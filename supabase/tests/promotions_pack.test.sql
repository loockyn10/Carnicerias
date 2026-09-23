begin;

create extension if not exists pgtap with schema extensions;
select plan(22);

-- Shape: save_weight_discount gained 4 trailing optional params, same identity as before.
select has_function('public', 'save_weight_discount',
  array['uuid','uuid','uuid','integer','text','bigint','boolean','timestamptz','timestamptz','text','integer','integer','bigint'],
  'save_weight_discount RPC exists with the extended pack signature');
select has_function('public', 'get_products_with_unit_type_history', array[]::text[], 'get_products_with_unit_type_history RPC exists');

-- Fixture: one organization, one branch, an admin, a WEIGHT product and a UNIT product.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pack-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pack Admin"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'Pack Org', 'pack-org');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Pack Branch 1', 'PK1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE');

insert into public.categories (id, organization_id, name, slug) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Pack Category', 'pack-category');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Vacio', 'vacio-pack', 'PK-1', 'WEIGHT', true),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Hamburguesa', 'hamburguesa-pack', 'PK-2', 'UNIT', true);
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 10000, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002', 700, now() - interval '1 day');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- THRESHOLD path is byte-for-byte unchanged: omitting the new params defaults to THRESHOLD.
select lives_ok(
  $$select public.save_weight_discount(null,'d5000000-0000-4000-8000-000000000001',null,2000,'PERCENTAGE',1500,true,now())$$,
  'threshold promo on a WEIGHT product still works without the new params'
);
select is((select promotion_mode::text from public.product_weight_discounts where product_id = 'd5000000-0000-4000-8000-000000000001'), 'THRESHOLD', 'defaults to THRESHOLD mode');
select throws_ok(
  $$select public.save_weight_discount(null,'d5000000-0000-4000-8000-000000000002',null,2000,'PERCENTAGE',1500,true,now())$$,
  '42501', 'Weight product not found', 'threshold promo on a UNIT product is still rejected exactly as before'
);

