begin;

create extension if not exists pgtap with schema extensions;
select plan(31);

-- Cubre 202611170103 (Pollos → «Eliminar» producto): borrado físico de la configuración cuando no hay historia, eliminación lógica
-- (deleted_at + inactivo) cuando la hay, historia intacta, tablero sin eliminados, permisos, aislamiento por organización y restauración.

select ok(not has_function_privilege('anon', 'public.delete_poultry_product(uuid)', 'EXECUTE'), 'anonymous cannot delete poultry products');
select ok(has_function_privilege('authenticated', 'public.delete_poultry_product(uuid)', 'EXECUTE'), 'authenticated users reach the RPC (the permission is checked inside)');
select ok(not has_table_privilege('authenticated', 'public.poultry_products', 'DELETE'), 'poultry products have no direct DELETE grant');

-- ---------------------------------------------------------------------------------------------
-- Fixture: org A (admin + empleado sin permisos de Pollos) y org B (admin)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pdel-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PDel Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pdel-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PDel Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pdel-reader-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PDel Reader A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'pdel-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PDel Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'PDel Org A', 'pdel-org-a'),
  ('d2000000-0000-4000-8000-000000000002', 'PDel Org B', 'pdel-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Central A1', 'A1');
insert into public.roles (id, organization_id, key, name, is_system) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'pollos_lectura', 'Pollos lectura', false);
insert into public.role_permissions (role_id, permission_key) values ('d4000000-0000-4000-8000-000000000001', 'poultry.read');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd4000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.products (id, organization_id, name, slug, sku, unit_type, active) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Pollo entero x 20 kg', 'pollo-entero', 'POL-ENT', 'UNIT', true),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'Alitas x 15 kg', 'alitas', 'ALI', 'UNIT', true),
  ('d5000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'Menudos x 15 kg', 'menudos', 'MEN', 'UNIT', true),
  ('d5000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'Pechuga x 15 kg', 'pechuga', 'PEC', 'UNIT', true);

create function public.t_pdel_board_ids() returns text language sql security definer set search_path = '' as $$
  select coalesce(string_agg(p.name, ',' order by p.name), '') from public.poultry_products p
  where p.organization_id = 'd2000000-0000-4000-8000-000000000001' and p.id::text in (
    select e ->> 'id' from jsonb_array_elements(public.get_poultry_price_board() -> 'products') e)
$$;
create function public.t_pdel_row(p_id uuid) returns text language sql security definer set search_path = '' as $$
  select coalesce((select p.active::text || '/' || (p.deleted_at is not null)::text from public.poultry_products p where p.id = p_id), 'gone')
$$;
create function public.t_pdel_audits(p_id uuid) returns bigint language sql security definer set search_path = '' as $$
  select count(*) from public.audit_logs a where a.entity_id = p_id and a.event_type = 'POULTRY_PRODUCTS_DELETE' and a.before_data ->> 'product_id' is not null
$$;
create function public.t_pdel_history(p_id uuid) returns text language sql security definer set search_path = '' as $$
  select (select count(*) from public.poultry_product_costs c where c.product_id = p_id)::text || '/'
    || (select count(*) from public.poultry_price_list_prices x where x.product_id = p_id)::text || '/'
    || (select count(*) from public.poultry_order_items x where x.product_id = p_id)::text
$$;
grant execute on function public.t_pdel_board_ids(), public.t_pdel_row(uuid), public.t_pdel_audits(uuid), public.t_pdel_history(uuid) to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select set_config('test.p_entero', public.add_poultry_product('d5000000-0000-4000-8000-000000000001', 'UNIT')::text, true);
select set_config('test.p_alitas', public.add_poultry_product('d5000000-0000-4000-8000-000000000002', 'UNIT')::text, true);
select set_config('test.p_menudos', public.add_poultry_product('d5000000-0000-4000-8000-000000000003', 'UNIT')::text, true);
select set_config('test.p_pechuga', public.add_poultry_product('d5000000-0000-4000-8000-000000000004', 'UNIT')::text, true);
select set_config('test.list_gen', (select id::text from public.poultry_price_lists where organization_id = 'd2000000-0000-4000-8000-000000000001' and is_default), true);
select set_config('test.customer', public.save_poultry_customer('Rotisería Z')::text, true);

-- Historia: Pollo entero con costo, precio General y un pedido; Alitas sólo con precio General; Menudos y Pechuga sin nada.
select lives_ok(format($f$select public.set_poultry_product_cost(%L, 5000000)$f$, current_setting('test.p_entero')), 'a cost is recorded');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 6599900)$f$, current_setting('test.list_gen'), current_setting('test.p_entero')), 'a General price is recorded');
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 4199900)$f$, current_setting('test.list_gen'), current_setting('test.p_alitas')), 'a General price for Alitas');
select set_config('test.order', (public.save_poultry_order(
  'd3000000-0000-4000-8000-000000000001', current_setting('test.customer')::uuid, date '2026-11-10',
  jsonb_build_array(jsonb_build_object('productId', current_setting('test.p_entero'), 'boxes', 3))) ->> 'orderId'), true);
