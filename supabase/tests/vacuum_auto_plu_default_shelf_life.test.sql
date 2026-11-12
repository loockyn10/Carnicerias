begin;

create extension if not exists pgtap with schema extensions;
select plan(63);

-- Cubre 202611120099: PLU automático (único, sin reutilizar, conservado al deshabilitar/rehabilitar, agotamiento), vencimiento general de la
-- organización con excepciones por corte, snapshots históricos intactos y el estado de un código de Envasados para el POS.
-- Fixture: organización A (dos sucursales, esquema 20 + PLU 4 + valor 6 ÷ 100) y organización B (PLU de 1 dígito, para agotar el espacio).

select ok(not has_function_privilege('authenticated', 'app_private.vacuum_next_plu(uuid,uuid)', 'EXECUTE'), 'the PLU allocator is private');
select ok(not has_function_privilege('anon', 'public.set_vacuum_product_enabled(uuid,boolean)', 'EXECUTE'), 'anonymous cannot enable cuts');
select ok(not has_function_privilege('anon', 'public.get_pos_vacuum_code_status(uuid,text)', 'EXECUTE'), 'anonymous cannot read a code status');
select ok(not has_function_privilege('anon', 'public.save_vacuum_default_shelf_life(integer)', 'EXECUTE'), 'anonymous cannot change the default shelf life');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'plu-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PLU Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'plu-other@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PLU Other"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'PLU Org', 'plu-org'),
  ('c2000000-0000-4000-8000-000000000002', 'PLU Org B', 'plu-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Central', 'CEN'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Avenida', 'AVE'),
  ('c3000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'Central B', 'CEB');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Cerdo', 'cerdo'),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'Cerdo B', 'cerdo-b');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('c6000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Vacío de cerdo', 'vacio-cerdo', 'VCE', 'WEIGHT'),
  ('c6000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Carne picada', 'carne-picada', 'PIC', 'WEIGHT'),
  ('c6000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Bondiola', 'bondiola', 'BON', 'WEIGHT'),
  ('c6000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Churrasco', 'churrasco', 'CHU', 'WEIGHT'),
  ('c6000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Matambre', 'matambre', 'MAT', 'WEIGHT'),
  ('c6000000-0000-4000-8000-000000000006', 'c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Pechito', 'pechito', 'PEC', 'WEIGHT'),
  ('c6000000-0000-4000-8000-000000000007', 'c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Gaseosa', 'gaseosa', 'GAS', 'UNIT');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type)
select ('c6b00000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'c2000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002',
  'Corte B ' || g, 'corte-b-' || g, 'CB' || g, 'WEIGHT'
from generate_series(1, 10) g;
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id;
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from)
select p.organization_id, p.id, null, 1500000, now() - interval '1 day' from public.products p where p.organization_id = 'c2000000-0000-4000-8000-000000000001';

create function public.t_plu_pkg(p_id uuid) returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('ean13', p.ean13, 'expiresOn', p.expires_on, 'packedOn', p.packed_on, 'shelf', p.shelf_life_days_snapshot,
    'plu', p.label_snapshot -> 'ean' ->> 'plu') from public.vacuum_packages p where p.id = p_id $$;
create function public.t_plu_of(p_product uuid) returns text language sql security definer set search_path = '' as $$
  select s.plu from public.product_vacuum_settings s where s.product_id = p_product $$;
grant execute on function public.t_plu_pkg(uuid), public.t_plu_of(uuid) to authenticated;

