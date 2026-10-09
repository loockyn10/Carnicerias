begin;

create extension if not exists pgtap with schema extensions;
select plan(165);

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'get_product_sales_summary', array['uuid','date','date','uuid'], 'get_product_sales_summary exists');
select has_function('public', 'get_stock_audit_summary', array['uuid','uuid','date','date','boolean'], 'get_stock_audit_summary exists');
select has_function('public', 'list_stock_audit_movements', array['uuid','uuid','date','date','boolean','integer','integer','boolean'], 'list_stock_audit_movements exists');
select ok((select bool_and(prosecdef) from pg_proc where oid in ('public.get_product_sales_summary(uuid,date,date,uuid)'::regprocedure, 'public.get_stock_audit_summary(uuid,uuid,date,date,boolean)'::regprocedure, 'public.list_stock_audit_movements(uuid,uuid,date,date,boolean,integer,integer,boolean)'::regprocedure)), 'the three RPCs are security definer');
select ok((select bool_and(array_to_string(proconfig, ',') = 'search_path=""') from pg_proc where oid in ('public.get_product_sales_summary(uuid,date,date,uuid)'::regprocedure, 'public.get_stock_audit_summary(uuid,uuid,date,date,boolean)'::regprocedure, 'public.list_stock_audit_movements(uuid,uuid,date,date,boolean,integer,integer,boolean)'::regprocedure, 'app_private.stock_audit_scope(uuid,uuid,uuid,date,date,boolean)'::regprocedure)), 'the RPCs and the scope helper have an empty search path');
select ok((select bool_and(provolatile = 's') from pg_proc where oid in ('public.get_product_sales_summary(uuid,date,date,uuid)'::regprocedure, 'public.get_stock_audit_summary(uuid,uuid,date,date,boolean)'::regprocedure, 'public.list_stock_audit_movements(uuid,uuid,date,date,boolean,integer,integer,boolean)'::regprocedure)), 'the three RPCs are STABLE (read-only)');
select ok(not has_function_privilege('anon', 'public.get_product_sales_summary(uuid,date,date,uuid)', 'EXECUTE'), 'anonymous cannot read the product sales summary');
select ok(not has_function_privilege('anon', 'public.get_stock_audit_summary(uuid,uuid,date,date,boolean)', 'EXECUTE'), 'anonymous cannot read the stock audit summary');
select ok(not has_function_privilege('anon', 'public.list_stock_audit_movements(uuid,uuid,date,date,boolean,integer,integer,boolean)', 'EXECUTE'), 'anonymous cannot read the movement detail');
select ok(has_function_privilege('authenticated', 'public.get_product_sales_summary(uuid,date,date,uuid)', 'EXECUTE'), 'authenticated can execute the product sales summary');
select ok(has_function_privilege('authenticated', 'public.get_stock_audit_summary(uuid,uuid,date,date,boolean)', 'EXECUTE'), 'authenticated can execute the stock audit summary');
select ok(has_function_privilege('authenticated', 'public.list_stock_audit_movements(uuid,uuid,date,date,boolean,integer,integer,boolean)', 'EXECUTE'), 'authenticated can execute the movement detail');
select ok(not has_function_privilege('authenticated', 'app_private.stock_audit_scope(uuid,uuid,uuid,date,date,boolean)', 'EXECUTE'), 'the scope helper (it trusts its organization argument) is not callable by browser clients');

-- ---------------------------------------------------------------------------------------------
-- Fixture. Org A: Central, Avenida, Janssen. Org B: una sucursal.
-- Usuarios: admin A, employee A (Avenida), stock-only A (rol propio con stock.read pero SIN sales.read,
-- Avenida), admin B.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'audit-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Audit Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'audit-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Audit Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'audit-stockonly-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Audit Stock Only A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'audit-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Audit Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'Audit Org A', 'audit-org-a'),
  ('d2000000-0000-4000-8000-000000000002', 'Audit Org B', 'audit-org-b');
