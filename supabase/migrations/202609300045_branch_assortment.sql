begin;

-- Surtido por sucursal ("assortment"): which products a branch carries.
--
-- This is NOT branch_product_stock_settings. That table is a stock POLICY (minimum/target) whose
-- rows only exist after someone configures a threshold, and whose absence means "no policy", not
-- "not carried" — using it (or "has stock") as the assortment would make a product vanish from a
-- branch's POS the moment it is sold out, and would make every policy row implicitly enable a
-- product. Assortment is its own relation:
--
--   in assortment + stock > 0   → visible and sellable in the POS
--   in assortment + stock <= 0  → visible as "Sin stock" (the row keeps existing)
--   not in assortment           → not in the POS catalog at all
--
-- Presence of a row = enabled; disabling deletes the row (it is catalog configuration, not
-- operational history — sales/stock/prices keep their own snapshots and are untouched; every
-- change is audited).

create table public.branch_product_assortment (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  product_id uuid not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete cascade,
  foreign key (product_id, organization_id)
    references public.products(id, organization_id) on delete cascade,
  unique (branch_id, product_id)
);

create index branch_product_assortment_product_idx on public.branch_product_assortment (product_id);
create index branch_product_assortment_org_branch_idx on public.branch_product_assortment (organization_id, branch_id);

comment on table public.branch_product_assortment is
  'Products enabled in a branch (surtido). Independent of stock (a sold-out product stays enabled) and of branch_product_stock_settings (a stock policy). Written only through set_product_branches / set_branch_products / copy_branch_assortment / the import engine.';

-- Existing behavior is "every product in every branch", so every existing (product, branch) pair
-- is enabled: the butcher branches keep exactly the catalog they have today. Done before the
-- sync/audit triggers exist so the backfill does not flood pos_catalog_changes or audit_logs.
insert into public.branch_product_assortment (organization_id, branch_id, product_id)
select p.organization_id, b.id, p.id
from public.products p
join public.branches b on b.organization_id = p.organization_id;

alter table public.branch_product_assortment enable row level security;
create policy branch_product_assortment_select on public.branch_product_assortment
for select to authenticated
using (app_private.is_org_member(organization_id));
revoke all on table public.branch_product_assortment from public, anon, authenticated;
grant select on table public.branch_product_assortment to authenticated;

-- An assortment change is a change to that PRODUCT for THAT branch's POS: it rides the existing
-- incremental catalog cursor (pos_catalog_changes carries an optional branch_id for exactly this).
create function app_private.log_branch_assortment_catalog_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_org uuid := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
  changed_branch uuid := case when tg_op = 'DELETE' then old.branch_id else new.branch_id end;
  changed_product uuid := case when tg_op = 'DELETE' then old.product_id else new.product_id end;
begin
  -- A branch/product being deleted cascades its rows; their own triggers already logged the change
  -- and the referenced rows may be gone (FK on pos_catalog_changes).
  if exists (select 1 from public.branches b where b.id = changed_branch)
     and exists (select 1 from public.products p where p.id = changed_product) then
    insert into public.pos_catalog_changes (organization_id, branch_id, entity_type, entity_id)
    values (changed_org, changed_branch, 'PRODUCT', changed_product);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger branch_product_assortment_log_pos_change
after insert or delete on public.branch_product_assortment
for each row execute function app_private.log_branch_assortment_catalog_change();
create trigger branch_product_assortment_audit
after insert or delete on public.branch_product_assortment
for each row execute function app_private.audit_row_change();

