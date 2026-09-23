begin;

-- Desposte: support UNIT outputs (e.g. "cabeza entera", "arrollado" sold per unit, not per kg)
-- alongside existing WEIGHT outputs, and feed the cost derived from a completed batch into
-- product_costs automatically. Relative-sale-value cost allocation only ever needs each output's
-- potential sale value in cents (packages/business-logic/src/production.ts,
-- allocateProductionCost) — it was already agnostic to WEIGHT vs UNIT; only the sale-value
-- formula and the per-output "cost per X" derivation differ by kind.
--
-- IMPORTANT: a UNIT output still has real physical weight (e.g. 2 arrollados weigh 2.640 kg), and
-- that weight is required for EVERY output, WEIGHT or UNIT, because merma/rendimiento is a
-- physical balance of the whole batch: input_weight_grams - SUM(output_weight_grams of every
-- output) = waste_grams. That weight never determines a UNIT output's commercial value or cost
-- allocation (that stays unit count × price per unit) — it only feeds the batch's weight balance.
-- Do not confuse it with products.approx_weight_grams (a per-product, purely informational
-- reference, never tied to any specific batch).
--
-- This migration extends the schema/RPCs added in 202609220024/025/026 without editing them (new
-- file, additive/DROP+CREATE only where a signature genuinely changes).

-- Reference-only weight for a UNIT product (e.g. "cabeza entera, aprox 5 kg"). Purely
-- informational: never used for pricing, cost allocation, or any batch's own weight balance
-- (each batch records its own real output_weight_grams instead, see below).
alter table public.products
  add column approx_weight_grams integer check (approx_weight_grams is null or approx_weight_grams > 0);

comment on column public.products.approx_weight_grams is
  'Optional reference weight for a UNIT product (e.g. a whole head, ~5000g). Purely informational:
   never used to price the product, to allocate Desposte cost, or in any batch''s weight balance —
   production_batch_outputs.output_weight_grams (this batch''s own measured weight) is what feeds
   merma/rendimiento, for every output regardless of unit_type.';

-- production_batch_outputs: output_weight_grams stays required for every output (physical weight,
-- feeds merma/rendimiento). output_quantity_units is additional and required only when the output
-- product sells by UNIT (adds the commercial-value/cost-per-unit dimension on top of the weight).
alter table public.production_batch_outputs
  add column output_quantity_units integer check (output_quantity_units is null or output_quantity_units > 0);

comment on column public.production_batch_outputs.output_quantity_units is
  'Unit count obtained, set only when the output product sells by UNIT. Drives commercial value
   (quantity × price per unit) and cost-per-unit. Never replaces output_weight_grams, which every
   output (WEIGHT or UNIT) still records for the batch''s physical merma/rendimiento balance.';

alter table public.production_batch_outputs
  rename column sale_price_per_kg_cents_snapshot to sale_price_cents_snapshot;

comment on column public.production_batch_outputs.sale_price_cents_snapshot is
  'Sale price snapshot used to compute this output''s commercial value at completion time: per kg
   if the output product sells by WEIGHT, per unit if it sells by UNIT (output_quantity_units set).';

comment on column public.production_batch_outputs.allocated_cost_cents_snapshot is
  'Cost assigned to this output by relative sale value (a joint-cost estimate). Never the true
   individual purchase cost of that cut/unit. Also feeds public.product_costs automatically when
   the batch completes (see complete_production_batch below).';

-- Shared allocation engine, extended for UNIT outputs. Dropped and recreated: the RETURNS TABLE
-- column list changes (adds output_quantity_units, allocated_cost_per_unit_cents), which
-- CREATE OR REPLACE cannot do for a set-returning function.
drop function if exists app_private.compute_production_preview(uuid);

