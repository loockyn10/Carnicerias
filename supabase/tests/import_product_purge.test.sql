begin;

create extension if not exists pgtap with schema extensions;
select plan(64);

-- Covers 202610030059: purga controlada (hard delete) de productos importados cuya CANTIDAD ORIGINAL de SimplyGest era <= 0.
-- Fixture: Central (productiva) + Avenida; productos importados de verdad por el motor de importación (para que
-- tengan vínculo externo y fila CREATE), un producto de carnicería cargado a mano que la importación ADOPTA por SKU,
-- y productos con historia (venta, movimiento de stock), habilitados en Avenida o vinculados a otro sistema.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ipp-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"IPP Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ipp-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"IPP Employee"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values ('f2000000-0000-4000-8000-000000000001', 'IPP Org', 'ipp-org');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA');
update public.organizations set production_branch_id = 'f3000000-0000-4000-8000-000000000001' where id = 'f2000000-0000-4000-8000-000000000001';
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Almacen', 'almacen');

-- Producto de carnicería cargado a mano ANTES de la importación (Central lo tiene habilitado, el archivo lo adopta por SKU).
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Chorizo manual', 'chorizo-manual', 'MAN-1', 'UNIT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id) values
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001');
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', null, 120000, now() - interval '1 day');

-- ---------------------------------------------------------------------------------------------
-- Importación real (motor existente): 9 productos nuevos + la adopción del manual por SKU.
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$select public.create_import_batch('simplygest', 'product', 'ipp-1', repeat('b', 64), 'f3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"f4000000-0000-4000-8000-000000000001","linkExistingBy":["sku"]}'::jsonb)$$, 'the import batch is created');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'ipp-1'),
  $j$[
    {"rowNumber":2,"externalId":"Z1","payload":{"name":"Yerba sin stock","unitType":"UNIT","sku":"Z1","barcodes":["7790000000011"],"priceCents":150000,"costCents":90000,"supplierName":"Molinos"}},
    {"rowNumber":3,"externalId":"Z2","payload":{"name":"Arroz negativo","unitType":"UNIT","sku":"Z2","barcodes":["7790000000012"],"priceCents":90000}},
    {"rowNumber":4,"externalId":"Z3","payload":{"name":"Fideos vendidos","unitType":"UNIT","sku":"Z3","priceCents":80000}},
    {"rowNumber":5,"externalId":"Z4","payload":{"name":"Aceite con movimiento","unitType":"UNIT","sku":"Z4","priceCents":250000}},
    {"rowNumber":6,"externalId":"Z5","payload":{"name":"Harina en Avenida","unitType":"UNIT","sku":"Z5","priceCents":70000}},
    {"rowNumber":7,"externalId":"Z6","payload":{"name":"Azucar de dos fuentes","unitType":"UNIT","sku":"Z6","priceCents":60000}},
    {"rowNumber":8,"externalId":"Z7","payload":{"name":"Sal con referencia rara","unitType":"UNIT","sku":"Z7","priceCents":30000,"barcodes":["7790000000017"]}},
    {"rowNumber":9,"externalId":"P1","payload":{"name":"Cafe con stock","unitType":"UNIT","sku":"P1","priceCents":500000}},
    {"rowNumber":10,"externalId":"Z8","payload":{"name":"Te sin precio","unitType":"UNIT","sku":"Z8","priceCents":0}},
    {"rowNumber":11,"externalId":"MAN-1","payload":{"name":"Chorizo manual","unitType":"UNIT","sku":"MAN-1","priceCents":120000}}
  ]$j$::jsonb)$t$, 'ten rows are staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'ipp-1'))$$, 'the batch is previewed');
select is(
  public.apply_import_batch((select id from public.import_batches where file_name = 'ipp-1')) -> 'result',
  '{"created":9,"updated":1,"ignored":0,"skippedErrors":0}'::jsonb,
  'apply creates 9 products and ADOPTS the manual one (so it has a link but was not created by the import)'
);

