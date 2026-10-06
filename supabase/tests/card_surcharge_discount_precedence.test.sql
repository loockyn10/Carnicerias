begin;

create extension if not exists pgtap with schema extensions;
select plan(49);

-- D-044 + D-061 + D-063/D-064 + D-068: el recargo por tarjeta NO es una promoción de línea y no compite con ella.
-- Una línea UNIT recibe, a lo sumo, UN descuento (precio manual > Pack > promoción propia > «llevando 3u»); el medio de pago se aplica DESPUÉS,
-- una sola vez sobre el total comercial ya descontado de la línea. La única excepción es el precio MANUAL de Central (D-061): ese precio es el
-- precio final, sin descuento y sin recargo, con cualquier medio de pago.
-- Este archivo prueba exactamente eso, con aritmética calculada a mano (centavos): lista $1.000 = 100000, tarjeta 10 %.
--
--   precio normal + tarjeta   : 2 u = 200000 -> 220000           (recargo 20000)
--   «llevando 3u» 15 % + tarjeta: 3 u = 300000 - 45000 = 255000 -> 280500   (descuento 45000 Y recargo 25500)
--   pack de 8 al 20 % + tarjeta : 800000 - 160000 = 640000 -> 704000       (descuento 160000 Y recargo 64000)
--   pack de 6 al 0 %  + tarjeta : 600000 -> 660000                         (sin descuento, con recargo 60000)
--   precio manual + tarjeta   : 2 u a $900 = 180000 -> 180000    (sin recargo, D-061)

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cs-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"CS Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cs-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"CS Employee"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values ('a2000000-0000-4000-8000-000000000001', 'CS Org', 'cs-org');
insert into public.branches (id, organization_id, name, code) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'CS Central', 'CS-C'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'CS Avenida', 'CS-A');
update public.organizations set production_branch_id = 'a3000000-0000-4000-8000-000000000001' where id = 'a2000000-0000-4000-8000-000000000001';
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002'),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002');
insert into public.categories (id, organization_id, name, slug) values ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'CS Category', 'cs-category');
-- Plain: sin pack ni nada. Pack8: pack de 8 al 20 %. Pack6: pack de 6 al 0 %.
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Plain', 'cs-plain', 'CS-1', 'UNIT'),
  ('a5000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Pack8', 'cs-pack8', 'CS-2', 'UNIT'),
  ('a5000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'Pack6', 'cs-pack6', 'CS-3', 'UNIT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id where p.organization_id = 'a2000000-0000-4000-8000-000000000001';
insert into public.product_prices (organization_id, product_id, price_cents, valid_from)
select 'a2000000-0000-4000-8000-000000000001', p.id, 100000, '2026-01-01T00:00:00Z' from public.products p where p.organization_id = 'a2000000-0000-4000-8000-000000000001';
insert into public.organization_cash_discounts (organization_id, cash_discount_bps, valid_from) values ('a2000000-0000-4000-8000-000000000001', 1000, '2026-01-01T00:00:00Z');
-- Pack de 8 al 20 %, pack de 6 al 0 % (D-068: el pack con 0 % sigue siendo un pack) y «desde 3, 15 %» en Central.
update public.products set pack_size_units = 8, pack_discount_bps = 2000 where sku = 'CS-2';
update public.products set pack_size_units = 6, pack_discount_bps = 0 where sku = 'CS-3';
insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps, semantics)
values ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 3, 1500, 'FROM_MINIMUM');

