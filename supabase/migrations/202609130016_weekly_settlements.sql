begin;

create type public.settlement_status as enum ('CONFIRMED', 'VOIDED');

create table public.settlements (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  expected_cash_cents bigint not null check (expected_cash_cents >= 0),
  received_cash_cents bigint not null check (received_cash_cents >= 0),
  difference_cents bigint not null,
  total_sales_cents bigint not null check (total_sales_cents >= 0),
  ticket_count integer not null check (ticket_count >= 0),
  sold_weight_grams bigint not null check (sold_weight_grams >= 0),
  payment_totals jsonb not null check (jsonb_typeof(payment_totals) = 'object'),
  employee_totals jsonb not null check (jsonb_typeof(employee_totals) = 'array'),
  device_sync_snapshot jsonb not null check (jsonb_typeof(device_sync_snapshot) = 'array'),
  notes text check (notes is null or char_length(btrim(notes)) between 1 and 500),
  status public.settlement_status not null default 'CONFIRMED',
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  voided_by uuid references public.profiles(id) on delete restrict,
  voided_at timestamptz,
  void_reason text check (void_reason is null or char_length(btrim(void_reason)) between 3 and 500),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete restrict,
  unique (id, organization_id, branch_id),
  check (period_end > period_start),
  check (difference_cents = received_cash_cents - expected_cash_cents),
  check (
    (status = 'CONFIRMED' and voided_by is null and voided_at is null and void_reason is null)
    or (status = 'VOIDED' and voided_by is not null and voided_at is not null and void_reason is not null)
  )
);

create index settlements_branch_period_idx
  on public.settlements (organization_id, branch_id, period_end desc);
create index settlements_history_idx
  on public.settlements (organization_id, created_at desc);

insert into public.permissions (key, description) values
  ('settlements.read', 'Read settlement summaries and history'),
  ('settlements.write', 'Confirm and void branch settlements')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select '10000000-0000-4000-8000-000000000001'::uuid, permission.key
from (values ('settlements.read'), ('settlements.write')) as permission(key)
on conflict (role_id, permission_key) do nothing;

create function app_private.build_settlement_snapshot(
  requested_organization_id uuid,
  requested_branch_id uuid,
  requested_period_start timestamptz,
  requested_period_end timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with valid_sales as (
    select s.id, s.profile_id, s.total_cents, s.total_weight_grams
    from public.sales s
    where s.organization_id = requested_organization_id
      and s.branch_id = requested_branch_id
      and s.status = 'COMPLETED'
      and s.completed_at >= requested_period_start
      and s.completed_at < requested_period_end
  ), totals as (
    select coalesce(sum(v.total_cents), 0)::bigint as total_sales_cents,
      count(*)::integer as ticket_count,
      coalesce(sum(v.total_weight_grams), 0)::bigint as sold_weight_grams
    from valid_sales v
  ), payments_by_method as (
    select p.method::text as method, sum(p.amount_cents)::bigint as amount_cents
    from public.payments p
    join valid_sales v on v.id = p.sale_id
    group by p.method
  ), payment_snapshot as (
    select coalesce(jsonb_object_agg(pm.method, pm.amount_cents), '{}'::jsonb) as value
    from payments_by_method pm
  ), employees_by_profile as (
    select v.profile_id, coalesce(pr.display_name, v.profile_id::text) as display_name,
      count(*)::integer as ticket_count, sum(v.total_cents)::bigint as sales_cents
    from valid_sales v
    left join public.profiles pr on pr.id = v.profile_id
    group by v.profile_id, pr.display_name
  ), employee_snapshot as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'profileId', employee.profile_id,
      'displayName', employee.display_name,
      'ticketCount', employee.ticket_count,
      'salesCents', employee.sales_cents
    ) order by employee.sales_cents desc, employee.display_name), '[]'::jsonb) as value
    from employees_by_profile employee
  ), device_snapshot as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'deviceId', d.id,
      'label', coalesce(d.label, 'POS'),
      'status', d.status,
      'lastSeenAt', d.last_seen_at
    ) order by coalesce(d.label, 'POS'), d.id), '[]'::jsonb) as value
    from public.pos_devices d
    where d.organization_id = requested_organization_id
      and d.branch_id = requested_branch_id
      and d.status = 'ACTIVE'
  )
  select jsonb_build_object(
    'totalSalesCents', totals.total_sales_cents,
    'ticketCount', totals.ticket_count,
    'soldWeightGrams', totals.sold_weight_grams,
    'paymentTotals', payment_snapshot.value,
    'employeeTotals', employee_snapshot.value,
    'devices', device_snapshot.value
  )
  from totals, payment_snapshot, employee_snapshot, device_snapshot;
