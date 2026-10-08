begin;

create extension if not exists pgtap with schema extensions;
select plan(54);

-- Covers 202610090072 (D-075): logo de cartelería de la organización (Storage + referencia) y teléfono / ciudad por sucursal.
-- El logo vive en el bucket privado `product-artwork` (carpeta `<org>/branding/`); el contacto es de la SUCURSAL: una pieza nunca
-- mezcla datos de otra sucursal ni de otra organización.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'bd-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"BD Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'bd-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"BD Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'bd-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"BD Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'BD Org', 'bd-org'),
  ('d2000000-0000-4000-8000-000000000002', 'BD Org B', 'bd-org-b');
insert into public.branches (id, organization_id, name, code, address, phone, city) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'BD Central', 'BD-C', 'Güemes 2180', '3496-448808', 'Esperanza, Santa Fe'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'BD Avenida', 'BD-A', null, null, null),
  ('d3000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000002', 'BD B Branch', 'BD-B', 'Calle B 1', '011-5555', 'Rosario, Santa Fe');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002');

insert into storage.objects (bucket_id, name, metadata) values
  ('product-artwork', 'd2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000001.png', '{"mimetype":"image/png","size":80000}'),
  ('product-artwork', 'd2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000002.png', '{"mimetype":"image/png","size":90000}'),
  ('product-artwork', 'd2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000003.jpg', '{"mimetype":"image/jpeg","size":70000}'),
  ('product-artwork', 'd2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000004.png', '{"mimetype":"image/gif","size":1000}'),
  ('product-artwork', 'd2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000005.png', '{"mimetype":"image/png","size":9000000}'),
  ('product-artwork', 'd2000000-0000-4000-8000-000000000002/branding/d6000000-0000-4000-8000-000000000006.png', '{"mimetype":"image/png","size":50000}');

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'organization_artwork_logos', 'the logo reference table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.organization_artwork_logos'::regclass), 'the logo table has RLS');
select ok(not has_table_privilege('anon', 'public.organization_artwork_logos', 'SELECT'), 'anonymous cannot read logo references');
select ok(not has_table_privilege('authenticated', 'public.organization_artwork_logos', 'INSERT'), 'browser clients cannot insert logo references');
select ok(not has_table_privilege('authenticated', 'public.organization_artwork_logos', 'UPDATE'), 'nor update them');
select ok(not has_table_privilege('authenticated', 'public.organization_artwork_logos', 'DELETE'), 'nor delete them');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organization_artwork_logos' and (data_type = 'bytea' or column_name ~ 'base64|blob|data')),
  'the logo table keeps a path and metadata only: no bytea, base64 or blob column');
select ok(not has_function_privilege('anon', 'public.set_organization_artwork_logo(text,integer,integer)', 'EXECUTE'), 'anonymous cannot register a logo');
select ok(not has_function_privilege('anon', 'public.remove_organization_artwork_logo()', 'EXECUTE'), 'anonymous cannot remove a logo');
select ok(not has_function_privilege('anon', 'public.set_branch_artwork_contact(uuid,text,text,text)', 'EXECUTE'), 'anonymous cannot edit a branch contact');
select ok(not has_function_privilege('anon', 'public.get_artwork_branding(uuid)', 'EXECUTE'), 'anonymous cannot read the branding');
select is((select count(*) from pg_attribute where attrelid = 'public.branches'::regclass and attname in ('phone', 'city') and not attisdropped), 2::bigint, 'branches gained phone and city (address already existed)');

-- ---------------------------------------------------------------------------------------------
-- Permisos y validaciones de escritura
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_organization_artwork_logo('d2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000001.png', 400, 900)$$, '42501', null, 'an employee (no catalog.write) cannot register the logo');
select throws_ok($$select public.remove_organization_artwork_logo()$$, '42501', null, 'nor remove it');
select throws_ok($$select public.set_branch_artwork_contact('d3000000-0000-4000-8000-000000000001', '123', 'x', 'y')$$, '42501', null, 'nor edit a branch contact (branches.write)');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.set_organization_artwork_logo('d2000000-0000-4000-8000-000000000002/branding/d6000000-0000-4000-8000-000000000006.png', 400, 900)$$, '22023', 'Ruta de logo inválida', 'a logo under ANOTHER organization folder is rejected');
select throws_ok($$select public.set_organization_artwork_logo('../etc/passwd', 400, 900)$$, '22023', 'Ruta de logo inválida', 'a path that is not <org>/branding/<uuid>.<ext> is rejected');
select throws_ok($$select public.set_organization_artwork_logo(null, 400, 900)$$, '22023', 'Ruta de logo inválida', 'a null path is rejected');
select throws_ok($$select public.set_organization_artwork_logo('d2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-0000000000ff.png', 400, 900)$$, '22023', 'El logo todavía no se subió', 'an object that was never uploaded is rejected');
select throws_ok($$select public.set_organization_artwork_logo('d2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000004.png', 400, 900)$$, '22023', 'El logo tiene que ser PNG o JPG', 'a GIF disguised as .png is rejected (type comes from Storage metadata)');
select throws_ok($$select public.set_organization_artwork_logo('d2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000005.png', 400, 900)$$, '22023', 'El logo pesa demasiado (máximo 5 MB)', 'a logo over 5 MB is rejected');
select throws_ok($$select public.set_organization_artwork_logo('d2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000001.png', 0, 900)$$, '22023', 'Medidas de logo inválidas', 'zero width is rejected');
select throws_ok($$select public.set_organization_artwork_logo('d2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000001.png', 400, 20000)$$, '22023', 'Medidas de logo inválidas', 'and absurd measures too');
select throws_ok($$select public.set_organization_artwork_logo('d2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000003.png', 400, 900)$$, '22023', 'El logo todavía no se subió', 'the extension must match the object that exists');

