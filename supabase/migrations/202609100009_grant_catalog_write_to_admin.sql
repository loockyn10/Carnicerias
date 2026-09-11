begin;

insert into public.permissions (key, description)
values ('catalog.write', 'Manage catalog commercial configuration, including weight discounts and notices')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
values ('10000000-0000-4000-8000-000000000001'::uuid, 'catalog.write')
on conflict (role_id, permission_key) do nothing;

commit;
