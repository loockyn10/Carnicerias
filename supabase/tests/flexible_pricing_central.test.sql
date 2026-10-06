begin;

create extension if not exists pgtap with schema extensions;
select plan(101);

-- D-061: precio manual por línea y descuento general del ticket (sólo POS de Central).
-- Fixture: una organización con Central (sucursal productiva) y Avenida, un empleado con acceso a ambas,
-- un empleado ajeno, un admin y tres productos (Coca Cola UNIT $12.000, Fanta UNIT $14.000, Vacío WEIGHT $15.000/kg).
-- Todo el dinero va en centavos: $12.000 = 1_200_000.

select has_column('public', 'sale_items', 'manual_price_applied', 'sale_items.manual_price_applied exists');
select has_column('public', 'sale_items', 'manual_unit_price_cents', 'sale_items.manual_unit_price_cents exists');
select has_column('public', 'sale_items', 'manual_adjustment_cents', 'sale_items.manual_adjustment_cents exists');
select has_column('public', 'sale_items', 'ticket_discount_cents', 'sale_items.ticket_discount_cents exists');
select has_column('public', 'sales', 'ticket_discount_bps', 'sales.ticket_discount_bps exists');
select has_column('public', 'sales', 'ticket_discount_cents', 'sales.ticket_discount_cents exists');
select ok(not has_function_privilege('authenticated', 'app_private.allocate_ticket_discount(uuid,uuid[])', 'EXECUTE'), 'the allocation helper is not callable by authenticated');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'flex-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Flex Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'flex-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Flex Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'flex-outsider@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Flex Outsider"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values ('f2000000-0000-4000-8000-000000000001', 'Flex Org', 'flex-org');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Flex Central', 'FLEX-C'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Flex Avenida', 'FLEX-A');
update public.organizations set production_branch_id = 'f3000000-0000-4000-8000-000000000001' where id = 'f2000000-0000-4000-8000-000000000001';
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002'),
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002');
insert into public.categories (id, organization_id, name, slug) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Flex Category', 'flex-category');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'flex-coca', 'FLEX-1', 'UNIT'),
  ('f5000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Fanta 2.25 L', 'flex-fanta', 'FLEX-2', 'UNIT'),
  ('f5000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Vacío', 'flex-vacio', 'FLEX-3', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where p.organization_id = 'f2000000-0000-4000-8000-000000000001';
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 1200000, '2026-01-01T00:00:00Z'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002', 1400000, '2026-01-01T00:00:00Z'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000003', 1500000, '2026-01-01T00:00:00Z');

-- Helpers del test (se descartan con el rollback): una línea del ticket tal como la arma el POS y el payload de sync.
create function public.t_flex_item(p_product uuid, p_name text, p_unit text, p_qty bigint, p_list bigint, p_manual bigint default null, p_card_bps integer default 0)
returns jsonb language plpgsql security definer as $$
declare list_sub bigint; price bigint; sub bigint; surcharge bigint := 0; result jsonb;
begin
  list_sub := case when p_unit = 'WEIGHT' then app_private.round_ratio_half_up(p_list * p_qty, 1000) else p_list * p_qty end;
  price := case when p_manual is not null then p_manual
                when p_card_bps > 0 then app_private.round_ratio_half_up(p_list * (10000 + p_card_bps), 10000)
                else p_list end;
  sub := case when p_unit = 'WEIGHT' then app_private.round_ratio_half_up(price * p_qty, 1000) else price * p_qty end;
  if p_manual is null and p_card_bps > 0 then surcharge := sub - list_sub; end if;
  result := jsonb_build_object(
    'productId', p_product, 'productNameSnapshot', p_name, 'pricePerKgCents', price::text, 'originalPricePerKgCents', p_list::text,
    'discountCents', '0', 'cashDiscountBps', case when p_manual is null then p_card_bps else 0 end::text, 'cashDiscountCents', '0',
    'cardSurchargeCents', surcharge::text, 'promotionDiscountCents', '0', 'subtotalCents', sub::text
  ) || case when p_unit = 'WEIGHT' then jsonb_build_object('weightGrams', p_qty) else jsonb_build_object('quantityUnits', p_qty) end;
  if p_manual is not null then
    result := result || jsonb_build_object('manualPriceApplied', true, 'manualUnitPriceCents', p_manual::text, 'manualAdjustmentCents', (sub - list_sub)::text);
  end if;
  return result;
