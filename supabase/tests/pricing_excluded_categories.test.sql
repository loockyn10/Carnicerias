begin;

create extension if not exists pgtap with schema extensions;
select plan(117);

-- Covers 202610070066 (D-069): categorías EXCLUIDAS del margen automático. Los productos de esas categorías (carnicería: Vaca / Cerdo /
-- Pollo en el caso real, pero acá se eligen por ID) conservan su precio de lista: ni un costo nuevo (set_product_cost, carga masiva,
-- importación, desposte) ni un cambio de margen les abre una vigencia de precio; el costo SÍ se guarda. Sin categoría = automático.
-- Sacar una categoría de la exclusión exige confirmar (con vista previa) y recién ahí reprecia; agregarla no reprecia. Aislamiento por org.
-- Todo el dinero en centavos.

-- ---------------------------------------------------------------------------------------------
-- Fixture (ids propios: prefijo f)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'xc-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"XC Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'xc-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"XC Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'xc-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"XC Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'XC Org', 'xc-org'),
  ('f2000000-0000-4000-8000-000000000002', 'XC Org B', 'xc-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'XC Central', 'XC-C'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'XC Avenida', 'XC-A'),
  ('f3000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000002', 'XC B Branch', 'XC-B');
update public.organizations set production_branch_id = 'f3000000-0000-4000-8000-000000000001' where id = 'f2000000-0000-4000-8000-000000000001';
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002');

-- Categorías de la org A (a/b/c/d = Almacén, Vaca, Cerdo, Pollo) y una de la org B (con el mismo nombre "Vaca").
insert into public.categories (id, organization_id, name, slug) values
  ('f4000000-0000-4000-8000-00000000000a', 'f2000000-0000-4000-8000-000000000001', 'Almacen', 'xc-almacen'),
  ('f4000000-0000-4000-8000-00000000000b', 'f2000000-0000-4000-8000-000000000001', 'Vaca', 'xc-vaca'),
  ('f4000000-0000-4000-8000-00000000000c', 'f2000000-0000-4000-8000-000000000001', 'Cerdo', 'xc-cerdo'),
  ('f4000000-0000-4000-8000-00000000000d', 'f2000000-0000-4000-8000-000000000001', 'Pollo', 'xc-pollo'),
  ('f4000000-0000-4000-8000-00000000000e', 'f2000000-0000-4000-8000-000000000002', 'Vaca', 'xcb-vaca');
-- 01 Aceite (Almacén, costo $10.000), 02 Vacío (Vaca, kg, costo $8.000, precio manual $12.500), 03 Chorizo (Cerdo), 04 Pollo entero (Pollo),
-- 05 Sin categoría (costo $4.000), 06 Sin costo (Almacén, sin costo), 07 Media res (materia prima de Vaca), 08 Org B (Vaca de B).
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-00000000000a', 'Aceite', 'xc-aceite', 'XC-01', 'UNIT', true, 'SELLABLE'),
  ('f5000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-00000000000b', 'Vacio', 'xc-vacio', 'XC-02', 'WEIGHT', true, 'SELLABLE'),
  ('f5000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-00000000000c', 'Chorizo', 'xc-chorizo', 'XC-03', 'WEIGHT', true, 'SELLABLE'),
  ('f5000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-00000000000d', 'Pollo entero', 'xc-pollo-entero', 'XC-04', 'WEIGHT', true, 'SELLABLE'),
  ('f5000000-0000-4000-8000-000000000005', 'f2000000-0000-4000-8000-000000000001', null, 'Sin categoria', 'xc-sin-categoria', 'XC-05', 'UNIT', true, 'SELLABLE'),
  ('f5000000-0000-4000-8000-000000000006', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-00000000000a', 'Sin costo', 'xc-sin-costo', 'XC-06', 'UNIT', true, 'SELLABLE'),
  ('f5000000-0000-4000-8000-000000000007', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-00000000000b', 'Media res', 'xc-media-res', 'XC-07', 'WEIGHT', true, 'RAW_MATERIAL'),
  ('f5000000-0000-4000-8000-000000000008', 'f2000000-0000-4000-8000-000000000002', 'f4000000-0000-4000-8000-00000000000e', 'Vacio B', 'xcb-vacio', 'XCB-08', 'WEIGHT', true, 'SELLABLE');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id;

insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 1000000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002', 1250000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000003', 900000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000004', 600000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000005', 500000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000006', 123400, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000002', 'f5000000-0000-4000-8000-000000000008', 700000, now() - interval '1 day');
-- Un precio PROPIO de sucursal de Aceite (en el POS le gana al global).
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 1100000, now() - interval '1 day');
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from) values
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 1000000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002', 800000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000003', 500000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000004', 300000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000005', 400000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000007', 500000, now() - interval '1 day'),
  ('f2000000-0000-4000-8000-000000000002', 'f5000000-0000-4000-8000-000000000008', 500000, now() - interval '1 day');

