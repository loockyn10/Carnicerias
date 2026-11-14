begin;

create extension if not exists pgtap with schema extensions;
select plan(18);

-- Fichaje por sucursal (202611140100): una sucursal con `timekeeping_enabled = false` (Central) no genera
-- turnos, eventos ni auditoría y nunca falla con P0001; otra sucursal de la MISMA organización y el MISMO
-- empleado conserva el comportamiento de siempre (entrada, salida, y P0001 si se marca salida sin turno).

select has_column('public', 'branches', 'timekeeping_enabled', 'branches has the per-branch timekeeping flag');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'timekeeping-toggle-admin@example.test', '', now(),
  '{"provider":"email","providers":["email"]}', '{"display_name":"Timekeeping Toggle Admin"}',
  now(), now(), '', '', '', ''
);

insert into public.organizations (id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'Timekeeping Toggle Org', 'timekeeping-toggle-org');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Central TK', 'TKT-CEN'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Avenida TK', 'TKT-AVE');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE');

-- Central = sucursal productiva (D-033); el fixture apaga el fichaje como lo hace la migración con los datos reales.
update public.organizations set production_branch_id = 'f3000000-0000-4000-8000-000000000001' where id = 'f2000000-0000-4000-8000-000000000001';
update public.branches set timekeeping_enabled = false where id = 'f3000000-0000-4000-8000-000000000001';

select is((select timekeeping_enabled from public.branches where code = 'TKT-AVE'), true, 'a branch keeps timekeeping by default');
select is((select timekeeping_enabled from public.branches where code = 'TKT-CEN'), false, 'Central has timekeeping disabled');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$
  select public.create_pos_employee(
    'Operador Toggle', '2468',
    array['f3000000-0000-4000-8000-000000000001'::uuid, 'f3000000-0000-4000-8000-000000000002'::uuid],
    250000, '2026-11-14 08:00', 'ACTIVE'
  )
$$, 'admin creates one employee on both branches');
select lives_ok($$select public.register_pos_device('f4000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Caja Central')$$, 'Central device registered');
select lives_ok($$select public.register_pos_device('f4000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000002', 'Caja Avenida')$$, 'Avenida device registered');

select set_config('test.employee_id', (select id::text from public.profiles where display_name = 'Operador Toggle'), true);
select set_config('test.pin_central',
  (public.verify_pos_operator_pin('f4000000-0000-4000-8000-000000000001', current_setting('test.employee_id')::uuid, '2468'))::text, true);
select set_config('test.pin_avenida',
  (public.verify_pos_operator_pin('f4000000-0000-4000-8000-000000000002', current_setting('test.employee_id')::uuid, '2468'))::text, true);
select ok((current_setting('test.pin_central')::jsonb ->> 'ok')::boolean, 'PIN still authenticates in Central (timekeeping is independent of the PIN)');
select ok((current_setting('test.pin_avenida')::jsonb ->> 'ok')::boolean, 'PIN authenticates in Avenida');

-- Capacidad que recuerda el POS.
select is((public.get_pos_device_capabilities('f4000000-0000-4000-8000-000000000001') ->> 'timekeepingEnabled')::boolean, false, 'Central device reports timekeepingEnabled=false');
select is((public.get_pos_device_capabilities('f4000000-0000-4000-8000-000000000002') ->> 'timekeepingEnabled')::boolean, true, 'Avenida device reports timekeepingEnabled=true');

-- Central: ningún evento de turno genera registros ni falla.
select is(
  (public.record_employee_time_event('f4000000-0000-4000-8000-000000000001'::uuid, (extensions.gen_random_uuid())::uuid, (extensions.gen_random_uuid())::uuid,
    current_setting('test.employee_id')::uuid, (current_setting('test.pin_central')::jsonb ->> 'operatorToken'), 'CLOCK_IN') ->> 'disabled')::boolean,
  true, 'Central CLOCK_IN is a no-op');
select lives_ok($$
  select public.record_employee_time_event('f4000000-0000-4000-8000-000000000001'::uuid, (extensions.gen_random_uuid())::uuid, (extensions.gen_random_uuid())::uuid,
    current_setting('test.employee_id')::uuid, (current_setting('test.pin_central')::jsonb ->> 'operatorToken'), 'CLOCK_OUT')
$$, 'Central CLOCK_OUT without an active shift does not raise P0001');
select set_config('test.central_out_event', (extensions.gen_random_uuid())::text, true);
select lives_ok($$
  select public.sync_offline_time_event('f4000000-0000-4000-8000-000000000001'::uuid, current_setting('test.central_out_event')::uuid,
    jsonb_build_object('schemaVersion','1','eventId',current_setting('test.central_out_event'),'deviceId','f4000000-0000-4000-8000-000000000001',
      'occurredAt',(now() - interval '1 hour')::text,'employeeId',current_setting('test.employee_id'),'shiftId',(extensions.gen_random_uuid())::text,
      'action','CLOCK_OUT','operatorToken',(current_setting('test.pin_central')::jsonb ->> 'operatorToken')))
$$, 'a stale queued CLOCK_OUT from Central syncs without error (the outbox is no longer blocked)');
select is((select count(*)::int from public.employee_shifts where branch_id = 'f3000000-0000-4000-8000-000000000001'), 0, 'Central has no shift rows');
select is((select count(*)::int from public.employee_time_events where branch_id = 'f3000000-0000-4000-8000-000000000001'), 0, 'Central has no time events');

-- Avenida: comportamiento intacto.
select set_config('test.ave_shift', (extensions.gen_random_uuid())::text, true);
select is(
  (public.record_employee_time_event('f4000000-0000-4000-8000-000000000002'::uuid, (extensions.gen_random_uuid())::uuid, current_setting('test.ave_shift')::uuid,
    current_setting('test.employee_id')::uuid, (current_setting('test.pin_avenida')::jsonb ->> 'operatorToken'), 'CLOCK_IN') ->> 'status'),
  'OPEN', 'Avenida CLOCK_IN opens a shift');
select is(
  (public.record_employee_time_event('f4000000-0000-4000-8000-000000000002'::uuid, (extensions.gen_random_uuid())::uuid, current_setting('test.ave_shift')::uuid,
    current_setting('test.employee_id')::uuid, (current_setting('test.pin_avenida')::jsonb ->> 'operatorToken'), 'CLOCK_OUT') ->> 'status'),
  'CLOSED', 'Avenida CLOCK_OUT closes it');
select throws_ok($$
  select public.record_employee_time_event('f4000000-0000-4000-8000-000000000002'::uuid, (extensions.gen_random_uuid())::uuid, current_setting('test.ave_shift')::uuid,
    current_setting('test.employee_id')::uuid, (current_setting('test.pin_avenida')::jsonb ->> 'operatorToken'), 'CLOCK_OUT')
$$, 'P0001', 'No hay un turno activo para marcar salida', 'Avenida still rejects a CLOCK_OUT without an active shift');

reset role;
select * from finish();
rollback;
