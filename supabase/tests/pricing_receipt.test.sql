begin;

create extension if not exists pgtap with schema extensions;
select plan(158);

-- Covers 202610110074 (D-077): Productos → Precios como pantalla de REMITO. Dos RPC nuevas:
--   list_pricing_rows    búsqueda GLOBAL paginada en el servidor (nombre, categoría, SKU, código de barras) con costo, precio y margen efectivo;
--   apply_pricing_receipt UNA transacción por lote: costo + margen + precio MANUAL + ingreso de stock (record_stock_operation PURCHASE) en la
--                         sucursal productiva, con clave de idempotencia (doble click / reintento no duplica el ingreso).
-- Regla de negocio del cliente: Vaca y Pollo son mercadería comprada (costo + margen, automáticos); sólo Cerdo (elaboración propia) está en
-- «Categorías excluidas del margen automático» y tiene precio manual. Nada depende de los NOMBRES: todo sale de la configuración de categorías.
-- Todo el dinero en centavos; peso en gramos; unidades enteras.

-- ---------------------------------------------------------------------------------------------
-- Fixture (prefijo b)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pr-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PR Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pr-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PR Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pr-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PR Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('b2000000-0000-4000-8000-000000000001', 'PR Org', 'pr-org'),
  ('b2000000-0000-4000-8000-000000000002', 'PR Org B', 'pr-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'PR Central', 'PR-C'),
  ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'PR Avenida', 'PR-A'),
  ('b3000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000002', 'PR B Branch', 'PR-B');
update public.organizations set production_branch_id = 'b3000000-0000-4000-8000-000000000001' where id = 'b2000000-0000-4000-8000-000000000001';
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002');

-- a = Almacén (con tilde: la búsqueda no distingue acentos), b = Vaca, c = Pollo, d = Cerdo (la ÚNICA excluida), e = Vaca de la otra organización.
insert into public.categories (id, organization_id, name, slug) values
  ('b4000000-0000-4000-8000-00000000000a', 'b2000000-0000-4000-8000-000000000001', 'Almacén', 'pr-almacen'),
  ('b4000000-0000-4000-8000-00000000000b', 'b2000000-0000-4000-8000-000000000001', 'Vaca', 'pr-vaca'),
  ('b4000000-0000-4000-8000-00000000000c', 'b2000000-0000-4000-8000-000000000001', 'Pollo', 'pr-pollo'),
  ('b4000000-0000-4000-8000-00000000000d', 'b2000000-0000-4000-8000-000000000001', 'Cerdo', 'pr-cerdo'),
  ('b4000000-0000-4000-8000-00000000000e', 'b2000000-0000-4000-8000-000000000002', 'Vaca', 'prb-vaca');
-- 01 Aceite (UNIT, costo $10.000), 02 Yerba (UNIT, $7.000), 03 Nalga vacuna (Vaca, WEIGHT, $9.000/kg), 04 Pechuga (Pollo, WEIGHT, $4.000/kg),
-- 05 Bondiola de cerdo (Cerdo, WEIGHT, precio manual $10.650, SIN costo), 06 Chorizo de cerdo (Cerdo, $5.000, precio manual $9.000),
-- 07 Sin costo (UNIT, $1.234), 08 Muslo (Pollo, WEIGHT, $3.000/kg), 09 No central (UNIT, NO habilitado en la sucursal productiva),
-- 10 Media res (materia prima), 11 Org B.
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000a', 'Aceite Cañuelas', 'pr-aceite', 'PR-01', 'UNIT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000a', 'Yerba', 'pr-yerba', 'PR-02', 'UNIT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000b', 'Nalga vacuna', 'pr-nalga', 'PR-03', 'WEIGHT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000c', 'Pechuga', 'pr-pechuga', 'PR-04', 'WEIGHT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000005', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000d', 'Bondiola de cerdo', 'pr-bondiola', 'PR-05', 'WEIGHT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000006', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000d', 'Chorizo de cerdo', 'pr-chorizo', 'PR-06', 'WEIGHT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000007', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000a', 'Sin costo', 'pr-sin-costo', 'PR-07', 'UNIT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000008', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000c', 'Muslo', 'pr-muslo', 'PR-08', 'WEIGHT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000009', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000a', 'No central', 'pr-no-central', 'PR-09', 'UNIT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000010', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000b', 'Media res', 'pr-media-res', 'PR-10', 'WEIGHT', true, 'RAW_MATERIAL'),
  ('b5000000-0000-4000-8000-000000000011', 'b2000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-00000000000e', 'Vacio B', 'prb-vacio', 'PRB-11', 'WEIGHT', true, 'SELLABLE');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where p.sku <> 'PR-09' or b.code <> 'PR-C';
insert into public.product_barcodes (organization_id, product_id, barcode) values
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000004', 'PR7790001');

insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 1000000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002', 1000000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000003', 1250000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000004', 600000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000005', 1065000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000006', 900000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000007', 123400, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000008', 450000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000009', 170000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000011', 700000, now() - interval '1 day');
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from) values
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 1000000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002', 700000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000003', 900000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000004', 400000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000006', 500000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000008', 300000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000009', 100000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000011', 500000, now() - interval '1 day');

create function public.t_pr_id(p_sku text) returns uuid language sql security definer as $$ select id from public.products where sku = p_sku $$;
create function public.t_pr_price(p_sku text) returns bigint language sql security definer as $$
  select price_cents from public.product_prices where product_id = public.t_pr_id(p_sku) and branch_id is null
    and valid_from <= clock_timestamp() and (valid_to is null or valid_to > clock_timestamp()) order by valid_from desc limit 1 $$;
