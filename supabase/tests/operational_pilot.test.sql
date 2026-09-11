begin;

create extension if not exists pgtap with schema extensions;
select plan(49);

select has_table('public', 'audit_logs', 'audit log exists');
select has_table('public', 'branch_product_stock_settings', 'stock settings exist');
select has_table('public', 'stock_operations', 'stock operation header exists');
select has_table('public', 'stock_operation_items', 'stock operation lines exist');
select has_view('public', 'branch_stock_status', 'stock status view exists');
select has_trigger('public', 'stock_movements', 'stock_movements_serialize_product', 'stock writes serialize per branch and product');
select has_function('public', 'record_stock_operation', array['uuid','text','jsonb','text','text','text','timestamp with time zone'], 'stock operation RPC exists');
select has_function('public', 'cancel_sale', array['uuid','uuid','text'], 'sale cancellation RPC exists');
select has_function('public', 'manage_existing_member', array['text','text','text','uuid','membership_status'], 'member association RPC exists');
select has_function('public', 'get_admin_dashboard', array['uuid'], 'dashboard RPC exists');
select ok((select relrowsecurity from pg_class where oid = 'public.audit_logs'::regclass), 'audit log has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.stock_operations'::regclass), 'stock operations have RLS');
select ok(not has_table_privilege('authenticated', 'public.audit_logs', 'INSERT'), 'audit log cannot be inserted by browser clients');
select ok(not has_table_privilege('authenticated', 'public.stock_movements', 'INSERT'), 'stock ledger remains RPC-only');
select ok(not has_function_privilege('anon', 'public.cancel_sale(uuid,uuid,text)', 'EXECUTE'), 'anonymous cannot cancel sales');
select ok((select prosecdef from pg_proc where oid = 'public.cancel_sale(uuid,uuid,text)'::regprocedure), 'cancellation is security definer');
select is((select array_to_string(proconfig, ',') from pg_proc where oid = 'public.cancel_sale(uuid,uuid,text)'::regprocedure), 'search_path=""', 'cancellation has empty search path');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '81000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pilot-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pilot Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-8000-000000000000', '81000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pilot-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pilot Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '81000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pilot-outsider@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Pilot Outsider"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('82000000-0000-4000-8000-000000000001', 'Pilot Org A', 'pilot-org-a'),
  ('82000000-0000-4000-8000-000000000002', 'Pilot Org B', 'pilot-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('83000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'Pilot Centro', 'P-CENTRO'),
  ('83000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000001', 'Pilot Norte', 'P-NORTE'),
  ('83000000-0000-4000-8000-000000000003', '82000000-0000-4000-8000-000000000002', 'Other Branch', 'OTHER');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('82000000-0000-4000-8000-000000000002', '83000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000003');
insert into public.categories (id, organization_id, name, slug) values
  ('84000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'Pilot Category', 'pilot-category');
insert into public.products (id, organization_id, category_id, name, slug, sku) values
  ('85000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', '84000000-0000-4000-8000-000000000001', 'Pilot Product A', 'pilot-product-a', 'PILOT-A'),
  ('85000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000001', '84000000-0000-4000-8000-000000000001', 'Pilot Product B', 'pilot-product-b', 'PILOT-B');
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('82000000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001', 1000000, now() - interval '1 day'),
  ('82000000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000002', 500000, now() - interval '1 day');

set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$select public.manage_existing_member('pilot-employee@example.test', 'Empleado Asociado', 'employee', '83000000-0000-4000-8000-000000000001', 'ACTIVE')$$, 'admin associates an existing Auth user');
select is((select role_key from public.list_organization_members() where email = 'pilot-employee@example.test'), 'employee', 'member directory exposes the assigned role to admin');
select is((select branch_id from public.list_organization_members() where email = 'pilot-employee@example.test'), '83000000-0000-4000-8000-000000000001'::uuid, 'employee is assigned to one branch');

select lives_ok($$select public.save_category(null, 'Congelados Pilot', 'congelados-pilot', 20, true)$$, 'category can be created');
select lives_ok($$select public.save_product(null, '84000000-0000-4000-8000-000000000001', 'Pilot Product C', 'pilot-product-c', 'PILOT-C', 'WEIGHT', true)$$, 'product can be created');
select lives_ok($$select public.set_product_price('85000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', 1100000, now())$$, 'branch price override can be created');
select is((select price_per_kg_cents from public.get_pos_catalog('83000000-0000-4000-8000-000000000001') where product_id = '85000000-0000-4000-8000-000000000001'), 1100000::bigint, 'branch price wins over global price');