-- Datos de catálogo y de historia sobre los productos importados (como superusuario: el fixture, no el flujo).
reset role;
insert into public.product_weight_discounts (organization_id, product_id, branch_id, minimum_grams, discount_type, discount_value, active, valid_from)
select 'f2000000-0000-4000-8000-000000000001', id, null, 2000, 'PERCENTAGE', 1000, true, now() from public.products where sku = 'Z1';
insert into public.branch_product_stock_settings (organization_id, branch_id, product_id, minimum_stock_grams, target_stock_grams, updated_by)
select 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', id, 1, 5, 'f1000000-0000-4000-8000-000000000001' from public.products where sku = 'Z1';
-- Z3: vendido
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('f6000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'COMPLETED', 80000, 0, now());
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents)
select 'f6000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', id, 'Fideos vendidos', 1, 80000, 80000, 80000, 80000 from public.products where sku = 'Z3';
-- Z4: movimiento de stock real (un ajuste)
insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id, occurred_at)
select 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', id, 'ADJUSTMENT_POSITIVE', 4, 'f1000000-0000-4000-8000-000000000001', now() from public.products where sku = 'Z4';
-- Z5: además habilitado en Avenida
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', id from public.products where sku = 'Z5';
-- Z6: vinculado también a otro sistema de origen
insert into public.external_entity_links (organization_id, source_system, entity_type, external_id, internal_id, content_hash)
select 'f2000000-0000-4000-8000-000000000001', 'otro_sistema', 'product', 'OTRO-9', id, repeat('c', 64) from public.products where sku = 'Z6';
-- Z7: una referencia que el clasificador no conoce (simula una tabla futura con FK restrict hacia products)
create table public.zz_future_product_ref (
  id serial primary key, product_id uuid not null, organization_id uuid not null,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict
);
insert into public.zz_future_product_ref (product_id, organization_id)
select id, organization_id from public.products where sku = 'Z7';

-- Foto previa de lo que NO debe cambiar.
create temp table before_counts as
select (select count(*) from public.stock_movements) as movements,
       (select count(*) from public.sale_items) as sale_items,
       (select count(*) from public.branch_product_assortment where branch_id = 'f3000000-0000-4000-8000-000000000002') as avenida_assortment,
       (select count(*) from public.suppliers) as suppliers,
       (select count(*) from public.categories) as categories,
       (select count(*) from public.products) as products;
grant all on before_counts to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Validación de entrada
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.preview_import_product_purge('simplygest', '[{"externalId":"P1","quantity":3}]'::jsonb)$$, '22023', null, 'CANTIDAD > 0 is never a candidate (rejected, not silently skipped)');
select throws_ok($$select public.preview_import_product_purge('simplygest', '[{"externalId":"P1","quantity":"0.5"}]'::jsonb)$$, '22023', null, 'a fractional positive CANTIDAD is never a candidate either');
select throws_ok($$select public.preview_import_product_purge('simplygest', '[{"externalId":"Z1"}]'::jsonb)$$, '22023', null, 'a candidate without its original CANTIDAD is rejected');
select throws_ok($$select public.preview_import_product_purge('simplygest', '[{"externalId":"Z1","quantity":"abc"}]'::jsonb)$$, '22023', null, 'a non-numeric CANTIDAD is rejected');
select throws_ok($$select public.preview_import_product_purge('simplygest', '[{"externalId":"Z1","quantity":0},{"externalId":"Z1","quantity":0}]'::jsonb)$$, '22023', null, 'a repeated code in the batch is rejected');
select throws_ok($$select public.preview_import_product_purge('simplygest', '[]'::jsonb)$$, '22023', null, 'an empty list is rejected');
select throws_ok($$select public.preview_import_product_purge('Bad System', '[{"externalId":"Z1","quantity":0}]'::jsonb)$$, '22023', null, 'an invalid source system is rejected');
select lives_ok($$select public.preview_import_product_purge('simplygest', '[{"externalId":"Z1","quantity":"-0"}]'::jsonb)$$, 'CANTIDAD 0 / -0 is a valid candidate');

-- ---------------------------------------------------------------------------------------------
-- Preview
-- ---------------------------------------------------------------------------------------------
create temp table candidates(j jsonb);
grant all on candidates to authenticated;
insert into candidates values ($j$[
  {"externalId":"Z1","quantity":0,"name":"Yerba sin stock"},
  {"externalId":"Z2","quantity":-3,"name":"Arroz negativo"},
  {"externalId":"Z3","quantity":0,"name":"Fideos vendidos"},
  {"externalId":"Z4","quantity":0,"name":"Aceite con movimiento"},
  {"externalId":"Z5","quantity":0,"name":"Harina en Avenida"},
  {"externalId":"Z6","quantity":0,"name":"Azucar de dos fuentes"},
  {"externalId":"Z7","quantity":0,"name":"Sal con referencia rara"},
  {"externalId":"MAN-1","quantity":0,"name":"Chorizo manual"},
  {"externalId":"NOEXISTE","quantity":0,"name":"Nunca importado"},
  {"externalId":"Z8","quantity":"-1.5","name":"Te sin precio"}
]$j$::jsonb);

