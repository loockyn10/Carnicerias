begin;

-- Completar costos faltantes de ventas (D-080). Complementa 202610130076 (ganancia/margen por sucursal): ese aviso de «líneas sin costo
-- conocido» pasa a ser una herramienta, SIN cambiar ninguna fórmula de rentabilidad.
--
--   DÓNDE VIVE EL COSTO HISTÓRICO: public.sale_items.cost_cents_snapshot (bigint, centavos POR MEDIDA: $/kg para WEIGHT, $/u para UNIT),
--   tomado al vender. NULL = «costo desconocido» (la venta ocurrió sin costo vigente). El costo de la línea se deriva siempre con
--   app_private.sale_item_cost_cents (UNIT: snapshot * unidades; WEIGHT: round(snapshot * gramos / 1000)); esta migración NO la toca.
--
--   REGLA DE NEGOCIO: esto es una REPARACIÓN DE DATOS FALTANTES, no una revaluación. Una línea que YA tiene snapshot no se modifica
--   nunca; sólo se completa donde es NULL. El UPDATE lleva `cost_cents_snapshot is null` en el WHERE (y las filas se bloquean antes), así que
--   una línea que alguien completó entre que Fran abrió la pantalla y guardó queda intacta (se informa como «omitida»).
--
--   1. public.get_missing_sale_costs(p_from, p_to, p_branch_id): las líneas sin costo del MISMO universo que el aviso del Resumen
--      (COMPLETED, sucursal, días calendario de la organización), agrupadas por producto, con el costo vigente y, para quien tiene
--      prices.write, si guardar ese costo como vigente repreciaría el producto (margen efectivo, mismo helper que el resto del pricing).
--   2. public.complete_missing_sale_costs(...): UNA transacción por producto. El navegador manda producto, sucursal, rango, el costo POR
--      MEDIDA y los ids de línea que vio; el servidor valida organización/sucursal/producto/rango/estado, completa sólo los NULL, deriva el
--      costo de cada línea con la fórmula existente (nunca viaja un total por línea), y audita en public.audit_logs (write_audit).
--      Opcionalmente (p_also_set_current_cost) guarda además el costo VIGENTE con el helper canónico app_private.apply_product_cost: es
--      una acción distinta y explícita, porque con margen efectivo ese flujo recalcula el precio de venta (price_outcome REPRICED).
--
--   No cambia: cantidades, precios, totales, promociones, pagos, estados ni stock. No recalcula ningún precio al aplicarse.

