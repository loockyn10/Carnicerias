begin;

create extension if not exists pgtap with schema extensions;
select plan(77);

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'get_branch_operations_summary', array['uuid','date','date'], 'get_branch_operations_summary exists');
select has_function('public', 'get_product_branch_activity', array['uuid'], 'get_product_branch_activity exists');
select ok((select bool_and(prosecdef) from pg_proc where oid in ('public.get_branch_operations_summary(uuid,date,date)'::regprocedure, 'public.get_product_branch_activity(uuid)'::regprocedure)), 'both RPCs are security definer');
select ok((select bool_and(array_to_string(proconfig, ',') = 'search_path=""') from pg_proc where oid in ('public.get_branch_operations_summary(uuid,date,date)'::regprocedure, 'public.get_product_branch_activity(uuid)'::regprocedure)), 'both RPCs have an empty search path');
select ok((select bool_and(provolatile = 's') from pg_proc where oid in ('public.get_branch_operations_summary(uuid,date,date)'::regprocedure, 'public.get_product_branch_activity(uuid)'::regprocedure)), 'both RPCs are STABLE (read-only)');
select ok(not has_function_privilege('anon', 'public.get_branch_operations_summary(uuid,date,date)', 'EXECUTE'), 'anonymous cannot read the operations summary');
select ok(not has_function_privilege('anon', 'public.get_product_branch_activity(uuid)', 'EXECUTE'), 'anonymous cannot read the product activity');
select ok(has_function_privilege('authenticated', 'public.get_branch_operations_summary(uuid,date,date)', 'EXECUTE'), 'authenticated can execute the operations summary');
select ok(has_function_privilege('authenticated', 'public.get_product_branch_activity(uuid)', 'EXECUTE'), 'authenticated can execute the product activity');

-- ---------------------------------------------------------------------------------------------
-- Fixture. Org A: Central (productiva), Avenida, Janssen. Org B: una sucursal.
-- Usuarios: admin A; sales-only A (rol propio con sales.read pero SIN stock.read, Avenida); viewer A (rol propio con
-- sales.read + stock.read, miembro de Avenida y SIN branches.read_all); admin B.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ops-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Ops Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ops-salesonly-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Ops Sales Only A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'ops-viewer-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Ops Viewer A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'ops-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Ops Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'Ops Org A', 'ops-org-a'),
  ('e2000000-0000-4000-8000-000000000002', 'Ops Org B', 'ops-org-b');
