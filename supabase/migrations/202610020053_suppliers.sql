begin;

-- Proveedores (Sprint "Proveedores + importación real SimplyGest").
--
-- Antes de esta migración un proveedor sólo existía como texto libre en algunas operaciones de stock
-- (`stock_operations.supplier`). SimplyGest asocia un proveedor a cada artículo y no queremos
-- perderlo al migrar, así que se modela una entidad real, multiempresa:
--
--   suppliers          el proveedor. El ÚNICO dato indispensable es el nombre; código externo, CUIT,
--                      teléfono, email y notas son opcionales (SimplyGest puede no tenerlos).
--   product_suppliers  la relación producto ↔ proveedor (N:M a futuro). `is_primary` marca el
--                      proveedor principal (a lo sumo uno por producto); este sprint la UI sólo
--                      administra el principal. Un producto sin proveedor sigue siendo válido.
--
-- Duplicados: se normaliza con el MISMO normalizador que ya usan productos y el importador
-- (`app_private.import_normalize_text`: sin mayúsculas, acentos ni espacios repetidos) y un índice
-- único sobre esa expresión es la garantía final, también ante dos importaciones concurrentes. No es
-- un `unique (lower(name))`: "Distribuidora  Peña" y "distribuidora pena" son el mismo proveedor.
--
-- Alcance: sólo la base de proveedores y su vínculo con productos. Sin cuentas corrientes, pagos,
-- órdenes de compra, balances ni facturas de proveedor.
--
-- Escritura: nada escribe estas tablas directamente (sin INSERT/UPDATE/DELETE para `authenticated`);
-- todo pasa por las RPC de abajo, con permiso, auditoría y validación. Lectura: RLS por organización
-- y permiso `suppliers.read` (sólo Admin; un proveedor puede llevar CUIT/teléfono, no es información
-- para la caja).

insert into public.permissions (key, description) values
  ('suppliers.read', 'Read suppliers and their product links'),
  ('suppliers.write', 'Create, edit and deactivate suppliers')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-4000-8000-000000000001', 'suppliers.read'),
  ('10000000-0000-4000-8000-000000000001', 'suppliers.write')
on conflict (role_id, permission_key) do nothing;

