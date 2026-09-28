begin;

-- Bug reportado: el selector de operador del POS ("¿Quién está usando la caja?")
-- muestra miembros con rol admin (ej. "franciscofontini — Administrador · sin PIN"),
-- porque get_pos_operator_roster (202609130018_pos_operator_timekeeping.sql) incluye
-- explícitamente cualquier fila con role.key = 'admin', sin exigirle membership de
-- sucursal activa -- la misma condición que sí tiene sentido para autorizar el token
-- de operador (un admin puede resolver/operar en cualquier sucursal, ver
-- app_private.resolve_pos_operator / verify_pos_operator_pin, sin tocar) pero que
-- filtró también a la lista que arma el propio selector.
--
-- Fix acotado al roster: sólo miembros con role.key = 'employee', activos
-- (organization_members.status = 'ACTIVE', profiles.active) y con membership de
-- sucursal activa siguen apareciendo. No se toca resolve_pos_operator ni
-- verify_pos_operator_pin -- el PIN de un empleado sigue funcionando exactamente
-- igual; un admin sigue accediendo al Admin sin cambios.
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
      exists(select 1 from public.employee_shifts s where s.organization_id = org_id and s.employee_id = p.id and s.status = 'REQUIRES_REVIEW') has_shift_issue
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

commit;
