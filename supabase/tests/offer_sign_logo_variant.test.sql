begin;

create extension if not exists pgtap with schema extensions;
select plan(22);

-- Covers 202610210087 (D-087): logo elegido para los carteles de ofertas impresos + logo de la carnicería.
-- El logo de identidad (organization_artwork_logos) NO cambia: Instagram, Story, TV y las etiquetas siguen leyéndolo.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'os-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"OS Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'os-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"OS Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'os-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"OS Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'OS Org', 'os-org'),
  ('e2000000-0000-4000-8000-000000000002', 'OS Org B', 'os-org-b');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into storage.objects (bucket_id, name, metadata) values
  ('product-artwork', 'e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-000000000001.png', '{"mimetype":"image/png","size":80000}'),
  ('product-artwork', 'e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-000000000002.jpg', '{"mimetype":"image/jpeg","size":70000}'),
  ('product-artwork', 'e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-000000000003.png', '{"mimetype":"image/gif","size":1000}'),
  ('product-artwork', 'e2000000-0000-4000-8000-000000000002/branding/e6000000-0000-4000-8000-000000000004.png', '{"mimetype":"image/png","size":50000}');
-- Logo de identidad existente (el de la despensa).
insert into storage.objects (bucket_id, name, metadata) values
  ('product-artwork', 'e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-000000000009.png', '{"mimetype":"image/png","size":60000}');

select has_table('public', 'organization_offer_sign_settings', 'the settings table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.organization_offer_sign_settings'::regclass), 'it has RLS');
select ok(not has_table_privilege('authenticated', 'public.organization_offer_sign_settings', 'INSERT'), 'browser clients cannot insert');
select ok(not has_function_privilege('anon', 'public.set_offer_sign_logo_variant(text)', 'EXECUTE'), 'anonymous cannot choose the logo');
select ok(not has_function_privilege('anon', 'public.get_offer_sign_settings()', 'EXECUTE'), 'anonymous cannot read the settings');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_offer_sign_logo_variant('GENERAL')$$, '42501', null, 'an employee (no catalog.write) cannot choose the logo');
select throws_ok($$select public.set_offer_sign_butcher_logo('e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-000000000001.png', 400, 400)$$, '42501', null, 'nor register the butcher logo');
select is(public.get_offer_sign_settings() ->> 'logoVariant', 'GENERAL', 'but can read the settings (products.read): default GENERAL');

select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.get_offer_sign_settings() -> 'butcherLogo', 'null'::jsonb, 'no butcher logo yet');
select throws_ok($$select public.set_offer_sign_logo_variant('BUTCHER')$$, '22023', 'Todavía no cargaste el logo de la carnicería', 'BUTCHER cannot be chosen before it exists');
select throws_ok($$select public.set_offer_sign_logo_variant('OTRO')$$, '22023', 'Logo inválido', 'an unknown variant is rejected');
select throws_ok($$select public.set_offer_sign_butcher_logo('e2000000-0000-4000-8000-000000000002/branding/e6000000-0000-4000-8000-000000000004.png', 400, 400)$$, '22023', 'Ruta de logo inválida', 'a path under ANOTHER organization is rejected');
select throws_ok($$select public.set_offer_sign_butcher_logo('e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-000000000003.png', 400, 400)$$, '22023', 'El logo tiene que ser PNG o JPG', 'a GIF disguised as PNG is rejected');
select throws_ok($$select public.set_offer_sign_butcher_logo('e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-0000000000ff.png', 400, 400)$$, '22023', 'El logo todavía no se subió', 'an object never uploaded is rejected');

select is(public.set_offer_sign_butcher_logo('e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-000000000001.png', 400, 300) ->> 'previousPath', null::text, 'first butcher logo: no previous path');
select is(public.get_offer_sign_settings() -> 'butcherLogo' ->> 'width', '400', 'the reference is readable');
select is(public.set_offer_sign_logo_variant('BUTCHER') ->> 'logoVariant', 'BUTCHER', 'the admin selects the butcher logo');
select is(public.get_offer_sign_settings() ->> 'logoVariant', 'BUTCHER', 'and the choice persists');
select is(public.set_offer_sign_butcher_logo('e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-000000000002.jpg', 500, 500) ->> 'previousPath', 'e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-000000000001.png', 'replacing returns the previous path for cleanup');
select is((select count(*) from public.organization_artwork_logos), 0::bigint, 'the identity logo table was never touched');
select is(public.remove_offer_sign_butcher_logo() ->> 'removedPath', 'e2000000-0000-4000-8000-000000000001/branding/e6000000-0000-4000-8000-000000000002.jpg', 'removing returns the object path');
select is(public.get_offer_sign_settings() ->> 'logoVariant', 'GENERAL', 'removing the butcher logo falls back to GENERAL');

select * from finish();
rollback;
