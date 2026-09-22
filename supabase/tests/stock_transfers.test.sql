begin;

create extension if not exists pgtap with schema extensions;
select plan(49);

-- Shape and hardening.
select has_table('public', 'stock_transfers', 'stock_transfers table exists');
select has_table('public', 'stock_transfer_items', 'stock_transfer_items table exists');
select has_column('public', 'stock_movements', 'stock_transfer_id', 'stock_movements gained a stock_transfer_id link column');
select has_function('public', 'create_stock_transfer', array['uuid','uuid','jsonb','text'], 'create transfer RPC exists');
select has_function('public', 'list_stock_transfers', array['uuid','integer'], 'list transfers RPC exists');
select ok((select relrowsecurity from pg_class where oid = 'public.stock_transfers'::regclass), 'stock_transfers has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.stock_transfer_items'::regclass), 'stock_transfer_items has RLS');
select ok(not has_table_privilege('authenticated', 'public.stock_transfers', 'INSERT'), 'browser clients cannot insert transfers directly');
select ok(not has_table_privilege('authenticated', 'public.stock_transfer_items', 'INSERT'), 'browser clients cannot insert transfer items directly');
select ok(not has_function_privilege('anon', 'public.create_stock_transfer(uuid,uuid,jsonb,text)', 'EXECUTE'), 'anonymous cannot create transfers');
select ok((select prosecdef from pg_proc where oid = 'public.create_stock_transfer(uuid,uuid,jsonb,text)'::regprocedure), 'create_stock_transfer is security definer');

-- Fixture: two organizations. Org A has two real commercial branches (Central, Avenida); the
-- employee is assigned only to Central.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'transfer-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Org A Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'transfer-employee-central@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Org A Employee Central"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'transfer-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Org B Admin"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'Transfer Org A', 'transfer-org-a'),
  ('d2000000-0000-4000-8000-000000000002', 'Transfer Org B', 'transfer-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Central', 'CENTRAL'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA'),
  ('d3000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000002', 'Org B Branch 1', 'PB1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002');

insert into public.categories (id, organization_id, name, slug) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Transfer Category', 'transfer-category'),
  ('d4000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000002', 'Transfer Category B', 'transfer-category-b');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Costilla', 'costilla-transfer', 'TCORTE-1', 'WEIGHT'),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Vacio', 'vacio-transfer', 'TCORTE-2', 'WEIGHT'),
  ('d5000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Bebida', 'bebida-transfer', 'TUNIT-1', 'UNIT'),
  ('d5000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-000000000002', 'Producto Org B', 'producto-org-b-transfer', 'TORGB-1', 'WEIGHT');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Seed Central's stock through the real stock RPC (not a direct write), matching how the app
-- actually produces this data.
select lives_ok($$select public.record_stock_operation(
  'd3000000-0000-4000-8000-000000000001', 'PURCHASE',
  '[{"product_id":"d5000000-0000-4000-8000-000000000001","quantity_grams":10000},{"product_id":"d5000000-0000-4000-8000-000000000002","quantity_grams":5000}]',
  'Transfer Fixture Supplier', null, 'Stock fixture', now()
)$$, 'admin stocks Central with 10kg costilla and 5kg vacio');

-- Atomicity: a transfer with one valid item and one item exceeding available stock must apply
-- NEITHER item, not just block the failing one.
select throws_ok($$select public.create_stock_transfer(
  'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002',
  '[{"product_id":"d5000000-0000-4000-8000-000000000001","quantity_grams":3000},{"product_id":"d5000000-0000-4000-8000-000000000002","quantity_grams":7000}]',
  null
)$$, '22023', 'Stock insuficiente de "Vacio" en la sucursal de origen: disponible 5000, solicitado 7000', 'a transfer with insufficient stock on its second item is rejected');
select is((select count(*) from public.stock_transfers), 0::bigint, 'the failed transfer left no header row: nothing partially persisted');
select is((select count(*) from public.stock_movements where type in ('TRANSFER_IN', 'TRANSFER_OUT')), 0::bigint, 'the failed transfer wrote no ledger rows at all');
select is((select coalesce(sum(quantity_grams), 0) from public.stock_movements where organization_id = 'd2000000-0000-4000-8000-000000000001' and branch_id = 'd3000000-0000-4000-8000-000000000001' and product_id = 'd5000000-0000-4000-8000-000000000001'), 10000::bigint, 'Central''s costilla stock is untouched: the would-have-succeeded first item was rolled back too');

