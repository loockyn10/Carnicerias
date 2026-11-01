begin;

create extension if not exists pgtap with schema extensions;
select plan(123);

-- Cubre 202611010092 (módulo Pollos): catálogo, costos versionados, listas de precios, precio por cliente, clientes, pedidos,
-- snapshots de precio (al crear) y de costo (al entregar), facturación / ganancia / margen y aislamiento por organización y sucursal.
-- Fixture: org A (admin, empleado sin permisos, usuario limitado a la sucursal A1 con permisos de Pollos) y org B (admin).

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select ok(exists(select 1 from public.permissions where key = 'poultry.read') and exists(select 1 from public.permissions where key = 'poultry.write'), 'the poultry permissions exist');
select ok(exists(select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000001' and permission_key = 'poultry.write'), 'the admin role can write poultry');
select ok(not exists(select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000002' and permission_key like 'poultry.%'), 'the employee role holds no poultry permission');
select ok(not has_function_privilege('anon', 'public.save_poultry_order(uuid,uuid,date,jsonb,date,public.payment_method,text,uuid,uuid)', 'EXECUTE'), 'anonymous cannot save orders');
select ok(not has_function_privilege('anon', 'public.set_poultry_product_cost(uuid,bigint,timestamptz)', 'EXECUTE'), 'anonymous cannot set costs');
select ok(not has_function_privilege('authenticated', 'app_private.poultry_resolve_price(uuid,uuid,uuid,timestamptz)', 'EXECUTE'), 'the price resolver is private');
select ok(not has_table_privilege('authenticated', 'public.poultry_orders', 'INSERT'), 'orders have no direct INSERT grant');
select ok(not has_table_privilege('authenticated', 'public.poultry_product_costs', 'UPDATE'), 'costs have no direct UPDATE grant');
select ok(not has_table_privilege('authenticated', 'public.poultry_order_counters', 'SELECT'), 'the order counter is not readable');
select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.poultry_products'::regclass, 'public.poultry_product_costs'::regclass, 'public.poultry_price_lists'::regclass, 'public.poultry_price_list_prices'::regclass,
  'public.poultry_customers'::regclass, 'public.poultry_customer_prices'::regclass, 'public.poultry_orders'::regclass, 'public.poultry_order_items'::regclass)), 'every poultry table has RLS enabled');

-- ---------------------------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pol-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pol Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pol-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pol Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pol-limited-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pol Limited A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'pol-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pol Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'Pol Org A', 'pol-org-a'),
  ('c2000000-0000-4000-8000-000000000002', 'Pol Org B', 'pol-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Central A1', 'A1'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Sucursal A2', 'A2'),
  ('c3000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'Central B1', 'B1');
insert into public.roles (id, organization_id, key, name, is_system) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'pollos_limitado', 'Pollos limitado', false);
insert into public.role_permissions (role_id, permission_key) values
  ('c4000000-0000-4000-8000-000000000001', 'poultry.read'),
  ('c4000000-0000-4000-8000-000000000001', 'poultry.write');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003');

select ok((select count(*) from public.poultry_price_lists where organization_id = 'c2000000-0000-4000-8000-000000000001' and is_default and name = 'General') = 1, 'a new organization gets its General price list');

create function public.t_poultry_price(p_customer uuid, p_product uuid) returns text language sql security definer set search_path = '' as $$
  select r.price_cents::text || '/' || r.source from app_private.poultry_resolve_price('c2000000-0000-4000-8000-000000000001', p_customer, p_product, clock_timestamp()) r
$$;
create function public.t_poultry_unpriced_count() returns bigint language sql security definer set search_path = '' as $$
  select count(*) from app_private.poultry_resolve_price('c2000000-0000-4000-8000-000000000001', null, gen_random_uuid(), clock_timestamp())
$$;
grant execute on function public.t_poultry_price(uuid, uuid), public.t_poultry_unpriced_count() to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Productos, listas y clientes
-- ---------------------------------------------------------------------------------------------
select set_config('test.p1', public.save_poultry_product('Cajón pollo entero', 'UNIT', false, 20000)::text, true);
select set_config('test.p2', public.save_poultry_product('Pata muslo por kg', 'WEIGHT')::text, true);
select set_config('test.p3', public.save_poultry_product('Menudos por kg', 'WEIGHT')::text, true);
select ok(current_setting('test.p1') <> '' and current_setting('test.p2') <> '', 'two poultry products are created without hardcoded names');
select is((select requires_weight from public.poultry_products where id = current_setting('test.p2')::uuid), true, 'a per-kg product always requires the real weight');
select throws_ok($$select public.save_poultry_product('cajon POLLO entero', 'UNIT')$$, '23505', null, 'the same name (case/accents) is a duplicate');
select throws_ok($$select public.save_poultry_product('', 'UNIT')$$, '22023', null, 'a blank product name is rejected');

select set_config('test.list_may', public.save_poultry_price_list('Mayorista')::text, true);
select set_config('test.list_gen', (select id::text from public.poultry_price_lists where is_default), true);
select throws_ok($$select public.save_poultry_price_list('mayorista')$$, '23505', null, 'duplicate list names are rejected');
select throws_ok(format($f$select public.save_poultry_price_list('General', null, false, %L)$f$, current_setting('test.list_gen')), '22023', null, 'the General list cannot be deactivated');

select set_config('test.c1', public.save_poultry_customer('Supermercado X', '11 5555-0001', 'Av. Siempreviva 1', '30-70000000-1', current_setting('test.list_may')::uuid, 'Paga a 7 días')::text, true);
select set_config('test.c2', public.save_poultry_customer('Rotisería Y')::text, true);
select is((select price_list_id from public.poultry_customers where id = current_setting('test.c1')::uuid), current_setting('test.list_may')::uuid, 'a customer keeps its assigned price list');
select is((select price_list_id from public.poultry_customers where id = current_setting('test.c2')::uuid), null, 'a customer without list uses General');
select throws_ok($$select public.save_poultry_customer('SUPERMERCADO  x')$$, '23505', null, 'duplicate customer names are rejected');
select throws_ok(format($f$select public.save_poultry_customer('Raro', null, null, null, %L)$f$, gen_random_uuid()), '42501', null, 'an unknown price list is rejected');

-- ---------------------------------------------------------------------------------------------
-- Costos versionados
-- ---------------------------------------------------------------------------------------------
select lives_ok(format($f$select public.set_poultry_product_cost(%L, 4200000)$f$, current_setting('test.p1')), 'the first cost is recorded');
select lives_ok(format($f$select public.set_poultry_product_cost(%L, 150000)$f$, current_setting('test.p2')), 'a per-kg cost is recorded');
select is((select count(*) from public.poultry_product_costs where product_id = current_setting('test.p1')::uuid), 1::bigint, 'one cost version exists');
select lives_ok(format($f$select public.set_poultry_product_cost(%L, 4200000)$f$, current_setting('test.p1')), 're-sending the same cost is idempotent');
select is((select count(*) from public.poultry_product_costs where product_id = current_setting('test.p1')::uuid), 1::bigint, 'no duplicate version was created');
select throws_ok(format($f$select public.set_poultry_product_cost(%L, 0)$f$, current_setting('test.p1')), '22023', null, 'a zero cost is rejected');
select throws_ok(format($f$select public.set_poultry_product_cost(%L, 100, now() - interval '1 day')$f$, current_setting('test.p1')), '22023', null, 'a cost cannot start in the past');

-- ---------------------------------------------------------------------------------------------
-- Listas de precios y precio por cliente
-- ---------------------------------------------------------------------------------------------
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 4800000)$f$, current_setting('test.list_gen'), current_setting('test.p1')), 'General price for the box');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 4600000)$f$, current_setting('test.list_may'), current_setting('test.p1')), 'Mayorista price for the box');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 200000)$f$, current_setting('test.list_gen'), current_setting('test.p2')), 'General price per kg');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 33333)$f$, current_setting('test.list_gen'), current_setting('test.p3')), 'a General price with odd cents for a per-kg product');
select lives_ok(format($f$select public.set_poultry_customer_price(%L, %L, 4500000)$f$, current_setting('test.c2'), current_setting('test.p1')), 'a special price for one customer');
select throws_ok(format($f$select public.set_poultry_list_price(%L, %L, 0)$f$, current_setting('test.list_gen'), current_setting('test.p1')), '22023', null, 'a zero price is rejected');

