begin;

-- Stock operations for UNIT products in Admin, without a second ledger or duplicated logic:
-- stock_movements already stores a UNIT quantity in quantity_grams (whole units, D-038/D-042),
-- so every view below just exposes unit_type and stops filtering on WEIGHT. Also honours the
-- branch assortment (a product only appears in the branches that carry it).

-- ---------------------------------------------------------------------------------------------
-- branch_stock_status (view): assortment-aware, UNIT included, unit_type appended (same leading
-- columns as 202609100008, so CREATE OR REPLACE is valid and existing consumers are unaffected).
-- ---------------------------------------------------------------------------------------------
create or replace view public.branch_stock_status with (security_invoker = true) as
select b.organization_id, b.id branch_id, b.name branch_name, p.id product_id, p.name product_name, p.sku,
  coalesce(sl.quantity_grams, 0)::bigint current_stock_grams, coalesce(s.minimum_stock_grams, 0)::bigint minimum_stock_grams,
  coalesce(s.target_stock_grams, 0)::bigint target_stock_grams,
  greatest(coalesce(s.target_stock_grams,0)-coalesce(sl.quantity_grams,0),0)::bigint suggested_replenishment_grams,
  case when not p.active then 'DISCONTINUED' when coalesce(sl.quantity_grams,0) <= 0 then 'OUT_OF_STOCK'
       when coalesce(sl.quantity_grams,0) < coalesce(s.minimum_stock_grams,0) then 'LOW_STOCK' else 'AVAILABLE' end stock_status,
  sl.last_movement_at,
  p.unit_type
from public.branches b
join public.products p on p.organization_id = b.organization_id
join public.branch_product_assortment a on a.branch_id = b.id and a.product_id = p.id
left join public.stock_levels sl on sl.organization_id=b.organization_id and sl.branch_id=b.id and sl.product_id=p.id
left join public.branch_product_stock_settings s on s.organization_id=b.organization_id and s.branch_id=b.id and s.product_id=p.id
where b.active;

-- ---------------------------------------------------------------------------------------------
-- get_branch_stock_status: filters + pagination, so a Central with thousands of products never
-- depends on returning (and silently truncating) every row. Old (uuid) signature is dropped
-- (return type gains columns → cannot be CREATE OR REPLACE); calling it with no arguments
-- still works through the defaults.
-- ---------------------------------------------------------------------------------------------
drop function public.get_branch_stock_status(uuid);

