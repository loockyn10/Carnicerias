begin;

-- Fichaje de empleados (entrada/salida/turnos) configurable POR SUCURSAL. Incremental: no edita 018/037/038/048.
--
-- Contexto: en Central NO se usa el control horario. Antes el POS exigía «Marcar entrada» tras el PIN y, al salir,
-- encolaba un CLOCK_OUT; si el servidor ya había cerrado ese turno (barrido de lease/heartbeat tras horas con la
-- sesión técnica vencida) o nunca lo recibió, `sync_offline_time_event` fallaba para siempre con
-- P0001 «No hay un turno activo para marcar salida» y ese evento trababa el resto de la cola de sincronización.
--
--   1. `branches.timekeeping_enabled` (default true: toda sucursal conserva el fichaje salvo decisión explícita).
--   2. Datos: se apaga SÓLO en la sucursal productiva configurada (`organizations.production_branch_id`, es decir Central;
--      nunca por nombre, D-033/D-058). Ningún turno, evento ni tarifa histórica se toca ni se borra.
--   3. `app_private.apply_employee_time_event` (misma firma de 10 parámetros): si la sucursal del dispositivo no lleva
--      fichaje devuelve un no-op `{"disabled":true}` ANTES de buscar turnos: no crea turno, no inserta evento, no audita
--      y no falla. Así los CLOCK_IN/CLOCK_OUT/inferidos que ya estaban en la cola de un POS de Central se marcan
--      sincronizados y se descartan sin intervención manual. `record_employee_time_event` y `sync_offline_time_event`
--      lo llaman tal cual y no cambian (para un CLOCK_IN sin turno `sync_offline_time_event` ya tolera el resultado vacío).
--   4. `get_pos_device_capabilities` (misma firma) suma `timekeepingEnabled` para que el POS lo recuerde por sucursal.
--
-- No toca ventas, caja, arqueos, stock ni movimientos financieros. Para volver a habilitar el fichaje en una sucursal:
--   update public.branches set timekeeping_enabled = true where id = '<sucursal>';

alter table public.branches
  add column timekeeping_enabled boolean not null default true;

comment on column public.branches.timekeeping_enabled is
  'false = la sucursal no usa fichaje de empleados: el POS no exige entrada/salida y el servidor ignora (no-op) los eventos de turno de sus dispositivos. El PIN y las ventas no dependen de esto.';

update public.branches b
set timekeeping_enabled = false
where b.id in (select o.production_branch_id from public.organizations o where o.production_branch_id is not null);

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
  select * into access from app_private.resolve_pos_operator(p_device_id, p_employee_id, p_operator_token, p_occurred_at);
  if not found then raise exception 'Operator is not authorized' using errcode='42501'; end if;
  -- Sucursal sin fichaje: no-op idempotente (la autorización del operador ya se validó arriba).
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
  where s.organization_id=access.organization_id and s.employee_id=p_employee_id and s.clock_out_at is null for update;

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
      -- A heartbeat-inferred close synthesized after a restart may arrive
      -- after the server already closed the same shift on its own (the
      -- lease-expiry sweep above). Treat that as a harmless duplicate
      -- instead of failing forever in the outbox.
      if p_inferred then
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

create or replace function public.get_pos_device_capabilities(p_device_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_branch uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select d.organization_id, d.branch_id into v_org, v_branch
  from public.pos_devices d
  where d.id = p_device_id and d.status = 'ACTIVE';
  if v_org is null or not app_private.can_access_branch(v_org, v_branch, 'sales.create') then
    raise exception 'Device is not authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'branchId', v_branch,
    'quickProductCreate', exists (
      select 1 from public.organizations o where o.id = v_org and o.production_branch_id = v_branch
    ),
    'timekeepingEnabled', coalesce((select b.timekeeping_enabled from public.branches b where b.id = v_branch), true)
  );
end;
$$;

revoke all on function public.get_pos_device_capabilities(uuid) from public, anon;
grant execute on function public.get_pos_device_capabilities(uuid) to authenticated;

commit;
