begin;

create extension if not exists pgtap with schema extensions;
select plan(95);

-- Costo de personal automático por horas trabajadas dentro del Resultado operativo (D-085, migración 202610200083).
-- Todo se prueba contra employee_shifts / employee_hourly_rates REALES (no hay tablas nuevas). Las cuentas de horas usan el cálculo privado con
-- p_as_of FIJO (la hora "actual" de la consulta) para que "fichada abierta a las 12:00 / 16:00" sea determinista; el camino público
-- (permisos, aislamiento, resultado operativo) se prueba con las RPC como usuario autenticado. Zona horaria de la organización: Buenos Aires (UTC-3).

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_function('app_private', 'branch_labor_cost_rows', array['uuid','uuid[]','date','date','timestamp with time zone'], 'the labor cost calculation exists');
select has_function('app_private', 'branch_labor_cost_totals', array['uuid','uuid[]','date','date','timestamp with time zone'], 'the labor cost totals exist');
select ok(not has_function_privilege('authenticated', 'app_private.branch_labor_cost_rows(uuid,uuid[],date,date,timestamptz)', 'EXECUTE'), 'browser clients cannot call the private labor calculation');
select ok(not has_function_privilege('authenticated', 'app_private.branch_labor_cost_totals(uuid,uuid[],date,date,timestamptz)', 'EXECUTE'), 'browser clients cannot call the private labor totals');
select ok(not has_function_privilege('anon', 'public.get_branch_operating_result(date,date,uuid)', 'EXECUTE'), 'anonymous cannot read the operating result');
select ok(has_function_privilege('authenticated', 'public.get_branch_operating_costs(uuid,date,date)', 'EXECUTE'), 'the modal RPC keeps its grant');
select is((select count(*)::int from pg_proc where oid = any(array['public.get_branch_operating_result(date,date,uuid)'::regprocedure, 'public.get_branch_operating_costs(uuid,date,date)'::regprocedure]) and prosecdef), 2, 'both RPCs are still security definer');

-- ---------------------------------------------------------------------------------------------
-- Fixture. Org A: Avenida y Janssen. Org B: una sucursal.
--   Lucía (rol empleado), Mica, SinTarifa (sin valor hora), Capped, Live, Analista (analytics.read sin timekeeping.read), Admin A / Admin B, EmpB.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'lc-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"LC Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'lc-lucia@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Lucía"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'lc-mica@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Mica"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'lc-sintarifa@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"SinTarifa"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'lc-capped@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Capped"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'lc-live@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Live"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated', 'lc-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"LC Admin B"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000008', 'authenticated', 'authenticated', 'lc-empb@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"EmpB"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'lc-analyst@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"LC Analista"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'LC Org A', 'lc-org-a'),
  ('f2000000-0000-4000-8000-000000000002', 'LC Org B', 'lc-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Avenida', 'LC-AV'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Janssen', 'LC-JA'),
  ('f3000000-0000-4000-8000-000000000009', 'f2000000-0000-4000-8000-000000000002', 'Org B Branch', 'LC-B');
insert into public.roles (id, organization_id, key, name, is_system) values
  ('f6000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'lc_analyst', 'Analista LC', false);
insert into public.role_permissions (role_id, permission_key) values
  ('f6000000-0000-4000-8000-000000000001', 'analytics.read'),
  ('f6000000-0000-4000-8000-000000000001', 'branches.read_all');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000009', 'f6000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.pos_devices (id, organization_id, branch_id, label, registered_by) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Avenida POS', 'f1000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'Janssen POS', 'f1000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000009', 'f2000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000009', 'Org B POS', 'f1000000-0000-4000-8000-000000000007');

-- Valor hora (centavos por hora). Lucía: $3.500/h hasta el 01/03/2026 00:00 (hora local) y $4.000/h desde ahí. El resto: $4.000/h. SinTarifa: ninguno.
insert into public.employee_hourly_rates (organization_id, employee_id, rate_cents_per_hour, valid_from, valid_to, created_by) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 350000, '2026-01-01 03:00:00+00', '2026-03-01 03:00:00+00', 'f1000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 400000, '2026-03-01 03:00:00+00', null, 'f1000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 400000, '2026-01-01 03:00:00+00', null, 'f1000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000005', 400000, '2026-01-01 03:00:00+00', null, 'f1000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000006', 400000, '2026-01-01 03:00:00+00', null, 'f1000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000008', 400000, '2026-01-01 03:00:00+00', null, 'f1000000-0000-4000-8000-000000000007');

