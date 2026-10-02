begin;

create extension if not exists pgtap with schema extensions;
select plan(56);

-- Covers 202610020054: el importador con proveedores, UNIT y WEIGHT, precio 0 válido, proveedor
-- vacío / existente / nuevo, idempotencia al reimportar y que lo importado sólo queda habilitado en
-- Central (y sin ningún movimiento de stock). Fixture: una organización con Central y Avenida, un
-- producto de carnicería existente (Avenida) y un proveedor cargado a mano ("Distribuidora Y").

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'isz-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"ISZ Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'isz-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"ISZ Employee"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values ('c2000000-0000-4000-8000-000000000001', 'ISZ Org', 'isz-org');
insert into public.branches (id, organization_id, name, code) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Almacen', 'almacen');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Chorizo carniceria', 'chorizo-carniceria', 'CHOR-1', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000001');
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', null, 1500000, now() - interval '1 day');
insert into public.suppliers (id, organization_id, name) values
  ('c6000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Distribuidora Y');

-- ---------------------------------------------------------------------------------------------
-- Precio 0 en la base
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 0, now() - interval '1 day')$$, 'the price table accepts a zero price');
select throws_ok($$insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', -1, now())$$, '23514', null, 'a negative price is impossible');
delete from public.product_prices where branch_id = 'c3000000-0000-4000-8000-000000000002';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select throws_ok($$select public.set_product_price('c5000000-0000-4000-8000-000000000001', null, 0)$$, '22023', null, 'Admin still cannot set a zero price by hand');

-- ---------------------------------------------------------------------------------------------
-- Preview: UNIT, WEIGHT, precio 0, precio inválido, tipo inválido, proveedores
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'isz-1', repeat('a', 64), 'c3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"c4000000-0000-4000-8000-000000000001","createMissingCategories":true,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'a product batch is created');

select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'isz-1'),
  $j$[
    {"rowNumber":2,"externalId":"S1","payload":{"name":"Coca Cola 2.25 L","unitType":"UNIT","sku":"S1","barcodes":["7790895000010"],"priceCents":350000,"costCents":250000,"supplierName":"Coca-Cola FEMSA","supplierCode":"P1"}},
    {"rowNumber":3,"externalId":"S2","payload":{"name":"Vacio importado","unitType":"WEIGHT","sku":"S2","priceCents":1200000}},
    {"rowNumber":4,"externalId":"S3","payload":{"name":"GALLETITAS X","unitType":"UNIT","sku":"S3","priceCents":0,"supplierName":"Distribuidora X"}},
    {"rowNumber":5,"externalId":"S4","payload":{"name":"Negativo","unitType":"UNIT","sku":"S4","priceCents":-5}},
    {"rowNumber":6,"externalId":"S5","payload":{"name":"Fraccion","unitType":"UNIT","sku":"S5","priceCents":10.5}},
    {"rowNumber":7,"externalId":"S6","payload":{"name":"Caja","unitType":"BOX","sku":"S6","priceCents":1000}},
    {"rowNumber":8,"externalId":"S7","payload":{"name":"Fideos","unitType":"UNIT","sku":"S7","priceCents":90000,"supplierName":"DISTRIBUIDORA  y"}},
    {"rowNumber":9,"externalId":"S8","payload":{"name":"Arroz","unitType":"UNIT","sku":"S8","priceCents":80000,"supplierName":""}},
    {"rowNumber":10,"externalId":"S9","payload":{"name":"Pepsi","unitType":"UNIT","sku":"S9","priceCents":300000,"supplierName":"coca-cola femsa "}},
    {"rowNumber":11,"externalId":"S10","payload":{"name":"Huerfano","unitType":"UNIT","sku":"S10","priceCents":1000,"supplierCode":"ZZ"}},
    {"rowNumber":12,"externalId":"S11","payload":{"name":"Proveedor largo","unitType":"UNIT","sku":"S11","priceCents":1000,"supplierName":"XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"}}
  ]$j$::jsonb)$t$, 'eleven rows are staged');

