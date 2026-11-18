begin;

create extension if not exists pgtap with schema extensions;
select plan(47);

-- Cubre 202611170105 (Pollos → categoría POLLO/CONGELADOS y número de orden manual): alta al final de la categoría, edición del número
-- (enteros 1..99999, repetidos permitidos), cambio de categoría, reactivación, orden del tablero (categoría, número, nombre, id), permisos,
-- aislamiento por organización y precios intactos.

select ok(not has_function_privilege('anon', 'public.set_poultry_product_sort_order(uuid, integer)', 'EXECUTE'), 'anonymous cannot set the order');
select ok(has_function_privilege('authenticated', 'public.set_poultry_product_sort_order(uuid, integer)', 'EXECUTE'), 'authenticated users reach the RPC (the permission is checked inside)');
select ok(has_function_privilege('authenticated', 'public.add_poultry_product(uuid, public.unit_type, boolean, integer, text)', 'EXECUTE'), 'add takes the category');
select ok(has_function_privilege('authenticated', 'public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean, text, text)', 'EXECUTE'), 'settings take the category');
select is((select count(*) from pg_proc where proname in ('add_poultry_product', 'save_poultry_product_settings') and pronamespace = 'public'::regnamespace), 2::bigint, 'no stale overloads remain');
select ok(not has_function_privilege('authenticated', 'app_private.poultry_next_sort_order(uuid, text, uuid)', 'EXECUTE'), 'the helper is private');

-- ---------------------------------------------------------------------------------------------
-- Fixture: org A (admin, empleado, lector de Pollos) y org B (admin)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pco-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PCo Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pco-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PCo Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pco-reader-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PCo Reader A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'pco-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PCo Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'PCo Org A', 'pco-org-a'),
  ('f2000000-0000-4000-8000-000000000002', 'PCo Org B', 'pco-org-b');
insert into public.roles (id, organization_id, key, name, is_system) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'pollos_lectura', 'Pollos lectura', false);
insert into public.role_permissions (role_id, permission_key) values ('f4000000-0000-4000-8000-000000000001', 'poultry.read');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'f4000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.products (id, organization_id, name, slug, sku, unit_type, active) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Pollo entero x 20 kg', 'pollo-entero', 'POL', 'UNIT', true),
  ('f5000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Pata muslo x 15 kg', 'pata-muslo', 'PAT', 'UNIT', true),
  ('f5000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'Pechuga x 15 kg', 'pechuga', 'PEC', 'UNIT', true),
  ('f5000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'Medallones x 6 kg', 'medallones', 'MED', 'UNIT', true),
  ('f5000000-0000-4000-8000-000000000005', 'f2000000-0000-4000-8000-000000000001', 'Hamburguesas x 40 un', 'hamburguesas', 'HAM', 'UNIT', true),
  ('f5000000-0000-4000-8000-000000000006', 'f2000000-0000-4000-8000-000000000001', 'Alitas x 15 kg', 'alitas', 'ALI', 'UNIT', true);

-- Tablero en su orden: «CATEGORÍA:número:nombre» separados por «|».
create function public.t_pco_board() returns text language sql security definer set search_path = '' as $$
  select coalesce(string_agg((e ->> 'category') || ':' || (e ->> 'sortOrder') || ':' || (e ->> 'name'), '|' order by n), '')
  from jsonb_array_elements(public.get_poultry_price_board() -> 'products') with ordinality as t(e, n)
$$;
create function public.t_pco_row(p_id uuid) returns text language sql security definer set search_path = '' as $$
  select coalesce((select p.category || ':' || p.sort_order::text || ':' || p.active::text from public.poultry_products p where p.id = p_id), 'gone')
$$;
grant execute on function public.t_pco_board(), public.t_pco_row(uuid) to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Alta: número automático al final de la categoría (independiente por categoría)
-- ---------------------------------------------------------------------------------------------
select set_config('test.p_entero', public.add_poultry_product('f5000000-0000-4000-8000-000000000001', 'UNIT')::text, true);
select set_config('test.p_pata', public.add_poultry_product('f5000000-0000-4000-8000-000000000002', 'UNIT', false, null, 'POLLO')::text, true);
select set_config('test.p_pechuga', public.add_poultry_product('f5000000-0000-4000-8000-000000000003', 'UNIT', false, null, 'POLLO')::text, true);
select set_config('test.p_medallones', public.add_poultry_product('f5000000-0000-4000-8000-000000000004', 'UNIT', false, null, 'CONGELADOS')::text, true);
select set_config('test.p_hamb', public.add_poultry_product('f5000000-0000-4000-8000-000000000005', 'UNIT', false, null, 'CONGELADOS')::text, true);
select set_config('test.list_gen', (select id::text from public.poultry_price_lists where organization_id = 'f2000000-0000-4000-8000-000000000001' and is_default), true);

select is(public.t_pco_row(current_setting('test.p_entero')::uuid), 'POLLO:1:true', 'without a category the product goes to Pollo, number 1');
select is(public.t_pco_row(current_setting('test.p_pechuga')::uuid), 'POLLO:3:true', 'the next Pollo product gets the next number');
select is(public.t_pco_row(current_setting('test.p_medallones')::uuid), 'CONGELADOS:1:true', 'numbering is independent per category');
select is(public.t_pco_row(current_setting('test.p_hamb')::uuid), 'CONGELADOS:2:true', 'the next Congelados product gets 2');
select throws_ok($$select public.add_poultry_product('f5000000-0000-4000-8000-000000000006', 'UNIT', false, null, 'OTRA')$$, '22023', null, 'an unknown category is rejected');
select throws_ok($$select public.add_poultry_product('f5000000-0000-4000-8000-000000000006', 'UNIT', false, null, null)$$, '22023', null, 'a null category is rejected');
select is(public.t_pco_board(), 'POLLO:1:Pollo entero x 20 kg|POLLO:2:Pata muslo x 15 kg|POLLO:3:Pechuga x 15 kg|CONGELADOS:1:Medallones x 6 kg|CONGELADOS:2:Hamburguesas x 40 un',
  'the board lists Pollo first, then Congelados, each by number');

-- Precio General registrado: ningún cambio de orden o categoría lo toca.
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 6599900)$f$, current_setting('test.list_gen'), current_setting('test.p_pata')), 'a General price is recorded');

