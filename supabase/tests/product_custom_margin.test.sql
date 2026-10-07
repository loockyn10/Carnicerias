begin;

create extension if not exists pgtap with schema extensions;
select plan(111);

-- Covers 202610070067 (D-070): margen de ganancia PERSONALIZADO por producto. Prioridad del margen efectivo:
--   1. margen propio del producto (aunque su categoría esté excluida);  2. categoría excluida -> precio manual;  3. margen global.
-- Misma fórmula gross-up (costo / (1 - margen)), mismos puntos de entrada (set_product_cost, carga masiva, importación, edición del margen).
-- El cambio del margen global sólo reprecia a quien lo usa. Quitar el margen propio: no excluido -> vuelve al global (reprecia);
-- excluido -> vuelve a precio manual (NO reprecia). El historial de precios es append-only. El POS sólo recibe el precio de lista.
-- Todo el dinero en centavos.

-- ---------------------------------------------------------------------------------------------
-- Fixture (ids propios: prefijo a)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cm-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"CM Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cm-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"CM Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'cm-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"CM Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('a2000000-0000-4000-8000-000000000001', 'CM Org', 'cm-org'),
  ('a2000000-0000-4000-8000-000000000002', 'CM Org B', 'cm-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'CM Central', 'CM-C'),
  ('a3000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000002', 'CM B Branch', 'CM-B');
update public.organizations set production_branch_id = 'a3000000-0000-4000-8000-000000000001' where id = 'a2000000-0000-4000-8000-000000000001';
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002');

-- Categorías de la org A (a/b/c = Almacén, Vaca, Cerdo) y una de la org B.
insert into public.categories (id, organization_id, name, slug) values
  ('a4000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000001', 'Almacen', 'cm-almacen'),
  ('a4000000-0000-4000-8000-00000000000b', 'a2000000-0000-4000-8000-000000000001', 'Vaca', 'cm-vaca'),
  ('a4000000-0000-4000-8000-00000000000c', 'a2000000-0000-4000-8000-000000000001', 'Cerdo', 'cm-cerdo'),
  ('a4000000-0000-4000-8000-00000000000e', 'a2000000-0000-4000-8000-000000000002', 'Vaca', 'cmb-vaca');
-- 01 Aceite (Almacén, costo $10.000), 02 Yerba (Almacén, $7.000), 03 Vacío (Vaca, kg, costo $9.000, precio manual $12.500), 04 Chorizo (Cerdo,
-- costo $5.000, precio manual $9.000), 05 Sin costo (Almacén), 06 Media res (materia prima de Vaca), 07 Org B (sin margen global configurado).
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-00000000000a', 'Aceite', 'cm-aceite', 'CM-01', 'UNIT', true, 'SELLABLE'),
  ('a5000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-00000000000a', 'Yerba', 'cm-yerba', 'CM-02', 'UNIT', true, 'SELLABLE'),
  ('a5000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-00000000000b', 'Vacio', 'cm-vacio', 'CM-03', 'WEIGHT', true, 'SELLABLE'),
  ('a5000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-00000000000c', 'Chorizo', 'cm-chorizo', 'CM-04', 'WEIGHT', true, 'SELLABLE'),
  ('a5000000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-00000000000a', 'Sin costo', 'cm-sin-costo', 'CM-05', 'UNIT', true, 'SELLABLE'),
  ('a5000000-0000-4000-8000-000000000006', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-00000000000b', 'Media res', 'cm-media-res', 'CM-06', 'WEIGHT', true, 'RAW_MATERIAL'),
  ('a5000000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-000000000002', 'a4000000-0000-4000-8000-00000000000e', 'Vacio B', 'cmb-vacio', 'CMB-07', 'WEIGHT', true, 'SELLABLE');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id;

insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 1000000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 1000000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003', 1250000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000004', 900000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000005', 123400, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000007', 700000, now() - interval '1 day');
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from) values
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 1000000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 700000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003', 900000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000004', 500000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000006', 500000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000007', 500000, now() - interval '1 day');

