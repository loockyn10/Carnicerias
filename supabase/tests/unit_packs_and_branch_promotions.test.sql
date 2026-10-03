begin;

create extension if not exists pgtap with schema extensions;
select plan(150);

-- Covers 202610030060: pack de productos UNIT (20 % de descuento, unidades reales), promoción global por sucursal
-- ("cada 3 unidades, 15 %"), sus snapshots en sale_items, la revalidación del servidor de líneas que llegan del POS
-- (online/offline comparten sync_offline_sale) y la entrega al POS (pull_pos_state).
-- Fixture: Central (sucursal productiva) y Avenida, admin + empleado con acceso a ambas, Leche (UNIT $1.000, pack de 8),
-- Coca Cola (UNIT $1.200, sin pack) y Vacío (WEIGHT $15.000/kg). Todo el dinero en centavos.

select has_column('public', 'products', 'pack_size_units', 'products.pack_size_units exists');
select has_table('public', 'branch_promotions', 'branch_promotions exists');
select has_column('public', 'sale_items', 'sold_as_pack', 'sale_items.sold_as_pack exists');
select has_column('public', 'sale_items', 'pack_size_units_snapshot', 'sale_items.pack_size_units_snapshot exists');
select has_column('public', 'sale_items', 'pack_count', 'sale_items.pack_count exists');
select has_column('public', 'sale_items', 'pack_discount_bps', 'sale_items.pack_discount_bps exists');
select has_column('public', 'sale_items', 'pack_discount_cents', 'sale_items.pack_discount_cents exists');
select has_column('public', 'sale_items', 'branch_promotion_id', 'sale_items.branch_promotion_id exists');
select is(app_private.pack_discount_bps(), 2000, 'the pack discount is 20 % (2000 bps)');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pk-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PK Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pk-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"PK Employee"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values ('a2000000-0000-4000-8000-000000000001', 'PK Org', 'pk-org');
insert into public.branches (id, organization_id, name, code) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'PK Central', 'PK-C'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'PK Avenida', 'PK-A');
update public.organizations set production_branch_id = 'a3000000-0000-4000-8000-000000000001' where id = 'a2000000-0000-4000-8000-000000000001';
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002');
insert into public.categories (id, organization_id, name, slug) values
  ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'PK Category', 'pk-category');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Leche', 'pk-leche', 'PK-1', 'UNIT'),
  ('a5000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'pk-coca', 'PK-2', 'UNIT'),
  ('a5000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Vacío', 'pk-vacio', 'PK-3', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where p.organization_id = 'a2000000-0000-4000-8000-000000000001';
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 100000, '2026-01-01T00:00:00Z'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 120000, '2026-01-01T00:00:00Z'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003', 1500000, '2026-01-01T00:00:00Z');

-- Helpers del test: la línea del ticket tal como la arma el POS (cálculo independiente en numeric) y el payload de sync.
create function public.t_pk_item(
  p_product uuid, p_name text, p_qty integer, p_list bigint, p_kind text default 'NONE', p_card_bps integer default 0,
  p_pack_size integer default null, p_promo uuid default null, p_every integer default null, p_promo_bps integer default null
) returns jsonb language plpgsql security definer as $$
declare units integer := p_qty; discounted integer := 0; bps integer := 0; disc bigint := 0; cash bigint; sub bigint; fin bigint; res jsonb;
begin
  if p_kind = 'PACK' then units := p_qty * p_pack_size; discounted := units; bps := 2000;
  elsif p_kind = 'PROMO' then discounted := (units / p_every) * p_every; bps := p_promo_bps;
  end if;
  disc := round(p_list::numeric * discounted * bps / 10000)::bigint;
  cash := p_list * units - disc;
  if discounted = 0 then
    fin := case when p_card_bps > 0 then round(p_list::numeric * (10000 + p_card_bps) / 10000)::bigint else p_list end;
    sub := fin * units;
  else
    sub := case when p_card_bps > 0 then round(cash::numeric * (10000 + p_card_bps) / 10000)::bigint else cash end;
    fin := round(sub::numeric / units)::bigint;
  end if;
  res := jsonb_build_object(
    'productId', p_product, 'productNameSnapshot', p_name, 'quantityUnits', units,
    'pricePerKgCents', fin::text, 'originalPricePerKgCents', p_list::text,
    'discountCents', disc::text, 'cashDiscountBps', p_card_bps::text, 'cashDiscountCents', '0',
    'cardSurchargeCents', (sub - (p_list * units - disc))::text, 'promotionDiscountCents', disc::text, 'subtotalCents', sub::text);
  if p_kind = 'PACK' then
    res := res || jsonb_build_object('soldAsPack', true, 'packCount', p_qty, 'packSizeUnitsSnapshot', p_pack_size, 'packDiscountBps', 2000, 'packDiscountCents', disc::text,
      'packConfigId', (select v.id from public.product_pack_versions v where v.product_id = p_product and v.pack_size_units = p_pack_size order by v.valid_to nulls first limit 1));
  elsif p_kind = 'PROMO' and discounted > 0 then
    res := res || jsonb_build_object('branchPromotionId', p_promo, 'branchPromotionEveryUnits', p_every, 'branchPromotionDiscountBps', p_promo_bps,
      'branchPromotionDiscountedUnits', discounted, 'branchPromotionDiscountCents', disc::text);
  end if;
  return res;
end $$;

create function public.t_pk_weight_item(p_product uuid, p_name text, p_grams integer, p_list bigint) returns jsonb language sql as $$
  select jsonb_build_object('productId', p_product, 'productNameSnapshot', p_name, 'weightGrams', p_grams, 'pricePerKgCents', p_list::text,
    'originalPricePerKgCents', p_list::text, 'discountCents', '0', 'cashDiscountBps', '0', 'cashDiscountCents', '0', 'cardSurchargeCents', '0',
    'promotionDiscountCents', '0', 'subtotalCents', round(p_list::numeric * p_grams / 1000)::bigint::text) $$;

create function public.t_pk_payload(p_seq integer, p_branch uuid, p_device uuid, p_items jsonb, p_method text default 'CASH', p_bps integer default 0, p_discount bigint default 0)
returns jsonb language plpgsql as $$
declare
  base text := 'a6000000-0000-4000-8000-';
  items jsonb := '[]'; moves jsonb := '[]'; item jsonb; idx integer := 0; subtotal bigint := 0; weight bigint := 0; total bigint;
  at timestamptz := now() - interval '1 minute';
begin
  for item in select value from jsonb_array_elements(p_items) loop
    idx := idx + 1;
    item := item || jsonb_build_object('id', base || lpad((p_seq * 1000 + 100 + idx)::text, 12, '0'));
    items := items || jsonb_build_array(item);
    subtotal := subtotal + (item->>'subtotalCents')::bigint;
    weight := weight + coalesce((item->>'weightGrams')::bigint, 0);
    moves := moves || jsonb_build_array(jsonb_build_object(
      'id', base || lpad((p_seq * 1000 + 200 + idx)::text, 12, '0'), 'productId', item->>'productId',
      'quantityGrams', (-coalesce((item->>'weightGrams')::bigint, (item->>'quantityUnits')::bigint))::text, 'occurredAt', at));
  end loop;
  total := subtotal - p_discount;
  return jsonb_build_object(
    'schemaVersion', 1, 'eventId', base || lpad((p_seq * 1000 + 1)::text, 12, '0'), 'saleId', base || lpad((p_seq * 1000 + 2)::text, 12, '0'),
    'organizationId', 'a2000000-0000-4000-8000-000000000001', 'branchId', p_branch, 'profileId', 'a1000000-0000-4000-8000-000000000002',
    'deviceId', p_device, 'status', 'COMPLETED', 'totalCents', total::text, 'totalWeightGrams', weight::text, 'createdAt', at, 'completedAt', at,
    'items', items,
    'payment', jsonb_build_object('id', base || lpad((p_seq * 1000 + 3)::text, 12, '0'), 'method', p_method, 'amountCents', total::text),
    'stockMovements', moves
  ) || case when p_bps > 0 then jsonb_build_object('ticketDiscountBps', p_bps::text, 'ticketDiscountCents', p_discount::text, 'subtotalCents', subtotal::text) else '{}'::jsonb end;
end $$;

create function public.t_pk_sale(p_seq integer) returns uuid language sql immutable as $$
  select ('a6000000-0000-4000-8000-' || lpad((p_seq * 1000 + 2)::text, 12, '0'))::uuid $$;
create function public.t_pk_sync(p_device uuid, p_payload jsonb) returns jsonb language sql as $$
  select public.sync_offline_sale(p_device, (p_payload->>'eventId')::uuid, p_payload) $$;
-- Id de la versión del pack de un producto (la vigente, o la del tamaño dado); definer porque el empleado no lee la tabla.
create function public.t_pk_version_id(p_product uuid, p_size integer default null) returns uuid language sql security definer as $$
  select v.id from public.product_pack_versions v
  where v.product_id = p_product and (p_size is null and v.valid_to is null or v.pack_size_units = p_size)
  order by v.valid_to nulls first limit 1 $$;
-- Central = a7...01, Avenida = a7...02.

-- ---------------------------------------------------------------------------------------------
-- 1. Unidades por pack (products.pack_size_units)
-- ---------------------------------------------------------------------------------------------
select is((select pack_size_units from public.products where sku = 'PK-1'), null::integer, 'a product starts without a pack');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 8)$$, 'Admin sets 8 units per pack on a UNIT product');
select is((select pack_size_units from public.products where sku = 'PK-1'), 8, 'the pack size is stored');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000003', 8)$$, '22023', null, 'a WEIGHT product cannot have a pack');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 1)$$, '22023', null, 'a pack needs at least 2 units');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 0)$$, '22023', null, 'zero is not a pack size');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', -3)$$, '22023', null, 'a negative pack size is rejected');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 10001)$$, '22023', null, 'an absurd pack size is rejected');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-0000000000ff', 8)$$, '42501', null, 'an unknown product is rejected');
select is((select pack_size_units from public.products where sku = 'PK-1'), 8, 'failed attempts left the pack size alone');
reset role;
select throws_ok($$update public.products set pack_size_units = 6 where sku = 'PK-3'$$, '23514', null, 'the table itself refuses a pack on a WEIGHT product');
select throws_ok($$update public.products set unit_type = 'WEIGHT' where sku = 'PK-1'$$, '23514', null, 'a product with a pack cannot be turned into a WEIGHT product while the pack exists');
set local role authenticated;

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 12)$$, '42501', null, 'an employee cannot change a pack');
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- 2. Promociones por sucursal (branch_promotions)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.save_branch_promotion('a3000000-0000-4000-8000-000000000001', 3, 1500)$$, 'Admin creates "cada 3, 15 %" for Central');
create temp table promo_ids(name text primary key, id uuid);
grant all on promo_ids to authenticated;
insert into promo_ids select 'central', id from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000001' and active;
select is((select every_units || '/' || discount_bps || '/' || scope from public.branch_promotions where id = (select id from promo_ids where name = 'central')), '3/1500/ALL_UNIT_PRODUCTS', 'the rule is stored with its scope');
select is(public.save_branch_promotion('a3000000-0000-4000-8000-000000000001', 3, 1500), (select id from promo_ids where name = 'central'), 'saving the same values again returns the same row (no new version)');
select is((select count(*) from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000001'), 1::bigint, 'no duplicate row was written');
select lives_ok($$select public.save_branch_promotion('a3000000-0000-4000-8000-000000000002', 2, 1000)$$, 'Avenida gets its own, different promotion');
insert into promo_ids select 'avenida', id from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000002' and active;
select throws_ok($$select public.save_branch_promotion('a3000000-0000-4000-8000-000000000001', 1, 1500)$$, '22023', null, 'a group of 1 is not a promotion');
select throws_ok($$select public.save_branch_promotion('a3000000-0000-4000-8000-000000000001', 3, 0)$$, '22023', null, '0 % is not a promotion');
select throws_ok($$select public.save_branch_promotion('a3000000-0000-4000-8000-000000000001', 3, 10000)$$, '22023', null, '100 % is not allowed (the line would be free)');
select throws_ok($$select public.save_branch_promotion('a3000000-0000-4000-8000-0000000000ff', 3, 1500)$$, '42501', null, 'an unknown branch is rejected');
select throws_ok($$insert into public.branch_promotions (organization_id, branch_id, every_units, discount_bps) values ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 4, 500)$$, '42501', null, 'the table is not writable by clients, only through the RPC');

-- Editar cierra la vigente y crea otra (historial inmutable); el id viejo conserva sus valores.
select lives_ok($$select public.save_branch_promotion('a3000000-0000-4000-8000-000000000001', 4, 2000)$$, 'editing the Central promotion to "cada 4, 20 %" works');
select is((select count(*) from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000001'), 2::bigint, 'the edit kept the old version as history');
select is((select count(*) from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000001' and active), 1::bigint, 'exactly one version is active');
select is((select every_units from public.branch_promotions where id = (select id from promo_ids where name = 'central')), 3, 'the closed version keeps its original values (a past sale can still be validated against it)');
select is((select active from public.branch_promotions where id = (select id from promo_ids where name = 'central')), false, 'the old version is closed');
select lives_ok($$select public.save_branch_promotion('a3000000-0000-4000-8000-000000000001', 3, 1500)$$, 'going back to "cada 3, 15 %"...');
insert into promo_ids select 'central2', id from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000001' and active;
select isnt((select id from promo_ids where name = 'central2'), (select id from promo_ids where name = 'central'), '...creates a NEW version instead of reopening the old one');
select is((select count(*) from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000001' and active), 1::bigint, 'still exactly one active promotion for Central');
select is((select every_units from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000002' and active), 2, 'the other branch promotion is independent');

-- ---------------------------------------------------------------------------------------------
-- 3. Entrega al POS (pull_pos_state)
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.register_pos_device('a7000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'Caja Central')$$, 'the Central device is registered');
select lives_ok($$select public.register_pos_device('a7000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000002', 'Caja Avenida')$$, 'the Avenida device is registered');
select is(
  (select (i ->> 'packSizeUnits')::int from jsonb_array_elements(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Leche'),
  8, 'the catalog item carries packSizeUnits'
);
select is(
  (select i -> 'packSizeUnits' from jsonb_array_elements(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Coca Cola 2.25 L'),
  'null'::jsonb, 'a product without pack carries a null packSizeUnits'
);
select is(
  public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'branchPromotions',
  jsonb_build_array(jsonb_build_object('id', (select id from promo_ids where name = 'central2'), 'scope', 'ALL_UNIT_PRODUCTS', 'everyUnits', 3, 'discountBps', 1500)),
  'the Central device receives exactly the active Central promotion'
);
select is(
  public.pull_pos_state('a7000000-0000-4000-8000-000000000002', 0) -> 'branchPromotions',
  jsonb_build_array(jsonb_build_object('id', (select id from promo_ids where name = 'avenida'), 'scope', 'ALL_UNIT_PRODUCTS', 'everyUnits', 2, 'discountBps', 1000)),
  'the Avenida device receives its own promotion, never Central''s'
);
select ok(jsonb_array_length(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 999999999) -> 'branchPromotions') = 1, 'the promotions travel as a full snapshot on every pull, even an incremental one with no catalog changes');

-- ---------------------------------------------------------------------------------------------
-- 4. Ventas (Central): la promoción de sucursal sobre unidades reales del MISMO producto
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(1, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 3, 100000, 'PROMO', 0, null, (select id from promo_ids where name = 'central2'), 3, 1500))))$$,
  '3 units of Leche: cada 3, 15 % syncs');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(1)), 255000::bigint, '3 × $1.000 with 15 % off = $2.550');
select is((select promotion_discount_cents from public.sale_items where sale_id = public.t_pk_sale(1)), 45000::bigint, 'the discount is -$450 (promotion_discount_cents)');
select is((select branch_promotion_discounted_units || '/' || branch_promotion_every_units || '/' || branch_promotion_discount_bps || '/' || branch_promotion_discount_cents from public.sale_items where sale_id = public.t_pk_sale(1)), '3/3/1500/45000', 'the promotion rule used is a snapshot on the line');
select is((select branch_promotion_id from public.sale_items where sale_id = public.t_pk_sale(1)), (select id from promo_ids where name = 'central2'), 'and so is the promotion id');
select is((select sold_as_pack from public.sale_items where sale_id = public.t_pk_sale(1)), false, 'a normal sale is not marked as a pack');
select is((select -quantity_grams from public.stock_movements where sale_id = public.t_pk_sale(1) and type = 'SALE'), 3::bigint, 'stock moves by the 3 real units');

select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(2, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 8, 100000, 'PROMO', 0, null, (select id from promo_ids where name = 'central2'), 3, 1500))))$$,
  '8 units of Leche (normal sale): 6 at 15 %, 2 at full price');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(2)), 710000::bigint, '8 × $1.000 with 6 units at 15 % off = $7.100');
select is((select branch_promotion_discounted_units from public.sale_items where sale_id = public.t_pk_sale(2)), 6, 'only the complete groups are discounted (6 of 8)');

select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(3, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 2, 100000), public.t_pk_item('a5000000-0000-4000-8000-000000000002', 'Coca Cola 2.25 L', 1, 120000))))$$,
  '2 Leche + 1 Coca (different products are not grouped) sell at plain prices');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(3) and product_name_snapshot = 'Leche'), 200000::bigint, '2 Leche: no discount');
