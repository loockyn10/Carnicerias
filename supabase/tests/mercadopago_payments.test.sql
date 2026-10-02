begin;

create extension if not exists pgtap with schema extensions;
select plan(97);

-- ---------------------------------------------------------------------------------------------
-- Shape and hardening
-- ---------------------------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.mercadopago_orders'::regclass), 'orders have RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.mercadopago_branch_pos'::regclass), 'branch config has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.mercadopago_webhook_events'::regclass), 'webhook events have RLS');
select ok(not has_table_privilege('authenticated', 'public.mercadopago_orders', 'SELECT'), 'orders are only readable through the RPC');
select ok(not has_table_privilege('authenticated', 'public.mercadopago_orders', 'INSERT'), 'orders cannot be written by browser clients');
select ok(not has_function_privilege('anon', 'public.mp_prepare_order(uuid,uuid,bigint,uuid,text,boolean)', 'EXECUTE'), 'anonymous cannot prepare orders');
select ok(not has_function_privilege('authenticated', 'public.mp_apply_order_state(text,text,text,text,text,text,bigint,bigint,text)', 'EXECUTE'), 'a device account cannot report Mercado Pago results');
select ok(not has_function_privilege('authenticated', 'public.mp_record_order_result(uuid,text,text,text,text,text)', 'EXECUTE'), 'a device account cannot record order creation');
select ok(not has_function_privilege('authenticated', 'public.mp_record_webhook_event(text,text,text,text,text,text,text,text,text)', 'EXECUTE'), 'a device account cannot log webhooks');
select ok(has_function_privilege('service_role', 'public.mp_apply_order_state(text,text,text,text,text,text,bigint,bigint,text)', 'EXECUTE'), 'the backend can report Mercado Pago results');
select ok(not has_function_privilege('authenticated', 'app_private.sync_offline_sale_core(uuid,uuid,jsonb)', 'EXECUTE'), 'the sync core is private');
select ok(not has_function_privilege('authenticated', 'app_private.mp_reconcile_sale(uuid)', 'EXECUTE'), 'the reconcile function is private');
select ok(has_function_privilege('authenticated', 'public.sync_offline_sale(uuid,uuid,jsonb)', 'EXECUTE'), 'the public sync entry point keeps its grant');
select ok(exists(select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000001' and permission_key = 'payments.read'), 'admin can read reconciliation');
select ok(not exists(select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000002' and permission_key in ('payments.read', 'payments.manage')), 'employees cannot read or manage Mercado Pago');

-- ---------------------------------------------------------------------------------------------
-- Fixture: org A (Avenida + Janssen), org B. Device accounts and operators are EMPLOYEE role.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'mp-device-avenida@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"MP Device Avenida"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'mp-device-janssen@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"MP Device Janssen"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'mp-operator@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Operadora Avenida"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'mp-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"MP Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'mp-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"MP Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'MP Org A', 'mp-org-a'),
  ('c2000000-0000-4000-8000-000000000002', 'MP Org B', 'mp-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Janssen', 'JANSSEN'),
  ('c3000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000002', 'Org B Branch', 'MPB');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003');
insert into public.pos_devices (id, organization_id, branch_id, label, registered_by) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'Avenida POS', 'c1000000-0000-4000-8000-000000000001'),
  ('c4000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'Janssen POS', 'c1000000-0000-4000-8000-000000000002');
insert into public.pos_operator_grants (organization_id, branch_id, device_id, operator_profile_id, issued_by, token_hash, valid_until) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', encode(extensions.digest(convert_to(repeat('c', 64), 'UTF8'), 'sha256'), 'hex'), now() + interval '7 days');

insert into public.categories (id, organization_id, name, slug) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Vacunos', 'vacunos-mp');
insert into public.products (id, organization_id, category_id, name, slug, unit_type) values
  ('c6000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'Vacío MP', 'vacio-mp', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id where p.organization_id = 'c2000000-0000-4000-8000-000000000001';
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('c2000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001', 1000000, '2026-01-01T00:00:00Z');

-- Offline sale payloads (1 kg of Vacío at $10.000 => $10.000 paid by TRANSFER; MP declared via payment.provider).
create temporary table mp_payloads(name text primary key, payload jsonb) on commit drop;
create function pg_temp.mp_sale(sale text, event text, item text, pay text, mov text, profile text, method text, provider text, token text)
returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 1, 'eventId', event, 'saleId', sale,
    'organizationId', 'c2000000-0000-4000-8000-000000000001', 'branchId', 'c3000000-0000-4000-8000-000000000001',
    'profileId', profile, 'operatorToken', token, 'deviceId', 'c4000000-0000-4000-8000-000000000001', 'status', 'COMPLETED',
    'totalCents', '1000000', 'totalWeightGrams', '1000',
    'createdAt', now() - interval '1 minute', 'completedAt', now() - interval '1 minute',
    'items', jsonb_build_array(jsonb_build_object('id', item, 'productId', 'c6000000-0000-4000-8000-000000000001', 'productNameSnapshot', 'Vacío MP', 'weightGrams', 1000, 'pricePerKgCents', '1000000', 'subtotalCents', '1000000')),
    'payment', jsonb_strip_nulls(jsonb_build_object('id', pay, 'method', method, 'provider', provider, 'amountCents', '1000000')),
    'stockMovements', jsonb_build_array(jsonb_build_object('id', mov, 'productId', 'c6000000-0000-4000-8000-000000000001', 'quantityGrams', '-1000', 'occurredAt', now() - interval '1 minute'))
  ));
$$;
-- sale 1: operator path, declared MP. sale 2: plain technical user, declared MP. sale 3: plain TRANSFER (manual). sale 4: MP paid BEFORE the sale syncs.
insert into mp_payloads values
  ('s1', pg_temp.mp_sale('c7000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001', 'cb000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'TRANSFER', 'MERCADOPAGO', repeat('c', 64))),
  ('s2', pg_temp.mp_sale('c7000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000002', 'cb000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('s3', pg_temp.mp_sale('c7000000-0000-4000-8000-000000000003', 'c8000000-0000-4000-8000-000000000003', 'c9000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000003', 'cb000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'TRANSFER', null, null)),
  ('s4', pg_temp.mp_sale('c7000000-0000-4000-8000-000000000004', 'c8000000-0000-4000-8000-000000000004', 'c9000000-0000-4000-8000-000000000004', 'ca000000-0000-4000-8000-000000000004', 'cb000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('s5', pg_temp.mp_sale('c7000000-0000-4000-8000-000000000005', 'c8000000-0000-4000-8000-000000000005', 'c9000000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000005', 'cb000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('s7', pg_temp.mp_sale('c7000000-0000-4000-8000-000000000007', 'c8000000-0000-4000-8000-000000000007', 'c9000000-0000-4000-8000-000000000007', 'ca000000-0000-4000-8000-000000000007', 'cb000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null)),
  ('s6', pg_temp.mp_sale('c7000000-0000-4000-8000-000000000006', 'c8000000-0000-4000-8000-000000000006', 'c9000000-0000-4000-8000-000000000006', 'ca000000-0000-4000-8000-000000000006', 'cb000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000001', 'TRANSFER', 'MERCADOPAGO', null));
grant select on mp_payloads to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Admin: configuration (no config => POS cannot start a Mercado Pago charge)
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is((public.mp_get_branch_config('c4000000-0000-4000-8000-000000000001') ->> 'enabled')::boolean, false, 'Mercado Pago is off until configured');
select throws_ok(
  $$select public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64))$$,
  'P0001', 'MP_NOT_CONFIGURED', 'no order can be prepared before the branch is configured'
);
select throws_ok(
  $$select public.set_mercadopago_branch_pos('c3000000-0000-4000-8000-000000000001', 'AVENIDA01')$$,
  '42501', null, 'an employee device cannot configure Mercado Pago'
);
select throws_ok($$select public.mp_get_branch_config('c4000000-0000-4000-8000-000000000002')$$, '42501', null, 'a device of another branch is rejected');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select lives_ok(
  $$select public.set_mercadopago_branch_pos('c3000000-0000-4000-8000-000000000001', 'AVENIDA01', 'STORE-1', 'POS-1', 'static', 15, false)$$,
  'admin stores the branch configuration disabled'
);
select throws_ok($$select public.set_mercadopago_branch_pos('c3000000-0000-4000-8000-000000000009', 'OTHERORG')$$, 'P0002', null, 'admin cannot configure a branch of another organization');
select throws_ok($$select public.set_mercadopago_branch_pos('c3000000-0000-4000-8000-000000000001', 'bad id!')$$, '23514', null, 'external POS id must be alphanumeric');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64))$$,
  'P0001', 'MP_NOT_CONFIGURED', 'a configured but disabled branch still cannot charge'
);

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select lives_ok(
  $$select public.set_mercadopago_branch_pos('c3000000-0000-4000-8000-000000000001', 'AVENIDA01', 'STORE-1', 'POS-1', 'static', 15, true)$$,
  'admin enables Mercado Pago for Avenida'
);
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.mp_get_branch_config('c4000000-0000-4000-8000-000000000001') ->> 'enabled')::boolean, true, 'the device now sees Mercado Pago enabled');

-- ---------------------------------------------------------------------------------------------
-- Order reservation: 1:1 with the sale, idempotent, amount-safe
-- ---------------------------------------------------------------------------------------------
create temporary table mp_orders(name text primary key, order_json jsonb) on commit drop;
grant all on mp_orders to authenticated, service_role;
insert into mp_orders values ('s1_first', public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64)));
select is((select order_json ->> 'externalReference' from mp_orders where name = 's1_first'), 'c7000000-0000-4000-8000-000000000001', 'attempt 1 uses the sale id as external_reference');
select is((select order_json ->> 'status' from mp_orders where name = 's1_first'), 'REQUESTING', 'a fresh order starts REQUESTING');
select is((select (order_json ->> 'needsMpCall')::boolean from mp_orders where name = 's1_first'), true, 'a REQUESTING order asks the backend to call Mercado Pago');
select is((select order_json ->> 'externalPosId' from mp_orders where name = 's1_first'), 'AVENIDA01', 'the order snapshots the branch POS id');
insert into mp_orders values ('s1_again', public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64)));
select is((select order_json ->> 'orderId' from mp_orders where name = 's1_again'), (select order_json ->> 'orderId' from mp_orders where name = 's1_first'), 'repeating the request returns the same order');
select is((select order_json ->> 'idempotencyKey' from mp_orders where name = 's1_again'), (select order_json ->> 'idempotencyKey' from mp_orders where name = 's1_first'), 'and the same Mercado Pago idempotency key');
reset role;
select is((select count(*) from public.mercadopago_orders where sale_id = 'c7000000-0000-4000-8000-000000000001'), 1::bigint, 'only one order exists for the sale');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 1500000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64))$$,
  '22023', null, 'the same sale cannot be charged with another amount'
);
select throws_ok(
  $$select public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('d', 64))$$,
  '42501', null, 'an invalid operator token is rejected'
);
select throws_ok(
  $$select public.mp_prepare_order('c4000000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000009', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64))$$,
  '42501', null, 'another branch device cannot use this operator token'
);
select throws_ok(
  $$select public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000009', 0, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64))$$,
  '22023', null, 'a zero amount is rejected'
);

