begin;

-- Promotions: add a second modality, PACK_FIXED_TOTAL, alongside the existing
-- quantity-threshold discounts (PERCENTAGE / FIXED_PRICE_PER_KG). A pack is a
-- concrete quantity sold at a fixed TOTAL price (e.g. "Vacío: 2kg por $18.000",
-- "Hamburguesa: 40 unidades por $28.000") — NOT a "from X onward" threshold, so
-- it gets its own columns instead of overloading minimum_grams with a second
-- meaning. Same WEIGHT/UNIT dual-column pattern already used by
-- production_batch_outputs (output_weight_grams / output_quantity_units, see
-- 202609220029): a WEIGHT product's pack uses pack_quantity_grams, a UNIT
-- product's pack uses pack_quantity_units, never both. Existing THRESHOLD rows
-- (promotion_mode defaults to 'THRESHOLD') are entirely unchanged in shape,
-- meaning, and evaluation — resolve_weight_discount is not touched here.
--
-- Business decision (confirmed with the product owner): a WEIGHT pack charges
-- its configured total price regardless of the real weighed amount (a pre-cut
-- piece never weighs the nominal amount exactly) — the actual weight is still
-- recorded for stock. A UNIT pack applies automatically on exact multiples of
-- the pack quantity (80 units = 2x a 40-unit pack); a remainder sells at the
-- normal per-unit price. See complete_discounted_sale/sync_offline_sale below
-- for the WEIGHT pack checkout path; the UNIT pack formula lives only in
-- packages/business-logic (POS does not sell UNIT products yet, tracked
-- separately in docs/TASKS.md).

create type public.promotion_mode as enum ('THRESHOLD', 'PACK_FIXED_TOTAL');

alter table public.product_weight_discounts
  add column promotion_mode public.promotion_mode not null default 'THRESHOLD',
  add column pack_quantity_grams integer check (pack_quantity_grams is null or pack_quantity_grams > 0),
  add column pack_quantity_units integer check (pack_quantity_units is null or pack_quantity_units > 0),
  add column pack_price_cents bigint check (pack_price_cents is null or pack_price_cents > 0);

alter table public.product_weight_discounts
  alter column minimum_grams drop not null,
  alter column discount_type drop not null,
  alter column discount_value drop not null;

alter table public.product_weight_discounts
  add constraint product_weight_discounts_mode_shape_check check (
    (promotion_mode = 'THRESHOLD'
      and minimum_grams is not null and discount_type is not null and discount_value is not null
      and pack_quantity_grams is null and pack_quantity_units is null and pack_price_cents is null)
    or
    (promotion_mode = 'PACK_FIXED_TOTAL'
      and minimum_grams is null and discount_type is null and discount_value is null
      and pack_price_cents is not null
      and (pack_quantity_grams is not null) <> (pack_quantity_units is not null))
  );

