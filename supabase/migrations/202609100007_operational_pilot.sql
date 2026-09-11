begin;

create type public.stock_operation_type as enum ('PURCHASE', 'WASTE', 'ADJUSTMENT');
create type public.waste_reason as enum ('DISCARD', 'EXPIRY', 'TRIMMING', 'DETERIORATION', 'INVENTORY_DIFFERENCE', 'OTHER');

create table public.audit_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  branch_id uuid,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  event_type text not null check (event_type ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  entity_type text not null check (char_length(btrim(entity_type)) between 2 and 80),
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now(),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete restrict
);

create table public.branch_product_stock_settings (
  organization_id uuid not null,
  branch_id uuid not null,
  product_id uuid not null,
  minimum_stock_grams bigint not null default 0 check (minimum_stock_grams >= 0),
  target_stock_grams bigint not null default 0 check (target_stock_grams >= minimum_stock_grams),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (branch_id, product_id),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete cascade,
  foreign key (product_id, organization_id)
    references public.products(id, organization_id) on delete cascade
);

create table public.stock_operations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  operation_type public.stock_operation_type not null,
  supplier text check (supplier is null or char_length(btrim(supplier)) between 2 and 160),
  waste_reason public.waste_reason,
  note text check (note is null or char_length(btrim(note)) between 2 and 500),
  occurred_at timestamptz not null default now(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete restrict,
  check ((operation_type = 'WASTE' and waste_reason is not null) or (operation_type <> 'WASTE' and waste_reason is null)),
  unique (id, organization_id, branch_id)
);

create table public.stock_operation_items (
  id uuid primary key default extensions.gen_random_uuid(),
  operation_id uuid not null,
  organization_id uuid not null,
  branch_id uuid not null,
  product_id uuid not null,
  quantity_grams bigint not null check (quantity_grams <> 0),
  system_quantity_before_grams bigint,
  physical_quantity_grams bigint check (physical_quantity_grams is null or physical_quantity_grams >= 0),
  created_at timestamptz not null default now(),
  foreign key (operation_id, organization_id, branch_id)
    references public.stock_operations(id, organization_id, branch_id) on delete restrict,
  foreign key (product_id, organization_id)
    references public.products(id, organization_id) on delete restrict
);

alter table public.stock_movements
  add column stock_operation_id uuid references public.stock_operations(id) on delete restrict;

alter table public.sales
  add column cancellation_key uuid unique,
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references public.profiles(id) on delete restrict,
  add column cancellation_reason text check (
    cancellation_reason is null or char_length(btrim(cancellation_reason)) between 3 and 500
  ),
  add constraint sales_cancellation_metadata check (
    (status = 'CANCELLED' and cancellation_key is not null and cancelled_at is not null
      and cancelled_by is not null and cancellation_reason is not null)
    or (status <> 'CANCELLED' and cancellation_key is null and cancelled_at is null
      and cancelled_by is null and cancellation_reason is null)
  );

create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_branch_created_idx on public.audit_logs (branch_id, created_at desc) where branch_id is not null;
create index stock_operations_branch_occurred_idx on public.stock_operations (organization_id, branch_id, occurred_at desc);
create index stock_operation_items_operation_idx on public.stock_operation_items (operation_id);
create index stock_movements_operation_idx on public.stock_movements (stock_operation_id) where stock_operation_id is not null;

create trigger branch_product_stock_settings_set_updated_at
before update on public.branch_product_stock_settings
for each row execute function app_private.set_updated_at();

create function app_private.lock_stock_movement()
returns trigger
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.branch_id::text || ':' || new.product_id::text, 0)
  );
  return new;
end;
$$;

create trigger stock_movements_serialize_product
before insert on public.stock_movements
for each row execute function app_private.lock_stock_movement();

insert into public.permissions (key, description) values
  ('stock.write', 'Register purchases, waste, adjustments and stock policies'),
  ('sales.cancel', 'Cancel completed sales and compensate stock'),
  ('devices.read', 'Read organization POS devices'),
  ('devices.write', 'Enable and disable organization POS devices'),
  ('dashboard.read', 'Read operational dashboard aggregates'),
  ('audit.read', 'Read the organization audit trail')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select '10000000-0000-4000-8000-000000000001'::uuid, permission.key
