begin;

create extension if not exists pgtap with schema extensions;
select plan(154);

-- Covers 202610040061 (ajuste posterior al deploy de 059/060):
--   * descuento de Pack configurable por producto (products.pack_discount_bps), versionado junto con las unidades por pack
--     (product_pack_versions) y validado por el servidor contra SU versión;
--   * promoción global de sucursal "DESDE N unidades": el descuento cae sobre TODAS las unidades de la línea del mismo producto
--     (nunca sobre grupos completos), sin acumularse con Pack ni con precio manual;
--   * compatibilidad con cajas que todavía mandan el formato anterior ("cada N").
-- Fixture: Central (sucursal productiva) y Avenida, admin + empleado con acceso a ambas; Leche A (UNIT $1.000), Coca Cola, Vacío.
-- Todo el dinero en centavos.

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
  p_pack_size integer default null, p_promo uuid default null, p_every integer default null, p_promo_bps integer default null,
  p_pack_bps integer default 2000
) returns jsonb language plpgsql security definer as $$
declare units integer := p_qty; discounted integer := 0; bps integer := 0; disc bigint := 0; cash bigint; sub bigint; fin bigint; res jsonb;
begin
  if p_kind = 'PACK' then units := p_qty * p_pack_size; discounted := units; bps := p_pack_bps;
  elsif p_kind = 'PROMO' then discounted := case when units >= p_every then units else 0 end; bps := p_promo_bps;
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
    res := res || jsonb_build_object('soldAsPack', true, 'packCount', p_qty, 'packSizeUnitsSnapshot', p_pack_size, 'packDiscountBps', p_pack_bps, 'packDiscountCents', disc::text,
      'packConfigId', (select v.id from public.product_pack_versions v where v.product_id = p_product and v.pack_size_units = p_pack_size and v.discount_bps = p_pack_bps order by v.valid_to nulls first limit 1));
  elsif p_kind = 'PROMO' and discounted > 0 then
    res := res || jsonb_build_object('branchPromotionId', p_promo, 'branchPromotionMinimumUnits', p_every, 'branchPromotionDiscountBps', p_promo_bps,
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

-- Segundo producto con pack y un tercero (para comparar porcentajes distintos por producto).
reset role;
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('a5000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Leche B', 'pk-leche-b', 'PK-4', 'UNIT'),
  ('a5000000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Producto C', 'pk-prod-c', 'PK-5', 'UNIT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where p.id in ('a5000000-0000-4000-8000-000000000004', 'a5000000-0000-4000-8000-000000000005');
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000004', 100000, '2026-01-01T00:00:00Z'),
  ('a2000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000005', 100000, '2026-01-01T00:00:00Z');

-- ---------------------------------------------------------------------------------------------
-- 1. Configuración del pack por producto: unidades + descuento, juntos y validados
-- ---------------------------------------------------------------------------------------------
select has_column('public', 'products', 'pack_discount_bps', 'products.pack_discount_bps exists');
select col_not_null('public', 'product_pack_versions', 'discount_bps', 'the version stores its own discount');
select is((select pack_discount_bps from public.products where sku = 'PK-1'), null::integer, 'a product without pack has no pack discount');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 8, 2000)$$, 'Leche A: pack of 8 at 20 %');
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000004', 8, 2500)$$, 'Leche B: pack of 8 at 25 %');
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000005', 12, 1500)$$, 'Producto C: pack of 12 at 15 %');
select is((select pack_size_units || '/' || pack_discount_bps from public.products where sku = 'PK-1'), '8/2000', 'A stores 8 units and 2000 bps');
select is((select pack_size_units || '/' || pack_discount_bps from public.products where sku = 'PK-4'), '8/2500', 'B stores 8 units and 2500 bps (its own percentage)');
select is((select pack_size_units || '/' || pack_discount_bps from public.products where sku = 'PK-5'), '12/1500', 'C stores 12 units and 1500 bps');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000004' and valid_to is null and discount_bps = 2500 and pack_size_units = 8), 1::bigint, 'B has one open version with 8 / 25 %');

select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 8, 0)$$, '22023', null, '0 % is not a pack discount');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 8, 10000)$$, '22023', null, '100 % is not a pack discount (the pack would be free)');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 8, 12000)$$, '22023', null, 'more than 100 % is rejected');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 8, -500)$$, '22023', null, 'a negative pack discount is rejected');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', null, 2000)$$, '22023', null, 'a discount without a pack is rejected');
select throws_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000003', 8, 2000)$$, '22023', null, 'a WEIGHT product cannot have a pack (nor its discount)');
select is((select pack_size_units || '/' || pack_discount_bps from public.products where sku = 'PK-1'), '8/2000', 'rejected attempts left A alone');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000001'), 1::bigint, 'and wrote no extra version');

