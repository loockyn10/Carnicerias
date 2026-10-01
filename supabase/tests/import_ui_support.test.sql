begin;

create extension if not exists pgtap with schema extensions;
select plan(64);

-- Covers 202609300049 (Admin → Importación de productos): categories created inside the previewed
-- batch, rows the uploader rejected (invalidReason), batch grouping (runId), linking by barcode/SKU
-- (unambiguous vs ambiguous), the stock opening balance as a second batch, and re-running the same
-- file. Fixture: one organization, Central + Avenida, an existing butcher catalog that must stay intact.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ui-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"UI Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ui-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"UI Employee"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values ('f2000000-0000-4000-8000-000000000001', 'UI Org', 'ui-org');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');

insert into public.categories (id, organization_id, name, slug) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Almacen', 'almacen'),
  ('f4000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Cerdo', 'cerdo'),
  ('f4000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'Dup Cat', 'dup-cat'),
  ('f4000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'DUP  cat', 'dup-cat-2');

-- Existing catalog: a butcher product (Avenida only) and two manual warehouse products with codes.
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000002', 'Chorizo carniceria', 'chorizo-carniceria', 'CHOR-1', 'WEIGHT'),
  ('f5000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Quick Alta Central', 'quick-alta-central', null, 'UNIT'),
  ('f5000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Producto A', 'producto-a', 'AAA-1', 'UNIT'),
  ('f5000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Producto B', 'producto-b', 'BBB-1', 'UNIT');
insert into public.product_barcodes (organization_id, product_id, barcode) values
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002', '7790000000099'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000004', 'BBB-2222');
insert into public.branch_product_assortment (organization_id, branch_id, product_id) values
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'f5000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002'),
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000003'),
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000004');
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', null, 1500000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002', null, 200000, now() - interval '1 day');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- New options are validated
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.create_import_batch('simplygest', 'category', null, null, null, '{"createMissingCategories":true}'::jsonb)$$, '22023', null, 'createMissingCategories is only for products');
select throws_ok($$select public.create_import_batch('simplygest', 'product', null, null, 'f3000000-0000-4000-8000-000000000001', '{"createMissingCategories":"yes"}'::jsonb)$$, '22023', null, 'createMissingCategories must be a boolean');
select throws_ok($$select public.create_import_batch('simplygest', 'product', null, null, 'f3000000-0000-4000-8000-000000000001', '{"runId":"not-a-uuid"}'::jsonb)$$, '22023', null, 'runId must be a uuid');
select throws_ok($$select public.create_import_batch('simplygest', 'product', null, null, 'f3000000-0000-4000-8000-000000000001', '{"runId":7}'::jsonb)$$, '22023', null, 'runId must be a string');
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'ui-1', repeat('b', 64), 'f3000000-0000-4000-8000-000000000001',
  '{"createMissingCategories":true,"runId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","defaultCategoryId":"f4000000-0000-4000-8000-000000000001","linkExistingBy":["barcode","sku"]}'::jsonb)$$,
  'a product batch with the new options is created');

