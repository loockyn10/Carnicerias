begin;

-- Raw materials vs sellable products (Desposte sprint continuation): today every product can be
-- picked as a Desposte input, including finished cuts like "Vacío" or "Costilla". This adds a
-- three-way classification so the input/output selectors can be scoped correctly, without forking
-- the product catalog into two tables (products stays the single catalog table).
create type public.product_inventory_role as enum ('RAW_MATERIAL', 'SELLABLE', 'BOTH');

alter table public.products
  add column inventory_role public.product_inventory_role not null default 'SELLABLE';

comment on column public.products.inventory_role is
  'RAW_MATERIAL: only usable as a Desposte input. SELLABLE: only a catalog/POS product (the default,
   preserving every existing product''s current behavior). BOTH: usable as either.';

-- Any product already used as a Desposte source in this repository keeps working as an input after
-- this migration (BOTH, not RAW_MATERIAL, since we do not know whether it was also being sold
-- directly and must not silently remove an existing capability).
update public.products
set inventory_role = 'BOTH'
where id in (select distinct source_product_id from public.production_batches);

create function public.set_product_inventory_role(p_product_id uuid, p_inventory_role text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  normalized_role public.product_inventory_role;
  updated_id uuid;
begin
  begin
    normalized_role := upper(p_inventory_role)::public.product_inventory_role;
  exception when invalid_text_representation then
    raise exception 'Unsupported inventory role' using errcode = '22023';
  end;

  update public.products
  set inventory_role = normalized_role
  where id = p_product_id and organization_id = current_organization_id
  returning id into updated_id;

  if updated_id is null then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
end;
$$;

-- Central as the default production/reception branch: Central stays a normal commercial branch
-- (see docs/DECISIONS.md D-011 — that decision is about NOT modeling a separate, fictitious
-- deposit; it says nothing about a real, already-existing branch like Central). This is a single
-- org-wide setting, following the same convention as organizations.replenishment_target_days
-- (202609130015): a plain column on organizations, read directly by the client and written
-- through a dedicated RPC.
alter table public.organizations
  add column production_branch_id uuid references public.branches(id) on delete set null;

comment on column public.organizations.production_branch_id is
  'The branch used as the default source/destination for Desposte batches when none is given
   explicitly (normally Central: where raw materials arrive and desposte happens). Nullable: until
   configured, Desposte batch creation is blocked with a clear message instead of guessing one.';

create function public.set_production_branch(p_branch_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('production.write');
  previous_branch_id uuid;
begin
  if p_branch_id is null then
    raise exception 'Debe seleccionar una sucursal' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.branches
    where id = p_branch_id and organization_id = current_organization_id and active
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;

  select production_branch_id into previous_branch_id
  from public.organizations where id = current_organization_id for update;

  update public.organizations
  set production_branch_id = p_branch_id
  where id = current_organization_id;

  perform app_private.write_audit(
    current_organization_id, p_branch_id, 'PRODUCTION_BRANCH_SET', 'organizations', current_organization_id,
    jsonb_build_object('productionBranchId', previous_branch_id), jsonb_build_object('productionBranchId', p_branch_id)
  );
end;
$$;

-- Multiple raw-material units per batch (e.g. "5 medias res de cerdo"): tracking-only, the actual
-- stock/cost math keeps using total input weight exactly as before.
alter table public.production_batches
  add column input_unit_count integer check (input_unit_count is null or input_unit_count > 0);

comment on column public.production_batches.input_unit_count is
  'Optional operational/traceability count of raw-material units received together (e.g. 5 medias
   res). Never used for cost or stock math, which stays based on input_weight_grams.';

-- get_production_catalog (defined in 202609220024): the Desposte input selector must only offer
-- raw-material products, not every WEIGHT product. Same signature, so CREATE OR REPLACE applies.
create or replace function public.get_production_catalog(p_branch_id uuid)
returns table (
  product_id uuid,
  product_name text,
  product_sku text,
  sale_price_per_kg_cents bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
begin
  select b.organization_id into current_organization_id from public.branches b where b.id = p_branch_id and b.active;
  if current_organization_id is null or not app_private.can_access_branch(current_organization_id, p_branch_id, 'production.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  return query
  select p.id, p.name, p.sku, effective_price.price_cents
  from public.products p
  left join lateral (
    select pp.price_cents
    from public.product_prices pp
    where pp.organization_id = p.organization_id
      and pp.product_id = p.id
      and (pp.branch_id = p_branch_id or pp.branch_id is null)
      and pp.valid_from <= now()
      and (pp.valid_to is null or pp.valid_to > now())
    order by (pp.branch_id = p_branch_id) desc nulls last, pp.valid_from desc
    limit 1
  ) effective_price on true
  where p.organization_id = current_organization_id
    and p.active
    and p.unit_type = 'WEIGHT'
    and p.inventory_role in ('RAW_MATERIAL', 'BOTH')
  order by p.name;
end;
$$;

-- create_production_batch (defined in 202609220024): p_branch_id becomes optional (defaults to
-- organizations.production_branch_id) and gains p_input_unit_count. Both are new parameters, so
-- the function's type signature changes; CREATE OR REPLACE cannot do that (it requires an
-- identical argument-type signature), so the old 6-argument version is dropped and replaced here.
-- This migration has not been applied anywhere yet (see docs/CURRENT_STATE.md), so this is not an
-- edit of an already-applied migration — it is new, incremental DDL in a new file.
drop function if exists public.create_production_batch(uuid, uuid, integer, bigint, text, text);

create function public.create_production_batch(
  p_source_product_id uuid,
  p_input_weight_grams integer,
  p_cost_per_kg_cents bigint,
  p_branch_id uuid default null,
  p_input_unit_count integer default null,
  p_description text default null,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('production.write');
  resolved_branch_id uuid := p_branch_id;
  new_batch_id uuid;
  cost_total bigint;
begin
  if resolved_branch_id is null then
    select o.production_branch_id into resolved_branch_id
    from public.organizations o where o.id = current_organization_id;

    if resolved_branch_id is null then
      raise exception 'No hay una sucursal habitual de producción configurada. Configurala antes de crear un desposte.' using errcode = '22023';
    end if;
  end if;

  if not app_private.can_access_branch(current_organization_id, resolved_branch_id, 'production.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if p_input_weight_grams is null or p_input_weight_grams <= 0 then
    raise exception 'El peso de entrada debe ser mayor a cero' using errcode = '22023';
  end if;
  if p_input_unit_count is not null and p_input_unit_count <= 0 then
    raise exception 'La cantidad de unidades debe ser mayor a cero' using errcode = '22023';
  end if;
  if p_cost_per_kg_cents is null or p_cost_per_kg_cents < 0 then
    raise exception 'El costo por kilogramo no puede ser negativo' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) > 200 or char_length(btrim(coalesce(p_notes, ''))) > 1000 then
    raise exception 'La descripción o las notas superan el largo permitido' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.products
    where id = p_source_product_id and organization_id = current_organization_id and active and unit_type = 'WEIGHT'
      and inventory_role in ('RAW_MATERIAL', 'BOTH')
  ) then
    raise exception 'El insumo de origen debe ser un producto activo por peso configurado como materia prima' using errcode = '42501';
  end if;

  cost_total := app_private.round_ratio_half_up(p_cost_per_kg_cents * p_input_weight_grams, 1000);

  insert into public.production_batches (
    organization_id, branch_id, source_product_id, description,
    input_weight_grams, input_unit_count, cost_per_kg_cents, cost_total_cents, status, notes, created_by
  ) values (
    current_organization_id, resolved_branch_id, p_source_product_id, nullif(btrim(p_description), ''),
    p_input_weight_grams, p_input_unit_count, p_cost_per_kg_cents, cost_total, 'DRAFT', nullif(btrim(p_notes), ''), auth.uid()
  ) returning id into new_batch_id;

  perform app_private.write_audit(
    current_organization_id, resolved_branch_id, 'PRODUCTION_BATCH_CREATED', 'production_batches', new_batch_id,
    null, jsonb_build_object('sourceProductId', p_source_product_id, 'inputWeightGrams', p_input_weight_grams, 'costTotalCents', cost_total)
  );

  return new_batch_id;
end;
$$;

-- update_production_batch_header (defined in 202609220024): gains p_input_unit_count. Same
-- reasoning as create_production_batch above: a new parameter changes the signature, so the old
-- 6-argument version is dropped and replaced.
drop function if exists public.update_production_batch_header(uuid, uuid, integer, bigint, text, text);

create function public.update_production_batch_header(
  p_batch_id uuid,
  p_source_product_id uuid,
  p_input_weight_grams integer,
  p_cost_per_kg_cents bigint,
  p_input_unit_count integer default null,
  p_description text default null,
  p_notes text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_batch public.production_batches%rowtype;
  cost_total bigint;
begin
  select * into current_batch from public.production_batches where id = p_batch_id for update;
  if not found then raise exception 'Batch was not found' using errcode = '42501'; end if;
  if not app_private.can_access_branch(current_batch.organization_id, current_batch.branch_id, 'production.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if current_batch.status <> 'DRAFT' then
    raise exception 'Sólo un lote en borrador puede editarse' using errcode = '22023';
  end if;
  if p_input_weight_grams is null or p_input_weight_grams <= 0 then
    raise exception 'El peso de entrada debe ser mayor a cero' using errcode = '22023';
  end if;
  if p_input_unit_count is not null and p_input_unit_count <= 0 then
    raise exception 'La cantidad de unidades debe ser mayor a cero' using errcode = '22023';
  end if;
  if p_cost_per_kg_cents is null or p_cost_per_kg_cents < 0 then
    raise exception 'El costo por kilogramo no puede ser negativo' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) > 200 or char_length(btrim(coalesce(p_notes, ''))) > 1000 then
    raise exception 'La descripción o las notas superan el largo permitido' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.products
    where id = p_source_product_id and organization_id = current_batch.organization_id and active and unit_type = 'WEIGHT'
      and inventory_role in ('RAW_MATERIAL', 'BOTH')
  ) then
    raise exception 'El insumo de origen debe ser un producto activo por peso configurado como materia prima' using errcode = '42501';
  end if;

  cost_total := app_private.round_ratio_half_up(p_cost_per_kg_cents * p_input_weight_grams, 1000);

  update public.production_batches
  set source_product_id = p_source_product_id,
      description = nullif(btrim(p_description), ''),
      input_weight_grams = p_input_weight_grams,
      input_unit_count = p_input_unit_count,
      cost_per_kg_cents = p_cost_per_kg_cents,
      cost_total_cents = cost_total,
      notes = nullif(btrim(p_notes), '')
  where id = p_batch_id;
end;
$$;

-- set_production_batch_output (defined in 202609220024): outputs must be sellable products, not
-- any WEIGHT product. Same signature, so CREATE OR REPLACE applies.
create or replace function public.set_production_batch_output(
  p_batch_id uuid,
  p_product_id uuid,
  p_output_weight_grams integer
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_batch public.production_batches%rowtype;
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
  if not exists (
    select 1 from public.products
    where id = p_product_id and organization_id = current_batch.organization_id and active and unit_type = 'WEIGHT'
      and inventory_role in ('SELLABLE', 'BOTH')
  ) then
    raise exception 'El producto obtenido debe ser un producto activo del catálogo, vendido por peso y configurado como producto de venta' using errcode = '42501';
  end if;

  insert into public.production_batch_outputs (batch_id, organization_id, branch_id, product_id, output_weight_grams)
  values (p_batch_id, current_batch.organization_id, current_batch.branch_id, p_product_id, p_output_weight_grams)
  on conflict (batch_id, product_id) do update
    set output_weight_grams = excluded.output_weight_grams,
        updated_at = now()
  returning id into current_output_id;

  return current_output_id;
end;
$$;

-- New: hard-delete a DRAFT batch (a draft never wrote stock movements, so this can never leave a
-- ledger residue). A COMPLETED batch can never reach here: the status check blocks it, and even if
-- it somehow did, stock_movements.production_batch_id has an ON DELETE RESTRICT foreign key back
-- to production_batches, so the DELETE below would fail loudly instead of silently orphaning
-- history.
create function public.delete_production_batch(p_batch_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_batch public.production_batches%rowtype;
begin
  select * into current_batch from public.production_batches where id = p_batch_id for update;
  if not found then raise exception 'Batch was not found' using errcode = '42501'; end if;
  if not app_private.can_access_branch(current_batch.organization_id, current_batch.branch_id, 'production.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if current_batch.status <> 'DRAFT' then
    raise exception 'Sólo un lote en borrador puede eliminarse' using errcode = '22023';
  end if;

  perform app_private.write_audit(
    current_batch.organization_id, current_batch.branch_id, 'PRODUCTION_BATCH_DELETED', 'production_batches', p_batch_id,
    jsonb_build_object('sourceProductId', current_batch.source_product_id, 'inputWeightGrams', current_batch.input_weight_grams), null
  );

  delete from public.production_batches where id = p_batch_id;
end;
$$;

-- list_production_batches / get_production_batch_detail (defined in 202609220024): surface
-- inputUnitCount. Same signatures, so CREATE OR REPLACE applies to both.
create or replace function public.list_production_batches(
  p_branch_id uuid default null,
  p_status text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('production.read');
  status_filter public.production_batch_status;
  result jsonb;
begin
  if p_status is not null then
    begin
      status_filter := upper(p_status)::public.production_batch_status;
    exception when invalid_text_representation then
      raise exception 'Unsupported batch status' using errcode = '22023';
    end;
  end if;
  if p_limit is null then p_limit := 50; end if;
  if p_limit <= 0 or p_limit > 200 then
    raise exception 'Limit must be between 1 and 200' using errcode = '22023';
  end if;

  with scoped as (
    select b.*
    from public.production_batches b
    where b.organization_id = current_organization_id
      and app_private.can_access_branch(current_organization_id, b.branch_id, 'production.read')
      and (p_branch_id is null or b.branch_id = p_branch_id)
      and (status_filter is null or b.status = status_filter)
  ), with_produced as (
    select scoped.*,
      coalesce(scoped.produced_weight_grams, (
        select sum(o.output_weight_grams)::integer from public.production_batch_outputs o where o.batch_id = scoped.id
      ), 0) as live_produced_weight_grams
    from scoped
  ), limited as (
    select * from with_produced order by created_at desc limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', batch.id,
    'branchId', batch.branch_id,
    'branchName', branch.name,
    'sourceProductId', batch.source_product_id,
    'sourceProductName', product.name,
    'status', batch.status,
    'createdAt', batch.created_at,
    'completedAt', batch.completed_at,
    'inputWeightGrams', batch.input_weight_grams,
    'inputUnitCount', batch.input_unit_count,
    'producedWeightGrams', batch.live_produced_weight_grams,
    'wasteGrams', batch.input_weight_grams - batch.live_produced_weight_grams,
    'yieldBps', case when batch.input_weight_grams > 0
      then app_private.round_ratio_half_up(batch.live_produced_weight_grams * 10000, batch.input_weight_grams) end,
    'costTotalCents', batch.cost_total_cents,
    'totalSaleValueCents', batch.total_sale_value_cents
  ) order by batch.created_at desc), '[]'::jsonb)
  into result
  from limited batch
  join public.branches branch on branch.id = batch.branch_id and branch.organization_id = batch.organization_id
  join public.products product on product.id = batch.source_product_id and product.organization_id = batch.organization_id;

  return result;
end;
$$;

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
      'salePricePerKgCents', o.sale_price_per_kg_cents_snapshot,
      'saleValueCents', o.sale_value_cents_snapshot,
      'allocatedCostCents', o.allocated_cost_cents_snapshot,
      'allocatedCostPerKgCents', app_private.round_ratio_half_up(o.allocated_cost_cents_snapshot * 1000, o.output_weight_grams),
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
        'salePricePerKgCents', preview.sale_price_per_kg_cents,
        'saleValueCents', preview.sale_value_cents,
        'allocatedCostCents', preview.allocated_cost_cents,
        'allocatedCostPerKgCents', preview.allocated_cost_per_kg_cents,
        'isSnapshot', false
      ) order by preview.product_name), '[]'::jsonb),
      coalesce(sum(preview.output_weight_grams), 0),
      sum(preview.sale_value_cents)::bigint
    into outputs_json, produced_weight, total_sale_value
    from app_private.compute_production_preview(p_batch_id) preview;

    select preview.product_name into missing_product
    from app_private.compute_production_preview(p_batch_id) preview
    where preview.sale_price_per_kg_cents is null
    limit 1;

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
    'canFinalize', current_batch.status = 'DRAFT' and produced_weight > 0
      and produced_weight <= current_batch.input_weight_grams and missing_product is null,
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
  public.set_product_inventory_role(uuid, text),
  public.set_production_branch(uuid),
  public.delete_production_batch(uuid)
from public, anon;

grant execute on function
  public.set_product_inventory_role(uuid, text),
  public.set_production_branch(uuid),
  public.delete_production_batch(uuid)
to authenticated;

revoke all on function
  public.get_production_catalog(uuid),
  public.create_production_batch(uuid, integer, bigint, uuid, integer, text, text),
  public.update_production_batch_header(uuid, uuid, integer, bigint, integer, text, text),
  public.set_production_batch_output(uuid, uuid, integer),
  public.list_production_batches(uuid, text, integer),
  public.get_production_batch_detail(uuid)
from public, anon;

grant execute on function
  public.get_production_catalog(uuid),
  public.create_production_batch(uuid, integer, bigint, uuid, integer, text, text),
  public.update_production_batch_header(uuid, uuid, integer, bigint, integer, text, text),
  public.set_production_batch_output(uuid, uuid, integer),
  public.list_production_batches(uuid, text, integer),
  public.get_production_batch_detail(uuid)
to authenticated;

commit;