select is(public.t_poultry_price(current_setting('test.c1')::uuid, current_setting('test.p1')::uuid), '4600000/LIST', 'a customer with a list gets the price of that list');
select is(public.t_poultry_price(current_setting('test.c2')::uuid, current_setting('test.p1')::uuid), '4500000/CUSTOMER', 'the customer-specific price wins over any list');
select is(public.t_poultry_price(current_setting('test.c1')::uuid, current_setting('test.p2')::uuid), '200000/DEFAULT', 'a product missing in the customer list falls back to General');
select is(public.t_poultry_unpriced_count(), 0::bigint, 'an unpriced product resolves to nothing');

-- Historia de precios y costos: el cambio cierra la vigencia anterior sin reescribirla.
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 4700000)$f$, current_setting('test.list_gen'), current_setting('test.p1')), 'a new General price is recorded');
select is((select count(*) from public.poultry_price_list_prices where product_id = current_setting('test.p1')::uuid and price_list_id = current_setting('test.list_gen')::uuid), 2::bigint, 'price history keeps both versions');
select ok((select valid_to is not null from public.poultry_price_list_prices where product_id = current_setting('test.p1')::uuid and price_list_id = current_setting('test.list_gen')::uuid and price_cents = 4800000), 'the previous price was closed, not rewritten');
select throws_ok(format($f$update public.poultry_price_list_prices set price_cents = 1 where product_id = %L$f$, current_setting('test.p1')), '42501', null, 'authenticated cannot rewrite a price (no UPDATE grant)');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 4800000)$f$, current_setting('test.list_gen'), current_setting('test.p1')), 'the General price goes back to 4.800.000 (new version)');

