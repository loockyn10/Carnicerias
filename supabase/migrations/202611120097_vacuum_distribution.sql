alter type public.stock_movement_type add value if not exists 'DISTRIBUTION_OUT';
alter type public.stock_movement_type add value if not exists 'DISTRIBUTION_RETURN';

begin;

-- Distribución a supermercados (D-093), parte 1 — operación mayorista. Se apoya en 202611010093 (Envasados), 202611070095 (estado de los paquetes y venta en
-- el POS) y 202611070096 (estación) y NO modifica ninguna de ellas: todo lo que cambia se reemplaza acá con `create or replace` / constraints nuevas.
--
-- MODELO (una sola contabilidad de inventario, ninguna paralela):
--   * La ubicación/estado físico de CADA paquete vive en `vacuum_package_state` (la tabla de la 095): se le agregan los estados RESERVED (en una entrega en
--     borrador), DISPATCHED (en un supermercado), SOLD_EXTERNAL (informado como vendido por el supermercado), QUARANTINE (devuelto, sin vender) y DISCARDED.
--     Un paquete tiene UN estado: no puede estar disponible en dos lugares. El POS sólo ofrece los AVAILABLE de su sucursal, así que ni reservados ni
--     despachados ni en cuarentena llegan a las cajas; si una caja offline igual los vendiera, se registra el conflicto `DISTRIBUTED` (nunca se pierde una venta).
--   * El stock en cantidades sigue siendo `stock_movements` (ledger append-only): confirmar una entrega escribe UN movimiento DISTRIBUTION_OUT por producto
--     (gramos reales, sucursal de origen) vinculado a la entrega y con índice único: confirmar dos veces no duplica. El reingreso aprobado de una devolución
--     (parte 2) escribe DISTRIBUTION_RETURN. Descartar/rechazar no mueve stock (ya salió al despachar).
--   * Movimiento físico, venta comercial, facturación y cobranza son cosas distintas: acá sólo el movimiento físico y el resultado comercial por paquete
--     (`outcome`: PENDING / SOLD_FIRM / SOLD_REPORTED / RETURNED). En venta mayorista firme la operación comercial ocurre al despachar (SOLD_FIRM); en
--     consignación despachar NO es vender (PENDING hasta que el supermercado informe). No hay facturación ni cobranza en esta etapa.
--   * Clientes: `poultry_customers` es específico del módulo avícola (listas de precios de pollo), por eso no se reutiliza: `distribution_clients` (empresa) y
--     `distribution_sites` (establecimientos, que NO son las sucursales internas de la organización).
--   * Identificador logístico por paquete: tabla aparte (`vacuum_package_logistics`, 1 a 1 con `vacuum_packages`, que es inmutable), código de 9 caracteres
--     (8 aleatorios + 1 de control, alfabeto sin I/L/O/U) único por organización. El EAN-13 comercial NO cambia ni se mezcla con él.

-- ---------------------------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------------------------
insert into public.permissions (key, description) values
  ('distribution.read', 'Read the wholesale distribution module: supermarkets, deliveries, reconciliation and returns'),
  ('distribution.write', 'Manage supermarkets, prepare and confirm deliveries, report sales and register/receive returns'),
  ('distribution.approve_reentry', 'Decide on a returned package: approve its re-entry to stock, reject it or discard it')
on conflict (key) do nothing;
insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-4000-8000-000000000001', 'distribution.read'),
  ('10000000-0000-4000-8000-000000000001', 'distribution.write'),
  ('10000000-0000-4000-8000-000000000001', 'distribution.approve_reentry')
