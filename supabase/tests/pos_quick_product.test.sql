begin;

create extension if not exists pgtap with schema extensions;
select plan(83);

-- ---------------------------------------------------------------------------------------------
-- Shape and hardening
-- ---------------------------------------------------------------------------------------------
select ok(exists(select 1 from public.permissions where key = 'products.quick_create'), 'the quick-create permission exists');
select ok(
  exists(select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000002' and permission_key = 'products.quick_create'),
  'the employee role holds it (Fran is an employee)'
);
select ok(not has_function_privilege('anon', 'public.create_pos_quick_product(uuid,uuid,text,text,text,bigint,bigint)', 'EXECUTE'), 'anonymous cannot create products from the POS');
select ok(not has_function_privilege('anon', 'public.get_pos_device_capabilities(uuid)', 'EXECUTE'), 'anonymous cannot read device capabilities');
select ok(not has_function_privilege('authenticated', 'app_private.pos_catalog_product_json(uuid,uuid,uuid)', 'EXECUTE'), 'the catalog-row helper is private');

-- ---------------------------------------------------------------------------------------------
-- Fixture: org A (Central = production branch, Avenida), org B. Device accounts are EMPLOYEE-role
-- users (no products.write / prices.write): the quick create must work without elevating them.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'qp-device-central@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"QP Device Central"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'qp-device-avenida@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"QP Device Avenida"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'qp-fran@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Fran"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'qp-avenida-op@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Operador Avenida"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'qp-limited@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Sin permiso"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'qp-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"QP Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('a2000000-0000-4000-8000-000000000001', 'QP Org A', 'qp-org-a'),
  ('a2000000-0000-4000-8000-000000000002', 'QP Org B', 'qp-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA'),
  ('a3000000-0000-4000-8000-000000000009', 'a2000000-0000-4000-8000-000000000002', 'Org B Branch', 'QPB');
update public.organizations set production_branch_id = 'a3000000-0000-4000-8000-000000000001' where id = 'a2000000-0000-4000-8000-000000000001';

-- A custom role WITHOUT products.quick_create (still able to sell) to prove the permission is checked on the operator.
insert into public.roles (id, organization_id, key, name, description, is_system) values
  ('a8000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'seller-only', 'Sólo ventas', 'No quick create', false);
insert into public.role_permissions (role_id, permission_key) values
  ('a8000000-0000-4000-8000-000000000001', 'sales.create'), ('a8000000-0000-4000-8000-000000000001', 'sales.read');

insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000005', 'a8000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000004'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000005');

insert into public.pos_devices (id, organization_id, branch_id, label, registered_by) values
  ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'Central POS', 'a1000000-0000-4000-8000-000000000001'),
  ('a4000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'Avenida POS', 'a1000000-0000-4000-8000-000000000002');

-- Operator grants (what verify_pos_operator_pin issues after the PIN): token sha256, bound to device + operator.
insert into public.pos_operator_grants (organization_id, branch_id, device_id, operator_profile_id, issued_by, token_hash, valid_until) values
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001', encode(extensions.digest(convert_to(repeat('f', 64), 'UTF8'), 'sha256'), 'hex'), now() + interval '7 days'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a4000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000002', encode(extensions.digest(convert_to(repeat('a', 64), 'UTF8'), 'sha256'), 'hex'), now() + interval '7 days'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000001', encode(extensions.digest(convert_to(repeat('b', 64), 'UTF8'), 'sha256'), 'hex'), now() + interval '7 days');

insert into public.categories (id, organization_id, name, slug) values
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Almacen', 'almacen'),
  ('a5000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'Bebidas', 'bebidas'),
  ('a5000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'Carnes', 'carnes');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('a6000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'Coca Cola 2.25 L', 'coca-cola', 'COCA-225', 'UNIT', true),
  ('a6000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'Agua 500 cc', 'agua-500', 'AGUA-5', 'UNIT', true),
  ('a6000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'Inactivo', 'inactivo', 'INACT-1', 'UNIT', false),
  ('a6000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003', 'Vacío', 'vacio', 'VAC-1', 'WEIGHT', true);
-- (la fila de product_category_assignments —proyección de la categoría principal— la crea el trigger del producto)
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from)
select organization_id, id, null, 100000, now() - interval '1 day' from public.products where organization_id = 'a2000000-0000-4000-8000-000000000001';
insert into public.product_barcodes (organization_id, product_id, barcode) values
  ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', '7790895000010'),
  ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000002', '7791111111111'),
  ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000003', '7792222222222');
-- Coca + Inactivo are carried by Central; Agua exists but is NOT enabled in Central; Vacío everywhere.
insert into public.branch_product_assortment (organization_id, branch_id, product_id) values
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000003'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000004'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a6000000-0000-4000-8000-000000000004');
-- Existing products Central does not carry: Jugo (active, priced), Inactivo fuera (inactive, priced), Producto sin precio (active, no price).
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('a6000000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'Inactivo fuera', 'inactivo-fuera', 'INACT-2', 'UNIT', false),
  ('a6000000-0000-4000-8000-000000000006', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'Producto sin precio', 'producto-sin-precio', 'SINP-1', 'UNIT', true),
  ('a6000000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'Jugo 1 L', 'jugo-1l', 'JUGO-1', 'UNIT', true);
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000005', null, 100000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000007', null, 250000, now() - interval '1 day');
insert into public.product_barcodes (organization_id, product_id, barcode) values
  ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000005', '7793333333333'),
  ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000006', '7794444444444'),
  ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000007', '7795000000001');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Device capabilities: only the POS of Central (the production branch) can create
-- ---------------------------------------------------------------------------------------------
select is(public.get_pos_device_capabilities('a4000000-0000-4000-8000-000000000001') ->> 'quickProductCreate', 'true', 'the Central device may create products from a scan');
select throws_ok($$select public.get_pos_device_capabilities('a4000000-0000-4000-8000-0000000000ff')$$, '42501', null, 'an unknown device is rejected');
select throws_ok($$select public.get_pos_device_capabilities('a4000000-0000-4000-8000-000000000002')$$, '42501', null, 'a device of a branch the account is not a member of is rejected');

-- The device account itself is NOT elevated: it still cannot use the Admin write RPCs.
select throws_ok(
  $$select public.save_product(null, 'a5000000-0000-4000-8000-000000000001', 'Hack', 'hack', null, 'UNIT', true)$$,
  '42501', null, 'the device account has no products.write: save_product stays closed'
);

-- ---------------------------------------------------------------------------------------------
-- C — unknown barcode, name + cost + price
-- ---------------------------------------------------------------------------------------------
select is(
  public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), ' 7799999999999 ', '  Galletitas X ', 120000, 80000) ->> 'status',
  'CREATED', 'an unknown barcode creates the product'
);
reset role;
select is((select count(*) from public.products where name = 'Galletitas X'), 1::bigint, 'exactly one product was created');
select is((select unit_type::text from public.products where name = 'Galletitas X'), 'UNIT', 'sold by UNIT');
select ok((select active from public.products where name = 'Galletitas X'), 'active');
select is((select inventory_role::text from public.products where name = 'Galletitas X'), 'SELLABLE', 'a sellable product (not a raw material)');
select is((select sku from public.products where name = 'Galletitas X'), null, 'no SKU is required');
select is((select category_id from public.products where name = 'Galletitas X'), 'a5000000-0000-4000-8000-000000000001'::uuid, 'category = the real Almacen category, by id');
select is(
  (select array_agg(category_id) from public.product_category_assignments where product_id = (select id from public.products where name = 'Galletitas X')),
  array['a5000000-0000-4000-8000-000000000001']::uuid[], 'assigned to Almacen only'
);
select is(
  (select barcode from public.product_barcodes where product_id = (select id from public.products where name = 'Galletitas X')),
  '7799999999999', 'the scanned barcode is stored normalized'
);
select is(
  (select array_agg(branch_id) from public.branch_product_assortment where product_id = (select id from public.products where name = 'Galletitas X')),
  array['a3000000-0000-4000-8000-000000000001']::uuid[], 'enabled in CENTRAL only (not Avenida)'
);
select is(
  (select price_cents from public.product_prices where product_id = (select id from public.products where name = 'Galletitas X') and valid_to is null and branch_id is null),
  120000::bigint, 'current price saved'
);
select is(
  (select cost_cents from public.product_costs where product_id = (select id from public.products where name = 'Galletitas X') and valid_to is null),
  80000::bigint, 'current cost saved'
);
select is(
  (select created_by from public.product_prices where product_id = (select id from public.products where name = 'Galletitas X')),
  'a1000000-0000-4000-8000-000000000003'::uuid, 'the price is attributed to the operator, not the device account'
);
select is((select count(*) from public.stock_movements where product_id = (select id from public.products where name = 'Galletitas X')), 0::bigint, 'no stock movement and no fake restock: registered stock is 0');
select ok(
  exists(select 1 from public.audit_logs where event_type = 'POS_QUICK_PRODUCT_CREATED' and (after_data ->> 'operatorProfileId') = 'a1000000-0000-4000-8000-000000000003' and (after_data ->> 'barcode') = '7799999999999'),
  'the creation is audited with the operator and the barcode'
);

-- The Central POS learns the product through the normal incremental pull; Avenida never does.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(
  (select e -> 'barcodes' from jsonb_array_elements(public.pull_pos_state('a4000000-0000-4000-8000-000000000001', 0) -> 'catalog') e where e ->> 'productName' = 'Galletitas X'),
  '["7799999999999"]'::jsonb, 'Central pull carries the new product with its barcode'
);
select is(
  (select e ->> 'pricePerKgCents' from jsonb_array_elements(public.pull_pos_state('a4000000-0000-4000-8000-000000000001', 0) -> 'catalog') e where e ->> 'productName' = 'Galletitas X'),
  '120000', 'Central pull carries the price'
);
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(
  (select count(*) from jsonb_array_elements(public.pull_pos_state('a4000000-0000-4000-8000-000000000002', 0) -> 'catalog') e where e ->> 'productName' = 'Galletitas X'),
  0::bigint, 'G: the Avenida catalog is not contaminated'
);
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- D — empty cost; same name twice gets distinct slugs
-- ---------------------------------------------------------------------------------------------
select is(
  public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7798888888888', 'Galletitas X', 99900, null) ->> 'status',
  'CREATED', 'D: an empty cost still creates the product (and a repeated name is fine)'
);
reset role;
select is((select count(*) from public.product_costs where product_id = (select product_id from public.product_barcodes where barcode = '7798888888888')), 0::bigint, 'no cost row when none was informed');
select is((select count(distinct slug) from public.products where name = 'Galletitas X'), 2::bigint, 'slugs stay unique across same-name products');
select is(
  (select count(*) from public.product_prices where product_id = (select product_id from public.product_barcodes where barcode = '7798888888888') and price_cents = 99900),
  1::bigint, 'price saved without cost'
);

-- ---------------------------------------------------------------------------------------------
-- E — barcode already in the organization: never a second product
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(
  public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7790895000010', 'Coca duplicada', 500000, null) ->> 'status',
  'EXISTS_SELLABLE', 'E: a barcode of a sellable Central product resolves to it'
);
select is(
  public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7790895000010', 'Coca duplicada', 500000, null) -> 'product' ->> 'productName',
  'Coca Cola 2.25 L', 'the existing product is returned, with its catalog row'
);
select is(
  public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7799999999999', 'Reintento', 777700, null) ->> 'status',
  'EXISTS_SELLABLE', 'a retry of an already created barcode is idempotent (no second product)'
);
select is(
  public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7791111111111', 'Agua otra vez', 100000, null) ->> 'status',
  'EXISTS_ENABLED', 'an active, priced product that Central did not carry is enabled in Central and returned (no duplicate)'
);
select is(
  public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7791111111111', 'Agua otra vez', 100000, null) ->> 'status',
  'EXISTS_SELLABLE', 'asking again is idempotent: it is already sellable in Central'
);
select is(
  public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7792222222222', 'Inactivo otra vez', 100000, null) ->> 'status',
  'EXISTS_UNSELLABLE', 'an inactive existing product is reported as not sellable'
);
reset role;
select is((select count(*) from public.products where name in ('Coca duplicada', 'Reintento', 'Agua otra vez', 'Inactivo otra vez')), 0::bigint, 'none of those calls created a product');
select is((select count(*) from public.product_barcodes where barcode = '7799999999999'), 1::bigint, 'the barcode still resolves to exactly one product');
select is(
  (select price_cents from public.product_prices where product_id = (select product_id from public.product_barcodes where barcode = '7799999999999') and valid_to is null),
  120000::bigint, 'the retry did not overwrite the price'
);
select is(
  (select array_agg(branch_id) from public.branch_product_assortment where product_id = 'a6000000-0000-4000-8000-000000000002'),
  array['a3000000-0000-4000-8000-000000000001']::uuid[], 'the existing product is now enabled in CENTRAL only (Avenida untouched)'
);
select ok(
  exists(select 1 from public.audit_logs where event_type = 'POS_QUICK_PRODUCT_ENABLED' and entity_id = 'a6000000-0000-4000-8000-000000000002' and (after_data ->> 'operatorProfileId') = 'a1000000-0000-4000-8000-000000000003'),
  'the enabling is audited with the operator'
);
select is((select active from public.products where id = 'a6000000-0000-4000-8000-000000000003'), false, 'an inactive product is NOT reactivated');
select is((select count(*) from public.branch_product_assortment where product_id = 'a6000000-0000-4000-8000-000000000005'), 0::bigint, 'an inactive product that Central did not carry is NOT enabled');
select is((select active from public.products where id = 'a6000000-0000-4000-8000-000000000005'), false, 'and stays inactive');

-- ---------------------------------------------------------------------------------------------
-- Scan step 1 (online): resolve_pos_scan_barcode never opens the "new product" path for an existing code
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7795000000001') ->> 'status', 'EXISTS_ENABLED', 'scan of an existing active product outside Central''s assortment: enabled and returned');
select is(public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), ' 7795000000001 ') -> 'product' ->> 'productName', 'Jugo 1 L', 'the product row comes back ready for the ticket');
select is(public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7795000000001') ->> 'status', 'EXISTS_SELLABLE', 'a second resolve is just sellable (no re-enabling)');
select is(public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7790895000010') ->> 'status', 'EXISTS_SELLABLE', 'a product already in Central stays sellable');
select is(public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7793333333333') ->> 'status', 'EXISTS_UNSELLABLE', 'inactive product: reported, not reactivated, not enabled');
select is(public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7794444444444') ->> 'status', 'EXISTS_UNSELLABLE', 'active product without a price: reported, not enabled');
select is(public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7790000000000') ->> 'status', 'NOT_FOUND', 'a truly unknown code is NOT_FOUND (only then does the POS open the new-product modal)');
select throws_ok($$select public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('0', 64), '7795000000001')$$, '42501', null, 'resolve rejects a wrong operator token');
select throws_ok($$select public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000005', repeat('b', 64), '7790000000000')$$, '42501', null, 'resolve rejects an operator without products.quick_create');
select throws_ok($$select public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), 'x')$$, '22023', null, 'resolve rejects an invalid barcode');
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.resolve_pos_scan_barcode('a4000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000004', repeat('a', 64), '7795000000001')$$, '42501', null, 'an Avenida device cannot use the scan resolver (and cannot enable anything)');
select is(
  (select count(*) from jsonb_array_elements(public.pull_pos_state('a4000000-0000-4000-8000-000000000002', 0) -> 'catalog') e where e ->> 'productName' in ('Agua 500 cc', 'Jugo 1 L')),
  0::bigint, 'the Avenida catalog still has none of the products enabled in Central'
);
reset role;
select is((select array_agg(branch_id) from public.branch_product_assortment where product_id = 'a6000000-0000-4000-8000-000000000007'), array['a3000000-0000-4000-8000-000000000001']::uuid[], 'Jugo is enabled in Central only');
select is((select count(*) from public.branch_product_assortment where product_id in ('a6000000-0000-4000-8000-000000000006')), 0::bigint, 'the product without a price was not enabled');
select is((select count(*) from public.branch_product_assortment where product_id = 'a6000000-0000-4000-8000-000000000005'), 0::bigint, 'after the resolve: the inactive product is still NOT enabled');
select is((select active from public.products where id = 'a6000000-0000-4000-8000-000000000005'), false, 'after the resolve: the inactive product is still inactive (never reactivated)');
select is((select count(*) from public.products where organization_id = 'a2000000-0000-4000-8000-000000000001' and name = 'Jugo 1 L'), 1::bigint, 'no duplicate Jugo');
select is((select count(*) from public.products where name in ('Coca duplicada', 'Reintento', 'Agua otra vez', 'Inactivo otra vez')), 0::bigint, 'still no duplicates after the resolve calls');
select throws_ok(
  $$insert into public.product_barcodes (organization_id, product_id, barcode) values ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000004', '7799999999999')$$,
  '23505', null, 'the unique constraint stays the last guarantee against duplicate barcodes'
);

-- ---------------------------------------------------------------------------------------------
-- Authorization: device + operator + permission + Central
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000004', repeat('a', 64), '7797777777777', 'Desde Avenida', 100000, null)$$,
  '42501', null, 'G: an Avenida device cannot create products (it is not Central)'
);
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('0', 64), '7797777777777', 'Token malo', 100000, null)$$,
  '42501', null, 'a wrong operator token is rejected'
);
select throws_ok(
  $$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'short', '7797777777777', 'Token corto', 100000, null)$$,
  '42501', null, 'a malformed operator token is rejected'
);
select throws_ok(
  $$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000004', repeat('a', 64), '7797777777777', 'Token ajeno', 100000, null)$$,
  '42501', null, 'the token of an Avenida operator does not work on the Central device'
);
select throws_ok(
  $$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000005', repeat('b', 64), '7797777777777', 'Sin permiso', 100000, null)$$,
  '42501', null, 'an operator whose role lacks products.quick_create cannot create'
);
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000009', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7797777777777', 'Otra org', 100000, null)$$,
  '42501', null, 'an account of another organization cannot use the device/operator'
);
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Input validation (nothing is created)
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7797777777777', '   ', 100000, null)$$, '22023', null, 'a blank name is rejected');
select throws_ok($$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7797777777777', 'Sin precio', 0, null)$$, '22023', null, 'a zero price is rejected');
select throws_ok($$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7797777777777', 'Sin precio', null, null)$$, '22023', null, 'a missing price is rejected');
select throws_ok($$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7797777777777', 'Costo cero', 100000, 0)$$, '22023', null, 'a zero cost is rejected (omit it instead)');
select throws_ok($$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), 'x', 'Barcode corto', 100000, null)$$, '22023', null, 'an invalid barcode is rejected');
select throws_ok($$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), null, 'Sin barcode', 100000, null)$$, '22023', null, 'a missing barcode is rejected');
reset role;
select is((select count(*) from public.products where name in ('Sin precio', 'Costo cero', 'Barcode corto', 'Sin barcode', 'Desde Avenida', 'Token malo', 'Token corto', 'Token ajeno', 'Sin permiso', 'Otra org')), 0::bigint, 'no rejected call left a product behind');

