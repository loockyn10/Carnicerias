begin;

create extension if not exists pgtap with schema extensions;
select plan(30);

select has_table('public', 'settlements', 'settlements table exists');
select has_function('public', 'get_settlement_overview', array[]::text[], 'overview RPC exists');
select has_function('public', 'get_settlement_preview', array['uuid','timestamp without time zone','timestamp without time zone'], 'preview RPC exists');
select has_function('public', 'confirm_settlement', array['uuid','timestamp without time zone','timestamp without time zone','bigint','text'], 'confirmation RPC exists');
select has_function('public', 'get_settlement_history', array['uuid','date','date','boolean','uuid'], 'history RPC exists');
select has_function('public', 'void_settlement', array['uuid','text'], 'void RPC exists');
select ok((select relrowsecurity from pg_class where oid = 'public.settlements'::regclass), 'settlements has RLS');
select ok(not has_table_privilege('authenticated', 'public.settlements', 'INSERT'), 'browser clients cannot insert settlements directly');
select ok(not has_function_privilege('anon', 'public.confirm_settlement(uuid,timestamp without time zone,timestamp without time zone,bigint,text)', 'EXECUTE'), 'anonymous cannot confirm settlements');
select ok((select bool_and(prosecdef) from pg_proc where oid in (
  'public.get_settlement_overview()'::regprocedure,
  'public.get_settlement_preview(uuid,timestamp without time zone,timestamp without time zone)'::regprocedure,
  'public.confirm_settlement(uuid,timestamp without time zone,timestamp without time zone,bigint,text)'::regprocedure,
  'public.get_settlement_history(uuid,date,date,boolean,uuid)'::regprocedure,
  'public.void_settlement(uuid,text)'::regprocedure
)), 'settlement RPCs are security definer');
select ok(exists (select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000001' and permission_key = 'settlements.read'), 'admin receives settlement read permission');
select ok(exists (select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000001' and permission_key = 'settlements.write'), 'admin receives settlement write permission');
select ok(not exists (select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000002' and permission_key like 'settlements.%'), 'employee receives no settlement permission');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'settlement-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Settlement Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'settlement-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Settlement Employee"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('92000000-0000-4000-8000-000000000001', 'Settlement Org', 'settlement-org');
insert into public.branches (id, organization_id, name, code) values
  ('93000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'Settlement Centro', 'SET-CENTRO');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.pos_devices (id, organization_id, branch_id, label, registered_by, last_seen_at) values
  ('94000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'Caja test', '91000000-0000-4000-8000-000000000001', now() - interval '8 hours');

insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('95000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'COMPLETED', 84000000, 1000, now() - interval '5 days'),
  ('95000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'COMPLETED', 42000000, 1000, now() - interval '4 days'),
  ('95000000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'COMPLETED', 19000000, 1000, now() - interval '3 days'),
  ('95000000-0000-4000-8000-000000000004', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'COMPLETED', 8000000, 1000, now() - interval '2 days'),
  ('95000000-0000-4000-8000-000000000005', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'COMPLETED', 2000000, 1000, now() - interval '1 day'),
  ('95000000-0000-4000-8000-000000000006', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'DRAFT', 99000000, 9999, null);
insert into public.payments (sale_id, organization_id, branch_id, method, amount_cents) values
  ('95000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'CASH', 84000000),
  ('95000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'TRANSFER', 42000000),
  ('95000000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'DEBIT', 19000000),
  ('95000000-0000-4000-8000-000000000004', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'CREDIT', 8000000),
  ('95000000-0000-4000-8000-000000000005', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'OTHER', 2000000),
  ('95000000-0000-4000-8000-000000000006', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'CASH', 99000000);

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is((public.get_settlement_preview(
  '93000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Argentina/Buenos_Aires') - interval '7 days',
  date_trunc('minute', now() at time zone 'America/Argentina/Buenos_Aires')
) -> 'paymentTotals' ->> 'CASH')::bigint, 84000000::bigint, 'only completed cash sales become expected physical cash');
select is((public.get_settlement_preview(
  '93000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Argentina/Buenos_Aires') - interval '7 days',
  date_trunc('minute', now() at time zone 'America/Argentina/Buenos_Aires')
) ->> 'totalSalesCents')::bigint, 155000000::bigint, 'preview totals all completed payment methods');
select is((public.get_settlement_preview(
  '93000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Argentina/Buenos_Aires') - interval '7 days',
  date_trunc('minute', now() at time zone 'America/Argentina/Buenos_Aires')
) ->> 'ticketCount')::integer, 5, 'draft sales are excluded from ticket count');
select is((public.get_settlement_preview(
  '93000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Argentina/Buenos_Aires') - interval '7 days',
  date_trunc('minute', now() at time zone 'America/Argentina/Buenos_Aires')
) -> 'devices' -> 0 ->> 'label'), 'Caja test', 'preview includes the honest last-seen device snapshot');
select lives_ok($$select public.confirm_settlement(
  '93000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Argentina/Buenos_Aires') - interval '7 days',
  date_trunc('minute', now() at time zone 'America/Argentina/Buenos_Aires'),
  83200000,
  'Cierre semanal test'
)$$, 'admin confirms a settlement');
select is((select expected_cash_cents from public.settlements where organization_id = '92000000-0000-4000-8000-000000000001'), 84000000::bigint, 'confirmed snapshot stores expected cash');
select is((select received_cash_cents from public.settlements where organization_id = '92000000-0000-4000-8000-000000000001'), 83200000::bigint, 'confirmed snapshot stores received cash');
select is((select difference_cents from public.settlements where organization_id = '92000000-0000-4000-8000-000000000001'), (-800000)::bigint, 'difference is received minus expected');
select is((select ticket_count from public.settlements where organization_id = '92000000-0000-4000-8000-000000000001'), 5, 'snapshot stores ticket count');
select is((select jsonb_array_length(employee_totals) from public.settlements where organization_id = '92000000-0000-4000-8000-000000000001'), 1, 'snapshot stores employee totals');
select is((select jsonb_array_length(device_sync_snapshot) from public.settlements where organization_id = '92000000-0000-4000-8000-000000000001'), 1, 'snapshot stores device state');
select is(jsonb_array_length(public.get_settlement_history(
  null, null, null, null,
  (select id from public.settlements where organization_id = '92000000-0000-4000-8000-000000000001')
)), 1, 'history can fetch one exact settlement detail');
select is((select status::text from public.settlements where organization_id = '92000000-0000-4000-8000-000000000001'), 'CONFIRMED', 'confirmed settlement remains active');

reset role;
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at, device_id, sync_event_id) values
  ('95000000-0000-4000-8000-000000000007', '92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'COMPLETED', 1000000, 1000, now() - interval '1 day', '94000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000001');
insert into public.pos_sync_receipts (event_id, sale_id, device_id, payload_hash, received_at) values
  ('96000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000007', '94000000-0000-4000-8000-000000000001', 'late-test', now() + interval '1 second');

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select is((select total_sales_cents from public.settlements where organization_id = '92000000-0000-4000-8000-000000000001'), 155000000::bigint, 'late sale does not mutate the historical snapshot');
select is((public.get_settlement_history(null, null, null, null, (select id from public.settlements where organization_id = '92000000-0000-4000-8000-000000000001')) -> 0 ->> 'hasLaterMovements')::boolean, true, 'history flags a sale received after confirmation');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select throws_ok($$select public.get_settlement_preview('93000000-0000-4000-8000-000000000001', now()::timestamp - interval '1 day', now()::timestamp)$$, '42501', 'Permission settlements.read is required', 'employee cannot preview settlements');
select is((select count(*) from public.settlements), 0::bigint, 'employee cannot read settlement history through the table');

reset role;
select * from finish();
rollback;