select is((select count(*) from public.sale_items where sale_id = public.t_pk_sale(3) and branch_promotion_id is not null), 0::bigint, 'no line of that ticket carries a promotion');
select is((select total_cents from public.sales where id = public.t_pk_sale(3)), 320000::bigint, 'the ticket total is the plain sum');

-- Rechazos de la promoción de sucursal: inventar el grupo, el porcentaje, la regla o la sucursal.
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(4, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 2, 100000) || jsonb_build_object(
    'branchPromotionId', (select id from promo_ids where name = 'central2'), 'branchPromotionEveryUnits', 3, 'branchPromotionDiscountBps', 1500,
    'branchPromotionDiscountedUnits', 2, 'branchPromotionDiscountCents', '30000', 'discountCents', '30000', 'promotionDiscountCents', '30000',
    'subtotalCents', '170000', 'pricePerKgCents', '85000'))))$$, '22023', null, 'a promotion claimed on 2 units (incomplete group) is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(5, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 8, 100000) || jsonb_build_object(
    'branchPromotionId', (select id from promo_ids where name = 'central2'), 'branchPromotionEveryUnits', 3, 'branchPromotionDiscountBps', 1500,
    'branchPromotionDiscountedUnits', 8, 'branchPromotionDiscountCents', '120000', 'discountCents', '120000', 'promotionDiscountCents', '120000',
    'subtotalCents', '680000', 'pricePerKgCents', '85000'))))$$, '22023', null, 'discounting 8 of 8 units (a partial group) is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(6, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 3, 100000, 'PROMO', 0, null, (select id from promo_ids where name = 'central2'), 3, 3000))))$$, '42501', null, 'a percentage the rule does not have (30 % vs 15 %) is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(7, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 4, 100000, 'PROMO', 0, null, (select id from promo_ids where name = 'central2'), 2, 1500))))$$, '42501', null, 'a group size the rule does not have (2 vs 3) is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(8, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 3, 100000, 'PROMO', 0, null, (select id from promo_ids where name = 'avenida'), 2, 1000))))$$, '42501', null, 'Avenida''s promotion cannot be used in Central');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000002', public.t_pk_payload(9, 'a3000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 3, 100000, 'PROMO', 0, null, (select id from promo_ids where name = 'central2'), 3, 1500))))$$, '42501', null, 'Central''s promotion cannot be used in Avenida');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(10, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 3, 100000, 'PROMO', 0, null, 'a8000000-0000-4000-8000-0000000000ff', 3, 1500))))$$, '42501', null, 'a promotion id that does not exist is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(11, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 3, 100000, 'PROMO', 0, null, (select id from promo_ids where name = 'central2'), 3, 1500) || '{"branchPromotionDiscountCents":"40000"}'::jsonb)))$$, '22023', null, 'a discount amount that is not exactly the rule applied to the real units is rejected');
