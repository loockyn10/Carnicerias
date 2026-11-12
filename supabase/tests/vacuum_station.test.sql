begin;

create extension if not exists pgtap with schema extensions;
select plan(29);

-- Cubre 202611070096 (estación de producción de Envasados): lista de cortes con categorías y frecuencia, y resumen del día. Son RPC de solo lectura:
-- el registro del paquete sigue siendo `create_vacuum_package`. Fixture: una organización con administrador y dos sucursales, y otra organización ajena.

select ok(not has_function_privilege('anon', 'public.list_vacuum_station_products(uuid)', 'EXECUTE'), 'anonymous cannot list the station products');
select ok(not has_function_privilege('anon', 'public.get_vacuum_station_summary(uuid,date)', 'EXECUTE'), 'anonymous cannot read the station summary');
select ok(has_function_privilege('authenticated', 'public.list_vacuum_station_products(uuid)', 'EXECUTE'), 'authenticated users can list the station products');
select ok((select bool_and(p.provolatile = 's') from pg_proc p where p.oid in ('public.list_vacuum_station_products(uuid)'::regprocedure, 'public.get_vacuum_station_summary(uuid,date)'::regprocedure)), 'both RPCs are stable (read only)');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'vst-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"VST Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'vst-other@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"VST Other"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug, timezone) values
  ('f2000000-0000-4000-8000-000000000001', 'VST Org', 'vst-org', 'America/Argentina/Buenos_Aires'),
  ('f2000000-0000-4000-8000-000000000002', 'VST Org B', 'vst-org-b', 'America/Argentina/Buenos_Aires');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Central', 'CEN'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Sucursal Dos', 'DOS'),
  ('f3000000-0000-4000-8000-000000000009', 'f2000000-0000-4000-8000-000000000002', 'Central B', 'CEB');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug, sort_order) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Cerdo', 'cerdo', 1),
  ('f5000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Vacuno', 'vacuno', 2),
  ('f5000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'Menudencias', 'menudencias', 3);
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('f6000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 'Vacío de cerdo', 'vacio-cerdo', 'VCE', 'WEIGHT'),
  ('f6000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 'Churrasco de cerdo', 'churrasco-cerdo', 'CHC', 'WEIGHT'),
  ('f6000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002', 'Peceto', 'peceto', 'PEC', 'WEIGHT'),
  ('f6000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002', 'Sin habilitar', 'sin-habilitar', 'SHA', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id;
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('f2000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000001', null, 1500000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000002', null, 1000000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000003', 'f3000000-0000-4000-8000-000000000002', 2000000, now() - interval '1 day');

select set_config('test.today', ((clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date)::text, true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$select public.save_vacuum_ean_scheme('PRICE_EMBEDDED', '20', 4, 6, 100)$$, 'the EAN scheme is configured');
select lives_ok($$select public.save_vacuum_product_config('f6000000-0000-4000-8000-000000000001', true, 14, '12', null)$$, 'Vacío de cerdo is enabled');
select lives_ok($$select public.save_vacuum_product_config('f6000000-0000-4000-8000-000000000002', true, 14, '13', null)$$, 'Churrasco de cerdo is enabled');
select lives_ok($$select public.save_vacuum_product_config('f6000000-0000-4000-8000-000000000003', true, null, '14', null)$$, 'Peceto is enabled');

-- Cortes de la estación
select is(jsonb_array_length(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000001')), 3, 'lists the 3 enabled cuts (not the disabled one)');
select is(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000001') -> 0 ->> 'name', 'Churrasco de cerdo', 'ordered by name');
select is(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000001') -> 2 ->> 'pricePerKgCents', '1500000', 'with the branch price per kg (as text)');
select is(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000001') -> 1 ->> 'pricePerKgCents', null, 'a cut without a price in this branch is listed with a null price');
select is(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000002') -> 1 ->> 'pricePerKgCents', '2000000', 'and the price follows the requested branch');
select is(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000001') -> 1 ->> 'categoryName', 'Vacuno', 'a cut carries its category (id and name)');
select is(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000001') -> 1 ->> 'categoryId', 'f5000000-0000-4000-8000-000000000002', 'and the category id');
select is(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000001') -> 2 ->> 'shelfLifeDays', '14', 'the shelf life comes along (the station never invents an expiry)');
select is(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000001') -> 1 ->> 'shelfLifeDays', '14', 'a cut without its own shelf life gets the general default (202611120099)');
select throws_ok($$select public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000009')$$, '42501', null, 'a branch of another organization is refused');

-- Frecuencia y resumen: dos paquetes de Vacío y uno de Churrasco hoy en Central; uno de ellos se anula.
select set_config('vst.p1', (public.create_vacuum_package('f3000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000001', 750, current_setting('test.today')::date, null, null, 'f8000000-0000-4000-8000-000000000001') ->> 'id'), true);
select set_config('vst.p2', (public.create_vacuum_package('f3000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000001', 1250, current_setting('test.today')::date, null, null, 'f8000000-0000-4000-8000-000000000002') ->> 'id'), true);
select set_config('vst.p3', (public.create_vacuum_package('f3000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000002', 500, current_setting('test.today')::date, null, null, 'f8000000-0000-4000-8000-000000000003') ->> 'id'), true);
select is((select e ->> 'recentPackages' from jsonb_array_elements(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000001')) e where e ->> 'name' = 'Vacío de cerdo'), '2', 'the recent count is the cut''s packages in this branch');
select is((select e ->> 'recentPackages' from jsonb_array_elements(public.list_vacuum_station_products('f3000000-0000-4000-8000-000000000002')) e where e ->> 'name' = 'Vacío de cerdo'), '0', 'and it is per branch');
select is(public.get_vacuum_station_summary('f3000000-0000-4000-8000-000000000001') ->> 'packages', '3', 'the summary counts today''s packages');
select is(public.get_vacuum_station_summary('f3000000-0000-4000-8000-000000000001') ->> 'grams', '2500', 'and their grams (0,750 + 1,250 + 0,500 kg)');
select is(public.get_vacuum_station_summary('f3000000-0000-4000-8000-000000000001') ->> 'lastProductName', 'Churrasco de cerdo', 'the last processed cut is the most recent package');
select is(public.get_vacuum_station_summary('f3000000-0000-4000-8000-000000000002') ->> 'packages', '0', 'another branch has none');
select lives_ok($$select public.void_vacuum_package(current_setting('vst.p2')::uuid, 'se rompió el vacío')$$, 'a package is voided');
select is(public.get_vacuum_station_summary('f3000000-0000-4000-8000-000000000001') ->> 'packages', '2', 'voided packages are not counted');
select is(public.get_vacuum_station_summary('f3000000-0000-4000-8000-000000000001') ->> 'grams', '1250', 'nor their grams');
select is(public.get_vacuum_station_summary('f3000000-0000-4000-8000-000000000001', (current_setting('test.today')::date - 1)) ->> 'packages', '0', 'another day has none');
select throws_ok($$select public.get_vacuum_station_summary('f3000000-0000-4000-8000-000000000009')$$, '42501', null, 'the summary refuses a branch of another organization');

select * from finish();
rollback;
