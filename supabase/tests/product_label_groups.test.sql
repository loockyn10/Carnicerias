begin;

create extension if not exists pgtap with schema extensions;
select plan(115);

-- Covers 202610070070 (D-073): grupos persistentes de etiquetas de góndola, historial de generaciones (snapshots) y la lectura que permite
-- detectar etiquetas desactualizadas. El precio se resuelve igual que el POS (sucursal vigente > global); la matemática de «llevando 3u» NO
-- vive en SQL (la hace el motor TS): acá se prueban los HECHOS y que el snapshot de impresión nunca se confunda con el precio vigente.

-- ---------------------------------------------------------------------------------------------
-- Fixture (ids propios: prefijo d)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'lg-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"LG Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'lg-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"LG Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'lg-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"LG Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'LG Org', 'lg-org'),
  ('d2000000-0000-4000-8000-000000000002', 'LG Org B', 'lg-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'LG Central', 'LG-C'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'LG Avenida', 'LG-A'),
  ('d3000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000002', 'LG B Branch', 'LG-B');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002');

insert into public.categories (id, organization_id, name, slug, active) values
  ('d4000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000001', 'Almacen', 'lg-almacen', true),
  ('d4000000-0000-4000-8000-00000000000b', 'd2000000-0000-4000-8000-000000000001', 'Vaca', 'lg-vaca', true),
  ('d4000000-0000-4000-8000-00000000000c', 'd2000000-0000-4000-8000-000000000001', 'Apagada', 'lg-apagada', false),
  ('d4000000-0000-4000-8000-00000000000e', 'd2000000-0000-4000-8000-000000000002', 'Almacen B', 'lgb-almacen', true);
-- 01 Mayonesa (UNIT, global $2.035 / Avenida $2.200), 02 Aceite (UNIT, $2.450, NO está en el surtido de Avenida), 03 Molida (WEIGHT, $11.000/kg),
-- 04 Inactivo, 05 Sin precio (precio 0), 06 Categoría apagada, 07 Materia prima, 08 Org B, 09 Yerba (UNIT, $4.100), 0a Sin precio vigente (vencido).
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-00000000000a', 'Mayonesa Hellmanns 250gr', 'lg-mayo', 'LG-01', 'UNIT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-00000000000a', 'Aceite Canuelas 900ml', 'lg-aceite', 'LG-02', 'UNIT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-00000000000b', 'Molida vacuna', 'lg-molida', 'LG-03', 'WEIGHT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-00000000000a', 'Producto inactivo', 'lg-inactivo', 'LG-04', 'UNIT', false, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-00000000000a', 'Producto sin precio', 'lg-sin-precio', 'LG-05', 'UNIT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-00000000000c', 'Producto de categoria apagada', 'lg-cat-apagada', 'LG-06', 'UNIT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-00000000000b', 'Media res', 'lg-media-res', 'LG-07', 'WEIGHT', true, 'RAW_MATERIAL'),
  ('d5000000-0000-4000-8000-000000000008', 'd2000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-00000000000e', 'Producto de otra org', 'lgb-otra', 'LGB-08', 'UNIT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-00000000000a', 'Yerba Aguantadora 1kg', 'lg-yerba', 'LG-09', 'UNIT', true, 'SELLABLE'),
  ('d5000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-00000000000a', 'Precio vencido', 'lg-vencido', 'LG-0A', 'UNIT', true, 'SELLABLE');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where not (b.id = 'd3000000-0000-4000-8000-000000000002' and p.id = 'd5000000-0000-4000-8000-000000000002');

insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from, valid_to) values
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', null, 203500, now() - interval '2 day', null),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 220000, now() - interval '2 day', null),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002', null, 245000, now() - interval '2 day', null),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000003', null, 1100000, now() - interval '2 day', null),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000004', null, 100000, now() - interval '2 day', null),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000005', null, 0, now() - interval '2 day', null),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000006', null, 100000, now() - interval '2 day', null),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000007', null, 100000, now() - interval '2 day', null),
  ('d2000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000008', null, 500000, now() - interval '2 day', null),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000009', null, 410000, now() - interval '2 day', null),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-00000000000a', null, 100000, now() - interval '3 day', now() - interval '1 day');
