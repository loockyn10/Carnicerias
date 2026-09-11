begin;

create extension if not exists pgtap with schema extensions;
select plan(35);

select has_table('public', 'pos_devices', 'POS devices exist');
select has_table('public', 'pos_sync_receipts', 'idempotency receipts exist');
select has_table('public', 'pos_catalog_changes', 'incremental catalog cursor exists');
select has_function('public', 'register_pos_device', array['uuid', 'uuid', 'text'], 'device registration RPC exists');
select has_function('public', 'pull_pos_state', array['uuid', 'bigint'], 'incremental pull RPC exists');
select has_function('public', 'sync_offline_sale', array['uuid', 'uuid', 'jsonb'], 'offline push RPC exists');
select ok((select relrowsecurity from pg_class where oid = 'public.pos_devices'::regclass), 'devices have RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.pos_sync_receipts'::regclass), 'receipts have RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.pos_catalog_changes'::regclass), 'change cursor has RLS');
select ok(has_table_privilege('authenticated', 'public.pos_devices', 'SELECT'), 'authenticated can query devices subject to admin-only RLS');
select ok(not has_table_privilege('authenticated', 'public.pos_sync_receipts', 'SELECT'), 'authenticated cannot query receipts directly');
select ok(not has_table_privilege('authenticated', 'public.pos_catalog_changes', 'SELECT'), 'authenticated cannot query cursor directly');
select ok(has_function_privilege('authenticated', 'public.register_pos_device(uuid,uuid,text)', 'EXECUTE'), 'authenticated can register an authorized device');
select ok(has_function_privilege('authenticated', 'public.pull_pos_state(uuid,bigint)', 'EXECUTE'), 'authenticated can pull its device state');
select ok(has_function_privilege('authenticated', 'public.sync_offline_sale(uuid,uuid,jsonb)', 'EXECUTE'), 'authenticated can push through the RPC');
select ok(not has_function_privilege('anon', 'public.sync_offline_sale(uuid,uuid,jsonb)', 'EXECUTE'), 'anonymous cannot push');
select ok((select prosecdef from pg_proc where oid = 'public.sync_offline_sale(uuid,uuid,jsonb)'::regprocedure), 'push RPC is security definer');
select is(
  (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.sync_offline_sale(uuid,uuid,jsonb)'::regprocedure),
  'search_path=""',
  'push RPC has an empty search path'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '71000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'phase1c-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Employee Offline"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '71000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'phase1c-outsider@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Outsider Offline"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('72000000-0000-4000-8000-000000000001', 'Phase 1C Org', 'phase-1c-org');
insert into public.branches (id, organization_id, name, code) values
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 'Offline Centro', 'OFF-CENTRO'),
  ('73000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000001', 'Offline Norte', 'OFF-NORTE');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001');
insert into public.categories (id, organization_id, name, slug) values
  ('74000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 'Vacunos Offline', 'vacunos-offline');
insert into public.products (id, organization_id, category_id, name, slug, unit_type) values
  ('75000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 'Vacío Offline', 'vacio-offline', 'WEIGHT'),
  ('75000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 'Asado Offline', 'asado-offline', 'WEIGHT');
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('72000000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-000000000001', 1200000, '2026-01-01T00:00:00Z'),
  ('72000000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-000000000002', 1000000, '2026-01-01T00:00:00Z');

create temporary table phase1c_payload(payload jsonb) on commit drop;
create temporary table phase1c_cursor(cursor bigint) on commit drop;
insert into phase1c_cursor select max(sequence) from public.pos_catalog_changes;
insert into phase1c_payload values (jsonb_build_object(
  'schemaVersion', 1,
  'eventId', '76000000-0000-4000-8000-000000000001',
  'saleId', '76000000-0000-4000-8000-000000000002',
  'organizationId', '72000000-0000-4000-8000-000000000001',
  'branchId', '73000000-0000-4000-8000-000000000001',
  'profileId', '71000000-0000-4000-8000-000000000001',
  'deviceId', '76000000-0000-4000-8000-000000000003',
  'status', 'COMPLETED',
  'totalCents', '2300000',
  'totalWeightGrams', '2050',
  'createdAt', now() - interval '1 minute',
  'completedAt', now() - interval '1 minute',
  'items', jsonb_build_array(
    jsonb_build_object('id', '76000000-0000-4000-8000-000000000004', 'productId', '75000000-0000-4000-8000-000000000001', 'productNameSnapshot', 'Vacío Offline', 'weightGrams', 1250, 'pricePerKgCents', '1200000', 'subtotalCents', '1500000'),
    jsonb_build_object('id', '76000000-0000-4000-8000-000000000005', 'productId', '75000000-0000-4000-8000-000000000002', 'productNameSnapshot', 'Asado Offline', 'weightGrams', 800, 'pricePerKgCents', '1000000', 'subtotalCents', '800000')
  ),
  'payment', jsonb_build_object('id', '76000000-0000-4000-8000-000000000006', 'method', 'CASH', 'amountCents', '2300000'),
  'stockMovements', jsonb_build_array(
    jsonb_build_object('id', '76000000-0000-4000-8000-000000000007', 'productId', '75000000-0000-4000-8000-000000000001', 'quantityGrams', '-1250', 'occurredAt', now() - interval '1 minute'),
    jsonb_build_object('id', '76000000-0000-4000-8000-000000000008', 'productId', '75000000-0000-4000-8000-000000000002', 'quantityGrams', '-800', 'occurredAt', now() - interval '1 minute')
  )
));
grant select on phase1c_payload to authenticated;
grant select on phase1c_cursor to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok(
  $$select public.register_pos_device('76000000-0000-4000-8000-000000000003', '73000000-0000-4000-8000-000000000001', 'Test POS')$$,
  'employee registers a device only in the assigned branch'
);
select is(
  (
    select (catalog_item ->> 'pricePerKgCents')::bigint
    from jsonb_array_elements(public.pull_pos_state('76000000-0000-4000-8000-000000000003', 0) -> 'catalog') catalog_item
    where catalog_item ->> 'productId' = '75000000-0000-4000-8000-000000000001'
  ),
  1200000::bigint,
  'initial pull returns the effective catalog snapshot'
);
select throws_ok(
  $$select public.register_pos_device('76000000-0000-4000-8000-000000000009', '73000000-0000-4000-8000-000000000002', 'Wrong branch')$$,
  '42501', 'Branch is not authorized for this user',
  'employee cannot bind a device to another branch'
);
select is(
  (public.sync_offline_sale('76000000-0000-4000-8000-000000000003', '76000000-0000-4000-8000-000000000001', (select payload from phase1c_payload)) ->> 'duplicate')::boolean,
  false,
  'first offline push inserts the aggregate'
);
select is((select count(*) from public.sales where id = '76000000-0000-4000-8000-000000000002'), 1::bigint, 'one sale was inserted');
select is((select count(*) from public.sale_items where sale_id = '76000000-0000-4000-8000-000000000002'), 2::bigint, 'both sale items were inserted');
select is((select amount_cents from public.payments where sale_id = '76000000-0000-4000-8000-000000000002'), 2300000::bigint, 'payment snapshot is exact');
select is((select sum(quantity_grams) from public.stock_movements where sale_id = '76000000-0000-4000-8000-000000000002'), (-2050)::numeric, 'stock ledger is exact');
select is(
  (public.sync_offline_sale('76000000-0000-4000-8000-000000000003', '76000000-0000-4000-8000-000000000001', (select payload from phase1c_payload)) ->> 'duplicate')::boolean,
  true,
  'retry returns the durable idempotency receipt'
);
select is((select count(*) from public.sales where id = '76000000-0000-4000-8000-000000000002'), 1::bigint, 'retry does not duplicate the sale');
select is((select count(*) from public.sale_items where sale_id = '76000000-0000-4000-8000-000000000002'), 2::bigint, 'retry does not duplicate children');
select throws_ok(
  $$select public.sync_offline_sale(
    '76000000-0000-4000-8000-000000000003',
    '76000000-0000-4000-8000-000000000001',
    (select payload || '{"totalCents":"1"}'::jsonb from phase1c_payload)
  )$$,
  '23505', 'Idempotency key was reused with a different payload',
  'an idempotency key cannot be reused with changed data'
);

reset role;
select is((select count(*) from public.pos_sync_receipts where event_id = '76000000-0000-4000-8000-000000000001'), 1::bigint, 'one durable receipt exists');
update public.products set name = 'Asado Offline Actualizado' where id = '75000000-0000-4000-8000-000000000002';

set local role authenticated;
select set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select ok(
  (public.pull_pos_state('76000000-0000-4000-8000-000000000003', (select cursor from phase1c_cursor)) ->> 'cursor')::bigint
    > (select cursor from phase1c_cursor),
  'incremental pull advances its monotonic cursor'
);
select is(
  jsonb_array_length(public.pull_pos_state('76000000-0000-4000-8000-000000000003', (select cursor from phase1c_cursor)) -> 'catalog'),
  1,
  'incremental pull returns only the changed product'
);

select set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
  $$select public.pull_pos_state('76000000-0000-4000-8000-000000000003', 0)$$,
  '42501', 'Device or branch is not authorized for this user',
  'a user outside the organization cannot pull device data'
);

reset role;
set local role anon;
select throws_ok(
  $$select public.sync_offline_sale('76000000-0000-4000-8000-000000000003', '76000000-0000-4000-8000-000000000001', '{}'::jsonb)$$,
  '42501', 'permission denied for function sync_offline_sale',
  'anonymous cannot invoke offline push'
);

reset role;
select * from finish();
rollback;
