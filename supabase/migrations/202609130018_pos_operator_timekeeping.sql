begin;

create type public.employee_shift_status as enum ('OPEN', 'CLOSED', 'REQUIRES_REVIEW');
create type public.time_event_action as enum ('CLOCK_IN', 'CLOCK_OUT');
create type public.time_event_source as enum ('ONLINE', 'OFFLINE', 'ADMIN_CORRECTION');

alter table public.organizations
  add column max_shift_hours smallint not null default 12
  check (max_shift_hours between 1 and 24);

create table public.employee_pos_pins (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  pin_hash text not null,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, profile_id),
  foreign key (organization_id, profile_id)
    references public.organization_members(organization_id, profile_id) on delete cascade
);

create table public.pos_pin_attempts (
  device_id uuid not null references public.pos_devices(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  failed_attempts smallint not null default 0 check (failed_attempts between 0 and 20),
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (device_id, profile_id)
);

create table public.pos_operator_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  device_id uuid not null,
  operator_profile_id uuid not null references public.profiles(id) on delete cascade,
  issued_by uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  issued_at timestamptz not null default now(),
  valid_until timestamptz not null,
  revoked_at timestamptz,
  foreign key (device_id, organization_id, branch_id)
    references public.pos_devices(id, organization_id, branch_id) on delete cascade,
  foreign key (organization_id, operator_profile_id)
    references public.organization_members(organization_id, profile_id) on delete cascade,
  check (valid_until > issued_at)
);