-- Costos y margen: las etiquetas NO deben exponerlos jamás (están cargados a propósito).
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from) values
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 123456, now() - interval '2 day'),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000003', 765432, now() - interval '2 day');
-- «Llevando 3u»: Central 15 % (desde 3); Avenida sin regla; la configuración global de la org (20 %) sólo vale para grupos sin sucursal.
insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps)
values ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 3, 1500);
-- Avenida sólo tiene una regla heredada «cada N» (EVERY_GROUP): el POS no la lee como «desde N», así que la etiqueta tampoco.
insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps, semantics)
values ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 2, 1000, 'EVERY_GROUP');
insert into public.organization_pricing_settings (organization_id, margin_bps, unit_bulk_discount_bps)
values ('d2000000-0000-4000-8000-000000000001', 3333, 2000);
insert into public.organization_quantity_discount_tiers (organization_id, minimum_units, discount_bps)
values ('d2000000-0000-4000-8000-000000000001', 3, 2000);

create table public.t_lg_keep(name text primary key, id uuid);
grant all on public.t_lg_keep to authenticated, anon;
create function public.t_lg_id(p_name text) returns uuid language sql security definer as $$ select id from public.t_lg_keep where name = p_name $$;
grant execute on function public.t_lg_id(text) to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'product_label_groups', 'the groups table exists');
select has_table('public', 'product_label_group_items', 'the group items table exists');
select has_table('public', 'product_label_print_runs', 'the print runs table exists');
select has_table('public', 'product_label_print_run_items', 'the print run snapshots table exists');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.product_label_groups'::regclass, 'public.product_label_group_items'::regclass, 'public.product_label_print_runs'::regclass, 'public.product_label_print_run_items'::regclass)), 'all four tables have RLS');
select ok(not exists (
  select 1 from (values ('product_label_groups'), ('product_label_group_items'), ('product_label_print_runs'), ('product_label_print_run_items')) t(n),
  (values ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
  where has_table_privilege('authenticated', 'public.' || t.n, p.priv) or has_table_privilege('anon', 'public.' || t.n, p.priv)
), 'no browser client can write any of the tables directly (only the RPCs write)');
select ok(not has_table_privilege('anon', 'public.product_label_groups', 'SELECT') and not has_table_privilege('anon', 'public.product_label_print_run_items', 'SELECT'), 'anonymous cannot read groups or print history');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name like 'product_label%' and column_name ~ 'cost|margin|stock|bytes|base64|pdf'),
  'the tables store NO cost, margin, stock or PDF bytes');
select ok(not exists (
  select 1 from unnest(array['list_label_groups(boolean)', 'get_label_group(uuid)', 'save_label_group(uuid,text,uuid,boolean)', 'set_label_group_products(uuid,uuid[],uuid[])', 'record_label_print_run(uuid,jsonb)']) f
  where has_function_privilege('anon', 'public.' || f, 'EXECUTE') or not has_function_privilege('authenticated', 'public.' || f, 'EXECUTE')
), 'every label RPC is callable by authenticated sessions and NOT by anonymous');

-- ---------------------------------------------------------------------------------------------
-- Grupos: permisos y validaciones
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.save_label_group(null, 'Empleado', null, true)$$, '42501', null, 'an employee (no catalog.write) cannot create a group');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.save_label_group(null, '   ', null, true)$$, '22023', null, 'a blank name is rejected');
select throws_ok($$select public.save_label_group(null, repeat('x', 81), null, true)$$, '22023', null, 'a name longer than 80 characters is rejected');
select throws_ok($$select public.save_label_group(null, 'Otra org', 'd3000000-0000-4000-8000-000000000003', true)$$, '42501', 'Branch not found', 'a branch of ANOTHER organization is rejected');

