begin;

create extension if not exists pgtap with schema extensions;
select plan(96);

-- ---------------------------------------------------------------------------------------------
-- Shape and hardening
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'branch_product_assortment', 'branch_product_assortment exists');
select ok((select relrowsecurity from pg_class where oid = 'public.branch_product_assortment'::regclass), 'assortment has RLS');
select ok(not has_table_privilege('authenticated', 'public.branch_product_assortment', 'INSERT'), 'browser clients cannot write the assortment directly');
select ok(not has_function_privilege('anon', 'public.set_product_branches(uuid,uuid[])', 'EXECUTE'), 'anonymous cannot change the assortment');
select ok(not has_function_privilege('anon', 'public.search_products(text,uuid,integer,boolean)', 'EXECUTE'), 'anonymous cannot search products');

-- ---------------------------------------------------------------------------------------------
-- Fixture: org A with Central (carniceria + almacen) and two butcher shops; org B for isolation
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'assort-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Assort Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'assort-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Assort Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'assort-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Assort Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('92000000-0000-4000-8000-000000000001', 'Assort Org A', 'assort-org-a'),
  ('92000000-0000-4000-8000-000000000002', 'Assort Org B', 'assort-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('93000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('93000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA'),
  ('93000000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000001', 'Janssen', 'JANSSEN'),
  ('93000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000002', 'Org B Branch', 'ASB');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('94000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'Carnes', 'carnes'),
  ('94000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', 'Bebidas', 'bebidas'),
  ('94000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000002', 'Org B Cat', 'org-b-cat');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('95000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'Vacío', 'vacio', 'VAC-1', 'WEIGHT'),
  ('95000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000002', 'Coca Cola 2.25 L', 'coca-cola', 'COCA-225', 'UNIT'),
  ('95000000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000002', 'Agua 500 cc', 'agua-500', 'AGUA-5', 'UNIT'),
  ('95000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000002', '94000000-0000-4000-8000-000000000009', 'Org B Product', 'org-b-product', 'ORGB-1', 'WEIGHT');
insert into public.product_category_assignments (organization_id, product_id, category_id)
select organization_id, id, category_id from public.products where organization_id = '92000000-0000-4000-8000-000000000001';
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000001', null, 1200000, now() - interval '1 day'),
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002', null, 450000, now() - interval '1 day'),
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000003', null, 120000, now() - interval '1 day');
insert into public.product_barcodes (organization_id, product_id, barcode) values
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002', '7790895000010');

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Defining the assortment (Admin): Vacío in all three branches, Coca Cola only in Central
-- ---------------------------------------------------------------------------------------------
select is(
  jsonb_array_length(public.set_product_branches('95000000-0000-4000-8000-000000000001', array['93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000003']::uuid[]) -> 'enabled'),
  3, 'Vacío is enabled in Central, Avenida and Janssen'
);
select is((select count(*) from public.branch_product_assortment where product_id = '95000000-0000-4000-8000-000000000001'), 3::bigint, 'Vacío is carried by the three branches');
select is(
  jsonb_array_length(public.set_product_branches('95000000-0000-4000-8000-000000000002', array['93000000-0000-4000-8000-000000000001']::uuid[]) -> 'enabled'),
  1, 'Coca Cola is enabled only in Central'
);
select is(
  public.set_product_branches('95000000-0000-4000-8000-000000000002', array['93000000-0000-4000-8000-000000000001']::uuid[]),
  '{"enabled":[],"disabled":[],"disabledWithStock":[]}'::jsonb,
  'set_product_branches is idempotent: the same set changes nothing'
);
select throws_ok(
  $$select public.set_product_branches('95000000-0000-4000-8000-000000000002', array['93000000-0000-4000-8000-000000000009']::uuid[])$$,
  '22023', null, 'a branch of another organization is rejected'
);
select throws_ok(
  $$select public.set_product_branches('95000000-0000-4000-8000-000000000009', array['93000000-0000-4000-8000-000000000001']::uuid[])$$,
  '42501', null, 'a product of another organization is not found'
);

-- ---------------------------------------------------------------------------------------------
-- The POS catalog of each device honours the assortment (and carries barcodes)
-- ---------------------------------------------------------------------------------------------
select is(
  (select jsonb_array_length(public.register_pos_device('96000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'Central POS') -> 'catalog')),
  2, 'Central device receives Vacío and Coca Cola'
);
select is(
  (select jsonb_array_length(public.register_pos_device('96000000-0000-4000-8000-000000000002', '93000000-0000-4000-8000-000000000002', 'Avenida POS') -> 'catalog')),
  1, 'Avenida device receives ONLY Vacío'
);
select is(
  (select jsonb_array_length(public.register_pos_device('96000000-0000-4000-8000-000000000003', '93000000-0000-4000-8000-000000000003', 'Janssen POS') -> 'catalog')),
  1, 'Janssen device receives ONLY Vacío'
);
select is(
  (select e ->> 'productName' from jsonb_array_elements(public.pull_pos_state('96000000-0000-4000-8000-000000000002', 0) -> 'catalog') e),
  'Vacío', 'the only product Avenida sells is the butcher one'
);
select is(
  (select e -> 'barcodes' from jsonb_array_elements(public.pull_pos_state('96000000-0000-4000-8000-000000000001', 0) -> 'catalog') e where e ->> 'productName' = 'Coca Cola 2.25 L'),
  '["7790895000010"]'::jsonb, 'Central receives the barcodes of Coca Cola in the catalog (offline scan source)'
);
select is(
  (select e -> 'barcodes' from jsonb_array_elements(public.pull_pos_state('96000000-0000-4000-8000-000000000001', 0) -> 'catalog') e where e ->> 'productName' = 'Vacío'),
  '[]'::jsonb, 'a butcher product simply has no barcodes'
);
select is(
  (select jsonb_agg(c ->> 'name' order by c ->> 'name') from jsonb_array_elements(public.pull_pos_state('96000000-0000-4000-8000-000000000002', 0) -> 'categories') c),
  '["Carnes"]'::jsonb, 'Avenida gets no "Bebidas" tab (no drink is enabled there)'
);
select is(
  (select jsonb_agg(c ->> 'name' order by c ->> 'name') from jsonb_array_elements(public.pull_pos_state('96000000-0000-4000-8000-000000000001', 0) -> 'categories') c),
  '["Bebidas","Carnes"]'::jsonb, 'Central gets both tabs'
);
select is(
  (select count(*) from public.get_pos_catalog('93000000-0000-4000-8000-000000000002')), 1::bigint,
  'the browser/online catalog RPC honours the assortment too'
);
select is(
  (select barcodes from public.get_pos_catalog('93000000-0000-4000-8000-000000000001') where product_name = 'Coca Cola 2.25 L'),
  array['7790895000010'], 'the online catalog carries barcodes'
);

-- Surtido is NOT stock: a product with zero stock (no ledger rows at all) is still in the catalog.
select is(
  (select count(*) from public.stock_movements where product_id = '95000000-0000-4000-8000-000000000002'), 0::bigint,
  'Coca Cola has no stock movements at all...'
);
select is(
  (select count(*) from jsonb_array_elements(public.pull_pos_state('96000000-0000-4000-8000-000000000001', 0) -> 'catalog') e where e ->> 'productName' = 'Coca Cola 2.25 L'),
  1::bigint, '...and it is still delivered to Central: an enabled product with stock 0 keeps existing (POS shows "Sin stock")'
);

-- ---------------------------------------------------------------------------------------------
-- Incremental sync: enabling / disabling / barcode edits travel through the existing cursor
-- ---------------------------------------------------------------------------------------------
create temporary table cursors (device text primary key, cursor bigint not null) on commit drop;
grant all on cursors to authenticated;
insert into cursors select 'central', (public.pull_pos_state('96000000-0000-4000-8000-000000000001', 0) ->> 'cursor')::bigint;
insert into cursors select 'avenida', (public.pull_pos_state('96000000-0000-4000-8000-000000000002', 0) ->> 'cursor')::bigint;

select lives_ok($$select public.set_product_branches('95000000-0000-4000-8000-000000000001', array['93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000003']::uuid[])$$, 'Vacío stops being carried by Avenida');
select is(
  public.pull_pos_state('96000000-0000-4000-8000-000000000002', (select cursor from cursors where device = 'avenida')) -> 'removedProductIds',
  '["95000000-0000-4000-8000-000000000001"]'::jsonb, 'Avenida is told to drop Vacío (removedProductIds)'
);
select is(
  jsonb_array_length(public.pull_pos_state('96000000-0000-4000-8000-000000000001', (select cursor from cursors where device = 'central')) -> 'removedProductIds'),
  0, 'Central is not told to drop anything'
);
select lives_ok($$select public.set_product_branches('95000000-0000-4000-8000-000000000002', array['93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000002']::uuid[])$$, 'Coca Cola is enabled in Avenida too');
select is(
  (select e ->> 'productName' from jsonb_array_elements(public.pull_pos_state('96000000-0000-4000-8000-000000000002', (select cursor from cursors where device = 'avenida')) -> 'catalog') e),
  'Coca Cola 2.25 L', 'Avenida now receives Coca Cola incrementally'
);
select lives_ok($$select public.set_product_barcodes('95000000-0000-4000-8000-000000000002', array['7790895000010','7790895000027'])$$, 'a second barcode is added');
select is(
  (select e -> 'barcodes' from jsonb_array_elements(public.pull_pos_state('96000000-0000-4000-8000-000000000001', (select cursor from cursors where device = 'central')) -> 'catalog') e where e ->> 'productName' = 'Coca Cola 2.25 L'),
  '["7790895000010","7790895000027"]'::jsonb, 'Central receives the updated barcode set incrementally'
);
select lives_ok($$select public.set_product_branches('95000000-0000-4000-8000-000000000001', array['93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000003']::uuid[])$$, 'Vacío is carried by Avenida again');
select lives_ok($$select public.set_product_branches('95000000-0000-4000-8000-000000000002', array['93000000-0000-4000-8000-000000000001']::uuid[])$$, 'Coca Cola goes back to Central only');

-- ---------------------------------------------------------------------------------------------
-- Stock of UNIT products in Admin (same ledger, whole units)
-- ---------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.get_branch_stock_status('93000000-0000-4000-8000-000000000002') where product_name = 'Coca Cola 2.25 L'),
  0::bigint, 'Avenida stock status does not list a product Avenida does not carry'
);
select is(
  (select stock_status || '/' || unit_type::text from public.get_branch_stock_status('93000000-0000-4000-8000-000000000001') where product_name = 'Coca Cola 2.25 L'),
  'OUT_OF_STOCK/UNIT', 'Central lists Coca Cola (UNIT) as sold out before any stock'
);
select lives_ok($$select public.record_stock_operation('93000000-0000-4000-8000-000000000001', 'PURCHASE', '[{"product_id":"95000000-0000-4000-8000-000000000002","quantity_grams":24}]'::jsonb, 'Distribuidor', null, 'compra de prueba')$$, 'a purchase of 24 units is recorded');
select is(
  (select current_stock_grams from public.get_branch_stock_status('93000000-0000-4000-8000-000000000001') where product_name = 'Coca Cola 2.25 L'),
  24::bigint, 'Central has 24 units (the ledger figure IS the unit count)'
);
select lives_ok($$select public.record_stock_operation('93000000-0000-4000-8000-000000000001', 'WASTE', '[{"product_id":"95000000-0000-4000-8000-000000000002","quantity_grams":2}]'::jsonb, null, 'DISCARD', 'botella rota')$$, 'a waste of 2 units is recorded');
select lives_ok($$select public.record_stock_operation('93000000-0000-4000-8000-000000000001', 'ADJUSTMENT', '[{"product_id":"95000000-0000-4000-8000-000000000002","physical_quantity_grams":20}]'::jsonb, null, null, 'conteo físico')$$, 'a physical count of 20 units is recorded');
select is(
  (select current_stock_grams from public.get_branch_stock_status('93000000-0000-4000-8000-000000000001') where product_name = 'Coca Cola 2.25 L'),
  20::bigint, 'the adjustment brought Central to 20 units (24 - 2 waste, then counted 20 -> -2 adjustment)'
);
select is(
  (select jsonb_build_object('out', out_of_stock_count, 'products', product_count) from public.get_branch_stock_summary() where branch_name = 'Avenida'),
  '{"out":1,"products":1}'::jsonb, 'Avenida summary: one carried product (Vacío), sold out'
);
select is(
  (select product_count from public.get_branch_stock_summary() where branch_name = 'Central'), 2::bigint,
  'Central summary counts Vacío and Coca Cola'
);
select is(
  (select count(*) from public.get_branch_stock_status(null, 'coca'))::int, 1, 'stock status search is accent/case-insensitive'
);
select is(
  (select count(*) from public.get_branch_stock_status(null, null, 'OUT_OF_STOCK')), 3::bigint, 'status filter: Vacío is sold out in the three branches'
);
select is(
  (select total_count from public.get_branch_stock_status(null, null, null, 1, 0) limit 1), 4::bigint, 'pagination reports the total (4 carried product/branch pairs) with one row per page'
);
select throws_ok($$select * from public.get_branch_stock_status(null, null, 'NOPE')$$, '22023', null, 'an unknown status filter is rejected');

-- ---------------------------------------------------------------------------------------------
-- Replenishment only considers carried products
-- ---------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.get_replenishment_plan() where branch_name = 'Avenida' and product_name = 'Coca Cola 2.25 L'),
  0::bigint, 'replenishment does not suggest Coca Cola for Avenida'
);
select is(
  (select unit_type::text from public.get_replenishment_plan() where branch_name = 'Central' and product_name = 'Coca Cola 2.25 L'),
  'UNIT', 'replenishment lists it for Central as a UNIT product'
);

-- ---------------------------------------------------------------------------------------------
-- Transfers: WEIGHT and UNIT, destination must carry the product
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.create_stock_transfer('93000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000002', '[{"product_id":"95000000-0000-4000-8000-000000000002","quantity_grams":6}]'::jsonb, null)$$,
  '22023', null, 'stock cannot be sent where the product is not carried (Coca Cola -> Avenida)'
);
select is(
  (select count(*) from public.stock_movements where type = 'TRANSFER_IN' and product_id = '95000000-0000-4000-8000-000000000002'), 0::bigint,
  'the rejected transfer wrote nothing'
);
select lives_ok($$select public.set_product_branches('95000000-0000-4000-8000-000000000002', array['93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000002']::uuid[])$$, 'Coca Cola is enabled in Avenida');
select lives_ok($$select public.record_stock_operation('93000000-0000-4000-8000-000000000001', 'PURCHASE', '[{"product_id":"95000000-0000-4000-8000-000000000001","quantity_grams":10000}]'::jsonb, null, null, 'vacio')$$, 'Central receives 10 kg of Vacío');
select lives_ok($$select public.create_stock_transfer('93000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000002', '[{"product_id":"95000000-0000-4000-8000-000000000002","quantity_grams":6},{"product_id":"95000000-0000-4000-8000-000000000001","quantity_grams":4000}]'::jsonb, 'mixto')$$, 'a mixed transfer (6 units + 4 kg) succeeds');
select is(
  (select jsonb_build_object('w', total_weight_grams, 'u', total_units, 'n', item_count) from public.stock_transfers where notes = 'mixto'),
  '{"w":4000,"u":6,"n":2}'::jsonb, 'kg and units are totalled separately, never added together'
);
select is(
  (select jsonb_build_object('c', (select quantity_grams from public.stock_levels where branch_id = '93000000-0000-4000-8000-000000000001' and product_id = '95000000-0000-4000-8000-000000000002'),
                             'a', (select quantity_grams from public.stock_levels where branch_id = '93000000-0000-4000-8000-000000000002' and product_id = '95000000-0000-4000-8000-000000000002'))),
  '{"c":14,"a":6}'::jsonb, 'units moved exactly: Central 20 -> 14, Avenida 0 -> 6 (global stock conserved)'
);
select is(
  (select jsonb_agg(i ->> 'unitType' order by i ->> 'productName') from jsonb_array_elements((public.list_stock_transfers(null, 10) -> 0) -> 'items') i),
  '["UNIT","WEIGHT"]'::jsonb, 'the listing exposes each item unit type'
);
select throws_ok(
  $$select public.create_stock_transfer('93000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000002', '[{"product_id":"95000000-0000-4000-8000-000000000002","quantity_grams":1000}]'::jsonb, null)$$,
  '22023', null, 'a UNIT transfer still needs stock at the origin (14 available, 1000 asked)'
);

-- ---------------------------------------------------------------------------------------------
-- Importer with a destination branch: products only in Central, OPENING_BALANCE only in Central
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.create_import_batch('simplygest', 'product', 'p-none')$$, '42501', null, 'a product batch without a destination branch is rejected');
select throws_ok($$select public.create_import_batch('simplygest', 'category', 'c-br', null, '93000000-0000-4000-8000-000000000001')$$, '22023', null, 'categories are organization-wide: no branch allowed');
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'p-central', null, '93000000-0000-4000-8000-000000000001', '{"defaultCategoryId":"94000000-0000-4000-8000-000000000002"}'::jsonb)$$, 'product batch with destinationBranch = Central');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'p-central'),
  $j$[
    {"rowNumber":1,"externalId":"SG-1","payload":{"name":"Sprite 2.25 L","unitType":"UNIT","sku":"SPR-225","barcodes":["7790895000089"],"priceCents":430000}},
    {"rowNumber":2,"externalId":"SG-2","payload":{"name":"Fideos 500 g","unitType":"UNIT","sku":"FID-500","barcodes":["7791234567001"],"priceCents":180000}}
  ]$j$::jsonb)$t$, 'two warehouse products staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'p-central'))$$, 'previewed');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'p-central')) -> 'result' ->> 'created', '2', 'two products created');