-- Decimal (12,5 % = 1250 bps) y el límite superior.
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000005', 12, 1250)$$, 'a decimal percentage (12,5 %) is stored as 1250 bps');
select is((select pack_discount_bps from public.products where sku = 'PK-5'), 1250, '12,5 % -> 1250 bps (integer basis points, never a float)');
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000005', 12, 9999)$$, '99,99 % is the highest allowed');
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000005', 12, 1500)$$, 'and back to 15 %');

-- Las tablas lo hacen valer aunque se salte la RPC.
reset role;
select throws_ok($$update public.products set pack_size_units = 6, pack_discount_bps = null where sku = 'PK-2'$$, '23514', null, 'the table refuses a pack with no discount');
select throws_ok($$update public.products set pack_discount_bps = 2000 where sku = 'PK-2'$$, '23514', null, 'the table refuses a discount with no pack');
select throws_ok($$update public.products set pack_discount_bps = 10000 where sku = 'PK-1'$$, '23514', null, 'the table refuses a 100 % pack discount');
select throws_ok($$update public.products set pack_discount_bps = 0 where sku = 'PK-1'$$, '23514', null, 'the table refuses a 0 % pack discount');
select throws_ok($$update public.products set pack_size_units = null where sku = 'PK-1'$$, '23514', null, 'removing the size while keeping the discount is refused');
select lives_ok($$update public.products set pack_size_units = null, pack_discount_bps = null where sku = 'PK-5'$$, 'removing both at once is allowed (no pack, no discount)');
select is((select pack_size_units is null and pack_discount_bps is null from public.products where sku = 'PK-5'), true, 'a product without pack has no active discount configuration');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000005' and valid_to is null), 0::bigint, 'and no open version');
select lives_ok($$update public.products set pack_size_units = 12, pack_discount_bps = 1500 where sku = 'PK-5'$$, 'Producto C gets its pack back (12 / 15 %)');
select throws_ok($$insert into public.products (organization_id, category_id, name, slug, sku, unit_type, pack_size_units) values ('a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Sin descuento', 'pk-sin-desc', 'PK-6', 'UNIT', 6)$$, '23514', null, 'a product cannot even be created with a pack and no discount');
select lives_ok($$insert into public.products (organization_id, category_id, name, slug, sku, unit_type, pack_size_units, pack_discount_bps) values ('a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Con pack', 'pk-con-pack', 'PK-7', 'UNIT', 6, 1800)$$, 'but it can with both');
select is((select count(*) from public.product_pack_versions v join public.products p on p.id = v.product_id where p.sku = 'PK-7' and v.discount_bps = 1800 and v.pack_size_units = 6 and v.valid_to is null), 1::bigint, 'creating it opened its first version (6 / 18 %)');
delete from public.products where sku = 'PK-7';

-- Compatibilidad: un Admin sin actualizar llama con 2 argumentos.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000004', 8)$$, 'a caller that predates the percentage (2 arguments) can still call it');
select is((select pack_discount_bps from public.products where sku = 'PK-4'), 2500, '...and it keeps the product''s own percentage (25 %)');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000004'), 1::bigint, 'without opening a new version');
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000002', 6)$$, 'on a product with no pack it defaults to the historical 20 %');
select is((select pack_discount_bps from public.products where sku = 'PK-2'), 2000, '...stored explicitly as 2000 bps');
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000002', null)$$, 'and the pack is removed again');

-- Cambiar el porcentaje (o el tamaño, o los dos) cierra la versión vigente y abre otra, con un packConfigId nuevo.
create temp table cfg(name text primary key, id uuid);
grant all on cfg to authenticated;
insert into cfg select 'a-v1', v.id from public.product_pack_versions v where v.product_id = 'a5000000-0000-4000-8000-000000000001' and v.valid_to is null;
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 8, 2000)$$, 'saving A with exactly the same values');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000001'), 1::bigint, 'does not open a new version');

-- Día 1: A = pack 8 / 20 %. La venta offline queda pendiente (payload armado ahora, se sincroniza después del cambio).
create temp table pending(name text primary key, payload jsonb);
grant all on pending to authenticated;
insert into pending select 'day1', public.t_pk_payload(60, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 2000)));

