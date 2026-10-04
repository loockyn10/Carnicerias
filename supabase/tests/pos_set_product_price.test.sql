begin;

create extension if not exists pgtap with schema extensions;
select plan(40);

-- Covers 202610020055: la caja de Central fija el precio de un producto sin precio (0 o inexistente)
-- sin convertirse en admin. Fixture: org A (Central = sucursal productiva, Avenida), org B. La cuenta
-- del dispositivo es de rol EMPLEADO (sin prices.write).

select ok(exists(select 1 from public.permissions where key = 'prices.pos_set_missing'), 'the permission exists');
select ok(
  exists(select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000002' and permission_key = 'prices.pos_set_missing'),
  'the employee role holds it (Fran is an employee)'
);
select ok(not has_function_privilege('anon', 'public.set_pos_product_price(uuid,uuid,text,uuid,bigint)', 'EXECUTE'), 'anonymous cannot set prices from the POS');
select ok(not has_function_privilege('authenticated', 'app_private.pos_price_authorize(uuid,uuid,text)', 'EXECUTE'), 'the authorization helper is private');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pp-device-central@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PP Device Central"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pp-device-avenida@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PP Device Avenida"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pp-fran@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Fran"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'pp-avenida-op@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Operador Avenida"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'pp-limited@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Sin permiso"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'PP Org A', 'pp-org-a'),
  ('d2000000-0000-4000-8000-000000000002', 'PP Org B', 'pp-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA'),
  ('d3000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'Org B Branch', 'PPB');
update public.organizations set production_branch_id = 'd3000000-0000-4000-8000-000000000001' where id = 'd2000000-0000-4000-8000-000000000001';

insert into public.roles (id, organization_id, key, name, description, is_system) values
  ('d8000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'seller-only', 'Sólo ventas', 'No price setting', false);
insert into public.role_permissions (role_id, permission_key) values
  ('d8000000-0000-4000-8000-000000000001', 'sales.create'), ('d8000000-0000-4000-8000-000000000001', 'sales.read');

insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000005', 'd8000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000004'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000005');
insert into public.pos_devices (id, organization_id, branch_id, label, registered_by) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'Central POS', 'd1000000-0000-4000-8000-000000000001'),
  ('d4000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'Avenida POS', 'd1000000-0000-4000-8000-000000000002');
insert into public.pos_operator_grants (organization_id, branch_id, device_id, operator_profile_id, issued_by, token_hash, valid_until) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001', encode(extensions.digest(convert_to(repeat('f', 64), 'UTF8'), 'sha256'), 'hex'), now() + interval '7 days'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000002', encode(extensions.digest(convert_to(repeat('a', 64), 'UTF8'), 'sha256'), 'hex'), now() + interval '7 days'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000005', 'd1000000-0000-4000-8000-000000000001', encode(extensions.digest(convert_to(repeat('b', 64), 'UTF8'), 'sha256'), 'hex'), now() + interval '7 days');

insert into public.categories (id, organization_id, name, slug) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Almacen', 'almacen'),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000002', 'Almacen', 'almacen');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('d6000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'GALLETITAS X', 'galletitas-x', 'GALL', 'UNIT', true),
  ('d6000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'coca', 'COCA', 'UNIT', true),
  ('d6000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Sin fila de precio', 'sin-fila', 'NOROW', 'UNIT', true),
  ('d6000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'No habilitado en Central', 'no-habilitado', 'NOCEN', 'UNIT', true),
  ('d6000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Inactivo', 'inactivo', 'INACT', 'UNIT', false),
  ('d6000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Vacio por peso', 'vacio', 'VAC', 'WEIGHT', true),
  ('d6000000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Pendiente de precio', 'pendiente', 'PEND', 'UNIT', true),
  ('d6000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', 'Producto de B', 'prod-b', 'PB', 'UNIT', true);
-- (la fila de product_category_assignments —proyección de la categoría principal— la crea el trigger del producto)
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', null, 0, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000002', null, 350000, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000004', null, 0, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000005', null, 0, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000006', null, 0, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000007', null, 0, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000009', null, 0, now() - interval '1 day');
insert into public.branch_product_assortment (organization_id, branch_id, product_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000002'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000003'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000005'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000006'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000007'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000004'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000006');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Antes: un producto con precio 0 llega al POS de Central con precio "0" (no se descarta)
-- ---------------------------------------------------------------------------------------------
select is(
  (select e ->> 'pricePerKgCents' from jsonb_array_elements(public.pull_pos_state('d4000000-0000-4000-8000-000000000001', 0) -> 'catalog') e where e ->> 'productName' = 'GALLETITAS X'),
  '0', 'the zero-price product is part of the Central catalog with price 0'
);

-- ---------------------------------------------------------------------------------------------
-- Fijar el precio
-- ---------------------------------------------------------------------------------------------
select is(
  public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000001', 180000) ->> 'status',
  'SET', 'Fran sets the price of Galletitas (it had $0)'
);
select is(
  (select jsonb_build_object('n', count(*), 'open', count(*) filter (where valid_to is null)) from public.product_prices where product_id = 'd6000000-0000-4000-8000-000000000001'),
  '{"n":2,"open":1}'::jsonb, 'the history is preserved: the old $0 row is closed and one new row is open'
);
select is((select price_cents from public.product_prices where product_id = 'd6000000-0000-4000-8000-000000000001' and valid_to is null), 180000::bigint, 'the new effective price is $1800');
select is((select price_cents from public.product_prices where product_id = 'd6000000-0000-4000-8000-000000000001' and valid_to is not null), 0::bigint, 'the previous $0 row was kept as history');
select is((select created_by from public.product_prices where product_id = 'd6000000-0000-4000-8000-000000000001' and valid_to is null), 'd1000000-0000-4000-8000-000000000003'::uuid, 'the price is attributed to the operator, not the device account');
select is(
  (select e ->> 'pricePerKgCents' from jsonb_array_elements(public.pull_pos_state('d4000000-0000-4000-8000-000000000001', 0) -> 'catalog') e where e ->> 'productName' = 'GALLETITAS X'),
  '180000', 'the next sync delivers the new price: the next scan already costs $1800'
);
select is(
  public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000001', 180000) ->> 'status',
  'UNCHANGED', 'repeating the same call (retry) is idempotent'
);
select is((select count(*) from public.product_prices where product_id = 'd6000000-0000-4000-8000-000000000001'), 2::bigint, 'the retry created no new price row');
select is(
  (public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000001', 180000) -> 'product' ->> 'productName'),
  'GALLETITAS X', 'the response carries the catalog row of the product'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000001', 250000)$$,
  '22023', null, 'once a product has a price the POS cannot change it (that is an Admin decision)'
);
select is((select price_cents from public.product_prices where product_id = 'd6000000-0000-4000-8000-000000000001' and valid_to is null), 180000::bigint, 'the failed attempt left the price intact');

-- Un producto que ya vale algo no se toca desde la caja.
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000002', 100)$$,
  '22023', null, 'a product with a price (Coca Cola) cannot be repriced from the POS'
);
select is(
  public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000002', 350000) ->> 'status',
  'UNCHANGED', 'asking for the price it already has is a no-op'
);

-- Sin ninguna fila de precio y un producto por peso con precio 0.
select is(
  public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000003', 99000) ->> 'status',
  'SET', 'a product with no price row at all also gets its first price'
);
select is(
  (select jsonb_build_object('branch', branch_id, 'price', price_cents) from public.product_prices where product_id = 'd6000000-0000-4000-8000-000000000003'),
  '{"branch":null,"price":99000}'::jsonb, 'as a global price'
);
select is(
  public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000006', 1500000) ->> 'status',
  'SET', 'a WEIGHT product (per kg) can also be priced'
);

-- ---------------------------------------------------------------------------------------------
-- Validaciones
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000004', 0)$$,
  '22023', null, 'the price must be greater than zero (0)'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000004', -100)$$,
  '22023', null, 'the price must be greater than zero (negative)'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000004', null)$$,
  '22023', null, 'the price is required'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000001', 999999999999)$$,
  '22023', null, 'an absurd price is rejected'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000004', 5000)$$,
  '42501', null, 'a product not enabled in Central cannot be priced from Central'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000005', 5000)$$,
  '42501', null, 'an inactive product cannot be priced'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000009', 5000)$$,
  '42501', null, 'a product of another organization is rejected'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-0000000000ff', 5000)$$,
  '42501', null, 'an unknown product is rejected'
);

-- ---------------------------------------------------------------------------------------------
-- Autorización: dispositivo, sucursal, operador, permiso
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', repeat('e', 64), 'd6000000-0000-4000-8000-000000000007', 5000)$$,
  '42501', null, 'a wrong operator token is rejected'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'short', 'd6000000-0000-4000-8000-000000000007', 5000)$$,
  '42501', null, 'a malformed operator token is rejected'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003', repeat('f', 64), 'd6000000-0000-4000-8000-000000000007', 5000)$$,
  '42501', null, 'an operator grant is bound to its own device'
);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000005', repeat('b', 64), 'd6000000-0000-4000-8000-000000000007', 5000)$$,
  '42501', null, 'an operator without the permission cannot set prices'
);
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
  $$select public.set_pos_product_price('d4000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000004', repeat('a', 64), 'd6000000-0000-4000-8000-000000000007', 5000)$$,
  '42501', 'El precio de un producto sin precio sólo se puede fijar desde el POS de la sucursal Central', 'the POS of Avenida (not the production branch) cannot set prices'
);
select is((select count(*) from public.product_prices where product_id = 'd6000000-0000-4000-8000-000000000007'), 1::bigint, 'and the product kept its single $0 row');

