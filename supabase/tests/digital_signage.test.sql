begin;

create extension if not exists pgtap with schema extensions;
select plan(117);

-- Covers 202610070069 (D-072) y 202610100073 (D-076: foto + logo para la TV): cartelería digital. Una pantalla = un token (sólo hash) + una lista ordenada de productos. La ÚNICA superficie
-- anónima es get_signage_display(token). Los slides no guardan precios: apuntan al producto y el precio se resuelve en cada lectura con el
-- mismo orden que el POS (precio de la sucursal vigente > global vigente). La matemática de «llevando 3u» NO vive acá (la hace el motor TS).

-- ---------------------------------------------------------------------------------------------
-- Fixture (ids propios: prefijo b)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'sg-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"SG Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'sg-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"SG Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'sg-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"SG Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('b2000000-0000-4000-8000-000000000001', 'SG Org', 'sg-org'),
  ('b2000000-0000-4000-8000-000000000002', 'SG Org B', 'sg-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'SG Central', 'SG-C'),
  ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'SG Avenida', 'SG-A'),
  ('b3000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000002', 'SG B Branch', 'SG-B');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002');

insert into public.categories (id, organization_id, name, slug, active) values
  ('b4000000-0000-4000-8000-00000000000a', 'b2000000-0000-4000-8000-000000000001', 'Almacen', 'sg-almacen', true),
  ('b4000000-0000-4000-8000-00000000000b', 'b2000000-0000-4000-8000-000000000001', 'Vaca', 'sg-vaca', true),
  ('b4000000-0000-4000-8000-00000000000c', 'b2000000-0000-4000-8000-000000000001', 'Apagada', 'sg-apagada', false),
  ('b4000000-0000-4000-8000-00000000000e', 'b2000000-0000-4000-8000-000000000002', 'Almacen B', 'sgb-almacen', true);
-- 01 Mayonesa (UNIT, global $2.035 / Avenida $2.200), 02 Aceite (UNIT, $2.450, NO está en el surtido de Avenida), 03 Molida (WEIGHT, $11.000/kg),
-- 04 Inactivo, 05 Sin precio (precio 0), 06 Categoría apagada, 07 Materia prima, 08 Org B, 09 Sin precio vigente (sólo uno vencido).
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000a', 'Mayonesa Hellmanns 250gr', 'sg-mayo', 'SG-01', 'UNIT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000a', 'Aceite Canuelas 900ml', 'sg-aceite', 'SG-02', 'UNIT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000b', 'Molida vacuna', 'sg-molida', 'SG-03', 'WEIGHT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000a', 'Producto inactivo', 'sg-inactivo', 'SG-04', 'UNIT', false, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000005', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000a', 'Producto sin precio', 'sg-sin-precio', 'SG-05', 'UNIT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000006', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000c', 'Producto de categoria apagada', 'sg-cat-apagada', 'SG-06', 'UNIT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000007', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000b', 'Media res', 'sg-media-res', 'SG-07', 'WEIGHT', true, 'RAW_MATERIAL'),
  ('b5000000-0000-4000-8000-000000000008', 'b2000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-00000000000e', 'Producto de otra org', 'sgb-otra', 'SGB-08', 'UNIT', true, 'SELLABLE'),
  ('b5000000-0000-4000-8000-000000000009', 'b2000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-00000000000a', 'Precio vencido', 'sg-vencido', 'SG-09', 'UNIT', true, 'SELLABLE');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where not (b.id = 'b3000000-0000-4000-8000-000000000002' and p.id = 'b5000000-0000-4000-8000-000000000002');

insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from, valid_to) values
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', null, 203500, now() - interval '2 day', null),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000002', 220000, now() - interval '2 day', null),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002', null, 245000, now() - interval '2 day', null),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000003', null, 1100000, now() - interval '2 day', null),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000004', null, 100000, now() - interval '2 day', null),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000005', null, 0, now() - interval '2 day', null),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000006', null, 100000, now() - interval '2 day', null),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000007', null, 100000, now() - interval '2 day', null),
  ('b2000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000008', null, 500000, now() - interval '2 day', null),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000009', null, 100000, now() - interval '3 day', now() - interval '1 day');
