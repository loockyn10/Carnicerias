begin;

-- D-061: pricing flexible del POS de Central.
--
--   1. Precio manual por línea: el operador fija el precio (por kg o por unidad) de UNA línea de UNA venta.
--      No modifica product_prices ni el catálogo. Es la decisión final de esa línea: no recibe promoción, pack,
--      recargo por tarjeta ni ajuste por medio de pago. Queda como snapshot auditable en sale_items:
--      original_price_per_kg_cents (precio normal), manual_unit_price_cents (cobrado), manual_adjustment_cents
--      (diferencia de la línea) y price_per_kg_cents/final_price_per_kg_cents = el precio manual.
--   2. Descuento general del ticket: un porcentaje libre (0-100, hasta 2 decimales) sobre la suma FINAL de las
--      líneas. sales.ticket_discount_bps/ticket_discount_cents lo dejan registrado; sales.total_cents y el pago son
--      lo realmente cobrado (suma de líneas menos el descuento). Para que Rentabilidad atribuya el ingreso real
--      a cada producto, el descuento se reparte entre las líneas por mayor resto
--      (sale_items.ticket_discount_cents, suma exacta) y el ingreso de una línea es subtotal - ese reparto.
--   3. Sólo en la sucursal productiva de la organización (organizations.production_branch_id): el servidor
--      rechaza una venta con cualquiera de las dos cosas en cualquier otra sucursal.
--
-- Migración incremental: columnas nuevas con default (una venta anterior queda sin precio manual y sin
-- descuento general, exactamente lo que era), una función auxiliar nueva y `create or replace` de las
-- funciones cuya lógica cambia (cuerpos derivados de 202609250036 / 202609230034 / 202610020057, ver cada
-- bloque). complete_discounted_sale (RPC online del POS web de desarrollo) no cambia: Central opera con el POS de
-- escritorio, que siempre confirma por SQLite y sincroniza con sync_offline_sale.

alter table public.sales
  add column ticket_discount_bps integer not null default 0 check (ticket_discount_bps between 0 and 10000),
  add column ticket_discount_cents bigint not null default 0 check (ticket_discount_cents >= 0),
  add constraint sales_ticket_discount_consistent check (ticket_discount_bps > 0 or ticket_discount_cents = 0);

alter table public.sale_items
  add column manual_price_applied boolean not null default false,
  add column manual_unit_price_cents bigint,
  add column manual_adjustment_cents bigint not null default 0,
  add column ticket_discount_cents bigint not null default 0 check (ticket_discount_cents >= 0),
  add constraint sale_items_manual_price_consistent check (
    (manual_price_applied
      and manual_unit_price_cents is not null and manual_unit_price_cents > 0
      and manual_unit_price_cents = price_per_kg_cents
      and promotion_mode is null and discount_rule_id is null
      and promotion_discount_cents = 0 and card_surcharge_cents = 0 and discount_cents = 0)
    or (not manual_price_applied and manual_unit_price_cents is null and manual_adjustment_cents = 0)
  ),
  add constraint sale_items_ticket_discount_within_subtotal check (ticket_discount_cents <= subtotal_cents);

comment on column public.sale_items.manual_price_applied is
  'D-061: el operador fijó el precio de esta línea en esta venta (sólo POS de Central). price_per_kg_cents es ese precio y original_price_per_kg_cents el precio normal del catálogo.';
comment on column public.sale_items.manual_adjustment_cents is
  'D-061: subtotal cobrado menos lo que habría costado a precio normal (negativo = rebaja). 0 si no hay precio manual.';
comment on column public.sale_items.ticket_discount_cents is
  'D-061: parte del descuento general del ticket atribuida a esta línea (reparto por mayor resto, suma exacta = sales.ticket_discount_cents). Ingreso de la línea = subtotal_cents - ticket_discount_cents.';
comment on column public.sales.ticket_discount_bps is
  'D-061: descuento general del ticket en basis points (0 = sin descuento). sales.total_cents ya lo descuenta.';
comment on column public.sales.ticket_discount_cents is
  'D-061: importe descontado del ticket; suma de las líneas = total_cents + ticket_discount_cents.';