select lives_ok($$select public.set_stock_policy('83000000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001', 5000, 12000)$$, 'minimum and target stock can be set');
select lives_ok($$select public.record_stock_operation(
  '83000000-0000-4000-8000-000000000001', 'PURCHASE',
  '[{"product_id":"85000000-0000-4000-8000-000000000001","quantity_grams":10000},{"product_id":"85000000-0000-4000-8000-000000000002","quantity_grams":5000}]',
  'Pilot Supplier', null, 'Remito 1', now()
)$$, 'multi-product purchase is atomic');
select is((select count(*) from public.stock_operation_items), 2::bigint, 'purchase stores both audited lines');
select is((select current_stock_grams from public.branch_stock_status where branch_id = '83000000-0000-4000-8000-000000000001' and product_id = '85000000-0000-4000-8000-000000000001'), 10000::bigint, 'purchase increases derived stock');

select lives_ok($$select public.record_stock_operation(
  '83000000-0000-4000-8000-000000000001', 'WASTE',
  '[{"product_id":"85000000-0000-4000-8000-000000000001","quantity_grams":1000}]',
  null, 'DETERIORATION', 'Control de calidad', now()
)$$, 'waste is registered with a reason');
select is((select current_stock_grams from public.branch_stock_status where branch_id = '83000000-0000-4000-8000-000000000001' and product_id = '85000000-0000-4000-8000-000000000001'), 9000::bigint, 'waste decreases stock');

select lives_ok($$select public.record_stock_operation(
  '83000000-0000-4000-8000-000000000001', 'ADJUSTMENT',
  '[{"product_id":"85000000-0000-4000-8000-000000000001","physical_quantity_grams":8500}]',
  null, null, 'Conteo físico', now()
)$$, 'physical inventory creates the signed adjustment');
select is((select current_stock_grams from public.branch_stock_status where branch_id = '83000000-0000-4000-8000-000000000001' and product_id = '85000000-0000-4000-8000-000000000001'), 8500::bigint, 'adjustment reconciles system stock to physical stock');
select is((select suggested_replenishment_grams from public.branch_stock_status where branch_id = '83000000-0000-4000-8000-000000000001' and product_id = '85000000-0000-4000-8000-000000000001'), 3500::bigint, 'replenishment reaches the configured target');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select * from public.complete_sale('83000000-0000-4000-8000-000000000001', '[{"product_id":"85000000-0000-4000-8000-000000000001","weight_grams":1000,"expected_price_per_kg_cents":"1100000"}]', 'CASH')$$, 'employee sells in assigned branch');
select throws_ok($$select public.record_stock_operation('83000000-0000-4000-8000-000000000001', 'PURCHASE', '[{"product_id":"85000000-0000-4000-8000-000000000001","quantity_grams":1000}]', 'Forbidden Supplier', null, null, now())$$, '42501', 'Permission stock.write is required', 'employee cannot mutate stock manually');
select is((select count(*) from public.stock_operations where branch_id = '83000000-0000-4000-8000-000000000002'), 0::bigint, 'employee cannot see another branch stock operations');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((select current_stock_grams from public.branch_stock_status where branch_id = '83000000-0000-4000-8000-000000000001' and product_id = '85000000-0000-4000-8000-000000000001'), 7500::bigint, 'sale decreases current stock');

select is((public.cancel_sale((select id from public.sales limit 1), '86000000-0000-4000-8000-000000000001', 'Error de carga') ->> 'duplicate')::boolean, false, 'first cancellation succeeds');
select is((select status::text from public.sales limit 1), 'CANCELLED', 'sale is retained with cancelled status');
select is((select count(*) from public.payments), 1::bigint, 'payment history is preserved');
select is((select current_stock_grams from public.branch_stock_status where branch_id = '83000000-0000-4000-8000-000000000001' and product_id = '85000000-0000-4000-8000-000000000001'), 8500::bigint, 'cancellation restores stock exactly once');
select is((public.cancel_sale((select id from public.sales limit 1), '86000000-0000-4000-8000-000000000001', 'Error de carga') ->> 'duplicate')::boolean, true, 'same cancellation key is idempotent');
select is((select count(*) from public.stock_movements where type = 'RETURN'), 1::bigint, 'retry does not duplicate compensating stock');
select throws_ok($$select public.cancel_sale((select id from public.sales limit 1), '86000000-0000-4000-8000-000000000002', 'Segundo intento')$$, '23505', 'Sale is already cancelled', 'another key cannot reverse a cancellation twice');
select ok((select count(*) from public.audit_logs where event_type = 'SALE_CANCELLED' and actor_profile_id = '81000000-0000-4000-8000-000000000001') = 1, 'cancellation is audited once');
select ok((public.get_admin_dashboard(null) -> 'stockAlerts') is not null, 'dashboard returns server-side stock alerts');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.audit_logs), 0::bigint, 'another organization cannot read audit events');
select is((select count(*) from public.stock_operations), 0::bigint, 'another organization cannot read stock operations');

reset role;
set local role anon;
select throws_ok($$select count(*) from public.audit_logs$$, '42501', 'permission denied for table audit_logs', 'anonymous cannot read private audit data');

reset role;
select * from finish();
rollback;
