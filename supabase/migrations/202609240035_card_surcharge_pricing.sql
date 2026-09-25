begin;

-- D-044: inverts the payment-method pricing rule. The product's manually-loaded price
-- (product_prices.price_cents) is now the CASH/TRANSFER/OTHER price directly, with NO
-- adjustment at all — it is no longer a "list" price that CASH/TRANSFER/OTHER get a discount
-- off of. DEBIT/CREDIT ("Tarjeta" in the POS) instead pay that price plus a card surcharge.
--
-- Example: price = $10.000, configured percentage = 10% -> CASH = $10.000, TRANSFER = $10.000,
-- DEBIT = $11.000, CREDIT = $11.000.
--
-- Physical names kept exactly as-is (organization_cash_discounts.cash_discount_bps,
-- sale_items.cash_discount_bps/cash_discount_cents, the *_receives_discount helper) per the
-- decision to avoid a destructive rename-only migration on columns already widely referenced —
-- see the comment above set_cash_discount below and D-044's report for the full rationale. Only
-- their MEANING changes: cash_discount_bps now configures the card surcharge percentage, and
-- cash_discount_cents is always 0 for a sale completed after this migration (no payment method
-- gets a discount off list price anymore) but is preserved, unmodified, on every historical row
-- (D-005/D-009 — snapshots are immutable). The one genuinely new concept, "how much extra a card
-- payment added", gets its own new column: sale_items.card_surcharge_cents.
--
-- PACK_FIXED_TOTAL and every promotion (D-039): the surcharge applies to the WHOLE commercial
-- result, no exception. Order is list price -> promotion/pack -> card surcharge (never the other
-- way — a promotion is always evaluated against the plain list price, and the surcharge is a
-- single final multiplicative step over whatever that produced, packs included). Confirmed
-- explicitly by the product owner (2026-09-24) after an initial, more conservative reading of
-- D-039 (packs payment-method-invariant) was corrected: "TODO lo que se pague con tarjeta lleva
-- el porcentaje de recargo configurado. No hay excepción para promociones ni packs." See
-- docs/DECISIONS.md D-044 for the full history of this correction.

alter table public.sale_items
  add column card_surcharge_cents bigint not null default 0 check (card_surcharge_cents >= 0);

-- Regression fix found auditing this task (see D-044's report point 1): the CREATE OR REPLACE in
-- 202609230031 that added pack fields to this RPC's 'discounts' array dropped the top-level
-- 'cashDiscountBps' key the jsonb payload used to carry entirely — apps/pos/src/App.tsx reads
-- config.cashDiscountBps from this exact call, so every POS session ended up with an undefined
-- (later, always-0-fallback) card surcharge/cash discount percentage regardless of what was
-- configured in Admin. Restored here, unrelated to the rest of this migration's behavior change.
create or replace function public.get_pos_commercial_config(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare org_id uuid; at_time timestamptz := now(); cash_bps integer;
begin
  select organization_id into org_id from public.branches where id = p_branch_id and active;
  if auth.uid() is null or org_id is null or not app_private.can_access_branch(org_id, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  select cash_discount_bps into cash_bps from public.organization_cash_discounts
  where organization_id = org_id and valid_from <= at_time and (valid_to is null or valid_to > at_time)
  order by valid_from desc limit 1;
  return jsonb_build_object(
    'cashDiscountBps', coalesce(cash_bps, 1000),
    'discounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'productId', d.product_id, 'branchId', d.branch_id, 'promotionMode', d.promotion_mode,
        'minimumGrams', d.minimum_grams, 'discountType', d.discount_type, 'discountValue', d.discount_value::text,
        'packQuantityGrams', d.pack_quantity_grams, 'packQuantityUnits', d.pack_quantity_units,
        'packPriceCents', d.pack_price_cents::text
      ) order by d.product_id, d.minimum_grams)
      from public.product_weight_discounts d
      where d.organization_id = org_id and (d.branch_id = p_branch_id or d.branch_id is null) and d.active
        and d.valid_from <= at_time and (d.valid_until is null or d.valid_until > at_time)
    ), '[]'::jsonb),
    'announcements', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'message', a.message, 'type', a.type, 'priority', a.priority, 'branchId', a.branch_id) order by a.priority desc, a.starts_at desc)
      from public.announcements a
      where a.organization_id = org_id and (a.branch_id = p_branch_id or a.branch_id is null) and a.active
        and a.starts_at <= at_time and (a.ends_at is null or a.ends_at > at_time)
    ), '[]'::jsonb)
  );