-- Enables one product in one branch (idempotent). Shared by the RPCs below and the import engine.
create function app_private.enable_product_in_branch(
  p_organization_id uuid,
  p_branch_id uuid,
  p_product_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inserted_id uuid;
begin
  insert into public.branch_product_assortment (organization_id, branch_id, product_id, created_by)
  values (p_organization_id, p_branch_id, p_product_id, auth.uid())
  on conflict (branch_id, product_id) do nothing
  returning id into inserted_id;
  return inserted_id is not null;
end;
$$;

-- Replaces the full set of branches where a product is enabled (same reconcile semantics as
-- set_product_categories/set_product_barcodes: idempotent). Returns what changed, plus the
-- branches where the product was disabled while it still has stock (its stock stays in the
-- ledger; it just stops being sellable there), so the caller can warn.
create function public.set_product_branches(p_product_id uuid, p_branch_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  wanted uuid[];
  enabled_ids uuid[];
  disabled_ids uuid[];
  with_stock jsonb;
begin
  if not exists (
    select 1 from public.products p where p.id = p_product_id and p.organization_id = current_organization_id
  ) then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct x), array[]::uuid[]) into wanted from unnest(coalesce(p_branch_ids, array[]::uuid[])) as x;
  if exists (
    select 1 from unnest(wanted) as x
    where not exists (select 1 from public.branches b where b.id = x and b.organization_id = current_organization_id)
  ) then
    raise exception 'Una de las sucursales no existe en esta organización' using errcode = '22023';
  end if;

  -- Serialize concurrent edits of the same product.
  perform 1 from public.products p where p.id = p_product_id and p.organization_id = current_organization_id for update;

  with removed as (
    delete from public.branch_product_assortment a
    where a.organization_id = current_organization_id and a.product_id = p_product_id
      and not (a.branch_id = any (wanted))
    returning a.branch_id
  )
  select coalesce(array_agg(branch_id), array[]::uuid[]) into disabled_ids from removed;

  with added as (
    insert into public.branch_product_assortment (organization_id, branch_id, product_id, created_by)
    select current_organization_id, x, p_product_id, auth.uid() from unnest(wanted) as x
    on conflict (branch_id, product_id) do nothing
    returning branch_id
  )
  select coalesce(array_agg(branch_id), array[]::uuid[]) into enabled_ids from added;

  select coalesce(jsonb_agg(jsonb_build_object('branchId', s.branch_id, 'quantity', s.quantity)), '[]'::jsonb)
  into with_stock
  from (
    select sm.branch_id, sum(sm.quantity_grams)::bigint as quantity
    from public.stock_movements sm
    where sm.organization_id = current_organization_id and sm.product_id = p_product_id
      and sm.branch_id = any (disabled_ids)
    group by sm.branch_id
    having sum(sm.quantity_grams) > 0
  ) s;

  return jsonb_build_object('enabled', to_jsonb(enabled_ids), 'disabled', to_jsonb(disabled_ids), 'disabledWithStock', with_stock);
end;
$$;

-- Bulk enable/disable a list of products in ONE branch (the "surtido de la sucursal" editor and
-- catalog-wide changes). Returns how many rows actually changed.
create function public.set_branch_products(p_branch_id uuid, p_product_ids uuid[], p_enabled boolean)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  changed integer;
begin
  if p_enabled is null then
    raise exception 'p_enabled is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;
  if p_product_ids is null or cardinality(p_product_ids) not between 1 and 1000 then
    raise exception 'Debe enviar entre 1 y 1000 productos' using errcode = '22023';
  end if;

  if p_enabled then
    with added as (
      insert into public.branch_product_assortment (organization_id, branch_id, product_id, created_by)
      select current_organization_id, p_branch_id, p.id, auth.uid()
      from public.products p
      where p.organization_id = current_organization_id and p.id = any (p_product_ids)
      on conflict (branch_id, product_id) do nothing
      returning 1
    )
    select count(*)::integer into changed from added;
  else
    with removed as (
      delete from public.branch_product_assortment a
      where a.organization_id = current_organization_id and a.branch_id = p_branch_id
        and a.product_id = any (p_product_ids)
      returning 1
    )
    select count(*)::integer into changed from removed;
  end if;
  return changed;
end;
$$;

