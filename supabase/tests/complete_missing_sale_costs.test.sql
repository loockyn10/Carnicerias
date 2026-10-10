begin;

create extension if not exists pgtap with schema extensions;
select plan(127);

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'get_missing_sale_costs', array['date','date','uuid'], 'get_missing_sale_costs exists');
select has_function('public', 'complete_missing_sale_costs', array['uuid','date','date','uuid','bigint','uuid[]','boolean'], 'complete_missing_sale_costs exists');
select ok((select prosecdef from pg_proc where oid = 'public.get_missing_sale_costs(date,date,uuid)'::regprocedure), 'the read is security definer');
select ok((select prosecdef from pg_proc where oid = 'public.complete_missing_sale_costs(uuid,date,date,uuid,bigint,uuid[],boolean)'::regprocedure), 'the repair is security definer');
select is((select array_to_string(proconfig, ',') from pg_proc where oid = 'public.get_missing_sale_costs(date,date,uuid)'::regprocedure), 'search_path=""', 'the read has an empty search path');
select is((select array_to_string(proconfig, ',') from pg_proc where oid = 'public.complete_missing_sale_costs(uuid,date,date,uuid,bigint,uuid[],boolean)'::regprocedure), 'search_path=""', 'the repair has an empty search path');
select ok(not has_function_privilege('anon', 'public.get_missing_sale_costs(date,date,uuid)', 'EXECUTE'), 'anonymous cannot list missing costs');
select ok(not has_function_privilege('anon', 'public.complete_missing_sale_costs(uuid,date,date,uuid,bigint,uuid[],boolean)', 'EXECUTE'), 'anonymous cannot repair costs');
select ok(has_function_privilege('authenticated', 'public.get_missing_sale_costs(date,date,uuid)', 'EXECUTE'), 'authenticated can call the read');
select ok(has_function_privilege('authenticated', 'public.complete_missing_sale_costs(uuid,date,date,uuid,bigint,uuid[],boolean)', 'EXECUTE'), 'authenticated can call the repair');

