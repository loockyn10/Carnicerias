begin;

-- Anular un fichaje incorrecto (D-099).
--
-- PROBLEMA: un fichaje que quedó abierto por error (la caja siguió latiendo, o el empleado nunca marcó salida) suma horas que nadie trabajó y
-- esas horas se valúan con el valor hora y entran en el costo de personal -> distorsionan el Resultado operativo de la sucursal (D-085).
-- La única herramienta administrativa existente era public.correct_employee_shift, que sólo CAMBIA LA HORA DE SALIDA: sirve cuando el empleado
-- trabajó, pero no para un fichaje que no corresponde (dejarlo "entrada = salida" lo disfrazaría de una jornada de 0 minutos).
--
-- QUÉ HACE ESTA MIGRACIÓN
--   1) employee_shifts.voided_at / voided_by / void_reason: el fichaje ANULADO se CONSERVA en el historial (no se borra ni se edita su
--      entrada/salida/estado; la auditoría guarda el antes y el después) pero deja de contar en TODO: horas, costo de personal, reporte de
--      horas, turnos pendientes de revisión, turno activo del POS, latido y aviso del selector de operador.
--   2) public.void_employee_shift(p_shift_id, p_reason): la acción administrativa (timekeeping.write + acceso a la sucursal del fichaje,
--      motivo obligatorio, auditada, no se puede anular dos veces).
--   3) El índice de «una sola fichada abierta por empleado» ignora las anuladas: anular una fichada abierta libera al empleado para volver a
--      fichar. Una salida que llegue desde la cola del POS para un fichaje anulado se trata como duplicado inofensivo.
--   4) Tope de las fichadas NO confirmadas en el costo de personal: una fichada sin salida confirmada (REQUIRES_REVIEW con salida inferida por
--      latido, o abierta) cuenta como máximo entrada + organizations.max_shift_hours hasta que alguien la corrija. Antes el tope sólo
--      alcanzaba a las que no tenían salida: un cierre inferido tras reiniciar una caja que siguió latiendo por su cuenta días enteros
--      (fichada "abierta" 175 h) sumaba todos esos días. Las fichadas CLOSED (salida confirmada) no cambian.
--
-- Nada se recalcula ni se escribe: el costo de personal se calcula al consultar (D-085), así que anular un fichaje cambia al instante el
-- Resultado operativo, el modal de Costos operativos, el Resumen de sucursal y el reporte de horas, sin migrar ni tocar otros datos.
-- Las funciones que se re-crean tienen el cuerpo VIGENTE salvo lo indicado (filtro de anulados y, en el costo, el tope del punto 4).

alter table public.employee_shifts
  add column voided_at timestamptz,
  add column voided_by uuid references public.profiles(id) on delete restrict,
  add column void_reason text,
  add constraint employee_shifts_void_consistent check (
    (voided_at is null and voided_by is null and void_reason is null)
    or (voided_at is not null and voided_by is not null and char_length(btrim(void_reason)) between 3 and 500)
  );

drop index public.employee_shifts_one_open_uq;
create unique index employee_shifts_one_open_uq
  on public.employee_shifts (organization_id, employee_id)
  where clock_out_at is null and voided_at is null;

create function public.void_employee_shift(p_shift_id uuid, p_reason text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  org_id uuid := app_private.require_permission('timekeeping.write');
  shift_row public.employee_shifts%rowtype;
  before_row jsonb;
begin
  if p_reason is null or char_length(btrim(p_reason)) < 3 or char_length(btrim(p_reason)) > 500 then
    raise exception 'El motivo es obligatorio (entre 3 y 500 caracteres)' using errcode = '22023';
  end if;
  select * into shift_row from public.employee_shifts s where s.id = p_shift_id and s.organization_id = org_id for update;
  if not found then raise exception 'Fichaje no encontrado' using errcode = '22023'; end if;
  if not app_private.can_access_branch(org_id, shift_row.branch_id, 'timekeeping.write') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if shift_row.voided_at is not null then raise exception 'El fichaje ya está anulado' using errcode = '22023'; end if;
  before_row := to_jsonb(shift_row);
  update public.employee_shifts
  set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason), updated_at = now()
  where id = p_shift_id;
  perform app_private.write_audit(org_id, shift_row.branch_id, 'EMPLOYEE_SHIFT_VOIDED', 'employee_shift', p_shift_id, before_row,
    (select to_jsonb(s) from public.employee_shifts s where s.id = p_shift_id));
