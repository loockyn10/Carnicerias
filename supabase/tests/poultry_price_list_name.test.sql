begin;

create extension if not exists pgtap with schema extensions;
select plan(34);

-- Cubre 202611180106 (Pollos → «Nombre para lista de precios»): se configura desde Configurar, se normaliza, se quita con texto vacío, no
-- cambia el nombre original, la categoría, el número de orden ni los precios; permisos y aislamiento por organización.

select ok(not has_function_privilege('anon', 'public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean, text, text)', 'EXECUTE'), 'anonymous cannot save settings');
select ok(has_function_privilege('authenticated', 'public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean, text, text)', 'EXECUTE'), 'settings take the price-list name');
select is((select count(*) from pg_proc where proname = 'save_poultry_product_settings' and pronamespace = 'public'::regnamespace), 1::bigint, 'no stale overload remains');

-- ---------------------------------------------------------------------------------------------
-- Fixture: org A (admin, empleado, lector de Pollos) y org B (admin)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pln-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PLN Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pln-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PLN Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pln-reader-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PLN Reader A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'pln-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PLN Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'PLN Org A', 'pln-org-a'),
  ('e2000000-0000-4000-8000-000000000002', 'PLN Org B', 'pln-org-b');
insert into public.roles (id, organization_id, key, name, is_system) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'pollos_lectura', 'Pollos lectura', false);
insert into public.role_permissions (role_id, permission_key) values ('e4000000-0000-4000-8000-000000000001', 'poultry.read');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'e4000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.products (id, organization_id, name, slug, sku, unit_type, active) values
  ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Gallina', 'gallina', 'GAL', 'UNIT', true),
  ('e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'Medallones', 'medallones', 'MED', 'UNIT', true);

-- Fila del tablero de un producto: «nombre|nombre para la lista|categoría:número».
create function public.t_pln_board(p_id uuid) returns text language sql security definer set search_path = '' as $$
  select coalesce((select (e ->> 'name') || '|' || coalesce(e ->> 'priceListName', '<null>') || '|' || (e ->> 'category') || ':' || (e ->> 'sortOrder')
    from jsonb_array_elements(public.get_poultry_price_board() -> 'products') e where e ->> 'id' = p_id::text), 'gone')
$$;
create function public.t_pln_raw(p_id uuid) returns text language sql security definer set search_path = '' as $$
  select coalesce((select coalesce(p.price_list_name, '<null>') from public.poultry_products p where p.id = p_id), 'gone')
$$;
create function public.t_pln_force(p_id uuid, p_name text) returns void language sql security definer set search_path = '' as $$
  update public.poultry_products set price_list_name = p_name where id = p_id
$$;
grant execute on function public.t_pln_board(uuid), public.t_pln_raw(uuid), public.t_pln_force(uuid, text) to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select set_config('test.p_gallina', public.add_poultry_product('e5000000-0000-4000-8000-000000000001', 'UNIT')::text, true);
select set_config('test.p_med', public.add_poultry_product('e5000000-0000-4000-8000-000000000002', 'UNIT', false, null, 'CONGELADOS')::text, true);
select set_config('test.list_gen', (select id::text from public.poultry_price_lists where organization_id = 'e2000000-0000-4000-8000-000000000001' and is_default), true);
select lives_ok(format($f$select public.set_poultry_list_price(%L, %L, 4299950)$f$, current_setting('test.list_gen'), current_setting('test.p_gallina')), 'a General price is recorded');
select lives_ok(format($f$select public.set_poultry_product_sort_order(%L, 7)$f$, current_setting('test.p_gallina')), 'the product gets order 7');

-- ---------------------------------------------------------------------------------------------
-- Sin configurar: NULL (los productos existentes no se rellenan)
-- ---------------------------------------------------------------------------------------------
select is(public.t_pln_board(current_setting('test.p_gallina')::uuid), 'Gallina|<null>|POLLO:7', 'a new product has no price-list name');

-- ---------------------------------------------------------------------------------------------
-- Configurar el nombre
-- ---------------------------------------------------------------------------------------------
select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, null, 'Gallina X 20kg')$f$, current_setting('test.p_gallina')), 'the price-list name is saved');
select is(public.t_pln_board(current_setting('test.p_gallina')::uuid), 'Gallina|Gallina X 20kg|POLLO:7', 'the board keeps the original name and adds the price-list name; category and order intact');
select is((select name from public.products where id = 'e5000000-0000-4000-8000-000000000001'), 'Gallina', 'the catalog product name is untouched');
select is((select ((e -> 'prices') -> current_setting('test.list_gen') ->> 'cents') from jsonb_array_elements(public.get_poultry_price_board() -> 'products') e
  where e ->> 'id' = current_setting('test.p_gallina')), '4299950', 'its General price is untouched');

