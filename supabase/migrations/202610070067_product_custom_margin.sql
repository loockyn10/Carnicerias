begin;

-- Margen de ganancia PERSONALIZADO por producto (D-070). Complementa D-068 (202610060065) y D-069 (202610070066), ya aplicadas: NO se editan.
--
--   Excepción opcional por producto, sobre la MISMA fórmula gross-up (precio = costo / (1 - margen), app_private.list_price_from_margin).
--   Resolución del margen EFECTIVO (app_private.effective_margin, helper único usado por costo nuevo, carga masiva, importación y edición):
--     1. el producto tiene margen propio                        -> ese margen (aunque su categoría esté excluida);
--     2. no lo tiene y no hay margen global configurado           -> sin margen (el costo se guarda, el precio no cambia);
--     3. no lo tiene y su categoría está excluida                 -> precio manual (comportamiento de D-069);
--     4. no lo tiene y su categoría no está excluida              -> margen global.
--   Persistencia: tabla propia product_custom_margins (basis points enteros, 1..9999, los mismos límites que el margen global; la AUSENCIA de
--   fila = sin margen propio). Se eligió una tabla y no una columna de products para que el margen (dato comercial sensible) no viaje en
--   ninguna lectura de products ni en el catálogo del POS: sólo lo lee quien tiene prices.write, igual que organization_pricing_settings.
--   No se guarda ninguna copia del margen global en el producto.
--
--   Esta migración reemplaza (mismo cuerpo + el cambio indicado): apply_product_cost (usa el margen efectivo), bulk_set_product_costs (sólo el
--   flag marginConfigured), recalculate_prices_from_margin (saltea los productos con margen propio y los cuenta en 'customMargin') e
--   import_apply_product (margen efectivo). save_pricing_config NO cambia (llama al recálculo, que ya respeta los márgenes propios).
--   No recalcula ningún precio al aplicarse: product_custom_margins nace vacía. El historial de precios sigue siendo append-only.

-- ---------------------------------------------------------------------------------------------
-- 1. Tabla
-- ---------------------------------------------------------------------------------------------
create table public.product_custom_margins (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null unique,
  -- Margen sobre el precio de venta en basis points (1..9999), igual que organization_pricing_settings.margin_bps.
  custom_margin_bps integer not null check (custom_margin_bps between 1 and 9999),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- El producto tiene que ser de la MISMA organización (aislamiento por tenant).
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete cascade
);

create trigger product_custom_margins_set_updated_at before update on public.product_custom_margins
for each row execute function app_private.set_updated_at();
create trigger product_custom_margins_audit after insert or update or delete on public.product_custom_margins
for each row execute function app_private.audit_row_change();

alter table public.product_custom_margins enable row level security;
create policy product_custom_margins_admin_select on public.product_custom_margins
for select to authenticated using (app_private.has_permission(organization_id, 'prices.write'));
revoke all on table public.product_custom_margins from public, anon, authenticated;
grant select on table public.product_custom_margins to authenticated;

comment on table public.product_custom_margins is
  'Margen de ganancia personalizado de un producto (D-070): excepción opcional al margen global. Sin fila = el producto usa la regla general (margen global, o precio manual si su categoría está excluida). Sólo se escribe con set_product_custom_margin.';
comment on column public.product_custom_margins.custom_margin_bps is
  'Margen sobre el PRECIO DE VENTA en basis points (1..9999): precio de lista = costo / (1 - margen). Gana sobre el margen global y sobre la exclusión de categoría.';