select is(
  (select jsonb_agg(b.name order by b.name) from public.branch_product_assortment a join public.branches b on b.id = a.branch_id join public.products p on p.id = a.product_id where p.sku = 'SPR-225'),
  '["Central"]'::jsonb, 'an imported product is enabled ONLY in the destination branch'
);
select is(
  (select count(*) from public.branch_product_assortment a join public.products p on p.id = a.product_id where p.sku in ('SPR-225','FID-500') and a.branch_id <> '93000000-0000-4000-8000-000000000001'), 0::bigint,
  'nothing was enabled in Avenida or Janssen'
);
select is(
  (select jsonb_array_length(public.pull_pos_state('96000000-0000-4000-8000-000000000002', 0) -> 'catalog')), 2,
  'Avenida catalog is unchanged by the import (Vacío + Coca Cola only)'
);

select lives_ok($$select public.create_import_batch('simplygest', 'stock_opening_balance', 's-central', null, '93000000-0000-4000-8000-000000000001')$$, 'stock batch for Central');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 's-central'),
  $j$[
    {"rowNumber":1,"externalId":"SG-1","payload":{"quantityUnits":48}},
    {"rowNumber":2,"externalId":"SG-2","payload":{"quantityUnits":30}}
  ]$j$::jsonb)$t$, 'opening stock staged');