end $$;

create function public.t_flex_payload(p_seq integer, p_branch uuid, p_device uuid, p_items jsonb, p_method text default 'CASH', p_bps integer default 0, p_discount bigint default 0, p_provider text default null)
returns jsonb language plpgsql as $$
declare
  base text := 'f6000000-0000-4000-8000-';
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
    'organizationId', 'f2000000-0000-4000-8000-000000000001', 'branchId', p_branch, 'profileId', 'f1000000-0000-4000-8000-000000000002',
    'deviceId', p_device, 'status', 'COMPLETED', 'totalCents', total::text, 'totalWeightGrams', weight::text, 'createdAt', at, 'completedAt', at,
    'items', items,
    'payment', jsonb_build_object('id', base || lpad((p_seq * 1000 + 3)::text, 12, '0'), 'method', p_method, 'amountCents', total::text)
      || case when p_provider is not null then jsonb_build_object('provider', p_provider) else '{}'::jsonb end,
    'stockMovements', moves
  ) || case when p_bps > 0 then jsonb_build_object('ticketDiscountBps', p_bps::text, 'ticketDiscountCents', p_discount::text, 'subtotalCents', subtotal::text) else '{}'::jsonb end;
end $$;

create function public.t_sale(p_seq integer) returns uuid language sql immutable as $$
  select ('f6000000-0000-4000-8000-' || lpad((p_seq * 1000 + 2)::text, 12, '0'))::uuid $$;
create function public.t_sync(p_device uuid, p_payload jsonb) returns jsonb language sql as $$
  select public.sync_offline_sale(p_device, (p_payload->>'eventId')::uuid, p_payload) $$;
-- Dispositivos: sólo para leer los ids en las llamadas de abajo.
-- Central = f7...01, Avenida = f7...02.

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select lives_ok($$select public.register_pos_device('f7000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Caja Central')$$, 'the Central device is registered');
select lives_ok($$select public.register_pos_device('f7000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000002', 'Caja Avenida')$$, 'the Avenida device is registered');

-- 1. Precio manual UNIT: Coca Cola de $12.000 vendida a $10.000.
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(1, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000))))$$,
  'Central: a manual UNIT price syncs through the normal flow');
select is((select manual_price_applied from public.sale_items where sale_id = public.t_sale(1)), true, 'the line is flagged as a manual price');
select is((select manual_unit_price_cents from public.sale_items where sale_id = public.t_sale(1)), 1000000::bigint, 'the manual price charged ($10.000) is a snapshot');
select is((select original_price_per_kg_cents from public.sale_items where sale_id = public.t_sale(1)), 1200000::bigint, 'the original price ($12.000) is preserved');
select is((select manual_adjustment_cents from public.sale_items where sale_id = public.t_sale(1)), -200000::bigint, 'the manual adjustment is -$2.000');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_sale(1)), 1000000::bigint, 'the line is charged the manual price');
select is((select card_surcharge_cents + promotion_discount_cents + discount_cents from public.sale_items where sale_id = public.t_sale(1)), 0::bigint, 'a manual line carries no promotion, discount or surcharge');
select is((select total_cents from public.sales where id = public.t_sale(1)), 1000000::bigint, 'the sale total is what was charged');
select is((select amount_cents from public.payments where sale_id = public.t_sale(1)), 1000000::bigint, 'the payment is what was charged');
select is((select count(*)::integer from public.product_prices where product_id = 'f5000000-0000-4000-8000-000000000001'), 1, 'a manual price never writes product_prices');
select is((select price_cents from public.product_prices where product_id = 'f5000000-0000-4000-8000-000000000001'), 1200000::bigint, 'the catalog price is untouched');
select is((select -quantity_grams from public.stock_movements where sale_id = public.t_sale(1) and type = 'SALE'), 1::bigint, 'stock still moves by the sold quantity');

