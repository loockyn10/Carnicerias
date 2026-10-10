begin;

-- Costo de personal AUTOMÁTICO por horas trabajadas dentro del Resultado operativo de cada sucursal (D-085).
--
--   resultado operativo = ganancia bruta - costos mensuales - gastos puntuales - COSTO DE PERSONAL (horas fichadas x valor hora)
--
-- NO se agrega ninguna tabla ni columna: se REUTILIZA lo que ya existe.
--   * Horas:      public.employee_shifts (clock_in_at / clock_out_at / branch_id de la JORNADA, no la sucursal habitual de la persona).
--   * Valor hora: public.employee_hourly_rates (rate_cents_per_hour con vigencia valid_from/valid_to, exclusión por solapamiento,
--                 se versiona con public.set_employee_hourly_rate: un cambio de valor cierra la vigencia anterior y abre otra, así que el
--                 costo de septiembre NUNCA se recalcula con el valor de octubre).
--   * Resultado:  public.get_branch_operating_result / get_branch_operating_costs (202610170080), que ya alimentan el Resumen de sucursal
--                 y el Inicio: al sumar acá el personal, ambos lo muestran sin otro cálculo.
--
-- CÁLCULO (todo en el servidor, un solo lugar: app_private.branch_labor_cost_rows):
--   costo = SUM( segundos del tramo x valor hora de la vigencia que cubre ese tramo ) / 3600, redondeado half-up UNA vez por persona y
--   sucursal en el período (el desglose del modal y el total suman lo mismo). La duración es EXACTA (timestamps, no horas enteras):
--   6 h 30 min x $4.000/h = $26.000.
--   * Cada fichada se INTERSECTA con el período consultado (días calendario de la zona horaria de la organización, [p_from, p_to] inclusive)
--     y con cada vigencia del valor hora: una fichada 20:00 -> 02:00 aporta 4 h al primer día y 2 h al segundo.
--   * Fichada ABIERTA: el fin provisorio es ahora (p_as_of = now()); no se escribe ningún gasto ni hay cron: al consultar más tarde, el
--     mismo cálculo da más horas. Al cerrarse se usa la salida definitiva.
--   * La sucursal imputada es employee_shifts.branch_id.
--
-- CRITERIO CON FICHADAS NO CERRADAS (espejo de app_private.mark_overdue_shifts, 202609280037, para que el costo no dependa de que otro
-- proceso haya corrido el barrido): una fichada sin salida termina en el MENOR de
--   a) ahora,
--   b) su último latido si el dispositivo dejó de latir hace más de 90 s (el barrido la cierra ahí con evidencia de presencia),
--   c) entrada + organizations.max_shift_hours (más allá no hay evidencia de que siga trabajando; el barrido la marca REQUIRES_REVIEW).
-- Una fichada REQUIRES_REVIEW con salida inferida cuenta hasta esa salida. Las que están en REQUIRES_REVIEW se informan aparte
-- (labor_review_shifts) para que el dueño las corrija; DIFERENCIA CONOCIDA con get_timekeeping_report, que sólo estima el pago de
-- fichadas CLOSED.
--
-- SIN valor hora cargado para parte de las horas: esas horas cuestan 0 y se informa labor_rate_missing (el resultado queda incompleto).
--
-- Permisos: igual que el resultado operativo (analytics.read + acceso a la sucursal). El DESGLOSE por persona con su valor hora sólo se
-- devuelve con timekeeping.read (el mismo permiso que ya protege las horas y el pago estimado).

