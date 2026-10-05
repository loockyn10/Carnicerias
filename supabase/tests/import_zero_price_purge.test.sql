begin;

create extension if not exists pgtap with schema extensions;
select plan(78);

-- Covers 202610050062: purga (hard delete) de productos importados cuyo PRECIO VIGENTE existente es $0.
-- Fixture: Central (productiva) + Avenida; productos importados de verdad por el motor de importación (vínculo externo y
-- fila CREATE), uno SIN ningún precio ("Media res cerdo": nunca candidato), uno con $0 cerrado en el pasado y un precio
-- vigente > 0, uno con $0 global y precio vigente > 0 de Central, productos de carnicería ($0) adoptados o sin vínculo,
-- y productos $0 con historia (venta, movimiento de stock), habilitados en Avenida o vinculados a otro origen.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'izp-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"IZP Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'izp-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"IZP Employee"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values ('e2000000-0000-4000-8000-000000000001', 'IZP Org', 'izp-org');
insert into public.branches (id, organization_id, name, code) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA');
update public.organizations set production_branch_id = 'e3000000-0000-4000-8000-000000000001' where id = 'e2000000-0000-4000-8000-000000000001';
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Almacen', 'almacen');

-- Productos de carnicería cargados a mano ANTES de la importación, ambos con precio $0 vigente:
--   MAN-0 lo ADOPTA la importación por SKU (tiene vínculo pero no lo creó ella); MAN-2 no tiene ningún vínculo externo.
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Chorizo adoptado', 'chorizo-adoptado', 'MAN-0', 'UNIT'),
  ('e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Morcilla manual', 'morcilla-manual', 'MAN-2', 'UNIT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id) values
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002');
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', null, 0, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002', null, 0, now() - interval '1 day');