-- Día 2: A pasa a 25 % (mismo tamaño).
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000001', 8, 2500)$$, 'Day 2: Leche A goes from 20 % to 25 % (same pack of 8)');
insert into cfg select 'a-v2', v.id from public.product_pack_versions v where v.product_id = 'a5000000-0000-4000-8000-000000000001' and v.valid_to is null;
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000001'), 2::bigint, 'the change left two versions');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000001' and valid_to is null), 1::bigint, 'exactly one is open');
select is((select discount_bps || '/' || pack_size_units || '/' || (valid_to is not null) from public.product_pack_versions where id = (select id from cfg where name = 'a-v1')), '2000/8/true', 'the 20 % version is closed and keeps its 20 %');
select is((select discount_bps || '/' || pack_size_units || '/' || (valid_to is null) from public.product_pack_versions where id = (select id from cfg where name = 'a-v2')), '2500/8/true', 'the new version is open with 25 %');
select isnt((select id from cfg where name = 'a-v2'), (select id from cfg where name = 'a-v1'), 'the new configuration has a new packConfigId');

select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000004', 12, 2500)$$, 'B: only the SIZE changes (8 -> 12)');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000004'), 2::bigint, 'a size change opens a new version too');
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000004', 6, 1000)$$, 'B: size AND percentage change in the same call (12 -> 6, 25 % -> 10 %)');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000004'), 3::bigint, 'both changes together open exactly ONE new version');
select lives_ok($$select public.set_product_pack_size('a5000000-0000-4000-8000-000000000004', 8, 2500)$$, 'B returns to 8 / 25 %...');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000004' and pack_size_units = 8 and discount_bps = 2500), 2::bigint, '...as a NEW version (history is never reopened)');
select is((select count(*) from public.product_pack_versions where product_id = 'a5000000-0000-4000-8000-000000000004' and valid_to is null), 1::bigint, 'still exactly one open version for B');

insert into cfg select 'b-open', v.id from public.product_pack_versions v where v.product_id = 'a5000000-0000-4000-8000-000000000004' and v.valid_to is null;

-- El POS recibe, por producto, tamaño + porcentaje + id de la versión vigente.
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.register_pos_device('a7000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'Caja Central')$$, 'the Central device is registered');
select lives_ok($$select public.register_pos_device('a7000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000002', 'Caja Avenida')$$, 'the Avenida device is registered');
select is(
  (select (i ->> 'packSizeUnits') || '/' || (i ->> 'packDiscountBps') || '/' || ((i ->> 'packConfigId')::uuid = (select id from cfg where name = 'a-v2'))
   from jsonb_array_elements(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Leche'),
  '8/2500/true', 'the catalog item of Leche A carries 8 units, 25 % and the open version id'
);
select is(
  (select (i ->> 'packSizeUnits') || '/' || (i ->> 'packDiscountBps') from jsonb_array_elements(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Leche B'),
  '8/2500', 'Leche B carries its own pack'
);
select is(
  (select (i ->> 'packSizeUnits') || '/' || (i ->> 'packDiscountBps') from jsonb_array_elements(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Producto C'),
  '12/1500', 'Producto C carries 12 units and 15 %'
);
select is(
  (select i -> 'packDiscountBps' from jsonb_array_elements(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'catalog') i where i ->> 'productName' = 'Coca Cola 2.25 L'),
  'null'::jsonb, 'a product without a pack carries a null discount'
);

-- ---------------------------------------------------------------------------------------------
-- 2. Ventas: la venta se valida contra SU versión (tamaño + porcentaje)
-- ---------------------------------------------------------------------------------------------
-- Día 1 offline, sincronizada DESPUÉS del cambio a 25 %: sigue validando 8 unidades al 20 %.
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', (select payload from pending where name = 'day1'))$$, 'the Day 1 offline pack sale (8 units, 20 %) still syncs after the product moved to 25 %');
select is((select quantity_units || '/' || pack_size_units_snapshot || '/' || pack_discount_bps || '/' || pack_discount_cents || '/' || subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(60)), '8/8/2000/160000/640000', 'it was stored as 8 units at 20 %: $8.000 - $1.600 = $6.400 (not 25 %)');
select is((select pack_config_id from public.sale_items where sale_id = public.t_pk_sale(60)), (select id from cfg where name = 'a-v1'), 'against the 20 % version');
select is((public.t_pk_sync('a7000000-0000-4000-8000-000000000001', (select payload from pending where name = 'day1')) ->> 'duplicate')::boolean, true, 'syncing it again is idempotent');

-- Venta nueva (Día 2): 1 pack de 8 al 25 %: base $8.000, descuento $2.000, total $6.000.
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(61, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 2500))))$$, 'a new pack sale uses the 25 % version');
select is((select quantity_units || '/' || pack_discount_bps || '/' || pack_discount_cents || '/' || subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(61)), '8/2500/200000/600000', '8 units at $1.000: base $8.000, discount $2.000, total $6.000');
select is((select pack_config_id from public.sale_items where sale_id = public.t_pk_sale(61)), (select id from cfg where name = 'a-v2'), 'stored against the 25 % version');
select is((select total_cents from public.sales where id = public.t_pk_sale(61)), 600000::bigint, 'the ticket total is $6.000');

-- Cada producto con su porcentaje en la misma venta: A (25 %), B (25 %) y C (15 %).
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(62, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(
    public.t_pk_item('a5000000-0000-4000-8000-000000000004', 'Leche B', 1, 100000, 'PACK', 0, 8, null, null, null, 2500),
    public.t_pk_item('a5000000-0000-4000-8000-000000000005', 'Producto C', 1, 100000, 'PACK', 0, 12, null, null, null, 1500))))$$, 'B (8 / 25 %) and C (12 / 15 %) in one ticket');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(62) and product_name_snapshot = 'Leche B'), 600000::bigint, 'B: 8 × $1.000 - 25 % = $6.000');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(62) and product_name_snapshot = 'Producto C'), 1020000::bigint, 'C: 12 × $1.000 - 15 % = $10.200');
