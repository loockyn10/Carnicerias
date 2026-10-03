begin;

create extension if not exists pgtap with schema extensions;
select plan(67);

-- ---------------------------------------------------------------------------------------------
-- Shape and hardening
-- ---------------------------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.ticket_deliveries'::regclass), 'deliveries have RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.ticket_delivery_events'::regclass), 'webhook events have RLS');
select ok(not has_column_privilege('authenticated', 'public.ticket_deliveries', 'recipient_phone', 'SELECT'), 'the full phone is never readable by browser clients');
select ok(not has_column_privilege('authenticated', 'public.ticket_deliveries', 'provider_message_id', 'SELECT'), 'the provider message id is not readable by browser clients');
select ok(has_column_privilege('authenticated', 'public.ticket_deliveries', 'recipient_phone_masked', 'SELECT'), 'the masked phone is readable');
select ok(not has_table_privilege('authenticated', 'public.ticket_deliveries', 'INSERT'), 'deliveries cannot be written by browser clients');
select ok(not has_table_privilege('authenticated', 'public.ticket_delivery_events', 'SELECT'), 'webhook events are backend-only');
select ok(not has_function_privilege('anon', 'public.wa_prepare_ticket(uuid,uuid,uuid,text,text,boolean)', 'EXECUTE'), 'anonymous cannot prepare tickets');
select ok(not has_function_privilege('authenticated', 'public.wa_record_send_result(uuid,text,text,text,text)', 'EXECUTE'), 'a device account cannot report send results');
select ok(not has_function_privilege('authenticated', 'public.wa_apply_status_event(text,text,timestamptz,text,text,text)', 'EXECUTE'), 'a device account cannot fake webhook events');
select ok(has_function_privilege('service_role', 'public.wa_apply_status_event(text,text,timestamptz,text,text,text)', 'EXECUTE'), 'the backend can apply webhook events');

-- ---------------------------------------------------------------------------------------------
-- Fixture: org A (Avenida + Janssen), org B. Device accounts and operators are EMPLOYEE role.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'wa-device-avenida@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"WA Device Avenida"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'wa-operator@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Operadora Avenida"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'wa-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"WA Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'wa-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"WA Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'Carnicerías Fran', 'wa-org-a'),
  ('f2000000-0000-4000-8000-000000000002', 'WA Org B', 'wa-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Janssen', 'JANSSEN'),
  ('f3000000-0000-4000-8000-000000000009', 'f2000000-0000-4000-8000-000000000002', 'Org B Branch', 'WAB');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003');
insert into public.pos_devices (id, organization_id, branch_id, label, registered_by) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Avenida POS', 'f1000000-0000-4000-8000-000000000001');
insert into public.pos_operator_grants (organization_id, branch_id, device_id, operator_profile_id, issued_by, token_hash, valid_until) values
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000001', encode(extensions.digest(convert_to(repeat('f', 64), 'UTF8'), 'sha256'), 'hex'), now() + interval '7 days');

