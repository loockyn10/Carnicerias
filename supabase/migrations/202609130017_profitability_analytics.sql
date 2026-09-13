begin;

insert into public.permissions (key, description)
values ('analytics.read', 'Read commercial profitability analytics and historical cost snapshots')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
values ('10000000-0000-4000-8000-000000000001'::uuid, 'analytics.read')
on conflict (role_id, permission_key) do nothing;

create function public.get_profitability_analytics(
  p_preset text default '7d',
  p_from date default null,
  p_to date default null,
  p_branch_id uuid default null,
  p_category_id uuid default null,
  p_product_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('analytics.read');
  current_timezone text;
  local_today date;
  start_date date;
  end_date date;
  previous_start_date date;
  previous_end_date date;
  period_start timestamptz;
  period_end timestamptz;
  previous_period_start timestamptz;
  previous_period_end timestamptz;
  period_days integer;
  current_data jsonb;
  previous_summary jsonb;
  branches jsonb;
  categories jsonb;
begin
  select organization.timezone into current_timezone
  from public.organizations organization
  where organization.id = current_organization_id and organization.active;
  if current_timezone is null then
    raise exception 'Organization timezone is unavailable' using errcode = '22023';
  end if;

  local_today := (now() at time zone current_timezone)::date;
  case p_preset
    when 'today' then start_date := local_today; end_date := local_today;
    when '7d' then start_date := local_today - 6; end_date := local_today;
    when '30d' then start_date := local_today - 29; end_date := local_today;
    when 'custom' then
      if p_from is null or p_to is null then
        raise exception 'A custom period requires both dates' using errcode = '22023';
      end if;
      start_date := p_from;
      end_date := p_to;
    else raise exception 'Analytics period is invalid' using errcode = '22023';
  end case;
  if end_date < start_date or end_date > local_today or end_date - start_date > 365 then
    raise exception 'Analytics date range is invalid' using errcode = '22023';
  end if;

  if p_branch_id is not null and not exists (
    select 1 from public.branches branch
    where branch.id = p_branch_id and branch.organization_id = current_organization_id
  ) then raise exception 'Branch was not found in this organization' using errcode = '42501'; end if;
  if p_category_id is not null and not exists (
    select 1 from public.categories category
    where category.id = p_category_id and category.organization_id = current_organization_id
  ) then raise exception 'Category was not found in this organization' using errcode = '42501'; end if;
  if p_product_id is not null and not exists (
    select 1 from public.products product
    where product.id = p_product_id and product.organization_id = current_organization_id
  ) then raise exception 'Product was not found in this organization' using errcode = '42501'; end if;

  period_days := end_date - start_date + 1;
  previous_end_date := start_date - 1;
  previous_start_date := previous_end_date - period_days + 1;
  period_start := start_date::timestamp at time zone current_timezone;
  period_end := (end_date + 1)::timestamp at time zone current_timezone;
  previous_period_start := previous_start_date::timestamp at time zone current_timezone;
  previous_period_end := (previous_end_date + 1)::timestamp at time zone current_timezone;

  select coalesce(jsonb_agg(jsonb_build_object('id', branch.id, 'name', branch.name) order by branch.name), '[]'::jsonb)
  into branches from public.branches branch
  where branch.organization_id = current_organization_id and branch.active;
  select coalesce(jsonb_agg(jsonb_build_object('id', category.id, 'name', category.name) order by category.sort_order, category.name), '[]'::jsonb)
  into categories from public.categories category
  where category.organization_id = current_organization_id and category.active;

  with lines as materialized (
    select item.product_id,
      product.name as product_name,
      product.unit_type,
      product.category_id,
      category.name as category_name,
      sale.branch_id,
      branch.name as branch_name,
      (sale.completed_at at time zone current_timezone)::date as local_day,
      item.weight_grams::bigint as quantity,
      item.subtotal_cents::bigint as revenue_cents,
      case
        when item.cost_cents_snapshot is null then null
        when product.unit_type = 'UNIT' then (item.cost_cents_snapshot::numeric * item.weight_grams)::bigint
        else round(item.cost_cents_snapshot::numeric * item.weight_grams / 1000)::bigint
      end as cost_cents
    from public.sales sale
    join public.sale_items item on item.sale_id = sale.id
      and item.organization_id = sale.organization_id and item.branch_id = sale.branch_id
    join public.products product on product.id = item.product_id and product.organization_id = item.organization_id
    join public.categories category on category.id = product.category_id and category.organization_id = product.organization_id
    join public.branches branch on branch.id = sale.branch_id and branch.organization_id = sale.organization_id
    where sale.organization_id = current_organization_id
      and sale.status = 'COMPLETED'
      and sale.completed_at >= period_start and sale.completed_at < period_end
      and (p_branch_id is null or sale.branch_id = p_branch_id)
      and (p_category_id is null or product.category_id = p_category_id)
  ), summary as (
    select coalesce(sum(line.revenue_cents), 0)::bigint as revenue_cents,
      coalesce(sum(line.revenue_cents) filter (where line.cost_cents is not null), 0)::bigint as costed_revenue_cents,
      coalesce(sum(line.cost_cents), 0)::bigint as cost_cents,
      coalesce(sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null), 0)::bigint as gross_profit_cents,
      coalesce(sum(line.quantity) filter (where line.unit_type = 'WEIGHT'), 0)::bigint as weight_grams,
      coalesce(sum(line.quantity) filter (where line.unit_type = 'UNIT'), 0)::bigint as unit_count,
      count(*) filter (where line.cost_cents is null)::integer as missing_cost_items
    from lines line
  ), product_groups as (
    select line.product_id, line.product_name, line.unit_type, line.category_id, line.category_name,
      sum(line.quantity)::bigint as quantity,
      sum(line.revenue_cents)::bigint as revenue_cents,
      sum(line.revenue_cents) filter (where line.cost_cents is not null)::bigint as costed_revenue_cents,
      sum(line.cost_cents)::bigint as known_cost_cents,
      sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null)::bigint as known_gross_profit_cents,
      sum(line.quantity) filter (where line.cost_cents is not null)::bigint as costed_quantity,
      count(*) filter (where line.cost_cents is null)::integer as missing_cost_items
    from lines line
    group by line.product_id, line.product_name, line.unit_type, line.category_id, line.category_name
  ), product_rows as (
    select product_group.*,
      case when product_group.missing_cost_items = 0 then coalesce(product_group.known_cost_cents, 0) end as cost_cents,
      case when product_group.missing_cost_items = 0 then coalesce(product_group.known_gross_profit_cents, 0) end as gross_profit_cents,
      case when product_group.missing_cost_items = 0 and product_group.known_cost_cents > 0
        then round(product_group.known_gross_profit_cents::numeric * 10000 / product_group.known_cost_cents)::bigint end as profitability_bps,
      case when product_group.missing_cost_items = 0 and product_group.costed_quantity > 0
        then round(product_group.known_gross_profit_cents::numeric * (case when product_group.unit_type = 'WEIGHT' then 1000 else 1 end) / product_group.costed_quantity)::bigint end as profit_per_measure_cents
    from product_groups product_group
  ), category_groups as (
    select line.category_id, line.category_name,
      sum(line.revenue_cents)::bigint as revenue_cents,
      sum(line.cost_cents)::bigint as known_cost_cents,
      sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null)::bigint as known_gross_profit_cents,
      count(*) filter (where line.cost_cents is null)::integer as missing_cost_items
    from lines line group by line.category_id, line.category_name
  ), branch_groups as (
    select line.branch_id, line.branch_name, line.unit_type,
      sum(line.quantity)::bigint as quantity,
      sum(line.revenue_cents)::bigint as revenue_cents,
      sum(line.cost_cents)::bigint as known_cost_cents,
      sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null)::bigint as known_gross_profit_cents,
      count(*) filter (where line.cost_cents is null)::integer as missing_cost_items
    from lines line where p_product_id is not null and line.product_id = p_product_id
    group by line.branch_id, line.branch_name, line.unit_type
  ), daily_groups as (
    select line.local_day, line.unit_type,
      sum(line.quantity)::bigint as quantity,
      sum(line.revenue_cents)::bigint as revenue_cents,
      sum(line.cost_cents)::bigint as known_cost_cents,
      sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null)::bigint as known_gross_profit_cents,
      count(*) filter (where line.cost_cents is null)::integer as missing_cost_items
    from lines line where p_product_id is not null and line.product_id = p_product_id
    group by line.local_day, line.unit_type
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'revenueCents', summary.revenue_cents,
      'costedRevenueCents', summary.costed_revenue_cents,
      'costCents', summary.cost_cents,
      'grossProfitCents', summary.gross_profit_cents,
      'profitabilityBps', case when summary.cost_cents > 0 then round(summary.gross_profit_cents::numeric * 10000 / summary.cost_cents)::bigint end,
      'coverageBps', case when summary.revenue_cents > 0 then round(summary.costed_revenue_cents::numeric * 10000 / summary.revenue_cents)::bigint else 10000 end,
      'missingCostItems', summary.missing_cost_items,
      'weightGrams', summary.weight_grams,
      'unitCount', summary.unit_count
    ),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
      'productId', row.product_id, 'productName', row.product_name, 'unitType', row.unit_type,
      'categoryId', row.category_id, 'categoryName', row.category_name,
      'quantity', row.quantity, 'revenueCents', row.revenue_cents,
      'costCents', row.cost_cents, 'grossProfitCents', row.gross_profit_cents,
      'profitabilityBps', row.profitability_bps, 'profitPerMeasureCents', row.profit_per_measure_cents,
      'missingCostItems', row.missing_cost_items
    ) order by row.gross_profit_cents desc nulls last, row.revenue_cents desc) from product_rows row), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
      'categoryId', row.category_id, 'categoryName', row.category_name,
      'revenueCents', row.revenue_cents,
      'costCents', case when row.missing_cost_items = 0 then coalesce(row.known_cost_cents, 0) end,
      'grossProfitCents', case when row.missing_cost_items = 0 then coalesce(row.known_gross_profit_cents, 0) end,
      'missingCostItems', row.missing_cost_items
    ) order by row.revenue_cents desc) from category_groups row), '[]'::jsonb),
    'detail', case when p_product_id is null then null else (
      select jsonb_build_object(
        'productId', product.id, 'productName', product.name, 'unitType', product.unit_type,
        'categoryName', category.name,
        'summary', coalesce((select jsonb_build_object(
          'quantity', row.quantity, 'revenueCents', row.revenue_cents,
          'costCents', row.cost_cents, 'grossProfitCents', row.gross_profit_cents,
          'profitabilityBps', row.profitability_bps, 'profitPerMeasureCents', row.profit_per_measure_cents,
          'missingCostItems', row.missing_cost_items
        ) from product_rows row where row.product_id = product.id), jsonb_build_object(
          'quantity', 0, 'revenueCents', 0, 'costCents', 0, 'grossProfitCents', 0,
          'profitabilityBps', null, 'profitPerMeasureCents', 0, 'missingCostItems', 0
        )),
        'branches', coalesce((select jsonb_agg(jsonb_build_object(
          'branchId', row.branch_id, 'branchName', row.branch_name, 'quantity', row.quantity,
          'revenueCents', row.revenue_cents,
          'costCents', case when row.missing_cost_items = 0 then coalesce(row.known_cost_cents, 0) end,
          'grossProfitCents', case when row.missing_cost_items = 0 then coalesce(row.known_gross_profit_cents, 0) end,
          'profitabilityBps', case when row.missing_cost_items = 0 and row.known_cost_cents > 0 then round(row.known_gross_profit_cents::numeric * 10000 / row.known_cost_cents)::bigint end,
          'missingCostItems', row.missing_cost_items
        ) order by row.known_gross_profit_cents desc nulls last, row.revenue_cents desc) from branch_groups row), '[]'::jsonb),
        'evolution', coalesce((select jsonb_agg(jsonb_build_object(
          'date', row.local_day, 'quantity', row.quantity, 'revenueCents', row.revenue_cents,
          'grossProfitCents', case when row.missing_cost_items = 0 then coalesce(row.known_gross_profit_cents, 0) end,
          'missingCostItems', row.missing_cost_items
        ) order by row.local_day) from daily_groups row), '[]'::jsonb)
      )
      from public.products product
      join public.categories category on category.id = product.category_id and category.organization_id = product.organization_id
      where product.id = p_product_id and product.organization_id = current_organization_id
    ) end
  ) into current_data from summary;

  with lines as (
    select item.subtotal_cents::bigint as revenue_cents,
      case
        when item.cost_cents_snapshot is null then null
        when product.unit_type = 'UNIT' then (item.cost_cents_snapshot::numeric * item.weight_grams)::bigint
        else round(item.cost_cents_snapshot::numeric * item.weight_grams / 1000)::bigint
      end as cost_cents
    from public.sales sale
    join public.sale_items item on item.sale_id = sale.id
      and item.organization_id = sale.organization_id and item.branch_id = sale.branch_id
    join public.products product on product.id = item.product_id and product.organization_id = item.organization_id
    where sale.organization_id = current_organization_id
      and sale.status = 'COMPLETED'
      and sale.completed_at >= previous_period_start and sale.completed_at < previous_period_end
      and (p_branch_id is null or sale.branch_id = p_branch_id)
      and (p_category_id is null or product.category_id = p_category_id)
  )
  select jsonb_build_object(
    'revenueCents', coalesce(sum(line.revenue_cents), 0)::bigint,
    'costedRevenueCents', coalesce(sum(line.revenue_cents) filter (where line.cost_cents is not null), 0)::bigint,
    'costCents', coalesce(sum(line.cost_cents), 0)::bigint,
    'grossProfitCents', coalesce(sum(line.revenue_cents - line.cost_cents) filter (where line.cost_cents is not null), 0)::bigint,
    'coverageBps', case when coalesce(sum(line.revenue_cents), 0) > 0
      then round(coalesce(sum(line.revenue_cents) filter (where line.cost_cents is not null), 0)::numeric * 10000 / sum(line.revenue_cents))::bigint else 10000 end
  ) into previous_summary from lines line;

  return jsonb_build_object(
    'timezone', current_timezone,
    'period', jsonb_build_object('preset', p_preset, 'from', start_date, 'to', end_date, 'startAt', period_start, 'endAt', period_end),
    'previousPeriod', jsonb_build_object('from', previous_start_date, 'to', previous_end_date),
    'branches', branches,
    'categoryOptions', categories,
    'summary', current_data -> 'summary',
    'previousSummary', previous_summary,
    'products', current_data -> 'products',
    'categories', current_data -> 'categories',
    'detail', current_data -> 'detail'
  );
end;
$$;

revoke all on function public.get_profitability_analytics(text, date, date, uuid, uuid, uuid) from public, anon;
grant execute on function public.get_profitability_analytics(text, date, date, uuid, uuid, uuid) to authenticated;

commit;