end;
$$;
revoke all on function public.void_employee_shift(uuid, text) from public, anon;
grant execute on function public.void_employee_shift(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Funciones que dejan de ver los fichajes anulados (cuerpo vigente + filtro `voided_at is null`)
-- ---------------------------------------------------------------------------------------------

-- Barrido de turnos vencidos (vigente: 202609280037).
create or replace function app_private.mark_overdue_shifts(p_organization_id uuid, p_as_of timestamptz default now())
returns void language plpgsql volatile security definer set search_path = '' as $$
declare heartbeat_grace interval := interval '90 seconds';
begin
  update public.employee_shifts s
  set status = 'REQUIRES_REVIEW', updated_at = p_as_of
  from public.organizations o
  where o.id = p_organization_id
    and s.organization_id = o.id
    and s.status = 'OPEN'
    and s.voided_at is null
    and s.clock_out_at is null
    and s.clock_in_at + make_interval(hours => o.max_shift_hours) < p_as_of
    and (s.last_heartbeat_at is null or p_as_of - s.last_heartbeat_at <= heartbeat_grace);

  update public.employee_shifts s
  set status = 'REQUIRES_REVIEW',
      clock_out_at = s.last_heartbeat_at,
      clock_out_source = 'OFFLINE',
      clock_out_received_at = p_as_of,
      auto_closed_by_heartbeat = true,
      updated_at = p_as_of
  where s.organization_id = p_organization_id
    and s.status = 'OPEN'
    and s.voided_at is null
    and s.clock_out_at is null
    and s.last_heartbeat_at is not null
    and p_as_of - s.last_heartbeat_at > heartbeat_grace;
end;
$$;

-- Turno activo que consulta el POS (vigente: 202609130018).
create or replace function public.get_current_employee_shift(p_device_id uuid,p_employee_id uuid,p_operator_token text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare access record; shift_row public.employee_shifts%rowtype;
begin
 select * into access from app_private.resolve_pos_operator(p_device_id,p_employee_id,p_operator_token,now());
 perform app_private.mark_overdue_shifts(access.organization_id);
 select * into shift_row from public.employee_shifts s where s.organization_id=access.organization_id and s.employee_id=p_employee_id and s.clock_out_at is null and s.voided_at is null order by s.clock_in_at desc limit 1;
 if shift_row.id is null then return null; end if;
 return jsonb_build_object('shiftId',shift_row.id,'status',shift_row.status,'clockInAt',shift_row.clock_in_at,'clockOutAt',shift_row.clock_out_at,
   'clockInSource',shift_row.clock_in_source,'clockOutSource',shift_row.clock_out_source);
end;
$$;

-- Latido de presencia (vigente: 202609280037).
create or replace function public.record_shift_heartbeat(
  p_device_id uuid, p_employee_id uuid, p_operator_token text, p_occurred_at timestamptz default clock_timestamp()
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare access record; updated public.employee_shifts%rowtype;
begin
  select * into access from app_private.resolve_pos_operator(p_device_id, p_employee_id, p_operator_token, p_occurred_at);
  if not found then raise exception 'Operator is not authorized' using errcode = '42501'; end if;
  perform app_private.mark_overdue_shifts(access.organization_id, p_occurred_at);
  update public.employee_shifts
  set last_heartbeat_at = greatest(coalesce(last_heartbeat_at, p_occurred_at), p_occurred_at),
      updated_at = now()
  where organization_id = access.organization_id
    and employee_id = p_employee_id
    and status = 'OPEN'
    and clock_out_at is null
    and voided_at is null
  returning * into updated;
  return jsonb_build_object('shiftId', updated.id, 'accepted', updated.id is not null, 'lastHeartbeatAt', updated.last_heartbeat_at);
end;
$$;

-- Evento de fichaje (vigente: 202611140101).
create or replace function app_private.apply_employee_time_event(
  p_device_id uuid, p_event_id uuid, p_shift_id uuid, p_employee_id uuid,
  p_operator_token text, p_action public.time_event_action,
  p_source public.time_event_source, p_occurred_at timestamptz, p_received_at timestamptz,
  p_inferred boolean default false
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  access record; existing_event public.employee_time_events%rowtype;
  current_shift public.employee_shifts%rowtype; max_hours smallint;
begin
  if p_source = 'OFFLINE' then
    select * into access from app_private.resolve_pos_operator_for_sync(p_device_id, p_employee_id);
  else
    select * into access from app_private.resolve_pos_operator(p_device_id, p_employee_id, p_operator_token, p_occurred_at);
  end if;
  if not found then raise exception 'Operator is not authorized' using errcode='42501'; end if;
  -- Sucursal sin fichaje: no-op idempotente (D-096).
  if not exists (select 1 from public.branches b where b.id = access.branch_id and b.timekeeping_enabled) then
    return jsonb_build_object('disabled', true, 'duplicate', false);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(access.organization_id::text || ':' || p_employee_id::text, 0));
  select * into existing_event from public.employee_time_events e where e.event_id=p_event_id;
  if found then
    if existing_event.device_id<>p_device_id or existing_event.employee_id<>p_employee_id or existing_event.action<>p_action then
      raise exception 'Time event id was reused with different data' using errcode='23505';
    end if;
    select * into current_shift from public.employee_shifts s where s.id=existing_event.shift_id;
    return jsonb_build_object('shiftId',current_shift.id,'status',current_shift.status,'clockInAt',current_shift.clock_in_at,
      'clockOutAt',current_shift.clock_out_at,'clockInSource',current_shift.clock_in_source,'clockOutSource',current_shift.clock_out_source,'duplicate',true);
  end if;
  perform app_private.mark_overdue_shifts(access.organization_id, p_received_at);
  select o.max_shift_hours into max_hours from public.organizations o where o.id=access.organization_id;
  select * into current_shift from public.employee_shifts s
  where s.organization_id=access.organization_id and s.employee_id=p_employee_id and s.clock_out_at is null and s.voided_at is null for update;

  if p_action='CLOCK_IN' then
    if current_shift.id is not null then
      if current_shift.status='REQUIRES_REVIEW' then
        raise exception 'Tenés un turno anterior pendiente de revisión' using errcode='P0001';
      end if;
      return jsonb_build_object('shiftId',current_shift.id,'status',current_shift.status,'clockInAt',current_shift.clock_in_at,
        'clockOutAt',null,'clockInSource',current_shift.clock_in_source,'clockOutSource',null,'duplicate',true);
    end if;
    insert into public.employee_shifts(id,organization_id,branch_id,employee_id,device_id,clock_in_at,clock_in_source,clock_in_received_at,status)
    values(p_shift_id,access.organization_id,access.branch_id,p_employee_id,p_device_id,p_occurred_at,p_source,p_received_at,'OPEN')
    returning * into current_shift;
  else
    if current_shift.id is null then
      -- Una salida (o cierre inferido) que llega para un fichaje ANULADO por el administrador es un duplicado inofensivo: no hay turno activo
      -- que cerrar y la cola del POS no debe quedar trabada reintentando para siempre.
      if p_inferred or exists (select 1 from public.employee_shifts v where v.id=p_shift_id and v.voided_at is not null) then
        select * into current_shift from public.employee_shifts s where s.id=p_shift_id;
        if current_shift.id is not null then
          return jsonb_build_object('shiftId',current_shift.id,'status',current_shift.status,'clockInAt',current_shift.clock_in_at,
            'clockOutAt',current_shift.clock_out_at,'clockInSource',current_shift.clock_in_source,'clockOutSource',current_shift.clock_out_source,'duplicate',true);
        end if;
      end if;
      raise exception 'No hay un turno activo para marcar salida' using errcode='P0001';
    end if;
    if p_occurred_at < current_shift.clock_in_at then raise exception 'La salida no puede ser anterior a la entrada' using errcode='22023'; end if;
    if p_inferred then
      update public.employee_shifts set clock_out_at=p_occurred_at,clock_out_source=p_source,clock_out_received_at=p_received_at,
        status='REQUIRES_REVIEW',auto_closed_by_heartbeat=true,updated_at=p_received_at
      where id=current_shift.id returning * into current_shift;
    elsif current_shift.status='REQUIRES_REVIEW' or p_occurred_at-current_shift.clock_in_at > make_interval(hours=>max_hours) then
      update public.employee_shifts set status='REQUIRES_REVIEW',updated_at=p_received_at where id=current_shift.id returning * into current_shift;
      return jsonb_build_object('shiftId',current_shift.id,'status',current_shift.status,'clockInAt',current_shift.clock_in_at,
        'clockOutAt',null,'clockInSource',current_shift.clock_in_source,'clockOutSource',null,'requiresReview',true);
    else
      update public.employee_shifts set clock_out_at=p_occurred_at,clock_out_source=p_source,clock_out_received_at=p_received_at,status='CLOSED',updated_at=p_received_at
      where id=current_shift.id returning * into current_shift;
    end if;
  end if;

  insert into public.employee_time_events(event_id,shift_id,organization_id,branch_id,employee_id,device_id,action,source,occurred_at,received_at)
  values(p_event_id,current_shift.id,access.organization_id,access.branch_id,p_employee_id,p_device_id,p_action,p_source,p_occurred_at,p_received_at);
  perform app_private.write_audit(access.organization_id,access.branch_id,
    case when p_action='CLOCK_IN' then 'EMPLOYEE_CLOCK_IN' else 'EMPLOYEE_CLOCK_OUT' end,
    'employee_shift',current_shift.id,null,jsonb_build_object('employeeId',p_employee_id,'source',p_source,'occurredAt',p_occurred_at,'receivedAt',p_received_at,'inferred',p_inferred));
  return jsonb_build_object('shiftId',current_shift.id,'status',current_shift.status,'clockInAt',current_shift.clock_in_at,
    'clockOutAt',current_shift.clock_out_at,'clockInSource',current_shift.clock_in_source,'clockOutSource',current_shift.clock_out_source,'duplicate',false);
end;
$$;
revoke all on function app_private.apply_employee_time_event(
  uuid, uuid, uuid, uuid, text, public.time_event_action, public.time_event_source, timestamptz, timestamptz, boolean
) from public, anon, authenticated;

-- Selector de operador del POS: el aviso «turno por revisar» ya no cuenta fichajes anulados (vigente: 202609280039).
create or replace function public.get_pos_operator_roster(p_device_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); org_id uuid; branch_uuid uuid; result jsonb;
begin
  select d.organization_id, d.branch_id into org_id, branch_uuid
  from public.pos_devices d where d.id = p_device_id and d.status = 'ACTIVE';
  if actor is null or org_id is null or not app_private.can_access_branch(org_id, branch_uuid, 'sales.create') then
    raise exception 'Device is not authorized' using errcode = '42501';
  end if;
  perform app_private.mark_overdue_shifts(org_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'profileId', q.profile_id, 'displayName', q.display_name, 'roleName', q.role_name,
    'hasPin', q.has_pin, 'hasShiftIssue', q.has_shift_issue
  ) order by q.display_name), '[]'::jsonb) into result
  from (
    select p.id profile_id, p.display_name, r.name role_name,
      exists(select 1 from public.employee_pos_pins pin where pin.organization_id = org_id and pin.profile_id = p.id) has_pin,
      exists(select 1 from public.employee_shifts s where s.organization_id = org_id and s.employee_id = p.id and s.status = 'REQUIRES_REVIEW' and s.voided_at is null) has_shift_issue
    from public.organization_members om
    join public.profiles p on p.id = om.profile_id and p.active
    join public.roles r on r.id = om.role_id
    where om.organization_id = org_id and om.status = 'ACTIVE'
      and r.key = 'employee'
      and exists(select 1 from public.branch_members bm where bm.organization_id = org_id and bm.branch_id = branch_uuid and bm.profile_id = p.id and bm.active)
  ) q;
  return jsonb_build_object('operators',result,'maxShiftHours',(select o.max_shift_hours from public.organizations o where o.id=org_id));
end;
$$;

-- Costo de personal (vigente: 202610200083): sin anulados y con el tope de las fichadas no confirmadas (punto 4).
create or replace function app_private.branch_labor_cost_rows(
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
        -- Salida CONFIRMADA (el empleado o el administrador): cuenta completa.
        when s.status = 'CLOSED' then s.clock_out_at
        -- Todo lo demás es una inferencia sin confirmar (salida inferida por latido, fichada abierta): nunca más de entrada + max_shift_hours.
        -- Sin este tope, un cierre inferido tras reiniciar una caja que siguió latiendo localmente días enteros sumaba esos días como horas.
        when s.clock_out_at is not null then least(s.clock_out_at, s.clock_in_at + make_interval(hours => w.max_shift_hours::integer))
        when s.status = 'OPEN' and s.last_heartbeat_at is not null and p_as_of - s.last_heartbeat_at > interval '90 seconds'
          then least(s.last_heartbeat_at, p_as_of, s.clock_in_at + make_interval(hours => w.max_shift_hours::integer))
        else least(p_as_of, s.clock_in_at + make_interval(hours => w.max_shift_hours::integer))
      end as end_at
    from public.employee_shifts s
    cross join win w
    where s.organization_id = p_organization_id
      and s.branch_id = any(p_branch_ids)
      and s.clock_in_at < w.to_at
      and s.voided_at is null
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

-- Reporte de horas del Admin (vigente: 202609280037): los anulados salen en el historial (voidedAt / voidReason) con 0 horas y 0 importe.
create or replace function public.get_timekeeping_report(p_from date,p_to date,p_employee_id uuid default null,p_branch_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare org_id uuid:=app_private.require_permission('timekeeping.read'); tz text; from_at timestamptz; to_at timestamptz; result jsonb;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>92 then raise exception 'Período inválido' using errcode='22023'; end if;
 select o.timezone into tz from public.organizations o where o.id=org_id;
 from_at:=p_from::timestamp at time zone tz;
 to_at:=(p_to+1)::timestamp at time zone tz;
 perform app_private.mark_overdue_shifts(org_id);
 with selected as (
   select s.*,p.display_name,b.name branch_name,
     case when s.status='CLOSED' and s.voided_at is null then extract(epoch from (least(s.clock_out_at,to_at)-greatest(s.clock_in_at,from_at)))::bigint else 0 end duration_seconds
   from public.employee_shifts s join public.profiles p on p.id=s.employee_id join public.branches b on b.id=s.branch_id
   where s.organization_id=org_id and s.clock_in_at<to_at and coalesce(s.clock_out_at,now())>=from_at
     and (p_employee_id is null or s.employee_id=p_employee_id) and (p_branch_id is null or s.branch_id=p_branch_id)
 ), pay as (
   select s.id,coalesce(sum(round(r.rate_cents_per_hour::numeric * extract(epoch from (least(s.clock_out_at,coalesce(r.valid_to,to_at),to_at)-greatest(s.clock_in_at,r.valid_from,from_at)))/3600)),0)::bigint estimated_cents,
     coalesce(sum(extract(epoch from (least(s.clock_out_at,coalesce(r.valid_to,to_at),to_at)-greatest(s.clock_in_at,r.valid_from,from_at)))),0)::bigint covered_seconds
   from selected s join public.employee_hourly_rates r on r.organization_id=org_id and r.employee_id=s.employee_id
     and s.status='CLOSED' and s.voided_at is null and tstzrange(r.valid_from,r.valid_to,'[)') && tstzrange(greatest(s.clock_in_at,from_at),least(s.clock_out_at,to_at),'[)')
   group by s.id
 ), employee_totals as (
   select s.employee_id,s.display_name,sum(s.duration_seconds)::bigint duration_seconds,coalesce(sum(pay.estimated_cents),0)::bigint estimated_cents,
     sum(s.duration_seconds)::bigint=coalesce(sum(pay.covered_seconds),0)::bigint rate_complete
   from selected s left join pay on pay.id=s.id where s.status='CLOSED' and s.voided_at is null group by s.employee_id,s.display_name
 )
 select jsonb_build_object(
   'from',p_from,'to',p_to,'maxShiftHours',(select o.max_shift_hours from public.organizations o where o.id=org_id),
   'employees',coalesce((select jsonb_agg(to_jsonb(e) order by e.display_name) from employee_totals e),'[]'::jsonb),
   'shifts',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'employeeId',s.employee_id,'employeeName',s.display_name,'branchId',s.branch_id,'branchName',s.branch_name,'clockInAt',s.clock_in_at,'clockOutAt',s.clock_out_at,'clockInSource',s.clock_in_source,'clockOutSource',s.clock_out_source,'status',s.status,'durationSeconds',s.duration_seconds,'estimatedCents',coalesce(pay.estimated_cents,0),'rateComplete',s.duration_seconds=coalesce(pay.covered_seconds,0),'autoClosedByHeartbeat',s.auto_closed_by_heartbeat,'voidedAt',s.voided_at,'voidReason',s.void_reason) order by s.clock_in_at desc) from selected s left join pay on pay.id=s.id),'[]'::jsonb),
   'review',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'employeeId',s.employee_id,'employeeName',s.display_name,'branchId',s.branch_id,'branchName',s.branch_name,'clockInAt',s.clock_in_at,'clockInSource',s.clock_in_source,'clockOutAt',s.clock_out_at,'autoClosedByHeartbeat',s.auto_closed_by_heartbeat) order by s.clock_in_at) from selected s where s.status='REQUIRES_REVIEW' and s.voided_at is null),'[]'::jsonb)
 ) into result;
 return result;
end;
$$;

commit;
