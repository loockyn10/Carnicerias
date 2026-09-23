begin;

create extension if not exists pgtap with schema extensions;
select plan(16);

select has_column('public', 'sale_items', 'quantity_units', 'sale_items.quantity_units exists');
select col_not_null('public', 'sale_items', 'product_id', 'product_id is still required (sanity check the rebuild kept the rest of the table intact)');

-- Fixture: one organization, one branch, an admin, a UNIT product ("Hamburguesa") with a pack.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'unit-sale-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Unit Sale Admin"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('a2000000-0000-4000-8000-000000000001', 'Unit Sale Org', 'unit-sale-org');
insert into public.branches (id, organization_id, name, code) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Unit Sale Branch 1', 'US1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE');

insert into public.categories (id, organization_id, name, slug) values
  ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Unit Sale Category', 'unit-sale-category');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Hamburguesa', 'hamburguesa-unit-sale', 'US-1', 'UNIT', true);
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 800, now() - interval '1 day');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Plain UNIT sale: 3 x $800 = $2.400, no promo, no balanza involved.
select lives_ok(
  $$select public.complete_discounted_sale(
    'a3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object('product_id','a5000000-0000-4000-8000-000000000001','quantity_units',3,'expected_price_per_unit_cents','800')),
    'CASH'
  )$$,
  'a plain UNIT sale (3 hamburguesas) completes'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 2_400::bigint, 'subtotal is quantity * unit price');
select is((select quantity_units from public.sale_items order by created_at desc limit 1), 3, 'quantity_units is recorded');
select is((select weight_grams from public.sale_items order by created_at desc limit 1), null, 'weight_grams stays null for a UNIT line');
select is((select -quantity_grams from public.stock_movements where type = 'SALE' order by created_at desc limit 1), 3::bigint, 'stock_movements reuses quantity_grams as the signed unit count (same precedent as PRODUCTION_YIELD)');

-- PACK_FIXED_TOTAL on a UNIT product: "40 hamburguesas por $28.000".
select lives_ok(
  $$select public.save_weight_discount(null,'a5000000-0000-4000-8000-000000000001',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',null,40,28000)$$,
  'pack promo on the UNIT product succeeds'
);

-- 45 = 1 pack (40 @ $28.000) + 5 @ $800 normal = $32.000 (the exact example from the request).
select lives_ok(
  $$select public.complete_discounted_sale(
    'a3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'product_id','a5000000-0000-4000-8000-000000000001','quantity_units',45,'expected_price_per_unit_cents','800',
      'pack_promotion_id',(select id from public.product_weight_discounts where product_id='a5000000-0000-4000-8000-000000000001' and promotion_mode='PACK_FIXED_TOTAL')
    )),
    'CASH'
  )$$,
  '45 hamburguesas with the pack active completes'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 32_000::bigint, '1 pack ($28.000) + 5 normal ($4.000) = $32.000');
select is((select promotion_mode::text from public.sale_items order by created_at desc limit 1), 'PACK_FIXED_TOTAL', 'sale_items snapshot records the pack mode for the UNIT line too');

-- 39 = below the pack size, no discount invented.
select lives_ok(
  $$select public.complete_discounted_sale(
    'a3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'product_id','a5000000-0000-4000-8000-000000000001','quantity_units',39,'expected_price_per_unit_cents','800',
      'pack_promotion_id',(select id from public.product_weight_discounts where product_id='a5000000-0000-4000-8000-000000000001' and promotion_mode='PACK_FIXED_TOTAL')
    )),
    'CASH'
  )$$,
  '39 hamburguesas (below the pack size) still completes'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 31_200::bigint, '39 x $800 = $31.200, no partial pack discount invented');

-- cancel_sale: this is the real bug this migration closes — cancelling a sale with a UNIT line
-- used to fail with a NOT NULL violation (sum(weight_grams) is NULL for an all-UNIT sale, and
-- stock_movements.quantity_grams is NOT NULL).
select lives_ok(
  $$select public.cancel_sale(
    (select id from public.sales order by created_at desc limit 1),
    gen_random_uuid(),
    'Test de cancelación con línea UNIT'
  )$$,
  'cancelling a sale that has a UNIT line no longer crashes with a NOT NULL violation'
);
select is(
  (select quantity_grams from public.stock_movements where type = 'RETURN' order by created_at desc limit 1),
  39::bigint,
  'the RETURN movement restores the exact unit quantity that was sold (positive, same sign convention as any other RETURN)'
);

-- get_replenishment_plan: sold_recent_quantity must reflect real UNIT sales, not stay stuck at 0.
select ok(
  (select sold_recent_quantity from public.get_replenishment_plan(7) where product_id = 'a5000000-0000-4000-8000-000000000001' and branch_id = 'a3000000-0000-4000-8000-000000000001') > 0,
  'get_replenishment_plan reflects real UNIT sales instead of silently summing null weight_grams'
);

reset role;
select * from finish();
rollback;
