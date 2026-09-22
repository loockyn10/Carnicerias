begin;

-- Desposte / Producción: registers the transformation of a purchased input (e.g. a media res)
-- into multiple catalog products plus waste, and reports yield/profitability. Modeled with
-- generic production_batches/production_batch_outputs names because the same shape works for
-- any input, not only pork. This migration defines the batch/output tables and draft-editing
-- RPCs; the follow-up migration 202609220025 wires completion into the existing stock_movements
-- ledger (this repository already has one) and replaces complete_production_batch accordingly.

create type public.production_batch_status as enum ('DRAFT', 'COMPLETED', 'CANCELLED');

create table public.production_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  source_product_id uuid not null,
  description text check (description is null or char_length(btrim(description)) between 1 and 200),
  input_weight_grams integer not null check (input_weight_grams > 0),
  cost_per_kg_cents bigint not null check (cost_per_kg_cents >= 0),
  cost_total_cents bigint not null check (cost_total_cents >= 0),
  status public.production_batch_status not null default 'DRAFT',
  notes text check (notes is null or char_length(btrim(notes)) between 1 and 1000),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_by uuid references public.profiles(id) on delete restrict,
  completed_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  cancelled_at timestamptz,
  -- Snapshots filled atomically once, by complete_production_batch. A completed batch is
  -- historical and must never be silently recomputed with today's prices or weights.
  produced_weight_grams integer,
  waste_grams integer,
  total_sale_value_cents bigint,
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  foreign key (source_product_id, organization_id) references public.products(id, organization_id) on delete restrict,
  unique (id, organization_id, branch_id),
  check (
    (status = 'DRAFT' and completed_at is null and completed_by is null and cancelled_at is null and cancelled_by is null
      and produced_weight_grams is null and waste_grams is null and total_sale_value_cents is null)
    or (status = 'COMPLETED' and completed_at is not null and completed_by is not null and cancelled_at is null and cancelled_by is null
      and produced_weight_grams is not null and waste_grams is not null and total_sale_value_cents is not null)
    or (status = 'CANCELLED' and cancelled_at is not null and cancelled_by is not null and completed_at is null and completed_by is null
      and produced_weight_grams is null and waste_grams is null and total_sale_value_cents is null)
  )
);

comment on table public.production_batches is
  'Desposte/production batches: one purchased weighed input transformed into catalog outputs plus waste. Completed rows are historical and immutable; correcting one later needs a reversal/adjustment flow, not implemented yet.';