-- Fichadas. Horas en UTC (hora local = UTC-3).
--   S1  Lucía  Avenida 10/04 08:00-18:00 (10 h)         S2  Mica   Avenida 10/04 09:00-15:30 (6 h 30)
--   S3  Lucía  Janssen 11/04 08:00-12:00 (4 h)           S4  Mica   Janssen 12/04 20:00 -> 13/04 02:00 (cruza medianoche, 6 h)
--   S5  Lucía  Avenida 10/02 08:00-16:00 (8 h, a $3.500) S6  Lucía  Avenida 28/02 20:00 -> 01/03 04:00 (cruza el cambio de valor hora)
--   S7  SinTarifa Avenida 14/04 10:00-12:00 (sin valor hora)
--   S8  Lucía  Avenida 20/04 08:00 ABIERTA               S9  Mica   Janssen 25/04 08:00 ABIERTA, último latido 10:00
--   S10 Capped Avenida 01/05 00:00 ABIERTA (sin latido)   S11 Live   Avenida ABIERTA desde hace 6 h 30 (respecto de now())
--   S12 EmpB   Org B 10/04 08:00-18:00                   S13 Mica   Avenida 28/04 08:00-11:00 REQUIRES_REVIEW (salida inferida por latido)
insert into public.employee_shifts (id, organization_id, branch_id, employee_id, device_id, clock_in_at, clock_out_at, clock_in_source, clock_out_source, clock_in_received_at, clock_out_received_at, status, last_heartbeat_at, auto_closed_by_heartbeat) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 'f4000000-0000-4000-8000-000000000001', '2026-04-10 11:00:00+00', '2026-04-10 21:00:00+00', 'ONLINE', 'ONLINE', '2026-04-10 11:00:00+00', '2026-04-10 21:00:00+00', 'CLOSED', null, false),
  ('f5000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'f4000000-0000-4000-8000-000000000001', '2026-04-10 12:00:00+00', '2026-04-10 18:30:00+00', 'ONLINE', 'ONLINE', '2026-04-10 12:00:00+00', '2026-04-10 18:30:00+00', 'CLOSED', null, false),
  ('f5000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002', 'f4000000-0000-4000-8000-000000000002', '2026-04-11 11:00:00+00', '2026-04-11 15:00:00+00', 'ONLINE', 'ONLINE', '2026-04-11 11:00:00+00', '2026-04-11 15:00:00+00', 'CLOSED', null, false),
  ('f5000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000003', 'f4000000-0000-4000-8000-000000000002', '2026-04-12 23:00:00+00', '2026-04-13 05:00:00+00', 'ONLINE', 'ONLINE', '2026-04-12 23:00:00+00', '2026-04-13 05:00:00+00', 'CLOSED', null, false),
  ('f5000000-0000-4000-8000-000000000005', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 'f4000000-0000-4000-8000-000000000001', '2026-02-10 11:00:00+00', '2026-02-10 19:00:00+00', 'ONLINE', 'ONLINE', '2026-02-10 11:00:00+00', '2026-02-10 19:00:00+00', 'CLOSED', null, false),
  ('f5000000-0000-4000-8000-000000000006', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 'f4000000-0000-4000-8000-000000000001', '2026-02-28 23:00:00+00', '2026-03-01 07:00:00+00', 'ONLINE', 'ONLINE', '2026-02-28 23:00:00+00', '2026-03-01 07:00:00+00', 'CLOSED', null, false),
  ('f5000000-0000-4000-8000-000000000007', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000004', 'f4000000-0000-4000-8000-000000000001', '2026-04-14 13:00:00+00', '2026-04-14 15:00:00+00', 'ONLINE', 'ONLINE', '2026-04-14 13:00:00+00', '2026-04-14 15:00:00+00', 'CLOSED', null, false),
  ('f5000000-0000-4000-8000-000000000008', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 'f4000000-0000-4000-8000-000000000001', '2026-04-20 11:00:00+00', null, 'ONLINE', null, '2026-04-20 11:00:00+00', null, 'OPEN', null, false),
  ('f5000000-0000-4000-8000-000000000009', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000003', 'f4000000-0000-4000-8000-000000000002', '2026-04-25 11:00:00+00', null, 'ONLINE', null, '2026-04-25 11:00:00+00', null, 'OPEN', '2026-04-25 13:00:00+00', false),
  ('f5000000-0000-4000-8000-000000000010', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000005', 'f4000000-0000-4000-8000-000000000001', '2026-05-01 03:00:00+00', null, 'ONLINE', null, '2026-05-01 03:00:00+00', null, 'OPEN', null, false),
  ('f5000000-0000-4000-8000-000000000011', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000006', 'f4000000-0000-4000-8000-000000000001', now() - interval '6 hours 30 minutes', null, 'ONLINE', null, now() - interval '6 hours 30 minutes', null, 'OPEN', null, false),
  ('f5000000-0000-4000-8000-000000000012', 'f2000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000009', 'f1000000-0000-4000-8000-000000000008', 'f4000000-0000-4000-8000-000000000009', '2026-04-10 11:00:00+00', '2026-04-10 21:00:00+00', 'ONLINE', 'ONLINE', '2026-04-10 11:00:00+00', '2026-04-10 21:00:00+00', 'CLOSED', null, false),
  ('f5000000-0000-4000-8000-000000000013', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'f4000000-0000-4000-8000-000000000001', '2026-04-28 11:00:00+00', '2026-04-28 14:00:00+00', 'ONLINE', 'OFFLINE', '2026-04-28 11:00:00+00', '2026-04-28 14:00:00+00', 'REQUIRES_REVIEW', '2026-04-28 14:00:00+00', true);

-- Una persona que también trabaja en OTRA organización (con SU propio valor hora, en otras fechas): el valor hora de la otra organización
-- nunca se usa para valuar las horas de ésta. S14: Lucía, Avenida, 15/12/2025 08:00-10:00 (2 h), fecha en que sólo existe el valor hora de org B ($9.000/h).
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.employee_hourly_rates (organization_id, employee_id, rate_cents_per_hour, valid_from, valid_to, created_by) values
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002', 900000, '2025-01-01 03:00:00+00', '2026-01-01 03:00:00+00', 'f1000000-0000-4000-8000-000000000007');
insert into public.employee_shifts (id, organization_id, branch_id, employee_id, device_id, clock_in_at, clock_out_at, clock_in_source, clock_out_source, clock_in_received_at, clock_out_received_at, status) values
  ('f5000000-0000-4000-8000-000000000014', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 'f4000000-0000-4000-8000-000000000001', '2025-12-15 11:00:00+00', '2025-12-15 13:00:00+00', 'ONLINE', 'ONLINE', '2025-12-15 11:00:00+00', '2025-12-15 13:00:00+00', 'CLOSED');

-- Ayudas de lectura: costo en centavos / segundos trabajados de UNA persona (por nombre) en una sucursal y un período.
create function public.t_cost(p_name text, p_branch uuid, p_from date, p_to date, p_as_of timestamptz default '2026-06-01 12:00:00+00')
returns bigint language sql stable as $$
  select coalesce((select r.cost_cents from app_private.branch_labor_cost_rows('f2000000-0000-4000-8000-000000000001', array[p_branch], p_from, p_to, p_as_of) r where r.employee_name = p_name), 0)::bigint
$$;
create function public.t_secs(p_name text, p_branch uuid, p_from date, p_to date, p_as_of timestamptz default '2026-06-01 12:00:00+00')
returns bigint language sql stable as $$
  select coalesce((select round(r.worked_seconds) from app_private.branch_labor_cost_rows('f2000000-0000-4000-8000-000000000001', array[p_branch], p_from, p_to, p_as_of) r where r.employee_name = p_name), 0)::bigint
$$;
create function public.t_total(p_branch uuid, p_from date, p_to date, p_as_of timestamptz default '2026-06-01 12:00:00+00')
returns table (labor_cents bigint, worked_seconds bigint, open_shifts integer, review_shifts integer, rate_missing boolean) language sql stable as $$
  select t.labor_cents, t.worked_seconds, t.open_shifts, t.review_shifts, t.rate_missing
  from app_private.branch_labor_cost_totals('f2000000-0000-4000-8000-000000000001', array[p_branch], p_from, p_to, p_as_of) t
$$;

-- ---------------------------------------------------------------------------------------------
-- Fichadas cerradas: duración exacta x valor hora
-- ---------------------------------------------------------------------------------------------
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10'), 4000000::bigint, '10 h x $4.000/h = $40.000');
select is(public.t_cost('Mica', 'f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10'), 2600000::bigint, '6 h 30 min x $4.000/h = $26.000 (exact minutes, not rounded hours)');
select is(public.t_secs('Mica', 'f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10'), 23400::bigint, '6 h 30 min = 23.400 seconds');
select is((select labor_cents from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10')), 6600000::bigint, 'two employees in the same branch add up ($40.000 + $26.000 = $66.000)');
select is((select count(*)::int from app_private.branch_labor_cost_rows('f2000000-0000-4000-8000-000000000001', array['f3000000-0000-4000-8000-000000000001'::uuid], '2026-04-10', '2026-04-10', '2026-06-01 12:00:00+00')), 2, 'one row per employee (the breakdown the modal shows)');
select is((select worked_seconds from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10')), 59400::bigint, 'worked seconds add up (10 h + 6 h 30 min)');
select is((select rate_missing from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10')), false, 'every hour has a rate -> not flagged');

-- ---------------------------------------------------------------------------------------------
-- Sucursal correcta: la de la FICHADA, no la habitual de la persona
-- ---------------------------------------------------------------------------------------------
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000002', '2026-04-11', '2026-04-11'), 1600000::bigint, 'Lucía worked 4 h at Janssen on 11/04: the cost belongs to Janssen');
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-04-11', '2026-04-11'), 0::bigint, '... and not to Avenida, where she also works on other days');
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000002', '2026-04-10', '2026-04-10'), 0::bigint, 'Janssen has no cost on 10/04 (Lucía was at Avenida)');
select is(public.t_cost('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-10', '2026-04-10'), 0::bigint, 'two branches, two employees: Mica at Avenida does not charge Janssen');

-- ---------------------------------------------------------------------------------------------
-- Períodos: Hoy / 7 días / 30 días / rango propio
-- ---------------------------------------------------------------------------------------------
select is((select labor_cents from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-04', '2026-04-10')), 6600000::bigint, '7 days (04/04-10/04) include the 10/04 shifts');
select is((select labor_cents from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-11', '2026-04-13')), 0::bigint, 'a period without shifts in that branch costs 0');
select is((select labor_cents from public.t_total('f3000000-0000-4000-8000-000000000002', '2026-04-11', '2026-04-12')), 3200000::bigint, 'custom range 11/04-12/04 at Janssen: Lucía 4 h + the first 4 h of Mica = $32.000');
select is((select labor_cents from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-03-12', '2026-04-10')), 6600000::bigint, '30 days only count the shifts that fall inside the window');
select is((select labor_cents from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10')), (select labor_cents from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10')), 'the same query is stable');

-- ---------------------------------------------------------------------------------------------
-- Cruce de medianoche (20:00 -> 02:00)
-- ---------------------------------------------------------------------------------------------
select is(public.t_secs('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-12', '2026-04-12'), 14400::bigint, 'looking at 12/04: 4 hours');
select is(public.t_secs('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-13', '2026-04-13'), 7200::bigint, 'looking at 13/04: 2 hours');
select is(public.t_secs('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-12', '2026-04-13'), 21600::bigint, 'looking at both days: 6 hours');
select is(public.t_cost('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-12', '2026-04-12'), 1600000::bigint, '12/04 costs 4 h x $4.000 = $16.000');
select is(public.t_cost('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-13', '2026-04-13'), 800000::bigint, '13/04 costs 2 h x $4.000 = $8.000');
select is(public.t_cost('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-12', '2026-04-13'), 2400000::bigint, 'both days cost the full 6 h = $24.000 (nothing counted twice)');
select is(public.t_secs('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-11', '2026-04-11'), 0::bigint, 'the day before the shift has none of it');

-- ---------------------------------------------------------------------------------------------
-- Timezone de la organización
-- ---------------------------------------------------------------------------------------------
update public.organizations set timezone = 'UTC' where id = 'f2000000-0000-4000-8000-000000000001';
select is(public.t_secs('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-12', '2026-04-12'), 3600::bigint, 'with an UTC organization the same shift has only 1 h on 12/04 (23:00Z-24:00Z)');
update public.organizations set timezone = 'America/Argentina/Buenos_Aires' where id = 'f2000000-0000-4000-8000-000000000001';
select is(public.t_secs('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-12', '2026-04-12'), 14400::bigint, 'with the Buenos Aires timezone it is 4 h again');

-- ---------------------------------------------------------------------------------------------
-- Valor hora histórico
-- ---------------------------------------------------------------------------------------------
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-02-10', '2026-02-10'), 2800000::bigint, 'February: 8 h x $3.500 = $28.000 (the old rate, not $4.000)');
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10'), 4000000::bigint, 'April: 10 h x $4.000 = $40.000');
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-02-28', '2026-02-28'), 1400000::bigint, 'a shift across the rate change: the part before it (28/02, 4 h) uses $3.500');
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-03-01', '2026-03-01'), 1600000::bigint, '... and the part after it (01/03, 4 h) uses $4.000');
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-02-28', '2026-03-01'), 3000000::bigint, '... together: 4 h x $3.500 + 4 h x $4.000 = $30.000');
select is((select min_rate_cents from app_private.branch_labor_cost_rows('f2000000-0000-4000-8000-000000000001', array['f3000000-0000-4000-8000-000000000001'::uuid], '2026-02-28', '2026-03-01', '2026-06-01 12:00:00+00') where employee_name = 'Lucía'), 350000::bigint, 'the breakdown reports the lowest rate used');
select is((select max_rate_cents from app_private.branch_labor_cost_rows('f2000000-0000-4000-8000-000000000001', array['f3000000-0000-4000-8000-000000000001'::uuid], '2026-02-28', '2026-03-01', '2026-06-01 12:00:00+00') where employee_name = 'Lucía'), 400000::bigint, '... and the highest');

-- ---------------------------------------------------------------------------------------------
-- Fichada ABIERTA: la hora actual la define la consulta; no se escribe nada
-- ---------------------------------------------------------------------------------------------
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-04-20', '2026-04-20', '2026-04-20 15:00:00+00'), 1600000::bigint, 'open shift 08:00 consulted at 12:00: 4 h x $4.000 = $16.000');
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-04-20', '2026-04-20', '2026-04-20 19:00:00+00'), 3200000::bigint, 'the same shift consulted at 16:00: 8 h = $32.000 (the cost grew with no new record)');
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-04-20', '2026-04-20', '2026-04-20 17:30:00+00'), 2600000::bigint, 'open shift 08:00 consulted at 14:30: 6 h 30 = $26.000');
select is((select open_shifts from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-20', '2026-04-20', '2026-04-20 15:00:00+00')), 1, 'the open shift is reported (the UI uses it to refresh periodically)');
select is((select open_shifts from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10')), 0, 'closed shifts are not reported as open');
select is((select count(*)::int from public.employee_shifts where organization_id = 'f2000000-0000-4000-8000-000000000001'), 13, 'consulting never writes: no hourly records were created');
-- Corte al período: una fichada abierta desde ayer sólo aporta a hoy lo que pasó hoy.
select is(public.t_secs('Live', 'f3000000-0000-4000-8000-000000000001', ((now() at time zone 'America/Argentina/Buenos_Aires')::date - 1), ((now() at time zone 'America/Argentina/Buenos_Aires')::date), now()), 23400::bigint, 'an open shift started 6 h 30 min ago counts exactly 6 h 30 min across yesterday + today');
select is(public.t_secs('Live', 'f3000000-0000-4000-8000-000000000001', ((now() at time zone 'America/Argentina/Buenos_Aires')::date), ((now() at time zone 'America/Argentina/Buenos_Aires')::date), now()),
  least(23400, floor(extract(epoch from (now() - (((now() at time zone 'America/Argentina/Buenos_Aires')::date)::timestamp at time zone 'America/Argentina/Buenos_Aires'))))::bigint), 'looking only at today counts just the part of the open shift that happened today (cut at local midnight)');
select is(public.t_secs('Lucía', 'f3000000-0000-4000-8000-000000000001', '2026-04-21', '2026-04-21', '2026-04-21 06:00:00+00'), 0::bigint, 'an open shift from the previous day is cut by max_shift_hours (12 h) and adds nothing past its cap');
-- Latido vencido: se corta en el último latido (lo que haría el barrido), con latido fresco corre hasta ahora.
select is(public.t_cost('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-25', '2026-04-25', '2026-04-25 17:00:00+00'), 800000::bigint, 'a device that stopped sending heartbeats: the shift ends at the last heartbeat (2 h = $8.000), not at the query time');
select is(public.t_cost('Mica', 'f3000000-0000-4000-8000-000000000002', '2026-04-25', '2026-04-25', '2026-04-25 13:01:00+00'), 806667::bigint, 'with a fresh heartbeat (60 s old) it runs up to now: 7.260 s x $4.000/h = $8.066,67 -> $8.067 (rounded once)');
-- Tope por máximo de turno (12 h): sin evidencia de que siga trabajando, no se acumula sin límite.
select is(public.t_cost('Capped', 'f3000000-0000-4000-8000-000000000001', '2026-05-01', '2026-05-02', '2026-05-02 12:00:00+00'), 4800000::bigint, 'an open shift with no heartbeat is capped at max_shift_hours (12 h = $48.000), however long it stays open');
-- Con salida inferida (REQUIRES_REVIEW): cuenta hasta esa salida y se informa aparte.
select is(public.t_cost('Mica', 'f3000000-0000-4000-8000-000000000001', '2026-04-28', '2026-04-28'), 1200000::bigint, 'a REQUIRES_REVIEW shift with an inferred clock-out counts up to that clock-out (3 h = $12.000)');
select is((select review_shifts from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-28', '2026-04-28')), 1, '... and is reported as pending review');

-- ---------------------------------------------------------------------------------------------
-- Sin valor hora
-- ---------------------------------------------------------------------------------------------
select is(public.t_secs('SinTarifa', 'f3000000-0000-4000-8000-000000000001', '2026-04-14', '2026-04-14'), 7200::bigint, 'hours without a rate are still counted as worked hours');
select is(public.t_cost('SinTarifa', 'f3000000-0000-4000-8000-000000000001', '2026-04-14', '2026-04-14'), 0::bigint, '... but cost 0 (there is nothing to multiply by)');
select is((select rate_missing from public.t_total('f3000000-0000-4000-8000-000000000001', '2026-04-14', '2026-04-14')), true, '... and the branch is flagged as missing a rate (the result is incomplete)');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento por organización
-- ---------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.branch_labor_cost_rows('f2000000-0000-4000-8000-000000000001', array['f3000000-0000-4000-8000-000000000009'::uuid], '2026-04-10', '2026-04-10', '2026-06-01 12:00:00+00')), 0, 'org A cannot read the shifts of an org B branch');
select is((select labor_cents from app_private.branch_labor_cost_totals('f2000000-0000-4000-8000-000000000002', array['f3000000-0000-4000-8000-000000000009'::uuid], '2026-04-10', '2026-04-10', '2026-06-01 12:00:00+00')), 4000000::bigint, 'org B sees its own 10 h x $4.000');
select is((select count(*)::int from app_private.branch_labor_cost_rows('f2000000-0000-4000-8000-000000000002', array['f3000000-0000-4000-8000-000000000001'::uuid], '2026-04-10', '2026-04-10', '2026-06-01 12:00:00+00')), 0, 'org B cannot read the shifts of an org A branch');
select is(public.t_cost('Lucía', 'f3000000-0000-4000-8000-000000000001', '2025-12-15', '2025-12-15'), 0::bigint, 'the hourly rate of ANOTHER organization is never used to price these hours ($9.000/h of org B is ignored)');
select is((select rate_missing from public.t_total('f3000000-0000-4000-8000-000000000001', '2025-12-15', '2025-12-15')), true, '... and those hours are reported as missing a rate in this organization');

-- ---------------------------------------------------------------------------------------------
-- Ganancia bruta de Avenida el 10/04 (para el Resultado operativo): ventas $200.000 con costo $100.000 + una línea SIN costo conocido
-- ---------------------------------------------------------------------------------------------
insert into public.categories (id, organization_id, name, slug) values
  ('f7000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Varios', 'lc-varios');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('f8000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'Pata muslo', 'lc-pata', 'LC-PATA', 'WEIGHT'),
  ('f8000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'Sin costo', 'lc-sc', 'LC-SC', 'WEIGHT');
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('f9000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'COMPLETED', 20000000, 1000, '2026-04-10 15:00:00+00'),
  ('f9000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'COMPLETED', 500000, 1000, '2026-04-10 16:00:00+00');
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot) values
  ('f9000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001', 'Pata muslo', 1000, 20000000, 20000000, 20000000, 20000000, 10000000),
  ('f9000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000002', 'Sin costo', 1000, 500000, 500000, 500000, 500000, null);

-- ---------------------------------------------------------------------------------------------
-- Resultado operativo (camino público, como el dueño)
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is((select gross_profit_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'f3000000-0000-4000-8000-000000000001')), 10000000::bigint, 'Avenida gross profit on 10/04 is $100.000 (only the costed line)');
select is((select labor_cost_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'f3000000-0000-4000-8000-000000000001')), 6600000::bigint, 'the labor cost enters the operating result automatically ($66.000)');
select is((select operating_cost_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'f3000000-0000-4000-8000-000000000001')), 6600000::bigint, 'with no other costs, operating cost = labor');
select is((select operating_result_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'f3000000-0000-4000-8000-000000000001')), 3400000::bigint, 'operating result = gross profit - labor = $100.000 - $66.000 = $34.000');
select is((select operating_margin_bps from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'f3000000-0000-4000-8000-000000000001')), 1659::bigint, 'the margin is recomputed on the new result ($34.000 / $205.000 = 16,59 %)');
select is((select is_partial from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'f3000000-0000-4000-8000-000000000001')), true, 'an exact labor cost does NOT make an incomplete gross profit exact: still partial (sale line without cost)');
select is((select labor_rate_missing from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'f3000000-0000-4000-8000-000000000001')), false, 'no missing rate on 10/04');

-- Convive con los costos manuales sin pisarse: se suman (alquiler por mes + gasto puntual) y el personal no se toca.
select lives_ok($$select public.save_branch_recurring_cost('f3000000-0000-4000-8000-000000000001', null, 'Alquiler', 30000000, '2026-01-01', 'fa000000-0000-4000-8000-000000000001')$$, 'a manual monthly cost (rent) is created');
select lives_ok($$select public.record_branch_expense('f3000000-0000-4000-8000-000000000001', '2026-04-10', 'Reparación', 5000000, 'fa000000-0000-4000-8000-000000000002')$$, 'a one-off expense is recorded');
select is((select operating_cost_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'f3000000-0000-4000-8000-000000000001')), 6600000::bigint + 1000000 + 5000000, 'operating cost = labor 66.000 + rent 10.000 (one day of 30) + expense 50.000');
select is((select labor_cost_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'f3000000-0000-4000-8000-000000000001')), 6600000::bigint, 'the labor part is unchanged by the manual costs');
select is((select operating_result_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10', 'f3000000-0000-4000-8000-000000000001')), 10000000::bigint - 6600000 - 1000000 - 5000000, 'result = gross profit - labor - rent - expense');

-- Inicio: sin sucursal = todas las de la organización, cada una con SU personal; la otra organización no aparece.
select is((select count(*)::int from public.get_branch_operating_result('2026-04-10', '2026-04-10')), 2, 'Home lists only the branches of the organization');
select is((select labor_cost_cents from public.get_branch_operating_result('2026-04-11', '2026-04-11') where branch_name = 'Janssen'), 1600000::bigint, 'Home: Janssen carries its own labor cost');
select is((select labor_cost_cents from public.get_branch_operating_result('2026-04-11', '2026-04-11') where branch_name = 'Avenida'), 0::bigint, 'Home: Avenida carries none on 11/04');
select is((select sum(operating_result_cents)::bigint from public.get_branch_operating_result('2026-04-11', '2026-04-11')), -1600000::bigint - 1000000, 'Home total = sum of the branches (labor and rent on 11/04)');

-- Fichada abierta, camino público: Live lleva 6 h 30 min con $4.000/h (ahora = now() de la transacción).
select is((select labor_cost_cents from public.get_branch_operating_result(((now() at time zone 'America/Argentina/Buenos_Aires')::date - 1), (now() at time zone 'America/Argentina/Buenos_Aires')::date, 'f3000000-0000-4000-8000-000000000001')), 2600000::bigint, 'the live open shift (6 h 30 min ago) already counts $26.000 in the result');
select is((select labor_open_shifts from public.get_branch_operating_result(((now() at time zone 'America/Argentina/Buenos_Aires')::date - 1), (now() at time zone 'America/Argentina/Buenos_Aires')::date, 'f3000000-0000-4000-8000-000000000001')), 1, 'and the card knows there is an open shift (periodic refresh)');

-- Modal «Configurar costos»: sección PERSONAL con el desglose por persona.
select is((public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') #>> '{labor,costCents}')::bigint, 6600000::bigint, 'the modal reports the labor total');
select is((public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') ->> 'laborCents')::bigint, 6600000::bigint, '... also at the top level');
select is(jsonb_array_length(public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') #> '{labor,employees}'), 2, 'the modal lists the two employees');
select is((select e ->> 'name' from jsonb_array_elements(public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') #> '{labor,employees}') e order by e ->> 'name' limit 1), 'Lucía', 'employees are listed by name');
select is((select (e ->> 'minRateCents')::bigint from jsonb_array_elements(public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') #> '{labor,employees}') e where e ->> 'name' = 'Lucía'), 400000::bigint, 'each employee carries the hourly rate');
select is((select (e ->> 'workedSeconds')::bigint from jsonb_array_elements(public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') #> '{labor,employees}') e where e ->> 'name' = 'Mica'), 23400::bigint, 'and the exact hours worked (6 h 30 min)');
select is((public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') ->> 'operatingCostCents')::bigint, 6600000::bigint + 1000000 + 5000000, 'the modal total = labor + rent + expense (same number as the card)');
select is((public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') #>> '{labor,canSeeDetail}')::boolean, true, 'the owner sees the per-person detail');

-- Permisos: quien no tiene analytics.read no ve nada; quien lo tiene pero no timekeeping.read ve el total, no el desglose con valores hora.
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000009', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select is((public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') #>> '{labor,costCents}')::bigint, 6600000::bigint, 'an analyst (analytics.read) sees the labor total');
select is((public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') #>> '{labor,canSeeDetail}')::boolean, false, '... but without timekeeping.read the detail is withheld');
select is(jsonb_array_length(public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10') #> '{labor,employees}'), 0, '... no employee rates are returned');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select * from public.get_branch_operating_result('2026-04-10', '2026-04-10')$$, '42501', null, 'an employee without analytics.read cannot read the result');
select throws_ok($$select public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10')$$, '42501', null, '... nor the modal');

-- Otra organización: el administrador B sólo ve lo suyo.
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000007', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000007","role":"authenticated"}', true);
select is((select count(*)::int from public.get_branch_operating_result('2026-04-10', '2026-04-10')), 1, 'admin B sees a single branch (its own)');
select is((select labor_cost_cents from public.get_branch_operating_result('2026-04-10', '2026-04-10')), 4000000::bigint, 'admin B sees only its own labor cost ($40.000), not the $66.000 of org A');
select throws_ok($$select public.get_branch_operating_costs('f3000000-0000-4000-8000-000000000001', '2026-04-10', '2026-04-10')$$, '42501', null, 'admin B cannot open the cost modal of an org A branch');

reset role;
select * from finish();
rollback;