create function public.t_cm_by_sku(p_sku text) returns uuid language sql security definer as $$ select id from public.products where sku = p_sku $$;
create function public.t_cm_price(p_sku text) returns bigint language sql security definer as $$
  select price_cents from public.product_prices where product_id = public.t_cm_by_sku(p_sku) and branch_id is null
    and valid_from <= clock_timestamp() and (valid_to is null or valid_to > clock_timestamp()) order by valid_from desc limit 1 $$;
create function public.t_cm_price_rows(p_sku text) returns bigint language sql security definer as $$
  select count(*) from public.product_prices where product_id = public.t_cm_by_sku(p_sku) and branch_id is null $$;
create function public.t_cm_cost(p_sku text) returns bigint language sql security definer as $$
  select cost_cents from public.product_costs where product_id = public.t_cm_by_sku(p_sku) and valid_to is null $$;
create function public.t_cm_margin(p_sku text) returns integer language sql security definer as $$
  select custom_margin_bps from public.product_custom_margins where product_id = public.t_cm_by_sku(p_sku) $$;
-- Todo el archivo corre en UNA transacción (now() no avanza): retrocede las vigencias para que lo creado con clock_timestamp() ya rija
-- (importación y pull_pos_state miran now()).
create function public.t_cm_backdate(p_org uuid, p_interval interval) returns void language plpgsql as $$
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
select has_table('public', 'product_custom_margins', 'the custom-margin table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.product_custom_margins'::regclass), 'it has RLS');
select ok(not has_table_privilege('authenticated', 'public.product_custom_margins', 'INSERT'), 'browser clients cannot insert into it directly');
select ok(not has_table_privilege('authenticated', 'public.product_custom_margins', 'UPDATE'), 'nor update it');
select ok(not has_table_privilege('authenticated', 'public.product_custom_margins', 'DELETE'), 'nor delete from it');
select ok(not has_function_privilege('anon', 'public.set_product_custom_margin(uuid,integer,boolean)', 'EXECUTE'), 'anonymous cannot set a custom margin');
select ok(not has_function_privilege('authenticated', 'app_private.effective_margin(uuid,uuid)', 'EXECUTE'), 'the effective-margin helper is not callable directly');
select is((select count(*) from public.product_custom_margins), 0::bigint, 'the migration creates no custom margin by itself (no product is touched)');
select is(app_private.effective_margin('a2000000-0000-4000-8000-000000000001', public.t_cm_by_sku('CM-01')) ::text, '(,NO_MARGIN)', 'without any margin the effective margin is NO_MARGIN');

create temp table keep(name text primary key, id uuid, payload jsonb, n bigint, doc jsonb);
grant all on keep to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Margen global 40 % con Vaca y Cerdo excluidas
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.save_pricing_config(4000, 0, 0, 1000, true, false,
  array['a4000000-0000-4000-8000-00000000000b','a4000000-0000-4000-8000-00000000000c']::uuid[])$$, 'the global margin (40 %) is configured with Vaca and Cerdo excluded');
select is(public.t_cm_price('CM-01'), 1666667::bigint, 'ACEITE: almacén, no own margin -> the global 40 % ($10.000 / 0,60)');
select is(public.t_cm_price('CM-03') || '/' || public.t_cm_price_rows('CM-03'), '1250000/1', 'VACIO: excluded category, no own margin -> manual price untouched');

-- ---------------------------------------------------------------------------------------------
-- Validación y permisos
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.set_product_custom_margin(public.t_cm_by_sku('CM-02'), 0)$$, '22023', null, 'a 0 % margin is rejected');
select throws_ok($$select public.set_product_custom_margin(public.t_cm_by_sku('CM-02'), 10000)$$, '22023', null, 'a 100 % margin is rejected');
select throws_ok($$select public.set_product_custom_margin(public.t_cm_by_sku('CM-02'), -5)$$, '22023', null, 'a negative margin is rejected');
select throws_ok($$select public.set_product_custom_margin(public.t_cm_by_sku('CMB-07'), 3000)$$, '42501', 'Product was not found in this organization', 'a product of ANOTHER organization cannot be given a margin');
select is((select count(*) from public.product_custom_margins), 0::bigint, 'rejected calls wrote nothing');