select is((select count(*) from public.sales where id in (public.t_pk_sale(4), public.t_pk_sale(5), public.t_pk_sale(6), public.t_pk_sale(7), public.t_pk_sale(8), public.t_pk_sale(9), public.t_pk_sale(10), public.t_pk_sale(11))), 0::bigint, 'a rejected sale leaves nothing behind');

-- Tarjeta: el recargo va una sola vez sobre el total comercial ya descontado.
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(13, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 8, 100000, 'PROMO', 1000, null, (select id from promo_ids where name = 'central2'), 3, 1500)), 'DEBIT'))$$,
  '8 units with a card: promotion first, surcharge after');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(13)), 781000::bigint, '$7.100 + 10 % card = $7.810');
select is((select card_surcharge_cents from public.sale_items where sale_id = public.t_pk_sale(13)), 71000::bigint, 'the card surcharge is $710 on the discounted total');

-- ---------------------------------------------------------------------------------------------
-- 5. Ventas como Pack: unidades reales y 20 % para todas; sin promoción encima
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(20, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8))))$$,
  '1 pack of 8 syncs');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(20)), 640000::bigint, '1 pack: 8 × $1.000 - 20 % = $6.400');
select is((select quantity_units from public.sale_items where sale_id = public.t_pk_sale(20)), 8, 'the line holds the 8 REAL units');
select is((select sold_as_pack from public.sale_items where sale_id = public.t_pk_sale(20)), true, 'the line remembers it was sold as a pack');
select is((select pack_size_units_snapshot || '/' || pack_count || '/' || pack_discount_bps || '/' || pack_discount_cents from public.sale_items where sale_id = public.t_pk_sale(20)), '8/1/2000/160000', 'pack snapshot: 8 units, 1 pack, 20 %, -$1.600');
select is((select promotion_discount_cents from public.sale_items where sale_id = public.t_pk_sale(20)), 160000::bigint, 'promotion_discount_cents carries the pack discount (reports, tickets)');
select is((select branch_promotion_id is null and branch_promotion_every_units is null from public.sale_items where sale_id = public.t_pk_sale(20)), true, 'a pack never also carries the branch promotion');
select is((select -quantity_grams from public.stock_movements where sale_id = public.t_pk_sale(20) and type = 'SALE'), 8::bigint, 'stock discounts the 8 real units');