create function public.t_xc_by_sku(p_sku text) returns uuid language sql security definer as $$ select id from public.products where sku = p_sku $$;
create function public.t_xc_price(p_sku text) returns bigint language sql security definer as $$
  select price_cents from public.product_prices where product_id = public.t_xc_by_sku(p_sku) and branch_id is null
    and valid_from <= clock_timestamp() and (valid_to is null or valid_to > clock_timestamp()) order by valid_from desc limit 1 $$;
create function public.t_xc_price_rows(p_sku text) returns bigint language sql security definer as $$
  select count(*) from public.product_prices where product_id = public.t_xc_by_sku(p_sku) and branch_id is null $$;
create function public.t_xc_cost(p_sku text) returns bigint language sql security definer as $$
  select cost_cents from public.product_costs where product_id = public.t_xc_by_sku(p_sku) and valid_to is null $$;
create function public.t_xc_cost_rows(p_sku text) returns bigint language sql security definer as $$
  select count(*) from public.product_costs where product_id = public.t_xc_by_sku(p_sku) $$;
create function public.t_xc_excluded(p_org uuid) returns uuid[] language sql security definer as $$
  select coalesce(array_agg(category_id order by category_id), '{}') from public.organization_pricing_excluded_categories where organization_id = p_org $$;
-- Todo el archivo corre en UNA transacción (now() no avanza): retrocede las vigencias para que lo creado con clock_timestamp() ya rija.
create function public.t_xc_backdate(p_org uuid, p_interval interval) returns void language plpgsql as $$
declare r record;
begin
  alter table public.product_prices disable trigger product_prices_prevent_history_rewrite;
  for r in select id from public.product_prices where organization_id = p_org order by valid_from loop
    update public.product_prices set valid_from = valid_from - p_interval, valid_to = valid_to - p_interval where id = r.id;
  end loop;
  alter table public.product_prices enable trigger product_prices_prevent_history_rewrite;
  for r in select id from public.organization_cash_discounts where organization_id = p_org order by valid_from loop
    update public.organization_cash_discounts set valid_from = valid_from - p_interval, valid_to = valid_to - p_interval where id = r.id;
  end loop;
  for r in select id from public.product_costs where organization_id = p_org order by valid_from loop
    update public.product_costs set valid_from = valid_from - p_interval, valid_to = valid_to - p_interval where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'organization_pricing_excluded_categories', 'the excluded-categories table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.organization_pricing_excluded_categories'::regclass), 'it has RLS');
select ok(not has_table_privilege('authenticated', 'public.organization_pricing_excluded_categories', 'INSERT'), 'browser clients cannot insert into it directly');
select ok(not has_table_privilege('authenticated', 'public.organization_pricing_excluded_categories', 'DELETE'), 'nor delete from it');
select ok(not has_function_privilege('anon', 'public.save_pricing_config(integer,integer,integer,integer,boolean,boolean,uuid[],jsonb)', 'EXECUTE'), 'anonymous cannot save the pricing config');
select ok(not has_function_privilege('authenticated', 'app_private.is_pricing_excluded(uuid,uuid)', 'EXECUTE'), 'the exclusion predicate is not callable directly');
select is((select count(*) from public.organization_pricing_excluded_categories), 0::bigint, 'the migration excludes nothing by itself (no hardcoded Vaca / Cerdo / Pollo)');
select is((select count(*) from pg_proc where proname = 'save_pricing_config' and pronamespace = 'public'::regnamespace), 1::bigint, 'there is a single save_pricing_config overload (no ambiguity for PostgREST)');