-- ---------------------------------------------------------------------------------------------
-- Margen propio en una categoría normal: YERBA 30 % con global 40 %
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('y1', null, public.set_product_custom_margin(public.t_cm_by_sku('CM-02'), 3000), null, null)$$, 'YERBA gets an own margin of 30 %');
select is((select payload ->> 'outcome' || '/' || (payload ->> 'source') || '/' || (payload ->> 'effectiveMarginBps') from keep where name = 'y1'), 'REPRICED/CUSTOM/3000', 'it reports a repricing with the own margin');
select is(public.t_cm_price('CM-02') || '/' || public.t_cm_price_rows('CM-02'), '1000000/3', 'YERBA: $7.000 / 0,70 = $10.000 (30 %, NOT the global 40 %), a NEW vigencia');
select is(public.t_cm_price('CM-01') || '/' || public.t_cm_price_rows('CM-01'), '1666667/2', 'ACEITE (no own margin) is untouched');
select is(public.t_cm_margin('CM-02'), 3000, 'the own margin is stored as integer basis points');
select lives_ok($$select public.set_product_cost(public.t_cm_by_sku('CM-02'), 800000, clock_timestamp())$$, 'YERBA cost changes to $8.000');
select is(public.t_cm_price('CM-02') || '/' || public.t_cm_price_rows('CM-02'), '1142857/4', 'a cost change uses the OWN margin: $8.000 / 0,70 = $11.428,57');
select lives_ok($$insert into keep values ('y2', null, public.set_product_custom_margin(public.t_cm_by_sku('CM-02'), 3000), null, null)$$, 'saving the SAME margin again');
select is((select payload ->> 'outcome' from keep where name = 'y2'), 'UNCHANGED', 'is a no-op (UNCHANGED)');
select is(public.t_cm_price_rows('CM-02'), 4::bigint, 'and it did not pollute the price history');

-- ---------------------------------------------------------------------------------------------
-- Cambio del margen global: sólo reprecia a quien lo usa
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('p1', null, public.save_pricing_config(5000, 0, 0, 1000, false, false), null, null)$$, 'a global margin change (50 %) asks for confirmation');
select is((select payload ->> 'recalculated' || '/' || (payload ->> 'customMargin') || '/' || (payload ->> 'excludedByCategory') || '/' || (payload ->> 'withoutCost') || '/' || (payload ->> 'unchanged') from keep where name = 'p1'),
  '1/1/2/1/0', 'preview: 1 global-margin product recalculated (Aceite) / 1 own margin (Yerba) / 2 excluded / 1 without cost / 0 unchanged');
select lives_ok($$select public.save_pricing_config(5000, 0, 0, 1000, true, false)$$, 'the change is confirmed');
select is(public.t_cm_price('CM-01'), 2000000::bigint, 'ACEITE follows the new global margin: $10.000 / 0,50');
select is(public.t_cm_price('CM-02') || '/' || public.t_cm_price_rows('CM-02'), '1142857/4', 'YERBA (own margin) is NOT altered by the global change: same price, no new vigencia');
select is(public.t_cm_price('CM-03') || '/' || public.t_cm_price('CM-04'), '1250000/900000', 'excluded products without own margin are not touched either');
select is(public.t_cm_price('CM-05'), 123400::bigint, 'a product without cost keeps its price');

-- ---------------------------------------------------------------------------------------------
-- Quitar el margen propio de un producto NO excluido: vuelve al global
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('y3', null, public.set_product_custom_margin(public.t_cm_by_sku('CM-02'), null), null, null)$$, 'the own margin of YERBA is removed');
select is((select payload ->> 'outcome' || '/' || (payload ->> 'source') || '/' || (payload ->> 'previousMarginBps') from keep where name = 'y3'), 'REPRICED/GLOBAL/3000', 'it reports the return to the global margin');
select is(public.t_cm_price('CM-02') || '/' || public.t_cm_price_rows('CM-02'), '1600000/5', 'YERBA is repriced with cost + the global margin: $8.000 / 0,50 = $16.000 (a new vigencia)');
select is((select count(*) from public.product_custom_margins where product_id = public.t_cm_by_sku('CM-02')), 0::bigint, 'the own margin row is gone');

