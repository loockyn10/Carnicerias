begin;

create extension if not exists pgtap with schema extensions;
select plan(55);

-- Covers 202611180107 (D-103): descarga incremental de las piezas Feed de las promociones.
--   * el estado trae las promociones activas de la sucursal de Cartelería (Central o la primera activa), resueltas por el resolvedor compartido,
--     cada una con lo último descargado (firma, resumen, tanda); al principio TODAS están pendientes (sin registro);
--   * registrar guarda la firma por promoción (reemplaza la anterior), agrupa por tanda, ignora otra organización, valida la entrada;
--   * «la última tanda» devuelve sólo esas promociones; permisos y aislamiento por organización; sin imágenes en la base.
-- Org A: sucursales «Avenida» y «Central»; Org B con una sucursal.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pf-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PF Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pf-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PF Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pf-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PF Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('a2000000-0000-4000-8000-000000000001', 'PF Org', 'pf-org'),
  ('a2000000-0000-4000-8000-000000000002', 'PF Org B', 'pf-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Avenida', 'PF-A'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'Central', 'PF-C'),
  ('a3000000-0000-4000-8000-000000000009', 'a2000000-0000-4000-8000-000000000002', 'PF B Branch', 'PF-B');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002');
insert into public.categories (id, organization_id, name, slug, active) values
  ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Varios', 'pf-varios', true),
  ('a4000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000002', 'Varios B', 'pf-varios-b', true);
-- 01 Pata muslo (kg $10.000), 02 Coca (u $2.000), 03 Costilla (kg $8.000; en Central $8.500), 04 Matambre (kg $12.000), 05 Chorizo (u, NO se vende en Central), 09 org B.
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type, active, inventory_role) values
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Pata muslo', 'pf-pata', 'PF-01', 'WEIGHT', true, 'SELLABLE'),
  ('a5000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Coca Cola', 'pf-coca', 'PF-02', 'UNIT', true, 'SELLABLE'),
  ('a5000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Costilla de cerdo', 'pf-costilla', 'PF-03', 'WEIGHT', true, 'SELLABLE'),
  ('a5000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Matambre', 'pf-matambre', 'PF-04', 'WEIGHT', true, 'SELLABLE'),
  ('a5000000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Chorizo', 'pf-chorizo', 'PF-05', 'UNIT', true, 'SELLABLE'),
  ('a5000000-0000-4000-8000-000000000009', 'a2000000-0000-4000-8000-000000000002', 'a4000000-0000-4000-8000-000000000002', 'Producto de otra org', 'pfb-otra', 'PFB-09', 'WEIGHT', true, 'SELLABLE');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where not (b.id = 'a3000000-0000-4000-8000-000000000002' and p.id = 'a5000000-0000-4000-8000-000000000005');
insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from) values
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', null, 1000000, now() - interval '5 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', null, 200000, now() - interval '5 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003', null, 800000, now() - interval '5 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000002', 850000, now() - interval '5 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000004', null, 1200000, now() - interval '5 day'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000005', null, 150000, now() - interval '5 day'),
  ('a2000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000009', null, 500000, now() - interval '5 day');
insert into public.product_artwork_photos (product_id, organization_id, storage_path, content_type, size_bytes) values
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001/a5000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png', 'image/png', 1200);

