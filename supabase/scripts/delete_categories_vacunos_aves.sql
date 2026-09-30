-- ============================================================================
-- supabase/scripts/delete_categories_vacunos_aves.sql
-- ============================================================================
-- ONE-OFF pre-production cleanup of test data. NOT a migration (a migration
-- with a DELETE would re-run in other environments); `supabase db push` never
-- executes it. Run it in the Supabase SQL Editor (postgres role: `authenticated`
-- has no DELETE grant on these tables by design - there is no UI path).
--
-- RULE: every product with active = false in the (single) organization is
-- physically deleted, together with ALL its dependent rows, historical ones
-- included. Then the categories "Vacunos" and "Aves" are deleted.
--
-- Dependent rows deleted, only those of inactive products (rows of active
-- products that share a parent - sale, transfer, operation, batch - stay):
--   product_restock_events, stock_movements, sale_items, stock_operation_items,
--   stock_transfer_items, production_batch_outputs, production_batches (whose
--   SOURCE product is inactive), product_prices, product_costs,
--   product_pricing_settings, product_weight_discounts,
--   branch_product_stock_settings, product_category_assignments.
-- NOT touched: sales / payments / stock_operations / stock_transfers headers,
-- settlements, audit_logs, pos_catalog_changes. A sale/operation/transfer that
-- only contained inactive products stays as an empty header (counts are
-- reported as emptied_*); sale totals/payments are therefore not recomputed.
-- Deleting those headers is a separate decision (settlements snapshot sales
-- totals with no FK, so deleting sales would desync them).
--
-- Default is DRY-RUN: does everything, verifies, then aborts (rolls back) and
-- shows the full report in the error message. To persist, change v_confirm
-- below to 'DELETE-INACTIVE-PRODUCTS'. The DO block is one transaction.
--
-- Aborts (nothing deleted) if: more than one organization; Vacunos/Aves are not
-- exactly 2 categories of it; an ACTIVE product still uses Vacunos/Aves
-- (principal or secondary); a foreign key to products exists that this script
-- does not know; a production batch of an inactive source product has outputs
-- or stock movements of an active product; any delete step removes a different
-- number of rows than counted; or any invariant hash (active products, their
-- prices/costs/settings/discounts/assignments/stock/sale items, sales,
-- payments, users, branches, devices, cash discounts, announcements, other
-- categories) differs before vs after.
-- Hashes cover tables POS devices write to only by COUNT (last_seen/heartbeats change
-- constantly). If the script aborts on an invariant while POS are selling, just re-run it.
-- DELETE is not audited (audit triggers are insert/update only): the report's
-- deleted_product_ids / names are the only record.
-- Other empty categories are only LISTED (other_empty_categories), never deleted.
-- ============================================================================
do $$
declare
  v_confirm constant text := 'NO';
  v_del_tables constant text[] := array[
    'product_restock_events', 'stock_movements', 'sale_items', 'stock_operation_items',
    'stock_transfer_items', 'production_batch_outputs', 'production_batches',
    'product_prices', 'product_costs', 'product_pricing_settings', 'product_weight_discounts',
    'branch_product_stock_settings', 'product_category_assignments'];
  v_del_cols constant text[] := array[
    'product_id', 'product_id', 'product_id', 'product_id',
    'product_id', 'product_id', 'source_product_id',
    'product_id', 'product_id', 'product_id', 'product_id',
    'product_id', 'product_id'];
  v_active_scoped constant text[] := array[
    'product_prices', 'product_costs', 'product_pricing_settings', 'product_weight_discounts',
    'branch_product_stock_settings', 'product_category_assignments', 'stock_movements', 'sale_items',
    'stock_operation_items', 'product_restock_events', 'stock_transfer_items', 'production_batch_outputs'];
  v_whole_tables constant text[] := array[
    'organizations', 'branches', 'profiles', 'organization_members',
    'organization_cash_discounts', 'announcements', 'sales', 'payments', 'stock_operations',
    'stock_transfers', 'settlements'];
  v_count_tables constant text[] := array[
    'categories', 'products', 'product_category_assignments', 'product_prices', 'product_costs',
    'product_pricing_settings', 'product_weight_discounts', 'branch_product_stock_settings',
    'sales', 'payments', 'sale_items', 'stock_movements', 'stock_operations', 'stock_operation_items',
    'product_restock_events', 'production_batches', 'production_batch_outputs',
    'stock_transfers', 'stock_transfer_items', 'pos_devices', 'branches'];
  v_known_fk_tables constant text[] := v_del_tables;
  v_org uuid;
  v_org_count integer;
  v_inactive uuid[];
  v_inactive_names text[];
  v_cat_ids uuid[];
  v_cat_names text[];
  v_unknown_fk text;
  v_blockers text;
  v_bad_batches bigint;
  v_active_before bigint;
  v_active_after bigint;
  v_other_empty text[];
  v_emptied jsonb;
  v_table text;
  v_col text;
  v_i integer;
  v_q text;
  v_h text;
  v_planned bigint;
  v_done bigint;
  v_before jsonb := '{}';
  v_after jsonb := '{}';
  v_deleted jsonb := '{}';
  v_hash_before jsonb := '{}';
  v_hash_after jsonb := '{}';
  v_queries text[] := array[]::text[];
  v_report jsonb;
