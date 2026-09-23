begin;

-- Enables selling UNIT products in the POS, online and offline (the sprint's
-- "40 hamburguesas por $28.000" case). Previously blocked in three
-- independent layers (apps/pos/src/App.tsx's client-side unit_type==='WEIGHT'
-- filter, Rust/SQLite structs with no quantity-units field, and these two
-- RPCs' own unit_type='WEIGHT' guards) — this migration removes the two
-- server-side layers; the POS/Rust layers are removed in the same sprint's
-- app code, not here.
--
-- sale_items.weight_grams becomes nullable; a new quantity_units column holds
-- a UNIT line's quantity. Exactly one of the two is ever set per row — same
-- mutually-exclusive-optional-columns pattern already used by
-- production_batch_outputs (output_weight_grams/output_quantity_units, D-038)
-- and product_weight_discounts (pack_quantity_grams/pack_quantity_units,
-- D-039), not an overload of one column with two meanings.
--
-- price_per_kg_cents/original_price_per_kg_cents/final_price_per_kg_cents
-- keep their historical (WEIGHT-era) names but are reused generically as
-- "price per kg or per unit, matching the product's own unit_type" for a
-- UNIT row — the exact same generic-reuse convention product_prices.price_cents
-- already relies on (see docs/ARCHITECTURE.md "Precio e historia"). Renaming
-- these long-established, widely-referenced columns would be a much larger,
-- riskier change than the reuse is worth.
--
-- stock_movements.quantity_grams is NOT altered: a UNIT sale's movement
-- reuses it directly as a signed unit count, following the EXACT precedent
-- already set by PRODUCTION_YIELD for a UNIT output
-- (`coalesce(output_quantity_units, output_weight_grams)`, see
-- complete_production_batch in 202609220024/202609220029) — not a new
-- convention invented here.
--
-- THRESHOLD promotions (percentage / fixed-price-per-kg) never apply to a
-- UNIT line — that stays WEIGHT-only by design (save_weight_discount, D-039).
-- The only promotion a UNIT line can carry is PACK_FIXED_TOTAL, applied in
-- exact multiples of the pack's quantity with any remainder at the normal
-- cash price (calculateUnitPackSalePricing in packages/business-logic, and
-- the identical formula re-validated here and in apps/pos/src-tauri's
-- insert_sale). A UNIT line never contributes to a sale's total WEIGHT
-- (weight stays a pure weight tally); sales.total_weight_grams already
-- allows zero (>= 0 since its original definition), so a sale made entirely
-- of UNIT items needs no further schema change there.

alter table public.sale_items
  alter column weight_grams drop not null,
  add column quantity_units integer check (quantity_units is null or quantity_units > 0);

alter table public.sale_items
  add constraint sale_items_quantity_shape_check check ((weight_grams is not null) <> (quantity_units is not null));

-- complete_discounted_sale: same signature (p_items is jsonb — a UNIT item is
-- expressed with quantity_units/expected_price_per_unit_cents keys instead of
-- weight_grams/expected_price_per_kg_cents; both shapes can appear in the
-- same array, one ticket can mix WEIGHT and UNIT lines). The WEIGHT branch
-- below is copied verbatim from 202609230031's version — byte-for-byte the
-- same logic, only re-indented into the new per-item branch.
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
      cash_price := app_private.round_ratio_half_up(list_price * (10000 - cash_bps), 10000);
      list_subtotal := list_price * quantity;
      cash_subtotal := cash_price * quantity;

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
        subtotal := pack_promo.pack_price_cents * whole_packs + cash_price * remainder;
        final_price := cash_price;
        rule_id := pack_promo.id; rule_discount_type := null; rule_discount_value := null; line_promotion_mode := 'PACK_FIXED_TOTAL';
      else
        subtotal := cash_subtotal;
        final_price := cash_price;
        rule_id := null; rule_discount_type := null; rule_discount_value := null; line_promotion_mode := null;
      end if;

      select c.cost_cents into cost_snapshot from public.product_costs c
      where c.organization_id = org_id and c.product_id = product and c.valid_from <= at_time and (c.valid_to is null or c.valid_to > at_time)
      order by c.valid_from desc limit 1;
      select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s
      where s.organization_id = org_id and s.product_id = product and s.valid_from <= at_time and (s.valid_to is null or s.valid_to > at_time)
      order by s.valid_from desc limit 1;

      insert into public.sale_items(
        sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents,
        original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, final_price_per_kg_cents,
        discount_cents, cash_discount_bps, cash_discount_cents, promotion_discount_cents, cost_cents_snapshot,
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at
      ) values (
        sale, org_id, p_branch_id, product, name, quantity, final_price, list_price, rule_id, rule_discount_type,
        rule_discount_value, final_price, list_subtotal - subtotal, cash_bps, list_subtotal - cash_subtotal,
        greatest(cash_subtotal - subtotal, 0), cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, at_time
      );
      -- Reuses quantity_grams as a signed unit count, same precedent as PRODUCTION_YIELD for a
      -- UNIT output (see complete_production_batch) — not a new modeling decision here.
      insert into public.stock_movements(organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values (org_id, p_branch_id, product, 'SALE', -quantity, sale, profile_id, at_time, at_time);
      total := total + subtotal;
    else
      -- WEIGHT line — unchanged from 202609230031.
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
    end if;
  end loop;

  update public.sales set total_cents = total, total_weight_grams = weight where id = sale;
  insert into public.payments(sale_id, organization_id, branch_id, method, amount_cents, created_at)
  values (sale, org_id, p_branch_id, method, total, at_time);
  return query select sale, total, weight, at_time;
end;
$$;

-- sync_offline_sale: same treatment for a UNIT item, mirroring
-- apps/pos/src-tauri/src/lib.rs's insert_sale exactly (same formulas, same
-- error conditions) so the server never disagrees with what already passed
-- local validation on the device. A synced item carries `quantityUnits`
-- instead of `weightGrams`; THRESHOLD promotion metadata (discountType/
-- discountValue) is never valid on a UNIT item — only PACK_FIXED_TOTAL or no
-- promotion at all. The WEIGHT branch below is copied verbatim from
-- 202609230031's version.
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
  list_price bigint; cash_price bigint; final_price bigint; subtotal bigint;
  discount_total bigint; cash_bps integer; cash_discount bigint; promo_discount bigint;
  discount_type public.weight_discount_type; discount_value bigint; discount_rule uuid;
  line_promotion_mode public.promotion_mode; pack_promo public.product_weight_discounts%rowtype;
  whole_packs bigint; remainder bigint;
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
      current_product_id := (item->>'productId')::uuid; final_price := (item->>'pricePerKgCents')::bigint;
      list_price := coalesce(nullif(item->>'originalPricePerKgCents', '')::bigint, final_price);
      discount_total := coalesce(nullif(item->>'discountCents', '')::bigint, 0);
      cash_bps := coalesce(nullif(item->>'cashDiscountBps', '')::integer, 0);
      cash_discount := coalesce(nullif(item->>'cashDiscountCents', '')::bigint, 0);
      promo_discount := coalesce(nullif(item->>'promotionDiscountCents', '')::bigint, discount_total - cash_discount);
      discount_type := nullif(item->>'discountType', '')::public.weight_discount_type; discount_value := nullif(item->>'discountValue', '')::bigint; discount_rule := nullif(item->>'discountRuleId', '')::uuid;
      line_promotion_mode := nullif(item->>'promotionMode', '')::public.promotion_mode;
      subtotal := (item->>'subtotalCents')::bigint;
      grams := nullif(item->>'weightGrams', '')::integer;
      quantity := nullif(item->>'quantityUnits', '')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale item snapshot is malformed' using errcode = '22023'; end;
    if list_price <= 0 or final_price <= 0 or cash_bps not between 0 and 9999 or (not app_private.payment_method_receives_discount(method) and cash_bps <> 0) then
      raise exception 'Offline sale item values are invalid' using errcode = '22023';
    end if;
    cash_price := app_private.round_ratio_half_up(list_price * (10000 - cash_bps), 10000);

    if quantity is not null and grams is null then
      -- UNIT line.
      if quantity <= 0 then raise exception 'Offline sale item values are invalid' using errcode = '22023'; end if;
      list_subtotal := list_price * quantity; cash_subtotal := cash_price * quantity;
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
        if final_price <> cash_price or subtotal <> pack_promo.pack_price_cents * whole_packs + cash_price * remainder then
          raise exception 'Offline pack promotion is inconsistent' using errcode = '22023';
        end if;
        if cash_discount <> list_subtotal - cash_subtotal or promo_discount <> greatest(cash_subtotal - subtotal, 0) or discount_total <> list_subtotal - subtotal then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
      else
        if final_price <> cash_price or subtotal <> cash_subtotal then raise exception 'Undiscounted snapshot is inconsistent' using errcode = '22023'; end if;
        if cash_discount <> list_subtotal - cash_subtotal or promo_discount <> 0 or discount_total <> cash_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
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
        discount_cents, cash_discount_bps, cash_discount_cents, promotion_discount_cents, cost_cents_snapshot,
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at
      ) values (
        (item->>'id')::uuid, sale_id, org_id, branch_uuid, current_product_id, item->>'productNameSnapshot', quantity, final_price,
        list_price, discount_rule, null, null, final_price, discount_total, cash_bps, cash_discount,
        promo_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, completed_at
      );
      insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values ((movement->>'id')::uuid, org_id, branch_uuid, current_product_id, 'SALE', -quantity::bigint, sale_id, profile_id, (movement->>'occurredAt')::timestamptz, completed_at);
      computed_total := computed_total + subtotal;
    else
      -- WEIGHT line — unchanged from 202609230031.
      if grams is null or grams <= 0 then raise exception 'Offline sale item values are invalid' using errcode = '22023'; end if;
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

