begin;

create extension if not exists pgtap with schema extensions;
select plan(129);

-- Cubre 202611010093 (Envasados): configuración por producto y por organización, búsqueda de cortes, peso × precio/kg, vida útil → vencimiento,
-- lote único, EAN-13 (dígito verificador, esquema configurable, rechazo de inválidos), snapshot histórico y reimpresión, idempotencia y aislamiento
-- por organización y sucursal. Fixture: org A (admin, empleado sin permisos, usuario limitado a la sucursal A1 SIN permiso de cambiar vencimiento) y org B.

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select ok((select count(*) from public.permissions where key in ('vacuum.read', 'vacuum.write', 'vacuum.configure', 'vacuum.override_expiry')) = 4, 'the vacuum permissions exist');
select ok((select count(*) from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000001' and permission_key like 'vacuum.%') = 4, 'the admin role holds every vacuum permission');
select ok(not exists(select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000002' and permission_key like 'vacuum.%'), 'the employee role holds no vacuum permission');
select ok(not has_function_privilege('anon', 'public.create_vacuum_package(uuid,uuid,integer,date,date,text,uuid)', 'EXECUTE'), 'anonymous cannot create packages');
select ok(not has_function_privilege('authenticated', 'app_private.vacuum_build_ean(text,text,integer,integer,integer,text,bigint,integer)', 'EXECUTE'), 'the EAN builder is private');
select ok(not has_table_privilege('authenticated', 'public.vacuum_packages', 'INSERT'), 'packages have no direct INSERT grant');
select ok(not has_table_privilege('authenticated', 'public.vacuum_packages', 'UPDATE'), 'packages have no direct UPDATE grant');
select ok(not has_table_privilege('authenticated', 'public.vacuum_packages', 'DELETE'), 'packages have no direct DELETE grant');
select ok(not has_table_privilege('authenticated', 'public.vacuum_lot_counters', 'SELECT'), 'the lot counter is not readable');
select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.product_vacuum_settings'::regclass, 'public.organization_vacuum_settings'::regclass, 'public.vacuum_packages'::regclass, 'public.vacuum_package_prints'::regclass)), 'every vacuum table has RLS enabled');

-- ---------------------------------------------------------------------------------------------
-- EAN-13 puro
-- ---------------------------------------------------------------------------------------------
select is(app_private.ean13_check_digit('200071805250'), 4, 'the check digit of 200071805250 is 4');
select is(app_private.ean13_check_digit('400638133393'), 1, 'the check digit of a known real EAN-13 (4006381333931) is 1');
select is(app_private.ean13_check_digit('590123412345'), 7, 'the check digit of the reference EAN 5901234123457 is 7');
select ok(app_private.ean13_is_valid('2000718052504'), 'a correct EAN-13 is valid');
select ok(not app_private.ean13_is_valid('2000718052505'), 'a wrong check digit is rejected');
select ok(not app_private.ean13_is_valid('200071805250'), 'twelve digits are rejected');
select ok(not app_private.ean13_is_valid('20007180525A4'), 'a non-numeric EAN is rejected');
select throws_ok($$select app_private.ean13_check_digit('12345')$$, '22023', null, 'the check digit needs exactly 12 digits');
select is(app_private.vacuum_build_ean('PRICE_EMBEDDED', '2', 4, 7, 1, '7', 1805250, 1245), '2000718052504', 'price-embedded EAN (cents)');
select is(app_private.vacuum_build_ean('WEIGHT_EMBEDDED', '20', 5, 5, 1, '7', 1805250, 1245), '2000007012455', 'weight-embedded EAN (grams)');
select is(app_private.vacuum_build_ean('PRICE_EMBEDDED', '2', 6, 5, 100, '7', 1805250, 1245), '2000007180536', 'price-embedded EAN in whole pesos rounds half-up (18.052,50 → 18.053)');
select throws_ok($$select app_private.vacuum_build_ean('PRICE_EMBEDDED', '2', 4, 7, 1, '7', 123456789, 1245)$$, '22023', null, 'a value that does not fit the configured digits is rejected, never truncated');
select throws_ok($$select app_private.vacuum_build_ean('PRICE_EMBEDDED', '2', 4, 7, 1, '12345', 1000, 1245)$$, '22023', null, 'a PLU longer than its digits is rejected');
select throws_ok($$select app_private.vacuum_build_ean('PRICE_EMBEDDED', '2', 4, 7, 1, null, 1000, 1245)$$, '22023', null, 'a missing PLU is rejected');
select throws_ok($$select app_private.vacuum_build_ean(null, null, null, null, 1, '7', 1000, 1245)$$, '22023', 'Falta configurar el esquema EAN-13 de envasados', 'an unconfigured scheme is reported, not invented');
select throws_ok($$select app_private.vacuum_build_ean('PRICE_EMBEDDED', '2', 4, 6, 1, '7', 1000, 1245)$$, '22023', null, 'a scheme that does not add up to 12 digits is rejected');

-- ---------------------------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'vac-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Vac Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'vac-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Vac Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'vac-limited-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Vac Limited A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'vac-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Vac Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'Vac Org A', 'vac-org-a'),
  ('d2000000-0000-4000-8000-000000000002', 'Vac Org B', 'vac-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Central A1', 'A1'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'Sucursal A2', 'A2'),
  ('d3000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'Central B1', 'B1');
insert into public.roles (id, organization_id, key, name, is_system) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'envasador', 'Envasador', false);
insert into public.role_permissions (role_id, permission_key) values
  ('d4000000-0000-4000-8000-000000000001', 'vacuum.read'),
  ('d4000000-0000-4000-8000-000000000001', 'vacuum.write');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd4000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003');
insert into public.categories (id, organization_id, name, slug) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Cortes', 'cortes'),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000002', 'Cortes', 'cortes');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('d6000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Vacío', 'vacio', 'VAC', 'WEIGHT'),
  ('d6000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Asado', 'asado', 'ASA', 'WEIGHT'),
  ('d6000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'coca', 'COCA', 'UNIT'),
  ('d6000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Lomo sin precio', 'lomo', 'LOMO', 'WEIGHT'),
  ('d6000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Peceto', 'peceto', 'PEC', 'WEIGHT'),
  ('d6000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Bife angosto', 'bife', 'BIFE', 'WEIGHT'),
  ('d6000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', 'Vacío de B', 'vacio-b', 'VACB', 'WEIGHT');
insert into public.product_barcodes (organization_id, product_id, barcode) values
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', '7790000000017');
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', null, 1450000, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 1500000, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000002', null, 1200000, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000005', null, 1800000, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000006', null, 1234567, now() - interval '1 day'),
  ('d2000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000009', null, 1000000, now() - interval '1 day');

-- Helper de test: cambia el precio global del Vacío después de haber envasado (cierra la vigencia y abre la nueva).
create function public.t_change_vacio_price(p_cents bigint) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.product_prices set valid_to = now() - interval '1 second'
    where product_id = 'd6000000-0000-4000-8000-000000000001' and branch_id is null and valid_to is null;
  insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from)
    values ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', null, p_cents, now() - interval '1 second');
end;
$$;
create function public.t_ean_valid(p text) returns boolean language sql security definer set search_path = '' as $f$ select app_private.ean13_is_valid(p) $f$;
create function public.t_vacuum_update_package() returns void language plpgsql security definer set search_path = '' as $$
begin update public.vacuum_packages set weight_grams = 1 where true; end;
$$;
grant execute on function public.t_change_vacio_price(bigint), public.t_vacuum_update_package(), public.t_ean_valid(text) to authenticated;

select set_config('test.today', ((clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date)::text, true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Configuración: default seguro y esquema EAN
-- ---------------------------------------------------------------------------------------------
select is((public.get_vacuum_settings() -> 'ean' ->> 'configured')::boolean, false, 'a new organization has no EAN scheme configured');
select is(jsonb_array_length(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001')), 0, 'no product is available for packaging by default');
select lives_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000001', true, 7, '7', 'Conservar entre 0 y 4 °C')$$, 'a cut is enabled with shelf life, PLU and conservation text');
select lives_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000002', false, 5, '12')$$, 'a cut can be configured but disabled');
select lives_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000004', true, 5, '9')$$, 'a cut without price can be enabled');
select lives_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000005', true, null, '15')$$, 'a cut without shelf life can be enabled');
select lives_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000006', true, 6, '21')$$, 'a cut priced with odd cents can be enabled');
select throws_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000003', true, 5, '20')$$, '42501', null, 'a per-unit product cannot be packaged');
select throws_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000009', true, 5, '20')$$, '42501', null, 'a product of another organization cannot be configured');
select throws_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000005', true, 5, '0007')$$, '23505', null, 'PLU 0007 collides with PLU 7 (numeric uniqueness)');
select throws_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000005', true, 0, '16')$$, '22023', null, 'a zero shelf life is rejected');
select throws_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000005', true, 5, 'AB')$$, '22023', null, 'a non-numeric PLU is rejected');
select is(public.list_vacuum_config_products_page('vac') ->> 'total', '1', 'the configuration list searches only per-weight products');
select is(public.list_vacuum_config_products_page(null, 'enabled') ->> 'total', '4', 'the configuration list filters enabled products');

select throws_ok(
  $$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 1245, current_setting('test.today')::date)$$,
  '22023', 'Falta configurar el esquema EAN-13 de envasados (Envasados → Configuración)', 'packages cannot be created until the EAN scheme is configured');
select throws_ok($$select public.save_vacuum_ean_scheme('PRICE_EMBEDDED', '2', 4, 6)$$, '22023', null, 'a scheme that does not add up to 12 digits is rejected');
select throws_ok($$select public.save_vacuum_ean_scheme('OTRO', '2', 4, 7)$$, '22023', null, 'an unsupported scheme is rejected');
select lives_ok($$select public.save_vacuum_ean_scheme('PRICE_EMBEDDED', '2', 4, 7, 1)$$, 'the EAN scheme is configured');
select is(public.get_vacuum_settings() -> 'ean', '{"configured":true,"scheme":"PRICE_EMBEDDED","prefix":"2","pluDigits":4,"valueDigits":7,"valueStep":1}'::jsonb, 'the EAN scheme is stored');
select lives_ok($$select public.save_vacuum_settings('Carnicería Fran', 'Av. Siempreviva 742', 'Establecimiento Nº 1', 'Mantener refrigerado', 'Texto extra', null, null, null)$$, 'the establishment texts are configured');

-- ---------------------------------------------------------------------------------------------
-- Búsqueda de cortes
-- ---------------------------------------------------------------------------------------------
select is(jsonb_array_length(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001')), 4, 'only enabled per-weight cuts are offered');
select is(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001', 'vac') -> 0 ->> 'name', 'Vacío', 'search by name ignores accents and case');
select is(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001', 'VAC') -> 0 ->> 'sku', 'VAC', 'search by SKU');
select is(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001', '7790000000017') -> 0 ->> 'name', 'Vacío', 'search by barcode');
select is(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001', '7') -> 0 ->> 'name', 'Vacío', 'search by exact PLU');
select is(jsonb_array_length(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001', 'asado')), 0, 'a disabled cut is not offered');
select is(jsonb_array_length(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001', 'coca')), 0, 'a per-unit product is not offered');
select is(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001', 'vac') -> 0 ->> 'pricePerKgCents', '1450000', 'the price per kg is the current global price');
select is(public.search_vacuum_products('d3000000-0000-4000-8000-000000000002', 'vac') -> 0 ->> 'pricePerKgCents', '1500000', 'the branch price wins over the global price');
select is(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001', 'lomo') -> 0 ->> 'pricePerKgCents', null, 'a cut without price is flagged by a null price');

-- ---------------------------------------------------------------------------------------------
-- Crear paquetes: peso × precio/kg, vencimiento por vida útil, lote, EAN
-- ---------------------------------------------------------------------------------------------
select set_config('test.pkg1', (public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 1245, current_setting('test.today')::date) ->> 'id'), true);
select ok(current_setting('test.pkg1') <> '', 'a package is created');
select is((select total_cents from public.vacuum_packages where id = current_setting('test.pkg1')::uuid), 1805250::bigint, '1,245 kg × $14.500/kg = $18.052,50 (half-up cents, like the POS)');
select is((select price_per_kg_cents from public.vacuum_packages where id = current_setting('test.pkg1')::uuid), 1450000::bigint, 'the price per kg is snapshotted');
select is((select ean13 from public.vacuum_packages where id = current_setting('test.pkg1')::uuid), '2000718052504', 'the EAN-13 follows the configured scheme with a valid check digit');
select ok(public.t_ean_valid((select ean13 from public.vacuum_packages where id = current_setting('test.pkg1')::uuid)), 'the stored EAN-13 validates');
select is((select expires_on - packed_on from public.vacuum_packages where id = current_setting('test.pkg1')::uuid), 7, 'the expiry is elaboration + the configured shelf life');
select is((select lot from public.vacuum_packages where id = current_setting('test.pkg1')::uuid), 'A1-' || to_char(current_setting('test.today')::date, 'YYMMDD') || '-0001', 'the first lot of the day is BRANCH-YYMMDD-0001');
select is((select conservation_text_snapshot from public.vacuum_packages where id = current_setting('test.pkg1')::uuid), 'Conservar entre 0 y 4 °C', 'the product conservation text is snapshotted');
select is((select label_snapshot ->> 'businessName' from public.vacuum_packages where id = current_setting('test.pkg1')::uuid), 'Carnicería Fran', 'the establishment data is snapshotted');
select is((select label_snapshot -> 'ean' ->> 'plu' from public.vacuum_packages where id = current_setting('test.pkg1')::uuid), '7', 'the EAN scheme used is snapshotted');

select is((public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000006', 1001, current_setting('test.today')::date) ->> 'totalCents'), '1235802', '1,001 kg × $12.345,67/kg = $12.358,01567 rounds half-up to 1.235.802 cents');
select set_config('test.pkg2', (public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 800, current_setting('test.today')::date) ->> 'id'), true);
select is((select lot from public.vacuum_packages where id = current_setting('test.pkg2')::uuid), 'A1-' || to_char(current_setting('test.today')::date, 'YYMMDD') || '-0003', 'the next lot increments the sequence (unique and readable; the Bife package took 0002)');
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 500, %L, null, %L)$f$, current_setting('test.today'), (select lot from public.vacuum_packages where id = current_setting('test.pkg1')::uuid)), '23505', null, 'a manual lot that already exists is rejected');
select lives_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 500, %L, null, 'lote especial 7')$f$, current_setting('test.today')), 'a manual lot is accepted');
select is((select lot from public.vacuum_packages where weight_grams = 500), 'LOTEESPECIAL7', 'a manual lot is normalized');
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 500, %L, null, 'a!')$f$, current_setting('test.today')), '22023', null, 'an invalid manual lot is rejected');

-- Idempotencia (doble clic / reintento de red).
select set_config('test.key', gen_random_uuid()::text, true);
select set_config('test.pkg3', (public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 650, current_setting('test.today')::date, null, null, current_setting('test.key')::uuid) ->> 'id'), true);
select is((public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 650, current_setting('test.today')::date, null, null, current_setting('test.key')::uuid) ->> 'id'), current_setting('test.pkg3'), 'the same request key returns the same package');
select is((select count(*) from public.vacuum_packages where weight_grams = 650), 1::bigint, 'the repeated request did not create another package');

-- Validaciones.
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 0, %L)$f$, current_setting('test.today')), '22023', null, 'a zero weight is rejected');
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000002', 500, %L)$f$, current_setting('test.today')), '22023', null, 'a disabled cut cannot be packaged');
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000003', 500, %L)$f$, current_setting('test.today')), '42501', null, 'a per-unit product cannot be packaged');
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000004', 500, %L)$f$, current_setting('test.today')), '22023', null, 'a cut without a current price cannot be packaged');
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 500, date %L)$f$, '2099-01-01'), '22023', null, 'an absurd elaboration date is rejected');
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 500, %L, %L)$f$, current_setting('test.today'), (current_setting('test.today')::date - 1)::text), '22023', null, 'an expiry before the elaboration is rejected');
select is(public.get_vacuum_settings() ->> 'defaultShelfLifeDays', '14', 'without a custom shelf life the cut uses the general default (202611120099)');
select lives_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000005', 500, %L, %L)$f$, current_setting('test.today'), (current_setting('test.today')::date + 12)::text), 'a manual expiry is accepted when no shelf life is configured');
select lives_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 400, %L, %L)$f$, current_setting('test.today'), (current_setting('test.today')::date + 3)::text), 'an admin with the permission can correct the expiry');
select is((select expires_on - packed_on from public.vacuum_packages where weight_grams = 400), 3, 'the corrected expiry is stored');