select is((public.preview_import_batch((select id from public.import_batches where file_name = 's-central')) -> 'summary' ->> 'create'), '2', 'both openings classify as CREATE (products are carried by Central)');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 's-central')) -> 'result' ->> 'created', '2', 'opening balances applied');
select is(
  (select jsonb_object_agg(p.sku, sl.quantity_grams) from public.stock_levels sl join public.products p on p.id = sl.product_id where sl.branch_id = '93000000-0000-4000-8000-000000000001' and p.sku in ('SPR-225','FID-500')),
  '{"SPR-225":48,"FID-500":30}'::jsonb, 'the imported stock is in Central'
);
select is(
  (select count(*) from public.stock_movements where type = 'OPENING_BALANCE' and branch_id <> '93000000-0000-4000-8000-000000000001'), 0::bigint,
  'Avenida and Janssen ledgers received no opening balance'
);

-- Opening stock for a branch that does NOT carry the product is an error, not a silent load.
select lives_ok($$select public.create_import_batch('simplygest', 'stock_opening_balance', 's-avenida', null, '93000000-0000-4000-8000-000000000002')$$, 'stock batch aimed at Avenida');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 's-avenida'),
  $j$[{"rowNumber":1,"externalId":"SG-1","payload":{"quantityUnits":5}}]$j$::jsonb)$t$, 'Sprite stock staged for Avenida');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 's-avenida'))$$, 'previewed');
