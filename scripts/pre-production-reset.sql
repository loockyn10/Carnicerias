-- ============================================================================
-- scripts/pre-production-reset.sql
-- ============================================================================
-- ONE-TIME, MANUAL script to clear fictional/demo operational data from
-- Carnicerías before real operation starts. It is NOT a migration: it is
-- never applied by `supabase db push` / `supabase migration up`, it is not a
-- button in Admin, and it is not exposed through any RPC. You run it by hand,
-- once, against a database you have already backed up.
--
-- Full context, the exact "preserve vs delete" list, how to run this safely,
-- and how to verify the result: docs/PRE_PRODUCTION_RESET.md. Read that
-- first if you have not already.
--
-- WHAT THIS DELETES (only for the branches selected in step 2 below, which
-- by default is every branch in the single organization found):
--   sales, sale_items, payments, stock_movements, stock_operations and their
--   items, settlements, employee_shifts/employee_time_events/hourly rates for
--   the removed employees, pos_devices and their sync receipts, production
--   batches (and their outputs, via cascade), stock_transfers (and their
--   items, via cascade), branch-scoped announcements and quantity discounts,
--   branch stock policies, audit log noise tied to those branches/employees,
--   internal POS employee profiles (role = 'employee'), and finally the
--   branches themselves.
--
-- WHAT THIS NEVER TOUCHES:
--   organizations, the admin/owner profile(s) (role = 'admin'), roles,
--   permissions, role_permissions, products, categories, product_prices
--   (pricing history), product_costs, product_pricing_settings,
--   organization_cash_discounts, or any Postgres schema/migration/RLS policy.
--   Global (branch_id IS NULL) announcements and quantity discounts are also
--   left alone — see docs/PRE_PRODUCTION_RESET.md for why.
--
-- SAFETY
--   1. Take a backup/export first (see docs/PRE_PRODUCTION_RESET.md).
--   2. This script refuses to run unless you explicitly confirm in the same
--      database session, right before running it:
--
--        SET app.confirm_pre_production_reset = 'YES-DELETE-TEST-DATA';
--
--   3. It aborts (no partial changes — everything runs inside one
--      transaction) if it finds more than one organization, or if any
--      branch-scoped product_prices row would be orphaned by removing a
--      branch (pricing history is never silently dropped).
--   4. Nothing here ever touches `products`, `categories`, or price history.
-- ============================================================================

do $$
begin
  if coalesce(current_setting('app.confirm_pre_production_reset', true), '') <> 'YES-DELETE-TEST-DATA' then
    raise exception
      'Refusing to run: this deletes operational data. Read docs/PRE_PRODUCTION_RESET.md, take a backup, then run '
      'SET app.confirm_pre_production_reset = ''YES-DELETE-TEST-DATA''; in this same session before re-running this script.';
  end if;
end $$;

begin;

-- ----------------------------------------------------------------------------
-- 1. Resolve the target organization.
--    This repository currently has exactly one organization (the demo/real
--    org). If a second organization ever exists, this aborts rather than
--    guessing which one to reset — edit the SELECT below to target one
--    explicitly by id.
-- ----------------------------------------------------------------------------
do $$
declare
  v_org_count int;
begin
  select count(*) into v_org_count from public.organizations;
  if v_org_count <> 1 then
    raise exception
      'Expected exactly 1 organization, found %. Edit step 1 of this script to target one organization_id explicitly, then re-run.',
      v_org_count;
  end if;
end $$;

create temporary table pre_production_org on commit drop as
select id as organization_id from public.organizations limit 1;
-- To target a specific organization instead, replace the query above with:
--   select '00000000-0000-0000-0000-000000000000'::uuid as organization_id;

-- ----------------------------------------------------------------------------
-- 2. Target branches. Defaults to every branch in the organization, matching
--    the "all current branches are fictional demo data" premise this script
--    was written for. If you already have a real branch in this organization
--    that you want to KEEP, add a condition here, e.g.:
--      and b.code not in ('REAL01')
-- ----------------------------------------------------------------------------
create temporary table pre_production_branches on commit drop as
select b.id, b.organization_id, b.name, b.code
from public.branches b
join pre_production_org o on o.organization_id = b.organization_id;

-- ----------------------------------------------------------------------------
-- 3. Target employees: internal POS employees only (role = 'employee').
--    Any profile with role = 'admin' — the owner/administrator account(s) —
--    is never selected here, regardless of how many there are.
-- ----------------------------------------------------------------------------
create temporary table pre_production_employees on commit drop as
select p.id
from public.profiles p
join public.organization_members om on om.profile_id = p.id
join pre_production_org o on o.organization_id = om.organization_id
join public.roles r on r.id = om.role_id
where r.key = 'employee';