select is(
  (public.preview_import_product_purge('simplygest', (select j from candidates)) -> 'summary'),
  '{"total":10,"delete":4,"blocked":5,"skipped":1}'::jsonb,
  'preview: Z1, Z2, Z7 and Z8 are deletable (Z7 only looks safe), five are blocked, one was never imported'
);
select is(
  (select jsonb_object_agg(i ->> 'externalId', i ->> 'verdict') from jsonb_array_elements(public.preview_import_product_purge('simplygest', (select j from candidates)) -> 'items') i),
  '{"Z1":"DELETE","Z2":"DELETE","Z3":"BLOCKED","Z4":"BLOCKED","Z5":"BLOCKED","Z6":"BLOCKED","Z7":"DELETE","Z8":"DELETE","MAN-1":"BLOCKED","NOEXISTE":"SKIP"}'::jsonb,
  'verdict per external code'
);
select is(
  (select jsonb_object_agg(i ->> 'externalId', i -> 'reasons') from jsonb_array_elements(public.preview_import_product_purge('simplygest', (select j from candidates)) -> 'items') i where i ->> 'verdict' <> 'DELETE'),
  '{"Z3":["HAS_SALES"],"Z4":["HAS_STOCK_MOVEMENTS","HAS_RESTOCK_EVENTS"],"Z5":["ENABLED_IN_OTHER_BRANCH"],"Z6":["LINKED_TO_OTHER_SOURCE"],"MAN-1":["NOT_CREATED_BY_IMPORT"],"NOEXISTE":["NOT_LINKED"]}'::jsonb,
  'every blocked/skipped candidate carries its reason (sale history, stock movement, other branch, other source, manual/adopted product, never imported)'
);
select is(
  (select i ->> 'productName' from jsonb_array_elements(public.preview_import_product_purge('simplygest', (select j from candidates)) -> 'items') i where i ->> 'externalId' = 'Z1'),
  'Yerba sin stock', 'the preview shows the product name from the database next to the code'
);
select is(
  (select i -> 'catalogRefs' from jsonb_array_elements(public.preview_import_product_purge('simplygest', (select j from candidates)) -> 'items') i where i ->> 'externalId' = 'Z1'),
  '{"costs":1,"prices":1,"barcodes":1,"suppliers":1,"assortment":1,"categories":1,"promotions":1,"externalLinks":1,"stockSettings":1,"pricingSettings":0}'::jsonb,
  'the preview counts the catalog relations that will go away with the product (including a per-product promotion and the external link)'
);
select is((select count(*) from public.products), (select products from before_counts), 'the preview deleted nothing');
select is((select count(*) from public.external_entity_links where source_system = 'simplygest' and entity_type = 'product'), 10::bigint, 'the preview kept every external link');

-- ---------------------------------------------------------------------------------------------
-- Permisos: un empleado no puede ni previsualizar ni purgar
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.preview_import_product_purge('simplygest', '[{"externalId":"Z1","quantity":0}]'::jsonb)$$, '42501', null, 'an employee cannot preview the purge');
select throws_ok($$select public.purge_import_products('simplygest', '[{"externalId":"Z1","quantity":0}]'::jsonb, 1)$$, '42501', null, 'an employee cannot purge');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Purga
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.purge_import_products('simplygest', (select j from candidates), 5)$$, '40001', null, 'a stale preview count aborts the purge');
select throws_ok($$select public.purge_import_products('simplygest', (select j from candidates), null)$$, '22023', null, 'the preview count is mandatory');
select is((select count(*) from public.products), (select products from before_counts), 'an aborted purge deleted nothing');

create temp table purge_result(r jsonb);
grant all on purge_result to authenticated;
insert into purge_result select public.purge_import_products('simplygest', (select j from candidates), 4);

select is((select r -> 'summary' from purge_result), '{"requested":10,"deleted":3,"blocked":6,"skipped":1,"staleLinksRemoved":0}'::jsonb,
  'purge: Z1, Z2 and Z8 are deleted; the five blocked stay; Z7 is reported as an unexpected reference; NOEXISTE is skipped');