-- ---------------------------------------------------------------------------------------------
-- Categoría excluida CON margen propio: VACIO 25 % (el ejemplo de $9.000 -> $12.000)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.set_product_cost(public.t_cm_by_sku('CM-04'), 600000, clock_timestamp())$$, 'CHORIZO (Cerdo, excluded, no own margin): a new cost is saved');
select is(public.t_cm_cost('CM-04') || '/' || public.t_cm_price('CM-04') || '/' || public.t_cm_price_rows('CM-04'), '600000/900000/1', 'the cost is stored, the manual price stays and no vigencia is opened');
select lives_ok($$insert into keep values ('v1', null, public.set_product_custom_margin(public.t_cm_by_sku('CM-03'), 2500), null, null)$$, 'VACIO (Vaca, excluded) gets an own margin of 25 %');
select is((select payload ->> 'outcome' || '/' || (payload ->> 'source') from keep where name = 'v1'), 'REPRICED/CUSTOM', 'an excluded product with own margin is priced automatically');
select is(public.t_cm_price('CM-03') || '/' || public.t_cm_price_rows('CM-03'), '1200000/2', 'cost $9.000 / 0,75 = $12.000, in a NEW vigencia');
select is((select count(*) from public.product_prices where product_id = public.t_cm_by_sku('CM-03') and branch_id is null and price_cents = 1250000 and valid_to is not null), 1::bigint, 'the previous manual price stays in the history (closed, never rewritten)');
select lives_ok($$select public.set_product_cost(public.t_cm_by_sku('CM-03'), 1000000, clock_timestamp())$$, 'VACIO: a new cost ($10.000)');
select is(public.t_cm_price('CM-03') || '/' || public.t_cm_price_rows('CM-03'), '1333333/3', 'it follows the own margin even in an excluded category: $10.000 / 0,75');
select lives_ok($$select public.save_pricing_config(4500, 0, 0, 1000, true, false)$$, 'a global margin change (45 %)');
select is(public.t_cm_price('CM-03') || '/' || public.t_cm_price_rows('CM-03'), '1333333/3', 'does NOT alter VACIO (own margin)');
select is(public.t_cm_price('CM-04') || '/' || public.t_cm_price_rows('CM-04'), '900000/1', 'nor CHORIZO (excluded, no own margin)');
select is(public.t_cm_price('CM-01'), 1818182::bigint, 'while ACEITE (global) follows it: $10.000 / 0,55');
select is(public.t_cm_price('CM-02'), 1454545::bigint, 'and YERBA, now back on the global margin: $8.000 / 0,55');

-- ---------------------------------------------------------------------------------------------
-- Quitar el margen propio de un producto EXCLUIDO: vuelve a precio manual (conserva el precio vigente)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('v2', null, public.set_product_custom_margin(public.t_cm_by_sku('CM-03'), null), null, null)$$, 'the own margin of VACIO is removed');
select is((select payload ->> 'outcome' || '/' || (payload ->> 'source') from keep where name = 'v2'), 'MANUAL_PRICE/MANUAL', 'it reports the return to the manual price');
select is(public.t_cm_price('CM-03') || '/' || public.t_cm_price_rows('CM-03'), '1333333/3', 'the current price is KEPT (not recalculated, not deleted) and no vigencia is opened');
select lives_ok($$select public.set_product_cost(public.t_cm_by_sku('CM-03'), 1100000, clock_timestamp())$$, 'a later cost change');
select is(public.t_cm_cost('CM-03') || '/' || public.t_cm_price('CM-03') || '/' || public.t_cm_price_rows('CM-03'), '1100000/1333333/3', 'only stores the cost: the product stopped receiving automatic pricing');