-- Adds to the destination every product enabled in the source (additive: never removes). Used to
-- give a new branch an existing branch's catalog in one step.
create function public.copy_branch_assortment(p_source_branch_id uuid, p_destination_branch_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  added integer;
begin
  if p_source_branch_id = p_destination_branch_id then
    raise exception 'Origen y destino deben ser distintos' using errcode = '22023';
  end if;
  if (select count(*) from public.branches b
      where b.organization_id = current_organization_id and b.id in (p_source_branch_id, p_destination_branch_id)) <> 2 then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;
  with inserted as (
    insert into public.branch_product_assortment (organization_id, branch_id, product_id, created_by)
    select current_organization_id, p_destination_branch_id, a.product_id, auth.uid()
    from public.branch_product_assortment a
    where a.organization_id = current_organization_id and a.branch_id = p_source_branch_id
    on conflict (branch_id, product_id) do nothing
    returning 1
  )
  select count(*)::integer into added from inserted;
  return added;
end;
$$;

revoke all on function
  app_private.log_branch_assortment_catalog_change(),
  app_private.enable_product_in_branch(uuid, uuid, uuid)
from public, anon, authenticated;
revoke all on function
  public.set_product_branches(uuid, uuid[]),
  public.set_branch_products(uuid, uuid[], boolean),
  public.copy_branch_assortment(uuid, uuid)
from public, anon;
grant execute on function
  public.set_product_branches(uuid, uuid[]),
  public.set_branch_products(uuid, uuid[], boolean),
  public.copy_branch_assortment(uuid, uuid)
to authenticated;

-- ---------------------------------------------------------------------------------------------
-- POS catalog: honour the assortment and carry barcodes (offline: they are stored in SQLite).
-- ---------------------------------------------------------------------------------------------

-- Browser/online POS fallback. RETURNS TABLE cannot gain a column via CREATE OR REPLACE → drop+create
-- (same technique as 202609130014 / 202609230033 for this exact function).
drop function public.get_pos_catalog(uuid);

create function public.get_pos_catalog(p_branch_id uuid)
returns table (
  organization_id uuid,
  branch_id uuid,
  branch_name text,
  category_id uuid,
  category_name text,
  category_color_hex text,
  category_sort_order integer,
  category_ids uuid[],
  product_id uuid,
  product_name text,
  product_sku text,
  unit_type public.unit_type,
  price_per_kg_cents bigint,
  price_valid_from timestamptz,
  barcodes text[]
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
  select b.organization_id into current_organization_id
  from public.branches b
  where b.id = p_branch_id and b.active;
  if current_organization_id is null
     or not app_private.can_access_branch(current_organization_id, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  return query
  select p.organization_id, b.id, b.name, c.id, c.name, c.color_hex, c.sort_order,
         coalesce(assigned_categories.category_ids, array[c.id]),
         p.id, p.name, p.sku, p.unit_type, effective_price.price_cents, effective_price.valid_from,
         coalesce(product_codes.barcodes, array[]::text[])
  from public.products p
  join public.branch_product_assortment a
    on a.product_id = p.id and a.branch_id = p_branch_id and a.organization_id = p.organization_id
  join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id and c.active
  join public.branches b on b.id = p_branch_id and b.organization_id = p.organization_id
  join lateral (
    select pp.price_cents, pp.valid_from
    from public.product_prices pp
    where pp.organization_id = p.organization_id and pp.product_id = p.id
      and (pp.branch_id = p_branch_id or pp.branch_id is null)
      and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
    order by (pp.branch_id = p_branch_id) desc nulls last, pp.valid_from desc
    limit 1
  ) effective_price on true
  left join lateral (
    select array_agg(pca.category_id) as category_ids
    from public.product_category_assignments pca
    join public.categories cc on cc.id = pca.category_id and cc.organization_id = p.organization_id and cc.active
    where pca.product_id = p.id and pca.organization_id = p.organization_id
  ) assigned_categories on true
  left join lateral (
    select array_agg(pb.barcode order by pb.barcode) as barcodes
    from public.product_barcodes pb
    where pb.product_id = p.id and pb.organization_id = p.organization_id
  ) product_codes on true
  where p.organization_id = current_organization_id and p.active
  order by c.sort_order, c.name, p.name;
end;
$$;

revoke all on function public.get_pos_catalog(uuid) from public, anon;
grant execute on function public.get_pos_catalog(uuid) to authenticated;

-- Tab directory: only categories that have at least one product ENABLED in this branch (Avenida
-- must not get a "Bebidas" tab because Central sells drinks). Same signature → CREATE OR REPLACE.
create or replace function public.get_pos_categories(p_branch_id uuid)
returns table (
  id uuid,
  name text,
  color_hex text,
  sort_order integer
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
  select b.organization_id into current_organization_id
  from public.branches b
  where b.id = p_branch_id and b.active;
  if current_organization_id is null
     or not app_private.can_access_branch(current_organization_id, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  return query
  select c.id, c.name, c.color_hex, c.sort_order
  from public.categories c
  where c.organization_id = current_organization_id and c.active
    and exists (
      select 1
      from public.product_category_assignments pca
      join public.branch_product_assortment a
        on a.product_id = pca.product_id and a.branch_id = p_branch_id and a.organization_id = pca.organization_id
      where pca.category_id = c.id and pca.organization_id = c.organization_id
    )
  order by c.sort_order, c.name;
end;
$$;

-- pull_pos_state: same as 202609230033 plus (1) only products enabled in THIS device's branch are
-- sent (a product that stops being enabled lands in removedProductIds so the POS deactivates it
-- locally), (2) every item carries its barcodes, (3) the category directory only lists categories
-- with at least one enabled product. The incremental cursor needs no change: assortment and
-- barcode edits are logged as PRODUCT changes (triggers above / 202609300042).
create or replace function public.pull_pos_state(p_device_id uuid, p_after_sequence bigint default 0)
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
  categories_payload jsonb;
begin
  if current_profile_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select d.organization_id, d.branch_id, b.name, b.active, d.status, r.name
  into current_organization_id, current_branch_id, current_branch_name,
       current_branch_active, current_device_status, current_role_name
  from public.pos_devices d
  join public.branches b on b.id = d.branch_id and b.organization_id = d.organization_id
  join public.organization_members om on om.organization_id = d.organization_id and om.profile_id = current_profile_id and om.status = 'ACTIVE'
  join public.roles r on r.id = om.role_id
  where d.id = p_device_id;
  if not found or current_device_status <> 'ACTIVE' or not current_branch_active
     or not app_private.can_access_branch(current_organization_id, current_branch_id, 'sales.create') then
    raise exception 'Device or branch is not authorized for this user' using errcode = '42501';
  end if;
  select coalesce(max(c.sequence), p_after_sequence) into current_cursor
  from public.pos_catalog_changes c
  where c.organization_id = current_organization_id and (c.branch_id is null or c.branch_id = current_branch_id);
  with changed_products as (
    select distinct p.id
    from public.products p
    where p.organization_id = current_organization_id and (
      p_after_sequence = 0 or exists (
        select 1 from public.pos_catalog_changes c
        where c.organization_id = current_organization_id and c.sequence > p_after_sequence
          and (c.branch_id is null or c.branch_id = current_branch_id)
          and ((c.entity_type in ('PRODUCT', 'PRICE') and c.entity_id = p.id)
            or (c.entity_type = 'CATEGORY' and c.entity_id = p.category_id)
            or c.entity_type = 'BRANCH')
      )
    )
  ), effective_catalog as (
    select p.organization_id, current_branch_id as branch_id, current_branch_name as branch_name,
      current_branch_active as branch_active, c.id as category_id, c.name as category_name,
      c.color_hex as category_color_hex, c.sort_order as category_sort_order, c.active as category_active,
      p.id as product_id, p.name as product_name, p.sku as product_sku, p.unit_type,
      p.active as product_active, effective_price.price_cents, effective_price.valid_from,
      assigned_categories.category_ids, product_codes.barcodes
    from changed_products changed
    join public.products p on p.id = changed.id and p.organization_id = current_organization_id
    join public.branch_product_assortment a
      on a.product_id = p.id and a.branch_id = current_branch_id and a.organization_id = p.organization_id
    join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    join lateral (
      select pp.price_cents, pp.valid_from
      from public.product_prices pp
      where pp.organization_id = p.organization_id and pp.product_id = p.id
        and (pp.branch_id = current_branch_id or pp.branch_id is null)
        and pp.valid_from <= current_server_time and (pp.valid_to is null or pp.valid_to > current_server_time)
      order by (pp.branch_id = current_branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) effective_price on true
    left join lateral (
      select array_agg(pca.category_id) as category_ids
      from public.product_category_assignments pca
      join public.categories cc on cc.id = pca.category_id and cc.organization_id = p.organization_id and cc.active
      where pca.product_id = p.id and pca.organization_id = p.organization_id
    ) assigned_categories on true
    left join lateral (
      select array_agg(pb.barcode order by pb.barcode) as barcodes
      from public.product_barcodes pb
      where pb.product_id = p.id and pb.organization_id = p.organization_id
    ) product_codes on true
    where p.active and c.active and current_branch_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', organization_id, 'branchId', branch_id, 'branchName', branch_name,
    'branchActive', branch_active, 'categoryId', category_id, 'categoryName', category_name,
    'categoryColorHex', category_color_hex, 'categorySortOrder', category_sort_order,
    'categoryActive', category_active, 'categoryIds', coalesce(to_jsonb(category_ids), jsonb_build_array(category_id)),
    'productId', product_id, 'productName', product_name,
    'productSku', product_sku, 'unitType', unit_type, 'productActive', product_active,
    'pricePerKgCents', price_cents::text, 'priceValidFrom', valid_from,
    'barcodes', coalesce(to_jsonb(barcodes), '[]'::jsonb)
  ) order by category_sort_order, category_name, product_name), '[]'::jsonb)
  into catalog_payload from effective_catalog;
  with changed_products as (
    select distinct p.id
    from public.products p
    where p.organization_id = current_organization_id and (
      p_after_sequence = 0 or exists (
        select 1 from public.pos_catalog_changes c
        where c.organization_id = current_organization_id and c.sequence > p_after_sequence
          and (c.branch_id is null or c.branch_id = current_branch_id)
          and ((c.entity_type in ('PRODUCT', 'PRICE') and c.entity_id = p.id)
            or (c.entity_type = 'CATEGORY' and c.entity_id = p.category_id)
            or c.entity_type = 'BRANCH')
      )
    )
  )
  select coalesce(jsonb_agg(changed.id), '[]'::jsonb) into removed_payload
  from changed_products changed
  where not exists (
    select 1 from public.products p
    join public.branch_product_assortment a
      on a.product_id = p.id and a.branch_id = current_branch_id and a.organization_id = p.organization_id
    join public.categories c on c.id = p.category_id and c.active
    join lateral (
      select 1 from public.product_prices pp
      where pp.product_id = p.id and pp.organization_id = p.organization_id
        and (pp.branch_id = current_branch_id or pp.branch_id is null)
        and pp.valid_from <= current_server_time and (pp.valid_to is null or pp.valid_to > current_server_time)
      limit 1
    ) price_exists on true
    where p.id = changed.id and p.active and current_branch_active
  );
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'colorHex', c.color_hex, 'sortOrder', c.sort_order
  ) order by c.sort_order, c.name), '[]'::jsonb)
  into categories_payload
  from public.categories c
  where c.organization_id = current_organization_id and c.active
    and exists (
      select 1
      from public.product_category_assignments pca
      join public.branch_product_assortment a
        on a.product_id = pca.product_id and a.branch_id = current_branch_id and a.organization_id = pca.organization_id
      where pca.category_id = c.id and pca.organization_id = c.organization_id
    );

  update public.pos_devices set last_seen_at = current_server_time where id = p_device_id;
  return jsonb_build_object(
    'cursor', current_cursor, 'serverTime', current_server_time,
    'authorizationExpiresAt', current_server_time + interval '24 hours',
    'organizationId', current_organization_id, 'branchId', current_branch_id,
    'branchName', current_branch_name, 'branchActive', current_branch_active,
    'deviceStatus', current_device_status, 'roleName', current_role_name,
    'catalog', catalog_payload, 'removedProductIds', removed_payload, 'categories', categories_payload
  );
end;
$$;

-- Devices that already synced before this migration must learn (a) each product's barcodes and
-- (b) nothing else changes for them (every existing pair is enabled). Barcodes may already exist
-- (042 shipped them unsynced), so log one PRODUCT change per product that has any.
insert into public.pos_catalog_changes (organization_id, branch_id, entity_type, entity_id)
select distinct pb.organization_id, null::uuid, 'PRODUCT', pb.product_id from public.product_barcodes pb;

commit;
