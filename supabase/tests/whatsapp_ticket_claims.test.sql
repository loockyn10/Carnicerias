begin;

create extension if not exists pgtap with schema extensions;
select plan(58);

-- ---------------------------------------------------------------------------------------------
-- Shape and hardening
-- ---------------------------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.whatsapp_ticket_claims'::regclass), 'claims have RLS');
select ok(not has_table_privilege('authenticated', 'public.whatsapp_ticket_claims', 'SELECT'), 'claims are backend-only (no SELECT for browser clients)');
select ok(not has_table_privilege('authenticated', 'public.whatsapp_ticket_claims', 'INSERT'), 'claims cannot be written by browser clients');
select ok(not has_table_privilege('anon', 'public.whatsapp_ticket_claims', 'SELECT'), 'anonymous cannot read claims');
select ok(not has_function_privilege('anon', 'public.wa_create_claim(uuid,uuid,uuid,text)', 'EXECUTE'), 'anonymous cannot create claims');
select ok(has_function_privilege('authenticated', 'public.wa_create_claim(uuid,uuid,uuid,text)', 'EXECUTE'), 'the POS can create claims');
select ok(not has_function_privilege('authenticated', 'public.wa_redeem_claim(text,text,text,timestamptz)', 'EXECUTE'), 'a device account cannot redeem claims');
select ok(has_function_privilege('service_role', 'public.wa_redeem_claim(text,text,text,timestamptz)', 'EXECUTE'), 'the backend can redeem claims');
select ok(not has_function_privilege('authenticated', 'app_private.wa_sale_ticket_json(uuid)', 'EXECUTE'), 'the ticket facts helper is private');

-- ---------------------------------------------------------------------------------------------
-- Fixture: org A (Avenida + Janssen), device/operator of Avenida, org B
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cl-device@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"CL Device"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'cl-operator@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Operadora"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'cl-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Admin"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'Carnicerías Fran', 'cl-org-a'),
  ('e2000000-0000-4000-8000-000000000002', 'CL Org B', 'cl-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Avenida', 'AVENIDA'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'Janssen', 'JANSSEN');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003');
insert into public.pos_devices (id, organization_id, branch_id, label, registered_by) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'Avenida POS', 'e1000000-0000-4000-8000-000000000001');
insert into public.pos_operator_grants (organization_id, branch_id, device_id, operator_profile_id, issued_by, token_hash, valid_until) values
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', encode(extensions.digest(convert_to(repeat('e', 64), 'UTF8'), 'sha256'), 'hex'), now() + interval '7 days');

insert into public.categories (id, organization_id, name, slug) values
  ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Vacunos', 'vacunos-cl');
