begin;

create extension if not exists pgtap with schema extensions;
select plan(124);

-- Cubre 202611120097 (Distribución a supermercados, parte 1): supermercados y establecimientos, identificador logístico, entregas (borrador, reserva, confirmación
-- transaccional e idempotente), inventario (un movimiento DISTRIBUTION_OUT por producto y entrega, estado único del paquete), compatibilidad con la venta del POS
-- y aislamiento entre organizaciones. Fixture: la organización A (administrador y un empleado) con Central y una sucursal, y la organización B (ajena).

select ok(not has_function_privilege('anon', 'public.confirm_distribution_delivery(uuid)', 'EXECUTE'), 'anonymous cannot confirm a delivery');
select ok(not has_function_privilege('anon', 'public.save_distribution_client(uuid,text,text,text,text,text,boolean)', 'EXECUTE'), 'anonymous cannot save a client');
select ok(not has_function_privilege('authenticated', 'app_private.dist_reserve_package(uuid,public.distribution_deliveries,uuid)', 'EXECUTE'), 'the reservation helper is private');
select ok(not has_table_privilege('authenticated', 'public.distribution_deliveries', 'INSERT'), 'deliveries have no direct INSERT grant');
select ok(not has_table_privilege('authenticated', 'public.distribution_delivery_items', 'UPDATE'), 'delivery items have no direct UPDATE grant');
select ok(not has_table_privilege('authenticated', 'public.vacuum_package_logistics', 'INSERT'), 'logistic codes cannot be written directly');
select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.distribution_clients'::regclass, 'public.distribution_sites'::regclass, 'public.distribution_deliveries'::regclass,
  'public.distribution_delivery_items'::regclass, 'public.vacuum_package_logistics'::regclass)), 'the new tables have RLS enabled');

-- Funciones puras
select ok(app_private.cuit_is_valid('20-12345678-6'), 'a valid CUIT is accepted (with hyphens)');
select ok(not app_private.cuit_is_valid('20-12345678-5'), 'a CUIT with a wrong check digit is refused');
select ok(not app_private.cuit_is_valid('123'), 'a short CUIT is refused');
select is(app_private.logistic_code_normalize(' 7k3m-9qx4 a'), '7K3M9QX4A', 'a logistic code is normalized (case, spaces, hyphens)');
select is(app_private.logistic_code_normalize('OIL0'), '0110', 'and look-alike characters are mapped (O→0, I/L→1)');
select is(app_private.logistic_code_check_char('7K3M9QX4'), 'S', 'the check character of the shared test vector (the Admin computes the same one)');
select ok(app_private.logistic_code_is_valid('7K3M9QX4' || app_private.logistic_code_check_char('7K3M9QX4')), 'a code with its check character is valid');
select ok(not app_private.logistic_code_is_valid('8K3M9QX4' || app_private.logistic_code_check_char('7K3M9QX4')), 'a mistyped character breaks the check');
select ok(not app_private.logistic_code_is_valid('K73M9QX4' || app_private.logistic_code_check_char('7K3M9QX4')), 'and so does swapping two characters');
select ok(app_private.logistic_code_is_valid(app_private.logistic_code_generate()), 'a generated code is valid');

select set_config('d.fake', '7K3M9QX4' || app_private.logistic_code_check_char('7K3M9QX4'), true);

-- Fixture
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'dst-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"DST Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'dst-other@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"DST Other"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'dst-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"DST Employee"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug, timezone) values
  ('a2000000-0000-4000-8000-000000000001', 'DST Org', 'dst-org', 'America/Argentina/Buenos_Aires'),
  ('a2000000-0000-4000-8000-000000000002', 'DST Org B', 'dst-org-b', 'America/Argentina/Buenos_Aires');
insert into public.branches (id, organization_id, name, code) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Central', 'CEN'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'Sucursal Dos', 'DOS'),
  ('a3000000-0000-4000-8000-000000000009', 'a2000000-0000-4000-8000-000000000002', 'Central B', 'CEB');