from (values
  ('stock.write'), ('sales.cancel'), ('devices.read'), ('devices.write'),
  ('dashboard.read'), ('audit.read')
) as permission(key)
on conflict (role_id, permission_key) do nothing;

create function app_private.require_permission(requested_permission text)
returns uuid
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

  select om.organization_id into current_organization_id
  from public.organization_members om
  join public.profiles p on p.id = om.profile_id and p.active
  join public.role_permissions rp on rp.role_id = om.role_id
  where om.profile_id = auth.uid()
    and om.status = 'ACTIVE'
    and rp.permission_key = requested_permission
  order by om.created_at
  limit 1;

  if current_organization_id is null then
    raise exception 'Permission % is required', requested_permission using errcode = '42501';
  end if;
  return current_organization_id;
end;
$$;

create function app_private.write_audit(
  requested_organization_id uuid,
  requested_branch_id uuid,
  requested_event_type text,
  requested_entity_type text,
  requested_entity_id uuid,
  requested_before jsonb,
  requested_after jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_logs (
    organization_id, branch_id, actor_profile_id, event_type, entity_type,
    entity_id, before_data, after_data
  ) values (
    requested_organization_id, requested_branch_id, auth.uid(), requested_event_type,
    requested_entity_type, requested_entity_id, requested_before, requested_after
  );
$$;

create function app_private.audit_row_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  record_before jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  record_after jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  record_data jsonb := coalesce(record_after, record_before);
  current_organization_id uuid := (record_data ->> 'organization_id')::uuid;
  current_branch_id uuid := nullif(record_data ->> 'branch_id', '')::uuid;
  current_entity_id uuid := nullif(record_data ->> 'id', '')::uuid;
begin
  if tg_table_name = 'pos_devices' and tg_op = 'UPDATE'
     and (record_before - array['last_seen_at', 'updated_at']) = (record_after - array['last_seen_at', 'updated_at']) then
    return new;
  end if;
  perform app_private.write_audit(
    current_organization_id,
    current_branch_id,
    upper(tg_table_name || '_' || tg_op),
    tg_table_name,
    current_entity_id,
    record_before,
    record_after
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger categories_audit after insert or update on public.categories
for each row execute function app_private.audit_row_change();
create trigger products_audit after insert or update on public.products
for each row execute function app_private.audit_row_change();
create trigger product_prices_audit after insert or update on public.product_prices
for each row execute function app_private.audit_row_change();
create trigger organization_members_audit after insert or update on public.organization_members
for each row execute function app_private.audit_row_change();
create trigger branch_members_audit after insert or update on public.branch_members
for each row execute function app_private.audit_row_change();
create trigger pos_devices_audit after insert or update on public.pos_devices
for each row execute function app_private.audit_row_change();

create function public.save_category(
  p_category_id uuid,
  p_name text,
  p_slug text,
  p_sort_order integer default 0,
  p_active boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  current_category_id uuid;
begin
  if char_length(btrim(p_name)) not between 1 and 100
     or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'Category name or slug is invalid' using errcode = '22023';
  end if;

  if p_category_id is null then
    insert into public.categories (organization_id, name, slug, sort_order, active)
    values (current_organization_id, btrim(p_name), p_slug, p_sort_order, p_active)
    returning id into current_category_id;
  else
    update public.categories
    set name = btrim(p_name), slug = p_slug, sort_order = p_sort_order, active = p_active
    where id = p_category_id and organization_id = current_organization_id
    returning id into current_category_id;
    if current_category_id is null then
      raise exception 'Category was not found in this organization' using errcode = '42501';
    end if;
  end if;
  return current_category_id;
end;
$$;

create function public.save_product(
  p_product_id uuid,
  p_category_id uuid,
  p_name text,
  p_slug text,
  p_sku text,
  p_unit_type public.unit_type,
  p_active boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  current_product_id uuid;
begin
  if char_length(btrim(p_name)) not between 1 and 120
     or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or not exists (
       select 1 from public.categories c
       where c.id = p_category_id and c.organization_id = current_organization_id
     ) then
    raise exception 'Product name, slug, or category is invalid' using errcode = '22023';
  end if;

  if p_product_id is null then
    insert into public.products (organization_id, category_id, name, slug, sku, unit_type, active)
    values (current_organization_id, p_category_id, btrim(p_name), p_slug,
      nullif(upper(btrim(p_sku)), ''), p_unit_type, p_active)
    returning id into current_product_id;
  else
    update public.products
    set category_id = p_category_id, name = btrim(p_name), slug = p_slug,
        sku = nullif(upper(btrim(p_sku)), ''), unit_type = p_unit_type, active = p_active
    where id = p_product_id and organization_id = current_organization_id
    returning id into current_product_id;
    if current_product_id is null then
      raise exception 'Product was not found in this organization' using errcode = '42501';
    end if;
  end if;
  return current_product_id;
end;
$$;

create function public.set_product_price(
  p_product_id uuid,
  p_branch_id uuid,
  p_price_cents bigint,
  p_effective_at timestamptz default now()
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  current_price_id uuid;
begin
  if p_effective_at < now() - interval '5 minutes' then
    raise exception 'A new price cannot start in the historical past' using errcode = '22023';
  end if;
  if p_price_cents is not null and p_price_cents <= 0 then
    raise exception 'Price must be positive' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.products p
    where p.id = p_product_id and p.organization_id = current_organization_id
  ) or (
    p_branch_id is not null and not exists (
      select 1 from public.branches b
      where b.id = p_branch_id and b.organization_id = current_organization_id
    )
  ) then
    raise exception 'Product or branch was not found in this organization' using errcode = '42501';
  end if;
  if p_price_cents is null and p_branch_id is null then
    raise exception 'The global price cannot be closed without a replacement' using errcode = '22023';
  end if;

  update public.product_prices pp
  set valid_to = p_effective_at
  where pp.organization_id = current_organization_id
    and pp.product_id = p_product_id
    and pp.branch_id is not distinct from p_branch_id
    and pp.valid_from < p_effective_at
    and (pp.valid_to is null or pp.valid_to > p_effective_at);

  if p_price_cents is null then
    return null;
  end if;

  insert into public.product_prices (
    organization_id, product_id, branch_id, price_cents, valid_from, created_by
  ) values (
    current_organization_id, p_product_id, p_branch_id, p_price_cents,
    p_effective_at, auth.uid()
  ) returning id into current_price_id;
  return current_price_id;
end;
$$;

create function public.set_stock_policy(
  p_branch_id uuid,
  p_product_id uuid,
  p_minimum_stock_grams bigint,
  p_target_stock_grams bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.write');
begin
  if p_minimum_stock_grams < 0 or p_target_stock_grams < p_minimum_stock_grams then
    raise exception 'Stock target must be greater than or equal to the minimum' using errcode = '22023';
  end if;
  if not app_private.can_access_branch(current_organization_id, p_branch_id, 'stock.write')
     or not exists (
       select 1 from public.products p
       where p.id = p_product_id and p.organization_id = current_organization_id
     ) then
    raise exception 'Product or branch was not found in this organization' using errcode = '42501';
  end if;

  insert into public.branch_product_stock_settings (
    organization_id, branch_id, product_id, minimum_stock_grams,
    target_stock_grams, updated_by
  ) values (
    current_organization_id, p_branch_id, p_product_id, p_minimum_stock_grams,
    p_target_stock_grams, auth.uid()
  ) on conflict (branch_id, product_id) do update
  set minimum_stock_grams = excluded.minimum_stock_grams,
      target_stock_grams = excluded.target_stock_grams,
      updated_by = excluded.updated_by;

  perform app_private.write_audit(
    current_organization_id, p_branch_id, 'STOCK_POLICY_SET', 'branch_product_stock_settings',
    p_product_id, null,
    jsonb_build_object('minimumStockGrams', p_minimum_stock_grams, 'targetStockGrams', p_target_stock_grams)
  );
end;
$$;

create function public.record_stock_operation(
  p_branch_id uuid,
  p_operation_type text,
  p_items jsonb,
  p_supplier text default null,
  p_waste_reason text default null,
  p_note text default null,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.write');
  current_operation_type public.stock_operation_type;
  current_waste_reason public.waste_reason;
  current_operation_id uuid;
  item jsonb;
  item_product_id uuid;
  item_input_quantity bigint;
  current_quantity bigint;
  physical_quantity bigint;
  movement_quantity bigint;
  movement_type public.stock_movement_type;
begin
  begin
    current_operation_type := upper(p_operation_type)::public.stock_operation_type;
  exception when invalid_text_representation then
    raise exception 'Unsupported stock operation type' using errcode = '22023';
  end;

  if current_operation_type = 'WASTE' then
    begin
      current_waste_reason := upper(p_waste_reason)::public.waste_reason;
    exception when invalid_text_representation or null_value_not_allowed then
      raise exception 'A valid waste reason is required' using errcode = '22023';
    end;
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 100 then
    raise exception 'A stock operation must contain between 1 and 100 items' using errcode = '22023';
  end if;
  if not app_private.can_access_branch(current_organization_id, p_branch_id, 'stock.write') then
    raise exception 'Branch is not authorized for stock operations' using errcode = '42501';
  end if;
  if p_occurred_at > now() + interval '5 minutes' or p_occurred_at < now() - interval '90 days' then
    raise exception 'Stock operation timestamp is outside the accepted window' using errcode = '22023';
  end if;

  insert into public.stock_operations (
    organization_id, branch_id, operation_type, supplier, waste_reason,
    note, occurred_at, actor_profile_id
  ) values (
    current_organization_id, p_branch_id, current_operation_type,
    case when current_operation_type = 'PURCHASE' then nullif(btrim(p_supplier), '') else null end,
    current_waste_reason, nullif(btrim(p_note), ''), p_occurred_at, auth.uid()
  ) returning id into current_operation_id;

  for item in select value from jsonb_array_elements(p_items)
  loop
    begin
      item_product_id := (item ->> 'product_id')::uuid;
      item_input_quantity := nullif(item ->> 'quantity_grams', '')::bigint;
      physical_quantity := nullif(item ->> 'physical_quantity_grams', '')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Stock item contains malformed identifiers or quantities' using errcode = '22023';
    end;

    if not exists (
      select 1 from public.products p
      where p.id = item_product_id and p.organization_id = current_organization_id
    ) then
      raise exception 'Product was not found in this organization' using errcode = '42501';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_branch_id::text || ':' || item_product_id::text, 0)
    );
    select coalesce(sum(sm.quantity_grams), 0)::bigint into current_quantity
    from public.stock_movements sm
    where sm.organization_id = current_organization_id
      and sm.branch_id = p_branch_id
      and sm.product_id = item_product_id;

    if current_operation_type = 'PURCHASE' then
      if item_input_quantity is null or item_input_quantity <= 0 then
        raise exception 'Purchase quantity must be positive' using errcode = '22023';
      end if;
      movement_quantity := item_input_quantity;
      movement_type := 'PURCHASE';
      physical_quantity := null;
    elsif current_operation_type = 'WASTE' then
      if item_input_quantity is null or item_input_quantity <= 0 then
        raise exception 'Waste quantity must be positive' using errcode = '22023';
      end if;
      movement_quantity := -item_input_quantity;
      movement_type := 'WASTE';
      physical_quantity := null;
    else
      if physical_quantity is null or physical_quantity < 0 then
        raise exception 'Physical quantity is required for an adjustment' using errcode = '22023';
      end if;
      movement_quantity := physical_quantity - current_quantity;
      if movement_quantity = 0 then
        raise exception 'Physical and system quantities already match' using errcode = '22023';
      end if;
      movement_type := case when movement_quantity > 0
        then 'ADJUSTMENT_POSITIVE'::public.stock_movement_type
        else 'ADJUSTMENT_NEGATIVE'::public.stock_movement_type end;
    end if;

    insert into public.stock_operation_items (
      operation_id, organization_id, branch_id, product_id, quantity_grams,
      system_quantity_before_grams, physical_quantity_grams
    ) values (
      current_operation_id, current_organization_id, p_branch_id, item_product_id,
      movement_quantity, current_quantity, physical_quantity
    );
    insert into public.stock_movements (
      organization_id, branch_id, product_id, type, quantity_grams, reason,
      profile_id, occurred_at, stock_operation_id
    ) values (
      current_organization_id, p_branch_id, item_product_id, movement_type,
      movement_quantity,
      case when current_operation_type = 'WASTE' then current_waste_reason::text else nullif(btrim(p_note), '') end,
      auth.uid(), p_occurred_at, current_operation_id
    );
  end loop;

  perform app_private.write_audit(
    current_organization_id, p_branch_id, 'STOCK_' || current_operation_type::text,
    'stock_operations', current_operation_id, null,
    jsonb_build_object('items', p_items, 'supplier', p_supplier, 'wasteReason', p_waste_reason, 'note', p_note)
  );
  return current_operation_id;
end;
$$;

create function public.cancel_sale(
  p_sale_id uuid,
  p_idempotency_key uuid,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('sales.cancel');
  current_sale public.sales%rowtype;
  cancellation_time timestamptz := now();
begin
  if p_idempotency_key is null or char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Cancellation key and reason are required' using errcode = '22023';
  end if;

  select * into current_sale
  from public.sales s
  where s.id = p_sale_id and s.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Sale was not found in this organization' using errcode = '42501';
  end if;
  if current_sale.status = 'CANCELLED' then
    if current_sale.cancellation_key = p_idempotency_key then
      return jsonb_build_object('saleId', p_sale_id, 'duplicate', true, 'cancelledAt', current_sale.cancelled_at);
    end if;
    raise exception 'Sale is already cancelled' using errcode = '23505';
  end if;
  if current_sale.status <> 'COMPLETED' then
    raise exception 'Only completed sales can be cancelled' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_sale_id::text, 0));
  insert into public.stock_movements (
    organization_id, branch_id, product_id, type, quantity_grams, sale_id,
    reason, profile_id, occurred_at
  )
  select
    si.organization_id, si.branch_id, si.product_id, 'RETURN',
    sum(si.weight_grams)::bigint, si.sale_id,
    'Cancelación: ' || btrim(p_reason), auth.uid(), cancellation_time
  from public.sale_items si
  where si.sale_id = p_sale_id
  group by si.organization_id, si.branch_id, si.product_id, si.sale_id;

  update public.sales
  set status = 'CANCELLED', cancellation_key = p_idempotency_key,
      cancelled_at = cancellation_time, cancelled_by = auth.uid(), cancellation_reason = btrim(p_reason)
  where id = p_sale_id;

  perform app_private.write_audit(
    current_organization_id, current_sale.branch_id, 'SALE_CANCELLED', 'sales', p_sale_id,
    jsonb_build_object('status', current_sale.status),
    jsonb_build_object('status', 'CANCELLED', 'reason', btrim(p_reason), 'idempotencyKey', p_idempotency_key)
  );
  return jsonb_build_object('saleId', p_sale_id, 'duplicate', false, 'cancelledAt', cancellation_time);
end;
$$;

create function public.manage_existing_member(
  p_email text,
  p_display_name text,
  p_role_key text,
  p_branch_id uuid,
  p_status public.membership_status default 'ACTIVE'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('members.write');
  target_profile_id uuid;
  target_role_id uuid;
begin
  if lower(btrim(p_email)) = '' or p_role_key not in ('admin', 'employee') then
    raise exception 'Email or role is invalid' using errcode = '22023';
  end if;
  select u.id into target_profile_id
  from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1;
  if target_profile_id is null then
    raise exception 'Create and confirm the Auth user before assigning membership' using errcode = '22023';
  end if;
  if target_profile_id = auth.uid() and (p_role_key <> 'admin' or p_status <> 'ACTIVE') then
    raise exception 'An administrator cannot disable or demote their own membership' using errcode = '42501';
  end if;
  select r.id into target_role_id from public.roles r
  where r.key = p_role_key and r.is_system and r.organization_id is null;
  if p_role_key = 'employee' and (
    p_branch_id is null or not exists (
      select 1 from public.branches b
      where b.id = p_branch_id and b.organization_id = current_organization_id and b.active
    )
  ) then
    raise exception 'An active organization branch is required for employees' using errcode = '22023';
  end if;

  update public.profiles set
    display_name = coalesce(nullif(btrim(p_display_name), ''), display_name)
  where id = target_profile_id;

  insert into public.organization_members (organization_id, profile_id, role_id, status)
  values (current_organization_id, target_profile_id, target_role_id, p_status)
  on conflict (organization_id, profile_id) do update
  set role_id = excluded.role_id, status = excluded.status;

  update public.branch_members set active = false
  where organization_id = current_organization_id and profile_id = target_profile_id
    and (p_branch_id is null or branch_id <> p_branch_id);
  if p_branch_id is not null then
    insert into public.branch_members (organization_id, branch_id, profile_id, active)
    values (current_organization_id, p_branch_id, target_profile_id, p_status = 'ACTIVE')
    on conflict (branch_id, profile_id) do update set active = excluded.active;
  end if;
  return target_profile_id;
end;
$$;

create function public.list_organization_members()
returns table (
  profile_id uuid,
  display_name text,
  email text,
  role_key text,
  status public.membership_status,
  branch_id uuid,
  branch_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('members.read');
begin
  return query
  select p.id, p.display_name, u.email::text, r.key, om.status, bm.branch_id, b.name
  from public.organization_members om
  join public.profiles p on p.id = om.profile_id
  join auth.users u on u.id = p.id
  join public.roles r on r.id = om.role_id
  left join public.branch_members bm
    on bm.organization_id = om.organization_id and bm.profile_id = om.profile_id and bm.active
  left join public.branches b on b.id = bm.branch_id
  where om.organization_id = current_organization_id
  order by p.display_name, b.name;
end;
$$;

create function public.set_pos_device_status(p_device_id uuid, p_status public.pos_device_status)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('devices.write');
begin
  update public.pos_devices
  set status = p_status
  where id = p_device_id and organization_id = current_organization_id;
  if not found then
    raise exception 'Device was not found in this organization' using errcode = '42501';
  end if;
end;
$$;

create view public.branch_stock_status
with (security_invoker = true)
as
select
  b.organization_id,
  b.id as branch_id,
  b.name as branch_name,
  p.id as product_id,
  p.name as product_name,
  p.sku,
  coalesce(sl.quantity_grams, 0)::bigint as current_stock_grams,
  coalesce(settings.minimum_stock_grams, 0)::bigint as minimum_stock_grams,
  coalesce(settings.target_stock_grams, 0)::bigint as target_stock_grams,
  greatest(coalesce(settings.target_stock_grams, 0) - coalesce(sl.quantity_grams, 0), 0)::bigint
    as suggested_replenishment_grams,
  case
    when coalesce(sl.quantity_grams, 0) <= 0 then 'CRITICAL'
    when coalesce(sl.quantity_grams, 0) < coalesce(settings.minimum_stock_grams, 0) then 'LOW'
    else 'NORMAL'
  end as stock_status,
  sl.last_movement_at
from public.branches b
join public.products p on p.organization_id = b.organization_id and p.active and p.unit_type = 'WEIGHT'
left join public.stock_levels sl
  on sl.organization_id = b.organization_id and sl.branch_id = b.id and sl.product_id = p.id
left join public.branch_product_stock_settings settings
  on settings.organization_id = b.organization_id
  and settings.branch_id = b.id and settings.product_id = p.id
where b.active;

create function public.get_admin_dashboard(p_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('dashboard.read');
  result jsonb;
begin
  if p_branch_id is not null and not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;

  with boundaries as (
    select
      date_trunc('day', now()) as today_start,
      date_trunc('week', now()) as week_start,
      date_trunc('month', now()) as month_start
  ), filtered_sales as (
    select s.* from public.sales s
    where s.organization_id = current_organization_id
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and s.status = 'COMPLETED'
  ), period_metrics as (
    select jsonb_build_object(
      'today', jsonb_build_object(
        'grossCents', coalesce(sum(total_cents) filter (where completed_at >= today_start), 0),
        'previousGrossCents', coalesce(sum(total_cents) filter (where completed_at >= today_start - interval '1 day' and completed_at < today_start), 0),
        'salesCount', count(*) filter (where completed_at >= today_start),
        'averageTicketCents', coalesce(avg(total_cents) filter (where completed_at >= today_start), 0)::bigint,
        'kilograms', round((coalesce(sum(total_weight_grams) filter (where completed_at >= today_start), 0)::numeric / 1000), 3)
      ),
      'week', jsonb_build_object(
        'grossCents', coalesce(sum(total_cents) filter (where completed_at >= week_start), 0),
        'previousGrossCents', coalesce(sum(total_cents) filter (where completed_at >= week_start - interval '7 days' and completed_at < week_start), 0),
        'salesCount', count(*) filter (where completed_at >= week_start),
        'averageTicketCents', coalesce(avg(total_cents) filter (where completed_at >= week_start), 0)::bigint,
        'kilograms', round((coalesce(sum(total_weight_grams) filter (where completed_at >= week_start), 0)::numeric / 1000), 3)
      ),
      'month', jsonb_build_object(
        'grossCents', coalesce(sum(total_cents) filter (where completed_at >= month_start), 0),
        'previousGrossCents', coalesce(sum(total_cents) filter (where completed_at >= month_start - interval '1 month' and completed_at < month_start), 0),
        'salesCount', count(*) filter (where completed_at >= month_start),
        'averageTicketCents', coalesce(avg(total_cents) filter (where completed_at >= month_start), 0)::bigint,
        'kilograms', round((coalesce(sum(total_weight_grams) filter (where completed_at >= month_start), 0)::numeric / 1000), 3)
      )
    ) as value
    from filtered_sales, boundaries
  ), payment_metrics as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'method', payment.method, 'amountCents', payment.amount_cents, 'salesCount', payment.sales_count
    ) order by payment.amount_cents desc), '[]'::jsonb) as value
    from (
      select p.method, sum(p.amount_cents)::bigint as amount_cents, count(distinct p.sale_id) as sales_count
      from public.payments p
      join public.sales s on s.id = p.sale_id
      cross join boundaries
      where s.organization_id = current_organization_id and s.status = 'COMPLETED'
        and (p_branch_id is null or s.branch_id = p_branch_id)
        and s.completed_at >= boundaries.month_start
      group by p.method
    ) payment
  ), product_totals as (
    select si.product_id, max(si.product_name_snapshot) as product_name,
      sum(si.weight_grams)::bigint as grams, sum(si.subtotal_cents)::bigint as gross_cents
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    cross join boundaries
    where s.organization_id = current_organization_id and s.status = 'COMPLETED'
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and s.completed_at >= boundaries.month_start
    group by si.product_id
  ), top_products_revenue as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', ranking.product_id, 'name', ranking.product_name,
      'kilograms', round(ranking.grams::numeric / 1000, 3), 'grossCents', ranking.gross_cents
    ) order by ranking.gross_cents desc), '[]'::jsonb) as value
    from (
      select * from product_totals order by gross_cents desc limit 10
    ) ranking
  ), top_products_kg as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', ranking.product_id, 'name', ranking.product_name,
      'kilograms', round(ranking.grams::numeric / 1000, 3), 'grossCents', ranking.gross_cents
    ) order by ranking.grams desc), '[]'::jsonb) as value
    from (select * from product_totals order by grams desc limit 10) ranking
  ), least_sold_products as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', ranking.product_id, 'name', ranking.product_name,
      'kilograms', round(ranking.grams::numeric / 1000, 3), 'grossCents', ranking.gross_cents
    ) order by ranking.grams), '[]'::jsonb) as value
    from (select * from product_totals order by grams, product_name limit 10) ranking
  ), alerts as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'branchId', alert.branch_id, 'branchName', alert.branch_name,
      'productId', alert.product_id, 'productName', alert.product_name,
      'status', alert.stock_status, 'currentStockGrams', alert.current_stock_grams,
      'minimumStockGrams', alert.minimum_stock_grams,
      'suggestedReplenishmentGrams', alert.suggested_replenishment_grams
    ) order by case alert.stock_status when 'CRITICAL' then 0 else 1 end, alert.current_stock_grams), '[]'::jsonb) as value
    from public.branch_stock_status alert
    where alert.organization_id = current_organization_id
      and (p_branch_id is null or alert.branch_id = p_branch_id)
      and alert.stock_status <> 'NORMAL'
  )
  select jsonb_build_object(
    'periods', period_metrics.value,
    'paymentsThisMonth', payment_metrics.value,
    'topProductsByRevenue', top_products_revenue.value,
    'topProductsByKg', top_products_kg.value,
    'leastSoldProducts', least_sold_products.value,
    'stockAlerts', alerts.value,
    'generatedAt', now()
  ) into result
  from period_metrics, payment_metrics, top_products_revenue, top_products_kg, least_sold_products, alerts;
  return result;