-- ---------------------------------------------------------------------------------------------
-- Pedidos: snapshot de precio al crear
-- ---------------------------------------------------------------------------------------------
select set_config('test.o1', (public.save_poultry_order(
  'c3000000-0000-4000-8000-000000000001', current_setting('test.c1')::uuid, date '2026-11-01',
  jsonb_build_array(jsonb_build_object('productId', current_setting('test.p1'), 'boxes', 5), jsonb_build_object('productId', current_setting('test.p2'), 'boxes', 2)),
  date '2026-11-03', 'TRANSFER', 'Entregar temprano') ->> 'orderId'), true);
select ok(current_setting('test.o1') <> '', 'an order is created');
select is((select order_number from public.poultry_orders where id = current_setting('test.o1')::uuid), 1::bigint, 'the first order is number 1');
select is((select status::text from public.poultry_orders where id = current_setting('test.o1')::uuid), 'PENDING', 'a new order is pending');
select is(
  (select jsonb_agg(jsonb_build_array(product_name_snapshot, unit_price_cents, price_source) order by position) from public.poultry_order_items where order_id = current_setting('test.o1')::uuid),
  '[["Cajón pollo entero",4600000,"LIST"],["Pata muslo por kg",200000,"DEFAULT"]]'::jsonb, 'each line snapshots the resolved price and its source');
select is((select revenue_cents from public.poultry_orders where id = current_setting('test.o1')::uuid), 23000000::bigint, 'revenue counts only the lines that can be valued (the per-kg line has no weight yet)');
select is((select line_revenue_cents from public.poultry_order_items where order_id = current_setting('test.o1')::uuid and position = 2), null, 'a per-kg line without weight has no revenue yet');

