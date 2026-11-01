begin;

-- Módulo POLLOS del Admin (cajones de pollo para clientes mayoristas): catálogo propio, costos y precios versionados,
-- listas de precios extensibles, clientes y pedidos con snapshot histórico de precio (al crear) y de costo (al entregar).
--
-- Por qué NO se reutiliza `products` (auditoría previa a esta migración):
--   * todo producto activo viaja al POS (pull_pos_state) y a etiquetas/cartelería/stock/reposición: un «Cajón pollo entero» no puede
--     aparecer en la caja de una sucursal en producción;
--   * set_product_cost/save_product_pricing recalculan el precio de lista con el margen GLOBAL (D-065/D-071): un cajón se vende por
--     lista de precios mayorista, no por margen minorista.
--   Se replica en cambio el PATRÓN ya probado de `product_costs` / `product_prices` (vigencias con exclusión GiST, historia inmutable).
--   Clientes: no existe ningún modelo general de clientes en el esquema (sólo se anticipa en docs/IMPORTS.md), por eso `poultry_customers`.
--   Reutilizados: `unit_type` (UNIT = se vende por cajón, WEIGHT = por kg), `payment_method`, `branches`, `audit_row_change`,
--   `require_permission`, `import_normalize_text`.
--
-- Escritura: ninguna tabla acepta INSERT/UPDATE/DELETE de `authenticated`; todo pasa por las RPC de abajo (permiso `poultry.write`,
-- organización y sucursal validadas en el servidor, nunca por IDs del cliente). Lectura: RLS por organización + `poultry.read`,
-- y para pedidos además aislamiento por sucursal (read_all o miembro de la sucursal).

insert into public.permissions (key, description) values
  ('poultry.read', 'Read the poultry module: products, price lists, customers, orders and profitability'),
  ('poultry.write', 'Manage poultry products, costs, price lists, customers and orders')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-4000-8000-000000000001', 'poultry.read'),
  ('10000000-0000-4000-8000-000000000001', 'poultry.write')
on conflict (role_id, permission_key) do nothing;

