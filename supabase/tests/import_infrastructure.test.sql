begin;

create extension if not exists pgtap with schema extensions;
select plan(120);

-- ---------------------------------------------------------------------------------------------
-- Shape and hardening
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'product_barcodes', 'product_barcodes exists');
select has_table('public', 'import_batches', 'import_batches exists');
select has_table('public', 'import_rows', 'import_rows exists');
select has_table('public', 'external_entity_links', 'external_entity_links exists');
select ok((select relrowsecurity from pg_class where oid = 'public.product_barcodes'::regclass), 'product_barcodes has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.import_batches'::regclass), 'import_batches has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.import_rows'::regclass), 'import_rows has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.external_entity_links'::regclass), 'external_entity_links has RLS');
select ok(not has_table_privilege('authenticated', 'public.import_batches', 'INSERT'), 'browser clients cannot insert import batches directly');
select ok(not has_table_privilege('authenticated', 'public.import_rows', 'UPDATE'), 'browser clients cannot update staged rows directly');
select ok(not has_table_privilege('authenticated', 'public.external_entity_links', 'INSERT'), 'browser clients cannot write links directly');
select ok(not has_table_privilege('authenticated', 'public.product_barcodes', 'INSERT'), 'browser clients cannot write barcodes directly');
select ok(not has_function_privilege('anon', 'public.apply_import_batch(uuid,boolean)', 'EXECUTE'), 'anonymous cannot apply imports');
select ok(exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'stock_movement_type' and e.enumlabel = 'OPENING_BALANCE'), 'OPENING_BALANCE movement type exists');

-- ---------------------------------------------------------------------------------------------
-- Fixture: org A (admin, employee), org B (admin), two branches in A
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'import-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Import Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'import-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Import Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'import-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Import Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'Import Org A', 'import-org-a'),
  ('e2000000-0000-4000-8000-000000000002', 'Import Org B', 'import-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Almacen', 'ALMACEN'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'Carniceria', 'CARNI'),
  ('e3000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000002', 'Org B Branch', 'IMPB');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');

-- Pre-existing (manually created) catalog in org A: what a real cut-over starts from.
insert into public.categories (id, organization_id, name, slug) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Existente', 'existente'),
  ('e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'Existente B', 'existente-b');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Manual Vacio', 'manual-vacio', 'MAN-1', 'WEIGHT'),
  ('e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Con historia', 'con-historia', 'HIS-1', 'WEIGHT'),
  ('e5000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000002', 'e4000000-0000-4000-8000-000000000002', 'Producto Org B', 'producto-org-b', 'ORGB-1', 'UNIT');
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', null, 800000, now() - interval '1 day');
-- "Con historia" has ledger history, so its forma de venta is locked.
insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id)
values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000002', 'PURCHASE', 1000, 'e1000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------------------------
-- Barcodes
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is(
  public.set_product_barcodes('e5000000-0000-4000-8000-000000000001', array[' 7791234567890 ', 'abc-123']),
  array['7791234567890', 'ABC-123'],
  'barcodes are trimmed/upper-cased and stored'
);
select is(
  public.set_product_barcodes('e5000000-0000-4000-8000-000000000001', array['7791234567890', 'ABC-123', '7791234567890']),
  array['7791234567890', 'ABC-123'],
  'set_product_barcodes is idempotent and de-duplicates the input'
);
select is((select count(*) from public.product_barcodes where product_id = 'e5000000-0000-4000-8000-000000000001'), 2::bigint, 'still exactly two barcode rows');
select throws_ok(
  $$select public.set_product_barcodes('e5000000-0000-4000-8000-000000000002', array['7791234567890'])$$,
  '23505', null, 'a barcode that belongs to another product is rejected'
);
select throws_ok(
  $$select public.set_product_barcodes('e5000000-0000-4000-8000-000000000002', array['a b'])$$,
  '22023', null, 'a malformed barcode is rejected'
);
select is((select product_id from public.resolve_product_barcode('  7791234567890 ')), 'e5000000-0000-4000-8000-000000000001'::uuid, 'scan resolves the normalized barcode to its product');
select is((select count(*) from public.resolve_product_barcode('0000000000000')), 0::bigint, 'an unknown barcode resolves to nothing');
select is(
  public.set_product_barcodes('e5000000-0000-4000-8000-000000000001', array['ABC-123']),
  array['ABC-123'],
  'replacing the set removes the barcodes that were dropped'
);
reset role;
select ok(
  (select count(*) from public.pos_catalog_changes where organization_id = 'e2000000-0000-4000-8000-000000000001' and entity_type = 'PRODUCT' and entity_id = 'e5000000-0000-4000-8000-000000000001') > 0,
  'a barcode change is logged as a PRODUCT change for the POS sync cursor'
);
set local role authenticated;
select public.set_product_barcodes('e5000000-0000-4000-8000-000000000001', array[]::text[]);