-- Costos y margen: la cartelería NO debe exponerlos jamás (están cargados a propósito).
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from) values
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 123456, now() - interval '2 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000003', 765432, now() - interval '2 day');
-- «Llevando 3u»: Central 15 % (desde 3); Avenida sin regla; la configuración global de la org (20 %) sólo vale para pantallas sin sucursal.
insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps)
values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 3, 1500);
insert into public.organization_pricing_settings (organization_id, margin_bps, unit_bulk_discount_bps)
values ('b2000000-0000-4000-8000-000000000001', 3333, 2000);
-- Molida: 10 % desde 2 kg (global) y precio fijo $9.500/kg desde 5 kg sólo en Central; uno vencido que no debe aparecer.
insert into public.product_weight_discounts (organization_id, product_id, branch_id, minimum_grams, discount_type, discount_value) values
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000003', null, 2000, 'PERCENTAGE', 1000),
  ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-000000000001', 5000, 'FIXED_PRICE_PER_KG', 950000);
insert into public.product_weight_discounts (organization_id, product_id, branch_id, minimum_grams, discount_type, discount_value, valid_from, valid_until)
values ('b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000003', null, 9000, 'PERCENTAGE', 5000, now() - interval '3 day', now() - interval '1 day');

-- Identidad de la TV (D-076): foto de Mayonesa, una foto que NO está en ninguna pantalla (producto de otra org) y el logo de SG Org.
insert into public.product_artwork_photos (product_id, organization_id, storage_path, content_type, size_bytes) values
  ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001/b5000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png', 'image/png', 1200),
  ('b5000000-0000-4000-8000-000000000008', 'b2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002/b5000000-0000-4000-8000-000000000008/c1000000-0000-4000-8000-000000000008.jpg', 'image/jpeg', 900);
insert into public.organization_artwork_logos (organization_id, storage_path, content_type, size_bytes, width_px, height_px)
values ('b2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001/branding/c2000000-0000-4000-8000-000000000001.png', 'image/png', 800, 600, 200);

create table public.t_sg_keep(name text primary key, id uuid, token text);
grant all on public.t_sg_keep to authenticated, anon;
create function public.t_sg_tok(p_name text) returns text language sql security definer as $$ select token from public.t_sg_keep where name = p_name $$;
create function public.t_sg_id(p_name text) returns uuid language sql security definer as $$ select id from public.t_sg_keep where name = p_name $$;
grant execute on function public.t_sg_tok(text), public.t_sg_id(text) to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'digital_signage_displays', 'the displays table exists');
select has_table('public', 'digital_signage_slides', 'the slides table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.digital_signage_displays'::regclass), 'displays have RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.digital_signage_slides'::regclass), 'slides have RLS');
select ok(not has_table_privilege('anon', 'public.digital_signage_displays', 'SELECT'), 'anonymous cannot read displays');
select ok(not has_table_privilege('anon', 'public.digital_signage_slides', 'SELECT'), 'anonymous cannot read slides');
select ok(not has_table_privilege('authenticated', 'public.digital_signage_displays', 'INSERT'), 'browser clients cannot insert displays');
select ok(not has_table_privilege('authenticated', 'public.digital_signage_displays', 'UPDATE'), 'nor update displays');
select ok(not has_table_privilege('authenticated', 'public.digital_signage_displays', 'DELETE'), 'nor delete displays');
select ok(not has_table_privilege('authenticated', 'public.digital_signage_slides', 'INSERT'), 'browser clients cannot insert slides');
select ok(not has_table_privilege('authenticated', 'public.digital_signage_slides', 'DELETE'), 'nor delete slides');
select ok(not has_column_privilege('authenticated', 'public.digital_signage_displays', 'token_hash', 'SELECT'), 'not even an admin session can read the token hash');
select ok(has_column_privilege('authenticated', 'public.digital_signage_displays', 'name', 'SELECT'), 'but can read the display configuration');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'digital_signage_slides' and column_name ~ 'price|cost|margin'),
  'slides store NO price, cost or margin: they point to the product (no snapshots)');