create table public.production_batch_outputs (
  id uuid primary key default extensions.gen_random_uuid(),
  batch_id uuid not null,
  organization_id uuid not null,
  branch_id uuid not null,
  product_id uuid not null,
  output_weight_grams integer not null check (output_weight_grams > 0),
  -- Filled together, atomically, only when the parent batch is completed.
  sale_price_per_kg_cents_snapshot bigint check (sale_price_per_kg_cents_snapshot > 0),
  sale_value_cents_snapshot bigint check (sale_value_cents_snapshot >= 0),
  allocated_cost_cents_snapshot bigint check (allocated_cost_cents_snapshot >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (batch_id, organization_id, branch_id)
    references public.production_batches(id, organization_id, branch_id) on delete cascade,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict,
  unique (batch_id, product_id),
  check (
    (sale_price_per_kg_cents_snapshot is null and sale_value_cents_snapshot is null and allocated_cost_cents_snapshot is null)
    or (sale_price_per_kg_cents_snapshot is not null and sale_value_cents_snapshot is not null and allocated_cost_cents_snapshot is not null)
  )
);

comment on column public.production_batch_outputs.allocated_cost_cents_snapshot is
  'Cost assigned to this output by relative sale value (a joint-cost estimate). Never the true individual purchase cost of that cut.';

create index production_batches_branch_created_idx
  on public.production_batches (organization_id, branch_id, created_at desc);
create index production_batches_source_product_idx
  on public.production_batches (organization_id, source_product_id, status, completed_at desc);
create index production_batch_outputs_batch_idx on public.production_batch_outputs (batch_id);
create index production_batch_outputs_product_idx on public.production_batch_outputs (organization_id, product_id);

create trigger production_batches_set_updated_at before update on public.production_batches
for each row execute function app_private.set_updated_at();
create trigger production_batch_outputs_set_updated_at before update on public.production_batch_outputs
for each row execute function app_private.set_updated_at();

insert into public.permissions (key, description) values
  ('production.read', 'Read production/desposte batches and their outputs'),
  ('production.write', 'Create, edit, finalize and cancel production/desposte batches')
on conflict (key) do nothing;

-- Admin-only, matching the settlements.*/analytics.read pattern: production costs, allocated
-- cost and margins are administrative information, never granted to the employee role.
insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-4000-8000-000000000001', 'production.read'),
  ('10000000-0000-4000-8000-000000000001', 'production.write')
on conflict (role_id, permission_key) do nothing;

-- Shared allocation engine: computes, from CURRENT prices, the same relative-sale-value
-- allocation implemented in TypeScript (packages/business-logic/src/production.ts), using the
-- same largest-remainder technique so allocated costs always sum exactly to the batch cost.
-- Used both for the live preview shown while a batch is a draft and, unchanged, to compute the
-- values that complete_production_batch freezes as snapshots.
create function app_private.compute_production_preview(p_batch_id uuid)
returns table (
  output_id uuid,
  product_id uuid,
  product_name text,
  output_weight_grams integer,
  sale_price_per_kg_cents bigint,
  sale_value_cents bigint,
  allocated_cost_cents bigint,
  allocated_cost_per_kg_cents bigint
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
    select o.id as output_id, o.product_id, o.output_weight_grams, p.name as product_name,
      effective_price.price_cents as sale_price_per_kg_cents
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
      order by (pp.branch_id = batch.branch_id) desc, pp.valid_from desc
      limit 1
    ) effective_price on true
    where o.batch_id = p_batch_id
  ), valued as (
    select priced.*,
      case when priced.sale_price_per_kg_cents is null or priced.sale_price_per_kg_cents <= 0 then null
        else app_private.round_ratio_half_up(priced.sale_price_per_kg_cents::bigint * priced.output_weight_grams, 1000)
      end as sale_value_cents
    from priced
  ), totals as (
    select sum(valued.sale_value_cents) as total_sale_value_cents,
      bool_and(valued.sale_value_cents is not null) as all_priced
    from valued
  ), shares as (
    select valued.output_id, valued.product_id,
      (batch.cost_total_cents * valued.sale_value_cents) / totals.total_sale_value_cents as floor_cents,
      (batch.cost_total_cents * valued.sale_value_cents) % totals.total_sale_value_cents as remainder_cents
    from valued, batch, totals
    where totals.all_priced and totals.total_sale_value_cents > 0
  ), leftover as (
    select batch.cost_total_cents - coalesce(sum(shares.floor_cents), 0) as leftover_cents
    from batch left join shares on true
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
  select valued.output_id, valued.product_id, valued.product_name, valued.output_weight_grams,
    valued.sale_price_per_kg_cents, valued.sale_value_cents,
    allocated.allocated_cost_cents,
    case when allocated.allocated_cost_cents is null then null
      else app_private.round_ratio_half_up(allocated.allocated_cost_cents * 1000, valued.output_weight_grams)
    end as allocated_cost_per_kg_cents
  from valued
  left join allocated on allocated.output_id = valued.output_id
  order by valued.product_name;
$$;

create function public.get_production_catalog(p_branch_id uuid)
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
    order by (pp.branch_id = p_branch_id) desc, pp.valid_from desc
    limit 1
  ) effective_price on true
  where p.organization_id = current_organization_id
    and p.active
    and p.unit_type = 'WEIGHT'
  order by p.name;
