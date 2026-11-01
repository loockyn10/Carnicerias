begin;

-- Módulo ENVASADOS al vacío del Admin: paquetes de cortes con peso, precio/kg vigente, elaboración/vencimiento, lote trazable y EAN-13,
-- registrados como snapshots auditables para poder reimprimir las dos etiquetas (informativa y de precio) tal como salieron.
--
-- NO se crea otro catálogo: los cortes son `products` (sólo WEIGHT y activos). La configuración de envasado vive en una tabla aparte
-- (`product_vacuum_settings`), sin tocar `products`: un producto sin fila NO está disponible para envasar, así que ningún producto existente
-- cambia y el POS (que sincroniza `products`) no se entera. El precio/kg es el vigente de `product_prices` (sucursal > global), el mismo
-- que usan las etiquetas de góndola; el importe usa el redondeo half-up de priceForWeight (precio × gramos / 1000) del POS.
--
-- Qué NO se asume (queda como configuración, nunca como regla del código):
--   * días de vida útil (por producto), textos de conservación y datos del establecimiento (por organización/producto);
--   * el esquema del EAN-13 (prefijo, PLU, qué valor se embebe y cuántos dígitos): mientras no esté configurado, no se pueden registrar
--     paquetes (el Admin muestra que falta configurarlo); jamás se inventa un formato;
--   * el tamaño de la etiqueta (ancho/alto): constantes centralizadas en el Admin, con override opcional por organización.
--
-- Escritura sólo por RPC (permisos vacuum.*, organización y sucursal validadas en el servidor). Lectura: RLS por organización + permiso,
-- y para paquetes además aislamiento por sucursal. Los paquetes y su historial de impresión son append-only.

insert into public.permissions (key, description) values
  ('vacuum.read', 'Read the vacuum-packaging module: settings, packages and labels'),
  ('vacuum.write', 'Register vacuum packages and print/reprint their labels'),
  ('vacuum.configure', 'Configure vacuum packaging: products, establishment texts, label size and EAN-13 scheme'),
  ('vacuum.override_expiry', 'Change the expiry date of a package away from the product shelf life')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-4000-8000-000000000001', 'vacuum.read'),
  ('10000000-0000-4000-8000-000000000001', 'vacuum.write'),
  ('10000000-0000-4000-8000-000000000001', 'vacuum.configure'),
  ('10000000-0000-4000-8000-000000000001', 'vacuum.override_expiry')