-- ---------------------------------------------------------------------------------------------
-- Snapshot histórico y reimpresión
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.t_change_vacio_price(1600000)$$, 'the price of the cut changes after packaging');
select lives_ok($$select public.save_vacuum_ean_scheme('WEIGHT_EMBEDDED', '20', 5, 5, 1)$$, 'the EAN scheme changes after packaging');
select lives_ok($$select public.save_vacuum_settings('Otro Nombre', null, null, null, null, 60, 40, 50)$$, 'the establishment data and label size change after packaging');
select is(public.get_vacuum_package(current_setting('test.pkg1')::uuid) ->> 'pricePerKgCents', '1450000', 'the reprint data keeps the historical price per kg');
select is(public.get_vacuum_package(current_setting('test.pkg1')::uuid) ->> 'totalCents', '1805250', 'the reprint data keeps the historical total');
select is(public.get_vacuum_package(current_setting('test.pkg1')::uuid) ->> 'ean13', '2000718052504', 'the reprint data keeps the historical EAN-13');
select is(public.get_vacuum_package(current_setting('test.pkg1')::uuid) -> 'label' ->> 'businessName', 'Carnicería Fran', 'the reprint data keeps the historical establishment data');
select is(public.get_vacuum_package(current_setting('test.pkg1')::uuid) -> 'label' -> 'ean' ->> 'scheme', 'PRICE_EMBEDDED', 'the reprint data keeps the EAN scheme used');
select isnt(public.search_vacuum_products('d3000000-0000-4000-8000-000000000001', 'vac') -> 0 ->> 'pricePerKgCents', '1450000', 'the current price differs from the historical one');
select set_config('test.pkg4', (public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 1000, current_setting('test.today')::date) ->> 'id'), true);
select is((select total_cents from public.vacuum_packages where id = current_setting('test.pkg4')::uuid), 1600000::bigint, 'a new package uses the new price');
select is((select ean13 from public.vacuum_packages where id = current_setting('test.pkg4')::uuid), '2000007010000', 'a new package uses the new weight-embedded scheme (1000 g, PLU 7)');
select throws_ok($$select public.t_vacuum_update_package()$$, '22023', null, 'a package record cannot be modified');

