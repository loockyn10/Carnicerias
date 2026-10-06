begin;

-- Sucursales: (1) métricas de ventas por rango de fechas y (2) "qué llevar ahora".
--
-- (1) get_branch_sales_summary: agregación server-side por sucursal para un rango de DÍAS CALENDARIO
--     de la organización (organizations.timezone). Reemplaza el select de `sales` que /admin/branches
--     traía al navegador para sumar en el cliente.
-- (2) get_branch_carry_plan: informe operativo bajo demanda "qué llevar desde la sucursal productiva".
--     NO crea un segundo motor de reposición: reutiliza la MISMA base de datos que
--     get_replenishment_plan (ventas COMPLETED de la ventana, stock actual de stock_levels, surtido
--     branch_product_assortment), extraída a app_private.replenishment_rows. get_replenishment_plan
--     pasa a ser un envoltorio de esa base con exactamente el mismo contrato (columnas, orden,
--     permisos), de modo que la ventana de demanda, el filtro de surtido y la zona horaria no
--     puedan divergir entre las dos pantallas.
--
-- No escribe nada: ni stock_movements, ni transferencias, ni stock_levels.

-- ---------------------------------------------------------------------------------------------
-- Base compartida: ventas recientes + stock + política por (sucursal × producto habilitado).
-- Cuerpo movido sin cambios desde 202609300047 (get_replenishment_plan), con dos agregados:
-- el filtro opcional por sucursal y la columna sales_window_start (inicio real de la ventana).
-- ---------------------------------------------------------------------------------------------
create function app_private.replenishment_rows(
  p_organization_id uuid,
  p_days integer,
  p_branch_id uuid default null
)
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
  target_coverage_days numeric,
  sales_window_start timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
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
  where o.id = p_organization_id and o.active;

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
    where s.organization_id = p_organization_id
      and s.status = 'COMPLETED'
      and s.completed_at >= sales_start
      and (p_branch_id is null or si.branch_id = p_branch_id)
    group by si.branch_id, si.product_id
  )
  select b.id, b.name, p.id, p.name, p.unit_type,
    coalesce(sl.quantity_grams, 0)::bigint,
    coalesce(settings.minimum_stock_grams, 0)::bigint,
    coalesce(settings.target_stock_grams, 0)::bigint,
    coalesce(recent.sold_quantity, 0)::bigint,
    p_days,
    current_target_days,
    sales_start
  from public.branches b
  join public.products p
    on p.organization_id = b.organization_id and p.active
  join public.branch_product_assortment assortment
    on assortment.branch_id = b.id and assortment.product_id = p.id
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
  where b.organization_id = p_organization_id
    and b.active
    and (p_branch_id is null or b.id = p_branch_id)
    and app_private.can_access_branch(p_organization_id, b.id, 'dashboard.read')
  order by b.name, b.id, p.name, p.id;
end;
$$;

revoke all on function app_private.replenishment_rows(uuid, integer, uuid) from public, anon, authenticated;

-- Mismo contrato que 202609300047 (misma firma → CREATE OR REPLACE conserva los grants).
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
begin
  return query
  select r.branch_id, r.branch_name, r.product_id, r.product_name, r.unit_type,
    r.current_quantity, r.minimum_quantity, r.target_quantity, r.sold_recent_quantity,
    r.sales_days, r.target_coverage_days
  from app_private.replenishment_rows(current_organization_id, p_days) r;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Qué llevar ahora.
