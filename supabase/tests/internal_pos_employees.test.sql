begin;

create extension if not exists pgtap with schema extensions;
select plan(37);

select has_column('public', 'profiles', 'auth_user_id', 'profiles exposes an optional Auth link');
select ok(not (select attnotnull from pg_attribute where attrelid = 'public.profiles'::regclass and attname = 'auth_user_id'), 'Auth link is nullable');
select is((select confdeltype::text from pg_constraint where conname = 'profiles_auth_user_id_fkey'), 'n', 'deleting Auth only clears the optional link');
select has_function('public', 'create_pos_employee', array['text','text','uuid[]','bigint','timestamp without time zone','membership_status'], 'internal employee creation RPC exists');
select has_function('public', 'update_pos_employee', array['uuid','text','uuid[]','membership_status'], 'internal employee update RPC exists');
select ok(not has_function_privilege('anon', 'public.create_pos_employee(text,text,uuid[],bigint,timestamp without time zone,membership_status)', 'EXECUTE'), 'anonymous cannot create employees');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'internal-employee-admin@example.test', '', now(),
  '{"provider":"email","providers":["email"]}', '{"display_name":"Internal Employee Admin"}',
  now(), now(), '', '', '', ''
);

insert into public.organizations (id, name, slug) values
  ('a2000000-0000-4000-8000-000000000001', 'Internal Employee Org', 'internal-employee-org'),
  ('a2000000-0000-4000-8000-000000000002', 'Other Internal Org', 'other-internal-org');
insert into public.branches (id, organization_id, name, code) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Centro', 'INT-CENTRO'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'Norte', 'INT-NORTE'),
  ('a3000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000002', 'Ajena', 'INT-AJENA');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$
  select public.create_pos_employee(
    'Operadora Interna', '2468',
    array['a3000000-0000-4000-8000-000000000001'::uuid, 'a3000000-0000-4000-8000-000000000002'::uuid],
    350000, '2026-09-14 08:00', 'ACTIVE'
  )
$$, 'admin creates a complete employee without Auth');

select ok(exists(select 1 from public.profiles where display_name = 'Operadora Interna' and auth_user_id is null), 'employee profile is internal');
select ok(not exists(select 1 from auth.users where id = (select id from public.profiles where display_name = 'Operadora Interna')), 'employee has no Auth user');
select is((select role.key from public.organization_members membership join public.roles role on role.id = membership.role_id where membership.profile_id = (select id from public.profiles where display_name = 'Operadora Interna')), 'employee', 'internal profile receives employee role');
select is((select status::text from public.organization_members where profile_id = (select id from public.profiles where display_name = 'Operadora Interna')), 'ACTIVE', 'employee starts active');
select is((select count(*) from public.branch_members where profile_id = (select id from public.profiles where display_name = 'Operadora Interna') and active), 2::bigint, 'employee receives multiple branches');
reset role;
select isnt((select pin_hash from public.employee_pos_pins where profile_id = (select id from public.profiles where display_name = 'Operadora Interna')), '2468', 'PIN is never stored as plaintext');
select ok((select extensions.crypt('2468', pin_hash) = pin_hash from public.employee_pos_pins where profile_id = (select id from public.profiles where display_name = 'Operadora Interna')), 'stored PIN hash verifies with bcrypt');
select is((select rate_cents_per_hour from public.employee_hourly_rates where employee_id = (select id from public.profiles where display_name = 'Operadora Interna')), 350000::bigint, 'initial historical rate is stored in cents');
set local role authenticated;
select is((select auth_linked from public.list_organization_members() where display_name = 'Operadora Interna'), false, 'member directory marks employee as internal');
select is((select email from public.list_organization_members() where display_name = 'Operadora Interna'), null::text, 'internal employee has no email');
select is((select cardinality(branch_ids) from public.list_organization_members() where display_name = 'Operadora Interna'), 2, 'member directory groups all branch assignments');

