begin;

alter table public.profiles
  add column auth_user_id uuid;

update public.profiles profile
set auth_user_id = profile.id
where exists (
  select 1 from auth.users auth_user where auth_user.id = profile.id
);

alter table public.profiles
  add constraint profiles_auth_user_id_key unique (auth_user_id),
  add constraint profiles_auth_user_id_fkey
    foreign key (auth_user_id) references auth.users(id) on delete set null;

alter table public.profiles
  drop constraint profiles_id_fkey;

comment on column public.profiles.auth_user_id is
  'Optional Supabase Auth identity. POS-only employees have no Auth user; legacy profile UUIDs remain unchanged.';

create or replace function app_private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, auth_user_id, display_name)
  values (
    new.id,
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Usuario'
    )
  );
  return new;
end;
$$;

create function public.create_pos_employee(
  p_display_name text,
  p_pin text,
  p_branch_ids uuid[],
  p_rate_cents_per_hour bigint,
  p_rate_valid_from_local timestamp,
  p_status public.membership_status default 'ACTIVE'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('members.write');
  employee_role_id uuid;
  employee_profile_id uuid := extensions.gen_random_uuid();
  normalized_branch_ids uuid[];
  organization_timezone text;
  effective_at timestamptz;
begin
  if not app_private.has_permission(current_organization_id, 'timekeeping.write') then
    raise exception 'Permission timekeeping.write is required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_display_name, ''))) not between 1 and 120 then
    raise exception 'El nombre debe tener entre 1 y 120 caracteres' using errcode = '22023';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'El PIN debe tener entre 4 y 6 dígitos' using errcode = '22023';
  end if;
  if p_status not in ('ACTIVE', 'DISABLED') then
    raise exception 'El estado del empleado es inválido' using errcode = '22023';
  end if;
  if p_rate_cents_per_hour is null or p_rate_cents_per_hour < 0 or p_rate_valid_from_local is null then
    raise exception 'La tarifa o su vigencia es inválida' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_branch_ids, '{}'::uuid[])) branch_id where branch_id is null) then
    raise exception 'Las sucursales son inválidas' using errcode = '22023';
  end if;

  select coalesce(array_agg(candidate.branch_id order by candidate.branch_id), '{}'::uuid[])
  into normalized_branch_ids
  from (
    select distinct branch_id
    from unnest(coalesce(p_branch_ids, '{}'::uuid[])) branch_id
  ) candidate;

  if cardinality(normalized_branch_ids) = 0 then
    raise exception 'Seleccioná al menos una sucursal' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(normalized_branch_ids) requested(branch_id)
    where not exists (
      select 1
      from public.branches branch
      where branch.id = requested.branch_id
        and branch.organization_id = current_organization_id
        and branch.active
    )
  ) then
    raise exception 'Una sucursal no pertenece a la organización o está inactiva' using errcode = '42501';
  end if;

  select role.id into employee_role_id
  from public.roles role
  where role.key = 'employee' and role.is_system and role.organization_id is null;
  select organization.timezone into organization_timezone
  from public.organizations organization
  where organization.id = current_organization_id;
  effective_at := p_rate_valid_from_local at time zone organization_timezone;
  if effective_at > now() + interval '1 day' then
    raise exception 'La vigencia de la tarifa es inválida' using errcode = '22023';
  end if;

  insert into public.profiles (id, auth_user_id, display_name, active)
  values (employee_profile_id, null, btrim(p_display_name), true);

  insert into public.organization_members (organization_id, profile_id, role_id, status)
  values (current_organization_id, employee_profile_id, employee_role_id, p_status);

  insert into public.branch_members (organization_id, branch_id, profile_id, active)
  select current_organization_id, branch_id, employee_profile_id, true
  from unnest(normalized_branch_ids) branch_id;

  insert into public.employee_pos_pins (organization_id, profile_id, pin_hash, updated_by)
  values (
    current_organization_id,
    employee_profile_id,
    extensions.crypt(p_pin, extensions.gen_salt('bf', 12)),
    auth.uid()
  );

  insert into public.employee_hourly_rates (
    organization_id, employee_id, rate_cents_per_hour, valid_from, created_by
  ) values (
    current_organization_id, employee_profile_id, p_rate_cents_per_hour, effective_at, auth.uid()
  );

  perform app_private.write_audit(
    current_organization_id,
    null,
    'POS_EMPLOYEE_CREATED',
    'profile',
    employee_profile_id,
    null,
    jsonb_build_object(
      'displayName', btrim(p_display_name),
      'status', p_status,
      'branchIds', to_jsonb(normalized_branch_ids),
      'rateCentsPerHour', p_rate_cents_per_hour,
      'rateValidFrom', effective_at,
      'authLinked', false
    )
  );
  return employee_profile_id;
end;
$$;