select is((public.record_vacuum_print(current_setting('test.pkg1')::uuid, 'BOTH') ->> 'printCount')::int, 1, 'the first print is recorded');
select is((public.record_vacuum_print(current_setting('test.pkg1')::uuid, 'INFO') ->> 'printCount')::int, 2, 'a reprint of one label is recorded');
select is((select count(*) from public.vacuum_package_prints where package_id = current_setting('test.pkg1')::uuid and reprint), 1::bigint, 'only the second print is flagged as a reprint');
select throws_ok(format($f$select public.record_vacuum_print(%L, 'XXX')$f$, current_setting('test.pkg1')), '22023', null, 'an unknown label kind is rejected');

-- ---------------------------------------------------------------------------------------------
-- Historial: búsqueda y filtros
-- ---------------------------------------------------------------------------------------------
select is((public.list_vacuum_packages_page() ->> 'total')::int, 8, 'the history lists every package');
select is((public.list_vacuum_packages_page(null, null, null, 'd6000000-0000-4000-8000-000000000005') ->> 'total')::int, 1, 'the history filters by product');
select is((public.list_vacuum_packages_page(null, null, null, null, 'LOTEESPECIAL7') ->> 'total')::int, 1, 'the history searches by lot');
select is((public.list_vacuum_packages_page(null, null, null, null, '2000718052504') ->> 'total')::int, 1, 'the history searches by EAN-13');
select is((public.list_vacuum_packages_page(null, null, null, null, 'peceto') ->> 'total')::int, 1, 'the history searches by product name');
select is((public.list_vacuum_packages_page(null, current_setting('test.today')::date + 1) ->> 'total')::int, 0, 'the history filters by date');
select is((public.list_vacuum_packages_page(null, null, null, null, null, 3, 0) -> 'rows' -> 0 ->> 'printCount')::int, 0, 'the newest package has no prints yet');
select is(jsonb_array_length(public.list_vacuum_packages_page(null, null, null, null, null, 3, 0) -> 'rows'), 3, 'the history is paginated on the server');

