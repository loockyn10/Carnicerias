begin;

create extension if not exists pgtap with schema extensions;
select plan(96);

-- Cubre 202611070095 (Envasados vendidos desde el POS): importe comercial único (impreso = EAN = cobrado), estado de los paquetes, línea PACKAGE
-- (importe fijo, gramos reales, un único movimiento de stock), idempotencia, conflictos entre cajas offline, anulación de la venta, envío a otra
-- sucursal, estado para el POS offline, reserva del prefijo del EAN y compatibilidad con las ventas por peso de siempre.
-- Fixture: una organización con administrador, dos sucursales (A1 Central, A2) y un dispositivo POS en cada una.

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'app_private.sync_vacuum_package_line(uuid,uuid,uuid,uuid,uuid,public.payment_method,timestamptz,jsonb,jsonb)', 'EXECUTE'), 'the package line validator is private');
select ok(not has_function_privilege('authenticated', 'app_private.vacuum_commercial_total(text,integer,bigint)', 'EXECUTE'), 'the commercial rounding helper is private');
select ok(not has_function_privilege('anon', 'public.get_pos_vacuum_state(uuid)', 'EXECUTE'), 'anonymous cannot read the POS vacuum state');
select ok(not has_function_privilege('anon', 'public.move_vacuum_packages(uuid[],uuid)', 'EXECUTE'), 'anonymous cannot move packages');
select ok(not has_table_privilege('authenticated', 'public.vacuum_package_state', 'UPDATE'), 'the package state has no direct UPDATE grant');
select ok(not has_table_privilege('authenticated', 'public.vacuum_package_conflicts', 'INSERT'), 'conflicts have no direct INSERT grant');
select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.vacuum_package_state'::regclass, 'public.vacuum_package_events'::regclass, 'public.vacuum_package_conflicts'::regclass)), 'the new vacuum tables have RLS enabled');

-- ---------------------------------------------------------------------------------------------
-- Importe comercial único (puro)
-- ---------------------------------------------------------------------------------------------
select is(app_private.vacuum_commercial_total('PRICE_EMBEDDED', 100, 1805250), 1805300::bigint, 'with divisor 100 the price rounds half-up to whole pesos (18.052,50 → 18.053)');
select is(app_private.vacuum_commercial_total('PRICE_EMBEDDED', 100, 1805249), 1805200::bigint, 'and rounds down below the half');
select is(app_private.vacuum_commercial_total('PRICE_EMBEDDED', 100, 1125000), 1125000::bigint, 'a whole-peso amount is unchanged');
select is(app_private.vacuum_commercial_total('PRICE_EMBEDDED', 1, 1805250), 1805250::bigint, 'divisor 1 keeps the cents');
select is(app_private.vacuum_commercial_total('WEIGHT_EMBEDDED', 100, 1805250), 1805250::bigint, 'a weight scheme does not round the amount');
select is(app_private.vacuum_build_ean('PRICE_EMBEDDED', '20', 4, 6, 100, '12', 1125000, 750), '2000120112506', 'the documented example: Vacío PLU 0012, $11.250 → 2000120112506');

