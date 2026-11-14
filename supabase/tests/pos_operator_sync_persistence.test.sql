begin;

create extension if not exists pgtap with schema extensions;
select plan(17);

-- D-097 (202611140101): una venta o un evento de turno hecho offline sincroniza horas o días después aunque el token del
-- operador haya vencido, esté revocado, lo haya emitido otro usuario técnico o el reloj de la caja estuviera desfasado.
-- El límite de acceso sigue siendo dispositivo + organización: otra organización, otro operador o un payload que no coincide
-- se rechazan igual. Las acciones EN VIVO siguen exigiendo token válido y no revocado.

-- Fixture: org A (sucursal X, admin A, cuenta técnica T), org B (admin B, empleado propio).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'persist-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Persist Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'persist-device@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Persist Device Account"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'persist-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Persist Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('92000000-0000-4000-8000-000000000001', 'Persist Org A', 'persist-org-a'),
  ('92000000-0000-4000-8000-000000000002', 'Persist Org B', 'persist-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('93000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'Sucursal X', 'PER-X'),
  ('93000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000002', 'Sucursal B', 'PER-B');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002');

insert into public.categories (id, organization_id, name, slug) values
  ('95000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'Vacunos', 'vacunos-persist');
insert into public.products (id, organization_id, category_id, name, slug, unit_type) values
  ('96000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000001', 'Vacío Persist', 'vacio-persist', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
values ('92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000001');
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('92000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000001', 1000000, '2026-01-01T00:00:00Z');

-- Admin A crea el empleado, registra la caja y valida el PIN (emite el token).
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.create_pos_employee('Operador Persist', '1357', array['93000000-0000-4000-8000-000000000001'::uuid], 250000, '2026-11-14 08:00', 'ACTIVE');
select public.register_pos_device('94000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 'Caja Persist');
select set_config('test.operator_id', (select id::text from public.profiles where display_name = 'Operador Persist'), true);
select set_config('test.pin_result',
  (public.verify_pos_operator_pin('94000000-0000-4000-8000-000000000001', current_setting('test.operator_id')::uuid, '1357'))::text, true);
select set_config('test.token', current_setting('test.pin_result')::jsonb ->> 'operatorToken', true);
select ok((current_setting('test.pin_result')::jsonb ->> 'ok')::boolean, 'the PIN identifies the operator online');
select ok(((current_setting('test.pin_result')::jsonb ->> 'validUntil')::timestamptz) > now() + interval '300 days', 'the operator token is issued for 365 days, not 7');

-- Admin B tiene su propio empleado en OTRA organización.
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select public.create_pos_employee('Operador Ajeno', '2468', array['93000000-0000-4000-8000-000000000009'::uuid], 250000, '2026-11-14 08:00', 'ACTIVE');
select set_config('test.foreign_operator_id', (select id::text from public.profiles where display_name = 'Operador Ajeno'), true);

-- El token envejece: emitido hace 40 días, vencido hace 30 (la regla vieja lo rechazaba para siempre).
reset role;
update public.pos_operator_grants set issued_at = now() - interval '40 days', valid_until = now() - interval '30 days'
where operator_profile_id = current_setting('test.operator_id')::uuid;

-- Payloads de ventas hechas offline hace 5 y 4 días.
create function pg_temp.persist_sale(sale text, event text, ago interval, profile text, token text)
returns jsonb language sql as $$
  select jsonb_build_object(
    'schemaVersion', 1, 'eventId', event, 'saleId', sale,
    'organizationId', '92000000-0000-4000-8000-000000000001', 'branchId', '93000000-0000-4000-8000-000000000001',
    'profileId', profile, 'operatorToken', token, 'deviceId', '94000000-0000-4000-8000-000000000001', 'status', 'COMPLETED',
    'totalCents', '1000000', 'totalWeightGrams', '1000',
    'createdAt', now() - ago, 'completedAt', now() - ago,
    'items', jsonb_build_array(jsonb_build_object('id', (extensions.gen_random_uuid())::text, 'productId', '96000000-0000-4000-8000-000000000001', 'productNameSnapshot', 'Vacío Persist', 'weightGrams', 1000, 'pricePerKgCents', '1000000', 'subtotalCents', '1000000')),
    'payment', jsonb_build_object('id', (extensions.gen_random_uuid())::text, 'method', 'TRANSFER', 'amountCents', '1000000'),
    'stockMovements', jsonb_build_array(jsonb_build_object('id', (extensions.gen_random_uuid())::text, 'productId', '96000000-0000-4000-8000-000000000001', 'quantityGrams', '-1000', 'occurredAt', now() - ago))
  );
$$;
create temporary table persist_payloads(name text primary key, payload jsonb) on commit drop;
insert into persist_payloads values
  ('s1', pg_temp.persist_sale('97000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', interval '5 days', current_setting('test.operator_id'), current_setting('test.token'))),
  ('s2', pg_temp.persist_sale('97000000-0000-4000-8000-000000000002', '98000000-0000-4000-8000-000000000002', interval '4 days', current_setting('test.operator_id'), current_setting('test.token'))),
  ('s3', pg_temp.persist_sale('97000000-0000-4000-8000-000000000003', '98000000-0000-4000-8000-000000000003', interval '3 days', current_setting('test.foreign_operator_id'), 'x')),
  ('s4', pg_temp.persist_sale('97000000-0000-4000-8000-000000000004', '98000000-0000-4000-8000-000000000004', interval '3 days', current_setting('test.operator_id'), current_setting('test.token')));
grant select on persist_payloads to authenticated;

-- La cuenta técnica T (otro usuario que el que emitió el token) sincroniza la cola de la caja.
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

-- Acción EN VIVO con el token envejecido: sigue valiendo (persistente, sin ventana de fechas ni issued_by)...
select is(public.get_current_employee_shift('94000000-0000-4000-8000-000000000001', current_setting('test.operator_id')::uuid, current_setting('test.token')), null::jsonb,
  'a live action accepts a persistent token even though its old 7-day window is long over and another account issued it');
-- ...pero un token inventado sigue rechazado.
select throws_ok($$select public.get_current_employee_shift('94000000-0000-4000-8000-000000000001', current_setting('test.operator_id')::uuid, repeat('z', 64))$$,
  '42501', null, 'a live action still rejects a token that was never issued');

-- Venta offline de hace 5 días con el token vencido: sincroniza y queda atribuida al empleado.
select lives_ok($$select public.sync_pos_operator_offline_sale('94000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', (select payload from persist_payloads where name = 's1'), current_setting('test.operator_id')::uuid, current_setting('test.token'))$$,
  'a 5-day-old offline sale syncs although its operator token expired 30 days ago');
select is((select profile_id::text from public.sales where id = '97000000-0000-4000-8000-000000000001'), current_setting('test.operator_id'), 'the sale is attributed to the employee who made it');
select lives_ok($$select public.sync_pos_operator_offline_sale('94000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', (select payload from persist_payloads where name = 's1'), current_setting('test.operator_id')::uuid, current_setting('test.token'))$$,
  'retrying the same sale is idempotent');
select is((select count(*)::int from public.sales where id = '97000000-0000-4000-8000-000000000001'), 1, 'the sale is never duplicated');

-- Admin revoca los tokens (cambio de PIN / baja): la venta ya cobrada igual sincroniza; la acción en vivo ya no.
reset role;
update public.pos_operator_grants set revoked_at = now() where operator_profile_id = current_setting('test.operator_id')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.sync_pos_operator_offline_sale('94000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000002', (select payload from persist_payloads where name = 's2'), current_setting('test.operator_id')::uuid, current_setting('test.token'))$$,
  'a legitimate sale made before the token was revoked still syncs');
select is((select count(*)::int from public.sales where id = '97000000-0000-4000-8000-000000000002'), 1, 'and it exists exactly once');
select throws_ok($$select public.get_current_employee_shift('94000000-0000-4000-8000-000000000001', current_setting('test.operator_id')::uuid, current_setting('test.token'))$$,
  '42501', null, 'a revoked token is still refused for live actions');

-- Eventos de turno OFFLINE de hace 3 días con un token cualquiera: entrada y salida se aplican.
select set_config('test.shift_id', (extensions.gen_random_uuid())::text, true);
select set_config('test.event_in', (extensions.gen_random_uuid())::text, true);
select set_config('test.event_out', (extensions.gen_random_uuid())::text, true);
select lives_ok($$
  select public.sync_offline_time_event('94000000-0000-4000-8000-000000000001', current_setting('test.event_in')::uuid,
    jsonb_build_object('schemaVersion','1','eventId',current_setting('test.event_in'),'deviceId','94000000-0000-4000-8000-000000000001',
      'occurredAt',(now() - interval '3 days')::text,'employeeId',current_setting('test.operator_id'),'shiftId',current_setting('test.shift_id'),
      'action','CLOCK_IN','operatorToken',repeat('z', 64)))
$$, 'an offline CLOCK_IN from 3 days ago syncs without a valid token');
select lives_ok($$
  select public.sync_offline_time_event('94000000-0000-4000-8000-000000000001', current_setting('test.event_out')::uuid,
    jsonb_build_object('schemaVersion','1','eventId',current_setting('test.event_out'),'deviceId','94000000-0000-4000-8000-000000000001',
      'occurredAt',(now() - interval '3 days' + interval '1 hour')::text,'employeeId',current_setting('test.operator_id'),'shiftId',current_setting('test.shift_id'),
      'action','CLOCK_OUT','operatorToken',repeat('z', 64)))
$$, 'and the matching CLOCK_OUT syncs too');
select is((select status::text from public.employee_shifts where id = current_setting('test.shift_id')::uuid), 'CLOSED', 'the shift is CLOSED with its real hours');

-- Los límites básicos se mantienen.
select throws_ok($$select public.sync_pos_operator_offline_sale('94000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000003', (select payload from persist_payloads where name = 's3'), current_setting('test.foreign_operator_id')::uuid, 'x')$$,
  '42501', null, 'an employee of another organization cannot be attributed a sale of this device');
select throws_ok($$select public.sync_pos_operator_offline_sale('94000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000004', (select payload from persist_payloads where name = 's4'), current_setting('test.foreign_operator_id')::uuid, current_setting('test.token'))$$,
  '42501', null, 'a call that names a different operator than the sale payload is refused');
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.sync_pos_operator_offline_sale('94000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000004', (select payload from persist_payloads where name = 's4'), current_setting('test.operator_id')::uuid, current_setting('test.token'))$$,
  '42501', null, 'an account of another organization cannot sync into this device');

reset role;
select * from finish();
rollback;