create function public.t_cs_rule() returns uuid language sql security definer as $$ select id from public.branch_promotions where branch_id = 'a3000000-0000-4000-8000-000000000001' and active $$;
-- La línea del ticket tal como la arma el POS (cálculo independiente en numeric): descuento (Pack o «desde 3») y después recargo UNA vez sobre el total.
create function public.t_cs_item(
  p_product uuid, p_name text, p_qty integer, p_kind text default 'NONE', p_card_bps integer default 0, p_pack_size integer default null, p_pack_bps integer default null,
  p_manual bigint default null
) returns jsonb language plpgsql security definer as $$
declare list bigint := 100000; units integer := p_qty; discounted integer := 0; bps integer := 0; disc bigint := 0; cash bigint; sub bigint; fin bigint; res jsonb;
begin
  if p_kind = 'PACK' then units := p_qty * p_pack_size; discounted := units; bps := p_pack_bps;
  elsif p_kind = 'PROMO' then discounted := case when units >= 3 then units else 0 end; bps := 1500;
  end if;
  if p_manual is not null then
    sub := p_manual * units;
    return jsonb_build_object('productId', p_product, 'productNameSnapshot', p_name, 'quantityUnits', units, 'pricePerKgCents', p_manual::text, 'originalPricePerKgCents', list::text,
      'discountCents', '0', 'cashDiscountBps', '0', 'cashDiscountCents', '0', 'cardSurchargeCents', '0', 'promotionDiscountCents', '0', 'subtotalCents', sub::text,
      'manualPriceApplied', true, 'manualUnitPriceCents', p_manual::text, 'manualAdjustmentCents', (sub - list * units)::text);
  end if;
  disc := round(list::numeric * discounted * bps / 10000)::bigint;
  cash := list * units - disc;
  if discounted = 0 then
    fin := case when p_card_bps > 0 then round(list::numeric * (10000 + p_card_bps) / 10000)::bigint else list end;
    sub := fin * units;
  else
    sub := case when p_card_bps > 0 then round(cash::numeric * (10000 + p_card_bps) / 10000)::bigint else cash end;
    fin := round(sub::numeric / units)::bigint;
  end if;
  res := jsonb_build_object('productId', p_product, 'productNameSnapshot', p_name, 'quantityUnits', units, 'pricePerKgCents', fin::text, 'originalPricePerKgCents', list::text,
    'discountCents', disc::text, 'cashDiscountBps', p_card_bps::text, 'cashDiscountCents', '0', 'cardSurchargeCents', (sub - cash)::text, 'promotionDiscountCents', disc::text, 'subtotalCents', sub::text);
  if p_kind = 'PACK' then
    res := res || jsonb_build_object('soldAsPack', true, 'packCount', p_qty, 'packSizeUnitsSnapshot', p_pack_size, 'packDiscountBps', p_pack_bps, 'packDiscountCents', disc::text,
      'packConfigId', (select v.id from public.product_pack_versions v where v.product_id = p_product and v.pack_size_units = p_pack_size and v.discount_bps = p_pack_bps order by v.valid_to nulls first limit 1));
  elsif p_kind = 'PROMO' and discounted > 0 then
    res := res || jsonb_build_object('branchPromotionId', public.t_cs_rule(), 'branchPromotionMinimumUnits', 3, 'branchPromotionDiscountBps', bps,
      'branchPromotionDiscountedUnits', discounted, 'branchPromotionDiscountCents', disc::text);
  end if;
  return res;
end $$;

create function public.t_cs_sync(p_seq integer, p_item jsonb, p_method text, p_at timestamptz default null) returns jsonb language plpgsql as $$
declare
  base text := 'a6000000-0000-4000-8000-'; at timestamptz := coalesce(p_at, now() - interval '1 minute'); total bigint := (p_item->>'subtotalCents')::bigint; event_id text := base || lpad((p_seq * 1000 + 1)::text, 12, '0');
  payload jsonb;
begin
  payload := jsonb_build_object(
    'schemaVersion', 1, 'eventId', event_id, 'saleId', base || lpad((p_seq * 1000 + 2)::text, 12, '0'),
    'organizationId', 'a2000000-0000-4000-8000-000000000001', 'branchId', 'a3000000-0000-4000-8000-000000000001', 'profileId', 'a1000000-0000-4000-8000-000000000002',
    'deviceId', 'a7000000-0000-4000-8000-000000000001', 'status', 'COMPLETED', 'totalCents', total::text, 'totalWeightGrams', '0', 'createdAt', at, 'completedAt', at,
    'items', jsonb_build_array(p_item || jsonb_build_object('id', base || lpad((p_seq * 1000 + 101)::text, 12, '0'))),
    'payment', jsonb_build_object('id', base || lpad((p_seq * 1000 + 3)::text, 12, '0'), 'method', p_method, 'amountCents', total::text),
    'stockMovements', jsonb_build_array(jsonb_build_object('id', base || lpad((p_seq * 1000 + 201)::text, 12, '0'), 'productId', p_item->>'productId', 'quantityGrams', (-(p_item->>'quantityUnits')::bigint)::text, 'occurredAt', at)));
  return public.sync_offline_sale('a7000000-0000-4000-8000-000000000001', event_id::uuid, payload);
