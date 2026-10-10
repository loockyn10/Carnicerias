begin;

create extension if not exists pgtap with schema extensions;
select plan(115);

-- Covers 202610190082 (D-084): promociones y GRUPOS de promociones en la cartelería de TV.
--   * una pantalla puede reproducir promociones ya cargadas (product_weight_discounts) y grupos de promociones, además de productos;
--   * el grupo es una selección ordenada: NO copia precio, nombre ni foto (cambiar el precio de la promoción se refleja solo);
--   * una promoción vencida / próxima / de otra sucursal / de un producto que la sucursal no vende se SALTEA;
--   * la foto sigue en el bucket privado: sólo se publica la de los productos que una pantalla habilitada puede mostrar.
-- Fixture (ids propios: prefijo 9): Org A con Avenida y Janssen, Org B con una sucursal; admin, empleado (sin catalog.write) y admin B.

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

create table public.t_pg_keep(name text primary key, id uuid, token text);
grant all on public.t_pg_keep to authenticated, anon;
create function public.t_pg_tok(p_name text) returns text language sql security definer as $$ select token from public.t_pg_keep where name = p_name $$;
create function public.t_pg_id(p_name text) returns uuid language sql security definer as $$ select id from public.t_pg_keep where name = p_name $$;
grant execute on function public.t_pg_tok(text), public.t_pg_id(text) to authenticated, anon;
-- Nombres de las diapositivas que reproduce el televisor de un token, en orden.
create function public.t_pg_tv(p_name text) returns text language sql stable as $$
  select coalesce(string_agg(s ->> 'name', ' | ' order by ord), '') from jsonb_array_elements(public.get_signage_display(public.t_pg_tok(p_name)) -> 'slides') with ordinality as t(s, ord) $$;
-- Motivos del editor: «nombre:motivo» por diapositiva (disponible = sin motivo), en orden.
create function public.t_pg_reasons(p_name text) returns text language sql stable as $$
  select coalesce(string_agg((s ->> 'name') || ':' || coalesce(s ->> 'unavailableReason', 'OK'), ' | ' order by ord), '')
  from jsonb_array_elements(public.get_signage_display_admin(public.t_pg_id(p_name)) -> 'slides') with ordinality as t(s, ord) $$;
grant execute on function public.t_pg_tv(text), public.t_pg_reasons(text) to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'signage_promotion_groups', 'the groups table exists');
select has_table('public', 'signage_promotion_group_items', 'the group items table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.signage_promotion_groups'::regclass), 'groups have RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.signage_promotion_group_items'::regclass), 'group items have RLS');
select ok(not has_table_privilege('anon', 'public.signage_promotion_groups', 'SELECT'), 'anonymous cannot read groups');
select ok(not has_table_privilege('anon', 'public.signage_promotion_group_items', 'SELECT'), 'anonymous cannot read group items');
select ok(not has_table_privilege('authenticated', 'public.signage_promotion_groups', 'INSERT'), 'browser clients cannot insert groups directly');
select ok(not has_table_privilege('authenticated', 'public.signage_promotion_group_items', 'DELETE'), 'nor delete group items');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name in ('signage_promotion_groups', 'signage_promotion_group_items') and column_name ~ 'price|cost|margin|name_snapshot|photo|image'),
  'groups store NO price, photo or product name: they point to the promotions (no snapshots)');
select ok(not has_function_privilege('anon', 'public.save_signage_group(uuid,text,uuid[])', 'EXECUTE'), 'anonymous cannot save groups');
select ok(not has_function_privilege('anon', 'public.delete_signage_group(uuid)', 'EXECUTE'), 'anonymous cannot delete groups');
select ok(not has_function_privilege('anon', 'public.get_signage_promotion_catalog(uuid,boolean)', 'EXECUTE'), 'anonymous cannot read the promotion catalog');
select ok(not has_function_privilege('anon', 'public.save_signage_display_entries(uuid,text,uuid,integer,boolean,jsonb)', 'EXECUTE'), 'anonymous cannot save screens');
select ok(not has_function_privilege('anon', 'app_private.signage_promotion_status(boolean,timestamptz,timestamptz,timestamptz)', 'EXECUTE'), 'the status helper is private');
select is(app_private.signage_promotion_status(true, now() - interval '1 day', null, now()), 'ACTIVE', 'an active promotion without end is ACTIVE');
select is(app_private.signage_promotion_status(true, now() + interval '1 day', null, now()), 'UPCOMING', 'one that has not started is UPCOMING');
select is(app_private.signage_promotion_status(true, now() - interval '3 day', now() - interval '1 day', now()), 'EXPIRED', 'one whose end passed is EXPIRED');
select is(app_private.signage_promotion_status(false, now() - interval '3 day', null, now()), 'EXPIRED', 'a deactivated one is EXPIRED too');