-- ---------------------------------------------------------------------------------------------
-- Importación real (motor existente)
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$select public.create_import_batch('simplygest', 'product', 'izp-1', repeat('b', 64), 'e3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"e4000000-0000-4000-8000-000000000001","linkExistingBy":["sku"]}'::jsonb)$$, 'the import batch is created');
select lives_ok($t$select public.stage_import_rows(
  (select id from public.import_batches where file_name = 'izp-1'),
  $j$[
    {"rowNumber":2,"externalId":"Z1","payload":{"name":"Yerba cero","unitType":"UNIT","sku":"Z1","barcodes":["7790000000011"],"priceCents":0,"costCents":90000,"supplierName":"Molinos"}},
    {"rowNumber":3,"externalId":"Z2","payload":{"name":"Arroz cero","unitType":"UNIT","sku":"Z2","barcodes":["7790000000012"],"priceCents":0}},
    {"rowNumber":4,"externalId":"Z3","payload":{"name":"Fideos vendidos","unitType":"UNIT","sku":"Z3","priceCents":0}},
    {"rowNumber":5,"externalId":"Z4","payload":{"name":"Aceite con movimiento","unitType":"UNIT","sku":"Z4","priceCents":0}},
    {"rowNumber":6,"externalId":"Z5","payload":{"name":"Harina en Avenida","unitType":"UNIT","sku":"Z5","priceCents":0}},
    {"rowNumber":7,"externalId":"Z6","payload":{"name":"Azucar de dos fuentes","unitType":"UNIT","sku":"Z6","priceCents":0}},
    {"rowNumber":8,"externalId":"Z7","payload":{"name":"Sal con referencia rara","unitType":"UNIT","sku":"Z7","priceCents":0,"barcodes":["7790000000017"]}},
    {"rowNumber":9,"externalId":"Z9","payload":{"name":"Cafe con precio en Central","unitType":"UNIT","sku":"Z9","priceCents":0}},
    {"rowNumber":10,"externalId":"P1","payload":{"name":"Cafe con precio","unitType":"UNIT","sku":"P1","priceCents":500000}},
    {"rowNumber":11,"externalId":"P2","payload":{"name":"Te con cero viejo","unitType":"UNIT","sku":"P2","priceCents":300000}},
    {"rowNumber":12,"externalId":"NOPRICE","payload":{"name":"Media res cerdo","unitType":"WEIGHT","sku":"NOPRICE"}},
    {"rowNumber":13,"externalId":"MAN-0","payload":{"name":"Chorizo adoptado","unitType":"UNIT","sku":"MAN-0","priceCents":0}}
  ]$j$::jsonb)$t$, 'twelve rows are staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'izp-1'))$$, 'the batch is previewed');
select is(
  public.apply_import_batch((select id from public.import_batches where file_name = 'izp-1')) -> 'result',
  '{"created":11,"updated":1,"ignored":0,"skippedErrors":0}'::jsonb,
  'apply creates 11 products and ADOPTS the manual MAN-0 (it has a link but was not created by the import)'
);

-- Datos de catálogo y de historia (como superusuario: es el fixture, no el flujo).
reset role;
-- Z1: pack (UNIT) con su versión, promoción propia y política de stock.
update public.products set pack_size_units = 6, pack_discount_bps = 2000 where sku = 'Z1';
insert into public.product_weight_discounts (organization_id, product_id, branch_id, minimum_grams, discount_type, discount_value, active, valid_from)
select 'e2000000-0000-4000-8000-000000000001', id, null, 2000, 'PERCENTAGE', 1000, true, now() from public.products where sku = 'Z1';
insert into public.branch_product_stock_settings (organization_id, branch_id, product_id, minimum_stock_grams, target_stock_grams, updated_by)
select 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', id, 1, 5, 'e1000000-0000-4000-8000-000000000001' from public.products where sku = 'Z1';
-- Z3: vendido
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'COMPLETED', 80000, 0, now());
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents)
select 'e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', id, 'Fideos vendidos', 1, 80000, 80000, 80000, 80000 from public.products where sku = 'Z3';
-- Z4: movimiento de stock real
insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id, occurred_at)
select 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', id, 'ADJUSTMENT_POSITIVE', 4, 'e1000000-0000-4000-8000-000000000001', now() from public.products where sku = 'Z4';
-- Z5: además habilitado en Avenida
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', id from public.products where sku = 'Z5';
-- Z6: vinculado también a otro sistema de origen
insert into public.external_entity_links (organization_id, source_system, entity_type, external_id, internal_id, content_hash)
select 'e2000000-0000-4000-8000-000000000001', 'otro_sistema', 'product', 'OTRO-9', id, repeat('c', 64) from public.products where sku = 'Z6';
-- Z7: una referencia que el clasificador no conoce (simula una tabla futura con FK restrict hacia products)
create table public.zz_future_product_ref (
  id serial primary key, product_id uuid not null, organization_id uuid not null,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict
);
insert into public.zz_future_product_ref (product_id, organization_id)
select id, organization_id from public.products where sku = 'Z7';
-- Z9: $0 global pero con un precio vigente > 0 en Central (no está realmente "sin precio").
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from)
select 'e2000000-0000-4000-8000-000000000001', id, 'e3000000-0000-4000-8000-000000000001', 700000, now() from public.products where sku = 'Z9';
-- P2: un $0 CERRADO en el pasado (el vigente es 300000): ya no tiene precio vigente 0.
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from, valid_to)
select 'e2000000-0000-4000-8000-000000000001', id, null, 0, now() - interval '3 days', now() - interval '2 days' from public.products where sku = 'P2';

create temp table before_counts as
select (select count(*) from public.stock_movements) as movements,
       (select count(*) from public.sale_items) as sale_items,
       (select count(*) from public.branch_product_assortment where branch_id = 'e3000000-0000-4000-8000-000000000002') as avenida_assortment,
       (select count(*) from public.suppliers) as suppliers,
       (select count(*) from public.categories) as categories,
       (select count(*) from public.products) as products,
       (select count(*) from public.external_entity_links) as links;
grant all on before_counts to authenticated;

select is((select pack_size_units from public.products where sku = 'Z1'), 6, 'fixture: Z1 has a pack configured');
select is((select count(*) from public.product_pack_versions where product_id = (select id from public.products where sku = 'Z1')), 1::bigint, 'fixture: Z1 has its pack version row');
select is((select count(*) from public.product_prices pp join public.products p on p.id = pp.product_id where p.sku = 'NOPRICE'), 0::bigint, 'fixture: "Media res cerdo" has NO price row at all');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Preview
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.preview_import_zero_price_purge('Bad System')$$, '22023', null, 'an invalid source system is rejected');
select throws_ok($$select public.preview_import_zero_price_purge(null)$$, '22023', null, 'a null source system is rejected');

