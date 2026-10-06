begin;

-- Formación de precio a partir del costo y de una configuración GLOBAL de la organización (D-068).
--
--   MARGEN = margen real sobre el PRECIO DE VENTA (no markup sobre costo):  precio = costo / (1 - margen).
--   Reutiliza el gross-up existente (public.calculate_product_price, 202609130012): con markup 0 su precio de lista es
--   round_half_up(costo * 10000 / (10000 - bps)), que es exactamente esa fórmula. No hay una segunda fórmula paralela.
--
--   Esta migración NO recalcula ningún precio ni cambia ningún pack/promoción: todos los valores nuevos empiezan SIN CONFIGURAR
--   (NULL / sin fila). El recálculo masivo ocurre cuando el administrador guarda conscientemente la configuración
--   (public.save_pricing_config), con una confirmación previa que informa cuántos precios cambian.
--
-- Ajustes de la segunda pasada (misma migración, todavía sin aplicar):
--   * PACK 0 %: "pack" (unidades por pack) y "descuento del pack" son conceptos independientes. El descuento global puede ser 0 %
--     (el pack sigue existiendo y vendiéndose como carga rápida de N unidades, sin descuento). Se relajan los checks 1..9999 -> 0..9999
--     de products, product_pack_versions, sale_items.pack_discount_bps y de sync_offline_sale_core (cuerpo de 202610040061 con ese único
--     cambio). Las versiones siguen siendo inmutables: 20 % -> 0 % -> 15 % abre una versión por cambio y cada venta conserva la suya.
--   * PRECIOS POR SUCURSAL: un product_prices con branch_id GANA sobre el global en el POS (orden "sucursal primero"). Ninguna pantalla vigente
--     los crea, pero pueden existir. El recálculo informa cuántos hay (branchOverrides) y puede CERRARLOS (nunca borrarlos) para que valga el
--     precio global; public.close_branch_price_overrides hace lo mismo a pedido.
--   * IMPORTACIÓN: con margen configurado y costo en el archivo, el precio se forma desde el costo (import_apply_product).
--
-- Qué NO cambia (preservado a propósito): product_prices / product_costs siguen siendo append-only con vigencias; el sync POS,
-- los snapshots de venta, product_pack_versions y branch_promotions (el POS recibe las mismas claves de siempre); el recargo
-- por tarjeta sigue en organization_cash_discounts (public.set_cash_discount); complete_production_batch, la importación y el
-- alta rápida del POS siguen escribiendo costos/precios como hasta ahora.

-- ---------------------------------------------------------------------------------------------
-- 1. Configuración global de precios (una fila por organización; sin fila = todo sin configurar)
-- ---------------------------------------------------------------------------------------------
create table public.organization_pricing_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  -- Margen sobre el precio de venta, en basis points (1..9999). NULL = todavía no configurado: cambiar un costo no toca el precio.
  margin_bps integer check (margin_bps between 1 and 9999),
  -- Descuento "llevando 3u" (desde 3 unidades del mismo producto UNIT, sobre toda la línea). 0 = sin promoción. NULL = sin configurar.
  unit_bulk_discount_bps integer check (unit_bulk_discount_bps between 0 and 9999),
  -- Descuento de pack de TODOS los productos UNIT con pack. 0 = el pack sigue existiendo pero sin descuento (las unidades por pack
  -- y el descuento son independientes). NULL = sin configurar (cada producto conserva el descuento propio que ya tenía).
  pack_discount_bps integer check (pack_discount_bps between 0 and 9999),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organization_pricing_settings_set_updated_at before update on public.organization_pricing_settings
for each row execute function app_private.set_updated_at();
create trigger organization_pricing_settings_audit after insert or update on public.organization_pricing_settings
for each row execute function app_private.audit_row_change();

alter table public.organization_pricing_settings enable row level security;
create policy organization_pricing_settings_admin_select on public.organization_pricing_settings
for select to authenticated using (app_private.has_permission(organization_id, 'prices.write'));
revoke all on table public.organization_pricing_settings from public, anon, authenticated;
grant select on table public.organization_pricing_settings to authenticated;

comment on table public.organization_pricing_settings is
  'Configuración global de precios de la organización (D-068): margen sobre precio de venta, descuento "llevando 3u" y descuento de pack. El recargo por tarjeta sigue en organization_cash_discounts. Sólo se escribe con save_pricing_config.';
comment on column public.organization_pricing_settings.margin_bps is
  'Margen de ganancia sobre el PRECIO DE VENTA en basis points: precio de lista = costo / (1 - margen). NULL = sin configurar (los precios no se derivan del costo).';
comment on column public.organization_pricing_settings.unit_bulk_discount_bps is
  'Descuento "llevando 3u": desde 3 unidades del mismo producto UNIT, todas las unidades de la línea. Se materializa como una regla FROM_MINIMUM (mínimo 3) en branch_promotions de cada sucursal (la fuente que lee el POS). 0 = sin promoción; NULL = sin configurar.';
comment on column public.organization_pricing_settings.pack_discount_bps is
  'Descuento de pack global. Se materializa en products.pack_discount_bps de cada producto con pack (el trigger de versiones abre una product_pack_versions nueva por pack). NULL = sin configurar.';

-- ---------------------------------------------------------------------------------------------
-- 2. Fórmula: precio de lista a partir del costo y el margen (gross-up existente, markup 0)
-- ---------------------------------------------------------------------------------------------
create function app_private.list_price_from_margin(p_cost_cents bigint, p_margin_bps integer)
returns bigint
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  list_price bigint;
begin
  if p_cost_cents is null or p_cost_cents <= 0 then
    raise exception 'El costo tiene que ser mayor a cero' using errcode = '22023';
  end if;
  if p_margin_bps is null or p_margin_bps not between 1 and 9999 then
    raise exception 'El margen tiene que ser mayor a 0 %% y menor a 100 %%' using errcode = '22023';
  end if;
  -- calculate_product_price(costo, markup 0, bps) = round_half_up(costo * 10000 / (10000 - bps)).
  select cp.list_price_cents into list_price from public.calculate_product_price(p_cost_cents, 0, p_margin_bps) cp;
  return list_price;
