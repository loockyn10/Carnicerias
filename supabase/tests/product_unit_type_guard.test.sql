begin;

create extension if not exists pgtap with schema extensions;
select plan(12);

-- save_product keeps its exact original signature — the guard lives inside the body.
select has_function('public', 'save_product', array['uuid','uuid','text','text','text','unit_type','boolean'], 'save_product RPC exists with its original signature');

-- Fixture: one organization, one branch, an admin, and products in different history states.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'guard-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Guard Admin"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'Guard Org', 'guard-org');
insert into public.branches (id, organization_id, name, code) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Guard Branch 1', 'GD1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE');

insert into public.categories (id, organization_id, name, slug) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Guard Category', 'guard-category');

-- product-a: no history at all -> can change type.
-- product-b: has a sale_items row -> blocked.
-- product-c: has a stock_movements row -> blocked.
-- product-d: has a product_weight_discounts row -> blocked.
-- product-e: has price/cost history ONLY -> can still change type (money history is not blocking).
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Product A', 'guard-a', 'GD-A', 'WEIGHT', true),
  ('e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Product B', 'guard-b', 'GD-B', 'WEIGHT', true),
  ('e5000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Product C', 'guard-c', 'GD-C', 'WEIGHT', true),
  ('e5000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Product D', 'guard-d', 'GD-D', 'WEIGHT', true),
  ('e5000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Product E', 'guard-e', 'GD-E', 'WEIGHT', true);

insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000005', 10000, now() - interval '1 day');
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from) values
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000005', 5000, now() - interval '1 day');

insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'COMPLETED', 10000, 1000, now());
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents) values
  ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002', 'Product B', 1000, 10000, 10000, 10000, 10000);

insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id, occurred_at) values
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000003', 'PURCHASE', 5000, 'e1000000-0000-4000-8000-000000000001', now());

insert into public.product_weight_discounts (organization_id, product_id, branch_id, minimum_grams, discount_type, discount_value, active, valid_from) values
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000004', null, 2000, 'PERCENTAGE', 1000, false, now());

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- No history at all: the change goes through.
select lives_ok(
  $$select public.save_product('e5000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000001','Product A','guard-a','GD-A','UNIT',true)$$,
  'a product with zero history can change WEIGHT -> UNIT'
);
select is((select unit_type::text from public.products where id = 'e5000000-0000-4000-8000-000000000001'), 'UNIT', 'unit_type was actually updated');

-- Blocked: sale_items history.
select throws_ok(
  $$select public.save_product('e5000000-0000-4000-8000-000000000002','e4000000-0000-4000-8000-000000000001','Product B','guard-b','GD-B','UNIT',true)$$,
  '22023', null, 'a product with sale history cannot change unit_type'
);
select is((select unit_type::text from public.products where id = 'e5000000-0000-4000-8000-000000000002'), 'WEIGHT', 'unit_type stayed WEIGHT after the rejected change');

-- Blocked: stock_movements history.
select throws_ok(
  $$select public.save_product('e5000000-0000-4000-8000-000000000003','e4000000-0000-4000-8000-000000000001','Product C','guard-c','GD-C','UNIT',true)$$,
  '22023', null, 'a product with stock movement history cannot change unit_type'
);

-- Blocked: a promotion was ever configured for it, even inactive.
select throws_ok(
  $$select public.save_product('e5000000-0000-4000-8000-000000000004','e4000000-0000-4000-8000-000000000001','Product D','guard-d','GD-D','UNIT',true)$$,
  '22023', null, 'a product with any promotion history (even inactive) cannot change unit_type'
);

-- NOT blocked: price/cost history alone is not operational history.
select lives_ok(
  $$select public.save_product('e5000000-0000-4000-8000-000000000005','e4000000-0000-4000-8000-000000000001','Product E','guard-e','GD-E','UNIT',true)$$,
  'price/cost history alone does not block a unit_type change'
);
select is((select unit_type::text from public.products where id = 'e5000000-0000-4000-8000-000000000005'), 'UNIT', 'unit_type was updated even though a price/cost history exists');
select is((select price_cents from public.product_prices where product_id = 'e5000000-0000-4000-8000-000000000005' and valid_to is null), 10000::bigint, 'the historical price row was not touched or reinterpreted');

-- No implicit reinterpretation: changing the flag never rewrites the historical quantity that was
-- already recorded under the old unit_type (grams stays grams, it is simply no longer being sold
-- that way going forward).
select is((select weight_grams from public.sale_items where product_id = 'e5000000-0000-4000-8000-000000000002'), 1000, '3000/1000 grams recorded historically is never reinterpreted as a unit count');

-- Unrelated edits (name/category/active) with the SAME unit_type never run the guard at all.
select lives_ok(
  $$select public.save_product('e5000000-0000-4000-8000-000000000002','e4000000-0000-4000-8000-000000000001','Product B Renamed','guard-b','GD-B','WEIGHT',true)$$,
  'a normal edit that keeps the same unit_type is unaffected by the guard even with sale history'
);

reset role;
select * from finish();
rollback;