-- ---------------------------------------------------------------------------------------------
-- Preview: new categories, default category, rejected rows, category errors
-- ---------------------------------------------------------------------------------------------
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'ui-1'),
  $j$[
    {"rowNumber":2,"externalId":"U1","payload":{"name":"Coca Cola 2.25 L","unitType":"UNIT","sku":"CODE1","barcodes":["7790000000011"],"categoryName":"Bebidas","priceCents":450000,"costCents":300000}},
    {"rowNumber":3,"externalId":"U2","payload":{"name":"Sprite 2.25 L","unitType":"UNIT","sku":"CODE2","categoryName":"BEBIDAS","priceCents":440000}},
    {"rowNumber":4,"externalId":"U3","payload":{"name":"Fideos","unitType":"UNIT","sku":"CODE3","priceCents":100000}},
    {"rowNumber":5,"externalId":"U4","payload":{"name":"Costilla de almacen","unitType":"UNIT","sku":"CODE4","categoryName":"CERDO","priceCents":800000}},
    {"rowNumber":6,"externalId":"INVALID:6","payload":{"name":"Sin precio","unitType":"UNIT","invalidReason":"Falta el precio de venta"},"raw":{"CODIGO":"X","PRECIO":""}},
    {"rowNumber":7,"externalId":"U6","payload":{"name":"Categoria ambigua","unitType":"UNIT","sku":"CODE6","categoryName":"Dup Cat","priceCents":1000}},
    {"rowNumber":8,"externalId":"U7","payload":{"name":"Categoria larga","unitType":"UNIT","sku":"CODE7","categoryName":"CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X","priceCents":1000}},
    {"rowNumber":9,"externalId":"U8","payload":{"name":"Sal fina","unitType":"UNIT","sku":"CODE8","categoryName":"Almacén","priceCents":50000}}
  ]$j$::jsonb)$t$, 'eight rows (one pre-rejected) are staged');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'ui-1')) -> 'summary') - 'errors' - 'byReason',
  '{"totalRows":8,"pending":0,"create":5,"update":0,"ignore":0,"error":3}'::jsonb,
  'preview: 8 rows → 5 new (a new category is NOT an error), 3 errors'
);
select is(
  (select jsonb_object_agg(row_number::text, reason_code) from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'ui-1') and action = 'ERROR'),
  '{"6":"INVALID_ROW","7":"CATEGORY_AMBIGUOUS","8":"INVALID_CATEGORY"}'::jsonb,
  'preview: rejected row, ambiguous category and too-long category each get their own reason'
);
select is(
  (select message from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'ui-1') and row_number = 6),
  'Falta el precio de venta', 'a rejected row shows the uploader''s own cause'
);
select is((select count(*) from public.categories where organization_id = 'f2000000-0000-4000-8000-000000000001'), 4::bigint, 'preview created no category');
select is((select count(*) from public.products where organization_id = 'f2000000-0000-4000-8000-000000000001'), 4::bigint, 'preview created no product');
select is(
  (select options ->> 'runId' from public.import_batches where file_name = 'ui-1'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'the batch keeps its runId for the history screen'
);

-- ---------------------------------------------------------------------------------------------
-- Apply
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.apply_import_batch((select id from public.import_batches where file_name = 'ui-1'))$$, '22023', null, 'apply refuses while rows have errors');
select is(
  public.apply_import_batch((select id from public.import_batches where file_name = 'ui-1'), true) -> 'result',
  '{"created":5,"updated":0,"ignored":0,"skippedErrors":3}'::jsonb,
  'apply with skip_errors creates the 5 valid products'
);
select is((select count(*) from public.categories where organization_id = 'f2000000-0000-4000-8000-000000000001'), 5::bigint, 'exactly one category was created (Bebidas), not one per row');
select is(
  (select count(*) from public.categories where organization_id = 'f2000000-0000-4000-8000-000000000001' and app_private.import_normalize_text(name) = 'bebidas'),
  1::bigint, 'Bebidas and BEBIDAS share one category'
);
select is(
  (select count(distinct p.category_id) from public.products p join public.external_entity_links l on l.internal_id = p.id and l.entity_type = 'product' and l.external_id in ('U1', 'U2')),
  1::bigint, 'both beverages point at the new category'
);
select is(
  (select c.name from public.products p join public.categories c on c.id = p.category_id join public.external_entity_links l on l.internal_id = p.id and l.external_id = 'U3'),
  'Almacen', 'a row without category falls back to the default category (Almacen)'
);
select is(
  (select c.id from public.products p join public.categories c on c.id = p.category_id join public.external_entity_links l on l.internal_id = p.id and l.external_id = 'U8'),
  'f4000000-0000-4000-8000-000000000001'::uuid, '“Almacén” (accent) reuses the existing Almacen: no duplicate'
);
select is(
  (select c.id from public.products p join public.categories c on c.id = p.category_id join public.external_entity_links l on l.internal_id = p.id and l.external_id = 'U4'),
  'f4000000-0000-4000-8000-000000000002'::uuid, '“CERDO” reuses the existing Cerdo category'
);
select is(
  (select count(*) from public.external_entity_links where organization_id = 'f2000000-0000-4000-8000-000000000001' and external_id like 'INVALID:%'),
  0::bigint, 'a rejected row left no link behind'
);
select is(
  (select jsonb_agg(b.branch_id order by b.branch_id)
   from public.branch_product_assortment b join public.external_entity_links l on l.internal_id = b.product_id and l.entity_type = 'product'),
  jsonb_build_array('f3000000-0000-4000-8000-000000000001'::uuid, 'f3000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001'),
  'the 5 imported products are enabled ONLY in Central'
);
select is(
  (select count(*) from public.branch_product_assortment where branch_id = 'f3000000-0000-4000-8000-000000000002'),
  1::bigint, 'Avenida still sells exactly its one original product'
);
select is(
  (select jsonb_build_object('name', name, 'sku', sku, 'active', active, 'unit', unit_type::text, 'role', inventory_role::text) from public.products where id = 'f5000000-0000-4000-8000-000000000001'),
  '{"name":"Chorizo carniceria","sku":"CHOR-1","active":true,"unit":"WEIGHT","role":"SELLABLE"}'::jsonb,
  'the existing butcher product is untouched'
);
select is(
  (select jsonb_build_object('unit', p.unit_type::text, 'active', p.active, 'role', p.inventory_role::text, 'price', (select price_cents from public.product_prices where product_id = p.id and valid_to is null), 'cost', (select cost_cents from public.product_costs where product_id = p.id and valid_to is null))
   from public.products p join public.external_entity_links l on l.internal_id = p.id and l.external_id = 'U1'),
  '{"unit":"UNIT","active":true,"role":"SELLABLE","price":450000,"cost":300000}'::jsonb,
  'imported product: UNIT, active, sellable, with price and cost'
);

