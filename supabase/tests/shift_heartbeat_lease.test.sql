begin;

create extension if not exists pgtap with schema extensions;
select plan(24);

-- Regression guard for the real 2026-09-28 release smoke failure: migration
-- 202609280037_shift_heartbeat_lease.sql added a p_inferred parameter to
-- app_private.apply_employee_time_event via CREATE OR REPLACE FUNCTION, which (since it
-- changes the declared parameter TYPE LIST) did not replace the original 9-parameter function
-- from 202609130018 — it created a second, coexisting overload. Every 9-argument internal call
-- (record_employee_time_event, used for both CLOCK_IN and CLOCK_OUT) became ambiguous at
-- runtime ("function ... is not unique"). 202609280038 drops the legacy overload.
select has_function('app_private', 'apply_employee_time_event',
  array['uuid','uuid','uuid','uuid','text','time_event_action','time_event_source','timestamptz','timestamptz','boolean'],
  'apply_employee_time_event has the canonical 10-parameter signature');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'apply_employee_time_event'),
  1,
  'exactly one apply_employee_time_event overload exists (no ambiguity for 9-argument calls)'
);
select has_function('public', 'record_shift_heartbeat', array['uuid','uuid','text','timestamptz'], 'record_shift_heartbeat RPC exists');
select has_column('public', 'employee_shifts', 'last_heartbeat_at', 'employee_shifts has a heartbeat lease column');
select has_column('public', 'employee_shifts', 'auto_closed_by_heartbeat', 'employee_shifts flags heartbeat-inferred closes');

-- Fixture: one org/branch, an admin who provisions the device/PIN, one POS employee.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'shift-heartbeat-admin@example.test', '', now(),
  '{"provider":"email","providers":["email"]}', '{"display_name":"Shift Heartbeat Admin"}',
  now(), now(), '', '', '', ''
);

insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'Shift Heartbeat Org', 'shift-heartbeat-org');
insert into public.branches (id, organization_id, name, code) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Centro', 'SHB-CENTRO');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$
  select public.create_pos_employee(
    'Operador Heartbeat', '1357',
    array['e3000000-0000-4000-8000-000000000001'::uuid],
    250000, '2026-09-28 08:00', 'ACTIVE'
  )
$$, 'admin creates the POS employee');

