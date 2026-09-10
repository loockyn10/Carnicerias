begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

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

select * from finish();

rollback;

