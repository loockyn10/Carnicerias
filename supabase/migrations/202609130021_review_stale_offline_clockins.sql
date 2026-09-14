begin;

create or replace function public.sync_offline_time_event(p_device_id uuid,p_event_id uuid,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare occurred timestamptz; employee uuid; shift_uuid uuid; action public.time_event_action; token text; result jsonb; org_id uuid; shift_row public.employee_shifts%rowtype;
begin
  if p_payload->>'schemaVersion'<>'1' or (p_payload->>'eventId')::uuid<>p_event_id or (p_payload->>'deviceId')::uuid<>p_device_id then
    raise exception 'Offline time event payload is invalid' using errcode='22023';
  end if;
  occurred:=(p_payload->>'occurredAt')::timestamptz; employee:=(p_payload->>'employeeId')::uuid;
  shift_uuid:=(p_payload->>'shiftId')::uuid; action:=(p_payload->>'action')::public.time_event_action; token:=p_payload->>'operatorToken';
  if occurred>now()+interval '5 minutes' or occurred<now()-interval '8 days' then raise exception 'Offline time event timestamp is outside the accepted window' using errcode='22023'; end if;
  result:=app_private.apply_employee_time_event(p_device_id,p_event_id,shift_uuid,employee,token,action,'OFFLINE',occurred,clock_timestamp());
  if action='CLOCK_IN' then
    select s.organization_id into org_id from public.employee_shifts s where s.id=shift_uuid;
    perform app_private.mark_overdue_shifts(org_id,clock_timestamp());
    select * into shift_row from public.employee_shifts s where s.id=shift_uuid;
    if shift_row.status='REQUIRES_REVIEW' then
      result:=jsonb_build_object('shiftId',shift_row.id,'status',shift_row.status,'clockInAt',shift_row.clock_in_at,'clockOutAt',null,
        'clockInSource',shift_row.clock_in_source,'clockOutSource',null,'requiresReview',true);
    end if;
  end if;
  return result;
end;
$$;

commit;
