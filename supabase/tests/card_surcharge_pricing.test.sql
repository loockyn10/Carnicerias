begin;

create extension if not exists pgtap with schema extensions;
select plan(24);

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

-- PACK_FIXED_TOTAL (WEIGHT): a pack's total is payment-method-invariant (D-044) — DEBIT charges
-- the exact same total as CASH, never the total plus a surcharge.
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
    'DEBIT'
  )$$,
  'a DEBIT pack sale completes'
);
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 18_000::bigint, 'DEBIT pack: still exactly $18.000, no card surcharge added on top of the pack total');
select is((select card_surcharge_cents from public.sale_items order by created_at desc limit 1), 0::bigint, 'DEBIT pack: card_surcharge_cents is 0 for the fixed-total portion');

-- PACK_FIXED_TOTAL (UNIT): the whole-pack portion is payment-method-invariant, but a remainder
-- (a genuine normal-price sale) DOES carry the card surcharge — the exact 45-hamburguesas example.
select lives_ok(
  $$select public.save_weight_discount(null,'b5000000-0000-4000-8000-000000000002',null,null,null,null,true,now(),null,'PACK_FIXED_TOTAL',null,40,28000)$$,
  'a UNIT pack promo (40u/$28.000) is created'
);
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
select is((select subtotal_cents from public.sale_items order by created_at desc limit 1), 32_400::bigint, 'DEBIT: pack ($28.000, no surcharge) + 5 remainder units at $800*1.10=$880 each = $32.400');
select is((select card_surcharge_cents from public.sale_items order by created_at desc limit 1), 400::bigint, 'DEBIT: card_surcharge_cents = 5 * (880-800) = 400, only the remainder carries it');

reset role;
select * from finish();
rollback;