-- ---------------------------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.save_signage_group(null, 'Empleado', array['96000000-0000-4000-8000-000000000001']::uuid[])$$, '42501', null, 'an employee (no catalog.write) cannot create a group');
select throws_ok($$select public.delete_signage_group('96000000-0000-4000-8000-000000000001')$$, '42501', null, 'nor delete one');

-- ---------------------------------------------------------------------------------------------
-- Dos pantallas: Avenida (sucursal) y Global (sin sucursal)
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into public.t_pg_keep select 'avenida', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_signage_display('TV Avenida', '93000000-0000-4000-8000-000000000001') as r) x;
insert into public.t_pg_keep select 'global', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_signage_display('TV Global', null) as r) x;
insert into public.t_pg_keep select 'janssen', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_signage_display('TV Janssen', '93000000-0000-4000-8000-000000000002') as r) x;

-- ---------------------------------------------------------------------------------------------
-- Catálogo de promociones del editor: vigencia y sucursal
-- ---------------------------------------------------------------------------------------------
select is((select string_agg(p ->> 'productName' || ':' || (p ->> 'status'), ' | ' order by ord) from jsonb_array_elements(public.get_signage_promotion_catalog('93000000-0000-4000-8000-000000000001') -> 'promotions') with ordinality as t(p, ord)),
  'Chorizo:ACTIVE | Coca Cola:ACTIVE | Costilla de cerdo:ACTIVE | Matambre:ACTIVE | Pata muslo:ACTIVE | Matambre:UPCOMING | Pata muslo:EXPIRED',
  'Avenida sees its active promotions first, then upcoming and recently expired ones (never Janssen-only or another organization)');
select is((select count(*)::int from jsonb_array_elements(public.get_signage_promotion_catalog('93000000-0000-4000-8000-000000000001') -> 'promotions') p where p ->> 'status' = 'ACTIVE'), 5, 'five active promotions apply to Avenida');
select is((select string_agg(p ->> 'productName', ' | ' order by ord) from jsonb_array_elements(public.get_signage_promotion_catalog('93000000-0000-4000-8000-000000000002') -> 'promotions') with ordinality as t(p, ord) where p ->> 'status' = 'ACTIVE'),
  'Coca Cola | Costilla de cerdo | Matambre | Pata muslo', 'Janssen: its own promotion appears, Avenida-only does not, and Chorizo (not sold there) is excluded');
select is((select string_agg(p ->> 'productName', ' | ' order by ord) from jsonb_array_elements(public.get_signage_promotion_catalog(null) -> 'promotions') with ordinality as t(p, ord) where p ->> 'status' = 'ACTIVE'),
  'Chorizo | Coca Cola | Matambre | Pata muslo', 'a branch-less screen only offers global promotions');
select is(jsonb_array_length(public.get_signage_promotion_catalog(null, false) -> 'promotions'), 8, 'without the applicable filter every promotion of the organization is listed (8, never another organization)');
select is((select p ->> 'hasPhoto' from jsonb_array_elements(public.get_signage_promotion_catalog('93000000-0000-4000-8000-000000000001') -> 'promotions') p where p ->> 'productName' = 'Matambre' and p ->> 'status' = 'ACTIVE'), 'false', 'a promotion whose product has no photo is flagged (the editor shows «Sin foto»)');
select is((select p ->> 'hasPhoto' from jsonb_array_elements(public.get_signage_promotion_catalog('93000000-0000-4000-8000-000000000001') -> 'promotions') p where p ->> 'productName' = 'Pata muslo' and p ->> 'status' = 'ACTIVE'), 'true', 'and one with a photo is not');
select is((select p ->> 'listPriceCents' from jsonb_array_elements(public.get_signage_promotion_catalog('93000000-0000-4000-8000-000000000001') -> 'promotions') p where p ->> 'productName' = 'Pata muslo' and p ->> 'status' = 'ACTIVE'), '1000000', 'the catalog carries the current list price (the editor builds the offer text with the pricing engine)');
select is(public.get_signage_promotion_catalog(null) -> 'groups', '[]'::jsonb, 'no groups yet');