-- Employee: can read/scan, cannot write barcodes or touch imports.
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
  $$select public.set_product_barcodes('e5000000-0000-4000-8000-000000000001', array['EMP-CODE-1'])$$,
  '42501', null, 'an employee cannot edit barcodes'
);
select throws_ok(
  $$select public.create_import_batch('simplygest', 'product', 'emp.csv')$$,
  '42501', null, 'an employee cannot create an import batch'
);

-- ---------------------------------------------------------------------------------------------
-- Admin A: validation of batch creation
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select throws_ok($$select public.create_import_batch('SimplyGest', 'product')$$, '22023', null, 'source_system must be a lowercase slug');
select throws_ok($$select public.create_import_batch('simplygest', 'customer')$$, '22023', null, 'unsupported entity types are rejected');
select throws_ok($$select public.create_import_batch('simplygest', 'stock_opening_balance')$$, '42501', null, 'stock opening requires a branch');
select throws_ok($$select public.create_import_batch('simplygest', 'product', null, null, 'e3000000-0000-4000-8000-000000000001', '{"nope":true}'::jsonb)$$, '22023', null, 'unknown options are rejected');
select throws_ok($$select public.create_import_batch('simplygest', 'category', null, null, null, '{"linkExistingBy":["sku"]}'::jsonb)$$, '22023', null, 'categories can only be linked by name');

-- ---------------------------------------------------------------------------------------------
-- Categories: conflicts are errors, linking is explicit
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.create_import_batch('simplygest', 'category', 'cats-1')$$, 'category batch is created');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'cats-1'),
  $j$[
    {"rowNumber":1,"externalId":"R1","payload":{"name":"Bebidas","sortOrder":5}},
    {"rowNumber":2,"externalId":"R2","payload":{"name":"Existente","sortOrder":3}}
  ]$j$::jsonb)$t$, 'category rows are staged');
select is(
  public.preview_import_batch((select id from public.import_batches where file_name = 'cats-1')) -> 'summary' ->> 'create',
  '1', 'preview: one new category'
);
select is(
  (select reason_code from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'cats-1') and row_number = 2),
  'NAME_CONFLICT', 'preview: a same-name category that was not imported is a conflict, never a silent merge'
);
select throws_ok(
  $$select public.apply_import_batch((select id from public.import_batches where file_name = 'cats-1'))$$,
  '22023', null, 'apply refuses a batch with errors unless told to skip them'
);
select is(
  public.apply_import_batch((select id from public.import_batches where file_name = 'cats-1'), true) -> 'result' ->> 'created',
  '1', 'apply with skip_errors creates only the valid category'
);
select is((select count(*) from public.categories where organization_id = 'e2000000-0000-4000-8000-000000000001'), 2::bigint, 'exactly one category was added');
select is(
  (select count(*) from public.external_entity_links where organization_id = 'e2000000-0000-4000-8000-000000000001' and entity_type = 'category'),
  1::bigint, 'the created category is linked to its external id'
);

select lives_ok($$select public.create_import_batch('simplygest', 'category', 'cats-2', null, null, '{"linkExistingBy":["name"]}'::jsonb)$$, 'second category batch (link by name)');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'cats-2'),
  $j$[
    {"rowNumber":1,"externalId":"R1","payload":{"name":"Bebidas","sortOrder":5}},
    {"rowNumber":2,"externalId":"R2","payload":{"name":"Existente","sortOrder":3}}
  ]$j$::jsonb)$t$, 'same category rows staged again');