update public.organizations set timezone = 'America/Argentina/Buenos_Aires' where id = 'e2000000-0000-4000-8000-000000000001';
insert into public.branches (id, organization_id, name, code) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA'),
  ('e3000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'Janssen', 'JANSSEN'),
  ('e3000000-0000-4000-8000-000000000009', 'e2000000-0000-4000-8000-000000000002', 'Org B Branch', 'CB');
update public.organizations set production_branch_id = 'e3000000-0000-4000-8000-000000000001' where id = 'e2000000-0000-4000-8000-000000000001';
insert into public.roles (id, organization_id, key, name, is_system) values
  ('e7000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'sales_only', 'Sales Only', false),
  ('e7000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'ops_viewer', 'Ops Viewer', false);
insert into public.role_permissions (role_id, permission_key) values
  ('e7000000-0000-4000-8000-000000000001', 'sales.read'),
  ('e7000000-0000-4000-8000-000000000002', 'sales.read'),
  ('e7000000-0000-4000-8000-000000000002', 'stock.read');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'e7000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002'),
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003');
insert into public.categories (id, organization_id, name, slug) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Carnes', 'carnes'),
  ('e4000000-0000-4000-8000-000000000009', 'e2000000-0000-4000-8000-000000000002', 'Org B Cat', 'org-b-cat');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Pata Muslo', 'pata-muslo', 'PMU', 'WEIGHT'),
  ('e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Molida', 'molida', 'MOL', 'WEIGHT'),
  ('e5000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Peceto', 'peceto', 'PEC', 'WEIGHT'),
  ('e5000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Tapa de Nalga', 'tapa-de-nalga', 'TAP', 'WEIGHT'),
  ('e5000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Hamburguesa', 'hamburguesa', 'HAM', 'UNIT'),
  ('e5000000-0000-4000-8000-000000000006', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Coca Cola', 'coca', 'COCA', 'UNIT'),
  ('e5000000-0000-4000-8000-000000000007', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Descontinuado', 'descontinuado', 'DESC', 'WEIGHT'),
  ('e5000000-0000-4000-8000-000000000008', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Nunca Operó', 'nunca-opero', 'NUN', 'WEIGHT'),
  ('e5000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Vacío', 'vacio', 'VAC', 'WEIGHT'),
  ('e5000000-0000-4000-8000-000000000009', 'e2000000-0000-4000-8000-000000000002', 'e4000000-0000-4000-8000-000000000009', 'Org B Product', 'org-b-product', 'ORGB', 'WEIGHT');
update public.products set active = false where id = 'e5000000-0000-4000-8000-000000000007';

-- Surtido: Central todo el catálogo; Avenida cortes + hamburguesa + el descontinuado + uno que nunca operó + vacío (SIN la
-- Coca); Janssen sólo Pata Muslo y Molida.
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', p.id
from public.products p where p.organization_id = 'e2000000-0000-4000-8000-000000000001';
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', p.id
from public.products p where p.id in ('e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000007', 'e5000000-0000-4000-8000-000000000008', 'e5000000-0000-4000-8000-00000000000a');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000003', p.id
from public.products p where p.id in ('e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002');
insert into public.branch_product_assortment (organization_id, branch_id, product_id) values
  ('e2000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000009', 'e5000000-0000-4000-8000-000000000009');

create function public.zz_move(p_branch uuid, p_product uuid, p_type public.stock_movement_type, p_qty bigint, p_at timestamptz, p_sale uuid default null)
returns uuid language plpgsql as $$
declare moved uuid := extensions.gen_random_uuid();
begin
  insert into public.stock_movements (id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
  values (moved, 'e2000000-0000-4000-8000-000000000001', p_branch, p_product, p_type, p_qty, p_sale, 'e1000000-0000-4000-8000-000000000001', p_at, p_at);
  return moved;
end $$;

-- Venta de un producto + su descuento de stock. p_ledger: lo que el ledger descuenta (por defecto lo vendido);
-- p_with_ledger = false => sin movimiento. Una venta CANCELLED repone con RETURN 10 minutos después.
create function public.zz_sale(p_branch uuid, p_status public.sale_status, p_at timestamptz, p_product uuid, p_grams integer, p_units integer,
  p_cents bigint, p_ticket_discount bigint default 0, p_ledger bigint default null, p_with_ledger boolean default true)
returns uuid language plpgsql as $$
declare
  sale uuid := extensions.gen_random_uuid();
  sold bigint := coalesce(p_grams, p_units);
begin
  insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at,
    ticket_discount_bps, ticket_discount_cents, cancellation_key, cancelled_at, cancelled_by, cancellation_reason)
  values (sale, 'e2000000-0000-4000-8000-000000000001', p_branch, 'e1000000-0000-4000-8000-000000000001', p_status, p_cents - p_ticket_discount, coalesce(p_grams, 0), p_at,
    case when p_ticket_discount > 0 then 200 else 0 end, p_ticket_discount,
    case when p_status = 'CANCELLED' then extensions.gen_random_uuid() end, case when p_status = 'CANCELLED' then p_at end,
    case when p_status = 'CANCELLED' then 'e1000000-0000-4000-8000-000000000001'::uuid end, case when p_status = 'CANCELLED' then 'fixture' end);
  insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, quantity_units, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, ticket_discount_cents)
  values (sale, 'e2000000-0000-4000-8000-000000000001', p_branch, p_product, 'x', p_grams, p_units, 1000, 1000, 1000, p_cents, p_ticket_discount);
  if p_with_ledger then
    perform public.zz_move(p_branch, p_product, 'SALE', -coalesce(p_ledger, sold), p_at, sale);
    if p_status = 'CANCELLED' then
      perform public.zz_move(p_branch, p_product, 'RETURN', coalesce(p_ledger, sold), p_at + interval '10 minutes', sale);
    end if;
  end if;
  return sale;
end $$;

-- ---- AVENIDA · Pata Muslo (WEIGHT). Ingreso 40 kg hace 10 días.
--   COMPLETED: S1 4 kg (hace 1 h), S2 6 kg (2 d), S3 5 kg (9 d: período ANTERIOR), S4 3 kg (3 d) SIN descuento en el ledger,
--   S5 2 kg (4 d) con el ledger descontando 3 kg, S8 9 kg (20 d: fuera de 14 días).
--   Ruido: CANCELLED 7 kg (SALE + RETURN) y PENDING_PAYMENT 1 kg (con ledger), que NO cuentan como vendido.
--   Ledger: 40 - 4 - 6 - 5 - 0 - 3 - 1 - 9 - 1 = 11 kg. Diferencia ventas vs ledger: S4 +3 kg, S5 -1 kg => 2 tickets, +2 kg.
select public.zz_move('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001', 'PURCHASE', 40000, now() - interval '10 days');
select set_config('zz.s1_at', (now() - interval '1 hour')::text, true);
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '1 hour', 'e5000000-0000-4000-8000-000000000001', 4000, null, 40000);
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '2 days', 'e5000000-0000-4000-8000-000000000001', 6000, null, 60000);
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '9 days', 'e5000000-0000-4000-8000-000000000001', 5000, null, 50000);
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '3 days', 'e5000000-0000-4000-8000-000000000001', 3000, null, 30000, 0, null, false);
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '4 days', 'e5000000-0000-4000-8000-000000000001', 2000, null, 20000, 0, 3000);
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '20 days', 'e5000000-0000-4000-8000-000000000001', 9000, null, 90000);
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'CANCELLED', now() - interval '5 days', 'e5000000-0000-4000-8000-000000000001', 7000, null, 999999);
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'PENDING_PAYMENT', now() - interval '5 days', 'e5000000-0000-4000-8000-000000000001', 1000, null, 888888);
-- Con descuento general del ticket: el ingreso es subtotal - descuento (venta de hace 1 día, 1 kg, 10000 - 1000).
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '1 day', 'e5000000-0000-4000-8000-000000000001', 1000, null, 10000, 1000);