-- ---------------------------------------------------------------------------------------------
-- Grupos: crear, validar, reordenar
-- ---------------------------------------------------------------------------------------------
insert into public.t_pg_keep select 'finde', (r ->> 'id')::uuid, null from (select public.save_signage_group(null, 'Ofertas fin de semana', array[
  '96000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000002', '96000000-0000-4000-8000-000000000003', '96000000-0000-4000-8000-000000000004']::uuid[]) as r) x;
select is((select count(*)::int from public.signage_promotion_group_items where group_id = public.t_pg_id('finde')), 4, 'the group stores its four promotions');
select is((public.get_signage_promotion_catalog(null) -> 'groups' -> 0 -> 'promotionIds'), '["96000000-0000-4000-8000-000000000001", "96000000-0000-4000-8000-000000000002", "96000000-0000-4000-8000-000000000003", "96000000-0000-4000-8000-000000000004"]'::jsonb, 'the order of the selection is the order of the group');
select throws_ok($$select public.save_signage_group(null, 'ofertas FIN DE SEMANA', array['96000000-0000-4000-8000-000000000001']::uuid[])$$, '22023', null, 'a second group with the same name (any case) is rejected');
select throws_ok($$select public.save_signage_group(null, '   ', array['96000000-0000-4000-8000-000000000001']::uuid[])$$, '22023', null, 'a blank name is rejected');
select throws_ok($$select public.save_signage_group(null, 'Vacío', array[]::uuid[])$$, '22023', null, 'a group without promotions is rejected');
select throws_ok($$select public.save_signage_group(null, 'Repetidas', array['96000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000001']::uuid[])$$, '22023', null, 'a repeated promotion is rejected');
select throws_ok($$select public.save_signage_group(null, 'Ajena', array['96000000-0000-4000-8000-000000000009']::uuid[])$$, '42501', null, 'a promotion of ANOTHER organization cannot be added');
select throws_ok($$select public.save_signage_group('96000000-0000-4000-8000-0000000000aa', 'Fantasma', array['96000000-0000-4000-8000-000000000001']::uuid[])$$, '42501', null, 'editing an unknown group is rejected');
select is((select count(*)::int from public.signage_promotion_groups), 1, 'every rejected attempt left the groups alone');
insert into public.t_pg_keep select 'pollo', (r ->> 'id')::uuid, null from (select public.save_signage_group(null, 'Ofertas pollo', array['96000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000006']::uuid[]) as r) x;
select is((select count(*)::int from public.signage_promotion_groups), 2, 'another group can be created');

-- ---------------------------------------------------------------------------------------------
-- Pantalla Avenida = el grupo «Ofertas fin de semana»: las 4 promociones rotan, en orden, con foto y precio promocional
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 8, true,
  jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('finde'))))$$, 'the Avenida screen takes the group');