select ok(has_function_privilege('anon', 'public.get_signage_display(text)', 'EXECUTE'), 'anonymous CAN call the TV read');
select ok(not has_function_privilege('anon', 'public.create_signage_display(text,uuid)', 'EXECUTE'), 'anonymous cannot create a display');
select ok(not has_function_privilege('anon', 'public.save_signage_display(uuid,text,uuid,integer,boolean,uuid[])', 'EXECUTE'), 'anonymous cannot save a display');
select ok(not has_function_privilege('anon', 'public.regenerate_signage_token(uuid)', 'EXECUTE'), 'anonymous cannot regenerate a token');
select ok(not has_function_privilege('anon', 'public.get_signage_display_admin(uuid)', 'EXECUTE'), 'anonymous cannot read the admin view');
select ok(not has_function_privilege('anon', 'app_private.signage_payload(uuid,boolean)', 'EXECUTE'), 'the payload helper is not callable by anonymous');
select ok(not has_function_privilege('authenticated', 'app_private.signage_payload(uuid,boolean)', 'EXECUTE'), 'nor by authenticated sessions');
select ok(has_function_privilege('anon', 'public.signage_object_is_published(text)', 'EXECUTE'), 'anonymous can ask whether a Storage object is published on a TV (policy helper)');
select ok(not has_function_privilege('authenticated', 'public.signage_object_is_published(text)', 'EXECUTE'), 'authenticated sessions use their own organization policies, not this one');
select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'signage_published_objects_select' and roles = '{anon}' and cmd = 'SELECT'),
  'the anonymous Storage policy is SELECT-only and anon-only');

-- ---------------------------------------------------------------------------------------------
-- Permisos de escritura
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.create_signage_display('Empleado', null)$$, '42501', null, 'an employee (no catalog.write) cannot create a display');

select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.create_signage_display('   ', null)$$, '22023', null, 'a blank name is rejected');
select throws_ok($$select public.create_signage_display(repeat('x', 81), null)$$, '22023', null, 'a name longer than 80 characters is rejected');
select throws_ok($$select public.create_signage_display('Otra org', 'b3000000-0000-4000-8000-000000000003')$$, '42501', 'Branch not found', 'a branch of ANOTHER organization is rejected');

-- ---------------------------------------------------------------------------------------------
-- Alta: token sólo en hash
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into public.t_sg_keep(name, token) select 'central', public.create_signage_display('TV Central', 'b3000000-0000-4000-8000-000000000001') ->> 'token'$$, 'an admin creates the Central display');
select lives_ok($$insert into public.t_sg_keep(name, token) select 'avenida', public.create_signage_display('TV Avenida', 'b3000000-0000-4000-8000-000000000002') ->> 'token'$$, 'and a second one for Avenida (several displays are modelled)');
select lives_ok($$insert into public.t_sg_keep(name, token) select 'global', public.create_signage_display('TV Global', null) ->> 'token'$$, 'and a display with no branch (global price)');
select ok(public.t_sg_tok('central') ~ '^[0-9a-f]{64}$', 'the token is 256 random bits in hex (64 characters)');
select isnt(public.t_sg_tok('central'), public.t_sg_tok('avenida'), 'tokens are different per display');
reset role;
select is((select count(*) from public.digital_signage_displays where token_hash = public.t_sg_tok('central')), 0::bigint, 'the clear token is NOT stored');
select is((select token_hash from public.digital_signage_displays where name = 'TV Central'), encode(extensions.digest(convert_to(public.t_sg_tok('central'), 'UTF8'), 'sha256'), 'hex'), 'only its SHA-256 hash is stored');
select is((select count(*) from public.audit_logs where entity_type = 'digital_signage_displays' and (coalesce(before_data::text, '') || coalesce(after_data::text, '')) ~ '[0-9a-f]{64}'), 0::bigint, 'the audit log never contains the token or its hash');
select is((select count(*) from public.audit_logs where entity_type = 'digital_signage_displays' and event_type = 'DIGITAL_SIGNAGE_DISPLAYS_INSERT'), 3::bigint, 'creating displays is audited');
update public.t_sg_keep k set id = d.id from public.digital_signage_displays d where d.name = 'TV ' || initcap(k.name);