select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(21, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 2, 100000, 'PACK', 0, 8))))$$,
  '2 packs of 8 sync');
select is((select quantity_units || '/' || subtotal_cents || '/' || pack_discount_cents from public.sale_items where sale_id = public.t_pk_sale(21)), '16/1280000/320000', '2 packs: 16 real units, $12.800, -$3.200');
select is((select -quantity_grams from public.stock_movements where sale_id = public.t_pk_sale(21) and type = 'SALE'), 16::bigint, 'stock discounts the 16 real units');

-- Pack + tarjeta, y pack + descuento general del ticket (se aplican DESPUÉS del pack).
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(22, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 1000, 8)), 'CREDIT'))$$,
  'a pack paid with card: pack first, surcharge after');
select is((select subtotal_cents || '/' || card_surcharge_cents from public.sale_items where sale_id = public.t_pk_sale(22)), '704000/64000', '$6.400 + 10 % = $7.040');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(23, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8)), 'CASH', 500, 32000))$$,
  'a pack plus a 5 % general ticket discount (Central)');
select is((select total_cents from public.sales where id = public.t_pk_sale(23)), 608000::bigint, '$6.400 - 5 % = $6.080');
select is((select ticket_discount_cents from public.sale_items where sale_id = public.t_pk_sale(23)), 32000::bigint, 'the ticket discount is allocated to the pack line');

