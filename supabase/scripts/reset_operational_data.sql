-- ============================================================================
-- supabase/scripts/reset_operational_data.sql
-- ============================================================================
-- MANUAL script. NOT a migration: it lives outside supabase/migrations, so
-- `supabase db push` / `supabase db reset` never run it. It is not exposed
-- through any RPC or Admin button. Run it by hand, against a database you have
-- already backed up.
--
-- PURPOSE
--   Leave one organization "operationally new": 0 sales/tickets, 0 shifts and
--   clock events, 0 stock movements (so 0 stock), 0 desposte batches, 0
--   transfers, 0 settlements. Master data stays intact so the business can
--   start operating immediately.
--
-- DELETES (scoped to ONE organization, children before parents)
--   product_restock_events, stock_movements, payments, sale_items, sales,
--   stock_operation_items, stock_operations, stock_transfer_items,
--   stock_transfers, production_batch_outputs, production_batches,
--   settlements, employee_time_events, employee_shifts, pos_sync_receipts.
--   Stock has no balance table: stock_levels / branch_stock_status are views
--   over stock_movements, so deleting the ledger leaves stock at 0. No second
--   source of truth is created or reset.
--
-- KEEPS (verified below: row counts must be identical before and after)
--   organizations, branches (and their active flag), pos_devices, profiles,
--   organization_members, branch_members, roles/permissions, employee PINs,
--   employee_hourly_rates, products, categories, product_category_assignments,
--   product_prices (history), product_costs, product_pricing_settings,
--   organization_cash_discounts, branch_product_stock_settings,
--   product_weight_discounts, announcements.
--
-- AMBIGUOUS, KEPT ON PURPOSE (not clearly operational, not deleted)
--   audit_logs          Only the operational entity types (sales, settlements,
--                       production_batches, stock_transfers, stock_operations,
--                       employee_shift) are deleted (also_clean_operational_audit =
--                       true). All other audit history (products, prices, costs,
--                       employees, devices, branches...) is kept and verified.
--   pos_catalog_changes Change feed (sequence cursor) that POS devices pull to
--                       sync the catalog. Deleting it could desync devices.
--   pos_operator_grants Operator sessions per device (device/PIN config side).
--   pos_pin_attempts    PIN lockout counters (auth state, currently empty).
--
-- HOW TO RUN
--   1. Backup first (docs/PRE_PRODUCTION_RESET.md, "Backup").
--   2. Run supabase/scripts/reset_operational_data.preview.sql (read-only) and
--      check the organization and the counts.
--   3. Run THIS file as-is: it is a DRY RUN by default. It performs the real
--      deletes and all verifications inside the transaction, then aborts with
--      an exception listing before/after counts, so nothing is persisted.
--   4. To really commit, change  'NO'  to  'RESET-OPERATIONAL-DATA'  in
--      reset_params below and run the whole file again in a single execution.
--
-- No DDL, no RLS changes, no constraint changes. Everything is one transaction.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. PARAMETERS (edit here).
-- ----------------------------------------------------------------------------
create temporary table reset_params on commit drop as
select
  '20000000-0000-4000-8000-000000000001'::uuid as organization_id,  -- "Carnicerías Demo" (development org)
  'NO'::text                                   as confirm,          -- 'RESET-OPERATIONAL-DATA' to commit
  true                                         as also_clean_operational_audit;  -- only the entity types listed below

-- Entity types in audit_logs that describe deleted operational records.
create temporary table reset_audit_types (entity_type text primary key) on commit drop;
insert into reset_audit_types values
  ('sales'), ('settlements'), ('production_batches'), ('stock_transfers'), ('stock_operations'), ('employee_shift');

-- ----------------------------------------------------------------------------
-- 1. Identify the organization being cleaned. Aborts if it does not exist.
-- ----------------------------------------------------------------------------
do $$
declare
  v_org record;
  v_branches int;
  v_active int;
begin
  select o.id, o.name into v_org
  from public.organizations o join reset_params p on p.organization_id = o.id;
  if not found then
    raise exception 'Organization % does not exist. Fix reset_params.organization_id.',
      (select organization_id from reset_params);
  end if;
  select count(*), count(*) filter (where active) into v_branches, v_active
  from public.branches where organization_id = v_org.id;
  raise notice 'reset_operational_data: target organization = % (%), branches = % (% active)',
    v_org.name, v_org.id, v_branches, v_active;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Row counting helper (session-only, dropped automatically; not schema DDL).
-- ----------------------------------------------------------------------------
create function pg_temp.reset_count(p_table text, p_org uuid) returns bigint
language plpgsql as $f$
declare n bigint;
begin
  if p_table = 'pos_sync_receipts' then
    select count(*) into n from public.pos_sync_receipts r
      join public.pos_devices d on d.id = r.device_id where d.organization_id = p_org;
  elsif p_table = 'pos_pin_attempts' then
    select count(*) into n from public.pos_pin_attempts a
      join public.pos_devices d on d.id = a.device_id where d.organization_id = p_org;
  elsif p_table = 'audit_logs[operational]' then
    select count(*) into n from public.audit_logs
      where organization_id = p_org and entity_type in (select entity_type from reset_audit_types);
  elsif p_table = 'audit_logs[other]' then
    select count(*) into n from public.audit_logs
      where organization_id = p_org and entity_type not in (select entity_type from reset_audit_types);
  elsif p_table = 'stock_levels[nonzero]' then
    select count(*) into n from public.stock_levels where organization_id = p_org and quantity_grams <> 0;
  else
    execute format('select count(*) from public.%I where organization_id = $1', p_table) into n using p_org;
  end if;
  return n;
end $f$;