create table public.employee_shifts (
  id uuid primary key,
  organization_id uuid not null,
  branch_id uuid not null,
  employee_id uuid not null references public.profiles(id) on delete restrict,
  device_id uuid not null references public.pos_devices(id) on delete restrict,
  clock_in_at timestamptz not null,
  clock_out_at timestamptz,
  clock_in_source public.time_event_source not null,
  clock_out_source public.time_event_source,
  clock_in_received_at timestamptz not null,
  clock_out_received_at timestamptz,
  status public.employee_shift_status not null default 'OPEN',
  corrected_by uuid references public.profiles(id) on delete restrict,
  corrected_at timestamptz,
  correction_reason text check (correction_reason is null or char_length(btrim(correction_reason)) between 3 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete restrict,
  check (clock_out_at is null or clock_out_at >= clock_in_at),
  check ((status = 'CLOSED' and clock_out_at is not null) or (status <> 'CLOSED' and clock_out_at is null))
);

create unique index employee_shifts_one_open_uq
  on public.employee_shifts (organization_id, employee_id)
  where clock_out_at is null;
create index employee_shifts_org_period_idx
  on public.employee_shifts (organization_id, clock_in_at desc);
create index employee_shifts_review_idx
  on public.employee_shifts (organization_id, status, clock_in_at)
  where status = 'REQUIRES_REVIEW';

create table public.employee_time_events (
  event_id uuid primary key,
  shift_id uuid not null references public.employee_shifts(id) on delete restrict,
  organization_id uuid not null,
  branch_id uuid not null,
  employee_id uuid not null references public.profiles(id) on delete restrict,
  device_id uuid not null references public.pos_devices(id) on delete restrict,
  action public.time_event_action not null,
  source public.time_event_source not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete restrict
);

create table public.employee_hourly_rates (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null references public.profiles(id) on delete restrict,
  rate_cents_per_hour bigint not null check (rate_cents_per_hour >= 0),
  valid_from timestamptz not null,
  valid_to timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (organization_id, employee_id)
    references public.organization_members(organization_id, profile_id) on delete restrict,
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (
    employee_id with =,
    (tstzrange(valid_from, valid_to, '[)')) with &&
  )
);

create index employee_hourly_rates_lookup_idx
  on public.employee_hourly_rates (organization_id, employee_id, valid_from desc);

insert into public.permissions (key, description) values
  ('timekeeping.read', 'Read employee shifts and estimated hourly pay'),
  ('timekeeping.write', 'Manage employee PINs, rates, and shift corrections')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select '10000000-0000-4000-8000-000000000001'::uuid, permission_key
from (values ('timekeeping.read'), ('timekeeping.write')) p(permission_key)
on conflict (role_id, permission_key) do nothing;

create function app_private.mark_overdue_shifts(p_organization_id uuid, p_as_of timestamptz default now())
returns void language sql volatile security definer set search_path = '' as $$
  update public.employee_shifts s
  set status = 'REQUIRES_REVIEW', updated_at = p_as_of
  from public.organizations o
  where o.id = p_organization_id
    and s.organization_id = o.id
    and s.status = 'OPEN'
    and s.clock_out_at is null
    and s.clock_in_at + make_interval(hours => o.max_shift_hours) < p_as_of;
$$;

create function app_private.resolve_pos_operator(
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

create function public.get_pos_operator_roster(p_device_id uuid)
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
      exists(select 1 from public.employee_shifts s where s.organization_id = org_id and s.employee_id = p.id and s.status = 'REQUIRES_REVIEW') has_shift_issue
    from public.organization_members om
    join public.profiles p on p.id = om.profile_id and p.active
    join public.roles r on r.id = om.role_id
    where om.organization_id = org_id and om.status = 'ACTIVE'
      and (r.key = 'admin' or exists(select 1 from public.branch_members bm where bm.organization_id = org_id and bm.branch_id = branch_uuid and bm.profile_id = p.id and bm.active))
  ) q;
  return jsonb_build_object('operators',result,'maxShiftHours',(select o.max_shift_hours from public.organizations o where o.id=org_id));
end;
$$;

create function public.verify_pos_operator_pin(p_device_id uuid, p_profile_id uuid, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); org_id uuid; branch_uuid uuid; pin_hash text; attempts smallint; locked timestamptz;
  raw_token text; expires_at timestamptz := now() + interval '7 days'; display text; role_label text;
begin
  if actor is null or p_pin !~ '^[0-9]{4,6}$' then raise exception 'PIN inválido' using errcode = '22023'; end if;
  select d.organization_id, d.branch_id into org_id, branch_uuid from public.pos_devices d where d.id = p_device_id and d.status = 'ACTIVE';
  if org_id is null or not app_private.can_access_branch(org_id, branch_uuid, 'sales.create') then raise exception 'Device is not authorized' using errcode = '42501'; end if;
  select a.failed_attempts, a.locked_until into attempts, locked from public.pos_pin_attempts a where a.device_id = p_device_id and a.profile_id = p_profile_id for update;
  if locked is not null and locked > now() then raise exception 'Demasiados intentos. Esperá unos minutos.' using errcode = '42501'; end if;
  select pin.pin_hash, p.display_name, r.name into pin_hash, display, role_label
  from public.employee_pos_pins pin
  join public.organization_members om on om.organization_id = pin.organization_id and om.profile_id = pin.profile_id and om.status = 'ACTIVE'
  join public.profiles p on p.id = om.profile_id and p.active
  join public.roles r on r.id = om.role_id
  where pin.organization_id = org_id and pin.profile_id = p_profile_id
    and (r.key = 'admin' or exists(select 1 from public.branch_members bm where bm.organization_id = org_id and bm.branch_id = branch_uuid and bm.profile_id = p_profile_id and bm.active));
  if pin_hash is null or extensions.crypt(p_pin, pin_hash) <> pin_hash then
    insert into public.pos_pin_attempts(device_id, profile_id, failed_attempts, locked_until)
    values(p_device_id, p_profile_id, 1, null)
    on conflict(device_id, profile_id) do update set failed_attempts = least(public.pos_pin_attempts.failed_attempts + 1, 20),
      locked_until = case when public.pos_pin_attempts.failed_attempts + 1 >= 5 then now() + interval '5 minutes' else null end, updated_at = now();
    raise exception 'PIN incorrecto' using errcode = '42501';
  end if;
  delete from public.pos_pin_attempts where device_id = p_device_id and profile_id = p_profile_id;
  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.pos_operator_grants(organization_id, branch_id, device_id, operator_profile_id, issued_by, token_hash, valid_until)
  values(org_id, branch_uuid, p_device_id, p_profile_id, actor, encode(extensions.digest(convert_to(raw_token, 'UTF8'), 'sha256'), 'hex'), expires_at);
  return jsonb_build_object('profileId', p_profile_id, 'displayName', display, 'roleName', role_label, 'operatorToken', raw_token, 'validUntil', expires_at);
end;
$$;

create function public.set_employee_pos_pin(p_profile_id uuid, p_pin text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare org_id uuid := app_private.require_permission('timekeeping.write');
begin
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'El PIN debe tener entre 4 y 6 dígitos' using errcode = '22023'; end if;
  if not exists(select 1 from public.organization_members om join public.profiles p on p.id=om.profile_id where om.organization_id=org_id and om.profile_id=p_profile_id and om.status='ACTIVE' and p.active) then
    raise exception 'El empleado no está activo en esta organización' using errcode = '42501';
  end if;
  insert into public.employee_pos_pins(organization_id, profile_id, pin_hash, updated_by)
  values(org_id, p_profile_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 12)), auth.uid())
  on conflict(organization_id, profile_id) do update set pin_hash=excluded.pin_hash, updated_by=excluded.updated_by, updated_at=now();
  update public.pos_operator_grants set revoked_at=now() where organization_id=org_id and operator_profile_id=p_profile_id and revoked_at is null;
  perform app_private.write_audit(org_id, null, 'EMPLOYEE_POS_PIN_CHANGED', 'profile', p_profile_id, null, jsonb_build_object('configured', true));
