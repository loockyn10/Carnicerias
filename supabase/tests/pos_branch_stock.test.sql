begin;

create extension if not exists pgtap with schema extensions;
select plan(17);

select has_function('public', 'get_pos_branch_stock', array['uuid'], 'POS branch stock RPC exists');
select ok((select prosecdef from pg_proc where oid = 'public.get_pos_branch_stock(uuid)'::regprocedure), 'RPC is security definer');
select is((select array_to_string(proconfig, ',') from pg_proc where oid = 'public.get_pos_branch_stock(uuid)'::regprocedure), 'search_path=""', 'RPC has empty search path');
select ok(not has_function_privilege('anon', 'public.get_pos_branch_stock(uuid)', 'EXECUTE'), 'anonymous cannot execute the RPC');
select ok(not has_function_privilege('public', 'public.get_pos_branch_stock(uuid)', 'EXECUTE'), 'public role cannot execute the RPC');
select ok(has_function_privilege('authenticated', 'public.get_pos_branch_stock(uuid)', 'EXECUTE'), 'authenticated can execute the RPC');

-- Fixture: org A with two branches (employee assigned to branch 1 only), org B with one branch.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'b3000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'posstock-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"POS Stock Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b3000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'posstock-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"POS Stock Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b3000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'posstock-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"POS Stock Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('b1000000-0000-4000-8000-000000000001', 'POS Stock Org A', 'pos-stock-org-a'),
  ('b1000000-0000-4000-8000-000000000002', 'POS Stock Org B', 'pos-stock-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'POS Stock Avenida', 'PSA'),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'POS Stock Janssen', 'PSJ'),
  ('b2000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000002', 'POS Stock Org B Branch', 'PSB');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('b1000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('b1000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('b1000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000002');
insert into public.categories (id, organization_id, name, slug) values
  ('b4000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'POS Stock Category', 'pos-stock-category');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('b5000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Vacio', 'pos-stock-vacio', 'PS-VACIO', 'WEIGHT'),
  ('b5000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Peceto', 'pos-stock-peceto', 'PS-PECETO', 'WEIGHT'),
  ('b5000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Asado', 'pos-stock-asado', 'PS-ASADO', 'WEIGHT'),
  ('b5000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Sin movimientos', 'pos-stock-none', 'PS-NONE', 'WEIGHT');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b3000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Avenida: Vacio 8 kg (fractional leftover 0.01 kg on Asado), Peceto exactly 0, nothing for the rest.
-- Janssen: Vacio stays with no movements at all. Per-branch, never organization-global.
select lives_ok($$select public.record_stock_operation('b2000000-0000-4000-8000-000000000001', 'PURCHASE',
  '[{"product_id":"b5000000-0000-4000-8000-000000000001","quantity_grams":8000},{"product_id":"b5000000-0000-4000-8000-000000000002","quantity_grams":3000},{"product_id":"b5000000-0000-4000-8000-000000000003","quantity_grams":10}]',
  'POS Stock Supplier', null, 'Avenida fixture', now())$$, 'admin can stock Avenida');
select lives_ok($$select public.record_stock_operation('b2000000-0000-4000-8000-000000000001', 'WASTE',
  '[{"product_id":"b5000000-0000-4000-8000-000000000002","quantity_grams":3200}]',
  null, 'DETERIORATION', 'Peceto goes negative', now())$$, 'ledger allows Peceto to go negative (-200 g)');

select is(
  (select (i ->> 'quantityGrams') from jsonb_array_elements(public.get_pos_branch_stock('b2000000-0000-4000-8000-000000000001') -> 'items') i where i ->> 'productId' = 'b5000000-0000-4000-8000-000000000001'),
  '8000', 'Avenida reports Vacio = 8 kg from the ledger sum');
select is(
  (select (i ->> 'quantityGrams') from jsonb_array_elements(public.get_pos_branch_stock('b2000000-0000-4000-8000-000000000001') -> 'items') i where i ->> 'productId' = 'b5000000-0000-4000-8000-000000000002'),
  '-200', 'negative stock is returned unclamped');
select is(
  (select (i ->> 'quantityGrams') from jsonb_array_elements(public.get_pos_branch_stock('b2000000-0000-4000-8000-000000000001') -> 'items') i where i ->> 'productId' = 'b5000000-0000-4000-8000-000000000003'),
  '10', 'a 0.01 kg remainder is returned exactly, not rounded');
select is(
  (select count(*) from jsonb_array_elements(public.get_pos_branch_stock('b2000000-0000-4000-8000-000000000001') -> 'items') i where i ->> 'productId' = 'b5000000-0000-4000-8000-000000000004'),
  0::bigint, 'a product with no movements is absent (the POS treats absence as zero)');
select is(
  jsonb_array_length(public.get_pos_branch_stock('b2000000-0000-4000-8000-000000000002') -> 'items'),
  0, 'Janssen has no movements: Avenida stock never leaks into another branch');

-- Employee assigned to Avenida only.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"b3000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select is(jsonb_array_length(public.get_pos_branch_stock('b2000000-0000-4000-8000-000000000001') -> 'items'), 3, 'employee can read stock for their own branch');
select throws_ok($$select public.get_pos_branch_stock('b2000000-0000-4000-8000-000000000002')$$, '42501', 'Branch is not authorized for this user', 'employee cannot read an unassigned branch');

-- Cross-organization isolation.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"b3000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

select throws_ok($$select public.get_pos_branch_stock('b2000000-0000-4000-8000-000000000001')$$, '42501', 'Branch is not authorized for this user', 'org B admin cannot read org A branch stock');

reset role;
set local role anon;
select throws_ok($$select public.get_pos_branch_stock('b2000000-0000-4000-8000-000000000001')$$, '42501', 'permission denied for function get_pos_branch_stock', 'anonymous cannot call the RPC at all');

reset role;
select * from finish();
rollback;