select lives_ok($$select public.register_pos_device('e4000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'Caja heartbeat')$$, 'admin registers the device');

select set_config('test.pin_result',
  (public.verify_pos_operator_pin('e4000000-0000-4000-8000-000000000001',
    (select id from public.profiles where display_name = 'Operador Heartbeat'), '1357'))::text,
  true);
select ok((current_setting('test.pin_result')::jsonb ->> 'ok')::boolean, 'employee authenticates with PIN');

select set_config('test.employee_id', (select id::text from public.profiles where display_name = 'Operador Heartbeat'), true);
select set_config('test.event1', (extensions.gen_random_uuid())::text, true);
select set_config('test.shift1', (extensions.gen_random_uuid())::text, true);

-- This is the exact call ("Marcar entrada", online) that failed in production with
-- "function ... is not unique" before 202609280038.
select lives_ok($$
  select public.record_employee_time_event(
    'e4000000-0000-4000-8000-000000000001'::uuid,
    current_setting('test.event1')::uuid,
    current_setting('test.shift1')::uuid,
    current_setting('test.employee_id')::uuid,
    (current_setting('test.pin_result')::jsonb ->> 'operatorToken'),
    'CLOCK_IN'
  )
$$, 'CLOCK_IN (online) does not throw the overload-ambiguity error');
select is(
  (public.record_employee_time_event('e4000000-0000-4000-8000-000000000001'::uuid, current_setting('test.event1')::uuid, current_setting('test.shift1')::uuid, current_setting('test.employee_id')::uuid, (current_setting('test.pin_result')::jsonb ->> 'operatorToken'), 'CLOCK_IN') ->> 'status'),
  'OPEN', 'shift is OPEN after CLOCK_IN'
);

-- A second CLOCK_IN (new event id, same employee) must stay idempotent, not open a second shift.
select set_config('test.event2', (extensions.gen_random_uuid())::text, true);
select is(
  (public.record_employee_time_event('e4000000-0000-4000-8000-000000000001'::uuid, current_setting('test.event2')::uuid, (extensions.gen_random_uuid())::uuid, current_setting('test.employee_id')::uuid, (current_setting('test.pin_result')::jsonb ->> 'operatorToken'), 'CLOCK_IN') ->> 'shiftId'),
  current_setting('test.shift1'),
  'a second CLOCK_IN reuses the same open shift instead of creating another one'
);
select is(
  (select count(*)::int from public.employee_shifts where employee_id = current_setting('test.employee_id')::uuid),
  1, 'only one shift row exists for the employee'
);

-- Heartbeat while the shift is open.
select is(
  (public.record_shift_heartbeat('e4000000-0000-4000-8000-000000000001'::uuid, current_setting('test.employee_id')::uuid, (current_setting('test.pin_result')::jsonb ->> 'operatorToken')) ->> 'accepted')::boolean,
  true, 'heartbeat is accepted for the open shift'
);
select ok(
  (select last_heartbeat_at from public.employee_shifts where id = current_setting('test.shift1')::uuid) is not null,
  'heartbeat sets last_heartbeat_at on the open shift'
);

-- CLOCK_OUT (online) — same RPC, same ambiguity risk as CLOCK_IN before the fix.
select set_config('test.event3', (extensions.gen_random_uuid())::text, true);
select lives_ok($$
  select public.record_employee_time_event(
    'e4000000-0000-4000-8000-000000000001'::uuid,
    current_setting('test.event3')::uuid,
    current_setting('test.shift1')::uuid,
    current_setting('test.employee_id')::uuid,
    (current_setting('test.pin_result')::jsonb ->> 'operatorToken'),
    'CLOCK_OUT'
  )
$$, 'CLOCK_OUT (online) does not throw the overload-ambiguity error');
select is((select status::text from public.employee_shifts where id = current_setting('test.shift1')::uuid), 'CLOSED', 'shift is CLOSED after CLOCK_OUT');

-- Offline CLOCK_IN (sync_offline_time_event) opens a fresh shift for the restart-reconciliation scenario below.
select set_config('test.offline_shift', (extensions.gen_random_uuid())::text, true);
select set_config('test.offline_in_event', (extensions.gen_random_uuid())::text, true);
select lives_ok($$
  select public.sync_offline_time_event(
    'e4000000-0000-4000-8000-000000000001'::uuid,
    current_setting('test.offline_in_event')::uuid,
    jsonb_build_object(
      'schemaVersion','1','eventId',current_setting('test.offline_in_event'),
      'deviceId','e4000000-0000-4000-8000-000000000001',
      'occurredAt',(now() - interval '2 hours')::text,
      'employeeId',current_setting('test.employee_id'),
      'shiftId',current_setting('test.offline_shift'),
      'action','CLOCK_IN',
      'operatorToken',(current_setting('test.pin_result')::jsonb ->> 'operatorToken')
    )
  )
$$, 'offline CLOCK_IN succeeds');

-- Restart-reconciliation: a device that died offline synthesizes an inferred CLOCK_OUT using
-- its last local heartbeat, never "now". Must land as REQUIRES_REVIEW + auto_closed_by_heartbeat,
-- with clock_out_at set to exactly that heartbeat.
select set_config('test.offline_heartbeat', (now() - interval '90 minutes')::text, true);
select set_config('test.offline_out_event', (extensions.gen_random_uuid())::text, true);
select lives_ok($$
  select public.sync_offline_time_event(
    'e4000000-0000-4000-8000-000000000001'::uuid,
    current_setting('test.offline_out_event')::uuid,
    jsonb_build_object(
      'schemaVersion','1','eventId',current_setting('test.offline_out_event'),
      'deviceId','e4000000-0000-4000-8000-000000000001',
      'occurredAt',current_setting('test.offline_heartbeat'),
      'employeeId',current_setting('test.employee_id'),
      'shiftId',current_setting('test.offline_shift'),
      'action','CLOCK_OUT',
      'operatorToken',(current_setting('test.pin_result')::jsonb ->> 'operatorToken'),
      'inferred', true
    )
  )
$$, 'restart-reconciled (inferred) offline CLOCK_OUT succeeds');
select is((select status::text from public.employee_shifts where id = current_setting('test.offline_shift')::uuid), 'REQUIRES_REVIEW', 'inferred close is flagged REQUIRES_REVIEW, not silently CLOSED');
select ok((select auto_closed_by_heartbeat from public.employee_shifts where id = current_setting('test.offline_shift')::uuid), 'inferred close is marked auto_closed_by_heartbeat');
select is(
  (select clock_out_at from public.employee_shifts where id = current_setting('test.offline_shift')::uuid),
  current_setting('test.offline_heartbeat')::timestamptz,
  'clock_out_at is the last known heartbeat, never "now"/reconnection time'
);

-- A duplicate delivery of the same inferred event (outbox retry after a partial failure) must
-- stay a no-op, not raise "no hay un turno activo" now that the shift is already closed.
select lives_ok($$
  select public.sync_offline_time_event(
    'e4000000-0000-4000-8000-000000000001'::uuid,
    current_setting('test.offline_out_event')::uuid,
    jsonb_build_object(
      'schemaVersion','1','eventId',current_setting('test.offline_out_event'),
      'deviceId','e4000000-0000-4000-8000-000000000001',
      'occurredAt',current_setting('test.offline_heartbeat'),
      'employeeId',current_setting('test.employee_id'),
      'shiftId',current_setting('test.offline_shift'),
      'action','CLOCK_OUT',
      'operatorToken',(current_setting('test.pin_result')::jsonb ->> 'operatorToken'),
      'inferred', true
    )
  )
$$, 'retrying the same event id after it already synced is a harmless duplicate');

-- Admin correcting an auto-closed shift clears the heartbeat-inferred flag. The correction
-- timestamp is derived from now() (in the org's own timezone, matching what
-- correct_employee_shift does with p_clock_out_local) rather than a fixed calendar date, so
-- this stays valid ("must be after clock_in_at and not more than 5 minutes in the future")
-- however far in the future this test actually runs.
select set_config('test.correction_local',
  (now() at time zone (select timezone from public.organizations where id = 'e2000000-0000-4000-8000-000000000001'))::text,
  true);
select lives_ok($$select public.correct_employee_shift(current_setting('test.offline_shift')::uuid, current_setting('test.correction_local')::timestamp, 'Corrección de horario real informado por el empleado')$$, 'admin corrects the auto-closed shift');
select ok(not (select auto_closed_by_heartbeat from public.employee_shifts where id = current_setting('test.offline_shift')::uuid), 'a manual admin correction clears auto_closed_by_heartbeat');

reset role;
select * from finish();
rollback;