-- get_profitability_analytics (202609130017) already anticipated UNIT sales:
-- it branches on product.unit_type and reads item.weight_grams as "the
-- quantity, in grams for WEIGHT or units for UNIT" — written before this
-- sprint's product_weight_discounts pack columns (D-039) and
-- production_batch_outputs (D-038) established the newer, explicit
-- "mutually-exclusive optional columns" convention this migration follows
-- for sale_items instead (see the file header comment above for why: the
-- domain rule against mixing kg/units in one field without separation).
-- Reconciling here rather than reverting sale_items' shape: every
-- item.weight_grams reference becomes coalesce(item.weight_grams,
-- item.quantity_units) — exactly one of the two is ever non-null per row, so
-- this is a drop-in read-side fix, not a behavior change for any existing
-- WEIGHT-only data. Same signature, so CREATE OR REPLACE applies.
create or replace function public.get_profitability_analytics(
  p_preset text default '7d',
  p_from date default null,
  p_to date default null,
  p_branch_id uuid default null,
  p_category_id uuid default null,
  p_product_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('analytics.read');
  current_timezone text;
  local_today date;
  start_date date;
  end_date date;
  previous_start_date date;
  previous_end_date date;
  period_start timestamptz;
  period_end timestamptz;
  previous_period_start timestamptz;
  previous_period_end timestamptz;
  period_days integer;
  current_data jsonb;
  previous_summary jsonb;
  branches jsonb;
  categories jsonb;
begin
  select organization.timezone into current_timezone
  from public.organizations organization
  where organization.id = current_organization_id and organization.active;
  if current_timezone is null then
    raise exception 'Organization timezone is unavailable' using errcode = '22023';
  end if;

  local_today := (now() at time zone current_timezone)::date;
  case p_preset
    when 'today' then start_date := local_today; end_date := local_today;
    when '7d' then start_date := local_today - 6; end_date := local_today;
    when '30d' then start_date := local_today - 29; end_date := local_today;
    when 'custom' then
      if p_from is null or p_to is null then
        raise exception 'A custom period requires both dates' using errcode = '22023';
      end if;
      start_date := p_from;
      end_date := p_to;
    else raise exception 'Analytics period is invalid' using errcode = '22023';
  end case;
  if end_date < start_date or end_date > local_today or end_date - start_date > 365 then
    raise exception 'Analytics date range is invalid' using errcode = '22023';
  end if;

  if p_branch_id is not null and not exists (
    select 1 from public.branches branch
    where branch.id = p_branch_id and branch.organization_id = current_organization_id
  ) then raise exception 'Branch was not found in this organization' using errcode = '42501'; end if;
  if p_category_id is not null and not exists (
    select 1 from public.categories category
    where category.id = p_category_id and category.organization_id = current_organization_id
  ) then raise exception 'Category was not found in this organization' using errcode = '42501'; end if;
  if p_product_id is not null and not exists (
    select 1 from public.products product
    where product.id = p_product_id and product.organization_id = current_organization_id
  ) then raise exception 'Product was not found in this organization' using errcode = '42501'; end if;

  period_days := end_date - start_date + 1;
  previous_end_date := start_date - 1;
  previous_start_date := previous_end_date - period_days + 1;
  period_start := start_date::timestamp at time zone current_timezone;
  period_end := (end_date + 1)::timestamp at time zone current_timezone;
  previous_period_start := previous_start_date::timestamp at time zone current_timezone;
  previous_period_end := (previous_end_date + 1)::timestamp at time zone current_timezone;

  select coalesce(jsonb_agg(jsonb_build_object('id', branch.id, 'name', branch.name) order by branch.name), '[]'::jsonb)
  into branches from public.branches branch
  where branch.organization_id = current_organization_id and branch.active;
  select coalesce(jsonb_agg(jsonb_build_object('id', category.id, 'name', category.name) order by category.sort_order, category.name), '[]'::jsonb)
  into categories from public.categories category
  where category.organization_id = current_organization_id and category.active;

  with lines as materialized (
    select item.product_id,
      product.name as product_name,
      product.unit_type,
      product.category_id,
      category.name as category_name,
      sale.branch_id,
      branch.name as branch_name,
      (sale.completed_at at time zone current_timezone)::date as local_day,
      coalesce(item.weight_grams, item.quantity_units)::bigint as quantity,
      item.subtotal_cents::bigint as revenue_cents,
      case
        when item.cost_cents_snapshot is null then null
        when product.unit_type = 'UNIT' then (item.cost_cents_snapshot::numeric * coalesce(item.weight_grams, item.quantity_units))::bigint
        else round(item.cost_cents_snapshot::numeric * coalesce(item.weight_grams, item.quantity_units) / 1000)::bigint
      end as cost_cents
    from public.sales sale
    join public.sale_items item on item.sale_id = sale.id
      and item.organization_id = sale.organization_id and item.branch_id = sale.branch_id
    join public.products product on product.id = item.product_id and product.organization_id = item.organization_id
    join public.categories category on category.id = product.category_id and category.organization_id = product.organization_id
    join public.branches branch on branch.id = sale.branch_id and branch.organization_id = sale.organization_id
    where sale.organization_id = current_organization_id
      and sale.status = 'COMPLETED'
      and sale.completed_at >= period_start and sale.completed_at < period_end
      and (p_branch_id is null or sale.branch_id = p_branch_id)
      and (p_category_id is null or product.category_id = p_category_id)
  ), summary as (
    select coalesce(sum(line.revenue_cents), 0)::bigint as revenue_cents,
      coalesce(sum(line.revenue_cents) filter (where line.cost_cents is not null), 0)::bigint as costed_revenue_cents,
      coalesce(sum(line.cost_cents), 0)::bigint as cost_cents,
      coalesce(sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null), 0)::bigint as gross_profit_cents,
      coalesce(sum(line.quantity) filter (where line.unit_type = 'WEIGHT'), 0)::bigint as weight_grams,
      coalesce(sum(line.quantity) filter (where line.unit_type = 'UNIT'), 0)::bigint as unit_count,
      count(*) filter (where line.cost_cents is null)::integer as missing_cost_items
    from lines line
  ), product_groups as (
    select line.product_id, line.product_name, line.unit_type, line.category_id, line.category_name,
      sum(line.quantity)::bigint as quantity,
      sum(line.revenue_cents)::bigint as revenue_cents,
      sum(line.revenue_cents) filter (where line.cost_cents is not null)::bigint as costed_revenue_cents,
      sum(line.cost_cents)::bigint as known_cost_cents,
      sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null)::bigint as known_gross_profit_cents,
      sum(line.quantity) filter (where line.cost_cents is not null)::bigint as costed_quantity,
      count(*) filter (where line.cost_cents is null)::integer as missing_cost_items
    from lines line
    group by line.product_id, line.product_name, line.unit_type, line.category_id, line.category_name
  ), product_rows as (
    select product_group.*,
      case when product_group.missing_cost_items = 0 then coalesce(product_group.known_cost_cents, 0) end as cost_cents,
      case when product_group.missing_cost_items = 0 then coalesce(product_group.known_gross_profit_cents, 0) end as gross_profit_cents,
      case when product_group.missing_cost_items = 0 and product_group.known_cost_cents > 0
        then round(product_group.known_gross_profit_cents::numeric * 10000 / product_group.known_cost_cents)::bigint end as profitability_bps,
      case when product_group.missing_cost_items = 0 and product_group.costed_quantity > 0
        then round(product_group.known_gross_profit_cents::numeric * (case when product_group.unit_type = 'WEIGHT' then 1000 else 1 end) / product_group.costed_quantity)::bigint end as profit_per_measure_cents
    from product_groups product_group
  ), category_groups as (
    select line.category_id, line.category_name,
      sum(line.revenue_cents)::bigint as revenue_cents,
      sum(line.cost_cents)::bigint as known_cost_cents,
      sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null)::bigint as known_gross_profit_cents,
      count(*) filter (where line.cost_cents is null)::integer as missing_cost_items
    from lines line group by line.category_id, line.category_name
  ), branch_groups as (
    select line.branch_id, line.branch_name, line.unit_type,
      sum(line.quantity)::bigint as quantity,
      sum(line.revenue_cents)::bigint as revenue_cents,
      sum(line.cost_cents)::bigint as known_cost_cents,
      sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null)::bigint as known_gross_profit_cents,
      count(*) filter (where line.cost_cents is null)::integer as missing_cost_items
    from lines line where p_product_id is not null and line.product_id = p_product_id
    group by line.branch_id, line.branch_name, line.unit_type
  ), daily_groups as (
    select line.local_day, line.unit_type,
      sum(line.quantity)::bigint as quantity,
      sum(line.revenue_cents)::bigint as revenue_cents,
      sum(line.cost_cents)::bigint as known_cost_cents,
      sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null)::bigint as known_gross_profit_cents,
      count(*) filter (where line.cost_cents is null)::integer as missing_cost_items
    from lines line where p_product_id is not null and line.product_id = p_product_id
    group by line.local_day, line.unit_type
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'revenueCents', summary.revenue_cents,
      'costedRevenueCents', summary.costed_revenue_cents,
      'costCents', summary.cost_cents,
      'grossProfitCents', summary.gross_profit_cents,
      'profitabilityBps', case when summary.cost_cents > 0 then round(summary.gross_profit_cents::numeric * 10000 / summary.cost_cents)::bigint end,
      'coverageBps', case when summary.revenue_cents > 0 then round(summary.costed_revenue_cents::numeric * 10000 / summary.revenue_cents)::bigint else 10000 end,
      'missingCostItems', summary.missing_cost_items,
      'weightGrams', summary.weight_grams,
      'unitCount', summary.unit_count
    ),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
      'productId', row.product_id, 'productName', row.product_name, 'unitType', row.unit_type,
      'categoryId', row.category_id, 'categoryName', row.category_name,
      'quantity', row.quantity, 'revenueCents', row.revenue_cents,
      'costCents', row.cost_cents, 'grossProfitCents', row.gross_profit_cents,
      'profitabilityBps', row.profitability_bps, 'profitPerMeasureCents', row.profit_per_measure_cents,
      'missingCostItems', row.missing_cost_items
    ) order by row.gross_profit_cents desc nulls last, row.revenue_cents desc) from product_rows row), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
      'categoryId', row.category_id, 'categoryName', row.category_name,
      'revenueCents', row.revenue_cents,
      'costCents', case when row.missing_cost_items = 0 then coalesce(row.known_cost_cents, 0) end,
      'grossProfitCents', case when row.missing_cost_items = 0 then coalesce(row.known_gross_profit_cents, 0) end,
      'missingCostItems', row.missing_cost_items
    ) order by row.revenue_cents desc) from category_groups row), '[]'::jsonb),
    'detail', case when p_product_id is null then null else (
      select jsonb_build_object(
        'productId', product.id, 'productName', product.name, 'unitType', product.unit_type,
        'categoryName', category.name,
        'summary', coalesce((select jsonb_build_object(
          'quantity', row.quantity, 'revenueCents', row.revenue_cents,
          'costCents', row.cost_cents, 'grossProfitCents', row.gross_profit_cents,
          'profitabilityBps', row.profitability_bps, 'profitPerMeasureCents', row.profit_per_measure_cents,
          'missingCostItems', row.missing_cost_items
        ) from product_rows row where row.product_id = product.id), jsonb_build_object(
          'quantity', 0, 'revenueCents', 0, 'costCents', 0, 'grossProfitCents', 0,
          'profitabilityBps', null, 'profitPerMeasureCents', 0, 'missingCostItems', 0
        )),
        'branches', coalesce((select jsonb_agg(jsonb_build_object(
          'branchId', row.branch_id, 'branchName', row.branch_name, 'quantity', row.quantity,
          'revenueCents', row.revenue_cents,
          'costCents', case when row.missing_cost_items = 0 then coalesce(row.known_cost_cents, 0) end,
          'grossProfitCents', case when row.missing_cost_items = 0 then coalesce(row.known_gross_profit_cents, 0) end,
          'profitabilityBps', case when row.missing_cost_items = 0 and row.known_cost_cents > 0 then round(row.known_gross_profit_cents::numeric * 10000 / row.known_cost_cents)::bigint end,
          'missingCostItems', row.missing_cost_items
        ) order by row.known_gross_profit_cents desc nulls last, row.revenue_cents desc) from branch_groups row), '[]'::jsonb),
        'evolution', coalesce((select jsonb_agg(jsonb_build_object(
          'date', row.local_day, 'quantity', row.quantity, 'revenueCents', row.revenue_cents,
          'grossProfitCents', case when row.missing_cost_items = 0 then coalesce(row.known_gross_profit_cents, 0) end,
          'missingCostItems', row.missing_cost_items
        ) order by row.local_day) from daily_groups row), '[]'::jsonb)
      )
      from public.products product
      join public.categories category on category.id = product.category_id and category.organization_id = product.organization_id
      where product.id = p_product_id and product.organization_id = current_organization_id
    ) end
  ) into current_data from summary;

  with lines as (
    select item.subtotal_cents::bigint as revenue_cents,
      case
        when item.cost_cents_snapshot is null then null
        when product.unit_type = 'UNIT' then (item.cost_cents_snapshot::numeric * coalesce(item.weight_grams, item.quantity_units))::bigint
        else round(item.cost_cents_snapshot::numeric * coalesce(item.weight_grams, item.quantity_units) / 1000)::bigint
      end as cost_cents
    from public.sales sale
    join public.sale_items item on item.sale_id = sale.id
      and item.organization_id = sale.organization_id and item.branch_id = sale.branch_id
    join public.products product on product.id = item.product_id and product.organization_id = item.organization_id
    where sale.organization_id = current_organization_id
      and sale.status = 'COMPLETED'
      and sale.completed_at >= previous_period_start and sale.completed_at < previous_period_end
      and (p_branch_id is null or sale.branch_id = p_branch_id)
      and (p_category_id is null or product.category_id = p_category_id)
  )
  select jsonb_build_object(
    'revenueCents', coalesce(sum(line.revenue_cents), 0)::bigint,
    'costedRevenueCents', coalesce(sum(line.revenue_cents) filter (where line.cost_cents is not null), 0)::bigint,
    'costCents', coalesce(sum(line.cost_cents), 0)::bigint,
    'grossProfitCents', coalesce(sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null), 0)::bigint,
    'coverageBps', case when coalesce(sum(line.revenue_cents), 0) > 0
      then round(coalesce(sum(line.revenue_cents) filter (where line.cost_cents is not null), 0)::numeric * 10000 / sum(line.revenue_cents))::bigint else 10000 end
  ) into previous_summary from lines line;

  return jsonb_build_object(
    'timezone', current_timezone,
    'period', jsonb_build_object('preset', p_preset, 'from', start_date, 'to', end_date, 'startAt', period_start, 'endAt', period_end),
    'previousPeriod', jsonb_build_object('from', previous_start_date, 'to', previous_end_date),
    'branches', branches,
    'categoryOptions', categories,
    'summary', current_data -> 'summary',
    'previousSummary', previous_summary,
    'products', current_data -> 'products',
    'categories', current_data -> 'categories',
    'detail', current_data -> 'detail'
  );