create temp table keep(name text primary key, id uuid, payload jsonb, n bigint, doc jsonb);
grant all on keep to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Primera configuración con exclusión: vista previa (nada se escribe) y confirmación
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('p1', null, public.save_pricing_config(3000, 0, 0, 1000, false, false,
  array['f4000000-0000-4000-8000-00000000000b','f4000000-0000-4000-8000-00000000000c','f4000000-0000-4000-8000-00000000000d']::uuid[]), null, null)$$, 'the first configuration asks for confirmation (preview)');
select is((select payload ->> 'requiresConfirmation' from keep where name = 'p1'), 'true', 'the preview requires confirmation');
select is((select payload ->> 'excludedByCategory' from keep where name = 'p1'), '3', 'preview: 3 sellable products are excluded by category (Vacio, Chorizo, Pollo entero)');
select is((select payload ->> 'recalculated' from keep where name = 'p1'), '2', 'preview: 2 automatic products would be repriced (Aceite and the one without category)');
select is((select payload ->> 'withoutCost' from keep where name = 'p1'), '1', 'preview: 1 automatic product has no cost');
select is((select payload ->> 'branchOverrides' from keep where name = 'p1'), '1', 'preview: 1 branch-specific price would keep winning over the global one');
select is((select jsonb_array_length(payload -> 'excludedCategoryIds') from keep where name = 'p1'), 3, 'preview echoes the 3 proposed excluded category ids');
select is((select payload -> 'sample' -> 0 ->> 'name' from keep where name = 'p1'), 'Aceite', 'preview shows which prices would change (sample, by name)');
select is((select (payload -> 'sample' -> 0 ->> 'newCents') from keep where name = 'p1'), '1430000', 'with the new price (Aceite $10.000 / 0,70)');
reset role;
select is((select count(*) from public.organization_pricing_settings), 0::bigint, 'the preview wrote no settings');
select is(public.t_xc_excluded('f2000000-0000-4000-8000-000000000001'), '{}'::uuid[], 'the preview saved no excluded categories');
select is(public.t_xc_price('XC-01') || '/' || public.t_xc_price_rows('XC-01'), '1000000/1', 'and repriced nothing');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$insert into keep values ('c1', null, public.save_pricing_config(3000, 0, 0, 1000, true, false,
  array['f4000000-0000-4000-8000-00000000000b','f4000000-0000-4000-8000-00000000000c','f4000000-0000-4000-8000-00000000000d']::uuid[]), null, null)$$, 'confirming saves the margin and the exclusion');
select is((select payload ->> 'recalculated' from keep where name = 'c1'), '2', 'only the 2 automatic products were repriced');
select is(public.t_xc_price('XC-01'), 1430000::bigint, 'almacén + cost + margin -> automatic price: $10.000 / 0,70 = $14.300');
select is(public.t_xc_price('XC-05'), 570000::bigint, 'a product WITHOUT category is automatic: $4.000 / 0,70 = $5.700');
select is(public.t_xc_price('XC-06'), 123400::bigint, 'an automatic product without cost keeps its price');
select is(public.t_xc_price('XC-02') || '/' || public.t_xc_price_rows('XC-02'), '1250000/1', 'Vaca (Vacio, cost $8.000, margin 30 %): NOT $11.428,57; the manual $12.500 stays and no price vigencia was opened');
select is(public.t_xc_price('XC-03') || '/' || public.t_xc_price_rows('XC-03'), '900000/1', 'Cerdo keeps its price');
select is(public.t_xc_price('XC-04') || '/' || public.t_xc_price_rows('XC-04'), '600000/1', 'Pollo keeps its price');
select is(public.t_xc_excluded('f2000000-0000-4000-8000-000000000001'), array['f4000000-0000-4000-8000-00000000000b','f4000000-0000-4000-8000-00000000000c','f4000000-0000-4000-8000-00000000000d']::uuid[], 'the exclusion is persisted as category IDs');
select is((select count(*) from public.audit_logs where entity_type = 'organization_pricing_excluded_categories' and event_type like '%_INSERT'), 3::bigint, 'each exclusion is audited');

