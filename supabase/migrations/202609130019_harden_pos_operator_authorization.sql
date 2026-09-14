begin;

create or replace function app_private.resolve_pos_operator(
  p_device_id uuid,
  p_operator_profile_id uuid,
  p_operator_token text,
  p_occurred_at timestamptz default now()
)
returns table (organization_id uuid, branch_id uuid, operator_profile_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  current_actor uuid := auth.uid();
  hashed_token text;
begin
  if current_actor is null or p_operator_token is null or char_length(p_operator_token) < 32 then
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
    and g.issued_by = current_actor
    and g.token_hash = hashed_token
    and g.revoked_at is null
    and p_occurred_at between g.issued_at - interval '5 minutes' and g.valid_until
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

create or replace function public.verify_pos_operator_pin(p_device_id uuid, p_profile_id uuid, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); org_id uuid; branch_uuid uuid; pin_hash text; failed_count smallint; locked timestamptz;
  raw_token text; expires_at timestamptz := now() + interval '7 days'; display text; role_label text;
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

create or replace function public.correct_employee_shift(p_shift_id uuid,p_clock_out_local timestamp,p_reason text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare org_id uuid:=app_private.require_permission('timekeeping.write'); before_row jsonb; branch_uuid uuid; clock_in timestamptz; corrected_out timestamptz; tz text;
begin
 select o.timezone into tz from public.organizations o where o.id=org_id; corrected_out:=p_clock_out_local at time zone tz;
 if char_length(btrim(p_reason))<3 then raise exception 'El motivo es obligatorio' using errcode='22023'; end if;
 select to_jsonb(s),s.branch_id,s.clock_in_at into before_row,branch_uuid,clock_in from public.employee_shifts s where s.id=p_shift_id and s.organization_id=org_id for update;
 if before_row is null or corrected_out<clock_in or corrected_out>now()+interval '5 minutes' then raise exception 'Turno u horario de salida inválido' using errcode='22023'; end if;
 update public.employee_shifts set clock_out_at=corrected_out,clock_out_source='ADMIN_CORRECTION',clock_out_received_at=now(),status='CLOSED',corrected_by=auth.uid(),corrected_at=now(),correction_reason=btrim(p_reason),updated_at=now() where id=p_shift_id;
 perform app_private.write_audit(org_id,branch_uuid,'EMPLOYEE_SHIFT_CORRECTED','employee_shift',p_shift_id,before_row,(select to_jsonb(s) from public.employee_shifts s where s.id=p_shift_id));
end;
$$;

commit;
