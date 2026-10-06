begin;

create extension if not exists pgtap with schema extensions;
select plan(84);

-- ---------------------------------------------------------------------------------------------
-- Shape and hardening
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'get_branch_sales_summary', array['date','date','uuid'], 'get_branch_sales_summary exists');
select has_function('public', 'get_branch_carry_plan', array['uuid'], 'get_branch_carry_plan exists');
select has_function('public', 'get_replenishment_plan', array['integer'], 'get_replenishment_plan keeps its signature');
select ok((select prosecdef from pg_proc where oid = 'public.get_branch_sales_summary(date,date,uuid)'::regprocedure), 'sales summary is security definer');
select ok((select prosecdef from pg_proc where oid = 'public.get_branch_carry_plan(uuid)'::regprocedure), 'carry plan is security definer');
select is((select array_to_string(proconfig, ',') from pg_proc where oid = 'public.get_branch_sales_summary(date,date,uuid)'::regprocedure), 'search_path=""', 'sales summary has an empty search path');
select is((select array_to_string(proconfig, ',') from pg_proc where oid = 'public.get_branch_carry_plan(uuid)'::regprocedure), 'search_path=""', 'carry plan has an empty search path');
select ok(not has_function_privilege('anon', 'public.get_branch_sales_summary(date,date,uuid)', 'EXECUTE'), 'anonymous cannot read the sales summary');
select ok(not has_function_privilege('anon', 'public.get_branch_carry_plan(uuid)', 'EXECUTE'), 'anonymous cannot read the carry plan');
select ok(has_function_privilege('authenticated', 'public.get_branch_sales_summary(date,date,uuid)', 'EXECUTE'), 'authenticated can execute the sales summary');
select ok(has_function_privilege('authenticated', 'public.get_branch_carry_plan(uuid)', 'EXECUTE'), 'authenticated can execute the carry plan');
select ok(not has_function_privilege('authenticated', 'app_private.replenishment_rows(uuid,integer,uuid)', 'EXECUTE'), 'the shared base is not callable by browser clients (it trusts its organization argument)');
select ok(has_function_privilege('authenticated', 'public.get_replenishment_plan(integer)', 'EXECUTE'), 'get_replenishment_plan stays callable by authenticated');

