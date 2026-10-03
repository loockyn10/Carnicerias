begin;

-- Pack de productos UNIT (con 20 % de descuento) y promociones globales por sucursal ("cada N unidades, X %").
--
--   1. products.pack_size_units: unidades por pack (sólo UNIT; NULL = sin pack; entero >= 2). NO es una promoción ni un
--      precio: es la unidad operativa de carga rápida del POS. Vender "N packs" registra N × pack_size_units unidades
--      REALES (stock, precio y venta trabajan con unidades reales) y TODAS reciben 20 % de descuento
--      (app_private.pack_discount_bps). La venta recuerda cómo se hizo (snapshot en sale_items), nunca relee el producto.
--      El tamaño del pack está VERSIONADO (product_pack_versions): cada cambio cierra la versión vigente y abre otra, el POS
--      recibe el id de la versión vigente (packConfigId) y cada línea vendida como Pack lo guarda (sale_items.pack_config_id).
--      El servidor valida la venta contra ESA versión (existe, es del producto, coincide con el snapshot y estaba vigente para
--      el dispositivo), nunca contra products.pack_size_units actual: una venta offline hecha con un pack de 8 sincroniza bien
--      aunque el Admin ya haya pasado el producto a 12.
--   2. branch_promotions: "cada E unidades del MISMO producto, D % de descuento" para todos los productos UNIT de UNA
--      sucursal, sin una fila por producto. Una por sucursal activa; editarla cierra la fila vigente y crea otra
--      (las filas son inmutables: la venta guarda el id y los valores que usó, y el servidor los revalida).
--   3. Precedencia de una línea UNIT (nunca se acumulan): precio manual (D-061) > venta como Pack (20 %) >
--      promoción específica del producto (PACK_FIXED_TOTAL) > promoción de sucursal. Después el medio de pago
--      (recargo de tarjeta, D-044, una sola vez sobre el total comercial de la línea) y por último el descuento general
--      del ticket (D-061). El servidor revalida cada línea con la misma aritmética que el POS y que Rust/SQLite.
--
-- Migración incremental: columnas nuevas con default (una venta anterior queda sin pack ni promoción de sucursal),
-- tablas y funciones nuevas, y `create or replace` de las funciones cuya lógica cambia (cuerpos derivados de
-- 202610020058 / 202610030059 / 202610020058, ver cada bloque). complete_discounted_sale (RPC del POS web de desarrollo)
-- no cambia: el POS web no ofrece Pack ni promociones de sucursal (Central opera con el POS de escritorio).

-- Decisión comercial: todo Pack lleva 20 % de descuento. Cambiarlo es una decisión de producto + una migración.
create function app_private.pack_discount_bps()
returns integer
language sql
immutable
set search_path = ''
as $$ select 2000 $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Unidades por pack
-- ---------------------------------------------------------------------------------------------
alter table public.products
  add column pack_size_units integer,
  add constraint products_pack_size_units_range check (pack_size_units is null or pack_size_units between 2 and 10000),
  add constraint products_pack_size_unit_only check (pack_size_units is null or unit_type = 'UNIT');

comment on column public.products.pack_size_units is
  'Unidades por pack (sólo UNIT; NULL = sin pack). No es una promoción ni tiene precio propio: vender N packs registra N x pack_size_units unidades reales con 20 % de descuento (app_private.pack_discount_bps).';

-- Alta/edición/baja del pack de un producto. Una RPC propia (y no un parámetro nuevo de save_product) para no cambiar
-- la firma de una función que usan otras pantallas: pack_size_units = NULL lo quita.
create function public.set_product_pack_size(p_product_id uuid, p_pack_size_units integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  current_unit_type public.unit_type;
begin
  select p.unit_type into current_unit_type
  from public.products p
  where p.id = p_product_id and p.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
  if p_pack_size_units is not null then
    if current_unit_type <> 'UNIT' then
      raise exception 'Sólo los productos que se venden por unidad pueden tener pack' using errcode = '22023';
    end if;
    if p_pack_size_units not between 2 and 10000 then
      raise exception 'Las unidades por pack tienen que ser un entero entre 2 y 10000' using errcode = '22023';
    end if;
  end if;
  -- Sin cambios: no toca la fila (no genera un cambio de catálogo ni de auditoría innecesario).
  update public.products set pack_size_units = p_pack_size_units
  where id = p_product_id and organization_id = current_organization_id
    and pack_size_units is distinct from p_pack_size_units;
end;
$$;

revoke all on function public.set_product_pack_size(uuid, integer) from public, anon;
grant execute on function public.set_product_pack_size(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1b. Versiones históricas del pack (mismo enfoque que branch_promotions: filas inmutables, editar = cerrar + abrir)
-- ---------------------------------------------------------------------------------------------
-- products.pack_size_units sigue siendo el valor VIGENTE (lo que edita el Admin y lo que ve el catálogo); esta tabla es su
-- historia. Un trigger sobre products la mantiene, así cualquier forma de cambiar el pack (RPC, importación, SQL) deja
-- su versión. Una venta guarda el id de la versión con la que se hizo y el servidor la valida contra ESA fila.
create table public.product_pack_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  pack_size_units integer not null check (pack_size_units between 2 and 10000),
  -- Descuento de todo Pack (decisión comercial, app_private.pack_discount_bps()). Cambiarlo es una decisión de producto +
  -- una migración que reemplace este check; las versiones viejas conservan el 20 % con el que se vendieron.
  discount_bps integer not null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete cascade,
  constraint product_pack_versions_discount_is_20_percent check (discount_bps = 2000),
  check (valid_to is null or valid_to >= valid_from)
);

-- A lo sumo una versión vigente (abierta) por producto.
create unique index product_pack_versions_one_open_idx on public.product_pack_versions (product_id) where valid_to is null;
create index product_pack_versions_product_idx on public.product_pack_versions (product_id, valid_from desc);

create trigger product_pack_versions_audit after insert or update on public.product_pack_versions
for each row execute function app_private.audit_row_change();

alter table public.product_pack_versions enable row level security;
create policy product_pack_versions_admin_select on public.product_pack_versions
for select to authenticated using (app_private.has_permission(organization_id, 'catalog.write'));
revoke all on table public.product_pack_versions from public, anon, authenticated;
grant select on table public.product_pack_versions to authenticated;

comment on table public.product_pack_versions is
  'Historia del tamaño de pack de cada producto UNIT. Filas inmutables: cambiar el pack cierra la versión vigente (valid_to) y abre otra. El POS recibe el id vigente (pull_pos_state.packConfigId) y la venta lo guarda (sale_items.pack_config_id); el servidor valida la venta contra esa versión, nunca contra products.pack_size_units actual.';

-- Mantiene las versiones al cambiar products.pack_size_units. Sin cambio de valor no hace nada.
create function app_private.sync_product_pack_version()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  open_version public.product_pack_versions%rowtype;
begin
  select * into open_version from public.product_pack_versions v where v.product_id = new.id and v.valid_to is null for update;
  if found then
    if open_version.pack_size_units is not distinct from new.pack_size_units then return new; end if;
    update public.product_pack_versions set valid_to = greatest(now(), valid_from) where id = open_version.id;
  end if;
  if new.pack_size_units is not null then
    insert into public.product_pack_versions (organization_id, product_id, pack_size_units, discount_bps, created_by)
    values (new.organization_id, new.id, new.pack_size_units, app_private.pack_discount_bps(), auth.uid());
  end if;
  return new;
end;
$$;
revoke all on function app_private.sync_product_pack_version() from public, anon, authenticated;

create trigger products_pack_version_insert after insert on public.products
for each row when (new.pack_size_units is not null) execute function app_private.sync_product_pack_version();
create trigger products_pack_version_update after update of pack_size_units on public.products
for each row when (old.pack_size_units is distinct from new.pack_size_units) execute function app_private.sync_product_pack_version();

-- Productos que ya tuvieran pack al aplicar la migración (ninguno si se aplica junto con la columna): primera versión.
insert into public.product_pack_versions (organization_id, product_id, pack_size_units, discount_bps)
select p.organization_id, p.id, p.pack_size_units, app_private.pack_discount_bps()
from public.products p
where p.pack_size_units is not null;

-- ---------------------------------------------------------------------------------------------
-- 2. Promociones globales por sucursal
-- ---------------------------------------------------------------------------------------------
create table public.branch_promotions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  -- Alcance: hoy sólo "todos los productos UNIT de la sucursal". Es una columna para poder sumar alcances sin cambiar la tabla.
  scope text not null default 'ALL_UNIT_PRODUCTS' check (scope = 'ALL_UNIT_PRODUCTS'),
  -- Cada `every_units` unidades del MISMO producto, `discount_bps` de descuento sobre esas unidades (grupos completos).
  every_units integer not null check (every_units between 2 and 1000),
  discount_bps integer not null check (discount_bps between 1 and 9999),
  active boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade,
  check (valid_until is null or valid_until >= valid_from),
  check (active = (valid_until is null))
);

