begin;

create extension if not exists pgtap with schema extensions;
select plan(64);

-- Cubre 202611190108 (Pollos → «Mercadería a encargar», D-105): agrupación por producto, estados (sólo abiertos), fechas (sin fecha, por fecha,
-- vencidas), modificaciones (editar, cambiar fecha, cancelar, entregar), pedidos sin fecha, orden del catálogo de Pollos (categoría y número),
-- permisos, aislamiento por sucursal y organización, y que la lectura no escribe ni duplica nada.
-- Fixture: org A (admin, empleado sin permisos y usuario limitado a la sucursal A1) y org B (admin).

select ok(not has_function_privilege('anon', 'public.get_poultry_boxes_to_order()', 'EXECUTE'), 'anonymous cannot read what to order');
select ok(has_function_privilege('authenticated', 'public.get_poultry_boxes_to_order()', 'EXECUTE'), 'authenticated users reach the RPC (the permission is checked inside)');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pbo-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pbo Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pbo-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pbo Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pbo-limited-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pbo Limited A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'pbo-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pbo Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'Pbo Org A', 'pbo-org-a'),
  ('d2000000-0000-4000-8000-000000000002', 'Pbo Org B', 'pbo-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Central A1', 'A1'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'Sucursal A2', 'A2'),
  ('d3000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'Central B1', 'B1');
insert into public.roles (id, organization_id, key, name, is_system) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'pollos_limitado', 'Pollos limitado', false);
insert into public.role_permissions (role_id, permission_key) values
  ('d4000000-0000-4000-8000-000000000001', 'poultry.read'),
  ('d4000000-0000-4000-8000-000000000001', 'poultry.write');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd4000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003');
