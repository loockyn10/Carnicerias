begin;

create extension if not exists pgtap with schema extensions;
select plan(61);

-- Covers 202610020053 (proveedores): alta/edición/desactivación, normalización de nombres,
-- aislamiento por organización (RLS), relación producto ↔ proveedor y que un producto sin proveedor
-- sigue siendo válido. Fixture: org A (admin + empleado, 3 productos) y org B (admin, 1 producto).

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select ok(exists(select 1 from public.permissions where key = 'suppliers.read') and exists(select 1 from public.permissions where key = 'suppliers.write'), 'the supplier permissions exist');
select ok(
  exists(select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000001' and permission_key = 'suppliers.write'),
  'the admin role can write suppliers'
);
select ok(
  not exists(select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000002' and permission_key like 'suppliers.%'),
  'the employee role holds no supplier permission'
);
select ok(not has_function_privilege('anon', 'public.save_supplier(uuid,text,text,text,text,text,text,boolean)', 'EXECUTE'), 'anonymous cannot save suppliers');
select ok(not has_function_privilege('anon', 'public.set_product_primary_supplier(uuid,uuid)', 'EXECUTE'), 'anonymous cannot assign suppliers');
select ok(not has_function_privilege('authenticated', 'app_private.set_primary_supplier(uuid,uuid,uuid,text)', 'EXECUTE'), 'the primary-supplier helper is private');
select ok(not has_table_privilege('authenticated', 'public.suppliers', 'INSERT'), 'suppliers have no direct INSERT grant');
select ok(not has_table_privilege('authenticated', 'public.product_suppliers', 'UPDATE'), 'product_suppliers have no direct UPDATE grant');
select ok((select relrowsecurity from pg_class where oid = 'public.suppliers'::regclass), 'suppliers has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.product_suppliers'::regclass), 'product_suppliers has RLS enabled');

-- ---------------------------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'sup-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Sup Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'sup-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Sup Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'sup-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Sup Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('b2000000-0000-4000-8000-000000000001', 'Sup Org A', 'sup-org-a'),
  ('b2000000-0000-4000-8000-000000000002', 'Sup Org B', 'sup-org-b');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Almacen', 'almacen'),
  ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', 'Almacen', 'almacen');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'coca', 'COCA', 'UNIT'),
  ('b4000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Galletitas X', 'galletitas', 'GALL', 'UNIT'),
  ('b4000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Sin proveedor', 'sin-proveedor', 'SINP', 'UNIT'),
  ('b4000000-0000-4000-8000-000000000009', 'b2000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000002', 'Producto de B', 'prod-b', 'PB', 'UNIT');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Crear / editar / desactivar
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.save_supplier(null, 'Coca-Cola FEMSA')$$, 'a supplier needs only a name');
select is(
  (select jsonb_build_object('code', code, 'tax_id', tax_id, 'phone', phone, 'email', email, 'notes', notes, 'active', active) from public.suppliers where name = 'Coca-Cola FEMSA'),
  '{"code":null,"tax_id":null,"phone":null,"email":null,"notes":null,"active":true}'::jsonb,
  'optional fields stay null and a new supplier is active'
);
select lives_ok($$select public.save_supplier(null, '  Distribuidora Peña  ', ' p-77 ', '30-12345678-9', '11 5555-0000', 'ventas@pena.test', 'Entrega los martes')$$, 'a full supplier is created (blank-trimmed, code upper-cased)');
select is(
  (select jsonb_build_object('name', name, 'code', code, 'tax', tax_id, 'email', email) from public.suppliers where code = 'P-77'),
  '{"name":"Distribuidora Peña","code":"P-77","tax":"30-12345678-9","email":"ventas@pena.test"}'::jsonb,
  'the optional data is saved normalized'
);
select throws_ok($$select public.save_supplier(null, '')$$, '22023', null, 'a blank name is rejected');
select throws_ok($$select public.save_supplier(null, 'Mal Email', null, null, null, 'sin-arroba')$$, '22023', null, 'an invalid email is rejected');
select throws_ok($$select public.save_supplier(null, 'coca-cola   femsa')$$, '23505', 'Ya existe un proveedor con ese nombre', 'the same name with other case/spaces is a duplicate');
select throws_ok($$select public.save_supplier(null, 'DISTRIBUIDORA PENA')$$, '23505', 'Ya existe un proveedor con ese nombre', 'accents are ignored when detecting duplicates');
select throws_ok($$select public.save_supplier(null, 'Otro Nombre', 'p-77')$$, '23505', 'Ya existe un proveedor con ese código', 'the same code is a duplicate');
select is((select count(*) from public.suppliers), 2::bigint, 'no duplicate was created');