-- ---------------------------------------------------------------------------------------------
-- Carga masiva de costos: usa el margen efectivo de cada producto
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.set_product_custom_margin(public.t_cm_by_sku('CM-02'), 3000)$$, 'YERBA: own margin 30 % again');
select lives_ok($$select public.set_product_custom_margin(public.t_cm_by_sku('CM-03'), 2000)$$, 'VACIO: own margin 20 %');
select is(public.t_cm_price('CM-03'), 1375000::bigint, 'VACIO: $11.000 / 0,80 = $13.750');
select lives_ok($$insert into keep values ('b1', null, public.bulk_set_product_costs(jsonb_build_array(
  jsonb_build_object('productId', public.t_cm_by_sku('CM-01'), 'costCents', 1200000),
  jsonb_build_object('productId', public.t_cm_by_sku('CM-02'), 'costCents', 900000),
  jsonb_build_object('productId', public.t_cm_by_sku('CM-03'), 'costCents', 1200000),
  jsonb_build_object('productId', public.t_cm_by_sku('CM-04'), 'costCents', 650000)), clock_timestamp()), null, null)$$, 'a bulk cost load with global, own-margin and manual products');
select is((select (payload ->> 'applied') || '/' || (payload ->> 'repriced') || '/' || (payload ->> 'manualPrice') from keep where name = 'b1'), '4/3/1', 'bulk: 4 costs saved, 3 prices recalculated, 1 manual-price product');
select is(public.t_cm_price('CM-01'), 2181818::bigint, 'bulk, global product: $12.000 / 0,55');
select is(public.t_cm_price('CM-02'), 1285714::bigint, 'bulk, own margin 30 %: $9.000 / 0,70');
select is(public.t_cm_price('CM-03'), 1500000::bigint, 'bulk, excluded category WITH own margin 20 %: $12.000 / 0,80');
select is(public.t_cm_price('CM-04') || '/' || public.t_cm_cost('CM-04') || '/' || public.t_cm_price_rows('CM-04'), '900000/650000/1', 'bulk, excluded category without own margin: cost stored, price untouched');

-- ---------------------------------------------------------------------------------------------
-- Importación: usa el mismo margen efectivo
-- ---------------------------------------------------------------------------------------------
reset role;
select public.t_cm_backdate('a2000000-0000-4000-8000-000000000001', interval '3 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'cm-imp-1', repeat('1', 64), 'a3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"a4000000-0000-4000-8000-00000000000a","createMissingCategories":false,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'an import batch is created');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'cm-imp-1'), $j$[
  {"rowNumber":2,"externalId":"X1","payload":{"name":"Vacio","unitType":"WEIGHT","sku":"CM-03","costCents":1300000}},
  {"rowNumber":3,"externalId":"X2","payload":{"name":"Chorizo","unitType":"WEIGHT","sku":"CM-04","costCents":700000}},
  {"rowNumber":4,"externalId":"X3","payload":{"name":"Yerba","unitType":"UNIT","sku":"CM-02","costCents":1000000}},
  {"rowNumber":5,"externalId":"X4","payload":{"name":"Aceite","unitType":"UNIT","sku":"CM-01","costCents":1300000}}
]$j$::jsonb)$t$, 'four rows are staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'cm-imp-1'))$$, 'the preview is generated');
select lives_ok($$select public.apply_import_batch((select id from public.import_batches where file_name = 'cm-imp-1'))$$, 'the import is applied');
select is(public.t_cm_price('CM-03') || '/' || public.t_cm_cost('CM-03'), '1625000/1300000', 'import, excluded category WITH own margin: price formed with 20 % ($13.000 / 0,80)');
select is(public.t_cm_price('CM-04') || '/' || public.t_cm_cost('CM-04') || '/' || public.t_cm_price_rows('CM-04'), '900000/700000/1', 'import, excluded category without own margin: cost stored, price untouched');
select is(public.t_cm_price('CM-02'), 1428571::bigint, 'import, own margin 30 %: $10.000 / 0,70');
select is(public.t_cm_price('CM-01'), 2363636::bigint, 'import, global margin 45 %: $13.000 / 0,55');
insert into keep values ('rows1', null, null, null, jsonb_build_array(public.t_cm_price_rows('CM-03'), public.t_cm_price_rows('CM-04'), public.t_cm_price_rows('CM-02'), public.t_cm_price_rows('CM-01'), public.t_cm_cost('CM-03')));
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'cm-imp-2', repeat('2', 64), 'a3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"a4000000-0000-4000-8000-00000000000a","createMissingCategories":false,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'the same file is imported again (idempotence)');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'cm-imp-2'), $j$[
  {"rowNumber":2,"externalId":"X1","payload":{"name":"Vacio","unitType":"WEIGHT","sku":"CM-03","costCents":1300000}},
  {"rowNumber":3,"externalId":"X2","payload":{"name":"Chorizo","unitType":"WEIGHT","sku":"CM-04","costCents":700000}},
  {"rowNumber":4,"externalId":"X3","payload":{"name":"Yerba","unitType":"UNIT","sku":"CM-02","costCents":1000000}},
  {"rowNumber":5,"externalId":"X4","payload":{"name":"Aceite","unitType":"UNIT","sku":"CM-01","costCents":1300000}}
]$j$::jsonb)$t$, 'rows staged again');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'cm-imp-2'))$$, 'the preview is generated');
select lives_ok($$select public.apply_import_batch((select id from public.import_batches where file_name = 'cm-imp-2'))$$, 'applied again');
select is(jsonb_build_array(public.t_cm_price_rows('CM-03'), public.t_cm_price_rows('CM-04'), public.t_cm_price_rows('CM-02'), public.t_cm_price_rows('CM-01'), public.t_cm_cost('CM-03')), (select doc from keep where name = 'rows1'), 'idempotent: the second import stacked no price or cost vigencia');