select lives_ok($$insert into public.t_lg_keep(name, id) select 'central', (public.save_label_group(null, 'Góndolas Despensa Central', 'd3000000-0000-4000-8000-000000000001', true) ->> 'id')::uuid$$, 'an admin creates the Central group');
select lives_ok($$insert into public.t_lg_keep(name, id) select 'avenida', (public.save_label_group(null, 'Heladera Avenida', 'd3000000-0000-4000-8000-000000000002', true) ->> 'id')::uuid$$, 'and one for Avenida (several groups per organization)');
select lives_ok($$insert into public.t_lg_keep(name, id) select 'global', (public.save_label_group(null, 'Ofertas mostrador', null, true) ->> 'id')::uuid$$, 'and a group with no branch (global price)');
select throws_ok($$select public.save_label_group(null, '  góndolas despensa CENTRAL ', null, true)$$, '23505', null, 'a second ACTIVE group with the same name (any case/spacing) is rejected');
select throws_ok($$select public.save_label_group(public.t_lg_id('avenida'), 'Góndolas Despensa Central', 'd3000000-0000-4000-8000-000000000002', true)$$, '23505', null, 'renaming onto an existing name is rejected too');
select throws_ok($$select public.save_label_group('00000000-0000-4000-8000-0000000000ff', 'X', null, true)$$, '42501', 'Label group not found', 'an unknown group is rejected');
select lives_ok($$select public.save_label_group(public.t_lg_id('global'), 'Ofertas de mostrador', null, true)$$, 'a group can be renamed');
select is((select name from public.product_label_groups where id = public.t_lg_id('global')), 'Ofertas de mostrador', 'the new name is stored');

-- Otra organización: no ve, no edita, y puede reutilizar el nombre.
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.save_label_group(public.t_lg_id('central'), 'Hackeado', null, true)$$, '42501', 'Label group not found', 'ANOTHER organization cannot edit my group');
select is(public.get_label_group(public.t_lg_id('central')), null, 'ANOTHER organization cannot read my group (NULL, indistinguishable from missing)');
select is(jsonb_array_length(public.list_label_groups()), 0, 'ANOTHER organization sees none of my groups');
select is((select count(*) from public.product_label_groups), 0::bigint, 'RLS hides my groups from ANOTHER organization');
select lives_ok($$select public.save_label_group(null, 'Góndolas Despensa Central', 'd3000000-0000-4000-8000-000000000003', true)$$, 'group names are unique per organization, not global');
select throws_ok($$select public.save_label_group(null, 'Mi sucursal ajena', 'd3000000-0000-4000-8000-000000000001', true)$$, '42501', 'Branch not found', 'ANOTHER organization cannot attach MY branch to its group');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(jsonb_array_length(public.list_label_groups()), 3, 'the admin lists exactly its three groups');
select is((select string_agg(g ->> 'name', ' | ' order by ord) from jsonb_array_elements(public.list_label_groups()) with ordinality t(g, ord)), 'Góndolas Despensa Central | Heladera Avenida | Ofertas de mostrador', 'groups are listed by name');
select is((select g ->> 'branchName' from jsonb_array_elements(public.list_label_groups()) g where g ->> 'name' like 'Gón%'), 'LG Central', 'the listing carries the branch name');

-- ---------------------------------------------------------------------------------------------
-- Productos del grupo: alta en LOTE, quitar, reactivar
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.set_label_group_products(public.t_lg_id('central'), array[
  'd5000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000001']::uuid[])$$, '22023', null, 'the same product twice is rejected');
select throws_ok($$select public.set_label_group_products(public.t_lg_id('central'), array[
  'd5000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000008']::uuid[])$$, '42501', 'Product was not found in this organization', 'a product of ANOTHER organization cannot be added');