-- Rechazos del pack.
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(24, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8) || jsonb_build_object(
    'packDiscountBps', 1500, 'packDiscountCents', '120000', 'discountCents', '120000', 'promotionDiscountCents', '120000', 'subtotalCents', '680000', 'pricePerKgCents', '85000'))))$$, '22023', null, 'a pack must carry exactly 20 % (15 % is rejected)');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(25, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8) || '{"packSizeUnitsSnapshot":6}'::jsonb)))$$, '22023', null, 'the units must be pack_count × pack size (8 units with a size of 6 is rejected)');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(26, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8) || '{"packDiscountCents":"100000"}'::jsonb)))$$, '22023', null, 'a pack discount amount that is not exactly 20 % is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(27, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8) || jsonb_build_object(
    'branchPromotionId', (select id from promo_ids where name = 'central2'), 'branchPromotionEveryUnits', 3, 'branchPromotionDiscountBps', 1500,
    'branchPromotionDiscountedUnits', 6, 'branchPromotionDiscountCents', '90000'))))$$, '22023', null, 'a pack that also claims the branch promotion (stacking) is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(28, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8) || '{"promotionMode":"PACK_FIXED_TOTAL","discountRuleId":"a8000000-0000-4000-8000-0000000000aa"}'::jsonb)))$$, '22023', null, 'a pack that also claims a specific product promotion (stacking) is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(29, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8) || jsonb_build_object(
    'manualPriceApplied', true, 'manualUnitPriceCents', '80000', 'manualAdjustmentCents', '-160000', 'pricePerKgCents', '80000'))))$$, '22023', null, 'a manual price excludes the pack (no automatic discounts on a manual line)');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(30, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_weight_item('a5000000-0000-4000-8000-000000000003', 'Vacío', 1000, 1500000) || '{"soldAsPack":true,"packCount":1,"packSizeUnitsSnapshot":8,"packDiscountBps":2000,"packDiscountCents":"300000"}'::jsonb)))$$, '22023', null, 'a WEIGHT line cannot be a pack');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(31, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8) || '{"packCount":null,"soldAsPack":false}'::jsonb)))$$, '22023', null, 'pack metadata without soldAsPack is rejected');
