begin;

create extension if not exists pgtap with schema extensions;
select plan(331);

-- Covers 202610060065 (D-068): precio de lista derivado del COSTO con un MARGEN REAL sobre el precio de venta (precio = costo / (1 - margen)),
-- configuración global (margen, "llevando 3u", pack, recargo por tarjeta), recálculo masivo al cambiar el margen, costo nuevo => precio nuevo
-- en la misma operación, historial append-only, productos sin costo, packs globales versionados, promoción "desde 3" materializada en
-- branch_promotions, ventas offline del Día 1 sincronizadas después del cambio y aislamiento entre organizaciones.
-- Todo el dinero en centavos.

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'organization_pricing_settings', 'organization_pricing_settings exists');
select has_function('public', 'save_pricing_config', array['integer','integer','integer','integer','boolean','boolean'], 'save_pricing_config RPC exists');
select has_function('public', 'close_branch_price_overrides', array['uuid[]'], 'close_branch_price_overrides RPC exists');
select ok(not has_function_privilege('anon', 'public.close_branch_price_overrides(uuid[])', 'EXECUTE'), 'anonymous cannot close branch prices');
select has_function('public', 'bulk_set_product_costs', array['jsonb','timestamptz'], 'bulk_set_product_costs RPC exists');
select ok(not has_function_privilege('anon', 'public.save_pricing_config(integer,integer,integer,integer,boolean,boolean)', 'EXECUTE'), 'anonymous cannot save the pricing config');
select ok(not has_function_privilege('anon', 'public.bulk_set_product_costs(jsonb,timestamptz)', 'EXECUTE'), 'anonymous cannot bulk-set costs');
select ok(not has_function_privilege('authenticated', 'app_private.recalculate_prices_from_margin(uuid,integer,uuid,boolean,boolean)', 'EXECUTE'), 'the mass recalculation is not callable directly');
select ok(not has_function_privilege('authenticated', 'app_private.apply_unit_bulk_promotion(uuid,uuid,integer,uuid)', 'EXECUTE'), 'the promotion fan-out is not callable directly');
select ok((select relrowsecurity from pg_class where oid = 'public.organization_pricing_settings'::regclass), 'organization_pricing_settings has RLS');
select ok(not has_table_privilege('authenticated', 'public.organization_pricing_settings', 'INSERT'), 'browser clients cannot write the config table directly');
select ok(not has_table_privilege('authenticated', 'public.organization_pricing_settings', 'UPDATE'), 'nor update it');

-- ---------------------------------------------------------------------------------------------
-- La fórmula: margen sobre el PRECIO DE VENTA (gross-up), no markup sobre costo
-- ---------------------------------------------------------------------------------------------
select is(app_private.list_price_from_margin(1000000, 3000), 1428571::bigint, 'cost $10.000 at 30 % margin -> $14.285,71 (10.000 / 0,70), NOT $13.000 (10.000 x 1,30)');
select isnt(app_private.list_price_from_margin(1000000, 3000), 1300000::bigint, 'it is not a 30 % markup over cost');
select is(app_private.list_price_from_margin(400000, 3000), 571429::bigint, 'cost $4.000 at 30 % -> $5.714,29');
select is(app_private.list_price_from_margin(1000000, 5000), 2000000::bigint, 'cost $10.000 at 50 % -> exactly $20.000');
select is(app_private.list_price_from_margin(1000000, 3500), 1538462::bigint, 'cost $10.000 at 35 % -> $15.384,62');
select is(app_private.list_price_from_margin(1, 5000), 2::bigint, 'half-up: 1 / 0,5 = 2');
select is(app_private.list_price_from_margin(100, 3333), 150::bigint, 'half-up on a fraction: 100 / 0,6667 = 149,99 -> 150');
select is(app_private.list_price_from_margin(10000, 1), 10001::bigint, 'half-up never drops below the cost: 10.000 / 0,9999 = 10.001');
select is(app_private.list_price_from_margin(1000000, 3000), (select list_price_cents from public.calculate_product_price(1000000, 0, 3000)), 'it is the existing gross-up (calculate_product_price with markup 0), not a parallel formula');
select throws_ok($$select app_private.list_price_from_margin(1000000, 10000)$$, '22023', null, '100 % margin is rejected');
select throws_ok($$select app_private.list_price_from_margin(1000000, 0)$$, '22023', null, '0 % margin is rejected');
select throws_ok($$select app_private.list_price_from_margin(0, 3000)$$, '22023', null, 'a zero cost produces no price');
select throws_ok($$select app_private.list_price_from_margin(null, 3000)$$, '22023', null, 'a missing cost produces no price');