end;
$$;

alter table public.audit_logs enable row level security;
alter table public.branch_product_stock_settings enable row level security;
alter table public.stock_operations enable row level security;
alter table public.stock_operation_items enable row level security;

create policy audit_logs_select on public.audit_logs
for select to authenticated
using (app_private.has_permission(organization_id, 'audit.read'));

create policy stock_settings_select on public.branch_product_stock_settings
for select to authenticated
using (app_private.can_access_branch(organization_id, branch_id, 'stock.read'));

create policy stock_operations_select on public.stock_operations
for select to authenticated
using (app_private.can_access_branch(organization_id, branch_id, 'stock.read'));

create policy stock_operation_items_select on public.stock_operation_items
for select to authenticated
using (app_private.can_access_branch(organization_id, branch_id, 'stock.read'));

create policy pos_devices_admin_select on public.pos_devices
for select to authenticated
using (app_private.has_permission(organization_id, 'devices.read'));

drop policy organization_members_delete on public.organization_members;
drop policy branch_members_delete on public.branch_members;
revoke delete on table public.organization_members, public.branch_members from authenticated;

revoke all on table public.audit_logs, public.branch_product_stock_settings,
  public.stock_operations, public.stock_operation_items from public, anon, authenticated;
grant select on table public.audit_logs, public.branch_product_stock_settings,
  public.stock_operations, public.stock_operation_items to authenticated;