-- Backend: Mercado Pago created the order.
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select is(
  (public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from mp_orders where name = 's1_first'), 'ORD01TEST0000000000000000001', 'created', 'ready_to_process', 'PAY01TEST', null) ->> 'status'),
  'CREATED', 'recording the Mercado Pago order id moves the attempt to CREATED'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select is((public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64)) ->> 'needsMpCall')::boolean, false, 'a CREATED order never asks for another Mercado Pago call');
select is((public.mp_get_order_status('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001') ->> 'status'), 'CREATED', 'the POS reads the order status');
select is(public.mp_get_order_status('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-0000000000aa'), null, 'unknown sale => no status');
select throws_ok($$select public.mp_get_order_status('c4000000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000001')$$, '42501', null, 'another branch device cannot read the status');

-- ---------------------------------------------------------------------------------------------
-- Sale arrives (offline sync, operator path): declared MP, still PENDING, never verified by itself
-- ---------------------------------------------------------------------------------------------
select lives_ok(
  $$select public.sync_pos_operator_offline_sale('c4000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', (select payload from mp_payloads where name = 's1'), 'c1000000-0000-4000-8000-000000000003', repeat('c', 64))$$,
  'the operator-path sale syncs'
);
select is((select provider from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000001'), 'MERCADOPAGO', 'the payment is tagged Mercado Pago');
select is((select method::text from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000001'), 'TRANSFER', 'priced as TRANSFER: no pricing rule changed');
select is((select verification_status from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000001'), 'PENDING', 'a declared Mercado Pago sale is PENDING until the backend confirms');
select is((select cash_discount_cents + card_surcharge_cents from public.sale_items where sale_id = 'c7000000-0000-4000-8000-000000000001'), 0::bigint, 'no discount and no card surcharge');
select lives_ok(
  $$select public.sync_pos_operator_offline_sale('c4000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', (select payload from mp_payloads where name = 's1'), 'c1000000-0000-4000-8000-000000000003', repeat('c', 64))$$,
  'replaying the same sale is idempotent'
);
select is((select count(*) from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000001'), 1::bigint, 'still a single payment');
select is((select count(*) from public.sales where id = 'c7000000-0000-4000-8000-000000000001'), 1::bigint, 'still a single sale');
select throws_ok(
  $$select public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 1200000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64))$$,
  '22023', null, 'once the sale is on the server its validated total is the only accepted amount'
);

-- Nobody can mark it verified by hand.
select throws_ok(
  $$update public.payments set verification_status = 'CONFIRMED' where sale_id = 'c7000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'a client cannot write the verification status'
);
reset role;
select throws_ok(
  $$update public.payments set verification_status = 'CONFIRMED' where sale_id = 'c7000000-0000-4000-8000-000000000001'$$,
  '42501', 'Payment verification can only be written by the payment backend', 'not even a direct SQL update can bypass the guard'
);
select throws_ok(
  $$insert into public.payments(id, sale_id, organization_id, branch_id, method, amount_cents, provider, verification_status) values ('ca000000-0000-4000-8000-0000000000ff', 'c7000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'TRANSFER', 1, 'MERCADOPAGO', 'CONFIRMED')$$,
  '42501', null, 'a pre-verified payment cannot be inserted either'
);

-- ---------------------------------------------------------------------------------------------
-- Backend confirms (always from a fetched order): CONFIRMED, idempotent, monotonic
-- ---------------------------------------------------------------------------------------------
set local role service_role;
select is(public.mp_apply_order_state('ORD-NOT-OURS', 'zzz', 'CONFIRMED', 'processed', 'accredited', null, 1000000, 1000000, 'WEBHOOK') ->> 'found', 'false', 'an order that is not ours is ignored');
select is(public.mp_apply_order_state('ORD01TEST0000000000000000001', 'c7000000-0000-4000-8000-000000000001', 'UNKNOWN', 'processed', 'partially_refunded', null, null, null, 'POLL') ->> 'status', 'CREATED', 'an unrecognized state never confirms');
select is(public.mp_apply_order_state('ORD01TEST0000000000000000001', 'c7000000-0000-4000-8000-0000000000bb', 'CONFIRMED', 'processed', 'accredited', null, 1000000, 1000000, 'WEBHOOK') ->> 'ignored', 'REFERENCE_MISMATCH', 'a notification whose reference differs from ours is ignored');
select is((select verification_status from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000001'), 'PENDING', 'still PENDING after ignored notifications');
select is(public.mp_apply_order_state('ORD01TEST0000000000000000001', 'c7000000-0000-4000-8000-000000000001', 'CONFIRMED', 'processed', 'accredited', 'PAY01TEST', 1000000, 1000000, 'WEBHOOK') ->> 'status', 'CONFIRMED', 'accredited payment confirms the order');
select is((select verification_status from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000001'), 'CONFIRMED', 'and verifies the sale payment');
select is((select verified_amount_cents from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000001'), 1000000::bigint, 'with the amount Mercado Pago confirmed');
select ok((select verified_at is not null from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000001'), 'and the confirmation time');
select is(public.mp_apply_order_state('ORD01TEST0000000000000000001', 'c7000000-0000-4000-8000-000000000001', 'CONFIRMED', 'processed', 'accredited', 'PAY01TEST', 1000000, 1000000, 'WEBHOOK') ->> 'status', 'CONFIRMED', 'a duplicated webhook is harmless');
select is(public.mp_apply_order_state('ORD01TEST0000000000000000001', 'c7000000-0000-4000-8000-000000000001', 'EXPIRED', 'expired', 'expired', null, null, null, 'WEBHOOK') ->> 'status', 'CONFIRMED', 'a late expiry notification cannot undo a confirmed payment');
select is(public.mp_record_webhook_event('order.processed|ORD01TEST0000000000000000001|req-1', 'order.processed', 'order', 'ORD01TEST0000000000000000001', 'req-1', 'c7000000-0000-4000-8000-000000000001', 'processed', 'accredited', 'APPLIED'), 1, 'the first delivery is logged once');
select is(public.mp_record_webhook_event('order.processed|ORD01TEST0000000000000000001|req-1', 'order.processed', 'order', 'ORD01TEST0000000000000000001', 'req-1', 'c7000000-0000-4000-8000-000000000001', 'processed', 'accredited', 'APPLIED'), 2, 'a retried delivery only bumps the counter');

-- Payment BEFORE the sale reaches the server (offline POS), a retry after expiry, mismatch, refund.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
insert into mp_orders values ('s4', public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000004', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64)));
select is((select order_json ->> 'status' from mp_orders where name = 's4'), 'REQUESTING', 'an order is prepared for a sale the server has not seen yet');
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok(
  $$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from mp_orders where name = 's4'), 'ORD01TEST0000000000000000004', 'created', 'ready_to_process', null, null)$$,
  'order created at Mercado Pago'
);
select is(public.mp_apply_order_state('ORD01TEST0000000000000000004', 'c7000000-0000-4000-8000-000000000004', 'CONFIRMED', 'processed', 'accredited', 'PAY04', 1000000, 1000000, 'WEBHOOK') ->> 'status', 'CONFIRMED', 'the payment is confirmed before the sale syncs');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select lives_ok($$select public.sync_offline_sale('c4000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000004', (select payload from mp_payloads where name = 's4'))$$, 'the sale then arrives through the plain sync path');
select is((select verification_status from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000004'), 'CONFIRMED', 'and is verified immediately: both arrival orders converge');

-- Expired => retry => attempt 2 with its own reference and key.
insert into mp_orders values ('s5', public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000005', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64)));
select is((select order_json ->> 'attempt' from mp_orders where name = 's5'), '1', 'order for sale 5');
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from mp_orders where name = 's5'), 'ORD01TEST0000000000000000005', 'created', 'ready_to_process', null, null)$$, 'order 5 created');
select is(public.mp_apply_order_state('ORD01TEST0000000000000000005', null, 'EXPIRED', 'expired', 'expired', null, null, null, 'WEBHOOK') ->> 'status', 'EXPIRED', 'the order expires');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select is((public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000005', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64)) ->> 'status'), 'EXPIRED', 'a plain poll never creates a new order by itself');
select is((public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000005', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64), true) ->> 'externalReference'), 'c7000000-0000-4000-8000-000000000005-2', 'an explicit retry uses sale_id-2 as reference');
reset role;
select is((select count(*) from public.mercadopago_orders where sale_id = 'c7000000-0000-4000-8000-000000000005' and status in ('REQUESTING', 'CREATED')), 1::bigint, 'never two live orders for one sale');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select lives_ok($$select public.sync_offline_sale('c4000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000005', (select payload from mp_payloads where name = 's5'))$$, 'sale 5 syncs');
select is((select verification_status from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000005'), 'PENDING', 'a new attempt is pending again');

-- Amount mismatch: the buyer paid less than the sale.
insert into mp_orders values ('s6', public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000006', 1000000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64)));
select is((select order_json ->> 'attempt' from mp_orders where name = 's6'), '1', 'order for sale 6');
select lives_ok($$select public.sync_offline_sale('c4000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000006', (select payload from mp_payloads where name = 's6'))$$, 'sale 6 syncs');
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from mp_orders where name = 's6'), 'ORD01TEST0000000000000000006', 'created', 'ready_to_process', null, null)$$, 'order 6 created');
select is(public.mp_apply_order_state('ORD01TEST0000000000000000006', 'c7000000-0000-4000-8000-000000000006', 'CONFIRMED', 'processed', 'accredited', 'PAY06', 900000, 1000000, 'POLL') ->> 'amountMismatch', 'true', 'a different paid amount is flagged');
select is((select verification_status from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000006'), 'MISMATCH', 'and the sale is NOT verified');
select is(public.mp_apply_order_state('ORD01TEST0000000000000000001', 'c7000000-0000-4000-8000-000000000001', 'REFUNDED', 'refunded', 'refunded', null, null, null, 'WEBHOOK') ->> 'status', 'REFUNDED', 'a refund moves a confirmed order to REFUNDED');
select is((select verification_status from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000001'), 'REFUNDED', 'and the sale payment follows');

-- ---------------------------------------------------------------------------------------------
-- Order for LESS than the sale will end up costing (the sale was not on the server when it was requested):
-- the confirmed money does not cover the validated sale total, so the sale is NOT verified.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
insert into mp_orders values ('s7', public.mp_prepare_order('c4000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000007', 400000, 'c1000000-0000-4000-8000-000000000003', repeat('c', 64)));
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select lives_ok($$select public.mp_record_order_result((select (order_json ->> 'orderId')::uuid from mp_orders where name = 's7'), 'ORD01TEST0000000000000000007', 'created', 'ready_to_process', null, null)$$, 'order 7 created for a smaller amount');
select is(public.mp_apply_order_state('ORD01TEST0000000000000000007', 'c7000000-0000-4000-8000-000000000007', 'CONFIRMED', 'processed', 'accredited', 'PAY07', 400000, 400000, 'WEBHOOK') ->> 'status', 'CONFIRMED', 'the smaller order is paid in full');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select lives_ok($$select public.sync_offline_sale('c4000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000007', (select payload from mp_payloads where name = 's7'))$$, 'the real (larger) sale arrives');
select is((select verification_status from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000007'), 'MISMATCH', 'money that does not cover the validated sale total never verifies it');

-- A plain TRANSFER stays manual/unverifiable; the report classifies everything
-- ---------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select lives_ok($$select public.sync_offline_sale('c4000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000003', (select payload from mp_payloads where name = 's3'))$$, 'a manual transfer syncs');
select is((select verification_status || '/' || coalesce(provider, 'none') from public.payments where sale_id = 'c7000000-0000-4000-8000-000000000003'), 'NOT_REQUIRED/none', 'a manual transfer is not part of the Mercado Pago flow');

select throws_ok($$select * from public.get_mercadopago_reconciliation(now() - interval '1 day', now() + interval '1 day')$$, '42501', null, 'employees cannot read the reconciliation report');
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000004', true);
select is((select count(*) from public.get_mercadopago_reconciliation(now() - interval '1 day', now() + interval '1 day')), 5::bigint, 'the report lists the five synced Mercado Pago sales and no manual transfer');
select is((select classification from public.get_mercadopago_reconciliation(now() - interval '1 day', now() + interval '1 day') where sale_id = 'c7000000-0000-4000-8000-000000000004'), 'VERIFIED', 'a confirmed sale is VERIFIED');
select is((select classification from public.get_mercadopago_reconciliation(now() - interval '1 day', now() + interval '1 day') where sale_id = 'c7000000-0000-4000-8000-000000000006'), 'AMOUNT_MISMATCH', 'a short payment is flagged');
select is((select count(*) from public.get_mercadopago_reconciliation(now() - interval '1 day', now() + interval '1 day', null, true) where classification = 'VERIFIED'), 0::bigint, 'only-issues hides verified sales');
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000005', true);
select is((select count(*) from public.get_mercadopago_reconciliation(now() - interval '1 day', now() + interval '1 day')), 0::bigint, 'another organization sees nothing');

select * from finish();
rollback;