create function app_private.compute_production_preview(p_batch_id uuid)
returns table (
  output_id uuid,
  product_id uuid,
  product_name text,
  output_weight_grams integer,
  output_quantity_units integer,
  sale_price_cents bigint,
  sale_value_cents bigint,
  allocated_cost_cents bigint,
  allocated_cost_per_kg_cents bigint,
  allocated_cost_per_unit_cents bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with batch as (
    select b.id, b.organization_id, b.branch_id, b.cost_total_cents
    from public.production_batches b
    where b.id = p_batch_id
  ), priced as (
    select o.id as output_id, o.product_id, p.name as product_name, p.unit_type,
      o.output_weight_grams, o.output_quantity_units,
      effective_price.price_cents as sale_price_cents
    from public.production_batch_outputs o
    cross join batch
    join public.products p on p.id = o.product_id and p.organization_id = batch.organization_id
    left join lateral (
      select pp.price_cents
      from public.product_prices pp
      where pp.organization_id = batch.organization_id
        and pp.product_id = o.product_id
        and (pp.branch_id = batch.branch_id or pp.branch_id is null)
        and pp.valid_from <= now()
        and (pp.valid_to is null or pp.valid_to > now())
      -- Boolean equality is NULL for a global price row (pp.branch_id is null), and PostgreSQL
      -- sorts NULL first on DESC unless told otherwise, which would incorrectly prefer the
      -- global price over a matching branch override (see migration 202609100004, the existing
      -- fix for this exact issue in get_pos_catalog/complete_sale).
      order by (pp.branch_id = batch.branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) effective_price on true
    where o.batch_id = p_batch_id
  ), valued as (
    -- Commercial value: WEIGHT uses weight × price/kg; UNIT uses unit count × price/unit — never
    -- weight, even though every row here also carries a real output_weight_grams (see file header).
    select priced.*,
      case when priced.sale_price_cents is null or priced.sale_price_cents <= 0 then null
        when priced.unit_type = 'WEIGHT' then app_private.round_ratio_half_up(priced.sale_price_cents::bigint * priced.output_weight_grams, 1000)
        else priced.sale_price_cents::bigint * priced.output_quantity_units
      end as sale_value_cents
    from priced
  ), totals as (
    -- PostgreSQL's sum() over a bigint input returns numeric, not bigint (only sum() of
    -- smallint/integer stays within bigint). Cast back explicitly so every downstream column
    -- derived from this value (floor_cents, remainder_cents, leftover_cents,
    -- allocated_cost_cents) stays bigint all the way to the final round_ratio_half_up(bigint,
    -- bigint) call, instead of silently widening to numeric.
    select sum(valued.sale_value_cents)::bigint as total_sale_value_cents,
      bool_and(valued.sale_value_cents is not null) as all_priced
    from valued
  ), shares as (
    select valued.output_id, valued.product_id,
      (batch.cost_total_cents * valued.sale_value_cents) / totals.total_sale_value_cents as floor_cents,
      (batch.cost_total_cents * valued.sale_value_cents) % totals.total_sale_value_cents as remainder_cents
    from valued, batch, totals
    where totals.all_priced and totals.total_sale_value_cents > 0
  ), leftover as (
    select (select batch.cost_total_cents from batch) - coalesce(sum(shares.floor_cents)::bigint, 0) as leftover_cents
    from shares
  ), ranked as (
    select shares.output_id, shares.floor_cents,
      row_number() over (order by shares.remainder_cents desc, shares.product_id asc) as rn
    from shares
  ), allocated as (
    select ranked.output_id,
      ranked.floor_cents + case when ranked.rn <= (select leftover.leftover_cents from leftover) then 1 else 0 end
        as allocated_cost_cents
    from ranked
  )
  -- allocated_cost_per_kg_cents is always computable (every output carries a real weight);
  -- allocated_cost_per_unit_cents only when the output also has a unit count.
  select valued.output_id, valued.product_id, valued.product_name,
    valued.output_weight_grams, valued.output_quantity_units,
    valued.sale_price_cents, valued.sale_value_cents,
    allocated.allocated_cost_cents,
    case when allocated.allocated_cost_cents is null then null
      else app_private.round_ratio_half_up(allocated.allocated_cost_cents * 1000, valued.output_weight_grams)
    end as allocated_cost_per_kg_cents,
    case when allocated.allocated_cost_cents is null or valued.output_quantity_units is null then null
      else app_private.round_ratio_half_up(allocated.allocated_cost_cents, valued.output_quantity_units)
    end as allocated_cost_per_unit_cents
  from valued
  left join allocated on allocated.output_id = valued.output_id
  order by valued.product_name;
$$;

revoke all on function app_private.compute_production_preview(uuid) from public, anon, authenticated;

-- set_production_batch_output: p_output_weight_grams stays required for every output (this
-- batch's real measured weight); p_output_quantity_units is additional, required only when the
-- output product sells by UNIT and rejected when it sells by WEIGHT (to avoid a silently ignored
-- value). Dropped and recreated: a new argument is added, which CREATE OR REPLACE cannot do.
drop function if exists public.set_production_batch_output(uuid, uuid, integer);

create function public.set_production_batch_output(
  p_batch_id uuid,
  p_product_id uuid,
  p_output_weight_grams integer,
  p_output_quantity_units integer default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_batch public.production_batches%rowtype;
  output_product public.products%rowtype;
  current_output_id uuid;
begin
  select * into current_batch from public.production_batches where id = p_batch_id for update;
  if not found then raise exception 'Batch was not found' using errcode = '42501'; end if;
  if not app_private.can_access_branch(current_batch.organization_id, current_batch.branch_id, 'production.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if current_batch.status <> 'DRAFT' then
    raise exception 'Sólo un lote en borrador puede editar sus productos obtenidos' using errcode = '22023';
  end if;
  if p_output_weight_grams is null or p_output_weight_grams <= 0 then
    raise exception 'El peso obtenido debe ser mayor a cero' using errcode = '22023';
  end if;
  if p_output_quantity_units is not null and p_output_quantity_units <= 0 then
    raise exception 'La cantidad de unidades obtenidas debe ser mayor a cero' using errcode = '22023';
  end if;

  select * into output_product from public.products
  where id = p_product_id and organization_id = current_batch.organization_id and active
    and inventory_role in ('SELLABLE', 'BOTH');
  if not found then
    raise exception 'El producto obtenido debe ser un producto activo del catálogo configurado como producto de venta' using errcode = '42501';
  end if;
  if output_product.unit_type = 'UNIT' and p_output_quantity_units is null then
    raise exception 'El producto "%" se vende por unidad: indicá también la cantidad de unidades obtenidas', output_product.name using errcode = '22023';
  end if;
  if output_product.unit_type = 'WEIGHT' and p_output_quantity_units is not null then
    raise exception 'El producto "%" se vende por peso: no corresponde indicar una cantidad de unidades', output_product.name using errcode = '22023';
  end if;

  insert into public.production_batch_outputs (
    batch_id, organization_id, branch_id, product_id, output_weight_grams, output_quantity_units
  )
  values (p_batch_id, current_batch.organization_id, current_batch.branch_id, p_product_id, p_output_weight_grams, p_output_quantity_units)
  on conflict (batch_id, product_id) do update
    set output_weight_grams = excluded.output_weight_grams,
        output_quantity_units = excluded.output_quantity_units,
        updated_at = now()
  returning id into current_output_id;

  return current_output_id;
end;
$$;

-- complete_production_batch (defined in 202609220024, extended for stock in 202609220025): same
-- signature, so CREATE OR REPLACE applies. Changes: (1) produced/waste/yield now sum EVERY
-- output's real output_weight_grams, WEIGHT or UNIT alike (a UNIT output still has physical
-- weight); (2) after freezing the batch snapshot, each output's allocated cost also becomes that
-- product's current product_costs row (org-global, same vigencia pattern as set_product_price),
-- expressed per kg for a WEIGHT product or per unit for a UNIT product — matching how that
-- product's own price is quoted — so Rentabilidad/complete_sale pick it up automatically without
-- any manual "costo" entry for produced products.
create or replace function public.complete_production_batch(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_batch public.production_batches%rowtype;
  produced_weight bigint;
  total_sale_value bigint;
  missing_product text;
  yield_bps bigint;
  gross_margin bigint;
  margin_over_sales_bps bigint;
  profitability_over_cost_bps bigint;
  current_actor uuid := auth.uid();
  batch_completed_at timestamptz := now();
  output_row record;
  cost_row record;
begin
  select * into current_batch from public.production_batches where id = p_batch_id for update;
  if not found then raise exception 'Batch was not found' using errcode = '42501'; end if;
  if not app_private.can_access_branch(current_batch.organization_id, current_batch.branch_id, 'production.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if current_batch.status <> 'DRAFT' then
    raise exception 'Sólo un lote en borrador puede finalizarse' using errcode = '22023';
  end if;

  if not exists (select 1 from public.production_batch_outputs o where o.batch_id = p_batch_id) then
    raise exception 'El lote no tiene productos obtenidos' using errcode = '22023';
  end if;

  -- Every output (WEIGHT or UNIT) has a real weight, so the physical balance always sums all of
  -- them — a UNIT output's weight was never excluded from this, only from commercial value.
  select coalesce(sum(o.output_weight_grams), 0) into produced_weight
  from public.production_batch_outputs o where o.batch_id = p_batch_id;

  if produced_weight > current_batch.input_weight_grams then
    raise exception 'Los productos obtenidos no pueden superar el peso de entrada' using errcode = '22023';
  end if;

  select preview.product_name into missing_product
  from app_private.compute_production_preview(p_batch_id) preview
  where preview.sale_price_cents is null
  limit 1;
  if missing_product is not null then
    raise exception 'El producto "%" no tiene un precio de venta vigente', missing_product using errcode = '22023';
  end if;

  select coalesce(sum(preview.sale_value_cents)::bigint, 0) into total_sale_value
  from app_private.compute_production_preview(p_batch_id) preview;
  if total_sale_value <= 0 then
    raise exception 'No se puede asignar el costo: el valor potencial de venta total es cero' using errcode = '22023';
  end if;

  update public.production_batch_outputs o
  set sale_price_cents_snapshot = preview.sale_price_cents,
      sale_value_cents_snapshot = preview.sale_value_cents,
      allocated_cost_cents_snapshot = preview.allocated_cost_cents
  from app_private.compute_production_preview(p_batch_id) preview
  where preview.output_id = o.id;

  -- Ledger: the full purchased input leaves stock as itself (it is not sellable once desposted),
  -- and each output enters stock at whatever quantity that PRODUCT's own stock is tracked in
  -- (grams for a WEIGHT product, unit count for a UNIT product — same convention already used by
  -- record_stock_operation/replenishment for purchases of UNIT products), never at the batch's
  -- own physical weight for a UNIT output. Waste is the implicit gap between input weight and the
  -- sum of every output's real weight; it never gets its own movement because it is not inventory
  -- for any product.
  insert into public.stock_movements (
    organization_id, branch_id, product_id, type, quantity_grams,
    production_batch_id, profile_id, occurred_at, created_at
  ) values (
    current_batch.organization_id, current_batch.branch_id, current_batch.source_product_id,
    'PRODUCTION_CONSUME', -current_batch.input_weight_grams::bigint,
    p_batch_id, current_actor, batch_completed_at, batch_completed_at
  );

  for output_row in
    select o.product_id, o.output_weight_grams, o.output_quantity_units
    from public.production_batch_outputs o
    where o.batch_id = p_batch_id
  loop
    insert into public.stock_movements (
      organization_id, branch_id, product_id, type, quantity_grams,
      production_batch_id, profile_id, occurred_at, created_at
    ) values (
      current_batch.organization_id, current_batch.branch_id, output_row.product_id,
      'PRODUCTION_YIELD', coalesce(output_row.output_quantity_units, output_row.output_weight_grams)::bigint,
      p_batch_id, current_actor, batch_completed_at, batch_completed_at
    );
  end loop;

  -- Feed the derived cost into product_costs (org-global, same vigencia convention as
  -- set_product_price/save_product_pricing) so it becomes the new current cost for each output
  -- product, without touching product_prices (the price stays a manual, separate decision).
  -- Expressed per kg or per unit matching the OUTPUT PRODUCT's own unit_type (not merely whether a
  -- unit count happens to be set), since that is how that product's cost is always quoted.
  for cost_row in
    select o.product_id,
      case when p.unit_type = 'UNIT'
        then app_private.round_ratio_half_up(o.allocated_cost_cents_snapshot, o.output_quantity_units)
        else app_private.round_ratio_half_up(o.allocated_cost_cents_snapshot * 1000, o.output_weight_grams)
      end as cost_cents
    from public.production_batch_outputs o
    join public.products p on p.id = o.product_id and p.organization_id = o.organization_id
    where o.batch_id = p_batch_id
  loop
    update public.product_costs
    set valid_to = batch_completed_at
    where organization_id = current_batch.organization_id
      and product_id = cost_row.product_id
      and valid_from < batch_completed_at
      and (valid_to is null or valid_to > batch_completed_at);

    insert into public.product_costs (organization_id, product_id, cost_cents, valid_from, created_by)
    values (current_batch.organization_id, cost_row.product_id, cost_row.cost_cents, batch_completed_at, current_actor);
  end loop;

  yield_bps := case when current_batch.input_weight_grams > 0
    then app_private.round_ratio_half_up(produced_weight * 10000, current_batch.input_weight_grams) end;
  gross_margin := total_sale_value - current_batch.cost_total_cents;
  margin_over_sales_bps := (case when gross_margin < 0 then -1 else 1 end)
    * app_private.round_ratio_half_up(abs(gross_margin) * 10000, total_sale_value);
  profitability_over_cost_bps := case when current_batch.cost_total_cents > 0 then
    (case when gross_margin < 0 then -1 else 1 end) * app_private.round_ratio_half_up(abs(gross_margin) * 10000, current_batch.cost_total_cents)
  end;

  update public.production_batches
  set status = 'COMPLETED',
      completed_by = current_actor,
      completed_at = batch_completed_at,
      produced_weight_grams = produced_weight,
      waste_grams = current_batch.input_weight_grams - produced_weight,
      total_sale_value_cents = total_sale_value
  where id = p_batch_id;

  perform app_private.write_audit(
    current_batch.organization_id, current_batch.branch_id, 'PRODUCTION_BATCH_COMPLETED', 'production_batches', p_batch_id,
    jsonb_build_object('status', 'DRAFT'),
    jsonb_build_object('status', 'COMPLETED', 'producedWeightGrams', produced_weight, 'totalSaleValueCents', total_sale_value)
  );

  return jsonb_build_object(
    'batchId', p_batch_id,
    'producedWeightGrams', produced_weight,
    'wasteGrams', current_batch.input_weight_grams - produced_weight,
    'yieldBps', yield_bps,
    'totalSaleValueCents', total_sale_value,
    'grossMarginCents', gross_margin,
    'marginOverSalesBps', margin_over_sales_bps,
    'profitabilityOverCostBps', profitability_over_cost_bps
  );
end;
$$;

-- get_production_batch_detail (defined in 202609220024, extended in 202609220026): outputs now
-- surface the unit count when present, and "cost per kg" is always computable (every output has a
-- real weight) while "cost per unit" stays conditional on a unit count. Same signature, so
-- CREATE OR REPLACE applies.
create or replace function public.get_production_batch_detail(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_batch record;
  outputs_json jsonb;
  summary_json jsonb;
  produced_weight bigint;
  waste bigint;
  yield_bps bigint;
  waste_bps bigint;
  avg_cost_per_kg bigint;
  total_sale_value bigint;
  gross_margin bigint;
  margin_over_sales_bps bigint;
  profitability_over_cost_bps bigint;
  missing_product text;
begin
  select b.*, sp.name as source_product_name, br.name as branch_name,
    creator.display_name as created_by_name,
    completer.display_name as completed_by_name,
    canceller.display_name as cancelled_by_name
  into current_batch
  from public.production_batches b
  join public.products sp on sp.id = b.source_product_id and sp.organization_id = b.organization_id
  join public.branches br on br.id = b.branch_id and br.organization_id = b.organization_id
  left join public.profiles creator on creator.id = b.created_by
  left join public.profiles completer on completer.id = b.completed_by
  left join public.profiles canceller on canceller.id = b.cancelled_by
  where b.id = p_batch_id;

  if not found then raise exception 'Batch was not found' using errcode = '42501'; end if;
  if not app_private.can_access_branch(current_batch.organization_id, current_batch.branch_id, 'production.read') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  if current_batch.status = 'COMPLETED' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'productId', o.product_id, 'productName', p.name,
      'outputWeightGrams', o.output_weight_grams,
      'outputQuantityUnits', o.output_quantity_units,
      'salePriceCents', o.sale_price_cents_snapshot,
      'saleValueCents', o.sale_value_cents_snapshot,
      'allocatedCostCents', o.allocated_cost_cents_snapshot,
      'allocatedCostPerKgCents', app_private.round_ratio_half_up(o.allocated_cost_cents_snapshot * 1000, o.output_weight_grams),
      'allocatedCostPerUnitCents', case when o.output_quantity_units is not null
        then app_private.round_ratio_half_up(o.allocated_cost_cents_snapshot, o.output_quantity_units) end,
      'isSnapshot', true
    ) order by p.name), '[]'::jsonb)
    into outputs_json
    from public.production_batch_outputs o
    join public.products p on p.id = o.product_id and p.organization_id = o.organization_id
    where o.batch_id = p_batch_id;

    produced_weight := current_batch.produced_weight_grams;
    total_sale_value := current_batch.total_sale_value_cents;
  else
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', preview.output_id, 'productId', preview.product_id, 'productName', preview.product_name,
        'outputWeightGrams', preview.output_weight_grams,
        'outputQuantityUnits', preview.output_quantity_units,
        'salePriceCents', preview.sale_price_cents,
        'saleValueCents', preview.sale_value_cents,
        'allocatedCostCents', preview.allocated_cost_cents,
        'allocatedCostPerKgCents', preview.allocated_cost_per_kg_cents,
        'allocatedCostPerUnitCents', preview.allocated_cost_per_unit_cents,
        'isSnapshot', false
      ) order by preview.product_name), '[]'::jsonb),
      coalesce(sum(preview.output_weight_grams), 0),
      sum(preview.sale_value_cents)::bigint
    into outputs_json, produced_weight, total_sale_value
    from app_private.compute_production_preview(p_batch_id) preview;

    select preview.product_name into missing_product
    from app_private.compute_production_preview(p_batch_id) preview
    where preview.sale_price_cents is null
    limit 1;

    -- Until every output has a price, totalSaleValueCents must not become a partial sum that
    -- silently drops the unpriced output(s); every sale-value-dependent figure stays unknown
    -- (null) rather than misleadingly small.
    if missing_product is not null then
      total_sale_value := null;
    end if;
  end if;

  waste := current_batch.input_weight_grams - produced_weight;
  yield_bps := case when current_batch.input_weight_grams > 0
    then app_private.round_ratio_half_up(produced_weight * 10000, current_batch.input_weight_grams) end;
  waste_bps := case when yield_bps is null then null else 10000 - yield_bps end;
  avg_cost_per_kg := case when produced_weight > 0
    then app_private.round_ratio_half_up(current_batch.cost_total_cents * 1000, produced_weight) end;

  if total_sale_value is not null then
    gross_margin := total_sale_value - current_batch.cost_total_cents;
    margin_over_sales_bps := case when total_sale_value > 0
      then (case when gross_margin < 0 then -1 else 1 end) * app_private.round_ratio_half_up(abs(gross_margin) * 10000, total_sale_value) end;
    profitability_over_cost_bps := case when current_batch.cost_total_cents > 0
      then (case when gross_margin < 0 then -1 else 1 end) * app_private.round_ratio_half_up(abs(gross_margin) * 10000, current_batch.cost_total_cents) end;
  else
    gross_margin := null;
    margin_over_sales_bps := null;
    profitability_over_cost_bps := null;
  end if;

  summary_json := jsonb_build_object(
    'producedWeightGrams', produced_weight,
    'wasteGrams', waste,
    'yieldBps', yield_bps,
    'wastePercentageBps', waste_bps,
    'averageCostPerKgCents', avg_cost_per_kg,
    'totalSaleValueCents', total_sale_value,
    'grossMarginCents', gross_margin,
    'marginOverSalesBps', margin_over_sales_bps,
    'profitabilityOverCostBps', profitability_over_cost_bps,
    'canFinalize', current_batch.status = 'DRAFT' and produced_weight <= current_batch.input_weight_grams
      and missing_product is null and exists (select 1 from public.production_batch_outputs where batch_id = p_batch_id),
    'missingPriceProductName', missing_product
  );

  return jsonb_build_object(
    'batch', jsonb_build_object(
      'id', current_batch.id, 'branchId', current_batch.branch_id, 'branchName', current_batch.branch_name,
      'sourceProductId', current_batch.source_product_id, 'sourceProductName', current_batch.source_product_name,
      'description', current_batch.description, 'inputWeightGrams', current_batch.input_weight_grams,
      'inputUnitCount', current_batch.input_unit_count,
      'costPerKgCents', current_batch.cost_per_kg_cents, 'costTotalCents', current_batch.cost_total_cents,
      'status', current_batch.status, 'notes', current_batch.notes,
      'createdAt', current_batch.created_at, 'createdByName', coalesce(current_batch.created_by_name, current_batch.created_by::text),
      'completedAt', current_batch.completed_at, 'completedByName', current_batch.completed_by_name,
      'cancelledAt', current_batch.cancelled_at, 'cancelledByName', current_batch.cancelled_by_name
    ),
    'outputs', outputs_json,
    'summary', summary_json
  );
end;
$$;

revoke all on function
  public.set_production_batch_output(uuid, uuid, integer, integer)
from public, anon;

grant execute on function
  public.set_production_batch_output(uuid, uuid, integer, integer)
to authenticated;

commit;