begin
  -- 1. Organization (single).
  select count(*), min(id) into v_org_count, v_org from public.organizations;
  if v_org_count <> 1 then
    raise exception 'Expected exactly 1 organization, found %. Nothing deleted.', v_org_count;
  end if;

  -- 2. Inactive products.
  select array_agg(p.id), array_agg(p.name order by p.name)
  into v_inactive, v_inactive_names
  from public.products p where p.organization_id = v_org and not p.active;
  if v_inactive is null then
    raise exception 'No inactive products found. Nothing to delete.';
  end if;
  select count(*) into v_active_before from public.products where organization_id = v_org and active;

  -- 3. Unknown foreign keys to products (abort instead of guessing).
  select string_agg(conrelid::regclass::text || '.' || conname, ', ') into v_unknown_fk
  from pg_constraint
  where confrelid = 'public.products'::regclass and contype = 'f'
    and replace(conrelid::regclass::text, 'public.', '') <> all (v_known_fk_tables);
  if v_unknown_fk is not null then
    raise exception 'Unknown foreign keys to products (add them to this script first): %. Nothing deleted.', v_unknown_fk;
  end if;

  -- 4. Categories Vacunos / Aves: exactly 2, and no ACTIVE product may still use them.
  select array_agg(c.id), array_agg(c.name order by c.name)
  into v_cat_ids, v_cat_names
  from public.categories c where c.organization_id = v_org and lower(btrim(c.name)) in ('vacunos', 'aves');
  if coalesce(array_length(v_cat_ids, 1), 0) <> 2 then
    raise exception 'Expected exactly 2 categories (Vacunos, Aves), found %. Nothing deleted.', coalesce(array_length(v_cat_ids, 1), 0);
  end if;
  select string_agg(distinct p.name, ', ') into v_blockers
  from public.products p
  where p.id <> all (v_inactive)
    and (p.category_id = any (v_cat_ids)
         or p.id in (select a.product_id from public.product_category_assignments a where a.category_id = any (v_cat_ids)));
  if v_blockers is not null then
    raise exception 'Active products still use Vacunos/Aves: %. Reassign them first. Nothing deleted.', v_blockers;
  end if;

  -- 5. Production batches of an inactive source that carry an active product's data.
  select count(*) into v_bad_batches
  from public.production_batches b
  where b.source_product_id = any (v_inactive)
    and (exists (select 1 from public.production_batch_outputs o where o.batch_id = b.id and o.product_id <> all (v_inactive))
      or exists (select 1 from public.stock_movements m where m.production_batch_id = b.id and m.product_id <> all (v_inactive)));
  if v_bad_batches > 0 then
    raise exception '% production batch(es) of an inactive source product have outputs/stock of ACTIVE products. Nothing deleted.', v_bad_batches;
  end if;

  -- 6. Other categories that will be empty (reported only).
  select array_agg(c.name order by c.name) into v_other_empty
  from public.categories c
  where c.organization_id = v_org and c.id <> all (v_cat_ids)
    and not exists (select 1 from public.products p where p.category_id = c.id and p.id <> all (v_inactive))
    and not exists (select 1 from public.product_category_assignments a where a.category_id = c.id and a.product_id <> all (v_inactive));

  -- 7. Headers that will be left empty (reported only).
  v_emptied := jsonb_build_object(
    'emptied_sales', (select count(*) from public.sales s
      where exists (select 1 from public.sale_items i where i.sale_id = s.id and i.product_id = any (v_inactive))
        and not exists (select 1 from public.sale_items i where i.sale_id = s.id and i.product_id <> all (v_inactive))),
    'mixed_sales', (select count(*) from public.sales s
      where exists (select 1 from public.sale_items i where i.sale_id = s.id and i.product_id = any (v_inactive))
        and exists (select 1 from public.sale_items i where i.sale_id = s.id and i.product_id <> all (v_inactive))),
    'emptied_stock_operations', (select count(*) from public.stock_operations o
      where exists (select 1 from public.stock_operation_items i where i.operation_id = o.id and i.product_id = any (v_inactive))
        and not exists (select 1 from public.stock_operation_items i where i.operation_id = o.id and i.product_id <> all (v_inactive))),
    'emptied_stock_transfers', (select count(*) from public.stock_transfers t
      where exists (select 1 from public.stock_transfer_items i where i.transfer_id = t.id and i.product_id = any (v_inactive))
        and not exists (select 1 from public.stock_transfer_items i where i.transfer_id = t.id and i.product_id <> all (v_inactive))));

  -- 8. Invariant hashes + counts BEFORE.
  v_queries := v_queries || 'select md5(coalesce(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text), '''')) from public.products x where x.id <> all ($1)';
  v_queries := v_queries || 'select md5(coalesce(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text), '''')) from public.production_batches x where x.source_product_id <> all ($1)';
  foreach v_table in array v_active_scoped loop
    v_queries := v_queries || format('select md5(coalesce(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text), '''')) from public.%I x where x.product_id <> all ($1)', v_table);
  end loop;
  foreach v_table in array v_whole_tables loop
    v_queries := v_queries || format('select md5(coalesce(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text), '''')) from public.%I x where $1::uuid[] is not null', v_table);
  end loop;
  v_queries := v_queries || 'select md5(coalesce(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text), '''')) from public.categories x where lower(btrim(x.name)) not in (''vacunos'', ''aves'') and $1::uuid[] is not null';
  foreach v_q in array v_queries loop
    execute v_q into v_h using v_inactive;
    v_hash_before := v_hash_before || jsonb_build_object(v_q, v_h);
  end loop;
  foreach v_table in array v_count_tables loop
    execute format('select count(*) from public.%I', v_table) into v_planned;
    v_before := v_before || jsonb_build_object(v_table, v_planned);
  end loop;

  -- 9. Delete dependents (children first), then products, then the 2 categories.
  for v_i in 1 .. array_length(v_del_tables, 1) loop
    v_table := v_del_tables[v_i];
    v_col := v_del_cols[v_i];
    execute format('select count(*) from public.%I where %I = any ($1)', v_table, v_col) into v_planned using v_inactive;
    execute format('delete from public.%I where %I = any ($1)', v_table, v_col) using v_inactive;
    get diagnostics v_done = row_count;
    if v_done <> v_planned then
      raise exception 'Table %: deleted % rows, expected %. Aborting.', v_table, v_done, v_planned;
    end if;
    v_deleted := v_deleted || jsonb_build_object(v_table, v_done);
  end loop;

  delete from public.products where id = any (v_inactive);
  get diagnostics v_done = row_count;
  if v_done <> array_length(v_inactive, 1) then
    raise exception 'Deleted % products, expected %. Aborting.', v_done, array_length(v_inactive, 1);
  end if;
  v_deleted := v_deleted || jsonb_build_object('products', v_done);

  delete from public.categories where id = any (v_cat_ids);
  get diagnostics v_done = row_count;
  if v_done <> 2 then
    raise exception 'Deleted % categories, expected 2. Aborting.', v_done;
  end if;
  v_deleted := v_deleted || jsonb_build_object('categories', v_done);

  -- 10. Verify AFTER.
  select count(*) into v_active_after from public.products where organization_id = v_org and active;
  if v_active_after <> v_active_before then
    raise exception 'Active product count changed (% -> %). Aborting.', v_active_before, v_active_after;
  end if;
  if exists (select 1 from public.products where organization_id = v_org and not active) then
    raise exception 'Inactive products remain after delete. Aborting.';
  end if;
  foreach v_table in array v_count_tables loop
    execute format('select count(*) from public.%I', v_table) into v_done;
    v_after := v_after || jsonb_build_object(v_table, v_done);
    if v_done <> (v_before ->> v_table)::bigint - coalesce((v_deleted ->> v_table)::bigint, 0) then
      raise exception 'Table % count mismatch (before %, deleted %, after %). Aborting.',
        v_table, v_before ->> v_table, coalesce(v_deleted ->> v_table, '0'), v_done;
    end if;
  end loop;
  foreach v_q in array v_queries loop
    execute v_q into v_h using v_inactive;
    v_hash_after := v_hash_after || jsonb_build_object(v_q, v_h);
    if v_h is distinct from (v_hash_before ->> v_q) then
      raise exception 'Invariant changed (should be untouched): %. Aborting.', v_q;
    end if;
  end loop;

  v_report := jsonb_build_object(
    'inactive_products_deleted', array_length(v_inactive, 1),
    'inactive_product_names', v_inactive_names,
    'deleted_product_ids', v_inactive,
    'rows_deleted', v_deleted,
    'categories_deleted', v_cat_names,
    'other_empty_categories_NOT_deleted', v_other_empty,
    'headers_left_empty_or_mixed', v_emptied,
    'active_products_before_after', jsonb_build_array(v_active_before, v_active_after),
    'counts_before', v_before, 'counts_after', v_after);

  if v_confirm <> 'DELETE-INACTIVE-PRODUCTS' then
    raise exception 'DRY-RUN OK, rolled back. %', v_report;
  end if;
  raise notice 'DELETED. %', v_report;
end;
$$;