insert into public.products (id, organization_id, name, slug, sku, unit_type, active) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Pollo entero', 'pollo-entero', 'ENT', 'UNIT', true),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'Gallina', 'gallina', 'GAL', 'UNIT', true),
  ('d5000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'Medallones', 'medallones', 'MED', 'UNIT', true),
  ('d5000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'Menudos por kg', 'menudos', 'MEN', 'WEIGHT', true),
  ('d5000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'Pechuga', 'pechuga', 'PEC', 'UNIT', true),
  ('d5000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'Cajón de B', 'cajon-b', 'CAJB', 'UNIT', true);

-- Hoy según la organización (la misma fecha que usa la RPC) y el estado de las tablas de origen, para comprobar que leer no escribe.
create function public.t_pbo_today() returns date language sql security definer set search_path = '' as $$
  select (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date
$$;
-- «Producto@d=boxes» separados por «|» (d = días respecto de hoy; «s/f» = sin fecha), en el orden en que viene la RPC.
create function public.t_pbo_lines() returns text language sql security definer set search_path = '' as $$
  select coalesce(string_agg(
    (e ->> 'name') || '@' || case when e ->> 'deliveryOn' is null then 's/f' else ((e ->> 'deliveryOn')::date - (x.j ->> 'today')::date)::text end || '=' || (e ->> 'boxes'),
    '|' order by n), '')
  from (select public.get_poultry_boxes_to_order() as j) x, jsonb_array_elements(x.j -> 'lines') with ordinality as t(e, n)
$$;
-- Total de cajones de un producto (o de todos con null) en una vista: p_view = 'none' | 'all' | 'd<offset>' (una fecha concreta).
create function public.t_pbo_sum(p_name text, p_view text) returns bigint language sql security definer set search_path = '' as $$
  select coalesce(sum((e ->> 'boxes')::bigint), 0)::bigint
  from (select public.get_poultry_boxes_to_order() as j) x, jsonb_array_elements(x.j -> 'lines') as t(e)
  where (p_name is null or e ->> 'name' = p_name)
    and case
      when p_view = 'all' then true
      when p_view = 'none' then e ->> 'deliveryOn' is null
      else e ->> 'deliveryOn' is not null and ((e ->> 'deliveryOn')::date - (x.j ->> 'today')::date) = substr(p_view, 2)::int
    end
$$;
create function public.t_pbo_source() returns text language sql security definer set search_path = '' as $$
  select (select count(*) from public.poultry_orders)::text || '/' || (select count(*) from public.poultry_order_items)::text || '/'
    || (select count(*) from public.poultry_customers)::text || '/' || (select coalesce(sum(revenue_cents), 0) from public.poultry_orders)::text || '/'
    || (select coalesce(sum(unit_price_cents * boxes), 0) from public.poultry_order_items)::text || '/' || (select count(*) from public.poultry_order_counters)::text
$$;
grant execute on function public.t_pbo_today(), public.t_pbo_lines(), public.t_pbo_sum(text, text), public.t_pbo_source() to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Catálogo de Pollos: Pollo entero (1), Gallina (2), Pechuga (3) y Menudos por kg (4) en POLLO; Medallones en CONGELADOS.
select set_config('test.p_entero', public.add_poultry_product('d5000000-0000-4000-8000-000000000001', 'UNIT', false, null, 'POLLO')::text, true);
select set_config('test.p_gallina', public.add_poultry_product('d5000000-0000-4000-8000-000000000002', 'UNIT', false, null, 'POLLO')::text, true);
select set_config('test.p_pechuga', public.add_poultry_product('d5000000-0000-4000-8000-000000000005', 'UNIT', false, null, 'POLLO')::text, true);
select set_config('test.p_menudos', public.add_poultry_product('d5000000-0000-4000-8000-000000000004', 'WEIGHT', true, null, 'POLLO')::text, true);
select set_config('test.p_medallones', public.add_poultry_product('d5000000-0000-4000-8000-000000000003', 'UNIT', false, null, 'CONGELADOS')::text, true);
select set_config('test.list_gen', (select id::text from public.poultry_price_lists where organization_id = 'd2000000-0000-4000-8000-000000000001' and is_default), true);
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 4800000)$f$, current_setting('test.list_gen'), current_setting('test.p_entero')), 'General price of Pollo entero');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 3900000)$f$, current_setting('test.list_gen'), current_setting('test.p_gallina')), 'General price of Gallina');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 2500000)$f$, current_setting('test.list_gen'), current_setting('test.p_pechuga')), 'General price of Pechuga');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 150000)$f$, current_setting('test.list_gen'), current_setting('test.p_menudos')), 'General price per kg of Menudos');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 1800000)$f$, current_setting('test.list_gen'), current_setting('test.p_medallones')), 'General price of Medallones');
select lives_ok(format($f$select public.set_poultry_product_cost(%L, 4200000)$f$, current_setting('test.p_entero')), 'a cost so an order can be delivered');
select set_config('test.c_juan', public.save_poultry_customer('Juan')::text, true);
select set_config('test.c_pedro', public.save_poultry_customer('Pedro')::text, true);
select set_config('test.c_maria', public.save_poultry_customer('María')::text, true);
select set_config('test.today', public.t_pbo_today()::text, true);

select is(public.t_pbo_lines(), '', 'with no orders there is nothing to order');
select is(jsonb_array_length(public.get_poultry_boxes_to_order() -> 'lines'), 0, 'the lines are an empty array, not null');
select is((public.get_poultry_boxes_to_order() ->> 'today')::date, public.t_pbo_today(), 'the response carries today in the organization time zone');

-- ---------------------------------------------------------------------------------------------
-- El ejemplo del pedido: Juan 3 entero, Pedro 5 entero, María 2 gallina (todos sin fecha)
-- ---------------------------------------------------------------------------------------------
select set_config('test.o_juan', public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => current_setting('test.c_juan')::uuid,
  p_ordered_on => current_setting('test.today')::date, p_items => jsonb_build_array(jsonb_build_object('productId', current_setting('test.p_entero'), 'boxes', 3))) ->> 'orderId', true);
select set_config('test.o_pedro', public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => current_setting('test.c_pedro')::uuid,
  p_ordered_on => current_setting('test.today')::date, p_items => jsonb_build_array(jsonb_build_object('productId', current_setting('test.p_entero'), 'boxes', 5))) ->> 'orderId', true);
select set_config('test.o_maria', public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => current_setting('test.c_maria')::uuid,
  p_ordered_on => current_setting('test.today')::date, p_items => jsonb_build_array(jsonb_build_object('productId', current_setting('test.p_gallina'), 'boxes', 2))) ->> 'orderId', true);