-- ---------------------------------------------------------------------------------------------
-- 2. Helper único: margen efectivo de un producto
-- ---------------------------------------------------------------------------------------------
-- source: CUSTOM (margen propio) | GLOBAL (margen de la organización) | MANUAL (categoría excluida sin margen propio: margin_bps NULL) |
--         NO_MARGIN (sin margen propio y sin margen global configurado: margin_bps NULL).
create function app_private.effective_margin(p_organization_id uuid, p_product_id uuid, out margin_bps integer, out source text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  custom integer;
  global integer;
begin
  select m.custom_margin_bps into custom
  from public.product_custom_margins m
  where m.organization_id = p_organization_id and m.product_id = p_product_id;
  if custom is not null then
    margin_bps := custom;
    source := 'CUSTOM';
    return;
  end if;
  global := app_private.pricing_margin_bps(p_organization_id);
  if global is null then
    source := 'NO_MARGIN';
  elsif app_private.is_pricing_excluded(p_organization_id, p_product_id) then
    source := 'MANUAL';
  else
    margin_bps := global;
    source := 'GLOBAL';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Costo nuevo => precio nuevo con el margen EFECTIVO
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.apply_product_cost(
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
  eff record;
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
  select * into eff from app_private.effective_margin(p_organization_id, p_product_id);
  if eff.source = 'NO_MARGIN' then
    price_outcome := 'NO_MARGIN';
  elsif not coalesce(sellable, false) then
    price_outcome := 'NOT_SELLABLE';
  elsif eff.source = 'MANUAL' then
    -- Categoría excluida sin margen propio: el costo queda guardado (rentabilidad) y el precio de venta vigente NO cambia.
    price_outcome := 'MANUAL_PRICE';
  else
    -- La vigencia de precio empieza ahora (o en la fecha futura pedida): nunca antes de un precio que otra transacción ya haya
    -- confirmado (p_at por defecto es el inicio de ESTA transacción), para no solapar vigencias.
    price_outcome := app_private.reprice_from_margin(
      p_organization_id, p_product_id, p_cost_cents, eff.margin_bps, greatest(p_at, clock_timestamp()), p_actor
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Carga masiva de costos (cuerpo de 202610070066; sólo cambia marginConfigured)
-- ---------------------------------------------------------------------------------------------
-- marginConfigured era "hay margen global"; con márgenes propios puede haber precios formados sin margen global, así que también es true si
-- algún costo guardado formó (o confirmó) un precio.
create or replace function public.bulk_set_product_costs(
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
  manual_price integer := 0;
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
    elsif outcome = 'MANUAL_PRICE' then manual_price := manual_price + 1;
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
    'costUnchanged', cost_unchanged, 'scheduledPrice', scheduled,
    'marginConfigured', margin is not null or repriced > 0 or price_unchanged > 0,
    'branchOverrides', overrides, 'manualPrice', manual_price
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Recálculo masivo: sólo los productos que USAN el margen global
-- ---------------------------------------------------------------------------------------------
-- Cuerpo de 202610070066 con un cambio: los productos con margen propio NO se recalculan (su precio no depende del margen global) y se
-- informan aparte ('customMargin'). withoutCost / excludedByCategory / unchanged / recalculated / scheduledPrice siguen describiendo sólo a
-- los productos que usan el margen global (o a los excluidos sin margen propio).
create or replace function app_private.recalculate_prices_from_margin(
  p_organization_id uuid,
  p_margin_bps integer,
  p_actor uuid,
  p_apply boolean,
  p_close_overrides boolean,
  p_excluded_ids uuid[] default '{}',
  p_scope_ids uuid[] default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  at_time timestamptz := clock_timestamp();
  excluded uuid[] := coalesce(p_excluded_ids, '{}');
  ids uuid[];
  prices bigint[];
  eligible_ids uuid[];
  eligible_count integer;
  automatic_count integer;
  excluded_count integer;
  custom_count integer;
  scheduled_count integer;
  unchanged_count integer;
  override_count integer;
  override_other integer;
  override_closed integer := 0;
  sample jsonb := '[]'::jsonb;
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
        and not coalesce(p.category_id = any (excluded), false)
        and not exists (select 1 from public.product_custom_margins cm where cm.organization_id = p.organization_id and cm.product_id = p.id)
        and (p_scope_ids is null or coalesce(p.category_id = any (p_scope_ids), false))
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

  select
    count(*) filter (where not s.is_custom and not coalesce(s.category_id = any (excluded), false)
      and (p_scope_ids is null or coalesce(s.category_id = any (p_scope_ids), false))),
    count(*) filter (where not s.is_custom and coalesce(s.category_id = any (excluded), false)
      and (p_scope_ids is null or coalesce(s.category_id = any (p_scope_ids), false))),
    count(*) filter (where s.is_custom and (p_scope_ids is null or coalesce(s.category_id = any (p_scope_ids), false)))
  into automatic_count, excluded_count, custom_count
  from (
    select p.category_id,
      exists (select 1 from public.product_custom_margins cm where cm.organization_id = p.organization_id and cm.product_id = p.id) as is_custom
    from public.products p
    where p.organization_id = p_organization_id and p.active and p.inventory_role in ('SELLABLE', 'BOTH')
  ) s;

  -- Precios VIGENTES por sucursal: en el POS un precio de sucursal gana sobre el global (orden "sucursal primero"), así que dejarían
  -- de ver el precio recién formado. branchOverrides = los de productos que este recálculo reprecia (o confirma); branchOverridesOther =
  -- los de productos que quedan fuera (sin costo, programados, inactivos, excluidos).
  select count(*) into override_count
  from public.product_prices pp
  where pp.organization_id = p_organization_id and pp.branch_id is not null and pp.product_id = any (eligible_ids)
    and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time);
  select count(*) into override_other
  from public.product_prices pp
  where pp.organization_id = p_organization_id and pp.branch_id is not null and not (pp.product_id = any (eligible_ids))
    and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time);

  if not p_apply and cardinality(ids) > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'currentCents', s.current_cents, 'newCents', s.new_cents) order by s.name), '[]'::jsonb)
    into sample
    from (
      select p.name, cur.price_cents as current_cents, ch.price_cents as new_cents
      from unnest(ids, prices) as ch(product_id, price_cents)
      join public.products p on p.id = ch.product_id
      left join lateral (
        select pp.price_cents from public.product_prices pp
        where pp.organization_id = p_organization_id and pp.product_id = ch.product_id and pp.branch_id is null
          and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time)
        order by pp.valid_from desc
        limit 1
      ) cur on true
      order by p.name
      limit 10
    ) s;
  end if;

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
    'withoutCost', automatic_count - eligible_count, 'excludedByCategory', excluded_count, 'customMargin', custom_count,
    'branchOverrides', override_count, 'branchOverridesOther', override_other, 'branchOverridesClosed', override_closed,
    'sample', sample
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5b. Importación (cuerpo de 202610070066; sólo cambia cómo se resuelve el margen)
-- ---------------------------------------------------------------------------------------------
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
  -- Margen EFECTIVO del producto (D-070): el propio si lo tiene; si no, el global salvo categoría excluida (precio manual). Un margen propio
  -- forma el precio aunque la categoría esté excluida. La categoría ya quedó guardada arriba (save_product), así que se evalúa la de ESTA fila.
  select e.margin_bps into v_margin from app_private.effective_margin(v_org, v_id) e;
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