create function public.t_pr_price_rows(p_sku text) returns bigint language sql security definer as $$
  select count(*) from public.product_prices where product_id = public.t_pr_id(p_sku) and branch_id is null $$;
create function public.t_pr_cost(p_sku text) returns bigint language sql security definer as $$
  select cost_cents from public.product_costs where product_id = public.t_pr_id(p_sku) and valid_to is null $$;
create function public.t_pr_cost_rows(p_sku text) returns bigint language sql security definer as $$
  select count(*) from public.product_costs where product_id = public.t_pr_id(p_sku) $$;
create function public.t_pr_margin(p_sku text) returns integer language sql security definer as $$
  select custom_margin_bps from public.product_custom_margins where product_id = public.t_pr_id(p_sku) $$;
-- Stock del ledger en la sucursal productiva (Central) y movimientos de compra de un producto.
create function public.t_pr_stock(p_sku text) returns bigint language sql security definer as $$
  select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements
  where product_id = public.t_pr_id(p_sku) and branch_id = 'b3000000-0000-4000-8000-000000000001' $$;
create function public.t_pr_moves(p_sku text) returns bigint language sql security definer as $$
  select count(*) from public.stock_movements where product_id = public.t_pr_id(p_sku) and type = 'PURCHASE' $$;
create function public.t_pr_all_moves() returns bigint language sql security definer as $$
  select count(*) from public.stock_movements where organization_id = 'b2000000-0000-4000-8000-000000000001' $$;
create function public.t_pr_requests() returns bigint language sql security definer as $$ select count(*) from public.pricing_receipt_requests $$;
-- Todo el archivo corre en UNA transacción (now() no avanza): entre dos lotes se retroceden las vigencias para que cada apply_pricing_receipt
-- vea un now() posterior al del anterior (en producción cada lote es su propia transacción).
create function public.t_pr_age() returns void language plpgsql security definer as $$
declare r record;
begin
  alter table public.product_prices disable trigger product_prices_prevent_history_rewrite;
  for r in select id from public.product_prices where organization_id = 'b2000000-0000-4000-8000-000000000001' order by valid_from loop
    update public.product_prices set valid_from = valid_from - interval '1 hour', valid_to = valid_to - interval '1 hour' where id = r.id;
  end loop;
  alter table public.product_prices enable trigger product_prices_prevent_history_rewrite;
  for r in select id from public.product_costs where organization_id = 'b2000000-0000-4000-8000-000000000001' order by valid_from loop
    update public.product_costs set valid_from = valid_from - interval '1 hour', valid_to = valid_to - interval '1 hour' where id = r.id;
  end loop;
end $$;
-- Un lote con ítems armados con ids reales: t_pr_item('PR-01', '{"costCents":350000}') -> {"productId": ..., "costCents": 350000}.
create function public.t_pr_item(p_sku text, p_changes jsonb) returns jsonb language sql security definer as $$
  select jsonb_build_object('productId', public.t_pr_id(p_sku)) || p_changes $$;

create temp table keep(name text primary key, payload jsonb);
grant all on keep to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'pricing_receipt_requests', 'the idempotency table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.pricing_receipt_requests'::regclass), 'it has RLS');
select ok(not has_table_privilege('authenticated', 'public.pricing_receipt_requests', 'SELECT'), 'browser clients cannot read it');
select ok(not has_table_privilege('authenticated', 'public.pricing_receipt_requests', 'INSERT'), 'nor insert into it');
select ok(not has_function_privilege('anon', 'public.apply_pricing_receipt(uuid,jsonb)', 'EXECUTE'), 'anonymous cannot apply a receipt');
select ok(not has_function_privilege('anon', 'public.list_pricing_rows(text,uuid[],integer,integer)', 'EXECUTE'), 'nor search the pricing rows');
select ok(has_function_privilege('authenticated', 'public.apply_pricing_receipt(uuid,jsonb)', 'EXECUTE'), 'an authenticated Admin can apply a receipt (permissions are checked inside)');
select is(public.t_pr_requests(), 0::bigint, 'the migration creates no request by itself');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Stock inicial: Aceite 20 unidades y Nalga 5,000 kg, por el flujo canónico (record_stock_operation, PURCHASE).
select lives_ok($$select public.record_stock_operation('b3000000-0000-4000-8000-000000000001', 'PURCHASE', jsonb_build_array(
  jsonb_build_object('product_id', public.t_pr_id('PR-01'), 'quantity_grams', 20),
  jsonb_build_object('product_id', public.t_pr_id('PR-03'), 'quantity_grams', 5000)), 'Proveedor', null, 'stock inicial')$$, 'the initial stock is recorded through the canonical flow');
select is(public.t_pr_stock('PR-01') || '/' || public.t_pr_stock('PR-03'), '20/5000', 'ACEITE has 20 units and NALGA 5000 g');