-- ---------------------------------------------------------------------------------------------
-- Cambio de margen: los excluidos no se tocan (Pollo incluido)
-- ---------------------------------------------------------------------------------------------
reset role;
select public.t_xc_backdate('f2000000-0000-4000-8000-000000000001', interval '2 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$insert into keep values ('p2', null, public.save_pricing_config(3500, 0, 0, 1000, false, false), null, null)$$, 'a margin change asks for confirmation (list not touched: same exclusions)');
select is((select payload ->> 'excludedByCategory' || '/' || (payload ->> 'recalculated') || '/' || (payload ->> 'withoutCost') from keep where name = 'p2'), '3/2/1', 'preview of the margin change: 3 excluded / 2 recalculated / 1 without cost');
select is((select payload ->> 'marginChanged' from keep where name = 'p2'), 'true', 'it says the margin changed');
select is((select jsonb_array_length(payload -> 'excludedCategoryIds') from keep where name = 'p2'), 3, 'omitting the list keeps the 3 excluded categories (a deployed Admin that does not send it is safe)');
select lives_ok($$select public.save_pricing_config(3500, 0, 0, 1000, true, false)$$, 'the margin change is confirmed (6-argument call)');
select is(public.t_xc_price('XC-01'), 1540000::bigint, 'Aceite follows the new margin: $10.000 / 0,65');
select is(public.t_xc_price('XC-04') || '/' || public.t_xc_price_rows('XC-04'), '600000/1', 'Pollo + margin change -> price unchanged, no new vigencia');
select is(public.t_xc_price('XC-02') || '/' || public.t_xc_price_rows('XC-02'), '1250000/1', 'Vacio unchanged by the margin change too');
select is(public.t_xc_excluded('f2000000-0000-4000-8000-000000000001') = array['f4000000-0000-4000-8000-00000000000b','f4000000-0000-4000-8000-00000000000c','f4000000-0000-4000-8000-00000000000d']::uuid[], true, 'the exclusion list was not modified by a call that did not send it');

-- ---------------------------------------------------------------------------------------------
-- Costo nuevo: automático => recalcula; excluido => sólo el costo (rentabilidad)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.set_product_cost(public.t_xc_by_sku('XC-02'), 900000, clock_timestamp())$$, 'a new cost is saved for Vacio (Vaca)');
select is(public.t_xc_cost('XC-02') || '/' || public.t_xc_cost_rows('XC-02'), '900000/2', 'the cost IS updated (profitability uses it): $9.000, two cost vigencias');
select is(public.t_xc_price('XC-02') || '/' || public.t_xc_price_rows('XC-02'), '1250000/1', 'but the sale price is NOT recalculated: it stays $12.500');
select is((public.t_xc_price('XC-02') - public.t_xc_cost('XC-02')), 350000::bigint, 'profitability inputs: gross margin = current price - NEW cost = $3.500/kg');
select lives_ok($$select public.set_product_cost(public.t_xc_by_sku('XC-03'), 600000, clock_timestamp())$$, 'a new cost is saved for Chorizo (Cerdo)');
select is(public.t_xc_cost('XC-03') || '/' || public.t_xc_price('XC-03') || '/' || public.t_xc_price_rows('XC-03'), '600000/900000/1', 'Cerdo + new cost -> cost updated, price unchanged');
select lives_ok($$select public.set_product_cost(public.t_xc_by_sku('XC-01'), 1100000, clock_timestamp())$$, 'a new cost is saved for Aceite (automatic)');
select is(public.t_xc_price('XC-01'), 1690000::bigint, 'the automatic product is repriced: $11.000 / 0,65 = $16.900');