-- ---------------------------------------------------------------------------------------------
-- Atomicity: a failure in the LAST step (cost) leaves no half-created product
-- ---------------------------------------------------------------------------------------------
create function pg_temp.fail_cost() returns trigger language plpgsql as $$ begin raise exception 'boom cost' using errcode = 'XX001'; end; $$;
create trigger fail_cost before insert on public.product_costs for each row execute function pg_temp.fail_cost();
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7796666666666', 'A medias', 100000, 5000)$$,
  'XX001', null, 'a failing cost insert aborts the whole creation'
);
reset role;
drop trigger fail_cost on public.product_costs;
select is((select count(*) from public.products where name = 'A medias'), 0::bigint, 'no product left behind');
select is((select count(*) from public.product_barcodes where barcode = '7796666666666'), 0::bigint, 'no barcode left behind');

-- ---------------------------------------------------------------------------------------------
-- Almacen category missing/inactive: a controlled error, never a duplicate category
-- ---------------------------------------------------------------------------------------------
update public.categories set active = false where id = 'a5000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_pos_quick_product('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', repeat('f', 64), '7795555555555', 'Sin categoria', 100000, null)$$,
  '22023', null, 'without an active Almacen category the call fails clearly'
);
reset role;
select is((select count(*) from public.categories where organization_id = 'a2000000-0000-4000-8000-000000000001' and name = 'Almacen'), 1::bigint, 'no duplicate Almacen category was created');
select is((select count(*) from public.products where name = 'Sin categoria'), 0::bigint, 'and no product');

select * from finish();
rollback;