-- A lo sumo una promoción vigente por sucursal y alcance.
create unique index branch_promotions_one_active_idx on public.branch_promotions (branch_id, scope) where active;
create index branch_promotions_org_idx on public.branch_promotions (organization_id, branch_id, valid_from desc);

create trigger branch_promotions_set_updated_at before update on public.branch_promotions
for each row execute function app_private.set_updated_at();
create trigger branch_promotions_audit after insert or update on public.branch_promotions
for each row execute function app_private.audit_row_change();

-- El cambio viaja por el mismo log de cursor que las promociones por producto (entity_type DISCOUNT, con la sucursal).
create function app_private.log_branch_promotion_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.pos_catalog_changes (organization_id, branch_id, entity_type, entity_id)
  values (new.organization_id, new.branch_id, 'DISCOUNT', new.id);
  return new;
end;
$$;
revoke all on function app_private.log_branch_promotion_change() from public, anon, authenticated;
create trigger branch_promotions_log_pos_change after insert or update on public.branch_promotions
for each row execute function app_private.log_branch_promotion_change();

alter table public.branch_promotions enable row level security;
create policy branch_promotions_admin_select on public.branch_promotions
for select to authenticated using (app_private.has_permission(organization_id, 'catalog.write'));
revoke all on table public.branch_promotions from public, anon, authenticated;
grant select on table public.branch_promotions to authenticated;

comment on table public.branch_promotions is
  'Promoción global de una sucursal: cada every_units unidades del mismo producto UNIT, discount_bps de descuento. Filas inmutables: editar cierra la vigente (active=false, valid_until) y crea otra. El POS la recibe en pull_pos_state (branchPromotions) y cada venta guarda el snapshot en sale_items.';