create function public.get_branch_stock_status(
  p_branch_id uuid default null,
  p_search text default null,
  p_status text default null,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  branch_id uuid,
  branch_name text,
  product_id uuid,
  product_name text,
  current_stock_grams bigint,
  minimum_stock_grams bigint,
  target_stock_grams bigint,
  suggested_replenishment_grams bigint,
  stock_status text,
  unit_type public.unit_type,
  sku text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.read');
  normalized_search text := app_private.import_normalize_text(p_search);
begin
  if p_status is not null and p_status not in ('OUT_OF_STOCK', 'LOW_STOCK', 'AVAILABLE', 'DISCONTINUED', 'ALERTS') then
    raise exception 'Unsupported stock status filter' using errcode = '22023';
  end if;
  if p_limit is not null and p_limit not between 1 and 500 then
    raise exception 'Limit must be between 1 and 500' using errcode = '22023';
  end if;
  if coalesce(p_offset, 0) < 0 then
    raise exception 'Offset must not be negative' using errcode = '22023';
  end if;

  return query
  with stock_rows as (
    select
      b.id as b_id, b.name as b_name, p.id as p_id, p.name as p_name,
      coalesce(sl.quantity_grams, 0)::bigint as current_qty,
      coalesce(s.minimum_stock_grams, 0)::bigint as minimum_qty,
      coalesce(s.target_stock_grams, 0)::bigint as target_qty,
      greatest(coalesce(s.target_stock_grams, 0) - coalesce(sl.quantity_grams, 0), 0)::bigint as suggested_qty,
      case
        when not p.active then 'DISCONTINUED'
        when coalesce(sl.quantity_grams, 0) <= 0 then 'OUT_OF_STOCK'
        when coalesce(sl.quantity_grams, 0) < coalesce(s.minimum_stock_grams, 0) then 'LOW_STOCK'
        else 'AVAILABLE'
      end as status,
      p.unit_type as p_unit_type, p.sku as p_sku
    from public.branches b
    join public.products p on p.organization_id = b.organization_id
    join public.branch_product_assortment a on a.branch_id = b.id and a.product_id = p.id
    left join public.stock_levels sl
      on sl.organization_id = b.organization_id and sl.branch_id = b.id and sl.product_id = p.id
    left join public.branch_product_stock_settings s
      on s.organization_id = b.organization_id and s.branch_id = b.id and s.product_id = p.id
    where b.organization_id = current_organization_id
      and b.active
      and (p_branch_id is null or b.id = p_branch_id)
      and app_private.can_access_branch(current_organization_id, b.id, 'stock.read')
      and (
        normalized_search is null
        or app_private.import_normalize_text(p.name) like '%' || normalized_search || '%'
        or upper(coalesce(p.sku, '')) like '%' || upper(btrim(p_search)) || '%'
      )
  ), filtered as (
    select r.* from stock_rows r
    where p_status is null
       or r.status = p_status
       or (p_status = 'ALERTS' and r.status in ('OUT_OF_STOCK', 'LOW_STOCK'))
  )
  select f.b_id, f.b_name, f.p_id, f.p_name, f.current_qty, f.minimum_qty, f.target_qty, f.suggested_qty,
         f.status, f.p_unit_type, f.p_sku, count(*) over ()
  from filtered f
  -- ALERTS: most urgent first (sold out, then below minimum); otherwise by branch and name.
  order by
    case when p_status = 'ALERTS' then (case f.status when 'OUT_OF_STOCK' then 0 when 'LOW_STOCK' then 1 else 2 end) else 0 end,
    f.b_name, f.p_name, f.p_id
  limit p_limit offset coalesce(p_offset, 0);
end;
$$;

-- Per-branch counts for the dashboards (/admin, /admin/branches), so they never pull every
-- (branch x product) row just to count alerts. Same status rules as get_branch_stock_status.
create function public.get_branch_stock_summary()
returns table (
  branch_id uuid,
  branch_name text,
  product_count bigint,
  out_of_stock_count bigint,
  low_stock_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.read');
begin
  return query
  select b.id, b.name,
    count(p.id)::bigint,
    count(p.id) filter (where p.active and coalesce(sl.quantity_grams, 0) <= 0)::bigint,
    count(p.id) filter (where p.active and coalesce(sl.quantity_grams, 0) > 0
      and coalesce(sl.quantity_grams, 0) < coalesce(s.minimum_stock_grams, 0))::bigint
  from public.branches b
  left join public.branch_product_assortment a on a.branch_id = b.id
  left join public.products p on p.id = a.product_id and p.organization_id = b.organization_id
  left join public.stock_levels sl
    on sl.organization_id = b.organization_id and sl.branch_id = b.id and sl.product_id = p.id
  left join public.branch_product_stock_settings s
    on s.organization_id = b.organization_id and s.branch_id = b.id and s.product_id = p.id
  where b.organization_id = current_organization_id
    and b.active
    and app_private.can_access_branch(current_organization_id, b.id, 'stock.read')
  group by b.id, b.name
  order by b.name;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Replenishment: only products enabled in each branch.
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_replenishment_plan(p_days integer default 7)
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
    select si.branch_id, si.product_id, coalesce(sum(coalesce(si.weight_grams, si.quantity_units)), 0)::bigint as sold_quantity
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
  join public.branch_product_assortment assortment
    on assortment.branch_id = b.id and assortment.product_id = p.id
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
  order by b.name, b.id, p.name, p.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Transfers: WEIGHT (grams) and UNIT (whole units), destination must carry the product.
-- ---------------------------------------------------------------------------------------------
alter table public.stock_transfers add column total_units bigint not null default 0 check (total_units >= 0);
comment on column public.stock_transfers.total_units is
  'Sum of UNIT items (whole units). total_weight_grams keeps summing WEIGHT items only: kg and units are never added together.';

create or replace function public.create_stock_transfer(
  p_source_branch_id uuid,
  p_destination_branch_id uuid,
  p_items jsonb,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.write');
  current_transfer_id uuid;
  current_actor uuid := auth.uid();
  occurred_at timestamptz := now();
  item jsonb;
  item_product_id uuid;
  item_quantity_grams integer;
  item_product_name text;
  item_unit_type public.unit_type;
  current_quantity bigint;
  seen_product_ids uuid[] := '{}';
  computed_total_weight bigint := 0;
  computed_total_units bigint := 0;
  computed_item_count integer := 0;
begin
  if p_source_branch_id is null or p_destination_branch_id is null then
    raise exception 'Origen y destino son obligatorios' using errcode = '22023';
  end if;
  if p_source_branch_id = p_destination_branch_id then
    raise exception 'El origen y el destino deben ser sucursales distintas' using errcode = '22023';
  end if;
  if not app_private.can_access_branch(current_organization_id, p_source_branch_id, 'stock.write') then
    raise exception 'Origin branch is not authorized for this user' using errcode = '42501';
  end if;
  if not app_private.can_access_branch(current_organization_id, p_destination_branch_id, 'stock.write') then
    raise exception 'Destination branch is not authorized for this user' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 100 then
    raise exception 'A transfer must contain between 1 and 100 items' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_notes, ''))) > 500 then
    raise exception 'Las notas superan el largo permitido' using errcode = '22023';
  end if;

  insert into public.stock_transfers (
    organization_id, source_branch_id, destination_branch_id, notes, created_by
  ) values (
    current_organization_id, p_source_branch_id, p_destination_branch_id, nullif(btrim(p_notes), ''), current_actor
  ) returning id into current_transfer_id;

  for item in select value from jsonb_array_elements(p_items)
  loop
    begin
      item_product_id := (item ->> 'product_id')::uuid;
      item_quantity_grams := (item ->> 'quantity_grams')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Every transfer item needs a valid product_id and quantity_grams' using errcode = '22023';
    end;

    if item_product_id is null or item_quantity_grams is null or item_quantity_grams <= 0 then
      raise exception 'Every transfer item needs a product and a positive quantity' using errcode = '22023';
    end if;
    if item_product_id = any(seen_product_ids) then
      raise exception 'El mismo producto no puede repetirse en una transferencia' using errcode = '22023';
    end if;
    seen_product_ids := seen_product_ids || item_product_id;

    -- WEIGHT products move in grams, UNIT products in whole units (the ledger already stores a
    -- UNIT quantity in quantity_grams, D-038/D-042). kg and units are never added together.
    select p.name, p.unit_type into item_product_name, item_unit_type
    from public.products p
    where p.id = item_product_id and p.organization_id = current_organization_id and p.active;
    if item_product_name is null then
      raise exception 'Product must be an active product in this organization' using errcode = '42501';
    end if;
    -- Stock must never land where the product is not carried: it would be invisible in that
    -- branch's POS. The destination must have the product enabled (surtido).
    if not exists (
      select 1 from public.branch_product_assortment a
      where a.organization_id = current_organization_id and a.branch_id = p_destination_branch_id
        and a.product_id = item_product_id
    ) then
      raise exception 'El producto "%" no está habilitado en la sucursal destino', item_product_name using errcode = '22023';
    end if;

    -- Same advisory lock key the stock_movements insert trigger (app_private.lock_stock_movement)
    -- takes on every row it serializes; taking it here first makes the read-then-check-then-insert
    -- below race-free against any other concurrent stock_movements writer for this (branch,
    -- product) pair. Re-acquiring it inside the trigger later in this same transaction is a no-op
    -- (Postgres advisory xact locks are reentrant per transaction).
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_source_branch_id::text || ':' || item_product_id::text, 0)
    );
    select coalesce(sum(sm.quantity_grams), 0)::bigint into current_quantity
    from public.stock_movements sm
    where sm.organization_id = current_organization_id
      and sm.branch_id = p_source_branch_id
      and sm.product_id = item_product_id;

    if current_quantity < item_quantity_grams then
      raise exception 'Stock insuficiente de "%" en la sucursal de origen: disponible %, solicitado %',
        item_product_name, current_quantity, item_quantity_grams using errcode = '22023';
    end if;

    insert into public.stock_transfer_items (transfer_id, organization_id, product_id, quantity_grams)
    values (current_transfer_id, current_organization_id, item_product_id, item_quantity_grams);

    insert into public.stock_movements (
      organization_id, branch_id, product_id, type, quantity_grams,
      stock_transfer_id, profile_id, occurred_at, created_at
    ) values (
      current_organization_id, p_source_branch_id, item_product_id, 'TRANSFER_OUT', -item_quantity_grams::bigint,
      current_transfer_id, current_actor, occurred_at, occurred_at
    );
    insert into public.stock_movements (
      organization_id, branch_id, product_id, type, quantity_grams,
      stock_transfer_id, profile_id, occurred_at, created_at
    ) values (
      current_organization_id, p_destination_branch_id, item_product_id, 'TRANSFER_IN', item_quantity_grams::bigint,
      current_transfer_id, current_actor, occurred_at, occurred_at
    );

    if item_unit_type = 'WEIGHT' then
      computed_total_weight := computed_total_weight + item_quantity_grams;
    else
      computed_total_units := computed_total_units + item_quantity_grams;
    end if;
    computed_item_count := computed_item_count + 1;
  end loop;

  update public.stock_transfers
  set total_weight_grams = computed_total_weight, total_units = computed_total_units, item_count = computed_item_count
  where id = current_transfer_id;

  perform app_private.write_audit(
    current_organization_id, p_source_branch_id, 'STOCK_TRANSFER_CREATED', 'stock_transfers', current_transfer_id,
    null, jsonb_build_object(
      'destinationBranchId', p_destination_branch_id, 'items', p_items,
      'totalWeightGrams', computed_total_weight, 'totalUnits', computed_total_units, 'itemCount', computed_item_count
    )
  );

  return current_transfer_id;
