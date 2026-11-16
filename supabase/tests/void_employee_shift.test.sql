begin;

create extension if not exists pgtap with schema extensions;
select plan(79);

-- Anular un fichaje incorrecto (D-099, migración 202611160102).
-- Caso real que lo motivó: sucursal Janssen, empleado «OTRO», 175 h 50 min de un fichaje que quedó abierto por error (~$703.000 de sueldo
-- ficticio dentro del costo de personal de la sucursal). Se prueba contra employee_shifts / employee_hourly_rates REALES; las cuentas de horas
-- usan el cálculo privado con p_as_of FIJO y el camino público (RPC como administrador) con fichadas de abril de 2026 (ya cerradas o topeadas,
-- por eso no dependen de now()). Zona horaria de la organización: Buenos Aires (UTC-3).

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'void_employee_shift', array['uuid', 'text'], 'the void RPC exists');
select ok(has_function_privilege('authenticated', 'public.void_employee_shift(uuid,text)', 'EXECUTE'), 'signed-in users can call it (permission is checked inside)');
select ok(not has_function_privilege('anon', 'public.void_employee_shift(uuid,text)', 'EXECUTE'), 'anonymous cannot void shifts');
select has_column('public', 'employee_shifts', 'voided_at', 'the shift keeps WHEN it was voided');
select has_column('public', 'employee_shifts', 'void_reason', 'the shift keeps WHY it was voided');