create type public.poultry_order_status as enum ('PENDING', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED');

-- ---------------------------------------------------------------------------------------------
-- Catálogo, costos y listas de precios
-- ---------------------------------------------------------------------------------------------

create table public.poultry_products (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  -- UNIT: precio y costo por cajón. WEIGHT: precio y costo por kg (hace falta el peso real para valorizar la línea).
  sale_unit public.unit_type not null default 'UNIT',
  -- Para productos por cajón: si además hay que pesar el cajón antes de entregar (informativo para kilos vendidos).
  requires_weight boolean not null default false,
  -- Peso nominal de un cajón (gramos), opcional: sólo referencia en pantalla.
  reference_weight_grams integer check (reference_weight_grams is null or reference_weight_grams > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  check (sale_unit <> 'WEIGHT' or requires_weight)
);
create unique index poultry_products_org_name_uq on public.poultry_products (organization_id, (app_private.import_normalize_text(name)));
create index poultry_products_org_active_idx on public.poultry_products (organization_id, active);

create table public.poultry_product_costs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  cost_cents bigint not null check (cost_cents > 0),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (product_id, organization_id) references public.poultry_products(id, organization_id) on delete restrict,
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (product_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create index poultry_product_costs_current_idx on public.poultry_product_costs (product_id, valid_from desc);
create index poultry_product_costs_org_idx on public.poultry_product_costs (organization_id);

create table public.poultry_price_lists (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  notes text check (notes is null or char_length(notes) between 1 and 500),
  -- La lista GENERAL: a lo sumo una por organización; es el respaldo cuando un cliente no tiene lista o su lista no tiene el producto.
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  check (not is_default or active)
);
create unique index poultry_price_lists_one_default_uq on public.poultry_price_lists (organization_id) where is_default;
create unique index poultry_price_lists_org_name_uq on public.poultry_price_lists (organization_id, (app_private.import_normalize_text(name)));

create table public.poultry_price_list_prices (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  price_list_id uuid not null,
  product_id uuid not null,
  price_cents bigint not null check (price_cents > 0),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (price_list_id, organization_id) references public.poultry_price_lists(id, organization_id) on delete restrict,
  foreign key (product_id, organization_id) references public.poultry_products(id, organization_id) on delete restrict,
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (price_list_id with =, product_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create index poultry_price_list_prices_lookup_idx on public.poultry_price_list_prices (price_list_id, product_id, valid_from desc);
create index poultry_price_list_prices_product_idx on public.poultry_price_list_prices (product_id);
create index poultry_price_list_prices_org_idx on public.poultry_price_list_prices (organization_id);

-- ---------------------------------------------------------------------------------------------
-- Clientes y precio específico por cliente
-- ---------------------------------------------------------------------------------------------

create table public.poultry_customers (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  phone text check (phone is null or char_length(phone) between 1 and 60),
  address text check (address is null or char_length(address) between 1 and 240),
  tax_id text check (tax_id is null or char_length(tax_id) between 1 and 40),
  -- null = usa la lista GENERAL.
  price_list_id uuid,
  notes text check (notes is null or char_length(notes) between 1 and 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (price_list_id, organization_id) references public.poultry_price_lists(id, organization_id) on delete restrict
);
create unique index poultry_customers_org_name_uq on public.poultry_customers (organization_id, (app_private.import_normalize_text(name)));
create index poultry_customers_org_active_idx on public.poultry_customers (organization_id, active);
create index poultry_customers_list_idx on public.poultry_customers (price_list_id) where price_list_id is not null;

create table public.poultry_customer_prices (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null,
  product_id uuid not null,
  price_cents bigint not null check (price_cents > 0),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (customer_id, organization_id) references public.poultry_customers(id, organization_id) on delete restrict,
  foreign key (product_id, organization_id) references public.poultry_products(id, organization_id) on delete restrict,
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (customer_id with =, product_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create index poultry_customer_prices_lookup_idx on public.poultry_customer_prices (customer_id, product_id, valid_from desc);
create index poultry_customer_prices_product_idx on public.poultry_customer_prices (product_id);
create index poultry_customer_prices_org_idx on public.poultry_customer_prices (organization_id);

-- ---------------------------------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------------------------------

create table public.poultry_order_counters (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  last_number bigint not null default 0
);

create table public.poultry_orders (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  order_number bigint not null,
  request_key uuid,
  customer_id uuid not null,
  status public.poultry_order_status not null default 'PENDING',
  ordered_on date not null,
  delivery_on date,
  payment_method public.payment_method,
  notes text check (notes is null or char_length(notes) between 1 and 1000),
  -- Facturación del pedido: suma de las líneas valorizadas (precio SNAPSHOT de cada línea).
  revenue_cents bigint not null default 0 check (revenue_cents >= 0),
  -- Costo histórico: null hasta que el pedido se entrega (se captura el costo vigente en ese momento y ya no cambia).
  cost_cents bigint check (cost_cents is null or cost_cents >= 0),
  delivered_at timestamptz,
  delivered_on date,
  cancelled_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (id, organization_id, branch_id),
  unique (organization_id, order_number),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  foreign key (customer_id, organization_id) references public.poultry_customers(id, organization_id) on delete restrict,
  check ((status = 'DELIVERED') = (delivered_at is not null)),
  check ((status = 'DELIVERED') = (delivered_on is not null)),
  check ((status = 'DELIVERED') = (cost_cents is not null)),
  check ((status = 'CANCELLED') = (cancelled_at is not null)),
  check (delivery_on is null or delivery_on >= ordered_on)
);
create unique index poultry_orders_request_key_uq on public.poultry_orders (organization_id, request_key) where request_key is not null;
create index poultry_orders_status_delivery_idx on public.poultry_orders (organization_id, status, delivery_on);
create index poultry_orders_delivered_idx on public.poultry_orders (organization_id, delivered_on) where status = 'DELIVERED';
create index poultry_orders_customer_idx on public.poultry_orders (organization_id, customer_id, ordered_on desc);
create index poultry_orders_recent_idx on public.poultry_orders (organization_id, ordered_on desc, order_number desc);
create index poultry_orders_branch_idx on public.poultry_orders (branch_id);

create table public.poultry_order_items (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  order_id uuid not null,
  position integer not null check (position > 0),
  product_id uuid not null,
  -- Snapshots: el nombre y la unidad de venta con que se vendió.
  product_name_snapshot text not null,
  sale_unit public.unit_type not null,
  boxes integer not null check (boxes > 0),
  actual_weight_grams integer check (actual_weight_grams is null or actual_weight_grams > 0),
  -- Precio SNAPSHOT (por cajón o por kg según sale_unit) con el que se tomó el pedido.
  unit_price_cents bigint not null check (unit_price_cents > 0),
  price_source text not null check (price_source in ('CUSTOMER', 'LIST', 'DEFAULT', 'MANUAL')),
  price_list_id uuid,
  -- null mientras una línea por kg no tiene peso real.
  line_revenue_cents bigint check (line_revenue_cents is null or line_revenue_cents >= 0),
  -- Costo SNAPSHOT: se captura al entregar.
  cost_cents_snapshot bigint check (cost_cents_snapshot is null or cost_cents_snapshot >= 0),
  line_cost_cents bigint check (line_cost_cents is null or line_cost_cents >= 0),
  notes text check (notes is null or char_length(notes) between 1 and 300),
  foreign key (order_id, organization_id, branch_id) references public.poultry_orders(id, organization_id, branch_id) on delete cascade,
  foreign key (product_id, organization_id) references public.poultry_products(id, organization_id) on delete restrict,
  unique (order_id, position),
  check (sale_unit = 'UNIT' or (actual_weight_grams is null) = (line_revenue_cents is null)),
  check ((cost_cents_snapshot is null) = (line_cost_cents is null))
);
create index poultry_order_items_order_idx on public.poultry_order_items (order_id);
create index poultry_order_items_product_idx on public.poultry_order_items (organization_id, product_id);

comment on table public.poultry_order_items is
  'Líneas de pedido de pollos. unit_price_cents y cost_cents_snapshot son snapshots: la rentabilidad histórica no se recalcula con precios o costos posteriores.';

-- ---------------------------------------------------------------------------------------------
-- Triggers: updated_at, auditoría, historia inmutable, lista GENERAL por organización
-- ---------------------------------------------------------------------------------------------

create trigger poultry_products_set_updated_at before update on public.poultry_products for each row execute function app_private.set_updated_at();
create trigger poultry_price_lists_set_updated_at before update on public.poultry_price_lists for each row execute function app_private.set_updated_at();
create trigger poultry_customers_set_updated_at before update on public.poultry_customers for each row execute function app_private.set_updated_at();
create trigger poultry_orders_set_updated_at before update on public.poultry_orders for each row execute function app_private.set_updated_at();

create trigger poultry_products_audit after insert or update on public.poultry_products for each row execute function app_private.audit_row_change();
create trigger poultry_product_costs_audit after insert or update on public.poultry_product_costs for each row execute function app_private.audit_row_change();
create trigger poultry_price_lists_audit after insert or update on public.poultry_price_lists for each row execute function app_private.audit_row_change();
create trigger poultry_price_list_prices_audit after insert or update on public.poultry_price_list_prices for each row execute function app_private.audit_row_change();
create trigger poultry_customers_audit after insert or update on public.poultry_customers for each row execute function app_private.audit_row_change();
create trigger poultry_customer_prices_audit after insert or update on public.poultry_customer_prices for each row execute function app_private.audit_row_change();
create trigger poultry_orders_audit after insert or update on public.poultry_orders for each row execute function app_private.audit_row_change();

-- Costos y precios son append-only: sólo se puede cerrar la vigencia (valid_to).
create function app_private.poultry_prevent_history_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.product_id is distinct from old.product_id
     or new.valid_from is distinct from old.valid_from
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or (to_jsonb(new) - 'valid_to') is distinct from (to_jsonb(old) - 'valid_to') then
    raise exception 'La historia de costos y precios es inmutable: cerrá la vigencia y cargá un valor nuevo' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger poultry_product_costs_prevent_rewrite before update on public.poultry_product_costs
for each row execute function app_private.poultry_prevent_history_rewrite();
create trigger poultry_price_list_prices_prevent_rewrite before update on public.poultry_price_list_prices
for each row execute function app_private.poultry_prevent_history_rewrite();
create trigger poultry_customer_prices_prevent_rewrite before update on public.poultry_customer_prices
for each row execute function app_private.poultry_prevent_history_rewrite();

-- Cada organización tiene su lista GENERAL desde el alta (y las existentes se completan abajo).
create function app_private.poultry_create_default_price_list()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.poultry_price_lists (organization_id, name, is_default) values (new.id, 'General', true)
  on conflict do nothing;
  return new;
end;
$$;

create trigger organizations_poultry_default_price_list after insert on public.organizations
for each row execute function app_private.poultry_create_default_price_list();

insert into public.poultry_price_lists (organization_id, name, is_default)
select o.id, 'General', true from public.organizations o
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------
-- RLS (lectura). Sin INSERT/UPDATE/DELETE para `authenticated`: se escribe sólo vía RPC.
-- ---------------------------------------------------------------------------------------------

alter table public.poultry_products enable row level security;
alter table public.poultry_product_costs enable row level security;
alter table public.poultry_price_lists enable row level security;
alter table public.poultry_price_list_prices enable row level security;
alter table public.poultry_customers enable row level security;
alter table public.poultry_customer_prices enable row level security;
alter table public.poultry_order_counters enable row level security;
alter table public.poultry_orders enable row level security;
alter table public.poultry_order_items enable row level security;

create policy poultry_products_select on public.poultry_products for select to authenticated
using (app_private.has_permission(organization_id, 'poultry.read'));
create policy poultry_product_costs_select on public.poultry_product_costs for select to authenticated
using (app_private.has_permission(organization_id, 'poultry.read'));
create policy poultry_price_lists_select on public.poultry_price_lists for select to authenticated
using (app_private.has_permission(organization_id, 'poultry.read'));
create policy poultry_price_list_prices_select on public.poultry_price_list_prices for select to authenticated
using (app_private.has_permission(organization_id, 'poultry.read'));
create policy poultry_customers_select on public.poultry_customers for select to authenticated
using (app_private.has_permission(organization_id, 'poultry.read'));
create policy poultry_customer_prices_select on public.poultry_customer_prices for select to authenticated
using (app_private.has_permission(organization_id, 'poultry.read'));
create policy poultry_orders_select on public.poultry_orders for select to authenticated
using (
  app_private.has_permission(organization_id, 'poultry.read')
  and (app_private.has_permission(organization_id, 'branches.read_all') or app_private.is_branch_member(branch_id))
);
create policy poultry_order_items_select on public.poultry_order_items for select to authenticated
using (
  app_private.has_permission(organization_id, 'poultry.read')
  and (app_private.has_permission(organization_id, 'branches.read_all') or app_private.is_branch_member(branch_id))
);
-- poultry_order_counters: sin política = ilegible para `authenticated`; sólo las RPC (security definer) la usan.

revoke all on table
  public.poultry_products, public.poultry_product_costs, public.poultry_price_lists, public.poultry_price_list_prices,
  public.poultry_customers, public.poultry_customer_prices, public.poultry_order_counters, public.poultry_orders, public.poultry_order_items
from public, anon, authenticated;
grant select on table
  public.poultry_products, public.poultry_product_costs, public.poultry_price_lists, public.poultry_price_list_prices,
  public.poultry_customers, public.poultry_customer_prices, public.poultry_orders, public.poultry_order_items
to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Helpers privados
-- ---------------------------------------------------------------------------------------------

-- Helpers neutros (los comparten Pollos y Envasados). Sucursales visibles del usuario: null = todas (read_all); si no, sólo aquellas de las que es miembro activo.
create function app_private.visible_branch_ids(p_organization_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when app_private.has_permission(p_organization_id, 'branches.read_all') then null
    else coalesce((
      select array_agg(bm.branch_id)
      from public.branch_members bm
      join public.organization_members om
        on om.organization_id = bm.organization_id and om.profile_id = bm.profile_id and om.status = 'ACTIVE'
      where bm.organization_id = p_organization_id and bm.profile_id = auth.uid() and bm.active
    ), '{}'::uuid[])
  end;
$$;

create function app_private.require_visible_branch(p_organization_id uuid, p_branch_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_visible uuid[];
begin
  if p_branch_id is null or not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = p_organization_id
  ) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;
  v_visible := app_private.visible_branch_ids(p_organization_id);
  if v_visible is not null and not (p_branch_id = any(v_visible)) then
    raise exception 'No tenés acceso a esta sucursal' using errcode = '42501';
  end if;
end;
$$;

-- Importe de una línea: por cajón = precio × cajones; por kg = precio × gramos / 1000 (half-up, igual que priceForWeight del POS).
-- null si es por kg y todavía no hay peso real.
create function app_private.poultry_line_amount(p_sale_unit public.unit_type, p_unit_cents bigint, p_boxes integer, p_grams integer)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_unit_cents is null then null
    when p_sale_unit = 'UNIT' then p_unit_cents * p_boxes
    when p_grams is null then null
    else (p_unit_cents * p_grams::bigint + 500) / 1000
  end;
$$;

create function app_private.poultry_cost_at(p_organization_id uuid, p_product_id uuid, p_at timestamptz)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select c.cost_cents
  from public.poultry_product_costs c
  where c.organization_id = p_organization_id and c.product_id = p_product_id
    and c.valid_from <= p_at and (c.valid_to is null or c.valid_to > p_at)
  order by c.valid_from desc
  limit 1;
$$;

-- Precio aplicable a un cliente: 1) precio específico del cliente, 2) precio de SU lista, 3) lista GENERAL.
create function app_private.poultry_resolve_price(p_organization_id uuid, p_customer_id uuid, p_product_id uuid, p_at timestamptz)
returns table (price_cents bigint, source text, price_list_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_price bigint;
  v_list uuid;
  v_default uuid;
begin
  if p_customer_id is not null then
    select cp.price_cents into v_price
    from public.poultry_customer_prices cp
    where cp.organization_id = p_organization_id and cp.customer_id = p_customer_id and cp.product_id = p_product_id
      and cp.valid_from <= p_at and (cp.valid_to is null or cp.valid_to > p_at)
    order by cp.valid_from desc limit 1;
    if v_price is not null then
      price_cents := v_price; source := 'CUSTOMER'; price_list_id := null;
      return next;
      return;
    end if;
    select c.price_list_id into v_list from public.poultry_customers c where c.id = p_customer_id and c.organization_id = p_organization_id;
    if v_list is not null then
      select lp.price_cents into v_price
      from public.poultry_price_list_prices lp
      where lp.organization_id = p_organization_id and lp.price_list_id = v_list and lp.product_id = p_product_id
        and lp.valid_from <= p_at and (lp.valid_to is null or lp.valid_to > p_at)
      order by lp.valid_from desc limit 1;
      if v_price is not null then
        price_cents := v_price; source := 'LIST'; price_list_id := v_list;
        return next;
        return;
      end if;
    end if;
  end if;

  select l.id into v_default from public.poultry_price_lists l where l.organization_id = p_organization_id and l.is_default;
  if v_default is not null then
    select lp.price_cents into v_price
    from public.poultry_price_list_prices lp
    where lp.organization_id = p_organization_id and lp.price_list_id = v_default and lp.product_id = p_product_id
      and lp.valid_from <= p_at and (lp.valid_to is null or lp.valid_to > p_at)
    order by lp.valid_from desc limit 1;
    if v_price is not null then
      price_cents := v_price; source := 'DEFAULT'; price_list_id := v_default;
      return next;
    end if;
  end if;
end;
$$;

create function app_private.poultry_like_pattern(p_search text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when app_private.import_normalize_text(p_search) is null then null
    else '%' || replace(replace(replace(app_private.import_normalize_text(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  end;
$$;

create function app_private.poultry_margin_bps(p_revenue_cents numeric, p_cost_cents numeric)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(p_revenue_cents, 0) > 0 then round((p_revenue_cents - p_cost_cents)::numeric * 10000 / p_revenue_cents)::integer end;
$$;

revoke all on function
  app_private.visible_branch_ids(uuid), app_private.require_visible_branch(uuid, uuid),
  app_private.poultry_line_amount(public.unit_type, bigint, integer, integer), app_private.poultry_cost_at(uuid, uuid, timestamptz),
  app_private.poultry_resolve_price(uuid, uuid, uuid, timestamptz), app_private.poultry_like_pattern(text),
  app_private.poultry_margin_bps(numeric, numeric), app_private.poultry_create_default_price_list(), app_private.poultry_prevent_history_rewrite()
from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- RPC: catálogo, costos, listas y precios
-- ---------------------------------------------------------------------------------------------

create function public.save_poultry_product(
  p_name text,
  p_sale_unit public.unit_type,
  p_requires_weight boolean default false,
  p_reference_weight_grams integer default null,
  p_active boolean default true,
  p_product_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_name text := btrim(coalesce(p_name, ''));
  v_existing public.poultry_products%rowtype;
  v_id uuid;
begin
  if char_length(v_name) not between 1 and 120 then raise exception 'El nombre es obligatorio (hasta 120 caracteres)' using errcode = '22023'; end if;
  if p_sale_unit is null then raise exception 'Elegí la unidad de venta' using errcode = '22023'; end if;
  if p_reference_weight_grams is not null and p_reference_weight_grams <= 0 then raise exception 'El peso de referencia tiene que ser positivo' using errcode = '22023'; end if;

  if p_product_id is null then
    insert into public.poultry_products (organization_id, name, sale_unit, requires_weight, reference_weight_grams, active)
    values (v_org, v_name, p_sale_unit, p_sale_unit = 'WEIGHT' or coalesce(p_requires_weight, false), p_reference_weight_grams, coalesce(p_active, true))
    returning id into v_id;
    return v_id;
  end if;

  select * into v_existing from public.poultry_products where id = p_product_id and organization_id = v_org for update;
  if not found then raise exception 'Producto de pollos no encontrado' using errcode = '42501'; end if;
  -- La unidad de venta no cambia una vez que hay costos, precios o pedidos: reinterpretaría la historia.
  if v_existing.sale_unit <> p_sale_unit and (
    exists (select 1 from public.poultry_product_costs c where c.product_id = p_product_id)
    or exists (select 1 from public.poultry_price_list_prices x where x.product_id = p_product_id)
    or exists (select 1 from public.poultry_customer_prices x where x.product_id = p_product_id)
    or exists (select 1 from public.poultry_order_items x where x.product_id = p_product_id)
  ) then
    raise exception 'No se puede cambiar la unidad de venta de un producto con costos, precios o pedidos' using errcode = '22023';
  end if;
  update public.poultry_products set
    name = v_name, sale_unit = p_sale_unit, requires_weight = p_sale_unit = 'WEIGHT' or coalesce(p_requires_weight, false),
    reference_weight_grams = p_reference_weight_grams, active = coalesce(p_active, true)
  where id = p_product_id;
  return p_product_id;
end;
$$;

-- Cambio de costo con vigencia: cierra el costo vigente en `p_effective_at` y abre el nuevo. Nunca reescribe historia.
create function public.set_poultry_product_cost(p_product_id uuid, p_cost_cents bigint, p_effective_at timestamptz default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_at timestamptz := coalesce(p_effective_at, clock_timestamp());
  v_current public.poultry_product_costs%rowtype;
  v_id uuid;
begin
  if p_cost_cents is null or p_cost_cents <= 0 then raise exception 'El costo tiene que ser mayor a cero' using errcode = '22023'; end if;
  if v_at < clock_timestamp() - interval '5 minutes' then raise exception 'Un costo nuevo no puede empezar en el pasado' using errcode = '22023'; end if;
  perform 1 from public.poultry_products p where p.id = p_product_id and p.organization_id = v_org for update;
  if not found then raise exception 'Producto de pollos no encontrado' using errcode = '42501'; end if;

  select * into v_current from public.poultry_product_costs c
  where c.organization_id = v_org and c.product_id = p_product_id and c.valid_from <= v_at and (c.valid_to is null or c.valid_to > v_at)
  order by c.valid_from desc limit 1;
  if found and v_current.cost_cents = p_cost_cents and v_current.valid_to is null then return v_current.id; end if;
  if exists (select 1 from public.poultry_product_costs c where c.product_id = p_product_id and c.valid_from > v_at) then
    raise exception 'Ya hay un costo programado con fecha posterior' using errcode = '22023';
  end if;
  if found then
    if v_current.valid_from >= v_at then raise exception 'Ya existe un costo que empieza en ese instante' using errcode = '22023'; end if;
    update public.poultry_product_costs set valid_to = v_at where id = v_current.id;
  end if;
  insert into public.poultry_product_costs (organization_id, product_id, cost_cents, valid_from, created_by)
  values (v_org, p_product_id, p_cost_cents, v_at, auth.uid()) returning id into v_id;
  return v_id;
end;
$$;

create function public.save_poultry_price_list(
  p_name text,
  p_notes text default null,
  p_active boolean default true,
  p_price_list_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_name text := btrim(coalesce(p_name, ''));
  v_existing public.poultry_price_lists%rowtype;
  v_id uuid;
begin
  if char_length(v_name) not between 1 and 80 then raise exception 'El nombre de la lista es obligatorio (hasta 80 caracteres)' using errcode = '22023'; end if;
  if p_price_list_id is null then
    insert into public.poultry_price_lists (organization_id, name, notes, active)
    values (v_org, v_name, nullif(btrim(coalesce(p_notes, '')), ''), coalesce(p_active, true)) returning id into v_id;
    return v_id;
  end if;
  select * into v_existing from public.poultry_price_lists where id = p_price_list_id and organization_id = v_org for update;
  if not found then raise exception 'Lista de precios no encontrada' using errcode = '42501'; end if;
  if v_existing.is_default and not coalesce(p_active, true) then raise exception 'La lista General no se puede desactivar' using errcode = '22023'; end if;
  if not coalesce(p_active, true) and exists (
    select 1 from public.poultry_customers c where c.price_list_id = p_price_list_id and c.active
  ) then
    raise exception 'Hay clientes activos con esta lista: asignales otra antes de desactivarla' using errcode = '22023';
  end if;
  update public.poultry_price_lists set name = v_name, notes = nullif(btrim(coalesce(p_notes, '')), ''), active = coalesce(p_active, true)
  where id = p_price_list_id;
  return p_price_list_id;
end;
$$;

create function public.set_poultry_list_price(p_price_list_id uuid, p_product_id uuid, p_price_cents bigint, p_effective_at timestamptz default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_at timestamptz := coalesce(p_effective_at, clock_timestamp());
  v_current public.poultry_price_list_prices%rowtype;
  v_id uuid;
begin
  if p_price_cents is null or p_price_cents <= 0 then raise exception 'El precio tiene que ser mayor a cero' using errcode = '22023'; end if;
  if v_at < clock_timestamp() - interval '5 minutes' then raise exception 'Un precio nuevo no puede empezar en el pasado' using errcode = '22023'; end if;
  perform 1 from public.poultry_price_lists l where l.id = p_price_list_id and l.organization_id = v_org and l.active for update;
  if not found then raise exception 'Lista de precios no encontrada o inactiva' using errcode = '42501'; end if;
  perform 1 from public.poultry_products p where p.id = p_product_id and p.organization_id = v_org;
  if not found then raise exception 'Producto de pollos no encontrado' using errcode = '42501'; end if;

  select * into v_current from public.poultry_price_list_prices x
  where x.organization_id = v_org and x.price_list_id = p_price_list_id and x.product_id = p_product_id
    and x.valid_from <= v_at and (x.valid_to is null or x.valid_to > v_at)
  order by x.valid_from desc limit 1;
  if found and v_current.price_cents = p_price_cents and v_current.valid_to is null then return v_current.id; end if;
  if exists (select 1 from public.poultry_price_list_prices x where x.price_list_id = p_price_list_id and x.product_id = p_product_id and x.valid_from > v_at) then
    raise exception 'Ya hay un precio programado con fecha posterior' using errcode = '22023';
  end if;
  if found then
    if v_current.valid_from >= v_at then raise exception 'Ya existe un precio que empieza en ese instante' using errcode = '22023'; end if;
    update public.poultry_price_list_prices set valid_to = v_at where id = v_current.id;
  end if;
  insert into public.poultry_price_list_prices (organization_id, price_list_id, product_id, price_cents, valid_from, created_by)
  values (v_org, p_price_list_id, p_product_id, p_price_cents, v_at, auth.uid()) returning id into v_id;
  return v_id;
end;
$$;

-- Precio específico de un cliente. `p_price_cents` null = quitar el precio especial (el cliente vuelve a su lista).
create function public.set_poultry_customer_price(p_customer_id uuid, p_product_id uuid, p_price_cents bigint default null, p_effective_at timestamptz default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_at timestamptz := coalesce(p_effective_at, clock_timestamp());
  v_current public.poultry_customer_prices%rowtype;
  v_id uuid;
begin
  if p_price_cents is not null and p_price_cents <= 0 then raise exception 'El precio tiene que ser mayor a cero' using errcode = '22023'; end if;
  if v_at < clock_timestamp() - interval '5 minutes' then raise exception 'Un precio nuevo no puede empezar en el pasado' using errcode = '22023'; end if;
  perform 1 from public.poultry_customers c where c.id = p_customer_id and c.organization_id = v_org for update;
  if not found then raise exception 'Cliente no encontrado' using errcode = '42501'; end if;
  perform 1 from public.poultry_products p where p.id = p_product_id and p.organization_id = v_org;
  if not found then raise exception 'Producto de pollos no encontrado' using errcode = '42501'; end if;

  select * into v_current from public.poultry_customer_prices x
  where x.organization_id = v_org and x.customer_id = p_customer_id and x.product_id = p_product_id
    and x.valid_from <= v_at and (x.valid_to is null or x.valid_to > v_at)
  order by x.valid_from desc limit 1;
  if p_price_cents is null then
    if found and v_current.valid_from < v_at then update public.poultry_customer_prices set valid_to = v_at where id = v_current.id; end if;
    return null;
  end if;
  if found and v_current.price_cents = p_price_cents and v_current.valid_to is null then return v_current.id; end if;
  if exists (select 1 from public.poultry_customer_prices x where x.customer_id = p_customer_id and x.product_id = p_product_id and x.valid_from > v_at) then
    raise exception 'Ya hay un precio programado con fecha posterior' using errcode = '22023';
  end if;
  if found then
    if v_current.valid_from >= v_at then raise exception 'Ya existe un precio que empieza en ese instante' using errcode = '22023'; end if;
    update public.poultry_customer_prices set valid_to = v_at where id = v_current.id;
  end if;
  insert into public.poultry_customer_prices (organization_id, customer_id, product_id, price_cents, valid_from, created_by)
  values (v_org, p_customer_id, p_product_id, p_price_cents, v_at, auth.uid()) returning id into v_id;
  return v_id;
end;
$$;

-- Tablero de Precios: listas + productos con costo vigente y precio vigente de cada lista, en UNA consulta.
create function public.get_poultry_price_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_at timestamptz := clock_timestamp();
begin
  return jsonb_build_object(
    'lists', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'notes', l.notes, 'isDefault', l.is_default, 'active', l.active,
        'customerCount', (select count(*) from public.poultry_customers c where c.price_list_id = l.id and c.active))
        order by l.is_default desc, lower(l.name), l.id)
      from public.poultry_price_lists l where l.organization_id = v_org
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'saleUnit', p.sale_unit, 'requiresWeight', p.requires_weight,
        'referenceWeightGrams', p.reference_weight_grams, 'active', p.active,
        'costCents', cost.cost_cents::text, 'costSince', cost.valid_from,
        'prices', coalesce((
          select jsonb_object_agg(lp.price_list_id::text, jsonb_build_object('cents', lp.price_cents::text, 'since', lp.valid_from))
          from public.poultry_price_list_prices lp
          where lp.organization_id = v_org and lp.product_id = p.id and lp.valid_from <= v_at and (lp.valid_to is null or lp.valid_to > v_at)
        ), '{}'::jsonb)
      ) order by p.active desc, lower(p.name), p.id)
      from public.poultry_products p
      left join lateral (
        select c.cost_cents, c.valid_from from public.poultry_product_costs c
        where c.product_id = p.id and c.valid_from <= v_at and (c.valid_to is null or c.valid_to > v_at)
        order by c.valid_from desc limit 1
      ) cost on true
      where p.organization_id = v_org
    ), '[]'::jsonb)
  );
end;
$$;

-- Historia de costos y de precios (por lista y por cliente) de un producto. Acotada a las últimas 60 vigencias de cada tipo.
create function public.get_poultry_price_history(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
begin
  if not exists (select 1 from public.poultry_products p where p.id = p_product_id and p.organization_id = v_org) then
    raise exception 'Producto de pollos no encontrado' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'costs', coalesce((select jsonb_agg(jsonb_build_object('cents', x.cost_cents::text, 'from', x.valid_from, 'to', x.valid_to) order by x.valid_from desc)
      from (select * from public.poultry_product_costs c where c.product_id = p_product_id and c.organization_id = v_org order by c.valid_from desc limit 60) x), '[]'::jsonb),
    'listPrices', coalesce((select jsonb_agg(jsonb_build_object('listId', x.price_list_id, 'listName', l.name, 'cents', x.price_cents::text, 'from', x.valid_from, 'to', x.valid_to)
        order by x.valid_from desc)
      from (select * from public.poultry_price_list_prices lp where lp.product_id = p_product_id and lp.organization_id = v_org order by lp.valid_from desc limit 60) x
      join public.poultry_price_lists l on l.id = x.price_list_id and l.organization_id = x.organization_id), '[]'::jsonb),
    'customerPrices', coalesce((select jsonb_agg(jsonb_build_object('customerId', x.customer_id, 'customerName', c.name, 'cents', x.price_cents::text, 'from', x.valid_from, 'to', x.valid_to)
        order by x.valid_from desc)
      from (select * from public.poultry_customer_prices cp where cp.product_id = p_product_id and cp.organization_id = v_org order by cp.valid_from desc limit 60) x
      join public.poultry_customers c on c.id = x.customer_id and c.organization_id = x.organization_id), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: clientes
-- ---------------------------------------------------------------------------------------------

create function public.save_poultry_customer(
  p_name text,
  p_phone text default null,
  p_address text default null,
  p_tax_id text default null,
  p_price_list_id uuid default null,
  p_notes text default null,
  p_active boolean default true,
  p_customer_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if char_length(v_name) not between 1 and 160 then raise exception 'El nombre del cliente es obligatorio (hasta 160 caracteres)' using errcode = '22023'; end if;
  if p_price_list_id is not null and not exists (
    select 1 from public.poultry_price_lists l where l.id = p_price_list_id and l.organization_id = v_org and l.active
  ) then
    raise exception 'Lista de precios no encontrada o inactiva' using errcode = '42501';
  end if;
  if p_customer_id is null then
    insert into public.poultry_customers (organization_id, name, phone, address, tax_id, price_list_id, notes, active)
    values (v_org, v_name, nullif(btrim(coalesce(p_phone, '')), ''), nullif(btrim(coalesce(p_address, '')), ''), nullif(btrim(coalesce(p_tax_id, '')), ''),
      p_price_list_id, nullif(btrim(coalesce(p_notes, '')), ''), coalesce(p_active, true))
    returning id into v_id;
    return v_id;
  end if;
  perform 1 from public.poultry_customers c where c.id = p_customer_id and c.organization_id = v_org for update;
  if not found then raise exception 'Cliente no encontrado' using errcode = '42501'; end if;
  update public.poultry_customers set
    name = v_name, phone = nullif(btrim(coalesce(p_phone, '')), ''), address = nullif(btrim(coalesce(p_address, '')), ''),
    tax_id = nullif(btrim(coalesce(p_tax_id, '')), ''), price_list_id = p_price_list_id, notes = nullif(btrim(coalesce(p_notes, '')), ''),
    active = coalesce(p_active, true)
  where id = p_customer_id;
  return p_customer_id;
end;
$$;

create function public.list_poultry_customers_page(
  p_search text default null,
  p_status text default 'all',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_pattern text := app_private.poultry_like_pattern(p_search);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  if p_status not in ('all', 'active', 'inactive') then raise exception 'Estado inválido' using errcode = '22023'; end if;
  select count(*) into v_total
  from public.poultry_customers c
  where c.organization_id = v_org
    and (p_status = 'all' or (p_status = 'active') = c.active)
    and (v_pattern is null or app_private.import_normalize_text(c.name) like v_pattern escape '\'
         or lower(coalesce(c.phone, '')) like v_pattern escape '\' or lower(coalesce(c.tax_id, '')) like v_pattern escape '\');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'name', r.name, 'phone', r.phone, 'address', r.address, 'taxId', r.tax_id, 'notes', r.notes, 'active', r.active,
    'priceListId', r.price_list_id, 'priceListName', r.price_list_name,
    'ordersCount', coalesce(s.orders_count, 0), 'boxes', coalesce(s.boxes, 0), 'revenueCents', coalesce(s.revenue_cents, 0)::text,
    'profitCents', coalesce(s.profit_cents, 0)::text, 'lastOrderOn', s.last_order_on
  ) order by r.active desc, lower(r.name), r.id), '[]'::jsonb) into v_rows
  from (
    select c.id, c.name, c.phone, c.address, c.tax_id, c.notes, c.active, c.price_list_id, l.name as price_list_name
    from public.poultry_customers c
    left join public.poultry_price_lists l on l.id = c.price_list_id and l.organization_id = c.organization_id
    where c.organization_id = v_org
      and (p_status = 'all' or (p_status = 'active') = c.active)
      and (v_pattern is null or app_private.import_normalize_text(c.name) like v_pattern escape '\'
           or lower(coalesce(c.phone, '')) like lower(v_pattern) escape '\' or lower(coalesce(c.tax_id, '')) like lower(v_pattern) escape '\')
    order by c.active desc, lower(c.name), c.id
    limit v_limit offset v_offset
  ) r
  left join lateral (
    select count(*) as orders_count,
      coalesce(sum(o.revenue_cents), 0) as revenue_cents, coalesce(sum(o.revenue_cents - o.cost_cents), 0) as profit_cents,
      coalesce(sum((select sum(i.boxes) from public.poultry_order_items i where i.order_id = o.id)), 0) as boxes,
      max(o.delivered_on) as last_order_on
    from public.poultry_orders o
    where o.organization_id = v_org and o.customer_id = r.id and o.status = 'DELIVERED' and (v_vis is null or o.branch_id = any(v_vis))
  ) s on true;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

-- Ficha del cliente: datos, totales de pedidos entregados, últimos pedidos y precios (especial vs efectivo) de cada producto.
create function public.get_poultry_customer_detail(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_at timestamptz := clock_timestamp();
  c public.poultry_customers%rowtype;
  v_list_name text;
  v_totals jsonb;
  v_recent jsonb;
  v_prices jsonb;
begin
  select * into c from public.poultry_customers x where x.id = p_customer_id and x.organization_id = v_org;
  if not found then return null; end if;
  select l.name into v_list_name from public.poultry_price_lists l where l.id = c.price_list_id and l.organization_id = v_org;

  select jsonb_build_object(
    'orders', count(*), 'boxes', coalesce(sum(b.boxes), 0), 'weightGrams', coalesce(sum(b.grams), 0),
    'revenueCents', coalesce(sum(o.revenue_cents), 0)::text, 'costCents', coalesce(sum(o.cost_cents), 0)::text,
    'profitCents', coalesce(sum(o.revenue_cents - o.cost_cents), 0)::text,
    'marginBps', app_private.poultry_margin_bps(coalesce(sum(o.revenue_cents), 0), coalesce(sum(o.cost_cents), 0))
  ) into v_totals
  from public.poultry_orders o
  left join lateral (
    select sum(i.boxes) as boxes, sum(i.actual_weight_grams) as grams from public.poultry_order_items i where i.order_id = o.id
  ) b on true
  where o.organization_id = v_org and o.customer_id = c.id and o.status = 'DELIVERED' and (v_vis is null or o.branch_id = any(v_vis));

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'orderNumber', x.order_number, 'status', x.status, 'orderedOn', x.ordered_on, 'deliveryOn', x.delivery_on,
    'revenueCents', x.revenue_cents::text, 'costCents', x.cost_cents::text, 'boxes', x.boxes
  ) order by x.ordered_on desc, x.order_number desc), '[]'::jsonb) into v_recent
  from (
    select o.id, o.order_number, o.status, o.ordered_on, o.delivery_on, o.revenue_cents, o.cost_cents,
      (select coalesce(sum(i.boxes), 0) from public.poultry_order_items i where i.order_id = o.id) as boxes
    from public.poultry_orders o
    where o.organization_id = v_org and o.customer_id = c.id and (v_vis is null or o.branch_id = any(v_vis))
    order by o.ordered_on desc, o.order_number desc limit 10
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', p.id, 'productName', p.name, 'saleUnit', p.sale_unit, 'active', p.active,
    'specialCents', special.price_cents::text, 'effectiveCents', resolved.price_cents::text, 'source', resolved.source
  ) order by p.active desc, lower(p.name), p.id), '[]'::jsonb) into v_prices
  from public.poultry_products p
  left join lateral (
    select cp.price_cents from public.poultry_customer_prices cp
    where cp.customer_id = c.id and cp.product_id = p.id and cp.valid_from <= v_at and (cp.valid_to is null or cp.valid_to > v_at)
    order by cp.valid_from desc limit 1
  ) special on true
  left join lateral app_private.poultry_resolve_price(v_org, c.id, p.id, v_at) resolved on true
  where p.organization_id = v_org;

  return jsonb_build_object(
    'customer', jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'address', c.address, 'taxId', c.tax_id, 'notes', c.notes,
      'active', c.active, 'priceListId', c.price_list_id, 'priceListName', v_list_name),
    'totals', v_totals, 'recentOrders', v_recent, 'prices', v_prices
  );
end;
$$;

-- Precios que se le aplicarían a un cliente HOY (para precargar el formulario de pedido). `p_product_ids` null = todos los activos.
create function public.resolve_poultry_prices(p_customer_id uuid default null, p_product_ids uuid[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_at timestamptz := clock_timestamp();
begin
  if p_customer_id is not null and not exists (select 1 from public.poultry_customers c where c.id = p_customer_id and c.organization_id = v_org) then
    raise exception 'Cliente no encontrado' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'productId', p.id, 'name', p.name, 'saleUnit', p.sale_unit, 'requiresWeight', p.requires_weight, 'referenceWeightGrams', p.reference_weight_grams,
      'priceCents', r.price_cents::text, 'source', r.source, 'priceListId', r.price_list_id
    ) order by lower(p.name), p.id)
    from public.poultry_products p
    left join lateral app_private.poultry_resolve_price(v_org, p_customer_id, p.id, v_at) r on true
    where p.organization_id = v_org and (p_product_ids is null and p.active or p.id = any(p_product_ids))
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: pedidos
-- ---------------------------------------------------------------------------------------------

create function public.save_poultry_order(
  p_branch_id uuid,
  p_customer_id uuid,
  p_ordered_on date,
  p_items jsonb,
  p_delivery_on date default null,
  p_payment_method public.payment_method default null,
  p_notes text default null,
  p_order_id uuid default null,
  p_request_key uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_at timestamptz := clock_timestamp();
  v_order public.poultry_orders%rowtype;
  v_order_id uuid;
  v_number bigint;
  v_branch uuid := p_branch_id;
  v_customer_changed boolean := false;
  v_old_items jsonb := '{}'::jsonb;
  v_old public.poultry_order_items%rowtype;
  v_product public.poultry_products%rowtype;
  v_resolved record;
  item jsonb;
  v_pos integer := 0;
  v_boxes integer;
  v_grams integer;
  v_unit_price bigint;
  v_source text;
  v_list uuid;
  v_revenue bigint := 0;
  v_line bigint;
  v_old_id uuid;
begin
  if p_ordered_on is null then raise exception 'Falta la fecha del pedido' using errcode = '22023'; end if;
  if p_delivery_on is not null and p_delivery_on < p_ordered_on then raise exception 'La entrega no puede ser anterior al pedido' using errcode = '22023'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'El pedido necesita entre 1 y 100 líneas' using errcode = '22023';
  end if;
  if not exists (select 1 from public.poultry_customers c where c.id = p_customer_id and c.organization_id = v_org) then
    raise exception 'Cliente no encontrado' using errcode = '42501';
  end if;

  if p_order_id is null then
    perform app_private.require_visible_branch(v_org, p_branch_id);
    if not exists (select 1 from public.branches b where b.id = p_branch_id and b.organization_id = v_org and b.active) then
      raise exception 'La sucursal está inactiva' using errcode = '22023';
    end if;
    if not exists (select 1 from public.poultry_customers c where c.id = p_customer_id and c.organization_id = v_org and c.active) then
      raise exception 'El cliente está inactivo' using errcode = '22023';
    end if;
    if p_request_key is not null then
      select o.* into v_order from public.poultry_orders o where o.organization_id = v_org and o.request_key = p_request_key;
      if found then
        return jsonb_build_object('orderId', v_order.id, 'orderNumber', v_order.order_number, 'revenueCents', v_order.revenue_cents::text, 'existing', true);
      end if;
    end if;
    insert into public.poultry_order_counters (organization_id, last_number) values (v_org, 1)
    on conflict (organization_id) do update set last_number = public.poultry_order_counters.last_number + 1
    returning last_number into v_number;
    insert into public.poultry_orders (organization_id, branch_id, order_number, request_key, customer_id, ordered_on, delivery_on, payment_method, notes, created_by)
    values (v_org, p_branch_id, v_number, p_request_key, p_customer_id, p_ordered_on, p_delivery_on, p_payment_method,
      nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
    returning * into v_order;
  else
    select * into v_order from public.poultry_orders o where o.id = p_order_id and o.organization_id = v_org for update;
    if not found then raise exception 'Pedido no encontrado' using errcode = '42501'; end if;
    perform app_private.require_visible_branch(v_org, v_order.branch_id);
    if v_order.status not in ('PENDING', 'PREPARING', 'READY') then
      raise exception 'Sólo se pueden editar pedidos abiertos' using errcode = '22023';
    end if;
    if p_branch_id is not null and p_branch_id <> v_order.branch_id then
      raise exception 'La sucursal de un pedido no se puede cambiar' using errcode = '22023';
    end if;
    v_customer_changed := v_order.customer_id <> p_customer_id;
    select coalesce(jsonb_object_agg(i.id::text, to_jsonb(i)), '{}'::jsonb) into v_old_items
    from public.poultry_order_items i where i.order_id = v_order.id;
    delete from public.poultry_order_items where order_id = v_order.id;
  end if;
  v_order_id := v_order.id;
  v_branch := v_order.branch_id;

  for item in select value from jsonb_array_elements(p_items) loop
    v_pos := v_pos + 1;
    select * into v_product from public.poultry_products p where p.id = nullif(item ->> 'productId', '')::uuid and p.organization_id = v_org;
    if not found then raise exception 'Producto de pollos no encontrado' using errcode = '42501'; end if;
    v_boxes := nullif(item ->> 'boxes', '')::integer;
    if v_boxes is null or v_boxes <= 0 or v_boxes > 100000 then raise exception 'Cantidad de cajones inválida en %', v_product.name using errcode = '22023'; end if;
    v_grams := nullif(item ->> 'actualWeightGrams', '')::integer;
    if v_grams is not null and v_grams <= 0 then raise exception 'Peso real inválido en %', v_product.name using errcode = '22023'; end if;
    v_unit_price := nullif(item ->> 'unitPriceCents', '')::bigint;
    if v_unit_price is not null and v_unit_price <= 0 then raise exception 'Precio inválido en %', v_product.name using errcode = '22023'; end if;

    v_old := null;
    v_old_id := nullif(item ->> 'itemId', '')::uuid;
    if v_old_id is not null and v_old_items ? v_old_id::text then
      v_old := jsonb_populate_record(null::public.poultry_order_items, v_old_items -> v_old_id::text);
    end if;
    if not v_product.active and not (v_old.id is not null and v_old.product_id = v_product.id) then
      raise exception 'El producto % está inactivo', v_product.name using errcode = '22023';
    end if;

    if v_unit_price is null and v_old.id is not null and v_old.product_id = v_product.id and not v_customer_changed then
      -- Línea existente sin precio nuevo: se conserva el snapshot con el que se tomó el pedido.
      v_unit_price := v_old.unit_price_cents; v_source := v_old.price_source; v_list := v_old.price_list_id;
    else
      select * into v_resolved from app_private.poultry_resolve_price(v_org, p_customer_id, v_product.id, v_at);
      if v_unit_price is null then
        if v_resolved.price_cents is null then
          raise exception 'No hay precio vigente para % (cargalo en Precios o ingresá uno manual)', v_product.name using errcode = '22023';
        end if;
        v_unit_price := v_resolved.price_cents; v_source := v_resolved.source; v_list := v_resolved.price_list_id;
      elsif v_resolved.price_cents is not distinct from v_unit_price then
        v_source := v_resolved.source; v_list := v_resolved.price_list_id;
      else
        v_source := 'MANUAL'; v_list := null;
      end if;
    end if;

    v_line := app_private.poultry_line_amount(v_product.sale_unit, v_unit_price, v_boxes, v_grams);
    v_revenue := v_revenue + coalesce(v_line, 0);
    insert into public.poultry_order_items (
      organization_id, branch_id, order_id, position, product_id, product_name_snapshot, sale_unit, boxes, actual_weight_grams,
      unit_price_cents, price_source, price_list_id, line_revenue_cents, notes
    ) values (
      v_org, v_branch, v_order_id, v_pos, v_product.id, v_product.name, v_product.sale_unit, v_boxes, v_grams,
      v_unit_price, v_source, v_list, v_line, nullif(btrim(coalesce(item ->> 'notes', '')), '')
    );
  end loop;

  update public.poultry_orders set
    customer_id = p_customer_id, ordered_on = p_ordered_on, delivery_on = p_delivery_on, payment_method = p_payment_method,
    notes = nullif(btrim(coalesce(p_notes, '')), ''), revenue_cents = v_revenue
  where id = v_order_id;

  return jsonb_build_object('orderId', v_order_id, 'orderNumber', v_order.order_number, 'revenueCents', v_revenue::text, 'existing', false);
end;
$$;

-- Registra el peso real de las líneas de un pedido abierto y revalúa las líneas por kg con su precio snapshot.
create function public.set_poultry_order_weights(p_order_id uuid, p_weights jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_order public.poultry_orders%rowtype;
  w jsonb;
  v_grams integer;
  v_item public.poultry_order_items%rowtype;
  v_revenue bigint;
begin
  if p_weights is null or jsonb_typeof(p_weights) <> 'array' or jsonb_array_length(p_weights) not between 1 and 100 then
    raise exception 'Se esperaba una lista de pesos' using errcode = '22023';
  end if;
  select * into v_order from public.poultry_orders o where o.id = p_order_id and o.organization_id = v_org for update;
  if not found then raise exception 'Pedido no encontrado' using errcode = '42501'; end if;
  perform app_private.require_visible_branch(v_org, v_order.branch_id);
  if v_order.status not in ('PENDING', 'PREPARING', 'READY') then raise exception 'Sólo se pueden editar pedidos abiertos' using errcode = '22023'; end if;

  for w in select value from jsonb_array_elements(p_weights) loop
    select * into v_item from public.poultry_order_items i where i.id = nullif(w ->> 'itemId', '')::uuid and i.order_id = v_order.id and i.organization_id = v_org;
    if not found then raise exception 'Línea de pedido no encontrada' using errcode = '42501'; end if;
    v_grams := nullif(w ->> 'actualWeightGrams', '')::integer;
    if v_grams is not null and v_grams <= 0 then raise exception 'Peso real inválido' using errcode = '22023'; end if;
    update public.poultry_order_items set
      actual_weight_grams = v_grams,
      line_revenue_cents = app_private.poultry_line_amount(v_item.sale_unit, v_item.unit_price_cents, v_item.boxes, v_grams)
    where id = v_item.id;
  end loop;

  select coalesce(sum(i.line_revenue_cents), 0) into v_revenue from public.poultry_order_items i where i.order_id = v_order.id;
  update public.poultry_orders set revenue_cents = v_revenue where id = v_order.id;
  return jsonb_build_object('orderId', v_order.id, 'revenueCents', v_revenue::text);
end;
$$;

-- Cambio de estado. Pasar a ENTREGADO captura el costo histórico vigente de cada línea (queda congelado). Los estados finales no se reabren.
create function public.set_poultry_order_status(p_order_id uuid, p_status public.poultry_order_status)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_at timestamptz := clock_timestamp();
  v_order public.poultry_orders%rowtype;
  v_tz text;
  r record;
  v_cost bigint;
  v_revenue bigint;
  v_total_cost bigint;
begin
  select * into v_order from public.poultry_orders o where o.id = p_order_id and o.organization_id = v_org for update;
  if not found then raise exception 'Pedido no encontrado' using errcode = '42501'; end if;
  perform app_private.require_visible_branch(v_org, v_order.branch_id);
  if v_order.status = p_status then
    return jsonb_build_object('orderId', v_order.id, 'status', v_order.status, 'changed', false);
  end if;
  if v_order.status in ('DELIVERED', 'CANCELLED') then
    raise exception 'Un pedido % no se puede reabrir', case v_order.status when 'DELIVERED' then 'entregado' else 'cancelado' end using errcode = '22023';
  end if;

  if p_status = 'CANCELLED' then
    update public.poultry_orders set status = 'CANCELLED', cancelled_at = v_at where id = v_order.id;
  elsif p_status = 'DELIVERED' then
    for r in
      select i.id, i.sale_unit, i.boxes, i.actual_weight_grams, i.product_id, i.product_name_snapshot, p.requires_weight
      from public.poultry_order_items i
      join public.poultry_products p on p.id = i.product_id and p.organization_id = i.organization_id
      where i.order_id = v_order.id order by i.position
    loop
      if (r.sale_unit = 'WEIGHT' or r.requires_weight) and r.actual_weight_grams is null then
        raise exception 'Falta registrar el peso real de %', r.product_name_snapshot using errcode = '22023';
      end if;
      v_cost := app_private.poultry_cost_at(v_org, r.product_id, v_at);
      if v_cost is null then
        raise exception 'Falta el costo vigente de % (cargalo en Precios antes de entregar)', r.product_name_snapshot using errcode = '22023';
      end if;
      update public.poultry_order_items set
        cost_cents_snapshot = v_cost,
        line_cost_cents = app_private.poultry_line_amount(r.sale_unit, v_cost, r.boxes, r.actual_weight_grams)
      where id = r.id;
    end loop;
    select coalesce(sum(i.line_revenue_cents), 0), coalesce(sum(i.line_cost_cents), 0) into v_revenue, v_total_cost
    from public.poultry_order_items i where i.order_id = v_order.id;
    select o.timezone into v_tz from public.organizations o where o.id = v_org;
    update public.poultry_orders set
      status = 'DELIVERED', delivered_at = v_at, delivered_on = (v_at at time zone coalesce(v_tz, 'UTC'))::date,
      revenue_cents = v_revenue, cost_cents = v_total_cost
    where id = v_order.id;
  else
    update public.poultry_orders set status = p_status where id = v_order.id;
  end if;
  return jsonb_build_object('orderId', v_order.id, 'status', p_status, 'changed', true);
end;
$$;

create function public.list_poultry_orders_page(
  p_status text default null,
  p_from date default null,
  p_to date default null,
  p_customer_id uuid default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_pattern text := app_private.poultry_like_pattern(p_search);
  v_number bigint := case when btrim(coalesce(p_search, '')) ~ '^\d{1,12}$' then btrim(p_search)::bigint end;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  if p_status is not null and p_status not in ('open', 'PENDING', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED') then
    raise exception 'Estado inválido' using errcode = '22023';
  end if;
  select count(*) into v_total
  from public.poultry_orders o
  join public.poultry_customers c on c.id = o.customer_id and c.organization_id = o.organization_id
  where o.organization_id = v_org and (v_vis is null or o.branch_id = any(v_vis))
    and (p_status is null or (p_status = 'open' and o.status in ('PENDING', 'PREPARING', 'READY')) or o.status::text = p_status)
    and (p_from is null or coalesce(o.delivery_on, o.ordered_on) >= p_from)
    and (p_to is null or coalesce(o.delivery_on, o.ordered_on) <= p_to)
    and (p_customer_id is null or o.customer_id = p_customer_id)
    and (v_pattern is null or app_private.import_normalize_text(c.name) like v_pattern escape '\' or o.order_number = v_number);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'orderNumber', r.order_number, 'branchId', r.branch_id, 'branchName', r.branch_name, 'customerId', r.customer_id,
    'customerName', r.customer_name, 'status', r.status, 'orderedOn', r.ordered_on, 'deliveryOn', r.delivery_on,
    'paymentMethod', r.payment_method, 'revenueCents', r.revenue_cents::text, 'costCents', r.cost_cents::text,
    'boxes', s.boxes, 'weightGrams', s.grams, 'pendingWeight', s.pending_weight, 'summary', s.summary
  ) order by r.sort_open, r.sort_open_date asc nulls last, r.sort_date desc, r.order_number desc), '[]'::jsonb) into v_rows
  from (
    select o.id, o.order_number, o.branch_id, b.name as branch_name, o.customer_id, c.name as customer_name, o.status, o.ordered_on, o.delivery_on,
      o.payment_method, o.revenue_cents, o.cost_cents,
      case when o.status in ('PENDING', 'PREPARING', 'READY') then 0 else 1 end as sort_open,
      case when o.status in ('PENDING', 'PREPARING', 'READY') then coalesce(o.delivery_on, o.ordered_on) end as sort_open_date,
      coalesce(o.delivery_on, o.ordered_on) as sort_date
    from public.poultry_orders o
    join public.poultry_customers c on c.id = o.customer_id and c.organization_id = o.organization_id
    join public.branches b on b.id = o.branch_id and b.organization_id = o.organization_id
    where o.organization_id = v_org and (v_vis is null or o.branch_id = any(v_vis))
      and (p_status is null or (p_status = 'open' and o.status in ('PENDING', 'PREPARING', 'READY')) or o.status::text = p_status)
      and (p_from is null or coalesce(o.delivery_on, o.ordered_on) >= p_from)
      and (p_to is null or coalesce(o.delivery_on, o.ordered_on) <= p_to)
      and (p_customer_id is null or o.customer_id = p_customer_id)
      and (v_pattern is null or app_private.import_normalize_text(c.name) like v_pattern escape '\' or o.order_number = v_number)
    order by (case when o.status in ('PENDING', 'PREPARING', 'READY') then 0 else 1 end),
      (case when o.status in ('PENDING', 'PREPARING', 'READY') then coalesce(o.delivery_on, o.ordered_on) end) asc nulls last,
      coalesce(o.delivery_on, o.ordered_on) desc, o.order_number desc
    limit v_limit offset v_offset
  ) r
  join lateral (
    select coalesce(sum(i.boxes), 0) as boxes, sum(i.actual_weight_grams) as grams,
      bool_or(i.sale_unit = 'WEIGHT' and i.actual_weight_grams is null) as pending_weight,
      string_agg(i.boxes::text || ' × ' || i.product_name_snapshot, ', ' order by i.position) as summary
    from public.poultry_order_items i where i.order_id = r.id
  ) s on true;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

create function public.get_poultry_order_detail(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  o public.poultry_orders%rowtype;
begin
  select * into o from public.poultry_orders x where x.id = p_order_id and x.organization_id = v_org and (v_vis is null or x.branch_id = any(v_vis));
  if not found then return null; end if;
  return jsonb_build_object(
    'id', o.id, 'orderNumber', o.order_number, 'branchId', o.branch_id,
    'branchName', (select b.name from public.branches b where b.id = o.branch_id and b.organization_id = o.organization_id),
    'customerId', o.customer_id,
    'customerName', (select c.name from public.poultry_customers c where c.id = o.customer_id and c.organization_id = o.organization_id),
    'status', o.status, 'orderedOn', o.ordered_on, 'deliveryOn', o.delivery_on, 'paymentMethod', o.payment_method, 'notes', o.notes,
    'revenueCents', o.revenue_cents::text, 'costCents', o.cost_cents::text, 'deliveredAt', o.delivered_at, 'deliveredOn', o.delivered_on, 'cancelledAt', o.cancelled_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'productId', i.product_id, 'name', i.product_name_snapshot, 'saleUnit', i.sale_unit, 'boxes', i.boxes,
        'actualWeightGrams', i.actual_weight_grams, 'unitPriceCents', i.unit_price_cents::text, 'priceSource', i.price_source,
        'lineRevenueCents', i.line_revenue_cents::text, 'costCentsSnapshot', i.cost_cents_snapshot::text, 'lineCostCents', i.line_cost_cents::text,
        'notes', i.notes
      ) order by i.position)
      from public.poultry_order_items i where i.order_id = o.id
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: resumen y rentabilidad (agregadas en el servidor; sólo pedidos ENTREGADOS, con costo histórico congelado)
-- ---------------------------------------------------------------------------------------------

create function public.get_poultry_summary(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_tz text;
  v_today date;
  v_open jsonb;
  v_sold jsonb;
  v_top_customers jsonb;
  v_top_products jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Rango de fechas inválido' using errcode = '22023'; end if;
  if p_to - p_from > 3660 then raise exception 'El rango es demasiado largo' using errcode = '22023'; end if;
  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_today := (clock_timestamp() at time zone coalesce(v_tz, 'UTC'))::date;

  select jsonb_build_object(
    'pending', count(*) filter (where status = 'PENDING'),
    'preparing', count(*) filter (where status = 'PREPARING'),
    'ready', count(*) filter (where status = 'READY'),
    'open', count(*),
    'dueToday', count(*) filter (where delivery_on = v_today),
    'upcoming', count(*) filter (where delivery_on > v_today and delivery_on <= v_today + 7),
    'overdue', count(*) filter (where delivery_on < v_today),
    'noDate', count(*) filter (where delivery_on is null)
  ) into v_open
  from public.poultry_orders o
  where o.organization_id = v_org and o.status in ('PENDING', 'PREPARING', 'READY') and (v_vis is null or o.branch_id = any(v_vis));

  select jsonb_build_object(
    'orders', count(*), 'revenueCents', coalesce(sum(o.revenue_cents), 0)::text, 'costCents', coalesce(sum(o.cost_cents), 0)::text,
    'profitCents', coalesce(sum(o.revenue_cents - o.cost_cents), 0)::text,
    'marginBps', app_private.poultry_margin_bps(coalesce(sum(o.revenue_cents), 0), coalesce(sum(o.cost_cents), 0)),
    'boxes', coalesce(sum(b.boxes), 0), 'weightGrams', coalesce(sum(b.grams), 0)
  ) into v_sold
  from public.poultry_orders o
  left join lateral (
    select sum(i.boxes) as boxes, sum(i.actual_weight_grams) as grams from public.poultry_order_items i where i.order_id = o.id
  ) b on true
  where o.organization_id = v_org and o.status = 'DELIVERED' and o.delivered_on between p_from and p_to and (v_vis is null or o.branch_id = any(v_vis));

  select coalesce(jsonb_agg(jsonb_build_object('customerId', t.customer_id, 'name', t.name, 'orders', t.orders, 'revenueCents', t.revenue::text, 'profitCents', t.profit::text)
    order by t.revenue desc, t.name), '[]'::jsonb) into v_top_customers
  from (
    select o.customer_id, c.name, count(*) as orders, sum(o.revenue_cents) as revenue, sum(o.revenue_cents - o.cost_cents) as profit
    from public.poultry_orders o
    join public.poultry_customers c on c.id = o.customer_id and c.organization_id = o.organization_id
    where o.organization_id = v_org and o.status = 'DELIVERED' and o.delivered_on between p_from and p_to and (v_vis is null or o.branch_id = any(v_vis))
    group by o.customer_id, c.name order by sum(o.revenue_cents) desc, c.name limit 5
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('productId', t.product_id, 'name', t.name, 'boxes', t.boxes, 'weightGrams', t.grams,
    'revenueCents', t.revenue::text, 'profitCents', t.profit::text) order by t.revenue desc, t.name), '[]'::jsonb) into v_top_products
  from (
    select i.product_id, max(i.product_name_snapshot) as name, sum(i.boxes) as boxes, sum(i.actual_weight_grams) as grams,
      sum(i.line_revenue_cents) as revenue, sum(i.line_revenue_cents - i.line_cost_cents) as profit
    from public.poultry_order_items i
    join public.poultry_orders o on o.id = i.order_id and o.organization_id = i.organization_id
    where o.organization_id = v_org and o.status = 'DELIVERED' and o.delivered_on between p_from and p_to and (v_vis is null or o.branch_id = any(v_vis))
    group by i.product_id order by sum(i.line_revenue_cents) desc, max(i.product_name_snapshot) limit 5
  ) t;

  return jsonb_build_object('today', v_today, 'open', v_open, 'sold', v_sold, 'topCustomers', v_top_customers, 'topProducts', v_top_products);
end;
$$;

-- Rentabilidad agrupada. p_group_by: product | customer | order | day | month. Paginada en el servidor (orden y día/mes sin límite de filas).
create function public.get_poultry_profitability(
  p_from date,
  p_to date,
  p_group_by text default 'product',
  p_product_id uuid default null,
  p_customer_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_totals jsonb;
  v_total bigint;
  v_rows jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Rango de fechas inválido' using errcode = '22023'; end if;
  if p_to - p_from > 3660 then raise exception 'El rango es demasiado largo' using errcode = '22023'; end if;
  if p_group_by not in ('product', 'customer', 'order', 'day', 'month') then raise exception 'Agrupación inválida' using errcode = '22023'; end if;

  -- Totales del rango (mismas líneas entregadas, ya filtradas por org, sucursales visibles, producto y cliente).
  with lines as (
    select i.product_id, i.product_name_snapshot as product_name, i.boxes, i.actual_weight_grams as grams,
      i.line_revenue_cents as revenue, i.line_cost_cents as cost,
      o.id as order_id, o.order_number, o.customer_id, c.name as customer_name, o.delivered_on
    from public.poultry_order_items i
    join public.poultry_orders o on o.id = i.order_id and o.organization_id = i.organization_id
    join public.poultry_customers c on c.id = o.customer_id and c.organization_id = o.organization_id
    where o.organization_id = v_org and o.status = 'DELIVERED' and o.delivered_on between p_from and p_to
      and (v_vis is null or o.branch_id = any(v_vis))
      and (p_product_id is null or i.product_id = p_product_id)
      and (p_customer_id is null or o.customer_id = p_customer_id)
  )
  select jsonb_build_object(
    'orders', count(distinct order_id), 'boxes', coalesce(sum(boxes), 0), 'weightGrams', coalesce(sum(grams), 0),
    'revenueCents', coalesce(sum(revenue), 0)::text, 'costCents', coalesce(sum(cost), 0)::text,
    'profitCents', coalesce(sum(revenue - cost), 0)::text,
    'marginBps', app_private.poultry_margin_bps(coalesce(sum(revenue), 0), coalesce(sum(cost), 0))
  ) into v_totals from lines;

  with lines as (
    select i.product_id, i.product_name_snapshot as product_name, i.boxes, i.actual_weight_grams as grams,
      i.line_revenue_cents as revenue, i.line_cost_cents as cost,
      o.id as order_id, o.order_number, o.customer_id, c.name as customer_name, o.delivered_on,
      case p_group_by when 'product' then i.product_id::text when 'customer' then o.customer_id::text when 'order' then o.id::text
        when 'day' then o.delivered_on::text else to_char(o.delivered_on, 'YYYY-MM') end as gkey,
      case p_group_by when 'product' then i.product_name_snapshot when 'customer' then c.name
        when 'order' then '#' || o.order_number::text || ' · ' || c.name
        when 'day' then o.delivered_on::text else to_char(o.delivered_on, 'YYYY-MM') end as glabel
    from public.poultry_order_items i
    join public.poultry_orders o on o.id = i.order_id and o.organization_id = i.organization_id
    join public.poultry_customers c on c.id = o.customer_id and c.organization_id = o.organization_id
    where o.organization_id = v_org and o.status = 'DELIVERED' and o.delivered_on between p_from and p_to
      and (v_vis is null or o.branch_id = any(v_vis))
      and (p_product_id is null or i.product_id = p_product_id)
      and (p_customer_id is null or o.customer_id = p_customer_id)
  ), grouped as (
    select gkey, max(glabel) as label, count(distinct order_id) as orders, sum(boxes) as boxes, sum(grams) as grams,
      sum(revenue) as revenue, sum(cost) as cost
    from lines group by gkey
  ), paged as (
    select * from grouped
    order by case when p_group_by in ('day', 'month') then null else revenue end desc nulls last,
      case when p_group_by in ('day', 'month') then gkey end desc nulls last, label, gkey
    limit v_limit offset v_offset
  )
  select (select count(*) from grouped),
    coalesce(jsonb_agg(jsonb_build_object(
      'key', gkey, 'label', label, 'orders', orders, 'boxes', boxes, 'weightGrams', grams,
      'revenueCents', revenue::text, 'costCents', cost::text, 'profitCents', (revenue - cost)::text,
      'marginBps', app_private.poultry_margin_bps(revenue, cost)
    ) order by case when p_group_by in ('day', 'month') then null else revenue end desc nulls last,
      case when p_group_by in ('day', 'month') then gkey end desc nulls last, label, gkey), '[]'::jsonb)
  into v_total, v_rows from paged;

  return jsonb_build_object('totals', v_totals, 'total', v_total, 'rows', v_rows, 'groupBy', p_group_by);
end;
$$;

revoke all on function
  public.save_poultry_product(text, public.unit_type, boolean, integer, boolean, uuid),
  public.set_poultry_product_cost(uuid, bigint, timestamptz),
  public.save_poultry_price_list(text, text, boolean, uuid),
  public.set_poultry_list_price(uuid, uuid, bigint, timestamptz),
  public.set_poultry_customer_price(uuid, uuid, bigint, timestamptz),
  public.get_poultry_price_board(),
  public.get_poultry_price_history(uuid),
  public.save_poultry_customer(text, text, text, text, uuid, text, boolean, uuid),
  public.list_poultry_customers_page(text, text, integer, integer),
  public.get_poultry_customer_detail(uuid),
  public.resolve_poultry_prices(uuid, uuid[]),
  public.save_poultry_order(uuid, uuid, date, jsonb, date, public.payment_method, text, uuid, uuid),
  public.set_poultry_order_weights(uuid, jsonb),
  public.set_poultry_order_status(uuid, public.poultry_order_status),
  public.list_poultry_orders_page(text, date, date, uuid, text, integer, integer),
  public.get_poultry_order_detail(uuid),
  public.get_poultry_summary(date, date),
  public.get_poultry_profitability(date, date, text, uuid, uuid, integer, integer)
from public, anon;

grant execute on function
  public.save_poultry_product(text, public.unit_type, boolean, integer, boolean, uuid),
  public.set_poultry_product_cost(uuid, bigint, timestamptz),
  public.save_poultry_price_list(text, text, boolean, uuid),
  public.set_poultry_list_price(uuid, uuid, bigint, timestamptz),
  public.set_poultry_customer_price(uuid, uuid, bigint, timestamptz),
  public.get_poultry_price_board(),
  public.get_poultry_price_history(uuid),
  public.save_poultry_customer(text, text, text, text, uuid, text, boolean, uuid),
  public.list_poultry_customers_page(text, text, integer, integer),
  public.get_poultry_customer_detail(uuid),
  public.resolve_poultry_prices(uuid, uuid[]),
  public.save_poultry_order(uuid, uuid, date, jsonb, date, public.payment_method, text, uuid, uuid),
  public.set_poultry_order_weights(uuid, jsonb),
  public.set_poultry_order_status(uuid, public.poultry_order_status),
  public.list_poultry_orders_page(text, date, date, uuid, text, integer, integer),
  public.get_poultry_order_detail(uuid),
  public.get_poultry_summary(date, date),
  public.get_poultry_profitability(date, date, text, uuid, uuid, integer, integer)
to authenticated;

commit;