select lives_ok($$select public.create_import_batch('simplygest', 'product', 'cm-imp-3', repeat('3', 64), 'a3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"a4000000-0000-4000-8000-00000000000a","createMissingCategories":false,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'a third file carries explicit prices');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'cm-imp-3'), $j$[
  {"rowNumber":2,"externalId":"X2","payload":{"name":"Chorizo","unitType":"WEIGHT","sku":"CM-04","costCents":700000,"priceCents":950000}},
  {"rowNumber":3,"externalId":"X3","payload":{"name":"Yerba","unitType":"UNIT","sku":"CM-02","costCents":1000000,"priceCents":555500}}
]$j$::jsonb)$t$, 'two rows are staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'cm-imp-3'))$$, 'the preview is generated');
select lives_ok($$select public.apply_import_batch((select id from public.import_batches where file_name = 'cm-imp-3'))$$, 'the import is applied');
select is(public.t_cm_price('CM-04') || '/' || public.t_cm_price_rows('CM-04'), '950000/2', 'import, excluded category without own margin + explicit file price: the file price rules (existing compatibility)');
select is(public.t_cm_price('CM-02') || '/' || public.t_cm_price_rows('CM-02'), '1428571/' || (select doc ->> 2 from keep where name = 'rows1'), 'import, own margin + a file price: the price formed from cost and margin wins, the file price is ignored');