select is((select total_cents from public.sales where id = public.t_pk_sale(62)), 1620000::bigint, 'the ticket adds each product''s own pack price');

-- Tarjeta y descuento general siguen DESPUÉS del pack.
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(63, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 1000, 8, null, null, null, 2500)), 'CREDIT'))$$, 'a 25 % pack paid with card: pack first, surcharge after');
select is((select subtotal_cents || '/' || card_surcharge_cents from public.sale_items where sale_id = public.t_pk_sale(63)), '660000/60000', '$6.000 + 10 % = $6.600');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(64, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 2500)), 'CASH', 500, 30000))$$, 'a 25 % pack plus a 5 % general ticket discount');
select is((select total_cents from public.sales where id = public.t_pk_sale(64)), 570000::bigint, '$6.000 - 5 % = $5.700');

-- Manipulaciones: cada una cambia SOLO el dato manipulado (la aritmética del resto sigue coherente).
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(65, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 2500) || jsonb_build_object('packConfigId', (select id from cfg where name = 'a-v1')))))$$,
  '22023', null, 'a 25 % pack that borrows the id of the old 20 % version is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(66, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 2000) || jsonb_build_object('packConfigId', (select id from cfg where name = 'a-v2')))))$$,
  '22023', null, 'a 20 % pack claiming the 25 % version is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(67, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 4000) || jsonb_build_object('packConfigId', (select id from cfg where name = 'a-v2')))))$$,
  '22023', null, 'a bigger invented percentage (40 %, arithmetic included) on a real version is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(68, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 2500) || '{"packDiscountCents":"150000"}'::jsonb)))$$,
  '22023', null, 'a discount amount that is not exactly the version percentage is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(69, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 2500) || jsonb_build_object('packConfigId', (select id from cfg where name = 'b-open')))))$$,
  '42501', null, 'the (identical 8 / 25 %) configuration of ANOTHER product is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(70, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 2, 100000, 'PACK', 0, 4, null, null, null, 2500) || jsonb_build_object('packConfigId', (select id from cfg where name = 'a-v2')))))$$,
  '22023', null, 'the same 8 units declared as 2 packs of 4 (size snapshot not matching the version) is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(71, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 9999) || jsonb_build_object('packConfigId', (select id from cfg where name = 'a-v2')))))$$,
  '22023', null, 'a 99,99 % snapshot is rejected unless the version says so');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(72, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 2500) || '{"packDiscountBps":10000}'::jsonb)))$$,
  '22023', null, 'a 100 % pack snapshot is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(73, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 2500) || '{"packDiscountBps":null}'::jsonb)))$$,
  '22023', null, 'a pack with no percentage at all is rejected');
select is((select count(*) from public.sales where id in (public.t_pk_sale(65), public.t_pk_sale(66), public.t_pk_sale(67), public.t_pk_sale(68), public.t_pk_sale(69), public.t_pk_sale(70), public.t_pk_sale(71), public.t_pk_sale(72), public.t_pk_sale(73))), 0::bigint, 'every manipulated pack sale left nothing behind');