end;
$$;

-- get_replenishment_plan (202609130015) has the exact same pre-existing
-- coupling as get_profitability_analytics above: it already returns
-- unit_type generically and already reads stock quantities from
-- stock_levels/stock_movements' quantity_grams column (which already holds a
-- raw unit count for a UNIT product via the PRODUCTION_YIELD precedent, and
-- now via this migration's own UNIT sale stock movements) — but its "sold
-- recently" figure came straight from si.weight_grams, which is null for a
-- UNIT sale_items row. Same fix: coalesce(si.weight_grams, si.quantity_units).
-- Same signature, so CREATE OR REPLACE applies.
create or replace function public.get_replenishment_plan(p_days integer default 7)
returns table (
  branch_id uuid,
  branch_name text,
  product_id uuid,
  product_name text,
  unit_type public.unit_type,
  current_quantity bigint,
  minimum_quantity bigint,
  target_quantity bigint,
  sold_recent_quantity bigint,
  sales_days integer,
  target_coverage_days numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('dashboard.read');
  current_timezone text;
  current_target_days numeric;
  sales_start timestamptz;
begin
  if p_days < 1 or p_days > 90 then
    raise exception 'Sales period must be between 1 and 90 days' using errcode = '22023';
  end if;

  select o.timezone, o.replenishment_target_days
  into current_timezone, current_target_days
  from public.organizations o
  where o.id = current_organization_id and o.active;

  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;

  sales_start := (
    ((now() at time zone current_timezone)::date - (p_days - 1))::timestamp
    at time zone current_timezone
  );

  return query
  with recent_sales as (
    select si.branch_id, si.product_id, coalesce(sum(coalesce(si.weight_grams, si.quantity_units)), 0)::bigint as sold_quantity
    from public.sale_items si
    join public.sales s
      on s.id = si.sale_id
     and s.organization_id = si.organization_id
     and s.branch_id = si.branch_id
    where s.organization_id = current_organization_id
      and s.status = 'COMPLETED'
      and s.completed_at >= sales_start
    group by si.branch_id, si.product_id
  )
  select b.id, b.name, p.id, p.name, p.unit_type,
    coalesce(sl.quantity_grams, 0)::bigint,
    coalesce(settings.minimum_stock_grams, 0)::bigint,
    coalesce(settings.target_stock_grams, 0)::bigint,
    coalesce(recent.sold_quantity, 0)::bigint,
    p_days,
    current_target_days
  from public.branches b
  join public.products p
    on p.organization_id = b.organization_id and p.active
  left join public.stock_levels sl
    on sl.organization_id = b.organization_id
   and sl.branch_id = b.id
   and sl.product_id = p.id
  left join public.branch_product_stock_settings settings
    on settings.organization_id = b.organization_id
   and settings.branch_id = b.id
   and settings.product_id = p.id
  left join recent_sales recent
    on recent.branch_id = b.id and recent.product_id = p.id
  where b.organization_id = current_organization_id
    and b.active
    and app_private.can_access_branch(current_organization_id, b.id, 'dashboard.read')
  order by b.name, p.name;
end;
$$;

-- cancel_sale (202609100007) has the same pre-existing coupling, and this one
-- is not just a reporting inaccuracy: `sum(si.weight_grams)` is NULL for a
-- sale that contains any UNIT line (sum() over an all-null group returns
-- NULL), and stock_movements.quantity_grams is NOT NULL — so cancelling ANY
-- sale with a UNIT item would fail outright with a NOT NULL violation before
-- this fix. Same signature, so CREATE OR REPLACE applies.
create or replace function public.cancel_sale(
  p_sale_id uuid,
  p_idempotency_key uuid,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('sales.cancel');
  current_sale public.sales%rowtype;
  cancellation_time timestamptz := now();
begin
  if p_idempotency_key is null or char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Cancellation key and reason are required' using errcode = '22023';
  end if;

  select * into current_sale
  from public.sales s
  where s.id = p_sale_id and s.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Sale was not found in this organization' using errcode = '42501';
  end if;
  if current_sale.status = 'CANCELLED' then
    if current_sale.cancellation_key = p_idempotency_key then
      return jsonb_build_object('saleId', p_sale_id, 'duplicate', true, 'cancelledAt', current_sale.cancelled_at);
    end if;
    raise exception 'Sale is already cancelled' using errcode = '23505';
  end if;
  if current_sale.status <> 'COMPLETED' then
    raise exception 'Only completed sales can be cancelled' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_sale_id::text, 0));
  insert into public.stock_movements (
    organization_id, branch_id, product_id, type, quantity_grams, sale_id,
    reason, profile_id, occurred_at
  )
  select
    si.organization_id, si.branch_id, si.product_id, 'RETURN',
    sum(coalesce(si.weight_grams, si.quantity_units))::bigint, si.sale_id,
    'Cancelación: ' || btrim(p_reason), auth.uid(), cancellation_time
  from public.sale_items si
  where si.sale_id = p_sale_id
  group by si.organization_id, si.branch_id, si.product_id, si.sale_id;

  update public.sales
  set status = 'CANCELLED', cancellation_key = p_idempotency_key,
      cancelled_at = cancellation_time, cancelled_by = auth.uid(), cancellation_reason = btrim(p_reason)
  where id = p_sale_id;

  perform app_private.write_audit(
    current_organization_id, current_sale.branch_id, 'SALE_CANCELLED', 'sales', p_sale_id,
    jsonb_build_object('status', current_sale.status),
    jsonb_build_object('status', 'CANCELLED', 'reason', btrim(p_reason), 'idempotencyKey', p_idempotency_key)
  );
  return jsonb_build_object('saleId', p_sale_id, 'duplicate', false, 'cancelledAt', cancellation_time);