on conflict (role_id, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- EAN-13 (puro): dígito verificador, validación y armado según el esquema configurado
-- ---------------------------------------------------------------------------------------------

-- Dígito verificador EAN-13 de los primeros 12 dígitos (pesos 1 y 3 alternados desde la izquierda).
create function app_private.ean13_check_digit(p_first12 text)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_sum integer := 0;
  i integer;
begin
  if p_first12 is null or p_first12 !~ '^[0-9]{12}$' then
    raise exception 'Se esperaban 12 dígitos para calcular el dígito verificador' using errcode = '22023';
  end if;
  for i in 1..12 loop
    v_sum := v_sum + substr(p_first12, i, 1)::integer * case when i % 2 = 1 then 1 else 3 end;
  end loop;
  return (10 - v_sum % 10) % 10;
end;
$$;

create function app_private.ean13_is_valid(p_ean text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_ean ~ '^[0-9]{13}$' and app_private.ean13_check_digit(left(p_ean, 12)) = right(p_ean, 1)::integer;
$$;

-- Arma el EAN-13 de un paquete: prefijo + PLU (cero a la izquierda) + valor embebido (precio en centavos o peso en gramos, dividido por
-- `p_step` con half-up) + dígito verificador. Rechaza si algo no entra en los dígitos configurados (nunca trunca).
create function app_private.vacuum_build_ean(
  p_scheme text,
  p_prefix text,
  p_plu_digits integer,
  p_value_digits integer,
  p_value_step integer,
  p_plu text,
  p_price_cents bigint,
  p_weight_grams integer
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_raw bigint;
  v_value bigint;
  v_first12 text;
begin
  if p_scheme is null or p_prefix is null or p_plu_digits is null or p_value_digits is null then
    raise exception 'Falta configurar el esquema EAN-13 de envasados' using errcode = '22023';
  end if;
  if p_scheme not in ('PRICE_EMBEDDED', 'WEIGHT_EMBEDDED') then raise exception 'Esquema EAN-13 no soportado' using errcode = '22023'; end if;
  if char_length(p_prefix) + p_plu_digits + p_value_digits <> 12 then raise exception 'El esquema EAN-13 tiene que sumar 12 dígitos antes del verificador' using errcode = '22023'; end if;
  if p_plu is null or p_plu !~ '^[0-9]+$' then raise exception 'El producto no tiene un PLU numérico para el código EAN-13' using errcode = '22023'; end if;
  if char_length(p_plu) > p_plu_digits then raise exception 'El PLU % no entra en % dígitos', p_plu, p_plu_digits using errcode = '22023'; end if;
  v_raw := case p_scheme when 'PRICE_EMBEDDED' then p_price_cents else p_weight_grams::bigint end;
  if v_raw is null or v_raw < 0 then raise exception 'Falta el valor a embeber en el EAN-13' using errcode = '22023'; end if;
  v_value := (v_raw + coalesce(p_value_step, 1) / 2) / coalesce(p_value_step, 1);
  if char_length(v_value::text) > p_value_digits then
    raise exception 'El valor % no entra en % dígitos del EAN-13', v_value, p_value_digits using errcode = '22023';
  end if;
  v_first12 := p_prefix || lpad(p_plu, p_plu_digits, '0') || lpad(v_value::text, p_value_digits, '0');
  return v_first12 || app_private.ean13_check_digit(v_first12)::text;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------------------------

create table public.product_vacuum_settings (
  product_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  enabled boolean not null default true,
  -- Días de vida útil: configuración, no regla. null = el vencimiento se carga a mano.
  shelf_life_days integer check (shelf_life_days is null or shelf_life_days between 1 and 3650),
  -- Código interno del producto dentro del EAN-13 (sólo dígitos).
  plu text check (plu is null or plu ~ '^[0-9]{1,8}$'),
  conservation_text text check (conservation_text is null or char_length(conservation_text) between 1 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete cascade
);
-- El PLU es único por organización comparando su valor numérico (0012 y 12 son el mismo código).
create unique index product_vacuum_settings_org_plu_uq on public.product_vacuum_settings (organization_id, ((plu)::bigint)) where plu is not null;
create index product_vacuum_settings_org_enabled_idx on public.product_vacuum_settings (organization_id, enabled);
create trigger product_vacuum_settings_set_updated_at before update on public.product_vacuum_settings for each row execute function app_private.set_updated_at();
create trigger product_vacuum_settings_audit after insert or update on public.product_vacuum_settings for each row execute function app_private.audit_row_change();

create table public.organization_vacuum_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- Datos del establecimiento y textos de la etiqueta informativa. Todos opcionales y configurables: el sistema no afirma cumplimiento regulatorio.
  business_name text check (business_name is null or char_length(business_name) between 1 and 120),
  address text check (address is null or char_length(address) between 1 and 240),
  establishment_info text check (establishment_info is null or char_length(establishment_info) between 1 and 300),
  default_conservation_text text check (default_conservation_text is null or char_length(default_conservation_text) between 1 and 600),
  extra_text text check (extra_text is null or char_length(extra_text) between 1 and 600),
  -- Medidas de etiqueta (mm). null = constante centralizada del Admin (vacuum-label-spec.ts).
  label_width_mm numeric(5, 1) check (label_width_mm is null or label_width_mm between 30 and 120),
  info_height_mm numeric(5, 1) check (info_height_mm is null or info_height_mm between 20 and 200),
  price_height_mm numeric(5, 1) check (price_height_mm is null or price_height_mm between 20 and 200),
  -- Esquema EAN-13: todo o nada. Los dígitos suman 12 (prefijo + PLU + valor) y el 13.º es el verificador.
  ean_scheme text check (ean_scheme is null or ean_scheme in ('PRICE_EMBEDDED', 'WEIGHT_EMBEDDED')),
  ean_prefix text check (ean_prefix is null or ean_prefix ~ '^[0-9]{1,6}$'),
  ean_plu_digits integer check (ean_plu_digits is null or ean_plu_digits between 1 and 8),
  ean_value_digits integer check (ean_value_digits is null or ean_value_digits between 1 and 8),
  -- Divisor del valor embebido (1 = centavos / gramos; 100 = pesos enteros; 10 = decagramos…), half-up.
  ean_value_step integer not null default 1 check (ean_value_step between 1 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((ean_scheme is null) = (ean_prefix is null) and (ean_scheme is null) = (ean_plu_digits is null) and (ean_scheme is null) = (ean_value_digits is null)),
  check (ean_scheme is null or char_length(ean_prefix) + ean_plu_digits + ean_value_digits = 12)
);
create trigger organization_vacuum_settings_set_updated_at before update on public.organization_vacuum_settings for each row execute function app_private.set_updated_at();
create trigger organization_vacuum_settings_audit after insert or update on public.organization_vacuum_settings for each row execute function app_private.audit_row_change();

create table public.vacuum_lot_counters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  packed_on date not null,
  last_seq integer not null default 0,
  primary key (organization_id, branch_id, packed_on),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade
);

create table public.vacuum_packages (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  product_id uuid not null,
  request_key uuid,
  -- Snapshots: la etiqueta histórica NUNCA se reconstruye con datos actuales.
  product_name_snapshot text not null,
  product_sku_snapshot text,
  weight_grams integer not null check (weight_grams > 0),
  price_per_kg_cents bigint not null check (price_per_kg_cents > 0),
  total_cents bigint not null check (total_cents > 0),
  packed_on date not null,
  expires_on date not null,
  lot text not null check (lot ~ '^[A-Z0-9][A-Z0-9._/-]{2,39}$'),
  ean13 text not null check (app_private.ean13_is_valid(ean13)),
  shelf_life_days_snapshot integer,
  conservation_text_snapshot text,
  -- Datos de la etiqueta tal como se emitieron: establecimiento, textos, medidas y esquema EAN usado.
  label_snapshot jsonb not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (expires_on >= packed_on),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict,
  unique (id, organization_id),
  unique (id, organization_id, branch_id),
  unique (organization_id, lot)
);
create unique index vacuum_packages_request_key_uq on public.vacuum_packages (organization_id, request_key) where request_key is not null;
create index vacuum_packages_recent_idx on public.vacuum_packages (organization_id, created_at desc, id);
create index vacuum_packages_branch_idx on public.vacuum_packages (organization_id, branch_id, created_at desc);
create index vacuum_packages_product_idx on public.vacuum_packages (organization_id, product_id, created_at desc);
create index vacuum_packages_packed_idx on public.vacuum_packages (organization_id, packed_on desc);
create index vacuum_packages_ean_idx on public.vacuum_packages (organization_id, ean13);
create trigger vacuum_packages_audit after insert on public.vacuum_packages for each row execute function app_private.audit_row_change();

create function app_private.vacuum_packages_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Un paquete envasado es un registro histórico: no se modifica' using errcode = '22023';
end;
$$;
create trigger vacuum_packages_no_update before update on public.vacuum_packages for each row execute function app_private.vacuum_packages_immutable();

create table public.vacuum_package_prints (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  package_id uuid not null,
  kind text not null check (kind in ('INFO', 'PRICE', 'BOTH')),
  reprint boolean not null default false,
  printed_by uuid references public.profiles(id) on delete set null,
  printed_at timestamptz not null default now(),
  foreign key (package_id, organization_id, branch_id) references public.vacuum_packages(id, organization_id, branch_id) on delete cascade
);
create index vacuum_package_prints_package_idx on public.vacuum_package_prints (package_id, printed_at desc);

-- ---------------------------------------------------------------------------------------------
-- RLS (lectura). Sin INSERT/UPDATE/DELETE para `authenticated`.
-- ---------------------------------------------------------------------------------------------

alter table public.product_vacuum_settings enable row level security;
alter table public.organization_vacuum_settings enable row level security;
alter table public.vacuum_lot_counters enable row level security;
alter table public.vacuum_packages enable row level security;
alter table public.vacuum_package_prints enable row level security;

create policy product_vacuum_settings_select on public.product_vacuum_settings for select to authenticated
using (app_private.has_permission(organization_id, 'vacuum.read'));
create policy organization_vacuum_settings_select on public.organization_vacuum_settings for select to authenticated
using (app_private.has_permission(organization_id, 'vacuum.read'));
create policy vacuum_packages_select on public.vacuum_packages for select to authenticated
using (
  app_private.has_permission(organization_id, 'vacuum.read')
  and (app_private.has_permission(organization_id, 'branches.read_all') or app_private.is_branch_member(branch_id))
);
create policy vacuum_package_prints_select on public.vacuum_package_prints for select to authenticated
using (
  app_private.has_permission(organization_id, 'vacuum.read')
  and (app_private.has_permission(organization_id, 'branches.read_all') or app_private.is_branch_member(branch_id))
);

revoke all on table
  public.product_vacuum_settings, public.organization_vacuum_settings, public.vacuum_lot_counters, public.vacuum_packages, public.vacuum_package_prints
from public, anon, authenticated;
grant select on table
  public.product_vacuum_settings, public.organization_vacuum_settings, public.vacuum_packages, public.vacuum_package_prints
to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Helpers privados
-- ---------------------------------------------------------------------------------------------

-- Precio/kg vigente del corte para una sucursal: precio de la sucursal > precio global (misma regla que las etiquetas de góndola).
create function app_private.vacuum_price_per_kg(p_organization_id uuid, p_product_id uuid, p_branch_id uuid, p_at timestamptz)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select pp.price_cents
  from public.product_prices pp
  where pp.organization_id = p_organization_id and pp.product_id = p_product_id
    and (pp.branch_id = p_branch_id or pp.branch_id is null)
    and pp.valid_from <= p_at and (pp.valid_to is null or pp.valid_to > p_at)
  order by (pp.branch_id = p_branch_id) desc nulls last, pp.valid_from desc
  limit 1;
$$;

create function app_private.vacuum_package_json(p public.vacuum_packages)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'organizationId', p.organization_id, 'branchId', p.branch_id,
    'branchName', (select b.name from public.branches b where b.id = p.branch_id and b.organization_id = p.organization_id),
    'productId', p.product_id, 'productName', p.product_name_snapshot, 'productSku', p.product_sku_snapshot,
    'weightGrams', p.weight_grams, 'pricePerKgCents', p.price_per_kg_cents::text, 'totalCents', p.total_cents::text,
    'packedOn', p.packed_on, 'expiresOn', p.expires_on, 'lot', p.lot, 'ean13', p.ean13,
    'shelfLifeDays', p.shelf_life_days_snapshot, 'conservationText', p.conservation_text_snapshot,
    'label', p.label_snapshot, 'createdAt', p.created_at,
    'createdBy', (select pr.display_name from public.profiles pr where pr.id = p.created_by),
    'printCount', (select count(*) from public.vacuum_package_prints x where x.package_id = p.id)
  );
$$;

revoke all on function
  app_private.ean13_check_digit(text), app_private.ean13_is_valid(text),
  app_private.vacuum_build_ean(text, text, integer, integer, integer, text, bigint, integer),
  app_private.vacuum_packages_immutable(), app_private.vacuum_price_per_kg(uuid, uuid, uuid, timestamptz),
  app_private.vacuum_package_json(public.vacuum_packages)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- RPC: configuración
-- ---------------------------------------------------------------------------------------------

create function public.get_vacuum_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  s public.organization_vacuum_settings%rowtype;
begin
  select * into s from public.organization_vacuum_settings x where x.organization_id = v_org;
  return jsonb_build_object(
    'businessName', s.business_name, 'address', s.address, 'establishmentInfo', s.establishment_info,
    'defaultConservationText', s.default_conservation_text, 'extraText', s.extra_text,
    'labelWidthMm', s.label_width_mm, 'infoHeightMm', s.info_height_mm, 'priceHeightMm', s.price_height_mm,
    'ean', jsonb_build_object(
      'configured', s.ean_scheme is not null, 'scheme', s.ean_scheme, 'prefix', s.ean_prefix,
      'pluDigits', s.ean_plu_digits, 'valueDigits', s.ean_value_digits, 'valueStep', coalesce(s.ean_value_step, 1)
    )
  );
end;
$$;

create function public.save_vacuum_settings(
  p_business_name text default null,
  p_address text default null,
  p_establishment_info text default null,
  p_default_conservation_text text default null,
  p_extra_text text default null,
  p_label_width_mm numeric default null,
  p_info_height_mm numeric default null,
  p_price_height_mm numeric default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.configure');
begin
  insert into public.organization_vacuum_settings (
    organization_id, business_name, address, establishment_info, default_conservation_text, extra_text, label_width_mm, info_height_mm, price_height_mm
  ) values (
    v_org, nullif(btrim(coalesce(p_business_name, '')), ''), nullif(btrim(coalesce(p_address, '')), ''), nullif(btrim(coalesce(p_establishment_info, '')), ''),
    nullif(btrim(coalesce(p_default_conservation_text, '')), ''), nullif(btrim(coalesce(p_extra_text, '')), ''), p_label_width_mm, p_info_height_mm, p_price_height_mm
  )
  on conflict (organization_id) do update set
    business_name = excluded.business_name, address = excluded.address, establishment_info = excluded.establishment_info,
    default_conservation_text = excluded.default_conservation_text, extra_text = excluded.extra_text,
    label_width_mm = excluded.label_width_mm, info_height_mm = excluded.info_height_mm, price_height_mm = excluded.price_height_mm;
end;
$$;

-- Esquema EAN-13. `p_scheme` null = borrar la configuración (los paquetes ya emitidos conservan su EAN y el esquema con que se armó).
create function public.save_vacuum_ean_scheme(
  p_scheme text default null,
  p_prefix text default null,
  p_plu_digits integer default null,
  p_value_digits integer default null,
  p_value_step integer default 1
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.configure');
begin
  if p_scheme is not null then
    if p_scheme not in ('PRICE_EMBEDDED', 'WEIGHT_EMBEDDED') then raise exception 'Esquema EAN-13 no soportado' using errcode = '22023'; end if;
    if p_prefix is null or p_prefix !~ '^[0-9]{1,6}$' then raise exception 'El prefijo tiene que tener entre 1 y 6 dígitos' using errcode = '22023'; end if;
    if p_plu_digits is null or p_plu_digits not between 1 and 8 or p_value_digits is null or p_value_digits not between 1 and 8 then
      raise exception 'Indicá cuántos dígitos usan el PLU y el valor (1 a 8)' using errcode = '22023';
    end if;
    if char_length(p_prefix) + p_plu_digits + p_value_digits <> 12 then
      raise exception 'Prefijo + PLU + valor tienen que sumar 12 dígitos (el 13.º es el verificador); hoy suman %', char_length(p_prefix) + p_plu_digits + p_value_digits using errcode = '22023';
    end if;
    if coalesce(p_value_step, 1) not between 1 and 100000 then raise exception 'El divisor del valor es inválido' using errcode = '22023'; end if;
  end if;
  insert into public.organization_vacuum_settings (organization_id, ean_scheme, ean_prefix, ean_plu_digits, ean_value_digits, ean_value_step)
  values (v_org, p_scheme, p_prefix, p_plu_digits, p_value_digits, coalesce(p_value_step, 1))
  on conflict (organization_id) do update set
    ean_scheme = excluded.ean_scheme, ean_prefix = excluded.ean_prefix, ean_plu_digits = excluded.ean_plu_digits,
    ean_value_digits = excluded.ean_value_digits, ean_value_step = excluded.ean_value_step;
end;
$$;

create function public.save_vacuum_product_config(
  p_product_id uuid,
  p_enabled boolean,
  p_shelf_life_days integer default null,
  p_plu text default null,
  p_conservation_text text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.configure');
  v_plu text := nullif(btrim(coalesce(p_plu, '')), '');
begin
  if not exists (select 1 from public.products p where p.id = p_product_id and p.organization_id = v_org and p.unit_type = 'WEIGHT') then
    raise exception 'Sólo los productos por peso de esta organización se pueden envasar' using errcode = '42501';
  end if;
  if p_shelf_life_days is not null and p_shelf_life_days not between 1 and 3650 then raise exception 'La vida útil tiene que estar entre 1 y 3650 días' using errcode = '22023'; end if;
  if v_plu is not null and v_plu !~ '^[0-9]{1,8}$' then raise exception 'El PLU tiene que tener sólo dígitos (hasta 8)' using errcode = '22023'; end if;
  begin
    insert into public.product_vacuum_settings (product_id, organization_id, enabled, shelf_life_days, plu, conservation_text)
    values (p_product_id, v_org, coalesce(p_enabled, true), p_shelf_life_days, v_plu, nullif(btrim(coalesce(p_conservation_text, '')), ''))
    on conflict (product_id) do update set
      enabled = excluded.enabled, shelf_life_days = excluded.shelf_life_days, plu = excluded.plu, conservation_text = excluded.conservation_text;
  exception when unique_violation then
    raise exception 'El PLU % ya está asignado a otro producto', v_plu using errcode = '23505';
  end;
end;
$$;

-- Productos por peso activos con su configuración de envasado (pantalla de Configuración), paginado.
create function public.list_vacuum_config_products_page(
  p_search text default null,
  p_filter text default 'all',
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
  v_org uuid := app_private.require_permission('vacuum.configure');
  v_pattern text := case when app_private.import_normalize_text(p_search) is null then null
    else '%' || replace(replace(replace(app_private.import_normalize_text(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  if p_filter not in ('all', 'enabled', 'disabled') then raise exception 'Filtro inválido' using errcode = '22023'; end if;
  select count(*) into v_total
  from public.products p
  left join public.product_vacuum_settings s on s.product_id = p.id and s.organization_id = p.organization_id
  where p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT'
    and (p_filter = 'all' or (p_filter = 'enabled') = coalesce(s.enabled, false))
    and (v_pattern is null or app_private.import_normalize_text(p.name) like v_pattern escape '\' or lower(coalesce(p.sku, '')) like v_pattern escape '\');
  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', r.id, 'name', r.name, 'sku', r.sku, 'enabled', coalesce(r.enabled, false), 'shelfLifeDays', r.shelf_life_days,
    'plu', r.plu, 'conservationText', r.conservation_text
  ) order by lower(r.name), r.id), '[]'::jsonb) into v_rows
  from (
    select p.id, p.name, p.sku, s.enabled, s.shelf_life_days, s.plu, s.conservation_text
    from public.products p
    left join public.product_vacuum_settings s on s.product_id = p.id and s.organization_id = p.organization_id
    where p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT'
      and (p_filter = 'all' or (p_filter = 'enabled') = coalesce(s.enabled, false))
      and (v_pattern is null or app_private.import_normalize_text(p.name) like v_pattern escape '\' or lower(coalesce(p.sku, '')) like v_pattern escape '\')
    order by lower(p.name), p.id limit v_limit offset v_offset
  ) r;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: búsqueda de cortes y registro de paquetes
-- ---------------------------------------------------------------------------------------------

-- Búsqueda rápida: sólo cortes habilitados para envasar, por nombre, SKU o código de barras, con el precio/kg vigente de la sucursal.
create function public.search_vacuum_products(p_branch_id uuid, p_search text default null, p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  v_at timestamptz := clock_timestamp();
  v_text text := app_private.import_normalize_text(p_search);
  v_pattern text := case when v_text is null then null else '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_code text := app_private.normalize_barcode(p_search);
begin
  perform app_private.require_visible_branch(v_org, p_branch_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'productId', r.id, 'name', r.name, 'sku', r.sku, 'shelfLifeDays', r.shelf_life_days, 'plu', r.plu,
      'conservationText', r.conservation_text, 'pricePerKgCents', r.price_cents::text
    ) order by lower(r.name), r.id)
    from (
      select p.id, p.name, p.sku, s.shelf_life_days, s.plu, s.conservation_text,
        app_private.vacuum_price_per_kg(v_org, p.id, p_branch_id, v_at) as price_cents
      from public.products p
      join public.product_vacuum_settings s on s.product_id = p.id and s.organization_id = p.organization_id and s.enabled
      where p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT'
        and (v_pattern is null
          or app_private.import_normalize_text(p.name) like v_pattern escape '\'
          or lower(coalesce(p.sku, '')) like v_pattern escape '\'
          or (s.plu is not null and s.plu = btrim(p_search))
          or (v_code is not null and exists (select 1 from public.product_barcodes pb where pb.product_id = p.id and pb.organization_id = p.organization_id and pb.barcode like v_code || '%')))
      order by lower(p.name), p.id
      limit least(greatest(coalesce(p_limit, 20), 1), 50)
    ) r
  ), '[]'::jsonb);
end;
$$;

create function public.create_vacuum_package(
  p_branch_id uuid,
  p_product_id uuid,
  p_weight_grams integer,
  p_packed_on date,
  p_expires_on date default null,
  p_lot text default null,
  p_request_key uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.write');
  v_at timestamptz := clock_timestamp();
  v_tz text;
  v_today date;
  v_existing public.vacuum_packages%rowtype;
  v_branch public.branches%rowtype;
  v_product public.products%rowtype;
  v_pset public.product_vacuum_settings%rowtype;
  v_org_set public.organization_vacuum_settings%rowtype;
  v_price bigint;
  v_total bigint;
  v_expires date;
  v_ean text;
  v_lot text := nullif(upper(regexp_replace(btrim(coalesce(p_lot, '')), '\s+', '', 'g')), '');
  v_seq integer;
  v_conservation text;
  v_row public.vacuum_packages%rowtype;
begin
  perform app_private.require_visible_branch(v_org, p_branch_id);
  select * into v_branch from public.branches b where b.id = p_branch_id and b.organization_id = v_org;
  if not v_branch.active then raise exception 'La sucursal está inactiva' using errcode = '22023'; end if;

  if p_request_key is not null then
    select * into v_existing from public.vacuum_packages x where x.organization_id = v_org and x.request_key = p_request_key;
    if found then return app_private.vacuum_package_json(v_existing); end if;
  end if;

  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_today := (v_at at time zone coalesce(v_tz, 'UTC'))::date;
  if p_packed_on is null or p_packed_on < v_today - 366 or p_packed_on > v_today + 366 then
    raise exception 'La fecha de elaboración es inválida' using errcode = '22023';
  end if;
  if p_weight_grams is null or p_weight_grams not between 1 and 99999 then raise exception 'El peso tiene que estar entre 1 g y 99,999 kg' using errcode = '22023'; end if;

  select * into v_product from public.products p where p.id = p_product_id and p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT';
  if not found then raise exception 'Corte no encontrado' using errcode = '42501'; end if;
  select * into v_pset from public.product_vacuum_settings s where s.product_id = p_product_id and s.organization_id = v_org and s.enabled;
  if not found then raise exception 'El corte % no está habilitado para envasar', v_product.name using errcode = '22023'; end if;

  v_price := app_private.vacuum_price_per_kg(v_org, p_product_id, p_branch_id, v_at);
  if v_price is null or v_price <= 0 then raise exception 'El corte % no tiene un precio vigente', v_product.name using errcode = '22023'; end if;
  -- Mismo redondeo que el POS (priceForWeight): precio por kg × gramos / 1000, half-up en centavos.
  v_total := (v_price * p_weight_grams::bigint + 500) / 1000;
  if v_total <= 0 then raise exception 'El importe del paquete es cero' using errcode = '22023'; end if;

  -- Vencimiento: por defecto elaboración + vida útil configurada. Cambiarlo requiere permiso; sin vida útil configurada se carga a mano.
  if p_expires_on is null then
    if v_pset.shelf_life_days is null then raise exception 'El corte no tiene vida útil configurada: ingresá el vencimiento' using errcode = '22023'; end if;
    v_expires := p_packed_on + v_pset.shelf_life_days;
  else
    v_expires := p_expires_on;
    if v_pset.shelf_life_days is not null and v_expires <> p_packed_on + v_pset.shelf_life_days
       and not app_private.has_permission(v_org, 'vacuum.override_expiry') then
      raise exception 'No tenés permiso para cambiar el vencimiento configurado' using errcode = '42501';
    end if;
  end if;
  if v_expires < p_packed_on then raise exception 'El vencimiento no puede ser anterior a la elaboración' using errcode = '22023'; end if;

  select * into v_org_set from public.organization_vacuum_settings s where s.organization_id = v_org;
  if not found or v_org_set.ean_scheme is null then
    raise exception 'Falta configurar el esquema EAN-13 de envasados (Envasados → Configuración)' using errcode = '22023';
  end if;
  v_ean := app_private.vacuum_build_ean(v_org_set.ean_scheme, v_org_set.ean_prefix, v_org_set.ean_plu_digits, v_org_set.ean_value_digits,
    v_org_set.ean_value_step, v_pset.plu, v_total, p_weight_grams);

  -- Lote: único por organización y legible (SUCURSAL-AAMMDD-0001). Automático con contador por sucursal y día; editable.
  if v_lot is null then
    loop
      insert into public.vacuum_lot_counters (organization_id, branch_id, packed_on, last_seq) values (v_org, p_branch_id, p_packed_on, 1)
      on conflict (organization_id, branch_id, packed_on) do update set last_seq = public.vacuum_lot_counters.last_seq + 1
      returning last_seq into v_seq;
      v_lot := upper(v_branch.code) || '-' || to_char(p_packed_on, 'YYMMDD') || '-' || lpad(v_seq::text, 4, '0');
      exit when not exists (select 1 from public.vacuum_packages x where x.organization_id = v_org and x.lot = v_lot);
      v_lot := null;
    end loop;
  elsif v_lot !~ '^[A-Z0-9][A-Z0-9._/-]{2,39}$' then
    raise exception 'El lote tiene que tener entre 3 y 40 caracteres (letras, números, . _ / -)' using errcode = '22023';
  elsif exists (select 1 from public.vacuum_packages x where x.organization_id = v_org and x.lot = v_lot) then
    raise exception 'El lote % ya existe', v_lot using errcode = '23505';
  end if;

  v_conservation := coalesce(v_pset.conservation_text, v_org_set.default_conservation_text);
  insert into public.vacuum_packages (
    organization_id, branch_id, product_id, request_key, product_name_snapshot, product_sku_snapshot, weight_grams, price_per_kg_cents, total_cents,
    packed_on, expires_on, lot, ean13, shelf_life_days_snapshot, conservation_text_snapshot, label_snapshot, created_by
  ) values (
    v_org, p_branch_id, p_product_id, p_request_key, v_product.name, v_product.sku, p_weight_grams, v_price, v_total,
    p_packed_on, v_expires, v_lot, v_ean, v_pset.shelf_life_days, v_conservation,
    jsonb_build_object(
      'businessName', v_org_set.business_name, 'address', v_org_set.address, 'establishmentInfo', v_org_set.establishment_info,
      'extraText', v_org_set.extra_text, 'branchName', v_branch.name,
      'labelWidthMm', v_org_set.label_width_mm, 'infoHeightMm', v_org_set.info_height_mm, 'priceHeightMm', v_org_set.price_height_mm,
      'ean', jsonb_build_object('scheme', v_org_set.ean_scheme, 'prefix', v_org_set.ean_prefix, 'pluDigits', v_org_set.ean_plu_digits,
        'valueDigits', v_org_set.ean_value_digits, 'valueStep', v_org_set.ean_value_step, 'plu', v_pset.plu)
    ),
    auth.uid()
  ) returning * into v_row;
  return app_private.vacuum_package_json(v_row);
end;
$$;

create function public.get_vacuum_package(p_package_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_row public.vacuum_packages%rowtype;
begin
  select * into v_row from public.vacuum_packages x
  where x.id = p_package_id and x.organization_id = v_org and (v_vis is null or x.branch_id = any(v_vis));
  if not found then return null; end if;
  return app_private.vacuum_package_json(v_row);
end;
$$;

create function public.list_vacuum_packages_page(
  p_branch_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_product_id uuid default null,
  p_search text default null,
  p_limit integer default 30,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_text text := app_private.import_normalize_text(p_search);
  v_pattern text := case when v_text is null then null else '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_digits text := case when btrim(coalesce(p_search, '')) ~ '^[0-9]{13}$' then btrim(p_search) end;
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  if p_branch_id is not null then perform app_private.require_visible_branch(v_org, p_branch_id); end if;
  select count(*) into v_total
  from public.vacuum_packages x
  where x.organization_id = v_org and (v_vis is null or x.branch_id = any(v_vis))
    and (p_branch_id is null or x.branch_id = p_branch_id)
    and (p_from is null or x.packed_on >= p_from) and (p_to is null or x.packed_on <= p_to)
    and (p_product_id is null or x.product_id = p_product_id)
    and (v_pattern is null or lower(x.lot) like v_pattern escape '\' or app_private.import_normalize_text(x.product_name_snapshot) like v_pattern escape '\' or x.ean13 = v_digits);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'lot', r.lot, 'branchId', r.branch_id, 'branchName', r.branch_name, 'productId', r.product_id, 'productName', r.product_name_snapshot,
    'weightGrams', r.weight_grams, 'pricePerKgCents', r.price_per_kg_cents::text, 'totalCents', r.total_cents::text,
    'packedOn', r.packed_on, 'expiresOn', r.expires_on, 'ean13', r.ean13, 'createdAt', r.created_at,
    'printCount', coalesce(pr.prints, 0), 'lastPrintedAt', pr.last_printed_at
  ) order by r.created_at desc, r.id), '[]'::jsonb) into v_rows
  from (
    select x.*, b.name as branch_name
    from public.vacuum_packages x
    join public.branches b on b.id = x.branch_id and b.organization_id = x.organization_id
    where x.organization_id = v_org and (v_vis is null or x.branch_id = any(v_vis))
      and (p_branch_id is null or x.branch_id = p_branch_id)
      and (p_from is null or x.packed_on >= p_from) and (p_to is null or x.packed_on <= p_to)
      and (p_product_id is null or x.product_id = p_product_id)
      and (v_pattern is null or lower(x.lot) like v_pattern escape '\' or app_private.import_normalize_text(x.product_name_snapshot) like v_pattern escape '\' or x.ean13 = v_digits)
    order by x.created_at desc, x.id
    limit v_limit offset v_offset
  ) r
  left join lateral (
    select count(*) as prints, max(p.printed_at) as last_printed_at from public.vacuum_package_prints p where p.package_id = r.id
  ) pr on true;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

-- Registra una impresión (la primera o una reimpresión) de las etiquetas de un paquete.
create function public.record_vacuum_print(p_package_id uuid, p_kind text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.write');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_row public.vacuum_packages%rowtype;
  v_prints integer;
begin
  if p_kind not in ('INFO', 'PRICE', 'BOTH') then raise exception 'Tipo de etiqueta inválido' using errcode = '22023'; end if;
  select * into v_row from public.vacuum_packages x
  where x.id = p_package_id and x.organization_id = v_org and (v_vis is null or x.branch_id = any(v_vis));
  if not found then raise exception 'Paquete no encontrado' using errcode = '42501'; end if;
  select count(*) into v_prints from public.vacuum_package_prints p where p.package_id = v_row.id;
  insert into public.vacuum_package_prints (organization_id, branch_id, package_id, kind, reprint, printed_by)
  values (v_org, v_row.branch_id, v_row.id, p_kind, v_prints > 0, auth.uid());
  return jsonb_build_object('packageId', v_row.id, 'printCount', v_prints + 1);
end;
$$;

revoke all on function
  public.get_vacuum_settings(),
  public.save_vacuum_settings(text, text, text, text, text, numeric, numeric, numeric),
  public.save_vacuum_ean_scheme(text, text, integer, integer, integer),
  public.save_vacuum_product_config(uuid, boolean, integer, text, text),
  public.list_vacuum_config_products_page(text, text, integer, integer),
  public.search_vacuum_products(uuid, text, integer),
  public.create_vacuum_package(uuid, uuid, integer, date, date, text, uuid),
  public.get_vacuum_package(uuid),
  public.list_vacuum_packages_page(uuid, date, date, uuid, text, integer, integer),
  public.record_vacuum_print(uuid, text)
from public, anon;

grant execute on function
  public.get_vacuum_settings(),
  public.save_vacuum_settings(text, text, text, text, text, numeric, numeric, numeric),
  public.save_vacuum_ean_scheme(text, text, integer, integer, integer),
  public.save_vacuum_product_config(uuid, boolean, integer, text, text),
  public.list_vacuum_config_products_page(text, text, integer, integer),
  public.search_vacuum_products(uuid, text, integer),
  public.create_vacuum_package(uuid, uuid, integer, date, date, text, uuid),
  public.get_vacuum_package(uuid),
  public.list_vacuum_packages_page(uuid, date, date, uuid, text, integer, integer),
  public.record_vacuum_print(uuid, text)
to authenticated;

commit;
