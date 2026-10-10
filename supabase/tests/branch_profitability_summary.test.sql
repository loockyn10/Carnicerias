begin;

create extension if not exists pgtap with schema extensions;
select plan(44);

-- ---------------------------------------------------------------------------------------------
-- Forma y endurecimiento
-- ---------------------------------------------------------------------------------------------
select has_function('public', 'get_branch_profitability_summary', array['date','date','uuid'], 'get_branch_profitability_summary exists');
select ok((select prosecdef from pg_proc where oid = 'public.get_branch_profitability_summary(date,date,uuid)'::regprocedure), 'it is security definer');
select is((select array_to_string(proconfig, ',') from pg_proc where oid = 'public.get_branch_profitability_summary(date,date,uuid)'::regprocedure), 'search_path=""', 'it has an empty search path');
select ok(not has_function_privilege('anon', 'public.get_branch_profitability_summary(date,date,uuid)', 'EXECUTE'), 'anonymous cannot read branch profitability');
select ok(has_function_privilege('authenticated', 'public.get_branch_profitability_summary(date,date,uuid)', 'EXECUTE'), 'authenticated can execute it');
select ok(not has_function_privilege('authenticated', 'app_private.sale_item_cost_cents(public.unit_type,bigint,bigint,bigint)', 'EXECUTE'), 'the shared cost formula is not callable by browser clients');
select ok(not has_function_privilege('authenticated', 'app_private.sale_item_revenue_cents(bigint,bigint)', 'EXECUTE'), 'the shared revenue formula is not callable by browser clients');

-- ---------------------------------------------------------------------------------------------
-- Fixture. Org A (America/Argentina/Buenos_Aires, UTC-3): Centro y Norte. Org B: una sucursal.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'bp-admin-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"BP Admin A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'bp-employee-a@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"BP Employee A"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'bp-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"BP Admin B"}', now(), now(), '', '', '', '');

insert into public.organizations (id, name, slug) values
  ('d2000000-0000-4000-8000-000000000001', 'BP Org A', 'bp-org-a'),
  ('d2000000-0000-4000-8000-000000000002', 'BP Org B', 'bp-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Centro', 'BP-CENTRO'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'Norte', 'BP-NORTE'),
  ('d3000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'Org B Branch', 'BP-B');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.categories (id, organization_id, name, slug) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Varios', 'bp-varios'),
  ('d4000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000002', 'Varios B', 'bp-varios-b');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Molida', 'bp-molida', 'BP-MOLIDA', 'WEIGHT'),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Yerba', 'bp-yerba', 'BP-YERBA', 'UNIT'),
  ('d5000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Pollo', 'bp-pollo', 'BP-POLLO', 'WEIGHT'),
  ('d5000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Gaseosa', 'bp-gaseosa', 'BP-GASEOSA', 'UNIT'),
  ('d5000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Legacy', 'bp-legacy', 'BP-LEGACY', 'WEIGHT'),
  ('d5000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-000000000002', 'Producto B', 'bp-prod-b', 'BP-PB', 'WEIGHT');

-- El costo VIGENTE de la molida hoy es muy distinto del snapshot de las ventas: la historia no lo usa.
insert into public.product_costs (organization_id, product_id, cost_cents, valid_from, created_by) values
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 9999999, now(), 'd1000000-0000-4000-8000-000000000001');