select throws_ok($$select public.set_label_group_products(public.t_lg_id('central'), array['d5000000-0000-4000-8000-000000000004']::uuid[])$$, '22023', 'No se pueden agregar productos inactivos', 'an inactive product cannot be added');
select throws_ok($$select public.set_label_group_products(public.t_lg_id('central'), array['d5000000-0000-4000-8000-000000000001']::uuid[], array['d5000000-0000-4000-8000-000000000001']::uuid[])$$, '22023', null, 'adding and removing the same product at once is rejected');
select throws_ok($$select public.set_label_group_products(public.t_lg_id('central'), array['d5000000-0000-4000-8000-000000000001', null]::uuid[])$$, '22023', null, 'a NULL id is rejected');
select throws_ok($$select public.set_label_group_products(public.t_lg_id('central'), (select array_agg(extensions.gen_random_uuid()) from generate_series(1, 501)))$$, '22023', null, 'more than 500 products in one call are rejected');
select is((select count(*) from public.product_label_group_items), 0::bigint, 'rejected calls wrote nothing');

select is(public.set_label_group_products(public.t_lg_id('central'), array[
  'd5000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000003','d5000000-0000-4000-8000-000000000009']::uuid[]) ->> 'added',
  '4', 'FOUR products are added with ONE call (batch, not one save per product)');
select is((select string_agg(p.sku, ',' order by i.position) from public.product_label_group_items i join public.products p on p.id = i.product_id where i.group_id = public.t_lg_id('central')), 'LG-01,LG-02,LG-03,LG-09', 'they keep the order they were added in');
select is((select min(position) || '-' || max(position) from public.product_label_group_items where group_id = public.t_lg_id('central')), '0-3', 'positions are consecutive from 0');
select is(public.set_label_group_products(public.t_lg_id('central'), array['d5000000-0000-4000-8000-000000000001']::uuid[]) ->> 'added', '0', 'adding a product that is already active changes nothing');
select is((select position from public.product_label_group_items where group_id = public.t_lg_id('central') and product_id = 'd5000000-0000-4000-8000-000000000001'), 0, 'and keeps its position');
select is(public.set_label_group_products(public.t_lg_id('central'), null, array['d5000000-0000-4000-8000-000000000002']::uuid[]) ->> 'removed', '1', 'a product is removed from the group');
select is(public.set_label_group_products(public.t_lg_id('central'), null, array['d5000000-0000-4000-8000-000000000002']::uuid[]) ->> 'removed', '0', 'removing it again is a no-op');
select is(jsonb_array_length(public.get_label_group(public.t_lg_id('central')) -> 'items'), 3, 'the removed product no longer appears in the group');
select is((select active from public.product_label_group_items where group_id = public.t_lg_id('central') and product_id = 'd5000000-0000-4000-8000-000000000002'), false, 'it is deactivated, not deleted (the link to its print history is kept)');
select is(public.set_label_group_products(public.t_lg_id('central'), array['d5000000-0000-4000-8000-000000000002']::uuid[]) ->> 'added', '1', 'adding it back reactivates it');
select is((select active from public.product_label_group_items where group_id = public.t_lg_id('central') and product_id = 'd5000000-0000-4000-8000-000000000002'), true, 'it is active again');
select is((select position from public.product_label_group_items where group_id = public.t_lg_id('central') and product_id = 'd5000000-0000-4000-8000-000000000002'), 4, 'and goes to the END of the group');
select is((select count(*) from public.product_label_group_items where group_id = public.t_lg_id('central')), 4::bigint, 'still one row per product (no duplicates)');
select is((select count(*) from public.audit_logs where entity_type = 'product_label_groups' and event_type = 'PRODUCT_LABEL_GROUP_ITEMS_CHANGED'), 5::bigint, 'product changes are audited');