select is(public.t_pbo_lines(), 'Pollo entero@s/f=8|Gallina@s/f=2', 'the example: 3 + 5 whole chickens and 2 hens = 8 and 2');
select is(public.t_pbo_sum(null, 'all'), 10::bigint, 'the grand total is 10 boxes');
select is(public.t_pbo_sum(null, 'none'), 10::bigint, 'with no dates, everything is in the «sin fecha» group');
select is((select (e ->> 'orders')::int from jsonb_array_elements(public.get_poultry_boxes_to_order() -> 'lines') e where e ->> 'name' = 'Pollo entero'), 2, 'two orders make up the whole chickens');
select is((select count(*) from jsonb_array_elements(public.get_poultry_boxes_to_order() -> 'lines') e where e ->> 'deliveryOn' = current_setting('test.today')), 0::bigint, 'an order without date is never assigned today''s date');
select set_config('test.source_read', public.t_pbo_source(), true);
select public.get_poultry_boxes_to_order();
select public.get_poultry_boxes_to_order();
select is(public.t_pbo_source(), current_setting('test.source_read'), 'reading what to order writes nothing (orders, items, customers, totals and counter unchanged)');

-- ---------------------------------------------------------------------------------------------
-- Estados: sólo los abiertos cuentan
-- ---------------------------------------------------------------------------------------------
select lives_ok(format($f$select public.set_poultry_order_status(%L, 'PREPARING')$f$, current_setting('test.o_juan')), 'Juan''s order goes to preparing');
select is(public.t_pbo_sum('Pollo entero', 'all'), 8::bigint, 'a PREPARING order still counts');
select lives_ok(format($f$select public.set_poultry_order_status(%L, 'READY')$f$, current_setting('test.o_juan')), 'Juan''s order goes to ready');
select is(public.t_pbo_sum('Pollo entero', 'all'), 8::bigint, 'a READY order still counts');
select lives_ok(format($f$select public.set_poultry_order_status(%L, 'DELIVERED')$f$, current_setting('test.o_juan')), 'Juan''s order is delivered');
select is(public.t_pbo_lines(), 'Pollo entero@s/f=5|Gallina@s/f=2', 'a DELIVERED order is no longer pending');
select lives_ok(format($f$select public.set_poultry_order_status(%L, 'CANCELLED')$f$, current_setting('test.o_maria')), 'María''s order is cancelled');
select is(public.t_pbo_lines(), 'Pollo entero@s/f=5', 'a CANCELLED order is not counted either');

-- ---------------------------------------------------------------------------------------------
-- Fechas: por fecha, vencidas que siguen contando, y mover un pedido de grupo
-- ---------------------------------------------------------------------------------------------
select set_config('test.o_vencido', public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => current_setting('test.c_juan')::uuid,
  p_ordered_on => current_setting('test.today')::date - 10, p_delivery_on => current_setting('test.today')::date - 3,
  p_items => jsonb_build_array(jsonb_build_object('productId', current_setting('test.p_gallina'), 'boxes', 4))) ->> 'orderId', true);
select set_config('test.o_manana', public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => current_setting('test.c_maria')::uuid,
  p_ordered_on => current_setting('test.today')::date, p_delivery_on => current_setting('test.today')::date + 1,
  p_items => jsonb_build_array(jsonb_build_object('productId', current_setting('test.p_entero'), 'boxes', 6), jsonb_build_object('productId', current_setting('test.p_medallones'), 'boxes', 2))) ->> 'orderId', true);
select set_config('test.o_hoy', public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => current_setting('test.c_pedro')::uuid,
  p_ordered_on => current_setting('test.today')::date, p_delivery_on => current_setting('test.today')::date,
  p_items => jsonb_build_array(jsonb_build_object('productId', current_setting('test.p_entero'), 'boxes', 1))) ->> 'orderId', true);