select is(
  public.preview_import_batch((select id from public.import_batches where file_name = 'cats-2')) -> 'summary' ->> 'ignore',
  '1', 're-importing an unchanged row is IGNORE (no duplicate category)'
);
select is(
  (select reason_code from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'cats-2') and row_number = 2),
  'LINK_EXISTING', 'with linkExistingBy=name the existing category is linked explicitly'
);
select is(
  public.apply_import_batch((select id from public.import_batches where file_name = 'cats-2')) -> 'result' ->> 'updated',
  '1', 'apply links the existing category'
);
select is((select count(*) from public.categories where organization_id = 'e2000000-0000-4000-8000-000000000001'), 2::bigint, 'no category was duplicated');
select is((select sort_order from public.categories where id = 'e4000000-0000-4000-8000-000000000001'), 3, 'the linked category took the imported sort order');

-- ---------------------------------------------------------------------------------------------
-- Products: classification, errors, creation, idempotency, update
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'prod-1', repeat('a', 64), 'e3000000-0000-4000-8000-000000000001')$$, 'product batch is created');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'prod-1'),
  $j$[
    {"rowNumber":1,"externalId":"P1","payload":{"name":"Coca Cola 2.25 L","unitType":"UNIT","sku":"coca-225","barcodes":["7790895000010"],"categoryExternalId":"R1","priceCents":450000,"costCents":300000}},
    {"rowNumber":2,"externalId":"P2","payload":{"name":"Vacío","unitType":"WEIGHT","sku":"VAC-IMP","categoryName":"Existente","priceCents":1200000}},
    {"rowNumber":3,"externalId":"P3","payload":{"name":"Otro","unitType":"WEIGHT","sku":"MAN-1","categoryName":"Existente"}},
    {"rowNumber":4,"externalId":"P1","payload":{"name":"Coca duplicada","unitType":"UNIT","categoryName":"Existente"}},
    {"rowNumber":5,"externalId":"P4","payload":{"name":"Agua 500 cc","unitType":"UNIT","categoryExternalId":"R1","priceCents":120000}},
    {"rowNumber":6,"externalId":"P5","payload":{"name":"Sal","unitType":"WEIGHT","categoryName":"Existente","priceCents":90000}},
    {"rowNumber":7,"externalId":"P6","payload":{"name":"Raro","unitType":"KILO","categoryName":"Existente"}},
    {"rowNumber":8,"externalId":"P7","payload":{"name":"Coca copia","unitType":"UNIT","barcodes":["7790895000010"],"categoryName":"Existente"}},
    {"rowNumber":9,"payload":{"name":"Sin codigo","unitType":"WEIGHT","categoryName":"Existente"}},
    {"rowNumber":10,"externalId":"P8","payload":{"name":"Sin categoria","unitType":"WEIGHT","categoryName":"Nope"}},
    {"rowNumber":11,"externalId":"P9","payload":{"name":"Precio malo","unitType":"WEIGHT","categoryName":"Existente","priceCents":"abc"}}
  ]$j$::jsonb)$t$, 'eleven product rows are staged');

select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'prod-1')) -> 'summary') - 'errors' - 'byReason',
  '{"totalRows":11,"pending":0,"create":4,"update":0,"ignore":0,"error":7}'::jsonb,
  'preview: 11 rows → 4 new, 0 updates, 0 ignored, 7 errors'
);
select is(
  (select jsonb_object_agg(row_number::text, reason_code) from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'prod-1') and action = 'ERROR'),
  '{"3":"SKU_CONFLICT","4":"DUPLICATE_EXTERNAL_ID","7":"INVALID_UNIT_TYPE","8":"DUPLICATE_BARCODE_IN_FILE","9":"MISSING_EXTERNAL_ID","10":"CATEGORY_NOT_FOUND","11":"INVALID_PRICE"}'::jsonb,
  'preview: every error row has a precise reason code'
);
select is((select count(*) from public.products where organization_id = 'e2000000-0000-4000-8000-000000000001'), 2::bigint, 'preview wrote no products');