-- Promociones:
--   P1 Pata muslo umbral 10 % desde 2 kg (global)        P5 Chorizo pack 6 u (global; Chorizo no está en Central)
--   P2 Costilla pack 2 kg por $14.000 (sólo Central)     P6 Pata muslo pack VENCIDA        P7 Matambre pack PRÓXIMA
--   P3 Coca pack 3 u por $5.400 (global)                 P8 Costilla 5 % desde 3 kg (sólo Avenida)
--   P4 Matambre umbral $11.000/kg desde 1 kg (global)    P9 otra organización
insert into public.product_weight_discounts (id, organization_id, product_id, branch_id, minimum_grams, discount_type, discount_value, promotion_mode, pack_quantity_grams, pack_quantity_units, pack_price_cents, valid_from, valid_until) values
  ('a6000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', null, 2000, 'PERCENTAGE', 1000, 'THRESHOLD', null, null, null, now() - interval '1 day', null),
  ('a6000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000004', null, 1000, 'FIXED_PRICE_PER_KG', 1100000, 'THRESHOLD', null, null, null, now() - interval '1 day', null),
  ('a6000000-0000-4000-8000-000000000008', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000001', 3000, 'PERCENTAGE', 500, 'THRESHOLD', null, null, null, now() - interval '1 day', null);
insert into public.product_weight_discounts (id, organization_id, product_id, branch_id, promotion_mode, pack_quantity_grams, pack_quantity_units, pack_price_cents, valid_from, valid_until) values
  ('a6000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000002', 'PACK_FIXED_TOTAL', 2000, null, 1400000, now() - interval '1 day', null),
  ('a6000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', null, 'PACK_FIXED_TOTAL', null, 3, 540000, now() - interval '1 day', null),
  ('a6000000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000005', null, 'PACK_FIXED_TOTAL', null, 6, 800000, now() - interval '1 day', null),
  ('a6000000-0000-4000-8000-000000000006', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', null, 'PACK_FIXED_TOTAL', 5000, null, 4500000, now() - interval '10 day', now() - interval '1 day'),
  ('a6000000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000004', null, 'PACK_FIXED_TOTAL', 3000, null, 3000000, now() + interval '2 day', null),
  ('a6000000-0000-4000-8000-000000000009', 'a2000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000009', null, 'PACK_FIXED_TOTAL', 1000, null, 400000, now() - interval '1 day', null);

-- «nombre:motivo:firma(4)» por elemento del estado, en orden.
create function public.t_pf(p_ids uuid[] default null, p_last boolean default false) returns text language sql stable as $$
  select coalesce(string_agg((s ->> 'name') || ':' || coalesce(s ->> 'unavailableReason', 'OK') || ':' || coalesce(left(s -> 'downloaded' ->> 'signature', 4), '-'), ' | ' order by ord), '')
  from jsonb_array_elements(public.get_promotion_feed_state(p_ids, p_last) -> 'items') with ordinality as t(s, ord) $$;
create function public.t_pf_item(p_id uuid) returns jsonb language sql stable as $$
  select s from jsonb_array_elements(public.get_promotion_feed_state() -> 'items') s where s ->> 'entryId' = p_id::text $$;
create function public.t_pf_sig(p_char text) returns text language sql immutable as $$ select repeat(p_char, 64) $$;
create function public.t_pf_row(p_id uuid) returns text language sql stable security definer as $$
  select d.price_signature || '|' || coalesce(d.price_summary, '-') || '|' || d.batch_id::text || '|' || coalesce(d.downloaded_by::text, '-')
  from public.promotion_feed_downloads d where d.promotion_id = p_id $$;
grant execute on function public.t_pf(uuid[], boolean), public.t_pf_item(uuid), public.t_pf_sig(text), public.t_pf_row(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select ok(to_regclass('public.promotion_feed_downloads') is not null, 'there is a per-promotion download record');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'promotion_feed_downloads' and column_name ~ 'png|image|bytes|file|data|path|url'),
  'the record stores NO image, file or path: only the price signature');
select ok((select relrowsecurity from pg_class where oid = 'public.promotion_feed_downloads'::regclass), 'RLS is enabled');
select ok(not has_table_privilege('anon', 'public.promotion_feed_downloads', 'SELECT'), 'anonymous cannot read the record');
select ok(not has_table_privilege('authenticated', 'public.promotion_feed_downloads', 'INSERT')
  and not has_table_privilege('authenticated', 'public.promotion_feed_downloads', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.promotion_feed_downloads', 'DELETE'), 'nobody writes the table directly');
select ok(not has_function_privilege('anon', 'public.get_promotion_feed_state(uuid[],boolean)', 'EXECUTE'), 'anonymous cannot read the feed state');
select ok(not has_function_privilege('anon', 'public.record_promotion_feed_downloads(uuid,jsonb)', 'EXECUTE'), 'anonymous cannot record downloads');
select ok(not has_function_privilege('authenticated', 'app_private.promotion_feed_branch(uuid)', 'EXECUTE'), 'the branch helper is private');

-- ---------------------------------------------------------------------------------------------
-- Primera vez: todas las activas de Central, pendientes
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is(public.get_promotion_feed_state() ->> 'branchName', 'Central', 'the branch is «Central» even if another active branch sorts first');
select is(public.t_pf(),
  'Chorizo:NOT_IN_BRANCH:- | Coca Cola:OK:- | Costilla de cerdo:OK:- | Matambre:OK:- | Pata muslo:OK:-',
  'state = active promotions global or of Central (no expired, upcoming, other branch or other org), by product name, none downloaded yet');
select is(public.get_promotion_feed_state() -> 'lastBatch', 'null'::jsonb, 'no batch yet');
select is(public.t_pf_item('a6000000-0000-4000-8000-000000000002') ->> 'listPriceCents', '850000', 'the facts carry Central''s price (branch price wins)');
select is(public.t_pf_item('a6000000-0000-4000-8000-000000000002') -> 'promotion' ->> 'packPriceCents', '1400000', 'and the promotion facts the engine needs');
select is(public.t_pf_item('a6000000-0000-4000-8000-000000000001') -> 'photo' ->> 'storagePath',
  'a2000000-0000-4000-8000-000000000001/a5000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001.png', 'and the photo reference');
select is((public.t_pf_item('a6000000-0000-4000-8000-000000000003') ->> 'position')::integer, 2, 'positions follow the product name order');

-- ---------------------------------------------------------------------------------------------
-- Registrar
-- ---------------------------------------------------------------------------------------------
select is(public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000001', jsonb_build_array(
  jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000001', 'signature', public.t_pf_sig('a'), 'summary', '$ 9.000 / kg · desde 2 kg'),
  jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000003', 'signature', public.t_pf_sig('a')))), 2, 'two downloads recorded');
select is(public.t_pf(),
  'Chorizo:NOT_IN_BRANCH:- | Coca Cola:OK:aaaa | Costilla de cerdo:OK:- | Matambre:OK:- | Pata muslo:OK:aaaa',
  'the state carries the recorded signature of each downloaded promotion');
select is(public.t_pf_row('a6000000-0000-4000-8000-000000000001'),
  public.t_pf_sig('a') || '|$ 9.000 / kg · desde 2 kg|b0000000-0000-4000-8000-000000000001|a1000000-0000-4000-8000-000000000001',
  'the record keeps signature, summary, batch and who downloaded');
select is(public.get_promotion_feed_state() -> 'lastBatch' ->> 'batchId', 'b0000000-0000-4000-8000-000000000001', 'the last batch is the one just recorded');
select is((public.get_promotion_feed_state() -> 'lastBatch' ->> 'count')::integer, 2, 'with its two promotions');
select is(public.t_pf(null, true), 'Coca Cola:OK:aaaa | Pata muslo:OK:aaaa', '«last batch» returns exactly those promotions');

-- Una tanda que llega en dos pedidos sigue siendo UNA tanda.
select is(public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000002', jsonb_build_array(
  jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000004', 'signature', public.t_pf_sig('b')))), 1, 'first part of batch 2');
select is(public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000002', jsonb_build_array(
  jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000001', 'signature', public.t_pf_sig('c'), 'summary', null))), 1, 'second part of batch 2 (re-download of P1)');
select is(public.t_pf(null, true), 'Matambre:OK:bbbb | Pata muslo:OK:cccc', 'the last batch has both parts; P1 moved to the new batch');
select is(public.t_pf_row('a6000000-0000-4000-8000-000000000001'),
  public.t_pf_sig('c') || '|-|b0000000-0000-4000-8000-000000000002|a1000000-0000-4000-8000-000000000001', 'a new download REPLACES the previous version');
select is((select count(*)::integer from public.promotion_feed_downloads), 3, 'one row per promotion (the admin reads the org''s rows)');

-- Repetida en el mismo pedido: vale la última; sin error.
select is(public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000002', jsonb_build_array(
  jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000003', 'signature', public.t_pf_sig('d')),
  jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000003', 'signature', public.t_pf_sig('e')))), 1, 'a promotion repeated in one call is recorded once');
select is(left(public.t_pf_row('a6000000-0000-4000-8000-000000000003'), 4), 'eeee', 'with the last signature sent');

-- Otra organización: se ignora, no rompe ni revela.
select is(public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000003', jsonb_build_array(
  jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000009', 'signature', public.t_pf_sig('f')))), 0, 'another org''s promotion is ignored');
select is(public.t_pf_row('a6000000-0000-4000-8000-000000000009'), null, 'and nothing is written for it');

-- Validación
select throws_ok($$select public.record_promotion_feed_downloads(null, '[{"promotionId":"a6000000-0000-4000-8000-000000000001","signature":"aaaa"}]')$$, '22023', null, 'a batch is required');
select throws_ok($$select public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000004', '[]')$$, '22023', null, 'an empty list is rejected');
select throws_ok($$select public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000004', '{"promotionId":"a6000000-0000-4000-8000-000000000001"}')$$, '22023', null, 'a non-array is rejected');
select throws_ok(format($$select public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000004', %L)$$,
  (select jsonb_agg(jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000001', 'signature', repeat('a', 64))) from generate_series(1, 101))::text), '22023', null, 'more than 100 items are rejected');
select throws_ok($$select public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000004', '[{"promotionId":"a6000000-0000-4000-8000-000000000001","signature":"ABC"}]')$$, '22023', null, 'a malformed signature is rejected');
select throws_ok(format($$select public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000004', %L)$$,
  jsonb_build_array(jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000001', 'signature', upper(repeat('a', 64))))::text), '22023', null, 'the signature must be lowercase hex');
select throws_ok($$select public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000004', '[{"promotionId":"no-uuid","signature":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]')$$, '22023', null, 'a malformed promotion id is rejected');
select throws_ok(format($$select public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000004', %L)$$,
  jsonb_build_array(jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000001', 'signature', repeat('a', 64), 'summary', repeat('x', 201)))::text), '22023', null, 'a summary over 200 characters is rejected');
select throws_ok(format($$select public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000004', %L)$$,
  jsonb_build_array(jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000001', 'signature', repeat('a', 64), 'summary', 5))::text), '22023', null, 'a non-text summary is rejected');
select is(left(public.t_pf_row('a6000000-0000-4000-8000-000000000001'), 4), 'cccc', 'a rejected call changes nothing');

-- Promociones pedidas por id: vienen con su estado de HOY (la ruta del PNG vuelve a comprobarlo).
select is(public.t_pf(array['a6000000-0000-4000-8000-000000000006', 'a6000000-0000-4000-8000-000000000008', 'a6000000-0000-4000-8000-000000000003']::uuid[]),
  'Coca Cola:OK:eeee | Costilla de cerdo:NOT_IN_BRANCH:- | Pata muslo:PROMO_EXPIRED:-', 'asked by id: the expired and the other-branch promotion come flagged');
select is(public.t_pf(array['a6000000-0000-4000-8000-000000000009']::uuid[]), '', 'another org''s promotion is never returned');
select throws_ok(format($$select public.get_promotion_feed_state(%L::uuid[])$$, (select array_agg(extensions.gen_random_uuid()) from generate_series(1, 201))::text),
  '22023', null, 'at most 200 ids per request');

-- ---------------------------------------------------------------------------------------------
-- Permisos y aislamiento
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000005', '[{"promotionId":"a6000000-0000-4000-8000-000000000001","signature":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]')$$,
  '42501', null, 'an employee (no catalog.write) cannot record downloads');

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(public.t_pf(), 'Producto de otra org:OK:-', 'org B only sees its own promotion, still pending');
select is((select count(*)::integer from public.promotion_feed_downloads), 0, 'org B reads none of org A''s records');
select is(public.record_promotion_feed_downloads('b0000000-0000-4000-8000-000000000006', jsonb_build_array(
  jsonb_build_object('promotionId', 'a6000000-0000-4000-8000-000000000001', 'signature', public.t_pf_sig('9')))), 0, 'org B cannot record org A''s promotion');
select is(public.get_promotion_feed_state() -> 'lastBatch', 'null'::jsonb, 'org B has no batch');

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(left(public.t_pf_row('a6000000-0000-4000-8000-000000000001'), 4), 'cccc', 'org A''s record is untouched');

-- ---------------------------------------------------------------------------------------------
-- Sucursal y ciclo de vida
-- ---------------------------------------------------------------------------------------------
reset role;
update public.branches set active = false where id = 'a3000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(public.get_promotion_feed_state() ->> 'branchName', 'Avenida', 'without an active Central, the first active branch by name');
select is(public.t_pf(),
  'Chorizo:OK:- | Coca Cola:OK:eeee | Costilla de cerdo:OK:- | Matambre:OK:bbbb | Pata muslo:OK:cccc',
  'Avenida: its own promotion (P8) instead of Central''s, and Chorizo is sold there');
reset role;
update public.branches set active = false where organization_id = 'a2000000-0000-4000-8000-000000000001';
set local role authenticated;
select is(public.get_promotion_feed_state() ->> 'branchId', null, 'no active branch: general prices');
select is(public.t_pf(), 'Chorizo:OK:- | Coca Cola:OK:eeee | Matambre:OK:bbbb | Pata muslo:OK:cccc', 'and only global promotions');
reset role;
update public.branches set active = true where organization_id = 'a2000000-0000-4000-8000-000000000001';

-- Una promoción borrada se lleva su registro.
delete from public.product_weight_discounts where id = 'a6000000-0000-4000-8000-000000000003';
select is((select count(*)::integer from public.promotion_feed_downloads where promotion_id = 'a6000000-0000-4000-8000-000000000003'), 0, 'deleting a promotion deletes its record');
select is((select count(*)::integer from public.promotion_feed_downloads), 2, 'the others stay');

select * from finish();
rollback;
