begin;

-- POS: el operador se IDENTIFICA, no se re-autoriza con un token que vence (D-097). Incremental: no edita 018/019/037/048/091/100.
--
-- Problema estructural: una venta o evento de turno hecho offline viajaba con el token del operador y, al sincronizar,
-- `app_private.resolve_pos_operator` lo volvía a validar contra una ventana de 7 días medida con el RELOJ DE LA PC
-- (`occurred_at between issued_at - 5 min and valid_until`), la revocación y `issued_by = auth.uid()`. Cualquiera de esas
-- condiciones (reloj atrasado, PIN cambiado o empleado desactivado después de la venta, sesión técnica distinta, más de
-- 7 días offline) hacía fallar la venta para siempre con 42501 «POS operator authorization is invalid, expired, or revoked»:
-- una venta legítima ya cobrada quedaba como «pendiente» y el evento trababa la cola.
--
-- Nueva separación:
--   1. Instalación/sesión del POS: la sesión técnica de Supabase + `pos_devices` ACTIVE + `can_access_branch(..., 'sales.create')`.
--      Es el límite de acceso a los datos de la organización y de la sucursal; no cambia.
--   2. Identificación del empleado: el PIN (`verify_pos_operator_pin`). El empleado de una venta sincronizada se valida con
--      `app_private.resolve_pos_operator_for_sync`: debe ser miembro (de cualquier estado: la historia no se pierde) de la
--      MISMA organización del dispositivo. Sin token, sin vencimiento, sin revocación: es sólo atribución de una venta que ya ocurrió.
--   3. Sincronización: `sync_pos_operator_offline_sale` y los eventos de turno OFFLINE usan (2). Las acciones EN VIVO (precio
--      rápido, alta de producto, Mercado Pago, WhatsApp, turno online) siguen exigiendo el token del PIN y su revocación, pero el
--      token ya no vence ni queda atado al usuario técnico que lo emitió: vale hasta que Admin cambie el PIN o desactive al empleado.
--
-- No toca ventas, stock, caja, pricing ni registros existentes. No borra ni modifica grants. Para ventas ya encoladas en un POS
-- con el error 42501 no hace falta ninguna acción manual: el próximo reintento de la cola las sincroniza (con idempotencia por event id).

-- 1) Identificación del operador para sincronizar (sin token, sin vencimiento).
create function app_private.resolve_pos_operator_for_sync(p_device_id uuid, p_operator_profile_id uuid)
returns table (organization_id uuid, branch_id uuid, operator_profile_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  return query
  select d.organization_id, d.branch_id, om.profile_id
  from public.pos_devices d
  join public.organization_members om on om.organization_id = d.organization_id and om.profile_id = p_operator_profile_id
  where d.id = p_device_id
    and d.status = 'ACTIVE'
    and app_private.can_access_branch(d.organization_id, d.branch_id, 'sales.create');
  if not found then
    raise exception 'POS device is not authorized for this operator' using errcode = '42501';
  end if;
end;
$$;

revoke all on function app_private.resolve_pos_operator_for_sync(uuid, uuid) from public, anon, authenticated;

-- 2) Acciones en vivo: token persistente (hasta revocación explícita), sin ventana de fechas ni `issued_by`.
create or replace function app_private.resolve_pos_operator(
  p_device_id uuid,
  p_operator_profile_id uuid,
  p_operator_token text,
  p_occurred_at timestamptz default now()
)
returns table (organization_id uuid, branch_id uuid, operator_profile_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  hashed_token text;
begin
  if auth.uid() is null or p_operator_token is null or char_length(p_operator_token) < 32 then
    raise exception 'Valid POS operator authorization is required' using errcode = '42501';
  end if;
  hashed_token := encode(extensions.digest(convert_to(p_operator_token, 'UTF8'), 'sha256'), 'hex');
  return query
  select g.organization_id, g.branch_id, g.operator_profile_id
  from public.pos_operator_grants g
  join public.pos_devices d on d.id = g.device_id and d.status = 'ACTIVE'
  join public.organization_members om on om.organization_id = g.organization_id
    and om.profile_id = g.operator_profile_id and om.status = 'ACTIVE'
  join public.profiles p on p.id = g.operator_profile_id and p.active
  join public.roles r on r.id = om.role_id
  where g.device_id = p_device_id
    and g.operator_profile_id = p_operator_profile_id
    and g.token_hash = hashed_token
    and g.revoked_at is null
    and app_private.can_access_branch(g.organization_id, g.branch_id, 'sales.create')
    and (r.key = 'admin' or exists (
      select 1 from public.branch_members bm
      where bm.organization_id = g.organization_id and bm.branch_id = g.branch_id
        and bm.profile_id = g.operator_profile_id and bm.active
    ));
  if not found then
    raise exception 'POS operator authorization is invalid, expired, or revoked' using errcode = '42501';
  end if;
end;
$$;

-- 3) Ventas offline: el operador se identifica por dispositivo + organización (el token del payload se ignora).
create or replace function public.sync_pos_operator_offline_sale(
  p_device_id uuid,p_event_id uuid,p_payload jsonb,p_operator_profile_id uuid,p_operator_token text
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare access record; delegated jsonb; result jsonb; sale_uuid uuid; operator_name text;
begin
  select * into access from app_private.resolve_pos_operator_for_sync(p_device_id,p_operator_profile_id);
  if (p_payload->>'profileId')::uuid<>p_operator_profile_id then raise exception 'Sale operator does not match its authorization' using errcode='42501'; end if;
  delegated:=jsonb_set(p_payload,'{profileId}',to_jsonb(auth.uid()::text));
  result:=public.sync_offline_sale(p_device_id,p_event_id,delegated);
  sale_uuid:=(result->>'saleId')::uuid;
  select display_name into operator_name from public.profiles where id = p_operator_profile_id;
  update public.sales s
  set profile_id=p_operator_profile_id,
      operator_name_snapshot=case when s.profile_id is distinct from p_operator_profile_id then operator_name else s.operator_name_snapshot end
  where s.id=sale_uuid and s.organization_id=access.organization_id and s.branch_id=access.branch_id;
  update public.stock_movements set profile_id=p_operator_profile_id where sale_id=sale_uuid and organization_id=access.organization_id;
  return result;
end;
$$;

-- 4) Eventos de turno: los OFFLINE (cola) se identifican como las ventas; los ONLINE (en vivo) siguen con el token.
--    Cuerpo idéntico al de 202611140100 salvo la selección del resolvedor.
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