-- ---------------------------------------------------------------------------------------------
-- Fixture. Org A (America/Argentina/Buenos_Aires, UTC-3): Centro y Norte. Org B: una sucursal.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cm-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"CM Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cm-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"CM Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'cm-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"CM Admin B"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'cm-analyst-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"CM Analyst A"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'CM Org A', 'cm-org-a'),
  ('c2000000-0000-4000-8000-000000000002', 'CM Org B', 'cm-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Centro', 'CM-CENTRO'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Norte', 'CM-NORTE'),
  ('c3000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'Org B Branch', 'CM-B');
-- Un analista: ve rentabilidad (analytics.read) de todas las sucursales, pero NO escribe precios/costos.
insert into public.roles (id, organization_id, key, name, is_system) values
  ('c7000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'cm_analyst', 'CM Analyst', false);
insert into public.role_permissions (role_id, permission_key) values
  ('c7000000-0000-4000-8000-000000000001', 'analytics.read'),
  ('c7000000-0000-4000-8000-000000000001', 'branches.read_all');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000004', 'c7000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Carnes', 'cm-carnes'),
  ('c4000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Bebidas', 'cm-bebidas'),
  ('c4000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'Varios B', 'cm-varios-b');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Pata muslo', 'cm-pata', 'CM-PATA', 'WEIGHT'),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'Coca Cola', 'cm-coca', 'CM-COCA', 'UNIT'),
  ('c5000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Con costo', 'cm-ya', 'CM-YA', 'WEIGHT'),
  ('c5000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000009', 'Producto B', 'cm-prod-b', 'CM-PB', 'WEIGHT');
-- Precios de lista vigentes (para comprobar si guardar un costo vigente los recalcula).
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 500000, now() - interval '1 day'),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000002', 400000, now() - interval '1 day');

-- Ventas (hora local Buenos Aires = UTC-3). Rango principal: 10/03 a 11/03/2026.
--   Centro: V1 Pata 2,500 kg ($12.500) · V2 Pata 3,100 kg ($15.500) · V3 Coca 3 u ($12.000) · V4 Coca 5 u ($20.000 - $1.000 desc. ticket)
--           V5 «Con costo» ya tiene costo · V6 Pata YA con snapshot (100) · V7 PENDING_PAYMENT · V8 del 12/03 (fuera del rango)
--   Norte:  V9..V15 sin costo (Pata x5, Coca x2) para los casos de costo vigente / repricing (V14 y V15 quedan sin completar a propósito).
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, ticket_discount_bps, ticket_discount_cents, completed_at) values
  ('c6000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 1250000, 2500, 0, 0, '2026-03-10 13:00:00+00'),
  ('c6000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 1550000, 3100, 0, 0, '2026-03-10 16:41:00+00'),
  ('c6000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 1200000, 0, 0, 0, '2026-03-10 17:00:00+00'),
  ('c6000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 1900000, 0, 500, 100000, '2026-03-11 15:00:00+00'),
  ('c6000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 800000, 1000, 0, 0, '2026-03-10 18:00:00+00'),
  ('c6000000-0000-4000-8000-000000000006', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 500000, 1000, 0, 0, '2026-03-10 19:00:00+00'),
  ('c6000000-0000-4000-8000-000000000007', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'PENDING_PAYMENT', 500000, 1000, 0, 0, '2026-03-10 20:00:00+00'),
  ('c6000000-0000-4000-8000-000000000008', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 500000, 1000, 0, 0, '2026-03-12 15:00:00+00'),
  ('c6000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 1000000, 2000, 0, 0, '2026-03-10 13:00:00+00'),
  ('c6000000-0000-4000-8000-000000000010', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 500000, 1000, 0, 0, '2026-03-10 14:00:00+00'),
  ('c6000000-0000-4000-8000-000000000011', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 800000, 0, 0, 0, '2026-03-10 15:00:00+00'),
  ('c6000000-0000-4000-8000-000000000012', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 500000, 1000, 0, 0, '2026-03-10 16:00:00+00'),
  ('c6000000-0000-4000-8000-000000000013', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 350000, 700, 0, 0, '2026-03-10 17:00:00+00'),
  ('c6000000-0000-4000-8000-000000000014', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 250000, 500, 0, 0, '2026-03-10 18:00:00+00'),
  ('c6000000-0000-4000-8000-000000000015', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'COMPLETED', 400000, 0, 0, 0, '2026-03-10 19:00:00+00'),
  ('c6000000-0000-4000-8000-000000000099', 'c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000009', 'c1000000-0000-4000-8000-000000000003', 'COMPLETED', 5000000, 1000, 0, 0, '2026-03-10 15:00:00+00');

-- Líneas WEIGHT (sin quantity_units): costo snapshot en $/kg.
insert into public.sale_items (id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot) values
  ('c9000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Pata muslo', 2500, 500000, 500000, 500000, 1250000, null),
  ('c9000000-0000-4000-8000-000000000002', 'c6000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Pata muslo', 3100, 500000, 500000, 500000, 1550000, null),
  ('c9000000-0000-4000-8000-000000000005', 'c6000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003', 'Con costo', 1000, 800000, 800000, 800000, 800000, 300000),
  ('c9000000-0000-4000-8000-000000000006', 'c6000000-0000-4000-8000-000000000006', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Pata muslo', 1000, 500000, 500000, 500000, 500000, 100),
  ('c9000000-0000-4000-8000-000000000007', 'c6000000-0000-4000-8000-000000000007', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Pata muslo', 1000, 500000, 500000, 500000, 500000, null),
  ('c9000000-0000-4000-8000-000000000008', 'c6000000-0000-4000-8000-000000000008', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Pata muslo', 1000, 500000, 500000, 500000, 500000, null),
  ('c9000000-0000-4000-8000-000000000009', 'c6000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001', 'Pata muslo', 2000, 500000, 500000, 500000, 1000000, null),
  ('c9000000-0000-4000-8000-000000000010', 'c6000000-0000-4000-8000-000000000010', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001', 'Pata muslo', 1000, 500000, 500000, 500000, 500000, null),
  ('c9000000-0000-4000-8000-000000000012', 'c6000000-0000-4000-8000-000000000012', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001', 'Pata muslo', 1000, 500000, 500000, 500000, 500000, null),
  ('c9000000-0000-4000-8000-000000000013', 'c6000000-0000-4000-8000-000000000013', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001', 'Pata muslo', 700, 500000, 500000, 500000, 350000, null),
  ('c9000000-0000-4000-8000-000000000014', 'c6000000-0000-4000-8000-000000000014', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001', 'Pata muslo', 500, 500000, 500000, 500000, 250000, null),
  ('c9000000-0000-4000-8000-000000000099', 'c6000000-0000-4000-8000-000000000099', 'c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000009', 'c5000000-0000-4000-8000-000000000009', 'Producto B', 1000, 5000000, 5000000, 5000000, 5000000, null);
-- Líneas UNIT (sin weight_grams): costo snapshot en $/u. V4 lleva un descuento general del ticket de $1.000 (ingreso = subtotal - descuento).
insert into public.sale_items (id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, ticket_discount_cents, cost_cents_snapshot) values
  ('c9000000-0000-4000-8000-000000000003', 'c6000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000002', 'Coca Cola', 3, 400000, 400000, 400000, 1200000, 0, null),
  ('c9000000-0000-4000-8000-000000000004', 'c6000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000002', 'Coca Cola', 5, 400000, 400000, 400000, 2000000, 100000, null),
  ('c9000000-0000-4000-8000-000000000011', 'c6000000-0000-4000-8000-000000000011', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002', 'Coca Cola', 2, 400000, 400000, 400000, 800000, 0, null),
  ('c9000000-0000-4000-8000-000000000015', 'c6000000-0000-4000-8000-000000000015', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002', 'Coca Cola', 1, 400000, 400000, 400000, 400000, 0, null);

-- Helpers de test (security definer: leen/escriben saltando RLS). Se descartan con el rollback.
create table public.t_cmc_fp (label text primary key, fp text not null);
grant all on public.t_cmc_fp to public;
-- Huella de TODO lo que la reparación no puede tocar: cantidades, precios, totales, descuentos, estado, y el ledger de stock.
create function public.t_cmc_fingerprint() returns text language sql security definer set search_path = '' as $$
  select md5(
    coalesce((select string_agg(concat_ws('|', i.id, i.sale_id, i.product_id, i.weight_grams, i.quantity_units, i.price_per_kg_cents, i.original_price_per_kg_cents,
      i.final_price_per_kg_cents, i.subtotal_cents, i.ticket_discount_cents, i.discount_cents, i.promotion_discount_cents), ';' order by i.id) from public.sale_items i), '')
    || '#' || coalesce((select string_agg(concat_ws('|', s.id, s.status, s.total_cents, s.total_weight_grams, s.ticket_discount_cents, s.completed_at), ';' order by s.id) from public.sales s), '')
    || '#' || (select count(*)::text from public.stock_movements)
    || '#' || (select count(*)::text from public.payments)
  )
$$;
create function public.t_cmc_snap(p_line uuid) returns bigint language sql security definer set search_path = '' as $$
  select cost_cents_snapshot from public.sale_items where id = p_line $$;
create function public.t_cmc_audits() returns bigint language sql security definer set search_path = '' as $$
  select count(*) from public.audit_logs where event_type = 'SALE_COSTS_BACKFILLED' $$;
-- La fila de auditoría que registró una línea (dentro de una transacción de test now() no avanza: no se puede ordenar por fecha).
create function public.t_cmc_audit_for(p_line uuid) returns public.audit_logs language sql security definer set search_path = '' as $$
  select a from public.audit_logs a where a.event_type = 'SALE_COSTS_BACKFILLED' and a.after_data -> 'lineIds' ? p_line::text limit 1 $$;
create function public.t_cmc_cost_rows(p_product uuid) returns bigint language sql security definer set search_path = '' as $$
  select count(*) from public.product_costs where product_id = p_product $$;
create function public.t_cmc_current_cost(p_product uuid) returns bigint language sql security definer set search_path = '' as $$
  select cost_cents from public.product_costs where product_id = p_product and valid_to is null $$;
create function public.t_cmc_price(p_product uuid) returns bigint language sql security definer set search_path = '' as $$
  select price_cents from public.product_prices where product_id = p_product and branch_id is null and valid_to is null $$;
create function public.t_cmc_price_rows(p_product uuid) returns bigint language sql security definer set search_path = '' as $$
  select count(*) from public.product_prices where product_id = p_product $$;
create function public.t_cmc_formula_price(p_cost bigint, p_bps integer) returns bigint language sql security definer set search_path = '' as $$
  select app_private.list_price_from_margin(p_cost, p_bps) $$;
grant execute on function public.t_cmc_fingerprint(), public.t_cmc_snap(uuid), public.t_cmc_audits(), public.t_cmc_audit_for(uuid), public.t_cmc_cost_rows(uuid),
  public.t_cmc_current_cost(uuid), public.t_cmc_price(uuid), public.t_cmc_price_rows(uuid), public.t_cmc_formula_price(bigint, integer) to public;

insert into public.t_cmc_fp values ('before', public.t_cmc_fingerprint());

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Listado de Centro (10/03 a 11/03): exactamente las líneas COMPLETED, de la sucursal, del rango y sin costo
-- ---------------------------------------------------------------------------------------------
create temp table cm_list on commit drop as
  select public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001') as j;
grant all on cm_list to public;

select is((select (j ->> 'totalLines')::int from cm_list), 4, 'lists exactly the 4 lines without cost (V1..V4)');
select is((select (j ->> 'totalRevenueCents')::bigint from cm_list), 5900000::bigint, 'their revenue is subtotal - ticket discount (12.500 + 15.500 + 12.000 + 19.000)');
select is((select jsonb_array_length(j -> 'products') from cm_list), 2, 'grouped by product: Pata muslo and Coca Cola');
select is((select p ->> 'productName' from cm_list, jsonb_array_elements(j -> 'products') with ordinality t(p, n) where n = 1), 'Coca Cola', 'products come ordered by revenue (Coca $31.000 > Pata $28.000)');
select is((select (p ->> 'quantity')::bigint from cm_list, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Pata muslo'), 5600::bigint, 'WEIGHT quantity is the sum of grams (2.500 + 3.100)');
select is((select p ->> 'unitType' from cm_list, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Pata muslo'), 'WEIGHT', 'Pata is sold by weight');
select is((select (p ->> 'lineCount')::int from cm_list, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Pata muslo'), 2, 'Pata has 2 affected lines');
select is((select (p ->> 'revenueCents')::bigint from cm_list, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Pata muslo'), 2800000::bigint, 'Pata revenue is $28.000');
select is((select (p ->> 'quantity')::bigint from cm_list, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Coca Cola'), 8::bigint, 'UNIT quantity is the sum of units (3 + 5)');
select is((select p ->> 'unitType' from cm_list, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Coca Cola'), 'UNIT', 'Coca is sold by unit');
select is((select (p ->> 'revenueCents')::bigint from cm_list, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Coca Cola'), 3100000::bigint, 'Coca revenue keeps the ticket discount out ($12.000 + $19.000)');
select is(
  (select array_agg(l ->> 'lineId' order by n) from cm_list, jsonb_array_elements(j -> 'products') p, jsonb_array_elements(p -> 'lines') with ordinality t(l, n) where p ->> 'productName' = 'Pata muslo'),
  array['c9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000002'],
  'the Pata lines are exactly V1 and V2, oldest first: no costed line (V6), pending sale (V7), out-of-range sale (V8), other branch (V9) or other organization'
);
select is(
  (select array_agg(l ->> 'lineId' order by n) from cm_list, jsonb_array_elements(j -> 'products') p, jsonb_array_elements(p -> 'lines') with ordinality t(l, n) where p ->> 'productName' = 'Coca Cola'),
  array['c9000000-0000-4000-8000-000000000003', 'c9000000-0000-4000-8000-000000000004'],
  'the Coca lines are exactly V3 and V4'
);
select is((select (l ->> 'quantity')::bigint from cm_list, jsonb_array_elements(j -> 'products') p, jsonb_array_elements(p -> 'lines') l where l ->> 'lineId' = 'c9000000-0000-4000-8000-000000000001'), 2500::bigint, 'a line shows its own quantity (2.500 kg)');
select is((select (l ->> 'saleId') from cm_list, jsonb_array_elements(j -> 'products') p, jsonb_array_elements(p -> 'lines') l where l ->> 'lineId' = 'c9000000-0000-4000-8000-000000000001'), 'c6000000-0000-4000-8000-000000000001', 'a line points to its sale');
select is((select (j ->> 'totalLines')::int from cm_list), (select missing_cost_items from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')), 'the count is the same one the summary warning shows');
select is((select (j ->> 'totalRevenueCents')::bigint from cm_list), (select missing_cost_revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')), 'the revenue is the same one the summary warning shows');
select ok((select (j ->> 'canRepair')::boolean from cm_list), 'an admin (prices.write) can repair');
select is((select (p ->> 'currentCostCents') from cm_list, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Pata muslo'), null, 'Pata has no current cost yet');
select is((select j ->> 'timezone' from cm_list), 'America/Argentina/Buenos_Aires', 'the organization timezone is returned for the line timestamps');
select ok(not (select (j ->> 'truncated')::boolean from cm_list), 'a short list is not truncated');
select is((select (public.get_missing_sale_costs('2026-03-11', '2026-03-11', 'c3000000-0000-4000-8000-000000000001') ->> 'totalLines')::int), 1, 'the range is respected (11/03 only has V4)');
select is((select (public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000002') ->> 'totalLines')::int), 7, 'Norte lists only its own 7 lines (V9, V10, V12, V13, V14 Pata and V11, V15 Coca)');

select throws_ok($$select public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000009')$$, '42501', 'Branch was not found in this organization', 'a branch of another organization is rejected');
select throws_ok($$select public.get_missing_sale_costs('2026-03-11', '2026-03-10', 'c3000000-0000-4000-8000-000000000001')$$, '22023', 'La fecha inicial no puede ser posterior a la final', 'an inverted range is rejected');

-- ---------------------------------------------------------------------------------------------
-- Permisos y aislamiento
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')$$, '42501', null, 'an employee without analytics.read cannot list');
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, array['c9000000-0000-4000-8000-000000000001']::uuid[], false)$$, '42501', null, 'an employee without prices.write cannot repair');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is((public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001') ->> 'totalLines')::int, 4, 'an analyst (analytics.read) can see what is missing');
select ok(not (public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001') ->> 'canRepair')::boolean, 'but is told they cannot repair');
select ok((select bool_and(p ->> 'currentCostCents' is null and p ->> 'currentPriceCents' is null and p ->> 'marginBps' is null and p ->> 'repricesOnCostChange' = 'false')
  from jsonb_array_elements(public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001') -> 'products') p), 'and does not receive costs, prices or margins (prices.write data)');
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, array['c9000000-0000-4000-8000-000000000001']::uuid[], false)$$, '42501', null, 'an analyst without prices.write cannot repair');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, array['c9000000-0000-4000-8000-000000000001']::uuid[], false)$$, '42501', 'Branch was not found in this organization', 'the admin of ANOTHER organization cannot repair this organization''s branch');
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000009', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, array['c9000000-0000-4000-8000-000000000001']::uuid[], false)$$, '42501', 'Product was not found in this organization', 'nor use their own branch with this organization''s product');
select throws_ok($$select public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')$$, '42501', 'Branch was not found in this organization', 'nor list this organization''s branch');
select is((select (public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000009') ->> 'totalLines')::int), 1, 'each organization sees only its own missing lines');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000009', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000009', 380000, array['c9000000-0000-4000-8000-000000000099']::uuid[], false)$$, '42501', 'Branch was not found in this organization', 'the admin of THIS organization cannot touch the other organization''s branch');

-- ---------------------------------------------------------------------------------------------
-- Validaciones de entrada
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 0, array['c9000000-0000-4000-8000-000000000001']::uuid[], false)$$, '22023', 'El costo tiene que ser un importe mayor a cero', 'a zero cost is rejected');
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', -5, array['c9000000-0000-4000-8000-000000000001']::uuid[], false)$$, '22023', 'El costo tiene que ser un importe mayor a cero', 'a negative cost is rejected');
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', null, array['c9000000-0000-4000-8000-000000000001']::uuid[], false)$$, '22023', 'El costo tiene que ser un importe mayor a cero', 'a missing cost is rejected');
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, array[]::uuid[], false)$$, '22023', 'Debe enviar entre 1 y 5000 líneas', 'an empty line list is rejected');
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, null, false)$$, '22023', 'Faltan las líneas a completar', 'a null line list is rejected');
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-11', '2026-03-10', 'c5000000-0000-4000-8000-000000000001', 380000, array['c9000000-0000-4000-8000-000000000001']::uuid[], false)$$, '22023', 'La fecha inicial no puede ser posterior a la final', 'an inverted range is rejected on repair too');
select throws_ok($$select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-0000000000ff', 380000, array['c9000000-0000-4000-8000-000000000001']::uuid[], false)$$, '42501', 'Product was not found in this organization', 'an unknown product is rejected');

-- ---------------------------------------------------------------------------------------------
-- Líneas que NO califican: no se tocan y se informan como omitidas
-- ---------------------------------------------------------------------------------------------
create temp table cm_r as select 'wrong-branch'::text as k, public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000002', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, array['c9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000002']::uuid[], false) as j;
insert into cm_r select 'wrong-product', public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000002', 380000, array['c9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000002']::uuid[], false);
insert into cm_r select 'wrong-range', public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-11', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, array['c9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000002']::uuid[], false);
insert into cm_r select 'pending-and-future', public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, array['c9000000-0000-4000-8000-000000000007', 'c9000000-0000-4000-8000-000000000008']::uuid[], false);
insert into cm_r select 'already-costed', public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, array['c9000000-0000-4000-8000-000000000006']::uuid[], false);
insert into cm_r select 'unknown-ids', public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000, array['c9000000-0000-4000-8000-0000000000ee']::uuid[], false);
grant all on cm_r to public;

select is((select (j ->> 'repairedLines')::int from cm_r where k = 'wrong-branch'), 0, 'lines of Centro are not repaired through Norte');
select is((select (j ->> 'skippedLines')::int from cm_r where k = 'wrong-branch'), 2, 'and are reported as skipped');
select is((select (j ->> 'repairedLines')::int from cm_r where k = 'wrong-product'), 0, 'lines of Pata are not repaired as Coca');
select is((select (j ->> 'repairedLines')::int from cm_r where k = 'wrong-range'), 0, 'lines outside the selected period are not repaired (V1/V2 are on 10/03)');
select is((select (j ->> 'repairedLines')::int from cm_r where k = 'pending-and-future'), 0, 'a pending-payment sale and a sale outside the range are not repaired');
select is((select (j ->> 'repairedLines')::int from cm_r where k = 'already-costed'), 0, 'a line that already has a historical cost is not repaired');
select is(public.t_cmc_snap('c9000000-0000-4000-8000-000000000006'), 100::bigint, 'and its historical cost is untouched (still 1,00 $/kg)');
select is((select (j ->> 'skippedLines')::int from cm_r where k = 'unknown-ids'), 1, 'an id that does not exist is skipped, not an error');
select ok(public.t_cmc_snap('c9000000-0000-4000-8000-000000000001') is null and public.t_cmc_snap('c9000000-0000-4000-8000-000000000002') is null
  and public.t_cmc_snap('c9000000-0000-4000-8000-000000000007') is null and public.t_cmc_snap('c9000000-0000-4000-8000-000000000008') is null
  and public.t_cmc_snap('c9000000-0000-4000-8000-000000000009') is null and public.t_cmc_snap('c9000000-0000-4000-8000-000000000099') is null, 'none of the rejected attempts completed any line');
select is(public.t_cmc_audits(), 0::bigint, 'no audit row is written when nothing was repaired');

-- ---------------------------------------------------------------------------------------------
-- WEIGHT: Pata a $3.800/kg. V1 (2,500 kg) -> $9.500 · V2 (3,100 kg) -> $11.780. Una línea con costo viaja en el pedido y no se toca.
-- ---------------------------------------------------------------------------------------------
select is((public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000,
  array['c9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000006']::uuid[], false) ->> 'repairedLines')::int, 1, 'a mixed request repairs only the line without cost');
select is(public.t_cmc_snap('c9000000-0000-4000-8000-000000000001'), 380000::bigint, 'V1 now stores the cost PER KG (3.800 $/kg), the same unit as product_costs');
select is(public.t_cmc_snap('c9000000-0000-4000-8000-000000000006'), 100::bigint, 'V6 keeps its existing cost although it was in the request');
select is(public.t_cmc_audits(), 1::bigint, 'one audit row for the repair');
select is((select (a).entity_id from (select public.t_cmc_audit_for('c9000000-0000-4000-8000-000000000001') a) s), 'c5000000-0000-4000-8000-000000000001'::uuid, 'the audit points at the product');
select is((select (a).branch_id from (select public.t_cmc_audit_for('c9000000-0000-4000-8000-000000000001') a) s), 'c3000000-0000-4000-8000-000000000001'::uuid, 'at the branch');
select is((select (a).actor_profile_id from (select public.t_cmc_audit_for('c9000000-0000-4000-8000-000000000001') a) s), 'c1000000-0000-4000-8000-000000000001'::uuid, 'and at who did it');
select is((select (a).after_data ->> 'unitCostCents' from (select public.t_cmc_audit_for('c9000000-0000-4000-8000-000000000001') a) s), '380000', 'the audit records the cost applied');
select is((select (a).after_data -> 'lineIds' from (select public.t_cmc_audit_for('c9000000-0000-4000-8000-000000000001') a) s), '["c9000000-0000-4000-8000-000000000001"]'::jsonb, 'the audit records exactly the repaired lines (not the skipped one)');
select is((select (a).after_data -> 'period' from (select public.t_cmc_audit_for('c9000000-0000-4000-8000-000000000001') a) s), '{"from": "2026-03-10", "to": "2026-03-11"}'::jsonb, 'and the period');
select is((select (a).after_data ->> 'alsoSetCurrentCost' from (select public.t_cmc_audit_for('c9000000-0000-4000-8000-000000000001') a) s), 'false', 'and that the current cost was not touched');

-- Repetir el mismo pedido (o completar el resto) es idempotente: la línea que ya se completó no se vuelve a escribir.
select is((public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 999999,
  array['c9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000002']::uuid[], false) ->> 'repairedLines')::int, 1, 'a retry with a different cost repairs only V2');
select is(public.t_cmc_snap('c9000000-0000-4000-8000-000000000001'), 380000::bigint, 'V1 is not overwritten by the second request');
select is(public.t_cmc_snap('c9000000-0000-4000-8000-000000000002'), 999999::bigint, 'V2 (still without cost) received the cost of that request');
reset role;
update public.sale_items set cost_cents_snapshot = null where id = 'c9000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000,
  array['c9000000-0000-4000-8000-000000000002']::uuid[], false) ->> 'repairedLines')::int, 1, 'V2 (reset by the test as owner) is repaired at 3.800 $/kg');
select is((public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000,
  array['c9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000002']::uuid[], false) ->> 'repairedLines')::int, 0, 'repeating the same request repairs nothing');
select is(public.t_cmc_audits(), 3::bigint, 'and the no-op does not add an audit row (3 real repairs so far)');

-- La ganancia cambia con el backfill, con aritmética entera exacta: V1 = round(380000 x 2500 / 1000) = 950000 · V2 = round(380000 x 3100 / 1000) = 1178000.
select is((select missing_cost_items from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')), 2, 'the warning counter drops from 4 to 2 lines (only Coca left)');
select is((select missing_cost_revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')), 3100000::bigint, 'and the revenue left out of the profit drops to $31.000');
select is((select cost_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')), 2428100::bigint, 'cost = 300.000 (V5) + 100 (V6) + 950.000 (V1: 2,500 kg x $3.800 = $9.500) + 1.178.000 (V2)');
select is((select gross_profit_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')), 1671900::bigint, 'gross profit grows from $9.999 to $16.719');

-- ---------------------------------------------------------------------------------------------
-- UNIT: Coca a $2.000/u. V3 (3 u) -> $6.000. Entre que se abrió la pantalla y se guardó, alguien completó V3: no se pisa.
-- ---------------------------------------------------------------------------------------------
reset role;
update public.sale_items set cost_cents_snapshot = 150000 where id = 'c9000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table cm_unit as select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000001', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000002', 200000,
  array['c9000000-0000-4000-8000-000000000003', 'c9000000-0000-4000-8000-000000000004']::uuid[], false) as j;
grant all on cm_unit to public;
select is((select (j ->> 'repairedLines')::int from cm_unit), 1, 'only V4 was still missing when saving');
select is((select (j ->> 'skippedLines')::int from cm_unit), 1, 'V3 (completed concurrently) is reported as skipped');
select is(public.t_cmc_snap('c9000000-0000-4000-8000-000000000003'), 150000::bigint, 'V3 keeps the cost somebody else saved');
select is(public.t_cmc_snap('c9000000-0000-4000-8000-000000000004'), 200000::bigint, 'V4 stores the cost PER UNIT (2.000 $/u)');
select is((select (j ->> 'repairedRevenueCents')::bigint from cm_unit), 1900000::bigint, 'the repaired revenue is V4 net of its ticket discount');
select is((select missing_cost_items from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')), 0, 'no missing lines left: the warning disappears');
select is((select missing_cost_revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')), 0::bigint, 'with nothing left out of the profit');
select is((select gross_profit_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')), 3321900::bigint, 'gross profit = 16.719 + (12.000 - 3 x 1.500) + (19.000 - 5 x 2.000) = $33.219');
select is((select gross_margin_bps from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001')), 4614::bigint, 'gross margin = profit / revenue of costed lines (46,14 %)');
select is((public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001') ->> 'totalLines')::int, 0, 'the listing is empty too');
select is(public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000001') -> 'products', '[]'::jsonb, 'with no products');
select is(public.t_cmc_cost_rows('c5000000-0000-4000-8000-000000000001'), 0::bigint, 'repairing the history never created a current product cost');
select is(public.t_cmc_price('c5000000-0000-4000-8000-000000000001'), 500000::bigint, 'nor changed the sale price');

-- ---------------------------------------------------------------------------------------------
-- Costo vigente: acción aparte. Sin margen configurado no reprecia; con margen, sí (y avisa).
-- ---------------------------------------------------------------------------------------------
select is((select (p ->> 'repricesOnCostChange')::boolean from jsonb_array_elements(public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000002') -> 'products') p where p ->> 'productName' = 'Pata muslo'), false, 'without a configured margin, saving the current cost would not reprice');

create temp table cm_cur as select 'no-margin'::text as k, public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000002', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 380000,
  array['c9000000-0000-4000-8000-000000000009']::uuid[], true) as j;
grant all on cm_cur to public;
select is((select j ->> 'priceOutcome' from cm_cur where k = 'no-margin'), 'NO_MARGIN', 'the canonical cost flow reports that no price was formed');
select is(public.t_cmc_current_cost('c5000000-0000-4000-8000-000000000001'), 380000::bigint, 'the current cost is now 3.800 $/kg');
select is(public.t_cmc_price('c5000000-0000-4000-8000-000000000001'), 500000::bigint, 'and the price is unchanged');

reset role;
insert into public.organization_pricing_settings (organization_id, margin_bps) values ('c2000000-0000-4000-8000-000000000001', 4000);
insert into public.organization_pricing_excluded_categories (organization_id, category_id) values ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

create temp table cm_norte as select public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000002') as j;
grant all on cm_norte to public;
select ok((select (p ->> 'repricesOnCostChange')::boolean from cm_norte, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Pata muslo'), 'with a margin, an automatic product WOULD be repriced: the modal can warn before saving');
select is((select (p ->> 'marginBps')::int from cm_norte, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Pata muslo'), 4000, 'with the effective margin');
select is((select (p ->> 'currentPriceCents')::bigint from cm_norte, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Pata muslo'), 500000::bigint, 'and the current price');
select is((select (p ->> 'currentCostCents')::bigint from cm_norte, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Pata muslo'), 380000::bigint, 'and the current cost suggestion');
select is((select (p ->> 'repricesOnCostChange')::boolean from cm_norte, jsonb_array_elements(j -> 'products') p where p ->> 'productName' = 'Coca Cola'), false, 'a product of an excluded category keeps its manual price: no repricing');

-- Sólo el histórico, aun con margen configurado: ni costo vigente ni precio cambian.
select is((public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000002', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 400000,
  array['c9000000-0000-4000-8000-000000000013']::uuid[], false) ->> 'currentCostSaved')::boolean, false, 'history only: the current cost is not saved');
select is(public.t_cmc_cost_rows('c5000000-0000-4000-8000-000000000001'), 1::bigint, 'no new cost validity was opened');
select is(public.t_cmc_price('c5000000-0000-4000-8000-000000000001'), 500000::bigint, 'and the sale price did not move although a margin is configured');
select is(public.t_cmc_price_rows('c5000000-0000-4000-8000-000000000001'), 1::bigint, 'nor was a price validity opened');

-- Histórico + costo vigente con margen: el flujo canónico reprecia, y el resultado lo informa.
create temp table cm_both as select public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000002', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 420000,
  array['c9000000-0000-4000-8000-000000000010']::uuid[], true) as j;
grant all on cm_both to public;
select is((select j ->> 'priceOutcome' from cm_both), 'REPRICED', 'history + current cost with a margin reprices (and says so)');
select ok((select (j ->> 'currentCostSaved')::boolean from cm_both), 'the current cost was saved');
select is(public.t_cmc_current_cost('c5000000-0000-4000-8000-000000000001'), 420000::bigint, 'as the new current cost');
select is(public.t_cmc_price('c5000000-0000-4000-8000-000000000001'), public.t_cmc_formula_price(420000, 4000), 'the new price is the one the canonical formula gives (cost / (1 - margin))');
select isnt(public.t_cmc_price('c5000000-0000-4000-8000-000000000001'), 500000::bigint, 'it differs from the previous price');
select is(public.t_cmc_snap('c9000000-0000-4000-8000-000000000010'), 420000::bigint, 'the historical line got the same cost per kg');
select is((select (a).after_data ->> 'priceOutcome' from (select public.t_cmc_audit_for('c9000000-0000-4000-8000-000000000010') a) s), 'REPRICED', 'the audit records that the price was recalculated');
select is((select (a).before_data ->> 'currentCostCents' from (select public.t_cmc_audit_for('c9000000-0000-4000-8000-000000000010') a) s), '380000', 'and the current cost before the change');
select ok((select (a).after_data ->> 'currentCostSaved' from (select public.t_cmc_audit_for('c9000000-0000-4000-8000-000000000010') a) s) = 'true', 'and that the current cost was saved');

-- Mismo costo que el vigente: no se abre una vigencia nueva ni se toca el precio.
select is((public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000002', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000001', 420000,
  array['c9000000-0000-4000-8000-000000000012']::uuid[], true) ->> 'currentCostUnchanged')::boolean, true, 'if the current cost is already that value it is reported as unchanged');
select is(public.t_cmc_cost_rows('c5000000-0000-4000-8000-000000000001'), 2::bigint, 'with no new cost validity');
select is(public.t_cmc_price_rows('c5000000-0000-4000-8000-000000000001'), 2::bigint, 'and no new price validity');

-- UNIT en categoría excluida: se guarda el costo vigente y el precio manual NO cambia.
select is((public.complete_missing_sale_costs('c3000000-0000-4000-8000-000000000002', '2026-03-10', '2026-03-11', 'c5000000-0000-4000-8000-000000000002', 200000,
  array['c9000000-0000-4000-8000-000000000011']::uuid[], true) ->> 'priceOutcome'), 'MANUAL_PRICE', 'an excluded-category product saves the cost without repricing');
select is(public.t_cmc_price('c5000000-0000-4000-8000-000000000002'), 400000::bigint, 'and its manual price is untouched');
select is(public.t_cmc_snap('c9000000-0000-4000-8000-000000000011'), 200000::bigint, 'its UNIT line stores the cost per unit');

-- Con costos, precios y márgenes ya cargados, un analista (sin prices.write) sigue sin recibirlos.
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select ok((select bool_and(p ->> 'currentCostCents' is null and p ->> 'currentPriceCents' is null and p ->> 'marginBps' is null and p ->> 'repricesOnCostChange' = 'false')
  from jsonb_array_elements(public.get_missing_sale_costs('2026-03-10', '2026-03-11', 'c3000000-0000-4000-8000-000000000002') -> 'products') p), 'an analyst still gets no costs, prices or margins once they exist (the admin gets them)');

-- ---------------------------------------------------------------------------------------------
-- Nada de lo que no es costo cambió: cantidades, precios, totales, descuentos, estado, pagos ni stock.
-- ---------------------------------------------------------------------------------------------
select is((select fp from public.t_cmc_fp where label = 'before'), public.t_cmc_fingerprint(), 'sales, quantities, prices, totals, discounts, status, payments and stock are exactly as before');

select * from finish();
rollback;