-- ---------------------------------------------------------------------------------------------
-- Edición del número desde el listado
-- ---------------------------------------------------------------------------------------------
select is(public.set_poultry_product_sort_order(current_setting('test.p_entero')::uuid, 10) ->> 'sortOrder', '10', 'the order is saved');
select is(public.set_poultry_product_sort_order(current_setting('test.p_pechuga')::uuid, 9) ->> 'category', 'POLLO', 'the response carries the category');
select is(public.t_pco_board(), 'POLLO:2:Pata muslo x 15 kg|POLLO:9:Pechuga x 15 kg|POLLO:10:Pollo entero x 20 kg|CONGELADOS:1:Medallones x 6 kg|CONGELADOS:2:Hamburguesas x 40 un',
  'numbers sort numerically (9 before 10), not as text');
select lives_ok(format($f$select public.set_poultry_product_sort_order(%L, 2)$f$, current_setting('test.p_pechuga')), 'a repeated number is not an error');
select is(public.t_pco_board(), 'POLLO:2:Pata muslo x 15 kg|POLLO:2:Pechuga x 15 kg|POLLO:10:Pollo entero x 20 kg|CONGELADOS:1:Medallones x 6 kg|CONGELADOS:2:Hamburguesas x 40 un',
  'both products with the same number stay listed, tied by name');
select throws_ok(format($f$select public.set_poultry_product_sort_order(%L, 0)$f$, current_setting('test.p_entero')), '22023', null, 'zero is rejected');
select throws_ok(format($f$select public.set_poultry_product_sort_order(%L, -3)$f$, current_setting('test.p_entero')), '22023', null, 'negative numbers are rejected');
select throws_ok(format($f$select public.set_poultry_product_sort_order(%L, 100000)$f$, current_setting('test.p_entero')), '22023', null, 'numbers above 99999 are rejected');
select throws_ok(format($f$select public.set_poultry_product_sort_order(%L, null)$f$, current_setting('test.p_entero')), '22023', null, 'an empty number is rejected');
select is(public.t_pco_row(current_setting('test.p_entero')::uuid), 'POLLO:10:true', 'rejected values leave the saved order untouched');
select throws_ok($$select public.set_poultry_product_sort_order(gen_random_uuid(), 1)$$, '42501', null, 'an unknown product is rejected');

