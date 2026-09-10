begin;

create type public.pos_device_status as enum ('ACTIVE', 'DISABLED');

create table public.pos_devices (
  id uuid primary key,
  organization_id uuid not null,
  branch_id uuid not null,
  label text check (label is null or char_length(btrim(label)) between 1 and 100),
  status public.pos_device_status not null default 'ACTIVE',
  registered_by uuid not null references public.profiles(id) on delete restrict,
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete restrict,
  unique (id, organization_id, branch_id)
);

create table public.pos_sync_receipts (
  event_id uuid primary key,
  sale_id uuid not null unique,
  device_id uuid not null references public.pos_devices(id) on delete restrict,
  payload_hash text not null,
  received_at timestamptz not null default now()
);

create table public.pos_catalog_changes (
  sequence bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid,
  entity_type text not null check (entity_type in ('BRANCH', 'CATEGORY', 'PRODUCT', 'PRICE')),
  entity_id uuid not null,
  changed_at timestamptz not null default now(),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete cascade
);

alter table public.sales
  add column device_id uuid references public.pos_devices(id) on delete restrict,
  add column sync_event_id uuid unique;

create index pos_devices_branch_idx on public.pos_devices (organization_id, branch_id, status);
create index pos_catalog_changes_pull_idx
  on public.pos_catalog_changes (organization_id, branch_id, sequence);
create index sales_device_created_idx
  on public.sales (device_id, created_at desc) where device_id is not null;

create trigger pos_devices_set_updated_at before update on public.pos_devices
for each row execute function app_private.set_updated_at();

create function app_private.log_pos_catalog_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  record_data jsonb;
  current_organization_id uuid;
  current_branch_id uuid;
  current_entity_id uuid;
  current_entity_type text;
