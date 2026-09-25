begin;

create extension if not exists pgtap with schema extensions;
select plan(32);

select has_column('public', 'sale_items', 'card_surcharge_cents', 'sale_items.card_surcharge_cents exists');
select col_not_null('public', 'sale_items', 'cash_discount_cents', 'cash_discount_cents is still required (sanity check the new column did not disturb the existing ones)');

-- Fixture: one organization, one branch, an admin, a WEIGHT product ($10.000/kg) and a UNIT
-- product ("Hamburguesa", $800/u).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'card-surcharge-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Card Surcharge Admin"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('b2000000-0000-4000-8000-000000000001', 'Card Surcharge Org', 'card-surcharge-org');
insert into public.branches (id, organization_id, name, code) values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Card Surcharge Branch 1', 'CS1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE');

insert into public.categories (id, organization_id, name, slug) values
  ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Card Surcharge Category', 'card-surcharge-category');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Vacio Card Surcharge', 'vacio-card-surcharge', 'CS-1', 'WEIGHT', true),
  ('b5000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Hamburguesa Card Surcharge', 'hamburguesa-card-surcharge', 'CS-2', 'UNIT', true);
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 1_000_000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002', 800, now() - interval '1 day');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Configure a 10% card surcharge (D-044's example: base $10.000 + 10%).
select lives_ok(
  $$select public.set_cash_discount(1000)$$,
  'set_cash_discount configures the 10% card surcharge percentage'
);

-- get_pos_commercial_config must expose cashDiscountBps (regression found and fixed by this
-- migration: 202609230031's CREATE OR REPLACE had silently dropped this key).
select is(
  (select (public.get_pos_commercial_config('b3000000-0000-4000-8000-000000000001')->>'cashDiscountBps')::integer),
  1000,
  'get_pos_commercial_config exposes cashDiscountBps again'
);

-- CASH: pays exactly the configured price, no adjustment.
select lives_ok(
  $$select public.complete_discounted_sale(
    'b3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object('product_id','b5000000-0000-4000-8000-000000000001','weight_grams',1000,'expected_price_per_kg_cents','1000000')),
    'CASH'
  )$$,
  'a CASH sale completes at the base price'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 1_000_000::bigint, 'CASH: 1kg at $10.000/kg = $10.000, no adjustment');
select is((select cash_discount_cents from public.sale_items order by created_at desc limit 1), 0::bigint, 'CASH: cash_discount_cents is always 0 under D-044');
select is((select card_surcharge_cents from public.sale_items order by created_at desc limit 1), 0::bigint, 'CASH: no card surcharge');

-- TRANSFER: same as CASH, no adjustment.
select lives_ok(
  $$select public.complete_discounted_sale(
    'b3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object('product_id','b5000000-0000-4000-8000-000000000001','weight_grams',1000,'expected_price_per_kg_cents','1000000')),
    'TRANSFER'
  )$$,
  'a TRANSFER sale completes at the base price'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 1_000_000::bigint, 'TRANSFER: same base price as CASH');

-- DEBIT ("Tarjeta"): base price + 10% surcharge = $11.000.
select lives_ok(
  $$select public.complete_discounted_sale(
    'b3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object('product_id','b5000000-0000-4000-8000-000000000001','weight_grams',1000,'expected_price_per_kg_cents','1000000')),
    'DEBIT'
  )$$,
  'a DEBIT (Tarjeta) sale completes with the surcharge'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 1_100_000::bigint, 'DEBIT: 1kg at $10.000/kg + 10% = $11.000 (the exact D-044 example)');
select is((select card_surcharge_cents from public.sale_items order by created_at desc limit 1), 100_000::bigint, 'DEBIT: card_surcharge_cents records the exact surcharge amount');
select is((select cash_discount_cents from public.sale_items order by created_at desc limit 1), 0::bigint, 'DEBIT: cash_discount_cents stays 0 (this is a surcharge, never a discount)');

-- CREDIT: same surcharge as DEBIT.
select lives_ok(
  $$select public.complete_discounted_sale(
    'b3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object('product_id','b5000000-0000-4000-8000-000000000001','weight_grams',1000,'expected_price_per_kg_cents','1000000')),
    'CREDIT'
  )$$,
  'a CREDIT sale completes with the same surcharge as DEBIT'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 1_100_000::bigint, 'CREDIT: same +10% surcharge as DEBIT');

-- PACK_FIXED_TOTAL (WEIGHT), corrected 2026-09-24: NO exception for packs — the surcharge
-- applies to the whole pack total, exactly like any other line. The required example:
-- "2kg por $18.000" -> DEBIT = $19.800 (18.000 * 1,10), not $18.000.
select lives_ok(
  $$select public.save_weight_discount(null,'b5000000-0000-4000-8000-000000000001',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',2000,null,18000)$$,
  'a WEIGHT pack promo (2kg/$18.000) is created'
);
select lives_ok(
  $$select public.complete_discounted_sale(
    'b3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'product_id','b5000000-0000-4000-8000-000000000001','weight_grams',2050,'expected_price_per_kg_cents','1000000',
      'pack_promotion_id',(select id from public.product_weight_discounts where product_id='b5000000-0000-4000-8000-000000000001' and promotion_mode='PACK_FIXED_TOTAL')
    )),
    'CASH'
  )$$,
  'a CASH pack sale completes'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 18_000::bigint, 'CASH pack: exactly $18.000, the configured total');