select is(
  (select reason_code from public.import_rows where batch_id = (select id from public.import_batches where file_name = 's-avenida') and row_number = 1),
  'NOT_IN_ASSORTMENT', 'Avenida does not carry Sprite: NOT_IN_ASSORTMENT'
);

-- ---------------------------------------------------------------------------------------------
-- Catalog search / paging for Admin
-- ---------------------------------------------------------------------------------------------
select is((select count(*) from public.search_products('COCA')), 1::bigint, 'search is case-insensitive');
select is((select count(*) from public.search_products('vacio')), 1::bigint, 'search is accent-insensitive (Vacío)');
select is((select product_name from public.search_products('7790895000010')), 'Coca Cola 2.25 L', 'an exact barcode finds the product (scanner into the picker)');
select is((select count(*) from public.search_products(null, '93000000-0000-4000-8000-000000000003')), 1::bigint, 'restricted to Janssen only Vacío is offered');
select is((select count(*) from public.search_products('sprite', '93000000-0000-4000-8000-000000000002')), 0::bigint, 'Sprite is not offered among Avenida products');
select throws_ok($$select * from public.search_products('x', null, 1000)$$, '22023', null, 'the search limit is bounded');
select is((select total_count from public.list_products_page(null, null, 'active', null, 2, 0) limit 1), 5::bigint, 'the listing reports the total (5 active products)');
select is((select count(*) from public.list_products_page(null, null, 'active', null, 2, 0)), 2::bigint, 'the listing returns one page');
select is((select count(*) from public.list_products_page(null, null, 'active', '93000000-0000-4000-8000-000000000002')), 2::bigint, 'filtered by "sold in Avenida": Vacío and Coca Cola');
select is((select branch_ids from public.list_products_page('sprite') limit 1), array['93000000-0000-4000-8000-000000000001']::uuid[], 'each row exposes the branches where the product is sold');
select is((select barcodes from public.list_products_page('coca') limit 1), array['7790895000010','7790895000027'], 'each row exposes its barcodes');
select is((select count(*) from public.get_products_unit_type_locks(array['95000000-0000-4000-8000-000000000002','95000000-0000-4000-8000-000000000003']::uuid[])), 1::bigint, 'only the product with ledger history is locked (Coca Cola)');