$$;

create function public.get_settlement_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('settlements.read');
  current_timezone text;
  default_period_start timestamptz;
  result jsonb;
begin
  select o.timezone into current_timezone
  from public.organizations o
  where o.id = current_organization_id;
  default_period_start := (
    ((now() at time zone current_timezone)::date - 6)::timestamp
    at time zone current_timezone
  );

  with latest_settlements as (
    select distinct on (s.branch_id) s.branch_id, s.period_end, s.created_at
    from public.settlements s
    where s.organization_id = current_organization_id and s.status = 'CONFIRMED'
    order by s.branch_id, s.period_end desc
  ), branch_periods as (
    select b.id as branch_id, b.name as branch_name,
      latest.period_end as last_settlement_at,
      coalesce(latest.period_end, default_period_start) as period_start
    from public.branches b
    left join latest_settlements latest on latest.branch_id = b.id
    where b.organization_id = current_organization_id and b.active
  ), valid_sales as (
    select periods.branch_id, s.id, s.total_cents
    from branch_periods periods
    join public.sales s on s.organization_id = current_organization_id
      and s.branch_id = periods.branch_id
      and s.status = 'COMPLETED'
      and s.completed_at >= periods.period_start
      and s.completed_at < now()
  ), sale_totals as (
    select v.branch_id, sum(v.total_cents)::bigint as total_sales_cents
    from valid_sales v group by v.branch_id
  ), cash_totals as (
    select v.branch_id, sum(p.amount_cents)::bigint as expected_cash_cents
    from valid_sales v
    join public.payments p on p.sale_id = v.id and p.method = 'CASH'
    group by v.branch_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'branchId', periods.branch_id,
    'branchName', periods.branch_name,
    'lastSettlementAt', periods.last_settlement_at,
    'periodStart', periods.period_start,
    'periodEnd', now(),
    'totalSalesCents', coalesce(sales.total_sales_cents, 0),
    'expectedCashCents', coalesce(cash.expected_cash_cents, 0)
  ) order by periods.branch_name), '[]'::jsonb)
  into result
  from branch_periods periods
  left join sale_totals sales on sales.branch_id = periods.branch_id
  left join cash_totals cash on cash.branch_id = periods.branch_id;
  return result;
end;
$$;