select is(public.t_pg_tv('avenida'), 'Pata muslo | Costilla de cerdo | Coca Cola | Matambre', 'the TV plays the 4 promotions in the order of the group');
select is((select string_agg(s ->> 'kind', ',') from jsonb_array_elements(public.get_signage_display(public.t_pg_tok('avenida')) -> 'slides') s), 'PROMOTION,PROMOTION,PROMOTION,PROMOTION', 'every slide is a promotion slide');
select is((select s -> 'promotion' ->> 'mode' || '/' || (s -> 'promotion' ->> 'minimumGrams') || '/' || (s -> 'promotion' ->> 'discountType') from jsonb_array_elements(public.get_signage_display(public.t_pg_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Pata muslo'),
  'THRESHOLD/2000/PERCENTAGE', 'a threshold promotion delivers its rule (the Admin prices it with the engine)');
select is((select s -> 'promotion' ->> 'packPriceCents' || '/' || (s -> 'promotion' ->> 'packQuantityGrams') from jsonb_array_elements(public.get_signage_display(public.t_pg_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Costilla de cerdo'),
  '1400000/2000', 'a pack promotion delivers its total price and quantity');
select is((select s ->> 'listPriceCents' from jsonb_array_elements(public.get_signage_display(public.t_pg_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Costilla de cerdo'), '800000', 'with the current list price (the «precio normal» context)');
select is((select s -> 'photo' ->> 'storagePath' from jsonb_array_elements(public.get_signage_display(public.t_pg_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Pata muslo'), '92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png', 'the photo reference travels with the slide (the file is read through the token route)');
select ok((select coalesce(s -> 'photo', 'null'::jsonb) = 'null'::jsonb from jsonb_array_elements(public.get_signage_display(public.t_pg_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Matambre'), 'a promotion without photo carries none (the renderer draws its fallback)');
select ok((select (s ->> 'slideId')::uuid = '96000000-0000-4000-8000-000000000001' from jsonb_array_elements(public.get_signage_display(public.t_pg_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Pata muslo'), 'a promotion slide is addressed by its promotion id (unique, used by the media route)');
select ok(public.get_signage_display(public.t_pg_tok('avenida'))::text !~* 'costCents|cost_cents|margin|stock', 'the public payload never exposes cost, margin or stock');
select is(public.t_pg_reasons('avenida'), 'Pata muslo:OK | Costilla de cerdo:OK | Coca Cola:OK | Matambre:OK', 'the editor sees the four as available');

-- La pantalla sin sucursal usa el MISMO grupo: la promoción de Avenida no aplica y se saltea.
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('global'), 'TV Global', null, 8, true,
  jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('finde'))))$$, 'the same group is reused by another screen');
select is(public.t_pg_tv('global'), 'Pata muslo | Coca Cola | Matambre', 'a branch-less screen skips the Avenida-only promotion');
select is(public.t_pg_reasons('global'), 'Pata muslo:OK | Costilla de cerdo:NOT_IN_BRANCH | Coca Cola:OK | Matambre:OK', 'and the editor says why');
-- Janssen: la promoción de Avenida no aparece, y los precios se resuelven para ESA sucursal.
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('janssen'), 'TV Janssen', '93000000-0000-4000-8000-000000000002', 8, true,
  jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('finde')), jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000008'),
    jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000005')))$$, 'Janssen takes the group plus two single promotions');
select is(public.t_pg_tv('janssen'), 'Pata muslo | Coca Cola | Matambre | Costilla de cerdo', 'Janssen skips the Avenida promotion and plays its own Costilla (5 % from 3 kg); Chorizo (not sold in Janssen) is skipped');
select is(public.t_pg_reasons('janssen'), 'Pata muslo:OK | Costilla de cerdo:NOT_IN_BRANCH | Coca Cola:OK | Matambre:OK | Costilla de cerdo:OK | Chorizo:NOT_IN_BRANCH', 'the reasons are explicit per slide');
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 8, true,
  jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('finde')), jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000008')))$$, 'Avenida also gets Janssen''s promotion by mistake');
select is(public.t_pg_tv('avenida'), 'Pata muslo | Costilla de cerdo | Coca Cola | Matambre', 'a Janssen-only promotion never plays on an Avenida screen');
select is(public.t_pg_reasons('avenida'), 'Pata muslo:OK | Costilla de cerdo:OK | Coca Cola:OK | Matambre:OK | Costilla de cerdo:NOT_IN_BRANCH', 'and the editor flags it');

-- ---------------------------------------------------------------------------------------------
-- Cambiar el precio de una promoción se refleja SIN recrear el grupo
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.save_weight_discount(p_id := '96000000-0000-4000-8000-000000000003', p_product_id := '95000000-0000-4000-8000-000000000002', p_branch_id := null,
  p_minimum_grams := null, p_discount_type := null, p_discount_value := null, p_active := true, p_valid_from := now() - interval '1 day', p_valid_until := null,
  p_promotion_mode := 'PACK_FIXED_TOTAL', p_pack_quantity_grams := null, p_pack_quantity_units := 3, p_pack_price_cents := 480000)$$, 'Fran changes the Coca pack price in Promociones');
select is((select s -> 'promotion' ->> 'packPriceCents' from jsonb_array_elements(public.get_signage_display(public.t_pg_tok('avenida')) -> 'slides') s where s ->> 'name' = 'Coca Cola'), '480000', 'the TV shows the NEW price with the same group (nothing was copied)');
select is((select count(*)::int from public.signage_promotion_group_items where group_id = public.t_pg_id('finde')), 4, 'and the group still holds the same four items');

-- ---------------------------------------------------------------------------------------------
-- Vencimiento: se saltea en la TV y se conserva en el grupo
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.save_weight_discount(p_id := '96000000-0000-4000-8000-000000000001', p_product_id := '95000000-0000-4000-8000-000000000001', p_branch_id := null,
  p_minimum_grams := 2000, p_discount_type := 'PERCENTAGE', p_discount_value := 1000, p_active := true, p_valid_from := now() - interval '1 day', p_valid_until := now() - interval '1 minute',
  p_promotion_mode := 'THRESHOLD', p_pack_quantity_grams := null, p_pack_quantity_units := null, p_pack_price_cents := null)$$, 'the Pata muslo promotion expires');
select is(public.t_pg_tv('avenida'), 'Costilla de cerdo | Coca Cola | Matambre', 'an expired promotion is skipped on the TV');
select is(public.t_pg_reasons('avenida'), 'Pata muslo:PROMO_EXPIRED | Costilla de cerdo:OK | Coca Cola:OK | Matambre:OK | Costilla de cerdo:NOT_IN_BRANCH', 'the editor shows it as expired');
select is((select count(*)::int from public.signage_promotion_group_items where group_id = public.t_pg_id('finde') and promotion_id = '96000000-0000-4000-8000-000000000001'), 1, 'the group keeps the reference (for editing/history)');
select is((select p ->> 'status' from jsonb_array_elements(public.get_signage_promotion_catalog('93000000-0000-4000-8000-000000000001') -> 'promotions') p where p ->> 'promotionId' = '96000000-0000-4000-8000-000000000001'), 'EXPIRED', 'and the catalog still lists it as expired (a group can show it as such)');
-- La vencida del grupo «pollo» (P6) y una futura: tampoco se reproducen.
select lives_ok($$select public.save_signage_group(public.t_pg_id('pollo'), 'Ofertas pollo', array['96000000-0000-4000-8000-000000000006', '96000000-0000-4000-8000-000000000007', '96000000-0000-4000-8000-000000000004']::uuid[])$$, 'the group can be edited (expired, upcoming and active promotions)');
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('global'), 'TV Global', null, 8, true, jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('pollo'))))$$, 'a screen plays the edited group');
select is(public.t_pg_tv('global'), 'Matambre', 'only the active promotion plays: the expired and the future ones are skipped');
select is(public.t_pg_reasons('global'), 'Pata muslo:PROMO_EXPIRED | Matambre:PROMO_UPCOMING | Matambre:OK', 'the editor explains the expired and the upcoming ones');
-- Llega la fecha: la próxima pasa a vigente.
reset role;
update public.product_weight_discounts set valid_from = now() - interval '1 minute' where id = '96000000-0000-4000-8000-000000000007';
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_pg_tv('global'), 'Matambre | Matambre', 'when its start date arrives the upcoming promotion begins to play');
-- Se desactiva la promoción: deja de reproducirse.
select lives_ok($$select public.save_weight_discount(p_id := '96000000-0000-4000-8000-000000000007', p_product_id := '95000000-0000-4000-8000-000000000004', p_branch_id := null,
  p_minimum_grams := null, p_discount_type := null, p_discount_value := null, p_active := false, p_valid_from := now() - interval '1 minute', p_valid_until := null,
  p_promotion_mode := 'PACK_FIXED_TOTAL', p_pack_quantity_grams := 3000, p_pack_quantity_units := null, p_pack_price_cents := 3000000)$$, 'a promotion is deactivated');
select is(public.t_pg_tv('global'), 'Matambre', 'a deactivated promotion stops playing');

-- ---------------------------------------------------------------------------------------------
-- Orden, quitar una promoción del grupo y deduplicación
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.save_signage_group(public.t_pg_id('finde'), 'Ofertas fin de semana', array['96000000-0000-4000-8000-000000000004', '96000000-0000-4000-8000-000000000003', '96000000-0000-4000-8000-000000000002', '96000000-0000-4000-8000-000000000001']::uuid[])$$, 'the group is reordered');
select is(public.t_pg_tv('avenida'), 'Matambre | Coca Cola | Costilla de cerdo', 'the TV follows the new order (the expired one still skipped)');
select lives_ok($$select public.save_signage_group(public.t_pg_id('finde'), 'Fin de semana', array['96000000-0000-4000-8000-000000000004', '96000000-0000-4000-8000-000000000002']::uuid[])$$, 'the group is renamed and two promotions are removed');
select is(public.t_pg_tv('avenida'), 'Matambre | Costilla de cerdo', 'a promotion removed from the group disappears from the TV');
select is((select name from public.signage_promotion_groups where id = public.t_pg_id('finde')), 'Fin de semana', 'the rename is stored');
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 8, true,
  jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000002'), jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('finde')),
    jsonb_build_object('kind', 'PRODUCT', 'id', '95000000-0000-4000-8000-000000000001')))$$, 'a screen mixes a promotion, a group and a product');
select is(public.t_pg_tv('avenida'), 'Costilla de cerdo | Matambre | Pata muslo', 'a promotion that is both direct and in the group plays once, at its first position; the product slide follows');
select is((select string_agg(kind, ',' order by position) from public.digital_signage_slides where display_id = public.t_pg_id('avenida')), 'PROMOTION,GROUP,PRODUCT', 'the entries keep their order and kind');
select throws_ok($$select public.save_signage_display_entries(public.t_pg_id('avenida'), 'TV Avenida', null, 8, true, jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('finde')), jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('finde'))))$$, '22023', null, 'a repeated entry is rejected');
select throws_ok($$select public.save_signage_display_entries(public.t_pg_id('avenida'), 'TV Avenida', null, 8, true, jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000009')))$$, '42501', null, 'a promotion of another organization is rejected');
select throws_ok($$select public.save_signage_display_entries(public.t_pg_id('avenida'), 'TV Avenida', null, 8, true, jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', '96000000-0000-4000-8000-0000000000aa')))$$, '42501', null, 'an unknown group is rejected');
select throws_ok($$select public.save_signage_display_entries(public.t_pg_id('avenida'), 'TV Avenida', null, 8, true, jsonb_build_array(jsonb_build_object('kind', 'OTHER', 'id', '96000000-0000-4000-8000-000000000001')))$$, '22023', null, 'an unknown kind is rejected');
select throws_ok($$select public.save_signage_display_entries(public.t_pg_id('avenida'), 'TV Avenida', null, 8, true, '[{"kind":"GROUP","id":"no-es-uuid"}]'::jsonb)$$, '22023', null, 'a malformed id is rejected');
select is((select count(*)::int from public.digital_signage_slides where display_id = public.t_pg_id('avenida')), 3, 'every rejected save left the screen untouched');

-- ---------------------------------------------------------------------------------------------
-- Un producto inactivo o sin precio también se saltea dentro de una promoción
-- ---------------------------------------------------------------------------------------------
reset role;
update public.products set active = false where id = '95000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.save_signage_group(public.t_pg_id('finde'), 'Fin de semana', array['96000000-0000-4000-8000-000000000004', '96000000-0000-4000-8000-000000000003']::uuid[])$$, 'the group now has Matambre and Coca');
select is(public.t_pg_reasons('avenida'), 'Costilla de cerdo:OK | Matambre:OK | Coca Cola:INACTIVE | Pata muslo:OK', 'an inactive product inside a promotion is flagged and skipped');
reset role;
update public.products set active = true where id = '95000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Borrar un grupo: sólo si ninguna pantalla lo usa
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.delete_signage_group(public.t_pg_id('finde'))$$, '23503', null, 'a group in use by a screen is not deleted (the screen would lose content silently)');
select is((select count(*)::int from public.signage_promotion_groups where id = public.t_pg_id('finde')), 1, 'it is still there');
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 8, true, '[]'::jsonb)$$, 'it is removed from Avenida');
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('janssen'), 'TV Janssen', '93000000-0000-4000-8000-000000000002', 8, true, '[]'::jsonb)$$, 'and from Janssen');
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('global'), 'TV Global', null, 8, true, jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('pollo'))))$$, 'the Global screen keeps using the other group');
select lives_ok($$select public.delete_signage_group(public.t_pg_id('finde'))$$, 'once unused it can be deleted');
select is((select count(*)::int from public.signage_promotion_group_items where group_id = public.t_pg_id('finde')), 0, 'its items go with it');
select is((select count(*)::int from public.product_weight_discounts where id in ('96000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000004')), 2, 'the promotions themselves are never deleted with a group');
select is(public.t_pg_tv('avenida'), '', 'an empty screen plays nothing (the waiting screen)');