-- 2. Precio manual WEIGHT: 1,250 kg de Vacío a $13.000/kg (lista $15.000/kg).
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(2, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000003', 'Vacío', 'WEIGHT', 1250, 1500000, 1300000))))$$,
  'Central: a manual WEIGHT price (per kg) syncs');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_sale(2)), 1625000::bigint, '1,250 kg at $13.000/kg = $16.250');
select is((select manual_adjustment_cents from public.sale_items where sale_id = public.t_sale(2)), -250000::bigint, 'the weight adjustment is exact against list ($18.750)');
select is((select total_weight_grams from public.sales where id = public.t_sale(2)), 1250::bigint, 'the real weight still feeds the sale');

-- 3. 5% general sobre $24.000 con una línea manual: descuenta $1.200 y cobra $22.800.
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(3, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000),
                    public.t_flex_item('f5000000-0000-4000-8000-000000000002', 'Fanta 2.25 L', 'UNIT', 1, 1400000)), 'CASH', 500, 120000))$$,
  'Central: a manual line plus a 5% ticket discount syncs');
select is((select total_cents from public.sales where id = public.t_sale(3)), 2280000::bigint, 'total charged = $24.000 - 5% = $22.800');
select is((select ticket_discount_bps from public.sales where id = public.t_sale(3)), 500, 'the discount percentage is a snapshot (500 bps)');
select is((select ticket_discount_cents from public.sales where id = public.t_sale(3)), 120000::bigint, 'the discount amount is -$1.200');
select is((select amount_cents from public.payments where sale_id = public.t_sale(3)), 2280000::bigint, 'the payment equals the discounted total');
select is((select sum(subtotal_cents)::bigint from public.sale_items where sale_id = public.t_sale(3)), 2400000::bigint, 'the lines keep their undiscounted subtotals');
select is((select array_agg(ticket_discount_cents order by product_name_snapshot)::text from public.sale_items where sale_id = public.t_sale(3)), '{50000,70000}', 'the discount is allocated to each line proportionally ($500 Coca / $700 Fanta)');
select is((select sum(ticket_discount_cents)::bigint from public.sale_items where sale_id = public.t_sale(3)), 120000::bigint, 'the allocation adds up exactly to the ticket discount');

-- 4/5/6. Otros porcentajes sobre $26.000 (Coca $12.000 + Fanta $14.000, ambas normales).
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(4, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000), public.t_flex_item('f5000000-0000-4000-8000-000000000002', 'Fanta 2.25 L', 'UNIT', 1, 1400000)), 'CASH', 1000, 260000))$$,
  'Central: a 10% ticket discount syncs');
select is((select total_cents from public.sales where id = public.t_sale(4)), 2340000::bigint, '10% of $26.000 -> $23.400');
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(5, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000), public.t_flex_item('f5000000-0000-4000-8000-000000000002', 'Fanta 2.25 L', 'UNIT', 1, 1400000)), 'CASH', 1250, 325000))$$,
  'Central: a decimal 12,5% ticket discount syncs');
select is((select total_cents from public.sales where id = public.t_sale(5)), 2275000::bigint, '12,5% of $26.000 -> $22.750');
select is((select ticket_discount_bps from public.sales where id = public.t_sale(5)), 1250, '12,5% is stored as 1250 bps');
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(6, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 123457)), 'CASH', 725, 8951))$$,
  'Central: 7,25% of $1.234,57 rounds half-up to $89,51');
select is((select total_cents from public.sales where id = public.t_sale(6)), 114506::bigint, 'total = subtotal - rounded discount, no orphan cents');

-- 7. Tarjeta: la línea normal lleva recargo, la manual no; el descuento general va sobre el subtotal ya recargado.
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(7, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000),
                    public.t_flex_item('f5000000-0000-4000-8000-000000000002', 'Fanta 2.25 L', 'UNIT', 1, 1400000, null, 1000)), 'DEBIT', 500, 127000))$$,
  'Central: card payment = manual line unchanged + surcharged normal line + 5% ticket discount');