select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'isz-1')) -> 'summary') - 'errors' - 'byReason',
  '{"totalRows":11,"pending":0,"create":6,"update":0,"ignore":0,"error":5}'::jsonb,
  'preview: 6 products to create (UNIT, WEIGHT and a zero price), 5 errors'
);
select is(
  (select jsonb_object_agg(row_number::text, reason_code) from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'isz-1') and action = 'ERROR'),
  '{"5":"INVALID_PRICE","6":"INVALID_PRICE","7":"INVALID_UNIT_TYPE","11":"SUPPLIER_NAME_REQUIRED","12":"INVALID_SUPPLIER"}'::jsonb,
  'negative/fractional price, unknown tipo_venta, a supplier code without name and an oversized supplier each get their own reason'
);
select is((select action from public.import_rows where batch_id = (select id from public.import_batches where file_name = 'isz-1') and row_number = 4), 'CREATE', 'a zero price is NOT an error');
select is((select count(*) from public.suppliers), 1::bigint, 'preview created no supplier');
select is((select count(*) from public.products), 1::bigint, 'preview created no product');

select is(
  (select jsonb_agg(jsonb_build_object('name', e ->> 'name', 'existing', (e ->> 'supplierId') is not null, 'rows', e -> 'rows') order by e ->> 'name')
   from jsonb_array_elements(public.list_import_batch_suppliers((select id from public.import_batches where file_name = 'isz-1'))) e),
  '[{"name":"Coca-Cola FEMSA","existing":false,"rows":2},{"name":"Distribuidora X","existing":false,"rows":1},{"name":"Distribuidora Y","existing":true,"rows":1}]'::jsonb,
  'the preview audits which suppliers will be created (Coca-Cola once, even if one row has the code and another only the name) and which one is reused'
);

-- ---------------------------------------------------------------------------------------------
-- Apply
-- ---------------------------------------------------------------------------------------------
select is(
  public.apply_import_batch((select id from public.import_batches where file_name = 'isz-1'), true) -> 'result',
  '{"created":6,"updated":0,"ignored":0,"skippedErrors":5}'::jsonb,
  'apply creates the 6 valid products'
);
select is((select count(*) from public.suppliers), 3::bigint, 'exactly 2 suppliers were created (Coca-Cola, Distribuidora X); Distribuidora Y was reused');
select is((select count(*) from public.suppliers where app_private.import_normalize_text(name) = 'coca-cola femsa'), 1::bigint, 'Coca-Cola exists once, though two rows named it differently');
select is((select code from public.suppliers where name = 'Coca-Cola FEMSA'), 'P1', 'the supplier code from the file is stored');
select is(
  (select count(*) from public.external_entity_links where entity_type = 'supplier' and external_id = 'P1'),
  1::bigint, 'the supplier code is linked as an external id'
);
select is(
  (select jsonb_object_agg(p.sku, s.name) from public.product_suppliers ps join public.products p on p.id = ps.product_id join public.suppliers s on s.id = ps.supplier_id where ps.is_primary),
  '{"S1":"Coca-Cola FEMSA","S3":"Distribuidora X","S7":"Distribuidora Y","S9":"Coca-Cola FEMSA"}'::jsonb,
  'each product with a supplier points at it as the primary one'
);
select is((select count(*) from public.product_suppliers ps join public.products p on p.id = ps.product_id where p.sku in ('S2', 'S8')), 0::bigint, 'products without supplier (absent or empty) stay without one');
select is(
  (select jsonb_object_agg(sku, unit_type::text) from public.products where sku in ('S1', 'S2', 'S3')),
  '{"S1":"UNIT","S2":"WEIGHT","S3":"UNIT"}'::jsonb, 'UNIT and WEIGHT are both imported as declared (no longer forced to UNIT)'
);
select is(
  (select jsonb_object_agg(p.sku, pp.price_cents) from public.product_prices pp join public.products p on p.id = pp.product_id where p.sku in ('S1', 'S2', 'S3', 'S7', 'S8')),
  '{"S1":350000,"S2":1200000,"S3":0,"S7":90000,"S8":80000}'::jsonb, 'the zero-price product is imported with price 0'
);
select is((select cost_cents from public.product_costs pc join public.products p on p.id = pc.product_id where p.sku = 'S1' and pc.valid_to is null), 250000::bigint, 'cost is still imported');
select is(
  (select count(*) from public.branch_product_assortment b join public.products p on p.id = b.product_id where p.sku like 'S%' and b.branch_id = 'c3000000-0000-4000-8000-000000000001'),
  6::bigint, 'the 6 imported products are enabled in Central'
);
select is(
  (select count(*) from public.branch_product_assortment where branch_id = 'c3000000-0000-4000-8000-000000000002'),
  1::bigint, 'Avenida still sells exactly its original product'
);
select is((select count(*) from public.stock_movements), 0::bigint, 'the import wrote no stock movement at all (no OPENING_BALANCE)');
select is(
  (select jsonb_build_object('name', name, 'sku', sku, 'unit', unit_type::text) from public.products where id = 'c5000000-0000-4000-8000-000000000001'),
  '{"name":"Chorizo carniceria","sku":"CHOR-1","unit":"WEIGHT"}'::jsonb, 'the existing butcher product is untouched'
);