select is(public.t_pbo_sum(null, 'none'), 5::bigint, 'the «sin fecha» group only holds undated orders');
select is(public.t_pbo_sum(null, 'd-3'), 4::bigint, 'an overdue open order still counts, in its own date');
select is(public.t_pbo_sum(null, 'd0'), 1::bigint, 'today''s group holds today''s order');
select is(public.t_pbo_sum(null, 'd1'), 8::bigint, 'tomorrow''s group sums every line of that day');
select is(public.t_pbo_sum(null, 'all'), 18::bigint, 'the grand total ignores dates: 5 undated + 4 overdue + 1 today + 8 tomorrow');
select is(public.t_pbo_sum('Pollo entero', 'all'), 12::bigint, 'one product sums across dates: 5 + 1 + 6');
select is(public.t_pbo_lines(),
  'Pollo entero@s/f=5|Pollo entero@0=1|Pollo entero@1=6|Gallina@-3=4|Medallones@1=2',
  'lines come by catalog order (Pollo before Congelados), then date with «sin fecha» first');

-- Cambiar la fecha de entrega (editar el pedido) mueve el pedido de grupo; sin duplicar cantidades.
select lives_ok(format($f$select public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => %L, p_ordered_on => %L::date,
  p_items => jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 6), jsonb_build_object('productId', %L, 'boxes', 2)),
  p_delivery_on => %L::date, p_order_id => %L)$f$,
  current_setting('test.c_maria'), current_setting('test.today'), current_setting('test.p_entero'), current_setting('test.p_medallones'),
  (current_setting('test.today')::date + 4)::text, current_setting('test.o_manana')), 'the delivery date of an order is changed');
select is(public.t_pbo_sum(null, 'd1'), 0::bigint, 'the old date group is empty after the change');
select is(public.t_pbo_sum(null, 'd4'), 8::bigint, 'the order moved to the new date group');
select is(public.t_pbo_sum(null, 'all'), 18::bigint, 'moving the date does not change the grand total');

-- Quitar la fecha (null) lo devuelve a «sin fecha», no a hoy.
select lives_ok(format($f$select public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => %L, p_ordered_on => %L::date,
  p_items => jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 6), jsonb_build_object('productId', %L, 'boxes', 2)),
  p_order_id => %L)$f$,
  current_setting('test.c_maria'), current_setting('test.today'), current_setting('test.p_entero'), current_setting('test.p_medallones'), current_setting('test.o_manana')), 'the date of an order is cleared');
select is(public.t_pbo_sum(null, 'none'), 13::bigint, 'clearing the date moves the order back to «sin fecha»');
select is(public.t_pbo_sum(null, 'd0'), 1::bigint, 'and never to today');

-- ---------------------------------------------------------------------------------------------
-- Modificaciones: cantidades, líneas repetidas, cancelar, entregar
-- ---------------------------------------------------------------------------------------------
select lives_ok(format($f$select public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => %L, p_ordered_on => %L::date,
  p_items => jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 10), jsonb_build_object('productId', %L, 'boxes', 1)),
  p_order_id => %L)$f$,
  current_setting('test.c_maria'), current_setting('test.today'), current_setting('test.p_entero'), current_setting('test.p_medallones'), current_setting('test.o_manana')), 'the quantities of an order are edited');
select is(public.t_pbo_sum('Pollo entero', 'none'), 15::bigint, 'the new quantity replaces the old one (5 + 10), nothing is added twice');
select is(public.t_pbo_sum('Medallones', 'all'), 1::bigint, 'a reduced line shows the reduced quantity');
select lives_ok(format($f$select public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => %L, p_ordered_on => %L::date,
  p_items => jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 2), jsonb_build_object('productId', %L, 'boxes', 1)),
  p_order_id => %L)$f$,
  current_setting('test.c_maria'), current_setting('test.today'), current_setting('test.p_pechuga'), current_setting('test.p_pechuga'), current_setting('test.o_manana')), 'one order with the same product on two lines is saved');
select is(public.t_pbo_sum('Pechuga', 'all'), 3::bigint, 'two lines of the same product in one order add up to 3');
select is((select (e ->> 'orders')::int from jsonb_array_elements(public.get_poultry_boxes_to_order() -> 'lines') e where e ->> 'name' = 'Pechuga'), 1, 'and it counts as ONE order');
select is(public.t_pbo_sum('Pollo entero', 'all'), 5::bigint + 1::bigint, 'the edited order no longer holds whole chickens: 5 undated + 1 today');
select lives_ok(format($f$select public.set_poultry_order_status(%L, 'CANCELLED')$f$, current_setting('test.o_vencido')), 'the overdue order is cancelled');
select is(public.t_pbo_sum('Gallina', 'all'), 0::bigint, 'cancelling an order removes its boxes');