-- La cuenta técnica del dispositivo no es admin: no escribe precios por fuera de la RPC.
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000004', null, 1, now())$$,
  '42501', null, 'the device account cannot write prices directly'
);
select throws_ok(
  $$select public.set_product_price('d6000000-0000-4000-8000-000000000004', null, 1000)$$,
  '42501', null, 'nor through the Admin price RPC'
);

-- ---------------------------------------------------------------------------------------------
-- Auditoría y cola de cambios del POS
-- ---------------------------------------------------------------------------------------------
reset role;
select is(
  (select jsonb_build_object('before', before_data ->> 'priceCents', 'after', after_data ->> 'priceCents', 'op', after_data ->> 'operatorProfileId')
   from public.audit_logs where event_type = 'POS_PRODUCT_PRICE_SET' and entity_id = 'd6000000-0000-4000-8000-000000000001'),
  '{"before":"0","after":"180000","op":"d1000000-0000-4000-8000-000000000003"}'::jsonb,
  'the change is audited with the previous price and the operator'
);
select is((select count(*) from public.audit_logs where event_type = 'POS_PRODUCT_PRICE_SET'), 3::bigint, 'one audit row per real change (none for the idempotent retries)');
select ok(
  exists(select 1 from public.pos_catalog_changes where entity_id = 'd6000000-0000-4000-8000-000000000001' and entity_type = 'PRICE'),
  'the price change is queued for the incremental POS sync'
);

select * from finish();
rollback;
