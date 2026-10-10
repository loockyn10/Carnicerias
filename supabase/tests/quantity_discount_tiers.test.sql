begin;

create extension if not exists pgtap with schema extensions;
select plan(80);

-- Covers 202610180081 (D-083): descuentos generales POR CANTIDAD con escalones configurables.
--   3 unidades -> 15 %, 5 unidades -> 20 %; se aplica el MAYOR escalón alcanzado, nunca se acumulan.
-- Fixture: Central (sucursal productiva), Avenida y Janssen; admin, empleado (Central y Avenida), un rol con SÓLO prices.write y otra organización.
-- Todo el dinero en centavos; los porcentajes, en basis points enteros.

select has_function('public', 'save_pricing_config', array['integer','integer','integer','integer','boolean','boolean','uuid[]','jsonb'], 'save_pricing_config accepts the tiers');
select has_table('public', 'organization_quantity_discount_tiers', 'the tier configuration table exists');
select ok(not has_function_privilege('authenticated', 'app_private.apply_quantity_discount_tiers(uuid,uuid,jsonb,uuid)', 'EXECUTE'), 'the branch fan-out is not callable by browser clients');
select ok(not has_function_privilege('authenticated', 'app_private.normalize_quantity_tiers(jsonb)', 'EXECUTE'), 'the tier validation helper is not callable by browser clients');
select ok(not has_table_privilege('authenticated', 'public.organization_quantity_discount_tiers', 'INSERT'), 'browser clients cannot write tiers directly');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'qt-admin@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"QT Admin"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'qt-employee@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"QT Employee"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'qt-pricer@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"QT Pricer"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'qt-admin-b@example.test', '', now(), '{"provider":"email","providers":["email"]}', '{"display_name":"QT Admin B"}', now(), now(), '', '', '', '');
insert into public.organizations (id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'QT Org', 'qt-org'),
  ('f2000000-0000-4000-8000-000000000002', 'QT Org B', 'qt-org-b');
insert into public.branches (id, organization_id, name, code) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'QT Central', 'QT-C'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'QT Avenida', 'QT-A'),
  ('f3000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'QT Janssen', 'QT-J'),
  ('f3000000-0000-4000-8000-000000000009', 'f2000000-0000-4000-8000-000000000002', 'QT B Branch', 'QT-B');
update public.organizations set production_branch_id = 'f3000000-0000-4000-8000-000000000001' where id = 'f2000000-0000-4000-8000-000000000001';
insert into public.roles (id, organization_id, key, name, description, is_system) values
  ('f8000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'qt_pricer', 'QT Pricer', 'only prices.write', false);
insert into public.role_permissions (role_id, permission_key) values ('f8000000-0000-4000-8000-000000000001', 'prices.write');
insert into public.organization_members (organization_id, profile_id, role_id, status) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'f8000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into public.branch_members (organization_id, branch_id, profile_id) values
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002'),
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002');
insert into public.categories (id, organization_id, name, slug) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'QT Category', 'qt-category');
insert into public.products (id, organization_id, category_id, name, slug, sku, unit_type) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Leche', 'qt-leche', 'QT-1', 'UNIT'),
  ('f5000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Vacío', 'qt-vacio', 'QT-2', 'WEIGHT');
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id from public.products p join public.branches b on b.organization_id = p.organization_id
where p.organization_id = 'f2000000-0000-4000-8000-000000000001';
insert into public.product_prices (organization_id, product_id, price_cents, valid_from) values
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 100000, '2026-01-01T00:00:00Z'),
  ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002', 1500000, '2026-01-01T00:00:00Z');

