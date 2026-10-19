begin;

create extension if not exists pgtap with schema extensions;
select plan(13);

-- Two Central terminals, plus one terminal for each other branch. The POS technical identities are
-- members of the same organization but each device remains pinned to its own branch.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'shared-central-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Caja Central A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'shared-central-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Caja Central B"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'shared-avenida@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Caja Avenida"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'shared-janssen@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Caja Janssen"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values ('e2000000-0000-4000-8000-000000000001', 'Shared POS Org', 'shared-pos-org');
insert into public.branches (id, organization_id, name, code) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Central', 'SHCENTRAL'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'Avenida', 'SHAVENIDA'),
  ('e3000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'Janssen', 'SHJANSSEN');
insert into public.organization_members (organization_id, profile_id, role_id, status)
select 'e2000000-0000-4000-8000-000000000001', id, '10000000-0000-4000-8000-000000000001', 'ACTIVE'
from public.profiles where id in ('e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000004');
insert into public.pos_devices (id, organization_id, branch_id, label, registered_by) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'Caja A', 'e1000000-0000-4000-8000-000000000001'),
  ('e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'Caja B', 'e1000000-0000-4000-8000-000000000002'),
  ('e4000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'Avenida POS', 'e1000000-0000-4000-8000-000000000003'),
  ('e4000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000003', 'Janssen POS', 'e1000000-0000-4000-8000-000000000004');

insert into public.categories (id, organization_id, name, slug) values ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Carnes', 'shared-carnes');
insert into public.products (id, organization_id, category_id, name, slug, unit_type) values ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'Vacío histórico', 'vacio-historico', 'WEIGHT');

insert into public.sales (id, organization_id, branch_id, profile_id, device_id, status, total_cents, total_weight_grams, completed_at, operator_name_snapshot, branch_name_snapshot) values
  ('e7000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'COMPLETED', 120000, 1000, now() - interval '2 minutes', 'Ana histórica', 'Central'),
  ('e7000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'e4000000-0000-4000-8000-000000000002', 'COMPLETED', 240000, 2000, now() - interval '1 minute', 'Beto histórico', 'Central'),
  ('e7000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', 'e4000000-0000-4000-8000-000000000003', 'COMPLETED', 360000, 3000, now(), 'Avenida histórica', 'Avenida'),
  ('e7000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000004', 'e4000000-0000-4000-8000-000000000004', 'COMPLETED', 480000, 4000, now(), 'Janssen histórica', 'Janssen');
insert into public.sale_items (id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, created_at) values
  ('e8000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'Vacío histórico', 1000, 120000, 120000, 120000, 120000, now()),
  ('e8000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'Vacío histórico B', 2000, 120000, 120000, 120000, 240000, now());
insert into public.payments (sale_id, organization_id, branch_id, method, amount_cents) values
  ('e7000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'CASH', 120000),
  ('e7000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'DEBIT', 240000);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select has_function('public', 'get_pos_recent_sales', array['uuid', 'integer'], 'shared recent-sales RPC exists');
select has_function('public', 'get_pos_sale_receipt', array['uuid', 'uuid'], 'shared receipt RPC exists');
select ok(has_function_privilege('authenticated', 'public.get_pos_recent_sales(uuid,integer)', 'EXECUTE'), 'authenticated POS session may read shared branch sales');
select ok(not has_function_privilege('anon', 'public.get_pos_recent_sales(uuid,integer)', 'EXECUTE'), 'anonymous cannot read shared branch sales');
select is(jsonb_array_length(public.get_pos_recent_sales('e4000000-0000-4000-8000-000000000001', 25)->'sales'), 2, 'Central A sees exactly the two Central sales');
select is((public.get_pos_recent_sales('e4000000-0000-4000-8000-000000000001', 25)->'sales' @> '[{"saleId":"e7000000-0000-4000-8000-000000000003"}]')::text, 'false', 'Avenida sale never appears in Central');
select is((public.get_pos_recent_sales('e4000000-0000-4000-8000-000000000001', 25)->'sales' @> '[{"saleId":"e7000000-0000-4000-8000-000000000004"}]')::text, 'false', 'Janssen sale never appears in Central');
select is((public.get_pos_recent_sales('e4000000-0000-4000-8000-000000000002', 25)->'sales'->0->>'saleId'), 'e7000000-0000-4000-8000-000000000002', 'Central B sees the newest Central sale made by the other terminal');

-- A renamed product must not change the remote receipt: it only reads sale_items snapshots.
update public.products set name = 'Vacío actual' where id = 'e6000000-0000-4000-8000-000000000001';
select is(public.get_pos_sale_receipt('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000002')->'items'->0->>'productName', 'Vacío histórico B', 'remote reprint uses the historical product-name snapshot, never the current catalog');
select is(public.get_pos_sale_receipt('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000002')->'items'->0->>'chargedPriceCents', '120000', 'remote reprint uses the historical charged price');
select is(public.get_pos_sale_receipt('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000002')->>'operatorName', 'Beto histórico', 'remote reprint preserves the historical operator snapshot');
select is(public.get_pos_sale_receipt('e4000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000003'), null, 'a Central device cannot load an Avenida receipt');
select throws_ok($$select public.get_pos_recent_sales('e4000000-0000-4000-8000-000000000003', 0)$$, '22023', 'Limit must be between 1 and 50', 'invalid polling limits are rejected');

reset role;
select * from finish();
rollback;