select set_config('test.order_before', (select jsonb_build_object('rev', o.revenue_cents, 'items', (select jsonb_agg(to_jsonb(i) - 'updated_at' order by i.position) from public.poultry_order_items i where i.order_id = o.id))::text
  from public.poultry_orders o where o.id = current_setting('test.order')::uuid), true);
select is(public.t_pdel_board_ids(), 'Alitas x 15 kg,Menudos x 15 kg,Pechuga x 15 kg,Pollo entero x 20 kg', 'the board lists the four products');

-- ---------------------------------------------------------------------------------------------
-- Permisos y aislamiento
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(format($f$select public.delete_poultry_product(%L)$f$, current_setting('test.p_menudos')), '42501', null, 'an employee without poultry.write cannot delete');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok(format($f$select public.delete_poultry_product(%L)$f$, current_setting('test.p_menudos')), '42501', null, 'read-only poultry access cannot delete');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000009', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select throws_ok(format($f$select public.delete_poultry_product(%L)$f$, current_setting('test.p_menudos')), '42501', null, 'another organization cannot delete it');
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_pdel_row(current_setting('test.p_menudos')::uuid), 'true/false', 'the rejected attempts changed nothing');
select throws_ok($$select public.delete_poultry_product(gen_random_uuid())$$, '42501', null, 'an unknown product cannot be deleted');

-- ---------------------------------------------------------------------------------------------
-- Sin historia: borrado físico de la configuración (el producto del catálogo queda)
-- ---------------------------------------------------------------------------------------------
select is(public.delete_poultry_product(current_setting('test.p_menudos')::uuid) ->> 'mode', 'DELETED', 'a product without history is deleted physically');
select is(public.t_pdel_row(current_setting('test.p_menudos')::uuid), 'gone', 'the Pollos row is gone');
select is(public.t_pdel_audits(current_setting('test.p_menudos')::uuid), 1::bigint, 'the physical deletion is audited with the full row');
select ok((select active from public.products where id = 'd5000000-0000-4000-8000-000000000003'), 'the general catalog product is untouched');
select throws_ok(format($f$select public.delete_poultry_product(%L)$f$, current_setting('test.p_menudos')), '42501', null, 'deleting twice is rejected');

-- ---------------------------------------------------------------------------------------------
-- Con historia: eliminación lógica, historia intacta
-- ---------------------------------------------------------------------------------------------
select is(public.delete_poultry_product(current_setting('test.p_entero')::uuid) ->> 'mode', 'ARCHIVED', 'a product with costs, prices and orders is deleted logically');
select is(public.t_pdel_row(current_setting('test.p_entero')::uuid), 'false/true', 'it becomes inactive and marked as deleted');
select is(public.t_pdel_history(current_setting('test.p_entero')::uuid), '1/1/1', 'its cost, price and order line are kept');
select is((select jsonb_build_object('rev', o.revenue_cents, 'items', (select jsonb_agg(to_jsonb(i) - 'updated_at' order by i.position) from public.poultry_order_items i where i.order_id = o.id))::text
  from public.poultry_orders o where o.id = current_setting('test.order')::uuid), current_setting('test.order_before'), 'the historical order is byte-for-byte unchanged');
select is(public.delete_poultry_product(current_setting('test.p_alitas')::uuid) ->> 'mode', 'ARCHIVED', 'a price alone is history too: logical deletion');
select is(public.t_pdel_board_ids(), 'Pechuga x 15 kg', 'deleted products leave the price board');
select ok(not exists (select 1 from jsonb_array_elements(public.get_poultry_customer_detail(current_setting('test.customer')::uuid) -> 'prices') e
  where e ->> 'productId' in (current_setting('test.p_entero'), current_setting('test.p_alitas'))), 'deleted products leave the customer price sheet');
select ok(not exists (select 1 from jsonb_array_elements(public.resolve_poultry_prices(current_setting('test.customer')::uuid)) e
  where e ->> 'productId' = current_setting('test.p_entero')), 'a deleted product is not offered for new orders');
select throws_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true)$f$, current_setting('test.p_entero')), '42501', null, 'a deleted product cannot be re-enabled from its settings');
select is((select (e ->> 'removedFromPoultry')::boolean from jsonb_array_elements(public.search_poultry_candidate_products('pollo entero')) e
  where e ->> 'productId' = 'd5000000-0000-4000-8000-000000000001'), true, 'the catalog search offers it back as removed');

-- ---------------------------------------------------------------------------------------------
-- Restauración: volver a agregarlo lo devuelve con su historia
-- ---------------------------------------------------------------------------------------------
select is(public.add_poultry_product('d5000000-0000-4000-8000-000000000001', 'UNIT')::text, current_setting('test.p_entero'), 'adding it again restores the same Pollos row');
select is(public.t_pdel_row(current_setting('test.p_entero')::uuid), 'true/false', 'the restored product is active and not deleted');
select is(public.t_pdel_board_ids(), 'Pechuga x 15 kg,Pollo entero x 20 kg', 'the restored product is back on the board');
select is((select ((e -> 'prices') -> current_setting('test.list_gen') ->> 'cents') from jsonb_array_elements(public.get_poultry_price_board() -> 'products') e
  where e ->> 'id' = current_setting('test.p_entero')), '6599900', 'with its current General price');

select * from finish();
rollback;