update public.organizations set timezone = 'America/Argentina/Buenos_Aires' where id = 'd2000000-0000-4000-8000-000000000001';
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA'),
  ('d3000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'Janssen', 'JANSSEN'),
  ('d3000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'Org B Branch', 'CB');
insert into public.roles (id, organization_id, key, name, is_system) values
  ('d7000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'stock_only', 'Stock Only', false);
insert into public.role_permissions (role_id, permission_key) values
  ('d7000000-0000-4000-8000-000000000001', 'stock.read');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003');
insert into public.categories (id, organization_id, name, slug) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Carnes', 'carnes'),
  ('d4000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'Org B Cat', 'org-b-cat');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Pata Muslo', 'pata-muslo', 'PMU', 'WEIGHT'),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Vacío', 'vacio', 'VAC', 'WEIGHT'),
  ('d5000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Hamburguesa', 'hamburguesa', 'HAM', 'UNIT'),
  ('d5000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Descontinuado', 'descontinuado', 'DESC', 'WEIGHT'),
  ('d5000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-000000000009', 'Org B Product', 'org-b-product', 'ORGB', 'WEIGHT');
update public.products set active = false where id = 'd5000000-0000-4000-8000-000000000005';

-- Movimiento del ledger con instantes explícitos (created_at = occurred_at: orden determinista).
create function public.zz_move(p_branch uuid, p_product uuid, p_type public.stock_movement_type, p_qty bigint, p_at timestamptz,
  p_sale uuid default null, p_transfer uuid default null, p_op uuid default null)
returns uuid language plpgsql as $$
declare moved uuid := extensions.gen_random_uuid();
begin
  insert into public.stock_movements (id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, stock_transfer_id, stock_operation_id, profile_id, occurred_at, created_at)
  values (moved, 'd2000000-0000-4000-8000-000000000001', p_branch, p_product, p_type, p_qty, p_sale, p_transfer, p_op, 'd1000000-0000-4000-8000-000000000001', p_at, p_at);
  return moved;
end $$;

-- Venta de un producto + su descuento de stock. p_ledger: lo que el ledger descuenta (por defecto lo
-- vendido); p_with_ledger = false => sin movimiento. Una venta CANCELLED repone con RETURN 10 min después.
create function public.zz_sale(p_branch uuid, p_status public.sale_status, p_at timestamptz, p_product uuid, p_grams integer, p_units integer,
  p_cents bigint, p_ticket_discount bigint default 0, p_ledger bigint default null, p_with_ledger boolean default true)
returns uuid language plpgsql as $$
declare
  sale uuid := extensions.gen_random_uuid();
  sold bigint := coalesce(p_grams, p_units);
begin
  insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at,
    ticket_discount_bps, ticket_discount_cents, cancellation_key, cancelled_at, cancelled_by, cancellation_reason)
  values (sale, 'd2000000-0000-4000-8000-000000000001', p_branch, 'd1000000-0000-4000-8000-000000000001', p_status, p_cents - p_ticket_discount, coalesce(p_grams, 0), p_at,
    case when p_ticket_discount > 0 then 200 else 0 end, p_ticket_discount,
    case when p_status = 'CANCELLED' then extensions.gen_random_uuid() end, case when p_status = 'CANCELLED' then p_at end,
    case when p_status = 'CANCELLED' then 'd1000000-0000-4000-8000-000000000001'::uuid end, case when p_status = 'CANCELLED' then 'fixture' end);
  insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, quantity_units, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, ticket_discount_cents)
  values (sale, 'd2000000-0000-4000-8000-000000000001', p_branch, p_product, 'x', p_grams, p_units, 1000, 1000, 1000, p_cents, p_ticket_discount);
  if p_with_ledger then
    perform public.zz_move(p_branch, p_product, 'SALE', -coalesce(p_ledger, sold), p_at, sale);
    if p_status = 'CANCELLED' then
      perform public.zz_move(p_branch, p_product, 'RETURN', coalesce(p_ledger, sold), p_at + interval '10 minutes', sale);
    end if;
  end if;
  return sale;
end $$;

-- Una transferencia Central -> Avenida (Pata Muslo): el mismo documento respalda el TRANSFER_OUT y el TRANSFER_IN.
insert into public.stock_transfers (id, organization_id, source_branch_id, destination_branch_id, created_by, created_at) values
  ('d8000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', '2026-10-02 13:00:00+00');
insert into public.stock_operations (id, organization_id, branch_id, operation_type, supplier, occurred_at, actor_profile_id) values
  ('d9000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'PURCHASE', 'Frigorífico X', '2026-10-02 13:00:00+00', 'd1000000-0000-4000-8000-000000000001');

-- ---- CASO REAL: Avenida / Pata Muslo. Entra 42 kg por transferencia y se venden 25,4 kg => quedan 16,6 kg.
select public.zz_move('d3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'PURCHASE', 100000, '2026-10-01 12:00:00+00');
select public.zz_move('d3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'TRANSFER_OUT', -42000, '2026-10-02 13:00:00+00', null, 'd8000000-0000-4000-8000-000000000001');
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', 'TRANSFER_IN', 42000, '2026-10-02 13:00:00+00', null, 'd8000000-0000-4000-8000-000000000001');
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-03 15:00:00+00', 'd5000000-0000-4000-8000-000000000001', 10000, null, 100000);
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-04 15:00:00+00', 'd5000000-0000-4000-8000-000000000001', 8000, null, 80000);
-- 2026-10-06 02:30Z = 05/10 23:30 hora local: el día calendario local es el 5, no el 6.
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-06 02:30:00+00', 'd5000000-0000-4000-8000-000000000001', 5400, null, 54000);
-- Con descuento general del ticket: el ingreso es subtotal - descuento.
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-08 20:00:00+00', 'd5000000-0000-4000-8000-000000000001', 2000, null, 20000, 4000);
-- Otras sucursales del mismo producto (el filtro de sucursal no las mezcla).
select public.zz_move('d3000000-0000-4000-8000-000000000003', 'd5000000-0000-4000-8000-000000000001', 'PURCHASE', 10000, '2026-10-01 12:00:00+00');
select public.zz_sale('d3000000-0000-4000-8000-000000000003', 'COMPLETED', '2026-10-04 15:00:00+00', 'd5000000-0000-4000-8000-000000000001', 3000, null, 30000);
select public.zz_sale('d3000000-0000-4000-8000-000000000001', 'COMPLETED', '2026-10-05 15:00:00+00', 'd5000000-0000-4000-8000-000000000001', 1000, null, 10000);

-- ---- Vacío (Avenida): ruido de estados y movimientos de todos los tipos.
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', 'PURCHASE', 5000, '2026-10-01 12:00:00+00');
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', 'PURCHASE', 20000, '2026-10-02 13:00:00+00', null, null, 'd9000000-0000-4000-8000-000000000001');
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-03 15:00:00+00', 'd5000000-0000-4000-8000-000000000002', 3000, null, 30000);
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'CANCELLED', '2026-10-03 16:00:00+00', 'd5000000-0000-4000-8000-000000000002', 9000, null, 999999);
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'PENDING_PAYMENT', '2026-10-04 15:00:00+00', 'd5000000-0000-4000-8000-000000000002', 9000, null, 888888);
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'REFUNDED', '2026-10-04 16:00:00+00', 'd5000000-0000-4000-8000-000000000002', 9000, null, 777777, 0, null, false);
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', 'WASTE', -300, '2026-10-05 15:00:00+00');
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', 'ADJUSTMENT_NEGATIVE', -200, '2026-10-06 15:00:00+00');
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', 'ADJUSTMENT_POSITIVE', 100, '2026-10-07 15:00:00+00');

-- ---- Hamburguesa (UNIT, Avenida): 100 u - 6 - 4 - 5 (anulada y restablecida) = 85 u.
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000004', 'PURCHASE', 100, '2026-10-01 12:00:00+00');
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-03 15:00:00+00', 'd5000000-0000-4000-8000-000000000004', null, 6, 60000);
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-04 15:00:00+00', 'd5000000-0000-4000-8000-000000000004', null, 4, 40000);
-- Mercado Pago: SALE, RETURN (anulada por falta de acreditación) y otro SALE (se restableció al acreditarse).
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000004', 'RETURN', 5, '2026-10-05 15:10:00+00',
  public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-05 15:00:00+00', 'd5000000-0000-4000-8000-000000000004', null, 5, 50000));
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000004', 'SALE', -5, '2026-10-05 15:20:00+00',
  (select s.id from public.sales s join public.sale_items i on i.sale_id = s.id where i.product_id = 'd5000000-0000-4000-8000-000000000004' and i.quantity_units = 5));