create function public.get_settlement_preview(
  p_branch_id uuid,
  p_period_start_local timestamp without time zone,
  p_period_end_local timestamp without time zone
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('settlements.read');
  current_timezone text;
  current_branch_name text;
  period_start_at timestamptz;
  period_end_at timestamptz;
begin
  select o.timezone, b.name into current_timezone, current_branch_name
  from public.organizations o
  join public.branches b on b.organization_id = o.id
  where o.id = current_organization_id and b.id = p_branch_id and b.active;
  if not found then raise exception 'Branch was not found in this organization' using errcode = '42501'; end if;
  period_start_at := p_period_start_local at time zone current_timezone;
  period_end_at := p_period_end_local at time zone current_timezone;
  if period_end_at <= period_start_at or period_end_at > now() + interval '5 minutes'
     or period_start_at < now() - interval '366 days' then
    raise exception 'Settlement period is invalid' using errcode = '22023';
  end if;
  return app_private.build_settlement_snapshot(current_organization_id, p_branch_id, period_start_at, period_end_at)
    || jsonb_build_object(
      'branchId', p_branch_id, 'branchName', current_branch_name,
      'periodStart', period_start_at, 'periodEnd', period_end_at,
      'timezone', current_timezone
    );
end;
$$;

create function public.confirm_settlement(
  p_branch_id uuid,
  p_period_start_local timestamp without time zone,
  p_period_end_local timestamp without time zone,
  p_received_cash_cents bigint,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('settlements.write');
  current_timezone text;
  period_start_at timestamptz;
  period_end_at timestamptz;
  last_period_end timestamptz;
  snapshot jsonb;
  expected_cash bigint;
  settlement_id uuid;
begin
  select o.timezone into current_timezone
  from public.organizations o
  join public.branches b on b.organization_id = o.id
  where o.id = current_organization_id and b.id = p_branch_id and b.active;
  if not found then raise exception 'Branch was not found in this organization' using errcode = '42501'; end if;
  period_start_at := p_period_start_local at time zone current_timezone;
  period_end_at := p_period_end_local at time zone current_timezone;
  if p_received_cash_cents < 0 or period_end_at <= period_start_at
     or period_end_at > now() + interval '5 minutes'
     or period_start_at < now() - interval '366 days'
     or char_length(btrim(coalesce(p_notes, ''))) > 500 then
    raise exception 'Settlement values or period are invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement:' || p_branch_id::text, 0)
  );
  select max(s.period_end) into last_period_end
  from public.settlements s
  where s.organization_id = current_organization_id
    and s.branch_id = p_branch_id and s.status = 'CONFIRMED';
  if last_period_end is not null and period_start_at <> last_period_end then
    raise exception 'The period must start at the end of the last confirmed settlement' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.settlements s
    where s.organization_id = current_organization_id and s.branch_id = p_branch_id
      and s.status = 'CONFIRMED'
      and tstzrange(s.period_start, s.period_end, '[)') && tstzrange(period_start_at, period_end_at, '[)')
  ) then
    raise exception 'Settlement periods cannot overlap' using errcode = '23P01';
  end if;

  snapshot := app_private.build_settlement_snapshot(current_organization_id, p_branch_id, period_start_at, period_end_at);
  expected_cash := coalesce((snapshot -> 'paymentTotals' ->> 'CASH')::bigint, 0);
  insert into public.settlements (
    organization_id, branch_id, period_start, period_end,
    expected_cash_cents, received_cash_cents, difference_cents,
    total_sales_cents, ticket_count, sold_weight_grams,
    payment_totals, employee_totals, device_sync_snapshot,
    notes, created_by
  ) values (
    current_organization_id, p_branch_id, period_start_at, period_end_at,
    expected_cash, p_received_cash_cents, p_received_cash_cents - expected_cash,
    (snapshot ->> 'totalSalesCents')::bigint,
    (snapshot ->> 'ticketCount')::integer,
    (snapshot ->> 'soldWeightGrams')::bigint,
    snapshot -> 'paymentTotals', snapshot -> 'employeeTotals', snapshot -> 'devices',
    nullif(btrim(p_notes), ''), auth.uid()
  ) returning id into settlement_id;

  perform app_private.write_audit(
    current_organization_id, p_branch_id, 'SETTLEMENT_CONFIRMED', 'settlements', settlement_id,
    null, jsonb_build_object(
      'periodStart', period_start_at, 'periodEnd', period_end_at,
      'expectedCashCents', expected_cash, 'receivedCashCents', p_received_cash_cents,
      'differenceCents', p_received_cash_cents - expected_cash
    )
  );
  return settlement_id;
end;
$$;