-- ---------------------------------------------------------------------------------------------
-- The same file again: nothing is duplicated
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'ui-2', repeat('b', 64), 'f3000000-0000-4000-8000-000000000001',
  '{"createMissingCategories":true,"runId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","defaultCategoryId":"f4000000-0000-4000-8000-000000000001","linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'the same file gets a new batch');
select is(
  (select public.get_import_batch((select id from public.import_batches where file_name = 'ui-2')) ->> 'sameFileAlreadyApplied'),
  'true', 'the batch reports that the file was already imported');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'ui-2'),
  $j$[
    {"rowNumber":2,"externalId":"U1","payload":{"name":"Coca Cola 2.25 L","unitType":"UNIT","sku":"CODE1","barcodes":["7790000000011"],"categoryName":"Bebidas","priceCents":450000,"costCents":300000}},
    {"rowNumber":3,"externalId":"U2","payload":{"name":"Sprite 2.25 L","unitType":"UNIT","sku":"CODE2","categoryName":"BEBIDAS","priceCents":440000}},
    {"rowNumber":4,"externalId":"U3","payload":{"name":"Fideos","unitType":"UNIT","sku":"CODE3","priceCents":100000}},
    {"rowNumber":5,"externalId":"U4","payload":{"name":"Costilla de almacen","unitType":"UNIT","sku":"CODE4","categoryName":"CERDO","priceCents":800000}},
    {"rowNumber":6,"externalId":"INVALID:6","payload":{"name":"Sin precio","unitType":"UNIT","invalidReason":"Falta el precio de venta"}},
    {"rowNumber":7,"externalId":"U6","payload":{"name":"Categoria ambigua","unitType":"UNIT","sku":"CODE6","categoryName":"Dup Cat","priceCents":1000}},
    {"rowNumber":8,"externalId":"U7","payload":{"name":"Categoria larga","unitType":"UNIT","sku":"CODE7","categoryName":"CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X_CATEGORIA_X","priceCents":1000}},
    {"rowNumber":9,"externalId":"U8","payload":{"name":"Sal fina","unitType":"UNIT","sku":"CODE8","categoryName":"Almacén","priceCents":50000}}
  ]$j$::jsonb)$t$, 'same rows staged again');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'ui-2')) -> 'summary') - 'errors' - 'byReason',
  '{"totalRows":8,"pending":0,"create":0,"update":0,"ignore":5,"error":3}'::jsonb,
  're-import: 0 new, 5 unchanged, the same 3 errors'
);
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'ui-2'), true) -> 'result' ->> 'created', '0', 'applying the re-import creates nothing');
select is((select count(*) from public.products where organization_id = 'f2000000-0000-4000-8000-000000000001'), 9::bigint, 'products unchanged after re-import (4 existing + 5 imported)');
select is((select count(*) from public.categories where organization_id = 'f2000000-0000-4000-8000-000000000001'), 5::bigint, 'categories unchanged after re-import');