select lives_ok($$select public.register_pos_device('a4000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'Caja interna')$$, 'admin registers an authorized device');
select ok((public.get_pos_operator_roster('a4000000-0000-4000-8000-000000000001') -> 'operators') @> '[{"displayName":"Operadora Interna"}]'::jsonb, 'internal employee appears in the branch roster');
select is((public.verify_pos_operator_pin('a4000000-0000-4000-8000-000000000001', (select id from public.profiles where display_name = 'Operadora Interna'), '2468') ->> 'ok')::boolean, true, 'internal employee authenticates with PIN');
reset role;
select ok(exists(select 1 from public.pos_operator_grants where operator_profile_id = (select id from public.profiles where display_name = 'Operadora Interna') and revoked_at is null), 'PIN verification issues a device-bound grant');
set local role authenticated;

select lives_ok($$
  select public.update_pos_employee(
    (select id from public.profiles where display_name = 'Operadora Interna'),
    'Operadora Interna Editada',
    array['a3000000-0000-4000-8000-000000000002'::uuid],
    'DISABLED'
  )
$$, 'admin edits and disables the internal employee');
select is((select count(*) from public.profiles where display_name = 'Operadora Interna Editada'), 1::bigint, 'update preserves the profile instead of replacing it');
select is((select status::text from public.organization_members where profile_id = (select id from public.profiles where display_name = 'Operadora Interna Editada')), 'DISABLED', 'membership is disabled');
select is((select count(*) from public.branch_members where profile_id = (select id from public.profiles where display_name = 'Operadora Interna Editada') and branch_id = 'a3000000-0000-4000-8000-000000000002' and active), 1::bigint, 'selected branch assignment remains active');
select is((select count(*) from public.branch_members where profile_id = (select id from public.profiles where display_name = 'Operadora Interna Editada') and branch_id = 'a3000000-0000-4000-8000-000000000001' and active), 0::bigint, 'removed branch assignment is deactivated');
reset role;
select ok(not exists(select 1 from public.pos_operator_grants where operator_profile_id = (select id from public.profiles where display_name = 'Operadora Interna Editada') and revoked_at is null), 'disabling revokes active grants');
set local role authenticated;
select ok(not (public.get_pos_operator_roster('a4000000-0000-4000-8000-000000000001') -> 'operators') @> '[{"displayName":"Operadora Interna Editada"}]'::jsonb, 'disabled employee leaves the POS roster');
select is((select count(*) from public.audit_logs where event_type = 'POS_EMPLOYEE_CREATED'), 1::bigint, 'creation is audited without exposing the PIN');
select ok(not exists(select 1 from public.audit_logs where event_type = 'POS_EMPLOYEE_CREATED' and after_data::text like '%2468%'), 'employee audit never contains the plaintext PIN');
select is((select count(*) from public.audit_logs where event_type = 'POS_EMPLOYEE_UPDATED'), 1::bigint, 'update is audited');

select throws_ok($$
  select public.create_pos_employee(
    'Empleado Ajeno', '1357', array['a3000000-0000-4000-8000-000000000003'::uuid],
    100000, '2026-09-14 08:00', 'ACTIVE'
  )
$$, '42501', 'Una sucursal no pertenece a la organización o está inactiva', 'cross-tenant branch assignment is rejected');
select is((select count(*) from public.profiles where display_name = 'Empleado Ajeno'), 0::bigint, 'failed cross-tenant creation is atomic');

reset role;
select lives_ok($$delete from auth.users where id = 'a1000000-0000-4000-8000-000000000001'$$, 'Auth account can be removed without deleting operational identity');
select ok(exists(select 1 from public.profiles where id = 'a1000000-0000-4000-8000-000000000001'), 'historical admin profile survives Auth deletion');
select is((select auth_user_id from public.profiles where id = 'a1000000-0000-4000-8000-000000000001'), null::uuid, 'deleted Auth link is cleared');

select * from finish();
rollback;
