begin;

create type public.sale_status as enum ('DRAFT', 'COMPLETED', 'CANCELLED', 'REFUNDED');
create type public.payment_method as enum ('CASH', 'TRANSFER', 'DEBIT', 'CREDIT', 'OTHER');
create type public.stock_movement_type as enum (
  'PURCHASE',
  'SALE',
  'WASTE',
  'ADJUSTMENT_POSITIVE',
  'ADJUSTMENT_NEGATIVE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'RETURN'
);

create table public.sales (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  status public.sale_status not null default 'DRAFT',
  total_cents bigint not null default 0 check (total_cents >= 0),
  total_weight_grams bigint not null default 0 check (total_weight_grams >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete restrict,
  unique (id, organization_id, branch_id),
  check (
    (status = 'DRAFT' and completed_at is null)
    or (status <> 'DRAFT' and completed_at is not null)
  )
);

create table public.sale_items (
  id uuid primary key default extensions.gen_random_uuid(),
  sale_id uuid not null,
  organization_id uuid not null,
  branch_id uuid not null,
  product_id uuid not null,
  product_name_snapshot text not null check (char_length(btrim(product_name_snapshot)) between 1 and 120),
  weight_grams integer not null check (weight_grams > 0),
  price_per_kg_cents bigint not null check (price_per_kg_cents > 0),
  subtotal_cents bigint not null check (subtotal_cents > 0),
  created_at timestamptz not null default now(),
  foreign key (sale_id, organization_id, branch_id)
    references public.sales(id, organization_id, branch_id) on delete restrict,
  foreign key (product_id, organization_id)
    references public.products(id, organization_id) on delete restrict
);

create table public.payments (
  id uuid primary key default extensions.gen_random_uuid(),
  sale_id uuid not null,
  organization_id uuid not null,
  branch_id uuid not null,
  method public.payment_method not null,
  amount_cents bigint not null check (amount_cents > 0),
  created_at timestamptz not null default now(),
  foreign key (sale_id, organization_id, branch_id)
    references public.sales(id, organization_id, branch_id) on delete restrict
);

create table public.stock_movements (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  product_id uuid not null,
  type public.stock_movement_type not null,
  quantity_grams bigint not null check (quantity_grams <> 0),
  sale_id uuid,
  reason text check (reason is null or char_length(btrim(reason)) between 1 and 500),
  profile_id uuid not null references public.profiles(id) on delete restrict,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete restrict,
  foreign key (product_id, organization_id)
    references public.products(id, organization_id) on delete restrict,
  foreign key (sale_id, organization_id, branch_id)
    references public.sales(id, organization_id, branch_id) on delete restrict,
  check (
    (type in ('PURCHASE', 'ADJUSTMENT_POSITIVE', 'TRANSFER_IN', 'RETURN') and quantity_grams > 0)
    or (type in ('SALE', 'WASTE', 'ADJUSTMENT_NEGATIVE', 'TRANSFER_OUT') and quantity_grams < 0)
  ),
  check ((type = 'SALE' and sale_id is not null) or type <> 'SALE')
);

comment on table public.stock_movements is
  'Append-only stock ledger. Current stock is derived by summing quantity_grams; it is never the sole mutable source of truth.';
comment on column public.sale_items.price_per_kg_cents is
  'Price snapshot used to complete the sale. Historical sales never read current product_prices.';

create index sales_organization_branch_created_idx
  on public.sales (organization_id, branch_id, created_at desc);
create index sales_profile_created_idx on public.sales (profile_id, created_at desc);
create index sale_items_sale_idx on public.sale_items (sale_id, created_at);
create index payments_sale_idx on public.payments (sale_id, created_at);
create index stock_movements_stock_idx
  on public.stock_movements (organization_id, branch_id, product_id, occurred_at);
create index stock_movements_sale_idx on public.stock_movements (sale_id) where sale_id is not null;

create view public.stock_levels
with (security_invoker = true)
as
select
  organization_id,
  branch_id,
  product_id,
  sum(quantity_grams)::bigint as quantity_grams,
  max(occurred_at) as last_movement_at
from public.stock_movements
group by organization_id, branch_id, product_id;

insert into public.permissions (key, description) values
  ('sales.create', 'Complete sales in an authorized branch'),
  ('sales.read', 'Read sales in authorized branches'),
  ('stock.read', 'Read stock movements and derived levels in authorized branches')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-4000-8000-000000000001', 'sales.create'),
  ('10000000-0000-4000-8000-000000000001', 'sales.read'),
  ('10000000-0000-4000-8000-000000000001', 'stock.read'),
  ('10000000-0000-4000-8000-000000000002', 'sales.create'),
  ('10000000-0000-4000-8000-000000000002', 'sales.read'),
  ('10000000-0000-4000-8000-000000000002', 'stock.read')
on conflict (role_id, permission_key) do nothing;

create function app_private.can_access_branch(
  requested_organization_id uuid,
  requested_branch_id uuid,
  requested_permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    app_private.has_permission(requested_organization_id, requested_permission)
    and exists (
      select 1
      from public.branches b
      where b.id = requested_branch_id
        and b.organization_id = requested_organization_id
        and b.active
    )
    and (
      app_private.has_permission(requested_organization_id, 'branches.read_all')
      or app_private.is_branch_member(requested_branch_id)
    );
$$;

create function public.get_pos_catalog(p_branch_id uuid)
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
    order by (pp.branch_id = p_branch_id) desc, pp.valid_from desc
    limit 1
  ) effective_price on true
  where p.organization_id = current_organization_id
    and p.active
  order by c.sort_order, c.name, p.name;
end;
$$;

create function public.complete_sale(
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
      order by (pp.branch_id = p_branch_id) desc, pp.valid_from desc
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

revoke all on function app_private.can_access_branch(uuid, uuid, text) from public, anon;
grant execute on function app_private.can_access_branch(uuid, uuid, text) to authenticated;

revoke all on function public.get_pos_catalog(uuid) from public, anon;
revoke all on function public.complete_sale(uuid, jsonb, text) from public, anon;
grant execute on function public.get_pos_catalog(uuid) to authenticated;
grant execute on function public.complete_sale(uuid, jsonb, text) to authenticated;

alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.payments enable row level security;
alter table public.stock_movements enable row level security;

create policy sales_select on public.sales
for select to authenticated
using (app_private.can_access_branch(organization_id, branch_id, 'sales.read'));

create policy sale_items_select on public.sale_items
for select to authenticated
using (app_private.can_access_branch(organization_id, branch_id, 'sales.read'));

create policy payments_select on public.payments
for select to authenticated
using (app_private.can_access_branch(organization_id, branch_id, 'sales.read'));

create policy stock_movements_select on public.stock_movements
for select to authenticated
using (app_private.can_access_branch(organization_id, branch_id, 'stock.read'));

revoke all on table public.sales, public.sale_items, public.payments, public.stock_movements from anon;
revoke all on table public.stock_levels from anon;

grant select on public.sales, public.sale_items, public.payments, public.stock_movements to authenticated;
grant select on public.stock_levels to authenticated;

commit;