on conflict (role_id, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Funciones puras: CUIT y código logístico
-- ---------------------------------------------------------------------------------------------
create function app_private.cuit_is_valid(p text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
  w integer[] := array[5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  s integer := 0;
  i integer;
  r integer;
begin
  if d !~ '^[0-9]{11}$' then return false; end if;
  for i in 1..10 loop s := s + substr(d, i, 1)::integer * w[i]; end loop;
  r := 11 - (s % 11);
  if r = 10 then return false; end if;
  return (case when r = 11 then 0 else r end) = substr(d, 11, 1)::integer;
end;
$$;

-- Alfabeto de Crockford (sin I, L, O, U): sin confusiones al leer o tipear.
create function app_private.logistic_code_normalize(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select translate(upper(regexp_replace(coalesce(p, ''), '[\s-]', '', 'g')), 'OIL', '011') $$;

create function app_private.logistic_code_check_char(p_body text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_sum integer := 0;
  i integer;
begin
  if p_body is null or p_body !~ '^[0-9A-HJKMNP-TV-Z]{8}$' then
    raise exception 'Se esperaban 8 caracteres del alfabeto logístico' using errcode = '22023';
  end if;
  for i in 1..8 loop v_sum := v_sum + (strpos(v_alphabet, substr(p_body, i, 1)) - 1) * i; end loop;
  return substr(v_alphabet, (v_sum % 31) + 1, 1);
end;
$$;

create function app_private.logistic_code_is_valid(p text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or p !~ '^[0-9A-HJKMNP-TV-Z]{9}$' then return false; end if;
  return substr(p, 9, 1) = app_private.logistic_code_check_char(substr(p, 1, 8));
end;
$$;

create function app_private.logistic_code_generate()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bits bit(40) := ('x' || substr(replace(extensions.gen_random_uuid()::text, '-', ''), 1, 10))::bit(40);
  v_body text := '';
  i integer;
begin
  for i in 0..7 loop v_body := v_body || substr(v_alphabet, (substring(v_bits from i * 5 + 1 for 5)::integer) + 1, 1); end loop;
  return v_body || app_private.logistic_code_check_char(v_body);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Identificador logístico de cada paquete
-- ---------------------------------------------------------------------------------------------
create table public.vacuum_package_logistics (
  package_id uuid primary key,
  organization_id uuid not null,
  code text not null check (app_private.logistic_code_is_valid(code)),
  created_at timestamptz not null default now(),
  foreign key (package_id, organization_id) references public.vacuum_packages(id, organization_id) on delete cascade,
  unique (organization_id, code)
);

create function app_private.assign_logistic_code(p_package_id uuid, p_org uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  select l.code into v_code from public.vacuum_package_logistics l where l.package_id = p_package_id;
  if found then return v_code; end if;
  loop
    v_code := app_private.logistic_code_generate();
    insert into public.vacuum_package_logistics (package_id, organization_id, code) values (p_package_id, p_org, v_code) on conflict (organization_id, code) do nothing;
    exit when found;
  end loop;
  return v_code;
end;
$$;

create function app_private.vacuum_package_assign_logistic_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assign_logistic_code(new.id, new.organization_id);
  return new;
end;
$$;
create trigger vacuum_packages_assign_logistic_code after insert on public.vacuum_packages for each row execute function app_private.vacuum_package_assign_logistic_code();

-- Paquetes que ya existieran: reciben su código.
do $$
declare r record;
begin
  for r in select p.id, p.organization_id from public.vacuum_packages p loop
    perform app_private.assign_logistic_code(r.id, r.organization_id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Supermercados: clientes (empresas) y establecimientos
-- ---------------------------------------------------------------------------------------------
create table public.distribution_clients (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  trade_name text not null check (char_length(btrim(trade_name)) between 1 and 160),
  legal_name text check (legal_name is null or char_length(btrim(legal_name)) between 1 and 200),
  tax_id text check (tax_id is null or app_private.cuit_is_valid(tax_id)),
  -- Modalidad por defecto de sus establecimientos (cada uno puede tener la suya).
  commercial_mode text not null check (commercial_mode in ('WHOLESALE', 'CONSIGNMENT')),
  notes text check (notes is null or char_length(btrim(notes)) between 1 and 1000),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index distribution_clients_name_uq on public.distribution_clients (organization_id, (app_private.import_normalize_text(trade_name)));
create unique index distribution_clients_tax_uq on public.distribution_clients (organization_id, tax_id) where tax_id is not null;
create trigger distribution_clients_set_updated_at before update on public.distribution_clients for each row execute function app_private.set_updated_at();
create trigger distribution_clients_audit after insert or update on public.distribution_clients for each row execute function app_private.audit_row_change();

create table public.distribution_sites (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  address text check (address is null or char_length(btrim(address)) between 1 and 240),
  city text check (city is null or char_length(btrim(city)) between 1 and 120),
  phone text check (phone is null or char_length(btrim(phone)) between 1 and 60),
  contact_name text check (contact_name is null or char_length(btrim(contact_name)) between 1 and 160),
  notes text check (notes is null or char_length(btrim(notes)) between 1 and 1000),
  -- 1 = lunes … 7 = domingo.
  restock_weekday smallint check (restock_weekday is null or restock_weekday between 1 and 7),
  -- null = la modalidad del cliente.
  commercial_mode text check (commercial_mode is null or commercial_mode in ('WHOLESALE', 'CONSIGNMENT')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (client_id, organization_id) references public.distribution_clients(id, organization_id) on delete restrict
);
create unique index distribution_sites_name_uq on public.distribution_sites (organization_id, client_id, (app_private.import_normalize_text(name)));
create index distribution_sites_client_idx on public.distribution_sites (organization_id, client_id);
create trigger distribution_sites_set_updated_at before update on public.distribution_sites for each row execute function app_private.set_updated_at();
create trigger distribution_sites_audit after insert or update on public.distribution_sites for each row execute function app_private.audit_row_change();

-- ---------------------------------------------------------------------------------------------
-- Entregas
-- ---------------------------------------------------------------------------------------------
create table public.distribution_delivery_counters (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  last_number bigint not null default 0
);

create table public.distribution_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Sucursal INTERNA de la organización desde donde sale la mercadería (la de producción por defecto).
  origin_branch_id uuid not null,
  site_id uuid not null,
  number bigint not null,
  request_key uuid,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'CONFIRMED', 'CANCELLED')),
  delivery_date date not null,
  -- Modalidad vigente al crear la entrega (snapshot: cambiar el acuerdo después no reescribe entregas hechas).
  commercial_mode text not null check (commercial_mode in ('WHOLESALE', 'CONSIGNMENT')),
  reference_delivery_id uuid,
  notes text check (notes is null or char_length(btrim(notes)) between 1 and 1000),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or char_length(btrim(cancel_reason)) between 3 and 300),
  -- Totales y datos del destinatario CONGELADOS al confirmar (el remito se arma desde acá).
  package_count integer,
  total_grams bigint,
  total_cents bigint,
  recipient_snapshot jsonb,
  unique (id, organization_id),
  unique (organization_id, number),
  foreign key (origin_branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  foreign key (site_id, organization_id) references public.distribution_sites(id, organization_id) on delete restrict,
  foreign key (reference_delivery_id, organization_id) references public.distribution_deliveries(id, organization_id) on delete restrict,
  check ((status = 'CONFIRMED') = (confirmed_at is not null)),
  check ((status = 'CANCELLED') = (cancelled_at is not null)),
  check (status <> 'CONFIRMED' or (package_count is not null and total_grams is not null and total_cents is not null and recipient_snapshot is not null))
);
create unique index distribution_deliveries_request_key_uq on public.distribution_deliveries (organization_id, request_key) where request_key is not null;
create index distribution_deliveries_site_idx on public.distribution_deliveries (organization_id, site_id, delivery_date desc);
create index distribution_deliveries_status_idx on public.distribution_deliveries (organization_id, status, delivery_date desc);
create trigger distribution_deliveries_audit after insert or update on public.distribution_deliveries for each row execute function app_private.audit_row_change();

create table public.distribution_delivery_items (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  delivery_id uuid not null,
  package_id uuid not null,
  -- Peso y precio comercial del paquete al agregarlo (snapshot).
  weight_grams integer not null check (weight_grams > 0),
  unit_cents bigint not null check (unit_cents > 0),
  -- Resultado comercial: PENDING (consignación a la espera), SOLD_FIRM (venta mayorista firme al despachar), SOLD_REPORTED (el supermercado informó
  -- ESTE paquete como vendido) o RETURNED (volvió a Central). Las ventas informadas sólo por cantidad NO se reparten acá: ver conciliación.
  outcome text not null default 'PENDING' check (outcome in ('PENDING', 'SOLD_FIRM', 'SOLD_REPORTED', 'RETURNED')),
  sold_on date,
  sold_reported_by uuid references public.profiles(id) on delete set null,
  sold_reported_at timestamptz,
  -- Se cierra cuando el paquete sale del circuito de esa entrega (informado vendido o recibido de vuelta).
  closed_at timestamptz,
  added_by uuid references public.profiles(id) on delete set null,
  added_at timestamptz not null default now(),
  unique (delivery_id, package_id),
  foreign key (delivery_id, organization_id) references public.distribution_deliveries(id, organization_id) on delete restrict,
  foreign key (package_id, organization_id) references public.vacuum_packages(id, organization_id) on delete restrict
);
-- Garantía dura contra duplicados: un paquete sólo puede estar en UNA entrega abierta a la vez.
create unique index distribution_items_open_package_uq on public.distribution_delivery_items (package_id) where closed_at is null;
create index distribution_items_delivery_idx on public.distribution_delivery_items (delivery_id);

-- ---------------------------------------------------------------------------------------------
-- Estado del paquete: ubicaciones nuevas (misma tabla que el POS) y eventos
-- ---------------------------------------------------------------------------------------------
alter table public.vacuum_package_state drop constraint vacuum_package_state_status_check;
alter table public.vacuum_package_state add constraint vacuum_package_state_status_check
  check (status in ('AVAILABLE', 'SOLD', 'VOIDED', 'RESERVED', 'DISPATCHED', 'SOLD_EXTERNAL', 'QUARANTINE', 'DISCARDED'));
alter table public.vacuum_package_state add column distribution_delivery_id uuid;
alter table public.vacuum_package_state
  add constraint vacuum_package_state_delivery_fk foreign key (distribution_delivery_id, organization_id) references public.distribution_deliveries(id, organization_id) on delete restrict,
  add constraint vacuum_package_state_delivery_shape check ((status in ('RESERVED', 'DISPATCHED', 'SOLD_EXTERNAL')) = (distribution_delivery_id is not null));
create index vacuum_package_state_delivery_idx on public.vacuum_package_state (distribution_delivery_id) where distribution_delivery_id is not null;

alter table public.vacuum_package_events drop constraint vacuum_package_events_kind_check;
alter table public.vacuum_package_events add constraint vacuum_package_events_kind_check
  check (kind in ('CREATED', 'MOVED', 'SOLD', 'RELEASED', 'VOIDED', 'CONFLICT', 'CONFLICT_RESOLVED',
    'RESERVED', 'UNRESERVED', 'DISPATCHED', 'SOLD_EXTERNAL', 'RETURN_RECEIVED', 'RETURN_REJECTED', 'REENTERED', 'DISCARDED'));

alter table public.vacuum_package_conflicts drop constraint vacuum_package_conflicts_reason_check;
alter table public.vacuum_package_conflicts add constraint vacuum_package_conflicts_reason_check
  check (reason in ('ALREADY_SOLD', 'VOIDED', 'WRONG_BRANCH', 'RESTORE_UNAVAILABLE', 'DISTRIBUTED'));

alter table public.vacuum_package_prints drop constraint vacuum_package_prints_kind_check;
alter table public.vacuum_package_prints add constraint vacuum_package_prints_kind_check check (kind in ('INFO', 'PRICE', 'BOTH', 'LOGISTIC'));

-- ---------------------------------------------------------------------------------------------
-- Stock: dos tipos nuevos del MISMO ledger, vinculados a la entrega
-- ---------------------------------------------------------------------------------------------
alter table public.stock_movements add column distribution_delivery_id uuid;
alter table public.stock_movements
  add constraint stock_movements_distribution_delivery_fk foreign key (distribution_delivery_id, organization_id) references public.distribution_deliveries(id, organization_id) on delete restrict;
alter table public.stock_movements drop constraint stock_movements_type_sign_check;
alter table public.stock_movements add constraint stock_movements_type_sign_check check (
  (type in ('PURCHASE', 'ADJUSTMENT_POSITIVE', 'TRANSFER_IN', 'RETURN', 'PRODUCTION_YIELD', 'OPENING_BALANCE', 'DISTRIBUTION_RETURN') and quantity_grams > 0)
  or (type in ('SALE', 'WASTE', 'ADJUSTMENT_NEGATIVE', 'TRANSFER_OUT', 'PRODUCTION_CONSUME', 'DISTRIBUTION_OUT') and quantity_grams < 0)
);
alter table public.stock_movements add constraint stock_movements_distribution_out_link_check check ((type = 'DISTRIBUTION_OUT') = (distribution_delivery_id is not null));
-- Un solo movimiento DISTRIBUTION_OUT por producto y entrega: confirmar dos veces (o dos pedidos simultáneos) no duplica el descuento.
create unique index stock_movements_distribution_out_uq on public.stock_movements (distribution_delivery_id, product_id) where type = 'DISTRIBUTION_OUT';
comment on column public.stock_movements.distribution_delivery_id is 'Set only for DISTRIBUTION_OUT rows written by confirm_distribution_delivery.';

-- ---------------------------------------------------------------------------------------------
-- RLS (lectura). Escritura sólo por RPC.
-- ---------------------------------------------------------------------------------------------
alter table public.vacuum_package_logistics enable row level security;
alter table public.distribution_clients enable row level security;
alter table public.distribution_sites enable row level security;
alter table public.distribution_deliveries enable row level security;
alter table public.distribution_delivery_items enable row level security;
alter table public.distribution_delivery_counters enable row level security;

create policy vacuum_package_logistics_select on public.vacuum_package_logistics for select to authenticated
using (app_private.has_permission(organization_id, 'vacuum.read'));
create policy distribution_clients_select on public.distribution_clients for select to authenticated
using (app_private.has_permission(organization_id, 'distribution.read'));
create policy distribution_sites_select on public.distribution_sites for select to authenticated
using (app_private.has_permission(organization_id, 'distribution.read'));
create policy distribution_deliveries_select on public.distribution_deliveries for select to authenticated
using (app_private.has_permission(organization_id, 'distribution.read') and (app_private.has_permission(organization_id, 'branches.read_all') or app_private.is_branch_member(origin_branch_id)));
create policy distribution_delivery_items_select on public.distribution_delivery_items for select to authenticated
using (
  app_private.has_permission(organization_id, 'distribution.read')
  and exists (
    select 1 from public.distribution_deliveries d
    where d.id = delivery_id and d.organization_id = distribution_delivery_items.organization_id
      and (app_private.has_permission(d.organization_id, 'branches.read_all') or app_private.is_branch_member(d.origin_branch_id))
  )
);

revoke all on table
  public.vacuum_package_logistics, public.distribution_clients, public.distribution_sites, public.distribution_deliveries, public.distribution_delivery_items, public.distribution_delivery_counters
from public, anon, authenticated;
grant select on table
  public.vacuum_package_logistics, public.distribution_clients, public.distribution_sites, public.distribution_deliveries, public.distribution_delivery_items
to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Funciones de 093 / 095 reemplazadas con cambios mínimos
-- ---------------------------------------------------------------------------------------------
-- El paquete (JSON que consumen la estación, las etiquetas y el historial) lleva ahora su código logístico y la entrega donde está.
create or replace function app_private.vacuum_package_json(p public.vacuum_packages)
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
    'printCount', (select count(*) from public.vacuum_package_prints x where x.package_id = p.id),
    'computedTotalCents', p.computed_total_cents::text, 'chargeCents', app_private.vacuum_package_charge_cents(p)::text,
    'status', (select s.status from public.vacuum_package_state s where s.package_id = p.id),
    'currentBranchId', (select s.current_branch_id from public.vacuum_package_state s where s.package_id = p.id),
    'logisticCode', (select l.code from public.vacuum_package_logistics l where l.package_id = p.id)
  );
$$;

create or replace function public.record_vacuum_print(p_package_id uuid, p_kind text)
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
  if p_kind not in ('INFO', 'PRICE', 'BOTH', 'LOGISTIC') then raise exception 'Tipo de etiqueta inválido' using errcode = '22023'; end if;
  select * into v_row from public.vacuum_packages x
  where x.id = p_package_id and x.organization_id = v_org and (v_vis is null or x.branch_id = any(v_vis));
  if not found then raise exception 'Paquete no encontrado' using errcode = '42501'; end if;
  select count(*) into v_prints from public.vacuum_package_prints p where p.package_id = v_row.id;
  insert into public.vacuum_package_prints (organization_id, branch_id, package_id, kind, reprint, printed_by)
  values (v_org, v_row.branch_id, v_row.id, p_kind, v_prints > 0, auth.uid());
  return jsonb_build_object('packageId', v_row.id, 'printCount', v_prints + 1);
end;
$$;

-- sync_vacuum_package_line (095) con UN cambio: un paquete que no está AVAILABLE ni SOLD/VOIDED (distribución) produce el conflicto DISTRIBUTED en vez de pasar en silencio.
create or replace function app_private.sync_vacuum_package_line(
  p_org_id uuid, p_branch_id uuid, p_sale_id uuid, p_device_id uuid, p_profile_id uuid,
  p_method public.payment_method, p_completed_at timestamptz, p_item jsonb, p_movement jsonb
)
returns table (o_subtotal bigint, o_grams integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item_id uuid; v_product_id uuid; v_package_id uuid; v_ean text; v_fixed bigint; v_bps integer;
  v_subtotal bigint; v_surcharge bigint; v_grams integer; v_list_price bigint; v_final_price bigint; v_name text;
  v_cash_discount bigint; v_discount bigint; v_promo_discount bigint;
  v_pkg public.vacuum_packages%rowtype; v_state public.vacuum_package_state%rowtype;
  v_cost bigint; v_profit integer; v_reason text; v_expected_subtotal bigint;
begin
  begin
    v_item_id := (p_item ->> 'id')::uuid; v_product_id := (p_item ->> 'productId')::uuid; v_package_id := (p_item ->> 'vacuumPackageId')::uuid;
    v_ean := p_item ->> 'vacuumEan13'; v_fixed := (p_item ->> 'vacuumPackageTotalCents')::bigint;
    v_bps := coalesce(nullif(p_item ->> 'cashDiscountBps', '')::integer, 0);
    v_subtotal := (p_item ->> 'subtotalCents')::bigint; v_surcharge := coalesce(nullif(p_item ->> 'cardSurchargeCents', '')::bigint, 0);
    v_grams := (p_item ->> 'weightGrams')::integer; v_final_price := (p_item ->> 'pricePerKgCents')::bigint;
    v_list_price := coalesce(nullif(p_item ->> 'originalPricePerKgCents', '')::bigint, v_final_price);
    v_name := p_item ->> 'productNameSnapshot';
    v_cash_discount := coalesce(nullif(p_item ->> 'cashDiscountCents', '')::bigint, 0);
    v_discount := coalesce(nullif(p_item ->> 'discountCents', '')::bigint, 0);
    v_promo_discount := coalesce(nullif(p_item ->> 'promotionDiscountCents', '')::bigint, 0);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Offline vacuum package line is malformed' using errcode = '22023';
  end;
  if v_item_id is null or v_product_id is null or v_package_id is null or v_ean is null or v_fixed is null or v_subtotal is null
     or v_grams is null or v_grams <= 0 or v_final_price is null or v_final_price <= 0 or v_list_price <= 0 or v_name is null then
    raise exception 'Offline vacuum package line is incomplete' using errcode = '22023';
  end if;
  -- Un paquete tiene importe fijo: ni cantidad por unidades, ni precio manual, ni Pack, ni promociones ni descuentos de línea.
  if exists (
    select 1 from jsonb_each(p_item) e
    where e.key in ('quantityUnits', 'manualPriceApplied', 'manualUnitPriceCents', 'manualAdjustmentCents', 'soldAsPack', 'packCount',
        'packSizeUnitsSnapshot', 'packDiscountBps', 'packDiscountCents', 'packConfigId', 'branchPromotionId', 'branchPromotionEveryUnits',
        'branchPromotionMinimumUnits', 'branchPromotionDiscountBps', 'branchPromotionDiscountedUnits', 'branchPromotionDiscountCents',
        'discountRuleId', 'discountType', 'discountValue', 'promotionMode')
      and e.value <> 'null'::jsonb and e.value <> 'false'::jsonb
  ) or v_cash_discount <> 0 or v_discount <> 0 or v_promo_discount <> 0 then
    raise exception 'Offline vacuum package line cannot carry discounts, promotions or a manual price' using errcode = '22023';
  end if;
  -- El único ajuste posible es el recargo de tarjeta (D-044), con una configuración que la organización haya tenido al venderse.
  if v_bps not between 0 and 9999 or (app_private.payment_method_receives_discount(p_method) and v_bps <> 0) then
    raise exception 'Offline vacuum package line has an invalid surcharge' using errcode = '22023';
  end if;
  if not app_private.payment_method_receives_discount(p_method) and not app_private.card_surcharge_bps_was_valid(p_org_id, v_bps, p_completed_at) then
    raise exception 'Offline card surcharge does not match the commercial configuration of the sale' using errcode = '22023';
  end if;

  select * into v_pkg from public.vacuum_packages x where x.id = v_package_id and x.organization_id = p_org_id for update;
  if not found then raise exception 'Offline vacuum package does not belong to the device organization' using errcode = '42501'; end if;
  if v_pkg.product_id <> v_product_id or v_pkg.weight_grams <> v_grams or v_pkg.ean13 <> v_ean then
    raise exception 'Offline vacuum package line does not match the registered package' using errcode = '22023';
  end if;
  -- El importe de la línea ES el del paquete: nunca precio/kg × peso (el precio/kg pudo cambiar desde que se envasó).
  if v_fixed <> app_private.vacuum_package_charge_cents(v_pkg) then
    raise exception 'Offline vacuum package amount does not match the registered package' using errcode = '22023';
  end if;
  v_expected_subtotal := case when v_bps > 0 then app_private.round_ratio_half_up(v_fixed * (10000 + v_bps), 10000) else v_fixed end;
  if v_subtotal <> v_expected_subtotal or v_surcharge <> v_subtotal - v_fixed
     or v_list_price <> app_private.round_ratio_half_up(v_fixed * 1000, v_grams)
     or v_final_price <> app_private.round_ratio_half_up(v_subtotal * 1000, v_grams) then
    raise exception 'Offline vacuum package arithmetic is invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from public.products p where p.id = v_product_id and p.organization_id = p_org_id and p.unit_type = 'WEIGHT') then
    raise exception 'Offline sale product does not belong to the device organization' using errcode = '42501';
  end if;
  if (p_movement ->> 'productId')::uuid <> v_product_id or (p_movement ->> 'quantityGrams')::bigint <> -v_grams::bigint then
    raise exception 'Offline stock movement does not match its sale item' using errcode = '22023';
  end if;

  select c.cost_cents into v_cost from public.product_costs c
  where c.organization_id = p_org_id and c.product_id = v_product_id and c.valid_from <= p_completed_at and (c.valid_to is null or c.valid_to > p_completed_at)
  order by c.valid_from desc limit 1;
  select s.profit_markup_bps into v_profit from public.product_pricing_settings s
  where s.organization_id = p_org_id and s.product_id = v_product_id and s.valid_from <= p_completed_at and (s.valid_to is null or s.valid_to > p_completed_at)
  order by s.valid_from desc limit 1;

  insert into public.sale_items(
    id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents,
    original_price_per_kg_cents, final_price_per_kg_cents, discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents,
    promotion_discount_cents, cost_cents_snapshot, profit_markup_bps_snapshot, subtotal_cents, created_at, vacuum_package_id, vacuum_ean13
  ) values (
    v_item_id, p_sale_id, p_org_id, p_branch_id, v_product_id, v_name, v_grams, v_final_price,
    v_list_price, v_final_price, 0, v_bps, 0, v_surcharge,
    0, v_cost, v_profit, v_subtotal, p_completed_at, v_package_id, v_ean
  );
  -- Un único movimiento SALE por línea, con los gramos REALES del paquete (envasar nunca descontó).
  insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
  values ((p_movement ->> 'id')::uuid, p_org_id, p_branch_id, v_product_id, 'SALE', -v_grams::bigint, p_sale_id, p_profile_id, (p_movement ->> 'occurredAt')::timestamptz, p_completed_at);

  -- Reclamo del paquete. El paquete está bloqueado (for update): dos cajas que sincronizan a la vez se serializan acá.
  select * into v_state from public.vacuum_package_state s where s.package_id = v_package_id for update;
  v_reason := case
    when v_state.status = 'SOLD' then 'ALREADY_SOLD'
    when v_state.status = 'VOIDED' then 'VOIDED'
    -- Reservado, despachado a un supermercado, en cuarentena o descartado: no es de la caja (se registra la venta igual, con su conflicto).
    when v_state.status <> 'AVAILABLE' then 'DISTRIBUTED'
    when v_state.current_branch_id <> p_branch_id then 'WRONG_BRANCH'
  end;
  if v_state.status = 'AVAILABLE' then
    update public.vacuum_package_state set status = 'SOLD', sold_sale_id = p_sale_id, sold_sale_item_id = v_item_id, sold_at = p_completed_at, updated_at = now()
    where package_id = v_package_id;
    insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, sale_id, sale_item_id, created_by)
    values (p_org_id, v_package_id, p_branch_id, 'SOLD', p_sale_id, v_item_id, p_profile_id);
  end if;
  if v_reason is not null then
    insert into public.vacuum_package_conflicts (organization_id, branch_id, package_id, sale_id, sale_item_id, device_id, reason, first_sale_id)
    values (p_org_id, p_branch_id, v_package_id, p_sale_id, v_item_id, p_device_id, v_reason, case when v_state.status = 'SOLD' then v_state.sold_sale_id end);
    insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, sale_id, sale_item_id, note, created_by)
    values (p_org_id, v_package_id, p_branch_id, 'CONFLICT', p_sale_id, v_item_id, v_reason, p_profile_id);
  end if;

  o_subtotal := v_subtotal; o_grams := v_grams;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Helpers privados
-- ---------------------------------------------------------------------------------------------
create function app_private.dist_package_event(p_org uuid, p_package uuid, p_branch uuid, p_kind text, p_note text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, note, created_by) values (p_org, p_package, p_branch, p_kind, p_note, auth.uid());
$$;

create function app_private.dist_number_label(p_number bigint)
returns text
language sql
immutable
set search_path = ''
as $$ select 'E-' || lpad(p_number::text, 6, '0') $$;

-- Reserva un paquete para una entrega en borrador. Bloquea el estado del paquete: dos pedidos simultáneos se serializan y el segundo ve RESERVED.
-- Devuelve false si ya estaba en ESTA entrega (idempotente).
create function app_private.dist_reserve_package(p_org uuid, p_delivery public.distribution_deliveries, p_package_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pkg public.vacuum_packages%rowtype;
  v_state public.vacuum_package_state%rowtype;
  v_code text;
begin
  select * into v_pkg from public.vacuum_packages x where x.id = p_package_id and x.organization_id = p_org;
  if not found then raise exception 'Paquete no encontrado' using errcode = '42501'; end if;
  select * into v_state from public.vacuum_package_state s where s.package_id = p_package_id for update;
  select l.code into v_code from public.vacuum_package_logistics l where l.package_id = p_package_id;
  if v_state.status = 'RESERVED' and v_state.distribution_delivery_id = p_delivery.id then return false; end if;
  if v_state.status <> 'AVAILABLE' then
    raise exception 'El paquete % (lote %) no está disponible para distribuir (estado: %)', coalesce(v_code, p_package_id::text), v_pkg.lot, v_state.status using errcode = '22023';
  end if;
  if v_state.current_branch_id <> p_delivery.origin_branch_id then
    raise exception 'El paquete % (lote %) está en otra sucursal', coalesce(v_code, p_package_id::text), v_pkg.lot using errcode = '22023';
  end if;
  if v_pkg.expires_on < p_delivery.delivery_date then
    raise exception 'El paquete % (lote %) vence el %, antes de la fecha de entrega', coalesce(v_code, p_package_id::text), v_pkg.lot, to_char(v_pkg.expires_on, 'DD/MM/YYYY') using errcode = '22023';
  end if;
  insert into public.distribution_delivery_items (organization_id, delivery_id, package_id, weight_grams, unit_cents, added_by)
  values (p_org, p_delivery.id, p_package_id, v_pkg.weight_grams, app_private.vacuum_package_charge_cents(v_pkg), auth.uid());
  update public.vacuum_package_state set status = 'RESERVED', distribution_delivery_id = p_delivery.id, updated_at = now() where package_id = p_package_id;
  perform app_private.dist_package_event(p_org, p_package_id, p_delivery.origin_branch_id, 'RESERVED', app_private.dist_number_label(p_delivery.number));
  return true;
end;
$$;

-- Entrega bloqueada para modificar, validando organización y que siga en borrador.
create function app_private.dist_draft_for_update(p_org uuid, p_delivery_id uuid)
returns public.distribution_deliveries
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d public.distribution_deliveries%rowtype;
begin
  select * into v_d from public.distribution_deliveries d where d.id = p_delivery_id and d.organization_id = p_org for update;
  if not found then raise exception 'Entrega no encontrada' using errcode = '42501'; end if;
  perform app_private.require_visible_branch(p_org, v_d.origin_branch_id);
  if v_d.status <> 'DRAFT' then raise exception 'La entrega % ya no es un borrador (%)', app_private.dist_number_label(v_d.number), v_d.status using errcode = '22023'; end if;
  return v_d;
end;
$$;

create function app_private.distribution_delivery_json(p_d public.distribution_deliveries, p_with_items boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_site public.distribution_sites%rowtype;
  v_client public.distribution_clients%rowtype;
  v_items jsonb := '[]'::jsonb;
  v_count integer; v_grams bigint; v_cents bigint;
begin
  select * into v_site from public.distribution_sites s where s.id = p_d.site_id and s.organization_id = p_d.organization_id;
  select * into v_client from public.distribution_clients c where c.id = v_site.client_id and c.organization_id = p_d.organization_id;
  select count(*), coalesce(sum(i.weight_grams), 0), coalesce(sum(i.unit_cents), 0) into v_count, v_grams, v_cents from public.distribution_delivery_items i where i.delivery_id = p_d.id;
  if p_with_items then
    select coalesce(jsonb_agg(jsonb_build_object(
      'itemId', i.id, 'packageId', i.package_id, 'logisticCode', l.code, 'productId', p.product_id, 'productName', p.product_name_snapshot,
      'weightGrams', i.weight_grams, 'unitCents', i.unit_cents::text, 'lot', p.lot, 'packedOn', p.packed_on, 'expiresOn', p.expires_on, 'ean13', p.ean13,
      'outcome', i.outcome, 'soldOn', i.sold_on, 'closedAt', i.closed_at
    ) order by p.product_name_snapshot, p.lot, p.id), '[]'::jsonb) into v_items
    from public.distribution_delivery_items i
    join public.vacuum_packages p on p.id = i.package_id and p.organization_id = i.organization_id
    left join public.vacuum_package_logistics l on l.package_id = p.id
    where i.delivery_id = p_d.id;
  end if;
  return jsonb_build_object(
    'id', p_d.id, 'number', p_d.number, 'numberLabel', app_private.dist_number_label(p_d.number), 'status', p_d.status, 'deliveryDate', p_d.delivery_date,
    'commercialMode', p_d.commercial_mode, 'referenceDeliveryId', p_d.reference_delivery_id, 'notes', p_d.notes,
    'originBranchId', p_d.origin_branch_id, 'originBranchName', (select b.name from public.branches b where b.id = p_d.origin_branch_id and b.organization_id = p_d.organization_id),
    'site', jsonb_build_object('id', v_site.id, 'name', v_site.name, 'address', v_site.address, 'city', v_site.city, 'phone', v_site.phone, 'contactName', v_site.contact_name),
    'client', jsonb_build_object('id', v_client.id, 'tradeName', v_client.trade_name, 'legalName', v_client.legal_name, 'taxId', v_client.tax_id),
    'recipient', p_d.recipient_snapshot,
    'packageCount', coalesce(p_d.package_count, v_count), 'totalGrams', coalesce(p_d.total_grams, v_grams)::text, 'totalCents', coalesce(p_d.total_cents, v_cents)::text,
    'createdBy', (select pr.display_name from public.profiles pr where pr.id = p_d.created_by), 'createdAt', p_d.created_at,
    'confirmedBy', (select pr.display_name from public.profiles pr where pr.id = p_d.confirmed_by), 'confirmedAt', p_d.confirmed_at,
    'cancelledAt', p_d.cancelled_at, 'cancelReason', p_d.cancel_reason,
    'items', v_items
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: supermercados
-- ---------------------------------------------------------------------------------------------
create function public.save_distribution_client(
  p_id uuid default null,
  p_trade_name text default null,
  p_legal_name text default null,
  p_tax_id text default null,
  p_commercial_mode text default 'CONSIGNMENT',
  p_notes text default null,
  p_active boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_name text := nullif(btrim(coalesce(p_trade_name, '')), '');
  v_tax text := nullif(regexp_replace(coalesce(p_tax_id, ''), '[^0-9]', '', 'g'), '');
  v_row public.distribution_clients%rowtype;
begin
  if v_name is null then raise exception 'Ingresá el nombre comercial' using errcode = '22023'; end if;
  if p_commercial_mode not in ('WHOLESALE', 'CONSIGNMENT') then raise exception 'Modalidad comercial inválida' using errcode = '22023'; end if;
  if v_tax is not null and not app_private.cuit_is_valid(v_tax) then raise exception 'El CUIT no es válido' using errcode = '22023'; end if;
  begin
    if p_id is null then
      insert into public.distribution_clients (organization_id, trade_name, legal_name, tax_id, commercial_mode, notes, active, created_by)
      values (v_org, v_name, nullif(btrim(coalesce(p_legal_name, '')), ''), v_tax, p_commercial_mode, nullif(btrim(coalesce(p_notes, '')), ''), coalesce(p_active, true), auth.uid())
      returning * into v_row;
    else
      update public.distribution_clients set trade_name = v_name, legal_name = nullif(btrim(coalesce(p_legal_name, '')), ''), tax_id = v_tax, commercial_mode = p_commercial_mode,
        notes = nullif(btrim(coalesce(p_notes, '')), ''), active = coalesce(p_active, true)
      where id = p_id and organization_id = v_org returning * into v_row;
      if not found then raise exception 'Cliente no encontrado' using errcode = '42501'; end if;
    end if;
  exception when unique_violation then
    raise exception 'Ya existe un cliente con ese nombre o CUIT' using errcode = '23505';
  end;
  return jsonb_build_object('id', v_row.id, 'tradeName', v_row.trade_name, 'active', v_row.active, 'commercialMode', v_row.commercial_mode);
end;
$$;

create function public.save_distribution_site(
  p_id uuid default null,
  p_client_id uuid default null,
  p_name text default null,
  p_address text default null,
  p_city text default null,
  p_phone text default null,
  p_contact_name text default null,
  p_notes text default null,
  p_restock_weekday integer default null,
  p_commercial_mode text default null,
  p_active boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_row public.distribution_sites%rowtype;
begin
  if v_name is null then raise exception 'Ingresá el nombre del establecimiento' using errcode = '22023'; end if;
  if p_restock_weekday is not null and p_restock_weekday not between 1 and 7 then raise exception 'El día de reposición va de 1 (lunes) a 7 (domingo)' using errcode = '22023'; end if;
  if p_commercial_mode is not null and p_commercial_mode not in ('WHOLESALE', 'CONSIGNMENT') then raise exception 'Modalidad comercial inválida' using errcode = '22023'; end if;
  begin
    if p_id is null then
      if not exists (select 1 from public.distribution_clients c where c.id = p_client_id and c.organization_id = v_org) then raise exception 'Cliente no encontrado' using errcode = '42501'; end if;
      insert into public.distribution_sites (organization_id, client_id, name, address, city, phone, contact_name, notes, restock_weekday, commercial_mode, active)
      values (v_org, p_client_id, v_name, nullif(btrim(coalesce(p_address, '')), ''), nullif(btrim(coalesce(p_city, '')), ''), nullif(btrim(coalesce(p_phone, '')), ''),
        nullif(btrim(coalesce(p_contact_name, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), p_restock_weekday, p_commercial_mode, coalesce(p_active, true))
      returning * into v_row;
    else
      update public.distribution_sites set name = v_name, address = nullif(btrim(coalesce(p_address, '')), ''), city = nullif(btrim(coalesce(p_city, '')), ''),
        phone = nullif(btrim(coalesce(p_phone, '')), ''), contact_name = nullif(btrim(coalesce(p_contact_name, '')), ''), notes = nullif(btrim(coalesce(p_notes, '')), ''),
        restock_weekday = p_restock_weekday, commercial_mode = p_commercial_mode, active = coalesce(p_active, true)
      where id = p_id and organization_id = v_org returning * into v_row;
      if not found then raise exception 'Establecimiento no encontrado' using errcode = '42501'; end if;
    end if;
  exception when unique_violation then
    raise exception 'Ese cliente ya tiene un establecimiento con ese nombre' using errcode = '23505';
  end;
  return jsonb_build_object('id', v_row.id, 'clientId', v_row.client_id, 'name', v_row.name, 'active', v_row.active);
end;
$$;

create function public.list_distribution_clients()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'tradeName', c.trade_name, 'legalName', c.legal_name, 'taxId', c.tax_id, 'commercialMode', c.commercial_mode, 'notes', c.notes, 'active', c.active,
      'sites', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'address', s.address, 'city', s.city, 'phone', s.phone, 'contactName', s.contact_name, 'notes', s.notes,
          'restockWeekday', s.restock_weekday, 'commercialMode', s.commercial_mode, 'effectiveMode', coalesce(s.commercial_mode, c.commercial_mode), 'active', s.active,
          'lastDelivery', (
            select jsonb_build_object('id', d.id, 'numberLabel', app_private.dist_number_label(d.number), 'deliveryDate', d.delivery_date, 'packageCount', d.package_count)
            from public.distribution_deliveries d
            where d.site_id = s.id and d.organization_id = s.organization_id and d.status = 'CONFIRMED' and (v_vis is null or d.origin_branch_id = any(v_vis))
            order by d.delivery_date desc, d.number desc limit 1
          ),
          'draftId', (
            select d.id from public.distribution_deliveries d
            where d.site_id = s.id and d.organization_id = s.organization_id and d.status = 'DRAFT' and (v_vis is null or d.origin_branch_id = any(v_vis))
            order by d.created_at desc limit 1
          )
        ) order by lower(s.name))
        from public.distribution_sites s where s.client_id = c.id and s.organization_id = c.organization_id
      ), '[]'::jsonb)
    ) order by lower(c.trade_name))
    from public.distribution_clients c where c.organization_id = v_org
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: identificación de paquetes
-- ---------------------------------------------------------------------------------------------
-- Busca por código logístico (con o sin guiones, tolerando O/I/L) o por el UUID del paquete. Devuelve el paquete con su estado y la entrega donde está.
create function public.find_vacuum_package_by_code(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_raw text := btrim(coalesce(p_code, ''));
  v_code text := app_private.logistic_code_normalize(v_raw);
  v_id uuid;
  v_row public.vacuum_packages%rowtype;
begin
  if v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_id := v_raw::uuid;
  elsif app_private.logistic_code_is_valid(v_code) then
    select l.package_id into v_id from public.vacuum_package_logistics l where l.organization_id = v_org and l.code = v_code;
  else
    raise exception 'El código no es un identificador logístico válido (revisá que esté completo)' using errcode = '22023';
  end if;
  select * into v_row from public.vacuum_packages x where x.id = v_id and x.organization_id = v_org and (v_vis is null or x.branch_id = any(v_vis));
  if not found then return null; end if;
  return app_private.vacuum_package_json(v_row) || jsonb_build_object(
    'distributionDeliveryId', (select s.distribution_delivery_id from public.vacuum_package_state s where s.package_id = v_row.id)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: paquetes disponibles para distribuir
-- ---------------------------------------------------------------------------------------------
create function public.list_distributable_packages(
  p_branch_id uuid,
  p_delivery_date date default null,
  p_product_id uuid default null,
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
  v_org uuid := app_private.require_permission('distribution.read');
  v_tz text;
  v_date date;
  v_text text := app_private.import_normalize_text(p_search);
  v_pattern text := case when v_text is null then null else '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_code text := app_private.logistic_code_normalize(p_search);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_total bigint;
  v_rows jsonb;
begin
  perform app_private.require_visible_branch(v_org, p_branch_id);
  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_date := coalesce(p_delivery_date, (clock_timestamp() at time zone coalesce(v_tz, 'UTC'))::date);
  select count(*) into v_total
  from public.vacuum_package_state s join public.vacuum_packages p on p.id = s.package_id and p.organization_id = s.organization_id
  left join public.vacuum_package_logistics l on l.package_id = p.id
  where s.organization_id = v_org and s.current_branch_id = p_branch_id and s.status = 'AVAILABLE' and p.expires_on >= v_date
    and (p_product_id is null or p.product_id = p_product_id)
    and (v_pattern is null or lower(p.lot) like v_pattern escape '\' or app_private.import_normalize_text(p.product_name_snapshot) like v_pattern escape '\' or l.code = v_code);
  select coalesce(jsonb_agg(jsonb_build_object(
    'packageId', r.id, 'logisticCode', r.code, 'productId', r.product_id, 'productName', r.product_name_snapshot, 'weightGrams', r.weight_grams,
    'lot', r.lot, 'packedOn', r.packed_on, 'expiresOn', r.expires_on, 'totalCents', r.charge::text, 'ean13', r.ean13
  ) order by r.expires_on, r.created_at, r.id), '[]'::jsonb) into v_rows
  from (
    select p.*, l.code, app_private.vacuum_package_charge_cents(p) as charge
    from public.vacuum_package_state s join public.vacuum_packages p on p.id = s.package_id and p.organization_id = s.organization_id
    left join public.vacuum_package_logistics l on l.package_id = p.id
    where s.organization_id = v_org and s.current_branch_id = p_branch_id and s.status = 'AVAILABLE' and p.expires_on >= v_date
      and (p_product_id is null or p.product_id = p_product_id)
      and (v_pattern is null or lower(p.lot) like v_pattern escape '\' or app_private.import_normalize_text(p.product_name_snapshot) like v_pattern escape '\' or l.code = v_code)
    order by p.expires_on, p.created_at, p.id
    limit v_limit offset greatest(coalesce(p_offset, 0), 0)
  ) r;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

create function public.get_distribution_available_summary(p_branch_id uuid, p_delivery_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.read');
  v_tz text;
  v_date date;
begin
  perform app_private.require_visible_branch(v_org, p_branch_id);
  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_date := coalesce(p_delivery_date, (clock_timestamp() at time zone coalesce(v_tz, 'UTC'))::date);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'productId', r.product_id, 'productName', r.name, 'packages', r.packages, 'grams', r.grams::text, 'nextExpiry', r.next_expiry
    ) order by lower(r.name))
    from (
      select p.product_id, max(p.product_name_snapshot) as name, count(*) as packages, sum(p.weight_grams) as grams, min(p.expires_on) as next_expiry
      from public.vacuum_package_state s join public.vacuum_packages p on p.id = s.package_id and p.organization_id = s.organization_id
      where s.organization_id = v_org and s.current_branch_id = p_branch_id and s.status = 'AVAILABLE' and p.expires_on >= v_date
      group by p.product_id
    ) r
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: entregas
-- ---------------------------------------------------------------------------------------------
create function public.create_distribution_delivery(
  p_site_id uuid,
  p_delivery_date date,
  p_request_key uuid default null,
  p_reference_delivery_id uuid default null,
  p_notes text default null,
  p_origin_branch_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_tz text;
  v_today date;
  v_origin uuid;
  v_site public.distribution_sites%rowtype;
  v_client public.distribution_clients%rowtype;
  v_existing public.distribution_deliveries%rowtype;
  v_ref public.distribution_deliveries%rowtype;
  v_number bigint;
  v_row public.distribution_deliveries%rowtype;
begin
  if p_request_key is not null then
    select * into v_existing from public.distribution_deliveries d where d.organization_id = v_org and d.request_key = p_request_key;
    if found then
      perform app_private.require_visible_branch(v_org, v_existing.origin_branch_id);
      return app_private.distribution_delivery_json(v_existing, true);
    end if;
  end if;
  select o.timezone, coalesce(p_origin_branch_id, o.production_branch_id) into v_tz, v_origin from public.organizations o where o.id = v_org;
  if v_origin is null then raise exception 'Elegí la sucursal de origen: la organización no tiene una sucursal de producción' using errcode = '22023'; end if;
  perform app_private.require_visible_branch(v_org, v_origin);
  v_today := (clock_timestamp() at time zone coalesce(v_tz, 'UTC'))::date;
  if p_delivery_date is null or p_delivery_date < v_today - 30 or p_delivery_date > v_today + 90 then
    raise exception 'La fecha de entrega es inválida' using errcode = '22023';
  end if;
  select * into v_site from public.distribution_sites s where s.id = p_site_id and s.organization_id = v_org;
  if not found then raise exception 'Establecimiento no encontrado' using errcode = '42501'; end if;
  select * into v_client from public.distribution_clients c where c.id = v_site.client_id and c.organization_id = v_org;
  if not v_site.active or not v_client.active then raise exception 'El supermercado está inactivo' using errcode = '22023'; end if;
  if p_reference_delivery_id is not null then
    select * into v_ref from public.distribution_deliveries d where d.id = p_reference_delivery_id and d.organization_id = v_org;
    if not found or v_ref.site_id <> p_site_id then raise exception 'La entrega de referencia no es de este establecimiento' using errcode = '22023'; end if;
  end if;
  insert into public.distribution_delivery_counters (organization_id, last_number) values (v_org, 1)
  on conflict (organization_id) do update set last_number = public.distribution_delivery_counters.last_number + 1 returning last_number into v_number;
  insert into public.distribution_deliveries (organization_id, origin_branch_id, site_id, number, request_key, delivery_date, commercial_mode, reference_delivery_id, notes, created_by)
  values (v_org, v_origin, p_site_id, v_number, p_request_key, p_delivery_date, coalesce(v_site.commercial_mode, v_client.commercial_mode), p_reference_delivery_id,
    nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning * into v_row;
  return app_private.distribution_delivery_json(v_row, true);
end;
$$;

create function public.add_delivery_packages(p_delivery_id uuid, p_package_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_d public.distribution_deliveries%rowtype;
  v_id uuid;
  v_added integer := 0;
begin
  if p_package_ids is null or cardinality(p_package_ids) = 0 or cardinality(p_package_ids) > 500 then raise exception 'Elegí entre 1 y 500 paquetes' using errcode = '22023'; end if;
  v_d := app_private.dist_draft_for_update(v_org, p_delivery_id);
  foreach v_id in array (select array_agg(distinct x) from unnest(p_package_ids) x) loop
    if app_private.dist_reserve_package(v_org, v_d, v_id) then v_added := v_added + 1; end if;
  end loop;
  return jsonb_build_object('added', v_added, 'delivery', app_private.distribution_delivery_json(v_d, true));
end;
$$;

create function public.add_delivery_package_by_code(p_delivery_id uuid, p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_d public.distribution_deliveries%rowtype;
  v_found jsonb;
  v_added boolean;
begin
  v_d := app_private.dist_draft_for_update(v_org, p_delivery_id);
  v_found := public.find_vacuum_package_by_code(p_code);
  if v_found is null then raise exception 'No se encontró ningún paquete con ese código' using errcode = '22023'; end if;
  v_added := app_private.dist_reserve_package(v_org, v_d, (v_found ->> 'id')::uuid);
  return jsonb_build_object('added', v_added, 'package', v_found, 'delivery', app_private.distribution_delivery_json(v_d, true));
end;
$$;

-- Agrega, por producto, los N paquetes que vencen primero (FEFO). Si no alcanzan, agrega los que haya e informa lo que faltó (no es un error).
create function public.add_delivery_packages_by_quantity(p_delivery_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_d public.distribution_deliveries%rowtype;
  v_item jsonb;
  v_product uuid;
  v_qty integer;
  v_got integer;
  r record;
  v_missing jsonb := '[]'::jsonb;
  v_added integer := 0;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'Indicá los productos y cantidades' using errcode = '22023';
  end if;
  v_d := app_private.dist_draft_for_update(v_org, p_delivery_id);
  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      v_product := (v_item ->> 'productId')::uuid;
      v_qty := (v_item ->> 'quantity')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Producto o cantidad inválidos' using errcode = '22023';
    end;
    if v_product is null or v_qty is null or v_qty < 1 or v_qty > 500 then raise exception 'Producto o cantidad inválidos' using errcode = '22023'; end if;
    v_got := 0;
    for r in
      select p.id from public.vacuum_package_state s join public.vacuum_packages p on p.id = s.package_id and p.organization_id = s.organization_id
      where s.organization_id = v_org and s.current_branch_id = v_d.origin_branch_id and s.status = 'AVAILABLE' and p.product_id = v_product and p.expires_on >= v_d.delivery_date
      order by p.expires_on, p.created_at, p.id
      limit v_qty
      for update of s skip locked
    loop
      if app_private.dist_reserve_package(v_org, v_d, r.id) then v_got := v_got + 1; end if;
    end loop;
    v_added := v_added + v_got;
    if v_got < v_qty then v_missing := v_missing || jsonb_build_array(jsonb_build_object('productId', v_product, 'requested', v_qty, 'added', v_got)); end if;
  end loop;
  return jsonb_build_object('added', v_added, 'missing', v_missing, 'delivery', app_private.distribution_delivery_json(v_d, true));
end;
$$;

create function public.remove_delivery_packages(p_delivery_id uuid, p_package_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_d public.distribution_deliveries%rowtype;
  v_id uuid;
  v_removed integer := 0;
begin
  if p_package_ids is null or cardinality(p_package_ids) = 0 or cardinality(p_package_ids) > 500 then raise exception 'Elegí entre 1 y 500 paquetes' using errcode = '22023'; end if;
  v_d := app_private.dist_draft_for_update(v_org, p_delivery_id);
  foreach v_id in array p_package_ids loop
    perform 1 from public.vacuum_package_state s where s.package_id = v_id for update;
    update public.vacuum_package_state set status = 'AVAILABLE', distribution_delivery_id = null, updated_at = now()
    where package_id = v_id and organization_id = v_org and status = 'RESERVED' and distribution_delivery_id = v_d.id;
    if found then
      delete from public.distribution_delivery_items where delivery_id = v_d.id and package_id = v_id;
      perform app_private.dist_package_event(v_org, v_id, v_d.origin_branch_id, 'UNRESERVED', app_private.dist_number_label(v_d.number));
      v_removed := v_removed + 1;
    end if;
  end loop;
  return jsonb_build_object('removed', v_removed, 'delivery', app_private.distribution_delivery_json(v_d, true));
end;
$$;

create function public.cancel_distribution_delivery(p_delivery_id uuid, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_d public.distribution_deliveries%rowtype;
  v_reason text := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Borrador cancelado');
  r record;
begin
  select * into v_d from public.distribution_deliveries d where d.id = p_delivery_id and d.organization_id = v_org for update;
  if not found then raise exception 'Entrega no encontrada' using errcode = '42501'; end if;
  perform app_private.require_visible_branch(v_org, v_d.origin_branch_id);
  if v_d.status = 'CANCELLED' then return app_private.distribution_delivery_json(v_d, false); end if;
  if v_d.status <> 'DRAFT' then raise exception 'Sólo se puede cancelar un borrador: una entrega confirmada ya movió mercadería' using errcode = '22023'; end if;
  if char_length(v_reason) < 3 then v_reason := 'Borrador cancelado'; end if;
  for r in select i.package_id from public.distribution_delivery_items i where i.delivery_id = v_d.id loop
    perform 1 from public.vacuum_package_state s where s.package_id = r.package_id for update;
    update public.vacuum_package_state set status = 'AVAILABLE', distribution_delivery_id = null, updated_at = now()
    where package_id = r.package_id and status = 'RESERVED' and distribution_delivery_id = v_d.id;
    perform app_private.dist_package_event(v_org, r.package_id, v_d.origin_branch_id, 'UNRESERVED', app_private.dist_number_label(v_d.number) || ' cancelada');
  end loop;
  delete from public.distribution_delivery_items where delivery_id = v_d.id;
  update public.distribution_deliveries set status = 'CANCELLED', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(v_reason, 300) where id = v_d.id returning * into v_d;
  return app_private.distribution_delivery_json(v_d, false);
end;
$$;

-- Confirma el despacho. TRANSACCIONAL (una sola función = una transacción) e IDEMPOTENTE (confirmar de nuevo devuelve la entrega sin tocar nada).
create function public.confirm_distribution_delivery(p_delivery_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_d public.distribution_deliveries%rowtype;
  v_site public.distribution_sites%rowtype;
  v_client public.distribution_clients%rowtype;
  v_label text;
  v_count integer; v_grams bigint; v_cents bigint;
  v_short jsonb;
  r record;
begin
  select * into v_d from public.distribution_deliveries d where d.id = p_delivery_id and d.organization_id = v_org for update;
  if not found then raise exception 'Entrega no encontrada' using errcode = '42501'; end if;
  perform app_private.require_visible_branch(v_org, v_d.origin_branch_id);
  if v_d.status = 'CONFIRMED' then return app_private.distribution_delivery_json(v_d, true) || jsonb_build_object('alreadyConfirmed', true, 'stockShortfalls', '[]'::jsonb); end if;
  if v_d.status <> 'DRAFT' then raise exception 'La entrega % está cancelada', app_private.dist_number_label(v_d.number) using errcode = '22023'; end if;
  v_label := app_private.dist_number_label(v_d.number);
  select count(*), coalesce(sum(i.weight_grams), 0), coalesce(sum(i.unit_cents), 0) into v_count, v_grams, v_cents from public.distribution_delivery_items i where i.delivery_id = v_d.id;
  if v_count = 0 then raise exception 'La entrega no tiene paquetes' using errcode = '22023'; end if;
  select * into v_site from public.distribution_sites s where s.id = v_d.site_id and s.organization_id = v_org;
  select * into v_client from public.distribution_clients c where c.id = v_site.client_id and c.organization_id = v_org;
  if not v_site.active or not v_client.active then raise exception 'El supermercado está inactivo' using errcode = '22023'; end if;

  -- Bloqueo de TODOS los estados y revalidación: cada paquete sigue reservado para ESTA entrega y no venció.
  perform 1 from public.vacuum_package_state s where s.package_id in (select i.package_id from public.distribution_delivery_items i where i.delivery_id = v_d.id) order by s.package_id for update;
  for r in
    select p.lot, l.code, s.status, s.distribution_delivery_id, p.expires_on
    from public.distribution_delivery_items i
    join public.vacuum_package_state s on s.package_id = i.package_id
    join public.vacuum_packages p on p.id = i.package_id and p.organization_id = i.organization_id
    left join public.vacuum_package_logistics l on l.package_id = p.id
    where i.delivery_id = v_d.id and (s.status <> 'RESERVED' or s.distribution_delivery_id <> v_d.id or p.expires_on < v_d.delivery_date)
    limit 1
  loop
    raise exception 'El paquete % (lote %) ya no se puede despachar (estado: %, vence %)', coalesce(r.code, '?'), r.lot, r.status, to_char(r.expires_on, 'DD/MM/YYYY') using errcode = '22023';
  end loop;

  update public.vacuum_package_state set status = 'DISPATCHED', updated_at = now()
  where package_id in (select i.package_id from public.distribution_delivery_items i where i.delivery_id = v_d.id) and distribution_delivery_id = v_d.id and status = 'RESERVED';
  update public.distribution_delivery_items set outcome = case when v_d.commercial_mode = 'WHOLESALE' then 'SOLD_FIRM' else 'PENDING' end where delivery_id = v_d.id;
  insert into public.vacuum_package_events (organization_id, package_id, branch_id, kind, note, created_by)
  select v_org, i.package_id, v_d.origin_branch_id, 'DISPATCHED', v_label, auth.uid() from public.distribution_delivery_items i where i.delivery_id = v_d.id;

  -- Movimiento físico en el ledger EXISTENTE: un DISTRIBUTION_OUT por producto, con los gramos reales.
  insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, reason, profile_id, occurred_at, distribution_delivery_id)
  select v_org, v_d.origin_branch_id, p.product_id, 'DISTRIBUTION_OUT', -sum(i.weight_grams)::bigint,
    left('Entrega ' || v_label || ' a ' || v_client.trade_name || ' - ' || v_site.name, 500), auth.uid(), now(), v_d.id
  from public.distribution_delivery_items i join public.vacuum_packages p on p.id = i.package_id and p.organization_id = i.organization_id
  where i.delivery_id = v_d.id group by p.product_id;

  -- Aviso (no bloquea): productos cuyo stock de la sucursal quedó negativo (el ledger puede ir atrasado respecto de lo envasado).
  select coalesce(jsonb_agg(jsonb_build_object('productId', x.product_id, 'productName', x.name, 'stockGrams', x.stock::text) order by x.name), '[]'::jsonb) into v_short
  from (
    select sm.product_id, max(pr.name) as name, sum(sm.quantity_grams) as stock
    from public.stock_movements sm join public.products pr on pr.id = sm.product_id and pr.organization_id = sm.organization_id
    where sm.organization_id = v_org and sm.branch_id = v_d.origin_branch_id
      and sm.product_id in (select p.product_id from public.distribution_delivery_items i join public.vacuum_packages p on p.id = i.package_id and p.organization_id = i.organization_id where i.delivery_id = v_d.id)
    group by sm.product_id having sum(sm.quantity_grams) < 0
  ) x;

  update public.distribution_deliveries set status = 'CONFIRMED', confirmed_by = auth.uid(), confirmed_at = now(), package_count = v_count, total_grams = v_grams, total_cents = v_cents,
    recipient_snapshot = jsonb_build_object('clientTradeName', v_client.trade_name, 'clientLegalName', v_client.legal_name, 'taxId', v_client.tax_id,
      'siteName', v_site.name, 'address', v_site.address, 'city', v_site.city, 'phone', v_site.phone, 'contactName', v_site.contact_name)
  where id = v_d.id returning * into v_d;
  return app_private.distribution_delivery_json(v_d, true) || jsonb_build_object('alreadyConfirmed', false, 'stockShortfalls', v_short);
end;
$$;

create function public.get_distribution_delivery(p_delivery_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_d public.distribution_deliveries%rowtype;
begin
  select * into v_d from public.distribution_deliveries d where d.id = p_delivery_id and d.organization_id = v_org and (v_vis is null or d.origin_branch_id = any(v_vis));
  if not found then return null; end if;
  return app_private.distribution_delivery_json(v_d, true);
end;
$$;

create function public.list_distribution_deliveries(
  p_site_id uuid default null,
  p_client_id uuid default null,
  p_status text default null,
  p_from date default null,
  p_to date default null,
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
  v_org uuid := app_private.require_permission('distribution.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_total bigint;
  v_rows jsonb;
begin
  if p_status is not null and p_status not in ('DRAFT', 'CONFIRMED', 'CANCELLED') then raise exception 'Estado inválido' using errcode = '22023'; end if;
  select count(*) into v_total
  from public.distribution_deliveries d join public.distribution_sites s on s.id = d.site_id and s.organization_id = d.organization_id
  where d.organization_id = v_org and (v_vis is null or d.origin_branch_id = any(v_vis))
    and (p_site_id is null or d.site_id = p_site_id) and (p_client_id is null or s.client_id = p_client_id) and (p_status is null or d.status = p_status)
    and (p_from is null or d.delivery_date >= p_from) and (p_to is null or d.delivery_date <= p_to);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'numberLabel', app_private.dist_number_label(r.number), 'status', r.status, 'deliveryDate', r.delivery_date, 'commercialMode', r.commercial_mode,
    'siteId', r.site_id, 'siteName', r.site_name, 'clientId', r.client_id, 'clientName', r.client_name,
    'packageCount', coalesce(r.package_count, r.live_count), 'totalGrams', coalesce(r.total_grams, r.live_grams)::text, 'totalCents', coalesce(r.total_cents, r.live_cents)::text,
    'pendingCount', r.pending_count, 'soldCount', r.sold_count, 'returnedCount', r.returned_count,
    'confirmedAt', r.confirmed_at, 'createdAt', r.created_at
  ) order by r.delivery_date desc, r.number desc), '[]'::jsonb) into v_rows
  from (
    select d.*, s.name as site_name, c.id as client_id, c.trade_name as client_name,
      (select count(*) from public.distribution_delivery_items i where i.delivery_id = d.id) as live_count,
      (select coalesce(sum(i.weight_grams), 0) from public.distribution_delivery_items i where i.delivery_id = d.id) as live_grams,
      (select coalesce(sum(i.unit_cents), 0) from public.distribution_delivery_items i where i.delivery_id = d.id) as live_cents,
      (select count(*) from public.distribution_delivery_items i where i.delivery_id = d.id and i.outcome = 'PENDING') as pending_count,
      (select count(*) from public.distribution_delivery_items i where i.delivery_id = d.id and i.outcome in ('SOLD_FIRM', 'SOLD_REPORTED')) as sold_count,
      (select count(*) from public.distribution_delivery_items i where i.delivery_id = d.id and i.outcome = 'RETURNED') as returned_count
    from public.distribution_deliveries d
    join public.distribution_sites s on s.id = d.site_id and s.organization_id = d.organization_id
    join public.distribution_clients c on c.id = s.client_id and c.organization_id = s.organization_id
    where d.organization_id = v_org and (v_vis is null or d.origin_branch_id = any(v_vis))
      and (p_site_id is null or d.site_id = p_site_id) and (p_client_id is null or s.client_id = p_client_id) and (p_status is null or d.status = p_status)
      and (p_from is null or d.delivery_date >= p_from) and (p_to is null or d.delivery_date <= p_to)
    order by d.delivery_date desc, d.number desc
    limit v_limit offset greatest(coalesce(p_offset, 0), 0)
  ) r;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

-- Última entrega CONFIRMADA de un establecimiento, con las cantidades por producto: base para preparar la siguiente reposición (nunca se crea sola).
create function public.get_site_reference_delivery(p_site_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_d public.distribution_deliveries%rowtype;
begin
  select * into v_d from public.distribution_deliveries d
  where d.organization_id = v_org and d.site_id = p_site_id and d.status = 'CONFIRMED' and (v_vis is null or d.origin_branch_id = any(v_vis))
  order by d.delivery_date desc, d.number desc limit 1;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', v_d.id, 'numberLabel', app_private.dist_number_label(v_d.number), 'deliveryDate', v_d.delivery_date, 'packageCount', v_d.package_count, 'totalGrams', v_d.total_grams::text,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('productId', x.product_id, 'productName', x.name, 'quantity', x.qty, 'grams', x.grams::text) order by lower(x.name))
      from (
        select p.product_id, max(p.product_name_snapshot) as name, count(*) as qty, sum(i.weight_grams) as grams
        from public.distribution_delivery_items i join public.vacuum_packages p on p.id = i.package_id and p.organization_id = i.organization_id
        where i.delivery_id = v_d.id group by p.product_id
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function
  app_private.cuit_is_valid(text), app_private.logistic_code_normalize(text), app_private.logistic_code_check_char(text), app_private.logistic_code_is_valid(text),
  app_private.logistic_code_generate(), app_private.assign_logistic_code(uuid, uuid), app_private.vacuum_package_assign_logistic_code(),
  app_private.dist_package_event(uuid, uuid, uuid, text, text), app_private.dist_number_label(bigint),
  app_private.dist_reserve_package(uuid, public.distribution_deliveries, uuid), app_private.dist_draft_for_update(uuid, uuid),
  app_private.distribution_delivery_json(public.distribution_deliveries, boolean)
from public, anon, authenticated;

revoke all on function
  public.save_distribution_client(uuid, text, text, text, text, text, boolean),
  public.save_distribution_site(uuid, uuid, text, text, text, text, text, text, integer, text, boolean),
  public.list_distribution_clients(),
  public.find_vacuum_package_by_code(text),
  public.list_distributable_packages(uuid, date, uuid, text, integer, integer),
  public.get_distribution_available_summary(uuid, date),
  public.create_distribution_delivery(uuid, date, uuid, uuid, text, uuid),
  public.add_delivery_packages(uuid, uuid[]),
  public.add_delivery_package_by_code(uuid, text),
  public.add_delivery_packages_by_quantity(uuid, jsonb),
  public.remove_delivery_packages(uuid, uuid[]),
  public.cancel_distribution_delivery(uuid, text),
  public.confirm_distribution_delivery(uuid),
  public.get_distribution_delivery(uuid),
  public.list_distribution_deliveries(uuid, uuid, text, date, date, integer, integer),
  public.get_site_reference_delivery(uuid)
from public, anon;
grant execute on function
  public.save_distribution_client(uuid, text, text, text, text, text, boolean),
  public.save_distribution_site(uuid, uuid, text, text, text, text, text, text, integer, text, boolean),
  public.list_distribution_clients(),
  public.find_vacuum_package_by_code(text),
  public.list_distributable_packages(uuid, date, uuid, text, integer, integer),
  public.get_distribution_available_summary(uuid, date),
  public.create_distribution_delivery(uuid, date, uuid, uuid, text, uuid),
  public.add_delivery_packages(uuid, uuid[]),
  public.add_delivery_package_by_code(uuid, text),
  public.add_delivery_packages_by_quantity(uuid, jsonb),
  public.remove_delivery_packages(uuid, uuid[]),
  public.cancel_distribution_delivery(uuid, text),
  public.confirm_distribution_delivery(uuid),
  public.get_distribution_delivery(uuid),
  public.list_distribution_deliveries(uuid, uuid, text, date, date, integer, integer),
  public.get_site_reference_delivery(uuid)
to authenticated;

commit;