-- Helpers del test: la línea UNIT tal como la arma el POS (cálculo independiente en numeric) y el payload de sync.
create function public.t_qt_item(
  p_qty integer, p_promo uuid default null, p_min integer default null, p_bps integer default null, p_force boolean default false,
  p_product uuid default 'f5000000-0000-4000-8000-000000000001', p_name text default 'Leche', p_list bigint default 100000
) returns jsonb language plpgsql as $$
declare discounted integer := 0; disc bigint; sub bigint; fin bigint; res jsonb;
begin
  if p_promo is not null and (p_qty >= p_min or p_force) then discounted := p_qty; end if;
  disc := round(p_list::numeric * discounted * coalesce(p_bps, 0) / 10000)::bigint;
  sub := p_list * p_qty - disc;
  fin := round(sub::numeric / p_qty)::bigint;
  res := jsonb_build_object('productId', p_product, 'productNameSnapshot', p_name, 'quantityUnits', p_qty,
    'pricePerKgCents', fin::text, 'originalPricePerKgCents', p_list::text, 'discountCents', disc::text, 'cashDiscountBps', '0', 'cashDiscountCents', '0',
    'cardSurchargeCents', '0', 'promotionDiscountCents', disc::text, 'subtotalCents', sub::text);
  if discounted > 0 then
    res := res || jsonb_build_object('branchPromotionId', p_promo, 'branchPromotionMinimumUnits', p_min, 'branchPromotionDiscountBps', p_bps,
      'branchPromotionDiscountedUnits', discounted, 'branchPromotionDiscountCents', disc::text);
  end if;
  return res;
end $$;

create function public.t_qt_payload(p_seq integer, p_branch uuid, p_device uuid, p_item jsonb, p_at timestamptz default now() - interval '1 minute')
returns jsonb language plpgsql as $$
declare
  base text := 'f6000000-0000-4000-8000-';
  item jsonb := p_item || jsonb_build_object('id', base || lpad((p_seq * 1000 + 101)::text, 12, '0'));
  total bigint := (p_item ->> 'subtotalCents')::bigint;
begin
  return jsonb_build_object(
    'schemaVersion', 1, 'eventId', base || lpad((p_seq * 1000 + 1)::text, 12, '0'), 'saleId', base || lpad((p_seq * 1000 + 2)::text, 12, '0'),
    'organizationId', 'f2000000-0000-4000-8000-000000000001', 'branchId', p_branch, 'profileId', 'f1000000-0000-4000-8000-000000000002',
    'deviceId', p_device, 'status', 'COMPLETED', 'totalCents', total::text, 'totalWeightGrams', '0', 'createdAt', p_at, 'completedAt', p_at,
    'items', jsonb_build_array(item),
    'payment', jsonb_build_object('id', base || lpad((p_seq * 1000 + 3)::text, 12, '0'), 'method', 'CASH', 'amountCents', total::text),
    'stockMovements', jsonb_build_array(jsonb_build_object('id', base || lpad((p_seq * 1000 + 201)::text, 12, '0'), 'productId', item ->> 'productId',
      'quantityGrams', (-coalesce((item ->> 'weightGrams')::bigint, (item ->> 'quantityUnits')::bigint))::text, 'occurredAt', p_at))
  );
end $$;
create function public.t_qt_sale(p_seq integer) returns uuid language sql immutable as $$
  select ('f6000000-0000-4000-8000-' || lpad((p_seq * 1000 + 2)::text, 12, '0'))::uuid $$;
create function public.t_qt_sync(p_device uuid, p_payload jsonb) returns jsonb language sql as $$
  select public.sync_offline_sale(p_device, (p_payload ->> 'eventId')::uuid, p_payload) $$;
-- Regla vigente (o la más reciente cerrada) de una sucursal para un mínimo; definer porque el empleado no lee la tabla.
create function public.t_qt_rule(p_branch uuid, p_min integer, p_active boolean default true) returns uuid language sql security definer as $$
  select bp.id from public.branch_promotions bp where bp.branch_id = p_branch and bp.minimum_units = p_min and bp.active = p_active
  order by bp.created_at desc, bp.id limit 1 $$;
create function public.t_qt_active_count(p_branch uuid) returns integer language sql security definer as $$
  select count(*)::int from public.branch_promotions bp where bp.branch_id = p_branch and bp.active $$;
