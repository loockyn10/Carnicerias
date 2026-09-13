begin;

alter table public.organizations
  add column replenishment_target_days numeric(5,2) not null default 3
  check (replenishment_target_days > 0 and replenishment_target_days <= 30);

create index sales_completed_replenishment_idx
  on public.sales (organization_id, completed_at, branch_id)
  where status = 'COMPLETED';

create function public.get_replenishment_plan(p_days integer default 7)
returns table (
  branch_id uuid,
  branch_name text,
  product_id uuid,
  product_name text,
  unit_type public.unit_type,
  current_quantity bigint,
  minimum_quantity bigint,
  target_quantity bigint,
  sold_recent_quantity bigint,
  sales_days integer,
  target_coverage_days numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('dashboard.read');
  current_timezone text;
  current_target_days numeric;
  sales_start timestamptz;
begin
  if p_days < 1 or p_days > 90 then
    raise exception 'Sales period must be between 1 and 90 days' using errcode = '22023';
  end if;

  select o.timezone, o.replenishment_target_days
  into current_timezone, current_target_days
  from public.organizations o
  where o.id = current_organization_id and o.active;

  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;

  sales_start := (
    ((now() at time zone current_timezone)::date - (p_days - 1))::timestamp
    at time zone current_timezone
  );

  return query
  with recent_sales as (
    select si.branch_id, si.product_id, coalesce(sum(si.weight_grams), 0)::bigint as sold_quantity
    from public.sale_items si
    join public.sales s
      on s.id = si.sale_id
     and s.organization_id = si.organization_id
     and s.branch_id = si.branch_id
    where s.organization_id = current_organization_id
      and s.status = 'COMPLETED'
      and s.completed_at >= sales_start
    group by si.branch_id, si.product_id
  )
  select b.id, b.name, p.id, p.name, p.unit_type,
    coalesce(sl.quantity_grams, 0)::bigint,
    coalesce(settings.minimum_stock_grams, 0)::bigint,
    coalesce(settings.target_stock_grams, 0)::bigint,
    coalesce(recent.sold_quantity, 0)::bigint,
    p_days,
    current_target_days
  from public.branches b
  join public.products p
    on p.organization_id = b.organization_id and p.active
  left join public.stock_levels sl
    on sl.organization_id = b.organization_id
   and sl.branch_id = b.id
   and sl.product_id = p.id
  left join public.branch_product_stock_settings settings
    on settings.organization_id = b.organization_id
   and settings.branch_id = b.id
   and settings.product_id = p.id
  left join recent_sales recent
    on recent.branch_id = b.id and recent.product_id = p.id
  where b.organization_id = current_organization_id
    and b.active
    and app_private.can_access_branch(current_organization_id, b.id, 'dashboard.read')
  order by b.name, p.name;
end;
$$;

create function public.set_replenishment_target_days(p_target_days numeric)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.write');
  previous_target numeric;
  normalized_target numeric := round(p_target_days, 2);
begin
  if normalized_target is null or normalized_target <= 0 or normalized_target > 30 then
    raise exception 'Target coverage must be between 0.01 and 30 days' using errcode = '22023';
  end if;

  select o.replenishment_target_days into previous_target
  from public.organizations o
  where o.id = current_organization_id
  for update;

  update public.organizations
  set replenishment_target_days = normalized_target
  where id = current_organization_id;

  perform app_private.write_audit(
    current_organization_id, null, 'REPLENISHMENT_TARGET_SET', 'organizations',
    current_organization_id,
    jsonb_build_object('targetCoverageDays', previous_target),
    jsonb_build_object('targetCoverageDays', normalized_target)
  );
end;
$$;

revoke all on function public.get_replenishment_plan(integer) from public, anon;
revoke all on function public.set_replenishment_target_days(numeric) from public, anon;
grant execute on function public.get_replenishment_plan(integer) to authenticated;
grant execute on function public.set_replenishment_target_days(numeric) to authenticated;

commit;