-- ---------------------------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'gp-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"GP Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'gp-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"GP Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'gp-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"GP Admin B"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'gp-pricer@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"GP Pricer"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'GP Org', 'gp-org'),
  ('e2000000-0000-4000-8000-000000000002', 'GP Org B', 'gp-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'GP Central', 'GP-C'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'GP Avenida', 'GP-A'),
  ('e3000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000002', 'GP B Branch', 'GP-B');
update public.organizations set production_branch_id = 'e3000000-0000-4000-8000-000000000001' where id = 'e2000000-0000-4000-8000-000000000001';

-- Un rol propio con SÓLO prices.write (sin catalog.write ni products.write).
insert into public.roles (id, organization_id, key, name, description, is_system) values
  ('e8000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'gp_pricer', 'GP Pricer', 'only prices.write', false);
insert into public.role_permissions (role_id, permission_key) values ('e8000000-0000-4000-8000-000000000001', 'prices.write');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000004', 'e8000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002'),
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002');

insert into public.categories (id, organization_id, name, slug) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'GP Category', 'gp-category'),
  ('e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'GP Category B', 'gp-category-b');
-- A Aceite, B Yerba, D Azúcar, G Programado, H Coca (pack 6), I Producto 3u, J Leche (pack 8): UNIT. C Vacío: WEIGHT. E Insumo: materia prima. F: inactivo.
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('e5000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Aceite', 'gp-aceite', 'GP-A', 'UNIT', true, 'SELLABLE'),
  ('e5000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Yerba', 'gp-yerba', 'GP-B', 'UNIT', true, 'SELLABLE'),
  ('e5000000-0000-4000-8000-00000000000c', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Vacio', 'gp-vacio', 'GP-C', 'WEIGHT', true, 'SELLABLE'),
  ('e5000000-0000-4000-8000-00000000000d', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Azucar', 'gp-azucar', 'GP-D', 'UNIT', true, 'SELLABLE'),
  ('e5000000-0000-4000-8000-00000000000e', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Media res', 'gp-media-res', 'GP-E', 'WEIGHT', true, 'RAW_MATERIAL'),
  ('e5000000-0000-4000-8000-00000000000f', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Inactivo', 'gp-inactivo', 'GP-F', 'UNIT', false, 'SELLABLE'),
  ('e5000000-0000-4000-8000-000000000010', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Programado', 'gp-programado', 'GP-G', 'UNIT', true, 'SELLABLE'),
  ('e5000000-0000-4000-8000-000000000011', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Coca', 'gp-coca', 'GP-H', 'UNIT', true, 'SELLABLE'),
  ('e5000000-0000-4000-8000-000000000012', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Producto 3u', 'gp-3u', 'GP-I', 'UNIT', true, 'SELLABLE'),
  ('e5000000-0000-4000-8000-000000000013', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Leche', 'gp-leche', 'GP-J', 'UNIT', true, 'SELLABLE'),
  ('e5000000-0000-4000-8000-000000000014', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Producto cero', 'gp-cero', 'GP-K', 'UNIT', true, 'SELLABLE'),
  ('e5000000-0000-4000-8000-000000000020', 'e2000000-0000-4000-8000-000000000002', 'e4000000-0000-4000-8000-000000000002', 'Producto Org B', 'gpb-z', 'GPB-Z', 'UNIT', true, 'SELLABLE');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id;

-- Precios de lista vigentes (ayer) y costos vigentes (ayer).
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000a', 1000000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000b', 600000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000c', 777700, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000d', 1428571, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000f', 111100, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000011', 200000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000012', 540000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000013', 100000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000014', 123400, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000020', 100000, now() - interval '1 day');
-- Programado: precio vigente hasta mañana y un precio global programado a partir de mañana.
insert into public.product_prices (organization_id, product_id, price_cents, valid_from, valid_to) values
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000010', 300000, now() - interval '1 day', now() + interval '1 day');
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000010', 310000, now() + interval '1 day');
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from) values
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000a', 1000000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000b', 400000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000d', 1000000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000e', 500000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000f', 500000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000010', 200000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000014', 0, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000020', 100000, now() - interval '1 day');
-- Packs con descuento PROPIO (el modelo anterior): Coca 6 u al 15 %, Leche 8 u al 25 %; Org B: 6 u al 10 %.
update public.products set pack_size_units = 6, pack_discount_bps = 1500 where id = 'e5000000-0000-4000-8000-000000000011';
update public.products set pack_size_units = 8, pack_discount_bps = 2500 where id = 'e5000000-0000-4000-8000-000000000013';
update public.products set pack_size_units = 6, pack_discount_bps = 1000 where id = 'e5000000-0000-4000-8000-000000000020';

-- Helpers del test (definer: el empleado no lee las tablas). La línea del ticket tal como la arma el POS, cálculo independiente en numeric.
create function public.t_gp_item(
  p_product uuid, p_name text, p_qty integer, p_list bigint, p_kind text default 'NONE',
  p_pack_size integer default null, p_pack_bps integer default null, p_promo uuid default null, p_promo_bps integer default null
) returns jsonb language plpgsql security definer as $$
declare units integer := p_qty; discounted integer := 0; bps integer := 0; disc bigint; sub bigint; res jsonb;
begin
  if p_kind = 'PACK' then units := p_qty * p_pack_size; discounted := units; bps := p_pack_bps;
  elsif p_kind = 'PROMO' then discounted := case when units >= 3 then units else 0 end; bps := p_promo_bps;
  end if;
  disc := round(p_list::numeric * discounted * bps / 10000)::bigint;
  sub := p_list * units - disc;
  res := jsonb_build_object(
    'productId', p_product, 'productNameSnapshot', p_name, 'quantityUnits', units,
    'pricePerKgCents', case when discounted = 0 then p_list else round(sub::numeric / units)::bigint end::text, 'originalPricePerKgCents', p_list::text,
    'discountCents', disc::text, 'cashDiscountBps', '0', 'cashDiscountCents', '0', 'cardSurchargeCents', '0',
    'promotionDiscountCents', disc::text, 'subtotalCents', sub::text);
  if p_kind = 'PACK' then
    res := res || jsonb_build_object('soldAsPack', true, 'packCount', p_qty, 'packSizeUnitsSnapshot', p_pack_size, 'packDiscountBps', p_pack_bps, 'packDiscountCents', disc::text,
      'packConfigId', (select v.id from public.product_pack_versions v where v.product_id = p_product and v.pack_size_units = p_pack_size and v.discount_bps = p_pack_bps order by v.valid_to nulls first limit 1));
  elsif p_kind = 'PROMO' and discounted > 0 then
    res := res || jsonb_build_object('branchPromotionId', p_promo, 'branchPromotionMinimumUnits', 3, 'branchPromotionDiscountBps', p_promo_bps,
      'branchPromotionDiscountedUnits', discounted, 'branchPromotionDiscountCents', disc::text);
  end if;
  return res;
end $$;

create function public.t_gp_payload(p_seq integer, p_items jsonb, p_at timestamptz default null)
returns jsonb language plpgsql as $$
declare
  base text := 'e6000000-0000-4000-8000-';
  items jsonb := '[]'; moves jsonb := '[]'; item jsonb; idx integer := 0; subtotal bigint := 0; at timestamptz := coalesce(p_at, now() - interval '1 minute');
begin
  for item in select value from jsonb_array_elements(p_items) loop
    idx := idx + 1;
    item := item || jsonb_build_object('id', base || lpad((p_seq * 1000 + 100 + idx)::text, 12, '0'));
    items := items || jsonb_build_array(item);
    subtotal := subtotal + (item->>'subtotalCents')::bigint;
    moves := moves || jsonb_build_array(jsonb_build_object(
      'id', base || lpad((p_seq * 1000 + 200 + idx)::text, 12, '0'), 'productId', item->>'productId',
      'quantityGrams', (-(item->>'quantityUnits')::bigint)::text, 'occurredAt', at));
  end loop;
  return jsonb_build_object(
    'schemaVersion', 1, 'eventId', base || lpad((p_seq * 1000 + 1)::text, 12, '0'), 'saleId', base || lpad((p_seq * 1000 + 2)::text, 12, '0'),
    'organizationId', 'e2000000-0000-4000-8000-000000000001', 'branchId', 'e3000000-0000-4000-8000-000000000001', 'profileId', 'e1000000-0000-4000-8000-000000000002',
    'deviceId', 'e7000000-0000-4000-8000-000000000001', 'status', 'COMPLETED', 'totalCents', subtotal::text, 'totalWeightGrams', '0', 'createdAt', at, 'completedAt', at,
    'items', items,
    'payment', jsonb_build_object('id', base || lpad((p_seq * 1000 + 3)::text, 12, '0'), 'method', 'CASH', 'amountCents', subtotal::text),
    'stockMovements', moves);
end $$;
create function public.t_gp_sale(p_seq integer) returns uuid language sql immutable as $$ select ('e6000000-0000-4000-8000-' || lpad((p_seq * 1000 + 2)::text, 12, '0'))::uuid $$;
create function public.t_gp_sync(p_payload jsonb) returns jsonb language sql as $$
  select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', (p_payload->>'eventId')::uuid, p_payload) $$;
create function public.t_gp_open_price(p_product uuid) returns bigint language sql security definer as $$
  select price_cents from public.product_prices where product_id = p_product and branch_id is null and valid_from <= clock_timestamp() and (valid_to is null or valid_to > clock_timestamp()) order by valid_from desc limit 1 $$;
create function public.t_gp_price_rows(p_product uuid) returns bigint language sql security definer as $$
  select count(*) from public.product_prices where product_id = p_product $$;
create function public.t_gp_cost(p_product uuid) returns bigint language sql security definer as $$
  select cost_cents from public.product_costs where product_id = p_product and valid_to is null $$;
create function public.t_gp_cost_rows(p_product uuid) returns bigint language sql security definer as $$
  select count(*) from public.product_costs where product_id = p_product $$;

create function public.t_gp_rule_id(p_branch uuid) returns uuid language sql security definer as $$
  select id from public.branch_promotions where branch_id = p_branch and active $$;
create function public.t_gp_pack_version(p_product uuid) returns uuid language sql security definer as $$
  select id from public.product_pack_versions where product_id = p_product and valid_to is null $$;
create function public.t_gp_items_doc(p_from integer, p_to integer) returns jsonb language sql security definer as $$
  select jsonb_agg(to_jsonb(si) order by si.id) from public.sale_items si
  where si.sale_id in (select public.t_gp_sale(g) from generate_series(p_from, p_to) g) $$;

create function public.t_gp_pack_bps(p_sku text) returns integer language sql security definer as $$
  select pack_discount_bps from public.products where sku = p_sku $$;
create function public.t_gp_versions(p_product uuid) returns bigint language sql security definer as $$
  select count(*) from public.product_pack_versions where product_id = p_product $$;
-- Todo el archivo corre en UNA transacción (now() no avanza): lo creado con clock_timestamp() "todavía no rige" para pull_pos_state /
-- get_pos_commercial_config / complete_production_batch, que miran now(). Este helper retrocede las vigencias (como superusuario, con
-- el trigger de historia inmutable apagado), fila por fila y de la más vieja a la más nueva para no solapar rangos.
create function public.t_gp_backdate(p_org uuid, p_interval interval) returns void language plpgsql as $$
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

-- Precio efectivo que vería el POS de una sucursal: el de la sucursal (si hay uno vigente) gana sobre el global (misma regla de pull_pos_state).
create function public.t_gp_effective(p_product uuid, p_branch uuid) returns bigint language sql security definer as $$
  select price_cents from public.product_prices
  where product_id = p_product and (branch_id = p_branch or branch_id is null) and valid_from <= clock_timestamp() and (valid_to is null or valid_to > clock_timestamp())
  order by (branch_id = p_branch) desc nulls last, valid_from desc limit 1 $$;
create function public.t_gp_by_sku(p_sku text) returns uuid language sql security definer as $$ select id from public.products where sku = p_sku $$;

create temp table keep(name text primary key, id uuid, payload jsonb, n bigint, doc jsonb);
grant all on keep to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Sin configurar (estado de la migración): ningún precio se deriva, el comportamiento anterior se conserva
-- ---------------------------------------------------------------------------------------------
select is((select count(*) from public.organization_pricing_settings), 0::bigint, 'the migration configures nothing: no row, no margin, no recalculation');
select lives_ok($$select public.set_product_cost('e5000000-0000-4000-8000-00000000000b', 450000, clock_timestamp())$$, 'a cost is saved while the margin is not configured');
select is(public.t_gp_cost('e5000000-0000-4000-8000-00000000000b'), 450000::bigint, 'the new cost is the current cost');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000b'), 600000::bigint, 'and the list price is untouched (no margin to derive it from)');
select is(public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000b'), 1::bigint, 'no price vigencia was opened');
select is((public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":400000}]'::jsonb, clock_timestamp()) ->> 'marginConfigured')::boolean, false, 'the bulk cost editor reports that the margin is not configured');
select is(public.t_gp_cost('e5000000-0000-4000-8000-00000000000b'), 400000::bigint, 'the bulk cost was saved');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000b'), 600000::bigint, 'and prices still did not move');
select is((select pack_discount_bps from public.products where sku = 'GP-H'), 1500, 'products keep their own pack discount until the global one is configured');
select is((select count(*) from public.branch_promotions), 0::bigint, 'no branch promotion was created');

-- Validaciones de la configuración.
select throws_ok($$select public.save_pricing_config(0, 1500, 2000, 1200)$$, '22023', null, 'margin 0 % is rejected');
select throws_ok($$select public.save_pricing_config(10000, 1500, 2000, 1200)$$, '22023', null, 'margin 100 % is rejected');
select throws_ok($$select public.save_pricing_config(-5, 1500, 2000, 1200)$$, '22023', null, 'a negative margin is rejected');
select throws_ok($$select public.save_pricing_config(null, 1500, 2000, 1200)$$, '22023', null, 'a missing margin is rejected');
select throws_ok($$select public.save_pricing_config(3000, 10000, 2000, 1200)$$, '22023', null, 'a 100 % 3u discount is rejected');
select throws_ok($$select public.save_pricing_config(3000, -1, 2000, 1200)$$, '22023', null, 'a negative 3u discount is rejected');
select throws_ok($$select public.save_pricing_config(3000, 1500, -1, 1200)$$, '22023', null, 'a negative pack discount is rejected (0 % is valid: a pack without discount)');
select throws_ok($$select public.save_pricing_config(3000, 1500, 10000, 1200)$$, '22023', null, 'a 100 % pack discount is rejected');
select throws_ok($$select public.save_pricing_config(3000, 1500, 2000, 10000)$$, '22023', null, 'a 100 % card surcharge is rejected');
select throws_ok($$select public.save_pricing_config(3000, 1500, 2000, -1)$$, '22023', null, 'a negative card surcharge is rejected');
select is((select count(*) from public.organization_pricing_settings), 0::bigint, 'the rejected attempts wrote nothing');

-- ---------------------------------------------------------------------------------------------
-- Vista previa (sin confirmar no se escribe NADA)
-- ---------------------------------------------------------------------------------------------
insert into keep select 'preview', null, null, null, public.save_pricing_config(3000, 1500, 2000, 1200);
select is((select (doc ->> 'requiresConfirmation')::boolean from keep where name = 'preview'), true, 'changing the margin without confirming returns a preview');
select is((select (doc ->> 'marginBps')::int from keep where name = 'preview'), 3000, 'it echoes the new margin');
select is((select doc -> 'previousMarginBps' from keep where name = 'preview'), 'null'::jsonb, 'with no previous margin');
select is((select (doc ->> 'recalculated')::int from keep where name = 'preview'), 2, 'preview: 2 prices would change (Aceite, Yerba)');
select is((select (doc ->> 'unchanged')::int from keep where name = 'preview'), 1, 'preview: 1 already has that price (Azúcar)');
select is((select (doc ->> 'scheduledPrice')::int from keep where name = 'preview'), 1, 'preview: 1 has a scheduled price and is respected (Programado)');
select is((select (doc ->> 'withoutCost')::int from keep where name = 'preview'), 5, 'preview: 5 sellable products have no usable cost (Vacío, Coca, Producto 3u, Leche, and Producto cero whose cost is $0)');
select is((select count(*) from public.organization_pricing_settings), 0::bigint, 'the preview wrote no settings');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000a'), 1000000::bigint, 'the preview changed no price');
select is((select pack_discount_bps from public.products where sku = 'GP-H'), 1500, 'the preview changed no pack');
select is((select count(*) from public.branch_promotions), 0::bigint, 'the preview created no promotion');
select is((select count(*) from public.organization_cash_discounts where organization_id = 'e2000000-0000-4000-8000-000000000001'), 0::bigint, 'the preview did not touch the card surcharge');

-- ---------------------------------------------------------------------------------------------
-- Confirmar: margen 30 %, "llevando 3u" 15 %, pack 20 %, tarjeta 12 %
-- ---------------------------------------------------------------------------------------------
insert into keep select 'cfg30', null, null, null, public.save_pricing_config(3000, 1500, 2000, 1200, true);
select is((select (doc ->> 'requiresConfirmation')::boolean from keep where name = 'cfg30'), false, 'the confirmed call applies the configuration');
select is((select (doc ->> 'recalculated')::int from keep where name = 'cfg30'), 2, 'result: 2 prices recalculated');
select is((select (doc ->> 'unchanged')::int from keep where name = 'cfg30'), 1, 'result: 1 unchanged');
select is((select (doc ->> 'scheduledPrice')::int from keep where name = 'cfg30'), 1, 'result: 1 scheduled price respected');
select is((select (doc ->> 'withoutCost')::int from keep where name = 'cfg30'), 5, 'result: 5 without cost');
select is((select (doc ->> 'packsUpdated')::int from keep where name = 'cfg30'), 2, 'result: 2 packs moved to the global discount');
select is((select (doc ->> 'branchPromotionsUpdated')::int from keep where name = 'cfg30'), 2, 'result: the two branches of the organization got the promotion');
select is((select (doc ->> 'cardSurchargeChanged')::boolean from keep where name = 'cfg30'), true, 'result: the card surcharge was written');
select is((select margin_bps || '/' || unit_bulk_discount_bps || '/' || pack_discount_bps from public.organization_pricing_settings where organization_id = 'e2000000-0000-4000-8000-000000000001'), '3000/1500/2000', 'the global configuration is stored in basis points');

-- Aceite: costo $10.000 + margen 30 % => $14.285,71; el precio anterior queda como historia.
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000a'), 1428571::bigint, 'Aceite: new list price $14.285,71');
select is(public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000a'), 2::bigint, 'Aceite: a NEW vigencia was opened (2 rows)');
select is((select price_cents from public.product_prices where product_id = 'e5000000-0000-4000-8000-00000000000a' and valid_to is not null), 1000000::bigint, 'Aceite: the old row keeps its price $10.000 (history is never rewritten)');
select ok((select valid_to is not null and valid_to <= (select valid_from from public.product_prices where product_id = 'e5000000-0000-4000-8000-00000000000a' and valid_to is null) from public.product_prices where product_id = 'e5000000-0000-4000-8000-00000000000a' and valid_to is not null), 'Aceite: the old vigencia closes exactly where the new one opens');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000b'), 571429::bigint, 'Yerba: cost $4.000 -> $5.714,29');
select is(public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000d'), 1::bigint, 'Azúcar: already at the right price, no vigencia noise');
-- Sin costo: ni se inventa ni se pone en 0 ni se borra.
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000c'), 777700::bigint, 'Vacío (no cost): keeps its price');
select is(public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000c'), 1::bigint, 'Vacío (no cost): no new row');
select is((select count(*) from public.product_prices where product_id in ('e5000000-0000-4000-8000-000000000011', 'e5000000-0000-4000-8000-000000000012', 'e5000000-0000-4000-8000-000000000013') and valid_to is not null), 0::bigint, 'products without cost (Coca, 3u, Leche) were not touched');
select is((select count(*) from public.product_prices where price_cents <= 0 and organization_id = 'e2000000-0000-4000-8000-000000000001'), 0::bigint, 'no $0 price was created');
select is(public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000e'), 0::bigint, 'a pure raw material never gets a sale price');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-000000000014') || '/' || public.t_gp_price_rows('e5000000-0000-4000-8000-000000000014'), '123400/1', 'a $0 cost is "no cost": its price is neither recalculated nor zeroed');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000f'), 111100::bigint, 'an inactive product is not repriced');
select is(public.t_gp_price_rows('e5000000-0000-4000-8000-000000000010'), 2::bigint, 'a scheduled price is respected: its two rows are untouched');
select is((select price_cents from public.product_prices where product_id = 'e5000000-0000-4000-8000-000000000010' and valid_to is null), 310000::bigint, '... and the scheduled price is still the scheduled one');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-000000000020'), 100000::bigint, 'another organization''s product is untouched');

-- Packs: el descuento global se materializa y versiona.
select is((select pack_discount_bps from public.products where sku = 'GP-H'), 2000, 'Coca: pack discount is now the global 20 %');
select is((select pack_discount_bps from public.products where sku = 'GP-J'), 2000, 'Leche: its own 25 % was replaced by the global 20 %');
select is(public.t_gp_pack_bps('GPB-Z'), 1000, 'the other organization''s pack keeps its own 10 %');
select is((select count(*) from public.product_pack_versions where product_id = 'e5000000-0000-4000-8000-000000000011'), 2::bigint, 'Coca: a new pack version was opened');
select is((select discount_bps || '/' || (valid_to is not null) from public.product_pack_versions where product_id = 'e5000000-0000-4000-8000-000000000011' and discount_bps = 1500), '1500/true', 'Coca: the old version is closed and keeps its 15 %');
select is((select discount_bps || '/' || (valid_to is null) from public.product_pack_versions where product_id = 'e5000000-0000-4000-8000-000000000011' and discount_bps = 2000), '2000/true', 'Coca: the open version carries the 20 %');
select is(public.t_gp_versions('e5000000-0000-4000-8000-000000000020'), 1::bigint, 'the other organization''s pack was not versioned');

-- "Llevando 3u": una regla "desde 3" en cada sucursal de la organización (la fuente que lee el POS).
select is((select count(*) from public.branch_promotions where organization_id = 'e2000000-0000-4000-8000-000000000001' and active), 2::bigint, 'one active rule per branch of the organization');
select is((select count(*) from public.branch_promotions where organization_id = 'e2000000-0000-4000-8000-000000000002'), 0::bigint, 'none for the other organization');
select is((select string_agg(distinct semantics || '/' || minimum_units || '/' || discount_bps, ',') from public.branch_promotions where active), 'FROM_MINIMUM/3/1500', 'FROM_MINIMUM from exactly 3 units at 15 % (never EVERY_GROUP)');

-- Recargo por tarjeta: la infraestructura existente.
select is((select cash_discount_bps from public.organization_cash_discounts where organization_id = 'e2000000-0000-4000-8000-000000000001' and valid_to is null), 1200, 'the card surcharge is stored where it always was (12 %)');
select is((select count(*) from public.audit_logs where organization_id = 'e2000000-0000-4000-8000-000000000001' and entity_type = 'organization_pricing_settings'), 1::bigint, 'saving the configuration is audited');

-- ---------------------------------------------------------------------------------------------
-- Idempotencia: guardar lo mismo no escribe nada
-- ---------------------------------------------------------------------------------------------
insert into keep select 'again', null, null, null, public.save_pricing_config(3000, 1500, 2000, 1200);
select is((select (doc ->> 'requiresConfirmation')::boolean from keep where name = 'again'), false, 'the same margin needs no confirmation');
select is((select (doc ->> 'recalculated')::int + (doc ->> 'packsUpdated')::int + (doc ->> 'branchPromotionsUpdated')::int from keep where name = 'again'), 0, 'saving the same values changes nothing');
select is((select (doc ->> 'cardSurchargeChanged')::boolean from keep where name = 'again'), false, 'not even the surcharge history');
select is(public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000a'), 2::bigint, 'Aceite still has 2 price rows');
select is((select count(*) from public.product_pack_versions where product_id = 'e5000000-0000-4000-8000-000000000011'), 2::bigint, 'Coca still has 2 pack versions');
select is((select count(*) from public.branch_promotions where organization_id = 'e2000000-0000-4000-8000-000000000001'), 2::bigint, 'still 2 promotion rows');

-- ---------------------------------------------------------------------------------------------
-- Costo nuevo => precio nuevo, en la misma operación
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.set_product_cost('e5000000-0000-4000-8000-00000000000b', 350000, clock_timestamp())$$, 'Yerba: the cost drops to $3.500');
select is(public.t_gp_cost('e5000000-0000-4000-8000-00000000000b'), 350000::bigint, 'the new cost is current');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000b'), 500000::bigint, 'and the list price follows: $3.500 / 0,70 = $5.000');
select is(public.t_gp_cost_rows('e5000000-0000-4000-8000-00000000000b'), 4::bigint, 'cost history keeps every vigencia ($4.000 initial, $4.500, $4.000, $3.500)');
select is(public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000b'), 3::bigint, 'price history keeps every vigencia (manual $6.000, $5.714,29, $5.000)');
insert into keep select 'bulk1', null, null, null, public.bulk_set_product_costs(
  '[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":400000},{"productId":"e5000000-0000-4000-8000-00000000000a","costCents":1000000},{"productId":"e5000000-0000-4000-8000-00000000000c","costCents":600000}]'::jsonb, clock_timestamp());
select is((select doc ->> 'applied' from keep where name = 'bulk1'), '2', 'bulk: two costs changed (Aceite already had that cost: nothing to do)');
select is((select doc ->> 'costUnchanged' from keep where name = 'bulk1'), '1', 'bulk: an unchanged cost is not saved again (idempotent)');
select is((select doc ->> 'repriced' from keep where name = 'bulk1'), '2', 'bulk: both changed costs reprice');
select is((select (doc ->> 'marginConfigured')::boolean from keep where name = 'bulk1'), true, 'bulk: reports that the margin is configured');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000b'), 571429::bigint, 'Yerba is back to $4.000 -> $5.714,29');
select is(public.t_gp_cost('e5000000-0000-4000-8000-00000000000c'), 600000::bigint, 'Vacío (WEIGHT) got its first cost...');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000c'), 857143::bigint, '...and therefore a price: $6.000 / 0,70 = $8.571,43 per kg');
select is(public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000a'), 2::bigint, 'an unchanged cost opened no new price vigencia');

-- Costo en un producto que no se vende (materia prima / inactivo): se guarda, pero no nace ni cambia ningún precio.
select lives_ok($$select public.set_product_cost('e5000000-0000-4000-8000-00000000000e', 520000, clock_timestamp())$$, 'a raw material cost is saved');
select is(public.t_gp_cost('e5000000-0000-4000-8000-00000000000e') || '/' || public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000e'), '520000/0', '...without creating a sale price');
select lives_ok($$select public.set_product_cost('e5000000-0000-4000-8000-00000000000f', 520000, clock_timestamp())$$, 'an inactive product cost is saved');
select is(public.t_gp_cost('e5000000-0000-4000-8000-00000000000f') || '/' || public.t_gp_open_price('e5000000-0000-4000-8000-00000000000f') || '/' || public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000f'), '520000/111100/1', '...and its price is left alone');
-- Un costo igual al que ya da el precio vigente no abre una vigencia de precio nueva.
select lives_ok($$select public.set_product_cost('e5000000-0000-4000-8000-00000000000d', 1000000, clock_timestamp())$$, 'Azúcar: a cost that yields the very same price');
select is(public.t_gp_cost_rows('e5000000-0000-4000-8000-00000000000d') || '/' || public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000d'), '2/1', '...opens a cost vigencia but no price vigencia');
-- Un precio global programado a futuro se respeta (el costo se guarda).
select is(((public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-000000000010","costCents":250000}]'::jsonb, clock_timestamp())) ->> 'scheduledPrice')::int, 1, 'a product with a scheduled price: reported as such');
select is(public.t_gp_cost('e5000000-0000-4000-8000-000000000010') || '/' || public.t_gp_price_rows('e5000000-0000-4000-8000-000000000010'), '250000/2', '...its cost is saved and both price rows are untouched');

-- Atomicidad y validación del lote.
select throws_ok($$select public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":900000},{"productId":"e5000000-0000-4000-8000-00000000000f","costCents":900000}]'::jsonb)$$, '42501', null, 'a batch with an inactive product is rejected entirely');
select is(public.t_gp_cost('e5000000-0000-4000-8000-00000000000b'), 400000::bigint, 'nothing from the rejected batch was applied');
select throws_ok($$select public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000e","costCents":900000}]'::jsonb)$$, '42501', null, 'a pure raw material is not a sale product for the editor');
select throws_ok($$select public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":0}]'::jsonb)$$, '22023', null, 'a zero cost is rejected');
select throws_ok($$select public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":-5}]'::jsonb)$$, '22023', null, 'a negative cost is rejected');
select throws_ok($$select public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":12.5}]'::jsonb)$$, '22023', null, 'a fractional cent is rejected');
select throws_ok($$select public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":100},{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":200}]'::jsonb)$$, '22023', null, 'the same product twice in one batch is rejected');
select throws_ok($$select public.bulk_set_product_costs('[]'::jsonb)$$, '22023', 'Debe enviar entre 1 y 500 costos', 'an empty batch is rejected');
select throws_ok($$select public.bulk_set_product_costs('{"productId":"x"}'::jsonb)$$, '22023', 'Debe enviar entre 1 y 500 costos', 'a non-array payload is rejected');
select throws_ok($$select public.bulk_set_product_costs((select jsonb_agg(jsonb_build_object('productId', 'e5000000-0000-4000-8000-00000000000b', 'costCents', 100)) from generate_series(1, 501)))$$, '22023', 'Debe enviar entre 1 y 500 costos', '501 items is over the limit');
select throws_ok($$select public.set_product_cost('e5000000-0000-4000-8000-00000000000b', 0)$$, '22023', 'Cost must be positive', 'the single-cost RPC still rejects zero');

-- Un precio manual NO toca costos ni configuración (el precio manual de Central por línea tampoco: se resuelve en la venta).
select lives_ok($$select public.set_product_price('e5000000-0000-4000-8000-00000000000a', null, 1499900, clock_timestamp())$$, 'a manual price override can still be set explicitly');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000a'), 1499900::bigint, 'the manual price is the list price');
select is(public.t_gp_cost('e5000000-0000-4000-8000-00000000000a'), 1000000::bigint, 'it did not change the cost');
select is((select margin_bps from public.organization_pricing_settings where organization_id = 'e2000000-0000-4000-8000-000000000001'), 3000, 'nor the global margin');
select lives_ok($$select public.set_product_price('e5000000-0000-4000-8000-00000000000a', null, 1428571, clock_timestamp())$$, 'and it is put back to the derived price for the rest of the test');

-- ---------------------------------------------------------------------------------------------
-- Precios por sucursal: un precio vigente de sucursal GANA sobre el global, así que se informan (y se pueden cerrar), nunca se ocultan
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.set_product_price('e5000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-000000000001', 999900, clock_timestamp())$$, 'Yerba gets a Central-only price');
select lives_ok($$select public.set_product_price('e5000000-0000-4000-8000-00000000000d', 'e3000000-0000-4000-8000-000000000002', 888800, clock_timestamp())$$, 'Azúcar gets an Avenida-only price');
select lives_ok($$select public.set_product_price('e5000000-0000-4000-8000-000000000013', 'e3000000-0000-4000-8000-000000000001', 150000, clock_timestamp())$$, 'Leche (no cost) gets a Central-only price');
select is(public.t_gp_effective('e5000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-000000000001'), 999900::bigint, 'precedence: the Central price WINS over the global one in Central');
select is(public.t_gp_effective('e5000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-000000000002'), 571429::bigint, '...and Avenida (no override) keeps seeing the global price');
select is(((public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":410000}]'::jsonb, clock_timestamp())) ->> 'branchOverrides')::int, 1, 'a cost change reports that the product has a branch price that keeps winning');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000b'), 585714::bigint, 'the GLOBAL price followed the cost ($4.100 / 0,70)');
select is(public.t_gp_effective('e5000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-000000000001'), 999900::bigint, '...but Central still sells at the old branch price: the problem is visible, not hidden');
select lives_ok($$select public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":400000}]'::jsonb, clock_timestamp())$$, 'Yerba cost back to $4.000');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000b'), 571429::bigint, '...and its global price with it');

-- ---------------------------------------------------------------------------------------------
-- POS: dispositivo, catálogo y lo que recibe
-- ---------------------------------------------------------------------------------------------
reset role;
select public.t_gp_backdate('e2000000-0000-4000-8000-000000000001', interval '2 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.register_pos_device('e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'Caja Central')$$, 'the Central device is registered');
select is(
  (select (i ->> 'pricePerKgCents') from jsonb_array_elements(public.pull_pos_state('e7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Aceite'),
  '1428571', 'the POS receives the FORMED list price (it never recomputes it from a cost)');
select ok(not (public.pull_pos_state('e7000000-0000-4000-8000-000000000001', 0)::text ilike '%cost%'), 'the POS payload exposes no cost');
select ok(not (public.pull_pos_state('e7000000-0000-4000-8000-000000000001', 0)::text ilike '%margin%'), 'nor the margin');
select is(
  (select (i ->> 'packSizeUnits') || '/' || (i ->> 'packDiscountBps') from jsonb_array_elements(public.pull_pos_state('e7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Coca'),
  '6/2000', 'the POS receives the pack size and the global discount');
select is(
  (select (r ->> 'minimumUnits') || '/' || (r ->> 'discountBps') from jsonb_array_elements(public.pull_pos_state('e7000000-0000-4000-8000-000000000001', 0) -> 'branchPromotionsFromMinimum') r),
  '3/1500', 'the POS receives the "desde 3" rule at 15 %');
select is(public.pull_pos_state('e7000000-0000-4000-8000-000000000001', 0) -> 'branchPromotions', '[]'::jsonb, 'the legacy "cada N" key stays empty');
select is(
  (select (i ->> 'pricePerKgCents') from jsonb_array_elements(public.pull_pos_state('e7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Yerba'),
  '999900', 'the Central POS receives the BRANCH price of Yerba, not the global one (the override really shadows it)');
select is((public.get_pos_commercial_config('e3000000-0000-4000-8000-000000000001') ->> 'cashDiscountBps')::int, 1200, 'the POS commercial config carries the card surcharge (12 %)');

-- Día 1: ventas offline armadas ahora, con lo vigente (se sincronizan DESPUÉS de cambiar la configuración).
insert into keep select 'rule15', public.t_gp_rule_id('e3000000-0000-4000-8000-000000000001'), null, null, null;
insert into keep select 'day1-aceite', null, public.t_gp_payload(1, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-00000000000a', 'Aceite', 1, 1428571)), clock_timestamp()), null, null;
insert into keep select 'day1-pack', null, public.t_gp_payload(2, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000011', 'Coca', 1, 200000, 'PACK', 6, 2000)), clock_timestamp()), null, null;
insert into keep select 'day1-3u', null, public.t_gp_payload(3, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000012', 'Producto 3u', 3, 540000, 'PROMO', null, null, (select id from keep where name = 'rule15'), 1500)), clock_timestamp()), null, null;
insert into keep select 'day1-2u', null, public.t_gp_payload(4, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000012', 'Producto 3u', 2, 540000)), clock_timestamp()), null, null;
insert into keep select 'packv20', public.t_gp_pack_version('e5000000-0000-4000-8000-000000000011'), null, null, null;

-- ---------------------------------------------------------------------------------------------
-- Día 2: margen 35 %, 3u 10 %, pack 25 %, tarjeta 10 %
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into keep select 'preview35', null, null, null, public.save_pricing_config(3500, 1000, 2500, 1000);
select is((select (doc ->> 'requiresConfirmation')::boolean from keep where name = 'preview35'), true, 'a margin change asks for confirmation again');
select is((select (doc ->> 'branchOverrides')::int || '/' || (doc ->> 'branchOverridesOther')::int from keep where name = 'preview35'), '2/1', 'preview: 2 branch prices (Yerba, Azúcar) would shadow the new global price; 1 more (Leche, no cost) is outside the recalculation');
select is((select (doc ->> 'recalculated')::int || '/' || (doc ->> 'unchanged')::int || '/' || (doc ->> 'previousMarginBps') from keep where name = 'preview35'), '4/0/3000', 'preview: 4 would change (Aceite, Yerba, Vacío, Azúcar), previous margin 30 %');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000a'), 1428571::bigint, 'still nothing written by the preview');
insert into keep select 'cfg35', null, null, null, public.save_pricing_config(3500, 1000, 2500, 1000, true);
select is((select (doc ->> 'branchOverrides')::int || '/' || (doc ->> 'branchOverridesClosed')::int from keep where name = 'cfg35'), '2/0', 'confirming WITHOUT asking to close them leaves the 2 branch prices in force and says so');
select is(public.t_gp_effective('e5000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-000000000001'), 999900::bigint, '...Yerba in Central still shows the branch price, not the new global $6.153,85');
select is((select (doc ->> 'recalculated')::int from keep where name = 'cfg35'), 4, 'margin 35 %: 4 prices recalculated');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000a'), 1538462::bigint, 'Aceite: $10.000 / 0,65 = $15.384,62');
select is(public.t_gp_price_rows('e5000000-0000-4000-8000-00000000000a'), 5::bigint, 'Aceite: every previous vigencia is still there (5 rows incl. the manual excursion)');
select is((select price_cents from public.product_prices where product_id = 'e5000000-0000-4000-8000-00000000000a' and valid_to is not null order by valid_from limit 1), 1000000::bigint, 'the oldest row still says $10.000');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000b'), 615385::bigint, 'Yerba: $4.000 / 0,65 = $6.153,85');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000c'), 923077::bigint, 'Vacío: $6.000 / 0,65 = $9.230,77 per kg');
select is((select (doc ->> 'scheduledPrice')::int from keep where name = 'cfg35'), 1, 'the scheduled price is still respected');
select is((select (doc ->> 'withoutCost')::int from keep where name = 'cfg35'), 4, 'now 4 sellable products have no usable cost (Coca, Producto 3u, Leche, Producto cero)');
select is((select pack_discount_bps from public.products where sku = 'GP-H'), 2500, 'packs now carry the new global 25 %');
select is((select count(*) from public.product_pack_versions where product_id = 'e5000000-0000-4000-8000-000000000011'), 3::bigint, 'Coca now has 3 pack versions');
select is((select string_agg(discount_bps::text, ',' order by discount_bps) from public.product_pack_versions where product_id = 'e5000000-0000-4000-8000-000000000011'), '1500,2000,2500', 'and every old version kept its own percentage');
select is((select count(*) from public.branch_promotions where branch_id = 'e3000000-0000-4000-8000-000000000001'), 2::bigint, 'the promotion was VERSIONED (2 rows for Central)');
select is((select discount_bps from public.branch_promotions where branch_id = 'e3000000-0000-4000-8000-000000000001' and not active), 1500, 'the closed rule keeps its 15 %');
select is((select discount_bps from public.branch_promotions where branch_id = 'e3000000-0000-4000-8000-000000000001' and active), 1000, 'the open rule says 10 %');
select isnt((select id from public.branch_promotions where branch_id = 'e3000000-0000-4000-8000-000000000001' and active), (select id from keep where name = 'rule15'), 'with a new id (a sale keeps the id of the rule it used)');
select is((select count(*) from public.organization_cash_discounts where organization_id = 'e2000000-0000-4000-8000-000000000001'), 2::bigint, 'the card surcharge keeps its history (12 % closed, 10 % open)');
select is((select cash_discount_bps from public.organization_cash_discounts where organization_id = 'e2000000-0000-4000-8000-000000000001' and valid_to is null), 1000, 'the open card surcharge is 10 %');

-- Un cambio de costo posterior a la venta del Día 1 tampoco debe reescribir su costo histórico.
select lives_ok($$select public.set_product_cost('e5000000-0000-4000-8000-00000000000a', 700000, clock_timestamp())$$, 'Aceite cost changes AFTER the Day 1 sale was made');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000a'), 1076923::bigint, 'and its list price follows: $7.000 / 0,65');

-- ---------------------------------------------------------------------------------------------
-- Las ventas offline del Día 1 sincronizan DESPUÉS del cambio y conservan lo que tenían
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.t_gp_sync((select payload from keep where name = 'day1-aceite'))$$, 'Day 1: the Aceite sale ($14.285,71) syncs after the margin and the cost changed');
select lives_ok($$select public.t_gp_sync((select payload from keep where name = 'day1-pack'))$$, 'Day 1: the Coca pack (6 units at 20 %) syncs after the pack moved to 25 %');
select lives_ok($$select public.t_gp_sync((select payload from keep where name = 'day1-3u'))$$, 'Day 1: the "3u" sale (rule at 15 %) syncs after the rule moved to 10 %');
select lives_ok($$select public.t_gp_sync((select payload from keep where name = 'day1-2u'))$$, 'two units of the same product: syncs');
select is((public.t_gp_sync((select payload from keep where name = 'day1-aceite')) ->> 'duplicate')::boolean, true, 'syncing a Day 1 sale again is idempotent');
-- Una venta con el id de la versión VIEJA pero con valores del Día 2 se rechaza.
select throws_ok($$select public.t_gp_sync(public.t_gp_payload(5, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000011', 'Coca', 1, 200000, 'PACK', 6, 2500) || jsonb_build_object('packConfigId', (select id from keep where name = 'packv20')))))$$, '22023', null, 'a 25 % pack that borrows the id of the old 20 % version is rejected');
-- Día 2: lo nuevo vale con lo nuevo.
select lives_ok($$select public.t_gp_sync(public.t_gp_payload(6, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000011', 'Coca', 1, 200000, 'PACK', 6, 2500))))$$, 'Day 2: a new pack sale uses the 25 %');
select lives_ok($$select public.t_gp_sync(public.t_gp_payload(7, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000012', 'Producto 3u', 3, 540000, 'PROMO', null, null, public.t_gp_rule_id('e3000000-0000-4000-8000-000000000001'), 1000))))$$, 'Day 2: a new "3u" sale uses the new rule (10 %)');
select throws_ok($$select public.t_gp_sync(public.t_gp_payload(8, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000011', 'Coca', 1, 200000, 'PACK', 6, 2500) || jsonb_build_object(
  'branchPromotionId', public.t_gp_rule_id('e3000000-0000-4000-8000-000000000001'), 'branchPromotionMinimumUnits', 3, 'branchPromotionDiscountBps', 1000,
  'branchPromotionDiscountedUnits', 6, 'branchPromotionDiscountCents', '120000'))))$$, '22023', null, 'a pack that also claims the global 3u discount is rejected: one discount per line, never stacked');

reset role;
select is((select original_price_per_kg_cents || '/' || subtotal_cents from public.sale_items where sale_id = public.t_gp_sale(1)), '1428571/1428571', 'Day 1 Aceite keeps its Day 1 price, not the new $15.384,62');
select is((select total_cents from public.sales where id = public.t_gp_sale(1)), 1428571::bigint, 'and its Day 1 total');
select is((select cost_cents_snapshot from public.sale_items where sale_id = public.t_gp_sale(1)), 1000000::bigint, 'with the cost of the moment of the sale ($10.000), not the current $7.000: historical profitability is untouched');
select is((select quantity_units || '/' || pack_discount_bps || '/' || pack_discount_cents || '/' || subtotal_cents || '/' || price_per_kg_cents from public.sale_items where sale_id = public.t_gp_sale(2)), '6/2000/240000/960000/160000', 'Day 1 pack: 6 x $2.000 = $12.000 - 20 % = $9.600 = $1.600 per unit, stored at the Day 1 percentage');
select is((select pack_config_id from public.sale_items where sale_id = public.t_gp_sale(2)), (select id from keep where name = 'packv20'), 'against the 20 % version it was sold with');
select is((select quantity_units || '/' || branch_promotion_discount_bps || '/' || price_per_kg_cents || '/' || subtotal_cents from public.sale_items where sale_id = public.t_gp_sale(3)), '3/1500/459000/1377000', 'Day 1 "3u": 3 units of $5.400 at 15 % = $4.590 each, stored with its own rule');
select is((select branch_promotion_id from public.sale_items where sale_id = public.t_gp_sale(3)), (select id from keep where name = 'rule15'), 'pointing at the closed 15 % rule');
select is((select price_per_kg_cents || '/' || subtotal_cents || '/' || promotion_discount_cents from public.sale_items where sale_id = public.t_gp_sale(4)), '540000/1080000/0', '1 or 2 units pay the list price with no discount');
select is((select pack_discount_bps || '/' || subtotal_cents from public.sale_items where sale_id = public.t_gp_sale(6)), '2500/900000', 'Day 2 pack: $12.000 - 25 % = $9.000');
select is((select price_per_kg_cents || '/' || subtotal_cents from public.sale_items where sale_id = public.t_gp_sale(7)), '486000/1458000', 'Day 2 "3u": 3 x $5.400 - 10 % = $4.860 each');
insert into keep select 'day1-items', null, null, null, public.t_gp_items_doc(1, 4);
select is(jsonb_array_length((select doc from keep where name = 'day1-items')), 4, 'the four Day 1 sale lines are on record (snapshot taken to prove they never change below)');
set local role authenticated;


-- ---------------------------------------------------------------------------------------------
-- Cerrar precios por sucursal (nunca borrar): vuelve a regir el global y el historial queda
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.close_branch_price_overrides()$$, '42501', 'Permission prices.write is required', 'an employee cannot close branch prices');
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.close_branch_price_overrides(array['e5000000-0000-4000-8000-00000000000b']::uuid[]) ->> 'closed')::int, 1, 'closing the branch prices of one product closes exactly that one');
select is(public.t_gp_effective('e5000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-000000000001'), 615385::bigint, 'Central now sees the global price of Yerba ($6.153,85)');
select is(public.t_gp_effective('e5000000-0000-4000-8000-00000000000d', 'e3000000-0000-4000-8000-000000000002'), 888800::bigint, 'the other overrides are untouched');
select is((public.close_branch_price_overrides() ->> 'closed')::int, 2, 'closing all the rest closes the other 2');
select is(public.t_gp_effective('e5000000-0000-4000-8000-00000000000d', 'e3000000-0000-4000-8000-000000000002'), 1538462::bigint, 'Avenida now sees the global price of Azúcar too');
select is((select count(*) from public.product_prices where branch_id is not null and valid_to is null), 0::bigint, 'no branch price is in force any more');
select is((select count(*) from public.product_prices where branch_id is not null), 3::bigint, 'but the 3 rows are still in the history (closed, never deleted)');
select is((select price_cents from public.product_prices where product_id = 'e5000000-0000-4000-8000-00000000000b' and branch_id is not null), 999900::bigint, 'and a closed branch price keeps its value');

-- Un cambio de margen que CIERRA los precios por sucursal de los productos que reprecia (la opción de la confirmación).
select lives_ok($$select public.set_product_price('e5000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-000000000001', 777700, clock_timestamp())$$, 'Yerba gets a new Central-only price');
insert into keep select 'preview36', null, null, null, public.save_pricing_config(3600, 1000, 2500, 1000);
select is((select (doc ->> 'branchOverrides')::int from keep where name = 'preview36'), 1, 'the preview of a margin change warns about it');
insert into keep select 'cfg36', null, null, null, public.save_pricing_config(3600, 1000, 2500, 1000, true, true);
select is((select (doc ->> 'branchOverridesClosed')::int from keep where name = 'cfg36'), 1, 'confirming with "close them" closes it in the same transaction');
select is(public.t_gp_effective('e5000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-000000000001'), 625000::bigint, 'Central sees the new global price: $4.000 / 0,64 = $6.250');
select is((select count(*) from public.product_prices where product_id = 'e5000000-0000-4000-8000-00000000000b' and branch_id is not null and valid_to is not null), 2::bigint, 'both Central rows of Yerba are history now');
select lives_ok($$select public.save_pricing_config(3500, 1000, 2500, 1000, true)$$, 'margin back to 35 % for the rest of the test');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000b'), 615385::bigint, '...and Yerba is back at $6.153,85');

-- Con los precios por sucursal cerrados: el POS recibe el precio GLOBAL, el sync deja de aceptar el viejo y el historial queda
reset role;
select public.t_gp_backdate('e2000000-0000-4000-8000-000000000001', interval '3 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(
  (select (i ->> 'pricePerKgCents') from jsonb_array_elements(public.pull_pos_state('e7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Yerba'),
  '615385', 'after closing the branch prices the Central POS receives the new GLOBAL price of Yerba');
select lives_ok($$select public.t_gp_sync(public.t_gp_payload(30, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-00000000000b', 'Yerba', 1, 615385))))$$, 'a sale at the global price syncs');
-- (El sync offline no relee product_prices: el precio de lista de una venta es el snapshot que trae la caja; por eso lo que importa es lo que la caja RECIBE, probado arriba.)
reset role;
select is((select original_price_per_kg_cents from public.sale_items where sale_id = public.t_gp_sale(30)), 615385::bigint, 'the accepted sale carries the global list price as its snapshot');
select is((select count(*) from public.product_prices where product_id = 'e5000000-0000-4000-8000-00000000000b' and branch_id is not null and valid_to is not null), 2::bigint, 'history intact: both closed Central rows of Yerba are still there');
select is((select string_agg(price_cents::text, ',' order by price_cents) from public.product_prices where product_id = 'e5000000-0000-4000-8000-00000000000b' and branch_id is not null), '777700,999900', '...with their original prices');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Pack: el producto sólo define las unidades; el descuento sale siempre del global
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.set_product_pack_size('e5000000-0000-4000-8000-000000000011', 12, 3000)$$, 'an explicit per-product percentage is accepted but...');
select is((select pack_size_units || '/' || pack_discount_bps from public.products where sku = 'GP-H'), '12/2500', '...the global 25 % wins');
select is((select count(*) from public.product_pack_versions where product_id = 'e5000000-0000-4000-8000-000000000011' and valid_to is null), 1::bigint, 'one open version after the size change');
select lives_ok($$select public.set_product_pack_size('e5000000-0000-4000-8000-000000000012', 4)$$, 'a new pack is configured with the units only (two arguments)');
select is((select pack_size_units || '/' || pack_discount_bps from public.products where sku = 'GP-I'), '4/2500', 'it takes the global discount');
select lives_ok($$select public.set_product_pack_size('e5000000-0000-4000-8000-000000000012', null)$$, 'and the pack can be removed');
select is((select pack_size_units is null and pack_discount_bps is null from public.products where sku = 'GP-I'), true, 'leaving no pack and no discount');
select throws_ok($$select public.set_product_pack_size('e5000000-0000-4000-8000-00000000000c', 6)$$, '22023', null, 'a WEIGHT product still cannot have a pack');

-- ---------------------------------------------------------------------------------------------
-- Pack con descuento 0 %: unidades por pack y descuento son independientes; 25 % -> 0 % -> 15 % con versionado y offline
-- ---------------------------------------------------------------------------------------------
-- (Coca: pack de 12; el global está en 25 %.) Día 1 con 25 %: la venta se arma ahora y sincroniza DESPUÉS de los cambios.
insert into keep select 'p25', null, public.t_gp_payload(20, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000011', 'Coca', 1, 200000, 'PACK', 12, 2500)), clock_timestamp()), null, null;
insert into keep select 'v25', public.t_gp_pack_version('e5000000-0000-4000-8000-000000000011'), null, null, null;
select lives_ok($$select public.save_pricing_config(3500, 1000, 0, 1000)$$, 'the global pack discount goes to 0 % (no need to remove any pack)');
select is((select pack_size_units || '/' || pack_discount_bps from public.products where sku = 'GP-H'), '12/0', 'Coca keeps its pack of 12 units; its discount is 0 %');
select is((select pack_size_units || '/' || pack_discount_bps from public.products where sku = 'GP-J'), '8/0', 'Leche keeps its pack of 8 units too');
select is((select discount_bps || '/' || pack_size_units from public.product_pack_versions where product_id = 'e5000000-0000-4000-8000-000000000011' and valid_to is null), '0/12', 'a NEW version opened: 12 units at 0 %');
select is((select discount_bps from public.product_pack_versions where id = (select id from keep where name = 'v25')), 2500, 'the 25 % version is closed and keeps its 25 %');
insert into keep select 'p0', null, public.t_gp_payload(21, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000011', 'Coca', 1, 200000, 'PACK', 12, 0)), clock_timestamp()), null, null;
insert into keep select 'v0', public.t_gp_pack_version('e5000000-0000-4000-8000-000000000011'), null, null, null;
select lives_ok($$select public.save_pricing_config(3500, 1000, 1500, 1000)$$, '...and then to 15 %');
select is((select pack_size_units || '/' || pack_discount_bps from public.products where sku = 'GP-H'), '12/1500', 'Coca: 12 units at 15 %');
select is((select discount_bps || '/' || pack_size_units from public.product_pack_versions where product_id = 'e5000000-0000-4000-8000-000000000011' and valid_to is null), '1500/12', 'a third version is open: 12 units at 15 %');
select is((select discount_bps from public.product_pack_versions where id = (select id from keep where name = 'v0')), 0, 'the 0 % version is closed and keeps its 0 % (never rewritten)');
select is((select count(*) from public.product_pack_versions where product_id = 'e5000000-0000-4000-8000-000000000011' and discount_bps = 0), 1::bigint, 'there is exactly one 0 % version in the history');
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(
  (select (i ->> 'packSizeUnits') || '/' || (i ->> 'packDiscountBps') || '/' || ((i ->> 'packConfigId')::uuid = public.t_gp_pack_version('e5000000-0000-4000-8000-000000000011')) from jsonb_array_elements(public.pull_pos_state('e7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Coca'),
  '12/1500/true', 'the POS receives the pack size, the 15 % and the id of the open version');
select lives_ok($$select public.t_gp_sync((select payload from keep where name = 'p25'))$$, 'the offline sale made at 25 % syncs after the pack went 25 -> 0 -> 15');
select lives_ok($$select public.t_gp_sync((select payload from keep where name = 'p0'))$$, 'the offline sale made at 0 % syncs after the pack went to 15 %');
select lives_ok($$select public.t_gp_sync(public.t_gp_payload(22, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000011', 'Coca', 1, 200000, 'PACK', 12, 1500))))$$, 'a new sale at 15 % syncs');
select throws_ok($$select public.t_gp_sync(public.t_gp_payload(23, jsonb_build_array(public.t_gp_item('e5000000-0000-4000-8000-000000000011', 'Coca', 1, 200000, 'PACK', 12, 0) || jsonb_build_object('packConfigId', public.t_gp_pack_version('e5000000-0000-4000-8000-000000000011')))))$$, '22023', null, 'a 0 % pack that borrows the id of the open 15 % version is rejected');
reset role;
select is((select pack_discount_bps || '/' || pack_discount_cents || '/' || subtotal_cents || '/' || (pack_config_id = (select id from keep where name = 'v25')) from public.sale_items where sale_id = public.t_gp_sale(20)), '2500/600000/1800000/true', 'the Day 1 sale kept 25 %: 12 x $2.000 - 25 % = $18.000, against the 25 % version');
select is((select pack_discount_bps || '/' || pack_discount_cents || '/' || subtotal_cents || '/' || sold_as_pack || '/' || (pack_config_id = (select id from keep where name = 'v0')) from public.sale_items where sale_id = public.t_gp_sale(21)), '0/0/2400000/true/true', 'the 0 % sale: 12 units at list price $24.000, still a pack, against the 0 % version');
select is((select pack_discount_bps || '/' || subtotal_cents from public.sale_items where sale_id = public.t_gp_sale(22)), '1500/2040000', 'the 15 % sale: $24.000 - 15 % = $20.400');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Sucursal nueva: nace con la promoción global; con 3u = 0 no hay promoción en ningún lado
-- ---------------------------------------------------------------------------------------------
reset role;
insert into public.branches (id, organization_id, name, code) values ('e3000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'GP Nueva', 'GP-N');
select is((select discount_bps || '/' || semantics || '/' || minimum_units from public.branch_promotions where branch_id = 'e3000000-0000-4000-8000-000000000004' and active), '1000/FROM_MINIMUM/3', 'a new branch is born with the global "desde 3" rule');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into keep select 'off', null, null, null, public.save_pricing_config(3500, 0, 1500, 1000);
select is((select (doc ->> 'branchPromotionsUpdated')::int from keep where name = 'off'), 3, '3u = 0 switches the rule off in every branch that had one (3)');
select is((select count(*) from public.branch_promotions where organization_id = 'e2000000-0000-4000-8000-000000000001' and active), 0::bigint, 'no active promotion remains');
select is((select count(*) from public.branch_promotions where organization_id = 'e2000000-0000-4000-8000-000000000001' and discount_bps = 1000), 3::bigint, 'the closed rules keep their value (history)');
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(public.pull_pos_state('e7000000-0000-4000-8000-000000000001', 0) -> 'branchPromotionsFromMinimum', '[]'::jsonb, 'the POS receives no promotion');
reset role;
insert into public.branches (id, organization_id, name, code) values ('e3000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000001', 'GP Otra', 'GP-O');
select is((select count(*) from public.branch_promotions where branch_id = 'e3000000-0000-4000-8000-000000000005'), 0::bigint, 'and a branch created now gets none');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(((public.save_pricing_config(3500, 1500, 1500, 1000)) ->> 'branchPromotionsUpdated')::int, 4, 'switching it back on creates a rule in every branch (4)');

-- ---------------------------------------------------------------------------------------------
-- Desposte: finalizar un lote sigue alimentando el costo, sin repreciar (el precio de un corte ya cargado no se pisa)
-- ---------------------------------------------------------------------------------------------
reset role;
select public.t_gp_backdate('e2000000-0000-4000-8000-000000000001', interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.create_production_batch(
  p_source_product_id => 'e5000000-0000-4000-8000-00000000000e', p_input_weight_grams => 20000, p_cost_per_kg_cents => 420000,
  p_branch_id => 'e3000000-0000-4000-8000-000000000001', p_description => 'Media res')$$, 'a Desposte batch is created');
select lives_ok($$select public.set_production_batch_output((select id from public.production_batches where organization_id = 'e2000000-0000-4000-8000-000000000001'), 'e5000000-0000-4000-8000-00000000000c', 2000)$$, 'with the Vacío output');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000c'), 923077::bigint, 'before finalizing, Vacío has the margin price');
select lives_ok($$select public.complete_production_batch((select id from public.production_batches where organization_id = 'e2000000-0000-4000-8000-000000000001'))$$, 'the batch is finalized');
select is(public.t_gp_cost('e5000000-0000-4000-8000-00000000000c'), 4200000::bigint, 'the produced cost became the current cost');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000c'), 923077::bigint, 'production does not reprice by itself: the list price is untouched');

-- ---------------------------------------------------------------------------------------------
-- Alta de un producto en el Admin: con costo + margen el precio sale solo (misma función); sin margen/costo/activo hace falta precio manual
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.create_product_with_pricing('e4000000-0000-4000-8000-000000000001', 'Alta derivada', 'gp-alta-derivada', 'GP-ALTA', 'UNIT', true)$$, 'the Admin creates a product with no price');
select is(public.t_gp_price_rows(public.t_gp_by_sku('GP-ALTA')), 0::bigint, 'without a cost it has no price (the Admin form asks for one in that case)');
select lives_ok($$select public.set_product_cost(public.t_gp_by_sku('GP-ALTA'), 1000000, clock_timestamp())$$, 'its cost ($10.000) is loaded');
select is(public.t_gp_open_price(public.t_gp_by_sku('GP-ALTA')), 1538462::bigint, 'the price is formed by the margin (35 %): $10.000 / 0,65 = $15.384,62 with NO manual price');
select is(public.t_gp_price_rows(public.t_gp_by_sku('GP-ALTA')) || '/' || public.t_gp_cost_rows(public.t_gp_by_sku('GP-ALTA')), '1/1', 'one price vigencia and one cost vigencia, created together');
select lives_ok($$select public.create_product_with_pricing('e4000000-0000-4000-8000-000000000001', 'Alta inactiva', 'gp-alta-inactiva', 'GP-INACT', 'UNIT', false)$$, 'an INACTIVE product is created with a cost');
select lives_ok($$select public.set_product_cost(public.t_gp_by_sku('GP-INACT'), 1000000, clock_timestamp())$$, 'its cost is saved');
select is(public.t_gp_price_rows(public.t_gp_by_sku('GP-INACT')), 0::bigint, 'an inactive product forms no price from its cost (the Admin form asks for a manual one)');
select lives_ok($$select public.set_product_price(public.t_gp_by_sku('GP-ALTA'), null, 1600000, clock_timestamp())$$, 'a manual price can still be written explicitly...');
select is(public.t_gp_open_price(public.t_gp_by_sku('GP-ALTA')), 1600000::bigint, '...and it wins until the next cost or margin change');

-- ---------------------------------------------------------------------------------------------
-- Importación (margen configurado): con costo, el precio se FORMA desde el costo; sólo-precio conserva el del archivo; idempotente
-- ---------------------------------------------------------------------------------------------
reset role;
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('e5000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'Imp sin precio', 'gp-imp-sin-precio', 'IMP-X', 'UNIT', true, 'SELLABLE');
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from) values ('e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-0000000000a1', 300000, now() - interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'gp-imp-1', repeat('1', 64), 'e3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"e4000000-0000-4000-8000-000000000001","createMissingCategories":true,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'an import batch is created');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'gp-imp-1'), $j$[
  {"rowNumber":2,"externalId":"I1","payload":{"name":"Imp costo y precio","unitType":"UNIT","sku":"IMP-1","priceCents":555500,"costCents":1000000}},
  {"rowNumber":3,"externalId":"I2","payload":{"name":"Imp solo costo","unitType":"UNIT","sku":"IMP-2","costCents":400000}},
  {"rowNumber":4,"externalId":"I3","payload":{"name":"Imp solo precio","unitType":"UNIT","sku":"IMP-3","priceCents":777700}},
  {"rowNumber":5,"externalId":"I4","payload":{"name":"Imp precio 0 con costo","unitType":"UNIT","sku":"IMP-4","priceCents":0,"costCents":200000}},
  {"rowNumber":6,"externalId":"I5","payload":{"name":"Imp sin precio","unitType":"UNIT","sku":"IMP-X","costCents":300000}}
]$j$::jsonb)$t$, 'five rows are staged');
select is((public.preview_import_batch((select id from public.import_batches where file_name = 'gp-imp-1')) -> 'summary' ->> 'create')::int || '/' || (public.preview_import_batch((select id from public.import_batches where file_name = 'gp-imp-1')) -> 'summary' ->> 'update')::int, '4/1', 'preview: 4 products to create and 1 existing to link');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'gp-imp-1')) -> 'result', '{"created":4,"updated":1,"ignored":0,"skippedErrors":0}'::jsonb, 'apply creates 4 and updates the linked one');
select is(public.t_gp_open_price(public.t_gp_by_sku('IMP-1')) || '/' || public.t_gp_price_rows(public.t_gp_by_sku('IMP-1')), '1538462/1', 'cost + price in the file: the price is FORMED from the cost ($10.000 / 0,65), the file price ($5.555) is ignored and never written');
select is(public.t_gp_open_price(public.t_gp_by_sku('IMP-2')), 615385::bigint, 'only a cost: the price is formed from it ($4.000 / 0,65)');
select is(public.t_gp_open_price(public.t_gp_by_sku('IMP-3')) || '/' || public.t_gp_cost_rows(public.t_gp_by_sku('IMP-3')), '777700/0', 'only a price (no cost): the file price is kept, as before');
select is(public.t_gp_open_price(public.t_gp_by_sku('IMP-4')), 307692::bigint, 'a $0 price with a cost: the cost forms the price ($2.000 / 0,65), not a "sin precio" row');
select is(public.t_gp_open_price(public.t_gp_by_sku('IMP-X')) || '/' || public.t_gp_cost_rows(public.t_gp_by_sku('IMP-X')), '461538/1', 'an existing product with the same cost and NO price gets its price formed, without a second cost vigencia');
select is((select count(*) from public.external_entity_links where entity_type = 'product' and external_id in ('I1', 'I2', 'I3', 'I4', 'I5')), 5::bigint, 'every row is linked to its product (external_entity_links)');

-- Idempotencia: el mismo archivo otra vez no cambia nada (y otro con el mismo costo pero otro precio tampoco pisa el precio formado).
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'gp-imp-2', repeat('2', 64), 'e3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"e4000000-0000-4000-8000-000000000001","createMissingCategories":true,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'the same file is imported again');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'gp-imp-2'), $j$[
  {"rowNumber":2,"externalId":"I1","payload":{"name":"Imp costo y precio","unitType":"UNIT","sku":"IMP-1","priceCents":555500,"costCents":1000000}},
  {"rowNumber":3,"externalId":"I2","payload":{"name":"Imp solo costo","unitType":"UNIT","sku":"IMP-2","costCents":400000}},
  {"rowNumber":4,"externalId":"I3","payload":{"name":"Imp solo precio","unitType":"UNIT","sku":"IMP-3","priceCents":777700}},
  {"rowNumber":5,"externalId":"I4","payload":{"name":"Imp precio 0 con costo","unitType":"UNIT","sku":"IMP-4","priceCents":0,"costCents":200000}},
  {"rowNumber":6,"externalId":"I5","payload":{"name":"Imp sin precio","unitType":"UNIT","sku":"IMP-X","costCents":300000}}
]$j$::jsonb)$t$, 'its 5 rows are staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'gp-imp-2'))$$, 'preview of gp-imp-2');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'gp-imp-2')) -> 'result', '{"created":0,"updated":0,"ignored":5,"skippedErrors":0}'::jsonb, 're-importing the same file ignores every row (idempotent)');
select is((select count(*) from public.product_prices where product_id in (select id from public.products where sku like 'IMP-%')), 5::bigint, 'and wrote no extra price vigencia (5 products, 5 rows)');
-- (todo el archivo es una transacción: lo importado arriba abrió vigencias en now(); se retroceden para poder abrir las siguientes)
reset role;
select public.t_gp_backdate('e2000000-0000-4000-8000-000000000001', interval '1 hour');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'gp-imp-3', repeat('3', 64), 'e3000000-0000-4000-8000-000000000001',
  '{"defaultCategoryId":"e4000000-0000-4000-8000-000000000001","createMissingCategories":true,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'a changed file is imported');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'gp-imp-3'), $j$[
  {"rowNumber":2,"externalId":"I1","payload":{"name":"Imp costo y precio v2","unitType":"UNIT","sku":"IMP-1","priceCents":999900,"costCents":1000000}},
  {"rowNumber":3,"externalId":"I2","payload":{"name":"Imp solo costo","unitType":"UNIT","sku":"IMP-2","costCents":500000}},
  {"rowNumber":4,"externalId":"I3","payload":{"name":"Imp solo precio","unitType":"UNIT","sku":"IMP-3","priceCents":800000}}
]$j$::jsonb)$t$, 'three changed rows are staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'gp-imp-3'))$$, 'preview of gp-imp-3');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'gp-imp-3')) -> 'result', '{"created":0,"updated":3,"ignored":0,"skippedErrors":0}'::jsonb, 'three products are updated');
select is(public.t_gp_open_price(public.t_gp_by_sku('IMP-1')) || '/' || public.t_gp_price_rows(public.t_gp_by_sku('IMP-1')) || '/' || public.t_gp_cost_rows(public.t_gp_by_sku('IMP-1')), '1538462/1/1', 'same cost, different file price: the formed price is NOT overwritten by the file price (no new vigencia)');
select is(public.t_gp_open_price(public.t_gp_by_sku('IMP-2')) || '/' || public.t_gp_price_rows(public.t_gp_by_sku('IMP-2')), '769231/2', 'a changed cost re-forms the price ($5.000 / 0,65) and opens a new vigencia (history kept)');
select is(public.t_gp_open_price(public.t_gp_by_sku('IMP-3')) || '/' || public.t_gp_price_rows(public.t_gp_by_sku('IMP-3')), '800000/2', 'a price-only row still sets the file price (compatibility)');

-- ---------------------------------------------------------------------------------------------
-- Seguridad y aislamiento
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.save_pricing_config(3000, 1500, 2000, 1200, true)$$, '42501', 'Permission prices.write is required', 'an employee cannot save the pricing config');
select throws_ok($$select public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":100}]'::jsonb)$$, '42501', 'Permission prices.write is required', 'an employee cannot bulk-set costs');
select throws_ok($$select public.set_product_cost('e5000000-0000-4000-8000-00000000000b', 100)$$, '42501', 'Permission prices.write is required', 'nor set a single cost');
select is((select count(*) from public.organization_pricing_settings), 0::bigint, 'an employee reads no pricing settings (RLS)');

-- Un rol con sólo prices.write puede cambiar margen y recargo, pero no promociones ni packs.
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$select public.save_pricing_config(3500, 2000, 1500, 1000)$$, '42501', 'Permission catalog.write is required', 'changing the 3u discount needs catalog.write');
select throws_ok($$select public.save_pricing_config(3500, 1500, 3000, 1000)$$, '42501', 'Permission products.write is required', 'changing the pack discount needs products.write');
select lives_ok($$select public.save_pricing_config(3500, 1500, 1500, 800)$$, 'a prices.write-only role can change the card surcharge (nothing else moves)');
select is((select cash_discount_bps from public.organization_cash_discounts where organization_id = 'e2000000-0000-4000-8000-000000000001' and valid_to is null), 800, 'it was applied');

-- Otra organización: no ve ni toca la nuestra, y su configuración es independiente.
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.bulk_set_product_costs('[{"productId":"e5000000-0000-4000-8000-00000000000b","costCents":100}]'::jsonb)$$, '42501', null, 'org B cannot bulk-set the cost of an org A product');
select throws_ok($$select public.set_product_cost('e5000000-0000-4000-8000-00000000000b', 100)$$, '42501', 'Product was not found in this organization', 'nor a single one');
select is((select count(*) from public.organization_pricing_settings), 0::bigint, 'org B reads none of org A''s settings');
select lives_ok($$select public.create_product_with_pricing('e4000000-0000-4000-8000-000000000002', 'B alta', 'gpb-alta', 'GPB-ALTA', 'UNIT', true)$$, 'org B (no margin configured) creates a product');
select lives_ok($$select public.set_product_cost(public.t_gp_by_sku('GPB-ALTA'), 1000000, clock_timestamp())$$, 'and loads its cost');
select is(public.t_gp_price_rows(public.t_gp_by_sku('GPB-ALTA')), 0::bigint, 'without a margin the cost forms no price: the manual price is required (the form says why)');
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'gpb-imp-1', repeat('4', 64), 'e3000000-0000-4000-8000-000000000003',
  '{"defaultCategoryId":"e4000000-0000-4000-8000-000000000002","createMissingCategories":true,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'org B imports a file with cost AND price');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'gpb-imp-1'), $j$[
  {"rowNumber":2,"externalId":"B1","payload":{"name":"Imp B","unitType":"UNIT","sku":"IMPB-1","priceCents":555500,"costCents":1000000}}
]$j$::jsonb)$t$, 'one row is staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'gpb-imp-1'))$$, 'preview of gpb-imp-1');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'gpb-imp-1')) -> 'result', '{"created":1,"updated":0,"ignored":0,"skippedErrors":0}'::jsonb, 'applied');
select is(public.t_gp_open_price(public.t_gp_by_sku('IMPB-1')) || '/' || public.t_gp_cost(public.t_gp_by_sku('IMPB-1')), '555500/1000000', 'WITHOUT a margin the file price is used as before (and the cost is saved)');
select is((public.save_pricing_config(3500, 2000, 3000, 500, true) ->> 'recalculated')::int, 3, 'org B configures its own margin (even if equal to org A''s): only its own products with cost are repriced (Z, B alta and Imp B)');
reset role;
select public.t_gp_backdate('e2000000-0000-4000-8000-000000000002', interval '1 hour');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select lives_ok($$select public.create_import_batch('simplygest', 'product', 'gpb-imp-2', repeat('5', 64), 'e3000000-0000-4000-8000-000000000003',
  '{"defaultCategoryId":"e4000000-0000-4000-8000-000000000002","createMissingCategories":true,"linkExistingBy":["barcode","sku"]}'::jsonb)$$, 'org B re-imports the product with a new cost');
select lives_ok($t$select public.stage_import_rows((select id from public.import_batches where file_name = 'gpb-imp-2'), $j$[
  {"rowNumber":2,"externalId":"B1","payload":{"name":"Imp B","unitType":"UNIT","sku":"IMPB-1","priceCents":555500,"costCents":1100000}}
]$j$::jsonb)$t$, 'staged');
select lives_ok($$select public.preview_import_batch((select id from public.import_batches where file_name = 'gpb-imp-2'))$$, 'preview of gpb-imp-2');
select is(public.apply_import_batch((select id from public.import_batches where file_name = 'gpb-imp-2')) -> 'result', '{"created":0,"updated":1,"ignored":0,"skippedErrors":0}'::jsonb, 'updated');
select is(public.t_gp_open_price(public.t_gp_by_sku('IMPB-1')), 1692308::bigint, 'WITH the margin now configured, the new cost forms the price ($11.000 / 0,65), not the file price');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-000000000020'), 153846::bigint, 'org B product: $1.000 at 35 % -> $1.538,46');
select is((select pack_discount_bps from public.products where sku = 'GPB-Z'), 3000, 'org B pack moved to its own global 30 %');
select is((select count(*) from public.branch_promotions where organization_id = 'e2000000-0000-4000-8000-000000000002' and active), 1::bigint, 'org B got its own promotion row');
reset role;
select is((select margin_bps from public.organization_pricing_settings where organization_id = 'e2000000-0000-4000-8000-000000000001'), 3500, 'org A margin untouched by org B');
select is(public.t_gp_open_price('e5000000-0000-4000-8000-00000000000b'), 615385::bigint, 'org A prices untouched by org B');
select is((select pack_discount_bps from public.products where sku = 'GP-H'), 1500, 'org A packs untouched by org B');
select is((select count(*) from public.organization_pricing_settings), 2::bigint, 'one settings row per organization');
select throws_ok($$insert into public.organization_pricing_settings (organization_id, margin_bps) values ('e2000000-0000-4000-8000-000000000001', 4000)$$, '23505', null, 'the table allows a single row per organization');
select throws_ok($$update public.organization_pricing_settings set margin_bps = 10000 where organization_id = 'e2000000-0000-4000-8000-000000000002'$$, '23514', null, 'the table itself refuses a 100 % margin');
select throws_ok($$update public.organization_pricing_settings set pack_discount_bps = 10000 where organization_id = 'e2000000-0000-4000-8000-000000000002'$$, '23514', null, 'and a 100 % pack discount');
select lives_ok($$update public.organization_pricing_settings set pack_discount_bps = 0 where organization_id = 'e2000000-0000-4000-8000-000000000002'$$, 'but a 0 % pack discount is valid (pack without discount)');

select is(public.t_gp_items_doc(1, 4), (select doc from keep where name = 'day1-items'), 'the Day 1 sale lines read back IDENTICAL after every later margin, cost, pack, promotion and surcharge change');

select * from finish();
rollback;