-- Todo el archivo corre en UNA transacción (now() no avanza): se retrocede un día la vigencia de lo
-- que acaba de importar para que los cambios de precio siguientes ocurran "después", como en producción.
reset role;
alter table public.product_prices disable trigger product_prices_prevent_history_rewrite;
update public.product_prices set valid_from = now() - interval '1 day' where valid_from = now();
alter table public.product_prices enable trigger product_prices_prevent_history_rewrite;
set local role authenticated;

-- ---------------------------------------------------------------------------------------------
-- Idempotencia: el mismo archivo otra vez
-- ---------------------------------------------------------------------------------------------
create temp table isz_before as
select (select count(*) from public.products) as products, (select count(*) from public.suppliers) as suppliers,
       (select count(*) from public.product_suppliers) as links, (select count(*) from public.product_prices) as prices,
       (select count(*) from public.product_barcodes) as barcodes, (select count(*) from public.product_costs) as costs,
       (select count(*) from public.external_entity_links) as externals;
grant select on isz_before to public;

select lives_ok($$select public.create_import_batch('simplygest', 'product', 'isz-2', repeat('a', 64), 'c3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"c4000000-0000-4000-8000-000000000001","createMissingCategories":true,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'a second batch for the same file is created');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'isz-2'),
  $j$[
    {"rowNumber":2,"externalId":"S1","payload":{"name":"Coca Cola 2.25 L","unitType":"UNIT","sku":"S1","barcodes":["7790895000010"],"priceCents":350000,"costCents":250000,"supplierName":"Coca-Cola FEMSA","supplierCode":"P1"}},
    {"rowNumber":3,"externalId":"S2","payload":{"name":"Vacio importado","unitType":"WEIGHT","sku":"S2","priceCents":1200000}},
    {"rowNumber":4,"externalId":"S3","payload":{"name":"GALLETITAS X","unitType":"UNIT","sku":"S3","priceCents":0,"supplierName":"Distribuidora X"}},
    {"rowNumber":8,"externalId":"S7","payload":{"name":"Fideos","unitType":"UNIT","sku":"S7","priceCents":90000,"supplierName":"DISTRIBUIDORA  y"}},
    {"rowNumber":9,"externalId":"S8","payload":{"name":"Arroz","unitType":"UNIT","sku":"S8","priceCents":80000,"supplierName":""}},
    {"rowNumber":10,"externalId":"S9","payload":{"name":"Pepsi","unitType":"UNIT","sku":"S9","priceCents":300000,"supplierName":"coca-cola femsa "}}
  ]$j$::jsonb)$t$, 'the same six valid rows are staged again');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'isz-2')) -> 'summary') - 'errors',
  '{"totalRows":6,"pending":0,"create":0,"update":0,"ignore":6,"error":0,"byReason":{"UNCHANGED":6}}'::jsonb,
  'preview of the same file: every row is IGNORE / UNCHANGED'
);
select is(
  (select jsonb_agg(jsonb_build_object('name', e ->> 'name', 'existing', (e ->> 'supplierId') is not null) order by e ->> 'name')
   from jsonb_array_elements(public.list_import_batch_suppliers((select id from public.import_batches where file_name = 'isz-2'))) e),
  '[{"name":"Coca-Cola FEMSA","existing":true},{"name":"Distribuidora X","existing":true},{"name":"Distribuidora Y","existing":true}]'::jsonb,
  'the second preview reports every supplier as reused'
);
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'isz-2')) -> 'result', '{"created":0,"updated":0,"ignored":6,"skippedErrors":0}'::jsonb, 'applying it changes nothing');
select is((select products from isz_before), (select count(*) from public.products), 'no product was duplicated');
select is((select suppliers from isz_before), (select count(*) from public.suppliers), 'no supplier was duplicated');
select is((select links from isz_before), (select count(*) from public.product_suppliers), 'no product-supplier link was duplicated');
select is((select prices from isz_before), (select count(*) from public.product_prices), 'no price row was created');
select is((select barcodes from isz_before), (select count(*) from public.product_barcodes), 'no barcode was duplicated');
select is((select costs from isz_before), (select count(*) from public.product_costs), 'no cost row was created');
select is((select externals from isz_before), (select count(*) from public.external_entity_links), 'no external link was duplicated');