-- ---- Descontinuado (inactivo): un único ajuste positivo, nunca una entrada real.
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000005', 'ADJUSTMENT_POSITIVE', 1000, '2026-10-03 15:00:00+00');
-- Movimiento EXACTAMENTE en el primer instante del 06/10 local (03:00:00Z): pertenece al 06/10, no al 05/10.
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000005', 'WASTE', -100, '2026-10-06 03:00:00+00');
-- Una venta con DOS líneas del mismo producto (Janssen / Hamburguesa) es un solo ticket de 5 unidades.
with two_lines as (
  select public.zz_sale('d3000000-0000-4000-8000-000000000003', 'COMPLETED', '2026-10-05 15:00:00+00', 'd5000000-0000-4000-8000-000000000004', null, 3, 3000, 0, null, false) as sale_id
)
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents)
select sale_id, 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000003', 'd5000000-0000-4000-8000-000000000004', 'x', 2, 1000, 1000, 1000, 2000 from two_lines;
-- Ventas EXACTAMENTE en el primer instante de un día local (03:00:00Z = 00:00:00 en Buenos Aires), sin movimientos.
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-03 03:00:00+00', 'd5000000-0000-4000-8000-000000000005', 500, null, 5000, 0, null, false);
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-04 03:00:00+00', 'd5000000-0000-4000-8000-000000000005', 700, null, 7000, 0, null, false);

-- ---- Org B
insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id, occurred_at)
values ('d2000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000009', 'd5000000-0000-4000-8000-000000000009', 'PURCHASE', 7000, 'd1000000-0000-4000-8000-000000000004', '2026-10-01 12:00:00+00');

create function public.zz_audit(p_branch uuid, p_product uuid, p_from date default null, p_to date default null, p_since boolean default false)
returns jsonb language sql as $$ select public.get_stock_audit_summary(p_branch, p_product, p_from, p_to, p_since) $$;
create function public.zz_type_qty(p_summary jsonb, p_type text)
returns bigint language sql as $$ select coalesce((select (t->>'quantity')::bigint from jsonb_array_elements(p_summary->'byType') t where t->>'type' = p_type), 0) $$;