grant execute on function public.t_qt_rule(uuid, integer, boolean), public.t_qt_active_count(uuid) to authenticated;
-- Central = f7...01, Avenida = f7...02.

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ---------------------------------------------------------------------------------------------
-- 1. Configurar los escalones: 3 -> 15 %, 5 -> 20 %
-- ---------------------------------------------------------------------------------------------
select is((public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":5,"discountBps":2000},{"minimumUnits":3,"discountBps":1500}]'::jsonb)) -> 'quantityTiers',
  '[{"minimumUnits": 3, "discountBps": 1500}, {"minimumUnits": 5, "discountBps": 2000}]'::jsonb, 'the tiers are stored sorted by quantity');
select is((select string_agg(minimum_units || '/' || discount_bps, ',' order by minimum_units) from public.organization_quantity_discount_tiers), '3/1500,5/2000', 'the table holds 3 -> 15 % and 5 -> 20 % (integer basis points)');
select is((select unit_bulk_discount_bps from public.organization_pricing_settings), 1500, 'the historical «llevando 3u» column mirrors the lowest tier');
select is(public.t_qt_active_count('f3000000-0000-4000-8000-000000000001'), 2, 'Central has one active rule per tier');
select is(public.t_qt_active_count('f3000000-0000-4000-8000-000000000002'), 2, 'Avenida has one active rule per tier');
select is(public.t_qt_active_count('f3000000-0000-4000-8000-000000000003'), 2, 'Janssen has one active rule per tier');
select is((select count(*)::int from public.branch_promotions bp where bp.active and bp.semantics = 'FROM_MINIMUM' and bp.organization_id = 'f2000000-0000-4000-8000-000000000001'), 6, '6 active rules in total (3 branches x 2 tiers), all FROM_MINIMUM');
select is((select string_agg(minimum_units || '/' || discount_bps, ',' order by minimum_units) from public.branch_promotions where branch_id = 'f3000000-0000-4000-8000-000000000002' and active), '3/1500,5/2000', 'the same configuration reaches every branch');

-- Validaciones
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":3,"discountBps":1500},{"minimumUnits":3,"discountBps":2000}]'::jsonb)$$, '22023', null, 'two tiers with the same quantity are rejected');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":1,"discountBps":1500}]'::jsonb)$$, '22023', null, 'a minimum of 1 unit is rejected');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":1001,"discountBps":1500}]'::jsonb)$$, '22023', null, 'an absurd minimum is rejected');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":2.5,"discountBps":1500}]'::jsonb)$$, '22023', null, 'a fractional quantity is rejected');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":3,"discountBps":0}]'::jsonb)$$, '22023', null, '0 % is not a tier');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":3,"discountBps":10000}]'::jsonb)$$, '22023', null, '100 % is not a tier');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":3,"discountBps":1500.5}]'::jsonb)$$, '22023', null, 'a fractional basis point is rejected');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":3,"discountBps":2000},{"minimumUnits":5,"discountBps":1500}]'::jsonb)$$, '22023', null, 'a bigger quantity with a smaller discount is rejected');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":3,"discountBps":1500},{"minimumUnits":5,"discountBps":1500}]'::jsonb)$$, '22023', null, 'a bigger quantity with the same discount is rejected');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '{"minimumUnits":3}'::jsonb)$$, '22023', null, 'tiers must be a list');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":3}]'::jsonb)$$, '22023', null, 'a tier without percentage is rejected');
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":2,"discountBps":100},{"minimumUnits":3,"discountBps":200},{"minimumUnits":4,"discountBps":300},{"minimumUnits":5,"discountBps":400},{"minimumUnits":6,"discountBps":500},{"minimumUnits":7,"discountBps":600},{"minimumUnits":8,"discountBps":700},{"minimumUnits":9,"discountBps":800},{"minimumUnits":10,"discountBps":900},{"minimumUnits":11,"discountBps":1000},{"minimumUnits":12,"discountBps":1100}]'::jsonb)$$, '22023', null, 'more than 10 tiers are rejected');
select is((select string_agg(minimum_units || '/' || discount_bps, ',' order by minimum_units) from public.organization_quantity_discount_tiers), '3/1500,5/2000', 'every rejected attempt left the configuration alone');