-- Otra organización no toca mis productos de grupo
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.set_label_group_products(public.t_lg_id('central'), array['d5000000-0000-4000-8000-000000000008']::uuid[])$$, '42501', 'Label group not found', 'ANOTHER organization cannot add products to MY group');
select throws_ok($$select public.set_label_group_products(public.t_lg_id('central'), null, array['d5000000-0000-4000-8000-000000000001']::uuid[])$$, '42501', 'Label group not found', 'nor remove them');
select is((select count(*) from public.product_label_group_items), 0::bigint, 'RLS hides my group items from ANOTHER organization');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_label_group_products(public.t_lg_id('central'), array['d5000000-0000-4000-8000-000000000001']::uuid[])$$, '42501', null, 'an employee cannot change group products');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Hechos del grupo: precio por sucursal y regla «llevando N»
-- ---------------------------------------------------------------------------------------------
select is((select i ->> 'listPriceCents' from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Mayonesa%'), '203500', 'Central: the GLOBAL price applies (no Central override)');
select is((select i ->> 'bulkMinimumUnits' || '/' || (i ->> 'bulkDiscountBps') from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Mayonesa%'), '3/1500', 'Central: its own «llevando 3» rule (3 u, 15 %) is the one the POS reads');
select is((select i ->> 'bulkMinimumUnits' from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Molida%'), null, 'WEIGHT products carry no «llevando N unidades» rule');
select is((select i ->> 'listPriceCents' from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Molida%'), '1100000', 'WEIGHT: the list price per kg');
select is((select string_agg(i ->> 'name', ' | ' order by ord) from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') with ordinality t(i, ord)),
  'Mayonesa Hellmanns 250gr | Molida vacuna | Yerba Aguantadora 1kg | Aceite Canuelas 900ml', 'items come back in group order');
select is(public.get_label_group(public.t_lg_id('central')) ->> 'branchName', 'LG Central', 'the group reports its branch');
select ok(public.get_label_group(public.t_lg_id('central'))::text !~* 'cost|margin|stock|employee|supplier|123456|765432', 'no cost, margin, stock, employee or supplier leaks into the facts');
select ok((select bool_and(i -> 'last' = 'null'::jsonb) from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i), 'a product never printed has no previous print (last = null)');

-- Avenida: precio de sucursal gana sobre el global; sin regla propia NO se inventa «llevando 3»; Aceite no se vende ahí.
select public.set_label_group_products(public.t_lg_id('avenida'), array['d5000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000002']::uuid[]);
select is((select i ->> 'listPriceCents' from jsonb_array_elements(public.get_label_group(public.t_lg_id('avenida')) -> 'items') i where i ->> 'name' like 'Mayonesa%'), '220000', 'Avenida: the BRANCH price wins over the global one (same order as the POS)');
select is((select i ->> 'bulkMinimumUnits' from jsonb_array_elements(public.get_label_group(public.t_lg_id('avenida')) -> 'items') i where i ->> 'name' like 'Mayonesa%'), null, 'Avenida: no promotion rule, so NO «llevando 3» is invented');
select is((select i ->> 'unavailableReason' from jsonb_array_elements(public.get_label_group(public.t_lg_id('avenida')) -> 'items') i where i ->> 'name' like 'Aceite%'), 'NOT_IN_BRANCH', 'Avenida: a product it does not sell is flagged, not printable');

-- Sin sucursal: precio global y configuración global de la organización.
select public.set_label_group_products(public.t_lg_id('global'), array['d5000000-0000-4000-8000-000000000001']::uuid[]);
select is((select i ->> 'listPriceCents' from jsonb_array_elements(public.get_label_group(public.t_lg_id('global')) -> 'items') i), '203500', 'branch-less group: the global price');
select is((select i ->> 'bulkMinimumUnits' || '/' || (i ->> 'bulkDiscountBps') from jsonb_array_elements(public.get_label_group(public.t_lg_id('global')) -> 'items') i), '3/2000', 'branch-less group: the organization-wide «llevando 3» configuration');

-- Productos que dejaron de ser imprimibles (se cargan como el dueño: la RPC no deja agregar inactivos, pero pueden desactivarse después).
reset role;
insert into public.product_label_group_items (organization_id, group_id, product_id, position) values
  ('d2000000-0000-4000-8000-000000000001', public.t_lg_id('central'), 'd5000000-0000-4000-8000-000000000004', 10),
  ('d2000000-0000-4000-8000-000000000001', public.t_lg_id('central'), 'd5000000-0000-4000-8000-000000000005', 11),
  ('d2000000-0000-4000-8000-000000000001', public.t_lg_id('central'), 'd5000000-0000-4000-8000-000000000006', 12),
  ('d2000000-0000-4000-8000-000000000001', public.t_lg_id('central'), 'd5000000-0000-4000-8000-000000000007', 13),
  ('d2000000-0000-4000-8000-000000000001', public.t_lg_id('central'), 'd5000000-0000-4000-8000-00000000000a', 14);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select string_agg(coalesce(i ->> 'unavailableReason', 'OK'), ',' order by ord) from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') with ordinality t(i, ord) where ord > 4),
  'INACTIVE,NO_PRICE,INACTIVE,INACTIVE,NO_PRICE', 'inactive, zero-price, switched-off category, raw material and expired-price products are flagged (never printed at $0)');
reset role;
delete from public.product_label_group_items where group_id = public.t_lg_id('central') and position >= 10;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Historial de generaciones (snapshots)
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), '[]'::jsonb)$$, '22023', null, 'an empty generation is rejected');
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), '{"productId": "x"}'::jsonb)$$, '22023', null, 'a non-array payload is rejected');
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000008', 'copies', 1, 'displayedName', 'X', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 100)))$$,
  '42501', 'Un producto no pertenece al grupo', 'a product that is not in the group (e.g. ANOTHER organization) cannot be recorded');
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 0, 'displayedName', 'X', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 100)))$$,
  '22023', null, 'copies must be at least 1');
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 100, 'displayedName', 'X', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 100)))$$,
  '22023', null, 'copies are capped at 99 per product');
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 1, 'displayedName', 'X', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 100),
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 1, 'displayedName', 'X', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 100)))$$,
  '22023', 'Hay productos repetidos en la generación', 'the same product twice is rejected');
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 1, 'displayedName', 'Mayo', 'unitType', 'UNIT', 'variant', 'PROMO', 'listPriceCents', 100,
    'promoPriceCents', 100, 'promoMinimumUnits', 3, 'promoDiscountBps', 1500)))$$,
  '23514', null, 'a promotional price that is not below the normal price is rejected');
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 1, 'displayedName', 'Mayo', 'unitType', 'UNIT', 'variant', 'PROMO', 'listPriceCents', 100)))$$,
  '23514', null, 'a PROMO snapshot needs its promotional price');
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 1, 'displayedName', 'Mayo', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 0)))$$,
  '23514', null, 'a zero normal price is rejected');