-- El precio cambia después: el pedido conserva el snapshot.
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 4700000)$f$, current_setting('test.list_may'), current_setting('test.p1')), 'the Mayorista price changes after the order');
select is((select unit_price_cents from public.poultry_order_items where order_id = current_setting('test.o1')::uuid and position = 1), 4600000::bigint, 'the order keeps the price it was taken with');
select is(
  (select (public.get_poultry_order_detail(current_setting('test.o1')::uuid) -> 'items' -> 0 ->> 'unitPriceCents')), '4600000', 'the detail RPC shows the snapshot price');

-- Idempotencia por request_key.
select set_config('test.key', gen_random_uuid()::text, true);
select set_config('test.o2', (public.save_poultry_order(
  'c3000000-0000-4000-8000-000000000001', current_setting('test.c2')::uuid, date '2026-11-01',
  jsonb_build_array(jsonb_build_object('productId', current_setting('test.p1'), 'boxes', 1)), null, null, null, null, current_setting('test.key')::uuid) ->> 'orderId'), true);
select is((public.save_poultry_order(
  'c3000000-0000-4000-8000-000000000001', current_setting('test.c2')::uuid, date '2026-11-01',
  jsonb_build_array(jsonb_build_object('productId', current_setting('test.p1'), 'boxes', 1)), null, null, null, null, current_setting('test.key')::uuid) ->> 'orderId'),
  current_setting('test.o2'), 'repeating the same request key returns the same order');
select is((select count(*) from public.poultry_orders), 2::bigint, 'the repeated request did not create another order');
select is((select unit_price_cents from public.poultry_order_items where order_id = current_setting('test.o2')::uuid), 4500000::bigint, 'the customer-specific price is snapshotted');
select is((select price_source from public.poultry_order_items where order_id = current_setting('test.o2')::uuid), 'CUSTOMER', 'the source is CUSTOMER');

-- Precio manual.
select is(
  (select (public.save_poultry_order('c3000000-0000-4000-8000-000000000001', current_setting('test.c2')::uuid, date '2026-11-01',
    jsonb_build_array(jsonb_build_object('productId', current_setting('test.p1'), 'boxes', 1, 'unitPriceCents', 4400000))) ->> 'revenueCents')),
  '4400000', 'a manual price is accepted');
select is((select price_source from public.poultry_order_items i join public.poultry_orders o on o.id = i.order_id where o.order_number = 3), 'MANUAL', 'a price different from the resolved one is marked MANUAL');
select lives_ok(format($f$select public.set_poultry_order_status(%L, 'CANCELLED')$f$, (select id from public.poultry_orders where order_number = 3)), 'the manual-price order is cancelled');

-- Validaciones.
select throws_ok(format($f$select public.save_poultry_order('c3000000-0000-4000-8000-000000000001', %L, date '2026-11-01', '[]'::jsonb)$f$, current_setting('test.c1')), '22023', null, 'an order needs at least one line');
select throws_ok(format($f$select public.save_poultry_order('c3000000-0000-4000-8000-000000000001', %L, date '2026-11-05', jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 1)), date '2026-11-01')$f$, current_setting('test.c1'), current_setting('test.p1')), '22023', null, 'delivery cannot precede the order date');
select throws_ok(format($f$select public.save_poultry_order('c3000000-0000-4000-8000-000000000001', %L, date '2026-11-01', jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 0)))$f$, current_setting('test.c1'), current_setting('test.p1')), '22023', null, 'zero boxes are rejected');