-- ---------------------------------------------------------------------------------------------
-- 2. Permisos y aislamiento
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.save_pricing_config(3000, 1500, 2000, 1000, true, false, null, '[{"minimumUnits":4,"discountBps":1000}]'::jsonb)$$, '42501', 'Permission prices.write is required', 'an employee cannot change the tiers');
select is((select count(*)::int from public.organization_quantity_discount_tiers), 0, 'an employee reads no tier configuration (RLS)');

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":4,"discountBps":1000}]'::jsonb)$$, '42501', 'Permission catalog.write is required', 'changing tiers needs catalog.write (like the old «llevando 3u»)');
select lives_ok($$select public.save_pricing_config(3000, 0, 2000, 900, true, false, null, '[{"minimumUnits":3,"discountBps":1500},{"minimumUnits":5,"discountBps":2000}]'::jsonb)$$, 'the same tiers saved by a prices.write-only role change nothing (only the card surcharge moved)');
select is((select count(*)::int from public.organization_quantity_discount_tiers), 2, 'a prices reader sees the two tiers');

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is((select count(*)::int from public.organization_quantity_discount_tiers), 0, 'another organization sees none of these tiers');
select lives_ok($$select public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":4,"discountBps":1000}]'::jsonb)$$, 'another organization configures its own tiers');
select is(public.t_qt_active_count('f3000000-0000-4000-8000-000000000002'), 2, 'and that did not touch the first organization branches');
select is(public.t_qt_active_count('f3000000-0000-4000-8000-000000000009'), 1, 'its own branch got its own single tier');

-- ---------------------------------------------------------------------------------------------
-- 3. El POS recibe TODOS los escalones (la lista que usa offline)
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.register_pos_device('f7000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000002', 'Caja Avenida')$$, 'the Avenida device is registered');
select is((select string_agg((r ->> 'minimumUnits') || '/' || (r ->> 'discountBps'), ',' order by (r ->> 'minimumUnits')::int) from jsonb_array_elements(public.pull_pos_state('f7000000-0000-4000-8000-000000000002', 0) -> 'branchPromotionsFromMinimum') r), '3/1500,5/2000', 'pull_pos_state delivers both tiers (the POS resolves them offline)');
select is(jsonb_array_length(public.pull_pos_state('f7000000-0000-4000-8000-000000000002', 0) -> 'branchPromotions'), 0, 'the superseded «cada N» key is still empty');

-- ---------------------------------------------------------------------------------------------
-- 4. Ventas offline: 2 / 3 / 4 / 5 / 6 / 10 unidades de Leche ($1.000)
-- ---------------------------------------------------------------------------------------------
select lives_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(1, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(2)))$$, '2 units: no discount');
select is((select subtotal_cents || '/' || promotion_discount_cents || '/' || coalesce(branch_promotion_id::text, '-') from public.sale_items where sale_id = public.t_qt_sale(1)), '200000/0/-', '2 units cost $2.000 with no rule');
select lives_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(2, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(3, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 3), 3, 1500)))$$, '3 units take the 15 % tier');
select is((select subtotal_cents || '/' || branch_promotion_discount_bps || '/' || branch_promotion_discounted_units from public.sale_items where sale_id = public.t_qt_sale(2)), '255000/1500/3', '3 units: $3.000 - 15 % = $2.550 on all 3 units');
select lives_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(3, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(4, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 3), 3, 1500)))$$, '4 units still take the 15 % tier');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_qt_sale(3)), 340000::bigint, '4 units: $4.000 - 15 % = $3.400');
select lives_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(4, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(5, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), 5, 2000)))$$, '5 units take the 20 % tier');
select is((select subtotal_cents || '/' || branch_promotion_discount_bps from public.sale_items where sale_id = public.t_qt_sale(4)), '400000/2000', '5 units: $5.000 - 20 % = $4.000 (NOT 15 % + 20 %)');
select lives_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(5, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(6, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), 5, 2000)))$$, '6 units take the 20 % tier');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_qt_sale(5)), 480000::bigint, '6 units: $6.000 - 20 % = $4.800');
select lives_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(6, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(10, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), 5, 2000)))$$, '10 units keep the 20 % tier');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_qt_sale(6)), 800000::bigint, '10 units: $10.000 - 20 % = $8.000');
-- Un POS que declara un escalón MÁS BAJO del que podía usar le cobra de menos al cliente, nunca de más: el servidor valida la regla que la línea declara.
select lives_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(7, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(5, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 3), 3, 1500)))$$, '5 units sold with the lower 15 % tier (an older POS) still validate');