-- Validation, before any successful transfer exists.
select throws_ok($$select public.create_stock_transfer(
  'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001',
  '[{"product_id":"d5000000-0000-4000-8000-000000000001","quantity_grams":1000}]', null
)$$, '22023', 'El origen y el destino deben ser sucursales distintas', 'Central to Central is rejected');
select throws_ok($$select public.create_stock_transfer(
  'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002',
  '[{"product_id":"d5000000-0000-4000-8000-000000000001","quantity_grams":1000},{"product_id":"d5000000-0000-4000-8000-000000000001","quantity_grams":500}]', null
)$$, '22023', 'El mismo producto no puede repetirse en una transferencia', 'the same product cannot appear twice in one transfer');
select throws_ok($$select public.create_stock_transfer(
  'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002',
  '[{"product_id":"d5000000-0000-4000-8000-000000000003","quantity_grams":1}]', null
)$$, '42501', 'Product must be an active weight-based product in this organization', 'a UNIT product cannot be transferred (this sprint is WEIGHT-only)');
select throws_ok($$select public.create_stock_transfer(
  'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002',
  '[{"product_id":"d5000000-0000-4000-8000-000000000001","quantity_grams":0}]', null
)$$, '22023', 'Every transfer item needs a product and a positive weight', 'a zero-weight item is rejected');
select throws_ok($$select public.create_stock_transfer(
  'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', '[]', null
)$$, '22023', 'A transfer must contain between 1 and 100 items', 'an empty item list is rejected');

-- The real, successful transfer.
select lives_ok($$select public.create_stock_transfer(
  'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002',
  '[{"product_id":"d5000000-0000-4000-8000-000000000001","quantity_grams":4000},{"product_id":"d5000000-0000-4000-8000-000000000002","quantity_grams":3000}]',
  'Reparto matutino'
)$$, 'admin transfers 4kg costilla + 3kg vacio from Central to Avenida');

select is((select count(*) from public.stock_transfers), 1::bigint, 'exactly one transfer header now exists');
select is((select item_count from public.stock_transfers limit 1), 2, 'item_count is computed from the loop');
select is((select total_weight_grams from public.stock_transfers limit 1), 7000::bigint, 'total_weight_grams sums every item');
select is((select notes from public.stock_transfers limit 1), 'Reparto matutino', 'notes are stored');
select is((select source_branch_id from public.stock_transfers limit 1), 'd3000000-0000-4000-8000-000000000001'::uuid, 'source branch is Central');
select is((select destination_branch_id from public.stock_transfers limit 1), 'd3000000-0000-4000-8000-000000000002'::uuid, 'destination branch is Avenida');