-- One active PACK_FIXED_TOTAL promotion per product/branch-scope at a time —
-- avoids ambiguity about which pack applies at checkout. Mirrors the existing
-- product_weight_discounts_scope_threshold_active_idx for threshold rows.
create unique index product_weight_discounts_pack_active_idx
  on public.product_weight_discounts (organization_id, product_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where active and promotion_mode = 'PACK_FIXED_TOTAL';

-- Snapshot on the sale line: distinguishes a PACK_FIXED_TOTAL line without
-- touching the existing weight_discount_type enum (which stays THRESHOLD-only,
-- avoiding any ALTER TYPE ... ADD VALUE risk on an enum already used by live
-- sale rows). Nullable: legacy rows and undiscounted lines have no promotion at
-- all. Backfilled only for rows that already recorded a threshold rule.
alter table public.sale_items add column promotion_mode public.promotion_mode;
update public.sale_items set promotion_mode = 'THRESHOLD' where discount_rule_id is not null;

-- save_weight_discount: new parameters appended at the end with defaults, so
-- CREATE OR REPLACE keeps the existing signature/grants intact (same technique
-- already used elsewhere in this repo for backward-compatible RPC extensions).
-- THRESHOLD behavior/error text is byte-for-byte unchanged; PACK_FIXED_TOTAL is
-- new and allows WEIGHT or UNIT products, validating that only the pack
-- quantity column matching the product's own unit_type is populated (same
-- validation shape as set_production_batch_output).
create or replace function public.save_weight_discount(
  p_id uuid, p_product_id uuid, p_branch_id uuid, p_minimum_grams integer, p_discount_type text,
  p_discount_value bigint, p_active boolean, p_valid_from timestamptz, p_valid_until timestamptz default null,
  p_promotion_mode text default 'THRESHOLD', p_pack_quantity_grams integer default null,
  p_pack_quantity_units integer default null, p_pack_price_cents bigint default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  org_id uuid := app_private.require_permission('catalog.write');
  result_id uuid;
  mode public.promotion_mode := p_promotion_mode::public.promotion_mode;
  target_product public.products%rowtype;
begin
  select * into target_product from public.products where id = p_product_id and organization_id = org_id;

  if p_branch_id is not null and not exists(select 1 from public.branches where id = p_branch_id and organization_id = org_id) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;

  if mode = 'THRESHOLD' then
    -- Unchanged: same combined existence+type check and error as before this migration.
    if target_product.id is null or target_product.unit_type <> 'WEIGHT' then
      raise exception 'Weight product not found' using errcode = '42501';
    end if;
    if p_minimum_grams is null or p_discount_type is null or p_discount_value is null then
      raise exception 'Threshold promotions require a minimum quantity and a discount' using errcode = '22023';
    end if;
  elsif mode = 'PACK_FIXED_TOTAL' then
    if target_product.id is null then raise exception 'Product not found' using errcode = '42501'; end if;
    if p_pack_price_cents is null or p_pack_price_cents <= 0 then
      raise exception 'El precio total del pack debe ser mayor a cero' using errcode = '22023';
    end if;
    if target_product.unit_type = 'WEIGHT' then
      if p_pack_quantity_grams is null or p_pack_quantity_grams <= 0 or p_pack_quantity_units is not null then
        raise exception 'El producto "%" se vende por peso: la cantidad del pack debe cargarse en kg/gramos', target_product.name using errcode = '22023';
      end if;
    else
      if p_pack_quantity_units is null or p_pack_quantity_units <= 0 or p_pack_quantity_grams is not null then
        raise exception 'El producto "%" se vende por unidad: la cantidad del pack debe cargarse en unidades', target_product.name using errcode = '22023';
      end if;
    end if;
  end if;

  insert into public.product_weight_discounts(
    id, organization_id, product_id, branch_id, minimum_grams, discount_type, discount_value, active,
    valid_from, valid_until, promotion_mode, pack_quantity_grams, pack_quantity_units, pack_price_cents
  )
  values(
    coalesce(p_id, extensions.gen_random_uuid()), org_id, p_product_id, p_branch_id,
    case when mode = 'THRESHOLD' then p_minimum_grams end,
    case when mode = 'THRESHOLD' then p_discount_type::public.weight_discount_type end,
    case when mode = 'THRESHOLD' then p_discount_value end,
    p_active, coalesce(p_valid_from, now()), p_valid_until, mode,
    p_pack_quantity_grams, p_pack_quantity_units, p_pack_price_cents
  )
  on conflict(id) do update set
    branch_id = excluded.branch_id, minimum_grams = excluded.minimum_grams,
    discount_type = excluded.discount_type, discount_value = excluded.discount_value,
    active = excluded.active, valid_from = excluded.valid_from, valid_until = excluded.valid_until,
    promotion_mode = excluded.promotion_mode, pack_quantity_grams = excluded.pack_quantity_grams,
    pack_quantity_units = excluded.pack_quantity_units, pack_price_cents = excluded.pack_price_cents
  where public.product_weight_discounts.organization_id = org_id
  returning id into result_id;
  return result_id;
end;
$$;

-- complete_discounted_sale (online WEIGHT checkout): same signature (p_items is
-- jsonb, so a pack line is expressed with an extra optional key inside each
-- item object, no SQL signature change needed). If an item carries
-- pack_promotion_id, the line is priced at that promotion's fixed total
-- instead of a per-kg rate; the real weighed grams are still what moves stock.
-- A sanity guard rejects a pack whose total exceeds the LIST price for the
-- actual weighed amount (never actually a worse deal than buying unweighted at
-- full list price) — in practice never triggered by a real pre-cut piece's
-- natural weight variance, but prevents a nonsensical/negative-discount sale.
-- promotion_discount_cents is clamped to >= 0 to respect its existing CHECK
-- constraint in that same edge case; discount_cents (list_subtotal - subtotal)
-- stays exact because the guard already ensures it can't go negative.
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
  expected_price bigint;
  expected_cash_bps integer;
  expected_final_price bigint;
  pack_promotion_id uuid;
  pack_promo public.product_weight_discounts%rowtype;
  name text;
  list_price bigint;
  cash_price bigint;
  final_price bigint;
  promo record;
  rule_id uuid;
  rule_discount_type public.weight_discount_type;
  rule_discount_value bigint;
  line_promotion_mode public.promotion_mode;
  list_subtotal bigint;
  cash_subtotal bigint;
  subtotal bigint;
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
  if app_private.payment_method_receives_discount(method) then
    select cash_discount_bps into cash_bps from public.organization_cash_discounts
    where organization_id = org_id and valid_from <= at_time and (valid_to is null or valid_to > at_time)
    order by valid_from desc limit 1;
    cash_bps := coalesce(cash_bps, 1000);
  end if;
  insert into public.sales(organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, completed_at)
  values(org_id, p_branch_id, profile_id, 'COMPLETED', 0, 0, at_time) returning id into sale;

  for item in select value from jsonb_array_elements(p_items) loop
    product := (item->>'product_id')::uuid;
    grams := (item->>'weight_grams')::integer;
    expected_price := (item->>'expected_price_per_kg_cents')::bigint;
    expected_cash_bps := nullif(item->>'expected_cash_discount_bps', '')::integer;
    expected_final_price := nullif(item->>'expected_final_price_per_kg_cents', '')::bigint;
    pack_promotion_id := nullif(item->>'pack_promotion_id', '')::uuid;
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
    cash_price := app_private.round_ratio_half_up(list_price * (10000 - cash_bps), 10000);
    list_subtotal := app_private.round_ratio_half_up(list_price * grams, 1000);
    cash_subtotal := app_private.round_ratio_half_up(cash_price * grams, 1000);

    if pack_promotion_id is not null then
      select * into pack_promo from public.product_weight_discounts
      where id = pack_promotion_id and organization_id = org_id and product_id = product
        and promotion_mode = 'PACK_FIXED_TOTAL' and active
        and (branch_id = p_branch_id or branch_id is null)
        and valid_from <= at_time and (valid_until is null or valid_until > at_time);
      if not found then raise exception 'Promotion configuration changed; reload and retry' using errcode = '40001'; end if;
      if pack_promo.pack_price_cents > list_subtotal then
        raise exception 'El precio del pack supera el precio de lista para el peso pesado' using errcode = '22023';
      end if;
      final_price := app_private.round_ratio_half_up(pack_promo.pack_price_cents * 1000, grams);
      subtotal := pack_promo.pack_price_cents;
      rule_id := pack_promo.id; rule_discount_type := null; rule_discount_value := null; line_promotion_mode := 'PACK_FIXED_TOTAL';
    else
      select * into promo from public.resolve_weight_discount(org_id, product, p_branch_id, grams, cash_price, at_time);
      final_price := coalesce(promo.final_price_cents, cash_price);
      if final_price > cash_price then raise exception 'Promotion is not a discount for this payment method' using errcode = '22023'; end if;
      if (expected_cash_bps is not null and expected_cash_bps <> cash_bps) or (expected_final_price is not null and expected_final_price <> final_price) then
        raise exception 'Commercial configuration changed; reload and retry' using errcode = '40001';
      end if;
      subtotal := app_private.round_ratio_half_up(final_price * grams, 1000);
      rule_id := promo.rule_id; rule_discount_type := promo.discount_type; rule_discount_value := promo.discount_value;
      line_promotion_mode := case when rule_id is not null then 'THRESHOLD'::public.promotion_mode end;
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
      discount_cents, cash_discount_bps, cash_discount_cents, promotion_discount_cents, cost_cents_snapshot,
      profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at
    ) values (
      sale, org_id, p_branch_id, product, name, grams, final_price, list_price, rule_id, rule_discount_type,
      rule_discount_value, final_price, list_subtotal - subtotal, cash_bps, list_subtotal - cash_subtotal,
      greatest(cash_subtotal - subtotal, 0), cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, at_time
    );
    insert into public.stock_movements(organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
    values (org_id, p_branch_id, product, 'SALE', -grams, sale, profile_id, at_time, at_time);
    total := total + subtotal; weight := weight + grams;
  end loop;

  update public.sales set total_cents = total, total_weight_grams = weight where id = sale;
  insert into public.payments(sale_id, organization_id, branch_id, method, amount_cents, created_at)
  values (sale, org_id, p_branch_id, method, total, at_time);
  return query select sale, total, weight, at_time;
end;
$$;

-- sync_offline_sale (offline push): same treatment for a pack line, validated
-- independently server-side like every other offline arithmetic field. A
-- synced item carrying discountType/promotionMode = 'PACK_FIXED_TOTAL' (no
-- percentage/fixed-per-kg discount metadata) must reference a real, still-valid
-- PACK_FIXED_TOTAL rule for that product whose pack_price_cents matches the
-- synced subtotal exactly, and that price must not exceed list price for the
-- synced weight (same guard as the online path).
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
  item_index integer; item jsonb; movement jsonb; current_product_id uuid; grams integer;
  list_price bigint; cash_price bigint; final_price bigint; subtotal bigint;
  discount_total bigint; cash_bps integer; cash_discount bigint; promo_discount bigint;
  discount_type public.weight_discount_type; discount_value bigint; discount_rule uuid;
  line_promotion_mode public.promotion_mode; pack_promo public.product_weight_discounts%rowtype;
  list_subtotal bigint; cash_subtotal bigint; cost_snapshot bigint; profit_snapshot integer; has_new_pricing boolean;
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
    has_new_pricing := item ? 'cashDiscountBps' or item ? 'promotionDiscountCents';
    begin
      current_product_id := (item->>'productId')::uuid; grams := (item->>'weightGrams')::integer; final_price := (item->>'pricePerKgCents')::bigint;
      list_price := coalesce(nullif(item->>'originalPricePerKgCents', '')::bigint, final_price);
      discount_total := coalesce(nullif(item->>'discountCents', '')::bigint, 0);
      cash_bps := coalesce(nullif(item->>'cashDiscountBps', '')::integer, 0);
      cash_discount := coalesce(nullif(item->>'cashDiscountCents', '')::bigint, 0);
      promo_discount := coalesce(nullif(item->>'promotionDiscountCents', '')::bigint, discount_total - cash_discount);
      discount_type := nullif(item->>'discountType', '')::public.weight_discount_type; discount_value := nullif(item->>'discountValue', '')::bigint; discount_rule := nullif(item->>'discountRuleId', '')::uuid;
      line_promotion_mode := nullif(item->>'promotionMode', '')::public.promotion_mode;
      subtotal := (item->>'subtotalCents')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale item snapshot is malformed' using errcode = '22023'; end;
    if grams <= 0 or list_price <= 0 or final_price <= 0 or cash_bps not between 0 and 9999 or (not app_private.payment_method_receives_discount(method) and cash_bps <> 0) then
      raise exception 'Offline sale item values are invalid' using errcode = '22023';
    end if;
    cash_price := app_private.round_ratio_half_up(list_price * (10000 - cash_bps), 10000);
    list_subtotal := app_private.round_ratio_half_up(list_price * grams, 1000); cash_subtotal := app_private.round_ratio_half_up(cash_price * grams, 1000);

    if line_promotion_mode = 'PACK_FIXED_TOTAL' then
      if discount_type is not null or discount_value is not null then
        raise exception 'Offline pack promotion metadata is inconsistent' using errcode = '22023';
      end if;
      if discount_rule is null then raise exception 'Offline pack sale is missing its promotion id' using errcode = '22023'; end if;
      select * into pack_promo from public.product_weight_discounts
      where id = discount_rule and organization_id = org_id and product_id = current_product_id and promotion_mode = 'PACK_FIXED_TOTAL';
      if not found then raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501'; end if;
      if pack_promo.pack_price_cents > list_subtotal then raise exception 'El precio del pack supera el precio de lista para el peso pesado' using errcode = '22023'; end if;
      if final_price <> app_private.round_ratio_half_up(pack_promo.pack_price_cents * 1000, grams) or subtotal <> pack_promo.pack_price_cents then
        raise exception 'Offline pack promotion is inconsistent' using errcode = '22023';
      end if;
      if cash_discount <> list_subtotal - cash_subtotal or promo_discount <> greatest(cash_subtotal - subtotal, 0) or discount_total <> list_subtotal - subtotal then
        raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
      end if;
    else
      if discount_type = 'PERCENTAGE' then
        if discount_value not between 1 and 10000
           or (has_new_pricing and final_price <> app_private.round_ratio_half_up(cash_price * (10000 - discount_value), 10000))
           or (not has_new_pricing and final_price <> app_private.round_ratio_half_up(cash_price * (10000 - discount_value), 10000) and final_price <> cash_price * (10000 - discount_value) / 10000) then
          raise exception 'Offline percentage promotion is inconsistent' using errcode = '22023';
        end if;
      elsif discount_type = 'FIXED_PRICE_PER_KG' then
        if discount_value <= 0 or final_price <> discount_value then raise exception 'Offline fixed-price promotion is inconsistent' using errcode = '22023'; end if;
      elsif discount_rule is not null or discount_value is not null then
        raise exception 'Offline promotion metadata is inconsistent' using errcode = '22023';
      else
        if final_price <> cash_price then raise exception 'Offline undiscounted price is inconsistent' using errcode = '22023'; end if;
      end if;
      if final_price > cash_price then raise exception 'Offline promotion cannot increase a price' using errcode = '22023'; end if;
      if subtotal <> app_private.round_ratio_half_up(final_price * grams, 1000) or cash_discount <> list_subtotal - cash_subtotal
         or promo_discount <> cash_subtotal - subtotal or discount_total <> cash_discount + promo_discount then
        raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
      end if;
      if discount_rule is not null and not exists(
        select 1 from public.product_weight_discounts pwd where pwd.id = discount_rule and pwd.organization_id = org_id and pwd.product_id = current_product_id
      ) then
        raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501';
      end if;
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
      discount_cents, cash_discount_bps, cash_discount_cents, promotion_discount_cents, cost_cents_snapshot,
      profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at
    ) values (
      (item->>'id')::uuid, sale_id, org_id, branch_uuid, current_product_id, item->>'productNameSnapshot', grams, final_price,
      list_price, discount_rule, discount_type, discount_value, final_price, discount_total, cash_bps, cash_discount,
      promo_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, completed_at
    );
    insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
    values ((movement->>'id')::uuid, org_id, branch_uuid, current_product_id, 'SALE', -grams::bigint, sale_id, profile_id, (movement->>'occurredAt')::timestamptz, completed_at);
    computed_total := computed_total + subtotal; computed_weight := computed_weight + grams;
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

-- get_pos_commercial_config: expose pack fields to the online POS alongside
-- the existing threshold fields, so a product with an active PACK_FIXED_TOTAL
-- promotion can offer the "sell as pack" toggle. discountValue stays text
-- (bigint precision) exactly like the existing fields.
create or replace function public.get_pos_commercial_config(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare org_id uuid; at_time timestamptz := now();
begin
  select organization_id into org_id from public.branches where id = p_branch_id and active;
  if auth.uid() is null or org_id is null or not app_private.can_access_branch(org_id, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  return jsonb_build_object(
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

commit;