-- ---------------------------------------------------------------------------------------------
-- Fotos privadas: se publican sólo las de lo que una pantalla habilitada puede mostrar
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('avenida'), 'TV Avenida', '93000000-0000-4000-8000-000000000001', 8, true,
  jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('pollo')), jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000002')))$$, 'Avenida plays a group and a single promotion');
reset role;
select ok(public.signage_object_is_published('92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png'), 'the photo of a product in a published group promotion is readable by the TV');
select ok(public.signage_object_is_published('92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000003/c1000000-0000-4000-8000-000000000003.png'), 'the photo of a directly published promotion is readable too');
select ok(not public.signage_object_is_published('92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000002/c1000000-0000-4000-8000-000000000002.png'), 'but the photo of a product that no screen shows (Coca, in the deleted group) stays private');
select ok(not public.signage_object_is_published('92000000-0000-4000-8000-000000000002/95000000-0000-4000-8000-000000000009/c1000000-0000-4000-8000-000000000009.png'), 'and another organization photo stays private');
update public.digital_signage_displays set enabled = false where id in (public.t_pg_id('avenida'), public.t_pg_id('global'), public.t_pg_id('janssen'));
select ok(not public.signage_object_is_published('92000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000003/c1000000-0000-4000-8000-000000000003.png'), 'with every screen disabled no photo is published');
update public.digital_signage_displays set enabled = true where id in (public.t_pg_id('avenida'), public.t_pg_id('global'), public.t_pg_id('janssen'));

