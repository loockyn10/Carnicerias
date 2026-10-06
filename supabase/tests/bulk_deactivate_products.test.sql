begin;

create extension if not exists pgtap with schema extensions;
select plan(29);

-- Shape.
select has_function('public', 'deactivate_products', array['uuid[]'], 'deactivate_products RPC exists');
select ok(not has_function_privilege('anon', 'public.deactivate_products(uuid[])', 'EXECUTE'), 'anonymous cannot deactivate products');
select ok(has_function_privilege('authenticated', 'public.deactivate_products(uuid[])', 'EXECUTE'), 'authenticated can call deactivate_products (the permission check lives inside)');

-- Fixture: two organizations, an admin and an employee of the first one.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'bulk-deact-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Bulk Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'bulk-deact-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Bulk Employee"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'Bulk Org A', 'bulk-org-a'),
  ('d2000000-0000-4000-8000-000000000002', 'Bulk Org B', 'bulk-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Bulk Branch', 'BK1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002');

insert into public.categories (id, organization_id, name, slug) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Bulk Category A', 'bulk-category-a'),
  ('d4000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000002', 'Bulk Category B', 'bulk-category-b');
-- A1..A3, A5 active; A4 already inactive; B1 belongs to the other organization.
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Bulk A1', 'bulk-a1', 'BK-A1', 'WEIGHT', true),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Bulk A2', 'bulk-a2', 'BK-A2', 'WEIGHT', true),
  ('d5000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Bulk A3', 'bulk-a3', 'BK-A3', 'WEIGHT', true),
  ('d5000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Bulk A4', 'bulk-a4', 'BK-A4', 'WEIGHT', false),
  ('d5000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Bulk A5', 'bulk-a5', 'BK-A5', 'WEIGHT', true),
  ('d5000000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-000000000002', 'Bulk B1', 'bulk-b1', 'BK-B1', 'WEIGHT', true);
-- History attached to A1 (price, barcode, stock ledger): it must survive the deactivation.
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 1450000, now() - interval '1 day');
insert into public.product_barcodes (organization_id, product_id, barcode) values
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'BULKA1CODE');
insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'ADJUSTMENT_POSITIVE', 5000, 'd1000000-0000-4000-8000-000000000001');

select set_config('test.a4_updated_at', (select updated_at::text from public.products where id = 'd5000000-0000-4000-8000-000000000004'), false);
select set_config('test.last_change', (select coalesce(max(sequence), 0)::text from public.pos_catalog_changes), false);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Happy path: two products in ONE call.
select is(
  public.deactivate_products(array['d5000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002']::uuid[]),
  '{"requested": 2, "deactivated": 2, "alreadyInactive": 0}'::jsonb,
  'deactivating two active products reports 2 deactivated'
);
select is((select active from public.products where id = 'd5000000-0000-4000-8000-000000000001'), false, 'A1 is inactive');
select is((select active from public.products where id = 'd5000000-0000-4000-8000-000000000002'), false, 'A2 is inactive');
select is((select active from public.products where id = 'd5000000-0000-4000-8000-000000000003'), true, 'A3 (not selected) is still active');

-- Never a physical delete: every product row still exists, and so does the history.
select is((select count(*) from public.products where organization_id = 'd2000000-0000-4000-8000-000000000001'), 5::bigint, 'no product row was deleted');
select is((select price_cents from public.product_prices where product_id = 'd5000000-0000-4000-8000-000000000001' and valid_to is null), 1450000::bigint, 'A1 price history is intact');
select is((select count(*) from public.product_barcodes where product_id = 'd5000000-0000-4000-8000-000000000001'), 1::bigint, 'A1 barcode is intact');
select is((select count(*) from public.stock_movements where product_id = 'd5000000-0000-4000-8000-000000000001'), 1::bigint, 'A1 stock ledger is intact');
select is((select count(*) from public.products where organization_id = 'd2000000-0000-4000-8000-000000000001' and not active), 3::bigint, 'inactive products (A1, A2, A4) are still listed by the inactive filter');