create temp table pv(j jsonb);
grant all on pv to authenticated;
insert into pv select public.preview_import_zero_price_purge('simplygest');

select is(
  (select j -> 'summary' from pv),
  '{"total":10,"blocked":7,"notImported":1,"deleteSafe":3}'::jsonb,
  'preview: 10 candidates with a current $0 price; Z1, Z2 and Z7 are DELETE_SAFE (Z7 only looks safe), seven are BLOCKED, one of them was never imported'
);
select is(
  (select jsonb_object_agg(i ->> 'sku', i ->> 'verdict') from pv, jsonb_array_elements(j -> 'items') i),
  '{"Z1":"DELETE_SAFE","Z2":"DELETE_SAFE","Z3":"BLOCKED","Z4":"BLOCKED","Z5":"BLOCKED","Z6":"BLOCKED","Z7":"DELETE_SAFE","Z9":"BLOCKED","MAN-0":"BLOCKED","MAN-2":"BLOCKED"}'::jsonb,
  'verdict per product'
);
select is(
  (select jsonb_object_agg(i ->> 'sku', i -> 'reasons') from pv, jsonb_array_elements(j -> 'items') i where i ->> 'verdict' = 'BLOCKED'),
  '{"Z3":["HAS_SALES"],"Z4":["HAS_STOCK_MOVEMENTS","HAS_RESTOCK_EVENTS"],"Z5":["ENABLED_IN_OTHER_BRANCH"],"Z6":["LINKED_TO_OTHER_SOURCE"],"Z9":["HAS_POSITIVE_CURRENT_PRICE"],"MAN-0":["NOT_CREATED_BY_IMPORT"],"MAN-2":["NOT_IMPORTED_FROM_SOURCE"]}'::jsonb,
  'every blocked candidate carries its reason (sale, stock movement, other branch, other source, price > 0 too, adopted manual product, never imported)'
);
select is((select j -> 'blockedByReason' from pv),
  '{"HAS_SALES":1,"HAS_RESTOCK_EVENTS":1,"HAS_STOCK_MOVEMENTS":1,"ENABLED_IN_OTHER_BRANCH":1,"NOT_CREATED_BY_IMPORT":1,"LINKED_TO_OTHER_SOURCE":1,"HAS_POSITIVE_CURRENT_PRICE":1,"NOT_IMPORTED_FROM_SOURCE":1}'::jsonb,
  'the preview aggregates blockers by reason');
select is(
  (select count(*) from pv, jsonb_array_elements(j -> 'items') i where i ->> 'sku' in ('NOPRICE', 'P1', 'P2')),
  0::bigint,
  '"Media res cerdo" (no price at all), a priced product and a product whose $0 is closed are NOT candidates'
);
select is(
  (select i ->> 'productName' from pv, jsonb_array_elements(j -> 'items') i where i ->> 'sku' = 'Z1'),
  'Yerba cero', 'the preview shows the product name next to the code'
);
select is(
  (select i -> 'catalogRefs' from pv, jsonb_array_elements(j -> 'items') i where i ->> 'sku' = 'Z1'),
  '{"costs":1,"prices":1,"barcodes":1,"suppliers":1,"assortment":1,"categories":1,"promotions":1,"externalLinks":1,"stockSettings":1,"pricingSettings":0}'::jsonb,
  'the preview counts the catalog relations that go away with the product'
);
select is((select count(*) from public.products), (select products from before_counts), 'the preview deleted nothing');
select is((select count(*) from public.external_entity_links), (select links from before_counts), 'the preview kept every external link');