select set_config('zz.movements', (select count(*)::text from public.stock_movements), true);
select set_config('zz.levels', (select coalesce(sum(quantity_grams), 0)::text from public.stock_levels), true);
select set_config('zz.sales', (select count(*)::text from public.sales), true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- VENTAS POR PRODUCTO
-- ---------------------------------------------------------------------------------------------
-- Pata Muslo en Avenida del 01/10 al 09/10: 10 + 8 + 5,4 + 2 kg en 4 tickets.
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 25400::bigint, 'WEIGHT: 25,400 kg vendidos (en gramos)');
select is((select tickets from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 4::bigint, 'WEIGHT: 4 tickets');
select is((select revenue_cents from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 250000::bigint, 'el importe es subtotal - descuento general del ticket (100000 + 80000 + 54000 + 16000)');
select is((select unit_type::text from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 'WEIGHT', 'informa la unidad del producto (WEIGHT)');
select is((select count(*) from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 1::bigint, 'con filtro de sucursal: una sola fila');
-- UNIT: unidades, no gramos; una venta anulada y restablecida cuenta una vez.
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000004', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 15::bigint, 'UNIT: 6 + 4 + 5 = 15 unidades');
select is((select tickets from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000004', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 3::bigint, 'UNIT: 3 tickets');
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000004', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000003')), 5::bigint, 'UNIT: una venta con dos líneas del producto suma 3 + 2 unidades');
select is((select tickets from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000004', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000003')), 1::bigint, 'UNIT: ...pero es un solo ticket (se cuentan ventas, no líneas)');
select is((select revenue_cents from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000004', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 150000::bigint, 'UNIT: importe 60000 + 40000 + 50000');
select is((select unit_type::text from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000004', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 'UNIT', 'informa la unidad del producto (UNIT)');
-- Solo COMPLETED: Vacío tiene 1 completada + 1 cancelada + 1 pendiente + 1 reembolsada.
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000002', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 3000::bigint, 'solo COMPLETED: no suma cancelada, pendiente de pago ni reembolsada');
select is((select tickets from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000002', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 1::bigint, 'solo COMPLETED: 1 ticket');
select is((select revenue_cents from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000002', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000002')), 30000::bigint, 'solo COMPLETED: el importe no incluye 999999 / 888888 / 777777');
-- Filtro de sucursal vs todas.
select is((select count(*) from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09')), 3::bigint, 'sin filtro: una fila por sucursal accesible');
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09') where branch_name = 'Janssen'), 3000::bigint, 'Janssen tiene lo suyo (3 kg)');
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09') where branch_name = 'Central'), 1000::bigint, 'Central tiene lo suyo (1 kg)');
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09') where branch_name = 'Avenida'), 25400::bigint, 'Avenida sin mezclar con las demás');
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000003')), 3000::bigint, 'el filtro de sucursal devuelve solo esa sucursal');
-- Filtro de producto: otro producto de la misma sucursal no se mezcla.
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000002', '2026-10-01', '2026-10-09') where branch_name = 'Janssen'), 0::bigint, 'otro producto en otra sucursal: 0 (no se mezcla)');
-- Rango y zona horaria: 06/10 02:30Z es el día 5 local.
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-05', '2026-10-05', 'd3000000-0000-4000-8000-000000000002')), 5400::bigint, 'el día calendario local incluye 23:30 del 05/10 (02:30Z del 06/10)');
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-06', '2026-10-06', 'd3000000-0000-4000-8000-000000000002')), 0::bigint, 'el 06/10 local no incluye esa venta (no es un corte UTC)');
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-03', '2026-10-05', 'd3000000-0000-4000-8000-000000000002')), 23400::bigint, 'rango 03/10-05/10: 10 + 8 + 5,4 kg');
select is((select tickets from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-01-01', '2026-01-01', 'd3000000-0000-4000-8000-000000000002')), 0::bigint, 'un rango sin ventas devuelve la fila en cero');
-- Límites exactos: 00:00:00 local entra en su día (inclusivo) y no en el anterior; el día termina antes de la medianoche siguiente (exclusivo).
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000005', '2026-10-03', '2026-10-03', 'd3000000-0000-4000-8000-000000000002')), 500::bigint, 'la venta de las 00:00:00 locales del 03/10 cuenta el 03/10 y no la de las 00:00:00 del 04/10');
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000005', '2026-10-04', '2026-10-04', 'd3000000-0000-4000-8000-000000000002')), 700::bigint, 'la venta de las 00:00:00 locales del 04/10 es del 04/10');
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000005', '2026-10-02', '2026-10-02', 'd3000000-0000-4000-8000-000000000002')), 0::bigint, 'la del 03/10 00:00:00 no es del día anterior');
select throws_ok($$select * from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-09', '2026-10-01')$$, '22023', null, 'desde posterior a hasta se rechaza');
select throws_ok($$select * from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', null, '2026-10-01')$$, '22023', null, 'un límite nulo se rechaza');
select throws_ok($$select * from public.get_product_sales_summary(null, '2026-10-01', '2026-10-09')$$, '22023', null, 'el producto es obligatorio');
select throws_ok($$select * from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2025-01-01', '2026-10-09')$$, '22023', null, 'más de 366 días se rechaza');
select throws_ok($$select * from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000009', '2026-10-01', '2026-10-09')$$, '42501', null, 'un producto de otra organización se rechaza');
select throws_ok($$select * from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000009')$$, '42501', null, 'una sucursal de otra organización se rechaza');

-- ---------------------------------------------------------------------------------------------
-- AUDITORÍA DE STOCK: CASO REAL (Avenida / Pata Muslo) "desde el último ingreso"
-- ---------------------------------------------------------------------------------------------
select is(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'mode', 'SINCE_LAST_INBOUND', 'modo desde el último ingreso');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'currentQuantity')::bigint, 16600::bigint, 'stock teórico actual = 16,600 kg');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'openingQuantity')::bigint, 0::bigint, 'antes del ingreso no había nada');
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true), 'TRANSFER_IN'), 42000::bigint, 'entró 42,000 kg por transferencia');
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true), 'SALE'), -25400::bigint, 'el ledger descontó 25,400 kg por ventas');
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true), 'WASTE'), 0::bigint, 'merma 0');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'closingQuantity')::bigint, 16600::bigint, 'stock al cierre = 16,600 kg');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'afterPeriodQuantity')::bigint, 0::bigint, 'desde el último ingreso llega hasta hoy: nada posterior');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'anchor'->>'type'), 'TRANSFER_IN', 'el ancla es la transferencia recibida');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'anchor'->>'quantity')::bigint, 42000::bigint, 'el ancla trae la cantidad que entró');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'movementCount')::bigint, 5::bigint, 'cinco movimientos desde el ingreso (1 entrada + 4 ventas)');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'currentQuantity')::bigint,
  (select quantity_grams from public.stock_levels where branch_id = 'd3000000-0000-4000-8000-000000000002' and product_id = 'd5000000-0000-4000-8000-000000000001'), 'el saldo final coincide con stock_levels (el ledger)');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'periodStart')::timestamptz, '2026-10-02 13:00:00+00'::timestamptz, 'el período arranca en el instante del ingreso');