select lives_ok($$select public.save_supplier((select id from public.suppliers where code = 'P-77'), 'Distribuidora Peña SRL', 'P-77', null, '11 5555-9999', null, null, true)$$, 'a supplier can be edited');
select is((select count(*) from public.suppliers), 2::bigint, 'editing did not create a second supplier');
select is((select phone from public.suppliers where code = 'P-77'), '11 5555-9999', 'the edit was saved');
select is((select tax_id from public.suppliers where code = 'P-77'), null, 'a blank optional field clears it');
select throws_ok($$select public.save_supplier((select id from public.suppliers where code = 'P-77'), 'Coca-Cola FEMSA')$$, '23505', null, 'renaming onto another supplier name is rejected');
select lives_ok($$select public.save_supplier((select id from public.suppliers where code = 'P-77'), 'distribuidora peña srl', 'P-77')$$, 'saving a supplier with its own name in other case is fine');

-- ---------------------------------------------------------------------------------------------
-- Relación producto ↔ proveedor
-- ---------------------------------------------------------------------------------------------
select is((select count(*) from public.product_suppliers), 0::bigint, 'products start without any supplier');
select lives_ok($$select public.set_product_primary_supplier('b4000000-0000-4000-8000-000000000001', (select id from public.suppliers where name = 'Coca-Cola FEMSA'))$$, 'a primary supplier is assigned');
select is(
  (select is_primary from public.product_suppliers where product_id = 'b4000000-0000-4000-8000-000000000001'),
  true, 'the link is the primary one'
);
select is((select count(*) from public.products where id = 'b4000000-0000-4000-8000-000000000003'), 1::bigint, 'a product with no supplier stays valid');
select is((select count(*) from public.product_suppliers where product_id = 'b4000000-0000-4000-8000-000000000003'), 0::bigint, 'and has no link at all');

select lives_ok($$select public.set_product_primary_supplier('b4000000-0000-4000-8000-000000000001', (select id from public.suppliers where code = 'P-77'))$$, 'the primary supplier can be replaced');
select is((select count(*) from public.product_suppliers where product_id = 'b4000000-0000-4000-8000-000000000001' and is_primary), 1::bigint, 'there is exactly one primary supplier');
select is((select count(*) from public.product_suppliers where product_id = 'b4000000-0000-4000-8000-000000000001'), 2::bigint, 'the previous primary is kept as a secondary link');
select is(
  public.set_product_primary_supplier('b4000000-0000-4000-8000-000000000001', (select id from public.suppliers where code = 'P-77')) ->> 'changed',
  'false', 'assigning the same primary again changes nothing'
);
select lives_ok($$select public.set_product_primary_supplier('b4000000-0000-4000-8000-000000000001', null)$$, 'a product can be left without a primary supplier');
select is((select count(*) from public.product_suppliers where product_id = 'b4000000-0000-4000-8000-000000000001' and is_primary), 0::bigint, 'no primary remains');
select is((select count(*) from public.products where id = 'b4000000-0000-4000-8000-000000000001'), 1::bigint, 'the product itself is untouched');
select throws_ok($$select public.set_product_primary_supplier('b4000000-0000-4000-8000-0000000000ff', (select id from public.suppliers where code = 'P-77'))$$, '42501', null, 'an unknown product is rejected');