-- 5) El PIN online emite un token de 365 días (informativo: el POS lo guarda como `grant_valid_until` para el ingreso offline);
--    el servidor ya no lo hace vencer. Cuerpo idéntico al de 202609130019 salvo el intervalo.
create or replace function public.verify_pos_operator_pin(p_device_id uuid, p_profile_id uuid, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); org_id uuid; branch_uuid uuid; pin_hash text; failed_count smallint; locked timestamptz;
  raw_token text; expires_at timestamptz := now() + interval '365 days'; display text; role_label text;
begin
  if actor is null or p_pin is null or p_pin !~ '^[0-9]{4,6}$' then raise exception 'PIN inválido' using errcode = '22023'; end if;
  select d.organization_id, d.branch_id into org_id, branch_uuid from public.pos_devices d where d.id = p_device_id and d.status = 'ACTIVE';
  if org_id is null or not app_private.can_access_branch(org_id, branch_uuid, 'sales.create') then raise exception 'Device is not authorized' using errcode = '42501'; end if;
  select a.failed_attempts, a.locked_until into failed_count, locked from public.pos_pin_attempts a where a.device_id = p_device_id and a.profile_id = p_profile_id for update;
  if locked is not null and locked > now() then return jsonb_build_object('ok',false,'message','Demasiados intentos. Esperá unos minutos.'); end if;
  select pin.pin_hash, p.display_name, r.name into pin_hash, display, role_label
  from public.employee_pos_pins pin
  join public.organization_members om on om.organization_id = pin.organization_id and om.profile_id = pin.profile_id and om.status = 'ACTIVE'
  join public.profiles p on p.id = om.profile_id and p.active
  join public.roles r on r.id = om.role_id
  where pin.organization_id = org_id and pin.profile_id = p_profile_id
    and (r.key = 'admin' or exists(select 1 from public.branch_members bm where bm.organization_id = org_id and bm.branch_id = branch_uuid and bm.profile_id = p_profile_id and bm.active));
  if pin_hash is null or extensions.crypt(p_pin, pin_hash) <> pin_hash then
    failed_count := least(coalesce(failed_count,0) + 1, 20);
    insert into public.pos_pin_attempts(device_id, profile_id, failed_attempts, locked_until)
    values(p_device_id, p_profile_id, failed_count, case when failed_count >= 5 then now() + interval '5 minutes' else null end)
    on conflict(device_id, profile_id) do update set failed_attempts=excluded.failed_attempts,locked_until=excluded.locked_until,updated_at=now();
    return jsonb_build_object('ok',false,'message',case when failed_count >= 5 then 'Demasiados intentos. Esperá unos minutos.' else 'PIN incorrecto' end);
  end if;
  delete from public.pos_pin_attempts where device_id = p_device_id and profile_id = p_profile_id;
  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.pos_operator_grants(organization_id, branch_id, device_id, operator_profile_id, issued_by, token_hash, valid_until)
  values(org_id, branch_uuid, p_device_id, p_profile_id, actor, encode(extensions.digest(convert_to(raw_token, 'UTF8'), 'sha256'), 'hex'), expires_at);
  return jsonb_build_object('ok',true,'profileId',p_profile_id,'displayName',display,'roleName',role_label,'operatorToken',raw_token,'validUntil',expires_at);
end;
$$;

commit;
