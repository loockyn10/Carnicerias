begin;

-- Resumen operativo de la sucursal (sólo lectura): lo que el Resumen del detalle necesita para contestar
-- "qué se vende, qué llevar, qué casi no se vende, qué stock parece raro" SIN una consulta por producto.
--
--   get_branch_operations_summary   UNA fila por producto del SURTIDO de la sucursal con alguna señal
--                                   (stock distinto de cero, ventas recientes o diferencia contra el ledger):
--                                   ventas del período elegido y del período anterior, ventas de los últimos
--                                   7 y 14 días, última venta, último ingreso y tickets cuyo descuento de
--                                   stock no coincide con lo vendido.
--   get_product_branch_activity     Un producto en todas las sucursales accesibles (stock, ventas de 7 días y
--                                   última venta): el modal de producto y la comparación entre sucursales.
--
-- NO crean un segundo stock ni un segundo algoritmo de reposición:
--   · el stock sale de `stock_levels` (el ledger), igual que get_replenishment_plan / get_branch_carry_plan;
--   · "qué llevar" sigue siendo get_branch_carry_plan (acá no se recalcula);
--   · el control ventas-vs-ledger usa EXACTAMENTE la regla de get_stock_audit_summary (ticket por ticket:
--     COMPLETED y PENDING_PAYMENT esperan descontar lo vendido, CANCELLED espera 0, comparado contra
--     -(SALE + RETURN) del ledger), pero en lote para todos los productos de la sucursal.
-- La organización siempre sale de la sesión (app_private.require_permission); la sucursal se valida contra esa
-- organización y el acceso por sucursal se resuelve con app_private.can_access_branch. Nada se escribe.
--
-- Ventanas (días calendario de la zona horaria de la organización, el día de hoy incluido):
--   período elegido      [p_from 00:00, p_to + 1 día 00:00)
--   período anterior     la misma cantidad de días inmediatamente antes
--   7 días / 14 días     desde la medianoche local de hace 6 / 13 días hasta ahora (igual que replenishment_rows)
--   última venta         la más reciente dentro de los últimos 90 días (o del período anterior, si es más viejo)
--   control vs ledger    tickets de los últimos 14 días