-- ---------------------------------------------------------------------------------------------
-- 1. Cálculo (privado)
-- ---------------------------------------------------------------------------------------------
-- Una fila por (sucursal, persona) con horas dentro del período. p_as_of existe para poder fijar "ahora" (tests); las RPC pasan now().
create function app_private.branch_labor_cost_rows(
  p_organization_id uuid,
  p_branch_ids uuid[],
  p_from date,
  p_to date,
  p_as_of timestamptz default now()
)
returns table (
  branch_id uuid,
  employee_id uuid,
  employee_name text,
  worked_seconds numeric,
  covered_seconds numeric,
  cost_cents bigint,
  min_rate_cents bigint,
  max_rate_cents bigint,
  open_shifts integer,
  review_shifts integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with org as (
    select o.timezone as tz, o.max_shift_hours
    from public.organizations o
    where o.id = p_organization_id
  ), win as (
    select (p_from::timestamp at time zone org.tz) as from_at,
           ((p_to + 1)::timestamp at time zone org.tz) as to_at,
           org.max_shift_hours
    from org
  ), eff as (
    -- Fin efectivo de cada fichada (ver el encabezado): salida real, o el menor de ahora / último latido vencido / entrada + máximo.
    select s.id, s.branch_id, s.employee_id, s.status, s.clock_in_at, w.from_at, w.to_at,
      case
        when s.clock_out_at is not null then s.clock_out_at
        when s.status = 'OPEN' and s.last_heartbeat_at is not null and p_as_of - s.last_heartbeat_at > interval '90 seconds'
          then least(s.last_heartbeat_at, p_as_of)
        else least(p_as_of, s.clock_in_at + make_interval(hours => w.max_shift_hours::integer))
      end as end_at
    from public.employee_shifts s
    cross join win w
    where s.organization_id = p_organization_id
      and s.branch_id = any(p_branch_ids)
      and s.clock_in_at < w.to_at
  ), sh as (
    -- Tramo de la fichada que cae dentro del período.
    select e.id, e.branch_id, e.employee_id, e.status, greatest(e.clock_in_at, e.from_at) as a, least(e.end_at, e.to_at) as b
    from eff e
    where least(e.end_at, e.to_at) > greatest(e.clock_in_at, e.from_at)
  ), seg as (
    -- Tramo x vigencia del valor hora (las vigencias no se solapan: lo garantiza la exclusión de employee_hourly_rates).
    select sh.id,
      extract(epoch from (least(sh.b, coalesce(r.valid_to, 'infinity'::timestamptz)) - greatest(sh.a, r.valid_from))) as secs,
      r.rate_cents_per_hour as rate
    from sh
    join public.employee_hourly_rates r
      on r.organization_id = p_organization_id
     and r.employee_id = sh.employee_id
     and r.valid_from < sh.b
     and (r.valid_to is null or r.valid_to > sh.a)
  ), per_shift as (
    select seg.id, sum(seg.secs) as covered, sum(seg.secs * seg.rate) as numerator, min(seg.rate) as min_rate, max(seg.rate) as max_rate
    from seg
    group by seg.id
  )
  select sh.branch_id,
    sh.employee_id,
    p.display_name,
    sum(extract(epoch from (sh.b - sh.a))),
    coalesce(sum(ps.covered), 0),
    round(coalesce(sum(ps.numerator), 0) / 3600)::bigint,
    min(ps.min_rate)::bigint,
    max(ps.max_rate)::bigint,
    (count(*) filter (where sh.status = 'OPEN'))::integer,
    (count(*) filter (where sh.status = 'REQUIRES_REVIEW'))::integer
  from sh
  join public.profiles p on p.id = sh.employee_id
  left join per_shift ps on ps.id = sh.id
  group by sh.branch_id, sh.employee_id, p.display_name
$$;
revoke all on function app_private.branch_labor_cost_rows(uuid, uuid[], date, date, timestamptz) from public, anon, authenticated;

-- Totales por sucursal (una fila por sucursal pedida, aunque no tenga horas).
create function app_private.branch_labor_cost_totals(
  p_organization_id uuid,
  p_branch_ids uuid[],
  p_from date,
  p_to date,
  p_as_of timestamptz default now()
)
returns table (
  branch_id uuid,
  labor_cents bigint,
  worked_seconds bigint,
  open_shifts integer,
  review_shifts integer,
  rate_missing boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id,
    coalesce(sum(r.cost_cents), 0)::bigint,
    round(coalesce(sum(r.worked_seconds), 0))::bigint,
    coalesce(sum(r.open_shifts), 0)::integer,
    coalesce(sum(r.review_shifts), 0)::integer,
    coalesce(bool_or(r.covered_seconds < r.worked_seconds), false)
  from unnest(p_branch_ids) as b(id)
  left join app_private.branch_labor_cost_rows(p_organization_id, p_branch_ids, p_from, p_to, p_as_of) r on r.branch_id = b.id
  group by b.id
$$;
revoke all on function app_private.branch_labor_cost_totals(uuid, uuid[], date, date, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Lectura: resultado operativo por sucursal (ahora con el personal)
-- ---------------------------------------------------------------------------------------------
-- Mismas columnas que antes + las de personal AL FINAL. operating_cost_cents ahora INCLUYE el personal:
--   operating_cost_cents   = recurring_cost_cents + expense_cents + labor_cost_cents
--   operating_result_cents = gross_profit_cents - operating_cost_cents
-- La ganancia bruta sigue saliendo del motor de rentabilidad existente; is_partial sigue marcando ventas sin costo de mercadería (un
-- costo de personal exacto no vuelve exacta una ganancia bruta incompleta).
drop function public.get_branch_operating_result(date, date, uuid);
create function public.get_branch_operating_result(
  p_from date,
  p_to date,
  p_branch_id uuid default null
)
returns table (
  branch_id uuid,
  branch_name text,
  revenue_cents bigint,
  gross_profit_cents bigint,
  recurring_cost_cents bigint,
  expense_cents bigint,
  operating_cost_cents bigint,
  operating_result_cents bigint,
  operating_margin_bps bigint,
  missing_cost_items integer,
  missing_cost_sales integer,
  missing_cost_revenue_cents bigint,
  is_partial boolean,
  labor_cost_cents bigint,
  labor_worked_seconds bigint,
  labor_open_shifts integer,
  labor_review_shifts integer,
  labor_rate_missing boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('analytics.read');
begin
  return query
  with profit as (
    select * from public.get_branch_profitability_summary(p_from, p_to, p_branch_id)
  ), branch_ids as (
    select coalesce(array_agg(p.branch_id), array[]::uuid[]) as ids from profit p
  ), costs as (
    select t.* from app_private.branch_operating_cost_totals(current_organization_id, (select ids from branch_ids), p_from, p_to) t
  ), labor as (
    select t.* from app_private.branch_labor_cost_totals(current_organization_id, (select ids from branch_ids), p_from, p_to, now()) t
  )
  select p.branch_id, p.branch_name,
    p.revenue_cents,
    p.gross_profit_cents,
    c.recurring_cents,
    c.expense_cents,
    (c.recurring_cents + c.expense_cents + l.labor_cents)::bigint,
    (p.gross_profit_cents - c.recurring_cents - c.expense_cents - l.labor_cents)::bigint,
    case when p.revenue_cents > 0
      then round((p.gross_profit_cents - c.recurring_cents - c.expense_cents - l.labor_cents)::numeric * 10000 / p.revenue_cents)::bigint end,
    p.missing_cost_items,
    p.missing_cost_sales,
    p.missing_cost_revenue_cents,
    p.missing_cost_items > 0,
    l.labor_cents,
    l.worked_seconds,
    l.open_shifts,
    l.review_shifts,
    l.rate_missing
  from profit p
  join costs c on c.branch_id = p.branch_id
  join labor l on l.branch_id = p.branch_id
  order by p.branch_name, p.branch_id;
end;
$$;
revoke all on function public.get_branch_operating_result(date, date, uuid) from public, anon;
grant execute on function public.get_branch_operating_result(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Lectura: el modal «Costos operativos» de UNA sucursal (con la sección PERSONAL — automático)
-- ---------------------------------------------------------------------------------------------
-- Igual que antes + 'laborCents' y 'labor'; 'operatingCostCents' incluye el personal. 'labor.employees' (desglose por persona con su valor
-- hora) sólo se entrega con timekeeping.read; sin él, 'canSeeDetail' es false y viaja el total y las horas.
create or replace function public.get_branch_operating_costs(p_branch_id uuid, p_from date, p_to date)
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
  can_write boolean;
  can_see_labor_detail boolean;
  recurring jsonb;
  expenses jsonb;
  recurring_total bigint;
  expense_total bigint;
  labor_total record;
  labor_employees jsonb := '[]'::jsonb;
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
  select o.timezone into current_timezone from public.organizations o where o.id = current_organization_id and o.active;
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

  local_today := (now() at time zone current_timezone)::date;
  can_write := app_private.can_access_branch(current_organization_id, p_branch_id, 'operating_costs.write');
  can_see_labor_detail := app_private.can_access_branch(current_organization_id, p_branch_id, 'timekeeping.read');

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'currentAmountCents', cur.amount_cents,
      'currentFrom', cur.valid_from,
      'endsOn', case when cur.id is null then last_v.valid_to end,
      'amountCents', coalesce(cur.amount_cents, last_v.amount_cents),
      'imputedCents', app_private.recurring_cost_imputed_cents(c.id, p_from, p_to),
      'history', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', v.id, 'amountCents', v.amount_cents, 'from', v.valid_from, 'to', v.valid_to
        ) order by v.valid_from, v.created_at), '[]'::jsonb)
        from public.branch_recurring_cost_versions v
        where v.cost_id = c.id and not (v.valid_to is not null and v.valid_to = v.valid_from)
      )
    ) order by c.name, c.id), '[]'::jsonb)
  into recurring
  from public.branch_recurring_costs c
  left join lateral (
    select v.id, v.amount_cents, v.valid_from from public.branch_recurring_cost_versions v
    where v.cost_id = c.id and v.valid_from <= local_today and (v.valid_to is null or v.valid_to > local_today)
    limit 1
  ) cur on true
  left join lateral (
    select v.amount_cents, v.valid_to from public.branch_recurring_cost_versions v
    where v.cost_id = c.id and v.valid_to is not null and v.valid_to > v.valid_from
    order by v.valid_from desc limit 1
  ) last_v on true
  where c.organization_id = current_organization_id and c.branch_id = p_branch_id
    -- Relevantes: vigentes hoy, programados a futuro, o con vigencia que toca el período.
    and exists (
      select 1 from public.branch_recurring_cost_versions v
      where v.cost_id = c.id and (v.valid_to is null or v.valid_to > p_from) and v.valid_to is distinct from v.valid_from
    );

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'date', e.expense_date, 'concept', e.concept, 'amountCents', e.amount_cents,
      'inPeriod', e.expense_date between p_from and p_to
    ) order by e.expense_date desc, e.created_at desc), '[]'::jsonb)
  into expenses
  from (
    select * from public.branch_expenses x
    where x.organization_id = current_organization_id and x.branch_id = p_branch_id and x.voided_at is null
    order by x.expense_date desc, x.created_at desc
    limit 50
  ) e;

  select t.recurring_cents, t.expense_cents into recurring_total, expense_total
  from app_private.branch_operating_cost_totals(current_organization_id, array[p_branch_id], p_from, p_to) t;

  select t.labor_cents, t.worked_seconds, t.open_shifts, t.review_shifts, t.rate_missing into labor_total
  from app_private.branch_labor_cost_totals(current_organization_id, array[p_branch_id], p_from, p_to, now()) t;

  if can_see_labor_detail then
    select coalesce(jsonb_agg(jsonb_build_object(
        'employeeId', r.employee_id,
        'name', r.employee_name,
        'workedSeconds', round(r.worked_seconds)::bigint,
        'costCents', r.cost_cents,
        'minRateCents', r.min_rate_cents,
        'maxRateCents', r.max_rate_cents,
        'rateMissing', r.covered_seconds < r.worked_seconds,
        'openShifts', r.open_shifts,
        'reviewShifts', r.review_shifts
      ) order by r.employee_name, r.employee_id), '[]'::jsonb)
    into labor_employees
    from app_private.branch_labor_cost_rows(current_organization_id, array[p_branch_id], p_from, p_to, now()) r;
  end if;

  return jsonb_build_object(
    'canWrite', can_write,
    'timezone', current_timezone,
    'today', local_today,
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'recurring', recurring,
    'expenses', expenses,
    'recurringCents', coalesce(recurring_total, 0),
    'expenseCents', coalesce(expense_total, 0),
    'laborCents', coalesce(labor_total.labor_cents, 0),
    'operatingCostCents', coalesce(recurring_total, 0) + coalesce(expense_total, 0) + coalesce(labor_total.labor_cents, 0),
    'labor', jsonb_build_object(
      'costCents', coalesce(labor_total.labor_cents, 0),
      'workedSeconds', coalesce(labor_total.worked_seconds, 0),
      'openShifts', coalesce(labor_total.open_shifts, 0),
      'reviewShifts', coalesce(labor_total.review_shifts, 0),
      'rateMissing', coalesce(labor_total.rate_missing, false),
      'canSeeDetail', can_see_labor_detail,
      'employees', labor_employees
    )
  );
end;
$$;

commit;