-- ---------------------------------------------------------------------------------------------
-- POS: sólo recibe el precio de lista formado (nunca costo ni margen)
-- ---------------------------------------------------------------------------------------------
reset role;
select public.t_cm_backdate('a2000000-0000-4000-8000-000000000001', interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.register_pos_device('a7000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'Caja Central')$$, 'a POS device is registered');
select is(
  (select (i ->> 'pricePerKgCents') from jsonb_array_elements(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Vacio'),
  '1625000', 'the POS receives the formed list price of the own-margin product in an excluded category');
select is(
  (select (i ->> 'pricePerKgCents') from jsonb_array_elements(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Yerba'),
  '1428571', 'and the own-margin product in a normal category');
select ok(not (public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0)::text ilike '%margin%'), 'the POS payload exposes no margin');
select ok(not (public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0)::text ilike '%"cost%'), 'nor cost');

-- ---------------------------------------------------------------------------------------------
-- Casos límite de set_product_custom_margin
-- ---------------------------------------------------------------------------------------------
select lives_ok($$insert into keep values ('n1', null, public.set_product_custom_margin(public.t_cm_by_sku('CM-01'), 3500, false), null, null)$$, 'saving a margin without repricing (the Admin does it when the same edit also saves a cost)');
select is((select payload ->> 'outcome' from keep where name = 'n1') || '/' || public.t_cm_price('CM-01') || '/' || public.t_cm_price_rows('CM-01'), 'NOT_REPRICED/2363636/6', 'it only stores the margin: the price and its history are untouched');
select lives_ok($$select public.set_product_cost(public.t_cm_by_sku('CM-01'), 1000000, clock_timestamp())$$, 'the cost saved afterwards reprices ONCE with the new margin');
select is(public.t_cm_price('CM-01') || '/' || public.t_cm_price_rows('CM-01'), '1538462/7', 'ACEITE: $10.000 / 0,65');
select lives_ok($$select public.set_product_custom_margin(public.t_cm_by_sku('CM-01'), null, false)$$, 'removing it without repricing');
select is(public.t_cm_price('CM-01') || '/' || (select count(*) from public.product_custom_margins where product_id = public.t_cm_by_sku('CM-01')), '1538462/0', 'keeps the current price until the next cost change');
select lives_ok($$insert into keep values ('n2', null, public.set_product_custom_margin(public.t_cm_by_sku('CM-05'), 3000), null, null)$$, 'a margin on a product without cost');
select is((select payload ->> 'outcome' from keep where name = 'n2') || '/' || public.t_cm_price('CM-05'), 'NO_COST/123400', 'is stored and the price stays (it will form when a cost arrives)');
select lives_ok($$insert into keep values ('n3', null, public.set_product_custom_margin(public.t_cm_by_sku('CM-06'), 3000), null, null)$$, 'a margin on a pure raw material');
select is((select payload ->> 'outcome' from keep where name = 'n3'), 'NOT_SELLABLE', 'is stored but forms no price (not a sale product)');
select lives_ok($$select public.set_product_cost(public.t_cm_by_sku('CM-05'), 400000, clock_timestamp())$$, 'a first cost arrives for the product without cost');
select is(public.t_cm_price('CM-05'), 571429::bigint, 'and forms the price with the own margin: $4.000 / 0,70');

-- ---------------------------------------------------------------------------------------------
-- Auditoría, aislamiento y permisos
-- ---------------------------------------------------------------------------------------------
select ok((select count(*) from public.audit_logs where entity_type = 'product_custom_margins' and event_type like '%_INSERT') > 0, 'margin creation is audited');
select ok((select count(*) from public.audit_logs where entity_type = 'product_custom_margins' and event_type like '%_DELETE') > 0, 'and margin removal');

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.product_custom_margins), 0::bigint, 'the other organization admin cannot read this organization''s margins (RLS)');
select throws_ok($$select public.set_product_custom_margin(public.t_cm_by_sku('CM-02'), 1000)$$, '42501', 'Product was not found in this organization', 'nor set a margin on a product of this organization');
select lives_ok($$insert into keep values ('o1', null, public.set_product_custom_margin(public.t_cm_by_sku('CMB-07'), 4000), null, null)$$, 'the other organization sets an own margin on ITS product (it has NO global margin configured)');
select is((select payload ->> 'outcome' || '/' || (payload ->> 'source') from keep where name = 'o1'), 'REPRICED/CUSTOM', 'an own margin works even without a global margin');
select is(public.t_cm_price('CMB-07') || '/' || public.t_cm_price_rows('CMB-07'), '833333/2', 'the price is formed: $5.000 / 0,60');

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.product_custom_margins where product_id = public.t_cm_by_sku('CMB-07')), 0::bigint, 'and this organization cannot see that margin');
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_product_custom_margin(public.t_cm_by_sku('CM-02'), 1000)$$, '42501', 'Permission prices.write is required', 'an employee without prices.write cannot set a margin');
select is((select count(*) from public.product_custom_margins), 0::bigint, 'nor read the margins');

select * from finish();
rollback;