select throws_ok(
  $$select public.apply_import_batch((select id from public.import_batches where file_name = 'prod-1'))$$,
  '22023', null, 'product apply is refused while errors are pending'
);
select is(
  public.apply_import_batch((select id from public.import_batches where file_name = 'prod-1'), true) -> 'result',
  '{"created":4,"updated":0,"ignored":0,"skippedErrors":7}'::jsonb,
  'apply creates the 4 valid products and skips the 7 error rows'
);
select is((select count(*) from public.products where organization_id = 'e2000000-0000-4000-8000-000000000001'), 6::bigint, 'exactly 4 products were added');
select is(
  (select jsonb_build_object('name', p.name, 'unit', p.unit_type, 'sku', p.sku, 'slug', p.slug, 'active', p.active)
   from public.products p join public.external_entity_links l on l.internal_id = p.id and l.external_id = 'P1' and l.entity_type = 'product'),
  '{"name":"Coca Cola 2.25 L","unit":"UNIT","sku":"COCA-225","slug":"coca-cola-2-25-l","active":true}'::jsonb,
  'the warehouse product is a UNIT product with normalized sku and generated slug'
);
select is(
  (select count(*) from public.resolve_product_barcode('7790895000010') r join public.external_entity_links l on l.internal_id = r.product_id and l.external_id = 'P1'),
  1::bigint, 'the imported barcode resolves to the imported product'
);
select is(
  (select price_cents from public.product_prices pp join public.external_entity_links l on l.internal_id = pp.product_id and l.external_id = 'P1' where pp.valid_to is null),
  450000::bigint, 'the imported price is the current price'
);
select is(
  (select cost_cents from public.product_costs pc join public.external_entity_links l on l.internal_id = pc.product_id and l.external_id = 'P1' where pc.valid_to is null),
  300000::bigint, 'the imported cost is the current cost'
);
select is(
  (select count(*) from public.product_category_assignments a join public.external_entity_links l on l.internal_id = a.product_id and l.external_id = 'P2'),
  1::bigint, 'imported products get their category assignment (the POS builds its tabs from it)'
);
select is(
  (select p.unit_type::text from public.products p join public.external_entity_links l on l.internal_id = p.id and l.external_id = 'P2'),
  'WEIGHT', 'a butcher product imports as a WEIGHT product'
);

-- Applying the same batch again is a no-op returning the stored result.
select is(
  public.apply_import_batch((select id from public.import_batches where file_name = 'prod-1')) ->> 'alreadyApplied',
  'true', 'applying an already applied batch is idempotent'
);
select is((select count(*) from public.products where organization_id = 'e2000000-0000-4000-8000-000000000001'), 6::bigint, 'retrying apply created nothing');

-- The SAME file imported a second time: nothing is created.
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'prod-2', repeat('a', 64), 'e3000000-0000-4000-8000-000000000001')$$, 'same file, new batch');
select is(
  (select public.get_import_batch((select id from public.import_batches where file_name = 'prod-2')) ->> 'sameFileAlreadyApplied'),
  'true', 'the batch reports that the same file was already applied'
);
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'prod-2'),
  $j$[
    {"rowNumber":1,"externalId":"P1","payload":{"name":"Coca Cola 2.25 L","unitType":"UNIT","sku":"coca-225","barcodes":["7790895000010"],"categoryExternalId":"R1","priceCents":450000,"costCents":300000}},
    {"rowNumber":2,"externalId":"P2","payload":{"name":"Vacío","unitType":"WEIGHT","sku":"VAC-IMP","categoryName":"Existente","priceCents":1200000}},
    {"rowNumber":5,"externalId":"P4","payload":{"name":"Agua 500 cc","unitType":"UNIT","categoryExternalId":"R1","priceCents":120000}},
    {"rowNumber":6,"externalId":"P5","payload":{"name":"Sal","unitType":"WEIGHT","categoryName":"Existente","priceCents":90000}}
  ]$j$::jsonb)$t$, 'the same rows are staged again');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'prod-2')) -> 'summary') - 'errors' - 'byReason',
  '{"totalRows":4,"pending":0,"create":0,"update":0,"ignore":4,"error":0}'::jsonb,
  'second run of the same file: 0 new, 4 ignored (no duplicates)'
);
select is(
  public.apply_import_batch((select id from public.import_batches where file_name = 'prod-2')) -> 'result' ->> 'created',
  '0', 'applying the repeated import creates nothing'
);
select is((select count(*) from public.products where organization_id = 'e2000000-0000-4000-8000-000000000001'), 6::bigint, 'product count is unchanged after the repeated import');