select is((select jsonb_agg(d ->> 'externalId' order by d ->> 'externalId') from purge_result, jsonb_array_elements(r -> 'deleted') d), '["Z1","Z2","Z8"]'::jsonb, 'the deleted list names code, product and original quantity');
select is((select jsonb_agg(b ->> 'externalId' order by b ->> 'externalId') from purge_result, jsonb_array_elements(r -> 'blocked') b), '["MAN-1","Z3","Z4","Z5","Z6","Z7"]'::jsonb, 'the blocked list is reported explicitly');
select is((select b -> 'reasons' from purge_result, jsonb_array_elements(r -> 'blocked') b where b ->> 'externalId' = 'Z7'), '["UNEXPECTED_REFERENCE"]'::jsonb, 'an FK the classifier did not know about blocks that product without deleting it');
select is((select d -> 'quantity' from purge_result, jsonb_array_elements(r -> 'deleted') d where d ->> 'externalId' = 'Z2'), '-3'::jsonb, 'the original quantity is echoed back');

select is((select count(*) from public.products where sku in ('Z1', 'Z2', 'Z8')), 0::bigint, 'the deletable products are REALLY gone from products (not archived)');
select is((select count(*) from public.products where sku in ('Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'P1', 'MAN-1')), 7::bigint, 'blocked products and the one with stock are intact');
select is((select count(*) from public.products where active = false), 0::bigint, 'nothing was archived or deactivated');
select is((select count(*) from public.product_prices pp where not exists (select 1 from public.products p where p.id = pp.product_id)), 0::bigint, 'no orphan prices');
select is((select count(*) from public.product_barcodes where barcode in ('7790000000011', '7790000000012')), 0::bigint, 'their barcodes are gone');
select is((select count(*) from public.product_suppliers ps where not exists (select 1 from public.products p where p.id = ps.product_id)), 0::bigint, 'their supplier links are gone');
select is((select count(*) from public.suppliers), (select suppliers from before_counts), 'the supplier entity itself stays');
select is((select count(*) from public.categories), (select categories from before_counts), 'categories stay');
select is((select count(*) from public.product_weight_discounts), 0::bigint, 'the per-product promotion went with its product');
select is((select count(*) from public.branch_product_stock_settings), 0::bigint, 'the stock policy went with its product');
select is((select count(*) from public.external_entity_links where source_system = 'simplygest' and entity_type = 'product' and external_id in ('Z1', 'Z2', 'Z8')), 0::bigint, 'their external links were cleaned up');
select is((select count(*) from public.external_entity_links where source_system = 'simplygest' and entity_type = 'product' and external_id in ('Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'MAN-1', 'P1')), 7::bigint, 'the links of the products that stay are untouched');
select is((select count(*) from public.stock_movements), (select movements from before_counts), 'no stock movement was touched');
select is((select count(*) from public.sale_items), (select sale_items from before_counts), 'no sale history was touched');
select is((select count(*) from public.branch_product_assortment where branch_id = 'f3000000-0000-4000-8000-000000000002'), (select avenida_assortment from before_counts), 'Avenida keeps its assortment');
select is((select name from public.products where sku = 'MAN-1'), 'Chorizo manual', 'the historical butcher product loaded before the import is untouched');
select is((select count(*) from public.product_prices where product_id = (select id from public.products where sku = 'Z7')), 1::bigint, 'the product rolled back by an unexpected reference keeps its prices (its sub-transaction was undone)');
select is((select count(*) from public.audit_logs where event_type = 'PRODUCTS_IMPORT_PURGE'), 3::bigint, 'one audit record per deleted product');
select is((select before_data -> 'purge' ->> 'externalId' from public.audit_logs where event_type = 'PRODUCTS_IMPORT_PURGE' and before_data ->> 'sku' = 'Z2'), 'Z2', 'the audit record keeps the external code and the product snapshot');
select is((select before_data -> 'purge' ->> 'originalQuantity' from public.audit_logs where event_type = 'PRODUCTS_IMPORT_PURGE' and before_data ->> 'sku' = 'Z2'), '-3', 'the audit record keeps the original quantity');

-- ---------------------------------------------------------------------------------------------
-- Idempotencia: repetir la purga no hace nada más
-- ---------------------------------------------------------------------------------------------
select is(
  (public.preview_import_product_purge('simplygest', (select j from candidates)) -> 'summary'),
  '{"total":10,"delete":1,"blocked":5,"skipped":4}'::jsonb,
  'second preview: the three deleted products are now NOT_LINKED (skipped, with the never-imported code); only the rolled-back Z7 still looks deletable'
);
reset role;
drop table public.zz_future_product_ref;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table purge_result_2(r jsonb);
grant all on purge_result_2 to authenticated;
insert into purge_result_2 select public.purge_import_products('simplygest', (select j from candidates), 1);
select is((select r -> 'summary' from purge_result_2), '{"requested":10,"deleted":1,"blocked":5,"skipped":4,"staleLinksRemoved":0}'::jsonb,
  'second purge only deletes Z7 (its unexpected reference is gone); nothing else changes');
insert into purge_result_2 select public.purge_import_products('simplygest', (select j from candidates), 0);
select is((select r -> 'summary' from purge_result_2 offset 1), '{"requested":10,"deleted":0,"blocked":5,"skipped":5,"staleLinksRemoved":0}'::jsonb, 'third purge is a no-op');
select is((select count(*) from public.products where sku in ('Z3', 'Z4', 'Z5', 'Z6', 'P1', 'MAN-1')), 6::bigint, 'the protected products survive every run');

-- Un vínculo huérfano (el producto ya no existe) se limpia en vez de dejar que una reimportación lo "re-relinkee".
reset role;
insert into public.external_entity_links (organization_id, source_system, entity_type, external_id, internal_id, content_hash)
values ('f2000000-0000-4000-8000-000000000001', 'simplygest', 'product', 'HUERFANO', 'f7000000-0000-4000-8000-0000000000ff', repeat('d', 64));
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(
  (public.purge_import_products('simplygest', '[{"externalId":"HUERFANO","quantity":0}]'::jsonb, 0) -> 'summary'),
  '{"requested":1,"deleted":0,"blocked":0,"skipped":1,"staleLinksRemoved":1}'::jsonb,
  'a stale link whose product no longer exists is removed'
);
select is((select count(*) from public.external_entity_links where external_id = 'HUERFANO'), 0::bigint, 'the stale link is gone');

-- ---------------------------------------------------------------------------------------------
-- Sync del POS: un producto borrado de verdad llega a removedProductIds
-- ---------------------------------------------------------------------------------------------
reset role;
-- Un producto más, ya sincronizado por un dispositivo, y después purgado.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.register_pos_device('f8000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'IPP POS')$$, 'a Central device is registered');
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'ipp-2', repeat('e', 64), 'f3000000-0000-4000-8000-000000000001', '{"defaultCategoryId":"f4000000-0000-4000-8000-000000000001"}'::jsonb)$$, 'a second batch is created');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'ipp-2'),
  '[{"rowNumber":2,"externalId":"Y1","payload":{"name":"Producto sincronizado","unitType":"UNIT","sku":"Y1","priceCents":50000}}]'::jsonb)$t$, 'a row is staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'ipp-2'))$$, 'previewed');
select lives_ok($$select public.apply_import_batch((select id from public.import_batches where file_name = 'ipp-2'))$$, 'applied');
create temp table first_pull(cursor bigint, product_id uuid);
grant all on first_pull to authenticated;
insert into first_pull
select (public.pull_pos_state('f8000000-0000-4000-8000-000000000001', 0) ->> 'cursor')::bigint,
       (select (i ->> 'productId')::uuid from jsonb_array_elements(public.pull_pos_state('f8000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Producto sincronizado');
select ok((select product_id from first_pull) is not null, 'the device received the product in its first pull');
select is((public.purge_import_products('simplygest', '[{"externalId":"Y1","quantity":0}]'::jsonb, 1) -> 'summary' ->> 'deleted')::int, 1, 'the synced product is purged');
select ok(
  (public.pull_pos_state('f8000000-0000-4000-8000-000000000001', (select cursor from first_pull)) -> 'removedProductIds') @> to_jsonb(array[(select product_id from first_pull)::text]),
  'the next incremental pull lists the hard-deleted product in removedProductIds so the POS drops it from SQLite'
);
select ok(
  not ((public.pull_pos_state('f8000000-0000-4000-8000-000000000001', 0) -> 'catalog') @> jsonb_build_array(jsonb_build_object('productName', 'Producto sincronizado'))),
  'and a fresh device (cursor 0) simply never receives it'
);

select * from finish();
rollback;