select is((select count(*) from public.sales where id in (public.t_pk_sale(24), public.t_pk_sale(25), public.t_pk_sale(26), public.t_pk_sale(27), public.t_pk_sale(28), public.t_pk_sale(29), public.t_pk_sale(30), public.t_pk_sale(31))), 0::bigint, 'every rejected pack sale left nothing behind');

-- Manual: una línea con precio manual sigue siendo manual (sin promoción ni pack), aunque supere el grupo.
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(32, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 3, 100000) || jsonb_build_object(
    'pricePerKgCents', '90000', 'subtotalCents', '270000', 'manualPriceApplied', true, 'manualUnitPriceCents', '90000', 'manualAdjustmentCents', '-30000'))))$$,
  '3 units with a manual price: no automatic promotion');
select is((select branch_promotion_id is null and not sold_as_pack from public.sale_items where sale_id = public.t_pk_sale(32)), true, 'the manual line carries neither promotion nor pack');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(33, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 3, 100000, 'PROMO', 0, null, (select id from promo_ids where name = 'central2'), 3, 1500) || jsonb_build_object(
    'pricePerKgCents', '85000', 'manualPriceApplied', true, 'manualUnitPriceCents', '85000', 'manualAdjustmentCents', '-45000'))))$$, '22023', null, 'a manual price line cannot also claim the branch promotion');

-- ---------------------------------------------------------------------------------------------
-- 6. Historia: un cambio posterior del pack no altera una venta vieja, ni invalida una venta offline pendiente
-- ---------------------------------------------------------------------------------------------
create temp table pending_old_pack(payload jsonb);
grant all on pending_old_pack to authenticated;
insert into pending_old_pack select public.t_pk_payload(40, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8)));
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 12)$$, 'the product pack changes from 8 to 12');
select is((select pack_size_units_snapshot from public.sale_items where sale_id = public.t_pk_sale(20)), 8, 'the old sale still says 1 pack × 8 units');
select is((select quantity_units || '/' || pack_count || '/' || subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(20)), '8/1/640000', 'and keeps its 8 units and $6.400');
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', (select payload from pending_old_pack))$$, 'an offline pack sale made with the old size (8) still syncs after the product moved to 12');
select is((select pack_size_units_snapshot from public.sale_items where sale_id = public.t_pk_sale(40)), 8, 'it is stored with the size it was sold with');
select is((public.t_pk_sync('a7000000-0000-4000-8000-000000000001', (select payload from pending_old_pack)) ->> 'duplicate')::boolean, true, 'syncing the same pack sale again is idempotent');
select is((select count(*) from public.sale_items where sale_id = public.t_pk_sale(40)), 1::bigint, 'and wrote no second line');