-- ----------------------------------------------------------------------------
-- 3. Snapshot BEFORE. kind: DELETE = must end at 0, KEEP = must end unchanged.
-- ----------------------------------------------------------------------------
create temporary table reset_report (
  tbl text primary key, kind text not null check (kind in ('DELETE', 'KEEP')),
  before_rows bigint, after_rows bigint
) on commit drop;

insert into reset_report (tbl, kind)
select t, 'DELETE' from unnest(array[
  'product_restock_events', 'stock_movements', 'payments', 'sale_items', 'sales',
  'stock_operation_items', 'stock_operations', 'stock_transfer_items', 'stock_transfers',
  'production_batch_outputs', 'production_batches', 'settlements',
  'employee_time_events', 'employee_shifts', 'pos_sync_receipts'
]) t
union all
select t, 'KEEP' from unnest(array[
  'organization_members', 'branch_members', 'branches', 'pos_devices', 'employee_pos_pins',
  'employee_hourly_rates', 'products', 'categories', 'product_category_assignments',
  'product_prices', 'product_costs', 'product_pricing_settings', 'organization_cash_discounts',
  'branch_product_stock_settings', 'product_weight_discounts', 'announcements',
  'pos_catalog_changes', 'pos_operator_grants', 'pos_pin_attempts', 'audit_logs[other]'
]) t
union all
select 'audit_logs[operational]',
  case when (select also_clean_operational_audit from reset_params) then 'DELETE' else 'KEEP' end;

update reset_report r
set before_rows = pg_temp.reset_count(r.tbl, (select organization_id from reset_params));

-- ----------------------------------------------------------------------------
-- 4. DELETE, FK-safe order. Every statement is scoped by organization_id
--    (pos_sync_receipts, which has no organization_id, through its device).
-- ----------------------------------------------------------------------------

-- product_restock_events.stock_movement_id -> stock_movements (restrict).
delete from public.product_restock_events
where organization_id = (select organization_id from reset_params);

-- The ledger. Referenced by product_restock_events only; it references sales,
-- stock_operations, production_batches and stock_transfers (all restrict), so
-- it must go before them.
delete from public.stock_movements
where organization_id = (select organization_id from reset_params);

-- Sales: children first (sale_items/payments -> sales, restrict).
delete from public.payments
where organization_id = (select organization_id from reset_params);
delete from public.sale_items
where organization_id = (select organization_id from reset_params);
delete from public.sales
where organization_id = (select organization_id from reset_params);

-- Offline sync idempotency receipts (device_id -> pos_devices, restrict; sale_id has no FK).
-- Removed with their sales so a stale event cannot be mistaken for an already-imported sale.
delete from public.pos_sync_receipts r
using public.pos_devices d
where r.device_id = d.id
  and d.organization_id = (select organization_id from reset_params);

-- Purchases / waste / adjustments.
delete from public.stock_operation_items
where organization_id = (select organization_id from reset_params);
delete from public.stock_operations
where organization_id = (select organization_id from reset_params);

-- Transfers between branches (items also cascade).
delete from public.stock_transfer_items
where organization_id = (select organization_id from reset_params);
delete from public.stock_transfers
where organization_id = (select organization_id from reset_params);

-- Desposte / production (outputs also cascade).
delete from public.production_batch_outputs
where organization_id = (select organization_id from reset_params);
delete from public.production_batches
where organization_id = (select organization_id from reset_params);

-- Settlements (rendiciones): derived from the sales deleted above.
delete from public.settlements
where organization_id = (select organization_id from reset_params);

-- Timekeeping: events -> shifts (restrict). Hourly rates are configuration and stay.
delete from public.employee_time_events
where organization_id = (select organization_id from reset_params);
delete from public.employee_shifts
where organization_id = (select organization_id from reset_params);

-- Optional: audit entries that describe the records deleted above.
delete from public.audit_logs
where (select also_clean_operational_audit from reset_params)
  and organization_id = (select organization_id from reset_params)
  and entity_type in (select entity_type from reset_audit_types);

-- ----------------------------------------------------------------------------
-- 5. Verify. Any violation raises and rolls the whole transaction back.
-- ----------------------------------------------------------------------------
update reset_report r
set after_rows = pg_temp.reset_count(r.tbl, (select organization_id from reset_params));

do $$
declare
  v_bad text;
  v_stock bigint;
begin
  select string_agg(format('%s (%s): before=%s after=%s', tbl, kind, before_rows, after_rows), '; ')
  into v_bad
  from reset_report
  where (kind = 'DELETE' and after_rows <> 0) or (kind = 'KEEP' and after_rows <> before_rows);
  if v_bad is not null then
    raise exception 'Verification failed, rolling back: %', v_bad;
  end if;

  v_stock := pg_temp.reset_count('stock_levels[nonzero]', (select organization_id from reset_params));
  if v_stock <> 0 then
    raise exception 'Verification failed, rolling back: % stock_levels rows are not zero', v_stock;
  end if;

  if (select count(*) from public.organization_members om
        join public.roles r on r.id = om.role_id
       where om.organization_id = (select organization_id from reset_params) and r.key = 'admin') = 0 then
    raise exception 'Verification failed, rolling back: no admin membership left';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Dry run by default: report and roll back unless explicitly confirmed.
-- ----------------------------------------------------------------------------
do $$
declare
  v_report text;
begin
  select string_agg(format('%-28s %-6s before=%s after=%s', tbl, kind, before_rows, after_rows), E'\n' order by kind, tbl)
  into v_report from reset_report;

  if (select confirm from reset_params) <> 'RESET-OPERATIONAL-DATA' then
    raise exception E'DRY RUN OK: nothing was persisted. To commit, set confirm = ''RESET-OPERATIONAL-DATA'' in reset_params.\n%', v_report;
  end if;

  raise notice E'reset_operational_data: committing.\n%', v_report;
end $$;

commit;