-- ---------------------------------------------------------------------------------------------
-- Fixture. Org A: Central (productive), Avenida, Janssen. Org B: one branch.
-- Users: admin A, employee A (Avenida member, no dashboard.read), viewer A (custom role with
-- dashboard.read but NOT branches.read_all, Avenida member), admin B.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'carry-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Carry Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'carry-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Carry Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'carry-viewer-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Carry Viewer A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'carry-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Carry Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'Carry Org A', 'carry-org-a'),
  ('c2000000-0000-4000-8000-000000000002', 'Carry Org B', 'carry-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA'),
  ('c3000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'Janssen', 'JANSSEN'),
  ('c3000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'Org B Branch', 'CB');
insert into public.roles (id, organization_id, key, name, is_system) values
  ('c7000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'dash_viewer', 'Dash Viewer', false);
insert into public.role_permissions (role_id, permission_key) values
  ('c7000000-0000-4000-8000-000000000001', 'dashboard.read'),
  ('c7000000-0000-4000-8000-000000000001', 'sales.read'),
  ('c7000000-0000-4000-8000-000000000001', 'stock.read');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003');
insert into public.categories (id, organization_id, name, slug) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Carnes', 'carnes'),
  ('c4000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'Org B Cat', 'org-b-cat');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Molida', 'molida', 'MOL', 'WEIGHT'),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Vacío', 'vacio', 'VAC', 'WEIGHT'),
  ('c5000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Matambre', 'matambre', 'MAT', 'WEIGHT'),
  ('c5000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Hamburguesa', 'hamburguesa', 'HAM', 'UNIT'),
  ('c5000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Coca Cola', 'coca', 'COCA', 'UNIT'),
  ('c5000000-0000-4000-8000-000000000006', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Peceto', 'peceto', 'PEC', 'WEIGHT'),
  ('c5000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000009', 'Org B Product', 'org-b-product', 'ORGB', 'WEIGHT');

-- Surtido: Central lleva todo el catálogo (incluida la Coca); Avenida sólo cortes + hamburguesa +
-- peceto; Janssen sólo molida y vacío. La Coca NO está habilitada en Avenida ni en Janssen.
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', p.id
from public.products p where p.organization_id = 'c2000000-0000-4000-8000-000000000001';
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', p.id
from public.products p where p.id in ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000003', 'c5000000-0000-4000-8000-000000000004', 'c5000000-0000-4000-8000-000000000006');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000003', p.id
from public.products p where p.id in ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000002');
insert into public.branch_product_assortment (organization_id, branch_id, product_id) values
  ('c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000009', 'c5000000-0000-4000-8000-000000000009');

update public.organizations set production_branch_id = 'c3000000-0000-4000-8000-000000000001' where id = 'c2000000-0000-4000-8000-000000000001';
-- Org B starts WITHOUT a productive branch (fail-closed case); configured later in the test.

create function public.zz_seed_sale(p_branch uuid, p_status public.sale_status, p_at timestamptz, p_product uuid, p_grams integer, p_units integer, p_cents bigint)
returns uuid language plpgsql as $$
declare sale uuid := extensions.gen_random_uuid();
begin
  insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at,
    cancellation_key, cancelled_at, cancelled_by, cancellation_reason)
  values (sale, 'c2000000-0000-4000-8000-000000000001', p_branch, 'c1000000-0000-4000-8000-000000000001', p_status, p_cents, coalesce(p_grams, 0), p_at,
    case when p_status = 'CANCELLED' then extensions.gen_random_uuid() end, case when p_status = 'CANCELLED' then p_at end,
    case when p_status = 'CANCELLED' then 'c1000000-0000-4000-8000-000000000001'::uuid end, case when p_status = 'CANCELLED' then 'fixture' end);
  insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, quantity_units, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents)
  values (sale, 'c2000000-0000-4000-8000-000000000001', p_branch, p_product, 'x', p_grams, p_units, 1000, 1000, 1000, p_cents);
  return sale;
end $$;

-- ---- Demand fixture for "qué llevar ahora" (relative to now: inside / outside the 7-day window) ----
-- Avenida · Molida: 10 kg + 8 kg completed = 18 kg. Ruido que NO cuenta: cancelada 5 kg, pendiente de
-- pago 7 kg, reembolsada 4 kg, y una venta completada de hace 10 días (fuera de la ventana).
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '1 hour', 'c5000000-0000-4000-8000-000000000001', 10000, null, 100000);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '2 days', 'c5000000-0000-4000-8000-000000000001', 8000, null, 80000);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'CANCELLED', now() - interval '1 hour', 'c5000000-0000-4000-8000-000000000001', 5000, null, 50000);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'PENDING_PAYMENT', now() - interval '1 hour', 'c5000000-0000-4000-8000-000000000001', 7000, null, 70000);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'REFUNDED', now() - interval '1 hour', 'c5000000-0000-4000-8000-000000000001', 4000, null, 40000);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '10 days', 'c5000000-0000-4000-8000-000000000001', 9000, null, 90000);
-- Avenida · Vacío 9 kg, Matambre 3 kg, Hamburguesa 30 unidades, y una Coca vendida cuando alguna vez
-- estuvo habilitada (hoy fuera del surtido de Avenida).
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '1 day', 'c5000000-0000-4000-8000-000000000002', 9000, null, 90000);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '1 day', 'c5000000-0000-4000-8000-000000000003', 3000, null, 30000);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '1 day', 'c5000000-0000-4000-8000-000000000004', null, 30, 60000);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '1 day', 'c5000000-0000-4000-8000-000000000005', null, 12, 24000);
-- Janssen · Molida 9 kg (con stock NEGATIVO). Central también vende (nunca debe ser destino).
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000003', 'COMPLETED', now() - interval '1 day', 'c5000000-0000-4000-8000-000000000001', 9000, null, 90000);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000001', 'COMPLETED', now() - interval '1 day', 'c5000000-0000-4000-8000-000000000001', 40000, null, 400000);

