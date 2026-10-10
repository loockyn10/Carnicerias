begin;

create extension if not exists pgtap with schema extensions;
select plan(105);

-- Covers 202610160079 (D-081): Stock rápido desde el celular. UNA RPC (apply_quick_stock_changes) que aplica varios cambios de stock de varias
-- sucursales con UN toque, SIEMPRE por el flujo canónico del ledger (record_stock_operation): agregar = PURCHASE, quitar = ajuste negativo
-- calculado en el servidor, conteo físico = ajuste hacia el valor contado con su historia. Idempotente por clave; resultado parcial por producto.
-- Cantidades crudas: gramos para WEIGHT, unidades enteras para UNIT.

-- ---------------------------------------------------------------------------------------------
-- Fixture (prefijo d)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'qs-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"QS Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'qs-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"QS Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'qs-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"QS Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'QS Org', 'qs-org'),
  ('d2000000-0000-4000-8000-000000000002', 'QS Org B', 'qs-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'QS Central', 'QS-C'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'QS Avenida', 'QS-A'),
  ('d3000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'QS Janssen', 'QS-J'),
  ('d3000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000002', 'QS B Branch', 'QS-B');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Pollo', 'qs-pollo'),
  ('d4000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000002', 'Pollo', 'qsb-pollo');
-- 01 Pata muslo (WEIGHT), 02 Molida (WEIGHT), 03 Coca 2,25L (UNIT), 04 Filet (WEIGHT), 05 Sin surtido en Avenida (WEIGHT), 06 Org B.
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Pata muslo', 'qs-pata', 'QS-01', 'WEIGHT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Molida', 'qs-molida', 'QS-02', 'WEIGHT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Coca 2,25L', 'qs-coca', 'QS-03', 'UNIT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Filet', 'qs-filet', 'QS-04', 'WEIGHT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Sin surtido', 'qs-sin-surtido', 'QS-05', 'WEIGHT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-000000000002', 'Producto B', 'qsb-prod', 'QSB-06', 'WEIGHT', true, 'SELLABLE');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where p.sku <> 'QS-05' or b.code = 'QS-C';

create function public.t_qs_id(p_sku text) returns uuid language sql security definer as $$ select id from public.products where sku = p_sku $$;
create function public.t_qs_branch(p_code text) returns uuid language sql security definer as $$ select id from public.branches where code = p_code $$;
create function public.t_qs_stock(p_code text, p_sku text) returns bigint language sql security definer as $$
  select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements
  where product_id = public.t_qs_id(p_sku) and branch_id = public.t_qs_branch(p_code) $$;
create function public.t_qs_moves(p_code text, p_sku text) returns bigint language sql security definer as $$
  select count(*) from public.stock_movements where product_id = public.t_qs_id(p_sku) and branch_id = public.t_qs_branch(p_code) $$;
create function public.t_qs_all_moves() returns bigint language sql security definer as $$
  select count(*) from public.stock_movements where organization_id = 'd2000000-0000-4000-8000-000000000001' $$;
create function public.t_qs_requests() returns bigint language sql security definer as $$ select count(*) from public.quick_stock_requests $$;
create function public.t_qs_item(p_code text, p_sku text, p_changes jsonb) returns jsonb language sql security definer as $$
  select jsonb_build_object('branchId', public.t_qs_branch(p_code), 'productId', public.t_qs_id(p_sku)) || p_changes $$;
-- Cuántos movimientos del ledger de ese tipo y cantidad firmada hay para el producto en la sucursal (todo el archivo corre en UNA transacción:
-- created_at no distingue «el último», por eso se consulta por tipo y cantidad exactos).
create function public.t_qs_mv(p_code text, p_sku text, p_type text, p_qty bigint) returns bigint language sql security definer as $$
  select count(*) from public.stock_movements
  where product_id = public.t_qs_id(p_sku) and branch_id = public.t_qs_branch(p_code) and type::text = p_type and quantity_grams = p_qty $$;
-- Una línea de resultado: «ok/code|unchanged/before->after».
create function public.t_qs_line(p_result jsonb, p_code text, p_sku text) returns text language sql security definer as $$
  select (r ->> 'ok') || '/' || coalesce(r ->> 'code', case when (r ->> 'unchanged')::boolean then 'unchanged' else 'applied' end) || '/' ||
         coalesce(r ->> 'before', r ->> 'current', '-') || '->' || coalesce(r ->> 'after', '-')
  from jsonb_array_elements(p_result -> 'items') r
  where r ->> 'branchId' = public.t_qs_branch(p_code)::text and r ->> 'productId' = public.t_qs_id(p_sku)::text $$;

create function public.t_qs_audits() returns bigint language sql security definer as $$ select count(*) from public.audit_logs where event_type = 'QUICK_STOCK_APPLIED' $$;
create function public.t_qs_applied_requests() returns bigint language sql security definer as $$ select count(*) from public.quick_stock_requests where result is not null $$;

create temp table keep(name text primary key, payload jsonb);
grant all on keep to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'quick_stock_requests', 'the idempotency table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.quick_stock_requests'::regclass), 'it has RLS');
select ok(not has_table_privilege('authenticated', 'public.quick_stock_requests', 'SELECT'), 'browser clients cannot read it');
select ok(not has_table_privilege('authenticated', 'public.quick_stock_requests', 'INSERT'), 'nor insert into it');
select ok(not has_function_privilege('anon', 'public.apply_quick_stock_changes(uuid,jsonb)', 'EXECUTE'), 'anonymous cannot apply quick stock changes');
select ok(has_function_privilege('authenticated', 'public.apply_quick_stock_changes(uuid,jsonb)', 'EXECUTE'), 'an authenticated Admin can (permissions are checked inside)');
select is(public.t_qs_requests(), 0::bigint, 'the migration creates no request by itself');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Stock inicial por el flujo canónico: Avenida: Pata muslo 16,600 kg, Molida 8,000 kg, Coca 8 u, Filet 5,500 kg; Janssen: Filet 2,000 kg, Molida 1,000 kg.
select lives_ok($$select public.record_stock_operation(public.t_qs_branch('QS-A'), 'PURCHASE', jsonb_build_array(
  jsonb_build_object('product_id', public.t_qs_id('QS-01'), 'quantity_grams', 16600),
  jsonb_build_object('product_id', public.t_qs_id('QS-02'), 'quantity_grams', 8000),
  jsonb_build_object('product_id', public.t_qs_id('QS-03'), 'quantity_grams', 8),
  jsonb_build_object('product_id', public.t_qs_id('QS-04'), 'quantity_grams', 5500)), null, null, 'stock inicial')$$, 'the initial stock of Avenida is recorded through the canonical flow');