select ok((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'periodEnd') = 'null'::jsonb, 'desde el último ingreso no tiene fin');

-- Control ventas vs ledger en el caso normal: coinciden.
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->>'completedQuantity')::bigint, 25400::bigint, 'las ventas COMPLETED suman 25,400 kg');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->>'completedTickets')::bigint, 4::bigint, 'en 4 tickets');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->>'completedRevenueCents')::bigint, 250000::bigint, 'con su importe');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->>'ledgerQuantityForCompleted')::bigint, 25400::bigint, 'el ledger descontó lo mismo por esas ventas');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->>'difference')::bigint, 0::bigint, 'sin discrepancia: ventas = movimientos SALE');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->>'mismatchedSales')::bigint, 0::bigint, 'ningún ticket con diferencia');
select is(jsonb_array_length(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->'mismatches'), 0, 'lista de diferencias vacía');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->'orphanSaleMovements'->>'count')::bigint, 0::bigint, 'ningún SALE huérfano');

-- ---- Rango manual (días locales): 03/10 a 05/10.
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-03', '2026-10-05')->>'mode'), 'RANGE', 'modo rango');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-03', '2026-10-05')->>'openingQuantity')::bigint, 42000::bigint, 'stock al inicio del rango = lo que había antes (42,000 kg)');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-03', '2026-10-05')->>'windowQuantity')::bigint, -23400::bigint, 'movimientos del rango = -(10 + 8 + 5,4) kg (la de 23:30 local entra)');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-03', '2026-10-05')->>'closingQuantity')::bigint, 18600::bigint, 'stock al cierre del rango = 18,600 kg');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-03', '2026-10-05')->>'afterPeriodQuantity')::bigint, -2000::bigint, 'lo posterior al rango (la venta del 08/10) = -2,000 kg');
select is(((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-03', '2026-10-05')->>'closingQuantity')::bigint + (public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-03', '2026-10-05')->>'afterPeriodQuantity')::bigint), 16600::bigint, 'cierre + posterior = stock teórico actual');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-03', '2026-10-05')->'sales'->>'completedQuantity')::bigint, 23400::bigint, 'las ventas del rango coinciden con las del ledger (23,400 kg)');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-06', '2026-10-06')->>'movementCount')::bigint, 0::bigint, 'el 06/10 local no contiene el movimiento de las 23:30 del 05/10');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-05', '2026-10-05')->>'movementCount')::bigint, 1::bigint, 'el 05/10 local contiene el movimiento de las 23:30');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-05', '2026-10-05')->>'periodEnd')::timestamptz, '2026-10-06 03:00:00+00'::timestamptz, 'el fin del día local 05/10 es la medianoche local (03:00Z)');