-- ---------------------------------------------------------------------------------------------
-- Permisos finos y aislamiento por sucursal
-- ---------------------------------------------------------------------------------------------
select set_config('test.pkg_a2', (public.create_vacuum_package('d3000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000001', 1000, current_setting('test.today')::date) ->> 'id'), true);
select is((select price_per_kg_cents from public.vacuum_packages where id = current_setting('test.pkg_a2')::uuid), 1500000::bigint, 'a package in A2 uses the A2 branch price');
select is((select lot from public.vacuum_packages where id = current_setting('test.pkg_a2')::uuid), 'A2-' || to_char(current_setting('test.today')::date, 'YYMMDD') || '-0001', 'the lot sequence is per branch and day');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.vacuum_packages), 8::bigint, 'a branch-limited user sees only A1 packages (table RLS, 8 of 9)');
select is((public.list_vacuum_packages_page() ->> 'total')::int, 8, 'the history hides other branches');
select is(public.get_vacuum_package(current_setting('test.pkg_a2')::uuid), null, 'the other-branch package is not returned');
select throws_ok(format($f$select public.record_vacuum_print(%L, 'BOTH')$f$, current_setting('test.pkg_a2')), '42501', null, 'a limited user cannot reprint a package of another branch');
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000001', 500, %L)$f$, current_setting('test.today')), '42501', null, 'a limited user cannot package in another branch');
select throws_ok(format($f$select public.search_vacuum_products('d3000000-0000-4000-8000-000000000002', 'vac')$f$), '42501', null, 'a limited user cannot search with another branch price list');
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 500, %L, %L)$f$, current_setting('test.today'), (current_setting('test.today')::date + 1)::text), '42501', null, 'without vacuum.override_expiry the expiry cannot differ from the shelf life');
select lives_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 500, %L, %L)$f$, current_setting('test.today'), (current_setting('test.today')::date + 7)::text), 'the same expiry as the shelf life is allowed without the override permission');
select throws_ok($$select public.save_vacuum_ean_scheme(null)$$, '42501', null, 'without vacuum.configure the scheme cannot be changed');
select throws_ok($$select public.save_vacuum_settings('X')$$, '42501', null, 'without vacuum.configure the settings cannot be changed');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.get_vacuum_settings()$$, '42501', null, 'an employee cannot read the vacuum module');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento por organización
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000009', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select is((select count(*) from public.vacuum_packages), 0::bigint, 'org B sees no package of org A');
select is((public.list_vacuum_packages_page() ->> 'total')::int, 0, 'org B history is empty');
select is(public.get_vacuum_package(current_setting('test.pkg1')::uuid), null, 'org B cannot read a package of org A');
select is((public.get_vacuum_settings() -> 'ean' ->> 'configured')::boolean, false, 'org B has its own (empty) EAN configuration');
select throws_ok(format($f$select public.record_vacuum_print(%L, 'BOTH')$f$, current_setting('test.pkg1')), '42501', null, 'org B cannot reprint a package of org A');
select throws_ok(format($f$select public.create_vacuum_package('d3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 500, %L)$f$, current_setting('test.today')), '42501', null, 'org B cannot package in a branch of org A');
select throws_ok($$select public.save_vacuum_product_config('d6000000-0000-4000-8000-000000000001', true, 5, '30')$$, '42501', null, 'org B cannot configure a product of org A');
select is(jsonb_array_length(public.search_vacuum_products('d3000000-0000-4000-8000-000000000009')), 0, 'org B has no cut enabled for packaging');

select * from finish();
rollback;