select lives_ok($$select public.record_stock_operation(public.t_qs_branch('QS-J'), 'PURCHASE', jsonb_build_array(
  jsonb_build_object('product_id', public.t_qs_id('QS-04'), 'quantity_grams', 2000),
  jsonb_build_object('product_id', public.t_qs_id('QS-02'), 'quantity_grams', 1000)), null, null, 'stock inicial')$$, 'the initial stock of Janssen too');
select is(public.t_qs_stock('QS-A', 'QS-01') || '/' || public.t_qs_stock('QS-A', 'QS-03'), '16600/8', 'Avenida has 16,600 kg of Pata muslo and 8 Coca');

-- ---------------------------------------------------------------------------------------------
-- Validación de forma: se rechaza el pedido ENTERO y no se escribe nada
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.apply_quick_stock_changes(null, jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":100}')))$$, '22023', 'Falta la clave de la operación', 'a missing request key is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), '[]'::jsonb)$$, '22023', 'Debe enviar entre 1 y 200 productos', 'an empty batch is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), '{"a":1}'::jsonb)$$, '22023', 'Debe enviar entre 1 y 200 productos', 'a non-array payload is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"SET","quantity":100}')))$$, '22023', 'Cada cambio tiene que ser agregar, quitar o contar', 'a mode other than ADD / REMOVE / COUNT is rejected (the stock is never SET directly)');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"quantity":100}')))$$, '22023', 'Cada cambio tiene que ser agregar, quitar o contar', 'a line without a mode is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":0}')))$$, '22023', 'La cantidad a agregar o quitar tiene que ser mayor a cero', 'adding zero is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":-5}')))$$, '22023', 'La cantidad a agregar o quitar tiene que ser mayor a cero', 'adding a negative quantity is rejected (use REMOVE)');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"REMOVE","quantity":-5}')))$$, '22023', 'La cantidad a agregar o quitar tiene que ser mayor a cero', 'removing a negative quantity is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":1.5}')))$$, '22023', 'La cantidad a agregar o quitar tiene que ser mayor a cero', 'a fractional quantity is rejected (the ledger is grams / whole units)');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":"100"}')))$$, '22023', 'La cantidad a agregar o quitar tiene que ser mayor a cero', 'a quantity sent as text is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"COUNT"}')))$$, '22023', 'El conteo tiene que ser una cantidad (puede ser cero)', 'a count without the counted quantity is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"COUNT","physicalQuantity":-1}')))$$, '22023', 'El conteo tiene que ser una cantidad (puede ser cero)', 'a negative count is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":100}'), public.t_qs_item('QS-A', 'QS-01', '{"mode":"REMOVE","quantity":50}')))$$, '22023', 'Un producto no puede venir dos veces para la misma sucursal en la misma carga', 'the same product twice for the same branch is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":100}') || '{"productId":"not-a-uuid"}'))$$, '22023', 'Los cambios de stock son inválidos', 'a malformed product id is rejected');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(jsonb_build_object('branchId', public.t_qs_branch('QS-A'), 'productId', public.t_qs_id('QSB-06'), 'mode', 'ADD', 'quantity', 100)))$$, '42501', 'Uno de los productos enviados no existe en esta organización', 'a product of ANOTHER organization rejects the whole request');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(jsonb_build_object('branchId', public.t_qs_branch('QS-B'), 'productId', public.t_qs_id('QS-01'), 'mode', 'ADD', 'quantity', 100)))$$, '42501', 'Una de las sucursales no está autorizada para operar stock', 'a branch of ANOTHER organization rejects the whole request');
select throws_ok($$select public.apply_quick_stock_changes(gen_random_uuid(), jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":100}'), jsonb_build_object('branchId', gen_random_uuid(), 'productId', public.t_qs_id('QS-02'), 'mode', 'ADD', 'quantity', 100)))$$, '42501', 'Una de las sucursales no está autorizada para operar stock', 'an unknown branch rejects the whole request, even if another line is valid');
select is(public.t_qs_requests() || '/' || public.t_qs_all_moves(), '0/6', 'every rejected call wrote nothing (no request key stored, only the 6 initial movements)');

-- ---------------------------------------------------------------------------------------------
-- AGREGAR: suma al ledger (PURCHASE), nunca reemplaza el stock
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('add', public.apply_quick_stock_changes('e0000000-0000-4000-8000-000000000001', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":15000}'),
  public.t_qs_item('QS-A', 'QS-03', '{"mode":"ADD","quantity":12}'))))$$, 'ADD 15 kg of Pata muslo and 12 Coca in one call');