-- ---- Todos los tipos del ledger y el saldo (Vacío: ingresos, venta, anulación, reserva, merma, ajustes).
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true)->>'currentQuantity')::bigint, 12600::bigint, 'Vacío: stock teórico 12,600 kg');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true)->>'openingQuantity')::bigint, 5000::bigint, 'Vacío: había 5,000 kg antes del último ingreso');
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true), 'PURCHASE'), 20000::bigint, 'Vacío: ingreso (recepción) +20,000');
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true), 'SALE'), -21000::bigint, 'Vacío: SALE incluye la venta, la anulada y la pendiente (3000 + 9000 + 9000)');
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true), 'RETURN'), 9000::bigint, 'Vacío: RETURN repone la anulada');
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true), 'WASTE'), -300::bigint, 'Vacío: merma resta');
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true), 'ADJUSTMENT_NEGATIVE'), -200::bigint, 'Vacío: ajuste negativo resta');
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true), 'ADJUSTMENT_POSITIVE'), 100::bigint, 'Vacío: ajuste positivo suma');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true)->>'openingQuantity')::bigint + (public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true)->>'windowQuantity')::bigint, 12600::bigint, 'inicio + movimientos del período = saldo final');
select is((select sum((t->>'quantity')::bigint)::bigint from jsonb_array_elements(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true)->'byType') t), 7600::bigint, 'los tipos agrupados suman exactamente los movimientos del período (nada queda afuera)');
-- Control de ventas con ruido legítimo: la anulada repuso, la pendiente reserva, la reembolsada no tiene movimientos.
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true)->'sales'->>'completedQuantity')::bigint, 3000::bigint, 'Vacío: ventas COMPLETED 3,000 kg');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true)->'sales'->>'difference')::bigint, 0::bigint, 'Vacío: sin discrepancia aunque haya anuladas y pendientes');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true)->'sales'->>'mismatchedSales')::bigint, 0::bigint, 'Vacío: una anulada con RETURN y una pendiente que reserva no son discrepancias');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true)->'sales'->>'pendingPaymentQuantity')::bigint, 9000::bigint, 'Vacío: informa lo reservado por la venta pendiente de pago');
-- UNIT: unidades, sin conversión; la venta anulada y restablecida concuerda.
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000004', null, null, true)->>'currentQuantity')::bigint, 85::bigint, 'Hamburguesa: 85 unidades');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000004', null, null, true)->'product'->>'unitType'), 'UNIT', 'Hamburguesa: informa que es UNIT');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000004', null, null, true)->'sales'->>'completedQuantity')::bigint, 15::bigint, 'Hamburguesa: 15 unidades vendidas');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000004', null, null, true)->'sales'->>'ledgerQuantityForCompleted')::bigint, 15::bigint, 'Hamburguesa: SALE + RETURN + SALE (restablecida) deja 15 en el ledger');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000004', null, null, true)->'sales'->>'mismatchedSales')::bigint, 0::bigint, 'Hamburguesa: la venta restablecida no es una discrepancia');
-- Producto inactivo y sin ninguna entrada real.
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000005', null, null, true)->>'mode'), 'ALL_HISTORY', 'sin entradas reales (un ajuste no es una recepción) se muestra todo el historial');
select ok((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000005', null, null, true)->'anchor') = 'null'::jsonb, 'sin ancla');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000005', null, null, true)->>'currentQuantity')::bigint, 900::bigint, 'un producto inactivo también se audita');
-- Límite final de un período: un movimiento a las 00:00:00 locales del 06/10 es del 06/10 (el fin es exclusivo).
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000005', '2026-10-05', '2026-10-05')->>'movementCount')::bigint, 0::bigint, 'el movimiento de las 00:00:00 del 06/10 no entra en el 05/10');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000005', '2026-10-06', '2026-10-06')->>'movementCount')::bigint, 1::bigint, 'el movimiento de las 00:00:00 del 06/10 entra en el 06/10');
-- Producto sin movimientos en esa sucursal.
select is((public.zz_audit('d3000000-0000-4000-8000-000000000003', 'd5000000-0000-4000-8000-000000000004', null, null, true)->>'currentQuantity')::bigint, 0::bigint, 'sin movimientos: stock 0, no es un error');
-- Central: la transferencia enviada.
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09'), 'TRANSFER_OUT'), -42000::bigint, 'Central: transferencia enviada -42,000');

