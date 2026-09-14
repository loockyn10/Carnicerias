begin;

create function app_private.audit_employee_access_change()
returns trigger language plpgsql volatile security definer set search_path='' as $$
begin
  if old.status is distinct from new.status then
    if new.status <> 'ACTIVE' then
      update public.pos_operator_grants set revoked_at=now()
      where organization_id=new.organization_id and operator_profile_id=new.profile_id and revoked_at is null;
    end if;
    perform app_private.write_audit(new.organization_id,null,'EMPLOYEE_ACCESS_STATUS_CHANGED','organization_member',new.id,
      jsonb_build_object('profileId',old.profile_id,'status',old.status),jsonb_build_object('profileId',new.profile_id,'status',new.status));
  end if;
  return new;
end;
$$;

create trigger organization_members_audit_employee_access
after update of status on public.organization_members
for each row execute function app_private.audit_employee_access_change();

revoke all on function app_private.audit_employee_access_change() from public,anon,authenticated;

commit;