-- ---------------------------------------------------------------------------------------------
-- Fixture. Org A: Avenida y Janssen. Org B: una sucursal.
--   Admin A, OTRO (el empleado del caso), Lucía (rol empleado), Colgado (fichada abierta), Inferido (cierre inferido por latido), Control.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'vs-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"VS Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'vs-otro@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"OTRO"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'vs-lucia@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Lucía"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'vs-colgado@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Colgado"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'vs-inferido@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Inferido"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'vs-control@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Control"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated', 'vs-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"VS Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'VS Org A', 'vs-org-a'),
  ('c2000000-0000-4000-8000-000000000002', 'VS Org B', 'vs-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Avenida', 'VS-AV'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Janssen', 'VS-JA'),
  ('c3000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'Org B Branch', 'VS-B');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000005');
insert into public.pos_devices (id, organization_id, branch_id, label, registered_by) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'Avenida POS', 'c1000000-0000-4000-8000-000000000001'),
  ('c4000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'Janssen POS', 'c1000000-0000-4000-8000-000000000001'),
  ('c4000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000009', 'Org B POS', 'c1000000-0000-4000-8000-000000000007');

-- $4.000 por hora para todos (centavos por hora).
insert into public.employee_hourly_rates (organization_id, employee_id, rate_cents_per_hour, valid_from, created_by)
select 'c2000000-0000-4000-8000-000000000001', e, 400000, '2026-01-01 03:00:00+00', 'c1000000-0000-4000-8000-000000000001'
from unnest(array['c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000004',
                  'c1000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000006']::uuid[]) as e;

-- Fichadas (todas en Janssen salvo la de Lucía en Avenida). Horas en UTC.
--   BAD    OTRO      CLOSED   01/04 11:00 -> 08/04 18:50 = 175 h 50 min (el fichaje que distorsiona la rentabilidad)
--   OTROOK OTRO      CLOSED   10/04 11:00 -> 15:00 = 4 h (legítimo, de la MISMA persona)
--   LUCIA  Lucía     CLOSED   10/04 11:00 -> 15:00 = 4 h        LUCIAAV  Lucía en Avenida el mismo día, 4 h
--   COLGADO  Colgado OPEN     20/04 11:00, sin salida ni latido        INFER  Inferido REQUIRES_REVIEW 25/04 11:00 -> 02/05 11:00 (7 días, cierre inferido)
--   CONTROL  Control OPEN     21/04 11:00 (testigo del barrido de turnos vencidos)
insert into public.employee_shifts (id, organization_id, branch_id, employee_id, device_id, clock_in_at, clock_out_at, clock_in_source, clock_out_source, clock_in_received_at, clock_out_received_at, status, last_heartbeat_at, auto_closed_by_heartbeat) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000002', '2026-04-01 11:00:00+00', '2026-04-08 18:50:00+00', 'ONLINE', 'ONLINE', '2026-04-01 11:00:00+00', '2026-04-08 18:50:00+00', 'CLOSED', null, false),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000002', '2026-04-10 11:00:00+00', '2026-04-10 15:00:00+00', 'ONLINE', 'ONLINE', '2026-04-10 11:00:00+00', '2026-04-10 15:00:00+00', 'CLOSED', null, false),
  ('c5000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-000000000002', '2026-04-10 11:00:00+00', '2026-04-10 15:00:00+00', 'ONLINE', 'ONLINE', '2026-04-10 11:00:00+00', '2026-04-10 15:00:00+00', 'CLOSED', null, false),
  ('c5000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-000000000001', '2026-04-10 11:00:00+00', '2026-04-10 15:00:00+00', 'ONLINE', 'ONLINE', '2026-04-10 11:00:00+00', '2026-04-10 15:00:00+00', 'CLOSED', null, false),
  ('c5000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000004', 'c4000000-0000-4000-8000-000000000002', '2026-04-20 11:00:00+00', null, 'ONLINE', null, '2026-04-20 11:00:00+00', null, 'OPEN', null, false),
  ('c5000000-0000-4000-8000-000000000006', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000005', 'c4000000-0000-4000-8000-000000000002', '2026-04-25 11:00:00+00', '2026-05-02 11:00:00+00', 'ONLINE', 'OFFLINE', '2026-04-25 11:00:00+00', '2026-05-02 11:00:00+00', 'REQUIRES_REVIEW', '2026-05-02 11:00:00+00', true),
  ('c5000000-0000-4000-8000-000000000007', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000006', 'c4000000-0000-4000-8000-000000000002', '2026-04-21 11:00:00+00', null, 'ONLINE', null, '2026-04-21 11:00:00+00', null, 'OPEN', null, false);

-- Registros comerciales de OTRO: una venta en Janssen el 10/04 ($200.000 con costo $100.000 -> ganancia bruta $100.000).
insert into public.categories (id, organization_id, name, slug) values
  ('c7000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Varios', 'vs-varios');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('c8000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'Pata muslo', 'vs-pata', 'VS-PATA', 'WEIGHT');
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('c9000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', 'COMPLETED', 20000000, 1000, '2026-04-10 15:00:00+00');
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot) values
  ('c9000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000001', 'Pata muslo', 1000, 20000000, 20000000, 20000000, 20000000, 10000000);

-- Ayudas de lectura (security definer: el cálculo privado no se puede llamar como authenticated). Abril completo, "ahora" fijo.
create function public.vs_cost(p_name text, p_branch uuid) returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((select r.cost_cents from app_private.branch_labor_cost_rows('c2000000-0000-4000-8000-000000000001', array[p_branch], '2026-04-01', '2026-04-30', '2026-06-01 12:00:00+00') r where r.employee_name = p_name), 0)::bigint
$$;
create function public.vs_secs(p_name text, p_branch uuid) returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((select round(r.worked_seconds) from app_private.branch_labor_cost_rows('c2000000-0000-4000-8000-000000000001', array[p_branch], '2026-04-01', '2026-04-30', '2026-06-01 12:00:00+00') r where r.employee_name = p_name), 0)::bigint
$$;
create function public.vs_total(p_branch uuid) returns table (labor_cents bigint, worked_seconds bigint, open_shifts integer, review_shifts integer) language sql stable security definer set search_path = '' as $$
  select t.labor_cents, t.worked_seconds, t.open_shifts, t.review_shifts
  from app_private.branch_labor_cost_totals('c2000000-0000-4000-8000-000000000001', array[p_branch], '2026-04-01', '2026-04-30', '2026-06-01 12:00:00+00') t
$$;
-- Evento de fichaje que llega desde la cola del POS (OFFLINE), como un administrador/dispositivo autorizado.
create function public.vs_event(p_event uuid, p_shift uuid, p_employee uuid, p_action text, p_inferred boolean default false) returns jsonb language sql volatile as $$
  select public.sync_offline_time_event('c4000000-0000-4000-8000-000000000002', p_event,
    jsonb_build_object('schemaVersion', '1', 'eventId', p_event, 'deviceId', 'c4000000-0000-4000-8000-000000000002', 'occurredAt', now() - interval '1 hour',
      'employeeId', p_employee, 'shiftId', p_shift, 'action', p_action, 'inferred', p_inferred))
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. ANTES: el fichaje de 175 h 50 min distorsiona el costo (y el tope de las fichadas NO confirmadas)
-- ---------------------------------------------------------------------------------------------
select is(public.vs_secs('OTRO', 'c3000000-0000-4000-8000-000000000002'), 633000::bigint + 14400, 'OTRO carries 175 h 50 min + 4 h at Janssen');
select is(public.vs_cost('OTRO', 'c3000000-0000-4000-8000-000000000002'), 71933333::bigint, 'and $719.333,33 of labor cost (175 h 50 min + 4 h at $4.000/h)');
select is(public.vs_secs('Colgado', 'c3000000-0000-4000-8000-000000000002'), 43200::bigint, 'an open shift without exit counts at most max_shift_hours (12 h), never indefinitely');
select is(public.vs_secs('Inferido', 'c3000000-0000-4000-8000-000000000002'), 43200::bigint, 'a REQUIRES_REVIEW shift whose exit was INFERRED 7 days later also counts at most 12 h (not 168 h)');
select is(public.vs_cost('Inferido', 'c3000000-0000-4000-8000-000000000002'), 4800000::bigint, '... = 12 h x $4.000 = $48.000');
select is((select labor_cents from public.vs_total('c3000000-0000-4000-8000-000000000002')), 71933333::bigint + 4800000 * 3 + 1600000, 'Janssen labor = OTRO + Colgado + Inferido + Control + Lucía');
select is(public.vs_cost('Lucía', 'c3000000-0000-4000-8000-000000000001'), 1600000::bigint, 'Avenida labor is only Lucía (4 h = $16.000)');

-- ---------------------------------------------------------------------------------------------
-- 2. Permisos y validaciones (nada se anula)
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-000000000001', 'Fichaje abierto por error')$$, '42501', null, 'an employee (no timekeeping.write) cannot void a shift');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000007', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000007","role":"authenticated"}', true);
select throws_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-000000000001', 'Fichaje abierto por error')$$, '22023', null, 'the admin of ANOTHER organization cannot even find the shift');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-000000000001', '  ')$$, '22023', null, 'the reason is mandatory');
select throws_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-000000000001', 'ab')$$, '22023', null, '... at least 3 characters');
select throws_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-0000000000ff', 'Fichaje abierto por error')$$, '22023', null, 'an unknown shift is rejected');
reset role;
select is((select count(*)::int from public.employee_shifts where voided_at is not null), 0, 'after all the rejected attempts nothing is voided');