select is((select card_surcharge_cents from public.sale_items order by created_at desc limit 1), 0::bigint, 'CASH pack: no surcharge');
select lives_ok(
  $$select public.complete_discounted_sale(
    'b3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'product_id','b5000000-0000-4000-8000-000000000001','weight_grams',2050,'expected_price_per_kg_cents','1000000',
      'pack_promotion_id',(select id from public.product_weight_discounts where product_id='b5000000-0000-4000-8000-000000000001' and promotion_mode='PACK_FIXED_TOTAL')
    )),
    'DEBIT'
  )$$,
  'a DEBIT pack sale completes'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 19_800::bigint, 'DEBIT pack: $18.000 * 1,10 = $19.800 (the required example — the pack total DOES carry the surcharge)');
select is((select card_surcharge_cents from public.sale_items order by created_at desc limit 1), 1_800::bigint, 'DEBIT pack: card_surcharge_cents = 1.800');

-- PACK_FIXED_TOTAL (UNIT), corrected 2026-09-24: the surcharge applies to the WHOLE resulting
-- total (pack + remainder), never only to the remainder. Required examples: "40u por $28.000"
-- -> DEBIT = $30.800; 45 units (1 pack + 5 remainder, $32.000 CASH-equivalent) -> DEBIT = $35.200.
select lives_ok(
  $$select public.save_weight_discount(null,'b5000000-0000-4000-8000-000000000002',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',null,40,28000)$$,
  'a UNIT pack promo (40u/$28.000) is created'
);
select lives_ok(
  $$select public.complete_discounted_sale(
    'b3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'product_id','b5000000-0000-4000-8000-000000000002','quantity_units',40,'expected_price_per_unit_cents','800',
      'pack_promotion_id',(select id from public.product_weight_discounts where product_id='b5000000-0000-4000-8000-000000000002' and promotion_mode='PACK_FIXED_TOTAL')
    )),
    'DEBIT'
  )$$,
  'a DEBIT UNIT pack sale (exact multiple, no remainder) completes'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 30_800::bigint, 'DEBIT: 40u pack $28.000 * 1,10 = $30.800 (the required example)');
select is((select card_surcharge_cents from public.sale_items order by created_at desc limit 1), 2_800::bigint, 'DEBIT: card_surcharge_cents = 2.800');

select lives_ok(
  $$select public.complete_discounted_sale(
    'b3000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'product_id','b5000000-0000-4000-8000-000000000002','quantity_units',45,'expected_price_per_unit_cents','800',
      'pack_promotion_id',(select id from public.product_weight_discounts where product_id='b5000000-0000-4000-8000-000000000002' and promotion_mode='PACK_FIXED_TOTAL')
    )),
    'DEBIT'
  )$$,
  'a DEBIT UNIT pack sale (45 units, 1 pack + 5 remainder) completes'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 35_200::bigint, 'DEBIT: (pack $28.000 + 5*$800 remainder = $32.000 CASH-equivalent) * 1,10 = $35.200 — the required example; NOT $28.000 + 5*$880');
select is((select card_surcharge_cents from public.sale_items order by created_at desc limit 1), 3_200::bigint, 'DEBIT: card_surcharge_cents = 3.200, on the WHOLE total');

-- Cancelling a DEBIT pack sale must still reverse stock correctly (regression: this sprint's
-- correction only touches pricing fields, never quantity_units/stock_movements).
select lives_ok(
  $$select public.cancel_sale(
    (select id from public.sales order by created_at desc limit 1),
    gen_random_uuid(),
    'Test de cancelacion con recargo por tarjeta'
  )$$,
  'cancelling a DEBIT pack sale with a card surcharge still reverses stock correctly'
);
select is(
  (select quantity_grams from public.stock_movements where type = 'RETURN' order by created_at desc limit 1),
  45::bigint,
  'the RETURN movement restores the exact unit quantity sold, unaffected by the card surcharge'
);

reset role;
select * from finish();
rollback;