-- Idempotent / de-duplicated: repeated and already-inactive ids are counted once and not rewritten.
select is(
  public.deactivate_products(array['d5000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000003', 'd5000000-0000-4000-8000-000000000003']::uuid[]),
  '{"requested": 2, "deactivated": 1, "alreadyInactive": 1}'::jsonb,
  'a duplicated id counts once and an already-inactive product is reported separately'
);
select is(
  public.deactivate_products(array['d5000000-0000-4000-8000-000000000004']::uuid[]),
  '{"requested": 1, "deactivated": 0, "alreadyInactive": 1}'::jsonb,
  'an already-inactive product is a no-op'
);
select is((select updated_at::text from public.products where id = 'd5000000-0000-4000-8000-000000000004'), current_setting('test.a4_updated_at'), 'the already-inactive product row was not rewritten');

-- Atomic and tenant-isolated: one id from another organization (or unknown) rejects the whole batch.
select throws_ok(
  $$select public.deactivate_products(array['d5000000-0000-4000-8000-000000000005', 'd5000000-0000-4000-8000-000000000011']::uuid[])$$,
  '42501', 'Uno de los productos no existe en esta organización', 'a batch with a product of another organization is rejected'
);
select is((select active from public.products where id = 'd5000000-0000-4000-8000-000000000005'), true, 'A5 stayed active: the rejected batch changed nothing');
select throws_ok(
  $$select public.deactivate_products(array['d5000000-0000-4000-8000-000000000005', 'ffffffff-ffff-4fff-8fff-ffffffffffff']::uuid[])$$,
  '42501', 'Uno de los productos no existe en esta organización', 'a batch with an unknown product is rejected'
);

-- Input validation.
select throws_ok($$select public.deactivate_products(array[]::uuid[])$$, '22023', 'Debe enviar entre 1 y 500 productos', 'an empty batch is rejected');
select throws_ok($$select public.deactivate_products(null)$$, '22023', 'Debe enviar entre 1 y 500 productos', 'a null batch is rejected');
select throws_ok($$select public.deactivate_products(array['d5000000-0000-4000-8000-000000000005', null]::uuid[])$$, '22023', 'Debe enviar entre 1 y 500 productos', 'a null element is rejected');
select throws_ok($$select public.deactivate_products(array(select gen_random_uuid() from generate_series(1, 501)))$$, '22023', 'Debe enviar entre 1 y 500 productos', 'more than 500 products is rejected');

-- Same side effects as the single-product path: audit trail and POS catalog change log.
reset role;
select ok(exists (
  select 1 from public.audit_logs
  where entity_id = 'd5000000-0000-4000-8000-000000000001' and after_data ->> 'active' = 'false' and before_data ->> 'active' = 'true'
    and actor_profile_id = 'd1000000-0000-4000-8000-000000000001'
), 'the deactivation is audited with the acting admin');
select is((select count(*) from public.audit_logs where entity_id = 'd5000000-0000-4000-8000-000000000004' and before_data ->> 'active' = 'false' and after_data ->> 'active' = 'false'), 0::bigint, 'no audit row for the already-inactive product');
select ok(exists (
  select 1 from public.pos_catalog_changes
  where entity_type = 'PRODUCT' and entity_id = 'd5000000-0000-4000-8000-000000000001' and sequence > current_setting('test.last_change')::bigint
), 'the POS catalog change log records the deactivation so the POS sync picks it up');
select ok(exists (
  select 1 from public.pos_catalog_changes
  where entity_type = 'PRODUCT' and entity_id = 'd5000000-0000-4000-8000-000000000002' and sequence > current_setting('test.last_change')::bigint
), 'every product of the batch is logged for the POS sync');

-- An employee (no products.write) is blocked.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
  $$select public.deactivate_products(array['d5000000-0000-4000-8000-000000000005']::uuid[])$$,
  '42501', 'Permission products.write is required', 'an employee cannot deactivate products'
);

reset role;
select is((select active from public.products where id = 'd5000000-0000-4000-8000-000000000005'), true, 'A5 is still active after the employee attempt');
select is((select active from public.products where id = 'd5000000-0000-4000-8000-000000000011'), true, 'B1 (other organization) was never touched, not even by the rejected batch');

select * from finish();
rollback;