-- ---------------------------------------------------------------------------------------------
-- Permisos y validación del apply
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.preview_import_zero_price_purge('simplygest')$$, '42501', null, 'an employee cannot preview the zero-price purge');
select throws_ok($$select public.purge_import_zero_price_products('simplygest', 3)$$, '42501', null, 'an employee cannot purge');
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select throws_ok($$select public.purge_import_zero_price_products('simplygest', 5)$$, '40001', null, 'a stale preview count aborts the purge');
select throws_ok($$select public.purge_import_zero_price_products('simplygest', null)$$, '22023', null, 'the preview count is mandatory');
select throws_ok($$select public.purge_import_zero_price_products('simplygest', 3, 0)$$, '22023', null, 'a batch size < 1 is rejected');
select throws_ok($$select public.purge_import_zero_price_products('Bad System', 3)$$, '22023', null, 'an invalid source system is rejected');
select is((select count(*) from public.products), (select products from before_counts), 'an aborted purge deleted nothing');

-- ---------------------------------------------------------------------------------------------
-- Apply: primero una tanda de 1 (Z2, orden por nombre), después el resto
-- ---------------------------------------------------------------------------------------------
create temp table purge_result(r jsonb);
grant all on purge_result to authenticated;
insert into purge_result select public.purge_import_zero_price_products('simplygest', 3, 1);
select is((select r -> 'summary' from purge_result), '{"candidates":10,"expectedDelete":3,"deleted":1,"blocked":7,"remainingDeletable":2}'::jsonb,
  'a batch of 1 deletes one product and reports how many deletable ones remain');
select is((select r -> 'deleted' -> 0 ->> 'sku' from purge_result), 'Z2', 'the first deletable (by name) went first');
select is((select count(*) from public.products), (select products from before_counts) - 1, 'only one product was deleted');
delete from purge_result;

insert into purge_result select public.purge_import_zero_price_products('simplygest', 2);
select is((select r -> 'summary' from purge_result), '{"candidates":9,"expectedDelete":2,"deleted":1,"blocked":8,"remainingDeletable":1}'::jsonb,
  'purge: Z1 is deleted; Z7 is reported as an unexpected reference; the seven blocked stay');
select is((select jsonb_agg(d ->> 'sku') from purge_result, jsonb_array_elements(r -> 'deleted') d), '["Z1"]'::jsonb, 'the deleted list names the product');
select is((select b -> 'reasons' from purge_result, jsonb_array_elements(r -> 'blocked') b where b ->> 'sku' = 'Z7'), '["UNEXPECTED_REFERENCE"]'::jsonb, 'an FK nobody knew about blocks that product without deleting it');
select is((select jsonb_agg(b ->> 'sku' order by b ->> 'sku') from purge_result, jsonb_array_elements(r -> 'blocked') b), '["MAN-0","MAN-2","Z3","Z4","Z5","Z6","Z7","Z9"]'::jsonb, 'the blocked list is reported explicitly');
select is((select d -> 'removed' ->> 'packVersions' from purge_result, jsonb_array_elements(r -> 'deleted') d where d ->> 'sku' = 'Z1'), '1', 'the pack versions removed with the product are reported');