-- A changed row updates the same product (no second product, no duplicate barcode/price rows).
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'prod-3', null, 'e3000000-0000-4000-8000-000000000001')$$, 'update batch');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'prod-3'),
  $j$[
    {"rowNumber":1,"externalId":"P1","payload":{"name":"Coca Cola 2.25 L Retornable","unitType":"UNIT","sku":"coca-225","barcodes":["7790895000010","7790895000027"],"categoryExternalId":"R1","priceCents":450000,"costCents":300000}}
  ]$j$::jsonb)$t$, 'changed row staged');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'prod-3')) -> 'summary') - 'errors' - 'byReason',
  '{"totalRows":1,"pending":0,"create":0,"update":1,"ignore":0,"error":0}'::jsonb,
  'a changed row is an UPDATE'
);
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'prod-3')) -> 'result' ->> 'updated', '1', 'update applied');
select is((select count(*) from public.products where organization_id = 'e2000000-0000-4000-8000-000000000001'), 6::bigint, 'the update did not create a product');
select is(
  (select p.name || '|' || p.slug from public.products p join public.external_entity_links l on l.internal_id = p.id and l.external_id = 'P1'),
  'Coca Cola 2.25 L Retornable|coca-cola-2-25-l', 'name changed, slug (URL identity) preserved'
);
select is(
  (select count(*) from public.product_barcodes b join public.external_entity_links l on l.internal_id = b.product_id and l.external_id = 'P1'),
  2::bigint, 'the second barcode was added without duplicating the first'
);
select is(
  (select count(*) from public.product_prices pp join public.external_entity_links l on l.internal_id = pp.product_id and l.external_id = 'P1'),
  1::bigint, 'an unchanged price did not add a history row'
);

-- Linking a pre-existing manual product explicitly (by SKU), with a price change + history.
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'prod-link', null, 'e3000000-0000-4000-8000-000000000001', '{"linkExistingBy":["sku"]}'::jsonb)$$, 'link batch');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'prod-link'),
  $j$[
    {"rowNumber":1,"externalId":"M1","payload":{"name":"Manual Vacio Importado","unitType":"WEIGHT","sku":"MAN-1","priceCents":999900}},
    {"rowNumber":2,"externalId":"L1","payload":{"name":"Con historia","unitType":"UNIT","sku":"HIS-1","categoryName":"Existente"}}
  ]$j$::jsonb)$t$, 'link rows staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'prod-link'))$$, 'link batch previews');
select is(
  (select jsonb_object_agg(row_number::text, reason_code) from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'prod-link')),
  '{"1":"LINK_EXISTING","2":"UNIT_TYPE_LOCKED"}'::jsonb,
  'explicit SKU link → LINK_EXISTING; a product with history cannot change forma de venta'
);
select is(
  public.apply_import_batch((select id from public.import_batches where file_name = 'prod-link'), true) -> 'result' ->> 'updated',
  '1', 'the existing product was linked and updated in place'
);
select is((select name from public.products where id = 'e5000000-0000-4000-8000-000000000001'), 'Manual Vacio Importado', 'the manual product kept its identity and took the imported name');
select is(
  (select jsonb_build_object('current', (select price_cents from public.product_prices where product_id = 'e5000000-0000-4000-8000-000000000001' and valid_to is null), 'rows', (select count(*) from public.product_prices where product_id = 'e5000000-0000-4000-8000-000000000001'))),
  '{"current":999900,"rows":2}'::jsonb, 'price history was preserved: old row closed, new one current'
);
select is((select internal_id from public.external_entity_links where external_id = 'M1' and entity_type = 'product'), 'e5000000-0000-4000-8000-000000000001'::uuid, 'the link points at the pre-existing product');