-- PACK_FIXED_TOTAL on a WEIGHT product: "Vacío 2kg por $18.000".
select lives_ok(
  $$select public.save_weight_discount(null,'d5000000-0000-4000-8000-000000000001',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',2000,null,18000)$$,
  'pack promo on a WEIGHT product with grams quantity succeeds'
);
select results_eq(
  $$select promotion_mode::text, minimum_grams, discount_type::text, discount_value, pack_quantity_grams, pack_quantity_units, pack_price_cents
    from public.product_weight_discounts where product_id = 'd5000000-0000-4000-8000-000000000001' and promotion_mode = 'PACK_FIXED_TOTAL'$$,
  $$values ('PACK_FIXED_TOTAL', null::integer, null::text, null::bigint, 2000, null::integer, 18000::bigint)$$,
  'pack row has exactly the pack shape (threshold columns null)'
);
select throws_ok(
  $$select public.save_weight_discount(null,'d5000000-0000-4000-8000-000000000001',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',null,40,18000)$$,
  '22023', null, 'a WEIGHT product pack rejects a unit-count quantity'
);
select throws_ok(
  $$select public.save_weight_discount(null,'d5000000-0000-4000-8000-000000000001',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',null,null,0)$$,
  '22023', null, 'a zero pack price is rejected'
);

-- One active pack per product/branch scope: a second one collides on the unique index.
select throws_ok(
  $$select public.save_weight_discount(null,'d5000000-0000-4000-8000-000000000001',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',1500,null,15000)$$,
  '23505', null, 'a second active pack for the same product/branch scope is rejected'
);

-- PACK_FIXED_TOTAL on a UNIT product: "Hamburguesa 40u por $28.000" — this is the actual fix for
-- the "new UNIT product doesn't appear in Promotions" report: it never was a stale-filter bug,
-- THRESHOLD was always WEIGHT-only by design, and PACK is what makes a UNIT product usable here.
select lives_ok(
  $$select public.save_weight_discount(null,'d5000000-0000-4000-8000-000000000002',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',null,40,28000)$$,
  'pack promo on a UNIT product with a unit quantity succeeds'
);
select throws_ok(
  $$select public.save_weight_discount(null,'d5000000-0000-4000-8000-000000000002',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',2000,null,28000)$$,
  '22023', null, 'a UNIT product pack rejects a weight quantity'
);

-- Editing an existing pack row (via p_id) goes through the update branch, not a second insert.
select is(
  (select count(*) from public.product_weight_discounts where product_id = 'd5000000-0000-4000-8000-000000000001' and promotion_mode = 'PACK_FIXED_TOTAL'),
  1::bigint, 'still exactly one pack row after edits (no accidental duplicate insert)'
);

-- complete_discounted_sale: the WEIGHT pack checkout path.
select lives_ok(
  $$select public.complete_discounted_sale(
    'd3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'product_id','d5000000-0000-4000-8000-000000000001','weight_grams',2050,
      'expected_price_per_kg_cents','10000',
      'pack_promotion_id',(select id from public.product_weight_discounts where product_id='d5000000-0000-4000-8000-000000000001' and promotion_mode='PACK_FIXED_TOTAL')
    )),
    'CASH'
  )$$,
  'a pack sale for a real 2.050kg piece completes'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 18000::bigint, 'pack sale subtotal is the pack''s fixed total, not weight * rate');
select is((select promotion_mode::text from public.sale_items order by created_at desc limit 1), 'PACK_FIXED_TOTAL', 'sale_items snapshot records the pack mode');
select is((select weight_grams from public.sale_items order by created_at desc limit 1), 2050, 'the real weighed grams are still what feeds stock/traceability');
select is((select -quantity_grams from public.stock_movements where type = 'SALE' order by created_at desc limit 1), 2050::bigint, 'stock movement deducts the real weighed grams, not a nominal pack weight');

-- Sanity guard: a pack price that exceeds list price for a tiny weighed amount is rejected.
select throws_ok(
  $$select public.complete_discounted_sale(
    'd3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'product_id','d5000000-0000-4000-8000-000000000001','weight_grams',100,
      'expected_price_per_kg_cents','10000',
      'pack_promotion_id',(select id from public.product_weight_discounts where product_id='d5000000-0000-4000-8000-000000000001' and promotion_mode='PACK_FIXED_TOTAL')
    )),
    'CASH'
  )$$,
  '22023', null, 'a pack sale is rejected when the pack price exceeds list price for a tiny weighed amount'
);

-- Regression: an undiscounted WEIGHT sale (no pack, no threshold) still completes exactly as
-- before this migration.
select lives_ok(
  $$select public.complete_discounted_sale(
    'd3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object('product_id','d5000000-0000-4000-8000-000000000001','weight_grams',1000,'expected_price_per_kg_cents','10000')),
    'CREDIT'
  )$$,
  'an undiscounted WEIGHT sale (no pack, no threshold) still completes as before'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 10000::bigint, 'undiscounted subtotal is unchanged: list price * weight');

-- RLS/tenant isolation: save_weight_discount and complete_discounted_sale both resolve the
-- organization from the authenticated caller, so a product from another org is simply not found.
insert into public.organizations (id, name, slug) values ('d2000000-0000-4000-8000-000000000099', 'Other Org', 'pack-other-org');
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000099', 'authenticated', 'authenticated', 'pack-other-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Other Admin"}', now(), now(), '', '', '', '');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000099', 'd1000000-0000-4000-8000-000000000099', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000099', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000099","role":"authenticated"}', true);
select throws_ok(
  $$select public.save_weight_discount(null,'d5000000-0000-4000-8000-000000000001',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',2000,null,18000)$$,
  '42501', null, 'an admin from another organization cannot pack-promote a product they cannot see'
);

reset role;
select * from finish();
rollback;