-- ---------------------------------------------------------------------------------------------
-- Reparto del descuento general entre las líneas de la venta (mayor resto; empate: la línea de menor
-- posición en el ticket). Espeja allocateTicketDiscount de packages/business-logic. Es el único lugar que
-- escribe sale_items.ticket_discount_cents.
-- ---------------------------------------------------------------------------------------------
create function app_private.allocate_ticket_discount(p_sale_id uuid, p_item_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  discount bigint;
  items_total numeric;
  covered integer;
  allocated bigint;
begin
  select s.ticket_discount_cents into discount from public.sales s where s.id = p_sale_id;
  if discount is null or discount = 0 then return; end if;
  select sum(i.subtotal_cents), count(*) into items_total, covered
  from public.sale_items i where i.sale_id = p_sale_id;
  if discount > items_total or covered <> coalesce(array_length(p_item_ids, 1), 0) then
    raise exception 'Ticket discount cannot be allocated' using errcode = '22023';
  end if;

  with src as (
    select i.id, o.pos, i.subtotal_cents
    from public.sale_items i
    join unnest(p_item_ids) with ordinality as o(id, pos) on o.id = i.id
    where i.sale_id = p_sale_id
  ), calc as (
    select id, pos,
      div(discount::numeric * subtotal_cents, items_total)::bigint as share,
      mod(discount::numeric * subtotal_cents, items_total) as remainder
    from src
  ), ranked as (
    select id, share,
      row_number() over (order by remainder desc, pos asc) as rk,
      discount - sum(share) over () as leftover
    from calc
  )
  update public.sale_items i
  set ticket_discount_cents = r.share + case when r.rk <= r.leftover then 1 else 0 end
  from ranked r
  where i.id = r.id;

  select sum(i.ticket_discount_cents) into allocated from public.sale_items i where i.sale_id = p_sale_id;
  if allocated <> discount then
    raise exception 'Ticket discount allocation does not add up' using errcode = '22023';
  end if;
end;
$$;

revoke all on function app_private.allocate_ticket_discount(uuid, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- app_private.sync_offline_sale_core: cuerpo de 202609250036 (sync_offline_sale, renombrada a *_core en 202610010050)
-- más el precio manual por línea, el descuento general del ticket y el gate de sucursal productiva (D-061).
-- Misma firma: el wrapper público (Mercado Pago, 202610020052) y sync_pos_operator_offline_sale (identidad del
-- operador y de su dispositivo/sucursal) la siguen llamando sin cambios.
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.sync_offline_sale_core(p_device_id uuid, p_event_id uuid, p_payload jsonb)
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
  -- D-061: precio manual por línea y descuento general del ticket (sólo POS de Central).
  manual_applied boolean; manual_price bigint; manual_adjustment bigint;
  discount_bps integer := 0; declared_discount bigint := 0; expected_discount bigint; net_total bigint;
  ordered_item_ids uuid[];
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
  -- D-061: el precio manual y el descuento general sólo existen en la sucursal productiva de la organización
  -- (organizations.production_branch_id, la misma que decide `get_pos_device_capabilities`: nunca el nombre).
  -- El POS ya lo bloquea, pero el servidor no confía en el POS: una venta de cualquier otra sucursal que traiga
  -- cualquiera de estas claves se rechaza entera (sin recibo, sin venta, sin movimientos).
  if p_payload ? 'ticketDiscountBps' or p_payload ? 'ticketDiscountCents' or p_payload ? 'subtotalCents'
     or exists (
       select 1 from jsonb_array_elements(p_payload->'items') as candidate(value)
       where candidate.value ? 'manualPriceApplied' or candidate.value ? 'manualUnitPriceCents' or candidate.value ? 'manualAdjustmentCents'
     ) then
    if not exists (select 1 from public.organizations o where o.id = org_id and o.production_branch_id = branch_uuid) then
      raise exception 'FLEXIBLE_PRICING_NOT_ALLOWED' using errcode = '42501',
        hint = 'El precio manual y el descuento general sólo están habilitados en el POS de Central.';
    end if;
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
      manual_applied := coalesce((item->>'manualPriceApplied')::boolean, false);
      manual_price := nullif(item->>'manualUnitPriceCents', '')::bigint;
      manual_adjustment := nullif(item->>'manualAdjustmentCents', '')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale item snapshot is malformed' using errcode = '22023'; end;
    -- D-044: only DEBIT/CREDIT may carry a nonzero bps now (the surcharge); CASH/TRANSFER/OTHER
    -- must not (they get no adjustment at all).
    if list_price <= 0 or final_price <= 0 or cash_bps not between 0 and 9999
       or (app_private.payment_method_receives_discount(method) and cash_bps <> 0)
       or cash_discount <> 0 then
      raise exception 'Offline sale item values are invalid' using errcode = '22023';
    end if;
    -- Línea con precio manual: el precio fijado ES el precio final (pricePerKgCents). No lleva promoción, pack,
    -- recargo por tarjeta ni ningún ajuste por medio de pago, y su aritmética se valida más abajo contra
    -- precio * cantidad y contra el precio original (lista) que quedó como snapshot.
    if manual_applied then
      if manual_price is null or manual_adjustment is null or manual_price <= 0 or manual_price <> final_price
         or discount_rule is not null or discount_type is not null or discount_value is not null or line_promotion_mode is not null
         or discount_total <> 0 or promo_discount <> 0 or card_surcharge <> 0 or cash_bps <> 0 then
        raise exception 'Offline manual price line is inconsistent' using errcode = '22023';
      end if;
    elsif manual_price is not null or manual_adjustment is not null then
      raise exception 'Offline manual price metadata without a manual price' using errcode = '22023';
    end if;

    if quantity is not null and grams is null then
      -- UNIT line.
      if quantity <= 0 then raise exception 'Offline sale item values are invalid' using errcode = '22023'; end if;
      list_subtotal := list_price * quantity;
      if discount_type is not null or discount_value is not null then
        raise exception 'Offline unit sale discount metadata is inconsistent' using errcode = '22023';
      end if;
      if manual_applied then
        cash_subtotal := subtotal;
        if subtotal <> manual_price * quantity or subtotal <= 0 or manual_adjustment <> subtotal - list_subtotal then
          raise exception 'Offline manual price arithmetic is invalid' using errcode = '22023';
        end if;
      elsif line_promotion_mode = 'PACK_FIXED_TOTAL' then
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
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at,
        manual_price_applied, manual_unit_price_cents, manual_adjustment_cents
      ) values (
        (item->>'id')::uuid, sale_id, org_id, branch_uuid, current_product_id, item->>'productNameSnapshot', quantity, final_price,
        list_price, discount_rule, null, null, final_price, discount_total, cash_bps, 0, card_surcharge,
        promo_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, completed_at,
        manual_applied, manual_price, coalesce(manual_adjustment, 0)
      );
      insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values ((movement->>'id')::uuid, org_id, branch_uuid, current_product_id, 'SALE', -quantity::bigint, sale_id, profile_id, (movement->>'occurredAt')::timestamptz, completed_at);
      computed_total := computed_total + subtotal;
    else
      -- WEIGHT line.
      if grams is null or grams <= 0 then raise exception 'Offline sale item values are invalid' using errcode = '22023'; end if;
      list_subtotal := app_private.round_ratio_half_up(list_price * grams, 1000);

      if manual_applied then
        cash_subtotal := subtotal;
        if subtotal <> app_private.round_ratio_half_up(manual_price * grams, 1000) or subtotal <= 0 or manual_adjustment <> subtotal - list_subtotal then
          raise exception 'Offline manual price arithmetic is invalid' using errcode = '22023';
        end if;
      elsif line_promotion_mode = 'PACK_FIXED_TOTAL' then
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
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at,
        manual_price_applied, manual_unit_price_cents, manual_adjustment_cents
      ) values (
        (item->>'id')::uuid, sale_id, org_id, branch_uuid, current_product_id, item->>'productNameSnapshot', grams, final_price,
        list_price, discount_rule, discount_type, discount_value, final_price, discount_total, cash_bps, 0, card_surcharge,
        promo_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, completed_at,
        manual_applied, manual_price, coalesce(manual_adjustment, 0)
      );
      insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values ((movement->>'id')::uuid, org_id, branch_uuid, current_product_id, 'SALE', -grams::bigint, sale_id, profile_id, (movement->>'occurredAt')::timestamptz, completed_at);
      computed_total := computed_total + subtotal; computed_weight := computed_weight + grams;
    end if;
  end loop;

  -- Descuento general del ticket (D-061): el servidor recalcula el importe con la misma regla que el POS
  -- (porcentaje en basis points sobre la suma final de las líneas, redondeo half-up) y rechaza la venta si lo
  -- declarado no coincide. Lo cobrado (sales.total_cents y el pago) es la suma de las líneas menos ese descuento.
  if (p_payload ? 'ticketDiscountBps') <> (p_payload ? 'ticketDiscountCents') then
    raise exception 'Offline ticket discount needs both its percentage and its amount' using errcode = '22023';
  end if;
  begin
    discount_bps := coalesce(nullif(p_payload->>'ticketDiscountBps', '')::integer, 0);
    declared_discount := coalesce(nullif(p_payload->>'ticketDiscountCents', '')::bigint, 0);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Offline ticket discount is malformed' using errcode = '22023';
  end;
  if p_payload ? 'ticketDiscountBps' and discount_bps not between 1 and 10000 then
    raise exception 'Offline ticket discount percentage is outside 0-100%%' using errcode = '22023';
  end if;
  expected_discount := app_private.round_ratio_half_up(computed_total * discount_bps, 10000);
  if declared_discount <> expected_discount then
    raise exception 'Offline ticket discount does not match its percentage' using errcode = '22023';
  end if;
  if p_payload ? 'subtotalCents' and (p_payload->>'subtotalCents')::bigint <> computed_total then
    raise exception 'Offline ticket subtotal does not match its items' using errcode = '22023';
  end if;
  net_total := computed_total - expected_discount;
  if net_total <= 0 then raise exception 'Offline sale total must be greater than zero' using errcode = '22023'; end if;
  if net_total <> declared_total or computed_weight <> declared_weight or (p_payload->'payment'->>'amountCents')::bigint <> declared_total then
    raise exception 'Offline sale totals do not match its details' using errcode = '22023';
  end if;
  update public.sales set total_cents = net_total, total_weight_grams = computed_weight,
    ticket_discount_bps = discount_bps, ticket_discount_cents = expected_discount where id = sale_id;
  select coalesce(array_agg((e.value->>'id')::uuid order by e.ordinality), '{}'::uuid[]) into ordered_item_ids
  from jsonb_array_elements(p_payload->'items') with ordinality as e(value, ordinality);
  perform app_private.allocate_ticket_discount(sale_id, ordered_item_ids);
  insert into public.payments(id, sale_id, organization_id, branch_id, method, amount_cents, created_at)
  values ((p_payload->'payment'->>'id')::uuid, sale_id, org_id, branch_uuid, method, declared_total, completed_at);
  return jsonb_build_object('saleId', sale_id, 'duplicate', false, 'syncedAt', now());