-- ---------------------------------------------------------------------------------------------
-- 1. Lectura: líneas sin costo agrupadas por producto
-- ---------------------------------------------------------------------------------------------
-- Tope de líneas devueltas (totalLines siempre cuenta todas): si hay más, truncated = true y se completa por tandas.
create function public.get_missing_sale_costs(
  p_from date,
  p_to date,
  p_branch_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('analytics.read');
  max_lines constant integer := 5000;
  current_timezone text;
  range_start timestamptz;
  range_end timestamptz;
  can_repair boolean;
  result jsonb;
begin
  if p_from is null or p_to is null then
    raise exception 'El rango de fechas es obligatorio' using errcode = '22023';
  end if;
  if p_from > p_to then
    raise exception 'La fecha inicial no puede ser posterior a la final' using errcode = '22023';
  end if;
  if (p_to - p_from) + 1 > 366 then
    raise exception 'El rango no puede superar 366 días' using errcode = '22023';
  end if;

  select o.timezone into current_timezone
  from public.organizations o
  where o.id = current_organization_id and o.active;
  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;

  if p_branch_id is null or not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;
  if not app_private.can_access_branch(current_organization_id, p_branch_id, 'analytics.read') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  range_start := p_from::timestamp at time zone current_timezone;
  range_end := (p_to + 1)::timestamp at time zone current_timezone;
  -- El costo vigente y la regla de margen son datos de precios (sólo prices.write los ve, igual que las tablas de origen).
  can_repair := app_private.can_access_branch(current_organization_id, p_branch_id, 'prices.write');

  with lines as (
    select item.id as line_id,
      item.sale_id,
      sale.completed_at,
      item.product_id,
      product.name as product_name,
      product.unit_type,
      coalesce(item.weight_grams, item.quantity_units)::bigint as quantity,
      app_private.sale_item_revenue_cents(item.subtotal_cents, item.ticket_discount_cents) as revenue
    from public.sales sale
    join public.sale_items item on item.sale_id = sale.id
      and item.organization_id = sale.organization_id and item.branch_id = sale.branch_id
    join public.products product on product.id = item.product_id and product.organization_id = item.organization_id
    where sale.organization_id = current_organization_id
      and sale.branch_id = p_branch_id
      and sale.status = 'COMPLETED'
      and sale.completed_at >= range_start and sale.completed_at < range_end
      and app_private.sale_item_cost_cents(product.unit_type, item.cost_cents_snapshot, item.weight_grams, item.quantity_units) is null
  ), totals as (
    select count(*)::integer as total_lines,
      coalesce(sum(l.revenue), 0)::bigint as total_revenue
    from lines l
  ), numbered as (
    select l.*, row_number() over (order by l.completed_at, l.line_id) as rn from lines l
  ), capped as (
    select * from numbered where rn <= max_lines
  ), groups as (
    select c.product_id, c.product_name, c.unit_type,
      sum(c.quantity)::bigint as quantity,
      count(*)::integer as line_count,
      sum(c.revenue)::bigint as revenue,
      jsonb_agg(jsonb_build_object(
        'lineId', c.line_id, 'saleId', c.sale_id, 'soldAt', c.completed_at,
        'quantity', c.quantity, 'revenueCents', c.revenue
      ) order by c.completed_at, c.line_id) as line_rows
    from capped c
    group by c.product_id, c.product_name, c.unit_type
  )
  select jsonb_build_object(
    'canRepair', can_repair,
    'timezone', current_timezone,
    'totalLines', t.total_lines,
    'totalRevenueCents', t.total_revenue,
    'truncated', t.total_lines > max_lines,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'productId', g.product_id,
        'productName', g.product_name,
        'unitType', g.unit_type,
        'quantity', g.quantity,
        'lineCount', g.line_count,
        'revenueCents', g.revenue,
        'currentCostCents', case when can_repair then cur.cost_cents end,
        'currentPriceCents', case when can_repair then price.price_cents end,
        'marginBps', case when can_repair and sellable.ok then eff.margin_bps end,
        'repricesOnCostChange', can_repair and sellable.ok and eff.source in ('CUSTOM', 'GLOBAL'),
        'lines', g.line_rows
      ) order by g.revenue desc, g.product_name, g.product_id)
      from groups g
      left join lateral (
        select pc.cost_cents from public.product_costs pc
        where pc.organization_id = current_organization_id and pc.product_id = g.product_id
          and pc.valid_from <= clock_timestamp() and (pc.valid_to is null or pc.valid_to > clock_timestamp())
        order by pc.valid_from desc limit 1
      ) cur on true
      left join lateral (
        select pp.price_cents from public.product_prices pp
        where pp.organization_id = current_organization_id and pp.product_id = g.product_id and pp.branch_id is null
          and pp.valid_from <= clock_timestamp() and (pp.valid_to is null or pp.valid_to > clock_timestamp())
        order by pp.valid_from desc limit 1
      ) price on true
      cross join lateral (
        select coalesce(p.active and p.inventory_role in ('SELLABLE', 'BOTH'), false) as ok
        from public.products p where p.id = g.product_id and p.organization_id = current_organization_id
      ) sellable
      cross join lateral app_private.effective_margin(current_organization_id, g.product_id) eff
    ), '[]'::jsonb)
  ) into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.get_missing_sale_costs(date, date, uuid) from public, anon;