select is((select total_cents from public.sales where id = public.t_sale(7)), 2413000::bigint, '($10.000 manual + $15.400 with card) - 5% = $24.130');
select is((select sum(card_surcharge_cents)::bigint from public.sale_items where sale_id = public.t_sale(7)), 140000::bigint, 'only the normal line carries the card surcharge');

-- 8/9. Reparto del descuento con centavos sobrantes (mayor resto; empate: la primera línea del ticket).
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(8, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 100),
                    public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 100),
                    public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 100)), 'CASH', 33, 1))$$,
  'Central: a 1-cent discount over three equal lines syncs');
select is((select array_agg(ticket_discount_cents order by id)::text from public.sale_items where sale_id = public.t_sale(8)), '{1,0,0}', 'the odd cent goes to the first line of the ticket');
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(9, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1000),
                    public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1000),
                    public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1000)), 'CASH', 3333, 1000))$$,
  'Central: a 33,33% discount over three equal lines syncs');
select is((select array_agg(ticket_discount_cents order by id)::text from public.sale_items where sale_id = public.t_sale(9)), '{334,333,333}', '1000 cents over three equal lines = 334/333/333');
-- Un porcentaje que redondea a 0 centavos se registra igual (5% de $0,09).
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(10, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 9)), 'CASH', 500, 0))$$,
  'Central: a percentage that rounds to zero cents is accepted');
select is((select ticket_discount_bps from public.sales where id = public.t_sale(10)), 500, 'the percentage is recorded even when the amount is zero');
select is((select total_cents from public.sales where id = public.t_sale(10)), 9::bigint, 'and the total is the full subtotal');

-- 11. Mercado Pago: la venta nace pendiente con el TOTAL FINAL como monto a cobrar.
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(11, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000), public.t_flex_item('f5000000-0000-4000-8000-000000000002', 'Fanta 2.25 L', 'UNIT', 1, 1400000)),
  'TRANSFER', 500, 120000, 'MERCADOPAGO'))$$,
  'Central: a Mercado Pago sale with a manual line and a discount syncs');
select is((select status::text from public.sales where id = public.t_sale(11)), 'PENDING_PAYMENT', 'the Mercado Pago sale stays pending until the backend confirms the credit');
select is((select total_cents from public.sales where id = public.t_sale(11)), 2280000::bigint, 'its total is the discounted total');
select is((select amount_cents from public.payments where sale_id = public.t_sale(11)), 2280000::bigint, 'and so is the amount Mercado Pago must collect');

-- Idempotencia: el mismo evento no duplica; el mismo evento con otro payload se rechaza.
select is((select (public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(3, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000), public.t_flex_item('f5000000-0000-4000-8000-000000000002', 'Fanta 2.25 L', 'UNIT', 1, 1400000)), 'CASH', 500, 120000)) ->> 'duplicate')::boolean),
  true, 'retrying the same event is a harmless duplicate');
select is((select count(*)::integer from public.sales where id = public.t_sale(3)), 1, 'the retry did not duplicate the sale');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(3, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000), public.t_flex_item('f5000000-0000-4000-8000-000000000002', 'Fanta 2.25 L', 'UNIT', 1, 1400000)), 'CASH', 1000, 240000))$$,
  '23505', 'Idempotency key was reused with a different payload', 'the same event with another discount is rejected, a completed sale cannot be altered');
select is((select ticket_discount_cents from public.sales where id = public.t_sale(3)), 120000::bigint, 'the completed sale is unchanged');