--   sugerido = max(vendido_7d - max(stock_actual, 0), 0)
-- · vendido_7d: ventas COMPLETED de la ventana (7 días calendario de la organización, el día de hoy
--   incluido: desde la medianoche local de hace 6 días hasta este momento), en la unidad del
--   producto (gramos para WEIGHT, unidades para UNIT).
-- · stock_actual: stock_levels (el ledger). Un stock negativo (ventas sin ingreso registrado) se
--   trata como 0 para la cuenta: físicamente no hay menos que nada, y sumar el faltante contable
--   inflaría sistemáticamente la carga. current_quantity se devuelve CRUDO para que la pantalla
--   muestre el faltante.
-- · NO se limita por el stock de la sucursal productiva (no es confiable como tope duro).
-- · Sólo productos habilitados en la sucursal (branch_product_assortment) y activos.
-- · El origen (organizations.production_branch_id) nunca es destino. Si no está configurado se
--   rechaza: sin saber cuál es el origen no se puede decir cuáles son destinos.
-- Devuelve TODAS las filas del surtido (también las de sugerido 0): ocultar las que no necesitan
-- carga es una decisión de la pantalla ("Mostrar sin necesidad").
-- ---------------------------------------------------------------------------------------------
create function public.get_branch_carry_plan(p_branch_id uuid default null)
returns table (
  branch_id uuid,
  branch_name text,
  product_id uuid,
  product_name text,
  unit_type public.unit_type,
  sold_quantity bigint,
  current_quantity bigint,
  suggested_quantity bigint,
  window_days integer,
  window_start timestamptz,
  calculated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('dashboard.read');
  production_id uuid;
begin
  select o.production_branch_id into production_id
  from public.organizations o
  where o.id = current_organization_id and o.active;
  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;
  if production_id is null then
    raise exception 'Configurá la sucursal productiva antes de calcular qué llevar' using errcode = '22023';
  end if;

  if p_branch_id is not null then
    if not exists (
      select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
    ) then
      raise exception 'Branch was not found in this organization' using errcode = '42501';
    end if;
    if p_branch_id = production_id then
      raise exception 'La sucursal productiva es el origen de la carga, no un destino' using errcode = '22023';
    end if;
    if not app_private.can_access_branch(current_organization_id, p_branch_id, 'dashboard.read') then
      raise exception 'Branch is not authorized for this user' using errcode = '42501';
    end if;
  end if;

  return query
  select r.branch_id, r.branch_name, r.product_id, r.product_name, r.unit_type,
    r.sold_recent_quantity,
    r.current_quantity,
    greatest(r.sold_recent_quantity - greatest(r.current_quantity, 0), 0)::bigint,
    r.sales_days,
    r.sales_window_start,
    now()
  from app_private.replenishment_rows(current_organization_id, 7, p_branch_id) r
  where r.branch_id <> production_id
  order by r.branch_name, r.branch_id,
    (r.unit_type = 'UNIT'),
    greatest(r.sold_recent_quantity - greatest(r.current_quantity, 0), 0) desc,
    r.sold_recent_quantity desc,
    r.product_name, r.product_id;
end;
$$;

revoke all on function public.get_branch_carry_plan(uuid) from public, anon;
grant execute on function public.get_branch_carry_plan(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Métricas de ventas por sucursal para un rango de días calendario de la organización.
-- · p_from / p_to son FECHAS locales (inclusivas). Los límites se resuelven en la zona horaria de
--   la organización: [p_from 00:00, p_to + 1 día 00:00) locales, nunca en UTC.
-- · Sólo ventas COMPLETED (PENDING_PAYMENT, CANCELLED, REFUNDED y borradores no son recaudación).
-- · total_cents = sales.total_cents (el mismo total que usan el dashboard y las rendiciones).
-- · weight_grams / units salen de sale_items (un ítem WEIGHT aporta gramos, un ítem UNIT aporta
--   unidades): nunca se suman kg con unidades.
-- · previous_total_cents: el período inmediatamente anterior de la misma cantidad de días, para
--   mostrar la variación.
-- · Devuelve una fila por cada sucursal activa accesible, también las que no vendieron.
-- ---------------------------------------------------------------------------------------------
create function public.get_branch_sales_summary(
  p_from date,
  p_to date,
  p_branch_id uuid default null
)
returns table (
  branch_id uuid,
  branch_name text,
  sales_count bigint,
  total_cents bigint,
  weight_grams bigint,
  units bigint,
  previous_total_cents bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('sales.read');
  current_timezone text;
  span_days integer;
  range_start timestamptz;
  range_end timestamptz;
  previous_start timestamptz;
begin
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

  select o.timezone into current_timezone
  from public.organizations o
  where o.id = current_organization_id and o.active;
  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;

  if p_branch_id is not null then
    if not exists (
      select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
    ) then
      raise exception 'Branch was not found in this organization' using errcode = '42501';
    end if;
    if not app_private.can_access_branch(current_organization_id, p_branch_id, 'sales.read') then
      raise exception 'Branch is not authorized for this user' using errcode = '42501';
    end if;
  end if;

  range_start := p_from::timestamp at time zone current_timezone;
  range_end := (p_to + 1)::timestamp at time zone current_timezone;
  previous_start := (p_from - span_days)::timestamp at time zone current_timezone;

  return query
  with scoped_branches as (
    select b.id, b.name
    from public.branches b
    where b.organization_id = current_organization_id
      and b.active
      and (p_branch_id is null or b.id = p_branch_id)
      and app_private.can_access_branch(current_organization_id, b.id, 'sales.read')
  ), window_sales as (
    select s.id, s.branch_id, s.total_cents, s.completed_at
    from public.sales s
    where s.organization_id = current_organization_id
      and s.status = 'COMPLETED'
      and s.completed_at >= previous_start
      and s.completed_at < range_end
      and s.branch_id in (select sb.id from scoped_branches sb)
  ), sold_items as (
    select si.branch_id,
      coalesce(sum(si.weight_grams), 0)::bigint as grams,
      coalesce(sum(si.quantity_units), 0)::bigint as unit_count
    from public.sale_items si
    join window_sales ws on ws.id = si.sale_id and ws.completed_at >= range_start
    group by si.branch_id
  ), sale_totals as (
    select ws.branch_id,
      count(*) filter (where ws.completed_at >= range_start)::bigint as current_count,
      coalesce(sum(ws.total_cents) filter (where ws.completed_at >= range_start), 0)::bigint as current_cents,
      coalesce(sum(ws.total_cents) filter (where ws.completed_at < range_start), 0)::bigint as previous_cents
    from window_sales ws
    group by ws.branch_id
  )
  select sb.id, sb.name,
    coalesce(st.current_count, 0)::bigint,
    coalesce(st.current_cents, 0)::bigint,
    coalesce(it.grams, 0)::bigint,
    coalesce(it.unit_count, 0)::bigint,
    coalesce(st.previous_cents, 0)::bigint
  from scoped_branches sb
  left join sale_totals st on st.branch_id = sb.id
  left join sold_items it on it.branch_id = sb.id
  order by sb.name, sb.id;
end;
$$;

revoke all on function public.get_branch_sales_summary(date, date, uuid) from public, anon;
grant execute on function public.get_branch_sales_summary(date, date, uuid) to authenticated;

commit;