-- ---------------------------------------------------------------------------------------------
-- 7. Stock, anulación, ticket de WhatsApp y rentabilidad
-- ---------------------------------------------------------------------------------------------
select is((select sum(quantity_grams)::bigint from public.stock_movements where product_id = 'a5000000-0000-4000-8000-000000000001' and sale_id = public.t_pk_sale(21)), -16::bigint, 'the 2-pack sale moved exactly -16 units of stock');
select is(
  (select -sum(quantity_grams)::int from public.stock_movements where product_id = 'a5000000-0000-4000-8000-000000000001' and type = 'SALE'),
  (select sum(quantity_units)::int from public.sale_items where product_id = 'a5000000-0000-4000-8000-000000000001'),
  'stock sold equals the real units on the lines, packs included (the ledger never sees "packs")'
);
reset role;
select is(
  (app_private.wa_sale_ticket_json(public.t_pk_sale(20)) -> 'items' -> 0 ->> 'soldAsPack')::boolean, true,
  'the WhatsApp ticket facts say the line was a pack'
);
select is(
  (select (i ->> 'packCount') || 'x' || (i ->> 'packSizeUnits') || '@' || (i ->> 'packDiscountBps') from jsonb_array_elements(app_private.wa_sale_ticket_json(public.t_pk_sale(20)) -> 'items') i),
  '1x8@2000', 'with its pack snapshot (1 pack × 8 units, 20 %)'
);
select is(
  (app_private.wa_sale_ticket_json(public.t_pk_sale(2)) -> 'items' -> 0 ->> 'branchPromotionDiscountedUnits')::int, 6,
  'and the branch promotion snapshot of a normal line'
);
select is(
  (app_private.wa_sale_ticket_json(public.t_pk_sale(20)) -> 'items' -> 0 ->> 'promotionDiscountCents')::bigint, 160000::bigint,
  'the ticket discount for the line is the pack discount'
);
set local role authenticated;

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.cancel_sale(public.t_pk_sale(21), 'a9000000-0000-4000-8000-000000000001', 'prueba de anulación de packs')$$, 'Admin cancels the 2-pack sale');
select is((select quantity_grams from public.stock_movements where sale_id = public.t_pk_sale(21) and type = 'RETURN'), 16::bigint, 'the cancellation returns the 16 real units');
select is(
  (public.get_profitability_analytics('7d') -> 'summary' ->> 'revenueCents')::bigint,
  (select sum(i.subtotal_cents - i.ticket_discount_cents)::bigint from public.sale_items i join public.sales s on s.id = i.sale_id where s.status = 'COMPLETED'),
  'profitability revenue is the real charged amount of the (pack and promotion) lines of completed sales'
);

-- ---------------------------------------------------------------------------------------------
-- 8. Configuración histórica del pack (product_pack_versions): la venta se valida contra la versión con la que se hizo,
--    nunca contra products.pack_size_units actual
-- ---------------------------------------------------------------------------------------------
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000001'), 2::bigint, 'the 8 -> 12 change left two versions of the pack');
select is(
  (select string_agg(pack_size_units || ':' || (valid_to is null), ',' order by pack_size_units) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000001'),
  '8:false,12:true', 'the 8 version is closed and the 12 version is the open one'
);
select is((select count(*) from public.product_pack_versions where discount_bps <> 2000), 0::bigint, 'every version carries the 20 % discount (2000 bps)');
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 12)$$, 'saving the same pack size again');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000001'), 2::bigint, 'an unchanged size does not open a new version');
select is(
  (select v.pack_size_units || '/' || (v.valid_to is not null) from public.sale_items i join public.product_pack_versions v on v.id = i.pack_config_id where i.sale_id = public.t_pk_sale(20)),
  '8/true', 'the historical pack sale still points at the 8 version, now closed'
);
select is(
  (select pack_config_id from public.sale_items where sale_id = public.t_pk_sale(40)),
  public.t_pk_version_id('a5000000-0000-4000-8000-000000000001', 8),
  'the offline sale made with 8 and synced after the change to 12 is stored against the 8 version'
);
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000002', 8)$$, 'Admin gives another product its own pack of 8');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000002' and valid_to is null), 1::bigint, 'and that product gets its own open version');

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.product_pack_versions), 0::bigint, 'an employee cannot read the pack versions table (catalog.write only)');
select is(
  (select (i ->> 'packSizeUnits') || '/' || ((i ->> 'packConfigId')::uuid = public.t_pk_version_id('a5000000-0000-4000-8000-000000000001'))
   from jsonb_array_elements(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Leche'),
  '12/true', 'the POS receives the current size (12) together with the id of the open version'
);

-- La venta nueva usa el pack vigente (12).
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(41, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 12))))$$, 'a new pack sale uses the current size: 1 pack of 12');
select is((select quantity_units || '/' || pack_size_units_snapshot || '/' || subtotal_cents || '/' || pack_discount_cents from public.sale_items where sale_id = public.t_pk_sale(41)), '12/12/960000/240000', '12 real units, $12.000 - 20 % = $9.600');
select is(
  (select pack_config_id from public.sale_items where sale_id = public.t_pk_sale(41)),
  public.t_pk_version_id('a5000000-0000-4000-8000-000000000001'), 'the new sale is stored against the open (12) version'
);
select is((select -quantity_grams from public.stock_movements where sale_id = public.t_pk_sale(41) and type = 'SALE'), 12::bigint, 'stock discounts the 12 real units');

