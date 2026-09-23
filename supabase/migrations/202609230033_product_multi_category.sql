begin;

-- Multi-category products: a product (e.g. "Chorizo de cerdo") can belong to
-- several categories (Cerdo, Embutidos) while keeping exactly one PRINCIPAL
-- category for backward compatibility (products.category_id, unchanged —
-- still drives the product card's color/label everywhere that only needs one).
-- product_category_assignments is the additive membership set; the principal
-- category is always included in it (kept coherent by set_product_categories
-- below, never by application code juggling both independently).
--
-- Every existing product keeps exactly its current category via the backfill.
-- No screen that only needs a single label/color is touched by this migration
-- — only screens that need real multi-category membership (the POS filter)
-- are expected to start reading this table.

create table public.product_category_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  category_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete cascade,
  foreign key (category_id, organization_id) references public.categories(id, organization_id) on delete restrict,
  unique (product_id, category_id)
);
create index product_category_assignments_category_idx on public.product_category_assignments (organization_id, category_id);
create index product_category_assignments_product_idx on public.product_category_assignments (organization_id, product_id);

insert into public.product_category_assignments (organization_id, product_id, category_id)
select organization_id, id, category_id from public.products where category_id is not null
on conflict do nothing;

alter table public.product_category_assignments enable row level security;
create policy product_category_assignments_select on public.product_category_assignments
for select to authenticated using (app_private.is_org_member(organization_id));
revoke all on table public.product_category_assignments from public, anon, authenticated;
grant select on table public.product_category_assignments to authenticated;

-- Reuse the existing POS catalog change log/trigger machinery instead of
-- inventing a second sync mechanism: a category (re)assignment logs a
-- 'PRODUCT' change for that product_id, exactly like editing the product
-- itself, so pull_pos_state's existing changed-products detection already
-- picks it up on the next incremental sync with no further wiring.
create or replace function app_private.log_pos_catalog_change()
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
    when 'product_category_assignments' then
      current_entity_type := 'PRODUCT';
      current_entity_id := (record_data ->> 'product_id')::uuid;
      current_branch_id := null;
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

create trigger product_category_assignments_log_pos_change
after insert or delete on public.product_category_assignments
for each row execute function app_private.log_pos_catalog_change();

-- set_product_categories: single transactional write path for the full
-- membership set. If the principal category is missing from p_category_ids it
-- is added automatically (never rejected — "mantener coherencia
-- automáticamente" per the product requirement), so callers can just submit
-- "principal + whatever else was checked" without a separate reconciliation
-- step. products.category_id is updated in the same statement so the two
-- never observe an inconsistent intermediate state.
create function public.set_product_categories(
  p_product_id uuid,
  p_primary_category_id uuid,
  p_category_ids uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  normalized_ids uuid[];
begin
  if not exists (select 1 from public.products where id = p_product_id and organization_id = current_organization_id) then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
  if p_primary_category_id is null or not exists (
    select 1 from public.categories where id = p_primary_category_id and organization_id = current_organization_id
  ) then
    raise exception 'Primary category is invalid' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct category_id), array[]::uuid[]) into normalized_ids
  from unnest(coalesce(p_category_ids, array[]::uuid[]) || p_primary_category_id) as category_id
  where exists (select 1 from public.categories c where c.id = category_id and c.organization_id = current_organization_id);

  if array_length(normalized_ids, 1) is null then
    raise exception 'A product must have at least one category' using errcode = '22023';
  end if;

  update public.products set category_id = p_primary_category_id
  where id = p_product_id and organization_id = current_organization_id;

  delete from public.product_category_assignments
  where product_id = p_product_id and organization_id = current_organization_id and not (category_id = any(normalized_ids));

  insert into public.product_category_assignments (organization_id, product_id, category_id)
  select current_organization_id, p_product_id, category_id from unnest(normalized_ids) as category_id
  on conflict (product_id, category_id) do nothing;
end;
$$;

revoke all on function public.set_product_categories(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.set_product_categories(uuid, uuid, uuid[]) to authenticated;

-- get_pos_catalog: the browser/online POS fallback (apps/pos/src/App.tsx calls
-- this directly when not running the Tauri desktop build) reads catalog rows
-- from here instead of pull_pos_state — needs the same category_ids addition.
-- A RETURNS TABLE function can't gain a column via CREATE OR REPLACE, so this
-- is DROP + CREATE (same technique already used in 202609130014 for this
-- exact function, and in 202609220026 for the production RPCs).
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
         p.id, p.name, p.sku, p.unit_type, effective_price.price_cents, effective_price.valid_from
  from public.products p
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
  where p.organization_id = current_organization_id and p.active
  order by c.sort_order, c.name, p.name;
end;
$$;

revoke all on function public.get_pos_catalog(uuid) from public, anon;
grant execute on function public.get_pos_catalog(uuid) to authenticated;

-- get_pos_categories: the category DIRECTORY the POS uses to build its tabs —
-- deliberately independent of any single product's principal category. A tab
-- must exist for every active category that has at least one product
-- assignment (principal OR "también aparece en"), and must NOT exist for a
-- category with zero assignments at all. Since product_category_assignments
-- always includes a product's principal (set_product_categories guarantees
-- this), "has >=1 assignment" is exactly the right condition — no need to
-- separately check products.category_id.
create function public.get_pos_categories(p_branch_id uuid)
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
      select 1 from public.product_category_assignments pca
      where pca.category_id = c.id and pca.organization_id = c.organization_id
    )
  order by c.sort_order, c.name;
end;
$$;

revoke all on function public.get_pos_categories(uuid) from public, anon;
grant execute on function public.get_pos_categories(uuid) to authenticated;

-- pull_pos_state: expose every assigned category (not just the principal) so
-- the POS can filter/tab a product under all of its categories. categoryId /
-- categoryName / categoryColorHex stay the PRINCIPAL category (unchanged —
-- still the single source for the product card's color/label). categoryIds is
-- the full active-category membership, used only for filtering. A new
-- top-level "categories" key (same directory as get_pos_categories, always a
-- full current snapshot regardless of the incremental cursor — categories are
-- a small table, cheap to resend every pull) is the actual TAB SOURCE: it is
-- NOT derived from any product's principal, so a category used only as
-- "también aparece en" still gets a tab, and an entirely unused category
-- never does.
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
      assigned_categories.category_ids
    from changed_products changed
    join public.products p on p.id = changed.id and p.organization_id = current_organization_id
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
    where p.active and c.active and current_branch_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', organization_id, 'branchId', branch_id, 'branchName', branch_name,
    'branchActive', branch_active, 'categoryId', category_id, 'categoryName', category_name,
    'categoryColorHex', category_color_hex, 'categorySortOrder', category_sort_order,
    'categoryActive', category_active, 'categoryIds', coalesce(to_jsonb(category_ids), jsonb_build_array(category_id)),
    'productId', product_id, 'productName', product_name,
    'productSku', product_sku, 'unitType', unit_type, 'productActive', product_active,
    'pricePerKgCents', price_cents::text, 'priceValidFrom', valid_from
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
      select 1 from public.product_category_assignments pca
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

commit;
