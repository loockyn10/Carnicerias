begin;

-- Costos operativos por sucursal + RESULTADO OPERATIVO (D-082).
--
--   resultado operativo = ganancia bruta del período - costos operativos imputables al período
--
-- UN SOLO MOTOR DE RENTABILIDAD: la ganancia bruta, el ingreso y el contador de líneas sin costo salen de
-- public.get_branch_profitability_summary (202610130076, que usa app_private.sale_item_revenue_cents / sale_item_cost_cents). Esta
-- migración NO recalcula ventas ni costos de mercadería: la RPC nueva envuelve a la existente y le resta los costos operativos.
-- Una línea de venta sin costo histórico conocido sigue fuera de la ganancia bruta, y por lo tanto el resultado operativo se informa
-- como PARCIAL (is_partial) mientras falte alguno.
--
-- Dos tipos de costo, ambos por sucursal:
--   1. RECURRENTES MENSUALES (sueldo, alquiler, internet...): un concepto (branch_recurring_costs) con VERSIONES por vigencia
--      (branch_recurring_cost_versions): append-only, nunca se pisa el importe de un período pasado. Cambiar el alquiler de 450.000 a
--      500.000 desde el 01/10 CIERRA la versión vigente y abre otra; agosto sigue valiendo 450.000.
--   2. GASTOS PUNTUALES (reparación, factura de luz...): una fila por gasto con fecha, concepto e importe (branch_expenses). Se anulan
--      (voided_*), no se borran.
--
-- PRORRATEO: cada versión se reparte en los días calendario de la ORGANIZACIÓN (organizations.timezone) de cada mes que toca el
-- período: importe_mensual * días_incluidos_del_mes / días_del_mes (nunca 30 fijo). Se redondea half-up UNA vez por concepto y período
-- (el desglose del modal y el total del período suman lo mismo). Un gasto puntual se imputa completo si su fecha cae dentro del período.
-- Los períodos son [p_from, p_to] en días calendario (incluyen el día de hoy completo).
--
-- Permisos: leer = analytics.read (como la ganancia bruta) + acceso a la sucursal; escribir = operating_costs.write (nuevo, el rol de
-- administración lo recibe) + acceso a la sucursal. Las tablas no tienen grants para ningún cliente: sólo las RPC SECURITY DEFINER.

-- ---------------------------------------------------------------------------------------------
-- 1. Permiso
-- ---------------------------------------------------------------------------------------------
insert into public.permissions (key, description)
values ('operating_costs.write', 'Configure branch operating costs (monthly costs and one-off expenses)')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
values ('10000000-0000-4000-8000-000000000001'::uuid, 'operating_costs.write')
on conflict (role_id, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 2. Tablas
-- ---------------------------------------------------------------------------------------------
create table public.branch_recurring_costs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- Clave de idempotencia del alta (doble clic / reintento no duplican el concepto).
  request_key uuid,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict
);
create index branch_recurring_costs_branch_idx on public.branch_recurring_costs (organization_id, branch_id);
create unique index branch_recurring_costs_request_key_idx on public.branch_recurring_costs (organization_id, request_key) where request_key is not null;

create table public.branch_recurring_cost_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  cost_id uuid not null,
  -- Importe MENSUAL en centavos enteros.
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  -- Días calendario de la organización: la versión rige de valid_from (inclusive) a valid_to (EXCLUSIVO; null = vigente).
  valid_from date not null check (valid_from >= date '2020-01-01'),
  valid_to date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (cost_id, organization_id) references public.branch_recurring_costs(id, organization_id) on delete restrict,
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  -- valid_to = valid_from es una versión VACÍA: una corrección del mismo día (queda en el historial, no rige ningún día).
  check (valid_to is null or valid_to >= valid_from),
  exclude using gist (cost_id with =, daterange(valid_from, valid_to, '[)') with &&)
);
create index branch_recurring_cost_versions_branch_idx on public.branch_recurring_cost_versions (organization_id, branch_id, valid_from);
create index branch_recurring_cost_versions_cost_idx on public.branch_recurring_cost_versions (cost_id, valid_from desc);