end;
$$;

-- Same signature/body as 202609220030's version; only the error message text is updated to match
-- the new meaning of the percentage it configures. Kept as CREATE OR REPLACE (not a rename) —
-- app_private.require_permission('prices.write') and the rest of the write path are untouched.
create or replace function public.set_cash_discount(p_cash_discount_bps integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  at_time timestamptz := clock_timestamp();
  previous_bps integer;
begin
  if p_cash_discount_bps not between 0 and 9999 then
    raise exception 'Card surcharge must be between 0%% and 99.99%%' using errcode = '22023';
  end if;
  select cash_discount_bps into previous_bps
  from public.organization_cash_discounts
  where organization_id = current_organization_id and valid_to is null
  order by valid_from desc limit 1;

  if coalesce(previous_bps, 1000) = p_cash_discount_bps then
    return jsonb_build_object('cashDiscountBps', p_cash_discount_bps, 'unchanged', true);
  end if;

  update public.organization_cash_discounts
  set valid_to = at_time
  where organization_id = current_organization_id and valid_to is null and valid_from < at_time;

  insert into public.organization_cash_discounts (organization_id, cash_discount_bps, valid_from, created_by)
  values (current_organization_id, p_cash_discount_bps, at_time, auth.uid());

  return jsonb_build_object('previousCashDiscountBps', coalesce(previous_bps, 1000), 'cashDiscountBps', p_cash_discount_bps);
end;
$$;

-- complete_discounted_sale (online checkout): same signature as 202609230034. Order is
-- list -> promotion/pack -> card surcharge for every branch, no exception (D-044, corrected).
-- app_private.payment_method_receives_discount is left completely untouched (still means "is
-- this CASH/TRANSFER/OTHER") — call sites below gate on its NEGATION to decide who gets the
-- surcharge looked up, instead of removing/renaming it.
create or replace function public.complete_discounted_sale(p_branch_id uuid, p_items jsonb, p_payment_method text)
returns table(sale_id uuid, total_cents bigint, total_weight_grams bigint, completed_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  profile_id uuid := auth.uid();
  org_id uuid;
  sale uuid;
  at_time timestamptz := clock_timestamp();
  item jsonb;
  product uuid;
  grams integer;
  quantity integer;
  expected_price bigint;
  expected_cash_bps integer;
  expected_final_price bigint;
  pack_promotion_id uuid;
  pack_promo public.product_weight_discounts%rowtype;
  name text;
  list_price bigint;
  promo_price bigint;
  final_price bigint;
  promo record;
  rule_id uuid;
  rule_discount_type public.weight_discount_type;
  rule_discount_value bigint;
  line_promotion_mode public.promotion_mode;
  list_subtotal bigint;
  cash_subtotal bigint;
  subtotal bigint;
  card_surcharge bigint;
  promotion_discount bigint;
  whole_packs bigint;
  remainder bigint;
  total bigint := 0;
  weight bigint := 0;
  method public.payment_method;
  cash_bps integer := 0;
  cost_snapshot bigint;
  profit_snapshot integer;
begin
  if profile_id is null or p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Invalid sale' using errcode = '22023';
  end if;
  select organization_id into org_id from public.branches where id = p_branch_id and active;
  if org_id is null or not app_private.can_access_branch(org_id, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  method := upper(p_payment_method)::public.payment_method;
  -- D-044: the card surcharge only applies to DEBIT/CREDIT now (the negation of "receives a
  -- discount", still exactly CASH/TRANSFER/OTHER on the other side of that same partition).
  if not app_private.payment_method_receives_discount(method) then
    select cash_discount_bps into cash_bps from public.organization_cash_discounts
    where organization_id = org_id and valid_from <= at_time and (valid_to is null or valid_to > at_time)
    order by valid_from desc limit 1;
    cash_bps := coalesce(cash_bps, 1000);
  end if;
  insert into public.sales(organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at)
  values(org_id, p_branch_id, profile_id, 'COMPLETED', 0, 0, at_time) returning id into sale;

  for item in select value from jsonb_array_elements(p_items) loop
    product := (item->>'product_id')::uuid;
    pack_promotion_id := nullif(item->>'pack_promotion_id', '')::uuid;

    if item ? 'quantity_units' and item->>'quantity_units' is not null then
      -- UNIT line.
      quantity := (item->>'quantity_units')::integer;
      expected_price := (item->>'expected_price_per_unit_cents')::bigint;
      if quantity <= 0 then raise exception 'Invalid quantity' using errcode = '22023'; end if;

      select p.name, pp.price_cents into name, list_price
      from public.products p
      join lateral (
        select price_cents from public.product_prices
        where organization_id = org_id and product_id = p.id and (branch_id = p_branch_id or branch_id is null)
          and valid_from <= at_time and (valid_to is null or valid_to > at_time)
        order by (branch_id = p_branch_id) desc, valid_from desc limit 1
      ) pp on true
      where p.id = product and p.organization_id = org_id and p.active and p.unit_type = 'UNIT';
      if not found or list_price <> expected_price then
        raise exception 'Product price changed; reload and retry' using errcode = '40001';
      end if;
      list_subtotal := list_price * quantity;

      if pack_promotion_id is not null then
        select * into pack_promo from public.product_weight_discounts
        where id = pack_promotion_id and organization_id = org_id and product_id = product
          and promotion_mode = 'PACK_FIXED_TOTAL' and active
          and (branch_id = p_branch_id or branch_id is null)
          and valid_from <= at_time and (valid_until is null or valid_until > at_time);
        if not found or pack_promo.pack_quantity_units is null then
          raise exception 'Promotion configuration changed; reload and retry' using errcode = '40001';
        end if;
        if pack_promo.pack_price_cents > list_price * pack_promo.pack_quantity_units then
          raise exception 'El precio del pack supera el precio de lista para su cantidad' using errcode = '22023';
        end if;
        whole_packs := quantity / pack_promo.pack_quantity_units;
        remainder := quantity % pack_promo.pack_quantity_units;
        -- cash_subtotal is the CASH-equivalent commercial result: whole packs at their fixed
        -- price, plus any remainder at plain list price (no promo ever applies to a UNIT
        -- remainder). The card surcharge (D-044, corrected) is then ONE step applied to that
        -- WHOLE total below — never only to the remainder.
        cash_subtotal := pack_promo.pack_price_cents * whole_packs + list_price * remainder;
        promotion_discount := greatest(list_price * (whole_packs * pack_promo.pack_quantity_units) - pack_promo.pack_price_cents * whole_packs, 0);
        rule_id := pack_promo.id; rule_discount_type := null; rule_discount_value := null; line_promotion_mode := 'PACK_FIXED_TOTAL';
        -- Pack total: the surcharge is one rounding applied directly to the whole total (mirrors
        -- calculateUnitPackSalePricing exactly — there is no single per-unit rate for a mixed
        -- pack+remainder line, so final_price_per_kg_cents reuses the total, same as the pure
        -- calculation function does).
        subtotal := case when cash_bps > 0 then app_private.round_ratio_half_up(cash_subtotal * (10000 + cash_bps), 10000) else cash_subtotal end;
        final_price := subtotal;
      else
        cash_subtotal := list_subtotal;
        promotion_discount := 0;
        rule_id := null; rule_discount_type := null; rule_discount_value := null; line_promotion_mode := null;
        -- Non-pack: round once at the per-unit level (mirrors calculateSalePricing exactly —
        -- quantityDivisor 1 means its own subtotal rounding is a no-op, i.e. exact multiply),
        -- not at the subtotal level, so this always agrees with the pure TS calculation bit for
        -- bit even for quantities where the two roundings could otherwise diverge by a cent.
        final_price := case when cash_bps > 0 then app_private.round_ratio_half_up(list_price * (10000 + cash_bps), 10000) else list_price end;
        subtotal := final_price * quantity;
      end if;
      card_surcharge := subtotal - cash_subtotal;

      select c.cost_cents into cost_snapshot from public.product_costs c
      where c.organization_id = org_id and c.product_id = product and c.valid_from <= at_time and (c.valid_to is null or c.valid_to > at_time)
      order by c.valid_from desc limit 1;
      select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s
      where s.organization_id = org_id and s.product_id = product and s.valid_from <= at_time and (s.valid_to is null or s.valid_to > at_time)
      order by s.valid_from desc limit 1;

      insert into public.sale_items(
        sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents,
        original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, final_price_per_kg_cents,
        discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_cents_snapshot,
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at
      ) values (
        sale, org_id, p_branch_id, product, name, quantity, final_price, list_price, rule_id, rule_discount_type,
        rule_discount_value, final_price, promotion_discount, cash_bps, 0, card_surcharge,
        promotion_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, at_time
      );
      -- Reuses quantity_grams as a signed unit count, same precedent as PRODUCTION_YIELD for a
      -- UNIT output (see complete_production_batch) — not a new modeling decision here.
      insert into public.stock_movements(organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values (org_id, p_branch_id, product, 'SALE', -quantity, sale, profile_id, at_time, at_time);
      total := total + subtotal;
    else
      -- WEIGHT line.
      grams := (item->>'weight_grams')::integer;
      expected_price := (item->>'expected_price_per_kg_cents')::bigint;
      expected_cash_bps := nullif(item->>'expected_cash_discount_bps', '')::integer;
      expected_final_price := nullif(item->>'expected_final_price_per_kg_cents', '')::bigint;
      if grams <= 0 then raise exception 'Invalid weight' using errcode = '22023'; end if;

      select p.name, pp.price_cents into name, list_price
      from public.products p
      join lateral (
        select price_cents from public.product_prices
        where organization_id = org_id and product_id = p.id and (branch_id = p_branch_id or branch_id is null)
          and valid_from <= at_time and (valid_to is null or valid_to > at_time)
        order by (branch_id = p_branch_id) desc, valid_from desc limit 1
      ) pp on true
      where p.id = product and p.organization_id = org_id and p.active and p.unit_type = 'WEIGHT';
      if not found or list_price <> expected_price then
        raise exception 'Product price changed; reload and retry' using errcode = '40001';
      end if;
      list_subtotal := app_private.round_ratio_half_up(list_price * grams, 1000);

      if pack_promotion_id is not null then
        select * into pack_promo from public.product_weight_discounts
        where id = pack_promotion_id and organization_id = org_id and product_id = product
          and promotion_mode = 'PACK_FIXED_TOTAL' and active
          and (branch_id = p_branch_id or branch_id is null)
          and valid_from <= at_time and (valid_until is null or valid_until > at_time);
        if not found then raise exception 'Promotion configuration changed; reload and retry' using errcode = '40001'; end if;
        -- Guard is (and always was) against LIST price — the pack's fixed total, before any card
        -- surcharge, must not exceed what the weighed amount would cost at plain list price.
        if pack_promo.pack_price_cents > list_subtotal then
          raise exception 'El precio del pack supera el precio de lista para el peso pesado' using errcode = '22023';
        end if;
        -- cash_subtotal is the pack's CASH-equivalent total; the surcharge (D-044, corrected)
        -- applies to this WHOLE total below (one rounding, mirrors calculateWeightPackSalePricing
        -- exactly — a pack has no single per-kg rate to round first), exactly like any other line
        -- — no pack exception. final_price_per_kg_cents is only a derived display equivalent.
        cash_subtotal := pack_promo.pack_price_cents;
        promotion_discount := greatest(list_subtotal - cash_subtotal, 0);
        rule_id := pack_promo.id; rule_discount_type := null; rule_discount_value := null; line_promotion_mode := 'PACK_FIXED_TOTAL';
        subtotal := case when cash_bps > 0 then app_private.round_ratio_half_up(cash_subtotal * (10000 + cash_bps), 10000) else cash_subtotal end;
        final_price := app_private.round_ratio_half_up(subtotal * 1000, grams);
      else
        select * into promo from public.resolve_weight_discount(org_id, product, p_branch_id, grams, list_price, at_time);
        promo_price := coalesce(promo.final_price_cents, list_price);
        if promo_price > list_price then raise exception 'Promotion is not a discount' using errcode = '22023'; end if;
        cash_subtotal := app_private.round_ratio_half_up(promo_price * grams, 1000);
        promotion_discount := list_subtotal - cash_subtotal;
        rule_id := promo.rule_id; rule_discount_type := promo.discount_type; rule_discount_value := promo.discount_value;
        line_promotion_mode := case when rule_id is not null then 'THRESHOLD'::public.promotion_mode end;
        -- Non-pack: round once at the per-kg level (mirrors calculateSalePricing exactly), THEN
        -- derive the subtotal from grams (its own, second rounding) — same double-rounding shape
        -- the pre-existing cash-discount code already had, just with the surcharge in the second
        -- factor instead of the first.
        final_price := case when cash_bps > 0 then app_private.round_ratio_half_up(promo_price * (10000 + cash_bps), 10000) else promo_price end;
        subtotal := app_private.round_ratio_half_up(final_price * grams, 1000);
      end if;
      card_surcharge := subtotal - cash_subtotal;
      if (expected_cash_bps is not null and expected_cash_bps <> cash_bps) or (expected_final_price is not null and expected_final_price <> final_price) then
        raise exception 'Commercial configuration changed; reload and retry' using errcode = '40001';
      end if;

      select c.cost_cents into cost_snapshot from public.product_costs c
      where c.organization_id = org_id and c.product_id = product and c.valid_from <= at_time and (c.valid_to is null or c.valid_to > at_time)
      order by c.valid_from desc limit 1;
      select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s
      where s.organization_id = org_id and s.product_id = product and s.valid_from <= at_time and (s.valid_to is null or s.valid_to > at_time)
      order by s.valid_from desc limit 1;

      insert into public.sale_items(
        sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents,
        original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, final_price_per_kg_cents,
        discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_cents_snapshot,
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at
      ) values (
        sale, org_id, p_branch_id, product, name, grams, final_price, list_price, rule_id, rule_discount_type,
        rule_discount_value, final_price, promotion_discount, cash_bps, 0, card_surcharge,
        promotion_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, at_time
      );
      insert into public.stock_movements(organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values (org_id, p_branch_id, product, 'SALE', -grams, sale, profile_id, at_time, at_time);
      total := total + subtotal; weight := weight + grams;
    end if;
  end loop;

  update public.sales set total_cents = total, total_weight_grams = weight where id = sale;
  insert into public.payments(sale_id, organization_id, branch_id, method, amount_cents, created_at)
  values (sale, org_id, p_branch_id, method, total, at_time);
  return query select sale, total, weight, at_time;
end;
$$;

-- sync_offline_sale (offline push): same signature as 202609230034, mirroring the Rust
-- insert_sale validation the device already ran. Same D-044 formula changes as
-- complete_discounted_sale above.
create or replace function public.sync_offline_sale(p_device_id uuid, p_event_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  profile_id uuid := auth.uid();
  org_id uuid;
  branch_uuid uuid;
  device_status public.pos_device_status;
  payload_hash text := encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
  receipt public.pos_sync_receipts%rowtype;
  inserted boolean;
  sale_id uuid; created_at timestamptz; completed_at timestamptz; declared_total bigint; declared_weight bigint;
  computed_total bigint := 0; computed_weight bigint := 0; method public.payment_method;
  item_index integer; item jsonb; movement jsonb; current_product_id uuid; grams integer; quantity integer;
  list_price bigint; promo_price bigint; final_price bigint; subtotal bigint;
  discount_total bigint; cash_bps integer; cash_discount bigint; card_surcharge bigint; promo_discount bigint;
  discount_type public.weight_discount_type; discount_value bigint; discount_rule uuid;
  line_promotion_mode public.promotion_mode; pack_promo public.product_weight_discounts%rowtype;
  whole_packs bigint; remainder bigint;
  list_subtotal bigint; cash_subtotal bigint; cost_snapshot bigint; profit_snapshot integer;
begin
  if profile_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_payload is null or p_payload->>'schemaVersion' <> '1' then raise exception 'Unsupported offline sale payload' using errcode = '22023'; end if;
  if jsonb_typeof(p_payload->'items') <> 'array' or jsonb_array_length(p_payload->'items') not between 1 and 100
     or jsonb_typeof(p_payload->'stockMovements') <> 'array' or jsonb_array_length(p_payload->'stockMovements') <> jsonb_array_length(p_payload->'items') then
    raise exception 'Offline sale items are invalid' using errcode = '22023';
  end if;
  select d.organization_id, d.branch_id, d.status into org_id, branch_uuid, device_status from public.pos_devices d where d.id = p_device_id;
  if not found or device_status <> 'ACTIVE' or not app_private.can_access_branch(org_id, branch_uuid, 'sales.create') then
    raise exception 'Device or branch is not authorized for this user' using errcode = '42501';
  end if;
  begin
    sale_id := (p_payload->>'saleId')::uuid; created_at := (p_payload->>'createdAt')::timestamptz; completed_at := (p_payload->>'completedAt')::timestamptz;
    declared_total := (p_payload->>'totalCents')::bigint; declared_weight := (p_payload->>'totalWeightGrams')::bigint;
    method := upper(p_payload->'payment'->>'method')::public.payment_method;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale header is invalid' using errcode = '22023'; end;
  if (p_payload->>'eventId')::uuid <> p_event_id or (p_payload->>'deviceId')::uuid <> p_device_id or (p_payload->>'organizationId')::uuid <> org_id
     or (p_payload->>'branchId')::uuid <> branch_uuid or (p_payload->>'profileId')::uuid <> profile_id or p_payload->>'status' <> 'COMPLETED'
     or created_at > completed_at or completed_at > now() + interval '5 minutes' then
    raise exception 'Offline sale identity or timestamps are invalid' using errcode = '42501';
  end if;
  insert into public.pos_sync_receipts(event_id, sale_id, device_id, payload_hash) values(p_event_id, sale_id, p_device_id, payload_hash)
  on conflict(event_id) do nothing returning true into inserted;
  if not coalesce(inserted, false) then
    select * into receipt from public.pos_sync_receipts where event_id = p_event_id;
    if receipt.sale_id <> sale_id or receipt.device_id <> p_device_id or receipt.payload_hash <> payload_hash then
      raise exception 'Idempotency key was reused with a different payload' using errcode = '23505';
    end if;
    return jsonb_build_object('saleId', sale_id, 'duplicate', true, 'syncedAt', receipt.received_at);
  end if;
  if exists(select 1 from public.sales where id = sale_id) then raise exception 'Sale id already exists with another sync event' using errcode = '23505'; end if;
  insert into public.sales(id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, created_at, completed_at, device_id, sync_event_id)
  values(sale_id, org_id, branch_uuid, profile_id, 'COMPLETED', 0, 0, created_at, completed_at, p_device_id, p_event_id);

  for item_index in 0..jsonb_array_length(p_payload->'items') - 1 loop
    item := p_payload->'items'->item_index; movement := p_payload->'stockMovements'->item_index;
    begin
      current_product_id := (item->>'productId')::uuid; final_price := (item->>'pricePerKgCents')::bigint;
      list_price := coalesce(nullif(item->>'originalPricePerKgCents', '')::bigint, final_price);
      discount_total := coalesce(nullif(item->>'discountCents', '')::bigint, 0);
      cash_bps := coalesce(nullif(item->>'cashDiscountBps', '')::integer, 0);
      cash_discount := coalesce(nullif(item->>'cashDiscountCents', '')::bigint, 0);
      card_surcharge := coalesce(nullif(item->>'cardSurchargeCents', '')::bigint, 0);
      promo_discount := coalesce(nullif(item->>'promotionDiscountCents', '')::bigint, discount_total - cash_discount);
      discount_type := nullif(item->>'discountType', '')::public.weight_discount_type; discount_value := nullif(item->>'discountValue', '')::bigint; discount_rule := nullif(item->>'discountRuleId', '')::uuid;
      line_promotion_mode := nullif(item->>'promotionMode', '')::public.promotion_mode;
      subtotal := (item->>'subtotalCents')::bigint;
      grams := nullif(item->>'weightGrams', '')::integer;
      quantity := nullif(item->>'quantityUnits', '')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale item snapshot is malformed' using errcode = '22023'; end;
    -- D-044: only DEBIT/CREDIT may carry a nonzero bps now (the surcharge); CASH/TRANSFER/OTHER
    -- must not (they get no adjustment at all).
    if list_price <= 0 or final_price <= 0 or cash_bps not between 0 and 9999
       or (app_private.payment_method_receives_discount(method) and cash_bps <> 0)
       or cash_discount <> 0 then
      raise exception 'Offline sale item values are invalid' using errcode = '22023';
    end if;

    if quantity is not null and grams is null then
      -- UNIT line.
      if quantity <= 0 then raise exception 'Offline sale item values are invalid' using errcode = '22023'; end if;
      list_subtotal := list_price * quantity;
      if discount_type is not null or discount_value is not null then
        raise exception 'Offline unit sale discount metadata is inconsistent' using errcode = '22023';
      end if;
      if line_promotion_mode = 'PACK_FIXED_TOTAL' then
        if discount_rule is null then raise exception 'Offline pack sale is missing its promotion id' using errcode = '22023'; end if;
        select * into pack_promo from public.product_weight_discounts
        where id = discount_rule and organization_id = org_id and product_id = current_product_id and promotion_mode = 'PACK_FIXED_TOTAL';
        if not found or pack_promo.pack_quantity_units is null then raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501'; end if;
        if pack_promo.pack_price_cents > list_price * pack_promo.pack_quantity_units then
          raise exception 'El precio del pack supera el precio de lista para su cantidad' using errcode = '22023';
        end if;
        whole_packs := quantity / pack_promo.pack_quantity_units;
        remainder := quantity % pack_promo.pack_quantity_units;
        -- Pack total: CASH-equivalent = whole packs at their fixed price + remainder at plain
        -- list (never a discounted rate) — the surcharge (D-044, corrected) is ONE rounding on
        -- the WHOLE resulting total below, never only on the remainder.
        cash_subtotal := pack_promo.pack_price_cents * whole_packs + list_price * remainder;
        if promo_discount <> greatest(list_price * (whole_packs * pack_promo.pack_quantity_units) - pack_promo.pack_price_cents * whole_packs, 0)
           or discount_total <> promo_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        if subtotal <> (case when cash_bps > 0 then app_private.round_ratio_half_up(cash_subtotal * (10000 + cash_bps), 10000) else cash_subtotal end)
           or final_price <> subtotal then
          raise exception 'Offline pack promotion is inconsistent' using errcode = '22023';
        end if;
      else
        cash_subtotal := list_subtotal;
        if promo_discount <> 0 or discount_total <> 0 then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        -- Non-pack: round once at the per-unit level (mirrors calculateSalePricing exactly,
        -- since quantityDivisor 1 makes its own subtotal rounding a no-op), then multiply exactly
        -- — not a single rounding on the subtotal, which can disagree by a cent for some quantities.
        if final_price <> (case when cash_bps > 0 then app_private.round_ratio_half_up(list_price * (10000 + cash_bps), 10000) else list_price end)
           or subtotal <> final_price * quantity then
          raise exception 'Undiscounted snapshot is inconsistent' using errcode = '22023';
        end if;
      end if;
      if card_surcharge <> subtotal - cash_subtotal then
        raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
      end if;
      if not exists(select 1 from public.products p where p.id = current_product_id and p.organization_id = org_id and p.unit_type = 'UNIT') then
        raise exception 'Offline sale product does not belong to the device organization' using errcode = '42501';
      end if;
      if (movement->>'productId')::uuid <> current_product_id or (movement->>'quantityGrams')::bigint <> -quantity::bigint then
        raise exception 'Offline stock movement does not match its sale item' using errcode = '22023';
      end if;

      select c.cost_cents into cost_snapshot from public.product_costs c
      where c.organization_id = org_id and c.product_id = current_product_id and c.valid_from <= completed_at and (c.valid_to is null or c.valid_to > completed_at)
      order by c.valid_from desc limit 1;
      select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s
      where s.organization_id = org_id and s.product_id = current_product_id and s.valid_from <= completed_at and (s.valid_to is null or s.valid_to > completed_at)
      order by s.valid_from desc limit 1;

      insert into public.sale_items(
        id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents,
        original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, final_price_per_kg_cents,
        discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_cents_snapshot,
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at
      ) values (
        (item->>'id')::uuid, sale_id, org_id, branch_uuid, current_product_id, item->>'productNameSnapshot', quantity, final_price,
        list_price, discount_rule, null, null, final_price, discount_total, cash_bps, 0, card_surcharge,
        promo_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, completed_at
      );
      insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values ((movement->>'id')::uuid, org_id, branch_uuid, current_product_id, 'SALE', -quantity::bigint, sale_id, profile_id, (movement->>'occurredAt')::timestamptz, completed_at);
      computed_total := computed_total + subtotal;
    else
      -- WEIGHT line.
      if grams is null or grams <= 0 then raise exception 'Offline sale item values are invalid' using errcode = '22023'; end if;
      list_subtotal := app_private.round_ratio_half_up(list_price * grams, 1000);

      if line_promotion_mode = 'PACK_FIXED_TOTAL' then
        if discount_type is not null or discount_value is not null then
          raise exception 'Offline pack promotion metadata is inconsistent' using errcode = '22023';
        end if;
        if discount_rule is null then raise exception 'Offline pack sale is missing its promotion id' using errcode = '22023'; end if;
        select * into pack_promo from public.product_weight_discounts
        where id = discount_rule and organization_id = org_id and product_id = current_product_id and promotion_mode = 'PACK_FIXED_TOTAL';
        if not found then raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501'; end if;
        -- Guard against LIST price, before any card surcharge — the pack total is
        -- payment-method-invariant only up to this guard, not in the final charged amount below.
        if pack_promo.pack_price_cents > list_subtotal then raise exception 'El precio del pack supera el precio de lista para el peso pesado' using errcode = '22023'; end if;
        cash_subtotal := pack_promo.pack_price_cents;
        if promo_discount <> greatest(list_subtotal - cash_subtotal, 0) or discount_total <> promo_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        -- The surcharge (D-044, corrected) applies to the WHOLE pack total below — one rounding,
        -- mirrors calculateWeightPackSalePricing exactly (no single per-kg rate to round first).
        if subtotal <> (case when cash_bps > 0 then app_private.round_ratio_half_up(cash_subtotal * (10000 + cash_bps), 10000) else cash_subtotal end)
           or final_price <> app_private.round_ratio_half_up(subtotal * 1000, grams) then
          raise exception 'Offline pack promotion is inconsistent' using errcode = '22023';
        end if;
      else
        if discount_type = 'PERCENTAGE' then
          if discount_value not between 1 and 10000 then raise exception 'Offline percentage promotion is inconsistent' using errcode = '22023'; end if;
          promo_price := app_private.round_ratio_half_up(list_price * (10000 - discount_value), 10000);
        elsif discount_type = 'FIXED_PRICE_PER_KG' then
          if discount_value <= 0 then raise exception 'Offline fixed-price promotion is inconsistent' using errcode = '22023'; end if;
          promo_price := discount_value;
        elsif discount_rule is not null or discount_value is not null then
          raise exception 'Offline promotion metadata is inconsistent' using errcode = '22023';
        else
          promo_price := list_price;
        end if;
        if promo_price > list_price then raise exception 'Offline promotion cannot increase a price' using errcode = '22023'; end if;
        cash_subtotal := app_private.round_ratio_half_up(promo_price * grams, 1000);
        if promo_discount <> list_subtotal - cash_subtotal or discount_total <> promo_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        -- Non-pack: round once at the per-kg level (list -> promotion -> surcharge, D-044,
        -- corrected), THEN derive the subtotal from grams — mirrors calculateSalePricing exactly.
        if final_price <> (case when cash_bps > 0 then app_private.round_ratio_half_up(promo_price * (10000 + cash_bps), 10000) else promo_price end)
           or subtotal <> app_private.round_ratio_half_up(final_price * grams, 1000) then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        if discount_rule is not null and not exists(
          select 1 from public.product_weight_discounts pwd where pwd.id = discount_rule and pwd.organization_id = org_id and pwd.product_id = current_product_id
        ) then
          raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501';
        end if;
      end if;
      if card_surcharge <> subtotal - cash_subtotal then
        raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
      end if;

      if not exists(select 1 from public.products p where p.id = current_product_id and p.organization_id = org_id and p.unit_type = 'WEIGHT') then
        raise exception 'Offline sale product does not belong to the device organization' using errcode = '42501';
      end if;
      if (movement->>'productId')::uuid <> current_product_id or (movement->>'quantityGrams')::bigint <> -grams::bigint then
        raise exception 'Offline stock movement does not match its sale item' using errcode = '22023';
      end if;
      select c.cost_cents into cost_snapshot from public.product_costs c
      where c.organization_id = org_id and c.product_id = current_product_id and c.valid_from <= completed_at and (c.valid_to is null or c.valid_to > completed_at)
      order by c.valid_from desc limit 1;
      select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s
      where s.organization_id = org_id and s.product_id = current_product_id and s.valid_from <= completed_at and (s.valid_to is null or s.valid_to > completed_at)
      order by s.valid_from desc limit 1;

      insert into public.sale_items(
        id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents,
        original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, final_price_per_kg_cents,
        discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_cents_snapshot,
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at
      ) values (
        (item->>'id')::uuid, sale_id, org_id, branch_uuid, current_product_id, item->>'productNameSnapshot', grams, final_price,
        list_price, discount_rule, discount_type, discount_value, final_price, discount_total, cash_bps, 0, card_surcharge,
        promo_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, completed_at
      );
      insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values ((movement->>'id')::uuid, org_id, branch_uuid, current_product_id, 'SALE', -grams::bigint, sale_id, profile_id, (movement->>'occurredAt')::timestamptz, completed_at);
      computed_total := computed_total + subtotal; computed_weight := computed_weight + grams;
    end if;
  end loop;

  if computed_total <> declared_total or computed_weight <> declared_weight or (p_payload->'payment'->>'amountCents')::bigint <> declared_total then
    raise exception 'Offline sale totals do not match its details' using errcode = '22023';
  end if;
  update public.sales set total_cents = computed_total, total_weight_grams = computed_weight where id = sale_id;
  insert into public.payments(id, sale_id, organization_id, branch_id, method, amount_cents, created_at)
  values ((p_payload->'payment'->>'id')::uuid, sale_id, org_id, branch_uuid, method, declared_total, completed_at);
  return jsonb_build_object('saleId', sale_id, 'duplicate', false, 'syncedAt', now());
end;
$$;

commit;