-- Margen global 40 % con SÓLO Cerdo excluida (la configuración real de Fran: Vaca y Pollo son comprados, Cerdo es elaboración propia).
select lives_ok($$select public.save_pricing_config(4000, 0, 0, 1000, true, false, array['b4000000-0000-4000-8000-00000000000d']::uuid[])$$, 'the global margin (40 %) is configured with ONLY Cerdo excluded');
select is(public.t_pr_price('PR-01'), 1665000::bigint, 'ACEITE: $10.000 / 0,60 rounded to $50 = $16.650');
select is(public.t_pr_price('PR-02'), 1165000::bigint, 'YERBA: $7.000 / 0,60 = $11.666,67 -> $11.650');
select is(public.t_pr_price('PR-03'), 1500000::bigint, 'NALGA (Vaca, NOT excluded): automatic, $9.000 / 0,60 = $15.000');
select is(public.t_pr_price('PR-04'), 665000::bigint, 'PECHUGA (Pollo, NOT excluded): automatic, $4.000 / 0,60 -> $6.650');
select is(public.t_pr_price('PR-08'), 500000::bigint, 'MUSLO (Pollo): $3.000 / 0,60 = $5.000');
select is(public.t_pr_price('PR-05') || '/' || public.t_pr_price('PR-06'), '1065000/900000', 'BONDIOLA and CHORIZO (Cerdo, excluded) keep their manual price');

-- ---------------------------------------------------------------------------------------------
-- Búsqueda GLOBAL (list_pricing_rows): un solo buscador contra todo el catálogo
-- ---------------------------------------------------------------------------------------------
select is((public.list_pricing_rows('aceite') ->> 'total'), '1', 'by name: "aceite" finds ACEITE');
select is((public.list_pricing_rows('CANUELAS') -> 'rows' -> 0 ->> 'name'), 'Aceite Cañuelas', 'the search ignores case and accents ("CANUELAS" finds Cañuelas)');
select is((public.list_pricing_rows('cerdo') ->> 'total'), '2', 'by CATEGORY: "cerdo" finds the two pork products');
select is((public.list_pricing_rows('almacen') ->> 'total'), '4', 'by category without accent: "almacen" finds the 4 Almacén products');
select is((public.list_pricing_rows('pr-03') -> 'rows' -> 0 ->> 'name'), 'Nalga vacuna', 'by SKU');
select is((public.list_pricing_rows('pr7790001') -> 'rows' -> 0 ->> 'name'), 'Pechuga', 'by BARCODE (exact)');
select is((public.list_pricing_rows('bondiola cerdo') ->> 'total'), '1', 'several words: each one must appear in the name, the category or the SKU');
select is((public.list_pricing_rows('bondiola pollo') ->> 'total'), '0', 'a word that matches nothing excludes the product');
select is((public.list_pricing_rows('%') ->> 'total'), '0', 'a "%" typed by the user is text, not a LIKE wildcard');
select is((public.list_pricing_rows('_') ->> 'total'), '0', 'nor an "_"');
select is((public.list_pricing_rows('media') ->> 'total'), '0', 'a pure raw material is not a sale row');
select is((public.list_pricing_rows('vacio b') ->> 'total'), '0', 'products of ANOTHER organization are never found');
select is((public.list_pricing_rows() ->> 'total'), '9', 'no query lists every active sale product of the organization (9 of 11 products; the raw material and the other org are out)');
select is(jsonb_array_length(public.list_pricing_rows(null, null, 3, 0) -> 'rows') || '/' || (public.list_pricing_rows(null, null, 3, 0) ->> 'total'), '3/9', 'a page of 3 still reports the total of 9');
select is((public.list_pricing_rows(null, null, 3, 6) -> 'rows' -> 0 ->> 'name') <> (public.list_pricing_rows(null, null, 3, 0) -> 'rows' -> 0 ->> 'name'), true, 'the offset reaches products beyond the first page (search over the whole catalog, not the loaded rows)');
select is(jsonb_array_length(public.list_pricing_rows(null, null, 3, 7) -> 'rows'), 2, 'the last page has the remaining 2');
select is(jsonb_array_length(public.list_pricing_rows(null, array[public.t_pr_id('PR-01'), public.t_pr_id('PR-06')]) -> 'rows'), 2, 'p_product_ids returns exactly those rows');
select is(
  (select r ->> 'costCents' || '/' || (r ->> 'priceCents') || '/' || (r ->> 'marginSource') || '/' || (r ->> 'marginBps') || '/' || (r ->> 'unitType')
   from jsonb_array_elements(public.list_pricing_rows('aceite') -> 'rows') r),
  '1000000/1665000/GLOBAL/4000/UNIT', 'a row carries cost, list price, the EFFECTIVE margin rule and the sale type');
select is(
  (select r ->> 'marginSource' || '/' || (r ->> 'excludedCategory') || '/' || coalesce(r ->> 'marginBps', 'null') || '/' || coalesce(r ->> 'costCents', 'null')
   from jsonb_array_elements(public.list_pricing_rows('bondiola') -> 'rows') r),
  'MANUAL/true/null/null', 'BONDIOLA (excluded Cerdo, no own margin): manual price, no margin, no cost');
select is(
  (select r ->> 'marginSource' || '/' || (r ->> 'excludedCategory') from jsonb_array_elements(public.list_pricing_rows('nalga') -> 'rows') r),
  'GLOBAL/false', 'NALGA (Vaca): automatic with the global margin');
select throws_ok($$select public.list_pricing_rows('x', null, 0)$$, '22023', null, 'a limit of 0 is rejected');
select throws_ok($$select public.list_pricing_rows('x', null, 101)$$, '22023', null, 'a limit over 100 is rejected');
select throws_ok($$select public.list_pricing_rows('x', null, 10, -1)$$, '22023', null, 'a negative offset is rejected');