-- ---------------------------------------------------------------------------------------------
-- 6. Guardar / quitar el margen personalizado de un producto
-- ---------------------------------------------------------------------------------------------
-- p_margin_bps NULL = quitar el margen propio. Con p_reprice (por defecto) recalcula el precio de lista DE ESE PRODUCTO con el margen
-- efectivo resultante y el costo vigente (misma función que el costo nuevo: abre una vigencia, nunca edita la anterior):
--   * con margen propio            -> costo / (1 - margen propio), aunque la categoría esté excluida;
--   * se quita y NO es excluido    -> vuelve al margen global (si hay) con el costo vigente;
--   * se quita y es excluido       -> vuelve a precio manual: NO se recalcula ni se borra el precio vigente (MANUAL_PRICE).
-- p_reprice = false guarda sólo el margen (el Admin lo usa cuando en la MISMA edición también guarda un costo nuevo, que reprecia una sola vez).
-- outcome: REPRICED | UNCHANGED | SCHEDULED | MANUAL_PRICE | NO_MARGIN | NOT_SELLABLE | NO_COST | NOT_REPRICED.
create function public.set_product_custom_margin(
  p_product_id uuid,
  p_margin_bps integer,
  p_reprice boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  target public.products%rowtype;
  previous integer;
  eff record;
  current_cost bigint;
  at_time timestamptz := clock_timestamp();
  outcome text := 'NOT_REPRICED';
begin
  if p_margin_bps is not null and p_margin_bps not between 1 and 9999 then
    raise exception 'El margen personalizado tiene que ser mayor a 0 %% y menor a 100 %%' using errcode = '22023';
  end if;
  select * into target from public.products p
  where p.id = p_product_id and p.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;

  select m.custom_margin_bps into previous from public.product_custom_margins m where m.product_id = p_product_id;
  if p_margin_bps is null then
    delete from public.product_custom_margins m where m.product_id = p_product_id;
  else
    insert into public.product_custom_margins (organization_id, product_id, custom_margin_bps, updated_by)
    values (current_organization_id, p_product_id, p_margin_bps, auth.uid())
    on conflict (product_id) do update
    set custom_margin_bps = excluded.custom_margin_bps, updated_by = excluded.updated_by
    where public.product_custom_margins.custom_margin_bps is distinct from excluded.custom_margin_bps;
  end if;

  select * into eff from app_private.effective_margin(current_organization_id, p_product_id);
  if coalesce(p_reprice, true) then
    select pc.cost_cents into current_cost
    from public.product_costs pc
    where pc.organization_id = current_organization_id and pc.product_id = p_product_id
      and pc.valid_from <= at_time and (pc.valid_to is null or pc.valid_to > at_time)
    order by pc.valid_from desc
    limit 1;
    if eff.source = 'MANUAL' then
      outcome := 'MANUAL_PRICE';
    elsif eff.source = 'NO_MARGIN' then
      outcome := 'NO_MARGIN';
    elsif not (target.active and target.inventory_role in ('SELLABLE', 'BOTH')) then
      outcome := 'NOT_SELLABLE';
    elsif current_cost is null or current_cost <= 0 then
      outcome := 'NO_COST';
    else
      outcome := app_private.reprice_from_margin(current_organization_id, p_product_id, current_cost, eff.margin_bps, at_time, auth.uid());
    end if;
  end if;

  return jsonb_build_object(
    'outcome', outcome, 'source', eff.source, 'marginBps', p_margin_bps, 'previousMarginBps', previous, 'effectiveMarginBps', eff.margin_bps
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------------------------
revoke all on function
  app_private.effective_margin(uuid, uuid),
  app_private.apply_product_cost(uuid, uuid, bigint, timestamptz, uuid),
  app_private.recalculate_prices_from_margin(uuid, integer, uuid, boolean, boolean, uuid[], uuid[])
from public, anon, authenticated;
revoke all on function app_private.import_apply_product(public.import_batches, public.import_rows, uuid) from public, anon, authenticated;

revoke all on function public.bulk_set_product_costs(jsonb, timestamptz) from public, anon;
grant execute on function public.bulk_set_product_costs(jsonb, timestamptz) to authenticated;
revoke all on function public.set_product_custom_margin(uuid, integer, boolean) from public, anon;
grant execute on function public.set_product_custom_margin(uuid, integer, boolean) to authenticated;

commit;