select is(public.t_qs_stock('QS-A', 'QS-01'), 31600::bigint, 'WEIGHT: the stock was 16,600 and is now 31,600 (+15,000), NOT 15,000');
select is(public.t_qs_stock('QS-A', 'QS-03'), 20::bigint, 'UNIT: the stock was 8 and is now 20 (+12), NOT 12');
select is(public.t_qs_mv('QS-A', 'QS-01', 'PURCHASE', 15000) || '|' || public.t_qs_mv('QS-A', 'QS-03', 'PURCHASE', 12), '1|1', 'each ADD is ONE positive PURCHASE movement of the canonical ledger');
select is((select payload ->> 'requested' || '/' || (payload ->> 'applied') || '/' || (payload ->> 'unchanged') || '/' || (payload ->> 'failed') || '/' || (payload ->> 'replayed') from keep where name = 'add'), '2/2/0/0/false', 'the result reports 2 applied, 0 failed, not a replay');
select is(public.t_qs_line((select payload from keep where name = 'add'), 'QS-A', 'QS-01'), 'true/applied/16600->31600', 'the line carries the stock before and after');
select is((select count(*) from public.stock_operations where operation_type = 'PURCHASE' and note = 'Stock rápido: ingreso'), 1::bigint, 'both products went in ONE ledger operation of the branch (not one per product)');
select is((select count(*) from public.stock_operations o where o.note like 'Stock rápido%' and o.actor_profile_id = 'd1000000-0000-4000-8000-000000000001'), 1::bigint, 'the operation records the actor');
select is(public.t_qs_audits(), 1::bigint, 'the batch is audited');