-- ---------------------------------------------------------------------------------------------
-- Validación de forma: nada se escribe
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.apply_pricing_receipt(null, jsonb_build_array(public.t_pr_item('PR-01', '{"costCents":100}')))$$, '22023', 'Falta la clave de la operación', 'a missing request key is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), '[]'::jsonb)$$, '22023', 'Debe enviar entre 1 y 500 productos', 'an empty batch is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), '{"a":1}'::jsonb)$$, '22023', 'Debe enviar entre 1 y 500 productos', 'a non-array payload is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-01', '{}')))$$, '22023', 'Una fila no trae ningún cambio', 'a row without any change is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-01', '{"costCents":0}')))$$, '22023', 'El costo tiene que ser un importe mayor a cero', 'a zero cost is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-01', '{"costCents":-5}')))$$, '22023', 'El costo tiene que ser un importe mayor a cero', 'a negative cost is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-01', '{"costCents":"100"}')))$$, '22023', 'El costo tiene que ser un importe mayor a cero', 'a cost sent as text is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-05', '{"priceCents":0}')))$$, '22023', 'El precio tiene que ser un importe mayor a cero', 'a zero price is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-01', '{"receivedQuantity":0}')))$$, '22023', 'La cantidad recibida tiene que ser mayor a cero', 'a zero received quantity is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-01', '{"receivedQuantity":-3}')))$$, '22023', 'La cantidad recibida tiene que ser mayor a cero', 'a negative received quantity is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-01', '{"receivedQuantity":1.5}')))$$, '22023', 'La cantidad recibida tiene que ser mayor a cero', 'a fractional received quantity is rejected (the ledger is whole units / grams)');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-01', '{"marginBps":10000}')))$$, '22023', null, 'a 100 % margin is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-01', '{"marginBps":0}')))$$, '22023', null, 'a 0 % margin is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-01', '{"costCents":100}'), public.t_pr_item('PR-01', '{"costCents":200}')))$$, '22023', 'Un producto no puede venir dos veces en la misma carga', 'a product twice in the same batch is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PRB-11', '{"costCents":100}')))$$, '42501', 'Uno de los productos enviados no existe, está inactivo o no es un producto de venta', 'a product of ANOTHER organization is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(public.t_pr_item('PR-10', '{"costCents":100}')))$$, '42501', 'Uno de los productos enviados no existe, está inactivo o no es un producto de venta', 'a pure raw material is rejected (not a sale product)');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(jsonb_build_object('productId', gen_random_uuid(), 'costCents', 100)))$$, '42501', 'Uno de los productos enviados no existe, está inactivo o no es un producto de venta', 'an unknown product is rejected');
select throws_ok($$select public.apply_pricing_receipt(gen_random_uuid(), jsonb_build_array(jsonb_build_object('productId', 'not-a-uuid', 'costCents', 100)))$$, '22023', 'Los cambios son inválidos', 'a malformed product id is rejected');
select is(public.t_pr_requests() || '/' || public.t_pr_all_moves(), '0/2', 'every rejected call wrote nothing (no request key stored, only the 2 initial stock movements)');

-- ---------------------------------------------------------------------------------------------
-- UNIT: cantidad recibida SUMA (no reemplaza)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('unit', public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pr_item('PR-01', '{"receivedQuantity":12}'))))$$, 'ACEITE: received quantity 12');
select is(public.t_pr_stock('PR-01'), 32::bigint, 'the stock was 20 and is now 32 (+12 received), NOT 12');
select is((select count(*) || '/' || min(quantity_grams) from public.stock_movements where product_id = public.t_pr_id('PR-01') and type = 'PURCHASE' and quantity_grams = 12), '1/12', 'exactly ONE +12 PURCHASE movement was written');
select is((select b.code || '/' || sm.type::text || '/' || (sm.profile_id = 'b1000000-0000-4000-8000-000000000001')::text
           from public.stock_movements sm join public.branches b on b.id = sm.branch_id where sm.product_id = public.t_pr_id('PR-01') and sm.quantity_grams = 12),
  'PR-C/PURCHASE/true', 'the movement is a PURCHASE (not an opening balance or adjustment) in the PRODUCTION branch, by the actor');
select is((select payload ->> 'applied' || '/' || (payload ->> 'costsSaved') || '/' || (payload ->> 'stockMovements') || '/' || (payload ->> 'replayed') from keep where name = 'unit'), '1/0/1/false', 'the result reports 1 row, 0 costs, 1 stock movement, not a replay');
select is(public.t_pr_price('PR-01') || '/' || public.t_pr_price_rows('PR-01') || '/' || public.t_pr_cost_rows('PR-01'), '1665000/2/1', 'a quantity alone touches neither the price nor the cost');
select is((select count(*) from public.stock_movements where branch_id = 'b3000000-0000-4000-8000-000000000002'), 0::bigint, 'the other branch (Avenida) received nothing');
select is((select count(*) from public.stock_operations where id::text = (select payload -> 'stockOperationIds' ->> 0 from keep where name = 'unit') and operation_type = 'PURCHASE'), 1::bigint, 'the receipt is recorded as one canonical PURCHASE stock operation');

-- ---------------------------------------------------------------------------------------------
-- WEIGHT: 12,500 kg = 12500 g
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000002', jsonb_build_array(public.t_pr_item('PR-03', '{"receivedQuantity":12500}')))$$, 'NALGA: received 12500 g (12,500 kg)');
select is(public.t_pr_stock('PR-03'), 17500::bigint, 'NALGA: 5000 g + 12500 g = 17500 g');
select is(public.t_pr_price('PR-03') || '/' || public.t_pr_price_rows('PR-03'), '1500000/2', 'a Vaca quantity alone keeps the automatic price (no new vigencia)');