-- ---------------------------------------------------------------------------------------------
-- 3. Fichada ABIERTA anulada: libera al empleado, el barrido no la toca y la cola del POS no se traba
-- ---------------------------------------------------------------------------------------------
select throws_ok($$insert into public.employee_shifts (id, organization_id, branch_id, employee_id, device_id, clock_in_at, clock_in_source, clock_in_received_at, status) values ('c5000000-0000-4000-8000-000000000011', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000004', 'c4000000-0000-4000-8000-000000000002', '2026-05-03 11:00:00+00', 'ONLINE', '2026-05-03 11:00:00+00', 'OPEN')$$, '23505', null, 'baseline: an employee cannot have two open shifts');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-000000000005', 'Quedó abierto por error')$$, 'the admin voids the open shift of Colgado');
reset role;
select is((select void_reason from public.employee_shifts where id = 'c5000000-0000-4000-8000-000000000005'), 'Quedó abierto por error', 'the reason is kept');
select is((select voided_by from public.employee_shifts where id = 'c5000000-0000-4000-8000-000000000005'), 'c1000000-0000-4000-8000-000000000001'::uuid, '... and who voided it');
select is((select status::text from public.employee_shifts where id = 'c5000000-0000-4000-8000-000000000005'), 'OPEN', 'the voided row keeps its original data (still OPEN, nothing rewritten)');
select is(public.vs_secs('Colgado', 'c3000000-0000-4000-8000-000000000002'), 0::bigint, 'a voided open shift adds no hours');
select is(public.vs_cost('Colgado', 'c3000000-0000-4000-8000-000000000002'), 0::bigint, '... and no labor cost');

select lives_ok($$select app_private.mark_overdue_shifts('c2000000-0000-4000-8000-000000000001', '2026-06-01 12:00:00+00')$$, 'the overdue sweep runs');
select is((select status::text from public.employee_shifts where id = 'c5000000-0000-4000-8000-000000000007'), 'REQUIRES_REVIEW', 'control: a normal stale open shift is flagged by the sweep');
select is((select status::text from public.employee_shifts where id = 'c5000000-0000-4000-8000-000000000005'), 'OPEN', 'the voided one is left alone by the sweep');
select is((select clock_out_at from public.employee_shifts where id = 'c5000000-0000-4000-8000-000000000005'), null, '... and never gets an exit written');