end;
$$;

-- get_admin_dashboard (202609100007): same pre-existing coupling, feeding the
-- Admin home page's "top productos" widgets. Fixed the same way so a UNIT
-- product's real quantity is reflected instead of NULL; the "kilograms" label
-- on these specific widgets stays literally mislabeled for a UNIT product
-- (documented limitation, not fixed here — a deeper relabel/redesign of these
-- widgets for mixed WEIGHT/UNIT catalogs was not requested and is out of
-- scope for this migration, which exists to make UNIT sales work correctly,
-- not to redesign existing dashboards). Same signature, so CREATE OR REPLACE
-- applies.
create or replace function public.get_admin_dashboard(p_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('dashboard.read');
  result jsonb;
begin
  if p_branch_id is not null and not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;

  with boundaries as (
    select
      date_trunc('day', now()) as today_start,
      date_trunc('week', now()) as week_start,
      date_trunc('month', now()) as month_start
  ), filtered_sales as (
    select s.* from public.sales s
    where s.organization_id = current_organization_id
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and s.status = 'COMPLETED'
  ), period_metrics as (
    select jsonb_build_object(
      'today', jsonb_build_object(
        'grossCents', coalesce(sum(total_cents) filter (where completed_at >= today_start), 0),
        'previousGrossCents', coalesce(sum(total_cents) filter (where completed_at >= today_start - interval '1 day' and completed_at < today_start), 0),
        'salesCount', count(*) filter (where completed_at >= today_start),
        'averageTicketCents', coalesce(avg(total_cents) filter (where completed_at >= today_start), 0)::bigint,
        'kilograms', round((coalesce(sum(total_weight_grams) filter (where completed_at >= today_start), 0)::numeric / 1000), 3)
      ),
      'week', jsonb_build_object(
        'grossCents', coalesce(sum(total_cents) filter (where completed_at >= week_start), 0),
        'previousGrossCents', coalesce(sum(total_cents) filter (where completed_at >= week_start - interval '7 days' and completed_at < week_start), 0),
        'salesCount', count(*) filter (where completed_at >= week_start),
        'averageTicketCents', coalesce(avg(total_cents) filter (where completed_at >= week_start), 0)::bigint,
        'kilograms', round((coalesce(sum(total_weight_grams) filter (where completed_at >= week_start), 0)::numeric / 1000), 3)
      ),
      'month', jsonb_build_object(
        'grossCents', coalesce(sum(total_cents) filter (where completed_at >= month_start), 0),
        'previousGrossCents', coalesce(sum(total_cents) filter (where completed_at >= month_start - interval '1 month' and completed_at < month_start), 0),
        'salesCount', count(*) filter (where completed_at >= month_start),
        'averageTicketCents', coalesce(avg(total_cents) filter (where completed_at >= month_start), 0)::bigint,
        'kilograms', round((coalesce(sum(total_weight_grams) filter (where completed_at >= month_start), 0)::numeric / 1000), 3)
      )
    ) as value
    from filtered_sales, boundaries
  ), payment_metrics as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'method', payment.method, 'amountCents', payment.amount_cents, 'salesCount', payment.sales_count
    ) order by payment.amount_cents desc), '[]'::jsonb) as value
    from (
      select p.method, sum(p.amount_cents)::bigint as amount_cents, count(distinct p.sale_id) as sales_count
      from public.payments p
      join public.sales s on s.id = p.sale_id
      cross join boundaries
      where s.organization_id = current_organization_id and s.status = 'COMPLETED'
        and (p_branch_id is null or s.branch_id = p_branch_id)
        and s.completed_at >= boundaries.month_start
      group by p.method
    ) payment
  ), product_totals as (
    select si.product_id, max(si.product_name_snapshot) as product_name,
      sum(coalesce(si.weight_grams, si.quantity_units))::bigint as grams, sum(si.subtotal_cents)::bigint as gross_cents
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    cross join boundaries
    where s.organization_id = current_organization_id and s.status = 'COMPLETED'
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and s.completed_at >= boundaries.month_start
    group by si.product_id
  ), top_products_revenue as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', ranking.product_id, 'name', ranking.product_name,
      'kilograms', round(ranking.grams::numeric / 1000, 3), 'grossCents', ranking.gross_cents
    ) order by ranking.gross_cents desc), '[]'::jsonb) as value
    from (
      select * from product_totals order by gross_cents desc limit 10
    ) ranking
  ), top_products_kg as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', ranking.product_id, 'name', ranking.product_name,
      'kilograms', round(ranking.grams::numeric / 1000, 3), 'grossCents', ranking.gross_cents
    ) order by ranking.grams desc), '[]'::jsonb) as value
    from (select * from product_totals order by grams desc limit 10) ranking
  ), least_sold_products as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', ranking.product_id, 'name', ranking.product_name,
      'kilograms', round(ranking.grams::numeric / 1000, 3), 'grossCents', ranking.gross_cents
    ) order by ranking.grams), '[]'::jsonb) as value
    from (select * from product_totals order by grams, product_name limit 10) ranking
  ), alerts as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'branchId', alert.branch_id, 'branchName', alert.branch_name,
      'productId', alert.product_id, 'productName', alert.product_name,
      'status', alert.stock_status, 'currentStockGrams', alert.current_stock_grams,
      'minimumStockGrams', alert.minimum_stock_grams,
      'suggestedReplenishmentGrams', alert.suggested_replenishment_grams
    ) order by case alert.stock_status when 'CRITICAL' then 0 else 1 end, alert.current_stock_grams), '[]'::jsonb) as value
    from public.branch_stock_status alert
    where alert.organization_id = current_organization_id
      and (p_branch_id is null or alert.branch_id = p_branch_id)
      and alert.stock_status <> 'NORMAL'
  )
  select jsonb_build_object(
    'periods', period_metrics.value,
    'paymentsThisMonth', payment_metrics.value,
    'topProductsByRevenue', top_products_revenue.value,
    'topProductsByKg', top_products_kg.value,
    'leastSoldProducts', least_sold_products.value,
    'stockAlerts', alerts.value,
    'generatedAt', now()
  ) into result
  from period_metrics, payment_metrics, top_products_revenue, top_products_kg, least_sold_products, alerts;
  return result;
end;
$$;

commit;