-- ---------------------------------------------------------------------------------------------
-- COMBINADO: costo + margen + cantidad (el ejemplo de almacén) en UNA operación
-- ---------------------------------------------------------------------------------------------
select public.t_pr_age();
select lives_ok($$insert into keep values ('combo', public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000003', jsonb_build_array(public.t_pr_item('PR-01', '{"costCents":350000,"marginBps":3500,"receivedQuantity":24}'))))$$, 'ACEITE: cost $3.500 + margin 35 % + received 24');
select is(public.t_pr_cost('PR-01') || '/' || public.t_pr_cost_rows('PR-01'), '350000/2', 'the cost is $3.500 in ONE new vigencia');
select is(public.t_pr_margin('PR-01'), 3500, 'the own margin 35 % is stored');
select is(public.t_pr_price('PR-01') || '/' || public.t_pr_price_rows('PR-01'), '540000/3', 'the price is formed ONCE with the NEW margin: $3.500 / 0,65 = $5.384,62 -> $5.400 (one vigencia, not two)');
select is(public.t_pr_stock('PR-01'), 56::bigint, 'and +24 units were received (32 -> 56)');
select is(public.t_pr_moves('PR-01'), 3::bigint, 'one movement per row: the initial 20, +12 and +24 (never 24 separate movements)');
select is((select payload ->> 'costsSaved' || '/' || (payload ->> 'marginsChanged') || '/' || (payload ->> 'repriced') || '/' || (payload ->> 'stockMovements') from keep where name = 'combo'), '1/1/1/1', 'result: 1 cost, 1 margin, 1 price formed, 1 stock movement');

-- ---------------------------------------------------------------------------------------------
-- AUTOMÁTICO: costo solo / margen solo (Almacén, Vaca y Pollo se comportan igual: cálculo por margen EFECTIVO)
-- ---------------------------------------------------------------------------------------------
select public.t_pr_age();
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000004', jsonb_build_array(public.t_pr_item('PR-02', '{"costCents":800000}')))$$, 'YERBA: cost only');
select is(public.t_pr_price('PR-02') || '/' || public.t_pr_stock('PR-02'), '1335000/0', 'cost only: $8.000 / 0,60 = $13.333,33 -> $13.350 and no stock movement');
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000005', jsonb_build_array(public.t_pr_item('PR-08', '{"marginBps":5000}')))$$, 'MUSLO (Pollo): margin only 50 %');
select is(public.t_pr_price('PR-08') || '/' || public.t_pr_cost_rows('PR-08') || '/' || public.t_pr_margin('PR-08'), '600000/1/5000', 'margin only: reprices with the current cost ($3.000 / 0,50 = $6.000), the cost is untouched');
select public.t_pr_age();
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000006', jsonb_build_array(
  public.t_pr_item('PR-03', '{"costCents":1000000}'), public.t_pr_item('PR-04', '{"costCents":500000}')))$$, 'NALGA (Vaca) and PECHUGA (Pollo): new cost each');
select is(public.t_pr_price('PR-03') || '/' || public.t_pr_price_rows('PR-03'), '1665000/3', 'Vaca + new cost recalculates with the effective (global) margin: $10.000 / 0,60 -> $16.650');
select is(public.t_pr_price('PR-04') || '/' || public.t_pr_price_rows('PR-04'), '835000/3', 'Pollo + new cost recalculates with the effective (global) margin: $5.000 / 0,60 -> $8.350');
select public.t_pr_age();
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000007', jsonb_build_array(public.t_pr_item('PR-08', '{"costCents":450000}')))$$, 'MUSLO: cost with an own margin');
select is(public.t_pr_price('PR-08'), 900000::bigint, 'an own margin wins over the global one: $4.500 / 0,50 = $9.000');

-- ---------------------------------------------------------------------------------------------
-- Vaca / Pollo + cantidad: ingreso y pricing automático intacto
-- ---------------------------------------------------------------------------------------------
select public.t_pr_age();
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000008', jsonb_build_array(
  public.t_pr_item('PR-03', '{"receivedQuantity":2500}'), public.t_pr_item('PR-04', '{"receivedQuantity":8000}')))$$, 'NALGA +2,500 kg and PECHUGA +8,000 kg');
select is(public.t_pr_stock('PR-03') || '/' || public.t_pr_stock('PR-04'), '20000/8000', 'both received (17500 + 2500 and 0 + 8000)');
select is(public.t_pr_price('PR-03') || '/' || public.t_pr_price_rows('PR-03') || '/' || public.t_pr_price('PR-04') || '/' || public.t_pr_price_rows('PR-04'), '1665000/3/835000/3', 'Vaca and Pollo keep their AUTOMATIC price (no new vigencia, no manual override)');
select is((select count(*) from public.stock_operations where operation_type = 'PURCHASE' and id::text in (select jsonb_array_elements_text(payload -> 'stockOperationIds') from keep where name = 'unit')), 1::bigint, 'the earlier receipt kept its own operation');