-- ---------------------------------------------------------------------------------------------
-- Estados, peso real y snapshot de costo al entregar
-- ---------------------------------------------------------------------------------------------
select lives_ok(format($f$select public.set_poultry_order_status(%L, 'PREPARING')$f$, current_setting('test.o1')), 'pending → preparing');
select lives_ok(format($f$select public.set_poultry_order_status(%L, 'READY')$f$, current_setting('test.o1')), 'preparing → ready');
select throws_ok(format($f$select public.set_poultry_order_status(%L, 'DELIVERED')$f$, current_setting('test.o1')), '22023', null, 'delivering needs the real weight of the per-kg line');
select is((select status::text from public.poultry_orders where id = current_setting('test.o1')::uuid), 'READY', 'a failed delivery leaves the order untouched');
select lives_ok(format($f$select public.set_poultry_order_weights(%L, jsonb_build_array(jsonb_build_object('itemId', (select id from public.poultry_order_items where order_id = %L and position = 2), 'actualWeightGrams', 30500)))$f$, current_setting('test.o1'), current_setting('test.o1')), 'the real weight is recorded');
select is((select line_revenue_cents from public.poultry_order_items where order_id = current_setting('test.o1')::uuid and position = 2), 6100000::bigint, 'a per-kg line is valued as price × weight (half-up)');
select is((select revenue_cents from public.poultry_orders where id = current_setting('test.o1')::uuid), 29100000::bigint, 'the order revenue includes the weighed line');
select is((select cost_cents from public.poultry_orders where id = current_setting('test.o1')::uuid), null, 'cost is not captured before delivery');

select lives_ok(format($f$select public.set_poultry_order_status(%L, 'DELIVERED')$f$, current_setting('test.o1')), 'the order is delivered');
select is((select status::text from public.poultry_orders where id = current_setting('test.o1')::uuid), 'DELIVERED', 'the status is delivered');
select is(
  (select jsonb_agg(jsonb_build_array(cost_cents_snapshot, line_cost_cents) order by position) from public.poultry_order_items where order_id = current_setting('test.o1')::uuid),
  '[[4200000,21000000],[150000,4575000]]'::jsonb, 'delivery snapshots the cost valid at that moment, per box and per kg');
select is((select cost_cents from public.poultry_orders where id = current_setting('test.o1')::uuid), 25575000::bigint, 'the order cost is the sum of the line costs');
select ok((select delivered_on is not null and delivered_at is not null from public.poultry_orders where id = current_setting('test.o1')::uuid), 'the delivery date is stored');
select throws_ok(format($f$select public.set_poultry_order_status(%L, 'PENDING')$f$, current_setting('test.o1')), '22023', null, 'a delivered order cannot be reopened');
select is((public.set_poultry_order_status(current_setting('test.o1')::uuid, 'DELIVERED') ->> 'changed')::boolean, false, 'delivering twice is a no-op');
select throws_ok(format($f$select public.save_poultry_order('c3000000-0000-4000-8000-000000000001', %L, date '2026-11-01', jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 9)), null, null, null, %L)$f$, current_setting('test.c1'), current_setting('test.p1'), current_setting('test.o1')), '22023', null, 'a delivered order cannot be edited');

-- El costo cambia después de entregar: el pedido entregado NO se recalcula.
select lives_ok(format($f$select public.set_poultry_product_cost(%L, 4500000)$f$, current_setting('test.p1')), 'the cost changes after the delivery');
select is((select count(*) from public.poultry_product_costs where product_id = current_setting('test.p1')::uuid), 2::bigint, 'cost history keeps both versions');
select ok((select valid_to is not null from public.poultry_product_costs where product_id = current_setting('test.p1')::uuid and cost_cents = 4200000), 'the old cost was closed, not rewritten');
select is((select cost_cents from public.poultry_orders where id = current_setting('test.o1')::uuid), 25575000::bigint, 'the delivered order keeps its historical cost');

select lives_ok(format($f$select public.set_poultry_order_status(%L, 'DELIVERED')$f$, current_setting('test.o2')), 'the second order is delivered with the new cost');
select is((select line_cost_cents from public.poultry_order_items where order_id = current_setting('test.o2')::uuid), 4500000::bigint, 'the second order captured the NEW cost');

-- ---------------------------------------------------------------------------------------------
-- Rentabilidad: facturación, costo, ganancia y margen (sólo entregados, con snapshots)
-- ---------------------------------------------------------------------------------------------
select is(
  (select public.get_poultry_summary(current_date - 30, current_date + 30) -> 'sold'),
  '{"orders":2,"revenueCents":"33600000","costCents":"30075000","profitCents":"3525000","marginBps":1049,"boxes":8,"weightGrams":30500}'::jsonb,
  'the summary aggregates revenue, historical cost, gross profit, margin, boxes and kilos');