-- Un precio manual sobre un producto excluido sigue siendo posible y se conserva.
select lives_ok($$select public.set_product_price(public.t_xc_by_sku('XC-02'), null, 1300000, clock_timestamp())$$, 'the administrator can set a manual price on an excluded product');
select is(public.t_xc_price('XC-02'), 1300000::bigint, 'and it is the current price');

-- ---------------------------------------------------------------------------------------------
-- Carga masiva de costos
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('b1', null, public.bulk_set_product_costs(jsonb_build_array(
  jsonb_build_object('productId', public.t_xc_by_sku('XC-01'), 'costCents', 1200000),
  jsonb_build_object('productId', public.t_xc_by_sku('XC-02'), 'costCents', 1000000),
  jsonb_build_object('productId', public.t_xc_by_sku('XC-04'), 'costCents', 350000),
  jsonb_build_object('productId', public.t_xc_by_sku('XC-05'), 'costCents', 450000)), clock_timestamp()), null, null)$$, 'a bulk cost load with automatic and excluded products');
select is((select (payload ->> 'applied') || '/' || (payload ->> 'repriced') || '/' || (payload ->> 'manualPrice') from keep where name = 'b1'), '4/2/2', 'bulk: 4 costs saved, 2 prices recalculated, 2 manual-price products');
select is(public.t_xc_price('XC-01') || '/' || public.t_xc_price('XC-05'), '1845000/690000', 'automatic rows: new cost -> new price ($12.000 / 0,65 and $4.500 / 0,65)');
select is(public.t_xc_price('XC-02') || '/' || public.t_xc_price('XC-04'), '1300000/600000', 'excluded rows: the price is untouched');
select is(public.t_xc_cost('XC-02') || '/' || public.t_xc_cost('XC-04'), '1000000/350000', 'excluded rows: the new cost IS stored');
select is(public.t_xc_price_rows('XC-04'), 1::bigint, 'and no price vigencia was opened for them');