-- ---------------------------------------------------------------------------------------------
-- Resumen operativo por sucursal.
-- · Sólo ventas COMPLETED para lo vendido; cantidades en la unidad del producto (gramos WEIGHT, unidades UNIT):
--   kilos y unidades nunca se suman entre sí porque cada fila es un producto.
-- · revenue_period_cents = subtotal de la línea menos su parte del descuento del ticket (el mismo ingreso que
--   usan el dashboard, Rentabilidad y get_product_sales_summary).
-- · ledger_mismatch_tickets: tickets de los últimos 14 días donde el ledger descontó algo distinto de lo
--   esperado; ledger_mismatch_quantity = esperado - descontado (positivo = se vendió más de lo que el ledger
--   descontó, o sea el stock del sistema está SOBRESTIMADO por esa cantidad).
-- · last_inbound_at: último PURCHASE / TRANSFER_IN / PRODUCTION_YIELD / OPENING_BALANCE (sólo se calcula para
--   productos con stock positivo; RETURN y ADJUSTMENT_POSITIVE no son recepciones, igual que en la auditoría).
-- · Sólo productos ACTIVOS y HABILITADOS en la sucursal (branch_product_assortment). Un producto sin stock, sin
--   ventas recientes y sin diferencias no aporta información y no se devuelve.
-- ---------------------------------------------------------------------------------------------
create function public.get_branch_operations_summary(
  p_branch_id uuid,
  p_from date,
  p_to date
)
returns table (
  product_id uuid,
  product_name text,
  unit_type public.unit_type,
  current_quantity bigint,
  sold_period bigint,
  revenue_period_cents bigint,
  sold_previous bigint,
  sold_7d bigint,
  sold_14d bigint,
  last_sale_at timestamptz,
  last_inbound_at timestamptz,
  ledger_mismatch_tickets integer,
  ledger_mismatch_quantity bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('sales.read');
  org_timezone text;
  span_days integer;
  local_today date;
  range_start timestamptz;
  range_end timestamptz;
  previous_start timestamptz;
  start_7d timestamptz;
  start_14d timestamptz;
  lookback_start timestamptz;
begin
  -- Mezcla stock (stock_levels) con ventas: hacen falta los dos permisos.
  perform app_private.require_permission('stock.read');

  if p_branch_id is null then
    raise exception 'La sucursal es obligatoria' using errcode = '22023';
  end if;
  if p_from is null or p_to is null then
    raise exception 'El rango de fechas es obligatorio' using errcode = '22023';
  end if;
  if p_from > p_to then
    raise exception 'La fecha inicial no puede ser posterior a la final' using errcode = '22023';
  end if;
  span_days := (p_to - p_from) + 1;
  if span_days > 366 then
    raise exception 'El rango no puede superar 366 días' using errcode = '22023';
  end if;

  select o.timezone into org_timezone
  from public.organizations o
  where o.id = current_organization_id and o.active;
  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;
  if not app_private.can_access_branch(current_organization_id, p_branch_id, 'sales.read')
     or not app_private.can_access_branch(current_organization_id, p_branch_id, 'stock.read') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  local_today := (now() at time zone org_timezone)::date;
  range_start := p_from::timestamp at time zone org_timezone;
  range_end := (p_to + 1)::timestamp at time zone org_timezone;
  previous_start := (p_from - span_days)::timestamp at time zone org_timezone;
  start_7d := (local_today - 6)::timestamp at time zone org_timezone;
  start_14d := (local_today - 13)::timestamp at time zone org_timezone;
  lookback_start := least(previous_start, (local_today - 89)::timestamp at time zone org_timezone);

  return query
  with assortment as (
    select p.id as a_product_id, p.name as a_product_name, p.unit_type as a_unit_type
    from public.branch_product_assortment a
    join public.products p
      on p.id = a.product_id
     and p.organization_id = a.organization_id
     and p.active
    where a.organization_id = current_organization_id
      and a.branch_id = p_branch_id
  ), sold as (
    select si.product_id as s_product_id,
      coalesce(sum(coalesce(si.weight_grams, si.quantity_units)) filter (where s.completed_at >= range_start and s.completed_at < range_end), 0)::bigint as s_period,
      coalesce(sum(si.subtotal_cents - si.ticket_discount_cents) filter (where s.completed_at >= range_start and s.completed_at < range_end), 0)::bigint as s_revenue,
      coalesce(sum(coalesce(si.weight_grams, si.quantity_units)) filter (where s.completed_at >= previous_start and s.completed_at < range_start), 0)::bigint as s_previous,
      coalesce(sum(coalesce(si.weight_grams, si.quantity_units)) filter (where s.completed_at >= start_7d), 0)::bigint as s_7d,
      coalesce(sum(coalesce(si.weight_grams, si.quantity_units)) filter (where s.completed_at >= start_14d), 0)::bigint as s_14d,
      max(s.completed_at) as s_last_sale
    from public.sale_items si
    join public.sales s
      on s.id = si.sale_id
     and s.organization_id = si.organization_id
     and s.branch_id = si.branch_id
    where s.organization_id = current_organization_id
      and s.branch_id = p_branch_id
      and s.status = 'COMPLETED'
      and s.completed_at >= lookback_start
    group by si.product_id
  ), window_sales as (
    select s.id as w_sale_id, s.status as w_status, si.product_id as w_product_id,
      sum(coalesce(si.weight_grams, si.quantity_units))::bigint as w_quantity
    from public.sales s
    join public.sale_items si
      on si.sale_id = s.id
     and si.organization_id = s.organization_id
     and si.branch_id = s.branch_id
    where s.organization_id = current_organization_id
      and s.branch_id = p_branch_id
      and s.status in ('COMPLETED', 'PENDING_PAYMENT', 'CANCELLED')
      and s.completed_at >= start_14d
    group by s.id, s.status, si.product_id
  ), ledger as (
    select sm.sale_id as l_sale_id, sm.product_id as l_product_id, (-sum(sm.quantity_grams))::bigint as l_quantity
    from public.stock_movements sm
    where sm.organization_id = current_organization_id
      and sm.branch_id = p_branch_id
      and sm.type in ('SALE', 'RETURN')
      and sm.sale_id in (select ws.w_sale_id from window_sales ws)
    group by sm.sale_id, sm.product_id
  ), mismatch as (
    select ws.w_product_id as m_product_id,
      count(*)::integer as m_tickets,
      sum(case when ws.w_status in ('COMPLETED', 'PENDING_PAYMENT') then ws.w_quantity else 0 end - coalesce(l.l_quantity, 0))::bigint as m_quantity
    from window_sales ws
    left join ledger l on l.l_sale_id = ws.w_sale_id and l.l_product_id = ws.w_product_id
    where coalesce(l.l_quantity, 0) <> case when ws.w_status in ('COMPLETED', 'PENDING_PAYMENT') then ws.w_quantity else 0 end
    group by ws.w_product_id
  )
  select a.a_product_id, a.a_product_name, a.a_unit_type,
    coalesce(sl.quantity_grams, 0)::bigint,
    coalesce(sd.s_period, 0)::bigint,
    coalesce(sd.s_revenue, 0)::bigint,
    coalesce(sd.s_previous, 0)::bigint,
    coalesce(sd.s_7d, 0)::bigint,
    coalesce(sd.s_14d, 0)::bigint,
    sd.s_last_sale,
    inbound.inbound_at,
    coalesce(mm.m_tickets, 0)::integer,
    coalesce(mm.m_quantity, 0)::bigint
  from assortment a
  left join public.stock_levels sl
    on sl.organization_id = current_organization_id
   and sl.branch_id = p_branch_id
   and sl.product_id = a.a_product_id
  left join sold sd on sd.s_product_id = a.a_product_id
  left join mismatch mm on mm.m_product_id = a.a_product_id
  left join lateral (
    select sm.occurred_at as inbound_at
    from public.stock_movements sm
    where coalesce(sl.quantity_grams, 0) > 0
      and sm.organization_id = current_organization_id
      and sm.branch_id = p_branch_id
      and sm.product_id = a.a_product_id
      and sm.type in ('PURCHASE', 'TRANSFER_IN', 'PRODUCTION_YIELD', 'OPENING_BALANCE')
    order by sm.occurred_at desc
    limit 1
  ) inbound on true
  where coalesce(sl.quantity_grams, 0) <> 0
     or sd.s_product_id is not null
     or mm.m_product_id is not null
  order by coalesce(sd.s_revenue, 0) desc, a.a_product_name, a.a_product_id;
end;
$$;

revoke all on function public.get_branch_operations_summary(uuid, date, date) from public, anon;
grant execute on function public.get_branch_operations_summary(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Un producto en todas las sucursales accesibles que lo tienen en su surtido (activas): stock actual, vendido
-- en los últimos 7 días (días calendario de la organización, hoy incluido), última venta (90 días) y si la
-- sucursal es la productiva (Central), para que la pantalla pueda omitirla de la comparación.
-- ---------------------------------------------------------------------------------------------
create function public.get_product_branch_activity(p_product_id uuid)
returns table (
  branch_id uuid,
  branch_name text,
  is_production boolean,
  unit_type public.unit_type,
  current_quantity bigint,
  sold_7d bigint,
  last_sale_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('sales.read');
  org_timezone text;
  production_id uuid;
  product_unit_type public.unit_type;
  local_today date;
  start_7d timestamptz;
  lookback_start timestamptz;
begin
  perform app_private.require_permission('stock.read');

  if p_product_id is null then
    raise exception 'El producto es obligatorio' using errcode = '22023';
  end if;

  select o.timezone, o.production_branch_id into org_timezone, production_id
  from public.organizations o
  where o.id = current_organization_id and o.active;
  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;

  select p.unit_type into product_unit_type
  from public.products p
  where p.id = p_product_id and p.organization_id = current_organization_id;
  if not found then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;

  local_today := (now() at time zone org_timezone)::date;
  start_7d := (local_today - 6)::timestamp at time zone org_timezone;
  lookback_start := (local_today - 89)::timestamp at time zone org_timezone;

  return query
  with scoped_branches as (
    select b.id as sb_id, b.name as sb_name
    from public.branches b
    join public.branch_product_assortment a
      on a.branch_id = b.id
     and a.organization_id = b.organization_id
     and a.product_id = p_product_id
    where b.organization_id = current_organization_id
      and b.active
      and app_private.can_access_branch(current_organization_id, b.id, 'sales.read')
      and app_private.can_access_branch(current_organization_id, b.id, 'stock.read')
  ), sold as (
    select si.branch_id as s_branch_id,
      coalesce(sum(coalesce(si.weight_grams, si.quantity_units)) filter (where s.completed_at >= start_7d), 0)::bigint as s_7d,
      max(s.completed_at) as s_last_sale
    from public.sale_items si
    join public.sales s
      on s.id = si.sale_id
     and s.organization_id = si.organization_id
     and s.branch_id = si.branch_id
    where s.organization_id = current_organization_id
      and s.status = 'COMPLETED'
      and s.completed_at >= lookback_start
      and si.product_id = p_product_id
      and s.branch_id in (select sb.sb_id from scoped_branches sb)
    group by si.branch_id
  )
  select sb.sb_id, sb.sb_name, (sb.sb_id = production_id), product_unit_type,
    coalesce(sl.quantity_grams, 0)::bigint,
    coalesce(sd.s_7d, 0)::bigint,
    sd.s_last_sale
  from scoped_branches sb
  left join public.stock_levels sl
    on sl.organization_id = current_organization_id
   and sl.branch_id = sb.sb_id
   and sl.product_id = p_product_id
  left join sold sd on sd.s_branch_id = sb.sb_id
  order by sb.sb_name, sb.sb_id;
end;
$$;

revoke all on function public.get_product_branch_activity(uuid) from public, anon;
grant execute on function public.get_product_branch_activity(uuid) to authenticated;

comment on function public.get_branch_operations_summary(uuid, date, date) is
  'Resumen operativo de una sucursal por producto del surtido: ventas del período y del anterior, últimos 7/14 días, última venta, último ingreso y tickets cuyo descuento de stock no coincide con lo vendido (misma regla que get_stock_audit_summary). Sólo lectura.';
comment on function public.get_product_branch_activity(uuid) is
  'Un producto en todas las sucursales activas accesibles que lo tienen en su surtido: stock, vendido en 7 días y última venta. Sólo lectura.';

commit;
