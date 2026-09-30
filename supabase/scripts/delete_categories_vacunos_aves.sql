-- ============================================================================
-- supabase/scripts/delete_categories_vacunos_aves.sql
-- ============================================================================
-- ONE-OFF hard delete of the two incorrect categories "Vacunos" and "Aves".
-- NOT a migration (a migration with a DELETE would re-run in other
-- environments); `supabase db push` never executes it.
--
-- Run ONLY after delete_categories_vacunos_aves.preview.sql showed both
-- categories with zero products (principal and secondary) and you exported its
-- backup rows. Run in the Supabase SQL Editor (postgres role: `authenticated`
-- has no DELETE grant on categories, by design - there is no UI path).
--
-- Default is DRY-RUN: does everything, verifies, then aborts (rolls back) with
-- the report in the error message. To persist, change v_confirm below to
-- 'DELETE-VACUNOS-AVES'.
--
-- Guards (any failure aborts, nothing is deleted):
--   * exactly 2 categories match the names, in exactly one organization;
--   * neither has a product (active or inactive) as principal or secondary;
--   * only those 2 rows are deleted; every other category, product, price,
--     assignment and stock movement is counted before/after and must match.
-- The FKs (products / product_category_assignments -> categories, ON DELETE
-- RESTRICT) are an extra backstop. The categories_log_pos_change trigger logs
-- a CATEGORY change per deleted row; categories_audit does not fire on DELETE
-- (insert/update only), so the backup JSON below is the only record.
-- ============================================================================
do $$
declare
  v_confirm constant text := 'NO';
  v_ids uuid[];
  v_org_count integer;
  v_products integer;
  v_assignments integer;
  v_deleted integer;
  v_backup jsonb;
  v_before jsonb;
  v_after jsonb;
  v_expected jsonb;
begin
  select array_agg(c.id), count(distinct c.organization_id), jsonb_agg(to_jsonb(c))
  into v_ids, v_org_count, v_backup
  from public.categories c where lower(btrim(c.name)) in ('vacunos', 'aves');

  if coalesce(array_length(v_ids, 1), 0) <> 2 or v_org_count <> 1 then
    raise exception 'Expected exactly 2 categories (Vacunos, Aves) in 1 organization, found % in % organization(s). Nothing deleted.',
      coalesce(array_length(v_ids, 1), 0), v_org_count;
  end if;

  select count(*) into v_products from public.products where category_id = any (v_ids);
  select count(*) into v_assignments from public.product_category_assignments where category_id = any (v_ids);
  if v_products > 0 or v_assignments > 0 then
    raise exception 'Categories still in use (% products as principal, % assignments). Reassign products first. Nothing deleted.',
      v_products, v_assignments;
  end if;

  v_before := jsonb_build_object(
    'categories', (select count(*) from public.categories),
    'products', (select count(*) from public.products),
    'assignments', (select count(*) from public.product_category_assignments),
    'prices', (select count(*) from public.product_prices),
    'stock_movements', (select count(*) from public.stock_movements));

  delete from public.categories where id = any (v_ids);
  get diagnostics v_deleted = row_count;
  if v_deleted <> 2 then
    raise exception 'Deleted % rows, expected 2. Aborting.', v_deleted;
  end if;

  v_after := jsonb_build_object(
    'categories', (select count(*) from public.categories),
    'products', (select count(*) from public.products),
    'assignments', (select count(*) from public.product_category_assignments),
    'prices', (select count(*) from public.product_prices),
    'stock_movements', (select count(*) from public.stock_movements));
  v_expected := jsonb_set(v_before, '{categories}', to_jsonb(((v_before ->> 'categories')::integer) - 2));
  if v_after <> v_expected then
    raise exception 'Post-delete counts differ from expectation. before=% after=%', v_before, v_after;
  end if;

  if v_confirm <> 'DELETE-VACUNOS-AVES' then
    raise exception 'DRY-RUN OK, rolled back. Would delete 2 categories. before=% after=% backup=%', v_before, v_after, v_backup;
  end if;
  raise notice 'DELETED 2 categories. before=% after=% backup=%', v_before, v_after, v_backup;
end;
$$;
