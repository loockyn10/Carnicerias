begin;

create extension if not exists pgtap with schema extensions;
select plan(103);

-- Shape and hardening.
select has_table('public', 'production_batches', 'production_batches table exists');
select has_table('public', 'production_batch_outputs', 'production_batch_outputs table exists');
select has_function('public', 'create_production_batch', array['uuid','integer','bigint','uuid','integer','text','text'], 'create RPC exists');
select has_function('public', 'update_production_batch_header', array['uuid','uuid','integer','bigint','integer','text','text'], 'update header RPC exists');
select has_function('public', 'set_production_batch_output', array['uuid','uuid','integer'], 'set output RPC exists');
select has_function('public', 'remove_production_batch_output', array['uuid'], 'remove output RPC exists');
select has_function('public', 'cancel_production_batch', array['uuid'], 'cancel RPC exists');
select has_function('public', 'complete_production_batch', array['uuid'], 'complete RPC exists');
select has_function('public', 'list_production_batches', array['uuid','text','integer'], 'list RPC exists');
select has_function('public', 'get_production_batch_detail', array['uuid'], 'detail RPC exists');
select ok((select relrowsecurity from pg_class where oid = 'public.production_batches'::regclass), 'production_batches has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.production_batch_outputs'::regclass), 'production_batch_outputs has RLS');
select ok(not has_table_privilege('authenticated', 'public.production_batches', 'INSERT'), 'browser clients cannot insert batches directly');
select ok(not has_table_privilege('authenticated', 'public.production_batch_outputs', 'UPDATE'), 'browser clients cannot update outputs directly');
select ok(not has_function_privilege('anon', 'public.complete_production_batch(uuid)', 'EXECUTE'), 'anonymous cannot finalize batches');
select ok((select bool_and(prosecdef) from pg_proc where oid in (
  'public.create_production_batch(uuid,integer,bigint,uuid,integer,text,text)'::regprocedure,
  'public.complete_production_batch(uuid)'::regprocedure,
  'public.get_production_batch_detail(uuid)'::regprocedure
)), 'production RPCs are security definer');
select ok(exists (select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000001' and permission_key = 'production.read'), 'admin receives production read permission');
select ok(exists (select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000001' and permission_key = 'production.write'), 'admin receives production write permission');
select ok(not exists (select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000002' and permission_key like 'production.%'), 'employee receives no production permission (Desposte is an Admin-only capability, matching settlements.*/analytics.read)');
select has_column('public', 'stock_movements', 'production_batch_id', 'stock_movements gained a production_batch_id link column');

-- Fixture: two organizations. Org A has two branches (employee assigned only to A1).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'production-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Org A Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'production-employee-a1@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Org A Employee A1"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'production-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Org B Admin"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('b2000000-0000-4000-8000-000000000001', 'Production Org A', 'production-org-a'),
  ('b2000000-0000-4000-8000-000000000002', 'Production Org B', 'production-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Org A Branch 1', 'PA1'),
  ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'Org A Branch 2', 'PA2'),
  ('b3000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000002', 'Org B Branch 1', 'PB1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002');

insert into public.categories (id, organization_id, name, slug) values
  ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Production Category', 'production-category'),
  ('b4000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', 'Production Category B', 'production-category-b');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, inventory_role) values
  ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Media res de cerdo', 'media-res-de-cerdo', 'INSUMO-1', 'WEIGHT', 'RAW_MATERIAL'),
  ('b5000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Vacio', 'vacio', 'CORTE-1', 'WEIGHT', 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Costilla', 'costilla', 'CORTE-2', 'WEIGHT', 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Sin Precio', 'sin-precio', 'CORTE-3', 'WEIGHT', 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000005', 'b2000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-000000000002', 'Producto Org B', 'producto-org-b', 'ORGB-1', 'WEIGHT', 'BOTH');

-- $10.000/kg and $59.500/kg so the two outputs sum to exactly $139.000 of potential value,
-- matching the worked example already verified in packages/business-logic/src/production.test.ts.
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002', 1000000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000003', 5950000, now() - interval '1 day');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Normal batch: 20 kg @ $4.200/kg = $84.000, two outputs of 2 kg each.
select lives_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000001', p_input_weight_grams => 20000, p_cost_per_kg_cents => 420000,
  p_branch_id => 'b3000000-0000-4000-8000-000000000001', p_input_unit_count => 5, p_description => 'Media res de cerdo #1'
)$$, 'org A admin creates a draft batch in branch A1');
select is((select input_unit_count from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'), 5, 'input_unit_count is stored as tracking-only metadata');

select is((select cost_total_cents from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'), 8400000::bigint, 'cost_total_cents is computed automatically');
select is((select status::text from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'), 'DRAFT', 'a new batch starts as DRAFT');

select lives_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'),
  'b5000000-0000-4000-8000-000000000002', 2000
)$$, 'admin adds the vacio output');
select lives_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'),
  'b5000000-0000-4000-8000-000000000003', 2000
)$$, 'admin adds the costilla output');

select is((
  public.get_production_batch_detail((select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'))
  -> 'summary' ->> 'marginOverSalesBps'
)::bigint, 3957::bigint, 'live preview matches the exact-rounding margin-over-sales example (39.57%)');
select is((
  public.get_production_batch_detail((select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'))
  -> 'summary' ->> 'canFinalize'
)::boolean, true, 'batch can be finalized once every output has a price and fits the input weight');

select lives_ok($$select public.complete_production_batch(
  (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001')
)$$, 'admin finalizes the batch');
select is((select status::text from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'), 'COMPLETED', 'batch becomes COMPLETED');
select is((select produced_weight_grams from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'), 4000, 'produced weight is snapshotted');
select is((select waste_grams from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'), 16000, 'waste is snapshotted');
select is((select total_sale_value_cents from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'), 13900000::bigint, 'total sale value snapshot matches $139.000');
select is((select sum(allocated_cost_cents_snapshot) from public.production_batch_outputs where batch_id = (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001')), 8400000::bigint, 'allocated costs sum EXACTLY to the batch cost, no rounding leak');

-- Stock ledger integration: the existing stock_movements ledger, not a second inventory model.
select is((
  select quantity_grams from public.stock_movements
  where production_batch_id = (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001')
    and type = 'PRODUCTION_CONSUME'
), (-20000)::bigint, 'finalizing writes a PRODUCTION_CONSUME movement for the full input weight');
select is((
  select count(*) from public.stock_movements
  where production_batch_id = (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001')
    and type = 'PRODUCTION_YIELD'
), 2::bigint, 'finalizing writes one PRODUCTION_YIELD movement per output');
select is((
  select sum(quantity_grams) from public.stock_movements
  where production_batch_id = (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001')
    and type = 'PRODUCTION_YIELD'
), 4000::bigint, 'PRODUCTION_YIELD movements sum to the produced weight');
select is((
  select quantity_grams from public.stock_levels
  where organization_id = 'b2000000-0000-4000-8000-000000000001' and branch_id = 'b3000000-0000-4000-8000-000000000001'
    and product_id = 'b5000000-0000-4000-8000-000000000001'
), (-20000)::bigint, 'derived stock for the source product reflects the consumption (negative stock is an accepted real state, same as WASTE/ADJUSTMENT_NEGATIVE)');
select is((
  select quantity_grams from public.stock_levels
  where organization_id = 'b2000000-0000-4000-8000-000000000001' and branch_id = 'b3000000-0000-4000-8000-000000000001'
    and product_id = 'b5000000-0000-4000-8000-000000000002'
), 2000::bigint, 'derived stock for an output product reflects the yield');

-- Immutability of a completed batch.
select throws_ok($$select public.complete_production_batch(
  (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001')
)$$, '22023', 'Sólo un lote en borrador puede finalizarse', 'a completed batch cannot be finalized again');
select throws_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'), 'b5000000-0000-4000-8000-000000000002', 500
)$$, '22023', 'Sólo un lote en borrador puede editar sus productos obtenidos', 'a completed batch cannot have its outputs edited');
select throws_ok($$select public.update_production_batch_header(
  p_batch_id => (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001'),
  p_source_product_id => 'b5000000-0000-4000-8000-000000000001', p_input_weight_grams => 25000, p_cost_per_kg_cents => 400000
)$$, '22023', 'Sólo un lote en borrador puede editarse', 'a completed batch header cannot be edited');
select throws_ok($$select public.cancel_production_batch(
  (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001')
)$$, '22023', 'Sólo un lote en borrador puede cancelarse', 'a completed batch cannot be cancelled (reversal flow is a future sprint)');

-- Validation: outputs exceeding the input weight block finalizing.
select lives_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000001', p_input_weight_grams => 1000, p_cost_per_kg_cents => 420000,
  p_branch_id => 'b3000000-0000-4000-8000-000000000001', p_description => 'Lote sobrepasado'
)$$, 'admin creates a second batch with a small input weight');
select lives_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where description = 'Lote sobrepasado'), 'b5000000-0000-4000-8000-000000000002', 2000
)$$, 'an output can still be entered while editing, even past the input weight');
select throws_ok($$select public.complete_production_batch(
  (select id from public.production_batches where description = 'Lote sobrepasado')
)$$, '22023', 'Los productos obtenidos no pueden superar el peso de entrada', 'finalizing is blocked when outputs exceed the input weight');

-- Validation: a missing price blocks finalizing and names the product.
select lives_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000001', p_input_weight_grams => 5000, p_cost_per_kg_cents => 420000,
  p_branch_id => 'b3000000-0000-4000-8000-000000000001', p_description => 'Lote sin precio'
)$$, 'admin creates a third batch');
select lives_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where description = 'Lote sin precio'), 'b5000000-0000-4000-8000-000000000004', 1000
)$$, 'admin adds an output with no current price');
select lives_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where description = 'Lote sin precio'), 'b5000000-0000-4000-8000-000000000002', 1000
)$$, 'admin adds a second, correctly priced output to the same batch');
select is((
  public.get_production_batch_detail((select id from public.production_batches where description = 'Lote sin precio')) -> 'summary' ->> 'missingPriceProductName'
), 'Sin Precio', 'the preview names exactly which product needs a price');
select is((
  public.get_production_batch_detail((select id from public.production_batches where description = 'Lote sin precio')) -> 'summary' -> 'totalSaleValueCents'
), 'null'::jsonb, 'totalSaleValueCents is null (not a partial sum) while any output is missing a price');
select throws_ok($$select public.complete_production_batch(
  (select id from public.production_batches where description = 'Lote sin precio')
)$$, '22023', 'El producto "Sin Precio" no tiene un precio de venta vigente', 'finalizing is blocked and names the product missing a price');

-- Validation: a batch with no outputs cannot be finalized.
select lives_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000001', p_input_weight_grams => 5000, p_cost_per_kg_cents => 420000,
  p_branch_id => 'b3000000-0000-4000-8000-000000000001', p_description => 'Lote vacio'
)$$, 'admin creates an empty batch');
select throws_ok($$select public.complete_production_batch(
  (select id from public.production_batches where description = 'Lote vacio')
)$$, '22023', 'El lote no tiene productos obtenidos', 'finalizing an empty batch is blocked');

-- A draft can be cancelled; a cancelled batch is then immutable too.
select lives_ok($$select public.cancel_production_batch(
  (select id from public.production_batches where description = 'Lote vacio')
)$$, 'admin cancels the empty draft');
select is((select status::text from public.production_batches where description = 'Lote vacio'), 'CANCELLED', 'cancelled batch is marked CANCELLED');
select throws_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where description = 'Lote vacio'), 'b5000000-0000-4000-8000-000000000002', 500
)$$, '22023', 'Sólo un lote en borrador puede editar sus productos obtenidos', 'a cancelled batch cannot have outputs added');

-- Branch isolation within the same organization: a batch created in branch A2 (admin has
-- branches.read_all so this succeeds).
select lives_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000001', p_input_weight_grams => 5000, p_cost_per_kg_cents => 420000,
  p_branch_id => 'b3000000-0000-4000-8000-000000000002', p_description => 'Lote sucursal A2'
)$$, 'admin creates a batch in branch A2');
select lives_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000001', p_input_weight_grams => 3000, p_cost_per_kg_cents => 420000,
  p_branch_id => 'b3000000-0000-4000-8000-000000000001', p_description => 'Lote org A extra'
)$$, 'admin creates one more batch in branch A1, reused below for the employee/org B checks');

-- Desposte is an Admin-only capability (see the permission assertions above): an employee,
-- even one assigned to the branch itself, must be blocked by every production RPC, not merely
-- by branch membership.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select throws_ok($$select public.list_production_batches()$$, '42501', 'Permission production.read is required', 'an employee cannot list production batches at all');
select throws_ok($$select public.get_production_batch_detail(
  (select id from public.production_batches where description = 'Lote org A extra')
)$$, '42501', 'Branch is not authorized for this user', 'an employee cannot read a batch even in their own assigned branch');
-- create_production_batch now resolves the organization via require_permission('production.write')
-- before touching p_branch_id at all (so it can fall back to organizations.production_branch_id
-- when no branch is given), so an employee with no production.write anywhere is rejected by that
-- check itself, before branch authorization is ever evaluated.
select throws_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000001', p_input_weight_grams => 3000, p_cost_per_kg_cents => 420000,
  p_branch_id => 'b3000000-0000-4000-8000-000000000001'
)$$, '42501', 'Permission production.write is required', 'an employee cannot create a batch even in their own assigned branch');
select is((select count(*) from public.production_batches), 0::bigint, 'RLS hides every production batch from the employee, including ones in their own branch');