-- ----------------------------------------------------------------------------
-- 4. Safety check — pricing is never silently dropped. If a branch-specific
--    price exists for a branch about to be removed, abort and let a human
--    decide (close the price range manually, or exclude that branch from
--    pre_production_branches in step 2).
-- ----------------------------------------------------------------------------
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.product_prices pp
  join pre_production_branches b on b.id = pp.branch_id;
  if v_count > 0 then
    raise exception
      'Aborting: % branch-scoped product_prices row(s) reference a branch about to be removed. '
      'Pricing history is protected (docs/DOMAIN_RULES.md, CLAUDE.md). Resolve manually or exclude that branch in step 2 before re-running.',
      v_count;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Pre-delete counts, printed to the console for a last visual check.
-- ----------------------------------------------------------------------------
do $$
declare r record;
begin
  raise notice '--- pre-production-reset: about to remove ---';
  for r in
    select 'branches' as table_name, count(*) as row_count from pre_production_branches
    union all select 'employee profiles', count(*) from pre_production_employees
    union all select 'sales', count(*) from public.sales s join pre_production_branches b on b.id = s.branch_id
    union all select 'stock_movements', count(*) from public.stock_movements sm join pre_production_branches b on b.id = sm.branch_id
    union all select 'settlements', count(*) from public.settlements st join pre_production_branches b on b.id = st.branch_id
    union all select 'employee_shifts', count(*) from public.employee_shifts es join pre_production_branches b on b.id = es.branch_id
    union all select 'pos_devices', count(*) from public.pos_devices d join pre_production_branches b on b.id = d.branch_id
    union all select 'production_batches', count(*) from public.production_batches pb join pre_production_branches b on b.id = pb.branch_id
    union all select 'stock_transfers', count(*) from public.stock_transfers tr
      where tr.source_branch_id in (select id from pre_production_branches)
         or tr.destination_branch_id in (select id from pre_production_branches)
    union all select 'branch-scoped announcements', count(*) from public.announcements a join pre_production_branches b on b.id = a.branch_id
    union all select 'branch-scoped weight discounts', count(*) from public.product_weight_discounts d join pre_production_branches b on b.id = d.branch_id
  loop
    raise notice '%: %', r.table_name, r.row_count;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Delete, in FK-safe order (children before the tables they reference).
-- ----------------------------------------------------------------------------

-- References stock_movements and (optionally) announcements.
delete from public.product_restock_events pre
using pre_production_branches b
where pre.branch_id = b.id;

-- Branch-scoped announcements/promotions are removed together with their
-- fictional branch (required by the FK: branches restricts deletion while a
-- branch-scoped row still points at it). Global (branch_id IS NULL) rows are
-- commercial configuration, not branch-fictional data, and are left alone.
-- Also removes anything a fictional employee created outside a branch scope,
-- so their profile is not blocked by announcements.created_by later.
delete from public.announcements a
where a.branch_id in (select id from pre_production_branches)
   or a.created_by in (select id from pre_production_employees);

delete from public.product_weight_discounts d
where d.branch_id in (select id from pre_production_branches);