insert into public.products (id, organization_id, category_id, name, slug, unit_type) values
  ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'Vacío', 'vacio-cl', 'WEIGHT'),
  ('e6000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'Hamburguesa', 'hamburguesa-cl', 'UNIT');

-- s1 COMPLETED (Vacío 1 kg $10.000), s2 PENDING_PAYMENT, s3 CANCELLED, s4 other branch, s5 COMPLETED (Hamburguesa x4 $4.000),
-- s6 COMPLETED (will be cancelled after its claim was issued).
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('e7000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'COMPLETED', 1000000, 1000, now()),
  ('e7000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'PENDING_PAYMENT', 1000000, 1000, now()),
  ('e7000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', 'COMPLETED', 1000000, 1000, now()),
  ('e7000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'COMPLETED', 400000, 0, now()),
  ('e7000000-0000-4000-8000-000000000006', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'COMPLETED', 1000000, 1000, now());
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at,
                          cancellation_key, cancelled_at, cancelled_by, cancellation_reason) values
  ('e7000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'CANCELLED', 1000000, 1000, now(),
   'e9000000-0000-4000-8000-000000000003', now(), 'e1000000-0000-4000-8000-000000000004', 'Anulada de prueba');
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents,
  original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot)
select s.id, s.organization_id, s.branch_id, 'e6000000-0000-4000-8000-000000000001', 'Vacío', 1000, 1000000, 1000000, 1000000, 1000000, 650000
from public.sales s where s.id in ('e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000003',
                                   'e7000000-0000-4000-8000-000000000004', 'e7000000-0000-4000-8000-000000000006');
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents,
  original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents)
values ('e7000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001',
        'e6000000-0000-4000-8000-000000000002', 'Hamburguesa', 4, 100000, 100000, 100000, 400000);
insert into public.payments (sale_id, organization_id, branch_id, method, amount_cents)
select s.id, s.organization_id, s.branch_id, 'CASH', s.total_cents from public.sales s where s.id in
  ('e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000005', 'e7000000-0000-4000-8000-000000000006');

create temporary table cl_ctx(k text primary key, v jsonb);
grant all on cl_ctx to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- POS: create claims (device account e1…01 + operator e1…03, token 'eeee…')
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

insert into cl_ctx select 'c1', public.wa_create_claim('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', repeat('e', 64));
insert into cl_ctx select 'c1b', public.wa_create_claim('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', repeat('e', 64));
insert into cl_ctx select 'c5', public.wa_create_claim('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-000000000003', repeat('e', 64));
insert into cl_ctx select 'c6', public.wa_create_claim('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000006', 'e1000000-0000-4000-8000-000000000003', repeat('e', 64));

select is((select v->>'ok' from cl_ctx where k = 'c1'), 'true', 'a COMPLETED sale can get a claim');
select ok((select v->>'token' ~ '^[0-9A-F]{32}$' from cl_ctx where k = 'c1'), 'the token is 128 random bits in hex');
select ok((select v->>'token' <> (select v2->>'token' from (select v as v2 from cl_ctx where k = 'c1b') x) from cl_ctx where k = 'c1'), 'each request produces a different token');
select ok((select position(left(replace('e7000000-0000-4000-8000-000000000001', '-', ''), 8) in lower(v->>'token')) = 0 from cl_ctx where k = 'c1'), 'the token does not embed the sale id');
select ok((select (v->>'expiresAt')::timestamptz between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute' from cl_ctx where k = 'c1'), 'the claim expires in 24 hours');
select is((select v->>'previouslyDelivered' from cl_ctx where k = 'c1'), 'false', 'a fresh sale has no previous delivery');

select is(public.wa_create_claim('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', repeat('e', 64)) ->> 'code', 'SALE_NOT_COMPLETED', 'PENDING_PAYMENT cannot get a claim');
select is(public.wa_create_claim('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003', repeat('e', 64)) ->> 'saleStatus', 'CANCELLED', 'CANCELLED cannot get a claim');
select is(public.wa_create_claim('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-0000000000aa', 'e1000000-0000-4000-8000-000000000003', repeat('e', 64)) ->> 'code', 'SALE_NOT_FOUND', 'a sale that has not synced yet has no claim');
select throws_ok($$select public.wa_create_claim('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000003', repeat('e', 64))$$, '42501', null, 'a sale of another branch is rejected');
select throws_ok($$select public.wa_create_claim('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', repeat('0', 64))$$, '42501', null, 'a wrong operator token is rejected');
select throws_ok($$select token_hash from public.whatsapp_ticket_claims$$, '42501', null, 'browser clients cannot read claims');
reset role;

select is((select count(*) from public.whatsapp_ticket_claims), 4::bigint, 'blocked requests created no claims (only c1, c1b, c5, c6)');
select is((select count(*) from public.whatsapp_ticket_claims where token_hash = (select v->>'token' from cl_ctx where k = 'c1')), 0::bigint, 'the plain token is never stored');
select is((select count(*) from public.whatsapp_ticket_claims where token_hash = encode(extensions.digest(convert_to((select v->>'token' from cl_ctx where k = 'c1'), 'UTF8'), 'sha256'), 'hex')), 1::bigint, 'only its SHA-256 hash is stored');

-- ---------------------------------------------------------------------------------------------
-- Backend: redeem inbound `TICKET <token>` messages
-- ---------------------------------------------------------------------------------------------
set local role service_role;
select is(public.wa_redeem_claim('not-a-token', 'wamid.IN1', '5493496111111') ->> 'kind', 'INVALID', 'a malformed token gets a short INVALID reply');
select is(public.wa_redeem_claim(repeat('A', 32), 'wamid.IN2', '5493496111111') ->> 'kind', 'INVALID', 'an unknown token gets a short INVALID reply');
select ok(not (public.wa_redeem_claim(repeat('B', 32), 'wamid.IN3', '5493496111111') ? 'sale'), 'a rejection reveals nothing about any sale');
select is(public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c1'), 'wamid.INBAD', 'not-digits') ->> 'result', 'BAD_SENDER', 'a malformed sender is ignored');

insert into cl_ctx select 'r1', public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c1'), 'wamid.IN10', '5493496111111', '2026-10-02T17:40:00Z');
select is((select v->>'action' from cl_ctx where k = 'r1'), 'SEND', 'a valid claim accepts the message');
select is((select v #>> '{sale,saleId}' from cl_ctx where k = 'r1'), 'e7000000-0000-4000-8000-000000000001', 'the claim resolves ITS sale');
select is((select v #>> '{sale,totalCents}' from cl_ctx where k = 'r1'), '1000000', 'the ticket facts come from the server');
select ok((select v::text !~* 'cost|supplier|proveedor|margin|markup|stock' from cl_ctx where k = 'r1'), 'no cost, supplier, margin or stock in the ticket facts');
select is((select recipient_phone from public.ticket_deliveries where id = (select (v->>'deliveryId')::uuid from cl_ctx where k = 'r1')), '+5493496111111', 'the recipient phone is the sender reported by Meta');
select is((select claim_id is not null and status = 'PENDING' from public.ticket_deliveries where id = (select (v->>'deliveryId')::uuid from cl_ctx where k = 'r1')), true, 'the delivery is audited against its claim');
select is((select recipient_phone_masked from public.ticket_deliveries where id = (select (v->>'deliveryId')::uuid from cl_ctx where k = 'r1')), '+54*******1111', 'the phone stays masked');
select is((select redeemed_phone from public.whatsapp_ticket_claims where token_hash = encode(extensions.digest(convert_to((select v->>'token' from cl_ctx where k = 'c1'), 'UTF8'), 'sha256'), 'hex')), '5493496111111', 'the claim records who redeemed it');

select is(public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c1'), 'wamid.IN10', '5493496111111') ->> 'result', 'DUPLICATE', 'the same message.id is a duplicate');
select is(public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c1'), 'wamid.IN10', '5493496111111') ->> 'action', 'NONE', 'a duplicate message.id sends nothing');
select is((select count(*) from public.ticket_deliveries where claim_id is not null), 1::bigint, 'a duplicate message.id created no second delivery');
select is((select delivery_count from public.ticket_delivery_events where dedupe_key = 'in|wamid.IN10'), 3, 'duplicates are counted, not re-applied');

select is(public.wa_redeem_claim(lower((select v->>'token' from cl_ctx where k = 'c1')), 'wamid.IN11', '5493496111111') ->> 'action', 'SEND', 'the same phone can ask again (idempotent resend, token case-insensitive)');
select is(public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c1'), 'wamid.IN12', '5493496111111') ->> 'action', 'SEND', 'a third delivery to the same phone is still allowed');
select is(public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c1'), 'wamid.IN13', '5493496111111') ->> 'kind', 'ALREADY_SENT', 'beyond three deliveries the bot only says it was already sent');
select is(public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c1'), 'wamid.IN14', '5493496222222') ->> 'kind', 'USED', 'another phone cannot use a redeemed claim');
select ok(not (public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c1'), 'wamid.IN15', '5493496222222') ? 'sale'), 'the USED reply reveals no sale data');

-- A claim only opens its own sale.
insert into cl_ctx select 'r5', public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c5'), 'wamid.IN20', '5493496333333');
select is((select v #>> '{sale,saleId}' from cl_ctx where k = 'r5'), 'e7000000-0000-4000-8000-000000000005', 'another claim resolves its own sale only');
select is((select v #>> '{sale,items,0,quantityUnits}' from cl_ctx where k = 'r5'), '4', 'UNIT facts come from that sale');
select is(public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c1b'), 'wamid.IN21', '5493496333333') #>> '{sale,saleId}', 'e7000000-0000-4000-8000-000000000001', 'a second claim of sale 1 still maps to sale 1 (never to another sale)');

-- Expiry (24 h) and sales that stop being COMPLETED.
reset role;
update public.whatsapp_ticket_claims set expires_at = now() - interval '1 second'
where token_hash = encode(extensions.digest(convert_to((select v->>'token' from cl_ctx where k = 'c5'), 'UTF8'), 'sha256'), 'hex');
set local role service_role;
select is(public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c5'), 'wamid.IN22', '5493496333333') ->> 'kind', 'EXPIRED', 'an expired claim answers that the link expired');
select ok(not (public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c5'), 'wamid.IN23', '5493496333333') ? 'sale'), 'an expired claim reveals no sale data');

reset role;
update public.sales set status = 'CANCELLED', cancellation_key = 'e9000000-0000-4000-8000-000000000006', cancelled_at = now(),
  cancelled_by = 'e1000000-0000-4000-8000-000000000004', cancellation_reason = 'Anulada luego del claim'
where id = 'e7000000-0000-4000-8000-000000000006';
set local role service_role;
select is(public.wa_redeem_claim((select v->>'token' from cl_ctx where k = 'c6'), 'wamid.IN24', '5493496444444') ->> 'kind', 'NOT_AVAILABLE', 'a sale cancelled after the claim no longer emits a ticket');
select is((select count(*) from public.ticket_deliveries where sale_id = 'e7000000-0000-4000-8000-000000000006'), 0::bigint, 'and no delivery was created for it');

-- Status events keep working for deliveries born from a claim (no regressions).
select is(public.wa_record_send_result((select (v->>'deliveryId')::uuid from cl_ctx where k = 'r1'), 'wamid.OUT1', null, null) ->> 'status', 'SENT', 'the reply is recorded as SENT with its provider message id');
select is(public.wa_apply_status_event('wamid.OUT1', 'DELIVERED', '2026-10-02T17:40:10Z', null, null, 'wamid.OUT1|delivered|1') ->> 'result', 'APPLIED', 'delivered still applies');
select is(public.wa_apply_status_event('wamid.OUT1', 'READ', '2026-10-02T17:40:20Z', null, null, 'wamid.OUT1|read|1') ->> 'result', 'APPLIED', 'read still applies');
select is(public.wa_apply_status_event('wamid.OUT1', 'SENT', '2026-10-02T17:40:05Z', null, null, 'wamid.OUT1|sent|1') ->> 'result', 'IGNORED_OUT_OF_ORDER', 'an old event still does not roll back the state');
reset role;
select is((select status from public.ticket_deliveries where provider_message_id = 'wamid.OUT1'), 'READ', 'the delivery ends READ');

-- A sale that was already delivered is flagged when a new QR is opened.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.wa_create_claim('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', repeat('e', 64)) ->> 'previouslyDelivered', 'true', 'reopening the QR of an already delivered ticket says so');
reset role;

select * from finish();
rollback;