select is((select count(*) from public.products where sku in ('Z1', 'Z2')), 0::bigint, 'the deletable products are REALLY gone from products (not archived)');
select is((select count(*) from public.products where sku in ('Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'Z9', 'P1', 'P2', 'NOPRICE', 'MAN-0', 'MAN-2')), 11::bigint, 'blocked, priced and priceless products are intact (including "Media res cerdo")');
select is((select count(*) from public.products where active = false), 0::bigint, 'nothing was archived or deactivated');
select is((select count(*) from public.product_prices pp where not exists (select 1 from public.products p where p.id = pp.product_id)), 0::bigint, 'no orphan prices');
select is((select count(*) from public.product_barcodes where barcode in ('7790000000011', '7790000000012')), 0::bigint, 'their barcodes are gone');
select is((select count(*) from public.product_suppliers ps where not exists (select 1 from public.products p where p.id = ps.product_id)), 0::bigint, 'no orphan supplier links');
select is((select count(*) from public.suppliers), (select suppliers from before_counts), 'the supplier entity itself stays');
select is((select count(*) from public.categories), (select categories from before_counts), 'categories stay');
select is((select count(*) from public.product_pack_versions where product_id not in (select id from public.products)), 0::bigint, 'no orphan pack versions');
select is((select count(*) from public.product_pack_versions), 0::bigint, 'the pack version of Z1 went with it');
select is((select count(*) from public.product_weight_discounts), 0::bigint, 'the per-product promotion went with its product');
select is((select count(*) from public.branch_product_stock_settings), 0::bigint, 'the stock policy went with its product');
select is((select count(*) from public.external_entity_links where source_system = 'simplygest' and external_id in ('Z1', 'Z2')), 0::bigint, 'their external links were cleaned up');
select is((select count(*) from public.external_entity_links where source_system = 'simplygest' and external_id in ('Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'Z9', 'P1', 'P2', 'NOPRICE', 'MAN-0')), 10::bigint, 'the links of the products that stay are untouched');
select is((select count(*) from public.stock_movements), (select movements from before_counts), 'no stock movement was touched');
select is((select count(*) from public.sale_items), (select sale_items from before_counts), 'no sale history was touched');
select is((select count(*) from public.branch_product_assortment where branch_id = 'e3000000-0000-4000-8000-000000000002'), (select avenida_assortment from before_counts), 'Avenida keeps its assortment');
select is((select count(*) from public.product_prices where product_id = (select id from public.products where sku = 'Z7')), 1::bigint, 'the product rolled back by an unexpected reference keeps its price (its sub-transaction was undone)');
select is((select count(*) from public.product_prices where product_id = (select id from public.products where sku = 'Z9')), 2::bigint, 'the product with a positive Central price keeps both prices');
select is((select count(*) from public.audit_logs where event_type = 'PRODUCTS_IMPORT_PURGE'), 2::bigint, 'one audit record per deleted product');
select is((select before_data -> 'purge' ->> 'mode' from public.audit_logs where event_type = 'PRODUCTS_IMPORT_PURGE' and before_data ->> 'sku' = 'Z1'), 'ZERO_CURRENT_PRICE', 'the audit record says which purge mode deleted it');
select is((select before_data -> 'purge' ->> 'externalId' from public.audit_logs where event_type = 'PRODUCTS_IMPORT_PURGE' and before_data ->> 'sku' = 'Z1'), 'Z1', 'the audit record keeps the external code and the product snapshot');

-- ---------------------------------------------------------------------------------------------
-- Idempotencia
-- ---------------------------------------------------------------------------------------------
select is((public.preview_import_zero_price_purge('simplygest') -> 'summary'), '{"total":8,"blocked":7,"notImported":1,"deleteSafe":1}'::jsonb,
  'second preview: the two deleted products are not candidates anymore; only the rolled-back Z7 still looks deletable');
reset role;
drop table public.zz_future_product_ref;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
delete from purge_result;
insert into purge_result select public.purge_import_zero_price_products('simplygest', 1);
select is((select r -> 'summary' from purge_result), '{"candidates":8,"expectedDelete":1,"deleted":1,"blocked":7,"remainingDeletable":0}'::jsonb, 'second purge only deletes Z7 (its unexpected reference is gone)');
delete from purge_result;
insert into purge_result select public.purge_import_zero_price_products('simplygest', 0);
select is((select r -> 'summary' from purge_result), '{"candidates":7,"expectedDelete":0,"deleted":0,"blocked":7,"remainingDeletable":0}'::jsonb, 'third purge is a no-op');
select is((select count(*) from public.products where sku in ('Z3', 'Z4', 'Z5', 'Z6', 'Z9', 'P1', 'P2', 'NOPRICE', 'MAN-0', 'MAN-2')), 10::bigint, 'the protected products survive every run');

-- ---------------------------------------------------------------------------------------------
-- El SKU, el barcode y el código externo se pueden reutilizar en una importación futura
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'izp-2', repeat('e', 64), 'e3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"e4000000-0000-4000-8000-000000000001"}'::jsonb)$$, 'a later import batch is created');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'izp-2'),
  '[{"rowNumber":2,"externalId":"Z1","payload":{"name":"Yerba cero","unitType":"UNIT","sku":"Z1","barcodes":["7790000000011"],"priceCents":125000,"supplierName":"Molinos"}}]'::jsonb)$t$, 'the purged product comes back in the file');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'izp-2'))$$, 'previewed');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'izp-2')) -> 'result',
  '{"created":1,"updated":0,"ignored":0,"skippedErrors":0}'::jsonb,
  'the purged SKU, barcode and external code are free: a future import CREATES the product with no conflict and no orphan link');