-- ---------------------------------------------------------------------------------------------
-- Guardar / publicar: validaciones
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.save_signage_display(public.t_sg_id('central'), 'TV Central', 'b3000000-0000-4000-8000-000000000001', 2, true, array[]::uuid[])$$, '22023', null, 'a duration under 3 seconds is rejected');
select throws_ok($$select public.save_signage_display(public.t_sg_id('central'), 'TV Central', 'b3000000-0000-4000-8000-000000000001', 61, true, array[]::uuid[])$$, '22023', null, 'a duration over 60 seconds is rejected');
select throws_ok($$select public.save_signage_display(public.t_sg_id('central'), 'TV Central', 'b3000000-0000-4000-8000-000000000001', 8, true,
  array['b5000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001']::uuid[])$$, '22023', null, 'the same product twice is rejected');
select throws_ok($$select public.save_signage_display(public.t_sg_id('central'), 'TV Central', 'b3000000-0000-4000-8000-000000000001', 8, true,
  array['b5000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000008']::uuid[])$$, '42501', 'Product was not found in this organization', 'a product of ANOTHER organization cannot be published');
select throws_ok($$select public.save_signage_display(public.t_sg_id('central'), 'TV Central', 'b3000000-0000-4000-8000-000000000003', 8, true, array[]::uuid[])$$, '42501', 'Branch not found', 'a branch of another organization is rejected on save');
select throws_ok($$select public.save_signage_display(public.t_sg_id('central'), 'TV Central', null, 8, true,
  (select array_agg('b5000000-0000-4000-8000-000000000001'::uuid) from generate_series(1, 2)))$$, '22023', null, 'duplicates in bulk are rejected');
select throws_ok($$select public.save_signage_display(public.t_sg_id('central'), 'TV Central', null, 8, true,
  (select array_agg(extensions.gen_random_uuid()) from generate_series(1, 51)))$$, '22023', 'Una pantalla admite hasta 50 slides', 'more than 50 slides are rejected');
select throws_ok($$select public.save_signage_display(public.t_sg_id('central'), '', null, 8, true, array[]::uuid[])$$, '22023', null, 'a blank name is rejected on save');
select throws_ok($$select public.save_signage_display('00000000-0000-4000-8000-0000000000ff', 'X', null, 8, true, array[]::uuid[])$$, '42501', 'Signage display not found', 'an unknown display is rejected');
select is((select count(*) from public.digital_signage_slides), 0::bigint, 'rejected saves wrote no slide');

-- ---------------------------------------------------------------------------------------------
-- Publicar la presentación de Central (orden: Aceite, Mayonesa, Molida + 6 no disponibles)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.save_signage_display(public.t_sg_id('central'), 'TV Despensa Central', 'b3000000-0000-4000-8000-000000000001', 12, true, array[
  'b5000000-0000-4000-8000-000000000002','b5000000-0000-4000-8000-000000000004','b5000000-0000-4000-8000-000000000001',
  'b5000000-0000-4000-8000-000000000005','b5000000-0000-4000-8000-000000000003','b5000000-0000-4000-8000-000000000006',
  'b5000000-0000-4000-8000-000000000007','b5000000-0000-4000-8000-000000000009']::uuid[])$$, 'Central is published with 8 products');
select is((select string_agg(p.sku, ',' order by s.position) from public.digital_signage_slides s join public.products p on p.id = s.product_id), 'SG-02,SG-04,SG-01,SG-05,SG-03,SG-06,SG-07,SG-09', 'slides keep the published order');

