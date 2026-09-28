begin;

-- Presence heartbeat/lease for employee_shifts. Fixes the regression where a
-- shift kept "OPEN" indefinitely (or up to max_shift_hours) whenever the POS
-- process died without delivering Tauri's CloseRequested event (Task Manager
-- kill, forced Windows shutdown/logoff, power loss): there was no signal at
-- all that the device had gone away, only the coarse max_shift_hours sweep.
--
-- last_heartbeat_at is a lease timestamp updated in place (no new row per
-- heartbeat, see docs/DOMAIN_RULES.md "Control horario"). auto_closed_by_heartbeat
-- distinguishes a shift closed from real presence evidence (the lease going
-- stale) from one flagged only because it ran longer than max_shift_hours
-- with no evidence of when it actually ended (existing D-015 behavior,
-- unchanged: clock_out_at stays null in that case).
alter table public.employee_shifts
  add column last_heartbeat_at timestamptz,
  add column auto_closed_by_heartbeat boolean not null default false;

create index employee_shifts_open_heartbeat_idx
  on public.employee_shifts (organization_id, last_heartbeat_at)
  where status = 'OPEN' and clock_out_at is null;

-- Relax the CLOSED/clock_out_at consistency check: a heartbeat-inferred close
-- sets clock_out_at while keeping status='REQUIRES_REVIEW' (existing status,
-- per docs/TASKS.md sprint note: reuse REQUIRES_REVIEW instead of inventing a
-- new one). Only CLOSED still requires clock_out_at; REQUIRES_REVIEW/OPEN may
-- have it null (forgot to clock out, no evidence) or set (heartbeat lease
-- expired, real evidence of last presence).
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.employee_shifts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status = ''CLOSED''%clock_out_at is not null%'
  loop
    execute format('alter table public.employee_shifts drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.employee_shifts
  add constraint employee_shifts_closed_requires_clock_out
  check (status <> 'CLOSED' or clock_out_at is not null);

-- Two independent cases, mutually exclusive by construction:
--   A) forgot to clock out, heartbeat still fresh (app still running normally
--      past max_shift_hours): flagged for review, clock_out_at stays null —
--      unchanged pre-existing behavior (D-015), no evidence to infer an end.
--   B) heartbeat lease expired (device stopped sending heartbeats: crash,
--      forced kill, power loss): the last heartbeat is real presence
--      evidence, so the shift's effective end is set to it instead of left
--      open/unbounded. Flagged for review (it's still an inference, not a
--      genuine clock-out tap) and marked auto_closed_by_heartbeat for the
--      Admin UI.
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
    and s.clock_out_at is null
    and s.last_heartbeat_at is not null
    and p_as_of - s.last_heartbeat_at > heartbeat_grace;
end;
$$;

-- Adds p_inferred (defaulted, appended last — same compatibility technique
-- already used for save_weight_discount/create_production_batch in this repo)
-- for the CLOCK_OUT event a device synthesizes about itself right after
-- restarting from a crash: it carries the last locally-known heartbeat as
-- occurred_at instead of "now" (never invents time up to reconnection), and
-- p_inferred=true forces the same REQUIRES_REVIEW + auto_closed_by_heartbeat
-- treatment as the server-side lease sweep above, regardless of max_shift_hours.
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

