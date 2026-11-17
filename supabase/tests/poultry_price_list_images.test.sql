begin;

create extension if not exists pgtap with schema extensions;
select plan(37);

-- Cubre 202611170104 (Pollos → «Lista de precios»: imágenes configurables): logo reutilizado (identidad / carnicería) o propio, fondo,
-- validación del objeto de Storage, ruta por organización, permisos y aislamiento.

select ok(not has_function_privilege('anon', 'public.set_poultry_price_list_image(text,text,integer,integer)', 'EXECUTE'), 'anonymous cannot register images');
select ok(not has_function_privilege('anon', 'public.get_poultry_price_list_settings()', 'EXECUTE'), 'anonymous cannot read the settings');
select ok(not has_table_privilege('authenticated', 'public.poultry_price_list_settings', 'INSERT'), 'the settings have no direct INSERT grant');
select ok((select relrowsecurity from pg_class where oid = 'public.poultry_price_list_settings'::regclass), 'the settings table has RLS');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pli-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PLI Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pli-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PLI Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pli-reader-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PLI Reader A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'pli-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PLI Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'PLI Org A', 'pli-org-a'),
  ('f2000000-0000-4000-8000-000000000002', 'PLI Org B', 'pli-org-b');
insert into public.roles (id, organization_id, key, name, is_system) values ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'pollos_lectura', 'Pollos lectura', false);
insert into public.role_permissions (role_id, permission_key) values ('f4000000-0000-4000-8000-000000000001', 'poultry.read');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'f4000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'ACTIVE');