-- Two rows that resolve to the same existing product never overwrite each other.
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'prod-dup-target', null, 'e3000000-0000-4000-8000-000000000001', '{"linkExistingBy":["name"]}'::jsonb)$$, 'duplicate-target batch');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'prod-dup-target'),
  $j$[
    {"rowNumber":1,"externalId":"D1","payload":{"name":"Con historia","unitType":"WEIGHT"}},
    {"rowNumber":2,"externalId":"D2","payload":{"name":"CON  historia ","unitType":"WEIGHT"}}
  ]$j$::jsonb)$t$, 'duplicate-target rows staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'prod-dup-target'))$$, 'duplicate-target batch previews');
select is(
  (select jsonb_object_agg(row_number::text, reason_code) from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'prod-dup-target')),
  '{"1":"LINK_EXISTING","2":"DUPLICATE_TARGET"}'::jsonb,
  'the second row pointing at the same existing product is an error, not a silent overwrite'
);

-- Staging again invalidates the preview; a stale preview is refused.
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'prod-stale', null, 'e3000000-0000-4000-8000-000000000001')$$, 'stale batch');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'prod-stale'),
  $j$[{"rowNumber":1,"externalId":"S1","payload":{"name":"Stale","unitType":"WEIGHT","sku":"STALE-1","categoryName":"Existente"}}]$j$::jsonb)$t$, 'stale row staged');
select is(public.preview_import_batch((select id from public.import_batches where file_name = 'prod-stale')) -> 'summary' ->> 'create', '1', 'stale row previews as CREATE');
reset role;
insert into public.products (organization_id, category_id, name, slug, sku, unit_type)
values ('e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Colision', 'colision', 'STALE-1', 'WEIGHT');
set local role authenticated;
select throws_ok(
  $$select public.apply_import_batch((select id from public.import_batches where file_name = 'prod-stale'))$$,
  '40001', null, 'apply refuses when the world changed since the preview'
);
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'prod-stale'),
  $j$[{"rowNumber":2,"externalId":"S2","payload":{"name":"Stale 2","unitType":"WEIGHT","categoryName":"Existente"}}]$j$::jsonb)$t$, 'staging more rows');
select is((select status from public.import_batches where file_name = 'prod-stale'), 'STAGING', 'staging returns the batch to STAGING');
select throws_ok(
  $$select public.apply_import_batch((select id from public.import_batches where file_name = 'prod-stale'))$$,
  '22023', null, 'a batch without a current preview cannot be applied'
);
select is(public.cancel_import_batch((select id from public.import_batches where file_name = 'prod-stale')) ->> 'status', 'CANCELLED', 'batches can be cancelled before apply');
select throws_ok(
  $$select public.stage_import_rows((select id from public.import_batches where file_name = 'prod-stale'), '[{"rowNumber":3,"payload":{}}]'::jsonb)$$,
  '22023', null, 'a cancelled batch accepts no rows'
);

-- ---------------------------------------------------------------------------------------------
-- Stock opening balance → ledger (no current_stock column anywhere)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.create_import_batch('simplygest', 'stock_opening_balance', 'stock-1', null, 'e3000000-0000-4000-8000-000000000001')$$, 'stock batch for the almacen branch');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'stock-1'),
  $j$[
    {"rowNumber":1,"externalId":"P1","payload":{"quantityUnits":24}},
    {"rowNumber":2,"externalId":"P2","payload":{"quantityGrams":15500}},
    {"rowNumber":3,"externalId":"P4","payload":{"quantityUnits":0}},
    {"rowNumber":4,"externalId":"P5","payload":{"quantityUnits":3}},
    {"rowNumber":5,"externalId":"NOPE","payload":{"quantityUnits":1}}
  ]$j$::jsonb)$t$, 'stock rows staged');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'stock-1')) -> 'summary') - 'errors',
  '{"totalRows":5,"pending":0,"create":2,"update":0,"ignore":1,"error":2,"byReason":{"ZERO_QUANTITY":1,"UNIT_MISMATCH":1,"PRODUCT_NOT_IMPORTED":1}}'::jsonb,
  'stock preview: 2 openings, 1 zero ignored, 2 errors'
);
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'stock-1'), true) -> 'result' ->> 'created', '2', 'two opening balances applied');
select is(
  (select jsonb_object_agg(l.external_id, s.quantity_grams)
   from public.stock_levels s join public.external_entity_links l on l.internal_id = s.product_id and l.entity_type = 'product'
   where s.branch_id = 'e3000000-0000-4000-8000-000000000001'),
  '{"P1":24,"P2":15500}'::jsonb, 'stock is derived from the ledger: 24 units (UNIT) and 15.5 kg (WEIGHT)'
);
select is(
  (select count(*) from public.stock_movements where import_batch_id = (select id from public.import_batches where file_name = 'stock-1') and type = 'OPENING_BALANCE'),
  2::bigint, 'the opening stock is OPENING_BALANCE ledger movements traced to the batch'
);