end;
$$;

create function public.create_production_batch(
  p_branch_id uuid,
  p_source_product_id uuid,
  p_input_weight_grams integer,
  p_cost_per_kg_cents bigint,
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
  current_organization_id uuid;
  new_batch_id uuid;
  cost_total bigint;
begin
  select b.organization_id into current_organization_id from public.branches b where b.id = p_branch_id and b.active;
  if current_organization_id is null or not app_private.can_access_branch(current_organization_id, p_branch_id, 'production.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if p_input_weight_grams is null or p_input_weight_grams <= 0 then
    raise exception 'El peso de entrada debe ser mayor a cero' using errcode = '22023';
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
  ) then
    raise exception 'El insumo de origen debe ser un producto activo vendido por peso' using errcode = '42501';
  end if;

  cost_total := app_private.round_ratio_half_up(p_cost_per_kg_cents * p_input_weight_grams, 1000);

  insert into public.production_batches (
    organization_id, branch_id, source_product_id, description,
    input_weight_grams, cost_per_kg_cents, cost_total_cents, status, notes, created_by
  ) values (
    current_organization_id, p_branch_id, p_source_product_id, nullif(btrim(p_description), ''),
    p_input_weight_grams, p_cost_per_kg_cents, cost_total, 'DRAFT', nullif(btrim(p_notes), ''), auth.uid()
  ) returning id into new_batch_id;

  perform app_private.write_audit(
    current_organization_id, p_branch_id, 'PRODUCTION_BATCH_CREATED', 'production_batches', new_batch_id,
    null, jsonb_build_object('sourceProductId', p_source_product_id, 'inputWeightGrams', p_input_weight_grams, 'costTotalCents', cost_total)
  );

  return new_batch_id;
end;
$$;

create function public.update_production_batch_header(
  p_batch_id uuid,
  p_source_product_id uuid,
  p_input_weight_grams integer,
  p_cost_per_kg_cents bigint,
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
  if p_cost_per_kg_cents is null or p_cost_per_kg_cents < 0 then
    raise exception 'El costo por kilogramo no puede ser negativo' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) > 200 or char_length(btrim(coalesce(p_notes, ''))) > 1000 then
    raise exception 'La descripción o las notas superan el largo permitido' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.products
    where id = p_source_product_id and organization_id = current_batch.organization_id and active and unit_type = 'WEIGHT'
  ) then
    raise exception 'El insumo de origen debe ser un producto activo vendido por peso' using errcode = '42501';
  end if;

  cost_total := app_private.round_ratio_half_up(p_cost_per_kg_cents * p_input_weight_grams, 1000);

  update public.production_batches
  set source_product_id = p_source_product_id,
      description = nullif(btrim(p_description), ''),
      input_weight_grams = p_input_weight_grams,
      cost_per_kg_cents = p_cost_per_kg_cents,
      cost_total_cents = cost_total,
      notes = nullif(btrim(p_notes), '')
  where id = p_batch_id;
end;
$$;

create function public.set_production_batch_output(
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
  ) then
    raise exception 'El producto obtenido debe ser un producto activo del catálogo vendido por peso' using errcode = '42501';
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