-- ---------------------------------------------------------------------------------------------
-- Importación: costo en producto automático forma precio; en excluido sólo guarda el costo; el precio explícito sigue rigiendo
-- ---------------------------------------------------------------------------------------------
-- La importación guarda el costo con now() (inicio de la transacción): hay que retroceder lo creado con clock_timestamp() para no solapar.
reset role;
select public.t_xc_backdate('f2000000-0000-4000-8000-000000000001', interval '3 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'xc-imp-1', repeat('1', 64), 'f3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"f4000000-0000-4000-8000-00000000000a","createMissingCategories":false,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'an import batch is created');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'xc-imp-1'), $j$[
  {"rowNumber":2,"externalId":"X1","payload":{"name":"Vacio","unitType":"WEIGHT","sku":"XC-02","costCents":1100000}},
  {"rowNumber":3,"externalId":"X2","payload":{"name":"Pollo entero","unitType":"WEIGHT","sku":"XC-04","costCents":380000,"priceCents":650000}},
  {"rowNumber":4,"externalId":"X3","payload":{"name":"Aceite","unitType":"UNIT","sku":"XC-01","costCents":1300000}},
  {"rowNumber":5,"externalId":"X4","payload":{"name":"Costilla nueva","unitType":"WEIGHT","sku":"XC-NEW-V","costCents":700000,"categoryName":"Vaca"}},
  {"rowNumber":6,"externalId":"X5","payload":{"name":"Fideos nuevo","unitType":"UNIT","sku":"XC-NEW-A","costCents":200000}}
]$j$::jsonb)$t$, 'five rows are staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'xc-imp-1'))$$, 'the preview is generated');
select lives_ok($$select public.apply_import_batch((select id from public.import_batches where file_name = 'xc-imp-1'))$$, 'the import is applied');
select is(public.t_xc_cost('XC-02') || '/' || public.t_xc_price('XC-02') || '/' || public.t_xc_price_rows('XC-02'), '1100000/1300000/2', 'import, excluded product with a cost and no price: the cost is stored, the price is NOT formed from it');
select is(public.t_xc_cost('XC-04') || '/' || public.t_xc_price('XC-04'), '380000/650000', 'import, excluded product WITH an explicit price: the file price is used (existing compatibility) and the cost is stored');
select is(public.t_xc_price('XC-01'), 2000000::bigint, 'import, automatic product with a cost: the price is formed from the margin ($13.000 / 0,65 = $20.000)');
select is(public.t_xc_price_rows('XC-NEW-V') || '/' || public.t_xc_cost('XC-NEW-V'), '0/700000', 'import, NEW product in a Vaca category with a cost: no price formed (it is entered manually), cost stored');
select is(public.t_xc_price('XC-NEW-A'), 310000::bigint, 'import, NEW automatic product with a cost: price formed ($2.000 / 0,65)');
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'xc-imp-2', repeat('2', 64), 'f3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"f4000000-0000-4000-8000-00000000000a","createMissingCategories":false,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'the same file is imported again (idempotence)');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'xc-imp-2'), $j$[
  {"rowNumber":2,"externalId":"X1","payload":{"name":"Vacio","unitType":"WEIGHT","sku":"XC-02","costCents":1100000}},
  {"rowNumber":3,"externalId":"X2","payload":{"name":"Pollo entero","unitType":"WEIGHT","sku":"XC-04","costCents":380000,"priceCents":650000}},
  {"rowNumber":4,"externalId":"X3","payload":{"name":"Aceite","unitType":"UNIT","sku":"XC-01","costCents":1300000}},
  {"rowNumber":5,"externalId":"X4","payload":{"name":"Costilla nueva","unitType":"WEIGHT","sku":"XC-NEW-V","costCents":700000,"categoryName":"Vaca"}},
  {"rowNumber":6,"externalId":"X5","payload":{"name":"Fideos nuevo","unitType":"UNIT","sku":"XC-NEW-A","costCents":200000}}
]$j$::jsonb)$t$, 'rows staged again');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'xc-imp-2'))$$, 'the preview is generated');
select lives_ok($$select public.apply_import_batch((select id from public.import_batches where file_name = 'xc-imp-2'))$$, 'applied again');
select is(public.t_xc_price_rows('XC-02') || '/' || public.t_xc_price_rows('XC-04') || '/' || public.t_xc_price_rows('XC-01') || '/' || public.t_xc_price_rows('XC-NEW-V') || '/' || public.t_xc_price_rows('XC-NEW-A'), '2/2/' || public.t_xc_price_rows('XC-01') || '/0/1', 'idempotent: no price vigencia was stacked by the second import');
select is(public.t_xc_cost_rows('XC-02') || '/' || public.t_xc_cost_rows('XC-04'), '4/3', 'and no cost vigencia either');

-- ---------------------------------------------------------------------------------------------
-- Desposte: finalizar un lote actualiza el costo del corte excluido sin tocar su precio
-- ---------------------------------------------------------------------------------------------
reset role;
select public.t_xc_backdate('f2000000-0000-4000-8000-000000000001', interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.create_production_batch(
  p_source_product_id => 'f5000000-0000-4000-8000-000000000007', p_input_weight_grams => 20000, p_cost_per_kg_cents => 420000,
  p_branch_id => 'f3000000-0000-4000-8000-000000000001', p_description => 'Media res')$$, 'a Desposte batch is created');