-- Rechazos: cada uno cambia SOLO el dato manipulado (el resto de la línea es aritméticamente coherente).
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(42, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 4, 100000, 'PACK', 0, 2) || jsonb_build_object('packConfigId', public.t_pk_version_id('a5000000-0000-4000-8000-000000000001', 8)))))$$,
  '22023', null, 'a fake pack of 2 that borrows the id of the real 8 version is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(43, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 4, 100000, 'PACK', 0, 2))))$$,
  '22023', null, 'a fake pack of 2 with no configuration at all is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(44, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8) || '{"packConfigId":"a9999999-0000-4000-8000-000000000999"}'::jsonb)))$$,
  '42501', null, 'a pack configuration that does not exist is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(45, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8) || jsonb_build_object('packConfigId', public.t_pk_version_id('a5000000-0000-4000-8000-000000000002')))))$$,
  '42501', null, 'a pack configuration of ANOTHER product (same size 8) is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(46, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 12) || jsonb_build_object('packDiscountBps', 1500, 'packDiscountCents', '180000', 'discountCents', '180000', 'promotionDiscountCents', '180000', 'subtotalCents', '1020000', 'pricePerKgCents', '85000'))))$$,
  '22023', null, 'a manipulated discount (15 %, arithmetic included) on a real configuration is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(47, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 12) || jsonb_build_object('packDiscountBps', 2500, 'packDiscountCents', '300000', 'discountCents', '300000', 'promotionDiscountCents', '300000', 'subtotalCents', '900000', 'pricePerKgCents', '75000'))))$$,
  '22023', null, 'a bigger manipulated discount (25 %, arithmetic included) is rejected too');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(48, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 12))) || jsonb_build_object('createdAt', now() - interval '2 hours', 'completedAt', now() - interval '2 hours'))$$,
  '42501', null, 'a configuration that did not exist yet when the sale was made is rejected');

-- Una versión cerrada hace 3 días (tamaño 6): vale para una venta hecha por un dispositivo que todavía no la había reemplazado.
reset role;
insert into public.product_pack_versions (organization_id, product_id, pack_size_units, discount_bps, valid_from, valid_to)
values ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 6, 2000, now() - interval '10 days', now() - interval '3 days');
select throws_ok($$insert into public.product_pack_versions (organization_id, product_id, pack_size_units, discount_bps) select organization_id, id, 9, 1500 from public.products where id = 'a5000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'the table itself refuses a pack version with a discount other than 20 %');
select throws_ok($$insert into public.product_pack_versions (organization_id, product_id, pack_size_units, discount_bps) select organization_id, id, 9, 2000 from public.products where id = 'a5000000-0000-4000-8000-000000000001'$$,
  '23505', null, 'the table itself refuses a second open version for the same product');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(49, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 6))))$$,
  '42501', null, 'a version closed 3 days ago does not validate a sale made now (the device could not still hold it)');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(50, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 6))) || jsonb_build_object('createdAt', now() - interval '47 hours', 'completedAt', now() - interval '47 hours'))$$,
  '42501', null, 'a sale made 25 h after the version was closed is outside the 24 h offline authorization');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(51, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 6))) || jsonb_build_object('createdAt', now() - interval '60 hours', 'completedAt', now() - interval '60 hours'))$$,
  'a sale made 12 h after the version was closed (an offline device that had not synced yet) is valid');
select is((select pack_size_units_snapshot || '/' || quantity_units from public.sale_items where sale_id = public.t_pk_sale(51)), '6/6', 'and it keeps the 6 it was sold with');
select is((select count(*) from public.sales where id in (public.t_pk_sale(42), public.t_pk_sale(43), public.t_pk_sale(44), public.t_pk_sale(45), public.t_pk_sale(46), public.t_pk_sale(47), public.t_pk_sale(48), public.t_pk_sale(49), public.t_pk_sale(50))), 0::bigint, 'every rejected pack sale left nothing behind');

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000002', null)$$, 'Admin removes the pack of the other product');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000002' and valid_to is null), 0::bigint, 'removing a pack closes its open version');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000002' and valid_to is not null), 1::bigint, 'and keeps it as history');

select * from finish();
rollback;