-- ---------------------------------------------------------------------------------------------
-- QUITAR: resta calculada en el servidor, ajuste negativo (no es una merma)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('remove', public.apply_quick_stock_changes('e0000000-0000-4000-8000-000000000002', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-01', '{"mode":"REMOVE","quantity":3500}'),
  public.t_qs_item('QS-A', 'QS-03', '{"mode":"REMOVE","quantity":5}'))))$$, 'REMOVE 3,5 kg of Pata muslo and 5 Coca');
select is(public.t_qs_stock('QS-A', 'QS-01'), 28100::bigint, 'WEIGHT: 31,600 - 3,500 = 28,100');
select is(public.t_qs_stock('QS-A', 'QS-03'), 15::bigint, 'UNIT: 20 - 5 = 15');
select is(public.t_qs_mv('QS-A', 'QS-01', 'ADJUSTMENT_NEGATIVE', -3500) || '|' || public.t_qs_mv('QS-A', 'QS-03', 'ADJUSTMENT_NEGATIVE', -5), '1|1', 'a REMOVE is a negative adjustment of the ledger (a signed movement)');
select is((select count(*) from public.stock_operations where operation_type = 'WASTE'), 0::bigint, 'a REMOVE is NOT a waste (the waste report is not polluted)');
select is((select i.system_quantity_before_grams || '->' || i.physical_quantity_grams from public.stock_operation_items i join public.stock_operations o on o.id = i.operation_id
           where o.note = 'Stock rápido: baja' and i.product_id = public.t_qs_id('QS-01')), '31600->28100', 'the operation keeps the stock before and after');
select is((select payload ->> 'applied' from keep where name = 'remove'), '2', 'both removals were applied');

-- Quitar más de lo que hay: ESE producto falla, el resto se aplica; el stock nunca queda negativo.
select lives_ok($$insert into keep values ('toomuch', public.apply_quick_stock_changes('e0000000-0000-4000-8000-000000000003', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-03', '{"mode":"REMOVE","quantity":16}'),
  public.t_qs_item('QS-A', 'QS-02', '{"mode":"ADD","quantity":2000}'))))$$, 'removing 16 units of Coca (only 15) plus adding 2 kg of Molida');
select is(public.t_qs_line((select payload from keep where name = 'toomuch'), 'QS-A', 'QS-03'), 'false/INSUFFICIENT_STOCK/15->-', 'the Coca line fails with INSUFFICIENT_STOCK and reports the current stock');
select is(public.t_qs_line((select payload from keep where name = 'toomuch'), 'QS-A', 'QS-02'), 'true/applied/8000->10000', 'the Molida line was applied anyway (partial result)');
select is(public.t_qs_stock('QS-A', 'QS-03'), 15::bigint, 'the failed Coca keeps its stock (no negative stock)');
select is((select payload ->> 'applied' || '/' || (payload ->> 'failed') from keep where name = 'toomuch'), '1/1', 'the summary says 1 applied, 1 failed');
-- Quitar EXACTAMENTE lo que hay deja el producto en cero.
select lives_ok($$insert into keep values ('toZero', public.apply_quick_stock_changes('e0000000-0000-4000-8000-000000000004', jsonb_build_array(public.t_qs_item('QS-A', 'QS-03', '{"mode":"REMOVE","quantity":15}'))))$$, 'removing exactly what there is');
select is(public.t_qs_stock('QS-A', 'QS-03'), 0::bigint, 'the stock is exactly 0');
select lives_ok($$select public.apply_quick_stock_changes('e0000000-0000-4000-8000-000000000005', jsonb_build_array(public.t_qs_item('QS-A', 'QS-03', '{"mode":"ADD","quantity":8}')))$$, 'and adding 8 again');

