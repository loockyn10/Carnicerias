begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

create schema if not exists app_private;
revoke all on schema app_private from public, anon;
grant usage on schema app_private to authenticated;

create type public.unit_type as enum ('WEIGHT', 'UNIT');
create type public.membership_status as enum ('INVITED', 'ACTIVE', 'DISABLED');

create table public.organizations (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  currency text not null default 'ARS' check (currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'America/Argentina/Buenos_Aires',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.branches (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  constraint system_role_scope check ((is_system and organization_id is null) or (not is_system and organization_id is not null))
);

create unique index roles_system_key_uq on public.roles (key) where organization_id is null;
create unique index roles_organization_key_uq on public.roles (organization_id, key) where organization_id is not null;

create table public.permissions (
  key text primary key check (key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  description text not null,
  created_at timestamptz not null default now()
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_key)
);

create table public.organization_members (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  status public.membership_status not null default 'INVITED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, profile_id)
);

create table public.branch_members (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  profile_id uuid not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete cascade,
  foreign key (organization_id, profile_id)
    references public.organization_members(organization_id, profile_id) on delete cascade,
  unique (branch_id, profile_id)
);

create table public.categories (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug),
  unique (id, organization_id)
);

create table public.products (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  sku text,
  unit_type public.unit_type not null default 'WEIGHT',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (category_id, organization_id)
    references public.categories(id, organization_id) on delete restrict,
  unique (organization_id, slug),
  unique (id, organization_id)
);

create unique index products_organization_sku_uq
  on public.products (organization_id, sku)
  where sku is not null;

create table public.product_prices (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  branch_id uuid,
  price_cents bigint not null check (price_cents > 0),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (product_id, organization_id)
    references public.products(id, organization_id) on delete restrict,
  foreign key (branch_id, organization_id)
    references public.branches(id, organization_id) on delete restrict,
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (
    product_id with =,
    (coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    (tstzrange(valid_from, valid_to, '[)')) with &&
  )
);

comment on column public.product_prices.price_cents is
  'Integer ARS cents per kilogram for WEIGHT products or per unit for UNIT products.';
comment on table public.product_prices is
  'Append-only price history. Existing amounts and start times cannot be rewritten; close a range and insert the next price.';

create index branches_organization_idx on public.branches (organization_id, active);
create index organization_members_profile_idx on public.organization_members (profile_id, status);
create index organization_members_role_idx on public.organization_members (role_id);
create index branch_members_profile_idx on public.branch_members (profile_id, active);
create index categories_organization_idx on public.categories (organization_id, active, sort_order);
create index products_organization_category_idx on public.products (organization_id, category_id, active);
create index product_prices_product_current_idx on public.product_prices (product_id, branch_id, valid_from desc) where valid_to is null;
create index product_prices_organization_idx on public.product_prices (organization_id, valid_from desc);

insert into public.permissions (key, description) values
  ('organizations.read', 'Read the organization'),
  ('organizations.write', 'Update organization settings'),
  ('branches.read_all', 'Read every branch in the organization'),
  ('branches.write', 'Create and update branches'),
  ('members.read', 'Read organization members'),
  ('members.write', 'Invite and manage organization members'),
  ('products.read', 'Read categories and products'),
  ('products.write', 'Create and update categories and products'),
  ('prices.read', 'Read product prices'),
  ('prices.write', 'Create and close product prices');

insert into public.roles (id, organization_id, key, name, description, is_system) values
  ('10000000-0000-4000-8000-000000000001', null, 'admin', 'Administrador', 'Owner-level access inside an organization.', true),
  ('10000000-0000-4000-8000-000000000002', null, 'employee', 'Empleado', 'Operational access limited to assigned branches.', true);

insert into public.role_permissions (role_id, permission_key)
select '10000000-0000-4000-8000-000000000001'::uuid, key from public.permissions;

insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-4000-8000-000000000002', 'organizations.read'),
  ('10000000-0000-4000-8000-000000000002', 'products.read'),
  ('10000000-0000-4000-8000-000000000002', 'prices.read');

create function app_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_set_updated_at before update on public.organizations
for each row execute function app_private.set_updated_at();
create trigger branches_set_updated_at before update on public.branches
for each row execute function app_private.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function app_private.set_updated_at();
create trigger organization_members_set_updated_at before update on public.organization_members
for each row execute function app_private.set_updated_at();
create trigger branch_members_set_updated_at before update on public.branch_members
for each row execute function app_private.set_updated_at();
create trigger categories_set_updated_at before update on public.categories
for each row execute function app_private.set_updated_at();
create trigger products_set_updated_at before update on public.products
for each row execute function app_private.set_updated_at();

create function app_private.validate_membership_role()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  role_organization_id uuid;
begin
  select r.organization_id into role_organization_id
  from public.roles r
  where r.id = new.role_id;

  if not found then
    raise exception 'Role does not exist';
  end if;

  if role_organization_id is not null and role_organization_id <> new.organization_id then
    raise exception 'Role belongs to another organization';
  end if;

  return new;
end;
$$;

create trigger organization_members_validate_role
before insert or update of organization_id, role_id on public.organization_members
for each row execute function app_private.validate_membership_role();

create function app_private.prevent_price_history_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.product_id is distinct from old.product_id
     or new.branch_id is distinct from old.branch_id
     or new.price_cents is distinct from old.price_cents
     or new.valid_from is distinct from old.valid_from
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Historical price fields are immutable; close the range and insert a new price';
  end if;

  return new;
end;
$$;

create trigger product_prices_prevent_history_rewrite
before update on public.product_prices
for each row execute function app_private.prevent_price_history_rewrite();

create function app_private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Usuario'
    )
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function app_private.handle_new_user();

create function app_private.is_org_member(requested_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members om
    join public.profiles p on p.id = om.profile_id and p.active
    where om.organization_id = requested_organization_id
      and om.profile_id = auth.uid()
      and om.status = 'ACTIVE'
  );
$$;

create function app_private.has_permission(requested_organization_id uuid, requested_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members om
    join public.profiles p on p.id = om.profile_id and p.active
    join public.roles r on r.id = om.role_id
    join public.role_permissions rp on rp.role_id = r.id
    where om.organization_id = requested_organization_id
      and om.profile_id = auth.uid()
      and om.status = 'ACTIVE'
      and rp.permission_key = requested_permission
      and (r.organization_id is null or r.organization_id = requested_organization_id)
  );
$$;

create function app_private.is_branch_member(requested_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.branch_members bm
    join public.organization_members om
      on om.organization_id = bm.organization_id
      and om.profile_id = bm.profile_id
      and om.status = 'ACTIVE'
    join public.profiles p on p.id = bm.profile_id and p.active
    where bm.branch_id = requested_branch_id
      and bm.profile_id = auth.uid()
      and bm.active
  );
$$;

create function app_private.can_read_profile(requested_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select requested_profile_id = auth.uid()
    or exists (
      select 1
      from public.organization_members target
      where target.profile_id = requested_profile_id
        and app_private.has_permission(target.organization_id, 'members.read')
    );
$$;

revoke all on all functions in schema app_private from public, anon;
grant execute on function app_private.is_org_member(uuid) to authenticated;
grant execute on function app_private.has_permission(uuid, text) to authenticated;
grant execute on function app_private.is_branch_member(uuid) to authenticated;
grant execute on function app_private.can_read_profile(uuid) to authenticated;

alter table public.organizations enable row level security;
alter table public.branches enable row level security;
alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.organization_members enable row level security;
alter table public.branch_members enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_prices enable row level security;

create policy organizations_select on public.organizations
for select to authenticated
using (app_private.is_org_member(id));

create policy organizations_update on public.organizations
for update to authenticated
using (app_private.has_permission(id, 'organizations.write'))
with check (app_private.has_permission(id, 'organizations.write'));

create policy branches_select on public.branches
for select to authenticated
using (
  app_private.has_permission(organization_id, 'branches.read_all')
  or app_private.is_branch_member(id)
);

create policy branches_insert on public.branches
for insert to authenticated
with check (app_private.has_permission(organization_id, 'branches.write'));

create policy branches_update on public.branches
for update to authenticated
using (app_private.has_permission(organization_id, 'branches.write'))
with check (app_private.has_permission(organization_id, 'branches.write'));

create policy profiles_select on public.profiles
for select to authenticated
using (app_private.can_read_profile(id));

create policy profiles_update_self on public.profiles
for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy roles_select on public.roles
for select to authenticated
using (organization_id is null or app_private.is_org_member(organization_id));

create policy permissions_select on public.permissions
for select to authenticated
using (true);

create policy role_permissions_select on public.role_permissions
for select to authenticated
using (
  exists (
    select 1 from public.roles r
    where r.id = role_id
      and (r.organization_id is null or app_private.is_org_member(r.organization_id))
  )
);

create policy organization_members_select on public.organization_members
for select to authenticated
using (
  profile_id = auth.uid()
  or app_private.has_permission(organization_id, 'members.read')
);

create policy organization_members_insert on public.organization_members
for insert to authenticated
with check (app_private.has_permission(organization_id, 'members.write'));

create policy organization_members_update on public.organization_members
for update to authenticated
using (app_private.has_permission(organization_id, 'members.write'))
with check (app_private.has_permission(organization_id, 'members.write'));

create policy organization_members_delete on public.organization_members
for delete to authenticated
using (app_private.has_permission(organization_id, 'members.write'));

create policy branch_members_select on public.branch_members
for select to authenticated
using (
  profile_id = auth.uid()
  or app_private.has_permission(organization_id, 'members.read')
);

create policy branch_members_insert on public.branch_members
for insert to authenticated
with check (app_private.has_permission(organization_id, 'members.write'));

create policy branch_members_update on public.branch_members
for update to authenticated
using (app_private.has_permission(organization_id, 'members.write'))
with check (app_private.has_permission(organization_id, 'members.write'));

create policy branch_members_delete on public.branch_members
for delete to authenticated
using (app_private.has_permission(organization_id, 'members.write'));

create policy categories_select on public.categories
for select to authenticated
using (app_private.is_org_member(organization_id));

create policy categories_insert on public.categories
for insert to authenticated
with check (app_private.has_permission(organization_id, 'products.write'));

create policy categories_update on public.categories
for update to authenticated
using (app_private.has_permission(organization_id, 'products.write'))
with check (app_private.has_permission(organization_id, 'products.write'));

create policy products_select on public.products
for select to authenticated
using (app_private.is_org_member(organization_id));

create policy products_insert on public.products
for insert to authenticated
with check (app_private.has_permission(organization_id, 'products.write'));

create policy products_update on public.products
for update to authenticated
using (app_private.has_permission(organization_id, 'products.write'))
with check (app_private.has_permission(organization_id, 'products.write'));

create policy product_prices_select on public.product_prices
for select to authenticated
using (
  app_private.has_permission(organization_id, 'branches.read_all')
  or (
    app_private.is_org_member(organization_id)
    and (branch_id is null or app_private.is_branch_member(branch_id))
  )
);

create policy product_prices_insert on public.product_prices
for insert to authenticated
with check (
  app_private.has_permission(organization_id, 'prices.write')
  and (created_by is null or created_by = auth.uid())
);

create policy product_prices_update on public.product_prices
for update to authenticated
using (app_private.has_permission(organization_id, 'prices.write'))
with check (app_private.has_permission(organization_id, 'prices.write'));

commit;