-- Cross-organization isolation.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

select is((select count(*) from public.production_batches), 0::bigint, 'org B admin cannot see any org A batch through RLS');
select is((select count(*) from public.stock_movements where type in ('PRODUCTION_CONSUME', 'PRODUCTION_YIELD')), 0::bigint, 'org B admin cannot see org A''s production stock movements through RLS');
select is((jsonb_array_length(public.list_production_batches())), 0, 'org B admin lists zero batches (none exist in org B yet)');
select throws_ok($$select public.get_production_batch_detail(
  (select id from public.production_batches where description = 'Lote org A extra')
)$$, '42501', 'Branch is not authorized for this user', 'org B admin cannot read an org A batch by id');
select throws_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where description = 'Lote org A extra'), 'b5000000-0000-4000-8000-000000000005', 500
)$$, '42501', 'Branch is not authorized for this user', 'org B admin cannot insert an output into an org A batch');
select throws_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000005', p_input_weight_grams => 5000, p_cost_per_kg_cents => 100000,
  p_branch_id => 'b3000000-0000-4000-8000-000000000001'
)$$, '42501', 'Branch is not authorized for this user', 'org B admin cannot create a batch against org A''s branch');

-- Raw materials vs sellable products, production branch default, and draft delete: back to org A
-- admin, who has both production.write and products.write.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select has_column('public', 'products', 'inventory_role', 'products gained an inventory_role column');
select has_column('public', 'organizations', 'production_branch_id', 'organizations gained a production_branch_id column');
select has_column('public', 'production_batches', 'input_unit_count', 'production_batches gained an input_unit_count column');
select has_function('public', 'set_product_inventory_role', array['uuid','text'], 'set inventory role RPC exists');
select has_function('public', 'set_production_branch', array['uuid'], 'set production branch RPC exists');
select has_function('public', 'delete_production_batch', array['uuid'], 'delete draft RPC exists');