create function public.remove_production_batch_output(p_output_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_output public.production_batch_outputs%rowtype;
  current_batch public.production_batches%rowtype;
begin
  select * into current_output from public.production_batch_outputs where id = p_output_id;
  if not found then raise exception 'Output was not found' using errcode = '42501'; end if;
  select * into current_batch from public.production_batches where id = current_output.batch_id for update;
  if not app_private.can_access_branch(current_batch.organization_id, current_batch.branch_id, 'production.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if current_batch.status <> 'DRAFT' then
    raise exception 'Sólo un lote en borrador puede editar sus productos obtenidos' using errcode = '22023';
  end if;

  delete from public.production_batch_outputs where id = p_output_id;
end;
$$;

create function public.cancel_production_batch(p_batch_id uuid)
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
    -- Cancelling a completed batch would need a stock/history reversal flow that does not exist
    -- yet; only an unfinished draft (which never touched stock or history) can be abandoned.
    raise exception 'Sólo un lote en borrador puede cancelarse' using errcode = '22023';
  end if;

  update public.production_batches
  set status = 'CANCELLED', cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_batch_id;

  perform app_private.write_audit(
    current_batch.organization_id, current_batch.branch_id, 'PRODUCTION_BATCH_CANCELLED', 'production_batches', p_batch_id,
    jsonb_build_object('status', 'DRAFT'), jsonb_build_object('status', 'CANCELLED')
  );
end;
$$;

create function public.complete_production_batch(p_batch_id uuid)
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
begin
  select * into current_batch from public.production_batches where id = p_batch_id for update;
  if not found then raise exception 'Batch was not found' using errcode = '42501'; end if;
  if not app_private.can_access_branch(current_batch.organization_id, current_batch.branch_id, 'production.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if current_batch.status <> 'DRAFT' then
    raise exception 'Sólo un lote en borrador puede finalizarse' using errcode = '22023';
  end if;

  select coalesce(sum(o.output_weight_grams), 0) into produced_weight
  from public.production_batch_outputs o where o.batch_id = p_batch_id;

  if produced_weight = 0 then
    raise exception 'El lote no tiene productos obtenidos' using errcode = '22023';
  end if;
  if produced_weight > current_batch.input_weight_grams then
    raise exception 'Los productos obtenidos no pueden superar el peso de entrada' using errcode = '22023';
  end if;

  select preview.product_name into missing_product
  from app_private.compute_production_preview(p_batch_id) preview
  where preview.sale_price_per_kg_cents is null
  limit 1;
  if missing_product is not null then
    raise exception 'El producto "%" no tiene un precio de venta vigente', missing_product using errcode = '22023';
  end if;

  select coalesce(sum(preview.sale_value_cents), 0) into total_sale_value
  from app_private.compute_production_preview(p_batch_id) preview;
  if total_sale_value <= 0 then
    raise exception 'No se puede asignar el costo: el valor potencial de venta total es cero' using errcode = '22023';
  end if;

  update public.production_batch_outputs o
  set sale_price_per_kg_cents_snapshot = preview.sale_price_per_kg_cents,
      sale_value_cents_snapshot = preview.sale_value_cents,
      allocated_cost_cents_snapshot = preview.allocated_cost_cents
  from app_private.compute_production_preview(p_batch_id) preview
  where preview.output_id = o.id;

  yield_bps := app_private.round_ratio_half_up(produced_weight * 10000, current_batch.input_weight_grams);
  gross_margin := total_sale_value - current_batch.cost_total_cents;
  margin_over_sales_bps := (case when gross_margin < 0 then -1 else 1 end)
    * app_private.round_ratio_half_up(abs(gross_margin) * 10000, total_sale_value);
  profitability_over_cost_bps := case when current_batch.cost_total_cents > 0 then
    (case when gross_margin < 0 then -1 else 1 end) * app_private.round_ratio_half_up(abs(gross_margin) * 10000, current_batch.cost_total_cents)
  end;

  update public.production_batches
  set status = 'COMPLETED',
      completed_by = auth.uid(),
      completed_at = now(),
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

create function public.list_production_batches(
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

create function public.get_production_batch_detail(p_batch_id uuid)
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
      sum(preview.sale_value_cents)
    into outputs_json, produced_weight, total_sale_value
    from app_private.compute_production_preview(p_batch_id) preview;

    select preview.product_name into missing_product
    from app_private.compute_production_preview(p_batch_id) preview
    where preview.sale_price_per_kg_cents is null
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
    'canFinalize', current_batch.status = 'DRAFT' and produced_weight > 0
      and produced_weight <= current_batch.input_weight_grams and missing_product is null,
    'missingPriceProductName', missing_product
  );

  return jsonb_build_object(
    'batch', jsonb_build_object(
      'id', current_batch.id, 'branchId', current_batch.branch_id, 'branchName', current_batch.branch_name,
      'sourceProductId', current_batch.source_product_id, 'sourceProductName', current_batch.source_product_name,
      'description', current_batch.description, 'inputWeightGrams', current_batch.input_weight_grams,
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

-- Pooled average yield/waste for the last N completed batches of a given source product, so the
-- POS can show e.g. "Media res de cerdo: rendimiento promedio 93,2%" without building analytics.
create function public.get_production_yield_summary(p_source_product_id uuid, p_limit integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('production.read');
  result jsonb;
begin
  if p_limit is null then p_limit := 10; end if;
  if p_limit <= 0 or p_limit > 100 then
    raise exception 'Limit must be between 1 and 100' using errcode = '22023';
  end if;
  if not exists (select 1 from public.products where id = p_source_product_id and organization_id = current_organization_id) then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;

  with recent as (
    select b.produced_weight_grams, b.input_weight_grams
    from public.production_batches b
    where b.organization_id = current_organization_id
      and b.source_product_id = p_source_product_id
      and b.status = 'COMPLETED'
      and app_private.can_access_branch(current_organization_id, b.branch_id, 'production.read')
    order by b.completed_at desc
    limit p_limit
  )
  select jsonb_build_object(
    'sampleSize', count(*),
    'averageYieldBps', case when count(*) > 0 and sum(recent.input_weight_grams) > 0
      then app_private.round_ratio_half_up(sum(recent.produced_weight_grams) * 10000, sum(recent.input_weight_grams)) end,
    'averageWastePercentageBps', case when count(*) > 0 and sum(recent.input_weight_grams) > 0
      then 10000 - app_private.round_ratio_half_up(sum(recent.produced_weight_grams) * 10000, sum(recent.input_weight_grams)) end
  )
  into result
  from recent;

  return result;
end;
$$;

alter table public.production_batches enable row level security;
alter table public.production_batch_outputs enable row level security;

create policy production_batches_select on public.production_batches
for select to authenticated
using (app_private.can_access_branch(organization_id, branch_id, 'production.read'));

create policy production_batch_outputs_select on public.production_batch_outputs
for select to authenticated
using (app_private.can_access_branch(organization_id, branch_id, 'production.read'));

revoke all on table public.production_batches, public.production_batch_outputs from public, anon, authenticated;
grant select on table public.production_batches, public.production_batch_outputs to authenticated;

revoke all on function app_private.compute_production_preview(uuid) from public, anon, authenticated;

revoke all on function
  public.get_production_catalog(uuid),
  public.create_production_batch(uuid, uuid, integer, bigint, text, text),
  public.update_production_batch_header(uuid, uuid, integer, bigint, text, text),
  public.set_production_batch_output(uuid, uuid, integer),
  public.remove_production_batch_output(uuid),
  public.cancel_production_batch(uuid),
  public.complete_production_batch(uuid),
  public.list_production_batches(uuid, text, integer),
  public.get_production_batch_detail(uuid),
  public.get_production_yield_summary(uuid, integer)
from public, anon;

grant execute on function
  public.get_production_catalog(uuid),
  public.create_production_batch(uuid, uuid, integer, bigint, text, text),
  public.update_production_batch_header(uuid, uuid, integer, bigint, text, text),
  public.set_production_batch_output(uuid, uuid, integer),
  public.remove_production_batch_output(uuid),
  public.cancel_production_batch(uuid),
  public.complete_production_batch(uuid),
  public.list_production_batches(uuid, text, integer),
  public.get_production_batch_detail(uuid),
  public.get_production_yield_summary(uuid, integer)
to authenticated;

commit;