grant execute on function public.get_missing_sale_costs(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Escritura: completar el costo histórico faltante de UN producto (y, opcional, el costo vigente)
-- ---------------------------------------------------------------------------------------------
-- p_unit_cost_cents es el costo POR MEDIDA ($/kg para WEIGHT, $/u para UNIT), el mismo formato que product_costs y que
-- sale_items.cost_cents_snapshot. Devuelve:
--   repairedLines / skippedLines (pedidas que ya no calificaban: ya tenían costo, otra sucursal, fuera del rango, no vendidas)
--   repairedRevenueCents, unitCostCents, currentCostSaved, currentCostUnchanged (el vigente ya era ese costo),
--   priceOutcome (REPRICED | UNCHANGED | SCHEDULED | NO_MARGIN | NOT_SELLABLE | MANUAL_PRICE | null si no se tocó el costo vigente).
create function public.complete_missing_sale_costs(
  p_branch_id uuid,
  p_from date,
  p_to date,
  p_product_id uuid,
  p_unit_cost_cents bigint,
  p_line_ids uuid[],
  p_also_set_current_cost boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  max_lines constant integer := 5000;
  current_timezone text;
  range_start timestamptz;
  range_end timestamptz;
  product_row record;
  requested_ids uuid[];
  repaired_ids uuid[];
  repaired_revenue bigint;
  previous_current_cost bigint;
  current_saved boolean := false;
  current_unchanged boolean := false;
  outcome text;
begin
  if p_from is null or p_to is null then
    raise exception 'El rango de fechas es obligatorio' using errcode = '22023';
  end if;
  if p_from > p_to then
    raise exception 'La fecha inicial no puede ser posterior a la final' using errcode = '22023';
  end if;
  if (p_to - p_from) + 1 > 366 then
    raise exception 'El rango no puede superar 366 días' using errcode = '22023';
  end if;
  if p_unit_cost_cents is null or p_unit_cost_cents <= 0 or p_unit_cost_cents > 10000000000 then
    raise exception 'El costo tiene que ser un importe mayor a cero' using errcode = '22023';
  end if;
  if p_line_ids is null then
    raise exception 'Faltan las líneas a completar' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct line_id), '{}'::uuid[]) into requested_ids
  from unnest(p_line_ids) as line_id
  where line_id is not null;
  if cardinality(requested_ids) = 0 or cardinality(requested_ids) > max_lines then
    raise exception 'Debe enviar entre 1 y % líneas', max_lines using errcode = '22023';
  end if;

  select o.timezone into current_timezone
  from public.organizations o
  where o.id = current_organization_id and o.active;
  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;

  if p_branch_id is null or not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;
  -- Escribir costos pide prices.write; ver las ventas que se corrigen pide analytics.read: las dos sobre ESTA sucursal.
  if not app_private.can_access_branch(current_organization_id, p_branch_id, 'prices.write')
     or not app_private.can_access_branch(current_organization_id, p_branch_id, 'analytics.read') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  select p.id, p.name, p.unit_type into product_row
  from public.products p
  where p.id = p_product_id and p.organization_id = current_organization_id;
  if not found then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;

  range_start := p_from::timestamp at time zone current_timezone;
  range_end := (p_to + 1)::timestamp at time zone current_timezone;

  -- Sólo líneas de ESTA organización, sucursal, producto y rango, de ventas COMPLETED, que SIGUEN sin costo. Se bloquean antes de
  -- escribir; el UPDATE vuelve a exigir `cost_cents_snapshot is null`, así que un completado concurrente nunca se pisa.
  with target as (
    select item.id
    from public.sale_items item
    join public.sales sale on sale.id = item.sale_id
      and sale.organization_id = item.organization_id and sale.branch_id = item.branch_id
    where item.id = any(requested_ids)
      and item.organization_id = current_organization_id
      and item.branch_id = p_branch_id
      and item.product_id = p_product_id
      and sale.status = 'COMPLETED'
      and sale.completed_at >= range_start and sale.completed_at < range_end
      and item.cost_cents_snapshot is null
    order by item.id
    for update of item
  ), repaired as (
    update public.sale_items item
    set cost_cents_snapshot = p_unit_cost_cents
    from target
    where item.id = target.id and item.cost_cents_snapshot is null
    returning item.id, app_private.sale_item_revenue_cents(item.subtotal_cents, item.ticket_discount_cents) as revenue
  )
  select coalesce(array_agg(r.id order by r.id), '{}'::uuid[]), coalesce(sum(r.revenue), 0)::bigint
  into repaired_ids, repaired_revenue
  from repaired r;

  -- Costo vigente: acción aparte y explícita. Mismo helper que set_product_cost; si el costo ya es ese, no abre una vigencia nueva.
  if coalesce(p_also_set_current_cost, false) then
    select pc.cost_cents into previous_current_cost
    from public.product_costs pc
    where pc.organization_id = current_organization_id and pc.product_id = p_product_id
      and pc.valid_from <= clock_timestamp() and (pc.valid_to is null or pc.valid_to > clock_timestamp())
    order by pc.valid_from desc
    limit 1;
    if previous_current_cost is not distinct from p_unit_cost_cents then
      current_unchanged := true;
    else
      select a.price_outcome into outcome
      from app_private.apply_product_cost(current_organization_id, p_product_id, p_unit_cost_cents, clock_timestamp(), auth.uid()) a;
      current_saved := true;
    end if;
  end if;

  if cardinality(repaired_ids) > 0 or current_saved then
    perform app_private.write_audit(
      current_organization_id,
      p_branch_id,
      'SALE_COSTS_BACKFILLED',
      'sale_items',
      p_product_id,
      jsonb_build_object(
        'costCentsSnapshot', null,
        'lineCount', cardinality(repaired_ids),
        'currentCostCents', previous_current_cost
      ),
      jsonb_build_object(
        'productId', p_product_id,
        'productName', product_row.name,
        'unitType', product_row.unit_type,
        'branchId', p_branch_id,
        'period', jsonb_build_object('from', p_from, 'to', p_to),
        'unitCostCents', p_unit_cost_cents,
        'lineCount', cardinality(repaired_ids),
        'lineIds', to_jsonb(repaired_ids),
        'repairedRevenueCents', repaired_revenue,
        'requestedLineCount', cardinality(requested_ids),
        'alsoSetCurrentCost', coalesce(p_also_set_current_cost, false),
        'currentCostSaved', current_saved,
        'priceOutcome', outcome
      )
    );
  end if;

  return jsonb_build_object(
    'repairedLines', cardinality(repaired_ids),
    'skippedLines', cardinality(requested_ids) - cardinality(repaired_ids),
    'repairedRevenueCents', repaired_revenue,
    'unitCostCents', p_unit_cost_cents,
    'currentCostSaved', current_saved,
    'currentCostUnchanged', current_unchanged,
    'priceOutcome', outcome
  );
end;
$$;

revoke all on function public.complete_missing_sale_costs(uuid, date, date, uuid, bigint, uuid[], boolean) from public, anon;
grant execute on function public.complete_missing_sale_costs(uuid, date, date, uuid, bigint, uuid[], boolean) to authenticated;

commit;