-- Pack y promoción global NO se acumulan.
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.save_branch_promotion('a3000000-0000-4000-8000-000000000001', 3, 1500)$$, 'Central promotion: desde 3 unidades, 15 %');
insert into cfg select 'promo-central', id from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000001' and active;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(74, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000, 'PACK', 0, 8, null, null, null, 2500) || jsonb_build_object(
    'branchPromotionId', (select id from cfg where name = 'promo-central'), 'branchPromotionMinimumUnits', 3, 'branchPromotionDiscountBps', 1500,
    'branchPromotionDiscountedUnits', 8, 'branchPromotionDiscountCents', '120000'))))$$, '22023', null, 'a pack that also claims the global promotion (-25 % then -15 %) is rejected');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(75, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 8, 100000, 'PROMO', 0, null, (select id from cfg where name = 'promo-central'), 3, 1500))))$$, 'the same 8 units sold as normal units take the global 15 %');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(75)), 680000::bigint, 'normal sale of 8: $8.000 - 15 % = $6.800');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(61)), 600000::bigint, 'the same 8 as a Pack: $8.000 - 25 % = $6.000 (never both)');

-- ---------------------------------------------------------------------------------------------
-- 3. Promoción global "DESDE N": toda la línea, por producto
-- ---------------------------------------------------------------------------------------------
reset role;
create function public.t_pk_promo_line(p_seq integer, p_qty integer, p_product uuid default 'a5000000-0000-4000-8000-000000000001', p_name text default 'Leche', p_rule text default 'promo-central')
returns jsonb language sql security definer as $$
  select public.t_pk_payload(p_seq, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
    jsonb_build_array(public.t_pk_item(p_product, p_name, p_qty, 100000, 'PROMO', 0, null, (select id from cfg where name = p_rule), 3, 1500))) $$;
grant execute on function public.t_pk_promo_line(integer, integer, uuid, text, text) to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

-- 1 y 2 unidades: sin descuento (la venta normal es la única válida; reclamar la promoción es rechazado).
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(80, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 1, 100000))))$$, '1 unit: plain sale');
select is((select subtotal_cents || '/' || promotion_discount_cents from public.sale_items where sale_id = public.t_pk_sale(80)), '100000/0', '1 unit: $1.000, no discount');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(81, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 2, 100000))))$$, '2 units: plain sale');
select is((select subtotal_cents || '/' || promotion_discount_cents from public.sale_items where sale_id = public.t_pk_sale(81)), '200000/0', '2 units: $2.000, no discount');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(82, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 2, 100000) || jsonb_build_object(
    'branchPromotionId', (select id from cfg where name = 'promo-central'), 'branchPromotionMinimumUnits', 3, 'branchPromotionDiscountBps', 1500,
    'branchPromotionDiscountedUnits', 2, 'branchPromotionDiscountCents', '30000', 'discountCents', '30000', 'promotionDiscountCents', '30000', 'subtotalCents', '170000', 'pricePerKgCents', '85000'))))$$,
  '22023', null, '2 units cannot claim the promotion (below the minimum)');

-- 3, 4, 5, 8 y 20 unidades: el 15 % cae sobre TODAS.
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_promo_line(83, 3))$$, '3 units');
select is((select branch_promotion_discounted_units || '/' || promotion_discount_cents || '/' || subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(83)), '3/45000/255000', '3 units: all 3 at 15 % -> -$450, $2.550');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_promo_line(84, 4))$$, '4 units');
select is((select branch_promotion_discounted_units || '/' || promotion_discount_cents || '/' || subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(84)), '4/60000/340000', '4 units: base $4.000, 15 % = -$600, total $3.400');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_promo_line(85, 5))$$, '5 units');
select is((select branch_promotion_discounted_units || '/' || promotion_discount_cents || '/' || subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(85)), '5/75000/425000', '5 units: all 5 at 15 % -> -$750, $4.250');
select is((select branch_promotion_discounted_units || '/' || promotion_discount_cents || '/' || subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(75)), '8/120000/680000', '8 units: base $8.000, 15 % = -$1.200, total $6.800');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_promo_line(86, 20))$$, '20 units');
select is((select branch_promotion_discounted_units || '/' || promotion_discount_cents || '/' || subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(86)), '20/300000/1700000', '20 units: all 20 at 15 % -> -$3.000, $17.000');
select is((select -quantity_grams from public.stock_movements where sale_id = public.t_pk_sale(86) and type = 'SALE'), 20::bigint, 'stock moves by the 20 real units');

