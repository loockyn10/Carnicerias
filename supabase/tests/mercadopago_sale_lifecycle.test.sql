begin;

create extension if not exists pgtap with schema extensions;
select plan(137);

-- Ciclo de vida de la VENTA Mercado Pago (D-055): PENDING_PAYMENT -> COMPLETED | CANCELLED, stock exacto,
-- una confirmación nunca retrocede, "CONFIRMED siempre gana", y la transferencia manual prohibida donde
-- Mercado Pago es el medio digital obligatorio. La verificación del PAGO (firma, montos, idempotencia de
-- la orden) la cubre mercadopago_payments.test.sql.

-- ---------------------------------------------------------------------------------------------
-- Fixture: org A con Avenida (Mercado Pago habilitado y obligatorio) y Janssen (sin Mercado Pago)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'lc-device-avenida@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"LC Device Avenida"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'lc-device-janssen@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"LC Device Janssen"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'lc-operator@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Operadora LC"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'lc-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"LC Admin"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values ('d2000000-0000-4000-8000-000000000001', 'LC Org', 'lc-org');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Avenida', 'LCAVENIDA'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'Janssen', 'LCJANSSEN');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003');
insert into public.pos_devices (id, organization_id, branch_id, label, registered_by) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'Avenida POS', 'd1000000-0000-4000-8000-000000000001'),
  ('d4000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'Janssen POS', 'd1000000-0000-4000-8000-000000000002');
insert into public.pos_operator_grants (organization_id, branch_id, device_id, operator_profile_id, issued_by, token_hash, valid_until) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001', encode(extensions.digest(convert_to(repeat('e', 64), 'UTF8'), 'sha256'), 'hex'), now() + interval '7 days');

insert into public.categories (id, organization_id, name, slug) values ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Vacunos', 'vacunos-lc');
insert into public.products (id, organization_id, category_id, name, slug, unit_type) values
  ('d6000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Vacío LC', 'vacio-lc', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id where p.organization_id = 'd2000000-0000-4000-8000-000000000001';
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('d2000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 1000000, '2026-01-01T00:00:00Z');
-- 10 kg de stock inicial en cada sucursal, para ver al gramo cómo se reserva y se restituye.
insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id, reason) values
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 'PURCHASE', 10000, 'd1000000-0000-4000-8000-000000000004', 'fixture'),
  ('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000001', 'PURCHASE', 10000, 'd1000000-0000-4000-8000-000000000004', 'fixture');

-- Payload de venta offline: 1 kg de Vacío a $10.000. n = sufijo de ids; branch/device = 1 Avenida | 2 Janssen.
create temporary table lc_payloads(name text primary key, payload jsonb) on commit drop;
create function pg_temp.lc_sale(n text, profile text, method text, provider text, token text, site text default '1')
returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 1, 'eventId', 'd8000000-0000-4000-8000-0000000000' || n, 'saleId', 'd7000000-0000-4000-8000-0000000000' || n,
    'organizationId', 'd2000000-0000-4000-8000-000000000001', 'branchId', 'd3000000-0000-4000-8000-00000000000' || site,
    'profileId', profile, 'operatorToken', token, 'deviceId', 'd4000000-0000-4000-8000-00000000000' || site, 'status', 'COMPLETED',
    'totalCents', '1000000', 'totalWeightGrams', '1000', 'createdAt', now(), 'completedAt', now(),
    'items', jsonb_build_array(jsonb_build_object('id', 'd9000000-0000-4000-8000-0000000000' || n, 'productId', 'd6000000-0000-4000-8000-000000000001', 'productNameSnapshot', 'Vacío LC', 'weightGrams', 1000, 'pricePerKgCents', '1000000', 'subtotalCents', '1000000')),
    'payment', jsonb_strip_nulls(jsonb_build_object('id', 'da000000-0000-4000-8000-0000000000' || n, 'method', method, 'provider', provider, 'amountCents', '1000000')),
    'stockMovements', jsonb_build_array(jsonb_build_object('id', 'db000000-0000-4000-8000-0000000000' || n, 'productId', 'd6000000-0000-4000-8000-000000000001', 'quantityGrams', '-1000', 'occurredAt', now()))
  ));