select lives_ok($$select public.set_production_batch_output((select id from public.production_batches where organization_id = 'f2000000-0000-4000-8000-000000000001'), 'f5000000-0000-4000-8000-000000000002', 2000)$$, 'with the Vacio output');
select lives_ok($$select public.complete_production_batch((select id from public.production_batches where organization_id = 'f2000000-0000-4000-8000-000000000001'))$$, 'the batch is finalized');
select is(public.t_xc_cost('XC-02'), 4200000::bigint, 'the produced cost became the current cost of the excluded cut (profitability sees it)');
select is(public.t_xc_price('XC-02'), 1300000::bigint, 'desposte did not reprice the excluded cut: its commercial price is unchanged');
select lives_ok($$select public.save_pricing_config(4000, 0, 0, 1000, true, false)$$, 'a later margin change...');
select is(public.t_xc_price('XC-02') || '/' || public.t_xc_price_rows('XC-02'), '1300000/2', '...does not reprice the desposte cut either (still the manual price)');

-- ---------------------------------------------------------------------------------------------
-- Agregar una categoría a la exclusión: sin confirmación, no reprecia, y desde ahí deja de repreciarse
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('a1', null, public.save_pricing_config(4000, 0, 0, 1000, false, false,
  array['f4000000-0000-4000-8000-00000000000a','f4000000-0000-4000-8000-00000000000b','f4000000-0000-4000-8000-00000000000c','f4000000-0000-4000-8000-00000000000d']::uuid[]), null, null)$$, 'adding Almacén to the exclusion');
select is((select payload ->> 'requiresConfirmation' from keep where name = 'a1'), 'false', 'adding a category does not need confirmation');
select is((select jsonb_array_length(payload -> 'addedExcludedCategoryIds') from keep where name = 'a1'), 1, 'it reports the added category');
select is(public.t_xc_price('XC-01'), 2165000::bigint, 'and the price it already had is kept (historical prices are not rewritten)');
select lives_ok($$select public.set_product_cost(public.t_xc_by_sku('XC-01'), 1500000, clock_timestamp())$$, 'a new cost for Aceite, now in an excluded category');
select is(public.t_xc_cost('XC-01') || '/' || public.t_xc_price('XC-01'), '1500000/2165000', 'the cost is saved and the price is no longer repriced automatically');
select lives_ok($$select public.save_pricing_config(4500, 0, 0, 1000, true, false)$$, 'a margin change after adding the category');
select is(public.t_xc_price('XC-01'), 2165000::bigint, 'does not reprice it either');
select is(public.t_xc_price('XC-05'), 820000::bigint, 'while the product without category (still automatic) follows the margin: $4.500 / 0,55');

-- ---------------------------------------------------------------------------------------------
-- Quitar una categoría de la exclusión: vista previa, confirmación, y recién ahí vigencias nuevas (sólo de esa categoría)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.set_product_price(public.t_xc_by_sku('XC-05'), null, 777700, clock_timestamp())$$, 'a manual price drift on an automatic product (not caused by this change)');
select lives_ok($$insert into keep values ('r1', null, public.save_pricing_config(4500, 0, 0, 1000, false, false,
  array['f4000000-0000-4000-8000-00000000000a','f4000000-0000-4000-8000-00000000000c','f4000000-0000-4000-8000-00000000000d']::uuid[]), null, null)$$, 'removing Vaca from the exclusion asks for confirmation (same margin)');
select is((select payload ->> 'requiresConfirmation' from keep where name = 'r1'), 'true', 'the preview requires confirmation');
select is((select payload ->> 'marginChanged' from keep where name = 'r1'), 'false', 'even though the margin did not change');
select is((select payload ->> 'newlyAutomatic' from keep where name = 'r1'), '2', 'it says how many products would start being automatic (Vacio and Costilla nueva)');
select is((select payload ->> 'recalculated' from keep where name = 'r1'), '2', 'and how many prices would change (Vacio gets a new price; Costilla nueva gets its first one)');
select is((select payload -> 'sample' -> 0 ->> 'name' from keep where name = 'r1'), 'Costilla nueva', 'the sample lists the products that would change');
reset role;
select is(public.t_xc_excluded('f2000000-0000-4000-8000-000000000001') @> array['f4000000-0000-4000-8000-00000000000b']::uuid[], true, 'the preview did not remove the exclusion');
select is(public.t_xc_price('XC-02') || '/' || public.t_xc_price_rows('XC-02'), '1300000/2', 'and repriced nothing');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.save_pricing_config(4500, 0, 0, 1000, true, false,
  array['f4000000-0000-4000-8000-00000000000a','f4000000-0000-4000-8000-00000000000c','f4000000-0000-4000-8000-00000000000d']::uuid[])$$, 'confirming the removal');