-- Stock actual (ledger): Avenida Molida 4 kg, Vacío 1 kg, Matambre 4 kg, Hamburguesa 10 u;
-- Janssen Molida -2 kg (ventas sin ingreso registrado), Vacío 5 kg; Central Molida 100 kg.
insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id, occurred_at) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001', 'PURCHASE', 4000, 'c1000000-0000-4000-8000-000000000001', now() - interval '3 hours'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002', 'PURCHASE', 1000, 'c1000000-0000-4000-8000-000000000001', now() - interval '3 hours'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000003', 'PURCHASE', 4000, 'c1000000-0000-4000-8000-000000000001', now() - interval '3 hours'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000004', 'PURCHASE', 10, 'c1000000-0000-4000-8000-000000000001', now() - interval '3 hours'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000003', 'c5000000-0000-4000-8000-000000000001', 'ADJUSTMENT_NEGATIVE', -2000, 'c1000000-0000-4000-8000-000000000001', now() - interval '3 hours'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000003', 'c5000000-0000-4000-8000-000000000002', 'PURCHASE', 5000, 'c1000000-0000-4000-8000-000000000001', now() - interval '3 hours'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'PURCHASE', 100000, 'c1000000-0000-4000-8000-000000000001', now() - interval '3 hours');

-- ---- Fixture for the date-range summary: fixed instants around the org-local midnight ----
-- America/Argentina/Buenos_Aires is UTC-3: 2026-09-10 03:00:00Z is 2026-09-10 00:00 local.
-- Avenida
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-09-10 02:59:59+00', 'c5000000-0000-4000-8000-000000000002', 1000, null, 100000);  -- Sep 9 local 23:59:59
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-09-10 03:00:00+00', 'c5000000-0000-4000-8000-000000000002', 2000, null, 200000);  -- Sep 10 local 00:00:00
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-09-10 15:00:00+00', 'c5000000-0000-4000-8000-000000000002', 3000, null, 300000);  -- Sep 10 12:00 local
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-09-11 02:59:59+00', 'c5000000-0000-4000-8000-000000000002', 4000, null, 400000);  -- Sep 10 local 23:59:59
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-09-11 03:00:00+00', 'c5000000-0000-4000-8000-000000000002', 5000, null, 500000);  -- Sep 11 local 00:00:00
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-09-10 15:00:00+00', 'c5000000-0000-4000-8000-000000000004', null, 6, 60000);       -- UNIT sale, Sep 10
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'CANCELLED', '2026-09-10 15:00:00+00', 'c5000000-0000-4000-8000-000000000002', 9000, null, 999999);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'PENDING_PAYMENT', '2026-09-10 15:00:00+00', 'c5000000-0000-4000-8000-000000000002', 9000, null, 888888);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000002', 'REFUNDED', '2026-09-10 15:00:00+00', 'c5000000-0000-4000-8000-000000000002', 9000, null, 777777);
-- Janssen y Central: totales propios
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000003', 'COMPLETED', '2026-09-10 14:00:00+00', 'c5000000-0000-4000-8000-000000000002', 7000, null, 700000);
select public.zz_seed_sale('c3000000-0000-4000-8000-000000000001', 'COMPLETED', '2026-09-10 14:00:00+00', 'c5000000-0000-4000-8000-000000000002', 500, null, 50000);