-- ---------------------------------------------------------------------------------------------
-- CONTEO FÍSICO: lleva el stock al valor contado conservando la historia
-- ---------------------------------------------------------------------------------------------
select is(public.t_qs_stock('QS-A', 'QS-01'), 28100::bigint, 'Pata muslo has 28,100 g before the count');
select lives_ok($$insert into keep values ('countneg', public.apply_quick_stock_changes('e0000000-0000-4000-8000-000000000006', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-01', '{"mode":"COUNT","physicalQuantity":4200,"expectedSystemQuantity":28100}'))))$$, 'COUNT 4,200 kg (the system said 28,100)');
select is(public.t_qs_stock('QS-A', 'QS-01'), 4200::bigint, 'the stock now equals the physical count');
select is(public.t_qs_mv('QS-A', 'QS-01', 'ADJUSTMENT_NEGATIVE', -23900), 1::bigint, 'a lower count is a NEGATIVE adjustment of exactly the difference (the server computed it)');
select is(public.t_qs_line((select payload from keep where name = 'countneg'), 'QS-A', 'QS-01'), 'true/applied/28100->4200', 'the line reports system before and counted after');
select is((select (r ->> 'difference') from jsonb_array_elements((select payload -> 'items' from keep where name = 'countneg')) r), '-23900', 'and the difference');
select is((select i.system_quantity_before_grams || '/' || i.physical_quantity_grams || '/' || i.quantity_grams from public.stock_operation_items i join public.stock_operations o on o.id = i.operation_id
           where o.note = 'Stock rápido: conteo físico' and i.product_id = public.t_qs_id('QS-01')), '28100/4200/-23900', 'the ledger keeps previous stock, physical count and adjustment (auditable history)');
select is((select count(*) from public.stock_movements where product_id = public.t_qs_id('QS-01') and branch_id = public.t_qs_branch('QS-A')), 4::bigint, 'the history was NOT erased: the earlier movements are all still there');
select lives_ok($$insert into keep values ('countpos', public.apply_quick_stock_changes('e0000000-0000-4000-8000-000000000007', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-03', '{"mode":"COUNT","physicalQuantity":11}'),
  public.t_qs_item('QS-A', 'QS-02', '{"mode":"COUNT","physicalQuantity":0}'))))$$, 'COUNT 11 Coca (system 8) and COUNT 0 Molida');
select is(public.t_qs_mv('QS-A', 'QS-03', 'ADJUSTMENT_POSITIVE', 3) || '|' || public.t_qs_stock('QS-A', 'QS-03'), '1|11', 'a higher count is a POSITIVE adjustment (UNIT: +3 units)');
select is(public.t_qs_stock('QS-A', 'QS-02'), 0::bigint, 'a count of ZERO is valid: the product is left at 0');
-- El conteo coincide con el sistema: no hay nada que ajustar (no se crea ningún movimiento).
select lives_ok($$insert into keep values ('countsame', public.apply_quick_stock_changes('e0000000-0000-4000-8000-000000000008', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-04', '{"mode":"COUNT","physicalQuantity":5500}'))))$$, 'COUNT equal to the system stock');
select is(public.t_qs_line((select payload from keep where name = 'countsame'), 'QS-A', 'QS-04'), 'true/unchanged/5500->5500', 'it is reported as unchanged');
select is((select payload ->> 'unchanged' || '/' || (payload ->> 'applied') || '/' || (payload ->> 'failed') from keep where name = 'countsame'), '1/0/0', 'counted as unchanged, not as a failure');
select is(public.t_qs_moves('QS-A', 'QS-04'), 1::bigint, 'and no movement was written');
-- El stock del sistema cambió mientras la pantalla estaba abierta: el conteo NO se aplica (la diferencia mostrada ya no sería la real).
select lives_ok($$insert into keep values ('countstale', public.apply_quick_stock_changes('e0000000-0000-4000-8000-000000000009', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-04', '{"mode":"COUNT","physicalQuantity":4000,"expectedSystemQuantity":6000}'),
  public.t_qs_item('QS-J', 'QS-04', '{"mode":"COUNT","physicalQuantity":1500,"expectedSystemQuantity":2000}'))))$$, 'COUNT with a stale expected stock (the screen said 6,000, the ledger has 5,500)');
select is(public.t_qs_line((select payload from keep where name = 'countstale'), 'QS-A', 'QS-04'), 'false/STOCK_CHANGED/5500->-', 'it fails with STOCK_CHANGED and reports the real current stock');
select is(public.t_qs_stock('QS-A', 'QS-04'), 5500::bigint, 'nothing was adjusted for the stale line');
select is(public.t_qs_line((select payload from keep where name = 'countstale'), 'QS-J', 'QS-04') || '|' || public.t_qs_stock('QS-J', 'QS-04'), 'true/applied/2000->1500|1500', 'the up-to-date line of ANOTHER branch was counted anyway');

-- ---------------------------------------------------------------------------------------------
-- VARIAS SUCURSALES en un solo pedido, y un producto fuera del surtido
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('multi', public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000000a', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-04', '{"mode":"ADD","quantity":6000}'),
  public.t_qs_item('QS-J', 'QS-04', '{"mode":"ADD","quantity":6000}'),
  public.t_qs_item('QS-J', 'QS-02', '{"mode":"REMOVE","quantity":400}'),
  public.t_qs_item('QS-A', 'QS-05', '{"mode":"ADD","quantity":1000}'),
  public.t_qs_item('QS-C', 'QS-05', '{"mode":"ADD","quantity":1000}'))))$$, 'a request with two branches and a product that Avenida does not sell');