-- ---------------------------------------------------------------------------------------------
-- MANUAL (Cerdo excluida, sin margen propio): precio editable desde la planilla
-- ---------------------------------------------------------------------------------------------
select public.t_pr_age();
select lives_ok($$insert into keep values ('manual', public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000009', jsonb_build_array(public.t_pr_item('PR-05', '{"priceCents":1090000}'))))$$, 'BONDIOLA (no cost): manual price $10.900');
select is(public.t_pr_price('PR-05') || '/' || public.t_pr_price_rows('PR-05') || '/' || coalesce(public.t_pr_cost('PR-05')::text, 'no-cost'), '1090000/2/no-cost', 'a manual product WITHOUT cost can change its price; the cost is not required');
select is((select count(*) from public.product_prices where product_id = public.t_pr_id('PR-05') and branch_id is null and price_cents = 1065000 and valid_to is not null), 1::bigint, 'the old price $10.650 stays in the history, CLOSED (never rewritten)');
select is((select payload ->> 'manualPrices' || '/' || (payload ->> 'repriced') || '/' || (payload ->> 'costsSaved') from keep where name = 'manual'), '1/0/0', 'result: 1 manual price, 0 automatic repricing');
select public.t_pr_age();
select lives_ok($$insert into keep values ('manual2', public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000000a', jsonb_build_array(public.t_pr_item('PR-05', '{"priceCents":1090000}'))))$$, 'the SAME manual price again');
select is(public.t_pr_price_rows('PR-05'), 2::bigint, 'is a no-op: no vigencia is stacked');
select is((select payload ->> 'priceUnchanged' || '/' || (payload ->> 'manualPrices') from keep where name = 'manual2'), '1/0', 'reported as price unchanged');
select public.t_pr_age();
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000000b', jsonb_build_array(public.t_pr_item('PR-05', '{"priceCents":1100000,"receivedQuantity":15500}')))$$, 'BONDIOLA: manual price $11.000 AND 15,500 kg received');
select is(public.t_pr_price('PR-05') || '/' || public.t_pr_stock('PR-05') || '/' || public.t_pr_price_rows('PR-05'), '1100000/15500/3', 'price vigencia + 15500 g received, in the same row');
select is((select array_agg(price_cents order by valid_from) from public.product_prices where product_id = public.t_pr_id('PR-05') and branch_id is null), array[1065000, 1090000, 1100000]::bigint[], 'the whole price history is intact');
select public.t_pr_age();
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000000c', jsonb_build_array(public.t_pr_item('PR-06', '{"costCents":550000,"priceCents":950000}')))$$, 'CHORIZO (Cerdo): cost AND manual price in the same row');
select is(public.t_pr_cost('PR-06') || '/' || public.t_pr_price('PR-06'), '550000/950000', 'the cost is stored and the manual price is the one written (the cost did not reprice it)');

-- ---------------------------------------------------------------------------------------------
-- Cerdo con margen propio vuelve a ser AUTOMÁTICO; y se puede volver a manual
-- ---------------------------------------------------------------------------------------------
select public.t_pr_age();
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000000d', jsonb_build_array(public.t_pr_item('PR-06', '{"marginBps":3000}')))$$, 'CHORIZO: an own margin of 30 %');
select is(public.t_pr_price('PR-06') || '/' || public.t_pr_margin('PR-06'), '785000/3000', 'with its own margin the pork product is AUTOMATIC again: $5.500 / 0,70 -> $7.850');
select public.t_pr_age();
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000000e', jsonb_build_array(public.t_pr_item('PR-06', '{"priceCents":999000}')))$$, '22023', 'Chorizo de cerdo: el precio se calcula desde el costo y el margen; para cambiarlo modificá el costo o el margen', 'a price on an automatic product (own margin + cost) is rejected: no ambiguous override');
select is(public.t_pr_price('PR-06'), 785000::bigint, 'and the automatic price is untouched');
select public.t_pr_age();
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000000f', jsonb_build_array(public.t_pr_item('PR-06', '{"marginBps":null,"priceCents":920000}')))$$, 'CHORIZO: the own margin is removed and, in the same row, a manual price is set');
select is(public.t_pr_price('PR-06') || '/' || coalesce(public.t_pr_margin('PR-06')::text, 'none'), '920000/none', 'back to a manual product: the price written by hand rules, no own margin');

-- ---------------------------------------------------------------------------------------------
-- Atomicidad: un error en cualquier fila o en el stock revierte TODO el lote
-- ---------------------------------------------------------------------------------------------
select public.t_pr_age();
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000010', jsonb_build_array(
  public.t_pr_item('PR-02', '{"costCents":900000}'), public.t_pr_item('PR-01', '{"priceCents":1000000}')))$$, '22023', 'Aceite Cañuelas: el precio se calcula desde el costo y el margen; para cambiarlo modificá el costo o el margen', 'a price on an AUTOMATIC product (cost + global/own margin) rejects the whole batch');
select is(public.t_pr_cost('PR-02') || '/' || public.t_pr_price('PR-02'), '800000/1335000', 'the valid row before the bad one was rolled back');
select is(public.t_pr_requests(), 14::bigint, 'and no idempotency key was left behind by the failed call');
-- Fallo del stock DESPUÉS de haber escrito costos, márgenes y precios: se revierte todo.
reset role;
create function public.t_pr_block_stock() returns trigger language plpgsql as $$
begin if new.quantity_grams = 777 then raise exception 'stock blocked by test'; end if; return new; end $$;
create trigger t_pr_block_stock before insert on public.stock_movements for each row execute function public.t_pr_block_stock();
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000011', jsonb_build_array(
  public.t_pr_item('PR-02', '{"costCents":900000,"marginBps":2500}'),
  public.t_pr_item('PR-05', '{"priceCents":1200000}'),
  public.t_pr_item('PR-01', '{"receivedQuantity":777}')))$$, 'P0001', 'stock blocked by test', 'the stock write fails AFTER cost, margin and price were written');