end $$;
create function public.t_cs_sale(p_seq integer) returns uuid language sql immutable as $$ select ('a6000000-0000-4000-8000-' || lpad((p_seq * 1000 + 2)::text, 12, '0'))::uuid $$;
create function public.t_cs_row(p_seq integer) returns text language sql security definer as $$
  select subtotal_cents || '/' || card_surcharge_cents || '/' || promotion_discount_cents || '/' || (select total_cents from public.sales where id = public.t_cs_sale(p_seq))
  from public.sale_items where sale_id = public.t_cs_sale(p_seq) $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.register_pos_device('a7000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'Caja Central')$$, 'the Central device is registered');

-- ---------------------------------------------------------------------------------------------
-- 1. Precio normal + tarjeta: el recargo se aplica sobre la lista (por unidad), efectivo no paga recargo
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.t_cs_sync(1, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 1000), 'DEBIT')$$, 'normal line paid with a card syncs');
select is(public.t_cs_row(1), '220000/20000/0/220000', 'normal + card: 2 x $1.000 = $2.000 -> $2.200 (surcharge $200, no discount)');
select lives_ok($$select public.t_cs_sync(2, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 0), 'CASH')$$, 'the same line in cash syncs');
select is(public.t_cs_row(2), '200000/0/0/200000', 'normal + cash: $2.000, no surcharge (cash/transfer pay the list price)');
select is((select cash_discount_bps from public.sale_items where sale_id = public.t_cs_sale(1)), 1000, 'the card percentage used (10 %) is stored on the line as its snapshot');

-- ---------------------------------------------------------------------------------------------
-- 2. «Llevando 3u» (desde 3, 15 %) + tarjeta: el descuento Y el recargo conviven en la misma línea
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.t_cs_sync(4, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 3, 'PROMO', 1000), 'DEBIT')$$, '3 units with the 3u promotion paid with a card sync');
select is(public.t_cs_row(4), '280500/25500/45000/280500', '3u + card: $3.000 - 15 % = $2.550, then +10 % = $2.805 (discount $450 AND surcharge $255 on the same line)');
select is((select branch_promotion_discount_cents || '/' || branch_promotion_discount_bps from public.sale_items where sale_id = public.t_cs_sale(4)), '45000/1500', 'the promotion snapshot keeps its 15 % even though the line paid a surcharge');
select lives_ok($$select public.t_cs_sync(5, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 3, 'PROMO', 0), 'CASH')$$, 'the same 3 units in cash sync');
select is(public.t_cs_row(5), '255000/0/45000/255000', '3u + cash: $2.550 (discount, no surcharge)');
select lives_ok($$select public.t_cs_sync(6, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'PROMO', 1000), 'DEBIT')$$, '2 units (below the minimum) with a card sync');
select is(public.t_cs_row(6), '220000/20000/0/220000', '2 units + card: no promotion (below 3), the surcharge still applies');
select throws_ok($$select public.t_cs_sync(14, jsonb_set(public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 3, 'PROMO', 1000), '{cardSurchargeCents}', '"0"'::jsonb), 'DEBIT')$$, '22023', null, 'a 3u line paid with a card that drops the surcharge is rejected');