end;
$$;

create function public.get_employee_security_status()
returns table(profile_id uuid, has_pin boolean, current_rate_cents_per_hour bigint, rate_valid_from timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare org_id uuid := app_private.require_permission('members.read');
begin
 return query select om.profile_id,
   exists(select 1 from public.employee_pos_pins pin where pin.organization_id=org_id and pin.profile_id=om.profile_id),
   rate.rate_cents_per_hour, rate.valid_from
 from public.organization_members om
 left join lateral(select r.rate_cents_per_hour, r.valid_from from public.employee_hourly_rates r where r.organization_id=org_id and r.employee_id=om.profile_id and r.valid_from<=now() and (r.valid_to is null or r.valid_to>now()) order by r.valid_from desc limit 1) rate on true
 where om.organization_id=org_id;
end;
$$;

create function app_private.apply_employee_time_event(
  p_device_id uuid, p_event_id uuid, p_shift_id uuid, p_employee_id uuid,
  p_operator_token text, p_action public.time_event_action,
  p_source public.time_event_source, p_occurred_at timestamptz, p_received_at timestamptz
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  access record; existing_event public.employee_time_events%rowtype;
  current_shift public.employee_shifts%rowtype; max_hours smallint;
begin
  select * into access from app_private.resolve_pos_operator(p_device_id, p_employee_id, p_operator_token, p_occurred_at);
  if not found then raise exception 'Operator is not authorized' using errcode='42501'; end if;
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
      raise exception 'No hay un turno activo para marcar salida' using errcode='P0001';
    end if;
    if current_shift.status='REQUIRES_REVIEW' or p_occurred_at-current_shift.clock_in_at > make_interval(hours=>max_hours) then
      update public.employee_shifts set status='REQUIRES_REVIEW',updated_at=p_received_at where id=current_shift.id returning * into current_shift;
      return jsonb_build_object('shiftId',current_shift.id,'status',current_shift.status,'clockInAt',current_shift.clock_in_at,
        'clockOutAt',null,'clockInSource',current_shift.clock_in_source,'clockOutSource',null,'requiresReview',true);
    end if;
    if p_occurred_at < current_shift.clock_in_at then raise exception 'La salida no puede ser anterior a la entrada' using errcode='22023'; end if;
    update public.employee_shifts set clock_out_at=p_occurred_at,clock_out_source=p_source,clock_out_received_at=p_received_at,status='CLOSED',updated_at=p_received_at
    where id=current_shift.id returning * into current_shift;
  end if;

  insert into public.employee_time_events(event_id,shift_id,organization_id,branch_id,employee_id,device_id,action,source,occurred_at,received_at)
  values(p_event_id,current_shift.id,access.organization_id,access.branch_id,p_employee_id,p_device_id,p_action,p_source,p_occurred_at,p_received_at);
  perform app_private.write_audit(access.organization_id,access.branch_id,
    case when p_action='CLOCK_IN' then 'EMPLOYEE_CLOCK_IN' else 'EMPLOYEE_CLOCK_OUT' end,
    'employee_shift',current_shift.id,null,jsonb_build_object('employeeId',p_employee_id,'source',p_source,'occurredAt',p_occurred_at,'receivedAt',p_received_at));
  return jsonb_build_object('shiftId',current_shift.id,'status',current_shift.status,'clockInAt',current_shift.clock_in_at,
    'clockOutAt',current_shift.clock_out_at,'clockInSource',current_shift.clock_in_source,'clockOutSource',current_shift.clock_out_source,'duplicate',false);
end;
$$;

create function public.record_employee_time_event(
  p_device_id uuid, p_event_id uuid, p_shift_id uuid, p_employee_id uuid,
  p_operator_token text, p_action public.time_event_action
)
returns jsonb language sql volatile security definer set search_path='' as $$
  select app_private.apply_employee_time_event(p_device_id,p_event_id,p_shift_id,p_employee_id,p_operator_token,p_action,'ONLINE',clock_timestamp(),clock_timestamp());
$$;

create function public.sync_offline_time_event(p_device_id uuid,p_event_id uuid,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare occurred timestamptz; employee uuid; shift_uuid uuid; action public.time_event_action; token text;
begin
  if p_payload->>'schemaVersion'<>'1' or (p_payload->>'eventId')::uuid<>p_event_id or (p_payload->>'deviceId')::uuid<>p_device_id then
    raise exception 'Offline time event payload is invalid' using errcode='22023';
  end if;
  occurred:=(p_payload->>'occurredAt')::timestamptz; employee:=(p_payload->>'employeeId')::uuid;
  shift_uuid:=(p_payload->>'shiftId')::uuid; action:=(p_payload->>'action')::public.time_event_action; token:=p_payload->>'operatorToken';
  if occurred>now()+interval '5 minutes' or occurred<now()-interval '8 days' then raise exception 'Offline time event timestamp is outside the accepted window' using errcode='22023'; end if;
  return app_private.apply_employee_time_event(p_device_id,p_event_id,shift_uuid,employee,token,action,'OFFLINE',occurred,clock_timestamp());
end;
$$;

create function public.get_current_employee_shift(p_device_id uuid,p_employee_id uuid,p_operator_token text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare access record; shift_row public.employee_shifts%rowtype;
begin
 select * into access from app_private.resolve_pos_operator(p_device_id,p_employee_id,p_operator_token,now());
 perform app_private.mark_overdue_shifts(access.organization_id);
 select * into shift_row from public.employee_shifts s where s.organization_id=access.organization_id and s.employee_id=p_employee_id and s.clock_out_at is null order by s.clock_in_at desc limit 1;
 if shift_row.id is null then return null; end if;
 return jsonb_build_object('shiftId',shift_row.id,'status',shift_row.status,'clockInAt',shift_row.clock_in_at,'clockOutAt',shift_row.clock_out_at,
   'clockInSource',shift_row.clock_in_source,'clockOutSource',shift_row.clock_out_source);
end;
$$;

create function public.sync_pos_operator_offline_sale(
  p_device_id uuid,p_event_id uuid,p_payload jsonb,p_operator_profile_id uuid,p_operator_token text
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare access record; delegated jsonb; result jsonb; sale_uuid uuid; occurred timestamptz;
begin
 occurred:=(p_payload->>'completedAt')::timestamptz;
 select * into access from app_private.resolve_pos_operator(p_device_id,p_operator_profile_id,p_operator_token,occurred);
 if (p_payload->>'profileId')::uuid<>p_operator_profile_id then raise exception 'Sale operator does not match its authorization' using errcode='42501'; end if;
 delegated:=jsonb_set(p_payload,'{profileId}',to_jsonb(auth.uid()::text));
 result:=public.sync_offline_sale(p_device_id,p_event_id,delegated);
 sale_uuid:=(result->>'saleId')::uuid;
 update public.sales set profile_id=p_operator_profile_id where id=sale_uuid and organization_id=access.organization_id and branch_id=access.branch_id;
 update public.stock_movements set profile_id=p_operator_profile_id where sale_id=sale_uuid and organization_id=access.organization_id;
 return result;
end;
$$;

create function public.complete_pos_operator_sale(
  p_device_id uuid,p_operator_profile_id uuid,p_operator_token text,p_branch_id uuid,p_items jsonb,p_payment_method text
)
returns table(sale_id uuid,total_cents bigint,total_weight_grams bigint,completed_at timestamptz)
language plpgsql volatile security definer set search_path='' as $$
declare access record; completed record;
begin
 select * into access from app_private.resolve_pos_operator(p_device_id,p_operator_profile_id,p_operator_token,now());
 if access.branch_id<>p_branch_id then raise exception 'Operator is not authorized for this branch' using errcode='42501'; end if;
 for completed in select * from public.complete_discounted_sale(p_branch_id,p_items,p_payment_method) loop
   update public.sales s set profile_id=p_operator_profile_id where s.id=completed.sale_id;
   update public.stock_movements sm set profile_id=p_operator_profile_id where sm.sale_id=completed.sale_id;
   sale_id:=completed.sale_id; total_cents:=completed.total_cents; total_weight_grams:=completed.total_weight_grams; completed_at:=completed.completed_at;
   return next;
 end loop;
end;
$$;

create function public.set_employee_hourly_rate(p_employee_id uuid,p_rate_cents_per_hour bigint,p_valid_from_local timestamp)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare org_id uuid:=app_private.require_permission('timekeeping.write'); new_id uuid; old_rate bigint; effective_at timestamptz; tz text;
begin
 select o.timezone into tz from public.organizations o where o.id=org_id; effective_at:=p_valid_from_local at time zone tz;
 if p_rate_cents_per_hour<0 or effective_at>now()+interval '1 day' then raise exception 'Tarifa o vigencia inválida' using errcode='22023'; end if;
 if not exists(select 1 from public.organization_members om where om.organization_id=org_id and om.profile_id=p_employee_id) then raise exception 'Employee is outside this organization' using errcode='42501'; end if;
 select r.rate_cents_per_hour into old_rate from public.employee_hourly_rates r where r.organization_id=org_id and r.employee_id=p_employee_id and r.valid_to is null for update;
 if exists(select 1 from public.employee_hourly_rates r where r.organization_id=org_id and r.employee_id=p_employee_id and r.valid_from=effective_at) then
   raise exception 'Ya existe una tarifa con esa fecha de vigencia' using errcode='23505';
 end if;
 update public.employee_hourly_rates set valid_to=effective_at where organization_id=org_id and employee_id=p_employee_id and valid_to is null and valid_from<effective_at;
 insert into public.employee_hourly_rates(organization_id,employee_id,rate_cents_per_hour,valid_from,created_by)
 values(org_id,p_employee_id,p_rate_cents_per_hour,effective_at,auth.uid()) returning id into new_id;
 perform app_private.write_audit(org_id,null,'EMPLOYEE_HOURLY_RATE_CHANGED','employee_hourly_rate',new_id,jsonb_build_object('rateCentsPerHour',old_rate),jsonb_build_object('employeeId',p_employee_id,'rateCentsPerHour',p_rate_cents_per_hour,'validFrom',effective_at));
 return new_id;
end;
$$;

create function public.correct_employee_shift(p_shift_id uuid,p_clock_out_local timestamp,p_reason text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare org_id uuid:=app_private.require_permission('timekeeping.write'); before_row jsonb; branch_uuid uuid; employee uuid; clock_in timestamptz; corrected_out timestamptz; tz text;
begin
 select o.timezone into tz from public.organizations o where o.id=org_id; corrected_out:=p_clock_out_local at time zone tz;
 if char_length(btrim(p_reason))<3 then raise exception 'El motivo es obligatorio' using errcode='22023'; end if;
 select to_jsonb(s),s.branch_id,s.employee_id,s.clock_in_at into before_row,branch_uuid,employee,clock_in from public.employee_shifts s where s.id=p_shift_id and s.organization_id=org_id for update;
 if before_row is null or corrected_out<clock_in or corrected_out>now()+interval '5 minutes' then raise exception 'Turno u horario de salida inválido' using errcode='22023'; end if;
 update public.employee_shifts set clock_out_at=corrected_out,clock_out_source='ADMIN_CORRECTION',clock_out_received_at=now(),status='CLOSED',corrected_by=auth.uid(),corrected_at=now(),correction_reason=btrim(p_reason),updated_at=now() where id=p_shift_id;
 perform app_private.write_audit(org_id,branch_uuid,'EMPLOYEE_SHIFT_CORRECTED','employee_shift',p_shift_id,before_row,
   (select to_jsonb(s) from public.employee_shifts s where s.id=p_shift_id));
end;
$$;

create function public.set_timekeeping_max_shift_hours(p_hours smallint)
returns void language plpgsql volatile security definer set search_path='' as $$
declare org_id uuid:=app_private.require_permission('timekeeping.write');
begin
 if p_hours not between 1 and 24 then raise exception 'La duración máxima debe estar entre 1 y 24 horas' using errcode='22023'; end if;
 update public.organizations set max_shift_hours=p_hours where id=org_id;
 perform app_private.write_audit(org_id,null,'TIMEKEEPING_SETTINGS_CHANGED','organization',org_id,null,jsonb_build_object('maxShiftHours',p_hours));
end;
$$;

create function public.get_timekeeping_report(p_from date,p_to date,p_employee_id uuid default null,p_branch_id uuid default null)
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
     case when s.status='CLOSED' then extract(epoch from (least(s.clock_out_at,to_at)-greatest(s.clock_in_at,from_at)))::bigint else 0 end duration_seconds
   from public.employee_shifts s join public.profiles p on p.id=s.employee_id join public.branches b on b.id=s.branch_id
   where s.organization_id=org_id and s.clock_in_at<to_at and coalesce(s.clock_out_at,now())>=from_at
     and (p_employee_id is null or s.employee_id=p_employee_id) and (p_branch_id is null or s.branch_id=p_branch_id)
 ), pay as (
   select s.id,coalesce(sum(round(r.rate_cents_per_hour::numeric * extract(epoch from (least(s.clock_out_at,coalesce(r.valid_to,to_at),to_at)-greatest(s.clock_in_at,r.valid_from,from_at)))/3600)),0)::bigint estimated_cents,
     coalesce(sum(extract(epoch from (least(s.clock_out_at,coalesce(r.valid_to,to_at),to_at)-greatest(s.clock_in_at,r.valid_from,from_at)))),0)::bigint covered_seconds
   from selected s join public.employee_hourly_rates r on r.organization_id=org_id and r.employee_id=s.employee_id
     and s.status='CLOSED' and tstzrange(r.valid_from,r.valid_to,'[)') && tstzrange(greatest(s.clock_in_at,from_at),least(s.clock_out_at,to_at),'[)')
   group by s.id
 ), employee_totals as (
   select s.employee_id,s.display_name,sum(s.duration_seconds)::bigint duration_seconds,coalesce(sum(pay.estimated_cents),0)::bigint estimated_cents,
     sum(s.duration_seconds)::bigint=coalesce(sum(pay.covered_seconds),0)::bigint rate_complete
   from selected s left join pay on pay.id=s.id where s.status='CLOSED' group by s.employee_id,s.display_name
 )
 select jsonb_build_object(
   'from',p_from,'to',p_to,'maxShiftHours',(select o.max_shift_hours from public.organizations o where o.id=org_id),
   'employees',coalesce((select jsonb_agg(to_jsonb(e) order by e.display_name) from employee_totals e),'[]'::jsonb),
   'shifts',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'employeeId',s.employee_id,'employeeName',s.display_name,'branchId',s.branch_id,'branchName',s.branch_name,'clockInAt',s.clock_in_at,'clockOutAt',s.clock_out_at,'clockInSource',s.clock_in_source,'clockOutSource',s.clock_out_source,'status',s.status,'durationSeconds',s.duration_seconds,'estimatedCents',coalesce(pay.estimated_cents,0),'rateComplete',s.duration_seconds=coalesce(pay.covered_seconds,0)) order by s.clock_in_at desc) from selected s left join pay on pay.id=s.id),'[]'::jsonb),
   'review',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'employeeId',s.employee_id,'employeeName',s.display_name,'branchId',s.branch_id,'branchName',s.branch_name,'clockInAt',s.clock_in_at,'clockInSource',s.clock_in_source) order by s.clock_in_at) from selected s where s.status='REQUIRES_REVIEW'),'[]'::jsonb)
 ) into result;
 return result;