-- Reads the optional "inferred" flag a restart-reconciliation event carries
-- (see apps/pos/src-tauri, reconcile_stale_open_shifts) and forwards it.
create or replace function public.sync_offline_time_event(p_device_id uuid,p_event_id uuid,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare occurred timestamptz; employee uuid; shift_uuid uuid; action public.time_event_action; token text; inferred boolean; result jsonb; org_id uuid; shift_row public.employee_shifts%rowtype;
begin
  if p_payload->>'schemaVersion'<>'1' or (p_payload->>'eventId')::uuid<>p_event_id or (p_payload->>'deviceId')::uuid<>p_device_id then
    raise exception 'Offline time event payload is invalid' using errcode='22023';
  end if;
  occurred:=(p_payload->>'occurredAt')::timestamptz; employee:=(p_payload->>'employeeId')::uuid;
  shift_uuid:=(p_payload->>'shiftId')::uuid; action:=(p_payload->>'action')::public.time_event_action; token:=p_payload->>'operatorToken';
  inferred:=coalesce((p_payload->>'inferred')::boolean,false);
  if occurred>now()+interval '5 minutes' or occurred<now()-interval '8 days' then raise exception 'Offline time event timestamp is outside the accepted window' using errcode='22023'; end if;
  result:=app_private.apply_employee_time_event(p_device_id,p_event_id,shift_uuid,employee,token,action,'OFFLINE',occurred,clock_timestamp(),inferred);
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

-- Heartbeat while an operator is active: last-write-wins on the shift's own
-- lease column, never a new row per tick (docs/DOMAIN_RULES.md). No-op
-- (accepted:false) if the shift isn't open anymore — the client doesn't need
-- to treat that as an error, it'll pick up the real status on its next
-- get_current_employee_shift reconciliation.
create function public.record_shift_heartbeat(
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
  returning * into updated;
  return jsonb_build_object('shiftId', updated.id, 'accepted', updated.id is not null, 'lastHeartbeatAt', updated.last_heartbeat_at);
end;
$$;

-- A manual admin correction supersedes any prior auto-close inference.
create or replace function public.correct_employee_shift(p_shift_id uuid,p_clock_out_local timestamp,p_reason text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare org_id uuid:=app_private.require_permission('timekeeping.write'); before_row jsonb; branch_uuid uuid; clock_in timestamptz; corrected_out timestamptz; tz text;
begin
 select o.timezone into tz from public.organizations o where o.id=org_id; corrected_out:=p_clock_out_local at time zone tz;
 if char_length(btrim(p_reason))<3 then raise exception 'El motivo es obligatorio' using errcode='22023'; end if;
 select to_jsonb(s),s.branch_id,s.clock_in_at into before_row,branch_uuid,clock_in from public.employee_shifts s where s.id=p_shift_id and s.organization_id=org_id for update;
 if before_row is null or corrected_out<clock_in or corrected_out>now()+interval '5 minutes' then raise exception 'Turno u horario de salida inválido' using errcode='22023'; end if;
 update public.employee_shifts set clock_out_at=corrected_out,clock_out_source='ADMIN_CORRECTION',clock_out_received_at=now(),status='CLOSED',
   auto_closed_by_heartbeat=false,corrected_by=auth.uid(),corrected_at=now(),correction_reason=btrim(p_reason),updated_at=now() where id=p_shift_id;
 perform app_private.write_audit(org_id,branch_uuid,'EMPLOYEE_SHIFT_CORRECTED','employee_shift',p_shift_id,before_row,(select to_jsonb(s) from public.employee_shifts s where s.id=p_shift_id));
end;
$$;

-- Surfaces autoClosedByHeartbeat/clockOutAt on review rows so Admin can tell
-- an inferred close from a genuine "forgot to clock out" (clock_out_at null).
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
   'shifts',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'employeeId',s.employee_id,'employeeName',s.display_name,'branchId',s.branch_id,'branchName',s.branch_name,'clockInAt',s.clock_in_at,'clockOutAt',s.clock_out_at,'clockInSource',s.clock_in_source,'clockOutSource',s.clock_out_source,'status',s.status,'durationSeconds',s.duration_seconds,'estimatedCents',coalesce(pay.estimated_cents,0),'rateComplete',s.duration_seconds=coalesce(pay.covered_seconds,0),'autoClosedByHeartbeat',s.auto_closed_by_heartbeat) order by s.clock_in_at desc) from selected s left join pay on pay.id=s.id),'[]'::jsonb),
   'review',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'employeeId',s.employee_id,'employeeName',s.display_name,'branchId',s.branch_id,'branchName',s.branch_name,'clockInAt',s.clock_in_at,'clockInSource',s.clock_in_source,'clockOutAt',s.clock_out_at,'autoClosedByHeartbeat',s.auto_closed_by_heartbeat) order by s.clock_in_at) from selected s where s.status='REQUIRES_REVIEW'),'[]'::jsonb)
 ) into result;
 return result;
end;
$$;

revoke all on function public.record_shift_heartbeat(uuid,uuid,text,timestamptz) from public,anon;
grant execute on function public.record_shift_heartbeat(uuid,uuid,text,timestamptz) to authenticated;

commit;