-- Un producto por kg cuenta cajones (no kilos) y no necesita peso.
select lives_ok(format($f$select public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => %L, p_ordered_on => %L::date,
  p_items => jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 7)))$f$,
  current_setting('test.c_pedro'), current_setting('test.today'), current_setting('test.p_menudos')), 'an order for a per-kg product');
select is(public.t_pbo_sum('Menudos por kg', 'none'), 7::bigint, 'a per-kg product counts whole boxes, without a real weight');

-- Un producto quitado de Pollos con pedidos abiertos sigue apareciendo (hay que encargarlo).
select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, false, 'POLLO')$f$, current_setting('test.p_pechuga')), 'a product is deactivated in Pollos');
select is(public.t_pbo_sum('Pechuga', 'all'), 3::bigint, 'an inactive product with open orders is still listed');

-- ---------------------------------------------------------------------------------------------
-- Orden por categoría y número del catálogo de Pollos
-- ---------------------------------------------------------------------------------------------
select lives_ok(format($f$select public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000001', p_customer_id => %L, p_ordered_on => %L::date,
  p_items => jsonb_build_array(jsonb_build_object('productId', %L, 'boxes', 2)), p_delivery_on => %L::date)$f$,
  current_setting('test.c_juan'), current_setting('test.today'), current_setting('test.p_medallones'), (current_setting('test.today')::date + 2)::text), 'an order for a frozen product');
select lives_ok(format($f$select public.set_poultry_product_sort_order(%L, 1)$f$, current_setting('test.p_menudos')), 'Menudos goes first in Pollo');
select is((select string_agg(distinct e ->> 'name', ',') from jsonb_array_elements(public.get_poultry_boxes_to_order() -> 'lines') e where e ->> 'category' = 'CONGELADOS'), 'Medallones', 'frozen products carry their category');
select is((select (public.get_poultry_boxes_to_order() -> 'lines' -> 0 ->> 'name')), 'Menudos por kg', 'the first line follows the manual number of the Pollos catalog');
select is((select (public.get_poultry_boxes_to_order() -> 'lines' -> -1 ->> 'name')), 'Medallones', 'Congelados always come after Pollo');

-- ---------------------------------------------------------------------------------------------
-- La lectura no escribe: cantidades, precios, clientes y pedidos originales intactos
-- ---------------------------------------------------------------------------------------------
select is((select revenue_cents::text from public.poultry_orders where id = current_setting('test.o_pedro')::uuid), '24000000', 'the original order keeps its own revenue (5 × 4.800.000 / 100 centavos)');
select is((select count(*) from public.poultry_customers where organization_id = 'd2000000-0000-4000-8000-000000000001'), 3::bigint, 'customers are untouched');

-- ---------------------------------------------------------------------------------------------
-- Permisos y aislamiento
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.t_pbo_sum(null, 'all'), 18::bigint, 'a user limited to branch A1 sees A1 orders');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select set_config('test.o_a2', public.save_poultry_order(p_branch_id => 'd3000000-0000-4000-8000-000000000002', p_customer_id => current_setting('test.c_juan')::uuid,
  p_ordered_on => current_setting('test.today')::date, p_items => jsonb_build_array(jsonb_build_object('productId', current_setting('test.p_entero'), 'boxes', 9))) ->> 'orderId', true);
select is(public.t_pbo_sum('Pollo entero', 'all'), 15::bigint, 'the admin (all branches) now sees the A2 order too: 6 + 9');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.t_pbo_sum('Pollo entero', 'all'), 6::bigint, 'the limited user does not see the A2 order');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.get_poultry_boxes_to_order()$$, '42501', null, 'an employee without Pollos permission cannot read what to order');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000009', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select is(public.t_pbo_lines(), '', 'org B sees nothing from org A');

select * from finish();
rollback;