-- ---------------------------------------------------------------------------------------------
-- 3. Pack + tarjeta (y pack al 0 % + tarjeta)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.t_cs_sync(7, public.t_cs_item('a5000000-0000-4000-8000-000000000002', 'Pack8', 1, 'PACK', 1000, 8, 2000), 'DEBIT')$$, 'a pack of 8 at 20 % paid with a card syncs');
select is(public.t_cs_row(7), '704000/64000/160000/704000', 'pack + card: 8 x $1.000 = $8.000 - 20 % = $6.400, then +10 % = $7.040 (discount $1.600 AND surcharge $640)');
select lives_ok($$select public.t_cs_sync(8, public.t_cs_item('a5000000-0000-4000-8000-000000000002', 'Pack8', 1, 'PACK', 0, 8, 2000), 'CASH')$$, 'the same pack in cash syncs');
select is(public.t_cs_row(8), '640000/0/160000/640000', 'pack + cash: $6.400');
select lives_ok($$select public.t_cs_sync(9, public.t_cs_item('a5000000-0000-4000-8000-000000000003', 'Pack6', 1, 'PACK', 1000, 6, 0), 'DEBIT')$$, 'a pack of 6 at 0 % paid with a card syncs');
select is(public.t_cs_row(9), '660000/60000/0/660000', 'pack at 0 % + card: $6.000, no discount, +10 % = $6.600 (the surcharge is not lost without a discount)');
select lives_ok($$select public.t_cs_sync(10, public.t_cs_item('a5000000-0000-4000-8000-000000000003', 'Pack6', 1, 'PACK', 0, 6, 0), 'CASH')$$, 'the 0 % pack in cash syncs');
select is(public.t_cs_row(10), '600000/0/0/600000', 'pack at 0 % + cash: $6.000');
select is((select pack_discount_bps || '/' || pack_discount_cents || '/' || sold_as_pack from public.sale_items where sale_id = public.t_cs_sale(10)), '0/0/true', 'the 0 % pack keeps its snapshot (sold as pack, 0 bps, $0)');
select throws_ok($$select public.t_cs_sync(15, jsonb_set(public.t_cs_item('a5000000-0000-4000-8000-000000000002', 'Pack8', 1, 'PACK', 1000, 8, 2000), '{cardSurchargeCents}', '"0"'::jsonb), 'DEBIT')$$, '22023', null, 'a pack paid with a card that drops the surcharge is rejected');

-- ---------------------------------------------------------------------------------------------
-- 4. Precio manual (Central, D-061) + tarjeta: el precio fijado es el final; NO hay recargo (decisión vigente, no un olvido)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.t_cs_sync(11, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 1000, null, null, 90000), 'DEBIT')$$, 'a manual-price line paid with a card syncs');
select is(public.t_cs_row(11), '180000/0/0/180000', 'manual + card: 2 x $900 = $1.800, no surcharge and no discount (the manual price is final)');
select is((select manual_price_applied from public.sale_items where sale_id = public.t_cs_sale(11)), true, 'the line is flagged manual');
select lives_ok($$select public.t_cs_sync(12, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 0, null, null, 90000), 'CASH')$$, 'the same manual line in cash syncs');
select is(public.t_cs_row(12), '180000/0/0/180000', 'manual + cash: the same $1.800: the payment method does not change a manual price');
select throws_ok($$select public.t_cs_sync(16, jsonb_set(public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 1000, null, null, 90000), '{subtotalCents}', '"198000"'::jsonb), 'DEBIT')$$, '22023', null, 'a manual line that adds a surcharge on top of the manual price is rejected');

-- ---------------------------------------------------------------------------------------------
-- 5. Una línea nunca recibe dos descuentos: el recargo no cuenta como descuento y el Pack no se acumula con «llevando 3u»
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.t_cs_sync(13, public.t_cs_item('a5000000-0000-4000-8000-000000000002', 'Pack8', 1, 'PACK', 1000, 8, 2000) || jsonb_build_object(
  'branchPromotionId', public.t_cs_rule(), 'branchPromotionMinimumUnits', 3, 'branchPromotionDiscountBps', 1500, 'branchPromotionDiscountedUnits', 8, 'branchPromotionDiscountCents', '120000'), 'DEBIT')$$, '22023', null, 'a pack paid with a card that also claims the 3u promotion is rejected (one discount per line; the surcharge is not one)');
select is((select count(*) from public.sale_items where branch_promotion_id is not null and sold_as_pack), 0::bigint, 'no stored line has both a pack and a promotion');