-- Un producto quitado del grupo ya no puede registrarse (se agrega a un grupo y se quita).
select public.set_label_group_products(public.t_lg_id('global'), array['d5000000-0000-4000-8000-000000000009']::uuid[]);
select public.set_label_group_products(public.t_lg_id('global'), null, array['d5000000-0000-4000-8000-000000000009']::uuid[]);
select throws_ok($$select public.record_label_print_run(public.t_lg_id('global'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000009', 'copies', 1, 'displayedName', 'X', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 100)))$$,
  '42501', 'Un producto no pertenece al grupo', 'a product REMOVED from the group cannot be recorded');
select is((select count(*) from public.product_label_print_runs), 0::bigint, 'rejected generations left no run behind');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 1, 'displayedName', 'X', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 100)))$$,
  '42501', null, 'an employee cannot record a generation');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 1, 'displayedName', 'X', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 100)))$$,
  '42501', 'Label group not found', 'ANOTHER organization cannot record a generation on MY group');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Primera impresión de Central: Mayonesa en oferta (2 copias), Molida por kg, Yerba sin promoción. Aceite NO se imprime.
select lives_ok($$insert into public.t_lg_keep(name, id) select 'run1', (public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 2, 'displayedName', 'MAYONESA HELLMANNS 250GR', 'unitType', 'UNIT', 'variant', 'PROMO',
    'listPriceCents', 203500, 'promoPriceCents', 172975, 'promoMinimumUnits', 3, 'promoDiscountBps', 1500, 'conditionText', 'POR 3 UNIDADES - Descuento 15%'),
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000003', 'copies', 1, 'displayedName', 'MOLIDA VACUNA', 'unitType', 'WEIGHT', 'variant', 'WEIGHT', 'listPriceCents', 1100000),
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000009', 'copies', 3, 'displayedName', 'YERBA AGUANTADORA 1KG', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 410000))) ->> 'runId')::uuid$$,
  'an admin records a generation of three products');