select is((select count(*) from public.external_entity_links l where l.source_system = 'simplygest' and l.entity_type = 'product' and not exists (select 1 from public.products p where p.id = l.internal_id)), 0::bigint, 'no orphan external links after the re-import');

-- ---------------------------------------------------------------------------------------------
-- Sync del POS: un producto borrado de verdad llega a removedProductIds
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.register_pos_device('e8000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'IZP POS')$$, 'a Central device is registered');
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'izp-3', repeat('f', 64), 'e3000000-0000-4000-8000-000000000001', '{"defaultCategoryId":"e4000000-0000-4000-8000-000000000001"}'::jsonb)$$, 'a third batch is created');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'izp-3'),
  '[{"rowNumber":2,"externalId":"Y1","payload":{"name":"Producto sincronizado","unitType":"UNIT","sku":"Y1","priceCents":0}}]'::jsonb)$t$, 'a row is staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'izp-3'))$$, 'previewed');
select lives_ok($$select public.apply_import_batch((select id from public.import_batches where file_name = 'izp-3'))$$, 'applied');
-- El catálogo del POS sólo lleva productos con precio vigente (un $0 lo tiene): el dispositivo lo recibe en su primer pull.
create temp table first_pull(cursor bigint, product_id uuid);
grant all on first_pull to authenticated;
insert into first_pull
select (public.pull_pos_state('e8000000-0000-4000-8000-000000000001', 0) ->> 'cursor')::bigint,
       (select (i ->> 'productId')::uuid from jsonb_array_elements(public.pull_pos_state('e8000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Producto sincronizado');
select ok((select product_id from first_pull) is not null, 'the device received the $0 product in its first pull');
select is(
  (public.purge_import_zero_price_products('simplygest', (public.preview_import_zero_price_purge('simplygest') -> 'summary' ->> 'deleteSafe')::int) -> 'summary' ->> 'deleted')::int,
  1, 'only the synced Y1 is purged (the re-imported Z1 now has a price, so it is not a candidate)');
select is((select count(*) from public.products where sku = 'Z1'), 1::bigint, 'the re-imported, priced Z1 is untouched');
select ok(
  (public.pull_pos_state('e8000000-0000-4000-8000-000000000001', (select cursor from first_pull)) -> 'removedProductIds') @> to_jsonb(array[(select product_id from first_pull)::text]),
  'the next incremental pull lists the hard-deleted product in removedProductIds so the POS drops it from SQLite'
);
select ok(
  not ((public.pull_pos_state('e8000000-0000-4000-8000-000000000001', 0) -> 'catalog') @> jsonb_build_array(jsonb_build_object('productName', 'Producto sincronizado'))),
  'and a fresh device (cursor 0) simply never receives it'
);

-- ---------------------------------------------------------------------------------------------
-- El modo por CANTIDAD (archivo SimplyGest) sigue igual: ignora el precio y manda la CANTIDAD original
-- ---------------------------------------------------------------------------------------------
select is(
  (select jsonb_object_agg(i ->> 'externalId', i ->> 'verdict') from jsonb_array_elements(public.preview_import_product_purge('simplygest',
    '[{"externalId":"P1","quantity":0},{"externalId":"Z3","quantity":0},{"externalId":"NOEXISTE","quantity":0}]'::jsonb) -> 'items') i),
  '{"P1":"DELETE","Z3":"BLOCKED","NOEXISTE":"SKIP"}'::jsonb,
  'quantity mode: a priced product with CANTIDAD 0 is deletable, the sold one is blocked, an unknown code is skipped');
select throws_ok($$select public.preview_import_product_purge('simplygest', '[{"externalId":"P1","quantity":3}]'::jsonb)$$, '22023', null, 'quantity mode: CANTIDAD > 0 is still rejected');
select is((public.purge_import_products('simplygest', '[{"externalId":"P1","quantity":0}]'::jsonb, 1) -> 'summary' ->> 'deleted')::int, 1, 'quantity mode still purges (P1, which the zero-price mode never touched)');
select is((select count(*) from public.products where sku = 'P1'), 0::bigint, 'P1 is gone');

select * from finish();
rollback;
