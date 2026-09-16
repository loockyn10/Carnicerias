begin;

create extension if not exists pgtap with schema extensions;
select plan(28);

-- Function shape and hardening.
select has_function('public', 'get_branch_stock_status', array['uuid'], 'branch stock status RPC exists');
select has_view('public', 'branch_stock_status', 'legacy view still exists for its remaining consumers (attention, branches/compare, branch detail)');
select ok((select prosecdef from pg_proc where oid = 'public.get_branch_stock_status(uuid)'::regprocedure), 'RPC is security definer');
select is((select array_to_string(proconfig, ',') from pg_proc where oid = 'public.get_branch_stock_status(uuid)'::regprocedure), 'search_path=""', 'RPC has empty search path');
select ok(not has_function_privilege('anon', 'public.get_branch_stock_status(uuid)', 'EXECUTE'), 'anonymous cannot execute the RPC');
select ok(not has_function_privilege('public', 'public.get_branch_stock_status(uuid)', 'EXECUTE'), 'public role cannot execute the RPC');
select ok(has_function_privilege('authenticated', 'public.get_branch_stock_status(uuid)', 'EXECUTE'), 'authenticated can execute the RPC');
select is((select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner where p.oid = 'public.get_branch_stock_status(uuid)'::regprocedure), 'postgres', 'RPC is owned by postgres (bypassrls), matching get_replenishment_plan and other admin RPCs');