-- ---------------------------------------------------------------------------------------------
-- Alta, reemplazo y baja del logo
-- ---------------------------------------------------------------------------------------------
select is((public.get_artwork_branding(null) -> 'logo'), 'null'::jsonb, 'an organization without logo reads logo = null');
select is(public.set_organization_artwork_logo('d2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000001.png', 400, 900) ->> 'previousPath', null::text, 'the first logo has no previous path');
select is(public.get_artwork_branding(null) -> 'logo' ->> 'contentType', 'image/png', 'the reference stores the type Storage recorded');
select is((public.get_artwork_branding(null) -> 'logo' ->> 'width')::integer, 400, 'and the measures the server read');
select is(public.set_organization_artwork_logo('d2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000003.jpg', 500, 800) ->> 'previousPath', 'd2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000001.png', 'replacing returns the previous path so the server can delete the object');
select is((select count(*) from public.organization_artwork_logos where organization_id = 'd2000000-0000-4000-8000-000000000001'), 1::bigint, 'there is only ONE logo per organization');
select is(public.get_artwork_branding(null) -> 'logo' ->> 'contentType', 'image/jpeg', 'the new logo replaced the old one');
select is((select count(*) from public.audit_logs where event_type = 'ARTWORK_LOGO_SET'), 2::bigint, 'each registration is audited');

-- ---------------------------------------------------------------------------------------------
-- Contacto por sucursal (sin mezclar sucursales)
-- ---------------------------------------------------------------------------------------------
select is(public.get_artwork_branding('d3000000-0000-4000-8000-000000000001') -> 'branch' ->> 'phone', '3496-448808', 'Central: its own phone');
select is(public.get_artwork_branding('d3000000-0000-4000-8000-000000000001') -> 'branch' ->> 'address', 'Güemes 2180', 'its own address (existing column)');
select is(public.get_artwork_branding('d3000000-0000-4000-8000-000000000001') -> 'branch' ->> 'city', 'Esperanza, Santa Fe', 'its own city');
select is(public.get_artwork_branding('d3000000-0000-4000-8000-000000000002') -> 'branch' -> 'phone', 'null'::jsonb, 'Avenida (nothing configured): NO phone is borrowed from Central');
select is(public.get_artwork_branding('d3000000-0000-4000-8000-000000000002') -> 'branch' -> 'city', 'null'::jsonb, 'nor its city');
select is(public.get_artwork_branding(null) -> 'branch', 'null'::jsonb, 'without branch there is no contact block');
select is(public.set_branch_artwork_contact('d3000000-0000-4000-8000-000000000002', '  0342 - 4 555 555 ', ' Av. Libertad 100 ', ' Santa Fe, Santa Fe ') ->> 'phone', '0342 - 4 555 555', 'saving trims the values');
select is(public.get_artwork_branding('d3000000-0000-4000-8000-000000000002') -> 'branch' ->> 'city', 'Santa Fe, Santa Fe', 'and they are readable afterwards');
select is(public.get_artwork_branding('d3000000-0000-4000-8000-000000000001') -> 'branch' ->> 'phone', '3496-448808', 'editing Avenida did not touch Central');
select is(public.set_branch_artwork_contact('d3000000-0000-4000-8000-000000000002', '', '', '') ->> 'phone', null::text, 'empty values clear the fields');
select throws_ok($$select public.set_branch_artwork_contact('d3000000-0000-4000-8000-000000000002', 'llamar al 3496', null, null)$$, '22023', null, 'a phone with letters is rejected');
select throws_ok($$select public.set_branch_artwork_contact('d3000000-0000-4000-8000-000000000002', null, null, 'X')$$, '22023', null, 'a one-letter city is rejected');
select throws_ok($$select public.set_branch_artwork_contact('d3000000-0000-4000-8000-000000000003', '1234', null, null)$$, '42501', 'Branch was not found in this organization', 'a branch of another organization cannot be edited');
select throws_ok($$select public.get_artwork_branding('d3000000-0000-4000-8000-000000000003')$$, '42501', 'Branch not found', 'nor read through the branding');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento entre organizaciones
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.get_artwork_branding(null) -> 'logo', 'null'::jsonb, 'the admin of B does not see A''s logo');
select is((select count(*) from public.organization_artwork_logos), 0::bigint, 'RLS hides A''s logo reference from B');
select is(public.get_artwork_branding('d3000000-0000-4000-8000-000000000003') -> 'branch' ->> 'city', 'Rosario, Santa Fe', 'B reads its own branch contact');
select throws_ok($$select public.get_artwork_branding('d3000000-0000-4000-8000-000000000001')$$, '42501', 'Branch not found', 'and not A''s branch');
select is((select count(*) from storage.objects where bucket_id = 'product-artwork' and name like 'd2000000-0000-4000-8000-000000000001/%'), 0::bigint, 'B cannot read A''s logo object in Storage');

-- ---------------------------------------------------------------------------------------------
-- Baja
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.remove_organization_artwork_logo() ->> 'removedPath', 'd2000000-0000-4000-8000-000000000001/branding/d6000000-0000-4000-8000-000000000003.jpg', 'removing returns the object path for Storage cleanup');
select is(public.get_artwork_branding(null) -> 'logo', 'null'::jsonb, 'after removing, the logo is gone');
select is(public.remove_organization_artwork_logo() ->> 'removedPath', null::text, 'removing again is a no-op');

select * from finish();
rollback;