-- References branches (cascade would work too, but explicit keeps this
-- table's profiles(updated_by) FK resolved before employees are removed).
delete from public.branch_product_stock_settings s
where s.branch_id in (select id from pre_production_branches);

-- Core ledger and sales. stock_movements first: it is the table other
-- operational tables (stock_operations, production_batches, stock_transfers)
-- restrict against.
delete from public.stock_movements sm
where sm.branch_id in (select id from pre_production_branches);

delete from public.sale_items si
where si.branch_id in (select id from pre_production_branches);

delete from public.payments pay
where pay.branch_id in (select id from pre_production_branches);

delete from public.sales s
where s.branch_id in (select id from pre_production_branches);

delete from public.stock_operation_items soi
where soi.branch_id in (select id from pre_production_branches);

delete from public.stock_operations so
where so.branch_id in (select id from pre_production_branches);

-- production_batch_outputs cascades automatically from production_batches.
delete from public.production_batches pb
where pb.branch_id in (select id from pre_production_branches);

-- stock_transfer_items cascades automatically from stock_transfers.
delete from public.stock_transfers tr
where tr.source_branch_id in (select id from pre_production_branches)
   or tr.destination_branch_id in (select id from pre_production_branches);

delete from public.settlements st
where st.branch_id in (select id from pre_production_branches);

delete from public.employee_time_events ete
where ete.branch_id in (select id from pre_production_branches);

delete from public.employee_shifts es
where es.branch_id in (select id from pre_production_branches);

delete from public.employee_hourly_rates ehr
where ehr.employee_id in (select id from pre_production_employees);

delete from public.pos_sync_receipts psr
using public.pos_devices d
where psr.device_id = d.id
  and d.branch_id in (select id from pre_production_branches);

delete from public.pos_devices d
where d.branch_id in (select id from pre_production_branches);

-- Test-generated audit noise: entries tied to a removed branch, or authored
-- by / about a removed employee profile (e.g. EMPLOYEE_POS_PIN_CHANGED has no
-- branch_id).
delete from public.audit_logs al
where al.branch_id in (select id from pre_production_branches)
   or al.actor_profile_id in (select id from pre_production_employees)
   or (al.entity_type = 'profile' and al.entity_id in (select id from pre_production_employees));

-- These three cascade automatically once organization_members/profiles are
-- removed below; deleted explicitly here too so this step is self-contained
-- and order-independent if you ever run it standalone.
delete from public.pos_pin_attempts a
where a.profile_id in (select id from pre_production_employees);

delete from public.pos_operator_grants g
where g.operator_profile_id in (select id from pre_production_employees);

delete from public.employee_pos_pins pin
where pin.profile_id in (select id from pre_production_employees);

delete from public.branch_members bm
where bm.profile_id in (select id from pre_production_employees)
   or bm.branch_id in (select id from pre_production_branches);

delete from public.organization_members om
where om.profile_id in (select id from pre_production_employees);

-- The admin/owner profile is never in pre_production_employees (it always
-- has role = 'admin'), so this can never delete it.
delete from public.profiles p
where p.id in (select id from pre_production_employees);

-- pos_catalog_changes cascades automatically on branch delete for
-- branch-scoped rows; deleted explicitly here for a tidy sync cursor log.
delete from public.pos_catalog_changes pcc
where pcc.branch_id in (select id from pre_production_branches);

delete from public.branches b
where b.id in (select id from pre_production_branches);

-- ----------------------------------------------------------------------------
-- 7. Post-delete verification. Aborts the whole transaction (rolls back
--    everything above) if any invariant is violated.
-- ----------------------------------------------------------------------------
do $$
declare
  v_remaining_branches int;
  v_remaining_sales int;
  v_remaining_admins int;
  v_remaining_products int;
  v_remaining_prices int;
begin
  select count(*) into v_remaining_branches from public.branches b join pre_production_org o on o.organization_id = b.organization_id;
  select count(*) into v_remaining_sales from public.sales s join pre_production_org o on o.organization_id = s.organization_id;
  select count(*) into v_remaining_admins
    from public.organization_members om
    join pre_production_org o on o.organization_id = om.organization_id
    join public.roles r on r.id = om.role_id
    where r.key = 'admin';
  select count(*) into v_remaining_products from public.products p join pre_production_org o on o.organization_id = p.organization_id;
  select count(*) into v_remaining_prices from public.product_prices pp join pre_production_org o on o.organization_id = pp.organization_id;

  if v_remaining_branches <> 0 then
    raise exception 'Verification failed: % branch(es) still exist for the target organization', v_remaining_branches;
  end if;
  if v_remaining_sales <> 0 then
    raise exception 'Verification failed: % sale(s) still exist for the target organization', v_remaining_sales;
  end if;
  if v_remaining_admins = 0 then
    raise exception 'Verification failed: no admin/owner membership left in the organization — aborting to avoid locking everyone out';
  end if;
  if v_remaining_products = 0 then
    raise exception 'Verification failed: 0 products remain — this script must never touch the catalog, aborting';
  end if;

  raise notice '--- pre-production-reset: verification OK ---';
  raise notice 'branches remaining: % (expected 0)', v_remaining_branches;
  raise notice 'sales remaining: % (expected 0)', v_remaining_sales;
  raise notice 'admin memberships preserved: %', v_remaining_admins;
  raise notice 'products preserved: %', v_remaining_products;
  raise notice 'product_prices preserved: %', v_remaining_prices;
end $$;

commit;

-- ============================================================================
-- After this commits: create the real branches from Admin → Sucursales →
-- "+ Nueva sucursal", then authorize each real POS device to its branch
-- through the existing device-authorization flow. See
-- docs/PRE_PRODUCTION_RESET.md for the full checklist.
-- ============================================================================