select is((select inventory_role::text from public.products where id = 'b5000000-0000-4000-8000-000000000001'), 'RAW_MATERIAL', 'Media res de cerdo starts as RAW_MATERIAL in this fixture');
select is((select inventory_role::text from public.products where id = 'b5000000-0000-4000-8000-000000000002'), 'SELLABLE', 'Vacio defaults to SELLABLE');

-- The Desposte input selector only offers RAW_MATERIAL/BOTH products.
select is(
  (select array_agg(product_name order by product_name) from public.get_production_catalog('b3000000-0000-4000-8000-000000000001')),
  array['Media res de cerdo'],
  'get_production_catalog only lists raw-material products as Desposte inputs'
);
select throws_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000002', p_input_weight_grams => 1000, p_cost_per_kg_cents => 100000,
  p_branch_id => 'b3000000-0000-4000-8000-000000000001'
)$$, '42501', 'El insumo de origen debe ser un producto activo por peso configurado como materia prima', 'a SELLABLE-only product (Vacio) cannot be used as a Desposte input');

-- Promoting a sellable cut to BOTH makes it usable as an input without losing its sellable side.
select lives_ok($$select public.set_product_inventory_role('b5000000-0000-4000-8000-000000000004', 'BOTH')$$, 'admin promotes Sin Precio to BOTH');
select is(
  (select array_agg(product_name order by product_name) from public.get_production_catalog('b3000000-0000-4000-8000-000000000001')),
  array['Media res de cerdo', 'Sin Precio'],
  'get_production_catalog includes a product promoted to BOTH'
);
select lives_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000004', p_input_weight_grams => 1000, p_cost_per_kg_cents => 100000,
  p_branch_id => 'b3000000-0000-4000-8000-000000000001', p_description => 'Lote insumo BOTH'
)$$, 'a BOTH product can be used as a Desposte input');
select lives_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where description = 'Lote org A extra'), 'b5000000-0000-4000-8000-000000000004', 500
)$$, 'a BOTH product can still be used as a Desposte output (its sellable side is preserved)');