-- Source branch decreased.
select is((select coalesce(sum(quantity_grams), 0) from public.stock_movements where organization_id = 'd2000000-0000-4000-8000-000000000001' and branch_id = 'd3000000-0000-4000-8000-000000000001' and product_id = 'd5000000-0000-4000-8000-000000000001'), 6000::bigint, 'Central costilla stock decreased by 4kg (10kg - 4kg)');
select is((select coalesce(sum(quantity_grams), 0) from public.stock_movements where organization_id = 'd2000000-0000-4000-8000-000000000001' and branch_id = 'd3000000-0000-4000-8000-000000000001' and product_id = 'd5000000-0000-4000-8000-000000000002'), 2000::bigint, 'Central vacio stock decreased by 3kg (5kg - 3kg)');
-- Destination branch increased.
select is((select coalesce(sum(quantity_grams), 0) from public.stock_movements where organization_id = 'd2000000-0000-4000-8000-000000000001' and branch_id = 'd3000000-0000-4000-8000-000000000002' and product_id = 'd5000000-0000-4000-8000-000000000001'), 4000::bigint, 'Avenida costilla stock increased by 4kg');
select is((select coalesce(sum(quantity_grams), 0) from public.stock_movements where organization_id = 'd2000000-0000-4000-8000-000000000001' and branch_id = 'd3000000-0000-4000-8000-000000000002' and product_id = 'd5000000-0000-4000-8000-000000000002'), 3000::bigint, 'Avenida vacio stock increased by 3kg');
-- Global stock conservation: a transfer never creates or destroys stock.
select is((select coalesce(sum(quantity_grams), 0) from public.stock_movements where organization_id = 'd2000000-0000-4000-8000-000000000001' and product_id = 'd5000000-0000-4000-8000-000000000001'), 10000::bigint, 'costilla stock is conserved organization-wide (still 10kg total)');
select is((select coalesce(sum(quantity_grams), 0) from public.stock_movements where organization_id = 'd2000000-0000-4000-8000-000000000001' and product_id = 'd5000000-0000-4000-8000-000000000002'), 5000::bigint, 'vacio stock is conserved organization-wide (still 5kg total)');

-- Ledger rows are traceable back to the transfer.
select is((select count(*) from public.stock_movements where stock_transfer_id = (select id from public.stock_transfers limit 1) and type = 'TRANSFER_OUT'), 2::bigint, 'two TRANSFER_OUT rows are linked to the transfer');
select is((select count(*) from public.stock_movements where stock_transfer_id = (select id from public.stock_transfers limit 1) and type = 'TRANSFER_IN'), 2::bigint, 'two TRANSFER_IN rows are linked to the transfer');

-- list_stock_transfers.
select is((jsonb_array_length(public.list_stock_transfers())), 1, 'admin lists exactly the one successful transfer');
select is(((public.list_stock_transfers() -> 0) ->> 'sourceBranchName'), 'Central', 'the listing resolves the source branch name');
select is(((public.list_stock_transfers() -> 0) ->> 'destinationBranchName'), 'Avenida', 'the listing resolves the destination branch name');
select is((((public.list_stock_transfers() -> 0) ->> 'totalWeightGrams')::bigint), 7000::bigint, 'the listing reports the total weight');
select is((jsonb_array_length((public.list_stock_transfers() -> 0) -> 'items')), 2, 'the listing includes both items');
select is((jsonb_array_length(public.list_stock_transfers('d3000000-0000-4000-8000-000000000002'))), 1, 'filtering by the destination branch still finds the transfer');
select throws_ok($$select public.list_stock_transfers(null, 0)$$, '22023', 'Limit must be between 1 and 200', 'a zero limit is rejected');
select throws_ok($$select public.list_stock_transfers(null, 500)$$, '22023', 'Limit must be between 1 and 200', 'an over-large limit is rejected');

-- Desposte/Distribución are administrative operations: an employee gets stock.read (so they can
-- see this transfer if it touches their branch) but not stock.write (so they cannot create one).
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select throws_ok($$select public.create_stock_transfer(
  'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002',
  '[{"product_id":"d5000000-0000-4000-8000-000000000001","quantity_grams":500}]', null
)$$, '42501', 'Permission stock.write is required', 'an employee cannot create a transfer even from their own assigned branch');
select is((jsonb_array_length(public.list_stock_transfers())), 1, 'an employee assigned to Central can still see the transfer through their branch membership');

-- Cross-organization isolation.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

select is((select count(*) from public.stock_transfers), 0::bigint, 'org B admin cannot see any org A transfer through RLS');
select is((jsonb_array_length(public.list_stock_transfers())), 0, 'org B admin lists zero transfers (none exist in org B yet)');
select throws_ok($$select public.create_stock_transfer(
  'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002',
  '[{"product_id":"d5000000-0000-4000-8000-000000000001","quantity_grams":500}]', null
)$$, '42501', 'Origin branch is not authorized for this user', 'org B admin cannot start a transfer from org A''s branch');

reset role;
select * from finish();