create function public.get_settlement_history(
  p_branch_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_has_difference boolean default null,
  p_settlement_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('settlements.read');
  current_timezone text;
  result jsonb;
begin
  select o.timezone into current_timezone from public.organizations o where o.id = current_organization_id;
  with selected_settlements as (
    select settlement.*
    from public.settlements settlement
    where settlement.organization_id = current_organization_id
      and (p_branch_id is null or settlement.branch_id = p_branch_id)
      and (p_from is null or (settlement.period_end at time zone current_timezone)::date >= p_from)
      and (p_to is null or (settlement.period_start at time zone current_timezone)::date <= p_to)
      and (p_has_difference is null or (settlement.difference_cents <> 0) = p_has_difference)
      and (p_settlement_id is null or settlement.id = p_settlement_id)
    order by settlement.created_at desc
    limit 200
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', settlement.id,
    'branchId', settlement.branch_id,
    'branchName', branch.name,
    'periodStart', settlement.period_start,
    'periodEnd', settlement.period_end,
    'expectedCashCents', settlement.expected_cash_cents,
    'receivedCashCents', settlement.received_cash_cents,
    'differenceCents', settlement.difference_cents,
    'totalSalesCents', settlement.total_sales_cents,
    'ticketCount', settlement.ticket_count,
    'soldWeightGrams', settlement.sold_weight_grams,
    'paymentTotals', settlement.payment_totals,
    'employeeTotals', settlement.employee_totals,
    'deviceSyncSnapshot', settlement.device_sync_snapshot,
    'notes', settlement.notes,
    'status', settlement.status,
    'createdBy', settlement.created_by,
    'createdByName', coalesce(profile.display_name, settlement.created_by::text),
    'createdAt', settlement.created_at,
    'voidedAt', settlement.voided_at,
    'voidReason', settlement.void_reason,
    'hasLaterMovements', exists (
      select 1
      from public.sales sale
      left join public.pos_sync_receipts receipt on receipt.event_id = sale.sync_event_id
      where sale.organization_id = settlement.organization_id
        and sale.branch_id = settlement.branch_id
        and sale.completed_at >= settlement.period_start and sale.completed_at < settlement.period_end
        and (
          (receipt.received_at is not null and receipt.received_at > settlement.created_at)
          or (sale.cancelled_at is not null and sale.cancelled_at > settlement.created_at)
        )
    )
  ) order by settlement.created_at desc), '[]'::jsonb)
  into result
  from selected_settlements settlement
  join public.branches branch on branch.id = settlement.branch_id and branch.organization_id = settlement.organization_id
  left join public.profiles profile on profile.id = settlement.created_by;
  return result;
end;
$$;

create function public.void_settlement(p_settlement_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('settlements.write');
  current_settlement public.settlements%rowtype;
begin
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'A valid reason is required to void a settlement' using errcode = '22023';
  end if;
  select * into current_settlement from public.settlements settlement
  where settlement.id = p_settlement_id and settlement.organization_id = current_organization_id
  for update;
  if not found then raise exception 'Settlement was not found' using errcode = '42501'; end if;
  if current_settlement.status <> 'CONFIRMED' then raise exception 'Settlement is already voided' using errcode = '22023'; end if;
  if exists (
    select 1 from public.settlements later
    where later.organization_id = current_organization_id
      and later.branch_id = current_settlement.branch_id
      and later.status = 'CONFIRMED'
      and later.period_end > current_settlement.period_end
  ) then
    raise exception 'Only the latest confirmed settlement can be voided' using errcode = '22023';
  end if;
  update public.settlements
  set status = 'VOIDED', voided_by = auth.uid(), voided_at = now(), void_reason = btrim(p_reason)
  where id = p_settlement_id;
  perform app_private.write_audit(
    current_organization_id, current_settlement.branch_id, 'SETTLEMENT_VOIDED', 'settlements', p_settlement_id,
    jsonb_build_object('status', current_settlement.status),
    jsonb_build_object('status', 'VOIDED', 'reason', btrim(p_reason))
  );
end;
$$;

alter table public.settlements enable row level security;
create policy settlements_select on public.settlements
for select to authenticated
using (app_private.has_permission(organization_id, 'settlements.read'));

revoke all on table public.settlements from public, anon, authenticated;
grant select on table public.settlements to authenticated;

revoke all on function app_private.build_settlement_snapshot(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.get_settlement_overview() from public, anon;
revoke all on function public.get_settlement_preview(uuid, timestamp, timestamp) from public, anon;
revoke all on function public.confirm_settlement(uuid, timestamp, timestamp, bigint, text) from public, anon;
revoke all on function public.get_settlement_history(uuid, date, date, boolean, uuid) from public, anon;
revoke all on function public.void_settlement(uuid, text) from public, anon;
grant execute on function public.get_settlement_overview() to authenticated;
grant execute on function public.get_settlement_preview(uuid, timestamp, timestamp) to authenticated;
grant execute on function public.confirm_settlement(uuid, timestamp, timestamp, bigint, text) to authenticated;
grant execute on function public.get_settlement_history(uuid, date, date, boolean, uuid) to authenticated;
grant execute on function public.void_settlement(uuid, text) to authenticated;

commit;