end;
$$;

create or replace function public.list_stock_transfers(p_branch_id uuid default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.read');
  result jsonb;
begin
  if p_limit is null then p_limit := 50; end if;
  if p_limit <= 0 or p_limit > 200 then
    raise exception 'Limit must be between 1 and 200' using errcode = '22023';
  end if;

  with scoped as (
    select t.*
    from public.stock_transfers t
    where t.organization_id = current_organization_id
      and (
        app_private.can_access_branch(current_organization_id, t.source_branch_id, 'stock.read')
        or app_private.can_access_branch(current_organization_id, t.destination_branch_id, 'stock.read')
      )
      and (p_branch_id is null or t.source_branch_id = p_branch_id or t.destination_branch_id = p_branch_id)
    order by t.created_at desc
    limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'sourceBranchId', s.source_branch_id, 'sourceBranchName', source_branch.name,
    'destinationBranchId', s.destination_branch_id, 'destinationBranchName', destination_branch.name,
    'notes', s.notes,
    'createdAt', s.created_at,
    'createdByName', coalesce(creator.display_name, s.created_by::text),
    'totalWeightGrams', s.total_weight_grams,
    'totalUnits', s.total_units,
    'itemCount', s.item_count,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'productId', i.product_id, 'productName', p.name, 'unitType', p.unit_type, 'quantityGrams', i.quantity_grams
      ) order by p.name), '[]'::jsonb)
      from public.stock_transfer_items i
      join public.products p on p.id = i.product_id and p.organization_id = i.organization_id
      where i.transfer_id = s.id
    )
  ) order by s.created_at desc), '[]'::jsonb)
  into result
  from scoped s
  join public.branches source_branch on source_branch.id = s.source_branch_id and source_branch.organization_id = s.organization_id
  join public.branches destination_branch on destination_branch.id = s.destination_branch_id and destination_branch.organization_id = s.organization_id
  left join public.profiles creator on creator.id = s.created_by;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Catalog search/pagination for Admin (a Central with thousands of products must never be loaded
-- whole, and PostgREST silently truncates at max_rows).
-- ---------------------------------------------------------------------------------------------

