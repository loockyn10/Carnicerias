begin;

-- Distribución / transferencias entre sucursales: moves already-produced stock (typically from
-- Central after a Desposte) to other branches. Reuses the existing stock_movements ledger via the
-- TRANSFER_IN/TRANSFER_OUT movement types already defined in 202609100003_online_pos_sales_stock.sql
-- but never used until now — no second inventory model is introduced (see docs/DOMAIN_RULES.md
-- "Stock" and D-010). Scoped to WEIGHT products this sprint, matching every example in the request
-- (costilla/vacío/bondiola) and the domain rule against mixing kg and units in one total.
create table public.stock_transfers (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_branch_id uuid not null,
  destination_branch_id uuid not null,
  notes text check (notes is null or char_length(btrim(notes)) between 1 and 500),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  -- Filled once, after the item loop completes; 0 momentarily during creation, never persisted at 0
  -- because at least one positive-weight item is required (see create_stock_transfer).
  total_weight_grams bigint not null default 0 check (total_weight_grams >= 0),
  item_count integer not null default 0 check (item_count >= 0),
  foreign key (source_branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  foreign key (destination_branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  unique (id, organization_id),
  check (source_branch_id <> destination_branch_id)
);

comment on table public.stock_transfers is
  'Header of an atomic branch-to-branch stock transfer. Immutable once created: this sprint has no
   cancel/reversal flow (see 22 "Fuera de alcance" style caution in the Desposte D-030 precedent).';

create table public.stock_transfer_items (
  id uuid primary key default extensions.gen_random_uuid(),
  transfer_id uuid not null,
  organization_id uuid not null,
  product_id uuid not null,
  quantity_grams integer not null check (quantity_grams > 0),
  foreign key (transfer_id, organization_id) references public.stock_transfers(id, organization_id) on delete cascade,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict,
  unique (transfer_id, product_id)
);

create index stock_transfers_organization_created_idx
  on public.stock_transfers (organization_id, created_at desc);
create index stock_transfers_source_idx on public.stock_transfers (organization_id, source_branch_id, created_at desc);
create index stock_transfers_destination_idx on public.stock_transfers (organization_id, destination_branch_id, created_at desc);
create index stock_transfer_items_transfer_idx on public.stock_transfer_items (transfer_id);

-- No generic app_private.audit_row_change() trigger here (unlike some other tables): the header
-- row is inserted with placeholder zero totals and only updated once the item loop finishes (see
-- create_stock_transfer below), so a naive AFTER INSERT trigger would audit a misleading
-- zero-items snapshot. create_stock_transfer calls app_private.write_audit explicitly instead,
-- once, with the real final totals — same approach production_batches already uses.

-- Same link pattern as stock_movements.production_batch_id (202609220025): traces every
-- TRANSFER_IN/TRANSFER_OUT ledger row back to the transfer that created it.
alter table public.stock_movements
  add column stock_transfer_id uuid;

alter table public.stock_movements
  add constraint stock_movements_transfer_fk
  foreign key (stock_transfer_id, organization_id) references public.stock_transfers(id, organization_id) on delete restrict;

create index stock_movements_transfer_idx
  on public.stock_movements (stock_transfer_id) where stock_transfer_id is not null;

alter table public.stock_movements add constraint stock_movements_transfer_link_check check (
  (type in ('TRANSFER_IN', 'TRANSFER_OUT') and stock_transfer_id is not null)
  or (type not in ('TRANSFER_IN', 'TRANSFER_OUT') and stock_transfer_id is null)
);

comment on column public.stock_movements.stock_transfer_id is
  'Set only for TRANSFER_IN/TRANSFER_OUT rows written by create_stock_transfer.';

-- Atomic branch-to-branch transfer. A single PL/pgSQL function call runs inside one transaction:
-- any exception (malformed item, insufficient stock, unauthorized branch) aborts everything already
-- inserted in this call, so a transfer is genuinely all-or-nothing (requirement 14). Concurrency
-- safety for the stock check reuses the exact pattern already used by record_stock_operation
-- (202609100007): take the same per (branch, product) advisory lock the stock_movements insert
-- trigger (app_private.lock_stock_movement) would take, before reading current stock.
create function public.create_stock_transfer(
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
  current_quantity bigint;
  seen_product_ids uuid[] := '{}';
  computed_total_weight bigint := 0;
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
      raise exception 'Every transfer item needs a product and a positive weight' using errcode = '22023';
    end if;
    if item_product_id = any(seen_product_ids) then
      raise exception 'El mismo producto no puede repetirse en una transferencia' using errcode = '22023';
    end if;
    seen_product_ids := seen_product_ids || item_product_id;

    select p.name into item_product_name
    from public.products p
    where p.id = item_product_id and p.organization_id = current_organization_id
      and p.active and p.unit_type = 'WEIGHT';
    if item_product_name is null then
      raise exception 'Product must be an active weight-based product in this organization' using errcode = '42501';
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

    computed_total_weight := computed_total_weight + item_quantity_grams;
    computed_item_count := computed_item_count + 1;
  end loop;

  update public.stock_transfers
  set total_weight_grams = computed_total_weight, item_count = computed_item_count
  where id = current_transfer_id;

  perform app_private.write_audit(
    current_organization_id, p_source_branch_id, 'STOCK_TRANSFER_CREATED', 'stock_transfers', current_transfer_id,
    null, jsonb_build_object(
      'destinationBranchId', p_destination_branch_id, 'items', p_items,
      'totalWeightGrams', computed_total_weight, 'itemCount', computed_item_count
    )
  );

  return current_transfer_id;
end;
$$;

create function public.list_stock_transfers(p_branch_id uuid default null, p_limit integer default 50)
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
    'itemCount', s.item_count,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'productId', i.product_id, 'productName', p.name, 'quantityGrams', i.quantity_grams
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

alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_items enable row level security;

create policy stock_transfers_select on public.stock_transfers
for select to authenticated
using (
  app_private.can_access_branch(organization_id, source_branch_id, 'stock.read')
  or app_private.can_access_branch(organization_id, destination_branch_id, 'stock.read')
);

create policy stock_transfer_items_select on public.stock_transfer_items
for select to authenticated
using (
  exists (
    select 1 from public.stock_transfers t
    where t.id = transfer_id
      and (
        app_private.can_access_branch(t.organization_id, t.source_branch_id, 'stock.read')
        or app_private.can_access_branch(t.organization_id, t.destination_branch_id, 'stock.read')
      )
  )
);

revoke all on table public.stock_transfers, public.stock_transfer_items from public, anon, authenticated;
grant select on table public.stock_transfers, public.stock_transfer_items to authenticated;

revoke all on function public.create_stock_transfer(uuid, uuid, jsonb, text), public.list_stock_transfers(uuid, integer) from public, anon;
grant execute on function public.create_stock_transfer(uuid, uuid, jsonb, text), public.list_stock_transfers(uuid, integer) to authenticated;

commit;