select is(
  (select public.get_poultry_summary(current_date - 30, current_date + 30) -> 'open' ->> 'open')::int, 0, 'there are no open orders left (the manual one was cancelled)');
select is(
  (select public.get_poultry_profitability(current_date - 30, current_date + 30, 'order') -> 'totals' ->> 'profitCents'), '3525000', 'profitability totals match the summary');
select is(
  (select jsonb_agg(jsonb_build_array(r ->> 'label', r ->> 'revenueCents', r ->> 'profitCents', r -> 'marginBps')) from jsonb_array_elements(public.get_poultry_profitability(current_date - 30, current_date + 30, 'product') -> 'rows') r),
  '[["Cajón pollo entero","27500000","2000000",727],["Pata muslo por kg","6100000","1525000",2500]]'::jsonb,
  'profitability by product uses the line snapshots (entero: 5 × 4.600.000 + 1 × 4.500.000, cost 4.200.000 × 5 + 4.500.000)');
select is(
  (select jsonb_agg(r ->> 'label' order by r ->> 'label') from jsonb_array_elements(public.get_poultry_profitability(current_date - 30, current_date + 30, 'customer') -> 'rows') r),
  '["Rotisería Y","Supermercado X"]'::jsonb, 'profitability by customer');
select is((public.get_poultry_profitability(current_date - 30, current_date + 30, 'order') ->> 'total')::int, 2, 'profitability by order lists the two delivered orders');
select is((public.get_poultry_profitability(current_date - 30, current_date + 30, 'month', null, current_setting('test.c1')::uuid) -> 'totals' ->> 'revenueCents'), '29100000', 'profitability can filter by customer');
select is((public.get_poultry_profitability(current_date - 30, current_date + 30, 'order', current_setting('test.p2')::uuid) -> 'totals' ->> 'revenueCents'), '6100000', 'profitability can filter by product');
select is((public.get_poultry_profitability(date '2000-01-01', date '2000-01-02', 'product') -> 'totals' ->> 'revenueCents'), '0', 'an empty period has zero revenue');
select throws_ok($$select public.get_poultry_profitability(date '2026-12-01', date '2026-11-01')$$, '22023', null, 'an inverted range is rejected');

-- Ficha del cliente.
select is((public.get_poultry_customer_detail(current_setting('test.c1')::uuid) -> 'totals' ->> 'revenueCents'), '29100000', 'the customer card shows delivered revenue');
select is((public.get_poultry_customer_detail(current_setting('test.c1')::uuid) -> 'totals' -> 'boxes')::int, 7, 'the customer card shows boxes');
select is((public.list_poultry_customers_page() ->> 'total')::int, 2, 'the customer page lists both customers');
select is((public.list_poultry_customers_page('rotis') ->> 'total')::int, 1, 'customer search is accent/case-insensitive');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento por sucursal
-- ---------------------------------------------------------------------------------------------
select set_config('test.o_a2', (public.save_poultry_order(
  'c3000000-0000-4000-8000-000000000002', current_setting('test.c1')::uuid, date '2026-11-01',
  jsonb_build_array(jsonb_build_object('productId', current_setting('test.p1'), 'boxes', 3), jsonb_build_object('productId', current_setting('test.p3'), 'boxes', 1, 'actualWeightGrams', 1245))) ->> 'orderId'), true);
select is((select count(*) from public.poultry_orders), 4::bigint, 'the admin sees every branch');
select is((select line_revenue_cents from public.poultry_order_items where order_id = current_setting('test.o_a2')::uuid and position = 2), 41500::bigint, 'a per-kg line rounds half-up to the cent (33.333 × 1,245 kg = 41.500)');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 4900000)$f$, current_setting('test.list_may'), current_setting('test.p1')), 'the Mayorista price rises again after the A2 order');
select lives_ok(format($f$select public.save_poultry_order(null, %L, date '2026-11-01', jsonb_build_array(jsonb_build_object('itemId', %L, 'productId', %L, 'boxes', 4), jsonb_build_object('itemId', %L, 'productId', %L, 'boxes', 1, 'actualWeightGrams', 1245)), null, null, null, %L)$f$,
  current_setting('test.c1'),
  (select id::text from public.poultry_order_items where order_id = current_setting('test.o_a2')::uuid and position = 1), current_setting('test.p1'),
  (select id::text from public.poultry_order_items where order_id = current_setting('test.o_a2')::uuid and position = 2), current_setting('test.p3'),
  current_setting('test.o_a2')), 'an open order can be edited');