-- A changed row (new name, same price) is an UPDATE of the same product and writes no price/cost history.
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'ui-3', null, 'f3000000-0000-4000-8000-000000000001',
  '{"createMissingCategories":true,"defaultCategoryId":"f4000000-0000-4000-8000-000000000001"}'::jsonb)$$, 'batch for a changed row');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'ui-3'),
  $j$[{"rowNumber":2,"externalId":"U1","payload":{"name":"Coca Cola 2.25 L Retornable","unitType":"UNIT","sku":"CODE1","barcodes":["7790000000011"],"categoryName":"Bebidas","priceCents":450000,"costCents":300000}}]$j$::jsonb)$t$, 'changed row staged');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'ui-3')) -> 'summary') - 'errors' - 'byReason',
  '{"totalRows":1,"pending":0,"create":0,"update":1,"ignore":0,"error":0}'::jsonb, 'a changed row is an UPDATE');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'ui-3')) -> 'result' ->> 'updated', '1', 'the update is applied');
select is(
  (select jsonb_build_object('current', (select price_cents from public.product_prices pp where pp.product_id = p.id and pp.valid_to is null), 'rows', (select count(*) from public.product_prices pp where pp.product_id = p.id), 'costRows', (select count(*) from public.product_costs pc where pc.product_id = p.id))
   from public.products p join public.external_entity_links l on l.internal_id = p.id and l.external_id = 'U1'),
  '{"current":450000,"rows":1,"costRows":1}'::jsonb, 'an unchanged price/cost adds no history rows');

-- ---------------------------------------------------------------------------------------------
-- Without createMissingCategories the old behaviour holds
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'ui-4', null, 'f3000000-0000-4000-8000-000000000001')$$, 'batch without the option');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'ui-4'),
  $j$[{"rowNumber":2,"externalId":"N1","payload":{"name":"Con categoria nueva","unitType":"UNIT","sku":"NEW1","categoryName":"Categoria Inexistente","priceCents":1000}}]$j$::jsonb)$t$, 'row with an unknown category staged');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'ui-4')) -> 'summary' -> 'byReason'),
  '{"CATEGORY_NOT_FOUND":1}'::jsonb, 'without createMissingCategories an unknown category is still CATEGORY_NOT_FOUND');

-- ---------------------------------------------------------------------------------------------
-- Linking an existing product: unambiguous barcode, ambiguous SKU+barcode, SKU collision
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'ui-5', null, 'f3000000-0000-4000-8000-000000000001',
  '{"createMissingCategories":true,"defaultCategoryId":"f4000000-0000-4000-8000-000000000001","linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'link batch');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'ui-5'),
  $j$[
    {"rowNumber":2,"externalId":"E1","payload":{"name":"Quick Alta Central (SimplyGest)","unitType":"UNIT","barcodes":["7790000000099"],"priceCents":260000}},
    {"rowNumber":3,"externalId":"E2","payload":{"name":"Mezcla ambigua","unitType":"UNIT","sku":"AAA-1","barcodes":["BBB-2222"],"priceCents":1000}},
    {"rowNumber":4,"externalId":"E3","payload":{"name":"Choque con carniceria","unitType":"UNIT","sku":"CHOR-1","priceCents":1000}}
  ]$j$::jsonb)$t$, 'link rows staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'ui-5'))$$, 'link batch previews');
select is(
  (select jsonb_object_agg(row_number::text, reason_code) from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'ui-5')),
  '{"2":"LINK_EXISTING","3":"AMBIGUOUS_MATCH","4":"UNIT_TYPE_MISMATCH"}'::jsonb,
  'barcode match → LINK_EXISTING; SKU of one product + barcode of another → AMBIGUOUS_MATCH; a butcher (WEIGHT) product is never flipped to UNIT by an adoption'
);
select is(
  (select internal_id from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'ui-5') and row_number = 2),
  'f5000000-0000-4000-8000-000000000002'::uuid, 'the barcode row targets the existing product');
select is(
  (select count(*) from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'ui-5') and action = 'UPDATE' and reason_code = 'LINK_EXISTING'),
  1::bigint, 'every adoption of an existing product is classified UPDATE/LINK_EXISTING so the operator can review it');
select is(
  (select jsonb_build_object('branches', (select count(*) from public.branch_product_assortment where product_id = 'f5000000-0000-4000-8000-000000000001'))),
  '{"branches":1}'::jsonb, 'the butcher product is still only in its own branch (previewing wrote nothing)');
select is(public.cancel_import_batch((select id from public.import_batches where file_name = 'ui-5')) ->> 'status', 'CANCELLED', 'a previewed batch can be cancelled without writing anything');