select is((select label_count || '/' || product_count from public.product_label_print_runs where id = public.t_lg_id('run1')), '6/3', 'the run counts labels (2 + 1 + 3 copies) and products');
select is((select generated_by from public.product_label_print_runs where id = public.t_lg_id('run1')), 'd1000000-0000-4000-8000-000000000001'::uuid, 'the run records who generated it');
select is((select branch_id from public.product_label_print_runs where id = public.t_lg_id('run1')), 'd3000000-0000-4000-8000-000000000001'::uuid, 'and the branch the group had');
select is((select string_agg(displayed_name || ':' || copies, ',' order by position) from public.product_label_print_run_items where run_id = public.t_lg_id('run1')), 'MAYONESA HELLMANNS 250GR:2,MOLIDA VACUNA:1,YERBA AGUANTADORA 1KG:3', 'snapshots keep the printed name, copies and order');
select is((select promo_price_cents || '/' || list_price_cents || '/' || promo_minimum_units || '/' || promo_discount_bps from public.product_label_print_run_items where run_id = public.t_lg_id('run1') and variant = 'PROMO'), '172975/203500/3/1500', 'the PROMO snapshot keeps the displayed promotional price, normal price and condition');
select is((select promo_price_cents from public.product_label_print_run_items where run_id = public.t_lg_id('run1') and variant = 'SIMPLE'), null, 'a product without promotion stores no promotional price');
select ok((select bool_and(generated_at = (select generated_at from public.product_label_print_runs where id = public.t_lg_id('run1'))) from public.product_label_print_run_items where run_id = public.t_lg_id('run1')), 'every snapshot carries the run''s generated_at');
select is((select count(*) from public.audit_logs where event_type = 'PRODUCT_LABEL_PRINT_RUNS_INSERT'), 1::bigint, 'the generation is audited');