-- Objetos «subidos» a Storage (metadatos como los guarda Supabase).
insert into storage.objects (bucket_id, name, metadata) values
  ('product-artwork', 'f2000000-0000-4000-8000-000000000001/branding/a0000000-0000-4000-8000-000000000001.png', '{"mimetype":"image/png","size":1000}'),
  ('product-artwork', 'f2000000-0000-4000-8000-000000000001/branding/a0000000-0000-4000-8000-000000000002.png', '{"mimetype":"image/png","size":1200}'),
  ('product-artwork', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000001.png', '{"mimetype":"image/png","size":2000}'),
  ('product-artwork', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000002.jpg', '{"mimetype":"image/jpeg","size":3000000}'),
  ('product-artwork', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000003.jpg', '{"mimetype":"image/jpeg","size":2500000}'),
  ('product-artwork', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000004.png', '{"mimetype":"image/jpeg","size":2500}'),
  ('product-artwork', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000005.jpg', '{"mimetype":"image/jpeg","size":6000000}'),
  ('product-artwork', 'f2000000-0000-4000-8000-000000000002/poultry-price-list/b0000000-0000-4000-8000-000000000009.png', '{"mimetype":"image/png","size":2000}');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Sin nada cargado
select is(public.get_poultry_price_list_settings() ->> 'logoSource', 'ARTWORK', 'without settings the identity logo is the default source');
select is(public.get_poultry_price_list_settings() -> 'logo', 'null'::jsonb, 'without any logo there is nothing to draw (no logo is invented)');
select is(public.get_poultry_price_list_settings() -> 'background', 'null'::jsonb, 'without a background the template uses its neutral one');
select throws_ok($$select public.set_poultry_price_list_logo_source('BUTCHER')$$, '22023', null, 'a logo that is not loaded cannot be chosen');

-- Logos que la aplicación ya guarda (Cartelería)
reset role;
insert into public.organization_artwork_logos (organization_id, storage_path, content_type, size_bytes, width_px, height_px)
values ('f2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001/branding/a0000000-0000-4000-8000-000000000001.png', 'image/png', 1000, 800, 200);
insert into public.organization_offer_sign_settings (organization_id, butcher_storage_path, butcher_content_type, butcher_size_bytes, butcher_width_px, butcher_height_px)
values ('f2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001/branding/a0000000-0000-4000-8000-000000000002.png', 'image/png', 1200, 600, 600);
set local role authenticated;
select is(public.get_poultry_price_list_settings() #>> '{logo,storagePath}', 'f2000000-0000-4000-8000-000000000001/branding/a0000000-0000-4000-8000-000000000001.png', 'the existing identity logo is reused automatically');
select is(public.get_poultry_price_list_settings() #>> '{options,BUTCHER,widthPx}', '600', 'the butcher logo is offered too');
select lives_ok($$select public.set_poultry_price_list_logo_source('BUTCHER')$$, 'the butcher logo can be chosen');
select is(public.get_poultry_price_list_settings() ->> 'logoUsed', 'BUTCHER', 'and is the one used');

-- Logo propio
select throws_ok($$select public.set_poultry_price_list_image('LOGO', 'f2000000-0000-4000-8000-000000000002/poultry-price-list/b0000000-0000-4000-8000-000000000009.png', 10, 10)$$, '22023', null, 'a path of another organization is rejected');
select throws_ok($$select public.set_poultry_price_list_image('LOGO', 'f2000000-0000-4000-8000-000000000001/branding/a0000000-0000-4000-8000-000000000001.png', 10, 10)$$, '22023', null, 'a path outside the price-list folder is rejected');
select throws_ok($$select public.set_poultry_price_list_image('LOGO', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/c0000000-0000-4000-8000-000000000001.png', 10, 10)$$, '22023', null, 'an object that was not uploaded is rejected');
select throws_ok($$select public.set_poultry_price_list_image('LOGO', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000004.png', 10, 10)$$, '22023', null, 'an extension that does not match the stored type is rejected');
select throws_ok($$select public.set_poultry_price_list_image('BACKGROUND', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000005.jpg', 10, 10)$$, '22023', null, 'an image over 5 MB is rejected');
select throws_ok($$select public.set_poultry_price_list_image('LOGO', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000001.png', 0, 10)$$, '22023', null, 'invalid dimensions are rejected');
select is(public.set_poultry_price_list_image('LOGO', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000001.png', 900, 240) ->> 'previousPath', null, 'a custom logo is registered');
select is(public.get_poultry_price_list_settings() ->> 'logoUsed', 'CUSTOM', 'uploading a logo selects it');
select is(public.get_poultry_price_list_settings() #>> '{logo,contentType}', 'image/png', 'with the type stored by Storage');

-- Fondo
select is(public.set_poultry_price_list_image('BACKGROUND', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000002.jpg', 2400, 1600) ->> 'previousPath', null, 'a background is registered');
select is(public.set_poultry_price_list_image('BACKGROUND', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000003.jpg', 2000, 1500) ->> 'previousPath',
  'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000002.jpg', 'replacing it returns the previous object to delete');
select is(public.get_poultry_price_list_settings() #>> '{background,widthPx}', '2000', 'the new background is kept');
select is(public.get_poultry_price_list_settings() ->> 'logoUsed', 'CUSTOM', 'the background does not change the logo');
select lives_ok($$select public.set_poultry_price_list_logo_source('ARTWORK')$$, 'going back to the identity logo keeps the custom one available');
select ok(public.get_poultry_price_list_settings() #> '{options,CUSTOM}' <> 'null'::jsonb, 'the custom logo remains an option');

-- Si el logo elegido desaparece, se usa el de identidad
select lives_ok($$select public.set_poultry_price_list_logo_source('BUTCHER')$$, 'choose the butcher logo again');
reset role;
update public.organization_offer_sign_settings set logo_variant = 'GENERAL', butcher_storage_path = null, butcher_content_type = null, butcher_size_bytes = null, butcher_width_px = null, butcher_height_px = null;
set local role authenticated;
select is(public.get_poultry_price_list_settings() ->> 'logoUsed', 'ARTWORK', 'a removed butcher logo falls back to the identity logo');
select is(public.get_poultry_price_list_settings() #>> '{logo,storagePath}', 'f2000000-0000-4000-8000-000000000001/branding/a0000000-0000-4000-8000-000000000001.png', 'and the identity logo is the one drawn');

select is(public.remove_poultry_price_list_background() ->> 'removedPath', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000003.jpg', 'removing the background returns its object');
select is(public.get_poultry_price_list_settings() -> 'background', 'null'::jsonb, 'and the template is back to the neutral background');

-- Permisos y aislamiento
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select ok(public.get_poultry_price_list_settings() -> 'logo' <> 'null'::jsonb, 'read-only poultry access reads the settings');
select throws_ok($$select public.set_poultry_price_list_logo_source('ARTWORK')$$, '42501', null, 'read-only poultry access cannot change the logo');
select throws_ok($$select public.set_poultry_price_list_image('BACKGROUND', 'f2000000-0000-4000-8000-000000000001/poultry-price-list/b0000000-0000-4000-8000-000000000002.jpg', 10, 10)$$, '42501', null, 'read-only poultry access cannot register images');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_poultry_price_list_logo_source('ARTWORK')$$, '42501', null, 'an employee without poultry.write cannot change the logo');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000009', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select is(public.get_poultry_price_list_settings() -> 'logo', 'null'::jsonb, 'another organization does not see these logos');

select * from finish();
rollback;
