begin;

create extension if not exists pgtap with schema extensions;
select plan(165);

-- Covers 202610200084 (D-086): CARPETAS de gráficas y TV alimentada por PROMOCIONES.
--   * una pantalla nueva reproduce «todas las promociones activas» que le aplican (sucursal, surtido, vigencia) sin cargar nada a mano;
--   * una promoción nueva aparece sola, una editada cambia, una vencida / desactivada / futura / de otra sucursal NO se reproduce;
--   * la fuente puede ser una carpeta: sólo sus elementos, activos y aplicables; la carpeta guarda referencias, nunca precios ni fotos;
--   * carpetas: crear, renombrar, ordenar, quitar, eliminar (sólo sin uso), aislamiento por organización y hechos vigentes en lote;
--   * las fotos siguen en el bucket privado: sólo se publica la de lo que una pantalla habilitada reproduce HOY.
-- Fixture idéntico al de signage_promotion_groups.test.sql (ids propios: prefijo 9): Org A con Avenida y Janssen, Org B con una sucursal.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pg-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PG Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pg-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PG Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pg-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PG Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('92000000-0000-4000-8000-000000000001', 'PG Org', 'pg-org'),
  ('92000000-0000-4000-8000-000000000002', 'PG Org B', 'pg-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('93000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'PG Avenida', 'PG-A'),
  ('93000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', 'PG Janssen', 'PG-J'),
  ('93000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000002', 'PG B Branch', 'PG-B');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002');
