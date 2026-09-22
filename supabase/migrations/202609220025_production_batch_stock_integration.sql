-- Wires desposte/production into the EXISTING stock ledger (public.stock_movements), which is
-- the project's actual, already-implemented stock model (append-only movements, stock derived by
-- summing quantity_grams, negative stock accepted as a real unclamped state — see
-- docs/DOMAIN_RULES.md "Stock" and the WASTE/ADJUSTMENT_NEGATIVE tests in
-- branch_stock_status_rpc.test.sql). No second, parallel inventory model is introduced: a
-- completed batch consumes its source product and yields its outputs through two new movement
-- types on the same ledger, exactly like SALE movements are written directly by complete_sale.
--
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction as a statement that references
-- the new value (a hard PostgreSQL restriction), so these two run standalone, auto-committed,
-- before the transactional block below that uses them.
alter type public.stock_movement_type add value if not exists 'PRODUCTION_CONSUME';
alter type public.stock_movement_type add value if not exists 'PRODUCTION_YIELD';

begin;

alter table public.stock_movements
  add column production_batch_id uuid;

alter table public.stock_movements
  add constraint stock_movements_production_batch_fk
  foreign key (production_batch_id, organization_id, branch_id)
  references public.production_batches(id, organization_id, branch_id) on delete restrict;

create index stock_movements_production_batch_idx
  on public.stock_movements (production_batch_id) where production_batch_id is not null;

-- Replace the original (unnamed, auto-generated) sign-check with an explicitly named one that
-- also covers the two new production movement types, without touching migration 003 itself.
do $$
declare
  sign_check_name text;
begin
  select conname into sign_check_name
  from pg_constraint
  where conrelid = 'public.stock_movements'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%ADJUSTMENT_POSITIVE%'
    and pg_get_constraintdef(oid) like '%TRANSFER_IN%';
  if sign_check_name is null then
    raise exception 'Could not locate the stock_movements type/quantity sign check constraint';
  end if;
  execute format('alter table public.stock_movements drop constraint %I', sign_check_name);
end;
$$;

alter table public.stock_movements add constraint stock_movements_type_sign_check check (
  (type in ('PURCHASE', 'ADJUSTMENT_POSITIVE', 'TRANSFER_IN', 'RETURN', 'PRODUCTION_YIELD') and quantity_grams > 0)
  or (type in ('SALE', 'WASTE', 'ADJUSTMENT_NEGATIVE', 'TRANSFER_OUT', 'PRODUCTION_CONSUME') and quantity_grams < 0)
);

alter table public.stock_movements add constraint stock_movements_production_link_check check (
  (type in ('PRODUCTION_CONSUME', 'PRODUCTION_YIELD') and production_batch_id is not null)
  or (type not in ('PRODUCTION_CONSUME', 'PRODUCTION_YIELD') and production_batch_id is null)
);

comment on column public.stock_movements.production_batch_id is
  'Set only for PRODUCTION_CONSUME/PRODUCTION_YIELD rows written by complete_production_batch. Waste itself is never a stock movement for any product: it is the arithmetic gap between the consumed input and the yielded outputs, reported on production_batches.waste_grams, not booked as inventory.';

-- Extend complete_production_batch (defined in 202609220024) to also write the ledger rows.
-- Full function replaced (not ALTERed) since this migration has not been applied anywhere yet.
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

  -- Ledger: the full purchased input leaves stock as itself (it is not sellable once desposted),
  -- and each output enters stock at its own weight. Waste is the implicit gap; it never gets its
  -- own movement because it is not inventory for any product.
  insert into public.stock_movements (
    organization_id, branch_id, product_id, type, quantity_grams,
    production_batch_id, profile_id, occurred_at, created_at
  ) values (
    current_batch.organization_id, current_batch.branch_id, current_batch.source_product_id,
    'PRODUCTION_CONSUME', -current_batch.input_weight_grams::bigint,
    p_batch_id, current_actor, batch_completed_at, batch_completed_at
  );

  for output_row in
    select o.product_id, o.output_weight_grams
    from public.production_batch_outputs o
    where o.batch_id = p_batch_id
  loop
    insert into public.stock_movements (
      organization_id, branch_id, product_id, type, quantity_grams,
      production_batch_id, profile_id, occurred_at, created_at
    ) values (
      current_batch.organization_id, current_batch.branch_id, output_row.product_id,
      'PRODUCTION_YIELD', output_row.output_weight_grams::bigint,
      p_batch_id, current_actor, batch_completed_at, batch_completed_at
    );
  end loop;

  yield_bps := app_private.round_ratio_half_up(produced_weight * 10000, current_batch.input_weight_grams);
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

revoke all on function public.complete_production_batch(uuid) from public, anon;
grant execute on function public.complete_production_batch(uuid) to authenticated;

commit;