-- Ventas (hora local Buenos Aires = UTC-3). Centro, 10/03/2026:
--   S1 molida WEIGHT 2,000 kg  $18.000 · costo hist. $6.000/kg  -> costo 12.000 · ganancia 6.000
--   S2 yerba UNIT 3 u          $13.770 · costo hist. $3.000/u   -> costo  9.000 · ganancia 4.770
--   S3 pollo con PROMO         $ 5.000 (promo -$500)  · costo $3.000   -> ganancia 2.000
--   S4 gaseosa PACK 6 u        $15.000 · costo hist. $2.000/u   -> costo 12.000 · ganancia 3.000
--   S5 pollo con TARJETA       $ 5.500 (recargo $500) · costo $3.000   -> ganancia 2.500
--   S6 molida PRECIO MANUAL    $10.000 · costo $6.000           -> ganancia 4.000
--   S7 molida con DESC. TICKET $ 9.000 (de $10.000) · costo $6.000     -> ganancia 3.000
--   S8 molida 23:30 local (02:30 UTC del 11/03) $10.000 · costo $6.000 -> ganancia 4.000
-- Centro, 11/03/2026: S9 molida $10.000 costo $6.000 + S10 legacy $8.000 SIN costo.
-- Excluidas: PENDING_PAYMENT, CANCELLED, REFUNDED, DRAFT, y una venta del 12/03 00:00 local.
-- Norte, 10/03: S11 molida 10,000 kg $100.000 · costo $60.000 -> ganancia $40.000 (margen 40%).
insert into public.sales (id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, ticket_discount_bps, ticket_discount_cents, completed_at) values
  ('d6000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 1800000, 2000, 0, 0, '2026-03-10 15:00:00+00'),
  ('d6000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 1377000, 0, 0, 0, '2026-03-10 15:05:00+00'),
  ('d6000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 500000, 1000, 0, 0, '2026-03-10 15:10:00+00'),
  ('d6000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 1500000, 0, 0, 0, '2026-03-10 15:15:00+00'),
  ('d6000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 550000, 1000, 0, 0, '2026-03-10 15:20:00+00'),
  ('d6000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 1000000, 1000, 0, 0, '2026-03-10 15:25:00+00'),
  ('d6000000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 900000, 1000, 1000, 100000, '2026-03-10 15:30:00+00'),
  ('d6000000-0000-4000-8000-000000000008', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 1000000, 1000, 0, 0, '2026-03-11 02:30:00+00'),
  ('d6000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 1000000, 1000, 0, 0, '2026-03-11 03:30:00+00'),
  ('d6000000-0000-4000-8000-000000000010', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 800000, 1000, 0, 0, '2026-03-11 15:00:00+00'),
  ('d6000000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 10000000, 10000, 0, 0, '2026-03-10 16:00:00+00'),
  ('d6000000-0000-4000-8000-000000000012', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'PENDING_PAYMENT', 99900000, 1000, 0, 0, '2026-03-10 17:00:00+00'),
  ('d6000000-0000-4000-8000-000000000013', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 99900000, 1000, 0, 0, '2026-03-10 17:05:00+00'),
  ('d6000000-0000-4000-8000-000000000014', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'REFUNDED', 99900000, 1000, 0, 0, '2026-03-10 17:10:00+00'),
  ('d6000000-0000-4000-8000-000000000015', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'DRAFT', 99900000, 1000, 0, 0, null),
  ('d6000000-0000-4000-8000-000000000016', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'COMPLETED', 777000, 1000, 0, 0, '2026-03-12 03:00:00+00'),
  ('d6000000-0000-4000-8000-000000000099', 'd2000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000009', 'd1000000-0000-4000-8000-000000000003', 'COMPLETED', 5000000, 1000, 0, 0, '2026-03-10 15:00:00+00');

update public.sales set status = 'CANCELLED', cancellation_key = 'd7000000-0000-4000-8000-000000000001', cancelled_at = '2026-03-10 18:00:00+00', cancelled_by = 'd1000000-0000-4000-8000-000000000001', cancellation_reason = 'test'
where id = 'd6000000-0000-4000-8000-000000000013';

-- Líneas WEIGHT (sin quantity_units) y UNIT (sin weight_grams).
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot, promotion_discount_cents, card_surcharge_cents) values
  ('d6000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Molida', 2000, 900000, 900000, 900000, 1800000, 600000, 0, 0),
  ('d6000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000003', 'Pollo', 1000, 550000, 550000, 500000, 500000, 300000, 50000, 0),
  ('d6000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000003', 'Pollo', 1000, 500000, 500000, 550000, 550000, 300000, 0, 50000),
  ('d6000000-0000-4000-8000-000000000008', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Molida', 1000, 1000000, 1000000, 1000000, 1000000, 600000, 0, 0),
  ('d6000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Molida', 1000, 1000000, 1000000, 1000000, 1000000, 600000, 0, 0),
  ('d6000000-0000-4000-8000-000000000010', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000005', 'Legacy', 1000, 800000, 800000, 800000, 800000, null, 0, 0),
  ('d6000000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001', 'Molida', 10000, 1000000, 1000000, 1000000, 10000000, 600000, 0, 0),
  ('d6000000-0000-4000-8000-000000000012', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Molida', 1000, 99900000, 99900000, 99900000, 99900000, 1, 0, 0),
  ('d6000000-0000-4000-8000-000000000013', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Molida', 1000, 99900000, 99900000, 99900000, 99900000, 1, 0, 0),
  ('d6000000-0000-4000-8000-000000000014', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Molida', 1000, 99900000, 99900000, 99900000, 99900000, 1, 0, 0),
  ('d6000000-0000-4000-8000-000000000015', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Molida', 1000, 99900000, 99900000, 99900000, 99900000, 1, 0, 0),
  ('d6000000-0000-4000-8000-000000000016', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Molida', 1000, 777000, 777000, 777000, 777000, 600000, 0, 0),
  ('d6000000-0000-4000-8000-000000000099', 'd2000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000009', 'd5000000-0000-4000-8000-000000000009', 'Producto B', 1000, 5000000, 5000000, 5000000, 5000000, 1, 0, 0);
-- Precio manual (la línea fija su precio; sin promo, recargo ni descuento).
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot, manual_price_applied, manual_unit_price_cents) values
  ('d6000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Molida', 1000, 1000000, 1200000, 1000000, 1000000, 600000, true, 1000000);
-- Descuento general del ticket atribuido a la línea (ingreso = subtotal - descuento).
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, ticket_discount_cents, cost_cents_snapshot) values
  ('d6000000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'Molida', 1000, 1000000, 1000000, 1000000, 1000000, 100000, 600000);
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot) values
  ('d6000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002', 'Yerba', 3, 459000, 459000, 459000, 1377000, 300000);
insert into public.sale_items (sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents, original_price_per_kg_cents, final_price_per_kg_cents, subtotal_cents, cost_cents_snapshot, promotion_mode) values
  ('d6000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000004', 'Gaseosa', 6, 250000, 300000, 250000, 1500000, 200000, 'PACK_FIXED_TOTAL');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- Centro, 10/03/2026 (incluye S8 a las 23:30 locales = 02:30 UTC del 11/03)
--   ingreso 18.000+13.770+5.000+15.000+5.500+10.000+9.000+10.000 = 86.270
--   costo   12.000+ 9.000+3.000+12.000+3.000+ 6.000+ 6.000+ 6.000 = 57.000 · ganancia 29.270
-- ---------------------------------------------------------------------------------------------
select is((select revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000001')), 8627000::bigint, 'revenue is the final charged amount of COMPLETED sales only (pending, cancelled, refunded and draft excluded)');
select is((select cost_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000001')), 5700000::bigint, 'cost uses the historical snapshots, not the current product cost');
select is((select gross_profit_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000001')), 2927000::bigint, 'gross profit = revenue - historical cost across WEIGHT, UNIT, promo, pack, card, manual price and ticket discount');
select is((select gross_margin_bps from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000001')), 3393::bigint, 'gross margin is profit over revenue (33.93%)');
select is((select missing_cost_items from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000001')), 0, 'no missing-cost items on 10/03');
select is((select missing_cost_revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000001')), 0::bigint, 'no revenue without cost on 10/03');

-- Cada tipo de línea, aislado por producto (mismo rango, mismas fórmulas).
select is((public.get_profitability_analytics('custom', '2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000001', null, 'd5000000-0000-4000-8000-000000000002') -> 'detail' -> 'summary' ->> 'grossProfitCents')::bigint, 477000::bigint, 'UNIT: 3 u at 13.770 with historical cost 3.000/u earns 4.770');
select is((public.get_profitability_analytics('custom', '2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000001', null, 'd5000000-0000-4000-8000-000000000004') -> 'detail' -> 'summary' ->> 'grossProfitCents')::bigint, 300000::bigint, 'UNIT pack: 15.000 - 12.000 earns 3.000');
select is((public.get_profitability_analytics('custom', '2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000001', null, 'd5000000-0000-4000-8000-000000000003') -> 'detail' -> 'summary' ->> 'grossProfitCents')::bigint, 450000::bigint, 'promo and card surcharge lines use the final charged amount (2.000 + 2.500)');

-- ---------------------------------------------------------------------------------------------
-- Ejemplo obligatorio: Norte 10/03 vende $100.000 con costo $60.000 -> ganancia $40.000, margen 40%.
-- ---------------------------------------------------------------------------------------------
select is((select revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000002')), 10000000::bigint, 'Norte revenue is $100.000');
select is((select cost_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000002')), 6000000::bigint, 'Norte cost is $60.000 (10 kg x $6.000)');
select is((select gross_profit_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000002')), 4000000::bigint, 'Norte gross profit is $40.000');
select is((select gross_margin_bps from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000002')), 4000::bigint, 'Norte gross margin is 40%');

-- ---------------------------------------------------------------------------------------------
-- Rango, zona horaria y líneas sin costo
-- ---------------------------------------------------------------------------------------------
select is((select revenue_cents from public.get_branch_profitability_summary('2026-03-11', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')), 1800000::bigint, '11/03 starts at local midnight: the 23:30 sale stays on 10/03, the 12/03 00:00 sale is excluded');
select is((select costed_revenue_cents from public.get_branch_profitability_summary('2026-03-11', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')), 1000000::bigint, 'costed revenue excludes the line without a historical cost');
select is((select gross_profit_cents from public.get_branch_profitability_summary('2026-03-11', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')), 400000::bigint, 'a line without cost never inflates gross profit (cost is not assumed 0)');
select is((select gross_margin_bps from public.get_branch_profitability_summary('2026-03-11', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')), 4000::bigint, 'margin is computed over the costed revenue only');
select is((select missing_cost_items from public.get_branch_profitability_summary('2026-03-11', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')), 1, 'one line without known cost is reported');
select is((select missing_cost_sales from public.get_branch_profitability_summary('2026-03-11', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')), 1, 'one sale without known cost is reported');
select is((select missing_cost_revenue_cents from public.get_branch_profitability_summary('2026-03-11', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')), 800000::bigint, 'the amount sold without known cost is reported');
select is((select revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')), 10427000::bigint, 'a multi-day range sums both local days');
select is((select revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-12', 'd3000000-0000-4000-8000-000000000001')), 11204000::bigint, 'the range end day is inclusive (12/03 local midnight sale counted)');

-- Sin ventas: ceros y margen null, nunca división por cero.
select is((select revenue_cents from public.get_branch_profitability_summary('2026-03-20', '2026-03-20', 'd3000000-0000-4000-8000-000000000001')), 0::bigint, 'a branch without sales reports zero revenue');
select is((select gross_profit_cents from public.get_branch_profitability_summary('2026-03-20', '2026-03-20', 'd3000000-0000-4000-8000-000000000001')), 0::bigint, 'a branch without sales reports zero gross profit');
select ok((select gross_margin_bps is null from public.get_branch_profitability_summary('2026-03-20', '2026-03-20', 'd3000000-0000-4000-8000-000000000001')), 'a branch without sales has a null margin (no division by zero)');

-- ---------------------------------------------------------------------------------------------
-- Mismo motor que las otras pantallas: ventas de la tarjeta actual y analytics coinciden exactamente.
-- ---------------------------------------------------------------------------------------------
select is(
  (select array_agg(p.revenue_cents order by p.branch_id) from public.get_branch_profitability_summary('2026-03-10', '2026-03-11') p),
  (select array_agg(s.total_cents order by s.branch_id) from public.get_branch_sales_summary('2026-03-10', '2026-03-11') s),
  'revenue equals get_branch_sales_summary.total_cents for every branch (same population of sales)');
select is((select revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')),
  (public.get_profitability_analytics('custom', '2026-03-10', '2026-03-11', 'd3000000-0000-4000-8000-000000000001') -> 'summary' ->> 'revenueCents')::bigint,
  'revenue equals get_profitability_analytics (/admin/analytics)');
select is((select gross_profit_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')),
  (public.get_profitability_analytics('custom', '2026-03-10', '2026-03-11', 'd3000000-0000-4000-8000-000000000001') -> 'summary' ->> 'grossProfitCents')::bigint,
  'gross profit equals get_profitability_analytics');
select is((select cost_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'd3000000-0000-4000-8000-000000000001')),
  (public.get_profitability_analytics('custom', '2026-03-10', '2026-03-11', 'd3000000-0000-4000-8000-000000000001') -> 'summary' ->> 'costCents')::bigint,
  'cost equals get_profitability_analytics');

-- ---------------------------------------------------------------------------------------------
-- Aislamiento
-- ---------------------------------------------------------------------------------------------
select is((select count(*) from public.get_branch_profitability_summary('2026-03-10', '2026-03-11')), 2::bigint, 'admin A sees only the two branches of its organization');
select is((select revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-11', 'd3000000-0000-4000-8000-000000000002')), 10000000::bigint, 'branch filter excludes the sales of other branches');
select throws_ok($$select * from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000009')$$, '42501', 'Branch was not found in this organization', 'admin A cannot read the profitability of another organization''s branch');
select throws_ok($$select * from public.get_branch_profitability_summary('2026-03-11', '2026-03-10')$$, '22023', 'La fecha inicial no puede ser posterior a la final', 'an inverted range is rejected');
select throws_ok($$select * from public.get_branch_profitability_summary('2025-01-01', '2026-03-10')$$, '22023', 'El rango no puede superar 366 días', 'a range over 366 days is rejected');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select * from public.get_branch_profitability_summary('2026-03-10', '2026-03-10')$$, '42501', 'Permission analytics.read is required', 'an employee without analytics.read cannot read costs');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select revenue_cents from public.get_branch_profitability_summary('2026-03-10', '2026-03-10', 'd3000000-0000-4000-8000-000000000009')), 5000000::bigint, 'admin B reads only its own organization''s branch');
select is((select count(*) from public.get_branch_profitability_summary('2026-03-10', '2026-03-10')), 1::bigint, 'admin B does not see organization A branches');

reset role;
select * from finish();
rollback;