end;
$$;

create function app_private.pricing_margin_bps(p_organization_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select s.margin_bps from public.organization_pricing_settings s where s.organization_id = p_organization_id;
$$;

-- Abre una vigencia nueva de precio de lista (global) con el precio derivado del costo y el margen, SALVO que el precio vigente ya
-- sea ese (no ensucia el historial) o haya un precio global programado a futuro (se respeta). Devuelve qué pasó.
create function app_private.reprice_from_margin(
  p_organization_id uuid,
  p_product_id uuid,
  p_cost_cents bigint,
  p_margin_bps integer,
  p_at timestamptz,
  p_actor uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  new_price bigint := app_private.list_price_from_margin(p_cost_cents, p_margin_bps);
  current_price bigint;
begin
  if exists (
    select 1 from public.product_prices pp
    where pp.organization_id = p_organization_id and pp.product_id = p_product_id and pp.branch_id is null and pp.valid_from > p_at
  ) then
    return 'SCHEDULED';
  end if;
  select pp.price_cents into current_price
  from public.product_prices pp
  where pp.organization_id = p_organization_id and pp.product_id = p_product_id and pp.branch_id is null
    and pp.valid_from <= p_at and (pp.valid_to is null or pp.valid_to > p_at)
  order by pp.valid_from desc
  limit 1;
  if current_price is not null and current_price = new_price then
    return 'UNCHANGED';
  end if;
  perform app_private.set_price_history(p_organization_id, p_product_id, new_price, p_at, p_actor);
  return 'REPRICED';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Costo nuevo => precio nuevo, en la MISMA operación
-- ---------------------------------------------------------------------------------------------
-- Cierra el costo vigente, abre el nuevo y, si hay margen configurado y el producto se vende, abre la vigencia de precio derivada.
-- price_outcome: REPRICED | UNCHANGED | SCHEDULED | NO_MARGIN (margen sin configurar) | NOT_SELLABLE (inactivo o sólo materia prima).
create function app_private.apply_product_cost(
  p_organization_id uuid,
  p_product_id uuid,
  p_cost_cents bigint,
  p_at timestamptz,
  p_actor uuid,
  out cost_id uuid,
  out price_outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  margin integer := app_private.pricing_margin_bps(p_organization_id);
  sellable boolean;
begin
  update public.product_costs pc
  set valid_to = p_at
  where pc.organization_id = p_organization_id and pc.product_id = p_product_id
    and pc.valid_from < p_at and (pc.valid_to is null or pc.valid_to > p_at);

  insert into public.product_costs (organization_id, product_id, cost_cents, valid_from, created_by)
  values (p_organization_id, p_product_id, p_cost_cents, p_at, p_actor)
  returning id into cost_id;

  select p.active and p.inventory_role in ('SELLABLE', 'BOTH') into sellable
  from public.products p where p.id = p_product_id and p.organization_id = p_organization_id;
  if margin is null then
    price_outcome := 'NO_MARGIN';
  elsif not coalesce(sellable, false) then
    price_outcome := 'NOT_SELLABLE';
  else
    -- La vigencia de precio empieza ahora (o en la fecha futura pedida): nunca antes de un precio que otra transacción ya haya
    -- confirmado (p_at por defecto es el inicio de ESTA transacción), para no solapar vigencias.
    price_outcome := app_private.reprice_from_margin(
      p_organization_id, p_product_id, p_cost_cents, margin, greatest(p_at, clock_timestamp()), p_actor
    );
  end if;
end;
$$;

-- Misma firma y mismo retorno (id de la vigencia de costo) que en 202609220030: el Admin ya desplegado sigue funcionando. Ahora, con
-- margen configurado, además recalcula el precio de lista del producto (misma transacción).
create or replace function public.set_product_cost(
  p_product_id uuid,
  p_cost_cents bigint,
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
  applied record;
begin
  if p_effective_at < now() - interval '5 minutes' then
    raise exception 'A new cost cannot start in the historical past' using errcode = '22023';
  end if;
  if p_cost_cents is null or p_cost_cents <= 0 then
    raise exception 'Cost must be positive' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.products p
    where p.id = p_product_id and p.organization_id = current_organization_id
  ) then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;

  select * into applied
  from app_private.apply_product_cost(current_organization_id, p_product_id, p_cost_cents, p_effective_at, auth.uid());
  return applied.cost_id;
end;
$$;

-- Carga masiva de costos ("Productos → Precios"): una sola llamada atómica. Cada costo que cambió abre su vigencia de costo y, con
-- margen configurado, su vigencia de precio. Un costo igual al vigente no se vuelve a guardar (idempotente ante un doble envío).
create function public.bulk_set_product_costs(
  p_items jsonb,
  p_effective_at timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  margin integer := app_private.pricing_margin_bps(current_organization_id);
  item jsonb;
  item_product uuid;
  item_cost bigint;
  current_cost bigint;
  outcome text;
  applied integer := 0;
  repriced integer := 0;
  price_unchanged integer := 0;
  cost_unchanged integer := 0;
  scheduled integer := 0;
  overrides integer := 0;
begin
  if p_effective_at < now() - interval '5 minutes' then
    raise exception 'Un costo nuevo no puede empezar en el pasado' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'Debe enviar entre 1 y 500 costos' using errcode = '22023';
  end if;

  -- Validar todo antes de escribir, para que el error nombre al producto en vez de fallar a mitad de camino.
  for item in select * from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(item -> 'costCents') is distinct from 'number' or (item ->> 'costCents') !~ '^[0-9]+$'
       or (item ->> 'costCents')::numeric <= 0 then
      raise exception 'El costo tiene que ser un importe mayor a cero' using errcode = '22023';
    end if;
    item_product := (item ->> 'productId')::uuid;
    if not exists (
      select 1 from public.products p
      where p.id = item_product and p.organization_id = current_organization_id and p.active
        and p.inventory_role in ('SELLABLE', 'BOTH')
    ) then
      raise exception 'Uno de los productos enviados no existe, está inactivo o no es un producto de venta' using errcode = '42501';
    end if;
  end loop;
  if (select count(distinct (i ->> 'productId')) from jsonb_array_elements(p_items) i) <> jsonb_array_length(p_items) then
    raise exception 'Un producto no puede venir dos veces en la misma carga' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(p_items)
  loop
    item_product := (item ->> 'productId')::uuid;
    item_cost := (item ->> 'costCents')::bigint;
    select pc.cost_cents into current_cost
    from public.product_costs pc
    where pc.organization_id = current_organization_id and pc.product_id = item_product
      and pc.valid_from <= p_effective_at and (pc.valid_to is null or pc.valid_to > p_effective_at)
    order by pc.valid_from desc
    limit 1;
    if current_cost is not null and current_cost = item_cost then
      cost_unchanged := cost_unchanged + 1;
      continue;
    end if;
    select a.price_outcome into outcome
    from app_private.apply_product_cost(current_organization_id, item_product, item_cost, p_effective_at, auth.uid()) a;
    applied := applied + 1;
    if outcome = 'REPRICED' then repriced := repriced + 1;
    elsif outcome = 'UNCHANGED' then price_unchanged := price_unchanged + 1;
    elsif outcome = 'SCHEDULED' then scheduled := scheduled + 1;
    end if;
    -- Un precio vigente de sucursal sigue ganando sobre el global recién formado: se informa (no se toca).
    if outcome in ('REPRICED', 'UNCHANGED') and exists (
      select 1 from public.product_prices pp
      where pp.organization_id = current_organization_id and pp.product_id = item_product and pp.branch_id is not null
        and pp.valid_from <= clock_timestamp() and (pp.valid_to is null or pp.valid_to > clock_timestamp())
    ) then
      overrides := overrides + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'applied', applied, 'repriced', repriced, 'priceUnchanged', price_unchanged,
    'costUnchanged', cost_unchanged, 'scheduledPrice', scheduled, 'marginConfigured', margin is not null,
    'branchOverrides', overrides
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Cambio de margen => recálculo masivo de precios de lista (server-side, una transacción)
-- ---------------------------------------------------------------------------------------------
-- Alcance: productos ACTIVOS y vendibles (SELLABLE/BOTH) con costo vigente > 0. Sin costo: no se inventa ni se pisa el precio (se
-- cuentan como withoutCost). Un precio global programado a futuro se respeta (scheduled). Los overrides por sucursal no se tocan.
-- Dos sentencias (cerrar vigencias, abrir vigencias) en vez de una por producto: es lo que permite recalcular miles en una pasada.
create function app_private.recalculate_prices_from_margin(
  p_organization_id uuid,
  p_margin_bps integer,
  p_actor uuid,
  p_apply boolean,
  p_close_overrides boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  at_time timestamptz := clock_timestamp();
  ids uuid[];
  prices bigint[];
  eligible_ids uuid[];
  eligible_count integer;
  sellable_count integer;
  scheduled_count integer;
  unchanged_count integer;
  override_count integer;
  override_other integer;
  override_closed integer := 0;
begin
  select
    coalesce(array_agg(c.product_id) filter (where c.changed), '{}'),
    coalesce(array_agg(c.new_price) filter (where c.changed), '{}'),
    coalesce(array_agg(c.product_id) filter (where not c.scheduled), '{}'),
    count(*),
    count(*) filter (where c.scheduled),
    count(*) filter (where not c.scheduled and not c.changed)
  into ids, prices, eligible_ids, eligible_count, scheduled_count, unchanged_count
  from (
    select e.product_id, e.new_price, s.scheduled,
      (not s.scheduled and cur.price_cents is distinct from e.new_price) as changed
    from (
      select p.id as product_id, app_private.list_price_from_margin(pc.cost_cents, p_margin_bps) as new_price
      from public.products p
      join public.product_costs pc on pc.organization_id = p.organization_id and pc.product_id = p.id
        and pc.valid_from <= at_time and (pc.valid_to is null or pc.valid_to > at_time)
      where p.organization_id = p_organization_id and p.active and p.inventory_role in ('SELLABLE', 'BOTH') and pc.cost_cents > 0
    ) e
    cross join lateral (
      select exists (
        select 1 from public.product_prices fp
        where fp.organization_id = p_organization_id and fp.product_id = e.product_id and fp.branch_id is null and fp.valid_from > at_time
      ) as scheduled
    ) s
    left join lateral (
      select pp.price_cents from public.product_prices pp
      where pp.organization_id = p_organization_id and pp.product_id = e.product_id and pp.branch_id is null
        and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time)
      order by pp.valid_from desc
      limit 1
    ) cur on true
  ) c;

  select count(*) into sellable_count
  from public.products p
  where p.organization_id = p_organization_id and p.active and p.inventory_role in ('SELLABLE', 'BOTH');

  -- Precios VIGENTES por sucursal: en el POS un precio de sucursal gana sobre el global (orden "sucursal primero"), así que dejarían
  -- de ver el precio recién formado. branchOverrides = los de productos que este recálculo reprecia (o confirma); branchOverridesOther =
  -- los de productos que quedan fuera (sin costo, programados, inactivos).
  select count(*) into override_count
  from public.product_prices pp
  where pp.organization_id = p_organization_id and pp.branch_id is not null and pp.product_id = any (eligible_ids)
    and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time);
  select count(*) into override_other
  from public.product_prices pp
  where pp.organization_id = p_organization_id and pp.branch_id is not null and not (pp.product_id = any (eligible_ids))
    and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time);

  if p_apply and cardinality(ids) > 0 then
    update public.product_prices pp
    set valid_to = at_time
    from unnest(ids) as changed(product_id)
    where pp.organization_id = p_organization_id and pp.product_id = changed.product_id and pp.branch_id is null
      and pp.valid_from < at_time and (pp.valid_to is null or pp.valid_to > at_time);

    insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from, created_by)
    select p_organization_id, changed.product_id, null, changed.price_cents, at_time, p_actor
    from unnest(ids, prices) as changed(product_id, price_cents);
  end if;

  -- Cerrar (no borrar) los precios por sucursal de esos productos: la fila conserva su precio y su historia, sólo deja de regir.
  if p_apply and p_close_overrides and override_count > 0 then
    update public.product_prices pp
    set valid_to = at_time
    where pp.organization_id = p_organization_id and pp.branch_id is not null and pp.product_id = any (eligible_ids)
      and pp.valid_from < at_time and (pp.valid_to is null or pp.valid_to > at_time);
    get diagnostics override_closed = row_count;
  end if;

  return jsonb_build_object(
    'recalculated', cardinality(ids), 'unchanged', unchanged_count, 'scheduledPrice', scheduled_count,
    'withoutCost', sellable_count - eligible_count,
    'branchOverrides', override_count, 'branchOverridesOther', override_other, 'branchOverridesClosed', override_closed
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. "Llevando 3u": la configuración global se materializa en branch_promotions (la fuente que lee el POS y valida el sync)
-- ---------------------------------------------------------------------------------------------
-- Desde 3 unidades del mismo producto, `p_discount_bps` sobre TODAS las unidades de la línea (semántica FROM_MINIMUM; nunca
-- EVERY_GROUP). Misma lógica de versionado que save_branch_promotion (202610040061): editar cierra la regla vigente y abre otra
-- con id nuevo, así una venta offline sigue validándose contra la regla que usó. 0 = apagar. Devuelve si algo cambió.
create function app_private.apply_unit_bulk_promotion(
  p_organization_id uuid,
  p_branch_id uuid,
  p_discount_bps integer,
  p_actor uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_row public.branch_promotions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('branch_promotion:' || p_branch_id::text, 0));
  select * into current_row
  from public.branch_promotions bp
  where bp.branch_id = p_branch_id and bp.scope = 'ALL_UNIT_PRODUCTS' and bp.active
  for update;

  if p_discount_bps = 0 then
    if found then
      update public.branch_promotions set active = false, valid_until = greatest(now(), valid_from) where id = current_row.id;
      return true;
    end if;
    return false;
  end if;
  if found then
    if current_row.semantics = 'FROM_MINIMUM' and current_row.minimum_units = 3 and current_row.discount_bps = p_discount_bps then
      return false;
    end if;
    update public.branch_promotions set active = false, valid_until = greatest(now(), valid_from) where id = current_row.id;
  end if;
  insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps, semantics, created_by)
  values (p_organization_id, p_branch_id, 3, p_discount_bps, 'FROM_MINIMUM', p_actor);
  return true;
end;
$$;

-- Una sucursal nueva nace con la promoción global vigente (si la organización ya la configuró).
create function app_private.apply_unit_bulk_promotion_to_new_branch()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bulk_bps integer;
begin
  select s.unit_bulk_discount_bps into bulk_bps
  from public.organization_pricing_settings s where s.organization_id = new.organization_id;
  if bulk_bps is not null and bulk_bps > 0 then
    perform app_private.apply_unit_bulk_promotion(new.organization_id, new.id, bulk_bps, auth.uid());
  end if;
  return new;
end;
$$;

create trigger branches_apply_unit_bulk_promotion after insert on public.branches
for each row execute function app_private.apply_unit_bulk_promotion_to_new_branch();

-- ---------------------------------------------------------------------------------------------
-- 5b. Pack con descuento 0 %: las unidades por pack y el descuento son independientes
-- ---------------------------------------------------------------------------------------------
-- Un producto puede seguir con pack_size_units = 6 aunque el descuento global sea 0 %. Los checks pasan de 1..9999 a 0..9999; el resto
-- (pack y descuento "las dos cosas o ninguna", versiones inmutables, 100 % rechazado) no cambia.
alter table public.products
  drop constraint products_pack_discount_bps_range,
  add constraint products_pack_discount_bps_range check (pack_discount_bps is null or pack_discount_bps between 0 and 9999);
alter table public.product_pack_versions
  drop constraint product_pack_versions_discount_range,
  add constraint product_pack_versions_discount_range check (discount_bps between 0 and 9999);
alter table public.sale_items
  drop constraint sale_items_pack_consistent,
  add constraint sale_items_pack_consistent check (
    (sold_as_pack
      and pack_config_id is not null and pack_size_units_snapshot >= 2 and pack_count >= 1
      and quantity_units is not null and quantity_units = pack_count * pack_size_units_snapshot
      and pack_discount_bps between 0 and 9999)
    or (not sold_as_pack and pack_config_id is null and pack_size_units_snapshot is null and pack_count is null
      and pack_discount_bps is null and pack_discount_cents = 0)
  );
comment on column public.products.pack_discount_bps is
  'Descuento del pack en basis points (0..9999; 2000 = 20 %, 0 = pack sin descuento). Sale de organization_pricing_settings.pack_discount_bps (D-068). NULL sii pack_size_units es NULL.';

-- ---------------------------------------------------------------------------------------------
-- 6. Pack: el descuento ya no es por producto, sale de la configuración global
-- ---------------------------------------------------------------------------------------------
-- Misma firma que 202610040061 (el Admin ya desplegado sigue pudiendo llamarla). p_pack_discount_bps queda sólo como valor de
-- compatibilidad: con el descuento global configurado se IGNORA (manda el global); sin configurar, se comporta como antes.
create or replace function public.set_product_pack_size(p_product_id uuid, p_pack_size_units integer, p_pack_discount_bps integer default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  current_unit_type public.unit_type;
  current_bps integer;
  global_bps integer;
  new_bps integer;
begin
  select p.unit_type, p.pack_discount_bps into current_unit_type, current_bps
  from public.products p
  where p.id = p_product_id and p.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
  if p_pack_size_units is null then
    if p_pack_discount_bps is not null then
      raise exception 'Sin pack no puede haber descuento de pack' using errcode = '22023';
    end if;
    new_bps := null;
  else
    if current_unit_type <> 'UNIT' then
      raise exception 'Sólo los productos que se venden por unidad pueden tener pack' using errcode = '22023';
    end if;
    if p_pack_size_units not between 2 and 10000 then
      raise exception 'Las unidades por pack tienen que ser un entero entre 2 y 10000' using errcode = '22023';
    end if;
    select s.pack_discount_bps into global_bps from public.organization_pricing_settings s where s.organization_id = current_organization_id;
    new_bps := coalesce(global_bps, p_pack_discount_bps, current_bps, app_private.pack_discount_bps());
    if new_bps not between 0 and 9999 then
      raise exception 'El descuento del pack tiene que estar entre 0 %% y 99,99 %%' using errcode = '22023';
    end if;
  end if;
  update public.products set pack_size_units = p_pack_size_units, pack_discount_bps = new_bps
  where id = p_product_id and organization_id = current_organization_id
    and (pack_size_units is distinct from p_pack_size_units or pack_discount_bps is distinct from new_bps);
end;
$$;

comment on function public.set_product_pack_size(uuid, integer, integer) is
  'Unidades por pack de un producto UNIT (NULL = sin pack). El descuento sale de organization_pricing_settings.pack_discount_bps; p_pack_discount_bps sólo rige mientras el descuento global no esté configurado (compatibilidad con el Admin anterior a 202610060065).';

-- ---------------------------------------------------------------------------------------------
-- 7. Guardar la configuración global (margen + dto 3u + dto pack + recargo tarjeta), todo en una transacción
-- ---------------------------------------------------------------------------------------------
-- Con un margen distinto del vigente exige p_confirm = true: sin confirmar NO escribe nada y devuelve la vista previa
-- (cuántos precios se recalcularían, cuántos productos no tienen costo, cuántos no cambian).
create function public.save_pricing_config(
  p_margin_bps integer,
  p_unit_bulk_discount_bps integer,
  p_pack_discount_bps integer,
  p_card_surcharge_bps integer,
  p_confirm boolean default false,
  p_close_branch_overrides boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  current_settings public.organization_pricing_settings%rowtype;
  margin_changed boolean;
  bulk_changed boolean;
  pack_changed boolean;
  recalculation jsonb := jsonb_build_object('recalculated', 0, 'unchanged', 0, 'scheduledPrice', 0, 'withoutCost', 0,
    'branchOverrides', 0, 'branchOverridesOther', 0, 'branchOverridesClosed', 0);
  packs_updated integer := 0;
  promotions_updated integer := 0;
  branch_row record;
  card_result jsonb;
begin
  if p_margin_bps is null or p_margin_bps not between 1 and 9999 then
    raise exception 'El margen de ganancia tiene que ser mayor a 0 %% y menor a 100 %%' using errcode = '22023';
  end if;
  if p_unit_bulk_discount_bps is null or p_unit_bulk_discount_bps not between 0 and 9999 then
    raise exception 'El descuento llevando 3u tiene que estar entre 0 %% y 99,99 %%' using errcode = '22023';
  end if;
  if p_pack_discount_bps is null or p_pack_discount_bps not between 0 and 9999 then
    raise exception 'El descuento por pack tiene que estar entre 0 %% y 99,99 %%' using errcode = '22023';
  end if;
  if p_card_surcharge_bps is null or p_card_surcharge_bps not between 0 and 9999 then
    raise exception 'El recargo por tarjeta tiene que estar entre 0 %% y 99,99 %%' using errcode = '22023';
  end if;

  -- Serializa a quienes guardan la configuración de la misma organización.
  perform pg_advisory_xact_lock(hashtextextended('pricing_config:' || current_organization_id::text, 0));
  select * into current_settings from public.organization_pricing_settings s
  where s.organization_id = current_organization_id for update;

  margin_changed := current_settings.margin_bps is distinct from p_margin_bps;
  bulk_changed := current_settings.unit_bulk_discount_bps is distinct from p_unit_bulk_discount_bps;
  pack_changed := current_settings.pack_discount_bps is distinct from p_pack_discount_bps;

  if bulk_changed and app_private.require_permission('catalog.write') <> current_organization_id then
    raise exception 'Permission catalog.write is required' using errcode = '42501';
  end if;
  if pack_changed and app_private.require_permission('products.write') <> current_organization_id then
    raise exception 'Permission products.write is required' using errcode = '42501';
  end if;

  if margin_changed and not coalesce(p_confirm, false) then
    return jsonb_build_object(
      'requiresConfirmation', true, 'previousMarginBps', current_settings.margin_bps, 'marginBps', p_margin_bps
    ) || app_private.recalculate_prices_from_margin(current_organization_id, p_margin_bps, auth.uid(), false, coalesce(p_close_branch_overrides, false));
  end if;

  insert into public.organization_pricing_settings (
    organization_id, margin_bps, unit_bulk_discount_bps, pack_discount_bps, updated_by
  ) values (
    current_organization_id, p_margin_bps, p_unit_bulk_discount_bps, p_pack_discount_bps, auth.uid()
  )
  on conflict (organization_id) do update
  set margin_bps = excluded.margin_bps, unit_bulk_discount_bps = excluded.unit_bulk_discount_bps,
      pack_discount_bps = excluded.pack_discount_bps, updated_by = excluded.updated_by;

  if margin_changed then
    recalculation := app_private.recalculate_prices_from_margin(current_organization_id, p_margin_bps, auth.uid(), true, coalesce(p_close_branch_overrides, false));
  end if;

  if bulk_changed then
    for branch_row in select b.id from public.branches b where b.organization_id = current_organization_id order by b.id
    loop
      if app_private.apply_unit_bulk_promotion(current_organization_id, branch_row.id, p_unit_bulk_discount_bps, auth.uid()) then
        promotions_updated := promotions_updated + 1;
      end if;
    end loop;
  end if;

  if pack_changed then
    -- Un solo UPDATE: el trigger products_pack_version_update cierra la versión vigente de cada pack y abre otra con el
    -- descuento nuevo (packConfigId nuevo); las ventas viejas conservan su versión. El cambio llega al POS por el cursor del catálogo.
    update public.products
    set pack_discount_bps = p_pack_discount_bps
    where organization_id = current_organization_id and pack_size_units is not null
      and pack_discount_bps is distinct from p_pack_discount_bps;
    get diagnostics packs_updated = row_count;
  end if;

  -- Recargo por tarjeta: la infraestructura existente (historial en organization_cash_discounts). No cambia ningún precio.
  card_result := public.set_cash_discount(p_card_surcharge_bps);

  return jsonb_build_object(
    'requiresConfirmation', false, 'marginBps', p_margin_bps, 'previousMarginBps', current_settings.margin_bps,
    'unitBulkDiscountBps', p_unit_bulk_discount_bps, 'packDiscountBps', p_pack_discount_bps,
    'cardSurchargeBps', p_card_surcharge_bps, 'packsUpdated', packs_updated, 'branchPromotionsUpdated', promotions_updated,
    'cardSurchargeChanged', not coalesce((card_result ->> 'unchanged')::boolean, false)
  ) || recalculation;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7b. Funciones derivadas de las vigentes (cuerpos de 202610040061 / 202610020054; sólo cambia lo indicado)
-- ---------------------------------------------------------------------------------------------
-- Recargo por tarjeta de una venta OFFLINE: el porcentaje que trae la línea tiene que ser uno que la configuración comercial haya tenido cuando
-- se hizo la venta. NO se compara contra la configuración vigente HOY (la venta pudo crearse antes de un cambio de recargo): vale cualquier
-- porcentaje de organization_cash_discounts (historial con vigencias) que haya regido desde 24 h 10 min antes de la venta (la autorización
-- offline del POS dura 24 h desde su último sync: una caja que todavía no recibió el cambio vende con el anterior) hasta 10 min después
-- (tolerancia de reloj). Una organización sin ninguna fila usa el 10 % por defecto, igual que la venta online. Un porcentaje manipulado
-- (por ejemplo 0 %) que nunca estuvo vigente se rechaza.
create function app_private.card_surcharge_bps_was_valid(p_organization_id uuid, p_bps integer, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_cash_discounts d
    where d.organization_id = p_organization_id and d.cash_discount_bps = p_bps
      and d.valid_from <= p_at + interval '10 minutes'
      and (d.valid_to is null or d.valid_to > p_at - interval '24 hours 10 minutes')
  ) or (p_bps = 1000 and not exists (select 1 from public.organization_cash_discounts d where d.organization_id = p_organization_id));
$$;
revoke all on function app_private.card_surcharge_bps_was_valid(uuid, integer, timestamptz) from public, anon, authenticated;

-- sync_offline_sale_core: (1) el porcentaje de una línea Pack puede ser 0 (antes 1..9999); (2) el recargo de tarjeta de una línea no manual se
-- valida contra la configuración histórica (card_surcharge_bps_was_valid). Nada más cambia.
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
  bp_id uuid; bp_every integer; bp_min integer; bp_bps integer; bp_units integer; bp_discount bigint;
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
      -- Promoción de sucursal "DESDE N" (cantidad mínima): branchPromotionMinimumUnits. La clave branchPromotionEveryUnits es el
      -- formato anterior ("cada N", sólo grupos completos) de un POS que todavía no se actualizó: se sigue validando con su regla.
      bp_every := nullif(item->>'branchPromotionEveryUnits', '')::integer;
      bp_min := nullif(item->>'branchPromotionMinimumUnits', '')::integer;
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
    -- D-068: el recargo de tarjeta tiene que ser uno que la configuración comercial haya tenido al hacerse la venta (no el de HOY).
    if not manual_applied and not app_private.payment_method_receives_discount(method)
       and not app_private.card_surcharge_bps_was_valid(org_id, cash_bps, completed_at) then
      raise exception 'Offline card surcharge does not match the commercial configuration of the sale' using errcode = '22023';
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
      or bp_id is not null or bp_every is not null or bp_min is not null or bp_bps is not null or bp_units is not null or bp_discount is not null;
    if has_unit_discount then
      if manual_applied or quantity is null or grams is not null
         or (sold_pack and (bp_id is not null or bp_every is not null or bp_min is not null or bp_bps is not null or bp_units is not null or bp_discount is not null))
         or (not sold_pack and (pack_count is not null or pack_size is not null or pack_bps is not null or pack_discount is not null or pack_config is not null))
         or (bp_every is not null and bp_min is not null)
         or (bp_id is null and (bp_every is not null or bp_min is not null or bp_bps is not null or bp_units is not null or bp_discount is not null))
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
             or quantity <> pack_count * pack_size or pack_bps is null or pack_bps not between 0 and 9999 or pack_discount is null
             or pack_config is null then
            raise exception 'Offline pack line is inconsistent' using errcode = '22023';
          end if;
          -- La versión del pack con la que el POS dice haber vendido: tiene que existir, ser de ESTE producto y coincidir con
          -- el snapshot (tamaño y porcentaje: cada producto tiene el suyo y cambia con el tiempo; la venta se valida contra
          -- el de SU versión). NUNCA se compara contra products.pack_size_units actual: el Admin pudo cambiarlo
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
          if bp_min is not null then
            -- "DESDE N unidades": si la línea llega a la cantidad mínima, TODAS sus unidades reciben el descuento (no sólo los
            -- grupos completos). Se evalúa por producto/línea, nunca sumando productos distintos. Espeja
            -- calculateBranchPromotionLinePricing y el insert_sale de Rust.
            if bp_min not between 2 and 1000 or bp_bps is null or bp_bps not between 1 and 9999
               or quantity < bp_min or bp_units is null or bp_units <> quantity or bp_discount is null then
              raise exception 'Offline branch promotion line is inconsistent' using errcode = '22023';
            end if;
          else
            -- Formato anterior (POS sin actualizar): "cada N", sólo los grupos completos. Se conserva únicamente para que una
            -- venta ya hecha con ese formato sincronice; el POS actual nunca lo envía.
            if bp_every is null or bp_every not between 2 and 1000 or bp_bps is null or bp_bps not between 1 and 9999
               or bp_units is null or bp_units <= 0 or bp_units <> (quantity / bp_every) * bp_every or bp_discount is null then
              raise exception 'Offline branch promotion line is inconsistent' using errcode = '22023';
            end if;
          end if;
          -- La regla tiene que existir, ser de esta sucursal y tener exactamente los valores que el POS dice haber usado
          -- (las filas son inmutables: editar una promoción crea otra). Tolerancia de reloj: el dispositivo puede estar
          -- unos minutos atrasado respecto del servidor que creó la promoción.
          if not exists (
            select 1 from public.branch_promotions bpr
            where bpr.id = bp_id and bpr.organization_id = org_id and bpr.branch_id = branch_uuid
              and bpr.scope = 'ALL_UNIT_PRODUCTS' and bpr.minimum_units = coalesce(bp_min, bp_every) and bpr.discount_bps = bp_bps
              and bpr.valid_from <= completed_at + interval '10 minutes'
              -- La semántica de la venta tiene que ser la de la regla: "desde N" (branchPromotionMinimumUnits) sólo contra una regla
              -- FROM_MINIMUM y el formato anterior "cada N" (branchPromotionEveryUnits) sólo contra una regla EVERY_GROUP.
              and bpr.semantics = case when bp_min is not null then 'FROM_MINIMUM' else 'EVERY_GROUP' end
              -- Una regla "cada N" está cerrada desde 202610040061: vale para lo vendido antes del cierre y para un POS que todavía
              -- no sincronizó (autorización offline de 24 h + 10 min de tolerancia), nunca para ventas nuevas indefinidamente.
              and (bp_min is not null or bpr.valid_until is null or completed_at <= bpr.valid_until + interval '24 hours 10 minutes')
          ) then
            if bp_min is null then
              raise exception 'Offline branch promotion uses the superseded "cada N" rule: update the POS' using errcode = '42501';
            end if;
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
        bp_id, coalesce(bp_min, bp_every), bp_bps, bp_units, coalesce(bp_discount, 0)
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

-- import_apply_product: con margen global configurado y costo en el archivo, el precio se forma desde el costo (ver el bloque Precio y costo).
create or replace function app_private.import_apply_product(
  p_batch public.import_batches,
  p_row public.import_rows,
  p_target uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := p_batch.organization_id;
  v_payload jsonb := p_row.payload;
  v_name text := btrim(v_payload ->> 'name');
  v_unit public.unit_type := (v_payload ->> 'unitType')::public.unit_type;
  v_sku text := nullif(upper(btrim(v_payload ->> 'sku')), '');
  v_existing public.products%rowtype;
  v_category_id uuid;
  v_category_name text := nullif(btrim(v_payload ->> 'categoryName'), '');
  v_provided boolean;
  v_id uuid;
  v_price bigint := app_private.import_nonnegative_bigint(v_payload -> 'priceCents');
  v_cost bigint := app_private.import_positive_bigint(v_payload -> 'costCents');
  v_current bigint;
  v_current_found boolean;
  v_supplier_name text := nullif(btrim(v_payload ->> 'supplierName'), '');
  v_supplier_code text := nullif(upper(btrim(v_payload ->> 'supplierCode')), '');
  v_supplier_id uuid;
  v_sellable boolean;
  v_margin integer;
  v_derive boolean;
begin
  select r.o_provided, r.o_category_id into v_provided, v_category_id
  from app_private.import_resolve_product_category(p_batch, v_payload, p_target is null) r;

  -- NEW: createMissingCategories. Re-checked here (not just trusted from the preview) so a category
  -- another user created meanwhile is reused instead of duplicated.
  if v_category_id is null and v_provided and v_category_name is not null
     and nullif(btrim(v_payload ->> 'categoryExternalId'), '') is null
     and coalesce((p_batch.options ->> 'createMissingCategories')::boolean, false)
     and not exists (
       select 1 from public.categories c
       where c.organization_id = v_org
         and app_private.import_normalize_text(c.name) = app_private.import_normalize_text(v_category_name)
     ) then
    v_category_id := public.save_category(
      null, v_category_name, app_private.import_unique_slug(v_org, 'categories', v_category_name), 0, true, null
    );
  end if;

  if p_target is null then
    v_id := public.save_product(
      null, v_category_id, v_name, app_private.import_unique_slug(v_org, 'products', v_name),
      v_sku, v_unit, coalesce((v_payload ->> 'active')::boolean, true)
    );
    perform public.set_product_categories(v_id, v_category_id, array[v_category_id]);
    -- New products are enabled ONLY in the batch's destination branch. Updates of an existing
    -- product never touch its assortment (that is managed from Admin / the product modal).
    perform app_private.enable_product_in_branch(v_org, p_batch.branch_id, v_id);
  else
    select * into v_existing from public.products p where p.id = p_target and p.organization_id = v_org for update;
    if not v_provided then v_category_id := v_existing.category_id; end if;
    -- A blank/absent sku never clears an existing one (a mapper emitting "" must not wipe data).
    v_id := public.save_product(
      p_target, v_category_id, v_name, v_existing.slug, coalesce(v_sku, v_existing.sku), v_unit,
      coalesce((v_payload ->> 'active')::boolean, v_existing.active)
    );
    if v_category_id is distinct from v_existing.category_id then
      -- New principal replaces the old one; "also appears in" categories are kept.
      perform public.set_product_categories(
        v_id, v_category_id,
        coalesce((
          select array_agg(a.category_id) from public.product_category_assignments a
          where a.product_id = v_id and a.organization_id = v_org and a.category_id <> v_existing.category_id
        ), array[]::uuid[])
      );
    end if;
  end if;

  if v_payload ? 'inventoryRole' and jsonb_typeof(v_payload -> 'inventoryRole') <> 'null' then
    perform public.set_product_inventory_role(v_id, v_payload ->> 'inventoryRole');
  end if;
  perform app_private.add_product_barcodes(v_org, v_id, app_private.import_payload_barcodes(v_payload));

  -- Precio y costo (D-068). Sólo se escribe lo que cambió: un reimport nunca apila vigencias idénticas (product_prices/product_costs son
  -- append-only). REGLA: con margen global configurado y un costo > 0 en el archivo, para un producto activo y vendible el precio de lista
  -- se FORMA desde el costo (costo / (1 - margen), la misma función del servidor) y el precio del archivo se IGNORA. Una fila que sólo trae
  -- precio (sin costo), una organización sin margen configurado o un producto no vendible conservan el comportamiento anterior: el precio del
  -- archivo (0 = "sin precio definido").
  select p.active and p.inventory_role in ('SELLABLE', 'BOTH') into v_sellable
  from public.products p where p.id = v_id and p.organization_id = v_org;
  v_margin := app_private.pricing_margin_bps(v_org);
  v_derive := v_margin is not null and v_cost is not null and coalesce(v_sellable, false);
  if v_price is not null and not v_derive then
    select pp.price_cents into v_current
    from public.product_prices pp
    where pp.organization_id = v_org and pp.product_id = v_id and pp.branch_id is null
      and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
    order by pp.valid_from desc limit 1;
    v_current_found := found;
    if v_price = 0 then
      -- precio 0 = "sin precio definido" (se pide en la caja). Sólo crea la PRIMERA vigencia del producto; nunca pisa un precio ya
      -- cargado: un 0 del archivo no es una baja de precio. public.set_product_price rechaza <= 0 a propósito, por eso se inserta directo.
      if not v_current_found then
        insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from, created_by)
        values (v_org, v_id, null, 0, now(), auth.uid());
      end if;
    elsif v_current is distinct from v_price then
      perform public.set_product_price(v_id, null, v_price);
    end if;
  end if;
  if v_cost is not null then
    select pc.cost_cents into v_current
    from public.product_costs pc
    where pc.organization_id = v_org and pc.product_id = v_id and pc.valid_to is null
    order by pc.valid_from desc limit 1;
    if v_current is distinct from v_cost then
      -- Con margen configurado, set_product_cost también abre la vigencia de precio derivada (misma transacción).
      perform public.set_product_cost(v_id, v_cost);
    elsif v_derive then
      -- Mismo costo (reimport): no toca un precio ya cargado; sólo forma el precio si el producto todavía no tiene uno (o es 0).
      select pp.price_cents into v_current
      from public.product_prices pp
      where pp.organization_id = v_org and pp.product_id = v_id and pp.branch_id is null
        and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
      order by pp.valid_from desc limit 1;
      v_current_found := found;
      if not v_current_found or v_current <= 0 then
        perform app_private.reprice_from_margin(v_org, v_id, v_cost, v_margin, greatest(now(), clock_timestamp()), auth.uid());
      end if;
    end if;
  end if;

  -- NEW: proveedor principal. Vacío = el producto se importa sin proveedor (y no se le quita el que
  -- ya tuviera). Con proveedor: se reutiliza el existente o se crea una sola vez.
  if v_supplier_name is not null or v_supplier_code is not null then
    v_supplier_id := app_private.import_ensure_supplier(p_batch, v_supplier_name, v_supplier_code);
    perform app_private.set_primary_supplier(v_org, v_id, v_supplier_id);
  end if;

  perform app_private.import_upsert_link(p_batch, p_row, 'product', v_id);
  return v_id;
end;
$$;

revoke all on function app_private.import_apply_product(public.import_batches, public.import_rows, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. Precios por sucursal que le ganan al precio global
-- ---------------------------------------------------------------------------------------------
-- Cierra (valid_to = ahora; NUNCA borra) los precios VIGENTES de sucursal, de los productos indicados o de toda la organización, para que
-- valga el precio global. La fila conserva su precio y queda en el historial. Un precio de sucursal programado a futuro no se toca.
create function public.close_branch_price_overrides(p_product_ids uuid[] default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  at_time timestamptz := clock_timestamp();
  closed integer;
begin
  update public.product_prices pp
  set valid_to = at_time
  where pp.organization_id = current_organization_id and pp.branch_id is not null
    and (p_product_ids is null or pp.product_id = any (p_product_ids))
    and pp.valid_from < at_time and (pp.valid_to is null or pp.valid_to > at_time);
  get diagnostics closed = row_count;
  return jsonb_build_object('closed', closed);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------------------------
revoke all on function
  app_private.list_price_from_margin(bigint, integer),
  app_private.pricing_margin_bps(uuid),
  app_private.reprice_from_margin(uuid, uuid, bigint, integer, timestamptz, uuid),
  app_private.apply_product_cost(uuid, uuid, bigint, timestamptz, uuid),
  app_private.recalculate_prices_from_margin(uuid, integer, uuid, boolean, boolean),
  app_private.apply_unit_bulk_promotion(uuid, uuid, integer, uuid),
  app_private.apply_unit_bulk_promotion_to_new_branch()
from public, anon, authenticated;

revoke all on function public.set_product_cost(uuid, bigint, timestamptz) from public, anon;
grant execute on function public.set_product_cost(uuid, bigint, timestamptz) to authenticated;
revoke all on function public.set_product_pack_size(uuid, integer, integer) from public, anon;
grant execute on function public.set_product_pack_size(uuid, integer, integer) to authenticated;
revoke all on function
  public.bulk_set_product_costs(jsonb, timestamptz), public.save_pricing_config(integer, integer, integer, integer, boolean, boolean),
  public.close_branch_price_overrides(uuid[])
from public, anon;
grant execute on function
  public.bulk_set_product_costs(jsonb, timestamptz), public.save_pricing_config(integer, integer, integer, integer, boolean, boolean),
  public.close_branch_price_overrides(uuid[])
to authenticated;

commit;
