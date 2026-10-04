begin;

create extension if not exists pgtap with schema extensions;
select plan(45);

-- Covers 202610040061: UNA categoría por producto. products.category_id es la única categoría válida;
-- product_category_assignments queda como proyección interna (a lo sumo una fila por producto, siempre la principal);
-- set_product_categories rechaza categorías extra; las lecturas del POS (pull_pos_state, get_pos_catalog, get_pos_categories)
-- devuelven siempre categoryIds = [category_id]. Reemplaza a product_multi_category.test.sql (202609230033).

select has_table('public', 'product_category_assignments', 'product_category_assignments is kept as an internal projection');
select has_function('public', 'set_product_categories', array['uuid','uuid','uuid[]'], 'set_product_categories keeps its signature');
select has_function('public', 'get_pos_categories', array['uuid'], 'get_pos_categories RPC exists');
select ok(
  exists (select 1 from pg_constraint where conrelid = 'public.product_category_assignments'::regclass and contype = 'u' and conkey = array[
    (select attnum from pg_attribute where attrelid = 'public.product_category_assignments'::regclass and attname = 'product_id')]::smallint[]),
  'at most one assignment per product is enforced by a unique constraint on product_id'
);
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.product_category_assignments'::regclass and tgname = 'product_category_assignments_single_category' and not tgisinternal),
  'a trigger refuses any assignment other than the principal category'
);

-- Fixture: one organization, two branches, an admin, an employee, three categories, products.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'category-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Category Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'category-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Category Employee"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'Category Org', 'category-org'),
  ('f2000000-0000-4000-8000-000000000099', 'Other Category Org', 'category-other-org');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Category Branch 1', 'CT1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002');