select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true)$f$, current_setting('test.p_gallina')), 'settings without the name (an older Admin) still work');
select is(public.t_pln_raw(current_setting('test.p_gallina')::uuid), 'Gallina X 20kg', '... and keep the name');
select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, 'POLLO', 'Gallina X 20kg')$f$, current_setting('test.p_gallina')), 'saving the same category with the name');
select is(public.t_pln_board(current_setting('test.p_gallina')::uuid), 'Gallina|Gallina X 20kg|POLLO:7', '... keeps the order number');

select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, null, %L)$f$, current_setting('test.p_gallina'), E'  Gallina \t X   20kg  '), 'extra spaces are accepted');
select is(public.t_pln_raw(current_setting('test.p_gallina')::uuid), 'Gallina X 20kg', '... and collapsed');

select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, null, %L)$f$, current_setting('test.p_gallina'), repeat('a', 80)), '80 characters are accepted');
select throws_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, null, %L)$f$, current_setting('test.p_gallina'), repeat('a', 81)), '22023', null, '81 characters are rejected');
select is(public.t_pln_raw(current_setting('test.p_gallina')::uuid), repeat('a', 80), '... and the previous name stays');

select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, null, '   ')$f$, current_setting('test.p_gallina')), 'blank text clears the name');
select is(public.t_pln_board(current_setting('test.p_gallina')::uuid), 'Gallina|<null>|POLLO:7', '... back to the original name');
select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, null, 'Gallina X 20kg')$f$, current_setting('test.p_gallina')), 'the name is set again');
select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, null, '')$f$, current_setting('test.p_gallina')), 'empty text clears the name');
select is(public.t_pln_raw(current_setting('test.p_gallina')::uuid), '<null>', '... stored as NULL');

-- Cambiar de categoría con nombre: el nombre queda, el número pasa al final de la nueva categoría (regla de 202611170105).
select lives_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, 'CONGELADOS', 'Gallina X 20kg')$f$, current_setting('test.p_gallina')), 'category and name change together');
select is(public.t_pln_board(current_setting('test.p_gallina')::uuid), 'Gallina|Gallina X 20kg|CONGELADOS:2', '... the name is saved and the order follows the category rule');
select is(public.t_pln_board(current_setting('test.p_med')::uuid), 'Medallones|<null>|CONGELADOS:1', 'other products are untouched');

-- La base nunca guarda un nombre vacío o con espacios en los bordes.
select throws_ok(format($f$select public.t_pln_force(%L, '')$f$, current_setting('test.p_gallina')), '23514', null, 'an empty name cannot be stored');
select throws_ok(format($f$select public.t_pln_force(%L, ' Gallina')$f$, current_setting('test.p_gallina')), '23514', null, 'a name with leading spaces cannot be stored');

-- ---------------------------------------------------------------------------------------------
-- Permisos y organización
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.t_pln_board(current_setting('test.p_gallina')::uuid), 'Gallina|Gallina X 20kg|CONGELADOS:2', 'a Pollos reader sees the price-list name');
select throws_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, null, 'Otro')$f$, current_setting('test.p_gallina')), '42501', null, 'a reader cannot change it');

select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, null, 'Otro')$f$, current_setting('test.p_gallina')), '42501', null, 'an employee without poultry.write cannot change it');

select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000009', true);
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select throws_ok(format($f$select public.save_poultry_product_settings(%L, 'UNIT', false, null, true, null, 'Otro')$f$, current_setting('test.p_gallina')), '42501', null, 'another organization cannot change it');
select is(public.t_pln_raw(current_setting('test.p_gallina')::uuid), 'Gallina X 20kg', 'the name survives the rejected attempts');

select * from finish();
rollback;