-- ---------------------------------------------------------------------------------------------
-- Aislamiento entre organizaciones y por token
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
insert into public.t_pg_keep select 'org-b', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_signage_display('TV Org B', null) as r) x;
select throws_ok($$select public.save_signage_group(public.t_pg_id('pollo'), 'Robado', array['96000000-0000-4000-8000-000000000009']::uuid[])$$, '42501', null, 'another organization cannot edit our group');
select throws_ok($$select public.delete_signage_group(public.t_pg_id('pollo'))$$, '42501', null, 'nor delete it');
select throws_ok($$select public.save_signage_display_entries(public.t_pg_id('org-b'), 'TV Org B', null, 8, true, jsonb_build_array(jsonb_build_object('kind', 'GROUP', 'id', public.t_pg_id('pollo'))))$$, '42501', null, 'nor use our group on its screen');
select lives_ok($$select public.save_signage_display_entries(public.t_pg_id('org-b'), 'TV Org B', null, 8, true, jsonb_build_array(jsonb_build_object('kind', 'PROMOTION', 'id', '96000000-0000-4000-8000-000000000009')))$$, 'it can use its own promotion');
select is(public.t_pg_tv('org-b'), 'Producto de otra org', 'its TV plays only its own content');
select is(jsonb_array_length(public.get_signage_promotion_catalog(null, false) -> 'promotions'), 1, 'its catalog holds only its own promotion');
select is(jsonb_array_length(public.get_signage_promotion_catalog(null, false) -> 'groups'), 0, 'and none of our groups');
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(public.get_signage_display('0000000000000000000000000000000000000000000000000000000000000000'), null::jsonb, 'an unknown token reads nothing');
select ok(public.get_signage_display(public.t_pg_tok('org-b'))::text !~ 'Pata muslo|Matambre|Coca', 'the Org B token never returns content of another organization');
select ok(public.get_signage_display(public.t_pg_tok('global'))::text !~ 'Producto de otra org', 'and ours never returns theirs');

select * from finish();
rollback;