-- Manipulaciones
select throws_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(10, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(4, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), 5, 2000, true)))$$, '22023', null, '4 units cannot claim the 5-unit tier');
select throws_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(11, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(2, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 3), 3, 1500, true)))$$, '22023', null, '2 units cannot claim the 3-unit tier');
select throws_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(12, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(5, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), 5, 2500)))$$, '42501', null, 'the 5-unit tier with a made-up 25 % is rejected');
select throws_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(13, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(5, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), 3, 2000)))$$, '42501', null, 'the id of the 5-unit tier declaring a 3-unit minimum is rejected');
select throws_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(14, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(5, public.t_qt_rule('f3000000-0000-4000-8000-000000000003', 5), 5, 2000)))$$, '42501', null, 'a rule of ANOTHER branch is rejected');
select throws_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(15, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(5, public.t_qt_rule('f3000000-0000-4000-8000-000000000009', 4), 4, 1000)))$$, '42501', null, 'a rule of ANOTHER organization is rejected');
select throws_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(16, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(5, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), 5, 2000) || '{"branchPromotionDiscountCents":"1"}'::jsonb))$$, '22023', null, 'a tampered discount amount is rejected');
select is((select count(*)::int from public.sales where id in (public.t_qt_sale(10), public.t_qt_sale(11), public.t_qt_sale(12), public.t_qt_sale(13), public.t_qt_sale(14), public.t_qt_sale(15), public.t_qt_sale(16))), 0, 'every manipulated sale left nothing behind');

-- Productos por PESO: la regla de unidades no se les aplica.
select throws_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(17, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002',
  (public.t_qt_item(1, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), 5, 2000, true, 'f5000000-0000-4000-8000-000000000002', 'Vacío', 1500000) - 'quantityUnits') || '{"weightGrams":1000}'::jsonb))$$, '22023', null, 'a WEIGHT line cannot carry a unit quantity tier');
select is((select count(*)::int from public.sales where id = public.t_qt_sale(17)), 0, 'and no sale was created');

