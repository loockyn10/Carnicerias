begin;

create extension if not exists pgtap with schema extensions;

select plan(35);

select has_table('public', 'sales', 'sales exists');
select has_table('public', 'sale_items', 'sale_items exists');
select has_table('public', 'payments', 'payments exists');
select has_table('public', 'stock_movements', 'stock_movements exists');
select has_view('public', 'stock_levels', 'derived stock view exists');
select has_function('public', 'complete_sale', array['uuid', 'jsonb', 'text'], 'atomic sale RPC exists');
select has_function('public', 'get_pos_catalog', array['uuid'], 'POS catalog RPC exists');

select ok((select relrowsecurity from pg_class where oid = 'public.sales'::regclass), 'sales has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.sale_items'::regclass), 'sale_items has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.payments'::regclass), 'payments has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.stock_movements'::regclass), 'stock movements has RLS');

select ok(has_table_privilege('authenticated', 'public.sales', 'SELECT'), 'authenticated can select sales');
select ok(not has_table_privilege('authenticated', 'public.sales', 'INSERT'), 'authenticated cannot insert sales directly');
select ok(not has_table_privilege('authenticated', 'public.sale_items', 'INSERT'), 'authenticated cannot insert sale items directly');
select ok(not has_table_privilege('authenticated', 'public.payments', 'INSERT'), 'authenticated cannot insert payments directly');
select ok(not has_table_privilege('authenticated', 'public.stock_movements', 'INSERT'), 'authenticated cannot insert stock directly');
select ok(not has_table_privilege('anon', 'public.sales', 'SELECT'), 'anonymous cannot read sales');
select ok(not has_function_privilege('anon', 'public.complete_sale(uuid,jsonb,text)', 'EXECUTE'), 'anonymous cannot execute sale RPC');
select ok(
  (select prosecdef from pg_proc where oid = 'public.complete_sale(uuid,jsonb,text)'::regprocedure),
  'sale RPC is security definer'
);
select is(
  (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.complete_sale(uuid,jsonb,text)'::regprocedure),
  'search_path=""',
  'sale RPC has an empty search path'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '61000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'phase1b-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Admin Test"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '61000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'phase1b-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Employee Test"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '61000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'phase1b-outsider@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Outsider Test"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('62000000-0000-4000-8000-000000000001', 'Phase 1B Org A', 'phase-1b-org-a'),
  ('62000000-0000-4000-8000-000000000002', 'Phase 1B Org B', 'phase-1b-org-b');

insert into public.branches (id, organization_id, name, code) values
  ('63000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000001', 'Org A Centro', 'A-CENTRO'),
  ('63000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000001', 'Org A Norte', 'A-NORTE'),
  ('63000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000002', 'Org B Centro', 'B-CENTRO');

insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('62000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE');

insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002'),
  ('62000000-0000-4000-8000-000000000002', '63000000-0000-4000-8000-000000000003', '61000000-0000-4000-8000-000000000003');

insert into public.categories (id, organization_id, name, slug) values
  ('64000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000001', 'Vacunos Test', 'vacunos-test');

insert into public.products (id, organization_id, category_id, name, slug, unit_type) values
  ('65000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000001', '64000000-0000-4000-8000-000000000001', 'Vacío Test', 'vacio-test', 'WEIGHT');

insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('62000000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000001', null, 1200000, '2026-01-01T00:00:00Z'),
  ('62000000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', 1300000, '2026-01-01T00:00:00Z');

set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"61000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select is(
  (select price_per_kg_cents from public.get_pos_catalog('63000000-0000-4000-8000-000000000001') where product_id = '65000000-0000-4000-8000-000000000001'),
  1300000::bigint,
  'employee catalog applies branch price override'
);

select throws_ok(
  $$select * from public.get_pos_catalog('63000000-0000-4000-8000-000000000002')$$,
  '42501',
  'Branch is not authorized for this user',
  'employee cannot open another branch catalog'
);

select lives_ok(
  $$select * from public.complete_sale(
    '63000000-0000-4000-8000-000000000001',
    '[{"product_id":"65000000-0000-4000-8000-000000000001","weight_grams":1250,"expected_price_per_kg_cents":"1300000"}]'::jsonb,
    'CASH'
  )$$,
  'employee completes a sale in the assigned branch'
);

select is((select count(*) from public.sales), 1::bigint, 'employee sees the assigned-branch sale');
select is((select total_cents from public.sales limit 1), 1625000::bigint, 'database calculates subtotal with integer rounding');
select is((select product_name_snapshot from public.sale_items limit 1), 'Vacío Test', 'sale item freezes product name');
select is((select price_per_kg_cents from public.sale_items limit 1), 1300000::bigint, 'sale item freezes effective price');
select is((select amount_cents from public.payments limit 1), 1625000::bigint, 'payment matches sale total');
select is((select quantity_grams from public.stock_movements limit 1), (-1250)::bigint, 'sale writes negative stock movement');

select throws_ok(
  $$select * from public.complete_sale(
    '63000000-0000-4000-8000-000000000002',
    '[{"product_id":"65000000-0000-4000-8000-000000000001","weight_grams":800,"expected_price_per_kg_cents":"1200000"}]'::jsonb,
    'CASH'
  )$$,
  '42501',
  'Branch is not authorized for this user',
  'employee cannot sell in another branch'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"61000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok(
  $$select * from public.complete_sale(
    '63000000-0000-4000-8000-000000000002',
    '[{"product_id":"65000000-0000-4000-8000-000000000001","weight_grams":800,"expected_price_per_kg_cents":"1200000"}]'::jsonb,
    'DEBIT'
  )$$,
  'admin completes a sale in any branch of the organization'
);
select is((select count(*) from public.sales), 2::bigint, 'admin reads all organization branches');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"61000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.sales), 0::bigint, 'another organization cannot read sales');
select is((select count(*) from public.stock_movements), 0::bigint, 'another organization cannot read stock movements');

reset role;
set local role anon;
select throws_ok(
  $$select count(*) from public.sales$$,
  '42501',
  'permission denied for table sales',
  'anonymous table access is rejected'
);

reset role;
select * from finish();
rollback;