-- ---- AVENIDA · Molida: 20 kg ingresados hace 20 días y UNA venta hace 30 días (1 kg) => nada en 14 días.
select public.zz_move('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000002', 'PURCHASE', 20000, now() - interval '20 days');
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '30 days', 'e5000000-0000-4000-8000-000000000002', 1000, null, 10000);
-- ---- AVENIDA · Peceto: 15 kg ingresados hace 12 días, 1,2 kg vendidos hace 8 días.
select public.zz_move('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000003', 'PURCHASE', 15000, now() - interval '12 days');
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '8 days', 'e5000000-0000-4000-8000-000000000003', 1200, null, 12000);
-- ---- AVENIDA · Tapa de Nalga: 7,4 kg de saldo inicial, sin una sola venta.
select public.zz_move('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000004', 'OPENING_BALANCE', 7400, now() - interval '30 days');
-- ---- AVENIDA · Hamburguesa (UNIT): 100 u hace 5 días, 6 u vendidas ayer.
select public.zz_move('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000005', 'PURCHASE', 100, now() - interval '5 days');
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '1 day', 'e5000000-0000-4000-8000-000000000005', null, 6, 60000);
-- ---- AVENIDA · Coca (fuera del surtido), Descontinuado (inactivo) y Vacío con stock NEGATIVO (-2 kg, sin ventas).
select public.zz_move('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000006', 'PURCHASE', 50, now() - interval '3 days');
select public.zz_sale('e3000000-0000-4000-8000-000000000002', 'COMPLETED', now() - interval '1 day', 'e5000000-0000-4000-8000-000000000006', null, 12, 24000);
select public.zz_move('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000007', 'PURCHASE', 5000, now() - interval '3 days');
select public.zz_move('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-00000000000a', 'ADJUSTMENT_NEGATIVE', -2000, now() - interval '2 days');
-- ---- JANSSEN · Pata Muslo (10 kg, 3 kg vendidos ayer) y Peceto (fuera de su surtido). CENTRAL · Pata Muslo.
select public.zz_move('e3000000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-000000000001', 'PURCHASE', 10000, now() - interval '6 days');
select public.zz_sale('e3000000-0000-4000-8000-000000000003', 'COMPLETED', now() - interval '1 day', 'e5000000-0000-4000-8000-000000000001', 3000, null, 30000);
select public.zz_sale('e3000000-0000-4000-8000-000000000003', 'COMPLETED', now() - interval '1 day', 'e5000000-0000-4000-8000-000000000003', 4000, null, 40000);
-- Una venta con pago pendiente de 0,5 kg cuyo stock NUNCA se descontó: esperaba 0,5 kg y el ledger descontó 0.
select public.zz_sale('e3000000-0000-4000-8000-000000000003', 'PENDING_PAYMENT', now() - interval '2 days', 'e5000000-0000-4000-8000-000000000001', 500, null, 5000, 0, null, false);
select public.zz_move('e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'PURCHASE', 100000, now() - interval '10 days');
select public.zz_sale('e3000000-0000-4000-8000-000000000001', 'COMPLETED', now() - interval '1 day', 'e5000000-0000-4000-8000-000000000001', 1000, null, 10000);

select set_config('zz.movements', (select count(*)::text from public.stock_movements), true);
select set_config('zz.sales', (select count(*)::text from public.sales), true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

create temp table zz_today as select (now() at time zone 'America/Argentina/Buenos_Aires')::date as d;
grant select on zz_today to public;

-- ---------------------------------------------------------------------------------------------
-- AVENIDA · últimos 7 días (hoy-6 .. hoy)
-- ---------------------------------------------------------------------------------------------
create temp table zz_av7 as select * from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', (select d - 6 from zz_today), (select d from zz_today));
grant select on zz_av7 to public;

select is((select array_agg(product_name order by product_name) from zz_av7), array['Hamburguesa', 'Molida', 'Pata Muslo', 'Peceto', 'Tapa de Nalga', 'Vacío'], 'only assortment products with a signal: no Coca (outside the assortment), no inactive product, no product that never operated');
select is((select count(*) from zz_av7 where product_name in ('Coca Cola', 'Descontinuado', 'Nunca Operó')), 0::bigint, 'Coca (not in the assortment), the discontinued product and the never-operated one are excluded');
-- Pata Muslo
select is((select current_quantity from zz_av7 where product_name = 'Pata Muslo'), 11000::bigint, 'Pata Muslo stock = the ledger (11 kg)');
select is((select sold_7d from zz_av7 where product_name = 'Pata Muslo'), 16000::bigint, 'Pata Muslo sold 7d = 4 + 6 + 3 + 2 + 1 kg; the cancelled, pending, 9-day and 20-day sales do not count');
select is((select sold_14d from zz_av7 where product_name = 'Pata Muslo'), 21000::bigint, 'Pata Muslo sold 14d adds the 5 kg of 9 days ago');
select is((select sold_period from zz_av7 where product_name = 'Pata Muslo'), 16000::bigint, 'the chosen period (7 days) equals the 7d window');
select is((select sold_previous from zz_av7 where product_name = 'Pata Muslo'), 5000::bigint, 'the previous period (the 7 days before) only has the 5 kg sale');
select is((select revenue_period_cents from zz_av7 where product_name = 'Pata Muslo'), 40000 + 60000 + 30000 + 20000 + 9000::bigint, 'revenue = subtotal - ticket discount of the completed sales of the period');
select is((select last_sale_at from zz_av7 where product_name = 'Pata Muslo'), (select current_setting('zz.s1_at')::timestamptz), 'last sale = the most recent completed sale');
select is((select last_inbound_at from zz_av7 where product_name = 'Pata Muslo'), (select occurred_at from public.stock_movements where branch_id = 'e3000000-0000-4000-8000-000000000002' and product_id = 'e5000000-0000-4000-8000-000000000001' and type = 'PURCHASE'), 'last inbound = the PURCHASE of 10 days ago');
select is((select ledger_mismatch_tickets from zz_av7 where product_name = 'Pata Muslo'), 2, 'two tickets of the last 14 days where the ledger deducted something else than was sold');
select is((select ledger_mismatch_quantity from zz_av7 where product_name = 'Pata Muslo'), 2000::bigint, 'net mismatch: sold 3 kg never deducted (+3) and 2 kg sold with 3 kg deducted (-1) = +2 kg');
-- La misma regla que la auditoría por producto (get_stock_audit_summary), ticket por ticket.
select is((select (public.get_stock_audit_summary('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001', (select d - 13 from zz_today), (select d from zz_today), false)->'sales'->>'mismatchedSales')::integer), 2, 'the batch mismatch count equals the per-product audit mismatchedSales');
select is((select (public.get_stock_audit_summary('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001', (select d - 13 from zz_today), (select d from zz_today), false)->'sales'->>'difference')::bigint), 2000::bigint, 'the batch mismatch quantity equals the per-product audit difference');
select is((select current_quantity from zz_av7 where product_name = 'Pata Muslo'), (select (public.get_stock_audit_summary('e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001', null, null, true)->>'currentQuantity')::bigint), 'the stock equals the audit current quantity (same ledger)');
-- Molida: stock sin ventas en 14 días, con una venta vieja.
select is((select current_quantity from zz_av7 where product_name = 'Molida'), 19000::bigint, 'Molida stock 19 kg');
select is((select sold_14d from zz_av7 where product_name = 'Molida'), 0::bigint, 'Molida did not sell in 14 days');
select ok((select last_sale_at from zz_av7 where product_name = 'Molida') < now() - interval '29 days', 'Molida last sale is the 30-day-old one (90-day lookback)');
select is((select ledger_mismatch_tickets from zz_av7 where product_name = 'Molida'), 0, 'Molida has no mismatch');
-- Peceto
select is((select sold_14d from zz_av7 where product_name = 'Peceto'), 1200::bigint, 'Peceto sold 1,2 kg in 14 days');
select is((select sold_7d from zz_av7 where product_name = 'Peceto'), 0::bigint, 'Peceto sold nothing in 7 days');
select ok((select last_sale_at from zz_av7 where product_name = 'Peceto') between now() - interval '8 days 1 hour' and now() - interval '7 days 23 hours', 'Peceto last sale was 8 days ago');
select is((select current_quantity from zz_av7 where product_name = 'Peceto'), 13800::bigint, 'Peceto stock does not include the Janssen sale');
-- Tapa de Nalga: saldo inicial y ninguna venta.
select is((select current_quantity from zz_av7 where product_name = 'Tapa de Nalga'), 7400::bigint, 'Tapa de Nalga stock 7,4 kg');
select ok((select last_sale_at is null and last_inbound_at is not null from zz_av7 where product_name = 'Tapa de Nalga'), 'Tapa de Nalga never sold and its last inbound is the opening balance');
-- Vacío con stock negativo: aparece, sin último ingreso.
select is((select current_quantity from zz_av7 where product_name = 'Vacío'), -2000::bigint, 'a negative stock is returned as is');
select ok((select last_inbound_at is null from zz_av7 where product_name = 'Vacío'), 'the inbound lookup only runs for positive stock');
-- UNIT
select is((select unit_type::text from zz_av7 where product_name = 'Hamburguesa'), 'UNIT', 'Hamburguesa is UNIT');
select is((select sold_7d from zz_av7 where product_name = 'Hamburguesa'), 6::bigint, 'UNIT sales are counted in units, not grams');
select is((select current_quantity from zz_av7 where product_name = 'Hamburguesa'), 94::bigint, 'UNIT stock is in units');
-- Orden: el que más facturó primero.
select is((select product_name from zz_av7 order by revenue_period_cents desc, product_name limit 1), 'Pata Muslo', 'Pata Muslo is the top seller by revenue');
-- Otra ventana: 30 días.
select is((select sold_period from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', (select d - 29 from zz_today), (select d from zz_today)) where product_name = 'Pata Muslo'), 30000::bigint, '30-day period adds the 5 kg of 9 days ago and the 9 kg of 20 days ago');
select is((select sold_previous from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', (select d - 29 from zz_today), (select d from zz_today)) where product_name = 'Molida'), 1000::bigint, 'the previous 30 days contain the 30-day-old Molida sale');
-- Un día futuro lejano no rompe y devuelve ceros de período (el stock sigue).
select is((select sold_period from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', (select d + 10 from zz_today), (select d + 10 from zz_today)) where product_name = 'Pata Muslo'), 0::bigint, 'a future period has no sales');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento por sucursal: Janssen sólo ve lo suyo.
-- ---------------------------------------------------------------------------------------------
select is((select array_agg(product_name order by product_name) from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000003', (select d - 6 from zz_today), (select d from zz_today))), array['Pata Muslo'], 'Janssen only returns its own assortment products with a signal');
select is((select sold_7d from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000003', (select d - 6 from zz_today), (select d from zz_today)) where product_name = 'Pata Muslo'), 3000::bigint, 'Janssen Pata Muslo sold 3 kg: never mixed with Avenida');
select is((select current_quantity from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000003', (select d - 6 from zz_today), (select d from zz_today)) where product_name = 'Pata Muslo'), 7000::bigint, 'Janssen stock is its own ledger');
select is((select ledger_mismatch_tickets from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000003', (select d - 6 from zz_today), (select d from zz_today)) where product_name = 'Pata Muslo'), 1, 'only the Janssen pending ticket is a mismatch: the Avenida ones do not leak');
select is((select ledger_mismatch_quantity from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000003', (select d - 6 from zz_today), (select d from zz_today)) where product_name = 'Pata Muslo'), 500::bigint, 'a pending-payment ticket expects its stock to be deducted (0,5 kg missing)');

-- ---------------------------------------------------------------------------------------------
-- Validaciones
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select * from public.get_branch_operations_summary(null, current_date, current_date)$$, '22023', null, 'a null branch is rejected');
select throws_ok($$select * from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', null, current_date)$$, '22023', null, 'a null bound is rejected');
select throws_ok($$select * from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', current_date, current_date - 1)$$, '22023', null, 'from after to is rejected');
select throws_ok($$select * from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', current_date - 400, current_date)$$, '22023', null, 'ranges longer than 366 days are rejected');
select throws_ok($$select * from public.get_branch_operations_summary('e3000000-0000-4000-8000-0000000000ff', current_date, current_date)$$, '42501', null, 'an unknown branch is rejected');
select throws_ok($$select * from public.get_product_branch_activity(null)$$, '22023', null, 'a null product is rejected');
select throws_ok($$select * from public.get_product_branch_activity('e5000000-0000-4000-8000-0000000000ff')$$, '42501', null, 'an unknown product is rejected');

-- ---------------------------------------------------------------------------------------------
-- get_product_branch_activity: un producto en todas las sucursales
-- ---------------------------------------------------------------------------------------------
select is((select array_agg(branch_name order by branch_name) from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000001')), array['Avenida', 'Central', 'Janssen'], 'Pata Muslo: the three branches that carry it');
select is((select sold_7d from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000001') where branch_name = 'Avenida'), 16000::bigint, 'activity Avenida sold 7d (same as the summary)');
select is((select sold_7d from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000001') where branch_name = 'Janssen'), 3000::bigint, 'activity Janssen sold 7d is its own');
select is((select current_quantity from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000001') where branch_name = 'Avenida'), 11000::bigint, 'activity Avenida stock');
select ok((select is_production from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000001') where branch_name = 'Central'), 'Central is flagged as the production branch');
select ok((select not bool_or(is_production) from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000001') where branch_name <> 'Central'), 'the other branches are not production');
select is((select last_sale_at from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000001') where branch_name = 'Avenida'), (select current_setting('zz.s1_at')::timestamptz), 'activity Avenida last sale');
select is((select array_agg(branch_name order by branch_name) from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000003')), array['Avenida', 'Central'], 'Peceto is not offered in Janssen: it is not listed there even though Janssen sold it once');
select is((select unit_type::text from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000005') where branch_name = 'Avenida'), 'UNIT', 'activity carries the product unit type');
select is((select sold_7d from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000005') where branch_name = 'Avenida'), 6::bigint, 'activity UNIT sold in units');

-- ---------------------------------------------------------------------------------------------
-- Permisos y aislamiento entre organizaciones
-- ---------------------------------------------------------------------------------------------
-- sales.read sin stock.read: las dos funciones mezclan stock con ventas → rechazadas.
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select * from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', current_date, current_date)$$, '42501', null, 'sales.read without stock.read is rejected by the operations summary');
select throws_ok($$select * from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000001')$$, '42501', null, 'sales.read without stock.read is rejected by the product activity');
-- Rol con sales.read + stock.read pero sin branches.read_all: sólo su sucursal.
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', (select d - 6 from zz_today), (select d from zz_today))), 6::bigint, 'a branch-scoped viewer reads their own branch');
select throws_ok($$select * from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000003', current_date, current_date)$$, '42501', null, 'a branch-scoped viewer cannot read another branch');
select is((select array_agg(branch_name) from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000001')), array['Avenida'], 'a branch-scoped viewer only compares the branches they can access');
-- Otra organización.
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$select * from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', current_date, current_date)$$, '42501', null, 'org B cannot read the operations summary of an org A branch');
select throws_ok($$select * from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000001')$$, '42501', null, 'org B cannot read the activity of an org A product');
select is((select count(*) from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000009', current_date - 6, current_date)), 0::bigint, 'org B reads its own branch (no signal yet): nothing from org A');
select is((select count(*) from public.get_product_branch_activity('e5000000-0000-4000-8000-000000000009')), 1::bigint, 'org B sees only its own branch for its own product');
-- Sin sesión.
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select * from public.get_branch_operations_summary('e3000000-0000-4000-8000-000000000002', current_date, current_date)$$, '28000', null, 'no session is rejected');

-- Sólo lectura: ningún movimiento ni venta nueva.
reset role;
select is((select count(*)::text from public.stock_movements), current_setting('zz.movements'), 'reading the operations summary created no stock movement');
select is((select count(*)::text from public.sales), current_setting('zz.sales'), 'reading the operations summary created no sale');

select * from finish();
rollback;