end;
$$;

alter table public.employee_pos_pins enable row level security;
alter table public.pos_pin_attempts enable row level security;
alter table public.pos_operator_grants enable row level security;
alter table public.employee_shifts enable row level security;
alter table public.employee_time_events enable row level security;
alter table public.employee_hourly_rates enable row level security;

create policy employee_shifts_admin_read on public.employee_shifts for select to authenticated
using (app_private.has_permission(organization_id,'timekeeping.read'));
create policy employee_rates_admin_read on public.employee_hourly_rates for select to authenticated
using (app_private.has_permission(organization_id,'timekeeping.read'));

revoke all on table public.employee_pos_pins,public.pos_pin_attempts,public.pos_operator_grants,public.employee_shifts,public.employee_time_events,public.employee_hourly_rates from anon,authenticated;
grant select on table public.employee_shifts,public.employee_hourly_rates to authenticated;
revoke all on function app_private.mark_overdue_shifts(uuid,timestamptz),app_private.resolve_pos_operator(uuid,uuid,text,timestamptz),app_private.apply_employee_time_event(uuid,uuid,uuid,uuid,text,public.time_event_action,public.time_event_source,timestamptz,timestamptz) from public,anon,authenticated;

revoke all on function public.get_pos_operator_roster(uuid),public.verify_pos_operator_pin(uuid,uuid,text),public.set_employee_pos_pin(uuid,text),public.get_employee_security_status(),public.record_employee_time_event(uuid,uuid,uuid,uuid,text,public.time_event_action),public.sync_offline_time_event(uuid,uuid,jsonb),public.get_current_employee_shift(uuid,uuid,text),public.sync_pos_operator_offline_sale(uuid,uuid,jsonb,uuid,text),public.complete_pos_operator_sale(uuid,uuid,text,uuid,jsonb,text),public.set_employee_hourly_rate(uuid,bigint,timestamp),public.correct_employee_shift(uuid,timestamp,text),public.set_timekeeping_max_shift_hours(smallint),public.get_timekeeping_report(date,date,uuid,uuid) from public,anon;
grant execute on function public.get_pos_operator_roster(uuid),public.verify_pos_operator_pin(uuid,uuid,text),public.set_employee_pos_pin(uuid,text),public.get_employee_security_status(),public.record_employee_time_event(uuid,uuid,uuid,uuid,text,public.time_event_action),public.sync_offline_time_event(uuid,uuid,jsonb),public.get_current_employee_shift(uuid,uuid,text),public.sync_pos_operator_offline_sale(uuid,uuid,jsonb,uuid,text),public.complete_pos_operator_sale(uuid,uuid,text,uuid,jsonb,text),public.set_employee_hourly_rate(uuid,bigint,timestamp),public.correct_employee_shift(uuid,timestamp,text),public.set_timekeeping_max_shift_hours(smallint),public.get_timekeeping_report(date,date,uuid,uuid) to authenticated;

commit;