end;
$$;


-- ---------------------------------------------------------------------------------------------
-- Rentabilidad y dashboard: el ingreso de una línea es lo realmente cobrado (subtotal - descuento general
-- atribuido). Cuerpos de 202609230034 con ese único cambio.
-- ---------------------------------------------------------------------------------------------
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
      (item.subtotal_cents - item.ticket_discount_cents)::bigint as revenue_cents,
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
    select (item.subtotal_cents - item.ticket_discount_cents)::bigint as revenue_cents,
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
      sum(coalesce(si.weight_grams, si.quantity_units))::bigint as grams, sum(si.subtotal_cents - si.ticket_discount_cents)::bigint as gross_cents
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

-- ---------------------------------------------------------------------------------------------
-- Hechos del ticket de WhatsApp (057): el descuento general y la línea con precio manual. Sin esto el ticket de una
-- venta con descuento no cerraría con su total y se rechazaría (TOTAL_MISMATCH).
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.wa_sale_ticket_json(p_sale_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'saleId', s.id,
    'status', s.status,
    'completedAt', s.completed_at,
    'totalCents', s.total_cents,
    'ticketDiscountBps', s.ticket_discount_bps,
    'ticketDiscountCents', s.ticket_discount_cents,
    'organizationName', o.name,
    'branchName', b.name,
    'timezone', o.timezone,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', i.product_name_snapshot,
        'weightGrams', i.weight_grams,
        'quantityUnits', i.quantity_units,
        'unitPriceCents', coalesce(i.manual_unit_price_cents, i.original_price_per_kg_cents),
        'manualPriceApplied', i.manual_price_applied,
        'promotionDiscountCents', i.promotion_discount_cents,
        'cardSurchargeCents', i.card_surcharge_cents,
        'subtotalCents', i.subtotal_cents,
        'promotionMode', i.promotion_mode
      ) order by i.created_at, i.id)
      from public.sale_items i where i.sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', p.method, 'provider', p.provider,
        'verificationStatus', p.verification_status, 'amountCents', p.amount_cents
      ) order by p.created_at, p.id)
      from public.payments p where p.sale_id = s.id
    ), '[]'::jsonb)
  )
  from public.sales s
  join public.organizations o on o.id = s.organization_id
  join public.branches b on b.id = s.branch_id
  where s.id = p_sale_id
$$;

commit;