$$;
insert into lc_payloads values
  ('01', pg_temp.lc_sale('01', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('02', pg_temp.lc_sale('02', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('03', pg_temp.lc_sale('03', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('04', pg_temp.lc_sale('04', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('05', pg_temp.lc_sale('05', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('06', pg_temp.lc_sale('06', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('07', pg_temp.lc_sale('07', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('08', pg_temp.lc_sale('08', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('09', pg_temp.lc_sale('09', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('10', pg_temp.lc_sale('10', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('11', pg_temp.lc_sale('11', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('20', pg_temp.lc_sale('20', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', null, null)),
  ('21', pg_temp.lc_sale('21', 'd1000000-0000-4000-8000-000000000002', 'TRANSFER', null, null, '2')),
  ('22', pg_temp.lc_sale('22', 'd1000000-0000-4000-8000-000000000001', 'CASH', null, null)),
  ('24', pg_temp.lc_sale('24', 'd1000000-0000-4000-8000-000000000002', 'TRANSFER', null, null, '2')),
  ('25', pg_temp.lc_sale('25', 'd1000000-0000-4000-8000-000000000001', 'TRANSFER', null, null));
grant select on lc_payloads to authenticated, service_role;

-- Órdenes preparadas por sale (nombre -> json de mp_prepare_order)
create temporary table lc_orders(name text primary key, order_json jsonb) on commit drop;
grant all on lc_orders to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Forma y permisos
-- ---------------------------------------------------------------------------------------------
select ok('PENDING_PAYMENT' = any (enum_range(null::public.sale_status)::text[]), 'sales can be PENDING_PAYMENT');
select ok(not has_function_privilege('authenticated', 'app_private.mp_cancel_pending_sale(uuid,text)', 'EXECUTE'), 'the cancel helper is private');
select ok(not has_function_privilege('authenticated', 'app_private.mp_restore_cancelled_sale(uuid)', 'EXECUTE'), 'the restore helper is private');
select ok(not has_function_privilege('anon', 'public.mp_abandon_unpaid_sale(uuid,uuid)', 'EXECUTE'), 'anonymous cannot abandon a sale');
select ok(has_function_privilege('authenticated', 'public.mp_abandon_unpaid_sale(uuid,uuid)', 'EXECUTE'), 'a device can abandon its own unpaid sale');
select has_column('public', 'mercadopago_branch_pos', 'require_verified_digital_payments', 'the branch config carries the verified-payments policy');

-- ---------------------------------------------------------------------------------------------
-- Configuración: Avenida con Mercado Pago obligatorio; Janssen sin configuración
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select lives_ok($$select public.set_mercadopago_branch_pos('d3000000-0000-4000-8000-000000000001', 'LCAVENIDA01', 'STORE-1', 'POS-1', 'static', 15, true)$$, 'admin enables Mercado Pago for Avenida (verified payments required by default)');
select is((select require_verified_digital_payments from public.get_mercadopago_branch_pos() where branch_name = 'Avenida'), true, 'the admin read shows verified payments required for Avenida');
select is((select require_verified_digital_payments from public.get_mercadopago_branch_pos() where branch_name = 'Janssen'), null, 'Janssen has no Mercado Pago configuration');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.mp_get_branch_config('d4000000-0000-4000-8000-000000000001') ->> 'manualTransferAllowed')::boolean, false, 'Avenida device: manual transfer is NOT allowed');
select is((public.mp_get_branch_config('d4000000-0000-4000-8000-000000000001') ->> 'enabled')::boolean, true, 'Avenida device: Mercado Pago is enabled');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((public.mp_get_branch_config('d4000000-0000-4000-8000-000000000002') ->> 'manualTransferAllowed')::boolean, true, 'Janssen device (no Mercado Pago): manual transfer stays allowed');
select is((public.mp_get_branch_config('d4000000-0000-4000-8000-000000000002') ->> 'enabled')::boolean, false, 'Janssen device: Mercado Pago is off');

-- ---------------------------------------------------------------------------------------------
-- 1. MP iniciado -> venta pendiente, no completada; el stock queda reservado
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', (select payload from lc_payloads where name = '01'))$$, 'sale 1 (Mercado Pago) syncs');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000001'), 'PENDING_PAYMENT', 'a Mercado Pago sale is NOT completed when it is declared');
select is((select verification_status from public.payments where sale_id = 'd7000000-0000-4000-8000-000000000001'), 'PENDING', 'and its payment is PENDING');
select is((select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000001'), -1000::bigint, 'while pending its stock is reserved (deducted)');
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', (select payload from lc_payloads where name = '01'))$$, 'replaying sale 1 is idempotent');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000001'), 'PENDING_PAYMENT', 'the replay does not change the pending sale');
select is((select count(*) from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000001'), 1::bigint, 'and does not duplicate stock movements');

-- ---------------------------------------------------------------------------------------------
-- 3/4/20. PENDING no cuenta como recaudación; CONFIRMED sí (rendición y dashboard)
-- ---------------------------------------------------------------------------------------------
reset role;
select is((app_private.build_settlement_snapshot('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', now() - interval '1 hour', now() + interval '1 hour') ->> 'totalSalesCents')::bigint, 0::bigint, 'a pending Mercado Pago sale is NOT in the settlement totals');
select is(app_private.build_settlement_snapshot('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', now() - interval '1 hour', now() + interval '1 hour') #> '{paymentTotals,TRANSFER}', null, 'nor in the transfer total');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is((public.get_admin_dashboard('d3000000-0000-4000-8000-000000000001') #>> '{periods,today,grossCents}')::bigint, 0::bigint, 'nor in the dashboard revenue');

-- Orden creada en Mercado Pago para la venta 1 y pagada.
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
insert into lc_orders values ('01', public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)));
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from lc_orders where name = '01'), 'LCORD0000000000000000000001', 'created', 'ready_to_process', null, null)$$, 'order 1 created at Mercado Pago');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000001'), 'PENDING_PAYMENT', 'a created (unpaid) order keeps the sale pending');
select is(public.mp_apply_order_state('LCORD0000000000000000000001', 'd7000000-0000-4000-8000-000000000001', 'CONFIRMED', 'processed', 'accredited', 'LCPAY01', 1000000, 1000000, 'POLL') ->> 'status', 'CONFIRMED', 'polling reports the accredited payment');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000001'), 'COMPLETED', 'a confirmed payment completes the sale');
select is((select verification_status from public.payments where sale_id = 'd7000000-0000-4000-8000-000000000001'), 'CONFIRMED', 'and the payment is CONFIRMED');
select is((select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000001'), -1000::bigint, 'the stock stays deducted (definitive) after confirmation');
reset role;
select is((app_private.build_settlement_snapshot('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', now() - interval '1 hour', now() + interval '1 hour') ->> 'totalSalesCents')::bigint, 1000000::bigint, 'the confirmed sale is in the settlement totals');
select is((app_private.build_settlement_snapshot('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', now() - interval '1 hour', now() + interval '1 hour') #>> '{paymentTotals,TRANSFER}')::bigint, 1000000::bigint, 'as an accredited transfer');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is((public.get_admin_dashboard('d3000000-0000-4000-8000-000000000001') #>> '{periods,today,grossCents}')::bigint, 1000000::bigint, 'and in the dashboard revenue');

-- ---------------------------------------------------------------------------------------------
-- 20. Una confirmación nunca retrocede
-- ---------------------------------------------------------------------------------------------
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select is(public.mp_apply_order_state('LCORD0000000000000000000001', 'd7000000-0000-4000-8000-000000000001', 'EXPIRED', 'expired', 'expired', null, null, null, 'WEBHOOK') ->> 'status', 'CONFIRMED', 'a late expiry cannot undo a confirmation');
select is(public.mp_apply_order_state('LCORD0000000000000000000001', 'd7000000-0000-4000-8000-000000000001', 'CANCELLED', 'canceled', 'canceled', null, null, null, 'CANCEL') ->> 'status', 'CONFIRMED', 'a late cancel cannot undo a confirmation');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000001'), 'COMPLETED', 'the sale stays COMPLETED');
select is((select count(*) from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000001' and type = 'RETURN'), 0::bigint, 'and no stock is returned');

-- ---------------------------------------------------------------------------------------------
-- 5/6/7/11. Cancelación sin acreditación: venta anulada, stock restituido UNA vez, idempotente
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000002', (select payload from lc_payloads where name = '02'))$$, 'sale 2 syncs');
insert into lc_orders values ('02', public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000002', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)));
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from lc_orders where name = '02'), 'LCORD0000000000000000000002', 'created', 'ready_to_process', null, null)$$, 'order 2 created');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000002'), 'PENDING_PAYMENT', 'sale 2 is pending');
select is(public.mp_apply_order_state('LCORD0000000000000000000002', 'd7000000-0000-4000-8000-000000000002', 'CANCELLED', 'canceled', 'canceled_by_api', null, null, null, 'CANCEL') ->> 'status', 'CANCELLED', 'Mercado Pago confirms the cancellation');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000002'), 'CANCELLED', 'the sale is annulled');
select is((select verification_status from public.payments where sale_id = 'd7000000-0000-4000-8000-000000000002'), 'CANCELLED', 'its payment reads as not accredited');
select ok((select cancellation_reason like 'Mercado Pago:%' from public.sales where id = 'd7000000-0000-4000-8000-000000000002'), 'with a Mercado Pago annulment reason');
select is((select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000002'), 0::bigint, 'the stock is fully restored');
select is((select count(*) from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000002' and type = 'RETURN'), 1::bigint, 'with exactly one RETURN movement');
select is(public.mp_apply_order_state('LCORD0000000000000000000002', 'd7000000-0000-4000-8000-000000000002', 'CANCELLED', 'canceled', 'canceled_by_api', null, null, null, 'CANCEL') ->> 'status', 'CANCELLED', 'cancelling again is accepted');
select is(public.mp_apply_order_state('LCORD0000000000000000000002', 'd7000000-0000-4000-8000-000000000002', 'CANCELLED', 'canceled', 'canceled_by_api', null, null, null, 'WEBHOOK') ->> 'status', 'CANCELLED', 'and so is a duplicated webhook');
select is((select count(*) from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000002' and type = 'RETURN'), 1::bigint, 'the stock is never restored twice');
select is((select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000002'), 0::bigint, 'the movements still net to zero');
select is((select count(*) from public.audit_logs where entity_id = 'd7000000-0000-4000-8000-000000000002' and event_type = 'SALE_CANCELLED_NO_ACCREDITATION'), 1::bigint, 'and the annulment is audited once');
reset role;
select is((app_private.build_settlement_snapshot('d2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', now() - interval '1 hour', now() + interval '1 hour') ->> 'totalSalesCents')::bigint, 1000000::bigint, 'an annulled Mercado Pago sale never enters the settlement totals');
select is(app_private.mp_cancel_pending_sale('d7000000-0000-4000-8000-000000000002', 'Mercado Pago: de nuevo'), false, 'the annulment helper refuses an already annulled sale');
select is(app_private.mp_cancel_pending_sale('d7000000-0000-4000-8000-000000000004', 'Mercado Pago: no corresponde'), false, 'and a completed one');
select is((select count(*) from public.stock_movements where sale_id in ('d7000000-0000-4000-8000-000000000002', 'd7000000-0000-4000-8000-000000000004') and type = 'RETURN'), 1::bigint, 'so the stock is only ever returned by the single legitimate annulment');

-- Una venta anulada no admite un cobro nuevo.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000002', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64), true)$$,
  'P0001', 'SALE_NOT_PAYABLE', 'an annulled sale cannot be charged again'
);
select is((public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000002', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)) ->> 'status'), 'CANCELLED', 'a plain reopen only reports the final state');
select is((public.mp_get_order_status('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000002') ->> 'saleStatus'), 'CANCELLED', 'the POS reads the sale status');
select is((public.mp_get_order_status('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000002') ->> 'verificationStatus'), 'CANCELLED', 'and the payment verification');

-- ---------------------------------------------------------------------------------------------
-- 9. EXPIRED -> anulada / no acreditada, stock restituido
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000003', (select payload from lc_payloads where name = '03'))$$, 'sale 3 syncs');
insert into lc_orders values ('03', public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000003', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)));
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from lc_orders where name = '03'), 'LCORD0000000000000000000003', 'created', 'ready_to_process', null, null)$$, 'order 3 created');
select is(public.mp_apply_order_state('LCORD0000000000000000000003', 'd7000000-0000-4000-8000-000000000003', 'EXPIRED', 'expired', 'expired', null, null, null, 'POLL') ->> 'status', 'EXPIRED', 'the order expires without payment');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000003'), 'CANCELLED', 'the sale is annulled');
select is((select verification_status from public.payments where sale_id = 'd7000000-0000-4000-8000-000000000003'), 'EXPIRED', 'its payment reads as expired / not accredited');
select ok((select cancellation_reason like '%vencido%' from public.sales where id = 'd7000000-0000-4000-8000-000000000003'), 'with the expiry reason');
select is((select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000003'), 0::bigint, 'and the stock back');
select is(public.mp_apply_order_state('LCORD0000000000000000000003', 'd7000000-0000-4000-8000-000000000003', 'EXPIRED', 'expired', 'expired', null, null, null, 'WEBHOOK') ->> 'status', 'EXPIRED', 'a duplicated expiry webhook is harmless');
select is((select count(*) from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000003' and type = 'RETURN'), 1::bigint, 'one RETURN only');

-- ---------------------------------------------------------------------------------------------
-- 8. Carrera cancelar vs pagar: CONFIRMED gana
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000004', (select payload from lc_payloads where name = '04'))$$, 'sale 4 syncs');
insert into lc_orders values ('04', public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000004', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)));
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from lc_orders where name = '04'), 'LCORD0000000000000000000004', 'created', 'ready_to_process', null, null)$$, 'order 4 created');
-- El cajero pidió cancelar, pero entre el pedido y la reconsulta el cliente pagó.
select is(public.mp_apply_order_state('LCORD0000000000000000000004', 'd7000000-0000-4000-8000-000000000004', 'CONFIRMED', 'processed', 'accredited', 'LCPAY04', 1000000, 1000000, 'CANCEL') ->> 'status', 'CONFIRMED', 'the re-query after the cancel attempt finds the payment');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000004'), 'COMPLETED', 'the sale is NOT annulled');
select is((select count(*) from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000004' and type = 'RETURN'), 0::bigint, 'no stock is reverted');
select is((select verification_status from public.payments where sale_id = 'd7000000-0000-4000-8000-000000000004'), 'CONFIRMED', 'the payment is confirmed');
select is(public.mp_apply_order_state('LCORD0000000000000000000004', 'd7000000-0000-4000-8000-000000000004', 'CANCELLED', 'canceled', 'canceled', null, null, null, 'CANCEL') ->> 'status', 'CONFIRMED', 'a second cancel report cannot override the confirmation');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000004'), 'COMPLETED', 'still COMPLETED');

-- Pago acreditado DESPUÉS de que el sistema anuló la venta: el dinero entró de verdad, la venta se restablece.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000005', (select payload from lc_payloads where name = '05'))$$, 'sale 5 syncs');
insert into lc_orders values ('05', public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000005', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)));
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from lc_orders where name = '05'), 'LCORD0000000000000000000005', 'created', 'ready_to_process', null, null)$$, 'order 5 created');
select is(public.mp_apply_order_state('LCORD0000000000000000000005', 'd7000000-0000-4000-8000-000000000005', 'CANCELLED', 'canceled', 'canceled', null, null, null, 'POLL') ->> 'status', 'CANCELLED', 'sale 5 is annulled by a cancellation...');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000005'), 'CANCELLED', '...');
select is(public.mp_apply_order_state('LCORD0000000000000000000005', 'd7000000-0000-4000-8000-000000000005', 'CONFIRMED', 'processed', 'accredited', 'LCPAY05', 1000000, 1000000, 'WEBHOOK') ->> 'status', 'CONFIRMED', '...but the accreditation arrives anyway');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000005'), 'COMPLETED', 'the sale is restored: the money is in the account');
select is((select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000005'), -1000::bigint, 'and its stock is deducted again exactly once');
select is((select cancellation_reason is null and cancelled_at is null and cancelled_by is null and cancellation_key is null from public.sales where id = 'd7000000-0000-4000-8000-000000000005'), true, 'the annulment metadata is cleared');
select is(public.mp_apply_order_state('LCORD0000000000000000000005', 'd7000000-0000-4000-8000-000000000005', 'CONFIRMED', 'processed', 'accredited', 'LCPAY05', 1000000, 1000000, 'WEBHOOK') ->> 'status', 'CONFIRMED', 'a duplicated confirmation is harmless');
select is((select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000005'), -1000::bigint, 'and does not deduct again');

-- ---------------------------------------------------------------------------------------------
-- Cancelado / pagado ANTES de que la venta llegue al servidor (POS offline): ambos órdenes de llegada convergen
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
insert into lc_orders values ('06', public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000006', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)));
insert into lc_orders values ('07', public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000007', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)));
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from lc_orders where name = '06'), 'LCORD0000000000000000000006', 'created', 'ready_to_process', null, null)$$, 'order 6 created before its sale syncs');
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from lc_orders where name = '07'), 'LCORD0000000000000000000007', 'created', 'ready_to_process', null, null)$$, 'order 7 created before its sale syncs');
select is(public.mp_apply_order_state('LCORD0000000000000000000006', null, 'CANCELLED', 'canceled', 'canceled', null, null, null, 'CANCEL') ->> 'status', 'CANCELLED', 'order 6 is cancelled before the sale arrives');
select is(public.mp_apply_order_state('LCORD0000000000000000000007', null, 'CONFIRMED', 'processed', 'accredited', 'LCPAY07', 1000000, 1000000, 'POLL') ->> 'status', 'CONFIRMED', 'order 7 is paid before the sale arrives');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000006', (select payload from lc_payloads where name = '06'))$$, 'sale 6 then arrives');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000006'), 'CANCELLED', 'and is annulled on arrival');
select is((select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000006'), 0::bigint, 'with its stock net zero');
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000007', (select payload from lc_payloads where name = '07'))$$, 'sale 7 then arrives');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000007'), 'COMPLETED', 'and is completed on arrival');
select is((select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000007'), -1000::bigint, 'with its stock deducted');

-- ---------------------------------------------------------------------------------------------
-- Monto distinto: el dinero llegó pero no cubre la venta => no se completa ni se anula (decide un humano)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000008', (select payload from lc_payloads where name = '08'))$$, 'sale 8 syncs');
insert into lc_orders values ('08', public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000008', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)));
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from lc_orders where name = '08'), 'LCORD0000000000000000000008', 'created', 'ready_to_process', null, null)$$, 'order 8 created');
select is(public.mp_apply_order_state('LCORD0000000000000000000008', 'd7000000-0000-4000-8000-000000000008', 'CONFIRMED', 'processed', 'accredited', 'LCPAY08', 900000, 1000000, 'POLL') ->> 'amountMismatch', 'true', 'a short payment is flagged');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000008'), 'PENDING_PAYMENT', 'the sale is neither completed nor annulled');
select is((select verification_status from public.payments where sale_id = 'd7000000-0000-4000-8000-000000000008'), 'MISMATCH', 'its payment is MISMATCH');

-- ---------------------------------------------------------------------------------------------
-- 19. Polling y webhook producen la misma transición de dominio
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000009', (select payload from lc_payloads where name = '09'))$$, 'sale 9 (polling) syncs');
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000010', (select payload from lc_payloads where name = '10'))$$, 'sale 10 (webhook) syncs');
insert into lc_orders values ('09', public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000009', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)));
insert into lc_orders values ('10', public.mp_prepare_order('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000010', 1000000, 'd1000000-0000-4000-8000-000000000003', repeat('e', 64)));
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from lc_orders where name = '09'), 'LCORD0000000000000000000009', 'created', 'ready_to_process', null, null)$$, 'order 9 created');
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from lc_orders where name = '10'), 'LCORD0000000000000000000010', 'created', 'ready_to_process', null, null)$$, 'order 10 created');
select public.mp_apply_order_state('LCORD0000000000000000000009', 'd7000000-0000-4000-8000-000000000009', 'EXPIRED', 'expired', 'expired', null, null, null, 'POLL');
select public.mp_apply_order_state('LCORD0000000000000000000010', 'd7000000-0000-4000-8000-000000000010', 'EXPIRED', 'expired', 'expired', null, null, null, 'WEBHOOK');
select results_eq(
  $$select s.status::text, p.verification_status, o.status, (select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements m where m.sale_id = s.id) from public.sales s join public.payments p on p.sale_id = s.id join public.mercadopago_orders o on o.sale_id = s.id where s.id = 'd7000000-0000-4000-8000-000000000009'$$,
  $$select s.status::text, p.verification_status, o.status, (select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements m where m.sale_id = s.id) from public.sales s join public.payments p on p.sale_id = s.id join public.mercadopago_orders o on o.sale_id = s.id where s.id = 'd7000000-0000-4000-8000-000000000010'$$,
  'an expiry reported by polling and by the webhook leaves the same state (sale, payment, order, stock)'
);

-- ---------------------------------------------------------------------------------------------
-- Anular una venta Mercado Pago sin orden viva (la alta del cobro falló)
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000011', (select payload from lc_payloads where name = '11'))$$, 'sale 11 (no order was ever created) syncs');
select is((public.mp_abandon_unpaid_sale('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-0000000000aa') ->> 'reason'), 'SALE_NOT_SYNCED', 'an unknown sale is reported as not synced yet');
select throws_ok($$select public.mp_abandon_unpaid_sale('d4000000-0000-4000-8000-000000000002', 'd7000000-0000-4000-8000-000000000011')$$, '42501', null, 'another branch device cannot abandon the sale');
select is((public.mp_abandon_unpaid_sale('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000011') ->> 'abandoned')::boolean, true, 'the unpaid sale without an order is annulled');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000011'), 'CANCELLED', 'it is CANCELLED');
select is((select verification_status from public.payments where sale_id = 'd7000000-0000-4000-8000-000000000011'), 'CANCELLED', 'its payment reads as not accredited');
select is((select coalesce(sum(quantity_grams), 0)::bigint from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000011'), 0::bigint, 'with its stock back');
select is((public.mp_abandon_unpaid_sale('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000011') ->> 'changed')::boolean, false, 'abandoning twice changes nothing');
select is((select count(*) from public.stock_movements where sale_id = 'd7000000-0000-4000-8000-000000000011' and type = 'RETURN'), 1::bigint, 'and returns the stock once');
select is((public.mp_abandon_unpaid_sale('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001') ->> 'reason'), 'NOT_PENDING', 'a completed sale is never abandoned');
select is((public.mp_abandon_unpaid_sale('d4000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000008') ->> 'reason'), 'ORDER_ACTIVE', 'a sale whose Mercado Pago order paid money is not abandoned');

-- ---------------------------------------------------------------------------------------------
-- Cancelación administrativa (cancel_sale) sigue siendo sólo para ventas COMPLETED
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$select public.cancel_sale('d7000000-0000-4000-8000-000000000008', 'dc000000-0000-4000-8000-000000000008', 'prueba')$$, '22023', 'Only completed sales can be cancelled', 'a pending-payment sale cannot be cancelled by hand');
select lives_ok($$select public.cancel_sale('d7000000-0000-4000-8000-000000000001', 'dc000000-0000-4000-8000-000000000001', 'devolución')$$, 'a paid (completed) Mercado Pago sale can still be cancelled by an admin');
reset role;
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000001'), 'CANCELLED', 'it is cancelled');
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select is(public.mp_apply_order_state('LCORD0000000000000000000001', 'd7000000-0000-4000-8000-000000000001', 'CONFIRMED', 'processed', 'accredited', 'LCPAY01', 1000000, 1000000, 'WEBHOOK') ->> 'status', 'CONFIRMED', 'a later duplicated confirmation of that order is accepted');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000001'), 'CANCELLED', 'but an administrator annulment is never reverted automatically');

-- ---------------------------------------------------------------------------------------------
-- 16/17/18. Transferencia manual: prohibida donde Mercado Pago es obligatorio, permitida donde no
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000020', (select payload from lc_payloads where name = '20'))$$, 'P0001', 'MANUAL_TRANSFER_NOT_ALLOWED', 'Avenida: a manual transfer without provider is rejected by the sync');
reset role;
select is((select count(*) from public.sales where id = 'd7000000-0000-4000-8000-000000000020'), 0::bigint, 'and no sale is stored');
select is((select count(*) from public.pos_sync_receipts where event_id = 'd8000000-0000-4000-8000-000000000020'), 0::bigint, 'nor its sync receipt');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select throws_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000025', jsonb_set((select payload from lc_payloads where name = '25'), '{payment,provider}', '"OTHER"'))$$, 'P0001', 'MANUAL_TRANSFER_NOT_ALLOWED', 'a made-up provider cannot be used to skirt the rule');
reset role;
select throws_ok(
  $$insert into public.payments(id, sale_id, organization_id, branch_id, method, amount_cents) values ('da000000-0000-4000-8000-0000000000ff', 'd7000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'TRANSFER', 1)$$,
  'P0001', 'MANUAL_TRANSFER_NOT_ALLOWED', 'not even a direct insert can add a manual transfer to an Avenida sale'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000022', (select payload from lc_payloads where name = '22'))$$, 'Avenida: cash still works');
select is((select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000022'), 'COMPLETED', 'and is COMPLETED at once (no verification involved)');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000021', (select payload from lc_payloads where name = '21'))$$, 'Janssen (no Mercado Pago): a manual transfer still syncs');
select is((select verification_status || '/' || coalesce(provider, 'none') || '/' || (select status::text from public.sales where id = 'd7000000-0000-4000-8000-000000000021') from public.payments where sale_id = 'd7000000-0000-4000-8000-000000000021'), 'NOT_REQUIRED/none/COMPLETED', 'and stays a plain COMPLETED transfer');

-- La política es configurable por sucursal, sin tocar código: Janssen la activa; Avenida la relaja.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select lives_ok($$select public.set_mercadopago_branch_pos('d3000000-0000-4000-8000-000000000001', 'LCAVENIDA01', 'STORE-1', 'POS-1', 'static', 15, true, false)$$, 'admin relaxes the rule for Avenida (Mercado Pago down)');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.mp_get_branch_config('d4000000-0000-4000-8000-000000000001') ->> 'manualTransferAllowed')::boolean, true, 'the device now sees manual transfer allowed');
select lives_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000020', (select payload from lc_payloads where name = '20'))$$, 'and the manual transfer syncs');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select lives_ok($$select public.set_mercadopago_branch_pos('d3000000-0000-4000-8000-000000000002', 'LCJANSSEN01', null, null, 'static', 15, true)$$, 'admin enables Mercado Pago for Janssen with the default policy');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((public.mp_get_branch_config('d4000000-0000-4000-8000-000000000002') ->> 'manualTransferAllowed')::boolean, false, 'Janssen now applies the same rule with no code change');
select throws_ok($$select public.sync_offline_sale('d4000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000024', (select payload from lc_payloads where name = '24'))$$, 'P0001', 'MANUAL_TRANSFER_NOT_ALLOWED', 'and rejects a manual transfer there too');
select is((select count(*) from public.sales where branch_id = 'd3000000-0000-4000-8000-000000000002' and status = 'COMPLETED'), 1::bigint, 'while the earlier Janssen transfer stays untouched');

select * from finish();
rollback;
