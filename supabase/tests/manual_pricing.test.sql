begin;

create extension if not exists pgtap with schema extensions;
select plan(25);

-- Shape.
select has_function('public', 'set_product_cost', array['uuid','bigint','timestamptz'], 'set_product_cost RPC exists');
select has_function('public', 'bulk_set_product_prices', array['jsonb','uuid','timestamptz'], 'bulk_set_product_prices RPC exists');
select has_function('public', 'set_cash_discount', array['integer'], 'set_cash_discount RPC exists');
select ok(not has_function_privilege('anon', 'public.set_product_cost(uuid,bigint,timestamptz)', 'EXECUTE'), 'anonymous cannot set a product cost');
select ok(not has_function_privilege('anon', 'public.bulk_set_product_prices(jsonb,uuid,timestamptz)', 'EXECUTE'), 'anonymous cannot bulk-set prices');
select ok(not has_function_privilege('anon', 'public.set_cash_discount(integer)', 'EXECUTE'), 'anonymous cannot set the cash discount');

-- Fixture: one organization, one branch, an admin and an employee.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'manual-pricing-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pricing Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'manual-pricing-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pricing Employee"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'Pricing Org', 'pricing-org');
insert into public.branches (id, organization_id, name, code) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Pricing Branch 1', 'PR1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002');

insert into public.categories (id, organization_id, name, slug) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Pricing Category', 'pricing-category');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Vacio', 'vacio-pricing', 'PRC-1', 'WEIGHT', true),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Bondiola', 'bondiola-pricing', 'PRC-2', 'WEIGHT', true),
  ('c5000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Inactivo', 'inactivo-pricing', 'PRC-3', 'WEIGHT', false);
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 1450000, now() - interval '1 day'),
  ('c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000002', 980000, now() - interval '1 day');
insert into public.organization_cash_discounts (organization_id, cash_discount_bps, valid_from) values
  ('c2000000-0000-4000-8000-000000000001', 1000, now() - interval '1 day')
on conflict do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- set_product_cost only writes product_costs, never touches product_prices.
select lives_ok($$select public.set_product_cost('c5000000-0000-4000-8000-000000000001', 1135100)$$, 'admin sets a direct cost for Vacio');
select is((select cost_cents from public.product_costs where product_id = 'c5000000-0000-4000-8000-000000000001' and valid_to is null), 1135100::bigint, 'product_costs reflects the new cost');
select is((select price_cents from public.product_prices where product_id = 'c5000000-0000-4000-8000-000000000001' and valid_to is null), 1450000::bigint, 'product_prices is untouched by set_product_cost');
select throws_ok($$select public.set_product_cost('c5000000-0000-4000-8000-000000000001', 0)$$, '22023', 'Cost must be positive', 'zero cost is rejected');

-- bulk_set_product_prices applies every valid item and returns how many it applied.
select is(
  (public.bulk_set_product_prices($${"items":[{"productId":"c5000000-0000-4000-8000-000000000001","priceCents":1500000},{"productId":"c5000000-0000-4000-8000-000000000002","priceCents":990000}]}$$::jsonb) ->> 'applied')::int,
  2, 'bulk update reports 2 applied prices'
);
select is((select price_cents from public.product_prices where product_id = 'c5000000-0000-4000-8000-000000000001' and valid_to is null), 1500000::bigint, 'Vacio price was updated by the bulk call');
select is((select price_cents from public.product_prices where product_id = 'c5000000-0000-4000-8000-000000000002' and valid_to is null), 990000::bigint, 'Bondiola price was updated by the bulk call');

-- Atomicity: one bad item in the array must roll back every write from that same call, even the
-- ones that would otherwise have been valid.
select throws_ok($$select public.bulk_set_product_prices(
  '{"items":[{"productId":"c5000000-0000-4000-8000-000000000001","priceCents":1600000},{"productId":"c5000000-0000-4000-8000-000000000003","priceCents":500000}]}'::jsonb
)$$, '42501', null, 'a batch containing an inactive product is rejected entirely');
select is((select price_cents from public.product_prices where product_id = 'c5000000-0000-4000-8000-000000000001' and valid_to is null), 1500000::bigint, 'Vacio price is unchanged after the rejected batch (no partial update)');

select throws_ok($$select public.bulk_set_product_prices('{"items":[{"productId":"c5000000-0000-4000-8000-000000000001","priceCents":0}]}'::jsonb)$$, '22023', 'El precio debe ser mayor a cero', 'a zero price in the batch is rejected');
select throws_ok($$select public.bulk_set_product_prices('[]'::jsonb)$$, '22023', 'Debe enviar entre 1 y 500 precios', 'an empty batch is rejected');

-- set_cash_discount changes the organization percentage without repricing anything.
select lives_ok($$select public.set_cash_discount(1200)$$, 'admin changes the cash discount to 12%');
select is((select cash_discount_bps from public.organization_cash_discounts where organization_id = 'c2000000-0000-4000-8000-000000000001' and valid_to is null), 1200, 'organization_cash_discounts reflects the new percentage');
select is((select price_cents from public.product_prices where product_id = 'c5000000-0000-4000-8000-000000000001' and valid_to is null), 1500000::bigint, 'no product price changed as a side effect of changing the cash discount');
select is((public.set_cash_discount(1200) ->> 'unchanged')::boolean, true, 'setting the same percentage again is a no-op, reported as unchanged');
select throws_ok($$select public.set_cash_discount(10000)$$, '22023', 'Cash discount must be between 0%% and 99.99%%', '100% discount is rejected');

-- Employees (no prices.write) are blocked from every one of these RPCs.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_product_cost('c5000000-0000-4000-8000-000000000001', 100000)$$, '42501', 'Permission prices.write is required', 'an employee cannot set a product cost');
select throws_ok($$select public.bulk_set_product_prices('{"items":[{"productId":"c5000000-0000-4000-8000-000000000001","priceCents":100000}]}'::jsonb)$$, '42501', 'Permission prices.write is required', 'an employee cannot bulk-set prices');
select throws_ok($$select public.set_cash_discount(500)$$, '42501', 'Permission prices.write is required', 'an employee cannot set the cash discount');

reset role;
select * from finish();
rollback;