select is(public.t_xc_price('XC-02') || '/' || public.t_xc_price_rows('XC-02'), '7635000/3', 'Vacio (cost $42.000, margin 45 %) now has an automatic price in a NEW vigencia: $42.000 / 0,55');
select is((select count(*) from public.product_prices where product_id = public.t_xc_by_sku('XC-02') and branch_id is null and price_cents = 1300000 and valid_to is not null), 1::bigint, 'the previous manual price stays in the history (closed, not rewritten)');
select is(public.t_xc_price('XC-03') || '/' || public.t_xc_price('XC-04'), '900000/650000', 'Cerdo and Pollo (still excluded) are untouched');
select is(public.t_xc_price('XC-05'), 777700::bigint, 'the removal only reprices the removed category: another product with a drifted price is not overwritten');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento, permisos y datos inválidos
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.save_pricing_config(4500, 0, 0, 1000, true, false, array['f4000000-0000-4000-8000-00000000000e']::uuid[])$$, '42501', null, 'a category of ANOTHER organization cannot be excluded');
select lives_ok($$select public.save_pricing_config(4500, 0, 0, 1000, true, false, '{}'::uuid[])$$, 'an empty list clears every exclusion');
select is((select count(*) from public.organization_pricing_excluded_categories), 0::bigint, 'no category is excluded any more');
select lives_ok($$select public.save_pricing_config(4500, 0, 0, 1000, true, false, array['f4000000-0000-4000-8000-00000000000b', 'f4000000-0000-4000-8000-00000000000b']::uuid[])$$, 'a duplicated id is stored once');
select is((select count(*) from public.organization_pricing_excluded_categories), 1::bigint, 'one row');

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.organization_pricing_excluded_categories), 0::bigint, 'the other organization admin cannot read this organization''s exclusions (RLS)');
select lives_ok($$select public.save_pricing_config(3000, 0, 0, 1000, true, false, array['f4000000-0000-4000-8000-00000000000e']::uuid[])$$, 'the other organization excludes ITS own "Vaca" (same name, different id)');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.organization_pricing_excluded_categories), 1::bigint, 'and that did not touch this organization');
reset role;
select is(public.t_xc_price('XCB-08') || '/' || public.t_xc_price_rows('XCB-08'), '700000/1', 'the other organization''s Vaca product keeps its price too');
-- Redondeo comercial a $50 (D-071): sólo el precio AUTOMÁTICO se redondea. Un precio manual (aunque no sea múltiplo de $50) y un producto
-- excluido/manual no se tocan; el precio automático vigente es siempre múltiplo de $50.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_xc_price('XC-06'), 123400::bigint, 'a manual price that is not a multiple of $50 and never had a cost is untouched by the rounding');
select lives_ok($$select public.set_product_price(public.t_xc_by_sku('XC-02'), null, 123457, clock_timestamp())$$, 'a manual price ($1.234,57) is saved exactly as typed on an excluded product');
select is(public.t_xc_price('XC-02'), 123457::bigint, 'manual prices are not rounded to $50');
select lives_ok($$select public.set_product_cost(public.t_xc_by_sku('XC-02'), 950000, clock_timestamp())$$, 'a new cost for the excluded product...');
select is(public.t_xc_price('XC-02'), 123457::bigint, '...does not reprice it nor round its manual price');
select is(public.t_xc_price('XC-01') % 5000, 0::bigint, 'the automatic price of Aceite is a multiple of $50');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.save_pricing_config(4500, 0, 0, 1000, true, false, '{}'::uuid[])$$, '42501', null, 'an employee without prices.write cannot change the exclusions');
select is((select count(*) from public.organization_pricing_excluded_categories), 0::bigint, 'nor read them');

select * from finish();
rollback;