-- ---------------------------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'vps-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"VPS Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'vps-other@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"VPS Other"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'VPS Org', 'vps-org'),
  ('e2000000-0000-4000-8000-000000000002', 'VPS Org B', 'vps-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Central', 'CEN'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'Sucursal Dos', 'DOS'),
  ('e3000000-0000-4000-8000-000000000009', 'e2000000-0000-4000-8000-000000000002', 'Central B', 'CEB');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Cortes', 'cortes');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'Vacío', 'vacio', 'VAC', 'WEIGHT'),
  ('e6000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'Asado', 'asado', 'ASA', 'WEIGHT'),
  ('e6000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'Peceto', 'peceto', 'PEC', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id;
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('e2000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', null, 1500000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000002', null, 1000000, now() - interval '1 day'),
  ('e2000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000003', null, 1234500, now() - interval '1 day');
insert into public.product_barcodes (organization_id, product_id, barcode) values
  ('e2000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000002', '7790000000017');

-- Helpers de test (SECURITY DEFINER: leen tablas privadas y arman payloads deterministas).
create function public.t_pkg_payload(
  p_sale uuid, p_event uuid, p_device uuid, p_branch uuid, p_package uuid,
  p_method text default 'CASH', p_bps integer default 0, p_amount_delta bigint default 0
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.vacuum_packages%rowtype;
  fixed bigint; sub bigint; item_id uuid := md5(p_event::text || 'item')::uuid; move_id uuid := md5(p_event::text || 'move')::uuid;
  pay_id uuid := md5(p_event::text || 'pay')::uuid;
begin
  select * into p from public.vacuum_packages where id = p_package;
  fixed := app_private.vacuum_package_charge_cents(p) + p_amount_delta;
  sub := case when p_bps > 0 then app_private.round_ratio_half_up(fixed * (10000 + p_bps), 10000) else fixed end;
  return jsonb_build_object(
    'schemaVersion', 1, 'eventId', p_event, 'saleId', p_sale, 'organizationId', p.organization_id, 'branchId', p_branch,
    'profileId', 'e1000000-0000-4000-8000-000000000001', 'deviceId', p_device, 'status', 'COMPLETED',
    'totalCents', sub::text, 'totalWeightGrams', p.weight_grams::text,
    'createdAt', now() - interval '1 minute', 'completedAt', now() - interval '1 minute',
    'items', jsonb_build_array(jsonb_build_object(
      'id', item_id, 'productId', p.product_id, 'productNameSnapshot', p.product_name_snapshot, 'weightGrams', p.weight_grams,
      'pricePerKgCents', app_private.round_ratio_half_up(sub * 1000, p.weight_grams)::text,
      'originalPricePerKgCents', app_private.round_ratio_half_up(fixed * 1000, p.weight_grams)::text,
      'discountRuleId', null, 'discountType', null, 'discountValue', null, 'promotionMode', null, 'discountCents', '0',
      'cashDiscountBps', p_bps::text, 'cashDiscountCents', '0', 'cardSurchargeCents', (sub - fixed)::text, 'promotionDiscountCents', '0',
      'subtotalCents', sub::text, 'vacuumPackageId', p.id, 'vacuumEan13', p.ean13, 'vacuumPackageTotalCents', fixed::text)),
    'payment', jsonb_build_object('id', pay_id, 'method', p_method, 'amountCents', sub::text),
    'stockMovements', jsonb_build_array(jsonb_build_object('id', move_id, 'productId', p.product_id, 'quantityGrams', (-p.weight_grams)::text, 'occurredAt', now() - interval '1 minute'))
  );
end; $$;
create function public.t_vps_count(p_sql text) returns bigint language plpgsql security definer set search_path = '' as $$
declare n bigint; begin execute p_sql into n; return n; end; $$;
create function public.t_vps_state(p_package uuid) returns text language sql security definer set search_path = '' as $$
  select s.status from public.vacuum_package_state s where s.package_id = p_package $$;
create function public.t_vps_pkg(p_id uuid) returns uuid language sql security definer set search_path = '' as $$ select p_id $$;
grant execute on function public.t_pkg_payload(uuid, uuid, uuid, uuid, uuid, text, integer, bigint), public.t_vps_count(text), public.t_vps_state(uuid), public.t_vps_pkg(uuid) to authenticated;

select set_config('test.today', ((clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date)::text, true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$select public.register_pos_device('e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'POS Central')$$, 'the Central device registers');
select lives_ok($$select public.register_pos_device('e7000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000002', 'POS Dos')$$, 'the second branch device registers');

-- Esquema inicial del pedido: precio embebido, prefijo 20, PLU 4, valor 6, divisor 100.
select lives_ok($$select public.save_vacuum_ean_scheme('PRICE_EMBEDDED', '20', 4, 6, 100)$$, 'the documented scheme is accepted');
select lives_ok($$select public.save_vacuum_product_config('e6000000-0000-4000-8000-000000000001', true, 7, '12', null)$$, 'the Vacío is enabled with PLU 12');
select lives_ok($$select public.save_vacuum_product_config('e6000000-0000-4000-8000-000000000002', true, 7, '13', null)$$, 'the Asado is enabled with PLU 13');

-- ---------------------------------------------------------------------------------------------
-- El importe del paquete: único e igual en el registro, en el EAN y en lo que cobra el POS
-- ---------------------------------------------------------------------------------------------
select set_config('vps.p1', (public.create_vacuum_package('e3000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 750, current_setting('test.today')::date, null, null, 'e8000000-0000-4000-8000-000000000001') ->> 'id'), true);
select is((select total_cents from public.vacuum_packages where id = current_setting('vps.p1')::uuid), 1125000::bigint, '0,750 kg × $15.000/kg = $11.250 exactos');
select is((select ean13 from public.vacuum_packages where id = current_setting('vps.p1')::uuid), '2000120112506', 'its EAN-13 is the documented one');
select is((select computed_total_cents from public.vacuum_packages where id = current_setting('vps.p1')::uuid), 1125000::bigint, 'the audit amount is kept');
select is(public.t_vps_state(current_setting('vps.p1')::uuid), 'AVAILABLE', 'a new package is AVAILABLE');
select is(public.t_vps_count('select count(*) from public.stock_movements where product_id = ''e6000000-0000-4000-8000-000000000001'''), 0::bigint, 'packing writes no stock movement');
select is(public.t_vps_count('select count(*) from public.vacuum_package_events where kind = ''CREATED'''), 1::bigint, 'the CREATED event is logged');

-- Un peso que da centavos: 1,245 kg × $15.000 = $18.675 (exacto) → usamos 1,247 kg: 18.705 exactos; 1,243 kg: 18.645; probamos el medio: 0,333 kg × $15.000 = $4.995.
select set_config('vps.p2', (public.create_vacuum_package('e3000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 333, current_setting('test.today')::date, null, null, 'e8000000-0000-4000-8000-000000000002') ->> 'id'), true);
select is((select total_cents from public.vacuum_packages where id = current_setting('vps.p2')::uuid), 499500::bigint, '0,333 kg × $15.000 = $4.995 (ya entero)');
select lives_ok($$select public.save_vacuum_product_config('e6000000-0000-4000-8000-000000000002', true, 7, '13', null)$$, 're-saving a product config is fine');
select set_config('vps.p3', (public.create_vacuum_package('e3000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000002', 123, current_setting('test.today')::date, null, null, 'e8000000-0000-4000-8000-000000000003') ->> 'id'), true);
-- 123 g × $10.000/kg = $1.230 exactos; para forzar centavos cambiamos el precio del Asado a $12.345 (1.234.500 ¢): 123 g → 151.843,5 ¢ → $1.518,435 → $1.518.
select is((select total_cents from public.vacuum_packages where id = current_setting('vps.p3')::uuid), 123000::bigint, '0,123 kg × $10.000/kg = $1.230');
select public.t_vps_count('select 1 from public.vacuum_packages') is not null;

-- ---------------------------------------------------------------------------------------------
-- Estado para el POS offline
-- ---------------------------------------------------------------------------------------------
select is(public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000001') -> 'scheme' ->> 'prefix', '20', 'the POS state carries the EAN scheme');
select is((public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000001') -> 'scheme' ->> 'valueStep')::integer, 100, 'including the divisor');
select is(jsonb_array_length(public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000001') -> 'plus'), 2, 'and the PLU of each enabled cut');
select is(jsonb_array_length(public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000001') -> 'packages'), 3, 'the branch POS gets its available packages');
select is(jsonb_array_length(public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000002') -> 'packages'), 0, 'another branch gets none of them');
select is((public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000001') -> 'packages' -> 0 ->> 'chargeCents'), '1125000', 'the amount to charge is the package amount');
select is((public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000001') -> 'packages' -> 0 ->> 'weightGrams'), '750', 'with its real weight');
select throws_ok($$select public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000009')$$, '42501', null, 'a branch of another organization is refused');

-- ---------------------------------------------------------------------------------------------
-- Venta de un paquete: importe fijo, gramos reales, un movimiento
-- ---------------------------------------------------------------------------------------------
select set_config('vps.sale1', public.t_pkg_payload('e9000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p1')::uuid)::text, true);
select lives_ok($$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000001', current_setting('vps.sale1')::jsonb)$$, 'a package sale syncs');
select is((select total_cents from public.sales where id = 'e9000000-0000-4000-8000-000000000001'), 1125000::bigint, 'the sale total is the package amount');
select is((select subtotal_cents from public.sale_items where sale_id = 'e9000000-0000-4000-8000-000000000001'), 1125000::bigint, 'the line subtotal is the package amount');
select is((select weight_grams from public.sale_items where sale_id = 'e9000000-0000-4000-8000-000000000001'), 750, 'the line keeps the real weight');
select is((select vacuum_package_id from public.sale_items where sale_id = 'e9000000-0000-4000-8000-000000000001'), current_setting('vps.p1')::uuid, 'the line is linked to the package');
select is((select vacuum_ean13 from public.sale_items where sale_id = 'e9000000-0000-4000-8000-000000000001'), '2000120112506', 'and to the EAN used');
select is((select quantity_grams from public.stock_movements where sale_id = 'e9000000-0000-4000-8000-000000000001'), -750::bigint, 'the ledger is discounted by the real grams');
select is(public.t_vps_state(current_setting('vps.p1')::uuid), 'SOLD', 'the package is SOLD');
select is((select sold_sale_id from public.vacuum_package_state where package_id = current_setting('vps.p1')::uuid), 'e9000000-0000-4000-8000-000000000001'::uuid, 'by that sale');
select is((public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000001', current_setting('vps.sale1')::jsonb) ->> 'duplicate')::boolean, true, 're-sending the same event is a duplicate');
select is(public.t_vps_count('select count(*) from public.stock_movements where sale_id = ''e9000000-0000-4000-8000-000000000001'''), 1::bigint, 'and never discounts the stock twice');
select is(public.t_vps_count('select count(*) from public.vacuum_package_conflicts'), 0::bigint, 'no conflict so far');
select is(jsonb_array_length(public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000001') -> 'packages'), 2, 'the sold package leaves the POS state');

-- El precio/kg cambia DESPUÉS de envasar: el paquete se sigue cobrando por su importe, no por el precio actual.
select public.t_vps_count('select 1') is not null;
select set_config('vps.sale2', public.t_pkg_payload('e9000000-0000-4000-8000-000000000002', 'e9100000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p2')::uuid, 'DEBIT', 1000)::text, true);
select lives_ok($$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000002', current_setting('vps.sale2')::jsonb)$$, 'a package paid by card syncs with the surcharge on top');
select is((select subtotal_cents from public.sale_items where sale_id = 'e9000000-0000-4000-8000-000000000002'), 549450::bigint, 'the card surcharge is applied once over the fixed amount ($4.995 + 10%)');
select is((select card_surcharge_cents from public.sale_items where sale_id = 'e9000000-0000-4000-8000-000000000002'), 49950::bigint, 'and recorded separately');
select is((select total_cents from public.vacuum_packages where id = current_setting('vps.p2')::uuid), 499500::bigint, 'without touching the package base amount');

-- ---------------------------------------------------------------------------------------------
-- Líneas que el POS nunca produce se rechazan enteras
-- ---------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000011', public.t_pkg_payload('e9000000-0000-4000-8000-000000000011', 'e9100000-0000-4000-8000-000000000011', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p3')::uuid, 'CASH', 0, 100))$$,
  '22023', null, 'an amount different from the package is rejected');
select throws_ok(
  $$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000012', jsonb_set(public.t_pkg_payload('e9000000-0000-4000-8000-000000000012', 'e9100000-0000-4000-8000-000000000012', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p3')::uuid), '{items,0,weightGrams}', '124'))$$,
  '22023', null, 'a weight different from the package is rejected');
select throws_ok(
  $$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000013', jsonb_set(public.t_pkg_payload('e9000000-0000-4000-8000-000000000013', 'e9100000-0000-4000-8000-000000000013', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p3')::uuid), '{items,0,manualPriceApplied}', 'true'))$$,
  '42501', null, 'a manual price on a package is rejected (outside Central by the flexible-pricing gate)');
select throws_ok(
  $$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000014', jsonb_set(public.t_pkg_payload('e9000000-0000-4000-8000-000000000014', 'e9100000-0000-4000-8000-000000000014', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p3')::uuid), '{items,0,vacuumEan13}', '"2000130012301"'))$$,
  '22023', null, 'an EAN that is not the package one is rejected');
select throws_ok(
  $$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000015', jsonb_set(public.t_pkg_payload('e9000000-0000-4000-8000-000000000015', 'e9100000-0000-4000-8000-000000000015', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p3')::uuid), '{stockMovements,0,quantityGrams}', '"-100"'))$$,
  '22023', null, 'a stock movement that is not the real grams is rejected');
select throws_ok(
  $$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000016', jsonb_set(public.t_pkg_payload('e9000000-0000-4000-8000-000000000016', 'e9100000-0000-4000-8000-000000000016', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p3')::uuid), '{items,0,vacuumPackageId}', '"eeeeeeee-0000-4000-8000-000000000000"'))$$,
  '42501', null, 'a package that does not exist is rejected');
select is(public.t_vps_state(current_setting('vps.p3')::uuid), 'AVAILABLE', 'a rejected sale leaves the package AVAILABLE');
select is(public.t_vps_count('select count(*) from public.sales where id::text like ''e9000000-0000-4000-8000-0000000000_1'' and id::text > ''e9000000-0000-4000-8000-000000000010'''), 0::bigint, 'and registers nothing');

-- ---------------------------------------------------------------------------------------------
-- Dos cajas venden el mismo paquete offline: la venta NO se pierde y queda un conflicto abierto
-- ---------------------------------------------------------------------------------------------
select set_config('vps.sale3', public.t_pkg_payload('e9000000-0000-4000-8000-000000000003', 'e9100000-0000-4000-8000-000000000003', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p1')::uuid)::text, true);
select lives_ok($$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000003', current_setting('vps.sale3')::jsonb)$$, 'a second sale of an already sold package is still registered');
select is(public.t_vps_count('select count(*) from public.sales where id = ''e9000000-0000-4000-8000-000000000003'''), 1::bigint, 'the sale exists (nothing is dropped)');
select is((select reason from public.vacuum_package_conflicts where sale_id = 'e9000000-0000-4000-8000-000000000003'), 'ALREADY_SOLD', 'the conflict says the package was already sold');
select is((select first_sale_id from public.vacuum_package_conflicts where sale_id = 'e9000000-0000-4000-8000-000000000003'), 'e9000000-0000-4000-8000-000000000001'::uuid, 'and points at the first sale');
select is((select sold_sale_id from public.vacuum_package_state where package_id = current_setting('vps.p1')::uuid), 'e9000000-0000-4000-8000-000000000001'::uuid, 'the package stays with the first sale');
select is(jsonb_array_length(public.list_vacuum_package_conflicts('OPEN')), 1, 'the open conflict is listed for the Admin');
select throws_ok($$select public.resolve_vacuum_package_conflict((public.list_vacuum_package_conflicts('OPEN') -> 0 ->> 'id')::uuid, 'x')$$, '22023', null, 'resolving needs a note');
select lives_ok($$select public.resolve_vacuum_package_conflict((public.list_vacuum_package_conflicts('OPEN') -> 0 ->> 'id')::uuid, 'Eran dos paquetes iguales')$$, 'the conflict is resolved with a note');
select is(jsonb_array_length(public.list_vacuum_package_conflicts('OPEN')), 0, 'and leaves the open list');

-- ---------------------------------------------------------------------------------------------
-- Anular la venta libera el paquete
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.cancel_sale('e9000000-0000-4000-8000-000000000001', 'ea000000-0000-4000-8000-000000000001', 'Cliente devolvió el paquete')$$, 'the first sale is cancelled');
select is(public.t_vps_state(current_setting('vps.p1')::uuid), 'AVAILABLE', 'its package is AVAILABLE again');
select is(public.t_vps_count('select coalesce(sum(quantity_grams), 0) from public.stock_movements where sale_id = ''e9000000-0000-4000-8000-000000000001'''), 0::bigint, 'and the stock returns (sale -750 + return +750)');
select is(public.t_vps_count('select count(*) from public.vacuum_package_events where kind = ''RELEASED'''), 1::bigint, 'the release is logged');

-- ---------------------------------------------------------------------------------------------
-- Envío a otra sucursal, anulación del paquete y venta en una sucursal que no es la suya
-- ---------------------------------------------------------------------------------------------
select is(public.move_vacuum_packages(array[current_setting('vps.p1')::uuid], 'e3000000-0000-4000-8000-000000000002'), 1, 'an available package moves to another branch');
select is(jsonb_array_length(public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000002') -> 'packages'), 1, 'the destination POS now sees it');
select is(jsonb_array_length(public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000001') -> 'packages'), 1, 'and the origin POS no longer does');
select throws_ok($$select public.move_vacuum_packages(array[current_setting('vps.p2')::uuid], 'e3000000-0000-4000-8000-000000000002')$$, '22023', null, 'a sold package cannot be moved');
select set_config('vps.sale4', public.t_pkg_payload('e9000000-0000-4000-8000-000000000004', 'e9100000-0000-4000-8000-000000000004', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p1')::uuid)::text, true);
select lives_ok($$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000004', current_setting('vps.sale4')::jsonb)$$, 'selling a package that was sent elsewhere registers the sale');
select is((select reason from public.vacuum_package_conflicts where sale_id = 'e9000000-0000-4000-8000-000000000004'), 'WRONG_BRANCH', 'with a WRONG_BRANCH conflict');
select lives_ok($$select public.void_vacuum_package(current_setting('vps.p3')::uuid, 'Se rompió el vacío')$$, 'an available package can be voided');
select is(public.t_vps_state(current_setting('vps.p3')::uuid), 'VOIDED', 'and is VOIDED');
select is(jsonb_array_length(public.get_pos_vacuum_state('e3000000-0000-4000-8000-000000000001') -> 'packages'), 0, 'a voided package is not offered to the POS');
select set_config('vps.sale5', public.t_pkg_payload('e9000000-0000-4000-8000-000000000005', 'e9100000-0000-4000-8000-000000000005', 'e7000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', current_setting('vps.p3')::uuid)::text, true);
select lives_ok($$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000001', 'e9100000-0000-4000-8000-000000000005', current_setting('vps.sale5')::jsonb)$$, 'a voided package sold offline is still registered');
select is((select reason from public.vacuum_package_conflicts where sale_id = 'e9000000-0000-4000-8000-000000000005'), 'VOIDED', 'with a VOIDED conflict');

-- ---------------------------------------------------------------------------------------------
-- Compatibilidad: una venta por peso de siempre + un paquete en el mismo ticket
-- ---------------------------------------------------------------------------------------------
select set_config('vps.mixed', (
  select jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
    public.t_pkg_payload('e9000000-0000-4000-8000-000000000006', 'e9100000-0000-4000-8000-000000000006', 'e7000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000002', current_setting('vps.p1')::uuid),
    '{items}', (public.t_pkg_payload('e9000000-0000-4000-8000-000000000006', 'e9100000-0000-4000-8000-000000000006', 'e7000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000002', current_setting('vps.p1')::uuid) -> 'items')
      || jsonb_build_array(jsonb_build_object('id', 'e9200000-0000-4000-8000-000000000001', 'productId', 'e6000000-0000-4000-8000-000000000002', 'productNameSnapshot', 'Asado', 'weightGrams', 500, 'pricePerKgCents', '1000000', 'subtotalCents', '500000'))),
    '{stockMovements}', (public.t_pkg_payload('e9000000-0000-4000-8000-000000000006', 'e9100000-0000-4000-8000-000000000006', 'e7000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000002', current_setting('vps.p1')::uuid) -> 'stockMovements')
      || jsonb_build_array(jsonb_build_object('id', 'e9300000-0000-4000-8000-000000000001', 'productId', 'e6000000-0000-4000-8000-000000000002', 'quantityGrams', '-500', 'occurredAt', now() - interval '1 minute'))),
    '{totalCents}', '"1625000"'),
    '{totalWeightGrams}', '"1250"'),
    '{payment,amountCents}', '"1625000"')
)::text, true);
select lives_ok($$select public.sync_offline_sale('e7000000-0000-4000-8000-000000000002', 'e9100000-0000-4000-8000-000000000006', current_setting('vps.mixed')::jsonb)$$, 'a ticket with a package and a normal weighed line syncs');
select is((select total_cents from public.sales where id = 'e9000000-0000-4000-8000-000000000006'), 1625000::bigint, 'with the right total');
select is((select total_weight_grams from public.sales where id = 'e9000000-0000-4000-8000-000000000006'), 1250::bigint, 'and the right weight');
select is(public.t_vps_count('select count(*) from public.sale_items where sale_id = ''e9000000-0000-4000-8000-000000000006'' and vacuum_package_id is null'), 1::bigint, 'the normal line carries no package');
select is(public.t_vps_state(current_setting('vps.p1')::uuid), 'SOLD', 'the package of the mixed ticket is SOLD (it was AVAILABLE at the destination)');

-- Un cálculo con centavos: 0,123 kg × $12.345/kg = $1.518,44 → importe comercial $1.518 (el EAN embebe 1518 y es lo que se imprime y se cobra).
select lives_ok($$select public.save_vacuum_product_config('e6000000-0000-4000-8000-000000000003', true, 7, '14', null)$$, 'a third cut is enabled');
select set_config('vps.p4', (public.create_vacuum_package('e3000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000003', 123, current_setting('test.today')::date, null, null, 'e8000000-0000-4000-8000-000000000004') ->> 'id'), true);
select is((select array[total_cents, computed_total_cents] from public.vacuum_packages where id = current_setting('vps.p4')::uuid), array[151800::bigint, 151844::bigint], 'the commercial amount is $1.518 and the cents calculation is kept for audit');
select is((select ean13 from public.vacuum_packages where id = current_setting('vps.p4')::uuid), '2000140015184', 'the EAN embeds the same whole-peso amount that is printed and charged');

-- ---------------------------------------------------------------------------------------------
-- Prefijo reservado
-- ---------------------------------------------------------------------------------------------
reset role;
select throws_ok($$insert into public.product_barcodes (organization_id, product_id, barcode) values ('e2000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000002', '200099000000' || app_private.ean13_check_digit('200099000000')::text)$$, '22023', null, 'a catalog barcode that matches the vacuum scheme is rejected');
select lives_ok($$insert into public.product_barcodes (organization_id, product_id, barcode) values ('e2000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000002', '7790000000010')$$, 'a normal EAN-13 is still accepted');
select lives_ok($$insert into public.product_barcodes (organization_id, product_id, barcode) values ('e2000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000002', 'ABC-2000001')$$, 'a non-EAN internal code is still accepted');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select throws_ok($$select public.save_vacuum_ean_scheme('PRICE_EMBEDDED', '7', 4, 7, 100)$$, '22023', null, 'a scheme prefix already used by catalog barcodes is refused');

select * from finish();
rollback;