-- Sólo Central: Avenida no admite ni precio manual ni descuento general (aunque el POS lo mandara).
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000002', public.t_flex_payload(20, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000))))$$,
  '42501', 'FLEXIBLE_PRICING_NOT_ALLOWED', 'a manual price is rejected outside the production branch');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000002', public.t_flex_payload(21, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 2, 1200000)), 'CASH', 500, 120000))$$,
  '42501', 'FLEXIBLE_PRICING_NOT_ALLOWED', 'a ticket discount is rejected outside the production branch');
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000002', public.t_flex_payload(22, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 2, 1200000, null, 1000)), 'DEBIT'))$$,
  'Avenida still syncs a normal sale exactly as before (a card line now carries its 10 % surcharge: the offline sync validates it, D-068)');
select is((select ticket_discount_bps from public.sales where id = public.t_sale(22)), 0, 'a normal sale has no ticket discount');
select is((select manual_price_applied from public.sale_items where sale_id = public.t_sale(22)), false, 'a normal line is not manual');
select is((select manual_unit_price_cents from public.sale_items where sale_id = public.t_sale(22)), null, 'a normal line has no manual price');

-- Un usuario ajeno a la sucursal no puede sincronizar nada, ni normal ni flexible.
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(23, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000))))$$,
  '42501', 'Device or branch is not authorized for this user', 'a user without access to the device branch cannot sync a manual price');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

-- Validaciones de integridad (Central): nada se guarda si algo no cierra.
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(30, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000), public.t_flex_item('f5000000-0000-4000-8000-000000000002', 'Fanta 2.25 L', 'UNIT', 1, 1400000)), 'CASH', 500, 120000))$$,
  '22023', 'Offline ticket discount does not match its percentage', 'an amount that does not match the percentage is rejected (5% of $26.000 is $1.300)');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001',
  jsonb_set(jsonb_set(public.t_flex_payload(31, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
    jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000), public.t_flex_item('f5000000-0000-4000-8000-000000000002', 'Fanta 2.25 L', 'UNIT', 1, 1400000)), 'CASH', 500, 130000),
    '{totalCents}', '"2600000"'), '{payment,amountCents}', '"2600000"'))$$,
  '22023', 'Offline sale totals do not match its details', 'a declared discount with an undiscounted total is rejected');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(32, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000)), 'CASH', 10001, 1200100))$$,
  '22023', 'Offline ticket discount percentage is outside 0-100%', 'a percentage above 100% is rejected');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(33, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000)), 'CASH', 10000, 1200000))$$,
  '22023', 'Offline sale total must be greater than zero', 'a 100% discount (total $0) cannot be charged');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(34, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000)), 'CASH', 500, 60000) - 'ticketDiscountCents')$$,
  '22023', 'Offline ticket discount needs both its percentage and its amount', 'a half-declared discount is rejected');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001',
  jsonb_set(public.t_flex_payload(35, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
    jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000)), 'CASH', 500, 60000), '{subtotalCents}', '"9999999"'))$$,
  '22023', 'Offline ticket subtotal does not match its items', 'a declared pre-discount subtotal that is not the sum of the lines is rejected');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001',
  jsonb_set(public.t_flex_payload(36, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
    jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 2, 1200000, 1000000))), '{items,0,subtotalCents}', '"1900000"'))$$,
  '22023', 'Offline manual price arithmetic is invalid', 'a manual line whose subtotal is not price x quantity is rejected');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001',
  jsonb_set(public.t_flex_payload(37, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
    jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000))), '{items,0,manualAdjustmentCents}', '"-100000"'))$$,
  '22023', 'Offline manual price arithmetic is invalid', 'a manual adjustment that is not subtotal - list is rejected');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001',
  jsonb_set(public.t_flex_payload(38, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
    jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000))), '{items,0,cardSurchargeCents}', '"100000"'))$$,
  '22023', 'Offline manual price line is inconsistent', 'a manual line cannot carry a card surcharge');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001',
  jsonb_set(public.t_flex_payload(39, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
    jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000))), '{items,0,promotionMode}', '"PACK_FIXED_TOTAL"'))$$,
  '22023', 'Offline manual price line is inconsistent', 'a manual line cannot also be a promotion pack');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(40, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 0))))$$,
  '22023', 'Offline sale item values are invalid', 'a manual price of $0 is rejected');