select is(public.t_pr_cost('PR-02') || '/' || public.t_pr_price('PR-02') || '/' || coalesce(public.t_pr_margin('PR-02')::text, 'none'), '800000/1335000/none', 'YERBA: cost, price and margin are exactly as before (rolled back)');
select is(public.t_pr_price('PR-05') || '/' || public.t_pr_price_rows('PR-05'), '1100000/3', 'BONDIOLA: the manual price vigencia was rolled back');
select is(public.t_pr_stock('PR-01'), 56::bigint, 'ACEITE: no stock written');
select is(public.t_pr_requests(), 14::bigint, 'and no idempotency key was left behind: Fran can simply retry');
reset role;
drop trigger t_pr_block_stock on public.stock_movements;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Precio manual de un producto automático SIN costo (fallback documentado) y sus límites
-- ---------------------------------------------------------------------------------------------
select public.t_pr_age();
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000012', jsonb_build_array(public.t_pr_item('PR-07', '{"priceCents":130000}')))$$, 'SIN COSTO (global margin, no cost): its price cannot be derived, so a manual price is accepted');
select is(public.t_pr_price('PR-07'), 130000::bigint, 'and written');
select public.t_pr_age();
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000013', jsonb_build_array(public.t_pr_item('PR-07', '{"costCents":400000,"priceCents":140000}')))$$, '22023', 'Sin costo: el precio se calcula desde el costo y el margen; para cambiarlo modificá el costo o el margen', 'but with a cost in the same row the price is derived and a typed price is rejected');
select is(public.t_pr_cost('PR-07') is null, true, 'the rejected row stored no cost');
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000014', jsonb_build_array(public.t_pr_item('PR-07', '{"costCents":400000}')))$$, 'a first cost arrives');
select is(public.t_pr_price('PR-07'), 665000::bigint, 'and forms the automatic price: $4.000 / 0,60 -> $6.650');

-- Un precio programado a futuro no se pisa.
reset role;
alter table public.product_prices disable trigger product_prices_prevent_history_rewrite;
update public.product_prices set valid_to = now() + interval '5 days'
where product_id = public.t_pr_id('PR-05') and branch_id is null and valid_to is null;
alter table public.product_prices enable trigger product_prices_prevent_history_rewrite;
insert into public.product_prices (organization_id, product_id, price_cents, valid_from)
values ('b2000000-0000-4000-8000-000000000001', public.t_pr_id('PR-05'), 1300000, now() + interval '5 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000015', jsonb_build_array(public.t_pr_item('PR-05', '{"priceCents":1150000}')))$$, '22023', 'Bondiola de cerdo: tiene un precio programado a futuro; cambialo desde Administrar', 'a manual price over a price scheduled for the future is rejected with a clear message');