update public.organizations set production_branch_id = 'a3000000-0000-4000-8000-000000000001' where id = 'a2000000-0000-4000-8000-000000000001';
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Cortes', 'cortes');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('a6000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'Vacío', 'vacio', 'VAC', 'WEIGHT'),
  ('a6000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'Asado', 'asado', 'ASA', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id;
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', null, 1500000, now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000002', null, 1000000, now() - interval '1 day');

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
    'profileId', 'a1000000-0000-4000-8000-000000000001', 'deviceId', p_device, 'status', 'COMPLETED',
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
create function public.t_dst_count(p_sql text) returns bigint language plpgsql security definer set search_path = '' as $$
declare n bigint; begin execute p_sql into n; return n; end; $$;
create function public.t_dst_state(p_package uuid) returns text language sql security definer set search_path = '' as $$
  select s.status from public.vacuum_package_state s where s.package_id = p_package $$;
create function public.t_dst_set_state(p_package uuid, p_status text) returns void language sql security definer set search_path = '' as $$
  update public.vacuum_package_state set status = p_status, distribution_delivery_id = null where package_id = p_package $$;
create function public.t_dst_dup_movement(p_delivery uuid, p_product uuid) returns void language sql security definer set search_path = '' as $$
  insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, profile_id, distribution_delivery_id)
  select d.organization_id, d.origin_branch_id, p_product, 'DISTRIBUTION_OUT', -1, 'a1000000-0000-4000-8000-000000000001', d.id from public.distribution_deliveries d where d.id = p_delivery $$;
create function public.t_dst_dup_item(p_delivery uuid, p_package uuid) returns void language sql security definer set search_path = '' as $$
  insert into public.distribution_delivery_items (organization_id, delivery_id, package_id, weight_grams, unit_cents)
  select d.organization_id, d.id, p_package, 100, 100 from public.distribution_deliveries d where d.id = p_delivery $$;
grant execute on function public.t_pkg_payload(uuid, uuid, uuid, uuid, uuid, text, integer, bigint), public.t_dst_count(text), public.t_dst_state(uuid), public.t_dst_set_state(uuid, text),
  public.t_dst_dup_movement(uuid, uuid), public.t_dst_dup_item(uuid, uuid) to authenticated;

