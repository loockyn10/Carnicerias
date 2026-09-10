begin;

create extension if not exists pgtap with schema extensions;

select plan(35);

select has_table('public', 'organizations', 'organizations exists');
select has_table('public', 'branches', 'branches exists');
select has_table('public', 'profiles', 'profiles exists');
select has_table('public', 'roles', 'roles exists');
select has_table('public', 'permissions', 'permissions exists');
select has_table('public', 'role_permissions', 'role_permissions exists');
select has_table('public', 'organization_members', 'organization_members exists');
select has_table('public', 'branch_members', 'branch_members exists');
select has_table('public', 'categories', 'categories exists');
select has_table('public', 'products', 'products exists');
select has_table('public', 'product_prices', 'product_prices exists');

select ok((select relrowsecurity from pg_class where oid = 'public.organizations'::regclass), 'organizations has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.branches'::regclass), 'branches has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.roles'::regclass), 'roles has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.permissions'::regclass), 'permissions has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.role_permissions'::regclass), 'role_permissions has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.organization_members'::regclass), 'organization_members has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.branch_members'::regclass), 'branch_members has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.categories'::regclass), 'categories has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.products'::regclass), 'products has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.product_prices'::regclass), 'product_prices has RLS');

select has_trigger('auth', 'users', 'on_auth_user_created', 'Auth creates a profile');
select col_type_is('public', 'product_prices', 'price_cents', 'bigint', 'prices use integer cents');
select has_function('app_private', 'has_permission', array['uuid', 'text'], 'permission helper exists');

select ok(has_table_privilege('authenticated', 'public.profiles', 'SELECT'), 'authenticated can select profiles');
select ok(has_table_privilege('authenticated', 'public.organization_members', 'SELECT'), 'authenticated can select memberships');
select ok(has_table_privilege('authenticated', 'public.organizations', 'SELECT'), 'authenticated can select organizations');
select ok(has_table_privilege('authenticated', 'public.roles', 'SELECT'), 'authenticated can select roles');
select ok(has_table_privilege('authenticated', 'public.branches', 'SELECT'), 'authenticated can select branches');
select ok(has_table_privilege('authenticated', 'public.products', 'SELECT'), 'authenticated can select products');
select ok(not has_table_privilege('anon', 'public.profiles', 'SELECT'), 'anonymous cannot select profiles');
select ok(not has_table_privilege('anon', 'public.organization_members', 'SELECT'), 'anonymous cannot select memberships');
select ok(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_private' and p.proname = 'has_permission'),
  'permission helper is security definer'
);
select ok(
  (select coalesce(array_to_string(proconfig, ','), '') = 'search_path=""' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_private' and p.proname = 'has_permission'),
  'permission helper has an empty search path'
);

select * from finish();

rollback;