-- Nunca "cada N": descontar sólo los grupos completos ya no valida.
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(87, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 4, 100000) || jsonb_build_object(
    'branchPromotionId', (select id from cfg where name = 'promo-central'), 'branchPromotionMinimumUnits', 3, 'branchPromotionDiscountBps', 1500,
    'branchPromotionDiscountedUnits', 3, 'branchPromotionDiscountCents', '45000', 'discountCents', '45000', 'promotionDiscountCents', '45000', 'subtotalCents', '355000', 'pricePerKgCents', '88750'))))$$,
  '22023', null, '4 units with only 3 discounted ("cada 3" arithmetic under the new key) is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(88, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 8, 100000) || jsonb_build_object(
    'branchPromotionId', (select id from cfg where name = 'promo-central'), 'branchPromotionMinimumUnits', 3, 'branchPromotionDiscountBps', 1500,
    'branchPromotionDiscountedUnits', 6, 'branchPromotionDiscountCents', '90000', 'discountCents', '90000', 'promotionDiscountCents', '90000', 'subtotalCents', '710000', 'pricePerKgCents', '88750'))))$$,
  '22023', null, '8 units with only 6 discounted is rejected');

-- Cada producto/línea por separado: dos productos distintos nunca se combinan.
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(89, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 2, 100000), public.t_pk_item('a5000000-0000-4000-8000-000000000004', 'Leche B', 1, 100000))))$$, '2 Leche + 1 Leche B (3 units in total, 2 + 1 per product): no promotion');
select is((select count(*) from public.sale_items where sale_id = public.t_pk_sale(89) and branch_promotion_id is not null), 0::bigint, 'different products are never added together');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(90, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(
    public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 3, 100000, 'PROMO', 0, null, (select id from cfg where name = 'promo-central'), 3, 1500),
    public.t_pk_item('a5000000-0000-4000-8000-000000000002', 'Coca Cola 2.25 L', 2, 120000))))$$, '3 Leche (promo) + 2 Coca (no promo)');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(90) and product_name_snapshot = 'Leche'), 255000::bigint, 'only the line that reaches 3 is discounted');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(90) and product_name_snapshot = 'Coca Cola 2.25 L'), 240000::bigint, 'and the other product pays plain price');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(91, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 2, 100000, 'PROMO', 0, null, (select id from cfg where name = 'promo-central'), 3, 1500) || '{"branchPromotionDiscountedUnits":3}'::jsonb)))$$,
  '22023', null, 'two lines of the same ticket cannot borrow each other''s units (3 discounted on a line of 2)');

-- Precio manual excluye la promoción.
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(92, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 4, 100000, 'PROMO', 0, null, (select id from cfg where name = 'promo-central'), 3, 1500) || jsonb_build_object(
    'pricePerKgCents', '90000', 'manualPriceApplied', true, 'manualUnitPriceCents', '90000', 'manualAdjustmentCents', '-40000'))))$$,
  '22023', null, 'a manual price line cannot also take the global promotion');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(93, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 4, 100000) || jsonb_build_object(
    'pricePerKgCents', '90000', 'subtotalCents', '360000', 'manualPriceApplied', true, 'manualUnitPriceCents', '90000', 'manualAdjustmentCents', '-40000'))))$$, '4 units with a manual price keep the manual price');
select is((select subtotal_cents || '/' || (branch_promotion_id is null) from public.sale_items where sale_id = public.t_pk_sale(93)), '360000/true', 'and carry no promotion');

-- Tarjeta: el recargo va sobre el total ya descontado de TODAS las unidades.
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(94, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 4, 100000, 'PROMO', 1000, null, (select id from cfg where name = 'promo-central'), 3, 1500)), 'DEBIT'))$$, '4 units with a card');
select is((select subtotal_cents || '/' || card_surcharge_cents from public.sale_items where sale_id = public.t_pk_sale(94)), '374000/34000', '$3.400 + 10 % = $3.740');

-- Rechazos del pull de la regla: otra sucursal / inventada.
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(95, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 4, 100000, 'PROMO', 0, null, (select id from cfg where name = 'promo-central'), 3, 2500))))$$,
  '42501', null, 'a percentage the rule does not have is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_payload(96, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_pk_item('a5000000-0000-4000-8000-000000000001', 'Leche', 4, 100000, 'PROMO', 0, null, (select id from cfg where name = 'promo-central'), 2, 1500))))$$,
  '42501', null, 'a minimum the rule does not have (2 vs 3) is rejected');