-- Demoting it back to RAW_MATERIAL-only blocks the output side again.
select lives_ok($$select public.set_product_inventory_role('b5000000-0000-4000-8000-000000000004', 'RAW_MATERIAL')$$, 'admin demotes Sin Precio to RAW_MATERIAL-only');
select throws_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where description = 'Lote insumo BOTH'), 'b5000000-0000-4000-8000-000000000004', 500
)$$, '42501', 'El producto obtenido debe ser un producto activo del catálogo, vendido por peso y configurado como producto de venta', 'a RAW_MATERIAL-only product cannot be used as a Desposte output');

select throws_ok($$select public.set_product_inventory_role('b5000000-0000-4000-8000-000000000004', 'NOT_A_ROLE')$$, '22023', 'Unsupported inventory role', 'an unsupported inventory role is rejected');
select throws_ok($$select public.set_product_inventory_role(
  'b5000000-0000-4000-8000-000000000005', 'RAW_MATERIAL'
)$$, '42501', 'Product was not found in this organization', 'org A admin cannot set the inventory role of an org B product');

-- Production branch default: unset initially, blocks creating a batch without an explicit branch,
-- can only be set to a branch of the same organization, and once set is used automatically.
select is((select production_branch_id from public.organizations where id = 'b2000000-0000-4000-8000-000000000001'), null::uuid, 'org A has no production branch configured yet');
select throws_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000001', p_input_weight_grams => 1000, p_cost_per_kg_cents => 100000
)$$, '22023', 'No hay una sucursal habitual de producción configurada. Configurala antes de crear un desposte.', 'creating a batch with no branch and no configured default is blocked with a clear message');
select throws_ok($$select public.set_production_branch(
  'b3000000-0000-4000-8000-000000000003'
)$$, '42501', 'Branch was not found in this organization', 'org A admin cannot set org B''s branch as their production branch');
select lives_ok($$select public.set_production_branch('b3000000-0000-4000-8000-000000000001')$$, 'org A admin sets Branch A1 as the production branch');
select is((select production_branch_id from public.organizations where id = 'b2000000-0000-4000-8000-000000000001'), 'b3000000-0000-4000-8000-000000000001'::uuid, 'organizations.production_branch_id is persisted');
select lives_ok($$select public.create_production_batch(
  p_source_product_id => 'b5000000-0000-4000-8000-000000000001', p_input_weight_grams => 2000, p_cost_per_kg_cents => 100000, p_description => 'Lote sin sucursal explicita'
)$$, 'creating a batch with no branch now falls back to the configured production branch');
select is(
  (public.get_production_batch_detail((select id from public.production_batches where description = 'Lote sin sucursal explicita')) -> 'batch' ->> 'branchId'),
  'b3000000-0000-4000-8000-000000000001', 'the batch was created in the configured default production branch'
);