-- La última impresión alimenta la detección de cambios; el snapshot NO es el precio vigente.
select is((select i -> 'last' ->> 'listPriceCents' || '/' || (i -> 'last' ->> 'promoPriceCents') from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Mayonesa%'), '203500/172975', 'get_label_group returns the last printed values per product');
select is((select i -> 'last' = 'null'::jsonb from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Aceite%'), true, 'a product that was NOT in the run still has no previous print');
select is((select i -> 'last' ->> 'copies' from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Yerba%'), '3', 'including how many copies were printed');
select is(jsonb_array_length(public.get_label_group(public.t_lg_id('avenida')) -> 'items'), 2, 'the other group is untouched by Central''s run');
select ok((select bool_and(i -> 'last' = 'null'::jsonb) from jsonb_array_elements(public.get_label_group(public.t_lg_id('avenida')) -> 'items') i), 'printing in Central does not mark Avenida''s labels as printed (history is per group)');

-- Cambio de precio vigente: se programa como el dueño y se retrocede la vigencia (un archivo pgTAP corre en UNA transacción: now() no avanza).
select public.set_product_price('d5000000-0000-4000-8000-000000000001', null, 225000, clock_timestamp());
reset role;
alter table public.product_prices disable trigger product_prices_prevent_history_rewrite;
update public.product_prices set valid_to = now() - interval '1 hour' where product_id = 'd5000000-0000-4000-8000-000000000001' and branch_id is null and price_cents = 203500;
update public.product_prices set valid_from = now() - interval '1 hour' where product_id = 'd5000000-0000-4000-8000-000000000001' and branch_id is null and price_cents = 225000;
alter table public.product_prices enable trigger product_prices_prevent_history_rewrite;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select i ->> 'listPriceCents' from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Mayonesa%'), '225000', 'after a price change the CURRENT price is the new one');
select is((select i -> 'last' ->> 'listPriceCents' from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Mayonesa%'), '203500', 'while the last PRINT keeps the old price (they differ: that is how a stale label is detected)');

-- Una nueva generación pasa a ser la referencia posterior.
select lives_ok($$insert into public.t_lg_keep(name, id) select 'run2', (public.record_label_print_run(public.t_lg_id('central'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 1, 'displayedName', 'MAYONESA HELLMANNS 250GR', 'unitType', 'UNIT', 'variant', 'PROMO',
    'listPriceCents', 225000, 'promoPriceCents', 191250, 'promoMinimumUnits', 3, 'promoDiscountBps', 1500))) ->> 'runId')::uuid$$, 'a second generation re-prints only the changed product');
select is((select i -> 'last' ->> 'listPriceCents' || '/' || (i -> 'last' ->> 'promoPriceCents') from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Mayonesa%'), '225000/191250', 'the NEW run becomes the reference for that product');
select is((select i -> 'last' ->> 'listPriceCents' from jsonb_array_elements(public.get_label_group(public.t_lg_id('central')) -> 'items') i where i ->> 'name' like 'Yerba%'), '410000', 'products not re-printed keep their previous reference');
select is((select count(*) from public.product_label_print_runs where group_id = public.t_lg_id('central')), 2::bigint, 'both runs are kept as history');
select ok((select (r1.generated_at < r2.generated_at) from public.product_label_print_runs r1, public.product_label_print_runs r2 where r1.id = public.t_lg_id('run1') and r2.id = public.t_lg_id('run2')), 'runs are ordered in time');

-- Lectura del historial: sólo mi organización.
select is((select count(*) from public.product_label_print_run_items), 4::bigint, 'the admin reads all snapshots of its organization');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.product_label_print_runs) + (select count(*) from public.product_label_print_run_items), 0::bigint, 'ANOTHER organization cannot read my print history');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Inmutabilidad del historial
reset role;
select throws_ok($$update public.product_label_print_run_items set list_price_cents = 1$$, '23000', 'El historial de impresión de etiquetas no se modifica', 'a print snapshot cannot be rewritten');
select throws_ok($$update public.product_label_print_runs set label_count = 99$$, '23000', null, 'nor can a run header');

-- Archivar un grupo
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.save_label_group(public.t_lg_id('avenida'), 'Heladera Avenida', 'd3000000-0000-4000-8000-000000000002', false)$$, 'a group can be archived (never deleted)');
select throws_ok($$select public.set_label_group_products(public.t_lg_id('avenida'), array['d5000000-0000-4000-8000-000000000009']::uuid[])$$, '22023', 'El grupo está archivado', 'an archived group cannot be edited');
select throws_ok($$select public.record_label_print_run(public.t_lg_id('avenida'), jsonb_build_array(
  jsonb_build_object('productId', 'd5000000-0000-4000-8000-000000000001', 'copies', 1, 'displayedName', 'X', 'unitType', 'UNIT', 'variant', 'SIMPLE', 'listPriceCents', 100)))$$,
  '22023', 'El grupo está archivado', 'nor generate labels');
select is(jsonb_array_length(public.list_label_groups()), 2, 'archived groups leave the default listing');
select is(jsonb_array_length(public.list_label_groups(true)), 3, 'but can be listed on request');
select lives_ok($$select public.save_label_group(null, 'Heladera Avenida', null, true)$$, 'an archived group frees its name');
select is((select g ->> 'lastRunAt' is not null from jsonb_array_elements(public.list_label_groups()) g where g ->> 'name' like 'Gón%'), true, 'the listing carries the last generation date');
select is((select (g ->> 'itemCount')::int from jsonb_array_elements(public.list_label_groups()) g where g ->> 'name' like 'Gón%'), 4, 'and the active product count');

select * from finish();
rollback;