-- ---------------------------------------------------------------------------------------------
-- 4. Compatibilidad con cajas que todavía mandan el formato anterior ("cada N")
-- ---------------------------------------------------------------------------------------------
-- Una caja sin actualizar vendió 4 unidades con la regla 3/15 % como "cada 3": 3 unidades con descuento.
-- Las reglas "cada N" (semantics EVERY_GROUP) existen sólo desde antes de 061, que las cierra: acá se reproducen cerradas, una hace 1 h
-- (una caja sin actualizar que todavía no sincronizó) y otra hace 3 días.
reset role;
select is((select semantics from public.branch_promotions where id = (select id from cfg where name = 'promo-central')), 'FROM_MINIMUM', 'a rule created now has the "desde N" semantics');
with ins as (
  insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps, semantics, active, valid_from, valid_until)
  values ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 3, 1500, 'EVERY_GROUP', false, now() - interval '10 days', now() - interval '1 hour')
  returning id
) insert into cfg select 'legacy-rule', id from ins;
with ins as (
  insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps, semantics, active, valid_from, valid_until)
  values ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 3, 1500, 'EVERY_GROUP', false, now() - interval '20 days', now() - interval '3 days')
  returning id
) insert into cfg select 'legacy-old', id from ins;
create function public.t_pk_legacy_line(p_seq integer, p_qty integer, p_discounted integer, p_rule text default 'legacy-rule')
returns jsonb language plpgsql security definer as $$
declare disc bigint := round(100000::numeric * p_discounted * 1500 / 10000)::bigint; sub bigint := 100000 * p_qty - disc;
begin
  return public.t_pk_payload(p_seq, 'a3000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', jsonb_build_array(
    jsonb_build_object('productId', 'a5000000-0000-4000-8000-000000000001', 'productNameSnapshot', 'Leche', 'quantityUnits', p_qty,
      'pricePerKgCents', round(sub::numeric / p_qty)::bigint::text, 'originalPricePerKgCents', '100000', 'discountCents', disc::text, 'cashDiscountBps', '0',
      'cashDiscountCents', '0', 'cardSurchargeCents', '0', 'promotionDiscountCents', disc::text, 'subtotalCents', sub::text,
      'branchPromotionId', (select id from cfg where name = p_rule), 'branchPromotionEveryUnits', 3, 'branchPromotionDiscountBps', 1500,
      'branchPromotionDiscountedUnits', p_discounted, 'branchPromotionDiscountCents', disc::text)));
end $$;
grant execute on function public.t_pk_legacy_line(integer, integer, integer, text) to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_legacy_line(100, 4, 3))$$, 'a sale from a box that has not been updated ("cada 3": 3 of 4 units) still syncs');
select is((select branch_promotion_discounted_units || '/' || branch_promotion_every_units || '/' || subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(100)), '3/3/355000', 'it is stored as it was sold: 3 discounted units, $3.550');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_legacy_line(101, 8, 6))$$, 'a legacy 8 units (6 discounted) syncs too');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_legacy_line(102, 4, 4))$$, '22023', null, 'the legacy format cannot discount every unit (that is only valid with the new minimum key)');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_legacy_line(103, 2, 3))$$, '22023', null, 'nor discount units the line does not have');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', (public.t_pk_legacy_line(104, 4, 3) #- '{items,0,branchPromotionEveryUnits}') #- '{items,0,branchPromotionId}')$$, '22023', null, 'a promotion snapshot without its rule is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', jsonb_set(public.t_pk_legacy_line(105, 4, 3), '{items,0,branchPromotionMinimumUnits}', '3'))$$, '22023', null, 'a line cannot carry both the legacy and the new key');
select is((select count(*) from public.sales where id in (public.t_pk_sale(102), public.t_pk_sale(103), public.t_pk_sale(104), public.t_pk_sale(105))), 0::bigint, 'rejected legacy sales left nothing behind');

-- Una venta hecha ANTES del cierre de la regla anterior (2 h atrás; la regla se cerró hace 1 h) sincroniza con su semántica histórica.
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_legacy_line(106, 4, 3) || jsonb_build_object('createdAt', now() - interval '2 hours', 'completedAt', now() - interval '2 hours'))$$, 'an old offline sale made before the old rule was closed syncs with its historical semantics');
select is((select branch_promotion_discounted_units || '/' || subtotal_cents from public.sale_items where sale_id = public.t_pk_sale(106)), '3/355000', 'and keeps "cada 3": 3 of 4 units discounted');
reset role;
select is((select r.semantics from public.sale_items i join public.branch_promotions r on r.id = i.branch_promotion_id where i.sale_id = public.t_pk_sale(106)), 'EVERY_GROUP', 'the sale points at the superseded rule, so the semantics it was sold with stays identifiable');
select is((select r.semantics from public.sale_items i join public.branch_promotions r on r.id = i.branch_promotion_id where i.sale_id = public.t_pk_sale(84)), 'FROM_MINIMUM', 'while a new sale points at a "desde N" rule');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