-- ---------------------------------------------------------------------------------------------
-- Televisor (anon): token válido devuelve SOLO su pantalla
-- ---------------------------------------------------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(public.get_signage_display(public.t_sg_tok('central')) ->> 'status', 'ACTIVE', 'a valid token resolves its display');
select is((public.get_signage_display(public.t_sg_tok('central')) ->> 'slideDurationSeconds'), '12', 'the configured duration is delivered');
select is((select string_agg(s ->> 'name', ' | ' order by ord) from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') with ordinality as t(s, ord)),
  'Aceite Canuelas 900ml | Mayonesa Hellmanns 250gr | Molida vacuna', 'only AVAILABLE slides are delivered (inactive, no price, off category, raw material and expired price are hidden) in order');
select is(public.get_signage_display(public.t_sg_tok('central')) ->> 'organizationName', 'SG Org', 'the brand name is its own organization');
select is((select array_agg(k order by k) from jsonb_object_keys(public.get_signage_display(public.t_sg_tok('central'))) k), array['logo','organizationName','slideDurationSeconds','slides','status']::text[], 'the payload has exactly the expected top-level keys (logo reference, no ids, branch, config or token)');
select is((select array_agg(distinct k order by k) from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') s, jsonb_object_keys(s) k),
  array['bulkDiscountBps','bulkMinimumUnits','listPriceCents','name','photo','slideId','unitType','weightTiers']::text[], 'each slide carries only commercial facts and its photo reference');
select ok(public.get_signage_display(public.t_sg_tok('central'))::text !~* 'cost|margin|stock|sale|employee|supplier|123456|765432|sku|SG-0', 'no cost, margin, stock, sales, employee, supplier or SKU leaks into the payload');
select ok(position('Producto de otra org' in public.get_signage_display(public.t_sg_tok('central'))::text) = 0, 'nothing from another organization appears');
select is((select s -> 'photo' ->> 'storagePath' from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') s where s ->> 'name' like 'Mayonesa%'),
  'b2000000-0000-4000-8000-000000000001/b5000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png', 'a slide carries the path of its product commercial photo');
select is((select s -> 'photo' ->> 'contentType' from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') s where s ->> 'name' like 'Mayonesa%'), 'image/png', 'and its content type');
select ok((select s -> 'photo' = 'null'::jsonb from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') s where s ->> 'name' like 'Aceite%'), 'a product without photo has a null photo (the TV draws its fallback)');
select is(public.get_signage_display(public.t_sg_tok('central')) -> 'logo' ->> 'storagePath', 'b2000000-0000-4000-8000-000000000001/branding/c2000000-0000-4000-8000-000000000001.png', 'the payload carries the organization logo reference');
select ok(public.signage_object_is_published('b2000000-0000-4000-8000-000000000001/b5000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png'), 'Storage: the photo of a product published on an enabled screen is readable by the TV');
select ok(public.signage_object_is_published('b2000000-0000-4000-8000-000000000001/branding/c2000000-0000-4000-8000-000000000001.png'), 'Storage: the logo of an organization with an enabled screen is readable by the TV');
select ok(not public.signage_object_is_published('b2000000-0000-4000-8000-000000000002/b5000000-0000-4000-8000-000000000008/c1000000-0000-4000-8000-000000000008.jpg'), 'Storage: a photo that no screen publishes is NOT readable');
select ok(not public.signage_object_is_published('b2000000-0000-4000-8000-000000000001/b5000000-0000-4000-8000-000000000002/c1000000-0000-4000-8000-0000000000ff.png'), 'Storage: an unknown path is NOT readable');
select ok(not public.signage_object_is_published(null), 'Storage: NULL is not readable');

-- Precios y promoción de la sucursal (el motor TS hace la matemática; acá se prueban los HECHOS)
select is((select s ->> 'listPriceCents' from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') s where s ->> 'name' like 'Mayonesa%'), '203500', 'Central: the GLOBAL price applies (no Central override)');
select is((select s ->> 'bulkMinimumUnits' || '/' || (s ->> 'bulkDiscountBps') from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') s where s ->> 'name' like 'Mayonesa%'), '3/1500', 'Central: its own «llevando 3» rule (3 u, 15 %) is the one the POS reads');
select is((select s ->> 'listPriceCents' from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') s where s ->> 'name' like 'Aceite%'), '245000', 'a product without promotion keeps its list price');
select is((select s -> 'weightTiers' -> 0 ->> 'minimumGrams' || ' ' || (s -> 'weightTiers' -> 0 ->> 'discountType') || ' ' || (s -> 'weightTiers' -> 1 ->> 'minimumGrams') || ' ' || (s -> 'weightTiers' -> 1 ->> 'discountType')
  from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') s where s ->> 'name' like 'Molida%'), '2000 PERCENTAGE 5000 FIXED_PRICE_PER_KG', 'WEIGHT: the active threshold tiers (global + Central), expired ones excluded');
select is((select jsonb_array_length(s -> 'weightTiers') from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') s where s ->> 'name' like 'Molida%'), 2, 'WEIGHT: exactly two live tiers');
select is((select s ->> 'bulkMinimumUnits' from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides') s where s ->> 'name' like 'Molida%'), null, 'WEIGHT products carry no «llevando N unidades» rule');

-- ---------------------------------------------------------------------------------------------
-- Token inválido: no filtra nada
-- ---------------------------------------------------------------------------------------------
select is(public.get_signage_display(repeat('0', 64)), null, 'a well-formed but unknown token returns NULL');
select is(public.get_signage_display('abc'), null, 'a short token returns NULL');
select is(public.get_signage_display(upper(public.t_sg_tok('central'))), null, 'the token is exact: a different case does not resolve');
select is(public.get_signage_display(public.t_sg_tok('central') || ' '), null, 'trailing characters do not resolve');
select is(public.get_signage_display(null), null, 'NULL returns NULL');
select is(public.get_signage_display('b2000000-0000-4000-8000-000000000001'), null, 'an organization id is not a token');
select is(public.get_signage_display(public.t_sg_id('central')::text), null, 'a display id is not a token (no predictable access)');
select throws_ok($$select count(*) from public.digital_signage_displays$$, '42501', null, 'anonymous cannot read the tables directly');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento por sucursal: Avenida (precio propio, sin regla, Aceite fuera del surtido) y pantalla global
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.save_signage_display(public.t_sg_id('avenida'), 'TV Avenida', 'b3000000-0000-4000-8000-000000000002', 5, true, array[
  'b5000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000002']::uuid[])$$, 'Avenida is published (Aceite is not in its assortment)');
select lives_ok($$select public.save_signage_display(public.t_sg_id('global'), 'TV Global', null, 8, true, array[
  'b5000000-0000-4000-8000-000000000001']::uuid[])$$, 'the branch-less display is published');
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select s ->> 'listPriceCents' from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('avenida')) -> 'slides') s), '220000', 'Avenida: the BRANCH price wins over the global one (same order as the POS)');
select is((select s ->> 'bulkMinimumUnits' from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('avenida')) -> 'slides') s), null, 'Avenida: no promotion rule, so NO «llevando 3» is invented');
select is(jsonb_array_length(public.get_signage_display(public.t_sg_tok('avenida')) -> 'slides'), 1, 'Avenida: the product it does not sell is not shown');
select is((select s ->> 'listPriceCents' from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('global')) -> 'slides') s), '203500', 'branch-less display: the global price');
select is((select s ->> 'bulkMinimumUnits' || '/' || (s ->> 'bulkDiscountBps') from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('global')) -> 'slides') s), '3/2000', 'branch-less display: the organization-wide «llevando 3» configuration');
select is((select count(*) from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('central')) -> 'slides')), 3::bigint, 'Central is unaffected by the other displays');

-- ---------------------------------------------------------------------------------------------
-- Vista del Admin: todos los slides con su motivo
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(jsonb_array_length(public.get_signage_display_admin(public.t_sg_id('central')) -> 'slides'), 8, 'the editor sees ALL slides, available or not');
select is((select string_agg(coalesce(s ->> 'unavailableReason', 'OK'), ',' order by (s ->> 'position')::int) from jsonb_array_elements(public.get_signage_display_admin(public.t_sg_id('central')) -> 'slides') s),
  'OK,INACTIVE,OK,NO_PRICE,OK,INACTIVE,INACTIVE,NO_PRICE', 'each unavailable slide says why (inactive / category off / raw material / no price / expired price)');
select is((select string_agg(coalesce(s ->> 'unavailableReason', 'OK'), ',' order by (s ->> 'position')::int) from jsonb_array_elements(public.get_signage_display_admin(public.t_sg_id('avenida')) -> 'slides') s), 'OK,NOT_IN_BRANCH', 'a product outside the branch assortment is flagged NOT_IN_BRANCH');
select is(public.get_signage_display_admin(public.t_sg_id('central')) ->> 'name', 'TV Despensa Central', 'the admin view carries the configuration');
select ok(public.get_signage_display_admin(public.t_sg_id('central')) ? 'tokenRotatedAt', 'it says when the link was last generated');
select ok(not (public.get_signage_display_admin(public.t_sg_id('central'))::text ~ '[0-9a-f]{64}'), 'but never the token or its hash');
select is((select count(*) from public.digital_signage_displays), 3::bigint, 'an admin lists its 3 displays through RLS');

-- ---------------------------------------------------------------------------------------------
-- Pantalla desactivada
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.save_signage_display(public.t_sg_id('central'), 'TV Despensa Central', 'b3000000-0000-4000-8000-000000000001', 12, false, array[
  'b5000000-0000-4000-8000-000000000002','b5000000-0000-4000-8000-000000000001']::uuid[])$$, 'an admin disables the display');
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(public.get_signage_display(public.t_sg_tok('central')) ->> 'status', 'DISABLED', 'a disabled display reports DISABLED');
select is(jsonb_array_length(public.get_signage_display(public.t_sg_tok('central')) -> 'slides'), 0, 'and shows NO slides');

-- ---------------------------------------------------------------------------------------------
-- Otra organización
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.get_signage_display_admin(public.t_sg_id('central')), null, 'an admin of ANOTHER organization cannot read this display');
select throws_ok($$select public.save_signage_display(public.t_sg_id('central'), 'Hackeado', null, 8, true, array[]::uuid[])$$, '42501', 'Signage display not found', 'nor save it');
select throws_ok($$select public.regenerate_signage_token(public.t_sg_id('central'))$$, '42501', 'Signage display not found', 'nor regenerate its token');
select is((select count(*) from public.digital_signage_displays), 0::bigint, 'RLS hides other organizations'' displays');
select is((select count(*) from public.digital_signage_slides), 0::bigint, 'and their slides');
select lives_ok($$insert into public.t_sg_keep(name, token) select 'orgb', public.create_signage_display('TV B', 'b3000000-0000-4000-8000-000000000003') ->> 'token'$$, 'organization B creates its own display');
select lives_ok($$select public.save_signage_display((select id from public.digital_signage_displays where name = 'TV B'), 'TV B', 'b3000000-0000-4000-8000-000000000003', 8, true, array['b5000000-0000-4000-8000-000000000008']::uuid[])$$, 'and publishes its product');
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select s ->> 'name' from jsonb_array_elements(public.get_signage_display(public.t_sg_tok('orgb')) -> 'slides') s), 'Producto de otra org', 'the token of B returns B''s product');
select is(public.get_signage_display(public.t_sg_tok('orgb')) ->> 'organizationName', 'SG Org B', 'and B''s name only');
select ok(position('Mayonesa' in public.get_signage_display(public.t_sg_tok('orgb'))::text) = 0, 'nothing of organization A leaks to B');

-- ---------------------------------------------------------------------------------------------
-- Regenerar el enlace
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.regenerate_signage_token(public.t_sg_id('avenida'))$$, '42501', null, 'an employee cannot regenerate a link');
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$insert into public.t_sg_keep(name, token) select 'avenida2', public.regenerate_signage_token(public.t_sg_id('avenida')) ->> 'token'$$, 'an admin regenerates the Avenida link');
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(public.get_signage_display(public.t_sg_tok('avenida')), null, 'the PREVIOUS link stops working');
select is(jsonb_array_length(public.get_signage_display(public.t_sg_tok('avenida2')) -> 'slides'), 1, 'the new link works and the slides are intact');
select isnt(public.t_sg_tok('avenida'), public.t_sg_tok('avenida2'), 'the new token differs');
reset role;
select is((select count(*) from public.audit_logs where event_type = 'DIGITAL_SIGNAGE_DISPLAYS_TOKEN_REGENERATED'), 1::bigint, 'regeneration is audited');
select is((select count(*) from public.audit_logs where entity_type = 'digital_signage_displays' and (coalesce(before_data::text, '') || coalesce(after_data::text, '')) ~ '[0-9a-f]{64}'), 0::bigint, 'and the audit log still holds no token or hash');

-- ---------------------------------------------------------------------------------------------
-- Borrado en cascada de los slides con la pantalla
-- ---------------------------------------------------------------------------------------------
select is((select count(*) from public.digital_signage_slides where display_id = public.t_sg_id('avenida')), 2::bigint, 'the display keeps its 2 slides (including the one that is not available)');
delete from public.digital_signage_displays where id = public.t_sg_id('avenida');
select is((select count(*) from public.digital_signage_slides where display_id = public.t_sg_id('avenida')), 0::bigint, 'deleting a display removes its slides (cascade)');

select * from finish();
rollback;