select throws_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001',
  jsonb_set(public.t_flex_payload(41, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
    jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000))), '{items,0,manualUnitPriceCents}', '"1200000"'))$$,
  '22023', 'Offline manual price metadata without a manual price', 'manual price metadata without the manual flag is rejected');
select is((select count(*)::integer from public.sales where id in (public.t_sale(20), public.t_sale(21), public.t_sale(30), public.t_sale(31), public.t_sale(32), public.t_sale(33), public.t_sale(34), public.t_sale(35), public.t_sale(36), public.t_sale(37), public.t_sale(38), public.t_sale(39), public.t_sale(40), public.t_sale(41))), 0, 'no rejected sale left anything behind');

-- Una sincronización posterior NO recalcula contra el precio de catálogo vigente: el precio manual y el precio
-- original quedan como se vendieron aunque el catálogo haya cambiado entretanto.
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.set_product_price('f5000000-0000-4000-8000-000000000001', null, 1500000)$$, 'the admin raises the Coca Cola catalog price to $15.000 (history is closed, not rewritten)');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.t_sync('f7000000-0000-4000-8000-000000000001', public.t_flex_payload(50, 'f3000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  jsonb_build_array(public.t_flex_item('f5000000-0000-4000-8000-000000000001', 'Coca Cola 2.25 L', 'UNIT', 1, 1200000, 1000000))))$$,
  'a manual sale made offline at the old list price still syncs after the catalog price changed');
select is((select original_price_per_kg_cents from public.sale_items where sale_id = public.t_sale(50)), 1200000::bigint, 'the original price is the snapshot, not the current catalog price ($15.000)');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_sale(50)), 1000000::bigint, 'and the manual price is not recalculated');
select is((select original_price_per_kg_cents from public.sale_items where sale_id = public.t_sale(1)), 1200000::bigint, 'an earlier sale keeps its snapshot after the catalog change');

-- Compatibilidad: la venta online del POS web (complete_discounted_sale) no cambia y queda sin precio manual ni descuento.
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.complete_discounted_sale('f3000000-0000-4000-8000-000000000001',
  jsonb_build_array(jsonb_build_object('product_id','f5000000-0000-4000-8000-000000000002','quantity_units',2,'expected_price_per_unit_cents','1400000')), 'CASH')$$,
  'the online RPC still completes a normal sale');
select is((select count(*)::integer from public.sale_items where manual_price_applied and sale_id = (select id from public.sales order by created_at desc limit 1)), 0, 'the online sale has no manual lines');

-- Rendiciones: usan el total FINAL (efectivo esperado = pagos CASH); Mercado Pago pendiente no suma.
select is((public.get_settlement_preview('f3000000-0000-4000-8000-000000000001',
  (now() at time zone (select timezone from public.organizations where id = 'f2000000-0000-4000-8000-000000000001')) - interval '1 day',
  date_trunc('minute', now() at time zone (select timezone from public.organizations where id = 'f2000000-0000-4000-8000-000000000001')) + interval '1 minute'
) -> 'paymentTotals' ->> 'CASH')::bigint,
  (select sum(p.amount_cents)::bigint from public.payments p join public.sales s on s.id = p.sale_id
   where s.branch_id = 'f3000000-0000-4000-8000-000000000001' and s.status = 'COMPLETED' and p.method = 'CASH'),
  'the settlement expects the final discounted cash totals');
select is((public.get_settlement_preview('f3000000-0000-4000-8000-000000000001',
  (now() at time zone (select timezone from public.organizations where id = 'f2000000-0000-4000-8000-000000000001')) - interval '1 day',
  date_trunc('minute', now() at time zone (select timezone from public.organizations where id = 'f2000000-0000-4000-8000-000000000001')) + interval '1 minute'
) ->> 'totalSalesCents')::bigint,
  (select sum(total_cents)::bigint from public.sales where branch_id = 'f3000000-0000-4000-8000-000000000001' and status = 'COMPLETED'),
  'the settlement total sale amount is the sum of final sale totals (the pending Mercado Pago sale is not counted)');
