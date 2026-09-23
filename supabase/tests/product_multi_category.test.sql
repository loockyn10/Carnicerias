begin;

create extension if not exists pgtap with schema extensions;
select plan(18);

select has_table('public', 'product_category_assignments', 'product_category_assignments table exists');
select has_function('public', 'set_product_categories', array['uuid','uuid','uuid[]'], 'set_product_categories RPC exists');
select has_function('public', 'get_pos_categories', array['uuid'], 'get_pos_categories RPC exists');
select col_is_unique('public', 'product_category_assignments', array['product_id', 'category_id'], 'no duplicate (product, category) assignment can exist');

-- Fixture: one organization, one branch, an admin, three categories, one product.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'category-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Category Admin"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'Category Org', 'category-org');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Category Branch 1', 'CT1');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE');

insert into public.categories (id, organization_id, name, slug) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Embutidos', 'embutidos-cat'),
  ('f4000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Cerdo', 'cerdo-cat'),
  ('f4000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'Vacuno', 'vacuno-cat');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Chorizo de cerdo', 'chorizo-cat', 'CT-1', 'WEIGHT', true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- "Chorizo de cerdo": principal = Embutidos, también aparece en Cerdo.
select lives_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001',array['f4000000-0000-4000-8000-000000000002']::uuid[])$$,
  'set_product_categories assigns a primary and an additional category'
);
select is((select category_id from public.products where id = 'f5000000-0000-4000-8000-000000000001'), 'f4000000-0000-4000-8000-000000000001'::uuid, 'products.category_id keeps meaning the principal category');
select is((select count(*) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001'), 2::bigint, 'both the principal and the additional category are assigned');
select ok(
  (select array_agg(category_id order by category_id) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001')
  = array['f4000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000002']::uuid[],
  'assignments are exactly Embutidos + Cerdo, no more, no less'
);

-- The primary category is auto-included even if the caller's array omits it ("mantener
-- coherencia automáticamente" per the product requirement, never rejected).
select lives_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000003',array['f4000000-0000-4000-8000-000000000002']::uuid[])$$,
  'changing the primary category to one not in the additional list still succeeds'
);
select is((select category_id from public.products where id = 'f5000000-0000-4000-8000-000000000001'), 'f4000000-0000-4000-8000-000000000003'::uuid, 'the new primary category was applied');
select is((select count(*) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001' and category_id = 'f4000000-0000-4000-8000-000000000003'), 1::bigint, 'the new primary was auto-added to the assignment set');
select is((select count(*) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001'), 2::bigint, 'the stale Embutidos assignment was dropped, no leftover row');

-- Reconciliation is idempotent: calling it again with the same set doesn't create duplicates.
select lives_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000003',array['f4000000-0000-4000-8000-000000000002']::uuid[])$$,
  'calling set_product_categories again with the same set is a no-op'
);
select is((select count(*) from public.product_category_assignments where product_id = 'f5000000-0000-4000-8000-000000000001'), 2::bigint, 'still exactly 2 assignments, not duplicated');

-- A product must always resolve to at least one category (the primary itself, at minimum) — an
-- invalid/foreign primary category is rejected outright.
select throws_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',array[]::uuid[])$$,
  '22023', null, 'an invalid primary category is rejected'
);

-- RLS/tenant isolation: a category from another organization is silently filtered out of the
-- assignment set (never cross-linked), same as save_product/save_weight_discount elsewhere.
insert into public.organizations (id, name, slug) values ('f2000000-0000-4000-8000-000000000099', 'Other Category Org', 'category-other-org');
insert into public.categories (id, organization_id, name, slug) values ('f4000000-0000-4000-8000-000000000099', 'f2000000-0000-4000-8000-000000000099', 'Foreign Category', 'foreign-cat');
select lives_ok(
  $$select public.set_product_categories('f5000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000003',array['f4000000-0000-4000-8000-000000000002','f4000000-0000-4000-8000-000000000099']::uuid[])$$,
  'a foreign-org category id in the array does not error out the whole call'
);
select is((select count(*) from public.product_category_assignments where category_id = 'f4000000-0000-4000-8000-000000000099'), 0::bigint, 'the foreign-org category was never assigned');

-- Tabs: the category DIRECTORY (get_pos_categories) is independent of any product's principal.
-- At this point: Vacuno is the principal, Cerdo is secondary-only (never anyone's principal in
-- this test), Embutidos has zero assignments (dropped when the primary changed away from it).
select results_eq(
  $$select name from public.get_pos_categories('f3000000-0000-4000-8000-000000000001') order by name$$,
  array['Cerdo', 'Vacuno'],
  'the directory includes a secondary-only category and excludes an entirely unused one'
);

reset role;
select * from finish();
rollback;