insert into public.categories (id, organization_id, name, slug) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Embutidos', 'embutidos-cat'),
  ('f4000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Cerdo', 'cerdo-cat'),
  ('f4000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'Vacuno', 'vacuno-cat'),
  ('f4000000-0000-4000-8000-000000000099', 'f2000000-0000-4000-8000-000000000099', 'Foreign Category', 'foreign-cat');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Chorizo de cerdo', 'chorizo-cat', 'CT-1', 'WEIGHT', true),
  ('f5000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000003', 'Vacío', 'vacio-cat', 'CT-2', 'WEIGHT', true);
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, 'f3000000-0000-4000-8000-000000000001', p.id from public.products p where p.organization_id = 'f2000000-0000-4000-8000-000000000001';
insert into public.product_prices (organization_id, product_id, price_cents, valid_from)
select p.organization_id, p.id, 1000000, now() - interval '1 day' from public.products p where p.organization_id = 'f2000000-0000-4000-8000-000000000001';

-- Creating a product creates its (single) projection row automatically.
select is((select count(*) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001'), 1::bigint, 'a new product gets exactly one assignment row');
select is((select category_id from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001'), 'f4000000-0000-4000-8000-000000000001'::uuid, 'and it is the product''s own category');

-- The server refuses a secondary category, however it is written (superuser included).
select throws_ok(
  $$insert into public.product_category_assignments (organization_id, product_id, category_id) values ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000002')$$,
  '23514', null, 'inserting a secondary category is refused'
);
select throws_ok(
  $$update public.product_category_assignments set category_id = 'f4000000-0000-4000-8000-000000000002' where product_id = 'f5000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'repointing the projection to another category is refused'
);
select throws_ok(
  $$insert into public.product_category_assignments (organization_id, product_id, category_id) values ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001')$$,
  '23505', null, 'even the principal category cannot be inserted twice'
);
select is((select count(*) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001'), 1::bigint, 'the refused writes left exactly one row');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$insert into public.product_category_assignments (organization_id, product_id, category_id) values ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002', 'f4000000-0000-4000-8000-000000000003')$$,
  '42501', null, 'a client cannot write the projection at all'
);

-- set_product_categories: only the principal.
select lives_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001',array['f4000000-0000-4000-8000-000000000001']::uuid[])$$,
  'set_product_categories with [principal] is accepted'
);
select lives_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001',array[]::uuid[])$$,
  'set_product_categories with no extras is accepted'
);
select throws_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001',array['f4000000-0000-4000-8000-000000000002']::uuid[])$$,
  '22023', null, 'set_product_categories refuses a secondary category'
);
select throws_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001',array['f4000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000002']::uuid[])$$,
  '22023', null, 'principal + extra is refused too (the old "also appears in")'
);
select throws_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001',array['f4000000-0000-4000-8000-000000000099']::uuid[])$$,
  '22023', null, 'a foreign-organization extra is refused as well'
);
select throws_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000099',array[]::uuid[])$$,
  '22023', null, 'a foreign-organization principal is refused'
);
select throws_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',array[]::uuid[])$$,
  '22023', null, 'an invalid principal category is refused'
);
select is((select count(*) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001'), 1::bigint, 'the refused calls changed nothing: still one category');
select is((select category_id from public.products where id = 'f5000000-0000-4000-8000-000000000001'), 'f4000000-0000-4000-8000-000000000001'::uuid, 'and still Embutidos');

-- Changing the category REPLACES the previous one (never adds another).
select lives_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000002',array['f4000000-0000-4000-8000-000000000002']::uuid[])$$,
  'changing the category to Cerdo works'
);
select is((select category_id from public.products where id = 'f5000000-0000-4000-8000-000000000001'), 'f4000000-0000-4000-8000-000000000002'::uuid, 'products.category_id is Cerdo');
select is((select array_agg(category_id) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001'), array['f4000000-0000-4000-8000-000000000002']::uuid[], 'the projection replaced Embutidos with Cerdo (a single row)');
select lives_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000002',array['f4000000-0000-4000-8000-000000000002']::uuid[])$$,
  'saving the same category again is a no-op'
);
select is((select count(*) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001'), 1::bigint, 'still one row');

-- save_product (the Admin's other write path) moves the projection too.
select lives_ok(
  $$select public.save_product('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000003','Chorizo de cerdo','chorizo-cat','CT-1','WEIGHT',true)$$,
  'save_product moves the product to Vacuno'
);
select is((select array_agg(category_id) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001'), array['f4000000-0000-4000-8000-000000000003']::uuid[], 'and the projection followed (Cerdo is gone)');

-- A brand-new product created through save_product also has exactly one row.
select lives_ok(
  $$select public.save_product(null,'f4000000-0000-4000-8000-000000000001','Salchicha','salchicha-cat','CT-3','WEIGHT',true)$$,
  'save_product creates a product in Embutidos'
);
select is((select count(*) from public.product_category_assignments a join public.products p on p.id = a.product_id where p.sku = 'CT-3'), 1::bigint, 'it has one assignment');
select is((select a.category_id from public.product_category_assignments a join public.products p on p.id = a.product_id where p.sku = 'CT-3'), 'f4000000-0000-4000-8000-000000000001'::uuid, 'and it is the one it was created with');

-- The whole table: no product ever has more than one category.
reset role;
select is((select count(*) from (select product_id from public.product_category_assignments group by product_id having count(*) > 1) x), 0::bigint, 'no product has more than one assignment');
select is(
  (select count(*) from public.product_category_assignments a join public.products p on p.id = a.product_id where a.category_id is distinct from p.category_id),
  0::bigint, 'no assignment differs from products.category_id'
);
select is(
  (select count(*) from public.products p where p.category_id is not null and not exists (select 1 from public.product_category_assignments a where a.product_id = p.id)),
  0::bigint, 'every product with a category has its projection row'
);

-- A product with no category has no row; giving it one creates it.
update public.products set category_id = null where id = 'f5000000-0000-4000-8000-000000000002';
select is((select count(*) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000002'), 0::bigint, 'a product without category has no assignment');
update public.products set category_id = 'f4000000-0000-4000-8000-000000000003' where id = 'f5000000-0000-4000-8000-000000000002';
select is((select array_agg(category_id) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000002'), array['f4000000-0000-4000-8000-000000000003']::uuid[], 'and giving it a category creates the single row');
delete from public.products where sku = 'CT-3';
select is((select count(*) from public.product_category_assignments a where not exists (select 1 from public.products p where p.id = a.product_id)), 0::bigint, 'deleting a product deletes its projection row');

-- Reads: the POS never sees more than the principal category.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.register_pos_device('f7000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Caja Category')$$, 'the device is registered');
select is(
  (select jsonb_agg(i -> 'categoryIds') from jsonb_array_elements(public.pull_pos_state('f7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Chorizo de cerdo'),
  jsonb_build_array(jsonb_build_array('f4000000-0000-4000-8000-000000000003')),
  'pull_pos_state: categoryIds is exactly [category_id]'
);
select is(
  (select bool_and(jsonb_array_length(i -> 'categoryIds') = 1 and (i -> 'categoryIds' ->> 0) = (i ->> 'categoryId')) from jsonb_array_elements(public.pull_pos_state('f7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i),
  true, 'for every product of the catalog, categoryIds = [categoryId]'
);
select is(
  (select jsonb_agg(c ->> 'name' order by c ->> 'name') from jsonb_array_elements(public.pull_pos_state('f7000000-0000-4000-8000-000000000001', 0) -> 'categories') c),
  '["Vacuno"]'::jsonb, 'the tab directory lists only categories that are the principal of an enabled product (Cerdo/Embutidos are unused)'
);
select is(
  (select category_ids from public.get_pos_catalog('f3000000-0000-4000-8000-000000000001') where product_name = 'Chorizo de cerdo'),
  array['f4000000-0000-4000-8000-000000000003']::uuid[], 'get_pos_catalog: category_ids is [category_id]'
);
select is(
  (select array_agg(name order by name) from public.get_pos_categories('f3000000-0000-4000-8000-000000000001')),
  array['Vacuno']::text[],
  'get_pos_categories: only principal categories'
);
-- A category change travels as a catalog change (the incremental cursor picks the product up).
create temp table cursor_before(c bigint);
grant all on cursor_before to authenticated;
insert into cursor_before select (public.pull_pos_state('f7000000-0000-4000-8000-000000000001', 0) ->> 'cursor')::bigint;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000002',array[]::uuid[])$$, 'the product moves to Cerdo');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(
  (select jsonb_agg(i -> 'categoryIds') from jsonb_array_elements(public.pull_pos_state('f7000000-0000-4000-8000-000000000001', (select c from cursor_before)) -> 'catalog') i where i ->> 'productName' = 'Chorizo de cerdo'),
  jsonb_build_array(jsonb_build_array('f4000000-0000-4000-8000-000000000002')),
  'the incremental pull delivers the product with its NEW single category (the old one is replaced on the device)'
);

reset role;
select * from finish();
rollback;