create function public.update_pos_employee(
  p_employee_id uuid,
  p_display_name text,
  p_branch_ids uuid[],
  p_status public.membership_status
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('members.write');
  normalized_branch_ids uuid[];
  before_snapshot jsonb;
begin
  if p_employee_id is null or char_length(btrim(coalesce(p_display_name, ''))) not between 1 and 120 then
    raise exception 'El empleado o el nombre es inválido' using errcode = '22023';
  end if;
  if p_status not in ('ACTIVE', 'DISABLED', 'INVITED') then
    raise exception 'El estado del empleado es inválido' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_branch_ids, '{}'::uuid[])) branch_id where branch_id is null) then
    raise exception 'Las sucursales son inválidas' using errcode = '22023';
  end if;

  select coalesce(array_agg(candidate.branch_id order by candidate.branch_id), '{}'::uuid[])
  into normalized_branch_ids
  from (
    select distinct branch_id
    from unnest(coalesce(p_branch_ids, '{}'::uuid[])) branch_id
  ) candidate;

  if cardinality(normalized_branch_ids) = 0 then
    raise exception 'Seleccioná al menos una sucursal' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(normalized_branch_ids) requested(branch_id)
    where not exists (
      select 1
      from public.branches branch
      where branch.id = requested.branch_id
        and branch.organization_id = current_organization_id
        and branch.active
    )
  ) then
    raise exception 'Una sucursal no pertenece a la organización o está inactiva' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'displayName', profile.display_name,
    'status', membership.status,
    'branchIds', coalesce((
      select jsonb_agg(branch_member.branch_id order by branch_member.branch_id)
      from public.branch_members branch_member
      where branch_member.organization_id = current_organization_id
        and branch_member.profile_id = p_employee_id
        and branch_member.active
    ), '[]'::jsonb)
  ) into before_snapshot
  from public.organization_members membership
  join public.profiles profile on profile.id = membership.profile_id
  join public.roles role on role.id = membership.role_id
  where membership.organization_id = current_organization_id
    and membership.profile_id = p_employee_id
    and role.key = 'employee';

  if before_snapshot is null then
    raise exception 'El empleado no pertenece a esta organización' using errcode = '42501';
  end if;

  update public.profiles
  set display_name = btrim(p_display_name)
  where id = p_employee_id;

  update public.organization_members
  set status = p_status
  where organization_id = current_organization_id and profile_id = p_employee_id;

  update public.branch_members
  set active = false
  where organization_id = current_organization_id
    and profile_id = p_employee_id
    and not (branch_id = any(normalized_branch_ids));

  insert into public.branch_members (organization_id, branch_id, profile_id, active)
  select current_organization_id, branch_id, p_employee_id, true
  from unnest(normalized_branch_ids) branch_id
  on conflict (branch_id, profile_id) do update set active = true;

  perform app_private.write_audit(
    current_organization_id,
    null,
    'POS_EMPLOYEE_UPDATED',
    'profile',
    p_employee_id,
    before_snapshot,
    jsonb_build_object(
      'displayName', btrim(p_display_name),
      'status', p_status,
      'branchIds', to_jsonb(normalized_branch_ids)
    )
  );
end;
$$;

create or replace function public.set_employee_pos_pin(p_profile_id uuid, p_pin text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('timekeeping.write');
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'El PIN debe tener entre 4 y 6 dígitos' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.organization_members membership
    join public.profiles profile on profile.id = membership.profile_id and profile.active
    where membership.organization_id = current_organization_id
      and membership.profile_id = p_profile_id
  ) then
    raise exception 'El empleado no pertenece a esta organización' using errcode = '42501';
  end if;

  insert into public.employee_pos_pins (organization_id, profile_id, pin_hash, updated_by)
  values (
    current_organization_id,
    p_profile_id,
    extensions.crypt(p_pin, extensions.gen_salt('bf', 12)),
    auth.uid()
  )
  on conflict (organization_id, profile_id) do update
  set pin_hash = excluded.pin_hash, updated_by = excluded.updated_by, updated_at = now();

  update public.pos_operator_grants
  set revoked_at = now()
  where organization_id = current_organization_id
    and operator_profile_id = p_profile_id
    and revoked_at is null;
  perform app_private.write_audit(
    current_organization_id,
    null,
    'EMPLOYEE_POS_PIN_CHANGED',
    'profile',
    p_profile_id,
    null,
    jsonb_build_object('configured', true)
  );
end;
$$;

drop function public.list_organization_members();

create function public.list_organization_members()
returns table (
  profile_id uuid,
  display_name text,
  email text,
  auth_linked boolean,
  role_key text,
  status public.membership_status,
  branch_id uuid,
  branch_name text,
  branch_ids uuid[],
  branch_names text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('members.read');
begin
  return query
  select
    profile.id,
    profile.display_name,
    auth_user.email::text,
    profile.auth_user_id is not null,
    role.key,
    membership.status,
    (assigned.branch_ids)[1],
    (assigned.branch_names)[1],
    coalesce(assigned.branch_ids, '{}'::uuid[]),
    coalesce(assigned.branch_names, '{}'::text[])
  from public.organization_members membership
  join public.profiles profile on profile.id = membership.profile_id
  join public.roles role on role.id = membership.role_id
  left join auth.users auth_user on auth_user.id = profile.auth_user_id
  left join lateral (
    select
      array_agg(branch_member.branch_id order by branch.name, branch_member.branch_id) branch_ids,
      array_agg(branch.name order by branch.name, branch_member.branch_id) branch_names
    from public.branch_members branch_member
    join public.branches branch on branch.id = branch_member.branch_id
    where branch_member.organization_id = membership.organization_id
      and branch_member.profile_id = membership.profile_id
      and branch_member.active
  ) assigned on true
  where membership.organization_id = current_organization_id
  order by profile.display_name, profile.id;
end;
$$;

revoke all on function public.create_pos_employee(text,text,uuid[],bigint,timestamp,public.membership_status) from public, anon;
revoke all on function public.update_pos_employee(uuid,text,uuid[],public.membership_status) from public, anon;
revoke all on function public.list_organization_members() from public, anon;
grant execute on function public.create_pos_employee(text,text,uuid[],bigint,timestamp,public.membership_status) to authenticated;
grant execute on function public.update_pos_employee(uuid,text,uuid[],public.membership_status) to authenticated;
grant execute on function public.list_organization_members() to authenticated;

comment on function public.create_pos_employee(text,text,uuid[],bigint,timestamp,public.membership_status) is
  'Creates an internal POS employee atomically without a Supabase Auth account.';
comment on function public.update_pos_employee(uuid,text,uuid[],public.membership_status) is
  'Updates a POS employee while preserving the profile UUID and all historical references.';

commit;