grant select on table public.pos_devices to authenticated;
revoke all on table public.branch_stock_status from public, anon;
grant select on table public.branch_stock_status to authenticated;

revoke all on function app_private.require_permission(text) from public, anon, authenticated;
revoke all on function app_private.write_audit(uuid, uuid, text, text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function app_private.audit_row_change() from public, anon, authenticated;
revoke all on function app_private.lock_stock_movement() from public, anon, authenticated;

revoke all on function public.save_category(uuid, text, text, integer, boolean) from public, anon;
revoke all on function public.save_product(uuid, uuid, text, text, text, public.unit_type, boolean) from public, anon;
revoke all on function public.set_product_price(uuid, uuid, bigint, timestamptz) from public, anon;
revoke all on function public.set_stock_policy(uuid, uuid, bigint, bigint) from public, anon;
revoke all on function public.record_stock_operation(uuid, text, jsonb, text, text, text, timestamptz) from public, anon;
revoke all on function public.cancel_sale(uuid, uuid, text) from public, anon;
revoke all on function public.manage_existing_member(text, text, text, uuid, public.membership_status) from public, anon;
revoke all on function public.list_organization_members() from public, anon;
revoke all on function public.set_pos_device_status(uuid, public.pos_device_status) from public, anon;
revoke all on function public.get_admin_dashboard(uuid) from public, anon;

grant execute on function public.save_category(uuid, text, text, integer, boolean) to authenticated;
grant execute on function public.save_product(uuid, uuid, text, text, text, public.unit_type, boolean) to authenticated;
grant execute on function public.set_product_price(uuid, uuid, bigint, timestamptz) to authenticated;
grant execute on function public.set_stock_policy(uuid, uuid, bigint, bigint) to authenticated;
grant execute on function public.record_stock_operation(uuid, text, jsonb, text, text, text, timestamptz) to authenticated;
grant execute on function public.cancel_sale(uuid, uuid, text) to authenticated;
grant execute on function public.manage_existing_member(text, text, text, uuid, public.membership_status) to authenticated;
grant execute on function public.list_organization_members() to authenticated;
grant execute on function public.set_pos_device_status(uuid, public.pos_device_status) to authenticated;
grant execute on function public.get_admin_dashboard(uuid) to authenticated;

comment on function public.manage_existing_member(text, text, text, uuid, public.membership_status) is
  'Admin-only exact-email association for an existing Auth user. It never exposes or mutates Auth credentials.';
comment on function public.cancel_sale(uuid, uuid, text) is
  'Idempotent cancellation that preserves financial history and appends compensating stock movements.';
comment on table public.audit_logs is
  'Append-only operational audit trail. Browser clients have no INSERT, UPDATE, or DELETE grants.';

commit;