select set_config('zz.movements', (select count(*)::text from public.stock_movements), true);
select set_config('zz.levels', (select coalesce(sum(quantity_grams), 0)::text from public.stock_levels), true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- RANGO DE VENTAS
-- ---------------------------------------------------------------------------------------------
-- Un solo día calendario local (10/09): las 00:00:00 locales entran, las 23:59:59 locales entran, las
-- 23:59:59 locales del día anterior y las 00:00:00 del siguiente NO. Un día NO es un día UTC.
select is((select sales_count from public.get_branch_sales_summary('2026-09-10', '2026-09-10') where branch_name = 'Avenida'), 4::bigint, 'Avenida 10/09: 4 completed sales (00:00:00, 12:00, 23:59:59 local + the unit sale)');
select is((select total_cents from public.get_branch_sales_summary('2026-09-10', '2026-09-10') where branch_name = 'Avenida'), 960000::bigint, 'Avenida 10/09 total = 200000 + 300000 + 400000 + 60000');
select is((select weight_grams from public.get_branch_sales_summary('2026-09-10', '2026-09-10') where branch_name = 'Avenida'), 9000::bigint, 'Avenida 10/09 weighed items = 2 + 3 + 4 kg (the unit sale adds no grams)');
select is((select units from public.get_branch_sales_summary('2026-09-10', '2026-09-10') where branch_name = 'Avenida'), 6::bigint, 'Avenida 10/09 counts the 6 units apart from the grams');
select is((select previous_total_cents from public.get_branch_sales_summary('2026-09-10', '2026-09-10') where branch_name = 'Avenida'), 100000::bigint, 'previous period = the day before (09/09 local 23:59:59 sale)');
-- El día anterior y el siguiente (límites inclusivo/exclusivo).
select is((select total_cents from public.get_branch_sales_summary('2026-09-09', '2026-09-09') where branch_name = 'Avenida'), 100000::bigint, 'Avenida 09/09 only has the 23:59:59 local sale (not a UTC-day cut)');
select is((select total_cents from public.get_branch_sales_summary('2026-09-11', '2026-09-11') where branch_name = 'Avenida'), 500000::bigint, 'Avenida 11/09 starts at local midnight');
-- Rango personalizado de varios días.
select is((select sales_count from public.get_branch_sales_summary('2026-09-09', '2026-09-11') where branch_name = 'Avenida'), 6::bigint, 'custom range 09/09-11/09 counts every completed sale (6)');
select is((select total_cents from public.get_branch_sales_summary('2026-09-09', '2026-09-11') where branch_name = 'Avenida'), 1560000::bigint, 'custom range total = 100000 + 200000 + 300000 + 400000 + 500000 + 60000');
select is((select previous_total_cents from public.get_branch_sales_summary('2026-09-10', '2026-09-11') where branch_name = 'Avenida'), 100000::bigint, 'a 2-day range compares with the previous 2 days (09/08-09/09)');
-- Totales separados por sucursal.
select is((select total_cents from public.get_branch_sales_summary('2026-09-10', '2026-09-10') where branch_name = 'Janssen'), 700000::bigint, 'Janssen total is its own');
select is((select total_cents from public.get_branch_sales_summary('2026-09-10', '2026-09-10') where branch_name = 'Central'), 50000::bigint, 'Central total is its own');
select is((select count(*) from public.get_branch_sales_summary('2026-09-10', '2026-09-10')), 3::bigint, 'one row per active accessible branch');
-- Una sucursal sin ventas en el rango igual aparece, en cero.
select is((select sales_count from public.get_branch_sales_summary('2026-01-01', '2026-01-01') where branch_name = 'Janssen'), 0::bigint, 'a branch without sales still returns a zero row');
select is((select total_cents from public.get_branch_sales_summary('2026-09-10', '2026-09-10', 'c3000000-0000-4000-8000-000000000003')), 700000::bigint, 'filtering by branch returns only that branch');
select is((select count(*) from public.get_branch_sales_summary('2026-09-10', '2026-09-10', 'c3000000-0000-4000-8000-000000000003')), 1::bigint, 'branch filter returns a single row');
-- Validaciones.
select throws_ok($$select * from public.get_branch_sales_summary('2026-09-11', '2026-09-10')$$, '22023', null, 'from after to is rejected');
select throws_ok($$select * from public.get_branch_sales_summary(null, '2026-09-10')$$, '22023', null, 'a null bound is rejected');
select throws_ok($$select * from public.get_branch_sales_summary('2025-01-01', '2026-09-10')$$, '22023', null, 'ranges longer than 366 days are rejected');
select lives_ok($$select * from public.get_branch_sales_summary('2026-01-01', '2026-12-31')$$, 'a full non-leap year (365 days) is accepted');

-- Zona horaria de la organización: con otra zona, el mismo instante cae en otro día.
reset role;
update public.organizations set timezone = 'Asia/Tokyo' where id = 'c2000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
-- Tokyo is UTC+9: 2026-09-10 03:00:00Z is 12:00 local on 09/10; 2026-09-10 02:59:59Z is 11:59:59 on 09/10.
select is((select total_cents from public.get_branch_sales_summary('2026-09-09', '2026-09-09') where branch_name = 'Avenida'), 0::bigint, 'with Asia/Tokyo the 02:59:59Z sale is no longer on 09/09 (the org timezone drives the day, not UTC)');
reset role;
update public.organizations set timezone = 'America/Argentina/Buenos_Aires' where id = 'c2000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- QUÉ LLEVAR AHORA
-- ---------------------------------------------------------------------------------------------
-- Fórmula: vendido 18 kg - stock 4 kg = 14 kg (ventas cancelada/pendiente/reembolsada/fuera de ventana ignoradas).
select is((select sold_quantity from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') where product_name = 'Molida'), 18000::bigint, 'Molida sold_7d = 18 kg (cancelled, pending, refunded and old sales ignored)');
select is((select current_quantity from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') where product_name = 'Molida'), 4000::bigint, 'Molida current stock = 4 kg');
select is((select suggested_quantity from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') where product_name = 'Molida'), 14000::bigint, 'Molida suggested = 18 - 4 = 14 kg');
select is((select suggested_quantity from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') where product_name = 'Vacío'), 8000::bigint, 'Vacío suggested = 9 - 1 = 8 kg');
select is((select suggested_quantity from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') where product_name = 'Matambre'), 0::bigint, 'Matambre sold 3 kg with 4 kg in stock suggests 0 (never negative)');
select is((select suggested_quantity from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') where product_name = 'Hamburguesa'), 20::bigint, 'UNIT: 30 units sold - 10 in stock = 20 units');
select is((select unit_type::text from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') where product_name = 'Hamburguesa'), 'UNIT', 'UNIT quantities stay in units (never converted to grams)');
select is((select unit_type::text from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') where product_name = 'Molida'), 'WEIGHT', 'WEIGHT quantities are in grams');
select is((select suggested_quantity from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') where product_name = 'Peceto'), 0::bigint, 'an enabled product with no sales and no stock appears with 0 (the screen decides to hide it)');
-- Stock negativo: Janssen Molida -2 kg, vendido 9 kg → 9 kg (el faltante contable no se suma), pero se informa crudo.
select is((select suggested_quantity from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000003') where product_name = 'Molida'), 9000::bigint, 'negative ledger stock counts as 0: suggested = sold (9 kg), not 9 + 2');
select is((select current_quantity from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000003') where product_name = 'Molida'), -2000::bigint, 'the raw negative stock is still reported so the screen can show the shortfall');
-- Surtido: lo que la sucursal no maneja no aparece, aunque haya historia de ventas.
select is((select count(*) from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') where product_name = 'Coca Cola'), 0::bigint, 'a product not enabled in Avenida never appears, even with past sales there');
select is((select array_agg(product_name order by product_name) from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002')), array['Hamburguesa','Matambre','Molida','Peceto','Vacío'], 'Avenida only lists its assortment (5 of the 6 catalog products)');
select is((select array_agg(product_name order by product_name) from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000003')), array['Molida','Vacío'], 'Janssen only lists its 2 products');
-- Orden: mayor necesidad primero (pesados antes que unidades).
select is((select array_agg(product_name order by ordinality) from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') with ordinality), array['Molida','Vacío','Matambre','Peceto','Hamburguesa'], 'ordered by suggested desc (weighed first, units after), ties by sold');
-- Ventana y marca de cálculo.
select is((select window_days from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') limit 1), 7, 'the demand window is always 7 days');
select is((select window_start from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') limit 1),
  (((now() at time zone 'America/Argentina/Buenos_Aires')::date - 6)::timestamp at time zone 'America/Argentina/Buenos_Aires'), 'the window starts at the org-local midnight 6 days ago (today included)');
select ok((select calculated_at from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002') limit 1) between now() - interval '1 minute' and now() + interval '1 minute', 'calculated_at is the moment of the calculation');
-- Todas las sucursales no productivas; la productiva nunca es destino.
select is((select array_agg(distinct branch_name order by branch_name) from public.get_branch_carry_plan()), array['Avenida','Janssen'], 'all-branches report lists the non-productive branches only');
select is((select count(*) from public.get_branch_carry_plan() where branch_name = 'Central'), 0::bigint, 'the productive branch never appears as a destination');
select throws_ok($$select * from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000001')$$, '22023', null, 'asking for the productive branch is rejected: it is the origin');
-- Sin sucursal productiva configurada no se puede saber cuál es el origen: se rechaza.
reset role;
update public.organizations set production_branch_id = null where id = 'c2000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select * from public.get_branch_carry_plan()$$, '22023', null, 'without a configured productive branch the report is refused (fail-closed)');
reset role;
update public.organizations set production_branch_id = 'c3000000-0000-4000-8000-000000000001' where id = 'c2000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Calcular NO escribe: ni movimientos, ni stock, ni transferencias
-- ---------------------------------------------------------------------------------------------
select is((select count(*)::text from public.stock_movements), current_setting('zz.movements'), 'computing the carry plan created no stock movement');
select is((select coalesce(sum(quantity_grams), 0)::text from public.stock_levels), current_setting('zz.levels'), 'computing the carry plan changed no stock level');
select is((select count(*) from public.stock_transfers), 0::bigint, 'computing the carry plan created no transfer');

-- ---------------------------------------------------------------------------------------------
-- REGRESIÓN: get_replenishment_plan conserva su contrato y sus resultados
-- ---------------------------------------------------------------------------------------------
select is((select count(*) from public.get_replenishment_plan(7)), 13::bigint, 'get_replenishment_plan still lists every (branch x enabled product) pair: 6 + 5 + 2');
select is((select sold_recent_quantity from public.get_replenishment_plan(7) where branch_name = 'Avenida' and product_name = 'Molida'), 18000::bigint, 'plan: same 18 kg of recent demand as the carry plan');
select is((select current_quantity from public.get_replenishment_plan(7) where branch_name = 'Avenida' and product_name = 'Molida'), 4000::bigint, 'plan: same 4 kg stock');
select is((select sales_days from public.get_replenishment_plan(7) limit 1), 7, 'plan: sales_days is the requested window');
select is((select count(*) from public.get_replenishment_plan(7) where branch_name = 'Central') > 0, true, 'plan still includes the productive branch (Stock por sucursal depends on it)');
select is((select count(*) from public.get_replenishment_plan(7) where product_name = 'Coca Cola' and branch_name <> 'Central'), 0::bigint, 'plan: Coca Cola only in Central (assortment honoured)');
select is((select sold_recent_quantity from public.get_replenishment_plan(1) where branch_name = 'Avenida' and product_name = 'Molida') <= 18000, true, 'plan accepts a 1-day window (branch-stock screen)');
select throws_ok($$select * from public.get_replenishment_plan(0)$$, '22023', null, 'plan still rejects an invalid window');

-- ---------------------------------------------------------------------------------------------
-- SURTIDO en las vistas operativas (la fuente de verdad es branch_product_assortment) y catálogo global intacto
-- ---------------------------------------------------------------------------------------------
select is((select array_agg(product_name order by product_name) from public.get_branch_stock_status('c3000000-0000-4000-8000-000000000002')), array['Hamburguesa','Matambre','Molida','Peceto','Vacío'], 'Avenida stock view lists only its enabled products');
select is((select count(*) from public.get_branch_stock_status('c3000000-0000-4000-8000-000000000003')), 2::bigint, 'Janssen stock view lists only its 2 enabled products');
select is((select count(*) from public.get_branch_stock_status('c3000000-0000-4000-8000-000000000001') where product_name = 'Coca Cola'), 1::bigint, 'Central keeps its large catalog (Coca Cola is enabled there)');
select is((select product_count from public.get_branch_stock_summary() where branch_name = 'Janssen'), 2::bigint, 'stock summary counts only the enabled products of Janssen');
select is((select product_count from public.get_branch_stock_summary() where branch_name = 'Central'), 6::bigint, 'stock summary counts the whole Central catalog');
select is((select count(*) from public.products where organization_id = 'c2000000-0000-4000-8000-000000000001' and active), 6::bigint, 'the global catalog still has every product active: not enabling a product in a branch never hides or deletes it');

-- ---------------------------------------------------------------------------------------------
-- SEGURIDAD
-- ---------------------------------------------------------------------------------------------
-- Empleado: tiene sales.read pero no dashboard.read → sin acceso al informe; el resumen de ventas sólo muestra su sucursal.
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select * from public.get_branch_carry_plan()$$, '42501', null, 'a user without dashboard.read is rejected by the carry plan');
select is((select array_agg(branch_name order by branch_name) from public.get_branch_sales_summary('2026-09-10', '2026-09-10')), array['Avenida'], 'an employee only sees the branch they belong to in the sales summary');
select throws_ok($$select * from public.get_branch_sales_summary('2026-09-10', '2026-09-10', 'c3000000-0000-4000-8000-000000000003')$$, '42501', null, 'an employee cannot ask for a branch they do not belong to');
-- Rol con dashboard.read pero sin branches.read_all: sólo su sucursal.
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select array_agg(distinct branch_name order by branch_name) from public.get_branch_carry_plan()), array['Avenida'], 'a branch-scoped viewer only gets their own branch in the all-branches report');
select throws_ok($$select * from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000003')$$, '42501', null, 'a branch-scoped viewer cannot ask for another branch');
-- Otra organización: el admin de B ve su organización y nunca la de A.
reset role;
update public.organizations set production_branch_id = 'c3000000-0000-4000-8000-000000000009' where id = 'c2000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$select * from public.get_branch_carry_plan('c3000000-0000-4000-8000-000000000002')$$, '42501', null, 'org B cannot compute the carry plan of an org A branch');
select throws_ok($$select * from public.get_branch_sales_summary('2026-09-10', '2026-09-10', 'c3000000-0000-4000-8000-000000000002')$$, '42501', null, 'org B cannot read the sales of an org A branch');
select is((select count(*) from public.get_branch_sales_summary('2026-09-10', '2026-09-10') where branch_name in ('Central', 'Avenida', 'Janssen')), 0::bigint, 'org B never sees org A branches in the sales summary');
select is((select count(*) from public.get_branch_carry_plan()), 0::bigint, 'org B has no non-productive branch: its own branch is the origin, nothing to carry');
select is((select count(*) from public.get_replenishment_plan(7) where branch_name in ('Central', 'Avenida', 'Janssen')), 0::bigint, 'org B never sees org A in the replenishment plan either');
-- Sin sesión.
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select * from public.get_branch_carry_plan()$$, '28000', null, 'no session is rejected');

select * from finish();
rollback;