begin
  record_data := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  current_organization_id := (record_data ->> 'organization_id')::uuid;

  case tg_table_name
    when 'branches' then
      current_entity_type := 'BRANCH';
      current_entity_id := (record_data ->> 'id')::uuid;
      current_branch_id := current_entity_id;
    when 'categories' then
      current_entity_type := 'CATEGORY';
      current_entity_id := (record_data ->> 'id')::uuid;
      current_branch_id := null;
    when 'products' then
      current_entity_type := 'PRODUCT';
      current_entity_id := (record_data ->> 'id')::uuid;
      current_branch_id := null;
    when 'product_prices' then
      current_entity_type := 'PRICE';
      current_entity_id := (record_data ->> 'product_id')::uuid;
      current_branch_id := nullif(record_data ->> 'branch_id', '')::uuid;
    else
      raise exception 'Unsupported POS catalog table %', tg_table_name;
  end case;

  insert into public.pos_catalog_changes (
    organization_id, branch_id, entity_type, entity_id
  ) values (
    current_organization_id, current_branch_id, current_entity_type, current_entity_id
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger branches_log_pos_change
after insert or update or delete on public.branches
for each row execute function app_private.log_pos_catalog_change();
create trigger categories_log_pos_change
after insert or update or delete on public.categories
for each row execute function app_private.log_pos_catalog_change();
create trigger products_log_pos_change
after insert or update or delete on public.products
for each row execute function app_private.log_pos_catalog_change();
create trigger product_prices_log_pos_change
after insert or update or delete on public.product_prices
for each row execute function app_private.log_pos_catalog_change();

-- Backfill makes cursor 0 a complete initial pull for existing tenants.
insert into public.pos_catalog_changes (organization_id, branch_id, entity_type, entity_id)
select organization_id, id, 'BRANCH', id from public.branches;
insert into public.pos_catalog_changes (organization_id, entity_type, entity_id)
select organization_id, 'CATEGORY', id from public.categories;
insert into public.pos_catalog_changes (organization_id, entity_type, entity_id)
select organization_id, 'PRODUCT', id from public.products;
insert into public.pos_catalog_changes (organization_id, branch_id, entity_type, entity_id)
select organization_id, branch_id, 'PRICE', product_id from public.product_prices;

create function public.pull_pos_state(p_device_id uuid, p_after_sequence bigint default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_profile_id uuid := auth.uid();
  current_organization_id uuid;
  current_branch_id uuid;
  current_branch_name text;
  current_branch_active boolean;
  current_device_status public.pos_device_status;
  current_role_name text;
  current_cursor bigint;
  current_server_time timestamptz := now();
  catalog_payload jsonb;
  removed_payload jsonb;
begin
  if current_profile_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select d.organization_id, d.branch_id, b.name, b.active, d.status, r.name
  into current_organization_id, current_branch_id, current_branch_name,
       current_branch_active, current_device_status, current_role_name
  from public.pos_devices d
  join public.branches b on b.id = d.branch_id and b.organization_id = d.organization_id
  join public.organization_members om
    on om.organization_id = d.organization_id and om.profile_id = current_profile_id and om.status = 'ACTIVE'
  join public.roles r on r.id = om.role_id
  where d.id = p_device_id;

  if not found
     or current_device_status <> 'ACTIVE'
     or not current_branch_active
     or not app_private.can_access_branch(current_organization_id, current_branch_id, 'sales.create') then
    raise exception 'Device or branch is not authorized for this user' using errcode = '42501';
  end if;

  select coalesce(max(c.sequence), p_after_sequence)
  into current_cursor
  from public.pos_catalog_changes c
  where c.organization_id = current_organization_id
    and (c.branch_id is null or c.branch_id = current_branch_id);

  with changed_products as (
    select distinct p.id
    from public.products p
    where p.organization_id = current_organization_id
      and (
        p_after_sequence = 0
        or exists (
          select 1
          from public.pos_catalog_changes c
          where c.organization_id = current_organization_id
            and c.sequence > p_after_sequence
            and (c.branch_id is null or c.branch_id = current_branch_id)
            and (
              (c.entity_type in ('PRODUCT', 'PRICE') and c.entity_id = p.id)
              or (c.entity_type = 'CATEGORY' and c.entity_id = p.category_id)
              or c.entity_type = 'BRANCH'
            )
        )
      )
  ), effective_catalog as (
    select
      p.organization_id,
      current_branch_id as branch_id,
      current_branch_name as branch_name,
      current_branch_active as branch_active,
      c.id as category_id,
      c.name as category_name,
      c.sort_order as category_sort_order,
      c.active as category_active,
      p.id as product_id,
      p.name as product_name,
      p.sku as product_sku,
      p.unit_type,
      p.active as product_active,
      effective_price.price_cents,
      effective_price.valid_from
    from changed_products changed
    join public.products p on p.id = changed.id and p.organization_id = current_organization_id
    join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    join lateral (
      select pp.price_cents, pp.valid_from
      from public.product_prices pp
      where pp.organization_id = p.organization_id
        and pp.product_id = p.id
        and (pp.branch_id = current_branch_id or pp.branch_id is null)
        and pp.valid_from <= current_server_time
        and (pp.valid_to is null or pp.valid_to > current_server_time)
      order by (pp.branch_id = current_branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) effective_price on true
    where p.active and c.active and current_branch_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', organization_id,
    'branchId', branch_id,
    'branchName', branch_name,
    'branchActive', branch_active,
    'categoryId', category_id,
    'categoryName', category_name,
    'categorySortOrder', category_sort_order,
    'categoryActive', category_active,
    'productId', product_id,
    'productName', product_name,
    'productSku', product_sku,
    'unitType', unit_type,
    'productActive', product_active,
    'pricePerKgCents', price_cents::text,
    'priceValidFrom', valid_from
  ) order by category_sort_order, category_name, product_name), '[]'::jsonb)
  into catalog_payload
  from effective_catalog;

  with changed_products as (
    select distinct p.id
    from public.products p
    where p.organization_id = current_organization_id
      and (
        p_after_sequence = 0
        or exists (
          select 1 from public.pos_catalog_changes c
          where c.organization_id = current_organization_id
            and c.sequence > p_after_sequence
            and (c.branch_id is null or c.branch_id = current_branch_id)
            and (
              (c.entity_type in ('PRODUCT', 'PRICE') and c.entity_id = p.id)
              or (c.entity_type = 'CATEGORY' and c.entity_id = p.category_id)
              or c.entity_type = 'BRANCH'
            )
        )
      )
  )
  select coalesce(jsonb_agg(changed.id), '[]'::jsonb)
  into removed_payload
  from changed_products changed
  where not exists (
    select 1
    from public.products p
    join public.categories c on c.id = p.category_id and c.active
    join lateral (
      select 1
      from public.product_prices pp
      where pp.product_id = p.id
        and pp.organization_id = p.organization_id
        and (pp.branch_id = current_branch_id or pp.branch_id is null)
        and pp.valid_from <= current_server_time
        and (pp.valid_to is null or pp.valid_to > current_server_time)
      limit 1
    ) price_exists on true
    where p.id = changed.id and p.active and current_branch_active
  );

  update public.pos_devices set last_seen_at = current_server_time where id = p_device_id;

  return jsonb_build_object(
    'cursor', current_cursor,
    'serverTime', current_server_time,
    'authorizationExpiresAt', current_server_time + interval '24 hours',
    'organizationId', current_organization_id,
    'branchId', current_branch_id,
    'branchName', current_branch_name,
    'branchActive', current_branch_active,
    'deviceStatus', current_device_status,
    'roleName', current_role_name,
    'catalog', catalog_payload,
    'removedProductIds', removed_payload
  );
end;
$$;

create function public.register_pos_device(p_device_id uuid, p_branch_id uuid, p_label text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_profile_id uuid := auth.uid();
  current_organization_id uuid;
  existing_organization_id uuid;
  existing_branch_id uuid;
begin
  if current_profile_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select b.organization_id into current_organization_id
  from public.branches b where b.id = p_branch_id and b.active;
  if current_organization_id is null
     or not app_private.can_access_branch(current_organization_id, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  select d.organization_id, d.branch_id into existing_organization_id, existing_branch_id
  from public.pos_devices d where d.id = p_device_id;
  if found and (existing_organization_id <> current_organization_id or existing_branch_id <> p_branch_id) then
    raise exception 'Device is already assigned to another organization or branch' using errcode = '42501';
  end if;

  insert into public.pos_devices (id, organization_id, branch_id, label, registered_by)
  values (p_device_id, current_organization_id, p_branch_id, nullif(btrim(p_label), ''), current_profile_id)
  on conflict (id) do update set label = coalesce(excluded.label, public.pos_devices.label), last_seen_at = now();

  return public.pull_pos_state(p_device_id, 0);
end;
$$;

create function public.sync_offline_sale(p_device_id uuid, p_event_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_profile_id uuid := auth.uid();
  current_organization_id uuid;
  current_branch_id uuid;
  current_device_status public.pos_device_status;
  current_hash text := encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
  existing_receipt public.pos_sync_receipts%rowtype;
  current_sale_id uuid;
  current_completed_at timestamptz;
  current_created_at timestamptz;
  current_total_cents bigint;
  current_total_weight bigint;
  computed_total_cents bigint := 0;
  computed_total_weight bigint := 0;
  item jsonb;
  movement jsonb;
  item_index integer;
  item_product_id uuid;
  item_weight integer;
  item_price bigint;
  item_subtotal bigint;
  server_price bigint;
  current_method public.payment_method;
  inserted_receipt boolean;
begin
  if current_profile_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_payload is null or p_payload ->> 'schemaVersion' <> '1' then
    raise exception 'Unsupported offline sale payload' using errcode = '22023';
  end if;

  select d.organization_id, d.branch_id, d.status
  into current_organization_id, current_branch_id, current_device_status
  from public.pos_devices d where d.id = p_device_id;
  if not found or current_device_status <> 'ACTIVE'
     or not app_private.can_access_branch(current_organization_id, current_branch_id, 'sales.create') then
    raise exception 'Device or branch is not authorized for this user' using errcode = '42501';
  end if;
  if (p_payload ->> 'eventId')::uuid <> p_event_id
     or (p_payload ->> 'deviceId')::uuid <> p_device_id
     or (p_payload ->> 'organizationId')::uuid <> current_organization_id
     or (p_payload ->> 'branchId')::uuid <> current_branch_id
     or (p_payload ->> 'profileId')::uuid <> current_profile_id
     or p_payload ->> 'status' <> 'COMPLETED' then
    raise exception 'Offline sale identity does not match the authenticated device' using errcode = '42501';
  end if;

  current_sale_id := (p_payload ->> 'saleId')::uuid;
  current_completed_at := (p_payload ->> 'completedAt')::timestamptz;
  current_created_at := (p_payload ->> 'createdAt')::timestamptz;
  current_total_cents := (p_payload ->> 'totalCents')::bigint;
  current_total_weight := (p_payload ->> 'totalWeightGrams')::bigint;
  if current_completed_at > now() + interval '5 minutes'
     or current_completed_at < now() - interval '30 days' then
    raise exception 'Offline sale timestamp is outside the accepted window' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'items') <> 'array'
     or jsonb_array_length(p_payload -> 'items') < 1
     or jsonb_array_length(p_payload -> 'items') > 100
     or jsonb_array_length(p_payload -> 'stockMovements') <> jsonb_array_length(p_payload -> 'items') then
    raise exception 'Offline sale items are invalid' using errcode = '22023';
  end if;

  insert into public.pos_sync_receipts (event_id, sale_id, device_id, payload_hash)
  values (p_event_id, current_sale_id, p_device_id, current_hash)
  on conflict (event_id) do nothing
  returning true into inserted_receipt;

  if not coalesce(inserted_receipt, false) then
    select * into existing_receipt from public.pos_sync_receipts where event_id = p_event_id;
    if existing_receipt.sale_id <> current_sale_id
       or existing_receipt.device_id <> p_device_id
       or existing_receipt.payload_hash <> current_hash then
      raise exception 'Idempotency key was reused with a different payload' using errcode = '23505';
    end if;
    return jsonb_build_object('saleId', current_sale_id, 'duplicate', true, 'syncedAt', existing_receipt.received_at);
  end if;

  if exists (select 1 from public.sales s where s.id = current_sale_id) then
    raise exception 'Sale id already exists with another sync event' using errcode = '23505';
  end if;

  for item_index in 0 .. jsonb_array_length(p_payload -> 'items') - 1 loop
    item := p_payload -> 'items' -> item_index;
    movement := p_payload -> 'stockMovements' -> item_index;
    item_product_id := (item ->> 'productId')::uuid;
    item_weight := (item ->> 'weightGrams')::integer;
    item_price := (item ->> 'pricePerKgCents')::bigint;
    item_subtotal := (item ->> 'subtotalCents')::bigint;
    if item_weight <= 0 or item_price <= 0
       or item_subtotal <> (item_price * item_weight::bigint + 500) / 1000
       or (movement ->> 'productId')::uuid <> item_product_id
       or (movement ->> 'quantityGrams')::bigint <> -item_weight::bigint then
      raise exception 'Offline item, subtotal, or stock movement is invalid' using errcode = '22023';
    end if;

    select pp.price_cents into server_price
    from public.product_prices pp
    where pp.organization_id = current_organization_id
      and pp.product_id = item_product_id
      and (pp.branch_id = current_branch_id or pp.branch_id is null)
      and pp.valid_from <= current_completed_at
      and (pp.valid_to is null or pp.valid_to > current_completed_at)
    order by (pp.branch_id = current_branch_id) desc nulls last, pp.valid_from desc
    limit 1;
    if not found or server_price <> item_price then
      raise exception 'Offline price snapshot is not valid at the sale timestamp' using errcode = '40001';
    end if;
    computed_total_cents := computed_total_cents + item_subtotal;
    computed_total_weight := computed_total_weight + item_weight;
  end loop;

  begin
    current_method := upper(p_payload -> 'payment' ->> 'method')::public.payment_method;
  exception when invalid_text_representation then
    raise exception 'Unsupported payment method' using errcode = '22023';
  end;
  if computed_total_cents <> current_total_cents
     or computed_total_weight <> current_total_weight
     or (p_payload -> 'payment' ->> 'amountCents')::bigint <> current_total_cents then
    raise exception 'Offline sale totals do not match its details' using errcode = '22023';
  end if;

  insert into public.sales (
    id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams,
    created_at, completed_at, device_id, sync_event_id
  ) values (
    current_sale_id, current_organization_id, current_branch_id, current_profile_id, 'COMPLETED',
    current_total_cents, current_total_weight, current_created_at, current_completed_at, p_device_id, p_event_id
  );

  for item_index in 0 .. jsonb_array_length(p_payload -> 'items') - 1 loop
    item := p_payload -> 'items' -> item_index;
    movement := p_payload -> 'stockMovements' -> item_index;
    insert into public.sale_items (
      id, sale_id, organization_id, branch_id, product_id, product_name_snapshot,
      weight_grams, price_per_kg_cents, subtotal_cents, created_at
    ) values (
      (item ->> 'id')::uuid, current_sale_id, current_organization_id, current_branch_id,
      (item ->> 'productId')::uuid, item ->> 'productNameSnapshot',
      (item ->> 'weightGrams')::integer, (item ->> 'pricePerKgCents')::bigint,
      (item ->> 'subtotalCents')::bigint, current_created_at
    );
    insert into public.stock_movements (
      id, organization_id, branch_id, product_id, type, quantity_grams, sale_id,
      profile_id, occurred_at, created_at
    ) values (
      (movement ->> 'id')::uuid, current_organization_id, current_branch_id,
      (movement ->> 'productId')::uuid, 'SALE', (movement ->> 'quantityGrams')::bigint,
      current_sale_id, current_profile_id, (movement ->> 'occurredAt')::timestamptz, current_created_at
    );
  end loop;

  insert into public.payments (
    id, sale_id, organization_id, branch_id, method, amount_cents, created_at
  ) values (
    (p_payload -> 'payment' ->> 'id')::uuid, current_sale_id, current_organization_id,
    current_branch_id, current_method, current_total_cents, current_created_at
  );
  update public.pos_devices set last_seen_at = now() where id = p_device_id;

  return jsonb_build_object('saleId', current_sale_id, 'duplicate', false, 'syncedAt', now());
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Offline sale payload contains malformed identifiers or numbers' using errcode = '22023';
end;
$$;

alter table public.pos_devices enable row level security;
alter table public.pos_sync_receipts enable row level security;
alter table public.pos_catalog_changes enable row level security;

revoke all on table public.pos_devices, public.pos_sync_receipts, public.pos_catalog_changes from public, anon, authenticated;
revoke all on function public.register_pos_device(uuid, uuid, text) from public, anon;
revoke all on function public.pull_pos_state(uuid, bigint) from public, anon;
revoke all on function public.sync_offline_sale(uuid, uuid, jsonb) from public, anon;
grant execute on function public.register_pos_device(uuid, uuid, text) to authenticated;
grant execute on function public.pull_pos_state(uuid, bigint) to authenticated;
grant execute on function public.sync_offline_sale(uuid, uuid, jsonb) to authenticated;

revoke all on function app_private.log_pos_catalog_change() from public, anon, authenticated;

comment on table public.pos_devices is
  'Server-enforced binding between a POS installation and exactly one organization branch.';
comment on table public.pos_sync_receipts is
  'Durable idempotency receipts. A successful event can be retried without duplicating any sale entity.';
comment on function public.sync_offline_sale(uuid, uuid, jsonb) is
  'Atomically validates and imports one immutable offline sale using client-assigned UUIDs.';

commit;