select lives_ok($$insert into public.employee_shifts (id, organization_id, branch_id, employee_id, device_id, clock_in_at, clock_in_source, clock_in_received_at, status) values ('c5000000-0000-4000-8000-000000000011', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000004', 'c4000000-0000-4000-8000-000000000002', '2026-05-03 11:00:00+00', 'ONLINE', '2026-05-03 11:00:00+00', 'OPEN')$$, 'once voided, Colgado can open a new shift (the one-open-shift rule ignores voided ones)');
delete from public.employee_shifts where id = 'c5000000-0000-4000-8000-000000000011';

-- Eventos de la cola del POS (camino público, como el dispositivo): la entrada ignora el fichaje anulado; una salida para uno anulado es un duplicado inofensivo.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.vs_event('c6000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000012', 'c1000000-0000-4000-8000-000000000004', 'CLOCK_IN') ->> 'duplicate')::boolean, false, 'a new clock-in of Colgado opens a NEW shift (it does not return the voided one as the current shift)');
reset role;
select is((select count(*)::int from public.employee_shifts where employee_id = 'c1000000-0000-4000-8000-000000000004' and clock_out_at is null and voided_at is null), 1, 'exactly one active shift for Colgado, and it is the new one');
select is((select count(*)::int from public.employee_shifts where id = 'c5000000-0000-4000-8000-000000000005' and voided_at is not null), 1, '... the voided one stays voided');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-000000000012', 'Prueba: el fichaje nuevo también se puede anular')$$, 'the new shift can be voided as well');
select is((public.vs_event('c6000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000004', 'CLOCK_OUT') ->> 'duplicate')::boolean, true, 'a clock-out that arrives for a voided shift is a harmless duplicate (the POS queue does not retry forever)');
reset role;

-- ---------------------------------------------------------------------------------------------
-- 4. EL CASO: anular el fichaje de 175 h 50 min de OTRO en Janssen
-- ---------------------------------------------------------------------------------------------
-- ANTES (camino público, como el dueño). Colgado ya está anulado (sección 3): Janssen = OTRO + Inferido + Control + Lucía.
select is((select count(*)::int from public.employee_shifts where status = 'REQUIRES_REVIEW' and voided_at is null and branch_id = 'c3000000-0000-4000-8000-000000000002'), 2, 'two Janssen shifts wait for review (Inferido and Control) before voiding');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.get_branch_operating_costs('c3000000-0000-4000-8000-000000000002', '2026-04-01', '2026-04-30') ->> 'laborCents')::bigint, 71933333::bigint + 4800000 + 4800000 + 1600000, 'BEFORE: the cost modal shows the fictitious hours inside Janssen labor');
select is((select labor_cost_cents from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'c3000000-0000-4000-8000-000000000002')), 71933333::bigint + 4800000 + 4800000 + 1600000, 'BEFORE: and so does the operating result');
select is((select operating_result_cents from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'c3000000-0000-4000-8000-000000000002')), 10000000::bigint - (71933333 + 4800000 + 4800000 + 1600000), 'BEFORE: profitability = gross profit $100.000 - labor (very negative because of the 175 h)');
select is((select duration_seconds from jsonb_to_recordset(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000002') -> 'employees') as e(employee_id uuid, duration_seconds bigint) where employee_id = 'c1000000-0000-4000-8000-000000000002'), 647400::bigint, 'BEFORE: the hours report shows OTRO with 179 h 50 min');

-- La acción: anular SÓLO el fichaje incorrecto, con motivo.
select lives_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-000000000001', 'Fichaje abierto por error: OTRO no trabajó esas horas')$$, 'the admin voids the 175 h 50 min shift of OTRO');
select throws_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-000000000001', 'Otra vez')$$, '22023', null, 'it cannot be voided twice');

-- DESPUÉS: la rentabilidad se recalcula sola (se calcula al consultar), restando exactamente el fichaje anulado.
select is((public.get_branch_operating_costs('c3000000-0000-4000-8000-000000000002', '2026-04-01', '2026-04-30') ->> 'laborCents')::bigint, 1600000::bigint + 4800000 + 4800000 + 1600000, 'AFTER: the cost modal no longer includes the voided shift (only the legitimate 4 h of OTRO remain)');
select is((select labor_cost_cents from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'c3000000-0000-4000-8000-000000000002')), 12800000::bigint, 'AFTER: Janssen labor dropped from $831.333,33 to $128.000,00');
select is((select operating_result_cents from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'c3000000-0000-4000-8000-000000000002')), 10000000::bigint - 12800000, 'AFTER: profitability = gross profit - the legitimate labor');
select is(
  (select operating_result_cents from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'c3000000-0000-4000-8000-000000000002')) - (10000000::bigint - (71933333 + 4800000 + 4800000 + 1600000)),
  70333333::bigint, 'the operating result improved by EXACTLY the voided shift ($703.333,33), nothing else moved');