-- ---------------------------------------------------------------------------------------------
-- Idempotencia: doble click / reintento
-- ---------------------------------------------------------------------------------------------
select public.t_pr_age();
select lives_ok($$insert into keep values ('idem1', public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000016', jsonb_build_array(public.t_pr_item('PR-01', '{"receivedQuantity":10}'))))$$, 'ACEITE: received 10 (first submit)');
select is(public.t_pr_stock('PR-01') || '/' || public.t_pr_moves('PR-01'), '66/4', 'stock 56 -> 66, one more movement');
select lives_ok($$insert into keep values ('idem2', public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000016', jsonb_build_array(public.t_pr_item('PR-01', '{"receivedQuantity":10}'))))$$, 'the SAME request (double click / network retry)');
select is(public.t_pr_stock('PR-01') || '/' || public.t_pr_moves('PR-01'), '66/4', 'registered NOTHING new: still 66 and 4 movements (no +20)');
select is((select payload ->> 'replayed' from keep where name = 'idem2') || '/' || (select payload -> 'stockOperationIds' ->> 0 = (select payload -> 'stockOperationIds' ->> 0 from keep where name = 'idem1') from keep where name = 'idem2'), 'true/true', 'it returns the stored result, flagged as replayed, with the original stock operation');
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000016', jsonb_build_array(public.t_pr_item('PR-01', '{"receivedQuantity":11}')))$$, '22023', 'Esta operación ya se registró con otros datos: recargá la pantalla', 'the same key with DIFFERENT data is an error, not a silent replay');
select is(public.t_pr_stock('PR-01'), 66::bigint, 'and wrote nothing');
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000017', jsonb_build_array(public.t_pr_item('PR-01', '{"receivedQuantity":10}')))$$, 'a NEW request with the same quantity is a genuine second delivery');
select is(public.t_pr_stock('PR-01'), 76::bigint, 'it does add (66 -> 76): only the same key is deduplicated');

-- ---------------------------------------------------------------------------------------------
-- Sucursal productiva
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000018', jsonb_build_array(public.t_pr_item('PR-09', '{"receivedQuantity":5}')))$$, '22023', 'No central no se vende en la sucursal productiva: habilitalo en Administrar antes de registrar su ingreso', 'a product not enabled in the production branch cannot receive stock there');
reset role;
update public.organizations set production_branch_id = null where id = 'b2000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.t_pr_age();
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000019', jsonb_build_array(
  public.t_pr_item('PR-02', '{"costCents":810000}'), public.t_pr_item('PR-01', '{"receivedQuantity":5}')))$$, '22023', 'Configurá la sucursal productiva (Desposte) antes de registrar el ingreso de mercadería', 'without organizations.production_branch_id a batch with a quantity is rejected ENTIRELY, with a clear message');
select is(public.t_pr_cost('PR-02'), 800000::bigint, 'including its cost row (nothing half-applied)');
select lives_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000001a', jsonb_build_array(public.t_pr_item('PR-02', '{"costCents":810000}')))$$, 'a batch WITHOUT quantities still works without a production branch');
select is(public.t_pr_cost('PR-02'), 810000::bigint, 'the cost is saved');
reset role;
update public.organizations set production_branch_id = 'b3000000-0000-4000-8000-000000000001' where id = 'b2000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Una fila con sólo campos vacíos no existe; un lote sólo de costos no toca el stock
-- ---------------------------------------------------------------------------------------------
select public.t_pr_age();
select is(public.t_pr_all_moves(), (select count(*) from public.stock_movements where organization_id = 'b2000000-0000-4000-8000-000000000001'), 'sanity: ledger counter');
select lives_ok($$insert into keep values ('nostock', public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000001b', jsonb_build_array(public.t_pr_item('PR-02', '{"costCents":820000}'))))$$, 'a cost-only batch');
select is((select payload ->> 'stockMovements' || '/' || jsonb_array_length(payload -> 'stockOperationIds') from keep where name = 'nostock'), '0/0', 'registers no stock operation at all');
select public.t_pr_age();
insert into keep values ('rows_before', jsonb_build_array(public.t_pr_cost_rows('PR-02'), public.t_pr_price_rows('PR-02')));
select lives_ok($$insert into keep values ('samecost', public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000001f', jsonb_build_array(public.t_pr_item('PR-02', '{"costCents":820000}'))))$$, 'YERBA: the SAME cost again');
select is(jsonb_build_array(public.t_pr_cost_rows('PR-02'), public.t_pr_price_rows('PR-02')), (select payload from keep where name = 'rows_before'), 'the cost and price history of YERBA did not grow');
select is((select payload ->> 'costUnchanged' || '/' || (payload ->> 'costsSaved') || '/' || (payload ->> 'repriced') from keep where name = 'samecost'), '1/0/0', 'is reported as unchanged: no cost vigencia and no price vigencia are stacked');

-- ---------------------------------------------------------------------------------------------
-- Precio por sucursal: se informa, nunca se crea ni se toca
-- ---------------------------------------------------------------------------------------------
reset role;
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from)
values ('b2000000-0000-4000-8000-000000000001', public.t_pr_id('PR-03'), 'b3000000-0000-4000-8000-000000000002', 1800000, now() - interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.t_pr_age();
select lives_ok($$insert into keep values ('branchprice', public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000001c', jsonb_build_array(public.t_pr_item('PR-03', '{"costCents":1100000}'))))$$, 'NALGA: a new cost while Avenida has its own price');
select is((select payload ->> 'branchOverrides' from keep where name = 'branchprice'), '1', 'the existing branch-specific price is REPORTED (it still wins in that branch)');
select is((select count(*) from public.product_prices where product_id = public.t_pr_id('PR-03') and branch_id is not null), 1::bigint, 'and it was neither modified nor duplicated; the receipt created no branch price');
select is((select price_cents from public.product_prices where product_id = public.t_pr_id('PR-03') and branch_id is not null and valid_to is null), 1800000::bigint, 'the branch price keeps its value');

-- ---------------------------------------------------------------------------------------------
-- Búsqueda tras los cambios (margen efectivo por fila)
-- ---------------------------------------------------------------------------------------------
select is(
  (select r ->> 'marginSource' || '/' || coalesce(r ->> 'customMarginBps', 'null') from jsonb_array_elements(public.list_pricing_rows('aceite') -> 'rows') r),
  'CUSTOM/3500', 'ACEITE now reports its own margin');
select is(
  (select r ->> 'marginSource' || '/' || (r ->> 'priceCents') from jsonb_array_elements(public.list_pricing_rows('chorizo') -> 'rows') r),
  'MANUAL/920000', 'CHORIZO is manual again, at its hand-written price');
select is(
  (select r ->> 'marginSource' || '/' || (r ->> 'marginBps') from jsonb_array_elements(public.list_pricing_rows('muslo') -> 'rows') r),
  'CUSTOM/5000', 'MUSLO (Pollo) uses its own margin');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento y permisos
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000001d', jsonb_build_array(public.t_pr_item('PR-01', '{"receivedQuantity":5}')))$$, '42501', 'Uno de los productos enviados no existe, está inactivo o no es un producto de venta', 'the OTHER organization admin cannot touch this organization''s products');
select is((public.list_pricing_rows('aceite') ->> 'total'), '0', 'nor find them');
select is((public.list_pricing_rows() ->> 'total'), '1', 'it only lists its own product');
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-000000000016', jsonb_build_array(public.t_pr_item('PRB-11', '{"receivedQuantity":5}')))$$, '22023', 'Configurá la sucursal productiva (Desposte) antes de registrar el ingreso de mercadería', 'the other organization has no production branch of its own: a reused key of ANOTHER organization is not a replay');
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.apply_pricing_receipt('c0000000-0000-4000-8000-00000000001e', jsonb_build_array(public.t_pr_item('PR-01', '{"receivedQuantity":5}')))$$, '42501', 'Permission prices.write is required', 'an employee (no prices.write) cannot apply a receipt');
select throws_ok($$select public.list_pricing_rows('aceite')$$, '42501', 'Permission prices.write is required', 'nor search costs and margins');
reset role;
select is((select count(*) from public.stock_movements where branch_id = 'b3000000-0000-4000-8000-000000000002'), 0::bigint, 'at the end the other branch still has no movement');
select is((select count(*) from public.audit_logs where event_type = 'PRICING_RECEIPT_APPLIED'), (select count(*) from public.pricing_receipt_requests where result is not null), 'every applied receipt is audited');

select * from finish();
rollback;