select is(public.t_qs_stock('QS-A', 'QS-04') || '|' || public.t_qs_stock('QS-J', 'QS-04') || '|' || public.t_qs_stock('QS-J', 'QS-02'), '11500|7500|600', 'each branch got ITS OWN quantities');
select is(public.t_qs_line((select payload from keep where name = 'multi'), 'QS-A', 'QS-05'), 'false/NOT_IN_BRANCH/-->-', 'a product that is not in the branch assortment fails with NOT_IN_BRANCH');
select is(public.t_qs_stock('QS-A', 'QS-05'), 0::bigint, 'and no stock lands where the product is not sold');
select is(public.t_qs_line((select payload from keep where name = 'multi'), 'QS-C', 'QS-05'), 'true/applied/0->1000', 'the same product in the branch that DOES sell it is applied');
select is((select payload ->> 'requested' || '/' || (payload ->> 'applied') || '/' || (payload ->> 'failed') from keep where name = 'multi'), '5/4/1', 'summary 5 requested, 4 applied, 1 failed');
select is(jsonb_array_length((select payload -> 'operationIds' from keep where name = 'multi')), 4, 'one ledger operation per (branch, kind): Avenida ADD, Janssen ADD, Janssen REMOVE, Central ADD');

-- ---------------------------------------------------------------------------------------------
-- IDEMPOTENCIA: doble toque / reintento de red
-- ---------------------------------------------------------------------------------------------
select is(public.t_qs_stock('QS-A', 'QS-02'), 0::bigint, 'Molida in Avenida is 0 before the idempotency test');
select lives_ok($$insert into keep values ('first', public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000000b', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-02', '{"mode":"ADD","quantity":15000}'))))$$, 'ADD 15 kg once');
select is(public.t_qs_stock('QS-A', 'QS-02'), 15000::bigint, 'Molida is 15,000');
select is(public.t_qs_all_moves(), 22::bigint, 'the ledger has 22 movements (6 initial + 16 written above)');
select lives_ok($$insert into keep values ('replay', public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000000b', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-02', '{"mode":"ADD","quantity":15000}'))))$$, 'the SAME call again (double tap)');
select is(public.t_qs_stock('QS-A', 'QS-02'), 15000::bigint, 'the stock is still 15,000: the +15 kg was NOT duplicated');
select is(public.t_qs_all_moves(), 22::bigint, 'no new ledger movement');
select is((select payload ->> 'replayed' from keep where name = 'replay'), 'true', 'the answer says it is a replay');
select is((select (payload - 'replayed') = (payload - 'replayed') and (select (k.payload - 'replayed') from keep k where k.name = 'first') = (payload - 'replayed') from keep where name = 'replay'), true, 'and it carries the SAME stored result as the first call');
select lives_ok($$select public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000000b', jsonb_build_array(public.t_qs_item('QS-A', 'QS-02', '{"mode":"ADD","quantity":15000}')))$$, 'a third and fourth tap are harmless too');
select throws_ok($$select public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000000b', jsonb_build_array(public.t_qs_item('QS-A', 'QS-02', '{"mode":"ADD","quantity":99000}')))$$, '22023', 'Esta operación ya se registró con otros datos: recargá la pantalla', 'the same key with ANOTHER payload is rejected, not applied');
select is(public.t_qs_stock('QS-A', 'QS-02'), 15000::bigint, 'still 15,000');
select is(public.t_qs_audits(), public.t_qs_applied_requests(), 'every applied request is audited exactly once (a replay does not audit again)');
-- Un reintento de lo que falló usa una clave NUEVA y se aplica.
select lives_ok($$insert into keep values ('retry', public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000000c', jsonb_build_array(
  public.t_qs_item('QS-A', 'QS-03', '{"mode":"REMOVE","quantity":16}'))))$$, 'a retry of a failed line with a NEW key is evaluated again (and fails again: Coca has 11)');