-- Pero una caja vieja NO puede seguir generando ventas nuevas con "cada N" cuando ya corresponde la regla nueva.
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_legacy_line(107, 4, 3, 'legacy-old'))$$, '42501', null, 'a NEW sale (now) with the "cada N" rule closed 3 days ago is rejected');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_legacy_line(108, 4, 3, 'promo-central'))$$, '42501', null, 'the "cada N" format against the current "desde N" rule is rejected (the old interpretation cannot ride on the new rule)');
select throws_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_promo_line(109, 4, 'a5000000-0000-4000-8000-000000000001', 'Leche', 'legacy-rule'))$$, '42501', null, 'the "desde N" format against the old "cada N" rule is rejected too');
select lives_ok($$select public.t_pk_sync('a7000000-0000-4000-8000-000000000001', public.t_pk_legacy_line(110, 4, 3, 'legacy-old') || jsonb_build_object('createdAt', now() - interval '3 days 1 hour', 'completedAt', now() - interval '3 days 1 hour'))$$, 'while a sale made before that rule was closed (3 days 1 h ago) still syncs with its historical semantics');
select is((select count(*) from public.sales where id in (public.t_pk_sale(107), public.t_pk_sale(108), public.t_pk_sale(109))), 0::bigint, 'the rejected "cada N" sales left nothing behind');

-- Una caja sin actualizar lee la clave anterior (branchPromotions): siempre vacía, así deja de aplicar "cada N". El POS nuevo lee la nueva.
select is(public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'branchPromotions', '[]'::jsonb, 'the key a POS from before 061 reads is empty: it stops applying the promotion instead of selling with the old semantics');
select is(
  public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'branchPromotionsFromMinimum' -> 0 ->> 'minimumUnits', '3',
  'the current POS reads minimumUnits from branchPromotionsFromMinimum'
);
select is(
  (public.pull_pos_state('a7000000-0000-4000-8000-000000000001', 0) -> 'branchPromotionsFromMinimum' -> 0) ? 'everyUnits', false,
  'and the "every" name is gone from the rule it receives'
);
reset role;
select is(
  (app_private.wa_sale_ticket_json(public.t_pk_sale(84)) -> 'items' -> 0 ->> 'branchPromotionMinimumUnits')::int, 3,
  'the WhatsApp ticket facts carry branchPromotionMinimumUnits'
);
select is(
  (app_private.wa_sale_ticket_json(public.t_pk_sale(84)) -> 'items' -> 0 ->> 'branchPromotionDiscountedUnits')::int, 4,
  'with all 4 units discounted'
);

-- ---------------------------------------------------------------------------------------------
-- 5. Admin ya desplegado (antes de 061): sigue pudiendo llamar save_branch_promotion con p_every_units y leer every_units
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.save_branch_promotion(p_branch_id := 'a3000000-0000-4000-8000-000000000002', p_every_units := 5, p_discount_bps := 1000, p_active := true)$$, 'the Admin deployed before 061 (named parameter p_every_units) can still save the branch promotion');
select is((select minimum_units || '/' || discount_bps || '/' || semantics from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000002' and active), '5/1000/FROM_MINIMUM', 'its value is stored as the minimum quantity of a "desde N" rule');
select is((select every_units from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000002' and active), 5, 'and the old Admin screen can still read the column it selects (every_units)');
select lives_ok($$select public.save_branch_promotion('a3000000-0000-4000-8000-000000000002', 6, 1000)$$, 'the positional call of the old Admin works too');
select is((select count(*) from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000002'), 2::bigint, 'editing closes the previous rule and opens a new one (history kept)');
select lives_ok($$select public.save_branch_promotion(p_branch_id := 'a3000000-0000-4000-8000-000000000002', p_every_units := 0, p_discount_bps := 0, p_active := false)$$, 'the old Admin can also deactivate the promotion');
select is((select count(*) from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000002' and active), 0::bigint, 'no active rule is left');
select throws_ok($$select public.save_branch_promotion(p_branch_id := 'a3000000-0000-4000-8000-000000000002', p_every_units := 1, p_discount_bps := 1500, p_active := true)$$, '22023', null, 'and its validation still applies (a minimum of 1 is rejected)');
select throws_ok($$insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps, every_units) values ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 3, 1500, 3)$$, '428C9', null, 'the alias column is generated: nobody can write it (and clients cannot write the table at all)');


select * from finish();
rollback;
