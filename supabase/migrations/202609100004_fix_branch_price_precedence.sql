begin;

-- Boolean equality is NULL for global prices. With DESC, PostgreSQL sorts
-- NULL first unless NULLS LAST is explicit, which incorrectly preferred the
-- global price over a matching branch override.
create or replace function public.get_pos_catalog(p_branch_id uuid)
returns table (
  organization_id uuid,
  branch_id uuid,
  branch_name text,
  category_id uuid,
  category_name text,
  category_sort_order integer,
  product_id uuid,
  product_name text,
  product_sku text,
  unit_type public.unit_type,
  price_per_kg_cents bigint,
  price_valid_from timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select b.organization_id
  into current_organization_id
  from public.branches b
  where b.id = p_branch_id
    and b.active;

  if current_organization_id is null
     or not app_private.can_access_branch(current_organization_id, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  return query
  select
    p.organization_id,
    b.id,
    b.name,
    c.id,
    c.name,
    c.sort_order,
    p.id,
    p.name,
    p.sku,
    p.unit_type,
    effective_price.price_cents,
    effective_price.valid_from
  from public.products p
  join public.categories c
    on c.id = p.category_id
    and c.organization_id = p.organization_id
    and c.active
  join public.branches b
    on b.id = p_branch_id
    and b.organization_id = p.organization_id
  join lateral (
    select pp.price_cents, pp.valid_from
    from public.product_prices pp
    where pp.organization_id = p.organization_id
      and pp.product_id = p.id
      and (pp.branch_id = p_branch_id or pp.branch_id is null)
      and pp.valid_from <= now()
      and (pp.valid_to is null or pp.valid_to > now())
    order by (pp.branch_id = p_branch_id) desc nulls last, pp.valid_from desc
    limit 1
  ) effective_price on true
  where p.organization_id = current_organization_id
    and p.active
  order by c.sort_order, c.name, p.name;
end;
$$;

create or replace function public.complete_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_payment_method text
)
returns table (
  sale_id uuid,
  total_cents bigint,
  total_weight_grams bigint,
  completed_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_profile_id uuid := auth.uid();
  current_organization_id uuid;
  current_sale_id uuid;
  current_completed_at timestamptz := now();
  current_method public.payment_method;
  item jsonb;
  item_product_id uuid;
  item_weight_grams integer;
  item_expected_price bigint;
  current_product_name text;
  current_unit_type public.unit_type;
  current_price bigint;
  current_subtotal bigint;
  computed_total_cents bigint := 0;
  computed_total_weight bigint := 0;
begin
  if current_profile_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) < 1
     or pg_catalog.jsonb_array_length(p_items) > 100 then
    raise exception 'A sale must contain between 1 and 100 items' using errcode = '22023';
  end if;

  begin
    current_method := pg_catalog.upper(p_payment_method)::public.payment_method;
  exception when invalid_text_representation then
    raise exception 'Unsupported payment method' using errcode = '22023';
  end;

  if current_method is null then
    raise exception 'Unsupported payment method' using errcode = '22023';
  end if;

  select b.organization_id
  into current_organization_id
  from public.branches b
  where b.id = p_branch_id
    and b.active;

  if current_organization_id is null
     or not app_private.can_access_branch(current_organization_id, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  insert into public.sales (
    organization_id,
    branch_id,
    profile_id,
    status,
    total_cents,
    total_weight_grams,
    completed_at
  ) values (
    current_organization_id,
    p_branch_id,
    current_profile_id,
    'COMPLETED',
    0,
    0,
    current_completed_at
  ) returning id into current_sale_id;

  for item in select value from pg_catalog.jsonb_array_elements(p_items)
  loop
    begin
      item_product_id := (item ->> 'product_id')::uuid;
      item_weight_grams := (item ->> 'weight_grams')::integer;
      item_expected_price := (item ->> 'expected_price_per_kg_cents')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Every item needs valid product_id, weight_grams and expected_price_per_kg_cents' using errcode = '22023';
    end;

    if item_product_id is null
       or item_weight_grams is null
       or item_weight_grams <= 0
       or item_expected_price is null
       or item_expected_price <= 0 then
      raise exception 'Every item needs positive integer weight and price values' using errcode = '22023';
    end if;

    select p.name, p.unit_type, effective_price.price_cents
    into current_product_name, current_unit_type, current_price
    from public.products p
    join lateral (
      select pp.price_cents
      from public.product_prices pp
      where pp.organization_id = p.organization_id
        and pp.product_id = p.id
        and (pp.branch_id = p_branch_id or pp.branch_id is null)
        and pp.valid_from <= current_completed_at
        and (pp.valid_to is null or pp.valid_to > current_completed_at)
      order by (pp.branch_id = p_branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) effective_price on true
    where p.id = item_product_id
      and p.organization_id = current_organization_id
      and p.active
    for share of p;

    if not found then
      raise exception 'Product is unavailable or has no current price' using errcode = '22023';
    end if;

    if current_unit_type <> 'WEIGHT' then
      raise exception 'The online POS currently supports WEIGHT products only' using errcode = '0A000';
    end if;

    if current_price <> item_expected_price then
      raise exception 'Product price changed; reload the catalog and retry' using errcode = '40001';
    end if;

    current_subtotal := (current_price * item_weight_grams::bigint + 500) / 1000;
    if current_subtotal <= 0 then
      raise exception 'Calculated subtotal must be positive' using errcode = '22023';
    end if;

    insert into public.sale_items (
      sale_id,
      organization_id,
      branch_id,
      product_id,
      product_name_snapshot,
      weight_grams,
      price_per_kg_cents,
      subtotal_cents,
      created_at
    ) values (
      current_sale_id,
      current_organization_id,
      p_branch_id,
      item_product_id,
      current_product_name,
      item_weight_grams,
      current_price,
      current_subtotal,
      current_completed_at
    );

    insert into public.stock_movements (
      organization_id,
      branch_id,
      product_id,
      type,
      quantity_grams,
      sale_id,
      profile_id,
      occurred_at,
      created_at
    ) values (
      current_organization_id,
      p_branch_id,
      item_product_id,
      'SALE',
      -item_weight_grams::bigint,
      current_sale_id,
      current_profile_id,
      current_completed_at,
      current_completed_at
    );

    computed_total_cents := computed_total_cents + current_subtotal;
    computed_total_weight := computed_total_weight + item_weight_grams;
  end loop;

  update public.sales
  set total_cents = computed_total_cents,
      total_weight_grams = computed_total_weight
  where id = current_sale_id;

  insert into public.payments (
    sale_id,
    organization_id,
    branch_id,
    method,
    amount_cents,
    created_at
  ) values (
    current_sale_id,
    current_organization_id,
    p_branch_id,
    current_method,
    computed_total_cents,
    current_completed_at
  );

  return query
  select current_sale_id, computed_total_cents, computed_total_weight, current_completed_at;
end;
$$;

commit;