-- ---------------------------------------------------------------------------------------------
-- 6. El recargo que trae una venta OFFLINE se valida contra la configuración histórica de SU momento (no contra la de hoy)
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.t_cs_sync(30, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 0), 'CREDIT')$$, '22023', null, 'a card sale that claims 0 % when the configuration says 10 % is rejected');
select throws_ok($$select public.t_cs_sync(31, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 500), 'DEBIT')$$, '22023', null, 'a consistent but invented 5 % surcharge is rejected');
select throws_ok($$select public.t_cs_sync(32, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 3, 'PROMO', 0), 'DEBIT')$$, '22023', null, 'a 3u line paid with a card that claims 0 % is rejected');
select throws_ok($$select public.t_cs_sync(33, public.t_cs_item('a5000000-0000-4000-8000-000000000002', 'Pack8', 1, 'PACK', 0, 8, 2000), 'DEBIT')$$, '22023', null, 'a pack paid with a card that claims 0 % is rejected');
select lives_ok($$select public.t_cs_sync(34, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 0), 'TRANSFER')$$, 'a transfer carries no surcharge and is not affected by the card configuration');

-- El recargo cambió de 10 % a 15 % hace 3 días.
reset role;
-- la promoción y las versiones de pack ya existían hace 10 días (para poder probar ventas viejas con ellas)
update public.branch_promotions set valid_from = now() - interval '10 days';
update public.product_pack_versions set valid_from = now() - interval '10 days';
update public.organization_cash_discounts set valid_to = now() - interval '3 days' where organization_id = 'a2000000-0000-4000-8000-000000000001' and valid_to is null;
insert into public.organization_cash_discounts (organization_id, cash_discount_bps, valid_from) values ('a2000000-0000-4000-8000-000000000001', 1500, now() - interval '3 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.t_cs_sync(35, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 1000), 'DEBIT')$$, '22023', null, 'a sale made TODAY with the old 10 % (which ended 3 days ago) is rejected');
select lives_ok($$select public.t_cs_sync(36, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 1500), 'DEBIT')$$, 'a sale made today with the current 15 % is accepted');
select is(public.t_cs_row(36), '230000/30000/0/230000', '15 %: 2 x $1.000 -> $2.300');
select lives_ok($$select public.t_cs_sync(37, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 1000), 'DEBIT', now() - interval '3 days 1 hour')$$, 'an offline sale CREATED before the change (10 %) syncs after it and is valid');
select is(public.t_cs_row(37), '220000/20000/0/220000', 'it keeps ITS configuration (10 %), not today''s 15 %');
select is((select cash_discount_bps from public.sale_items where sale_id = public.t_cs_sale(37)), 1000, 'and stores 10 % as its snapshot');
select throws_ok($$select public.t_cs_sync(38, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 1500), 'DEBIT', now() - interval '3 days 1 hour')$$, '22023', null, 'a sale made before the change cannot claim the 15 % that did not exist yet');
select lives_ok($$select public.t_cs_sync(39, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 1000), 'DEBIT', now() - interval '2 days 23 hours')$$, 'a register that has not pulled the change yet (< 24 h after it) still sells with the previous 10 %');
select lives_ok($$select public.t_cs_sync(40, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 3, 'PROMO', 1000), 'DEBIT', now() - interval '3 days 1 hour')$$, '3u + card created before the change is valid with its own 10 %');
select lives_ok($$select public.t_cs_sync(41, public.t_cs_item('a5000000-0000-4000-8000-000000000002', 'Pack8', 1, 'PACK', 1000, 8, 2000), 'DEBIT', now() - interval '3 days 1 hour')$$, 'pack + card created before the change is valid with its own 10 %');
select is(public.t_cs_row(41), '704000/64000/160000/704000', '...and keeps its amounts');
select lives_ok($$select public.t_cs_sync(42, public.t_cs_item('a5000000-0000-4000-8000-000000000001', 'Plain', 2, 'NONE', 0), 'CASH')$$, 'cash is unaffected by any of this');

select * from finish();
rollback;