-- Deleting a DRAFT never touches stock and cascades its outputs; a COMPLETED batch cannot be
-- deleted at all (see D-030 — only a true reversal flow, not built this sprint, could do that).
select lives_ok($$select public.set_production_batch_output(
  (select id from public.production_batches where description = 'Lote sin sucursal explicita'), 'b5000000-0000-4000-8000-000000000002', 500
)$$, 'admin adds an output to the soon-to-be-deleted draft');
select lives_ok($$select public.delete_production_batch(
  (select id from public.production_batches where description = 'Lote sin sucursal explicita')
)$$, 'admin deletes the draft batch');
select is((select count(*) from public.production_batches where description = 'Lote sin sucursal explicita'), 0::bigint, 'the deleted draft no longer exists');
select is((select count(*) from public.production_batch_outputs o where not exists (select 1 from public.production_batches b where b.id = o.batch_id)), 0::bigint, 'no orphan outputs remain after deleting a draft (its output row was cascade-deleted with it)');
select throws_ok($$select public.delete_production_batch(
  (select id from public.production_batches where organization_id = 'b2000000-0000-4000-8000-000000000001' and status = 'COMPLETED' limit 1)
)$$, '22023', 'Sólo un lote en borrador puede eliminarse', 'a COMPLETED batch cannot be deleted');
select is((select count(*) from public.stock_movements where type in ('PRODUCTION_CONSUME', 'PRODUCTION_YIELD')), 3::bigint, 'deleting draft batches never wrote or removed any stock movement (still exactly the 3 from the one completed batch)');

-- Employees get none of this either (Desposte configuration stays Admin-only).
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_production_branch('b3000000-0000-4000-8000-000000000001')$$, '42501', 'Permission production.write is required', 'an employee cannot set the production branch');
select throws_ok($$select public.set_product_inventory_role('b5000000-0000-4000-8000-000000000001', 'SELLABLE')$$, '42501', 'Permission products.write is required', 'an employee cannot set a product''s inventory role');
select throws_ok($$select public.delete_production_batch(
  (select id from public.production_batches where description = 'Lote org A extra')
)$$, '42501', 'Branch is not authorized for this user', 'an employee cannot delete a draft, even in their own assigned branch');

reset role;
select * from finish();