-- Fixture: two organizations, two branches in org A (employee assigned to only one), one in org B.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'stockrpc-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Org A Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'stockrpc-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Org A Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'stockrpc-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Org B Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'stockrpc-unaffiliated@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"No Membership"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('a1000000-0000-4000-8000-000000000001', 'Stock RPC Org A', 'stock-rpc-org-a'),
  ('a1000000-0000-4000-8000-000000000002', 'Stock RPC Org B', 'stock-rpc-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Org A Branch 1', 'A1'),
  ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'Org A Branch 2', 'A2'),
  ('a2000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'Org B Branch 1', 'B1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('a1000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002');
insert into public.categories (id, organization_id, name, slug) values
  ('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Stock RPC Category', 'stock-rpc-category');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Product With Movements', 'product-with-movements', 'STOCK-RPC-A', 'WEIGHT'),
  ('a5000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Product Without Movements', 'product-without-movements', 'STOCK-RPC-B', 'WEIGHT'),
  ('a5000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Unit Product', 'unit-product', 'STOCK-RPC-C', 'UNIT');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a3000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Build a positive -> zero -> negative stock history through the real RPC (no direct
-- writes to stock_movements), matching how the app actually produces this data.
select lives_ok($$select public.record_stock_operation(
  'a2000000-0000-4000-8000-000000000001', 'PURCHASE',
  '[{"product_id":"a5000000-0000-4000-8000-000000000001","quantity_grams":5000}]',
  'Stock RPC Supplier', null, 'Positive stock fixture', now()
)$$, 'admin can purchase into branch A1 (positive stock fixture)');
select is((select current_stock_grams from public.get_branch_stock_status() where branch_id = 'a2000000-0000-4000-8000-000000000001' and product_id = 'a5000000-0000-4000-8000-000000000001'), 5000::bigint, 'RPC reports positive stock exactly like the ledger');

select lives_ok($$select public.record_stock_operation(
  'a2000000-0000-4000-8000-000000000001', 'WASTE',
  '[{"product_id":"a5000000-0000-4000-8000-000000000001","quantity_grams":5000}]',
  null, 'DETERIORATION', 'Zero stock fixture', now()
)$$, 'admin can waste the full quantity (zero stock fixture)');
select is((select current_stock_grams from public.get_branch_stock_status() where branch_id = 'a2000000-0000-4000-8000-000000000001' and product_id = 'a5000000-0000-4000-8000-000000000001'), 0::bigint, 'RPC reports exactly zero stock, not null and not an error');
select is((select stock_status from public.get_branch_stock_status() where branch_id = 'a2000000-0000-4000-8000-000000000001' and product_id = 'a5000000-0000-4000-8000-000000000001'), 'OUT_OF_STOCK', 'zero stock is classified as OUT_OF_STOCK');

select lives_ok($$select public.record_stock_operation(
  'a2000000-0000-4000-8000-000000000001', 'WASTE',
  '[{"product_id":"a5000000-0000-4000-8000-000000000001","quantity_grams":2000}]',
  null, 'DETERIORATION', 'Negative stock fixture', now()
)$$, 'the ledger allows waste beyond available stock (negative stock is a real, unclamped state)');
select is((select current_stock_grams from public.get_branch_stock_status() where branch_id = 'a2000000-0000-4000-8000-000000000001' and product_id = 'a5000000-0000-4000-8000-000000000001'), (-2000)::bigint, 'RPC reports negative stock unclamped, same as the ledger sum');

-- Product with zero movements ever.
select is((select current_stock_grams from public.get_branch_stock_status() where branch_id = 'a2000000-0000-4000-8000-000000000001' and product_id = 'a5000000-0000-4000-8000-000000000002'), 0::bigint, 'a product with no stock_movements rows still appears, coalesced to zero');

-- UNIT products are excluded, exactly like the legacy view (unchanged behavior).
select is((select count(*) from public.get_branch_stock_status() where product_id = 'a5000000-0000-4000-8000-000000000003'), 0::bigint, 'UNIT products are excluded, matching branch_stock_status semantics');

-- Multiple branches: admin sees both org A branches in one call.
select is((select count(distinct branch_id) from public.get_branch_stock_status() where branch_id in ('a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000002')), 2::bigint, 'admin (branches.read_all) sees stock across every active branch in the organization');

-- Cross-organization isolation: org A admin never sees org B's branch, even by
-- passing its id explicitly as p_branch_id (parameter cannot be used to cross tenants).
select is((select count(*) from public.get_branch_stock_status('a2000000-0000-4000-8000-000000000003')), 0::bigint, 'passing another organization''s branch id returns zero rows, not that organization''s stock');

-- Nonexistent branch id: empty result, no error, no leak.
select is((select count(*) from public.get_branch_stock_status('00000000-0000-4000-8000-000000000099')), 0::bigint, 'a nonexistent branch id returns zero rows without raising');

-- Old view and new RPC agree exactly for this organization (semantic equivalence).
select is(
  (select jsonb_agg(row_to_json(v) order by v.branch_id, v.product_id) from (
    select branch_id, product_id, current_stock_grams, minimum_stock_grams, target_stock_grams, suggested_replenishment_grams, stock_status
    from public.branch_stock_status where organization_id = 'a1000000-0000-4000-8000-000000000001'
  ) v),
  (select jsonb_agg(row_to_json(r) order by r.branch_id, r.product_id) from (
    select branch_id, product_id, current_stock_grams, minimum_stock_grams, target_stock_grams, suggested_replenishment_grams, stock_status
    from public.get_branch_stock_status() r
  ) r),
  'the RPC returns byte-identical rows to the legacy view for the same organization'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a3000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

-- Employee has stock.read but is only a member of branch A1: branch A2 must not appear.
select is((select count(*) from public.get_branch_stock_status() where branch_id = 'a2000000-0000-4000-8000-000000000001'), 2::bigint, 'employee sees stock for the branch they are assigned to (2 WEIGHT products; the UNIT product is excluded)');
select is((select count(*) from public.get_branch_stock_status() where branch_id = 'a2000000-0000-4000-8000-000000000002'), 0::bigint, 'employee cannot see stock for a branch they are not assigned to');
select is((select count(*) from public.get_branch_stock_status('a2000000-0000-4000-8000-000000000002')), 0::bigint, 'requesting the unassigned branch explicitly by id still returns zero rows');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a3000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

-- Cross-organization isolation from the other side: org B admin gets org B's own
-- (empty) stock, never org A's.
select is((select count(*) from public.get_branch_stock_status()), 0::bigint, 'org B admin sees zero rows: org B has no branches with stock yet, not org A''s data');
select is((select count(*) from public.get_branch_stock_status() where branch_id in ('a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000002')), 0::bigint, 'org B admin cannot see org A''s branches even when filtering by their exact ids');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a3000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000004","role":"authenticated"}', true);

-- Authenticated but no organization membership at all.
select throws_ok($$select * from public.get_branch_stock_status()$$, '42501', 'Permission stock.read is required', 'a user with no organization membership is rejected before any query runs');

reset role;
set local role anon;
select throws_ok($$select * from public.get_branch_stock_status()$$, '42501', 'permission denied for function get_branch_stock_status', 'anonymous cannot call the RPC at all (EXECUTE revoked)');

reset role;
select * from finish();
rollback;