-- Accent/case-insensitive match on name, SKU (contains) or an exact barcode; optionally restricted
-- to the products enabled in one branch. Used by the product pickers (stock, transfers) — it also
-- lets an operator scan a barcode into the picker.
create function public.search_products(
  p_query text default null,
  p_branch_id uuid default null,
  p_limit integer default 20,
  p_active_only boolean default true
)
returns table (
  product_id uuid,
  product_name text,
  sku text,
  unit_type public.unit_type,
  active boolean,
  barcodes text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  normalized_query text := app_private.import_normalize_text(p_query);
  normalized_code text := app_private.normalize_barcode(p_query);
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Limit must be between 1 and 100' using errcode = '22023';
  end if;
  return query
  select p.id, p.name, p.sku, p.unit_type, p.active,
         coalesce((select array_agg(pb.barcode order by pb.barcode) from public.product_barcodes pb
                   where pb.product_id = p.id and pb.organization_id = p.organization_id), array[]::text[])
  from public.products p
  where p.organization_id = current_organization_id
    and (not coalesce(p_active_only, true) or p.active)
    and (p_branch_id is null or exists (
      select 1 from public.branch_product_assortment a where a.branch_id = p_branch_id and a.product_id = p.id
    ))
    and (
      normalized_query is null
      or app_private.import_normalize_text(p.name) like '%' || normalized_query || '%'
      or upper(coalesce(p.sku, '')) like '%' || upper(btrim(p_query)) || '%'
      or exists (select 1 from public.product_barcodes pb
                 where pb.product_id = p.id and pb.organization_id = p.organization_id and pb.barcode = normalized_code)
    )
  order by p.name, p.id
  limit p_limit;
end;
$$;

-- Paged catalog listing for /admin/products (filters applied in SQL; price/cost/promotion are
-- fetched by the page only for the ids of the current page).
create function public.list_products_page(
  p_search text default null,
  p_category_id uuid default null,
  p_status text default 'active',
  p_branch_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  product_id uuid,
  product_name text,
  slug text,
  sku text,
  category_id uuid,
  unit_type public.unit_type,
  active boolean,
  inventory_role public.product_inventory_role,
  barcodes text[],
  branch_ids uuid[],
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  normalized_search text := app_private.import_normalize_text(p_search);
  normalized_code text := app_private.normalize_barcode(p_search);
begin
  if p_status is null or p_status not in ('active', 'inactive', 'all') then
    raise exception 'Unsupported status filter' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'Limit must be between 1 and 200' using errcode = '22023';
  end if;
  if coalesce(p_offset, 0) < 0 then
    raise exception 'Offset must not be negative' using errcode = '22023';
  end if;
  return query
  select p.id, p.name, p.slug, p.sku, p.category_id, p.unit_type, p.active, p.inventory_role,
         coalesce((select array_agg(pb.barcode order by pb.barcode) from public.product_barcodes pb
                   where pb.product_id = p.id and pb.organization_id = p.organization_id), array[]::text[]),
         coalesce((select array_agg(a.branch_id) from public.branch_product_assortment a
                   where a.product_id = p.id and a.organization_id = p.organization_id), array[]::uuid[]),
         count(*) over ()
  from public.products p
  where p.organization_id = current_organization_id
    and (p_status = 'all' or (p_status = 'active' and p.active) or (p_status = 'inactive' and not p.active))
    and (p_category_id is null or p.category_id = p_category_id)
    and (p_branch_id is null or exists (
      select 1 from public.branch_product_assortment a where a.branch_id = p_branch_id and a.product_id = p.id
    ))
    and (
      normalized_search is null
      or app_private.import_normalize_text(p.name) like '%' || normalized_search || '%'
      or upper(coalesce(p.sku, '')) like '%' || upper(btrim(p_search)) || '%'
      or exists (select 1 from public.product_barcodes pb
                 where pb.product_id = p.id and pb.organization_id = p.organization_id and pb.barcode = normalized_code)
    )
  order by p.name, p.id
  limit p_limit offset coalesce(p_offset, 0);
end;
$$;

-- Same five "operational history" checks as save_product's unit-type guard, but only for the ids
-- asked for (get_products_with_unit_type_history returns every such product in the organization).
create function public.get_products_unit_type_locks(p_product_ids uuid[])
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
begin
  return query
  select p.id from public.products p
  where p.organization_id = current_organization_id and p.id = any (coalesce(p_product_ids, array[]::uuid[]))
    and app_private.product_has_operational_history(p.id);
end;
$$;

revoke all on function
  public.get_branch_stock_status(uuid, text, text, integer, integer),
  public.get_branch_stock_summary(),
  public.search_products(text, uuid, integer, boolean),
  public.list_products_page(text, uuid, text, uuid, integer, integer),
  public.get_products_unit_type_locks(uuid[])
from public, anon;
grant execute on function
  public.get_branch_stock_status(uuid, text, text, integer, integer),
  public.get_branch_stock_summary(),
  public.search_products(text, uuid, integer, boolean),
  public.list_products_page(text, uuid, text, uuid, integer, integer),
  public.get_products_unit_type_locks(uuid[])
to authenticated;

commit;