-- ---------------------------------------------------------------------------------------------
-- DETALLE CRONOLÓGICO
-- ---------------------------------------------------------------------------------------------
select is((public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'total')::bigint, 5::bigint, 'detalle: 5 movimientos');
select is((select array_agg(r->>'type' order by ord) from jsonb_array_elements(public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'rows') with ordinality as t(r, ord)), array['TRANSFER_IN','SALE','SALE','SALE','SALE'], 'detalle: orden cronológico ascendente');
select is((select array_agg((r->>'balanceAfter')::bigint order by ord) from jsonb_array_elements(public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'rows') with ordinality as t(r, ord)), array[42000,32000,24000,18600,16600]::bigint[], 'detalle: saldo resultante tras cada movimiento');
select is((select array_agg((r->>'quantity')::bigint order by ord) from jsonb_array_elements(public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'rows') with ordinality as t(r, ord)), array[42000,-10000,-8000,-5400,-2000]::bigint[], 'detalle: cantidades firmadas');
select is((public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'rows'->4->>'balanceAfter')::bigint, (public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'closingQuantity')::bigint, 'el último saldo del detalle es el stock al cierre');
select is((public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'rows'->0->>'counterpartBranchName'), 'Central', 'la transferencia recibida dice de dónde viene');
select is((public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', '2026-10-02', '2026-10-02')->'rows'->0->>'counterpartBranchName'), 'Avenida', 'la transferencia enviada dice a dónde va');
select is((public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'rows'->1->>'saleStatus'), 'COMPLETED', 'una venta trae su ticket y su estado');
select ok((public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'rows'->1->>'saleId') is not null, 'la venta trae su referencia');
select is((public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'rows'->1->>'operatorName'), 'Audit Admin A', 'trae el operador que registró el movimiento');
select is((public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', null, null, true)->'rows'->0->>'supplier'), 'Frigorífico X', 'una recepción trae su proveedor');
-- Paginación.
select is((select array_agg((r->>'balanceAfter')::bigint order by ord) from jsonb_array_elements(public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true, 2, 2)->'rows') with ordinality as t(r, ord)), array[24000,18600]::bigint[], 'página 2 (limit 2, offset 2)');
select is((public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true, 2, 2)->>'total')::bigint, 5::bigint, 'el total no depende de la página');
select is(jsonb_array_length(public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true, 2, 4)->'rows'), 1, 'la última página trae el resto');
select is(jsonb_array_length(public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true, 2, 10)->'rows'), 0, 'una página fuera de rango queda vacía');
select is((select array_agg((r->>'balanceAfter')::bigint order by ord) from jsonb_array_elements(public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true, 50, 0, true)->'rows') with ordinality as t(r, ord)), array[16600,18600,24000,32000,42000]::bigint[], 'más recientes primero: invierte el orden sin cambiar los saldos');
select is((select array_agg((r->>'balanceAfter')::bigint order by ord) from jsonb_array_elements(public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true, 2, 1, true)->'rows') with ordinality as t(r, ord)), array[18600,24000]::bigint[], 'más recientes primero, página 2: salta el más nuevo');
-- Detalle de un rango: el saldo arranca desde el stock inicial del rango.
select is((select array_agg((r->>'balanceAfter')::bigint order by ord) from jsonb_array_elements(public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-04', '2026-10-05')->'rows') with ordinality as t(r, ord)), array[24000,18600]::bigint[], 'en un rango, el saldo de cada fila incluye el stock inicial del rango');
select is((public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-04', '2026-10-05')->>'openingQuantity')::bigint, 32000::bigint, 'el detalle informa el stock inicial');
select throws_ok($$select public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true, 0)$$, '22023', null, 'limit 0 se rechaza');
select throws_ok($$select public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true, 201)$$, '22023', null, 'limit mayor al máximo se rechaza');
select throws_ok($$select public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true, 50, -1)$$, '22023', null, 'offset negativo se rechaza');

-- ---------------------------------------------------------------------------------------------
-- VALIDACIONES
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001')$$, '22023', null, 'sin ancla ni rango se rechaza');
select throws_ok($$select public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-09', '2026-10-01')$$, '22023', null, 'desde posterior a hasta se rechaza');
select throws_ok($$select public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2025-01-01', '2026-10-09')$$, '22023', null, 'más de 366 días se rechaza');
select throws_ok($$select public.get_stock_audit_summary(null, 'd5000000-0000-4000-8000-000000000001', null, null, true)$$, '22023', null, 'la sucursal es obligatoria');
select throws_ok($$select public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000002', null, null, null, true)$$, '22023', null, 'el producto es obligatorio');

-- ---------------------------------------------------------------------------------------------
-- SEGURIDAD: multiempresa
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000009', 'd5000000-0000-4000-8000-000000000009', null, null, true)$$, '42501', null, 'admin A no audita una sucursal de la org B');
select throws_ok($$select public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000009', null, null, true)$$, '42501', null, 'admin A no audita un producto de la org B en su propia sucursal');
select throws_ok($$select public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000009', 'd5000000-0000-4000-8000-000000000009', null, null, true)$$, '42501', null, 'el detalle tampoco cruza organizaciones');
select throws_ok($$select public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000009', null, null, true)$$, '42501', null, 'el detalle rechaza un producto ajeno');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$select public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)$$, '42501', null, 'admin B no audita la sucursal/producto de la org A');
select throws_ok($$select public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000009', 'd5000000-0000-4000-8000-000000000001', null, null, true)$$, '42501', null, 'admin B con su sucursal pero producto de la org A: rechazado');
select throws_ok($$select * from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09')$$, '42501', null, 'admin B no consulta ventas de un producto de la org A');
select is((public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000009', 'd5000000-0000-4000-8000-000000000009', null, null, true)->>'currentQuantity')::bigint, 7000::bigint, 'admin B audita lo suyo');
select is((select count(*) from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000009', '2026-10-01', '2026-10-09')), 1::bigint, 'admin B ve solo sus sucursales en las ventas por producto');

-- ---------------------------------------------------------------------------------------------
-- SEGURIDAD: permisos y acceso por sucursal
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'currentQuantity')::bigint, 16600::bigint, 'el empleado ve su sucursal (Avenida)');
select throws_ok($$select public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000003', 'd5000000-0000-4000-8000-000000000001', null, null, true)$$, '42501', null, 'el empleado no audita otra sucursal (Janssen)');
select throws_ok($$select public.list_stock_audit_movements('d3000000-0000-4000-8000-000000000003', 'd5000000-0000-4000-8000-000000000001', null, null, true)$$, '42501', null, 'el empleado no lista movimientos de otra sucursal');
select throws_ok($$select * from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09', 'd3000000-0000-4000-8000-000000000003')$$, '42501', null, 'el empleado no consulta ventas de otra sucursal');
select is((select count(*) from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09')), 1::bigint, 'sin filtro, el empleado solo recibe sus sucursales (Avenida)');
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09')), 25400::bigint, 'y sin filtro no se cuela Janssen ni Central');

-- Rol con stock.read pero SIN sales.read: audita el stock, no ve ventas.
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'currentQuantity')::bigint, 16600::bigint, 'stock.read alcanza para auditar el ledger');
select ok((public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales') = 'null'::jsonb, 'sin sales.read el control de ventas no se expone');
select throws_ok($$select * from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-01', '2026-10-09')$$, '42501', null, 'sin sales.read no hay ventas por producto');

-- Anónimo / sin sesión.
reset role;
set local role anon;
select throws_ok($$select public.get_stock_audit_summary('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)$$, '42501', null, 'anon no puede ejecutar la auditoría');

-- ---------------------------------------------------------------------------------------------
-- DISCREPANCIA DETECTABLE (sin corregir nada)
-- Una venta COMPLETED de 3 kg cuyo movimiento SALE descontó solo 1,5 kg; y un SALE de Pata Muslo
-- colgado de una venta que no tiene Pata Muslo.
-- ---------------------------------------------------------------------------------------------
reset role;
select public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-08 22:00:00+00', 'd5000000-0000-4000-8000-000000000001', 3000, null, 30000, 0, 1500);
select public.zz_move('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', 'SALE', -400, '2026-10-08 23:00:00+00',
  public.zz_sale('d3000000-0000-4000-8000-000000000002', 'COMPLETED', '2026-10-08 23:00:00+00', 'd5000000-0000-4000-8000-000000000002', 400, null, 4000));
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->>'completedQuantity')::bigint, 28400::bigint, 'discrepancia: las ventas dicen 28,400 kg');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->>'ledgerQuantityForCompleted')::bigint, 26900::bigint, 'discrepancia: el ledger descontó 26,900 kg por esas ventas');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->>'difference')::bigint, 1500::bigint, 'discrepancia: 1,500 kg de diferencia');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->>'mismatchedSales')::bigint, 1::bigint, 'un ticket con diferencia');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->'mismatches'->0->>'saleQuantity')::bigint, 3000::bigint, 'el ticket dice 3,000 kg');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->'mismatches'->0->>'ledgerQuantity')::bigint, 1500::bigint, 'el ledger descontó 1,500 kg por ese ticket');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->'mismatches'->0->>'status'), 'COMPLETED', 'el ticket discrepante trae su estado');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->'orphanSaleMovements'->>'count')::bigint, 1::bigint, 'un SALE sin línea de este producto en su venta');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->'sales'->'orphanSaleMovements'->>'quantity')::bigint, 400::bigint, 'por 400 g');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true)->>'currentQuantity')::bigint, 14700::bigint, 'la discrepancia no corrige el stock: el ledger sigue siendo la verdad (14,700 kg)');
select is(public.zz_type_qty(public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', null, null, true), 'SALE'), -27300::bigint, 'los SALE del ledger suman 27,300 kg (vs. 28,400 de las ventas)');

-- ---------------------------------------------------------------------------------------------
-- Zona horaria de la organización: con Tokio el mismo instante cae en otro día.
-- ---------------------------------------------------------------------------------------------
reset role;
update public.organizations set timezone = 'Asia/Tokyo' where id = 'd2000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
-- 2026-10-06 02:30Z = 06/10 11:30 en Tokio.
select is((select quantity from public.get_product_sales_summary('d5000000-0000-4000-8000-000000000001', '2026-10-06', '2026-10-06', 'd3000000-0000-4000-8000-000000000002')), 5400::bigint, 'con Tokio, la venta de 02:30Z cae el 06/10');
select is((public.zz_audit('d3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', '2026-10-06', '2026-10-06')->>'periodEnd')::timestamptz, '2026-10-06 15:00:00+00'::timestamptz, 'con Tokio, el fin del 06/10 local es 15:00Z');

-- ---------------------------------------------------------------------------------------------
-- Sólo lectura: nada cambió en el ledger, el stock ni las ventas.
-- ---------------------------------------------------------------------------------------------
reset role;
select is((select count(*) from public.stock_movements), current_setting('zz.movements')::bigint + 3, 'el ledger solo creció por los 3 movimientos de la fase de discrepancia (fixture), nunca por una consulta');
select is((select count(*) from public.sales), current_setting('zz.sales')::bigint + 2, 'las ventas solo crecieron por el fixture de discrepancia');

select * from finish();
rollback;