create table public.suppliers (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  -- Código del proveedor en otro sistema (SimplyGest) o interno. Opcional.
  code text check (code is null or char_length(code) between 1 and 60),
  tax_id text check (tax_id is null or char_length(tax_id) between 1 and 40),
  phone text check (phone is null or char_length(phone) between 1 and 60),
  email text check (email is null or char_length(email) between 3 and 160),
  notes text check (notes is null or char_length(notes) between 1 and 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);

create unique index suppliers_org_normalized_name_uq
  on public.suppliers (organization_id, (app_private.import_normalize_text(name)));
create unique index suppliers_org_code_uq
  on public.suppliers (organization_id, upper(code)) where code is not null;
create index suppliers_org_active_idx on public.suppliers (organization_id, active);

create trigger suppliers_set_updated_at before update on public.suppliers
for each row execute function app_private.set_updated_at();
create trigger suppliers_audit after insert or update on public.suppliers
for each row execute function app_private.audit_row_change();

create table public.product_suppliers (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  supplier_id uuid not null,
  is_primary boolean not null default false,
  -- Código del producto en el catálogo del proveedor. Opcional.
  supplier_sku text check (supplier_sku is null or char_length(supplier_sku) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, supplier_id),
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict,
  foreign key (supplier_id, organization_id) references public.suppliers(id, organization_id) on delete restrict
);

-- A lo sumo un proveedor principal por producto.
create unique index product_suppliers_one_primary_uq on public.product_suppliers (product_id) where is_primary;
create index product_suppliers_supplier_idx on public.product_suppliers (supplier_id, is_primary);
create index product_suppliers_org_idx on public.product_suppliers (organization_id);

create trigger product_suppliers_set_updated_at before update on public.product_suppliers
for each row execute function app_private.set_updated_at();

alter table public.suppliers enable row level security;
alter table public.product_suppliers enable row level security;

create policy suppliers_select on public.suppliers
for select to authenticated using (app_private.has_permission(organization_id, 'suppliers.read'));
create policy product_suppliers_select on public.product_suppliers
for select to authenticated using (app_private.has_permission(organization_id, 'suppliers.read'));

revoke all on table public.suppliers, public.product_suppliers from public, anon, authenticated;
grant select on table public.suppliers, public.product_suppliers to authenticated;

comment on table public.suppliers is
  'Proveedores de la organización. Sólo el nombre es obligatorio. Se desactivan, no se borran (conservan el vínculo con sus productos).';
comment on table public.product_suppliers is
  'Relación producto ↔ proveedor. is_primary = proveedor principal (único por producto). Un producto puede no tener ninguno.';

-- Los proveedores importados se identifican por código externo igual que categorías y productos.
alter table public.external_entity_links drop constraint external_entity_links_entity_type_check;
alter table public.external_entity_links add constraint external_entity_links_entity_type_check
  check (entity_type in ('category', 'product', 'supplier'));

-- ---------------------------------------------------------------------------------------------
-- Helpers privados (los comparten las RPC de Admin y el importador)
-- ---------------------------------------------------------------------------------------------

create function app_private.supplier_blank_to_null(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$ select nullif(btrim(coalesce(p_value, '')), ''); $$;

-- Proveedor de la organización que corresponde a (código externo, nombre), sin crear nada.
-- Prioridad: 1) vínculo externo del sistema de origen, 2) mismo código, 3) mismo nombre normalizado.
-- null = no existe. `p_source_system` puede ser null (alta manual: sólo código y nombre).
create function app_private.find_supplier(
  p_organization_id uuid,
  p_source_system text,
  p_code text,
  p_name text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := nullif(upper(btrim(coalesce(p_code, ''))), '');
  v_key text := app_private.import_normalize_text(p_name);
  v_id uuid;
begin
  if v_code is not null and p_source_system is not null then
    select s.id into v_id
    from public.external_entity_links l
    join public.suppliers s on s.id = l.internal_id and s.organization_id = l.organization_id
    where l.organization_id = p_organization_id and l.source_system = p_source_system
      and l.entity_type = 'supplier' and l.external_id = v_code;
    if v_id is not null then return v_id; end if;
  end if;
  if v_code is not null then
    select s.id into v_id from public.suppliers s
    where s.organization_id = p_organization_id and upper(s.code) = v_code;
    if v_id is not null then return v_id; end if;
  end if;
  if v_key is not null then
    select s.id into v_id from public.suppliers s
    where s.organization_id = p_organization_id and app_private.import_normalize_text(s.name) = v_key;
  end if;
  return v_id;
end;
$$;

-- Deja a `p_supplier_id` como proveedor principal del producto (alta del vínculo si no existía) y
-- degrada al principal anterior a vínculo secundario: nunca se borra un vínculo. null = el producto
-- queda sin proveedor principal. Devuelve true si algo cambió.
create function app_private.set_primary_supplier(
  p_organization_id uuid,
  p_product_id uuid,
  p_supplier_id uuid,
  p_supplier_sku text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_current uuid;
  v_sku text := app_private.supplier_blank_to_null(p_supplier_sku);
  v_changed boolean := false;
begin
  -- Serializa por producto: dos llamadas simultáneas no pueden dejar dos principales.
  perform pg_advisory_xact_lock(hashtextextended('product-supplier:' || p_product_id::text, 0));

  select ps.supplier_id into v_current
  from public.product_suppliers ps
  where ps.product_id = p_product_id and ps.is_primary;

  if p_supplier_id is null then
    if v_current is not null then
      update public.product_suppliers set is_primary = false
      where product_id = p_product_id and supplier_id = v_current;
      v_changed := true;
    end if;
    return v_changed;
  end if;

  if v_current is distinct from p_supplier_id then
    if v_current is not null then
      update public.product_suppliers set is_primary = false
      where product_id = p_product_id and supplier_id = v_current;
    end if;
    insert into public.product_suppliers (organization_id, product_id, supplier_id, is_primary, supplier_sku)
    values (p_organization_id, p_product_id, p_supplier_id, true, v_sku)
    on conflict (product_id, supplier_id) do update
    set is_primary = true, supplier_sku = coalesce(excluded.supplier_sku, public.product_suppliers.supplier_sku);
    v_changed := true;
  elsif v_sku is not null then
    update public.product_suppliers set supplier_sku = v_sku
    where product_id = p_product_id and supplier_id = p_supplier_id and supplier_sku is distinct from v_sku;
    v_changed := found;
  end if;
  return v_changed;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC de Admin
-- ---------------------------------------------------------------------------------------------

-- Alta/edición. p_supplier_id null = alta. Un nombre (normalizado) o código ya usado por OTRO
-- proveedor es un error legible; la edición nunca crea un segundo proveedor.
create function public.save_supplier(
  p_supplier_id uuid,
  p_name text,
  p_code text default null,
  p_tax_id text default null,
  p_phone text default null,
  p_email text default null,
  p_notes text default null,
  p_active boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('suppliers.write');
  v_name text := btrim(coalesce(p_name, ''));
  v_code text := nullif(upper(btrim(coalesce(p_code, ''))), '');
  v_email text := app_private.supplier_blank_to_null(p_email);
  v_existing uuid;
  v_id uuid;
begin
  if char_length(v_name) not between 1 and 120 then
    raise exception 'El nombre del proveedor es obligatorio (hasta 120 caracteres)' using errcode = '22023';
  end if;
  if v_code is not null and char_length(v_code) > 60 then
    raise exception 'El código del proveedor supera los 60 caracteres' using errcode = '22023';
  end if;
  if v_email is not null and (char_length(v_email) > 160 or position('@' in v_email) < 2) then
    raise exception 'El email del proveedor no es válido' using errcode = '22023';
  end if;
  if char_length(coalesce(p_tax_id, '')) > 40 or char_length(coalesce(p_phone, '')) > 60 or char_length(coalesce(p_notes, '')) > 1000 then
    raise exception 'Alguno de los datos del proveedor es demasiado largo' using errcode = '22023';
  end if;

  select s.id into v_existing from public.suppliers s
  where s.organization_id = v_org and app_private.import_normalize_text(s.name) = app_private.import_normalize_text(v_name)
    and s.id is distinct from p_supplier_id;
  if v_existing is not null then
    raise exception 'Ya existe un proveedor con ese nombre' using errcode = '23505';
  end if;
  if v_code is not null then
    select s.id into v_existing from public.suppliers s
    where s.organization_id = v_org and upper(s.code) = v_code and s.id is distinct from p_supplier_id;
    if v_existing is not null then
      raise exception 'Ya existe un proveedor con ese código' using errcode = '23505';
    end if;
  end if;

  begin
    if p_supplier_id is null then
      insert into public.suppliers (organization_id, name, code, tax_id, phone, email, notes, active)
      values (
        v_org, v_name, v_code, app_private.supplier_blank_to_null(p_tax_id), app_private.supplier_blank_to_null(p_phone),
        v_email, app_private.supplier_blank_to_null(p_notes), coalesce(p_active, true)
      )
      returning id into v_id;
    else
      update public.suppliers s
      set name = v_name, code = v_code, tax_id = app_private.supplier_blank_to_null(p_tax_id),
          phone = app_private.supplier_blank_to_null(p_phone), email = v_email,
          notes = app_private.supplier_blank_to_null(p_notes), active = coalesce(p_active, s.active)
      where s.id = p_supplier_id and s.organization_id = v_org
      returning s.id into v_id;
    end if;
  exception when unique_violation then
    -- Carrera con otra alta del mismo nombre/código: la restricción única es la última garantía.
    raise exception 'Ya existe un proveedor con ese nombre o código' using errcode = '23505';
  end;
  if v_id is null then
    raise exception 'El proveedor no existe en esta organización' using errcode = '42501';
  end if;
  return v_id;
end;
$$;

-- Activar/desactivar. Un proveedor desactivado conserva sus productos y su historial; sólo deja de
-- ofrecerse al asignar un proveedor principal.
create function public.set_supplier_active(p_supplier_id uuid, p_active boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('suppliers.write');
begin
  if p_active is null then
    raise exception 'Indicá si el proveedor queda activo o inactivo' using errcode = '22023';
  end if;
  update public.suppliers set active = p_active where id = p_supplier_id and organization_id = v_org;
  if not found then
    raise exception 'El proveedor no existe en esta organización' using errcode = '42501';
  end if;
end;
$$;

-- Proveedor principal desde la ficha del producto. p_supplier_id null = sin proveedor principal.
-- Cambiar de proveedor degrada al anterior a vínculo secundario (no se pierde su código de proveedor).
create function public.set_product_primary_supplier(p_product_id uuid, p_supplier_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('products.write');
  v_before uuid;
  v_active boolean;
  v_changed boolean;
begin
  if not app_private.has_permission(v_org, 'suppliers.read') then
    raise exception 'Permiso insuficiente para asignar proveedores' using errcode = '42501';
  end if;
  if not exists (select 1 from public.products p where p.id = p_product_id and p.organization_id = v_org) then
    raise exception 'El producto no existe en esta organización' using errcode = '42501';
  end if;
  select ps.supplier_id into v_before from public.product_suppliers ps
  where ps.product_id = p_product_id and ps.is_primary;

  if p_supplier_id is not null then
    select s.active into v_active from public.suppliers s where s.id = p_supplier_id and s.organization_id = v_org;
    if not found then
      raise exception 'El proveedor no existe en esta organización' using errcode = '42501';
    end if;
    -- Un proveedor inactivo no se asigna de nuevo; si ya era el principal, no cambia nada.
    if not v_active and v_before is distinct from p_supplier_id then
      raise exception 'El proveedor está inactivo: activalo antes de asignarlo' using errcode = '22023';
    end if;
  end if;

  v_changed := app_private.set_primary_supplier(v_org, p_product_id, p_supplier_id);
  if v_changed then
    perform app_private.write_audit(
      v_org, null, 'PRODUCT_PRIMARY_SUPPLIER_SET', 'products', p_product_id,
      jsonb_build_object('supplierId', v_before), jsonb_build_object('supplierId', p_supplier_id)
    );
  end if;
  return jsonb_build_object('changed', v_changed, 'supplierId', p_supplier_id);
end;
$$;

-- Listado paginado para /admin/suppliers. product_count = productos para los que es el proveedor
-- PRINCIPAL (los vínculos secundarios del futuro no inflan la cifra).
create function public.list_suppliers_page(
  p_search text default null,
  p_status text default 'all',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  supplier_id uuid,
  name text,
  code text,
  tax_id text,
  phone text,
  email text,
  notes text,
  active boolean,
  product_count bigint,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('suppliers.read');
  v_search text := app_private.import_normalize_text(p_search);
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
  with filtered as (
    select s.id
    from public.suppliers s
    where s.organization_id = v_org
      and (p_status = 'all' or (p_status = 'active') = s.active)
      and (v_search is null
        or app_private.import_normalize_text(s.name) like '%' || v_search || '%'
        or upper(coalesce(s.code, '')) like '%' || upper(btrim(p_search)) || '%'
        or coalesce(s.tax_id, '') like '%' || btrim(p_search) || '%')
  )
  select s.id, s.name, s.code, s.tax_id, s.phone, s.email, s.notes, s.active,
    (select count(*) from public.product_suppliers ps where ps.supplier_id = s.id and ps.is_primary),
    (select count(*) from filtered)
  from public.suppliers s
  join filtered f on f.id = s.id
  order by app_private.import_normalize_text(s.name), s.id
  limit p_limit offset coalesce(p_offset, 0);
end;
$$;

revoke all on function
  app_private.supplier_blank_to_null(text),
  app_private.find_supplier(uuid, text, text, text),
  app_private.set_primary_supplier(uuid, uuid, uuid, text)
from public, anon, authenticated;

revoke all on function
  public.save_supplier(uuid, text, text, text, text, text, text, boolean),
  public.set_supplier_active(uuid, boolean),
  public.set_product_primary_supplier(uuid, uuid),
  public.list_suppliers_page(text, text, integer, integer)
from public, anon;
grant execute on function
  public.save_supplier(uuid, text, text, text, text, text, text, boolean),
  public.set_supplier_active(uuid, boolean),
  public.set_product_primary_supplier(uuid, uuid),
  public.list_suppliers_page(text, text, integer, integer)
to authenticated;

commit;