-- ---------------------------------------------------------------------------------------------
-- Permisos y aislamiento
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(format($f$select public.set_poultry_product_sort_order(%L, 1)$f$, current_setting('test.p_entero')), '42501', null, 'an employee without poultry.write cannot reorder');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok(format($f$select public.set_poultry_product_sort_order(%L, 1)$f$, current_setting('test.p_entero')), '42501', null, 'read-only poultry access cannot reorder');
select is(split_part(public.t_pco_board(), '|', 1), 'POLLO:2:Pata muslo x 15 kg', 'read-only poultry access sees category and order on the board');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000009', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select throws_ok(format($f$select public.set_poultry_product_sort_order(%L, 1)$f$, current_setting('test.p_entero')), '42501', null, 'another organization cannot reorder it');
select throws_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, 'CONGELADOS')$f$, current_setting('test.p_entero')), '42501', null, 'another organization cannot change its category');
select is(public.t_pco_board(), '', 'another organization does not see the products');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.t_pco_row(current_setting('test.p_entero')::uuid), 'POLLO:10:true', 'the rejected attempts changed nothing');

-- ---------------------------------------------------------------------------------------------
-- Cambio de categoría desde «Configurar»
-- ---------------------------------------------------------------------------------------------
select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true)$f$, current_setting('test.p_pata')), 'settings without a category keep it');
select is(public.t_pco_row(current_setting('test.p_pata')::uuid), 'POLLO:2:true', 'category and order are unchanged');
select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, 'CONGELADOS')$f$, current_setting('test.p_pata')), 'a product moves to Congelados');
select is(public.t_pco_row(current_setting('test.p_pata')::uuid), 'CONGELADOS:3:true', 'it goes to the end of its new category');
select throws_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, 'carne')$f$, current_setting('test.p_pata')), '22023', null, 'settings reject an unknown category');
select is((select ((e -> 'prices') -> current_setting('test.list_gen') ->> 'cents') from jsonb_array_elements(public.get_poultry_price_board() -> 'products') e
  where e ->> 'id' = current_setting('test.p_pata')), '6599900', 'its General price is untouched');

-- ---------------------------------------------------------------------------------------------
-- Quitar / eliminar y volver a agregar
-- ---------------------------------------------------------------------------------------------
select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, false)$f$, current_setting('test.p_medallones')), 'a product is removed from Pollos');
select is(public.add_poultry_product('f5000000-0000-4000-8000-000000000004', 'UNIT', false, null, 'CONGELADOS')::text, current_setting('test.p_medallones'), 'adding it again reactivates the same row');
select is(public.t_pco_row(current_setting('test.p_medallones')::uuid), 'CONGELADOS:1:true', 'back in the same category it keeps its place');

select is(public.delete_poultry_product(current_setting('test.p_hamb')::uuid) ->> 'mode', 'DELETED', 'a product without history is deleted');
select is(public.delete_poultry_product(current_setting('test.p_pata')::uuid) ->> 'mode', 'ARCHIVED', 'a product with history is deleted logically');
select throws_ok(format($f$select public.set_poultry_product_sort_order(%L, 1)$f$, current_setting('test.p_pata')), '42501', null, 'a deleted product cannot be reordered');
select set_config('test.p_alitas', public.add_poultry_product('f5000000-0000-4000-8000-000000000006', 'UNIT', false, null, 'CONGELADOS')::text, true);
select is(public.t_pco_row(current_setting('test.p_alitas')::uuid), 'CONGELADOS:2:true',
  'a new product goes after the last remaining one of its category (deleted ones do not count)');
select is(public.set_poultry_product_sort_order(current_setting('test.p_alitas')::uuid, 7) ->> 'sortOrder', '7', 'the new product is renumbered');
select is(public.t_pco_row(public.add_poultry_product('f5000000-0000-4000-8000-000000000002', 'UNIT', false, null, 'CONGELADOS')), 'CONGELADOS:8:true',
  'restoring a deleted product puts it at the end of its category');

select * from finish();
rollback;