select is(public.t_qs_line((select payload from keep where name = 'retry'), 'QS-A', 'QS-03'), 'false/INSUFFICIENT_STOCK/11->-', 'the new key re-validates against the current stock');

-- ---------------------------------------------------------------------------------------------
-- Un error inesperado del ledger revierte SOLO ese grupo (subtransacción) y se informa por producto
-- ---------------------------------------------------------------------------------------------
reset role;
create function public.t_qs_boom() returns trigger language plpgsql as $$
begin
  if new.quantity_grams = 7777 then raise exception 'boom from the test' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger t_qs_boom before insert on public.stock_movements for each row execute function public.t_qs_boom();
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$insert into keep values ('boom', public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000000d', jsonb_build_array(
  public.t_qs_item('QS-J', 'QS-04', '{"mode":"ADD","quantity":7777}'),
  public.t_qs_item('QS-J', 'QS-02', '{"mode":"REMOVE","quantity":500}'),
  public.t_qs_item('QS-A', 'QS-04', '{"mode":"REMOVE","quantity":1500}'))))$$, 'a group whose ledger insert blows up does not abort the request');
select is(public.t_qs_line((select payload from keep where name = 'boom'), 'QS-J', 'QS-04'), 'false/FAILED/-->-', 'the line of the group that failed is reported as FAILED');
select is((select r ->> 'message' from jsonb_array_elements((select payload -> 'items' from keep where name = 'boom')) r where r ->> 'code' = 'FAILED'), 'boom from the test', 'with the reason');
select is(public.t_qs_stock('QS-J', 'QS-04'), 7500::bigint, 'and its stock is untouched (the subtransaction was rolled back)');
select is(public.t_qs_stock('QS-J', 'QS-02') || '|' || public.t_qs_stock('QS-A', 'QS-04'), '100|10000', 'the OTHER groups (another kind in the same branch, another branch) were applied');
select is((select payload ->> 'applied' || '/' || (payload ->> 'failed') from keep where name = 'boom'), '2/1', 'summary: 2 applied, 1 failed');
reset role;
drop trigger t_qs_boom on public.stock_movements;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Aislamiento y permisos
-- ---------------------------------------------------------------------------------------------
reset role;
update public.branches set active = false where code = 'QS-J';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000001f', jsonb_build_array(public.t_qs_item('QS-J', 'QS-04', '{"mode":"ADD","quantity":5}')))$$, '42501', 'Una de las sucursales no está autorizada para operar stock', 'an INACTIVE branch cannot receive stock changes');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000001d', jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":5}')))$$, '42501', 'Uno de los productos enviados no existe en esta organización', 'the OTHER organization admin cannot touch this organization''s products');
select lives_ok($$select public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000000b', jsonb_build_array(jsonb_build_object('branchId', public.t_qs_branch('QS-B'), 'productId', public.t_qs_id('QSB-06'), 'mode', 'ADD', 'quantity', 700)))$$, 'a request key of ANOTHER organization is not a replay (keys are per organization)');
select is(public.t_qs_stock('QS-B', 'QSB-06'), 700::bigint, 'it applied normally in its own organization');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.apply_quick_stock_changes('e0000000-0000-4000-8000-00000000001e', jsonb_build_array(public.t_qs_item('QS-A', 'QS-01', '{"mode":"ADD","quantity":5}')))$$, '42501', null, 'an employee (no stock.write) cannot apply quick stock changes');
reset role;
select is(public.t_qs_stock('QS-A', 'QS-01'), 4200::bigint, 'at the end Pata muslo is still where the count left it');

select * from finish();
rollback;