-- A second stock file: already-opened products are ignored, never doubled.
select lives_ok($$select public.create_import_batch('simplygest', 'stock_opening_balance', 'stock-2', null, 'e3000000-0000-4000-8000-000000000001')$$, 'second stock batch');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'stock-2'),
  $j$[
    {"rowNumber":1,"externalId":"P1","payload":{"quantityUnits":99}},
    {"rowNumber":2,"externalId":"P5","payload":{"quantityGrams":-5}},
    {"rowNumber":3,"externalId":"P4","payload":{"quantityUnits":7}}
  ]$j$::jsonb)$t$, 'second stock rows staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'stock-2'))$$, 'second stock batch previews');
select is(
  (select jsonb_object_agg(row_number::text, reason_code) from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'stock-2')),
  '{"1":"ALREADY_HAS_STOCK_HISTORY","2":"NEGATIVE_QUANTITY","3":"OPENING_BALANCE"}'::jsonb,
  'an opened product is ignored, negative stock is an error, a new product opens'
);
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'stock-2'), true) -> 'result' ->> 'created', '1', 'only the new opening was applied');
select is(
  (select quantity_grams from public.stock_levels s join public.external_entity_links l on l.internal_id = s.product_id and l.external_id = 'P1' where s.branch_id = 'e3000000-0000-4000-8000-000000000001'),
  24::bigint, 'P1 was not doubled by the second stock file'
);

reset role;
select is((select count(*) from public.product_restock_events e join public.stock_movements m on m.id = e.stock_movement_id where m.type = 'OPENING_BALANCE'), 0::bigint, 'opening balances do not raise restock events');
select throws_ok(
  $$insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id)
    select organization_id, branch_id, product_id, 'OPENING_BALANCE', 5, profile_id from public.stock_movements where type = 'OPENING_BALANCE' limit 1$$,
  '23505', null, 'a (branch, product) can be opened only once, from any source'
);
select throws_ok(
  $$insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id)
    values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001', 'OPENING_BALANCE', -5, 'e1000000-0000-4000-8000-000000000001')$$,
  '23514', null, 'an opening balance must be positive'
);
select throws_ok(
  $$insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id, import_batch_id)
    values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001', 'PURCHASE', 5, 'e1000000-0000-4000-8000-000000000001', (select id from public.import_batches limit 1))$$,
  '23514', null, 'only an opening balance can carry an import link'
);

-- ---------------------------------------------------------------------------------------------
-- Tenant isolation
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.import_batches), 0::bigint, 'org B sees no batches of org A');
select is((select count(*) from public.import_rows), 0::bigint, 'org B sees no staged rows of org A');
select is((select count(*) from public.external_entity_links), 0::bigint, 'org B sees no links of org A');
select is((select count(*) from public.product_barcodes), 0::bigint, 'org B sees no barcodes of org A');
select throws_ok(
  $$select public.get_import_batch('00000000-0000-4000-8000-0000000000aa')$$,
  '42501', null, 'an unknown batch id is refused'
);
select throws_ok(
  $$select public.set_product_barcodes('e5000000-0000-4000-8000-000000000001', array['XTENANT-1'])$$,
  '42501', null, 'org B cannot write barcodes onto org A products'
);
select is(
  (select count(*) from public.resolve_product_barcode('7790895000010')), 0::bigint, 'org B cannot resolve an org A barcode'
);
select is(
  public.set_product_barcodes('e5000000-0000-4000-8000-000000000003', array['7791234567890']),
  array['7791234567890'], 'the same barcode value is allowed in another organization (unique per organization)'
);

select * from finish();
rollback;