select is((select gross_profit_cents from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'c3000000-0000-4000-8000-000000000002')), 10000000::bigint, 'the gross profit (sales) is untouched');
select is((select labor_cost_cents from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'c3000000-0000-4000-8000-000000000001')), 1600000::bigint, 'the other branch is not affected');
select is((select (e ->> 'workedSeconds')::bigint from jsonb_array_elements(public.get_branch_operating_costs('c3000000-0000-4000-8000-000000000002', '2026-04-01', '2026-04-30') #> '{labor,employees}') e where e ->> 'name' = 'OTRO'), 14400::bigint, 'the cost breakdown lists OTRO with only his legitimate 4 h');

-- El reporte de horas: el anulado sale en el historial, con 0 horas y 0 importe; los totales no lo suman.
select is((select duration_seconds from jsonb_to_recordset(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000002') -> 'employees') as e(employee_id uuid, duration_seconds bigint) where employee_id = 'c1000000-0000-4000-8000-000000000002'), 14400::bigint, 'AFTER: the hours report shows OTRO with 4 h');
select is((select estimated_cents from jsonb_to_recordset(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000002') -> 'employees') as e(employee_id uuid, estimated_cents bigint) where employee_id = 'c1000000-0000-4000-8000-000000000002'), 1600000::bigint, '... and the estimated pay of only that legitimate shift ($16.000)');
select is((select (s ->> 'durationSeconds')::bigint from jsonb_array_elements(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000002') -> 'shifts') s where s ->> 'id' = 'c5000000-0000-4000-8000-000000000001'), 0::bigint, 'the voided shift stays in the history with 0 hours');
select is((select (s ->> 'estimatedCents')::bigint from jsonb_array_elements(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000002') -> 'shifts') s where s ->> 'id' = 'c5000000-0000-4000-8000-000000000001'), 0::bigint, '... and 0 pay');
select is((select s ->> 'voidReason' from jsonb_array_elements(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000002') -> 'shifts') s where s ->> 'id' = 'c5000000-0000-4000-8000-000000000001'), 'Fichaje abierto por error: OTRO no trabajó esas horas', '... flagged with its reason');
select ok((select (s ->> 'voidedAt') is not null from jsonb_array_elements(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000002') -> 'shifts') s where s ->> 'id' = 'c5000000-0000-4000-8000-000000000001'), '... and its voidedAt');
select is((select (s ->> 'durationSeconds')::bigint from jsonb_array_elements(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000002') -> 'shifts') s where s ->> 'id' = 'c5000000-0000-4000-8000-000000000002'), 14400::bigint, 'the legitimate shift of the same person is intact (4 h)');
select is((select (s ->> 'durationSeconds')::bigint from jsonb_array_elements(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000002') -> 'shifts') s where s ->> 'id' = 'c5000000-0000-4000-8000-000000000003'), 14400::bigint, 'and so is every other employee''s');
reset role;

-- Lo que NO se toca: el fichaje, el empleado y sus registros comerciales.
select ok((select clock_in_at = '2026-04-01 11:00:00+00'::timestamptz and clock_out_at = '2026-04-08 18:50:00+00'::timestamptz and status = 'CLOSED' from public.employee_shifts where id = 'c5000000-0000-4000-8000-000000000001'), 'the voided shift keeps its entry, exit and status exactly as registered');
select is((select count(*)::int from public.employee_shifts), 8, 'no shift was deleted (7 from the fixture + the new one Colgado opened and voided)');
select is((select count(*)::int from public.employee_shifts where voided_at is not null), 3, 'only the three shifts voided in this test are voided (Colgado open, Colgado new, OTRO)');
select is((select count(*)::int from public.profiles where id = 'c1000000-0000-4000-8000-000000000002'), 1, 'the employee OTRO still exists');
select is((select count(*)::int from public.organization_members where profile_id = 'c1000000-0000-4000-8000-000000000002' and status = 'ACTIVE'), 1, '... and is still an active member');
select is((select count(*)::int from public.employee_hourly_rates where employee_id = 'c1000000-0000-4000-8000-000000000002'), 1, '... with his hourly rate');
select is((select count(*)::int from public.sales where profile_id = 'c1000000-0000-4000-8000-000000000002' and status = 'COMPLETED'), 1, 'his commercial records (sales) are untouched');
select is((select count(*)::int from public.audit_logs where event_type = 'EMPLOYEE_SHIFT_VOIDED' and entity_id = 'c5000000-0000-4000-8000-000000000001'), 1, 'the voiding is audited');
select is((select (after_data ->> 'voided_at') is not null and (before_data ->> 'voided_at') is null from public.audit_logs where event_type = 'EMPLOYEE_SHIFT_VOIDED' and entity_id = 'c5000000-0000-4000-8000-000000000001'), true, '... with the before and after of the row');
select throws_ok($$update public.employee_shifts set voided_at = now() where id = 'c5000000-0000-4000-8000-000000000004'$$, '23514', null, 'a shift cannot be half-voided (voided_at without who/why is rejected by the table)');

-- ---------------------------------------------------------------------------------------------
-- 5. Turno PENDIENTE DE REVISIÓN anulado: sale de la lista de revisión, del contador y del aviso del POS
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select (o ->> 'hasShiftIssue')::boolean from jsonb_array_elements(public.get_pos_operator_roster('c4000000-0000-4000-8000-000000000002') -> 'operators') o where o ->> 'displayName' = 'Inferido'), true, 'BEFORE: the POS roster warns that Inferido has a shift to review');
select is(jsonb_array_length(public.get_timekeeping_report('2026-04-01', '2026-05-31', null, 'c3000000-0000-4000-8000-000000000002') -> 'review'), 2, 'BEFORE: the review list has Inferido and Control');
select lives_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-000000000006', 'Cierre inferido de una caja que siguió encendida')$$, 'the admin voids the inferred shift of Inferido');
select is((select (o ->> 'hasShiftIssue')::boolean from jsonb_array_elements(public.get_pos_operator_roster('c4000000-0000-4000-8000-000000000002') -> 'operators') o where o ->> 'displayName' = 'Inferido'), false, 'AFTER: the POS roster no longer warns about it');
select is(jsonb_array_length(public.get_timekeeping_report('2026-04-01', '2026-05-31', null, 'c3000000-0000-4000-8000-000000000002') -> 'review'), 1, 'AFTER: only Control is left in the review list');
reset role;
select is((select review_shifts from public.vs_total('c3000000-0000-4000-8000-000000000002')), 1, 'the labor card counts one pending review (Control) instead of two');
select is((select labor_cents from public.vs_total('c3000000-0000-4000-8000-000000000002')), 1600000::bigint + 4800000 + 1600000, 'Janssen labor = OTRO legit 4 h + Control (capped 12 h) + Lucía');

-- Una persona cuyo ÚNICO fichaje cerrado se anula (Lucía en Avenida) desaparece de los totales del reporte y del costo de esa sucursal.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(jsonb_array_length(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000001') -> 'employees'), 1, 'BEFORE: Avenida hours report lists Lucía');
select lives_ok($$select public.void_employee_shift('c5000000-0000-4000-8000-000000000004', 'Cargado por error en esta sucursal')$$, 'the admin voids the only closed shift of Lucía at Avenida');
select is(jsonb_array_length(public.get_timekeeping_report('2026-04-01', '2026-04-30', null, 'c3000000-0000-4000-8000-000000000001') -> 'employees'), 0, 'AFTER: nobody is listed in the Avenida hours report (a voided shift is not a worked shift)');
select is((select labor_cost_cents from public.get_branch_operating_result('2026-04-01', '2026-04-30', 'c3000000-0000-4000-8000-000000000001')), 0::bigint, 'AFTER: Avenida labor cost is 0');
reset role;

-- Un fichaje que NO se anula y queda REQUIRES_REVIEW sigue contando (con el tope) hasta que alguien lo corrija: la corrección existente lo confirma.
select is(public.vs_cost('Control', 'c3000000-0000-4000-8000-000000000002'), 4800000::bigint, 'an unconfirmed shift still counts (capped at 12 h) until it is corrected or voided');

select * from finish();
rollback;