insert into public.categories (id, organization_id, name, slug, active) values
  ('94000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'Varios', 'pg-varios', true),
  ('94000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000002', 'Varios B', 'pg-varios-b', true);
-- 01 Pata muslo (kg $10.000), 02 Coca (u $2.000), 03 Costilla (kg $8.000), 04 Matambre (kg $12.000, SIN foto), 05 Chorizo (u $1.500, no se vende en Janssen), 09 org B.
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('95000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'Pata muslo', 'pg-pata', 'PG-01', 'WEIGHT', true, 'SELLABLE'),
  ('95000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'Coca Cola', 'pg-coca', 'PG-02', 'UNIT', true, 'SELLABLE'),
  ('95000000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'Costilla de cerdo', 'pg-costilla', 'PG-03', 'WEIGHT', true, 'SELLABLE'),
  ('95000000-0000-4000-8000-000000000004', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'Matambre', 'pg-matambre', 'PG-04', 'WEIGHT', true, 'SELLABLE'),
  ('95000000-0000-4000-8000-000000000005', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'Chorizo', 'pg-chorizo', 'PG-05', 'UNIT', true, 'SELLABLE'),
  ('95000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000002', '94000000-0000-4000-8000-000000000002', 'Producto de otra org', 'pgb-otra', 'PGB-09', 'WEIGHT', true, 'SELLABLE');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where not (b.id = '93000000-0000-4000-8000-000000000002' and p.id = '95000000-0000-4000-8000-000000000005');
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000001', null, 1000000, now() - interval '5 day'),
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002', null, 200000, now() - interval '5 day'),
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000003', null, 800000, now() - interval '5 day'),
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000004', null, 1200000, now() - interval '5 day'),
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000005', null, 150000, now() - interval '5 day'),
  ('92000000-0000-4000-8000-000000000002', '95000000-0000-4000-8000-000000000009', null, 500000, now() - interval '5 day');
-- Costos cargados a propósito: la TV no debe exponerlos jamás.
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from) values
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000001', 765432, now() - interval '5 day');
-- Fotos comerciales (bucket privado): Pata muslo, Coca, Costilla y la de otra organización. Matambre NO tiene foto.
insert into public.product_artwork_photos (product_id, organization_id, storage_path, content_type, size_bytes) values
  ('95000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png', 'image/png', 1200),
  ('95000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000002/c1000000-0000-4000-8000-000000000002.png', 'image/png', 1200),
  ('95000000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000003/c1000000-0000-4000-8000-000000000003.png', 'image/png', 1200),
  ('95000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000002/95000000-0000-4000-8000-000000000009/c1000000-0000-4000-8000-000000000009.png', 'image/png', 1200);

-- Promociones (ids fijos para leerlas en los tests):
--   P1 Pata muslo  umbral  10 % desde 2 kg (global)                   P5 Chorizo  pack 6 u por $8.000 (global)
--   P2 Costilla    pack 2 kg por $14.000 (sólo Avenida)               P6 Pata muslo pack 5 kg por $45.000 (global) VENCIDA ayer
--   P3 Coca        pack 3 u por $5.400 (global)                       P7 Matambre pack 3 kg por $30.000 (global) PRÓXIMA (en 2 días)
--   P4 Matambre    umbral $11.000/kg desde 1 kg (global)              P8 Costilla umbral 5 % desde 3 kg (sólo Janssen)
--   P9 Producto de otra organización (pack)
insert into public.product_weight_discounts (id, organization_id, product_id, branch_id, minimum_grams, discount_type, discount_value, promotion_mode, pack_quantity_grams, pack_quantity_units, pack_price_cents, valid_from, valid_until) values
  ('96000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000001', null, 2000, 'PERCENTAGE', 1000, 'THRESHOLD', null, null, null, now() - interval '1 day', null),
  ('96000000-0000-4000-8000-000000000004', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000004', null, 1000, 'FIXED_PRICE_PER_KG', 1100000, 'THRESHOLD', null, null, null, now() - interval '1 day', null),
  ('96000000-0000-4000-8000-000000000008', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000003', '93000000-0000-4000-8000-000000000002', 3000, 'PERCENTAGE', 500, 'THRESHOLD', null, null, null, now() - interval '1 day', null);
insert into public.product_weight_discounts (id, organization_id, product_id, branch_id, promotion_mode, pack_quantity_grams, pack_quantity_units, pack_price_cents, valid_from, valid_until) values
  ('96000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000003', '93000000-0000-4000-8000-000000000001', 'PACK_FIXED_TOTAL', 2000, null, 1400000, now() - interval '1 day', null),
  ('96000000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002', null, 'PACK_FIXED_TOTAL', null, 3, 540000, now() - interval '1 day', null),
  ('96000000-0000-4000-8000-000000000005', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000005', null, 'PACK_FIXED_TOTAL', null, 6, 800000, now() - interval '1 day', null),
  ('96000000-0000-4000-8000-000000000006', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000001', null, 'PACK_FIXED_TOTAL', 5000, null, 4500000, now() - interval '10 day', now() - interval '1 day'),
  ('96000000-0000-4000-8000-000000000007', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000004', null, 'PACK_FIXED_TOTAL', 3000, null, 3000000, now() + interval '2 day', null),
  ('96000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000002', '95000000-0000-4000-8000-000000000009', null, 'PACK_FIXED_TOTAL', 1000, null, 400000, now() - interval '1 day', null);

create table public.t_sf_keep(name text primary key, id uuid, token text);
grant all on public.t_sf_keep to authenticated, anon;
create function public.t_sf_tok(p_name text) returns text language sql security definer as $$ select token from public.t_sf_keep where name = p_name $$;
create function public.t_sf_id(p_name text) returns uuid language sql security definer as $$ select id from public.t_sf_keep where name = p_name $$;
grant execute on function public.t_sf_tok(text), public.t_sf_id(text) to authenticated, anon;
-- Nombres de las diapositivas que reproduce el televisor de un token, en orden.
create function public.t_sf_tv(p_name text) returns text language sql stable as $$
  select coalesce(string_agg(s ->> 'name', ' | ' order by ord), '') from jsonb_array_elements(public.get_signage_display(public.t_sf_tok(p_name)) -> 'slides') with ordinality as t(s, ord) $$;
-- Vista del editor: «nombre:motivo» por diapositiva (disponible = OK), en orden.
create function public.t_sf_reasons(p_name text) returns text language sql stable as $$
  select coalesce(string_agg((s ->> 'name') || ':' || coalesce(s ->> 'unavailableReason', 'OK'), ' | ' order by ord), '')
  from jsonb_array_elements(public.get_signage_display_admin(public.t_sf_id(p_name)) -> 'slides') with ordinality as t(s, ord) $$;
-- Hechos de una carpeta: «nombre:motivo-o-estado» por elemento.
create function public.t_sf_facts(p_folder text, p_branch uuid) returns text language sql stable as $$
  select coalesce(string_agg((s ->> 'name') || ':' || coalesce(s ->> 'unavailableReason', 'OK'), ' | ' order by ord), '')
  from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id(p_folder), p_branch) -> 'items') with ordinality as t(s, ord) $$;
grant execute on function public.t_sf_tv(text), public.t_sf_reasons(text), public.t_sf_facts(text, uuid) to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_column('public', 'signage_promotion_groups', 'generate_feed', 'a folder remembers whether to generate Feed');
select has_column('public', 'signage_promotion_groups', 'generate_story', 'and Story');
select has_column('public', 'signage_promotion_group_items', 'product_id', 'a folder can hold a product without promotion');
select has_column('public', 'digital_signage_displays', 'content_source', 'a screen has a content source');
select has_column('public', 'digital_signage_displays', 'folder_id', 'and an optional folder');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name in ('signage_promotion_groups', 'signage_promotion_group_items') and column_name ~ 'price|cost|margin|name_snapshot|photo|image|discount'),
  'folders still store NO price, discount, photo or name: they only point to promotions/products');
select ok(not has_function_privilege('anon', 'public.save_signage_folder(uuid,text,jsonb,boolean,boolean)', 'EXECUTE'), 'anonymous cannot save folders');
select ok(not has_function_privilege('anon', 'public.delete_signage_folder(uuid)', 'EXECUTE'), 'anonymous cannot delete folders');
select ok(not has_function_privilege('anon', 'public.get_signage_folders()', 'EXECUTE'), 'anonymous cannot list folders');
select ok(not has_function_privilege('anon', 'public.get_signage_folder_facts(uuid,uuid,uuid[])', 'EXECUTE'), 'anonymous cannot resolve a folder');
select ok(not has_function_privilege('anon', 'public.save_signage_display_source(uuid,text,uuid,integer,boolean,text,uuid)', 'EXECUTE'), 'anonymous cannot change a screen source');
select ok(not has_function_privilege('anon', 'public.get_signage_displays_overview()', 'EXECUTE'), 'anonymous cannot read the screens overview');
select ok(not has_function_privilege('anon', 'app_private.signage_resolve_entries(uuid,uuid,jsonb,boolean,timestamptz)', 'EXECUTE'), 'the resolver is private');
select ok(not has_function_privilege('authenticated', 'app_private.signage_display_entries(uuid)', 'EXECUTE'), 'and so is the per-screen list');
select ok(has_function_privilege('anon', 'public.get_signage_display(text)', 'EXECUTE'), 'the token RPC stays the only public door');
select ok(not has_column_privilege('authenticated', 'public.digital_signage_displays', 'token_hash', 'SELECT'), 'the token hash is still unreadable');

-- ---------------------------------------------------------------------------------------------
-- Dos organizaciones y permisos
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.save_signage_folder(null, 'Empleado', jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001')), true, true)$$,
  '42501', null, 'an employee (no catalog.write) cannot create a folder');
select throws_ok($$select public.delete_signage_folder('96000000-0000-4000-8000-000000000001')$$, '42501', null, 'nor delete one');
select throws_ok($$select public.save_signage_display_source('96000000-0000-4000-8000-000000000001', 'x', null, 8, true, 'ALL_PROMOTIONS', null)$$, '42501', null, 'nor change a screen source');

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Carpetas: crear, validar, ordenar, renombrar
-- ---------------------------------------------------------------------------------------------
-- «Ofertas finde»: 4 promociones activas, 1 vencida (P6, conserva la referencia) y el producto Costilla (sin promoción) como elemento suelto.
insert into public.t_sf_keep select 'finde', (r ->> 'id')::uuid, null from (select public.save_signage_folder(null, 'Ofertas finde', jsonb_build_array(
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000002'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000003'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000004'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000006'),
  jsonb_build_object('kind', 'PRODUCT', 'id', '95000000-0000-4000-8000-000000000003')), true, true) as r) x;
select is((select count(*)::int from public.signage_promotion_group_items where group_id = public.t_sf_id('finde')), 6, 'the folder stores its six elements');
select is((select count(*)::int from public.signage_promotion_group_items where group_id = public.t_sf_id('finde') and product_id is not null), 1, 'one of them is a product with no promotion');
select is((public.get_signage_folders() -> 0 ->> 'name') || '/' || (public.get_signage_folders() -> 0 ->> 'generateFeed') || '/' || (public.get_signage_folders() -> 0 ->> 'generateStory') || '/' || jsonb_array_length(public.get_signage_folders() -> 0 -> 'items'),
  'Ofertas finde/true/true/6', 'the list returns name, formats and number of elements');
select is(public.get_signage_folders() -> 0 -> 'items' -> 5 ->> 'name', 'Costilla de cerdo', 'a product element carries its product name');
select is(public.get_signage_folders() -> 0 -> 'items' -> 0 ->> 'name', 'Pata muslo', 'a promotion element carries the name of its product');
select throws_ok($$select public.save_signage_folder(null, 'OFERTAS finde', jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001')), true, true)$$, '22023', null, 'a second folder with the same name (any case) is rejected');
select throws_ok($$select public.save_signage_folder(null, '   ', jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001')), true, true)$$, '22023', null, 'a blank name is rejected');
select throws_ok($$select public.save_signage_folder(null, 'Vacía', '[]'::jsonb, true, true)$$, '22023', null, 'a folder without elements is rejected');
select throws_ok($$select public.save_signage_folder(null, 'Sin formato', jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001')), false, false)$$, '22023', null, 'a folder needs at least one format');
select throws_ok($$select public.save_signage_folder(null, 'Repetida', jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001'), jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001')), true, true)$$, '22023', null, 'a repeated promotion is rejected');
select throws_ok($$select public.save_signage_folder(null, 'Rara', jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', '96000000-0000-4000-8000-000000000001')), true, true)$$, '22023', null, 'an unknown element kind is rejected');
select throws_ok($$select public.save_signage_folder(null, 'Ajena', jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000009')), true, true)$$, '42501', null, 'a promotion of ANOTHER organization cannot be added');
select throws_ok($$select public.save_signage_folder(null, 'Ajeno', jsonb_build_array(jsonb_build_object('kind', 'PRODUCT', 'id', '95000000-0000-4000-8000-000000000009')), true, true)$$, '42501', null, 'nor a product of another organization');
select throws_ok($$select public.save_signage_folder('96000000-0000-4000-8000-0000000000aa', 'Fantasma', jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001')), true, true)$$, '42501', null, 'editing an unknown folder is rejected');
select is((select count(*)::int from public.signage_promotion_groups), 1, 'every rejected attempt left the folders alone');

-- Renombrar, quitar un elemento, agregar otro y reordenar (la misma función: reemplaza la lista ordenada) + sólo Feed.
select lives_ok($$select public.save_signage_folder(public.t_sf_id('finde'), 'Ofertas del finde', jsonb_build_array(
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000004'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000002'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000003'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000006'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000005')), true, false)$$, 'a folder can be renamed, reordered and edited');
select is((select string_agg(f ->> 'name', ' | ' order by ord) from jsonb_array_elements(public.get_signage_folders() -> 0 -> 'items') with ordinality as t(f, ord)),
  'Matambre | Pata muslo | Costilla de cerdo | Coca Cola | Pata muslo | Chorizo', 'the new order is kept, the removed product is gone and the added promotion is there');
select is((public.get_signage_folders() -> 0 ->> 'name') || '/' || (public.get_signage_folders() -> 0 ->> 'generateFeed') || '/' || (public.get_signage_folders() -> 0 ->> 'generateStory'), 'Ofertas del finde/true/false', 'the name and the Feed-only format were saved');
select is((select count(*)::int from public.signage_promotion_groups), 1, 'renaming did not create a second folder');
select lives_ok($$select public.save_signage_folder(public.t_sf_id('finde'), 'Ofertas finde', jsonb_build_array(
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000002'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000003'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000004'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000006'),
  jsonb_build_object('kind', 'PRODUCT', 'id', '95000000-0000-4000-8000-000000000003')), true, true)$$, 'and restored');

-- ---------------------------------------------------------------------------------------------
-- Hechos VIGENTES de la carpeta: promoción vencida, sucursal, foto, lotes
-- ---------------------------------------------------------------------------------------------
select is(public.t_sf_facts('finde', '93000000-0000-4000-8000-000000000001'),
  'Pata muslo:OK | Costilla de cerdo:OK | Coca Cola:OK | Matambre:OK | Pata muslo:PROMO_EXPIRED | Costilla de cerdo:OK',
  'Avenida: the four live promotions and the loose product resolve; the expired promotion says so (never silently dropped)');
select is(public.t_sf_facts('finde', '93000000-0000-4000-8000-000000000002'),
  'Pata muslo:OK | Costilla de cerdo:NOT_IN_BRANCH | Coca Cola:OK | Matambre:OK | Pata muslo:PROMO_EXPIRED | Costilla de cerdo:OK',
  'Janssen: the Avenida-only promotion does not apply there, the loose product does');
select is(public.t_sf_facts('finde', null),
  'Pata muslo:OK | Costilla de cerdo:NOT_IN_BRANCH | Coca Cola:OK | Matambre:OK | Pata muslo:PROMO_EXPIRED | Costilla de cerdo:OK',
  'without a branch only global promotions apply');
select is(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') ->> 'branchName', 'PG Avenida', 'the facts name the branch');
select is(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') ->> 'itemCount', '6', 'and the number of elements');
select is((select count(*)::int from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001', array[
  (select i.id from public.signage_promotion_group_items i where i.group_id = public.t_sf_id('finde') and i.position = 1),
  (select i.id from public.signage_promotion_group_items i where i.group_id = public.t_sf_id('finde') and i.position = 3)]) -> 'items')), 2,
  'a batch can ask only for some elements (chunked generation)');
select is((select s -> 'promotion' ->> 'status' from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') -> 'items') s where s -> 'promotion' ->> 'promotionId' = '96000000-0000-4000-8000-000000000006'), 'EXPIRED', 'the expired promotion reports its status');
select ok((select (s -> 'promotion' ->> 'validUntil') is not null from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') -> 'items') s where s -> 'promotion' ->> 'promotionId' = '96000000-0000-4000-8000-000000000006'), 'with its end date');
select is((select s ->> 'listPriceCents' from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') -> 'items') s where s ->> 'name' = 'Pata muslo' limit 1), '1000000', 'the current list price comes with each element');
select ok((select jsonb_typeof(s -> 'photo') = 'null' from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') -> 'items') s where s ->> 'name' = 'Matambre'), 'a product without photo carries none (the Admin warns «Sin foto»)');
select is((select s -> 'photo' ->> 'storagePath' from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') -> 'items') s where s ->> 'name' = 'Pata muslo' limit 1),
  '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png', 'a product with photo carries its private Storage reference');
select ok(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001')::text !~* 'costCents|cost_cents|margin|stock', 'the facts never expose cost, margin or stock');
select throws_ok($$select public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000009')$$, '42501', null, 'a branch of another organization is rejected');
select is(public.get_signage_folder_facts('96000000-0000-4000-8000-0000000000aa'), null::jsonb, 'an unknown folder resolves to nothing');

-- El precio de una promoción cambia: la carpeta NO se toca y los hechos traen el valor nuevo.
select is((select s -> 'promotion' ->> 'packPriceCents' from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') -> 'items') s where s ->> 'name' = 'Costilla de cerdo' and jsonb_typeof(s -> 'promotion') = 'object'), '1400000', 'before: the pack costs $14.000');
reset role;
update public.product_weight_discounts set pack_price_cents = 1500000 where id = '96000000-0000-4000-8000-000000000002';
set local role authenticated;
select is((select s -> 'promotion' ->> 'packPriceCents' from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') -> 'items') s where s ->> 'name' = 'Costilla de cerdo' and jsonb_typeof(s -> 'promotion') = 'object'), '1500000', 'after changing the promotion the same folder resolves $15.000 (no snapshot)');
select is((select count(*)::int from public.signage_promotion_group_items where group_id = public.t_sf_id('finde')), 6, 'and the folder was not modified');
-- Una promoción desactivada (no vencida por fecha): se distingue de la vencida.
reset role;
update public.product_weight_discounts set active = false where id = '96000000-0000-4000-8000-000000000004';
set local role authenticated;
select is((select s -> 'promotion' ->> 'active' || '/' || (s -> 'promotion' ->> 'status') || '/' || coalesce(s ->> 'unavailableReason', '') from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') -> 'items') s where s -> 'promotion' ->> 'promotionId' = '96000000-0000-4000-8000-000000000004'),
  'false/EXPIRED/PROMO_EXPIRED', 'a deactivated promotion reports active = false (the Admin shows «Inactiva») and is not playable');
reset role;
update public.product_weight_discounts set active = true where id = '96000000-0000-4000-8000-000000000004';
set local role authenticated;

-- ---------------------------------------------------------------------------------------------
-- Aislamiento entre organizaciones
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.get_signage_folders(), '[]'::jsonb, 'another organization sees none of our folders');
select is(public.get_signage_folder_facts(public.t_sf_id('finde'), null), null::jsonb, 'nor resolves them');
select throws_ok($$select public.save_signage_folder(public.t_sf_id('finde'), 'Robada', jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000009')), true, true)$$, '42501', null, 'nor edits them');
select throws_ok($$select public.delete_signage_folder(public.t_sf_id('finde'))$$, '42501', null, 'nor deletes them');
select throws_ok($$select public.save_signage_folder(null, 'Mezcla', jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001')), true, true)$$, '42501', null, 'nor puts our promotion in its own folder');
insert into public.t_sf_keep select 'b-folder', (r ->> 'id')::uuid, null from (select public.save_signage_folder(null, 'Ofertas finde', jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000009')), true, true) as r) x;
select is(jsonb_array_length(public.get_signage_folders()), 1, 'it can have its own folder with the same name');
insert into public.t_sf_keep select 'b-display', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_signage_display('TV B', null) as r) x;
select throws_ok($$select public.save_signage_display_source(public.t_sf_id('b-display'), 'TV B', null, 8, true, 'FOLDER', public.t_sf_id('finde'))$$, '42501', null, 'a screen cannot use a folder of another organization');
select lives_ok($$select public.save_signage_display_source(public.t_sf_id('b-display'), 'TV B', null, 8, true, 'FOLDER', public.t_sf_id('b-folder'))$$, 'but can use its own');
select is(public.t_sf_tv('b-display'), 'Producto de otra org', 'its TV plays only its own folder content');
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Pantallas: la fuente por defecto es «todas las promociones activas»
-- ---------------------------------------------------------------------------------------------
insert into public.t_sf_keep select 'avenida', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_signage_display('TV Avenida', '93000000-0000-4000-8000-000000000001') as r) x;
insert into public.t_sf_keep select 'janssen', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_signage_display('TV Janssen', '93000000-0000-4000-8000-000000000002') as r) x;
insert into public.t_sf_keep select 'global', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_signage_display('TV Global', null) as r) x;
select is((select content_source from public.digital_signage_displays where id = public.t_sf_id('avenida')), 'ALL_PROMOTIONS', 'a new screen plays every active promotion by default (nothing to configure)');
select is((select folder_id from public.digital_signage_displays where id = public.t_sf_id('avenida')), null::uuid, 'without a folder');
select is(public.t_sf_tv('avenida'), 'Chorizo | Coca Cola | Costilla de cerdo | Matambre | Pata muslo',
  'Avenida plays its 5 active promotions with no slide loaded by hand (no Janssen-only, expired, upcoming or other-organization promotion)');
select is(public.t_sf_tv('janssen'), 'Coca Cola | Costilla de cerdo | Matambre | Pata muslo', 'Janssen plays its own (Costilla 5 % from 3 kg), not the Avenida pack, and not Chorizo (not sold there)');
select is(public.t_sf_reasons('janssen'), 'Coca Cola:OK | Costilla de cerdo:OK | Matambre:OK | Pata muslo:OK', 'the editor of an all-promotions screen lists only what applies to its branch (not the Avenida pack nor Chorizo, which Janssen does not sell)');
select is(public.t_sf_tv('global'), 'Chorizo | Coca Cola | Matambre | Pata muslo', 'a screen with no branch plays only the global promotions');
select is((select s -> 'promotion' ->> 'packPriceCents' from jsonb_array_elements(public.get_signage_display(public.t_sf_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Costilla de cerdo'), '1500000', 'each slide resolves the CURRENT promotion (the edited $15.000)');
select is((select s -> 'promotion' ->> 'status' from jsonb_array_elements(public.get_signage_display(public.t_sf_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Coca Cola'), 'ACTIVE', 'and reports it active');
select is(public.t_sf_reasons('avenida'), 'Chorizo:OK | Coca Cola:OK | Costilla de cerdo:OK | Matambre:OK | Pata muslo:OK', 'the editor sees the same list (no non-applicable promotion is listed)');
select ok(public.get_signage_display(public.t_sf_tok('avenida'))::text !~* 'costCents|cost_cents|margin|stock|"sku"|"productId"', 'the public payload never exposes cost, margin, stock, SKU or product ids');
select is((select s ->> 'packSizeUnits' from jsonb_array_elements(public.get_signage_display(public.t_sf_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Coca Cola'), null, 'a product without pack carries no pack facts');

-- Una promoción NUEVA aparece sola; una editada cambia; una vencida, desactivada o futura no se reproduce.
reset role;
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('95000000-0000-4000-8000-000000000006', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'Bife de chorizo', 'pg-bife', 'PG-06', 'WEIGHT', true, 'SELLABLE'),
  ('95000000-0000-4000-8000-000000000007', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'Zapallo sin precio', 'pg-zapallo', 'PG-07', 'WEIGHT', true, 'SELLABLE');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select '92000000-0000-4000-8000-000000000001', b.id, p.id from public.branches b cross join public.products p
where b.organization_id = '92000000-0000-4000-8000-000000000001' and p.id in ('95000000-0000-4000-8000-000000000006', '95000000-0000-4000-8000-000000000007');
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000006', null, 1500000, now() - interval '5 day');
insert into public.product_artwork_photos (product_id, organization_id, storage_path, content_type, size_bytes) values
  ('95000000-0000-4000-8000-000000000006', '92000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000006/c1000000-0000-4000-8000-000000000006.png', 'image/png', 1200);
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_sf_tv('avenida'), 'Chorizo | Coca Cola | Costilla de cerdo | Matambre | Pata muslo', 'a product without promotion does not appear by itself');
reset role;
insert into public.product_weight_discounts (id, organization_id, product_id, branch_id, promotion_mode, pack_quantity_grams, pack_price_cents, valid_from, valid_until) values
  ('96000000-0000-4000-8000-000000000010', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000006', null, 'PACK_FIXED_TOTAL', 2000, 2400000, now() - interval '1 hour', null),
  ('96000000-0000-4000-8000-000000000011', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000007', null, 'PACK_FIXED_TOTAL', 1000, 500000, now() - interval '1 hour', null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_sf_tv('avenida'), 'Bife de chorizo | Chorizo | Coca Cola | Costilla de cerdo | Matambre | Pata muslo', 'a NEW promotion shows up on the TV by itself, without touching the screen');
select is(public.t_sf_tv('global'), 'Bife de chorizo | Chorizo | Coca Cola | Matambre | Pata muslo', 'on every compatible screen');
select is(public.t_sf_reasons('avenida'), 'Bife de chorizo:OK | Chorizo:OK | Coca Cola:OK | Costilla de cerdo:OK | Matambre:OK | Pata muslo:OK | Zapallo sin precio:NO_PRICE',
  'a live promotion whose product has no price is listed for the editor with its reason (never a $0 slide)');
select ok(public.t_sf_tv('avenida') !~ 'Zapallo', 'and the TV does not play it');
reset role;
update public.product_weight_discounts set pack_price_cents = 2200000 where id = '96000000-0000-4000-8000-000000000010';
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select s -> 'promotion' ->> 'packPriceCents' from jsonb_array_elements(public.get_signage_display(public.t_sf_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Bife de chorizo'), '2200000', 'an EDITED promotion shows the new price on the next poll');
reset role;
update public.product_weight_discounts set valid_until = now() - interval '1 minute', valid_from = now() - interval '2 day' where id = '96000000-0000-4000-8000-000000000010';
update public.product_weight_discounts set active = false where id = '96000000-0000-4000-8000-000000000005';
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_sf_tv('avenida'), 'Coca Cola | Costilla de cerdo | Matambre | Pata muslo', 'an expired promotion (Bife) and a deactivated one (Chorizo) disappear; the upcoming one (Matambre pack) never appeared');
select ok(public.t_sf_reasons('avenida') !~ 'Bife|Chorizo', 'and they are not even listed as non-applicable');
reset role;
update public.product_weight_discounts set active = true where id = '96000000-0000-4000-8000-000000000005';
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select ok(public.t_sf_tv('avenida') ~ 'Chorizo', 'reactivating a promotion brings it back');

-- ---------------------------------------------------------------------------------------------
-- Fuente = carpeta
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.save_signage_display_source(public.t_sf_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 8, true, 'FOLDER', null)$$, '22023', null, 'the folder source needs a folder');
select throws_ok($$select public.save_signage_display_source(public.t_sf_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 8, true, 'ALL_PROMOTIONS', public.t_sf_id('finde'))$$, '22023', null, 'a folder only makes sense with the folder source');
select throws_ok($$select public.save_signage_display_source(public.t_sf_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 8, true, 'MANUAL', null)$$, '22023', null, 'the old hand-made list cannot be chosen again');
select throws_ok($$select public.save_signage_display_source(public.t_sf_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 2, true, 'ALL_PROMOTIONS', null)$$, '22023', null, 'the duration keeps its limits');
select throws_ok($$select public.save_signage_display_source(public.t_sf_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000009', 8, true, 'ALL_PROMOTIONS', null)$$, '42501', null, 'a branch of another organization is rejected');
select throws_ok($$select public.save_signage_display_source(public.t_sf_id('avenida'), 'TV Avenida', null, 8, true, 'FOLDER', '96000000-0000-4000-8000-0000000000aa')$$, '42501', null, 'an unknown folder is rejected');
select lives_ok($$select public.save_signage_display_source(public.t_sf_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 10, true, 'FOLDER', public.t_sf_id('finde'))$$, 'Avenida can play a folder');
select is((select content_source || '/' || (folder_id = public.t_sf_id('finde'))::text || '/' || slide_duration_seconds from public.digital_signage_displays where id = public.t_sf_id('avenida')), 'FOLDER/true/10', 'the source, folder and duration were saved');
select is(public.t_sf_tv('avenida'), 'Pata muslo | Costilla de cerdo | Coca Cola | Matambre | Costilla de cerdo',
  'the TV plays ONLY the folder: its active promotions in order and the loose product; the expired promotion is skipped');
select is(public.t_sf_reasons('avenida'), 'Pata muslo:OK | Costilla de cerdo:OK | Coca Cola:OK | Matambre:OK | Pata muslo:PROMO_EXPIRED | Costilla de cerdo:OK', 'the editor keeps the expired reference with its reason');
select is((select s ->> 'kind' from jsonb_array_elements(public.get_signage_display(public.t_sf_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Costilla de cerdo' and s -> 'promotion' = 'null'::jsonb limit 1), 'PRODUCT', 'the loose product plays as a plain price slide');
select is((select count(*)::int from public.digital_signage_slides where display_id = public.t_sf_id('avenida')), 0, 'no hand-made slide exists: the folder is the source of truth');
-- Janssen sobre la misma carpeta: la promoción de Avenida no aplica.
select lives_ok($$select public.save_signage_display_source(public.t_sf_id('janssen'), 'TV Janssen', '93000000-0000-4000-8000-000000000002', 8, true, 'FOLDER', public.t_sf_id('finde'))$$, 'the same folder is reused by another screen');
select is(public.t_sf_tv('janssen'), 'Pata muslo | Coca Cola | Matambre | Costilla de cerdo', 'Janssen skips the Avenida-only promotion and keeps the rest');
-- La carpeta cambia: se quita una promoción y se agrega otra; las pantallas lo toman sin tocar nada más.
select lives_ok($$select public.save_signage_folder(public.t_sf_id('finde'), 'Ofertas finde', jsonb_build_array(
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000001'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000002'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000004'),
  jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000005')), true, true)$$, 'a promotion is removed from the folder and another one added');
select is(public.t_sf_tv('avenida'), 'Pata muslo | Costilla de cerdo | Matambre | Chorizo', 'the TV follows the folder: the removed one stops and the new one plays');
reset role;
update public.product_weight_discounts set pack_price_cents = 1600000 where id = '96000000-0000-4000-8000-000000000002';
update public.product_weight_discounts set valid_until = now() - interval '1 minute', valid_from = now() - interval '2 day' where id = '96000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select s -> 'promotion' ->> 'packPriceCents' from jsonb_array_elements(public.get_signage_display(public.t_sf_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Costilla de cerdo'), '1600000', 'a price change inside the folder reaches the TV without editing the folder');
select is(public.t_sf_tv('avenida'), 'Costilla de cerdo | Matambre | Chorizo', 'and a promotion that expires stops playing while the folder keeps the reference');
select is((select count(*)::int from public.signage_promotion_group_items where group_id = public.t_sf_id('finde')), 4, 'the folder still holds its four references');
select is((select count(*)::int from public.signage_promotion_group_items where group_id = public.t_sf_id('finde') and promotion_id = '96000000-0000-4000-8000-000000000001'), 1, 'including the expired promotion');

-- ---------------------------------------------------------------------------------------------
-- Eliminar una carpeta: sólo si ninguna pantalla la usa
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.delete_signage_folder(public.t_sf_id('finde'))$$, '23503',
  'La carpeta «Ofertas finde» está en uso en 2 pantalla(s): TV Avenida, TV Janssen. Cambiá la fuente de esas pantallas antes de eliminarla',
  'a folder used as a screen source cannot be deleted, and the refusal names the screens that use it');
insert into public.t_sf_keep select 'solo', (r ->> 'id')::uuid, null from (select public.save_signage_folder(null, 'Para borrar', jsonb_build_array(jsonb_build_object('kind', 'PRODUCT', 'id', '95000000-0000-4000-8000-000000000001')), true, true) as r) x;
select lives_ok($$select public.delete_signage_folder(public.t_sf_id('solo'))$$, 'an unused folder can be deleted');
select is((select count(*)::int from public.signage_promotion_group_items where group_id = public.t_sf_id('solo')), 0, 'with its elements');
select is((select count(*)::int from public.products where id = '95000000-0000-4000-8000-000000000001'), 1, 'and never the products');
select is((select count(*)::int from public.product_weight_discounts), 10, 'nor the promotions (the 10 of this organization)');

-- ---------------------------------------------------------------------------------------------
-- Pantalla anterior (lista manual): sigue igual hasta que se elija otra fuente
-- ---------------------------------------------------------------------------------------------
insert into public.t_sf_keep select 'manual', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_signage_display('TV manual', '93000000-0000-4000-8000-000000000001') as r) x;
select lives_ok($$select public.save_signage_display(public.t_sf_id('manual'), 'TV manual', '93000000-0000-4000-8000-000000000001', 8, true, array['95000000-0000-4000-8000-000000000001']::uuid[])$$, 'the old RPC still saves a hand-made list');
select is((select content_source from public.digital_signage_displays where id = public.t_sf_id('manual')), 'MANUAL', 'and the screen keeps playing exactly that list');
select is(public.t_sf_tv('manual'), 'Pata muslo', 'only the hand-made list plays');
select is((select (o ->> 'legacyEntries')::int from jsonb_array_elements(public.get_signage_displays_overview()) o where o ->> 'name' = 'TV manual'), 1, 'the overview reports the old list so the Admin can offer the switch');
select is((select (e ->> 'manualEntriesDropped')::int from (select public.save_signage_display_source(public.t_sf_id('manual'), 'TV manual', '93000000-0000-4000-8000-000000000001', 8, true, 'ALL_PROMOTIONS', null) as e) x), 1, 'switching to promotions drops the old list');
select is(public.t_sf_tv('manual'), 'Chorizo | Coca Cola | Costilla de cerdo | Matambre', 'and now it plays the active promotions of its branch');

-- ---------------------------------------------------------------------------------------------
-- Resumen de pantallas (una sola llamada)
-- ---------------------------------------------------------------------------------------------
select is(jsonb_array_length(public.get_signage_displays_overview()), 4, 'the overview lists the 4 screens of the organization (never another one)');
select is((select o ->> 'contentSource' || '/' || (o ->> 'folderName') || '/' || (o ->> 'playable') || '/' || (o ->> 'blocked') || '/' || (o ->> 'withoutPhoto') from jsonb_array_elements(public.get_signage_displays_overview()) o where o ->> 'name' = 'TV Avenida'),
  'FOLDER/Ofertas finde/3/1/2', 'Avenida: folder source, 3 promotions playing today, 1 blocked (the expired one) and 2 without photo (Matambre, Chorizo)');
select is((select o ->> 'contentSource' || '/' || (o ->> 'playable') || '/' || (o ->> 'blocked') || '/' || (o ->> 'withoutPhoto') from jsonb_array_elements(public.get_signage_displays_overview()) o where o ->> 'name' = 'TV Global'),
  'ALL_PROMOTIONS/3/1/2', 'Global: all-promotions source, 3 playing, 1 blocked (no price) and 2 without photo');
select ok(public.get_signage_displays_overview()::text !~* 'token_hash|tokenHash|"token"', 'the overview never carries a token or hash');

-- ---------------------------------------------------------------------------------------------
-- Fotos: el bucket sigue privado; sólo se publica la de lo que una pantalla habilitada reproduce HOY
-- ---------------------------------------------------------------------------------------------
reset role;
select ok(public.signage_object_is_published('92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000002/c1000000-0000-4000-8000-000000000002.png'), 'the photo of a product with a live promotion on an all-promotions screen is readable by the TV');
select ok(public.signage_object_is_published('92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000003/c1000000-0000-4000-8000-000000000003.png'), 'and the one of a folder promotion');
select ok(not public.signage_object_is_published('92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000006/c1000000-0000-4000-8000-000000000006.png'), 'the photo of a product whose promotion already expired is NOT published (no screen shows it any more)');
select ok(public.signage_object_is_published('92000000-0000-4000-8000-000000000002/95000000-0000-4000-8000-000000000009/c1000000-0000-4000-8000-000000000009.png'), 'the photo of another organization is published only because ITS OWN screen plays it');
select ok(not public.signage_object_is_published('92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-0000000000ff/c1000000-0000-4000-8000-0000000000ff.png'), 'an unknown path is never published');
update public.digital_signage_displays set enabled = false where organization_id = '92000000-0000-4000-8000-000000000001';
select ok(not public.signage_object_is_published('92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000002/c1000000-0000-4000-8000-000000000002.png'), 'with every screen disabled no photo is published');
update public.digital_signage_displays set enabled = true where organization_id = '92000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------------------------
-- Token incorrecto y aislamiento público
-- ---------------------------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(public.get_signage_display('0000000000000000000000000000000000000000000000000000000000000000'), null::jsonb, 'an unknown token reads nothing');
select is(public.get_signage_display('not-a-token'), null::jsonb, 'nor a malformed one');
select ok(public.get_signage_display(public.t_sf_tok('b-display'))::text !~ 'Pata muslo|Matambre|Coca', 'the Org B token never returns content of another organization');
select ok(public.get_signage_display(public.t_sf_tok('global'))::text !~ 'Producto de otra org', 'and ours never returns theirs');
select throws_ok($$select * from public.signage_promotion_group_items$$, '42501', null, 'the folder items stay unreadable for anonymous');
select throws_ok($$select public.get_signage_folders()$$, '42501', null, 'and so does the folder list');

-- ---------------------------------------------------------------------------------------------
-- Transparencia de la foto (has_alpha) y datos del pack del producto
-- ---------------------------------------------------------------------------------------------
reset role;
select is((select has_alpha from public.product_artwork_photos where product_id = '95000000-0000-4000-8000-000000000001'), null::boolean, 'a PNG photo starts with the alpha unknown (treated as opaque)');
select ok(not has_function_privilege('anon', 'public.set_product_artwork_photo_alpha(uuid,text,boolean)', 'EXECUTE'), 'anonymous cannot record the transparency of a photo');
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_product_artwork_photo_alpha('95000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png', true)$$, '42501', null, 'an employee (no catalog.write) cannot record it');
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.set_product_artwork_photo_alpha('95000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png', true) ->> 'updated'), 'true', 'the admin records that the photo is a transparent cutout');
select is((select s -> 'photo' ->> 'hasAlpha' from jsonb_array_elements(public.get_signage_folder_facts(public.t_sf_id('finde'), '93000000-0000-4000-8000-000000000001') -> 'items') s where s ->> 'name' = 'Pata muslo' limit 1), 'true', 'the folder facts carry it (the piece draws the yellow blob behind a cutout)');
select is(public.get_product_artwork('95000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001') -> 'photo' ->> 'hasAlpha', 'true', 'and so do the facts of an individual piece');
select is((public.set_product_artwork_photo_alpha('95000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/otra-foto.png', false) ->> 'updated'), 'false', 'a value computed for a photo that is no longer the current one is not recorded');
select throws_ok($$select public.set_product_artwork_photo_alpha('95000000-0000-4000-8000-000000000001', 'x', null)$$, '22023', null, 'a missing value is rejected');
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((public.set_product_artwork_photo_alpha('95000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png', false) ->> 'updated'), 'false', 'another organization cannot change it');
reset role;
select is((select has_alpha from public.product_artwork_photos where product_id = '95000000-0000-4000-8000-000000000001'), true, 'and the value stays');
update public.product_artwork_photos set storage_path = '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-0000000000f1.png' where product_id = '95000000-0000-4000-8000-000000000001';
select is((select has_alpha from public.product_artwork_photos where product_id = '95000000-0000-4000-8000-000000000001'), null::boolean, 'replacing the photo forgets the value (it is a different file)');
update public.product_artwork_photos set storage_path = '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png' where product_id = '95000000-0000-4000-8000-000000000001';
-- Un producto por unidad con pack: los hechos del pack llegan a la pieza y a la carpeta; un producto por peso no los lleva.
update public.products set pack_size_units = 6, pack_discount_bps = 2000 where id = '95000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.get_product_artwork('95000000-0000-4000-8000-000000000002', '93000000-0000-4000-8000-000000000001') ->> 'packSizeUnits') || '/' || (public.get_product_artwork('95000000-0000-4000-8000-000000000002', '93000000-0000-4000-8000-000000000001') ->> 'packDiscountBps'), '6/2000', 'a unit product with a pack carries its pack facts in the individual piece');
select is(public.get_product_artwork('95000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001') ->> 'packSizeUnits', null, 'a weight product does not');
select is((select s ->> 'packSizeUnits' from jsonb_array_elements(public.get_signage_display_admin(public.t_sf_id('global')) -> 'slides') s where s ->> 'name' = 'Coca Cola' limit 1), '6', 'the screen facts (same resolver as the folders) carry the pack of a unit product');
select is(public.t_sf_tv('global') ~ 'Coca Cola', true, 'and the TV keeps playing the promotion of that product');

-- ---------------------------------------------------------------------------------------------
-- «Todas las promociones activas» = SÓLO las promociones EXPLÍCITAS creadas en el módulo Promociones (product_weight_discounts).
-- Las reglas globales de pricing (escalones «llevando N», Packs de producto) siguen valiendo en el POS pero NO generan diapositivas.
-- ---------------------------------------------------------------------------------------------
reset role;
-- 0a Azúcar JL 1KG ($1.650, Pack 10 u 25 %), 0b Galletitas ($1.000, sólo escalones), 0c Fideos ($900, sólo Pack 6 u 10 %): reglas de pricing, SIN promoción.
-- 0e/0f/0g/0h: promociones creadas a mano (HAMBURGUESA POLLO 12 u $8.900 global, HAMBURGUESA CERDO 12 u $15.000 sólo Avenida, CHICHARRON 1 u $10.000, MIXTA vencida).
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role, pack_size_units, pack_discount_bps) values
  ('95000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'AZUCAR JL 1KG', 'pg-azucar', 'PG-0A', 'UNIT', true, 'SELLABLE', 10, 2500),
  ('95000000-0000-4000-8000-00000000000b', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'Galletitas', 'pg-galletitas', 'PG-0B', 'UNIT', true, 'SELLABLE', null, null),
  ('95000000-0000-4000-8000-00000000000c', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'Fideos', 'pg-fideos', 'PG-0C', 'UNIT', true, 'SELLABLE', 6, 1000),
  ('95000000-0000-4000-8000-00000000000e', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'HAMBURGUESA POLLO', 'pg-hamb-pollo', 'PG-0E', 'UNIT', true, 'SELLABLE', null, null),
  ('95000000-0000-4000-8000-00000000000f', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'HAMBURGUESA CERDO', 'pg-hamb-cerdo', 'PG-0F', 'UNIT', true, 'SELLABLE', null, null),
  ('95000000-0000-4000-8000-000000000010', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'CHICHARRON BOLSA 5KG', 'pg-chicharron', 'PG-10', 'UNIT', true, 'SELLABLE', null, null),
  ('95000000-0000-4000-8000-000000000011', '92000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'HAMBURGUESA MIXTA', 'pg-hamb-mixta', 'PG-11', 'UNIT', true, 'SELLABLE', null, null);
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where p.id in ('95000000-0000-4000-8000-00000000000a', '95000000-0000-4000-8000-00000000000b', '95000000-0000-4000-8000-00000000000c',
  '95000000-0000-4000-8000-00000000000e', '95000000-0000-4000-8000-00000000000f', '95000000-0000-4000-8000-000000000010', '95000000-0000-4000-8000-000000000011');
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from)
select '92000000-0000-4000-8000-000000000001', x.id, null, x.cents, now() - interval '5 day' from (values
  ('95000000-0000-4000-8000-00000000000a'::uuid, 165000), ('95000000-0000-4000-8000-00000000000b', 100000), ('95000000-0000-4000-8000-00000000000c', 90000),
  ('95000000-0000-4000-8000-00000000000e', 90000), ('95000000-0000-4000-8000-00000000000f', 130000), ('95000000-0000-4000-8000-000000000010', 1100000),
  ('95000000-0000-4000-8000-000000000011', 90000)) as x(id, cents);
-- Reglas globales: escalones 3 u 15 % y 5 u 20 % (Avenida y la organización).
insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps) values
  ('92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 3, 1500),
  ('92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 5, 2000);
insert into public.organization_quantity_discount_tiers (organization_id, minimum_units, discount_bps) values
  ('92000000-0000-4000-8000-000000000001', 3, 1500), ('92000000-0000-4000-8000-000000000001', 5, 2000);
reset role;
create function public.t_sf_slide(p_name text, p_product text) returns jsonb language sql stable as $$
  select s from jsonb_array_elements(public.get_signage_display(public.t_sf_tok(p_name)) -> 'slides') s where s ->> 'name' = p_product limit 1 $$;
grant execute on function public.t_sf_slide(text, text) to authenticated, anon;
-- Antes de crear promociones manuales: sólo con reglas globales, NADA de eso se reproduce.
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.save_signage_display_source(public.t_sf_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 8, true, 'ALL_PROMOTIONS', null);
select public.save_signage_display_source(public.t_sf_id('janssen'), 'TV Janssen', '93000000-0000-4000-8000-000000000002', 8, true, 'ALL_PROMOTIONS', null);
select is(public.t_sf_tv('avenida') ~ 'Galletitas', false, 'a product with only the global 3u/5u tiers does NOT play (Avenida has those tiers)');
select is(public.t_sf_tv('avenida') ~ 'AZUCAR|Fideos', false, 'nor one with only a product Pack / pricing config and no explicit promotion');
select is(public.t_sf_tv('global') ~ 'AZUCAR|Fideos|Galletitas', false, 'nor on a screen with no branch (organization tiers)');
select is(public.t_sf_tv('avenida'), 'Chorizo | Coca Cola | Costilla de cerdo | Matambre', 'the TV keeps playing exactly the explicit promotions, however many global rules exist');
select is(public.t_sf_slide('avenida', 'Coca Cola') -> 'bulkTiers', '[{"minimumUnits":3,"discountBps":1500},{"minimumUnits":5,"discountBps":2000}]'::jsonb, 'the global rules still reach the slide facts (the POS pricing is untouched)');
-- Promociones creadas a mano: aparecen solas.
reset role;
insert into public.product_weight_discounts (id, organization_id, product_id, branch_id, promotion_mode, pack_quantity_units, pack_price_cents, valid_from, valid_until) values
  ('96000000-0000-4000-8000-000000000020', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-00000000000e', null, 'PACK_FIXED_TOTAL', 12, 890000, now() - interval '1 hour', null),
  ('96000000-0000-4000-8000-000000000021', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-00000000000f', '93000000-0000-4000-8000-000000000001', 'PACK_FIXED_TOTAL', 12, 1500000, now() - interval '1 hour', null),
  ('96000000-0000-4000-8000-000000000022', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000010', null, 'PACK_FIXED_TOTAL', 1, 1000000, now() - interval '1 hour', null),
  ('96000000-0000-4000-8000-000000000023', '92000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000011', null, 'PACK_FIXED_TOTAL', 12, 800000, now() - interval '10 day', now() - interval '1 day');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_sf_tv('avenida'), 'CHICHARRON BOLSA 5KG | Chorizo | Coca Cola | Costilla de cerdo | HAMBURGUESA CERDO | HAMBURGUESA POLLO | Matambre', 'several active manual promotions play together with the existing ones (global, Avenida, 1 u)');
select is(public.t_sf_tv('janssen') ~ 'HAMBURGUESA POLLO' and public.t_sf_tv('janssen') ~ 'CHICHARRON', true, 'a global promotion plays in every branch');
select is(public.t_sf_tv('janssen') ~ 'HAMBURGUESA CERDO', false, 'a promotion of ANOTHER branch does not play');
select is(public.t_sf_tv('avenida') ~ 'MIXTA', false, 'an expired manual promotion does not play');
select is(public.t_sf_tv('global') ~ 'HAMBURGUESA POLLO', true, 'a screen with no branch plays the global ones');
select is(public.t_sf_tv('global') ~ 'HAMBURGUESA CERDO', false, 'but not a branch-only promotion');
select is(public.t_sf_tv('b-display') ~ 'HAMBURGUESA|CHICHARRON', false, 'another organization never sees them');
select is((public.t_sf_slide('avenida', 'HAMBURGUESA POLLO') -> 'promotion' ->> 'packQuantityUnits') || '/' || (public.t_sf_slide('avenida', 'HAMBURGUESA POLLO') -> 'promotion' ->> 'packPriceCents'), '12/890000', 'the slide carries the promotion as created: 12 u for $8.900');
select ok(public.get_signage_display(public.t_sf_tok('avenida'))::text !~* 'cost_cents|costCents|margin|organization_id|organizationId', 'the TV payload carries no costs or tenant ids');
-- Desactivación y cambio de producto.
reset role;
update public.product_weight_discounts set active = false, valid_until = now() where id = '96000000-0000-4000-8000-000000000020';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_sf_tv('avenida') ~ 'HAMBURGUESA POLLO', false, 'an inactivated manual promotion leaves the TV on the next read');
reset role;
delete from public.branch_product_assortment where branch_id = '93000000-0000-4000-8000-000000000001' and product_id = '95000000-0000-4000-8000-000000000010';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_sf_tv('avenida') ~ 'CHICHARRON', false, 'a promotion whose product is out of the branch assortment does not play');
reset role;
update public.products set active = false where id = '95000000-0000-4000-8000-00000000000f';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_sf_tv('avenida') ~ 'HAMBURGUESA CERDO', false, 'nor one whose product is deactivated');

select * from finish();
rollback;
