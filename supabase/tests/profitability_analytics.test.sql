begin;

create extension if not exists pgtap with schema extensions;
select plan(22);

select has_function('public', 'get_profitability_analytics', array['text','date','date','uuid','uuid','uuid'], 'profitability RPC exists');
select ok((select prosecdef from pg_proc where oid = 'public.get_profitability_analytics(text,date,date,uuid,uuid,uuid)'::regprocedure), 'profitability RPC is security definer');
select ok(not has_function_privilege('anon', 'public.get_profitability_analytics(text,date,date,uuid,uuid,uuid)', 'EXECUTE'), 'anonymous cannot read profitability');
select ok(exists (select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000001' and permission_key = 'analytics.read'), 'admin receives analytics permission');
select ok(not exists (select 1 from public.role_permissions where role_id = '10000000-0000-4000-8000-000000000002' and permission_key = 'analytics.read'), 'employee receives no analytics permission');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'analytics-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Analytics Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'analytics-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Analytics Employee"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values ('a2000000-0000-4000-8000-000000000001', 'Analytics Org', 'analytics-org');
insert into public.branches (id, organization_id, name, code) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Centro', 'A-CENTRO'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'Norte', 'A-NORTE');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Vacunos', 'analytics-vacunos');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Filet', 'analytics-filet', 'A-FILET', 'WEIGHT'),
  ('a5000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Morcilla', 'analytics-morcilla', 'A-MORCILLA', 'WEIGHT'),
  ('a5000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Legacy', 'analytics-legacy', 'A-LEGACY', 'WEIGHT');

insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at) values
  ('a6000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'COMPLETED', 150000000, 100000, now() - interval '1 day'),
  ('a6000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'COMPLETED', 70000000, 50000, now() - interval '1 day'),
  ('a6000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'COMPLETED', 10000000, 10000, now() - interval '1 day'),
  ('a6000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'DRAFT', 999000000, 1000, null);
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot) values
  ('a6000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'Filet', 100000, 1500000, 1500000, 1500000, 150000000, 1350000),
  ('a6000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000002', 'Morcilla', 50000, 1400000, 1400000, 1400000, 70000000, 800000),
  ('a6000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003', 'Legacy', 10000, 1000000, 1000000, 1000000, 10000000, null),
  ('a6000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'Filet', 1000, 999000000, 999000000, 999000000, 999000000, 1);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is((public.get_profitability_analytics('7d') -> 'summary' ->> 'revenueCents')::bigint, 230000000::bigint, 'revenue uses final completed sale subtotals');
select is((public.get_profitability_analytics('7d') -> 'summary' ->> 'costedRevenueCents')::bigint, 220000000::bigint, 'covered revenue excludes legacy items without cost');
select is((public.get_profitability_analytics('7d') -> 'summary' ->> 'costCents')::bigint, 175000000::bigint, 'cost uses historical item snapshots');
select is((public.get_profitability_analytics('7d') -> 'summary' ->> 'grossProfitCents')::bigint, 45000000::bigint, 'gross profit is final revenue minus historical merchandise cost');
select is((public.get_profitability_analytics('7d') -> 'summary' ->> 'coverageBps')::integer, 9565, 'coverage reports the share of revenue with historical cost');
select is((public.get_profitability_analytics('7d') -> 'summary' ->> 'weightGrams')::bigint, 160000::bigint, 'weight and draft exclusion remain exact');
select is((select (row ->> 'revenueCents')::bigint from jsonb_array_elements(public.get_profitability_analytics('7d') -> 'products') row where row ->> 'productName' = 'Filet'), 150000000::bigint, 'Filet revenue is final revenue');
select is((select (row ->> 'grossProfitCents')::bigint from jsonb_array_elements(public.get_profitability_analytics('7d') -> 'products') row where row ->> 'productName' = 'Filet'), 15000000::bigint, 'Filet gross profit is exact');
select is((select (row ->> 'profitabilityBps')::integer from jsonb_array_elements(public.get_profitability_analytics('7d') -> 'products') row where row ->> 'productName' = 'Filet'), 1111, 'Filet profitability is 11.11 percent');
select is((select (row ->> 'profitPerMeasureCents')::bigint from jsonb_array_elements(public.get_profitability_analytics('7d') -> 'products') row where row ->> 'productName' = 'Filet'), 150000::bigint, 'Filet leaves 1500 pesos per kg');
select is((select (row ->> 'revenueCents')::bigint from jsonb_array_elements(public.get_profitability_analytics('7d') -> 'products') row where row ->> 'productName' = 'Morcilla'), 70000000::bigint, 'Morcilla revenue is exact');
select is((select (row ->> 'grossProfitCents')::bigint from jsonb_array_elements(public.get_profitability_analytics('7d') -> 'products') row where row ->> 'productName' = 'Morcilla'), 30000000::bigint, 'Morcilla gross profit exceeds Filet');
select is((select (row ->> 'profitabilityBps')::integer from jsonb_array_elements(public.get_profitability_analytics('7d') -> 'products') row where row ->> 'productName' = 'Morcilla'), 7500, 'Morcilla profitability is 75 percent');
select is((select (row ->> 'profitPerMeasureCents')::bigint from jsonb_array_elements(public.get_profitability_analytics('7d') -> 'products') row where row ->> 'productName' = 'Morcilla'), 600000::bigint, 'Morcilla leaves 6000 pesos per kg');
select is((select row ->> 'grossProfitCents' from jsonb_array_elements(public.get_profitability_analytics('7d') -> 'products') row where row ->> 'productName' = 'Legacy'), null, 'legacy product does not invent gross profit');
select is((public.get_profitability_analytics('7d', null, null, 'a3000000-0000-4000-8000-000000000002') -> 'summary' ->> 'revenueCents')::bigint, 70000000::bigint, 'branch filter is applied in SQL');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select throws_ok($$select public.get_profitability_analytics('7d')$$, '42501', 'Permission analytics.read is required', 'employee cannot read profitability');

reset role;
select * from finish();
rollback;