-- Adopting the unambiguous one: same product, price history appended (old row closed, new current).
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'ui-6', null, 'f3000000-0000-4000-8000-000000000001',
  '{"createMissingCategories":true,"defaultCategoryId":"f4000000-0000-4000-8000-000000000001","linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'adoption batch');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'ui-6'),
  $j$[{"rowNumber":2,"externalId":"E1","payload":{"name":"Quick Alta Central (SimplyGest)","unitType":"UNIT","barcodes":["7790000000099"],"priceCents":260000}}]$j$::jsonb)$t$, 'the unambiguous row is staged alone');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'ui-6')) -> 'summary') - 'errors' - 'byReason',
  '{"totalRows":1,"pending":0,"create":0,"update":1,"ignore":0,"error":0}'::jsonb, 'preview: the existing product is updated, not duplicated');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'ui-6')) -> 'result' ->> 'updated', '1', 'adoption applied');
select is(
  (select jsonb_build_object(
     'name', p.name, 'products', (select count(*) from public.products where organization_id = p.organization_id),
     'current', (select price_cents from public.product_prices pp where pp.product_id = p.id and pp.valid_to is null),
     'rows', (select count(*) from public.product_prices pp where pp.product_id = p.id),
     'linked', (select count(*) from public.external_entity_links l where l.internal_id = p.id and l.external_id = 'E1'))
   from public.products p where p.id = 'f5000000-0000-4000-8000-000000000002'),
  '{"name":"Quick Alta Central (SimplyGest)","products":9,"current":260000,"rows":2,"linked":1}'::jsonb,
  'same product (no duplicate), new current price, old price kept as history, now linked to its SimplyGest code');

-- ---------------------------------------------------------------------------------------------
-- Opening balance as a second batch (after the products exist)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.create_import_batch('simplygest', 'stock_opening_balance', 'ui-stock', repeat('c', 64), 'f3000000-0000-4000-8000-000000000001',
  '{"runId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'::jsonb)$$, 'stock batch for Central');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'ui-stock'),
  $j$[
    {"rowNumber":2,"externalId":"U1","payload":{"quantityUnits":24}},
    {"rowNumber":3,"externalId":"U2","payload":{"quantityUnits":0}},
    {"rowNumber":4,"externalId":"U3","payload":{"quantityUnits":5}},
    {"rowNumber":5,"externalId":"U4","payload":{"quantityGrams":1500}}
  ]$j$::jsonb)$t$, 'stock rows staged');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'ui-stock')) -> 'summary') - 'errors' - 'byReason',
  '{"totalRows":4,"pending":0,"create":2,"update":0,"ignore":1,"error":1}'::jsonb,
  'stock preview: 2 openings, a zero ignored, a grams-for-a-UNIT row rejected');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'ui-stock'), true) -> 'result' ->> 'created', '2', 'two opening balances were written');
select is(
  (select jsonb_build_object('type', type::text, 'branch', branch_id, 'qty', quantity_grams)
   from public.stock_movements sm join public.external_entity_links l on l.internal_id = sm.product_id and l.external_id = 'U1'),
  '{"type":"OPENING_BALANCE","branch":"f3000000-0000-4000-8000-000000000001","qty":24}'::jsonb,
  'stock enters the ledger as an OPENING_BALANCE in Central (no stock column anywhere)');
select is(
  (select count(*) from public.stock_movements where branch_id = 'f3000000-0000-4000-8000-000000000002'),
  0::bigint, 'Avenida stock was not touched');

select lives_ok($$select public.create_import_batch('simplygest', 'stock_opening_balance', 'ui-stock-2', repeat('c', 64), 'f3000000-0000-4000-8000-000000000001')$$, 'same stock file again');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'ui-stock-2'),
  $j$[{"rowNumber":2,"externalId":"U1","payload":{"quantityUnits":24}},{"rowNumber":4,"externalId":"U3","payload":{"quantityUnits":5}}]$j$::jsonb)$t$, 'stock rows staged again');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'ui-stock-2')) -> 'summary' -> 'byReason'),
  '{"ALREADY_HAS_STOCK_HISTORY":2}'::jsonb, 're-importing the stock never doubles it');

-- ---------------------------------------------------------------------------------------------
-- An employee cannot use any of it
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.create_import_batch('simplygest', 'product', 'emp', null, 'f3000000-0000-4000-8000-000000000001', '{"createMissingCategories":true}'::jsonb)$$, '42501', null, 'an employee cannot create import batches');
select is((select count(*) from public.import_batches), 0::bigint, 'an employee cannot read the import history');

select * from finish();
rollback;