select is((public.get_settlement_preview('f3000000-0000-4000-8000-000000000001',
  (now() at time zone (select timezone from public.organizations where id = 'f2000000-0000-4000-8000-000000000001')) - interval '1 day',
  date_trunc('minute', now() at time zone (select timezone from public.organizations where id = 'f2000000-0000-4000-8000-000000000001')) + interval '1 minute'
) -> 'paymentTotals' ->> 'CASH')::bigint,
  13436814::bigint,
  'the cash expected by the settlement matches the hand-computed final totals (manual prices and discounts included)');

-- Rentabilidad: el ingreso por producto es lo realmente cobrado (subtotal - descuento general atribuido).
select is((public.get_profitability_analytics('7d') -> 'summary' ->> 'revenueCents')::bigint,
  (select sum(total_cents)::bigint from public.sales where status = 'COMPLETED'),
  'profitability revenue equals the sum of final sale totals (manual prices and ticket discounts included)');
select is((select sum(i.subtotal_cents - i.ticket_discount_cents)::bigint from public.sale_items i join public.sales s on s.id = i.sale_id where s.status = 'COMPLETED'),
  (select sum(total_cents)::bigint from public.sales where status = 'COMPLETED'),
  'per-line revenue adds up exactly to the final totals, no cent lost to the allocation');
select is((select sum(ticket_discount_cents)::bigint from public.sale_items where sale_id = public.t_sale(3) and product_id = 'f5000000-0000-4000-8000-000000000001'), 50000::bigint, 'Coca Cola carries $500 of the $1.200 ticket discount');
select is((select (row ->> 'revenueCents')::bigint from jsonb_array_elements(public.get_profitability_analytics('7d') -> 'products') row where row ->> 'productName' = 'Vacío'), 1625000::bigint, 'the Vacío product revenue is its manual-price subtotal');

-- Anular una venta con descuento: sigue siendo una anulación completa con stock compensado, sin tocar la historia.
select lives_ok($$select public.cancel_sale(public.t_sale(3), 'f6000000-0000-4000-8000-000000009999', 'prueba de anulacion')$$, 'a discounted sale with a manual line can be cancelled');
select is((select status::text from public.sales where id = public.t_sale(3)), 'CANCELLED', 'the sale is cancelled');
select is((select count(*)::integer from public.stock_movements where sale_id = public.t_sale(3) and type = 'RETURN'), 2, 'its stock is returned once per line');
select is((select ticket_discount_cents from public.sales where id = public.t_sale(3)), 120000::bigint, 'the cancelled sale keeps its discount snapshot');
select is((public.get_profitability_analytics('7d') -> 'summary' ->> 'revenueCents')::bigint,
  (select sum(total_cents)::bigint from public.sales where status = 'COMPLETED'),
  'after the cancellation revenue still equals the completed totals');

-- Ticket de WhatsApp: los hechos del ticket traen el descuento y la línea manual, y cierran con el total.
reset role;
select is((app_private.wa_sale_ticket_json(public.t_sale(7)) ->> 'ticketDiscountCents')::bigint, 127000::bigint, 'the WhatsApp ticket facts carry the ticket discount');
select is((app_private.wa_sale_ticket_json(public.t_sale(7)) -> 'items' -> 0 ->> 'manualPriceApplied')::boolean, true, 'the manual line is flagged in the ticket facts');
select is((app_private.wa_sale_ticket_json(public.t_sale(7)) -> 'items' -> 0 ->> 'unitPriceCents')::bigint, 1000000::bigint, 'the ticket shows the manual price as the line price');
select is(
  (select sum((i ->> 'subtotalCents')::bigint)::bigint from jsonb_array_elements(app_private.wa_sale_ticket_json(public.t_sale(7)) -> 'items') i)
    - (app_private.wa_sale_ticket_json(public.t_sale(7)) ->> 'ticketDiscountCents')::bigint,
  (app_private.wa_sale_ticket_json(public.t_sale(7)) ->> 'totalCents')::bigint,
  'lines minus ticket discount equal the ticket total');

select * from finish();
rollback;