select is((select unit_price_cents from public.poultry_order_items where order_id = current_setting('test.o_a2')::uuid and position = 1), 4700000::bigint, 'editing an order keeps the price snapshot of the existing lines');
select is((select revenue_cents from public.poultry_orders where id = current_setting('test.o_a2')::uuid), 18841500::bigint, 'the edited order revenue is recomputed (4 × 4.700.000 + 41.500)');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.poultry_orders), 3::bigint, 'a branch-limited user sees only orders of its branch (table RLS)');
select is((public.list_poultry_orders_page() ->> 'total')::int, 3, 'the order page hides other branches');
select is(public.get_poultry_order_detail(current_setting('test.o_a2')::uuid), null, 'the detail of another branch order is not returned');
select throws_ok(format($f$select public.set_poultry_order_status(%L, 'READY')$f$, current_setting('test.o_a2')), '42501', null, 'a limited user cannot change an order of another branch');
select throws_ok(format($f$select public.save_poultry_order('c3000000-0000-4000-8000-000000000002', %L, date '2026-11-02', jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 1)))$f$, current_setting('test.c1'), current_setting('test.p1')), '42501', null, 'a limited user cannot create an order in another branch');
select lives_ok(format($f$select public.save_poultry_order('c3000000-0000-4000-8000-000000000001', %L, date '2026-11-02', jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 1)))$f$, current_setting('test.c1'), current_setting('test.p1')), 'a limited user can create an order in its own branch');
select is((public.get_poultry_summary(current_date - 30, current_date + 30) -> 'open' ->> 'open')::int, 1, 'the limited summary counts only its branch (the A2 order is hidden)');

-- Empleado sin permisos de Pollos.
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.get_poultry_price_board()$$, '42501', null, 'an employee cannot read the poultry module');
select is((select count(*) from public.poultry_orders), 0::bigint, 'an employee reads no orders directly');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento por organización
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000009', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select is((select count(*) from public.poultry_orders), 0::bigint, 'org B sees no order of org A');
select is((public.list_poultry_customers_page() ->> 'total')::int, 0, 'org B sees no customer of org A');
select is(jsonb_array_length(public.get_poultry_price_board() -> 'products'), 0, 'org B sees no product of org A');
select is(jsonb_array_length(public.get_poultry_price_board() -> 'lists'), 1, 'org B only has its own General list');
select is(public.get_poultry_order_detail(current_setting('test.o1')::uuid), null, 'org B cannot read an order of org A');
select throws_ok(format($f$select public.set_poultry_product_cost(%L, 1000)$f$, current_setting('test.p1')), '42501', null, 'org B cannot set the cost of a product of org A');
select throws_ok(format($f$select public.set_poultry_order_status(%L, 'CANCELLED')$f$, current_setting('test.o_a2')), '42501', null, 'org B cannot change an order of org A');
select throws_ok(format($f$select public.save_poultry_order('c3000000-0000-4000-8000-000000000009', %L, date '2026-11-01', jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 1)))$f$, current_setting('test.c1'), current_setting('test.p1')), '42501', null, 'org B cannot order for a customer of org A');
select throws_ok(format($f$select public.save_poultry_order('c3000000-0000-4000-8000-000000000001', %L, date '2026-11-01', jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 1)))$f$, gen_random_uuid(), gen_random_uuid()), '42501', null, 'org B cannot order in a branch of org A');
select is((public.get_poultry_summary(current_date - 30, current_date + 30) -> 'sold' ->> 'orders')::int, 0, 'org B summary is empty');

select * from finish();
rollback;