-- ---------------------------------------------------------------------------------------------
-- 5. Editar un escalón: la venta histórica conserva SU porcentaje y la regla cerrada sigue validando lo hecho offline
-- ---------------------------------------------------------------------------------------------
create temp table qt_keep (name text primary key, id uuid, payload jsonb);
grant all on qt_keep to public;
-- Una venta offline hecha con el escalón de 5 al 20 % que todavía no sincronizó cuando el dueño lo sube a 25 %.
insert into qt_keep select 'old5', public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), public.t_qt_payload(20, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(5, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), 5, 2000));
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[{"minimumUnits":3,"discountBps":1500},{"minimumUnits":5,"discountBps":2500}]'::jsonb) ->> 'branchPromotionsUpdated')::int, 3, 'raising the 5-unit tier updates the rules of all 3 branches');
select is((select string_agg(minimum_units || '/' || discount_bps, ',' order by minimum_units) from public.branch_promotions where branch_id = 'f3000000-0000-4000-8000-000000000002' and active), '3/1500,5/2500', 'Avenida now has 3 -> 15 % and 5 -> 25 %');
select isnt(public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), (select id from qt_keep where name = 'old5'), 'the edited tier is a NEW rule (new id)');
select is((select (not active and valid_until is not null)::text from public.branch_promotions where id = (select id from qt_keep where name = 'old5')), 'true', 'the previous rule is closed, not overwritten');
select is((select discount_bps from public.branch_promotions where id = (select id from qt_keep where name = 'old5')), 2000, 'and it keeps its 20 %');
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', (select payload from qt_keep where name = 'old5'))$$, 'the offline sale made with the OLD 5 -> 20 % rule syncs after the edit');
select is((select subtotal_cents || '/' || branch_promotion_discount_bps from public.sale_items where sale_id = public.t_qt_sale(20)), '400000/2000', 'it keeps the 20 % it was sold with (history is not recalculated)');
select is((select subtotal_cents || '/' || branch_promotion_discount_bps from public.sale_items where sale_id = public.t_qt_sale(4)), '400000/2000', 'an earlier synced sale is untouched too');
select lives_ok($$select public.t_qt_sync('f7000000-0000-4000-8000-000000000002', public.t_qt_payload(22, 'f3000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', public.t_qt_item(5, public.t_qt_rule('f3000000-0000-4000-8000-000000000002', 5), 5, 2500)))$$, 'the new 25 % rule applies to new sales');
select is((select subtotal_cents from public.sale_items where sale_id = public.t_qt_sale(22)), 375000::bigint, '5 units at 25 %: $5.000 - 25 % = $3.750');

-- ---------------------------------------------------------------------------------------------
-- 6. Compatibilidad con el Admin anterior (sólo «Dto llevando 3u») y sucursales nuevas
-- ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is((public.save_pricing_config(3000, 1500, 2000, 1000) ->> 'branchPromotionsUpdated')::int, 0, 'the old Admin saving the SAME «llevando 3u» value leaves the tiers alone');
select is((select string_agg(minimum_units || '/' || discount_bps, ',' order by minimum_units) from public.organization_quantity_discount_tiers where organization_id = 'f2000000-0000-4000-8000-000000000001'), '3/1500,5/2500', 'both tiers are still there');
insert into public.branches (id, organization_id, name, code) values ('f3000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'QT Nueva', 'QT-N');
select is(public.t_qt_active_count('f3000000-0000-4000-8000-000000000004'), 2, 'a new branch is born with both tiers');
select is((public.save_pricing_config(3000, 1000, 2000, 1000) ->> 'branchPromotionsUpdated')::int, 4, 'the old Admin changing «llevando 3u» collapses to a single «desde 3» tier in every branch');
select is((select string_agg(minimum_units || '/' || discount_bps, ',' order by minimum_units) from public.organization_quantity_discount_tiers where organization_id = 'f2000000-0000-4000-8000-000000000001'), '3/1000', 'single tier 3 -> 10 %');

-- Sin escalones: apaga la promoción en todas las sucursales (las reglas cerradas quedan para validar ventas offline).
select is((public.save_pricing_config(3000, 0, 2000, 1000, true, false, null, '[]'::jsonb) ->> 'branchPromotionsUpdated')::int, 4, 'an empty list switches the discount off everywhere');
select is(public.t_qt_active_count('f3000000-0000-4000-8000-000000000002'), 0, 'no active rule remains in Avenida');
select is((select count(*)::int from public.branch_promotions where branch_id = 'f3000000-0000-4000-8000-000000000002'), 4, 'the closed rules of the history are kept (3/15, 5/20, 5/25, 3/10)');
select is((select unit_bulk_discount_bps from public.organization_pricing_settings where organization_id = 'f2000000-0000-4000-8000-000000000001'), 0, 'the mirror column is 0 (configured, no discount)');

select * from finish();
rollback;