select set_config('test.today', ((clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date)::text, true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$select public.register_pos_device('a7000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'POS Central')$$, 'the Central device registers');
select lives_ok($$select public.save_vacuum_ean_scheme('PRICE_EMBEDDED', '20', 4, 6, 100)$$, 'the EAN scheme is configured');
select lives_ok($$select public.save_vacuum_product_config('a6000000-0000-4000-8000-000000000001', true, 7, '12', null)$$, 'Vacío is enabled');
select lives_ok($$select public.save_vacuum_product_config('a6000000-0000-4000-8000-000000000002', true, 7, '13', null)$$, 'Asado is enabled');

-- Paquetes: tres de Vacío con pesos distintos, uno de Asado y uno de Vacío que vence en 2 días.
select set_config('d.p1', (public.create_vacuum_package('a3000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 750, current_setting('test.today')::date, null, null, 'a8000000-0000-4000-8000-000000000001') ->> 'id'), true);
select set_config('d.p2', (public.create_vacuum_package('a3000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 1250, current_setting('test.today')::date, null, null, 'a8000000-0000-4000-8000-000000000002') ->> 'id'), true);
select set_config('d.p3', (public.create_vacuum_package('a3000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 500, current_setting('test.today')::date, null, null, 'a8000000-0000-4000-8000-000000000003') ->> 'id'), true);
select set_config('d.p4', (public.create_vacuum_package('a3000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000002', 600, current_setting('test.today')::date, null, null, 'a8000000-0000-4000-8000-000000000004') ->> 'id'), true);
select set_config('d.p5', (public.create_vacuum_package('a3000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 400, current_setting('test.today')::date, (current_setting('test.today')::date + 2), null, 'a8000000-0000-4000-8000-000000000005') ->> 'id'), true);

-- ---------------------------------------------------------------------------------------------
-- Identificación individual de los paquetes
-- ---------------------------------------------------------------------------------------------
select is(public.t_dst_count('select count(*) from public.vacuum_package_logistics'), 5::bigint, 'every new package got a logistic code');
select is(public.t_dst_count('select count(distinct code) from public.vacuum_package_logistics'), 5::bigint, 'and they are all different');
select is(public.t_dst_count('select count(*) from public.vacuum_package_logistics where app_private.logistic_code_is_valid(code)'), 5::bigint, 'and valid (with their check character)');
select is((public.get_vacuum_package(current_setting('d.p1')::uuid) ->> 'logisticCode') = (select code from public.vacuum_package_logistics where package_id = current_setting('d.p1')::uuid), true, 'the package JSON carries its logistic code');
select is(public.get_vacuum_package(current_setting('d.p1')::uuid) ->> 'ean13', '2000120112506', 'the commercial EAN-13 is untouched (same code as always)');
select set_config('d.c1', (select code from public.vacuum_package_logistics where package_id = current_setting('d.p1')::uuid), true);
select is(public.find_vacuum_package_by_code(lower(substr(current_setting('d.c1'), 1, 4) || '-' || substr(current_setting('d.c1'), 5))) ->> 'id', current_setting('d.p1'), 'a package is found by its code (lowercase, with a hyphen)');
select is(public.find_vacuum_package_by_code(current_setting('d.p2')) ->> 'id', current_setting('d.p2'), 'or by its UUID');
select throws_ok($$select public.find_vacuum_package_by_code('ABC')$$, '22023', null, 'a malformed code is refused');
select is(public.find_vacuum_package_by_code(current_setting('d.fake')), null::jsonb, 'a well-formed code that does not exist finds nothing');

-- ---------------------------------------------------------------------------------------------
-- Supermercados
-- ---------------------------------------------------------------------------------------------
select set_config('d.client1', (public.save_distribution_client(null, 'Supermercado Sol', 'Sol S.A.', '20-12345678-6', 'CONSIGNMENT', 'Cliente de prueba') ->> 'id'), true);
select is((select tax_id from public.distribution_clients where id = current_setting('d.client1')::uuid), '20123456786', 'the CUIT is stored without hyphens');
select throws_ok($$select public.save_distribution_client(null, 'Otro', null, '20-12345678-5', 'CONSIGNMENT')$$, '22023', null, 'an invalid CUIT is refused');
select throws_ok($$select public.save_distribution_client(null, '  supermercado   sol ', null, null, 'CONSIGNMENT')$$, '23505', null, 'a client name cannot repeat');
select throws_ok($$select public.save_distribution_client(null, 'Distinto', null, '20123456786', 'CONSIGNMENT')$$, '23505', null, 'nor can a CUIT');
select throws_ok($$select public.save_distribution_client(null, 'Sin modalidad', null, null, 'OTRA')$$, '22023', null, 'the commercial mode must be known');
select lives_ok($$select public.save_distribution_client(current_setting('d.client1')::uuid, 'Supermercado Sol', 'Sol S.A.', '20-12345678-6', 'CONSIGNMENT', 'Notas nuevas')$$, 'a client can be updated');
select set_config('d.client2', (public.save_distribution_client(null, 'Mayorista Norte', null, null, 'WHOLESALE') ->> 'id'), true);
select set_config('d.site1', (public.save_distribution_site(null, current_setting('d.client1')::uuid, 'Sol Centro', 'Av. 1 123', 'La Plata', '221 555', 'Marta', null, 1) ->> 'id'), true);
select set_config('d.site1b', (public.save_distribution_site(null, current_setting('d.client1')::uuid, 'Sol Norte', null, 'City Bell', null, null, null, 4) ->> 'id'), true);
select set_config('d.site2', (public.save_distribution_site(null, current_setting('d.client2')::uuid, 'Norte Depósito') ->> 'id'), true);
select throws_ok($$select public.save_distribution_site(null, current_setting('d.client1')::uuid, 'sol  centro')$$, '23505', null, 'a client cannot have two establishments with the same name');
select throws_ok($$select public.save_distribution_site(null, current_setting('d.client1')::uuid, 'Sol Sur', null, null, null, null, null, 8)$$, '22023', null, 'the restock weekday goes from 1 to 7');
select lives_ok($$select public.save_distribution_site(null, current_setting('d.client2')::uuid, 'Norte Otro', null, null, null, null, null, null, 'CONSIGNMENT')$$, 'an establishment can override the client mode');
select is((select jsonb_array_length(c -> 'sites') from jsonb_array_elements(public.list_distribution_clients()) c where c ->> 'tradeName' = 'Supermercado Sol'), 2, 'the client list nests its establishments (Sol has two)');
select is((select e ->> 'effectiveMode' from jsonb_array_elements(public.list_distribution_clients()) c, jsonb_array_elements(c -> 'sites') e where e ->> 'name' = 'Norte Otro'), 'CONSIGNMENT', 'and shows the effective commercial mode');
select lives_ok($$select public.save_distribution_site(null, current_setting('d.client2')::uuid, 'Norte Inactivo', null, null, null, null, null, null, null, false)$$, 'an inactive establishment can be created');

-- ---------------------------------------------------------------------------------------------
-- Entrega en borrador: reserva de paquetes
-- ---------------------------------------------------------------------------------------------
select set_config('d.d1', (public.create_distribution_delivery(current_setting('d.site1')::uuid, current_setting('test.today')::date, 'a9000000-0000-4000-8000-000000000001', null, 'Primera tanda') ->> 'id'), true);
select is((select status from public.distribution_deliveries where id = current_setting('d.d1')::uuid), 'DRAFT', 'a new delivery is a draft');
select is((select number from public.distribution_deliveries where id = current_setting('d.d1')::uuid), 1::bigint, 'with the first delivery number');
select is((select commercial_mode from public.distribution_deliveries where id = current_setting('d.d1')::uuid), 'CONSIGNMENT', 'and the mode of the establishment (snapshot)');
select is(public.create_distribution_delivery(current_setting('d.site1')::uuid, current_setting('test.today')::date, 'a9000000-0000-4000-8000-000000000001') ->> 'id', current_setting('d.d1'), 'creating again with the same request key returns the same draft');
select is(public.t_dst_count('select count(*) from public.distribution_deliveries'), 1::bigint, 'and never a second one');
select throws_ok($$select public.create_distribution_delivery(current_setting('d.site1')::uuid, (current_setting('test.today')::date + 200))$$, '22023', null, 'a far-away delivery date is refused');
select throws_ok($$select public.create_distribution_delivery((select id from public.distribution_sites where name = 'Norte Inactivo'), current_setting('test.today')::date)$$, '22023', null, 'an inactive establishment cannot receive deliveries');

select is(jsonb_array_length(public.get_pos_vacuum_state('a3000000-0000-4000-8000-000000000001') -> 'packages'), 5, 'before reserving, the Central POS can sell the 5 packages');
select is((public.add_delivery_packages(current_setting('d.d1')::uuid, array[current_setting('d.p1')::uuid, current_setting('d.p4')::uuid]) ->> 'added')::integer, 2, 'two packages are added to the draft');
select is(public.t_dst_state(current_setting('d.p1')::uuid), 'RESERVED', 'and become RESERVED');
select is(jsonb_array_length(public.get_pos_vacuum_state('a3000000-0000-4000-8000-000000000001') -> 'packages'), 3, 'a reserved package leaves the POS state');
select is((public.add_delivery_packages(current_setting('d.d1')::uuid, array[current_setting('d.p1')::uuid]) ->> 'added')::integer, 0, 'adding the same package again to the same draft is a no-op');
select set_config('d.d2', (public.create_distribution_delivery(current_setting('d.site1b')::uuid, current_setting('test.today')::date) ->> 'id'), true);
select throws_ok($$select public.add_delivery_packages(current_setting('d.d2')::uuid, array[current_setting('d.p1')::uuid])$$, '22023', null, 'a package reserved by one delivery cannot enter another');
select throws_ok($$select public.t_dst_dup_item(current_setting('d.d2')::uuid, current_setting('d.p1')::uuid)$$, '23505', null, 'not even by writing the row directly: the database refuses a package in two open deliveries');
select is((public.add_delivery_package_by_code(current_setting('d.d1')::uuid, (select code from public.vacuum_package_logistics where package_id = current_setting('d.p2')::uuid)) ->> 'added')::boolean, true, 'a package is added by scanning its logistic code');
select lives_ok($$select public.remove_delivery_packages(current_setting('d.d1')::uuid, array[current_setting('d.p2')::uuid])$$, 'a package can be taken out of the draft');
select is(public.t_dst_state(current_setting('d.p2')::uuid), 'AVAILABLE', 'and is AVAILABLE again');
select is(public.t_dst_count('select count(*) from public.distribution_delivery_items where package_id = ''' || current_setting('d.p2') || ''''), 0::bigint, 'with no item left behind');
select is((public.add_delivery_packages_by_quantity(current_setting('d.d1')::uuid, jsonb_build_array(jsonb_build_object('productId', 'a6000000-0000-4000-8000-000000000001', 'quantity', 1))) ->> 'added')::integer, 1, 'adding by quantity takes the package that expires first (FEFO)');
select is(public.t_dst_state(current_setting('d.p5')::uuid), 'RESERVED', 'the one expiring in 2 days');

-- Vencimientos: contra la fecha de ENTREGA
select set_config('d.d3', (public.create_distribution_delivery(current_setting('d.site1b')::uuid, (current_setting('test.today')::date + 5)) ->> 'id'), true);
select throws_ok($$select public.add_delivery_packages(current_setting('d.d3')::uuid, array[current_setting('d.p5')::uuid])$$, '22023', null, 'a package that expires before the delivery date is refused');
select is((public.add_delivery_packages_by_quantity(current_setting('d.d3')::uuid, jsonb_build_array(jsonb_build_object('productId', 'a6000000-0000-4000-8000-000000000001', 'quantity', 10))) -> 'missing' -> 0 ->> 'added')::integer, 2, 'by quantity it adds what is available and not expired (p2 and p3)');
select is((public.add_delivery_packages_by_quantity(current_setting('d.d3')::uuid, jsonb_build_array(jsonb_build_object('productId', 'a6000000-0000-4000-8000-000000000001', 'quantity', 10))) -> 'missing' -> 0 ->> 'requested')::integer, 10, 'and reports what was requested (a shortfall is not an error)');
select throws_ok($$select public.confirm_distribution_delivery(current_setting('d.d2')::uuid)$$, '22023', null, 'an empty delivery cannot be confirmed');
select lives_ok($$select public.cancel_distribution_delivery(current_setting('d.d3')::uuid, 'Cambio de planes')$$, 'a draft is cancelled');
select is(public.t_dst_state(current_setting('d.p2')::uuid), 'AVAILABLE', 'and its packages are released');
select is(public.t_dst_count('select count(*) from public.distribution_delivery_items where delivery_id = ''' || current_setting('d.d3') || ''''), 0::bigint, 'with no items left');
select is(public.cancel_distribution_delivery(current_setting('d.d3')::uuid) ->> 'status', 'CANCELLED', 'cancelling again is idempotent');
select throws_ok($$select public.confirm_distribution_delivery(current_setting('d.d3')::uuid)$$, '22023', null, 'a cancelled delivery cannot be confirmed');

-- ---------------------------------------------------------------------------------------------
-- Confirmación: movimiento físico, estado y stock
-- ---------------------------------------------------------------------------------------------
select is(public.t_dst_count('select count(*) from public.stock_movements where type = ''DISTRIBUTION_OUT'''), 0::bigint, 'nothing moves the stock while the delivery is a draft');
select set_config('d.confirm1', public.confirm_distribution_delivery(current_setting('d.d1')::uuid)::text, true);
select is(current_setting('d.confirm1')::jsonb ->> 'status', 'CONFIRMED', 'the delivery is confirmed');
select is((current_setting('d.confirm1')::jsonb ->> 'packageCount')::integer, 3, 'with its 3 packages');
select is(current_setting('d.confirm1')::jsonb ->> 'totalGrams', '1750', 'their real weight (0,750 + 0,600 + 0,400 kg)');
select is(current_setting('d.confirm1')::jsonb ->> 'totalCents', '2325000', 'and their commercial value');
select is(current_setting('d.confirm1')::jsonb -> 'recipient' ->> 'siteName', 'Sol Centro', 'the recipient data is frozen for the delivery note');
select is(public.t_dst_state(current_setting('d.p1')::uuid), 'DISPATCHED', 'the packages are DISPATCHED');
select is(public.t_dst_count('select count(*) from public.vacuum_package_state where status = ''DISPATCHED'' and distribution_delivery_id = ''' || current_setting('d.d1') || ''''), 3::bigint, 'all of them, linked to the delivery');
select is(public.t_dst_count('select count(*) from public.distribution_delivery_items where delivery_id = ''' || current_setting('d.d1') || ''' and outcome = ''PENDING'''), 3::bigint, 'in consignment, dispatching is not selling: the outcome is PENDING');
select is(public.t_dst_count('select count(*) from public.stock_movements where type = ''DISTRIBUTION_OUT'''), 2::bigint, 'the stock ledger got one movement per product');
select is(public.t_dst_count('select quantity_grams from public.stock_movements where type = ''DISTRIBUTION_OUT'' and product_id = ''a6000000-0000-4000-8000-000000000001'''), -1150::bigint, 'with the real grams of the Vacío packages (-0,750 - 0,400)');
select is(public.t_dst_count('select quantity_grams from public.stock_movements where type = ''DISTRIBUTION_OUT'' and product_id = ''a6000000-0000-4000-8000-000000000002'''), -600::bigint, 'and of the Asado');
select is(jsonb_array_length(current_setting('d.confirm1')::jsonb -> 'stockShortfalls'), 2, 'a negative stock is reported (not blocked)');
select is(public.t_dst_count('select count(*) from public.vacuum_package_events where kind = ''DISPATCHED'''), 3::bigint, 'every dispatch is in the package history');
select is(jsonb_array_length(public.get_pos_vacuum_state('a3000000-0000-4000-8000-000000000001') -> 'packages'), 2, 'dispatched packages are not offered to the POS (p2 and p3 remain)');

-- Idempotencia
select is(public.confirm_distribution_delivery(current_setting('d.d1')::uuid) ->> 'alreadyConfirmed', 'true', 'confirming again reports it was already confirmed');
select is(public.t_dst_count('select count(*) from public.stock_movements where type = ''DISTRIBUTION_OUT'''), 2::bigint, 'and does not move the stock again');
select is(public.t_dst_count('select count(*) from public.vacuum_package_events where kind = ''DISPATCHED'''), 3::bigint, 'nor repeat the history');
select throws_ok($$select public.t_dst_dup_movement(current_setting('d.d1')::uuid, 'a6000000-0000-4000-8000-000000000001')$$, '23505', null, 'the ledger itself refuses a second DISTRIBUTION_OUT for the same product and delivery');
select throws_ok($$select public.add_delivery_packages(current_setting('d.d1')::uuid, array[current_setting('d.p2')::uuid])$$, '22023', null, 'a confirmed delivery cannot be modified');
select throws_ok($$select public.cancel_distribution_delivery(current_setting('d.d1')::uuid, 'x')$$, '22023', null, 'nor cancelled: the goods already left');

-- Venta mayorista firme
select set_config('d.d4', (public.create_distribution_delivery(current_setting('d.site2')::uuid, current_setting('test.today')::date) ->> 'id'), true);
select is((public.add_delivery_packages(current_setting('d.d4')::uuid, array[current_setting('d.p2')::uuid, current_setting('d.p3')::uuid]) ->> 'added')::integer, 2, 'a second delivery takes the two remaining Vacío packages');
select lives_ok($$select public.confirm_distribution_delivery(current_setting('d.d4')::uuid)$$, 'and is confirmed');
select is(public.t_dst_count('select count(*) from public.distribution_delivery_items where delivery_id = ''' || current_setting('d.d4') || ''' and outcome = ''SOLD_FIRM'''), 2::bigint, 'in a firm wholesale sale the commercial operation happens at dispatch (SOLD_FIRM)');
select is(public.t_dst_count('select quantity_grams from public.stock_movements where type = ''DISTRIBUTION_OUT'' and distribution_delivery_id = ''' || current_setting('d.d4') || ''''), -1750::bigint, 'and the physical movement is the same kind of ledger row');
select is(public.t_dst_count('select count(*) from public.distribution_deliveries where number is not null'), 4::bigint, 'delivery numbers are consecutive per organization');

-- Revalidación al confirmar: si el estado de un paquete cambió por fuera, no se despacha
select set_config('d.d5', (public.create_distribution_delivery(current_setting('d.site1b')::uuid, current_setting('test.today')::date) ->> 'id'), true);
select set_config('d.p6', (public.create_vacuum_package('a3000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 300, current_setting('test.today')::date, null, null, 'a8000000-0000-4000-8000-000000000006') ->> 'id'), true);
select lives_ok($$select public.add_delivery_packages(current_setting('d.d5')::uuid, array[current_setting('d.p6')::uuid])$$, 'a new package is reserved');
select lives_ok($$select public.t_dst_set_state(current_setting('d.p6')::uuid, 'AVAILABLE')$$, 'its state is changed behind the delivery''s back');
select throws_ok($$select public.confirm_distribution_delivery(current_setting('d.d5')::uuid)$$, '22023', null, 'confirming then refuses to dispatch it');
select is(public.t_dst_count('select count(*) from public.stock_movements where distribution_delivery_id = ''' || current_setting('d.d5') || ''''), 0::bigint, 'and writes no stock movement (the confirmation is all-or-nothing)');
select is((select status from public.distribution_deliveries where id = current_setting('d.d5')::uuid), 'DRAFT', 'the delivery stays a draft');

-- Listados y referencia de reposición
select is((public.list_distribution_deliveries(current_setting('d.site1')::uuid) ->> 'total')::integer, 1, 'the delivery list filters by establishment');
select is((public.list_distribution_deliveries(null, null, 'CONFIRMED') ->> 'total')::integer, 2, 'and by status');
select is((public.list_distribution_deliveries(null, null, 'DRAFT') -> 'rows' -> 0 ->> 'numberLabel'), 'E-000005', 'the newest draft comes first with its number label');
select is(jsonb_array_length(public.get_site_reference_delivery(current_setting('d.site1')::uuid) -> 'products'), 2, 'the reference delivery of an establishment lists its products');
select is((select (e ->> 'quantity')::integer from jsonb_array_elements(public.get_site_reference_delivery(current_setting('d.site1')::uuid) -> 'products') e where e ->> 'productName' = 'Vacío'), 2, 'with their quantities');
select is(public.get_site_reference_delivery(current_setting('d.site1b')::uuid), null::jsonb, 'an establishment without confirmed deliveries has no reference');

-- ---------------------------------------------------------------------------------------------
-- Compatibilidad con el POS: una venta offline de un paquete despachado no se pierde
-- ---------------------------------------------------------------------------------------------
select set_config('d.sale1', public.t_pkg_payload('a4000000-0000-4000-8000-000000000001', 'a4100000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', current_setting('d.p1')::uuid)::text, true);
select lives_ok($$select public.sync_offline_sale('a7000000-0000-4000-8000-000000000001', 'a4100000-0000-4000-8000-000000000001', current_setting('d.sale1')::jsonb)$$, 'a POS sale of a dispatched package still syncs');
select is(public.t_dst_count('select count(*) from public.sales where id = ''a4000000-0000-4000-8000-000000000001'''), 1::bigint, 'the sale is registered (nothing is dropped)');
select is((select reason from public.vacuum_package_conflicts where sale_id = 'a4000000-0000-4000-8000-000000000001'), 'DISTRIBUTED', 'with a DISTRIBUTED conflict for the Admin to review');
select is(public.t_dst_state(current_setting('d.p1')::uuid), 'DISPATCHED', 'and the package stays dispatched (the POS cannot claim it)');

-- ---------------------------------------------------------------------------------------------
-- Permisos y aislamiento entre organizaciones
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.save_distribution_client(null, 'Intruso', null, null, 'CONSIGNMENT')$$, '42501', null, 'an employee without distribution.write cannot create clients');
select throws_ok($$select public.list_distribution_clients()$$, '42501', null, 'nor read the module');
select throws_ok($$select public.confirm_distribution_delivery(current_setting('d.d5')::uuid)$$, '42501', null, 'nor confirm deliveries');

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(public.get_distribution_delivery(current_setting('d.d1')::uuid), null::jsonb, 'another organization cannot read a delivery');
select throws_ok($$select public.confirm_distribution_delivery(current_setting('d.d5')::uuid)$$, '42501', null, 'cannot confirm it');
select throws_ok($$select public.add_delivery_packages(current_setting('d.d5')::uuid, array[current_setting('d.p1')::uuid])$$, '42501', null, 'cannot add packages to it');
select throws_ok($$select public.save_distribution_site(null, current_setting('d.client1')::uuid, 'Sitio ajeno')$$, '42501', null, 'cannot create an establishment under a client of another organization');
select is(jsonb_array_length(public.list_distribution_clients()), 0, 'sees none of the clients');
select is((public.list_distribution_deliveries() ->> 'total')::integer, 0, 'nor deliveries');
select is(public.find_vacuum_package_by_code(current_setting('d.c1')), null::jsonb, 'nor find a package by its logistic code');
select throws_ok($$select public.list_distributable_packages('a3000000-0000-4000-8000-000000000001')$$, null, null, 'nor list the packages of a branch that is not theirs');
select is((select count(*) from public.distribution_deliveries), 0::bigint, 'and RLS hides every delivery row');

select * from finish();
rollback;