-- Crea, edita o desactiva la promoción de una sucursal (UNA vigente por sucursal). Devuelve el id de la fila vigente
-- (o null si se desactivó una que no existía). Sin cambios de valores: no escribe nada.
create function public.save_branch_promotion(
  p_branch_id uuid,
  p_every_units integer,
  p_discount_bps integer,
  p_active boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  current_row public.branch_promotions%rowtype;
  new_id uuid;
begin
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;
  -- Serializa a quienes editan la misma sucursal.
  perform pg_advisory_xact_lock(hashtextextended('branch_promotion:' || p_branch_id::text, 0));
  select * into current_row
  from public.branch_promotions bp
  where bp.branch_id = p_branch_id and bp.scope = 'ALL_UNIT_PRODUCTS' and bp.active
  for update;

  if not coalesce(p_active, true) then
    if found then
      update public.branch_promotions set active = false, valid_until = greatest(now(), valid_from) where id = current_row.id;
      return current_row.id;
    end if;
    return null;
  end if;

  if p_every_units is null or p_every_units not between 2 and 1000 then
    raise exception 'La cantidad del grupo tiene que ser un entero entre 2 y 1000' using errcode = '22023';
  end if;
  if p_discount_bps is null or p_discount_bps not between 1 and 9999 then
    raise exception 'El descuento tiene que estar entre 0,01 %% y 99,99 %%' using errcode = '22023';
  end if;
  if found then
    if current_row.every_units = p_every_units and current_row.discount_bps = p_discount_bps then
      return current_row.id;
    end if;
    update public.branch_promotions set active = false, valid_until = greatest(now(), valid_from) where id = current_row.id;
  end if;
  insert into public.branch_promotions (organization_id, branch_id, every_units, discount_bps, created_by)
  values (current_organization_id, p_branch_id, p_every_units, p_discount_bps, auth.uid())
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.save_branch_promotion(uuid, integer, integer, boolean) from public, anon;
grant execute on function public.save_branch_promotion(uuid, integer, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Snapshots de la venta: cómo se vendió cada línea UNIT (nunca se reconstruye desde el producto actual)
-- ---------------------------------------------------------------------------------------------
alter table public.sale_items
  add column sold_as_pack boolean not null default false,
  add column pack_size_units_snapshot integer,
  add column pack_count integer,
  add column pack_discount_bps integer,
  add column pack_discount_cents bigint not null default 0 check (pack_discount_cents >= 0),
  -- Versión del pack (product_pack_versions) con la que se vendió la línea: el servidor la valida, la venta la conserva.
  add column pack_config_id uuid references public.product_pack_versions(id),
  add column branch_promotion_id uuid references public.branch_promotions(id) on delete set null,
  add column branch_promotion_every_units integer,
  add column branch_promotion_discount_bps integer,
  add column branch_promotion_discounted_units integer,
  add column branch_promotion_discount_cents bigint not null default 0 check (branch_promotion_discount_cents >= 0),
  add constraint sale_items_pack_consistent check (
    (sold_as_pack
      and pack_config_id is not null and pack_size_units_snapshot >= 2 and pack_count >= 1
      and quantity_units is not null and quantity_units = pack_count * pack_size_units_snapshot
      and pack_discount_bps between 1 and 9999)
    or (not sold_as_pack and pack_config_id is null and pack_size_units_snapshot is null and pack_count is null
      and pack_discount_bps is null and pack_discount_cents = 0)
  ),
  add constraint sale_items_branch_promotion_consistent check (
    (branch_promotion_every_units >= 2 and branch_promotion_discount_bps between 1 and 9999
      and branch_promotion_discounted_units >= branch_promotion_every_units
      and quantity_units is not null and branch_promotion_discounted_units <= quantity_units)
    or (branch_promotion_every_units is null and branch_promotion_discount_bps is null
      and branch_promotion_discounted_units is null and branch_promotion_discount_cents = 0
      and branch_promotion_id is null)
  ),
  -- Un solo descuento por línea: Pack, promoción de sucursal y precio manual se excluyen entre sí.
  add constraint sale_items_unit_discount_exclusive check (
    not (sold_as_pack and branch_promotion_every_units is not null)
    and not (manual_price_applied and (sold_as_pack or branch_promotion_every_units is not null))
  );

comment on column public.sale_items.sold_as_pack is
  'La línea UNIT se vendió explícitamente como Pack: quantity_units = pack_count x pack_size_units_snapshot unidades reales, todas con pack_discount_bps (20 %). promotion_discount_cents = pack_discount_cents.';
comment on column public.sale_items.pack_size_units_snapshot is
  'Tamaño del pack (product_pack_versions.pack_size_units de pack_config_id) con el que se vendió la línea; nunca se relee del producto.';
comment on column public.sale_items.pack_config_id is
  'Versión del pack (product_pack_versions) con la que se vendió la línea. Sólo existe en una línea vendida como Pack.';
comment on column public.sale_items.branch_promotion_every_units is
  'Snapshot de la promoción de sucursal aplicada (cada N unidades, X %): branch_promotion_discounted_units unidades (grupos completos) recibieron el descuento; promotion_discount_cents = branch_promotion_discount_cents.';

-- ---------------------------------------------------------------------------------------------
-- 4. app_private.sync_offline_sale_core: cuerpo de 202610020058 + Pack y promoción de sucursal en líneas UNIT.
--    Misma firma (el wrapper de Mercado Pago y sync_pos_operator_offline_sale la siguen llamando sin cambios).
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.sync_offline_sale_core(p_device_id uuid, p_event_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  profile_id uuid := auth.uid();
  org_id uuid;
  branch_uuid uuid;
  device_status public.pos_device_status;
  payload_hash text := encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
  receipt public.pos_sync_receipts%rowtype;
  inserted boolean;
  sale_id uuid; created_at timestamptz; completed_at timestamptz; declared_total bigint; declared_weight bigint;
  computed_total bigint := 0; computed_weight bigint := 0; method public.payment_method;
  item_index integer; item jsonb; movement jsonb; current_product_id uuid; grams integer; quantity integer;
  list_price bigint; promo_price bigint; final_price bigint; subtotal bigint;
  discount_total bigint; cash_bps integer; cash_discount bigint; card_surcharge bigint; promo_discount bigint;
  discount_type public.weight_discount_type; discount_value bigint; discount_rule uuid;
  line_promotion_mode public.promotion_mode; pack_promo public.product_weight_discounts%rowtype;
  whole_packs bigint; remainder bigint;
  list_subtotal bigint; cash_subtotal bigint; cost_snapshot bigint; profit_snapshot integer;
  -- D-061: precio manual por línea y descuento general del ticket (sólo POS de Central).
  manual_applied boolean; manual_price bigint; manual_adjustment bigint;
  discount_bps integer := 0; declared_discount bigint := 0; expected_discount bigint; net_total bigint;
  ordered_item_ids uuid[];
  -- Pack y promoción de sucursal de una línea UNIT (snapshot que manda el POS; el servidor lo revalida).
  sold_pack boolean; pack_count integer; pack_size integer; pack_bps integer; pack_discount bigint;
  pack_config uuid; pack_version public.product_pack_versions%rowtype;
  bp_id uuid; bp_every integer; bp_bps integer; bp_units integer; bp_discount bigint;
  unit_discount bigint; has_unit_discount boolean;
begin
  if profile_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_payload is null or p_payload->>'schemaVersion' <> '1' then raise exception 'Unsupported offline sale payload' using errcode = '22023'; end if;
  if jsonb_typeof(p_payload->'items') <> 'array' or jsonb_array_length(p_payload->'items') not between 1 and 100
     or jsonb_typeof(p_payload->'stockMovements') <> 'array' or jsonb_array_length(p_payload->'stockMovements') <> jsonb_array_length(p_payload->'items') then
    raise exception 'Offline sale items are invalid' using errcode = '22023';
  end if;
  select d.organization_id, d.branch_id, d.status into org_id, branch_uuid, device_status from public.pos_devices d where d.id = p_device_id;
  if not found or device_status <> 'ACTIVE' or not app_private.can_access_branch(org_id, branch_uuid, 'sales.create') then
    raise exception 'Device or branch is not authorized for this user' using errcode = '42501';
  end if;
  begin
    sale_id := (p_payload->>'saleId')::uuid; created_at := (p_payload->>'createdAt')::timestamptz; completed_at := (p_payload->>'completedAt')::timestamptz;
    declared_total := (p_payload->>'totalCents')::bigint; declared_weight := (p_payload->>'totalWeightGrams')::bigint;
    method := upper(p_payload->'payment'->>'method')::public.payment_method;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale header is invalid' using errcode = '22023'; end;
  if (p_payload->>'eventId')::uuid <> p_event_id or (p_payload->>'deviceId')::uuid <> p_device_id or (p_payload->>'organizationId')::uuid <> org_id
     or (p_payload->>'branchId')::uuid <> branch_uuid or (p_payload->>'profileId')::uuid <> profile_id or p_payload->>'status' <> 'COMPLETED'
     or created_at > completed_at or completed_at > now() + interval '5 minutes' then
    raise exception 'Offline sale identity or timestamps are invalid' using errcode = '42501';
  end if;
  -- D-061: el precio manual y el descuento general sólo existen en la sucursal productiva de la organización
  -- (organizations.production_branch_id, la misma que decide `get_pos_device_capabilities`: nunca el nombre).
  -- El POS ya lo bloquea, pero el servidor no confía en el POS: una venta de cualquier otra sucursal que traiga
  -- cualquiera de estas claves se rechaza entera (sin recibo, sin venta, sin movimientos).
  if p_payload ? 'ticketDiscountBps' or p_payload ? 'ticketDiscountCents' or p_payload ? 'subtotalCents'
     or exists (
       select 1 from jsonb_array_elements(p_payload->'items') as candidate(value)
       where candidate.value ? 'manualPriceApplied' or candidate.value ? 'manualUnitPriceCents' or candidate.value ? 'manualAdjustmentCents'
     ) then
    if not exists (select 1 from public.organizations o where o.id = org_id and o.production_branch_id = branch_uuid) then
      raise exception 'FLEXIBLE_PRICING_NOT_ALLOWED' using errcode = '42501',
        hint = 'El precio manual y el descuento general sólo están habilitados en el POS de Central.';
    end if;
  end if;
  insert into public.pos_sync_receipts(event_id, sale_id, device_id, payload_hash) values(p_event_id, sale_id, p_device_id, payload_hash)
  on conflict(event_id) do nothing returning true into inserted;
  if not coalesce(inserted, false) then
    select * into receipt from public.pos_sync_receipts where event_id = p_event_id;
    if receipt.sale_id <> sale_id or receipt.device_id <> p_device_id or receipt.payload_hash <> payload_hash then
      raise exception 'Idempotency key was reused with a different payload' using errcode = '23505';
    end if;
    return jsonb_build_object('saleId', sale_id, 'duplicate', true, 'syncedAt', receipt.received_at);
  end if;
  if exists(select 1 from public.sales where id = sale_id) then raise exception 'Sale id already exists with another sync event' using errcode = '23505'; end if;
  insert into public.sales(id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams, created_at, completed_at, device_id, sync_event_id)
  values(sale_id, org_id, branch_uuid, profile_id, 'COMPLETED', 0, 0, created_at, completed_at, p_device_id, p_event_id);

  for item_index in 0..jsonb_array_length(p_payload->'items') - 1 loop
    item := p_payload->'items'->item_index; movement := p_payload->'stockMovements'->item_index;
    begin
      current_product_id := (item->>'productId')::uuid; final_price := (item->>'pricePerKgCents')::bigint;
      list_price := coalesce(nullif(item->>'originalPricePerKgCents', '')::bigint, final_price);
      discount_total := coalesce(nullif(item->>'discountCents', '')::bigint, 0);
      cash_bps := coalesce(nullif(item->>'cashDiscountBps', '')::integer, 0);
      cash_discount := coalesce(nullif(item->>'cashDiscountCents', '')::bigint, 0);
      card_surcharge := coalesce(nullif(item->>'cardSurchargeCents', '')::bigint, 0);
      promo_discount := coalesce(nullif(item->>'promotionDiscountCents', '')::bigint, discount_total - cash_discount);
      discount_type := nullif(item->>'discountType', '')::public.weight_discount_type; discount_value := nullif(item->>'discountValue', '')::bigint; discount_rule := nullif(item->>'discountRuleId', '')::uuid;
      line_promotion_mode := nullif(item->>'promotionMode', '')::public.promotion_mode;
      subtotal := (item->>'subtotalCents')::bigint;
      grams := nullif(item->>'weightGrams', '')::integer;
      quantity := nullif(item->>'quantityUnits', '')::integer;
      manual_applied := coalesce((item->>'manualPriceApplied')::boolean, false);
      manual_price := nullif(item->>'manualUnitPriceCents', '')::bigint;
      manual_adjustment := nullif(item->>'manualAdjustmentCents', '')::bigint;
      sold_pack := coalesce((item->>'soldAsPack')::boolean, false);
      pack_count := nullif(item->>'packCount', '')::integer;
      pack_size := nullif(item->>'packSizeUnitsSnapshot', '')::integer;
      pack_bps := nullif(item->>'packDiscountBps', '')::integer;
      pack_discount := nullif(item->>'packDiscountCents', '')::bigint;
      pack_config := nullif(item->>'packConfigId', '')::uuid;
      bp_id := nullif(item->>'branchPromotionId', '')::uuid;
      bp_every := nullif(item->>'branchPromotionEveryUnits', '')::integer;
      bp_bps := nullif(item->>'branchPromotionDiscountBps', '')::integer;
      bp_units := nullif(item->>'branchPromotionDiscountedUnits', '')::integer;
      bp_discount := nullif(item->>'branchPromotionDiscountCents', '')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale item snapshot is malformed' using errcode = '22023'; end;
    -- D-044: only DEBIT/CREDIT may carry a nonzero bps now (the surcharge); CASH/TRANSFER/OTHER
    -- must not (they get no adjustment at all).
    if list_price <= 0 or final_price <= 0 or cash_bps not between 0 and 9999
       or (app_private.payment_method_receives_discount(method) and cash_bps <> 0)
       or cash_discount <> 0 then
      raise exception 'Offline sale item values are invalid' using errcode = '22023';
    end if;
    -- Línea con precio manual: el precio fijado ES el precio final (pricePerKgCents). No lleva promoción, pack,
    -- recargo por tarjeta ni ningún ajuste por medio de pago, y su aritmética se valida más abajo contra
    -- precio * cantidad y contra el precio original (lista) que quedó como snapshot.
    if manual_applied then
      if manual_price is null or manual_adjustment is null or manual_price <= 0 or manual_price <> final_price
         or discount_rule is not null or discount_type is not null or discount_value is not null or line_promotion_mode is not null
         or discount_total <> 0 or promo_discount <> 0 or card_surcharge <> 0 or cash_bps <> 0 then
        raise exception 'Offline manual price line is inconsistent' using errcode = '22023';
      end if;
    elsif manual_price is not null or manual_adjustment is not null then
      raise exception 'Offline manual price metadata without a manual price' using errcode = '22023';
    end if;

    -- Pack / promoción de sucursal: sólo en líneas UNIT normales, nunca juntos, nunca con precio manual ni con una
    -- promoción específica del producto (un solo descuento por línea). El detalle se revalida en la rama UNIT.
    has_unit_discount := sold_pack or pack_count is not null or pack_size is not null or pack_bps is not null or pack_discount is not null
      or pack_config is not null
      or bp_id is not null or bp_every is not null or bp_bps is not null or bp_units is not null or bp_discount is not null;
    if has_unit_discount then
      if manual_applied or quantity is null or grams is not null
         or (sold_pack and (bp_id is not null or bp_every is not null or bp_bps is not null or bp_units is not null or bp_discount is not null))
         or (not sold_pack and (pack_count is not null or pack_size is not null or pack_bps is not null or pack_discount is not null or pack_config is not null))
         or line_promotion_mode is not null or discount_rule is not null or discount_type is not null or discount_value is not null then
        raise exception 'Offline unit discount metadata is inconsistent' using errcode = '22023';
      end if;
    end if;

    if quantity is not null and grams is null then
      -- UNIT line.
      if quantity <= 0 then raise exception 'Offline sale item values are invalid' using errcode = '22023'; end if;
      list_subtotal := list_price * quantity;
      if discount_type is not null or discount_value is not null then
        raise exception 'Offline unit sale discount metadata is inconsistent' using errcode = '22023';
      end if;
      if manual_applied then
        cash_subtotal := subtotal;
        if subtotal <> manual_price * quantity or subtotal <= 0 or manual_adjustment <> subtotal - list_subtotal then
          raise exception 'Offline manual price arithmetic is invalid' using errcode = '22023';
        end if;
      elsif sold_pack or bp_id is not null then
        -- Un solo descuento sobre las unidades REALES de la línea, calculado una vez sobre el total de lista y
        -- redondeado half-up (espeja calculateUnitPackLinePricing / calculateBranchPromotionLinePricing y el
        -- insert_sale de Rust). Después, el recargo de tarjeta una sola vez sobre el total comercial de la línea.
        if sold_pack then
          if pack_count is null or pack_count < 1 or pack_size is null or pack_size not between 2 and 10000
             or quantity <> pack_count * pack_size or pack_bps is distinct from app_private.pack_discount_bps() or pack_discount is null
             or pack_config is null then
            raise exception 'Offline pack line is inconsistent' using errcode = '22023';
          end if;
          -- La versión del pack con la que el POS dice haber vendido: tiene que existir, ser de ESTE producto y coincidir con
          -- el snapshot (tamaño y porcentaje). NUNCA se compara contra products.pack_size_units actual: el Admin pudo cambiarlo
          -- mientras el dispositivo estaba sin conexión (una venta hecha con un pack de 8 sigue siendo válida).
          select * into pack_version from public.product_pack_versions v
          where v.id = pack_config and v.organization_id = org_id and v.product_id = current_product_id;
          if not found then
            raise exception 'Offline pack configuration does not belong to the sale product' using errcode = '42501';
          end if;
          if pack_version.pack_size_units <> pack_size or pack_version.discount_bps <> pack_bps then
            raise exception 'Offline pack snapshot does not match its configuration' using errcode = '22023';
          end if;
          -- Vigencia para el dispositivo que la recibió: la versión ya existía cuando se hizo la venta (tolerancia de reloj de
          -- 10 min) y, si el Admin la cerró después, el dispositivo todavía podía tenerla: un POS sólo vende con una
          -- autorización de hasta 24 h desde su último sync (pull_pos_state.authorizationExpiresAt), así que una venta posterior
          -- a valid_to + 24 h no pudo hacerse con esa versión.
          if pack_version.valid_from > completed_at + interval '10 minutes'
             or (pack_version.valid_to is not null and completed_at > pack_version.valid_to + interval '24 hours 10 minutes') then
            raise exception 'Offline pack configuration was not valid for the device that sold it' using errcode = '42501';
          end if;
          unit_discount := app_private.round_ratio_half_up(list_subtotal * pack_bps, 10000);
          if pack_discount <> unit_discount then raise exception 'Offline pack discount does not match its percentage' using errcode = '22023'; end if;
        else
          if bp_every is null or bp_every not between 2 and 1000 or bp_bps is null or bp_bps not between 1 and 9999
             or bp_units is null or bp_units <= 0 or bp_units <> (quantity / bp_every) * bp_every or bp_discount is null then
            raise exception 'Offline branch promotion line is inconsistent' using errcode = '22023';
          end if;
          -- La regla tiene que existir, ser de esta sucursal y tener exactamente los valores que el POS dice haber usado
          -- (las filas son inmutables: editar una promoción crea otra). Tolerancia de reloj: el dispositivo puede estar
          -- unos minutos atrasado respecto del servidor que creó la promoción.
          if not exists (
            select 1 from public.branch_promotions bpr
            where bpr.id = bp_id and bpr.organization_id = org_id and bpr.branch_id = branch_uuid
              and bpr.scope = 'ALL_UNIT_PRODUCTS' and bpr.every_units = bp_every and bpr.discount_bps = bp_bps
              and bpr.valid_from <= completed_at + interval '10 minutes'
          ) then
            raise exception 'Offline branch promotion does not match a rule of this branch' using errcode = '42501';
          end if;
          unit_discount := app_private.round_ratio_half_up(list_price * bp_units * bp_bps, 10000);
          if bp_discount <> unit_discount then raise exception 'Offline branch promotion discount does not match its percentage' using errcode = '22023'; end if;
        end if;
        if promo_discount <> unit_discount or discount_total <> unit_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        cash_subtotal := list_subtotal - unit_discount;
        if cash_subtotal <= 0 then raise exception 'Offline unit discount leaves the line at zero' using errcode = '22023'; end if;
        if subtotal <> (case when cash_bps > 0 then app_private.round_ratio_half_up(cash_subtotal * (10000 + cash_bps), 10000) else cash_subtotal end)
           or final_price <> app_private.round_ratio_half_up(subtotal, quantity) then
          raise exception 'Offline unit discount line is inconsistent' using errcode = '22023';
        end if;
      elsif line_promotion_mode = 'PACK_FIXED_TOTAL' then
        if discount_rule is null then raise exception 'Offline pack sale is missing its promotion id' using errcode = '22023'; end if;
        select * into pack_promo from public.product_weight_discounts
        where id = discount_rule and organization_id = org_id and product_id = current_product_id and promotion_mode = 'PACK_FIXED_TOTAL';
        if not found or pack_promo.pack_quantity_units is null then raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501'; end if;
        if pack_promo.pack_price_cents > list_price * pack_promo.pack_quantity_units then
          raise exception 'El precio del pack supera el precio de lista para su cantidad' using errcode = '22023';
        end if;
        whole_packs := quantity / pack_promo.pack_quantity_units;
        remainder := quantity % pack_promo.pack_quantity_units;
        -- Pack total: CASH-equivalent = whole packs at their fixed price + remainder at plain
        -- list (never a discounted rate) — the surcharge (D-044, corrected) is ONE rounding on
        -- the WHOLE resulting total below, never only on the remainder.
        cash_subtotal := pack_promo.pack_price_cents * whole_packs + list_price * remainder;
        if promo_discount <> greatest(list_price * (whole_packs * pack_promo.pack_quantity_units) - pack_promo.pack_price_cents * whole_packs, 0)
           or discount_total <> promo_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        if subtotal <> (case when cash_bps > 0 then app_private.round_ratio_half_up(cash_subtotal * (10000 + cash_bps), 10000) else cash_subtotal end)
           or final_price <> subtotal then
          raise exception 'Offline pack promotion is inconsistent' using errcode = '22023';
        end if;
      else
        cash_subtotal := list_subtotal;
        if promo_discount <> 0 or discount_total <> 0 then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        -- Non-pack: round once at the per-unit level (mirrors calculateSalePricing exactly,
        -- since quantityDivisor 1 makes its own subtotal rounding a no-op), then multiply exactly
        -- — not a single rounding on the subtotal, which can disagree by a cent for some quantities.
        if final_price <> (case when cash_bps > 0 then app_private.round_ratio_half_up(list_price * (10000 + cash_bps), 10000) else list_price end)
           or subtotal <> final_price * quantity then
          raise exception 'Undiscounted snapshot is inconsistent' using errcode = '22023';
        end if;
      end if;
      if card_surcharge <> subtotal - cash_subtotal then
        raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
      end if;
      if not exists(select 1 from public.products p where p.id = current_product_id and p.organization_id = org_id and p.unit_type = 'UNIT') then
        raise exception 'Offline sale product does not belong to the device organization' using errcode = '42501';
      end if;
      if (movement->>'productId')::uuid <> current_product_id or (movement->>'quantityGrams')::bigint <> -quantity::bigint then
        raise exception 'Offline stock movement does not match its sale item' using errcode = '22023';
      end if;

      select c.cost_cents into cost_snapshot from public.product_costs c
      where c.organization_id = org_id and c.product_id = current_product_id and c.valid_from <= completed_at and (c.valid_to is null or c.valid_to > completed_at)
      order by c.valid_from desc limit 1;
      select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s
      where s.organization_id = org_id and s.product_id = current_product_id and s.valid_from <= completed_at and (s.valid_to is null or s.valid_to > completed_at)
      order by s.valid_from desc limit 1;

      insert into public.sale_items(
        id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents,
        original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, final_price_per_kg_cents,
        discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_cents_snapshot,
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at,
        manual_price_applied, manual_unit_price_cents, manual_adjustment_cents,
        sold_as_pack, pack_size_units_snapshot, pack_count, pack_discount_bps, pack_discount_cents, pack_config_id,
        branch_promotion_id, branch_promotion_every_units, branch_promotion_discount_bps, branch_promotion_discounted_units, branch_promotion_discount_cents
      ) values (
        (item->>'id')::uuid, sale_id, org_id, branch_uuid, current_product_id, item->>'productNameSnapshot', quantity, final_price,
        list_price, discount_rule, null, null, final_price, discount_total, cash_bps, 0, card_surcharge,
        promo_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, completed_at,
        manual_applied, manual_price, coalesce(manual_adjustment, 0),
        sold_pack, pack_size, pack_count, pack_bps, coalesce(pack_discount, 0), pack_config,
        bp_id, bp_every, bp_bps, bp_units, coalesce(bp_discount, 0)
      );
      insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values ((movement->>'id')::uuid, org_id, branch_uuid, current_product_id, 'SALE', -quantity::bigint, sale_id, profile_id, (movement->>'occurredAt')::timestamptz, completed_at);
      computed_total := computed_total + subtotal;
    else
      -- WEIGHT line.
      if grams is null or grams <= 0 then raise exception 'Offline sale item values are invalid' using errcode = '22023'; end if;
      list_subtotal := app_private.round_ratio_half_up(list_price * grams, 1000);

      if manual_applied then
        cash_subtotal := subtotal;
        if subtotal <> app_private.round_ratio_half_up(manual_price * grams, 1000) or subtotal <= 0 or manual_adjustment <> subtotal - list_subtotal then
          raise exception 'Offline manual price arithmetic is invalid' using errcode = '22023';
        end if;
      elsif line_promotion_mode = 'PACK_FIXED_TOTAL' then
        if discount_type is not null or discount_value is not null then
          raise exception 'Offline pack promotion metadata is inconsistent' using errcode = '22023';
        end if;
        if discount_rule is null then raise exception 'Offline pack sale is missing its promotion id' using errcode = '22023'; end if;
        select * into pack_promo from public.product_weight_discounts
        where id = discount_rule and organization_id = org_id and product_id = current_product_id and promotion_mode = 'PACK_FIXED_TOTAL';
        if not found then raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501'; end if;
        -- Guard against LIST price, before any card surcharge — the pack total is
        -- payment-method-invariant only up to this guard, not in the final charged amount below.
        if pack_promo.pack_price_cents > list_subtotal then raise exception 'El precio del pack supera el precio de lista para el peso pesado' using errcode = '22023'; end if;
        cash_subtotal := pack_promo.pack_price_cents;
        if promo_discount <> greatest(list_subtotal - cash_subtotal, 0) or discount_total <> promo_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        -- The surcharge (D-044, corrected) applies to the WHOLE pack total below — one rounding,
        -- mirrors calculateWeightPackSalePricing exactly (no single per-kg rate to round first).
        if subtotal <> (case when cash_bps > 0 then app_private.round_ratio_half_up(cash_subtotal * (10000 + cash_bps), 10000) else cash_subtotal end)
           or final_price <> app_private.round_ratio_half_up(subtotal * 1000, grams) then
          raise exception 'Offline pack promotion is inconsistent' using errcode = '22023';
        end if;
      else
        if discount_type = 'PERCENTAGE' then
          if discount_value not between 1 and 10000 then raise exception 'Offline percentage promotion is inconsistent' using errcode = '22023'; end if;
          promo_price := app_private.round_ratio_half_up(list_price * (10000 - discount_value), 10000);
        elsif discount_type = 'FIXED_PRICE_PER_KG' then
          if discount_value <= 0 then raise exception 'Offline fixed-price promotion is inconsistent' using errcode = '22023'; end if;
          promo_price := discount_value;
        elsif discount_rule is not null or discount_value is not null then
          raise exception 'Offline promotion metadata is inconsistent' using errcode = '22023';
        else
          promo_price := list_price;
        end if;
        if promo_price > list_price then raise exception 'Offline promotion cannot increase a price' using errcode = '22023'; end if;
        cash_subtotal := app_private.round_ratio_half_up(promo_price * grams, 1000);
        if promo_discount <> list_subtotal - cash_subtotal or discount_total <> promo_discount then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        -- Non-pack: round once at the per-kg level (list -> promotion -> surcharge, D-044,
        -- corrected), THEN derive the subtotal from grams — mirrors calculateSalePricing exactly.
        if final_price <> (case when cash_bps > 0 then app_private.round_ratio_half_up(promo_price * (10000 + cash_bps), 10000) else promo_price end)
           or subtotal <> app_private.round_ratio_half_up(final_price * grams, 1000) then
          raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
        end if;
        if discount_rule is not null and not exists(
          select 1 from public.product_weight_discounts pwd where pwd.id = discount_rule and pwd.organization_id = org_id and pwd.product_id = current_product_id
        ) then
          raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501';
        end if;
      end if;
      if card_surcharge <> subtotal - cash_subtotal then
        raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
      end if;

      if not exists(select 1 from public.products p where p.id = current_product_id and p.organization_id = org_id and p.unit_type = 'WEIGHT') then
        raise exception 'Offline sale product does not belong to the device organization' using errcode = '42501';
      end if;
      if (movement->>'productId')::uuid <> current_product_id or (movement->>'quantityGrams')::bigint <> -grams::bigint then
        raise exception 'Offline stock movement does not match its sale item' using errcode = '22023';
      end if;
      select c.cost_cents into cost_snapshot from public.product_costs c
      where c.organization_id = org_id and c.product_id = current_product_id and c.valid_from <= completed_at and (c.valid_to is null or c.valid_to > completed_at)
      order by c.valid_from desc limit 1;
      select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s
      where s.organization_id = org_id and s.product_id = current_product_id and s.valid_from <= completed_at and (s.valid_to is null or s.valid_to > completed_at)
      order by s.valid_from desc limit 1;

      insert into public.sale_items(
        id, sale_id, organization_id, branch_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents,
        original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, final_price_per_kg_cents,
        discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_cents_snapshot,
        profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at,
        manual_price_applied, manual_unit_price_cents, manual_adjustment_cents
      ) values (
        (item->>'id')::uuid, sale_id, org_id, branch_uuid, current_product_id, item->>'productNameSnapshot', grams, final_price,
        list_price, discount_rule, discount_type, discount_value, final_price, discount_total, cash_bps, 0, card_surcharge,
        promo_discount, cost_snapshot, profit_snapshot, subtotal, line_promotion_mode, completed_at,
        manual_applied, manual_price, coalesce(manual_adjustment, 0)
      );
      insert into public.stock_movements(id, organization_id, branch_id, product_id, type, quantity_grams, sale_id, profile_id, occurred_at, created_at)
      values ((movement->>'id')::uuid, org_id, branch_uuid, current_product_id, 'SALE', -grams::bigint, sale_id, profile_id, (movement->>'occurredAt')::timestamptz, completed_at);
      computed_total := computed_total + subtotal; computed_weight := computed_weight + grams;
    end if;
  end loop;

  -- Descuento general del ticket (D-061): el servidor recalcula el importe con la misma regla que el POS
  -- (porcentaje en basis points sobre la suma final de las líneas, redondeo half-up) y rechaza la venta si lo
  -- declarado no coincide. Lo cobrado (sales.total_cents y el pago) es la suma de las líneas menos ese descuento.
  if (p_payload ? 'ticketDiscountBps') <> (p_payload ? 'ticketDiscountCents') then
    raise exception 'Offline ticket discount needs both its percentage and its amount' using errcode = '22023';
  end if;
  begin
    discount_bps := coalesce(nullif(p_payload->>'ticketDiscountBps', '')::integer, 0);
    declared_discount := coalesce(nullif(p_payload->>'ticketDiscountCents', '')::bigint, 0);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Offline ticket discount is malformed' using errcode = '22023';
  end;
  if p_payload ? 'ticketDiscountBps' and discount_bps not between 1 and 10000 then
    raise exception 'Offline ticket discount percentage is outside 0-100%%' using errcode = '22023';
  end if;
  expected_discount := app_private.round_ratio_half_up(computed_total * discount_bps, 10000);
  if declared_discount <> expected_discount then
    raise exception 'Offline ticket discount does not match its percentage' using errcode = '22023';
  end if;
  if p_payload ? 'subtotalCents' and (p_payload->>'subtotalCents')::bigint <> computed_total then
    raise exception 'Offline ticket subtotal does not match its items' using errcode = '22023';
  end if;
  net_total := computed_total - expected_discount;
  if net_total <= 0 then raise exception 'Offline sale total must be greater than zero' using errcode = '22023'; end if;
  if net_total <> declared_total or computed_weight <> declared_weight or (p_payload->'payment'->>'amountCents')::bigint <> declared_total then
    raise exception 'Offline sale totals do not match its details' using errcode = '22023';
  end if;
  update public.sales set total_cents = net_total, total_weight_grams = computed_weight,
    ticket_discount_bps = discount_bps, ticket_discount_cents = expected_discount where id = sale_id;
  select coalesce(array_agg((e.value->>'id')::uuid order by e.ordinality), '{}'::uuid[]) into ordered_item_ids
  from jsonb_array_elements(p_payload->'items') with ordinality as e(value, ordinality);
  perform app_private.allocate_ticket_discount(sale_id, ordered_item_ids);
  insert into public.payments(id, sale_id, organization_id, branch_id, method, amount_cents, created_at)
  values ((p_payload->'payment'->>'id')::uuid, sale_id, org_id, branch_uuid, method, declared_total, completed_at);
  return jsonb_build_object('saleId', sale_id, 'duplicate', false, 'syncedAt', now());
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. pull_pos_state: cuerpo de 202610030059 + packSizeUnits / packConfigId (versión vigente) en cada producto + branchPromotions
--    de la sucursal del dispositivo.
-- ---------------------------------------------------------------------------------------------
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
  promotions_payload jsonb;
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
      assigned_categories.category_ids, product_codes.barcodes,
      pack_version.pack_size_units as pack_size_units, pack_version.id as pack_config_id
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
    -- Versión VIGENTE del pack (su id viaja al POS y se guarda en cada línea vendida como Pack).
    left join lateral (
      select v.id, v.pack_size_units
      from public.product_pack_versions v
      where v.product_id = p.id and v.organization_id = p.organization_id and v.valid_to is null
    ) pack_version on true
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
    'barcodes', coalesce(to_jsonb(barcodes), '[]'::jsonb), 'packSizeUnits', pack_size_units, 'packConfigId', pack_config_id
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
  -- Productos borrados de verdad: ya no existen en `products`, pero el log del cursor guarda su id.
  if p_after_sequence > 0 then
    select removed_payload || coalesce(jsonb_agg(deleted.id), '[]'::jsonb) into removed_payload
    from (
      select distinct c.entity_id as id
      from public.pos_catalog_changes c
      where c.organization_id = current_organization_id and c.sequence > p_after_sequence
        and (c.branch_id is null or c.branch_id = current_branch_id)
        and c.entity_type = 'PRODUCT'
        and not exists (select 1 from public.products p where p.id = c.entity_id)
    ) deleted;
  end if;
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

  -- Promociones globales de ESTA sucursal: foto completa en cada pull (como el directorio de categorías), no un delta.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', bp.id, 'scope', bp.scope, 'everyUnits', bp.every_units, 'discountBps', bp.discount_bps
  ) order by bp.valid_from, bp.id), '[]'::jsonb)
  into promotions_payload
  from public.branch_promotions bp
  where bp.organization_id = current_organization_id and bp.branch_id = current_branch_id
    and bp.active and bp.valid_from <= current_server_time and (bp.valid_until is null or bp.valid_until > current_server_time);

  update public.pos_devices set last_seen_at = current_server_time where id = p_device_id;
  return jsonb_build_object(
    'cursor', current_cursor, 'serverTime', current_server_time,
    'authorizationExpiresAt', current_server_time + interval '24 hours',
    'organizationId', current_organization_id, 'branchId', current_branch_id,
    'branchName', current_branch_name, 'branchActive', current_branch_active,
    'deviceStatus', current_device_status, 'roleName', current_role_name,
    'catalog', catalog_payload, 'removedProductIds', removed_payload, 'categories', categories_payload,
    'branchPromotions', promotions_payload
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Hechos del ticket de WhatsApp (cuerpo de 202610020058 + Pack / promoción de sucursal por línea).
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.wa_sale_ticket_json(p_sale_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'saleId', s.id,
    'status', s.status,
    'completedAt', s.completed_at,
    'totalCents', s.total_cents,
    'ticketDiscountBps', s.ticket_discount_bps,
    'ticketDiscountCents', s.ticket_discount_cents,
    'organizationName', o.name,
    'branchName', b.name,
    'timezone', o.timezone,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', i.product_name_snapshot,
        'weightGrams', i.weight_grams,
        'quantityUnits', i.quantity_units,
        'unitPriceCents', coalesce(i.manual_unit_price_cents, i.original_price_per_kg_cents),
        'manualPriceApplied', i.manual_price_applied,
        'promotionDiscountCents', i.promotion_discount_cents,
        'cardSurchargeCents', i.card_surcharge_cents,
        'subtotalCents', i.subtotal_cents,
        'promotionMode', i.promotion_mode,
        'soldAsPack', i.sold_as_pack,
        'packCount', i.pack_count,
        'packSizeUnits', i.pack_size_units_snapshot,
        'packDiscountBps', i.pack_discount_bps,
        'branchPromotionEveryUnits', i.branch_promotion_every_units,
        'branchPromotionDiscountBps', i.branch_promotion_discount_bps,
        'branchPromotionDiscountedUnits', i.branch_promotion_discounted_units
      ) order by i.created_at, i.id)
      from public.sale_items i where i.sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', p.method, 'provider', p.provider,
        'verificationStatus', p.verification_status, 'amountCents', p.amount_cents
      ) order by p.created_at, p.id)
      from public.payments p where p.sale_id = s.id
    ), '[]'::jsonb)
  )
  from public.sales s
  join public.organizations o on o.id = s.organization_id
  join public.branches b on b.id = s.branch_id
  where s.id = p_sale_id
$$;

commit;