-- ---------------------------------------------------------------------------------------------
-- Una fila cambia: el precio 0 del archivo nunca pisa un precio ya cargado; el proveedor cambia
-- ---------------------------------------------------------------------------------------------
-- "Fran" le puso precio a Galletitas desde la caja (aquí: la misma historia append-only vía Admin).
select lives_ok($$select public.set_product_price((select id from public.products where sku = 'S3'), null, 180000)$$, 'a real price replaces the zero price (history is closed, not rewritten)');
select is((select count(*) from public.product_prices where product_id = (select id from public.products where sku = 'S3')), 2::bigint, 'the zero price stays in the history');

select lives_ok($$select public.create_import_batch('simplygest', 'product', 'isz-3', repeat('c', 64), 'c3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"c4000000-0000-4000-8000-000000000001","createMissingCategories":true,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'a third batch (a changed file) is created');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'isz-3'),
  $j$[
    {"rowNumber":4,"externalId":"S3","payload":{"name":"GALLETITAS X","unitType":"UNIT","sku":"S3","priceCents":0,"costCents":90000,"supplierName":"Distribuidora X"}},
    {"rowNumber":10,"externalId":"S9","payload":{"name":"Pepsi","unitType":"UNIT","sku":"S9","priceCents":310000,"supplierName":"Distribuidora X"}},
    {"rowNumber":13,"externalId":"S12","payload":{"name":"Cola de otro codigo","unitType":"UNIT","sku":"S12","priceCents":1000,"supplierName":"COCA COLA S.A.","supplierCode":"p1"}},
    {"rowNumber":14,"externalId":"S13","payload":{"name":"Sin proveedor ahora","unitType":"UNIT","sku":"S13","priceCents":2000}}
  ]$j$::jsonb)$t$, 'changed rows are staged');
select is(
  (public.preview_import_batch((select id from public.import_batches where file_name = 'isz-3')) -> 'summary') - 'errors' - 'byReason',
  '{"totalRows":4,"pending":0,"create":2,"update":2,"ignore":0,"error":0}'::jsonb,
  'preview of a changed file: 2 updates, 2 new products'
);
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'isz-3')) -> 'result', '{"created":2,"updated":2,"ignored":0,"skippedErrors":0}'::jsonb, 'the changed file is applied');
select is(
  (select pp.price_cents from public.product_prices pp where pp.product_id = (select id from public.products where sku = 'S3') and pp.valid_to is null),
  180000::bigint, 'a 0 in the file never overwrites a price that was already set'
);
select is((select count(*) from public.product_prices where product_id = (select id from public.products where sku = 'S3')), 2::bigint, 'and creates no new price row');
select is((select cost_cents from public.product_costs where product_id = (select id from public.products where sku = 'S3') and valid_to is null), 90000::bigint, 'the changed cost of that row was applied');
select is(
  (select s.name from public.product_suppliers ps join public.suppliers s on s.id = ps.supplier_id where ps.product_id = (select id from public.products where sku = 'S9') and ps.is_primary),
  'Distribuidora X', 'a changed supplier becomes the new primary'
);
select is((select count(*) from public.product_suppliers where product_id = (select id from public.products where sku = 'S9')), 2::bigint, 'the previous supplier stays as a secondary link');
select is(
  (select s.name from public.product_suppliers ps join public.suppliers s on s.id = ps.supplier_id where ps.product_id = (select id from public.products where sku = 'S12') and ps.is_primary),
  'Coca-Cola FEMSA', 'a row with a known supplier CODE reuses that supplier even if the name is spelled differently'
);
select is((select count(*) from public.suppliers), 3::bigint, 'still only 3 suppliers: nothing was duplicated by name variants');
select is((select name from public.suppliers where code = 'P1'), 'Coca-Cola FEMSA', 'the supplier name was not rewritten by a differently spelled row');
select is((select count(*) from public.product_suppliers ps join public.products p on p.id = ps.product_id where p.sku = 'S13'), 0::bigint, 'a new product without supplier is created without one');
select is((select count(*) from public.stock_movements), 0::bigint, 'still no stock movement after the changed import');

-- ---------------------------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.list_import_batch_suppliers((select id from public.import_batches where file_name = 'isz-1'))$$, '42501', null, 'an employee cannot read the import supplier audit');
select ok(not has_function_privilege('anon', 'public.list_import_batch_suppliers(uuid)', 'EXECUTE'), 'anonymous cannot read it either');
select ok(not has_function_privilege('authenticated', 'app_private.import_ensure_supplier(public.import_batches,text,text)', 'EXECUTE'), 'the supplier writer used by the importer is private');

select * from finish();
rollback;