-- Append-only: nunca se borra ni se reescribe una versión. Lo único permitido es CERRAR la vigente (valid_to null -> fecha).
create function app_private.branch_recurring_cost_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'El historial de costos es append-only: no se borra' using errcode = '55000';
  end if;
  if old.valid_to is not null
     or new.valid_to is null
     or (new.id, new.organization_id, new.branch_id, new.cost_id, new.amount_cents, new.valid_from, new.created_by, new.created_at)
        is distinct from (old.id, old.organization_id, old.branch_id, old.cost_id, old.amount_cents, old.valid_from, old.created_by, old.created_at) then
    raise exception 'El historial de costos es append-only: sólo se puede cerrar la versión vigente' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.branch_recurring_cost_versions_guard() from public, anon, authenticated;
create trigger branch_recurring_cost_versions_guard
before update or delete on public.branch_recurring_cost_versions
for each row execute function app_private.branch_recurring_cost_versions_guard();

create table public.branch_expenses (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  -- Día calendario de la organización en que se imputa el gasto.
  expense_date date not null check (expense_date >= date '2020-01-01'),
  concept text not null check (char_length(btrim(concept)) between 1 and 120),
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  request_key uuid,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete set null,
  void_reason text check (void_reason is null or char_length(btrim(void_reason)) between 1 and 200),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  check (voided_at is not null or (voided_by is null and void_reason is null))
);
create index branch_expenses_branch_date_idx on public.branch_expenses (organization_id, branch_id, expense_date desc) where voided_at is null;
create unique index branch_expenses_request_key_idx on public.branch_expenses (organization_id, request_key) where request_key is not null;

alter table public.branch_recurring_costs enable row level security;
alter table public.branch_recurring_cost_versions enable row level security;
alter table public.branch_expenses enable row level security;
revoke all on table public.branch_recurring_costs from public, anon, authenticated;
revoke all on table public.branch_recurring_cost_versions from public, anon, authenticated;
revoke all on table public.branch_expenses from public, anon, authenticated;

comment on table public.branch_recurring_costs is
  'Concepto de costo mensual recurrente de una sucursal (sueldo, alquiler...). El importe vive en branch_recurring_cost_versions (versionado por vigencia).';
comment on table public.branch_recurring_cost_versions is
  'Versiones del importe mensual de un costo recurrente. Append-only: valid_from inclusive, valid_to exclusivo, null = vigente. Una versión con valid_to = valid_from es una corrección del mismo día (no rige ningún día).';
comment on table public.branch_expenses is
  'Gasto puntual de una sucursal (reparación, factura de luz...). Se imputa completo en expense_date. Se anula (voided_*), nunca se borra.';

-- ---------------------------------------------------------------------------------------------
-- 3. Cálculo (privado): prorrateo de un costo recurrente y totales por sucursal
-- ---------------------------------------------------------------------------------------------
-- Costo imputado de UN concepto recurrente a [p_from, p_to] (días calendario, ambos inclusive). Suma, mes por mes y versión por versión,
-- importe * días_incluidos / días_del_mes y redondea half-up una sola vez. Un mes que el período toca parcialmente cuenta sólo sus días.
create function app_private.recurring_cost_imputed_cents(p_cost_id uuid, p_from date, p_to date)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(round(sum(
    v.amount_cents::numeric
    * greatest(0, least(p_to + 1, coalesce(v.valid_to, date '9999-12-31'), (m.ms + interval '1 month')::date) - greatest(p_from, v.valid_from, m.ms::date))
    / extract(day from (m.ms + interval '1 month' - interval '1 day'))::numeric
  )), 0)::bigint
  from public.branch_recurring_cost_versions v
  cross join lateral generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') as m(ms)
  where v.cost_id = p_cost_id
    and v.valid_from <= p_to
    and coalesce(v.valid_to, date '9999-12-31') > p_from
$$;
revoke all on function app_private.recurring_cost_imputed_cents(uuid, date, date) from public, anon, authenticated;