select set_config('test.today', ((clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date)::text, true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Vencimiento general
-- ---------------------------------------------------------------------------------------------
select is((public.get_vacuum_settings() ->> 'defaultShelfLifeDays')::integer, 14, 'an organization without settings starts with 14 days');
select lives_ok($$select public.save_vacuum_ean_scheme('PRICE_EMBEDDED', '20', 4, 6, 100)$$, 'the EAN scheme is configured');
select is((public.get_vacuum_settings() ->> 'defaultShelfLifeDays')::integer, 14, 'configuring the scheme keeps the default of 14');
select throws_ok($$select public.save_vacuum_default_shelf_life(0)$$, '22023', null, 'zero days is refused');
select throws_ok($$select public.save_vacuum_default_shelf_life(null)$$, '22023', null, 'a missing value is refused');

-- ---------------------------------------------------------------------------------------------
-- PLU automático
-- ---------------------------------------------------------------------------------------------
select is(public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000001', true) ->> 'plu', '1', 'the first enabled cut gets PLU 1');
select is(public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000002', true) ->> 'plu', '2', 'the second gets PLU 2');
select is(public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000001', true) ->> 'plu', '1', 'enabling again is idempotent');
select is((public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000001', true) ->> 'shelfLifeDays')::integer, 14, 'an enabled cut uses the general shelf life');
select is(public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000001', true) -> 'customShelfLifeDays', 'null'::jsonb, 'and has no custom value');

select is((public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000001', false) ->> 'enabled')::boolean, false, 'disabling is one call');
select is(public.t_plu_of('c6000000-0000-4000-8000-000000000001'), '1', 'a disabled cut keeps its PLU');
select is(public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000003', true) ->> 'plu', '3', 'the PLU of a disabled cut is never reused');
select is(public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000001', true) ->> 'plu', '1', 're-enabling keeps the original PLU');

-- PLU cargados a mano antes de esta migración se conservan y el siguiente automático sigue después del mayor.
select lives_ok($$select public.save_vacuum_product_config('c6000000-0000-4000-8000-000000000004', true, null, '0012', null)$$, 'a legacy manual PLU 0012');
select is(public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000004', true) ->> 'plu', '0012', 'an existing PLU is preserved as stored');
select is(public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000005', true) ->> 'plu', '13', 'the next automatic PLU follows the highest one');

-- Un corte habilitado sin PLU (configuración anterior) se regulariza al habilitarlo de nuevo.
select lives_ok($$select public.save_vacuum_product_config('c6000000-0000-4000-8000-000000000006', true, null, null, null)$$, 'a legacy enabled cut without PLU');
select is(public.t_plu_of('c6000000-0000-4000-8000-000000000006'), null, 'it has no PLU yet');
select is(public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000006', true) ->> 'plu', '14', 'enabling it assigns the next PLU');

select throws_ok($$select public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000007', true)$$, '42501', null, 'a per-unit product cannot be enabled');
select throws_ok($$select public.set_vacuum_product_enabled('c6b00000-0000-4000-8000-000000000001', true)$$, '42501', null, 'a product of another organization is refused');
select is((select count(distinct (plu)::bigint) from public.product_vacuum_settings where organization_id = 'c2000000-0000-4000-8000-000000000001'),
  (select count(*) from public.product_vacuum_settings where organization_id = 'c2000000-0000-4000-8000-000000000001'), 'every PLU of the organization is unique');

-- ---------------------------------------------------------------------------------------------
-- Vencimiento general, excepción por corte y snapshots
-- ---------------------------------------------------------------------------------------------
select set_config('plu.p1', (public.create_vacuum_package('c3000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001', 750, current_setting('test.today')::date, null, null, 'c8000000-0000-4000-8000-000000000001') ->> 'id'), true);
select is((public.t_plu_pkg(current_setting('plu.p1')::uuid) ->> 'expiresOn')::date, current_setting('test.today')::date + 14, 'a package of a cut without custom value expires in 14 days');
select is((public.t_plu_pkg(current_setting('plu.p1')::uuid) ->> 'shelf')::integer, 14, 'and snapshots the effective shelf life');
select is(public.t_plu_pkg(current_setting('plu.p1')::uuid) ->> 'ean13', '2000010112500', 'its EAN-13 carries the automatic PLU 0001 and $11.250');

select is((public.save_vacuum_product_overrides('c6000000-0000-4000-8000-000000000002', 2, null) ->> 'shelfLifeDays')::integer, 2, 'Carne picada gets a custom 2 days');
select is(public.t_plu_of('c6000000-0000-4000-8000-000000000002'), '2', 'saving the exception does not touch the PLU');
select is((public.list_vacuum_config_products_page('picada') -> 'rows' -> 0 ->> 'enabled')::boolean, true, 'nor whether the cut is enabled');
select is(public.save_vacuum_default_shelf_life(12), 12, 'the general shelf life changes to 12');
select is((public.list_vacuum_config_products_page() ->> 'defaultShelfLifeDays')::integer, 12, 'the configuration page reports the new default');
select is((public.list_vacuum_config_products_page('vacío') -> 'rows' -> 0 ->> 'shelfLifeDays')::integer, 12, 'a cut on the general value follows it');
select is((public.list_vacuum_config_products_page('picada') -> 'rows' -> 0 ->> 'shelfLifeDays')::integer, 2, 'a custom value wins over the general one');
select is((public.list_vacuum_config_products_page('picada') -> 'rows' -> 0 ->> 'customShelfLifeDays')::integer, 2, 'and is reported as custom');
select is((public.search_vacuum_products('c3000000-0000-4000-8000-000000000001', 'bondiola') -> 0 ->> 'shelfLifeDays')::integer, 12, 'the packing screen gets the effective value');
select is((public.list_vacuum_station_products('c3000000-0000-4000-8000-000000000001') -> 0 ->> 'shelfLifeDays')::integer, 12, 'and so does the station');

select is((public.t_plu_pkg(current_setting('plu.p1')::uuid) ->> 'expiresOn')::date, current_setting('test.today')::date + 14, 'the package registered before the change keeps its expiry');
select is((public.t_plu_pkg(current_setting('plu.p1')::uuid) ->> 'shelf')::integer, 14, 'and its snapshot');
select set_config('plu.p2', (public.create_vacuum_package('c3000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001', 750, current_setting('test.today')::date, null, null, 'c8000000-0000-4000-8000-000000000002') ->> 'id'), true);
select is((public.t_plu_pkg(current_setting('plu.p2')::uuid) ->> 'expiresOn')::date, current_setting('test.today')::date + 12, 'a new package uses the new general value');
select set_config('plu.p3', (public.create_vacuum_package('c3000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000002', 500, current_setting('test.today')::date, null, null, 'c8000000-0000-4000-8000-000000000003') ->> 'id'), true);
select is((public.t_plu_pkg(current_setting('plu.p3')::uuid) ->> 'expiresOn')::date, current_setting('test.today')::date + 2, 'a package of the custom cut uses its 2 days');
select is((public.save_vacuum_product_overrides('c6000000-0000-4000-8000-000000000002', null, null) ->> 'shelfLifeDays')::integer, 12, 'restoring the general value is saving no custom days');
select is((public.t_plu_pkg(current_setting('plu.p3')::uuid) ->> 'expiresOn')::date, current_setting('test.today')::date + 2, 'which never rewrites a registered package');
select throws_ok($$select public.save_vacuum_product_overrides('c6000000-0000-4000-8000-000000000002', 0, null)$$, '22023', null, 'a custom value of zero days is refused');

-- Un corte deshabilitado no se puede envasar, y al rehabilitarlo conserva PLU: el EAN de un paquete nuevo usa el mismo identificador.
select public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000001', false) is not null;
select throws_ok($$select public.create_vacuum_package('c3000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001', 750, current_setting('test.today')::date)$$, '22023', null, 'a disabled cut cannot be packed');
select public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000001', true) is not null;
select set_config('plu.p4', (public.create_vacuum_package('c3000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001', 750, current_setting('test.today')::date, null, null, 'c8000000-0000-4000-8000-000000000004') ->> 'id'), true);
select is(public.t_plu_pkg(current_setting('plu.p4')::uuid) ->> 'ean13', '2000010112500', 'after disabling and re-enabling the EAN keeps the same PLU');
select is(public.t_plu_pkg(current_setting('plu.p1')::uuid) ->> 'ean13', '2000010112500', 'and the EAN of the first package never changed');

-- El PLU de las etiquetas ya impresas de un corte vuelve a ese corte si su configuración lo perdió.
select lives_ok($$select public.save_vacuum_product_config('c6000000-0000-4000-8000-000000000001', false, null, null, null)$$, 'a legacy save wipes the PLU of the Vacío');
select is(public.set_vacuum_product_enabled('c6000000-0000-4000-8000-000000000001', true) ->> 'plu', '1', 'enabling recovers the PLU printed on its packages');

-- ---------------------------------------------------------------------------------------------
-- Estado de un código para el POS
-- ---------------------------------------------------------------------------------------------
select is(public.get_pos_vacuum_code_status('c3000000-0000-4000-8000-000000000001', '2000010112500') ->> 'status', 'AVAILABLE', 'a registered package is AVAILABLE');
select is((public.get_pos_vacuum_code_status('c3000000-0000-4000-8000-000000000001', '2000010112500') ->> 'here')::boolean, true, 'in the branch that packed it');
select is((public.get_pos_vacuum_code_status('c3000000-0000-4000-8000-000000000002', '2000010112500') ->> 'here')::boolean, false, 'and not in another branch');
select is(public.get_pos_vacuum_code_status('c3000000-0000-4000-8000-000000000002', '2000010112500') ->> 'branchName', 'Central', 'which is told where it is');
select is(public.get_pos_vacuum_code_status('c3000000-0000-4000-8000-000000000001', '2000990112505') ->> 'status', 'UNKNOWN', 'a code nobody registered is UNKNOWN');
select throws_ok($$select public.get_pos_vacuum_code_status('c3000000-0000-4000-8000-000000000009', '2000010112500')$$, '42501', null, 'a branch of another organization is refused');

-- ---------------------------------------------------------------------------------------------
-- Agotamiento del espacio de PLU (organización B: PLU de 1 dígito → 1 a 9)
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.save_vacuum_ean_scheme('PRICE_EMBEDDED', '20000', 1, 6, 100)$$, 'organization B uses a one-digit PLU');
select lives_ok($$select public.save_vacuum_product_config('c6b00000-0000-4000-8000-000000000001', true, null, '9', null)$$, 'a manual PLU at the top of the range');
select is(public.set_vacuum_product_enabled('c6b00000-0000-4000-8000-000000000002', true) ->> 'plu', '1', 'past the top, the first never-used PLU is assigned');
select is((select string_agg(public.set_vacuum_product_enabled(('c6b00000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, true) ->> 'plu', ',' order by g) from generate_series(3, 9) g),
  '2,3,4,5,6,7,8', 'the remaining gaps are filled in order');
select throws_ok($$select public.set_vacuum_product_enabled('c6b00000-0000-4000-8000-000000000010', true)$$, '54000', null, 'an exhausted PLU space is reported, never duplicated');

select * from finish();
rollback;