insert into public.categories (id, organization_id, name, slug) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Vacunos', 'vacunos-wa');
insert into public.products (id, organization_id, category_id, name, slug, unit_type) values
  ('f6000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 'Vacío', 'vacio-wa', 'WEIGHT'),
  ('f6000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 'Hamburguesa', 'hamburguesa-wa', 'UNIT');

-- Sales inserted directly (postgres): s1 COMPLETED cash, s2 PENDING_PAYMENT (Mercado Pago), s3 CANCELLED,
-- s4 COMPLETED with an unconfirmed provider payment (should never exist; defense in depth), s5 other branch,
-- s6 other organization, s7 COMPLETED (retry flow), s8 COMPLETED UNIT line with promotion + card surcharge.
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('f7000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'COMPLETED', 1000000, 1000, now()),
  ('f7000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'PENDING_PAYMENT', 1000000, 1000, now()),
  ('f7000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'COMPLETED', 1000000, 1000, now()),
  ('f7000000-0000-4000-8000-000000000005', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000003', 'COMPLETED', 1000000, 1000, now()),
  ('f7000000-0000-4000-8000-000000000007', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'COMPLETED', 1000000, 1000, now()),
  ('f7000000-0000-4000-8000-000000000008', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'COMPLETED', 2200000, 0, now());
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at,
                          cancellation_key, cancelled_at, cancelled_by, cancellation_reason) values
  ('f7000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'CANCELLED', 1000000, 1000, now(),
   'f9000000-0000-4000-8000-000000000003', now(), 'f1000000-0000-4000-8000-000000000004', 'Anulada de prueba');
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('f7000000-0000-4000-8000-000000000006', 'f2000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000009', 'f1000000-0000-4000-8000-000000000005', 'COMPLETED', 1000000, 1000, now());

-- Weight lines (1 kg of Vacío at $10.000) for every weight sale; cost/markup snapshots are present on
-- purpose: they must never reach the ticket data.
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents,
  original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot, profit_markup_bps_snapshot)
select s.id, s.organization_id, s.branch_id, 'f6000000-0000-4000-8000-000000000001', 'Vacío', 1000, 1000000, 1000000, 1000000, 1000000, 650000, 5000
from public.sales s
where s.id in ('f7000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000003',
               'f7000000-0000-4000-8000-000000000004', 'f7000000-0000-4000-8000-000000000005', 'f7000000-0000-4000-8000-000000000007');
-- s8: 4 hamburguesas con promoción de pack (-$500) y recargo de tarjeta (+$2.000) sobre un precio de lista de $5.000 c/u.
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents,
  original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, promotion_discount_cents, card_surcharge_cents, promotion_mode, cost_cents_snapshot)
values ('f7000000-0000-4000-8000-000000000008', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001',
        'f6000000-0000-4000-8000-000000000002', 'Hamburguesa', 4, 2200000, 500000, 2200000, 2200000, 50000, 200000, 'PACK_FIXED_TOTAL', 300000);
-- sale s4/s2/s8 payments (provider payments need the verifier flag the backend uses).
select set_config('carnicerias.payment_verifier', 'mercadopago', true);
insert into public.payments (sale_id, organization_id, branch_id, method, amount_cents, provider, verification_status) values
  ('f7000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'TRANSFER', 1000000, 'MERCADOPAGO', 'PENDING'),
  ('f7000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'TRANSFER', 1000000, 'MERCADOPAGO', 'PENDING');
select set_config('carnicerias.payment_verifier', '', true);
insert into public.payments (sale_id, organization_id, branch_id, method, amount_cents) values
  ('f7000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'CASH', 1000000),
  ('f7000000-0000-4000-8000-000000000007', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'CASH', 1000000),
  ('f7000000-0000-4000-8000-000000000008', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'CREDIT', 2200000);

create temporary table wa_ctx(k text primary key, v jsonb);
grant all on wa_ctx to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- POS: prepare (device account f1...01 + operator f1...03 with token 'ffff…')
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

insert into wa_ctx select 's1', public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496123456');
select is((select v->>'ok' from wa_ctx where k = 's1'), 'true', 'a COMPLETED sale can be prepared');
select is((select v #>> '{sale,totalCents}' from wa_ctx where k = 's1'), '1000000', 'the server total is returned');
select is((select v #>> '{sale,organizationName}' from wa_ctx where k = 's1'), 'Carnicerías Fran', 'the business name comes from the server');
select is((select v #>> '{sale,branchName}' from wa_ctx where k = 's1'), 'Avenida', 'the branch name comes from the server');
select is((select v #>> '{sale,items,0,weightGrams}' from wa_ctx where k = 's1'), '1000', 'weight lines carry grams');
select is((select v #>> '{sale,payments,0,method}' from wa_ctx where k = 's1'), 'CASH', 'the payment method is returned');
select ok((select v::text !~* 'cost|supplier|proveedor|margin|markup|stock' from wa_ctx where k = 's1'), 'no cost, supplier, margin, markup or stock leaks into the ticket data');
select ok((select v::text !~ 'f1000000-0000-4000-8000-00000000000[135]' from wa_ctx where k = 's1'), 'no employee or device identity leaks into the ticket data');

select is(public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496123456') ->> 'code', 'IN_PROGRESS', 'a double tap while the first send is in flight is not duplicated');

select is(public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496123456') ->> 'code', 'SALE_NOT_COMPLETED', 'PENDING_PAYMENT blocks the ticket');
select is(public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496123456') ->> 'saleStatus', 'CANCELLED', 'CANCELLED blocks the ticket');
select is(public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000004', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496123456') ->> 'code', 'PAYMENT_NOT_CONFIRMED', 'an unconfirmed provider payment blocks the ticket even on a COMPLETED sale');
select is(public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-0000000000aa', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496123456') ->> 'code', 'SALE_NOT_FOUND', 'a sale that has not reached the server yet is reported as such');
select throws_ok($$select public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000005', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496123456')$$, '42501', null, 'a sale of another branch is rejected');
select throws_ok($$select public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000006', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496123456')$$, '42501', null, 'a sale of another organization is rejected');
select throws_ok($$select public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', repeat('0', 64), '+5493496123456')$$, '42501', null, 'a wrong operator token is rejected');
select throws_ok($$select public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '3496123456')$$, '22023', null, 'a non-E.164 phone is rejected');

insert into wa_ctx select 's8', public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000008', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496654321');
select is((select v #>> '{sale,items,0,quantityUnits}' from wa_ctx where k = 's8'), '4', 'UNIT lines carry units');
select ok((select v #> '{sale,items,0}' ? 'weightGrams' and (v #>> '{sale,items,0,weightGrams}') is null from wa_ctx where k = 's8'), 'UNIT lines have no grams');
select is((select v #>> '{sale,items,0,promotionDiscountCents}' from wa_ctx where k = 's8'), '50000', 'promotion discounts are returned');
select is((select v #>> '{sale,items,0,cardSurchargeCents}' from wa_ctx where k = 's8'), '200000', 'card surcharges are returned');

-- Reading (RLS): the device account (employee) cannot read the raw phone, but the masked one is fine.
select throws_ok($$select recipient_phone from public.ticket_deliveries$$, '42501', null, 'the raw phone is denied even to authorized staff');

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is((select recipient_phone_masked from public.ticket_deliveries where sale_id = 'f7000000-0000-4000-8000-000000000001'), '+54*******3456', 'an admin sees the masked phone');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000005', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
select is((select count(*) from public.ticket_deliveries), 0::bigint, 'another organization sees no deliveries');
reset role;

select is((select count(*) from public.ticket_deliveries), 2::bigint, 'blocked attempts created no delivery rows (only s1 and s8 are PENDING)');

-- ---------------------------------------------------------------------------------------------
-- Backend: send results, duplicates and retries
-- ---------------------------------------------------------------------------------------------
set local role service_role;
select is(public.wa_record_send_result((select (v->>'deliveryId')::uuid from wa_ctx where k = 's1'), 'wamid.S1', null, null, 'ticket_compra') ->> 'status', 'SENT', 'a message id marks the delivery SENT');
select is((select provider_message_id from public.ticket_deliveries where sale_id = 'f7000000-0000-4000-8000-000000000001'), 'wamid.S1', 'the provider message id is stored');
select is(public.wa_record_send_result((select (v->>'deliveryId')::uuid from wa_ctx where k = 's1'), 'wamid.OTHER', null, null) ->> 'status', 'SENT', 'recording the result twice does not change the first message id');
select is((select provider_message_id from public.ticket_deliveries where sale_id = 'f7000000-0000-4000-8000-000000000001'), 'wamid.S1', 'the first message id is kept');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496999999') ->> 'code', 'ALREADY_SENT', 'a sent ticket asks for confirmation before sending again (any phone)');
select is(public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496999999') ->> 'phoneMasked', '+54*******3456', 'the warning shows only the masked previous number');
insert into wa_ctx select 's1b', public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496999999', true);
select is((select v->>'ok' from wa_ctx where k = 's1b'), 'true', 'a deliberate resend is allowed');
reset role;
select is((select count(*) from public.ticket_deliveries where sale_id = 'f7000000-0000-4000-8000-000000000001'), 2::bigint, 'the resend is a new audited attempt');

-- A FAILED attempt does not count as "already sent": retrying needs no confirmation.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into wa_ctx select 's7', public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000007', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496111111');
reset role;
set local role service_role;
select is(public.wa_record_send_result((select (v->>'deliveryId')::uuid from wa_ctx where k = 's7'), null, '131030', 'Recipient phone number not in allowed list') ->> 'status', 'FAILED', 'a provider error marks the delivery FAILED');
select is((select provider_error_code from public.ticket_deliveries where sale_id = 'f7000000-0000-4000-8000-000000000007'), '131030', 'the provider error code is kept for diagnosis');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000007', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496111111') ->> 'ok', 'true', 'retrying after a failure is allowed without confirmation');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Webhook: idempotent, monotonic (s1 delivery wamid.S1 is SENT)
-- ---------------------------------------------------------------------------------------------
set local role service_role;
select is(public.wa_apply_status_event('wamid.S1', 'DELIVERED', '2026-10-02T15:00:10Z', null, null, 'wamid.S1|delivered|1') ->> 'result', 'APPLIED', 'DELIVERED is applied');
select is((select status from public.ticket_deliveries where provider_message_id = 'wamid.S1'), 'DELIVERED', 'the delivery is DELIVERED');
select is((select delivered_at from public.ticket_deliveries where provider_message_id = 'wamid.S1'), '2026-10-02T15:00:10Z'::timestamptz, 'delivered_at comes from the provider timestamp');
select is(public.wa_apply_status_event('wamid.S1', 'DELIVERED', '2026-10-02T15:00:10Z', null, null, 'wamid.S1|delivered|1') ->> 'result', 'DUPLICATE', 'a repeated event is a duplicate');
select is((select delivery_count from public.ticket_delivery_events where dedupe_key = 'wamid.S1|delivered|1'), 2, 'the duplicate is counted, not re-applied');
select is(public.wa_apply_status_event('wamid.S1', 'SENT', '2026-10-02T15:00:05Z', null, null, 'wamid.S1|sent|1') ->> 'result', 'IGNORED_OUT_OF_ORDER', 'a late SENT never rolls DELIVERED back');
select is((select status from public.ticket_deliveries where provider_message_id = 'wamid.S1'), 'DELIVERED', 'the status stays DELIVERED after the late SENT');
select is(public.wa_apply_status_event('wamid.S1', 'READ', '2026-10-02T15:01:00Z', null, null, 'wamid.S1|read|1') ->> 'result', 'APPLIED', 'READ is applied');
select is(public.wa_apply_status_event('wamid.S1', 'DELIVERED', '2026-10-02T15:02:00Z', null, null, 'wamid.S1|delivered|2') ->> 'result', 'IGNORED_OUT_OF_ORDER', 'an older state after READ does not downgrade it');
select is(public.wa_apply_status_event('wamid.S1', 'FAILED', '2026-10-02T15:03:00Z', '131026', 'Message undeliverable', 'wamid.S1|failed|1') ->> 'result', 'IGNORED_OUT_OF_ORDER', 'a late FAILED never undoes a READ');
select is((select status from public.ticket_deliveries where provider_message_id = 'wamid.S1'), 'READ', 'the final status is READ');
select is(public.wa_apply_status_event('wamid.S1', 'READ', '2026-10-02T15:05:00Z', null, null, 'wamid.S1|read|2') ->> 'result', 'NO_CHANGE', 'a second READ with another timestamp changes nothing');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.wa_prepare_ticket('f4000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', repeat('f', 64), '+5493496999999') ->> 'status', 'READ', 'a READ ticket also asks for confirmation before sending again');
reset role;
set local role service_role;

-- FAILED is terminal: SENT -> FAILED applies; anything after is ignored.
select public.wa_record_send_result((select (v->>'deliveryId')::uuid from wa_ctx where k = 's1b'), 'wamid.S1B', null, null);
select is(public.wa_apply_status_event('wamid.S1B', 'FAILED', '2026-10-02T15:00:20Z', '131026', 'Message undeliverable', 'wamid.S1B|failed|1') ->> 'result', 'APPLIED', 'FAILED after SENT is applied');
select is((select provider_error_code from public.ticket_deliveries where provider_message_id = 'wamid.S1B'), '131026', 'the webhook error is stored for diagnosis');
select is(public.wa_apply_status_event('wamid.S1B', 'DELIVERED', '2026-10-02T15:00:30Z', null, null, 'wamid.S1B|delivered|1') ->> 'result', 'IGNORED_OUT_OF_ORDER', 'a DELIVERED after FAILED does not resurrect it');
select is((select status from public.ticket_deliveries where provider_message_id = 'wamid.S1B'), 'FAILED', 'FAILED stays terminal');

-- Unknown status and early events (the webhook can beat the send recording).
select is(public.wa_apply_status_event('wamid.S1', 'DELETED', null, null, null, 'wamid.S1|deleted|1') ->> 'result', 'IGNORED_STATUS', 'unknown provider statuses are ignored (and logged)');
select is(public.wa_apply_status_event('wamid.EARLY', 'DELIVERED', '2026-10-02T15:10:10Z', null, null, 'wamid.EARLY|delivered|1') ->> 'result', 'UNKNOWN_MESSAGE', 'an event for an unrecorded message is stored, not lost');
select public.wa_record_send_result((select (v->>'deliveryId')::uuid from wa_ctx where k = 's8'), 'wamid.EARLY', null, null);
select is((select status from public.ticket_deliveries where provider_message_id = 'wamid.EARLY'), 'DELIVERED', 'the stored early event is replayed once the message id is recorded');
reset role;

select * from finish();
rollback;