-- Desactivar: conserva vínculos; ya no se asigna de nuevo.
select lives_ok($$select public.set_product_primary_supplier('b4000000-0000-4000-8000-000000000002', (select id from public.suppliers where name = 'Coca-Cola FEMSA'))$$, 'Galletitas get Coca-Cola as supplier');
select lives_ok($$select public.set_supplier_active((select id from public.suppliers where name = 'Coca-Cola FEMSA'), false)$$, 'a supplier is deactivated');
select is((select active from public.suppliers where name = 'Coca-Cola FEMSA'), false, 'it is inactive');
select is((select count(*) from public.product_suppliers where supplier_id = (select id from public.suppliers where name = 'Coca-Cola FEMSA')), 2::bigint, 'deactivating keeps its product links');
select throws_ok($$select public.set_product_primary_supplier('b4000000-0000-4000-8000-000000000003', (select id from public.suppliers where name = 'Coca-Cola FEMSA'))$$, '22023', null, 'an inactive supplier cannot be assigned to another product');
select lives_ok($$select public.set_product_primary_supplier('b4000000-0000-4000-8000-000000000002', (select id from public.suppliers where name = 'Coca-Cola FEMSA'))$$, 'but a product already using it is not forced to change');
select lives_ok($$select public.set_supplier_active((select id from public.suppliers where name = 'Coca-Cola FEMSA'), true)$$, 'a supplier is reactivated');

-- ---------------------------------------------------------------------------------------------
-- Listado
-- ---------------------------------------------------------------------------------------------
select is(
  (select jsonb_agg(jsonb_build_object('n', name, 'p', product_count, 't', total_count) order by name) from public.list_suppliers_page()),
  '[{"n":"Coca-Cola FEMSA","p":1,"t":2},{"n":"distribuidora peña srl","p":0,"t":2}]'::jsonb,
  'the page lists suppliers with their primary-product count'
);
select is((select count(*) from public.list_suppliers_page('pena')), 1::bigint, 'search is accent/case-insensitive');
select is((select count(*) from public.list_suppliers_page('p-77')), 1::bigint, 'search also matches the code');
select throws_ok($$select * from public.list_suppliers_page(null, 'weird')$$, '22023', null, 'an unsupported status filter is rejected');

-- ---------------------------------------------------------------------------------------------
-- Permisos y aislamiento por organización
-- ---------------------------------------------------------------------------------------------
select set_config('test.supplier_a', (select id::text from public.suppliers where code = 'P-77'), true);
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.save_supplier(null, 'Intruso')$$, '42501', null, 'an employee cannot create suppliers');
select is((select count(*) from public.suppliers), 0::bigint, 'an employee cannot even read suppliers (RLS)');
select throws_ok($$insert into public.suppliers (organization_id, name) values ('b2000000-0000-4000-8000-000000000001', 'Directo')$$, '42501', null, 'direct inserts are not allowed');

select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000009', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select is((select count(*) from public.suppliers), 0::bigint, 'org B sees none of org A suppliers');
select is((select count(*) from public.product_suppliers), 0::bigint, 'org B sees none of org A product links');
select is((select count(*) from public.list_suppliers_page()), 0::bigint, 'the page of org B is empty');
select lives_ok($$select public.save_supplier(null, 'Coca-Cola FEMSA')$$, 'org B can create a supplier with the same name as org A (names are unique per organization)');
select throws_ok($$select public.save_supplier('00000000-0000-4000-8000-00000000dead', 'Fantasma')$$, '42501', null, 'editing an unknown supplier id is rejected');
select throws_ok(format($f$select public.save_supplier(%L, 'Secuestrado')$f$, current_setting('test.supplier_a')), '42501', null, 'org B cannot edit a supplier of org A');
select throws_ok(format($f$select public.set_supplier_active(%L, false)$f$, current_setting('test.supplier_a')), '42501', null, 'org B cannot deactivate a supplier of org A');
select throws_ok(
  format($f$select public.set_product_primary_supplier('b4000000-0000-4000-8000-000000000009', %L)$f$, current_setting('test.supplier_a')),
  '42501', null, 'org B cannot link its product to a supplier of org A'
);

select * from finish();
rollback;