-- ---------------------------------------------------------------------------------------------
-- Permissions and tenant isolation
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_product_branches('95000000-0000-4000-8000-000000000001', array['93000000-0000-4000-8000-000000000001']::uuid[])$$, '42501', null, 'an employee cannot change the assortment');
select throws_ok($$select public.set_branch_products('93000000-0000-4000-8000-000000000001', array['95000000-0000-4000-8000-000000000001']::uuid[], true)$$, '42501', null, 'an employee cannot bulk-enable products');

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.branch_product_assortment), 0::bigint, 'org B sees no assortment rows of org A');
select is((select count(*) from public.search_products('coca')), 0::bigint, 'org B cannot search org A products');
select throws_ok($$select public.copy_branch_assortment('93000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000002')$$, '42501', null, 'org B cannot copy the assortment of org A branches');

-- Bulk helpers (org A admin)
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.set_branch_products('93000000-0000-4000-8000-000000000003', array['95000000-0000-4000-8000-000000000002','95000000-0000-4000-8000-000000000003']::uuid[], true), 2, 'bulk enable: two products enabled in Janssen');
select is(public.set_branch_products('93000000-0000-4000-8000-000000000003', array['95000000-0000-4000-8000-000000000002','95000000-0000-4000-8000-000000000003']::uuid[], true), 0, 'bulk enable is idempotent');
select is(public.set_branch_products('93000000-0000-4000-8000-000000000003', array['95000000-0000-4000-8000-000000000003']::uuid[], false), 1, 'bulk disable removes the row');
select is(public.copy_branch_assortment('93000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000003'), 2, 'copy adds only what Janssen was missing from Central (Sprite and Fideos)');

select * from finish();
rollback;