-- Totales por sucursal (recurrentes prorrateados + gastos puntuales no anulados con fecha en el período). Una fila por sucursal pedida.
create function app_private.branch_operating_cost_totals(p_organization_id uuid, p_branch_ids uuid[], p_from date, p_to date)
returns table (branch_id uuid, recurring_cents bigint, expense_cents bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id,
    coalesce((
      select sum(app_private.recurring_cost_imputed_cents(c.id, p_from, p_to))
      from public.branch_recurring_costs c
      where c.organization_id = p_organization_id and c.branch_id = b.id
    ), 0)::bigint,
    coalesce((
      select sum(e.amount_cents)
      from public.branch_expenses e
      where e.organization_id = p_organization_id and e.branch_id = b.id and e.voided_at is null
        and e.expense_date between p_from and p_to
    ), 0)::bigint
  from unnest(p_branch_ids) as b(id)
$$;
revoke all on function app_private.branch_operating_cost_totals(uuid, uuid[], date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Lectura: resultado operativo por sucursal
-- ---------------------------------------------------------------------------------------------
-- Una fila por sucursal activa accesible (las mismas que get_branch_profitability_summary: la RPC existente aplica permiso, rango de
-- fechas, zona horaria, COMPLETED y acceso por sucursal; acá sólo se le suman los costos operativos).
--   operating_result_cents = gross_profit_cents - operating_cost_cents   (gross_profit sólo cuenta líneas con costo conocido)
--   operating_margin_bps   = resultado / ventas (revenue_cents) en basis points; null si no hubo ventas
--   is_partial             = hay líneas vendidas sin costo histórico: el resultado NO es exacto
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
  is_partial boolean
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
  ), costs as (
    select t.* from app_private.branch_operating_cost_totals(
      current_organization_id, (select coalesce(array_agg(p.branch_id), array[]::uuid[]) from profit p), p_from, p_to
    ) t
  )
  select p.branch_id, p.branch_name,
    p.revenue_cents,
    p.gross_profit_cents,
    c.recurring_cents,
    c.expense_cents,
    (c.recurring_cents + c.expense_cents)::bigint,
    (p.gross_profit_cents - c.recurring_cents - c.expense_cents)::bigint,
    case when p.revenue_cents > 0
      then round((p.gross_profit_cents - c.recurring_cents - c.expense_cents)::numeric * 10000 / p.revenue_cents)::bigint end,
    p.missing_cost_items,
    p.missing_cost_sales,
    p.missing_cost_revenue_cents,
    p.missing_cost_items > 0
  from profit p
  join costs c on c.branch_id = p.branch_id
  order by p.branch_name, p.branch_id;
end;
$$;
revoke all on function public.get_branch_operating_result(date, date, uuid) from public, anon;
grant execute on function public.get_branch_operating_result(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Lectura: el modal «Costos operativos» de UNA sucursal
-- ---------------------------------------------------------------------------------------------
-- Costos mensuales (importe vigente hoy, desde cuándo rige, lo imputado al período y su historial) + gastos puntuales (los 50 más
-- recientes por fecha, marcando los que caen en el período). p_from/p_to sólo definen "imputado al período".
create function public.get_branch_operating_costs(p_branch_id uuid, p_from date, p_to date)
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
  recurring jsonb;
  expenses jsonb;
  recurring_total bigint;
  expense_total bigint;
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

  return jsonb_build_object(
    'canWrite', can_write,
    'timezone', current_timezone,
    'today', local_today,
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'recurring', recurring,
    'expenses', expenses,
    'recurringCents', coalesce(recurring_total, 0),
    'expenseCents', coalesce(expense_total, 0),
    'operatingCostCents', coalesce(recurring_total, 0) + coalesce(expense_total, 0)
  );
end;
$$;
revoke all on function public.get_branch_operating_costs(uuid, date, date) from public, anon;
grant execute on function public.get_branch_operating_costs(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. Escritura
-- ---------------------------------------------------------------------------------------------
-- Alta de un costo mensual (p_cost_id null) o CAMBIO de importe/nombre de uno existente, con la fecha desde la que rige el importe nuevo.
-- Cambio de importe = cerrar la versión vigente en p_effective_from y abrir otra (el pasado no se toca). Reglas de fecha:
--   * p_effective_from > inicio de la versión vigente: la vigente se cierra ahí y el pasado conserva su importe;
--   * == inicio de la vigente: es una CORRECCIÓN del mismo día (la vigente queda vacía en el historial y la nueva la reemplaza);
--   * <  inicio de la vigente: se rechaza (no se reescribe una vigencia anterior).
--   * Un costo ya dado de baja puede reactivarse desde la fecha de baja o después.
-- Idempotente: el alta con la misma p_request_key devuelve el mismo concepto; repetir el mismo importe no crea otra versión.
create function public.save_branch_recurring_cost(
  p_branch_id uuid,
  p_cost_id uuid,
  p_name text,
  p_amount_cents bigint,
  p_effective_from date,
  p_request_key uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('operating_costs.write');
  current_timezone text;
  local_today date;
  clean_name text := btrim(coalesce(p_name, ''));
  cost_row public.branch_recurring_costs%rowtype;
  latest public.branch_recurring_cost_versions%rowtype;
  new_cost_id uuid;
  new_version_id uuid;
  changed boolean := false;
  had_latest boolean;
begin
  if char_length(clean_name) not between 1 and 80 then
    raise exception 'El nombre del costo tiene que tener entre 1 y 80 caracteres' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents not between 1 and 100000000000 then
    raise exception 'El importe mensual tiene que ser mayor a cero' using errcode = '22023';
  end if;
  if p_effective_from is null or p_effective_from < date '2020-01-01' then
    raise exception 'La fecha desde la que rige el costo no es válida' using errcode = '22023';
  end if;
  select o.timezone into current_timezone from public.organizations o where o.id = current_organization_id and o.active;
  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;
  local_today := (now() at time zone current_timezone)::date;
  if p_effective_from > local_today + 366 then
    raise exception 'La fecha desde la que rige el costo no puede estar a más de un año' using errcode = '22023';
  end if;
  if p_branch_id is null or not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;
  if not app_private.can_access_branch(current_organization_id, p_branch_id, 'operating_costs.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('branch_operating_costs:' || p_branch_id::text, 0));

  if p_cost_id is null then
    if p_request_key is not null then
      select * into cost_row from public.branch_recurring_costs c
      where c.organization_id = current_organization_id and c.request_key = p_request_key;
      if found then
        return jsonb_build_object('costId', cost_row.id, 'changed', false);
      end if;
    end if;
    insert into public.branch_recurring_costs (organization_id, branch_id, name, request_key, created_by)
    values (current_organization_id, p_branch_id, clean_name, p_request_key, auth.uid())
    returning id into new_cost_id;
    insert into public.branch_recurring_cost_versions (organization_id, branch_id, cost_id, amount_cents, valid_from, created_by)
    values (current_organization_id, p_branch_id, new_cost_id, p_amount_cents, p_effective_from, auth.uid())
    returning id into new_version_id;
    perform app_private.write_audit(current_organization_id, p_branch_id, 'BRANCH_RECURRING_COST_CREATED', 'branch_recurring_costs', new_cost_id,
      null, jsonb_build_object('name', clean_name, 'amount_cents', p_amount_cents, 'valid_from', p_effective_from));
    return jsonb_build_object('costId', new_cost_id, 'versionId', new_version_id, 'changed', true);
  end if;

  select * into cost_row from public.branch_recurring_costs c
  where c.id = p_cost_id and c.organization_id = current_organization_id and c.branch_id = p_branch_id
  for update;
  if not found then
    raise exception 'Cost was not found in this branch' using errcode = '42501';
  end if;

  if cost_row.name <> clean_name then
    update public.branch_recurring_costs set name = clean_name where id = cost_row.id;
    changed := true;
  end if;

  select * into latest from public.branch_recurring_cost_versions v
  where v.cost_id = cost_row.id and v.valid_to is distinct from v.valid_from
  order by v.valid_from desc, v.created_at desc
  limit 1
  for update;
  had_latest := found;

  if had_latest and latest.valid_to is null and latest.amount_cents = p_amount_cents then
    -- Mismo importe que el vigente: no hay nada que versionar (sólo pudo cambiar el nombre).
    if changed then
      perform app_private.write_audit(current_organization_id, p_branch_id, 'BRANCH_RECURRING_COST_RENAMED', 'branch_recurring_costs', cost_row.id,
        jsonb_build_object('name', cost_row.name), jsonb_build_object('name', clean_name));
    end if;
    return jsonb_build_object('costId', cost_row.id, 'changed', changed);
  end if;

  if had_latest then
    if latest.valid_to is null then
      if p_effective_from < latest.valid_from then
        raise exception 'El importe nuevo no puede regir desde antes del %: la vigencia anterior no se reescribe',
          to_char(latest.valid_from, 'DD/MM/YYYY') using errcode = '22023';
      end if;
      update public.branch_recurring_cost_versions set valid_to = p_effective_from where id = latest.id;
    elsif p_effective_from < latest.valid_to then
      raise exception 'Este costo se dio de baja el %: elegí esa fecha o una posterior para reactivarlo',
        to_char(latest.valid_to, 'DD/MM/YYYY') using errcode = '22023';
    end if;
  end if;

  insert into public.branch_recurring_cost_versions (organization_id, branch_id, cost_id, amount_cents, valid_from, created_by)
  values (current_organization_id, p_branch_id, cost_row.id, p_amount_cents, p_effective_from, auth.uid())
  returning id into new_version_id;

  perform app_private.write_audit(current_organization_id, p_branch_id, 'BRANCH_RECURRING_COST_VERSIONED', 'branch_recurring_costs', cost_row.id,
    case when had_latest then jsonb_build_object('amount_cents', latest.amount_cents, 'valid_from', latest.valid_from) end,
    jsonb_build_object('name', clean_name, 'amount_cents', p_amount_cents, 'valid_from', p_effective_from));
  return jsonb_build_object('costId', cost_row.id, 'versionId', new_version_id, 'changed', true);
end;
$$;
revoke all on function public.save_branch_recurring_cost(uuid, uuid, text, bigint, date, uuid) from public, anon;
grant execute on function public.save_branch_recurring_cost(uuid, uuid, text, bigint, date, uuid) to authenticated;

-- Dar de baja un costo mensual: deja de aplicarse DESDE p_effective_to (el día anterior es el último). El historial queda.
create function public.end_branch_recurring_cost(p_cost_id uuid, p_effective_to date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('operating_costs.write');
  cost_row public.branch_recurring_costs%rowtype;
  latest public.branch_recurring_cost_versions%rowtype;
begin
  if p_effective_to is null or p_effective_to < date '2020-01-01' then
    raise exception 'La fecha de baja no es válida' using errcode = '22023';
  end if;
  select * into cost_row from public.branch_recurring_costs c
  where c.id = p_cost_id and c.organization_id = current_organization_id for update;
  if not found then
    raise exception 'Cost was not found in this organization' using errcode = '42501';
  end if;
  if not app_private.can_access_branch(current_organization_id, cost_row.branch_id, 'operating_costs.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('branch_operating_costs:' || cost_row.branch_id::text, 0));

  select * into latest from public.branch_recurring_cost_versions v
  where v.cost_id = cost_row.id and v.valid_to is null
  for update;
  if not found then
    return jsonb_build_object('costId', cost_row.id, 'changed', false);
  end if;
  if p_effective_to < latest.valid_from then
    raise exception 'La baja no puede ser anterior al %, cuando empezó a regir el importe vigente', to_char(latest.valid_from, 'DD/MM/YYYY') using errcode = '22023';
  end if;
  update public.branch_recurring_cost_versions set valid_to = p_effective_to where id = latest.id;
  perform app_private.write_audit(current_organization_id, cost_row.branch_id, 'BRANCH_RECURRING_COST_ENDED', 'branch_recurring_costs', cost_row.id,
    jsonb_build_object('amount_cents', latest.amount_cents, 'valid_from', latest.valid_from), jsonb_build_object('valid_to', p_effective_to));
  return jsonb_build_object('costId', cost_row.id, 'changed', true);
end;
$$;
revoke all on function public.end_branch_recurring_cost(uuid, date) from public, anon;
grant execute on function public.end_branch_recurring_cost(uuid, date) to authenticated;

-- Registrar un gasto puntual. Idempotente por p_request_key (doble clic / reintento devuelven el mismo gasto).
create function public.record_branch_expense(
  p_branch_id uuid,
  p_expense_date date,
  p_concept text,
  p_amount_cents bigint,
  p_request_key uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('operating_costs.write');
  current_timezone text;
  clean_concept text := btrim(coalesce(p_concept, ''));
  existing public.branch_expenses%rowtype;
  new_id uuid;
begin
  if char_length(clean_concept) not between 1 and 120 then
    raise exception 'El concepto del gasto tiene que tener entre 1 y 120 caracteres' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents not between 1 and 100000000000 then
    raise exception 'El importe del gasto tiene que ser mayor a cero' using errcode = '22023';
  end if;
  select o.timezone into current_timezone from public.organizations o where o.id = current_organization_id and o.active;
  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;
  if p_expense_date is null or p_expense_date < date '2020-01-01' or p_expense_date > (now() at time zone current_timezone)::date then
    raise exception 'La fecha del gasto no puede estar en el futuro' using errcode = '22023';
  end if;
  if p_branch_id is null or not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;
  if not app_private.can_access_branch(current_organization_id, p_branch_id, 'operating_costs.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  if p_request_key is not null then
    select * into existing from public.branch_expenses e
    where e.organization_id = current_organization_id and e.request_key = p_request_key;
    if found then
      return jsonb_build_object('expenseId', existing.id, 'changed', false);
    end if;
  end if;

  insert into public.branch_expenses (organization_id, branch_id, expense_date, concept, amount_cents, request_key, created_by)
  values (current_organization_id, p_branch_id, p_expense_date, clean_concept, p_amount_cents, p_request_key, auth.uid())
  returning id into new_id;
  perform app_private.write_audit(current_organization_id, p_branch_id, 'BRANCH_EXPENSE_RECORDED', 'branch_expenses', new_id,
    null, jsonb_build_object('expense_date', p_expense_date, 'concept', clean_concept, 'amount_cents', p_amount_cents));
  return jsonb_build_object('expenseId', new_id, 'changed', true);
end;
$$;
revoke all on function public.record_branch_expense(uuid, date, text, bigint, uuid) from public, anon;
grant execute on function public.record_branch_expense(uuid, date, text, bigint, uuid) to authenticated;

-- Anular un gasto (queda en la base con quién y por qué; deja de imputarse). Anular dos veces no hace nada.
create function public.void_branch_expense(p_expense_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('operating_costs.write');
  clean_reason text := btrim(coalesce(p_reason, ''));
  expense_row public.branch_expenses%rowtype;
begin
  if char_length(clean_reason) not between 1 and 200 then
    raise exception 'Indicá el motivo de la anulación (hasta 200 caracteres)' using errcode = '22023';
  end if;
  select * into expense_row from public.branch_expenses e
  where e.id = p_expense_id and e.organization_id = current_organization_id for update;
  if not found then
    raise exception 'Expense was not found in this organization' using errcode = '42501';
  end if;
  if not app_private.can_access_branch(current_organization_id, expense_row.branch_id, 'operating_costs.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if expense_row.voided_at is not null then
    return jsonb_build_object('expenseId', expense_row.id, 'changed', false);
  end if;
  update public.branch_expenses set voided_at = now(), voided_by = auth.uid(), void_reason = clean_reason where id = expense_row.id;
  perform app_private.write_audit(current_organization_id, expense_row.branch_id, 'BRANCH_EXPENSE_VOIDED', 'branch_expenses', expense_row.id,
    jsonb_build_object('expense_date', expense_row.expense_date, 'concept', expense_row.concept, 'amount_cents', expense_row.amount_cents),
    jsonb_build_object('void_reason', clean_reason));
  return jsonb_build_object('expenseId', expense_row.id, 'changed', true);
end;
$$;
revoke all on function public.void_branch_expense(uuid, text) from public, anon;
grant execute on function public.void_branch_expense(uuid, text) to authenticated;

commit;
