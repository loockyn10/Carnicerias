begin;

create extension if not exists pgtap with schema extensions;
select plan(126);

-- Cubre 202611120098 (Distribución, parte 2): conciliación (paquetes identificados vs ventas por cantidad), devoluciones (recepción en cuarentena, inspección, reingreso
-- autorizado, rechazo, descarte), control de vencimientos, integridad del inventario y estadísticas confirmadas/estimadas. Fixture: una organización con un administrador, un
-- usuario que escribe pero no autoriza reingresos, un empleado sin permisos de distribución, y una organización ajena.

-- Fixture
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ret-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"RET Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ret-other@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"RET Other"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'ret-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"RET Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'ret-writer@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"RET Writer"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug, timezone) values
  ('b2000000-0000-4000-8000-000000000001', 'RET Org', 'ret-org', 'America/Argentina/Buenos_Aires'),
  ('b2000000-0000-4000-8000-000000000002', 'RET Org B', 'ret-org-b', 'America/Argentina/Buenos_Aires');
insert into public.branches (id, organization_id, name, code) values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Central', 'CEN'),
  ('b3000000-0000-4000-8000-000000000009', 'b2000000-0000-4000-8000-000000000002', 'Central B', 'CEB');
update public.organizations set production_branch_id = 'b3000000-0000-4000-8000-000000000001' where id = 'b2000000-0000-4000-8000-000000000001';
insert into public.roles (id, organization_id, key, name, description, is_system) values
  ('b0000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'dist-writer', 'Distribución (sin autorizar reingresos)', 'Prueba', false);
insert into public.role_permissions (role_id, permission_key) values
  ('b0000000-0000-4000-8000-000000000001', 'distribution.read'), ('b0000000-0000-4000-8000-000000000001', 'distribution.write'),
  ('b0000000-0000-4000-8000-000000000001', 'vacuum.read'), ('b0000000-0000-4000-8000-000000000001', 'branches.read_all');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Vacuno', 'vacuno'),
  ('b5000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'Cerdo', 'cerdo');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('b6000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 'Vacío', 'vacio', 'VAC', 'WEIGHT'),
  ('b6000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002', 'Asado', 'asado', 'ASA', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id;
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('b2000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', null, 1500000, now() - interval '1 day'),
  ('b2000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000002', null, 1000000, now() - interval '1 day');

create function public.t_ret_count(p_sql text) returns bigint language plpgsql security definer set search_path = '' as $$
declare n bigint; begin execute p_sql into n; return n; end; $$;
create function public.t_ret_state(p_package uuid) returns text language sql security definer set search_path = '' as $$
  select s.status from public.vacuum_package_state s where s.package_id = p_package $$;
-- Intenta aprobar por afuera de las reglas (como un SQL directo): el check de la tabla tiene que impedirlo.
create function public.t_ret_force_approve(p_return uuid) returns void language sql security definer set search_path = '' as $$
  update public.distribution_returns set status = 'APPROVED', decided_at = now(), decision_reason = 'forzado', packaging_state = 'DAMAGED', conservation_verified = true where id = p_return $$;
grant execute on function public.t_ret_count(text), public.t_ret_state(uuid), public.t_ret_force_approve(uuid) to authenticated;

create function public.t_ret_pkg(p_n integer, p_product uuid, p_grams integer, p_packed integer, p_expires integer) returns uuid language plpgsql security invoker set search_path = '' as $$
begin
  return (public.create_vacuum_package('b3000000-0000-4000-8000-000000000001', p_product, p_grams, current_setting('test.today')::date + p_packed,
    case when p_expires is null then null else current_setting('test.today')::date + p_expires end, null, ('b8000000-0000-4000-8000-0000000000' || lpad(p_n::text, 2, '0'))::uuid) ->> 'id')::uuid;
end; $$;
grant execute on function public.t_ret_pkg(integer, uuid, integer, integer, integer) to authenticated;

select set_config('test.today', ((clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date)::text, true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$select public.save_vacuum_ean_scheme('PRICE_EMBEDDED', '20', 4, 6, 100)$$, 'the EAN scheme is configured');
select lives_ok($$select public.save_vacuum_product_config('b6000000-0000-4000-8000-000000000001', true, 7, '12', null)$$, 'Vacío is enabled');
select lives_ok($$select public.save_vacuum_product_config('b6000000-0000-4000-8000-000000000002', true, 7, '13', null)$$, 'Asado is enabled');

-- Paquetes (key a8…): Vacío v1 0,750 · v2 0,500 · v3 0,300 · w1 0,800 · w2 0,200 · w3 0,100 · e1 0,350 (vence ayer) y Asado a1 0,600 · a2 0,400.
select set_config('r.v1', public.t_ret_pkg(1, 'b6000000-0000-4000-8000-000000000001', 750, 0, null)::text, true);
select set_config('r.v2', public.t_ret_pkg(2, 'b6000000-0000-4000-8000-000000000001', 500, 0, null)::text, true);
select set_config('r.v3', public.t_ret_pkg(3, 'b6000000-0000-4000-8000-000000000001', 300, 0, null)::text, true);
select set_config('r.w1', public.t_ret_pkg(4, 'b6000000-0000-4000-8000-000000000001', 800, 0, null)::text, true);
select set_config('r.w2', public.t_ret_pkg(5, 'b6000000-0000-4000-8000-000000000001', 200, 0, null)::text, true);
select set_config('r.w3', public.t_ret_pkg(6, 'b6000000-0000-4000-8000-000000000001', 100, 0, null)::text, true);
select set_config('r.e1', public.t_ret_pkg(7, 'b6000000-0000-4000-8000-000000000001', 350, -5, -1)::text, true);
select set_config('r.a1', public.t_ret_pkg(8, 'b6000000-0000-4000-8000-000000000002', 600, 0, null)::text, true);
select set_config('r.a2', public.t_ret_pkg(9, 'b6000000-0000-4000-8000-000000000002', 400, 0, null)::text, true);
select set_config('r.v3_expires', (public.get_vacuum_package(current_setting('r.v3')::uuid) ->> 'expiresOn'), true);

select set_config('r.client1', (public.save_distribution_client(null, 'Supermercado Sol', null, null, 'CONSIGNMENT') ->> 'id'), true);
select set_config('r.client2', (public.save_distribution_client(null, 'Mayorista Norte', null, null, 'WHOLESALE') ->> 'id'), true);
select set_config('r.site1', (public.save_distribution_site(null, current_setting('r.client1')::uuid, 'Sol Centro') ->> 'id'), true);
select set_config('r.site2', (public.save_distribution_site(null, current_setting('r.client2')::uuid, 'Norte Depósito') ->> 'id'), true);

-- D0: consignación hace 3 días con un paquete que hoy está vencido. D1: consignación de hoy. D2: venta mayorista firme de hoy.
select set_config('r.d0', (public.create_distribution_delivery(current_setting('r.site1')::uuid, current_setting('test.today')::date - 3) ->> 'id'), true);
select lives_ok($$select public.add_delivery_packages(current_setting('r.d0')::uuid, array[current_setting('r.e1')::uuid])$$, 'a package that expires the day after the delivery is dispatchable then');
select lives_ok($$select public.confirm_distribution_delivery(current_setting('r.d0')::uuid)$$, 'and the old delivery is confirmed');
select set_config('r.d1', (public.create_distribution_delivery(current_setting('r.site1')::uuid, current_setting('test.today')::date) ->> 'id'), true);
select lives_ok($$select public.add_delivery_packages(current_setting('r.d1')::uuid, array[current_setting('r.v1')::uuid, current_setting('r.v2')::uuid, current_setting('r.v3')::uuid, current_setting('r.a1')::uuid, current_setting('r.a2')::uuid])$$, 'the consignment delivery gets five packages');
select lives_ok($$select public.confirm_distribution_delivery(current_setting('r.d1')::uuid)$$, 'and is confirmed');
select set_config('r.d2', (public.create_distribution_delivery(current_setting('r.site2')::uuid, current_setting('test.today')::date) ->> 'id'), true);
select lives_ok($$select public.add_delivery_packages(current_setting('r.d2')::uuid, array[current_setting('r.w1')::uuid, current_setting('r.w2')::uuid, current_setting('r.w3')::uuid])$$, 'the wholesale delivery gets three packages');
select lives_ok($$select public.confirm_distribution_delivery(current_setting('r.d2')::uuid)$$, 'and is confirmed');

-- ---------------------------------------------------------------------------------------------
-- Conciliación
-- ---------------------------------------------------------------------------------------------
select is((public.get_delivery_reconciliation(current_setting('r.d1')::uuid) -> 'totals' ->> 'pending')::integer, 5, 'a fresh consignment delivery has everything pending');
select is((public.report_delivery_sales(current_setting('r.d1')::uuid, array[current_setting('r.v1')::uuid]) ->> 'reported')::integer, 1, 'a package is reported sold individually');
select is(public.t_ret_state(current_setting('r.v1')::uuid), 'SOLD_EXTERNAL', 'and becomes SOLD_EXTERNAL');
select is((public.report_delivery_sales(current_setting('r.d1')::uuid, array[current_setting('r.v1')::uuid]) ->> 'alreadyReported')::integer, 1, 'reporting it again is idempotent');
select is(public.t_ret_count('select count(*) from public.vacuum_package_events where kind = ''SOLD_EXTERNAL'''), 1::bigint, 'and the history is not repeated');
select is((public.report_delivery_sales_by_codes(current_setting('r.d1')::uuid, array[(select code from public.vacuum_package_logistics where package_id = current_setting('r.v2')::uuid)]) ->> 'reported')::integer, 1, 'a package is reported by its logistic code');
select throws_ok($$select public.report_delivery_sales(current_setting('r.d2')::uuid, array[current_setting('r.w1')::uuid])$$, '22023', null, 'a package of a firm wholesale sale is already sold');
select throws_ok($$select public.report_delivery_sales(current_setting('r.d1')::uuid, array[current_setting('r.w3')::uuid])$$, '22023', null, 'a package of another delivery cannot be reported here');
select throws_ok($$select public.report_delivery_sales(current_setting('r.d1')::uuid, array[current_setting('r.a1')::uuid], current_setting('test.today')::date + 3)$$, '22023', null, 'a sale cannot be dated in the future');
select is((public.report_delivery_quantity_sales(current_setting('r.d1')::uuid, jsonb_build_array(jsonb_build_object('productId', 'b6000000-0000-4000-8000-000000000002', 'quantity', 1)), null, 'Informe del sábado', 'b9000000-0000-4000-8000-000000000001') ->> 'recorded')::integer, 1, 'a quantity-only sale is recorded');
select is((public.report_delivery_quantity_sales(current_setting('r.d1')::uuid, jsonb_build_array(jsonb_build_object('productId', 'b6000000-0000-4000-8000-000000000002', 'quantity', 1)), null, 'Informe del sábado', 'b9000000-0000-4000-8000-000000000001') ->> 'recorded')::integer, 0, 'sending the same report again does not add it twice');
select throws_ok($$select public.report_delivery_quantity_sales(current_setting('r.d1')::uuid, jsonb_build_array(jsonb_build_object('productId', 'b6000000-0000-4000-8000-000000000002', 'quantity', 5)))$$, '22023', null, 'more sold than pending is refused (no invented sales)');
select throws_ok($$select public.report_delivery_quantity_sales(current_setting('r.d2')::uuid, jsonb_build_array(jsonb_build_object('productId', 'b6000000-0000-4000-8000-000000000001', 'quantity', 1)))$$, '22023', null, 'a firm wholesale delivery is not reconciled by quantity');
select is(public.t_ret_count('select count(*) from public.vacuum_package_state where status = ''SOLD_EXTERNAL'''), 2::bigint, 'a quantity-only report marks NO package (only the 2 identified ones are sold)');
select is((public.get_delivery_reconciliation(current_setting('r.d1')::uuid) -> 'totals' ->> 'soldIdentified')::integer, 2, 'the reconciliation separates identified sales');
select is((public.get_delivery_reconciliation(current_setting('r.d1')::uuid) -> 'totals' ->> 'soldInferred')::integer, 1, 'from inferred ones');
select is((public.get_delivery_reconciliation(current_setting('r.d1')::uuid) -> 'totals' ->> 'pending')::integer, 2, 'and pending is what is left: 5 - 2 - 1');
select is((select e ->> 'estimatedInferredCents' from jsonb_array_elements(public.get_delivery_reconciliation(current_setting('r.d1')::uuid) -> 'products') e where e ->> 'productName' = 'Asado'), '500000', 'the inferred sale is valued at the average package price of that product (an estimate)');
select throws_ok($$select public.close_delivery_reconciliation(current_setting('r.d1')::uuid)$$, '22023', null, 'closing with unexplained packages requires a note');

-- ---------------------------------------------------------------------------------------------
-- Devoluciones: registro
-- ---------------------------------------------------------------------------------------------
select is((public.register_distribution_returns(current_setting('r.d1')::uuid, jsonb_build_array(
  jsonb_build_object('packageId', current_setting('r.v3'), 'reason', 'UNSOLD'), jsonb_build_object('packageId', current_setting('r.a1'), 'reason', 'DAMAGED', 'reasonNote', 'Envase hinchado')),
  null, 'ba000000-0000-4000-8000-000000000001') ->> 'registered')::integer, 2, 'two packages are registered as returns');
select is(public.t_ret_state(current_setting('r.v3')::uuid), 'DISPATCHED', 'until they are received they still belong to the supermarket');
select is((public.register_distribution_returns(current_setting('r.d1')::uuid, jsonb_build_array(jsonb_build_object('packageId', current_setting('r.v3'), 'reason', 'UNSOLD')), null, 'ba000000-0000-4000-8000-000000000001') ->> 'alreadyRegistered')::integer, 1, 'sending the same registration again is idempotent');
select throws_ok($$select public.register_distribution_returns(current_setting('r.d1')::uuid, jsonb_build_array(jsonb_build_object('packageId', current_setting('r.v3'), 'reason', 'UNSOLD')))$$, '22023', null, 'a package cannot have two returns in progress');
select throws_ok($$select public.register_distribution_returns(current_setting('r.d1')::uuid, jsonb_build_array(jsonb_build_object('packageId', current_setting('r.v1'), 'reason', 'UNSOLD')))$$, '22023', null, 'a package reported as sold cannot be returned');
select throws_ok($$select public.register_distribution_returns(current_setting('r.d1')::uuid, jsonb_build_array(jsonb_build_object('packageId', current_setting('r.a2'), 'reason', 'OTHER')))$$, '22023', null, 'the reason "other" needs an explanation');
select throws_ok($$select public.register_distribution_returns(current_setting('r.d1')::uuid, jsonb_build_array(jsonb_build_object('packageId', current_setting('r.a2'), 'reason', 'MAGIC')))$$, '22023', null, 'and the reason must be a known one');
select is((select (e ->> 'pending')::integer from jsonb_array_elements(public.get_delivery_reconciliation(current_setting('r.d1')::uuid) -> 'products') e where e ->> 'productName' = 'Asado'), 0, 'a registered return stops counting as pending');
select is(public.close_delivery_reconciliation(current_setting('r.d1')::uuid) ->> 'pendingAtClose', '0', 'with nothing left unexplained the reconciliation closes without a note');
select is(public.close_delivery_reconciliation(current_setting('r.d1')::uuid) ->> 'alreadyClosed', 'true', 'closing again is idempotent');
select throws_ok($$select public.report_delivery_sales(current_setting('r.d1')::uuid, array[current_setting('r.a2')::uuid])$$, '22023', null, 'a closed reconciliation accepts no new sales reports');
select is(public.close_delivery_reconciliation(current_setting('r.d0')::uuid, 'El supermercado no devolvió el paquete') ->> 'pendingAtClose', '1', 'with a note, a delivery closes leaving its difference recorded');

-- ---------------------------------------------------------------------------------------------
-- Recepción: cuarentena (nunca disponible solo)
-- ---------------------------------------------------------------------------------------------
select set_config('r.ret_v3', (select id::text from public.distribution_returns where package_id = current_setting('r.v3')::uuid), true);
select set_config('r.ret_a1', (select id::text from public.distribution_returns where package_id = current_setting('r.a1')::uuid), true);
select throws_ok($$select public.receive_distribution_returns(jsonb_build_array(jsonb_build_object('returnId', current_setting('r.ret_v3'), 'conservationVerified', true)))$$, '22023', null, 'receiving needs the state of the packaging');
select throws_ok($$select public.decide_distribution_return(current_setting('r.ret_v3')::uuid, 'APPROVE', 'quiero reingresarlo')$$, '22023', null, 'a package not yet received cannot be decided');
select is((public.receive_distribution_returns(jsonb_build_array(
  jsonb_build_object('returnId', current_setting('r.ret_v3'), 'packagingState', 'INTACT', 'conservationVerified', true, 'conservationNote', 'Llegó en conservadora a 3 °C'),
  jsonb_build_object('returnId', current_setting('r.ret_a1'), 'packagingState', 'VACUUM_LOST', 'conservationVerified', true))) ->> 'received')::integer, 2, 'two returns are received');
select is(public.t_ret_state(current_setting('r.v3')::uuid), 'QUARANTINE', 'a returned package goes to QUARANTINE');
select is((select status from public.distribution_returns where id = current_setting('r.ret_v3')::uuid), 'IN_QUARANTINE', 'its return is in quarantine');
select is((public.receive_distribution_returns(jsonb_build_array(jsonb_build_object('returnId', current_setting('r.ret_v3'), 'packagingState', 'INTACT', 'conservationVerified', true))) ->> 'alreadyReceived')::integer, 1, 'receiving again is idempotent');
select is((select outcome from public.distribution_delivery_items where package_id = current_setting('r.v3')::uuid), 'RETURNED', 'the delivery line shows the package as returned');
select is(public.t_ret_count('select count(*) from public.stock_movements where type = ''DISTRIBUTION_RETURN'''), 0::bigint, 'receiving does not touch the stock');
select is((public.list_distributable_packages('b3000000-0000-4000-8000-000000000001') ->> 'total')::integer, 0, 'a quarantined package is not offered for distribution');
select set_config('r.dx', (public.create_distribution_delivery(current_setting('r.site1')::uuid, current_setting('test.today')::date) ->> 'id'), true);
select throws_ok($$select public.add_delivery_packages(current_setting('r.dx')::uuid, array[current_setting('r.v3')::uuid])$$, '22023', null, 'a draft refuses a quarantined package');

-- ---------------------------------------------------------------------------------------------
-- Decisión: sólo con permiso, con motivo y cumpliendo las condiciones
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$select public.decide_distribution_return(current_setting('r.ret_v3')::uuid, 'APPROVE', 'Aprobado por error')$$, '42501', null, 'a user who can write but not authorize re-entry cannot approve');
select throws_ok($$select public.start_return_inspection(current_setting('r.ret_v3')::uuid)$$, '42501', null, 'nor start an inspection');
select is((public.list_distribution_returns('OPEN') ->> 'total')::integer, 2, 'but can read the pending returns');
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select throws_ok($$select public.decide_distribution_return(current_setting('r.ret_v3')::uuid, 'APPROVE', '')$$, '22023', null, 'a decision needs a reason');
select throws_ok($$select public.decide_distribution_return(current_setting('r.ret_v3')::uuid, 'MAYBE', 'no sé')$$, '22023', null, 'and a known decision');
select throws_ok($$select public.decide_distribution_return(current_setting('r.ret_a1')::uuid, 'APPROVE', 'Parece estar bien')$$, '22023', null, 'a package that lost its vacuum cannot be re-entered');
select throws_ok($$select public.t_ret_force_approve(current_setting('r.ret_a1')::uuid)$$, '23514', null, 'the table itself refuses an approval with damaged packaging (even from a direct update)');
select is((public.start_return_inspection(current_setting('r.ret_v3')::uuid) ->> 'status'), 'PENDING_INSPECTION', 'the inspection is started');
select is((public.start_return_inspection(current_setting('r.ret_v3')::uuid) ->> 'alreadyStarted'), 'true', 'starting it again is idempotent');
select is(public.decide_distribution_return(current_setting('r.ret_v3')::uuid, 'APPROVE', 'Inspección sanitaria conforme: envase intacto, cadena de frío verificada') ->> 'status', 'APPROVED', 'an intact, verified, unexpired package is approved for re-entry');
select is(public.t_ret_state(current_setting('r.v3')::uuid), 'AVAILABLE', 'and only then is AVAILABLE again');
select is((select current_branch_id from public.vacuum_package_state where package_id = current_setting('r.v3')::uuid), 'b3000000-0000-4000-8000-000000000001'::uuid, 'in the branch it left from');
select is((select decided_by from public.distribution_returns where id = current_setting('r.ret_v3')::uuid), 'b1000000-0000-4000-8000-000000000001'::uuid, 'the approval records who approved');
select is((select decision_reason from public.distribution_returns where id = current_setting('r.ret_v3')::uuid), 'Inspección sanitaria conforme: envase intacto, cadena de frío verificada', 'and why');
select is((select decided_at is not null from public.distribution_returns where id = current_setting('r.ret_v3')::uuid), true, 'and when');
select is(public.t_ret_count('select quantity_grams from public.stock_movements where type = ''DISTRIBUTION_RETURN'''), 300::bigint, 'the re-entry returns the real grams to the ledger');
select is(public.decide_distribution_return(current_setting('r.ret_v3')::uuid, 'APPROVE', 'Aprobado de nuevo') ->> 'alreadyDecided', 'true', 'approving again is idempotent');
select is(public.t_ret_count('select count(*) from public.stock_movements where type = ''DISTRIBUTION_RETURN'''), 1::bigint, 'and never duplicates the stock movement');
select is(public.get_vacuum_package(current_setting('r.v3')::uuid) ->> 'expiresOn', current_setting('r.v3_expires'), 'the original expiry date is untouched');
select is((public.list_distributable_packages('b3000000-0000-4000-8000-000000000001') ->> 'total')::integer, 1, 'the re-entered package can be distributed again');
select is(jsonb_array_length(public.get_pos_vacuum_state('b3000000-0000-4000-8000-000000000001') -> 'packages'), 1, 'and sold at the POS');
select throws_ok($$select public.decide_distribution_return(current_setting('r.ret_v3')::uuid, 'DISCARD', 'Ya no')$$, '22023', null, 'an approved return cannot be discarded afterwards');

select is(public.decide_distribution_return(current_setting('r.ret_a1')::uuid, 'DISCARD', 'Envase sin vacío: se descarta') ->> 'status', 'DISCARDED', 'a package that lost its vacuum is discarded');
select is(public.t_ret_state(current_setting('r.a1')::uuid), 'DISCARDED', 'its package is DISCARDED');
select is(public.t_ret_count('select count(*) from public.stock_movements where type = ''DISTRIBUTION_RETURN'''), 1::bigint, 'discarding moves no stock (it left when it was dispatched)');
select throws_ok($$select public.decide_distribution_return(current_setting('r.ret_a1')::uuid, 'APPROVE', 'Me arrepentí')$$, '22023', null, 'a discarded package can never be approved');

-- Venta mayorista firme devuelta: pendiente de nota de crédito; rechazo y descarte; verificación de conservación.
select lives_ok($$select public.register_distribution_returns(current_setting('r.d2')::uuid, jsonb_build_array(
  jsonb_build_object('packageId', current_setting('r.w1'), 'reason', 'CLIENT_REQUEST'), jsonb_build_object('packageId', current_setting('r.w2'), 'reason', 'NEAR_EXPIRY')))$$, 'two firm-sale packages are returned');
select is(public.t_ret_count('select count(*) from public.distribution_returns where credit_required'), 2::bigint, 'a firm sale returned is flagged as pending a credit note (no billing here)');
select lives_ok($$select public.receive_distribution_returns(jsonb_build_array(
  jsonb_build_object('returnId', (select id from public.distribution_returns where package_id = current_setting('r.w1')::uuid), 'packagingState', 'INTACT', 'conservationVerified', true),
  jsonb_build_object('returnId', (select id from public.distribution_returns where package_id = current_setting('r.w2')::uuid), 'packagingState', 'INTACT', 'conservationVerified', false, 'conservationNote', 'Sin registro de temperatura')))$$, 'they are received (one without a verifiable cold chain)');
select throws_ok($$select public.decide_distribution_return((select id from public.distribution_returns where package_id = current_setting('r.w2')::uuid), 'APPROVE', 'Se ve bien')$$, '22023', null, 'without verified conservation a package cannot be re-entered');
select is(public.decide_distribution_return((select id from public.distribution_returns where package_id = current_setting('r.w2')::uuid), 'REJECT', 'No hay forma de verificar la cadena de frío') ->> 'status', 'REJECTED', 'it is rejected');
select is(public.t_ret_state(current_setting('r.w2')::uuid), 'QUARANTINE', 'a rejected package stays in quarantine until it is discarded');
select is(public.decide_distribution_return((select id from public.distribution_returns where package_id = current_setting('r.w2')::uuid), 'DISCARD', 'Se descarta tras el rechazo') ->> 'status', 'DISCARDED', 'and then it can be discarded');
select is(public.decide_distribution_return((select id from public.distribution_returns where package_id = current_setting('r.w1')::uuid), 'APPROVE', 'Conforme, cadena de frío verificada', 'INTACT', true) ->> 'status', 'APPROVED', 'the verified one is approved directly from quarantine');
select is(public.t_ret_count('select coalesce(sum(quantity_grams), 0) from public.stock_movements where type = ''DISTRIBUTION_RETURN'''), 1100::bigint, 'the ledger got back 0,300 + 0,800 kg');

-- Control de vencimientos
select lives_ok($$select public.register_distribution_returns(current_setting('r.d0')::uuid, jsonb_build_array(jsonb_build_object('packageId', current_setting('r.e1'), 'reason', 'NEAR_EXPIRY')), current_setting('test.today')::date - 2)$$, 'the package that expired is returned');
select lives_ok($$select public.receive_distribution_returns(jsonb_build_array(jsonb_build_object('returnId', (select id from public.distribution_returns where package_id = current_setting('r.e1')::uuid), 'packagingState', 'INTACT', 'conservationVerified', true)))$$, 'and received with intact packaging');
select throws_ok($$select public.decide_distribution_return((select id from public.distribution_returns where package_id = current_setting('r.e1')::uuid), 'APPROVE', 'Está bien')$$, '22023', null, 'an expired package can never be re-entered');
select is((select (e ->> 'expired')::boolean from jsonb_array_elements(public.list_distribution_returns('OPEN') -> 'rows') e where (e ->> 'packageId') = current_setting('r.e1')), true, 'the returns list flags it as expired');
select lives_ok($$select public.decide_distribution_return((select id from public.distribution_returns where package_id = current_setting('r.e1')::uuid), 'DISCARD', 'Vencido')$$, 'it is discarded');

-- Integridad del inventario
select is(public.t_ret_count('select count(*) from public.vacuum_package_state s join public.distribution_delivery_items i on i.package_id = s.package_id and i.closed_at is null where s.status = ''AVAILABLE'''), 0::bigint, 'no AVAILABLE package is also open in a delivery (never in two places)');
select is(public.t_ret_count('select count(*) from public.vacuum_packages p where (select count(*) from public.vacuum_package_state s where s.package_id = p.id) <> 1'), 0::bigint, 'every package has exactly one state');
select is(public.t_ret_count('select coalesce(sum(quantity_grams), 0) from public.stock_movements where product_id = ''b6000000-0000-4000-8000-000000000001'''), -1900::bigint, 'the Vacío ledger nets out: out 1,550 + 1,100 + 0,350 minus the 1,100 re-entered');
select is(public.t_ret_count('select count(*) from public.stock_movements where distribution_delivery_id is not null and type <> ''DISTRIBUTION_OUT'''), 0::bigint, 'only dispatches carry a delivery link');
select is(public.t_ret_count('select count(*) from public.vacuum_package_state where status = ''DISPATCHED'' and distribution_delivery_id is null'), 0::bigint, 'every dispatched package points to its delivery');

-- ---------------------------------------------------------------------------------------------
-- Estadísticas: confirmado vs estimado
-- ---------------------------------------------------------------------------------------------
select is((public.get_distribution_stats() -> 'delivered' ->> 'packages')::integer, 9, 'the panel counts every package delivered in confirmed deliveries');
select is((public.get_distribution_stats() ->> 'activeClients')::integer, 2, 'with the active supermarkets');
select is((public.get_distribution_stats() -> 'confirmed' ->> 'packages')::integer, 3, 'confirmed sales: 2 identified + 1 firm');
select is((public.get_distribution_stats() -> 'confirmed' ->> 'cents'), '2025000', 'valued at the commercial price of those packages');
select is((public.get_distribution_stats() -> 'estimated' ->> 'packages')::integer, 1, 'estimated sales are kept apart: the quantity-only one');
select is((public.get_distribution_stats() -> 'estimated' ->> 'cents'), '500000', 'and valued as an estimate');
select is((public.get_distribution_stats() -> 'returned' ->> 'packages')::integer, 5, 'returned packages');
select is((public.get_distribution_stats() -> 'pending' ->> 'packages')::integer, 0, 'and nothing is left pending');
select is((select (e ->> 'rotationConfirmedPct')::numeric from jsonb_array_elements(public.get_distribution_stats() -> 'products') e where e ->> 'productName' = 'Vacío'), 42.9, 'rotation uses confirmed sales only: 3 of 7 Vacío packages');
select is((select (e ->> 'rotationWithEstimatePct')::numeric from jsonb_array_elements(public.get_distribution_stats() -> 'products') e where e ->> 'productName' = 'Asado'), 50.0, 'and a second figure includes the estimate: 1 of 2 Asado');
select is((select (e ->> 'returnPct')::numeric from jsonb_array_elements(public.get_distribution_stats() -> 'products') e where e ->> 'productName' = 'Asado'), 50.0, 'the return percentage per cut');
select is((public.get_distribution_stats(null, null, null, null, 'b6000000-0000-4000-8000-000000000002') -> 'delivered' ->> 'packages')::integer, 2, 'it filters by product');
select is((public.get_distribution_stats(null, null, null, null, null, 'b5000000-0000-4000-8000-000000000002') -> 'delivered' ->> 'packages')::integer, 2, 'by category');
select is((public.get_distribution_stats(null, null, current_setting('r.client2')::uuid) -> 'delivered' ->> 'packages')::integer, 3, 'by supermarket');
select is((public.get_distribution_stats(null, null, null, current_setting('r.site1')::uuid) -> 'delivered' ->> 'packages')::integer, 6, 'by establishment');
select is((public.get_distribution_stats(current_setting('test.today')::date + 1, current_setting('test.today')::date + 5) -> 'delivered' ->> 'packages')::integer, 0, 'and by date');
select is(jsonb_array_length(public.get_site_replenishment_history(current_setting('r.site1')::uuid)), 2, 'the replenishment history lists the confirmed deliveries of an establishment');
select is((public.get_site_replenishment_history(current_setting('r.site1')::uuid) -> 0 ->> 'soldConfirmed')::integer, 2, 'with their result');

-- ---------------------------------------------------------------------------------------------
-- Permisos y aislamiento entre organizaciones
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.register_distribution_returns(current_setting('r.d1')::uuid, '[]'::jsonb)$$, '42501', null, 'an employee without permissions cannot register returns');
select throws_ok($$select public.get_distribution_stats()$$, '42501', null, 'nor read the statistics');
select throws_ok($$select public.decide_distribution_return(current_setting('r.ret_v3')::uuid, 'DISCARD', 'Intruso')$$, '42501', null, 'nor decide on a return');

select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(public.get_delivery_reconciliation(current_setting('r.d1')::uuid), null::jsonb, 'another organization cannot read a reconciliation');
select throws_ok($$select public.report_delivery_sales(current_setting('r.d1')::uuid, array[current_setting('r.a2')::uuid])$$, '42501', null, 'cannot report sales on it');
select throws_ok($$select public.report_delivery_quantity_sales(current_setting('r.d1')::uuid, jsonb_build_array(jsonb_build_object('productId', 'b6000000-0000-4000-8000-000000000002', 'quantity', 1)))$$, '42501', null, 'cannot report quantities');
select throws_ok($$select public.register_distribution_returns(current_setting('r.d1')::uuid, jsonb_build_array(jsonb_build_object('packageId', current_setting('r.a2'), 'reason', 'UNSOLD')))$$, '42501', null, 'cannot register returns');
select throws_ok($$select public.receive_distribution_returns(jsonb_build_array(jsonb_build_object('returnId', current_setting('r.ret_v3'), 'packagingState', 'INTACT', 'conservationVerified', true)))$$, '42501', null, 'cannot receive them');
select throws_ok($$select public.decide_distribution_return(current_setting('r.ret_v3')::uuid, 'DISCARD', 'Intruso')$$, '42501', null, 'cannot decide on them');
select is((public.list_distribution_returns() ->> 'total')::integer, 0, 'sees no returns');
select is((public.get_distribution_stats() -> 'delivered' ->> 'packages')::integer, 0, 'and empty statistics');
select is((select count(*) from public.distribution_returns), 0::bigint, 'RLS hides the return rows');
select is((select count(*) from public.distribution_quantity_reports), 0::bigint, 'and the quantity reports');

select * from finish();
rollback;
