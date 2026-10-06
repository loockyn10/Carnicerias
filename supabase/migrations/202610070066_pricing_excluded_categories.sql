begin;

-- Categorías EXCLUIDAS del margen automático (D-069). Complementa D-068 (202610060065, ya aplicada: NO se edita).
--
--   El margen global es el margen AUTOMÁTICO de los productos habilitados para pricing automático, no de todos los de la organización.
--   Un producto de una categoría excluida (hoy el usuario elegirá Vaca / Cerdo / Pollo, pero NADA está hardcodeado: se guardan IDs de
--   categoría por organización) conserva su precio de lista vigente, se puede preciar a mano y su COSTO se sigue guardando (rentabilidad):
--     * costo nuevo (set_product_cost, carga masiva, importación, alta/edición): se guarda el costo y NO se abre vigencia de precio;
--     * cambio de margen: el recálculo masivo los saltea (no generan vigencia);
--     * desposte: complete_production_batch ya sólo escribe costos (no reprecia); un cambio de margen tampoco toca a los cortes excluidos.
--   Modelo de categorías: UNA categoría por producto (products.category_id; product_category_assignments es sólo su proyección, unique por
--   producto desde 202610040061). Un producto sin categoría (category_id null) NO está excluido: pricing automático.
--
--   Cambiar la configuración nunca reprecia sola: sacar una categoría de la lista exige confirmación y recién entonces abre las vigencias de
--   los productos que pasan a automáticos (con vista previa de cuántos son y qué precios cambian); agregar una categoría no toca ningún
--   precio (sólo deja de repreciarla). El historial de precios no se modifica nunca.
--
--   Esta migración reemplaza (create or replace / drop+create con la misma semántica + un parámetro nuevo con default):
--     app_private.apply_product_cost, public.bulk_set_product_costs, app_private.recalculate_prices_from_margin,
--     public.save_pricing_config, app_private.import_apply_product.
--   save_pricing_config conserva su llamada de 6 argumentos (el parámetro nuevo p_excluded_category_ids tiene default null = "no tocar la
--   lista"): un Admin ya desplegado sigue funcionando.

-- ---------------------------------------------------------------------------------------------
-- 1. Categorías excluidas (por organización, por ID)
-- ---------------------------------------------------------------------------------------------
create table public.organization_pricing_excluded_categories (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category_id uuid not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, category_id),
  -- La categoría tiene que ser de la MISMA organización (aislamiento por tenant). Una categoría no se borra: se desactiva; si algún día
  -- se borra, la exclusión desaparece con ella.
  foreign key (category_id, organization_id) references public.categories(id, organization_id) on delete cascade
);

create trigger organization_pricing_excluded_categories_audit after insert or delete on public.organization_pricing_excluded_categories
for each row execute function app_private.audit_row_change();

alter table public.organization_pricing_excluded_categories enable row level security;
create policy organization_pricing_excluded_categories_admin_select on public.organization_pricing_excluded_categories
for select to authenticated using (app_private.has_permission(organization_id, 'prices.write'));
revoke all on table public.organization_pricing_excluded_categories from public, anon, authenticated;
grant select on table public.organization_pricing_excluded_categories to authenticated;

comment on table public.organization_pricing_excluded_categories is
  'Categorías excluidas del margen automático (D-069): sus productos conservan el precio de lista vigente (precio manual) aunque tengan costo y haya margen global. Se guardan IDs de categoría por organización; sólo se escribe con save_pricing_config.';

-- ¿El producto está excluido del pricing automático? (su categoría principal es una de las excluidas de su organización)
create function app_private.is_pricing_excluded(p_organization_id uuid, p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.products p
    join public.organization_pricing_excluded_categories e
      on e.organization_id = p.organization_id and e.category_id = p.category_id
    where p.id = p_product_id and p.organization_id = p_organization_id
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Costo nuevo => precio nuevo SÓLO si el producto es automático
-- ---------------------------------------------------------------------------------------------
-- Igual que 202610060065 y, además, price_outcome = 'MANUAL_PRICE' para un producto excluido: el costo se guarda y el precio no se toca.
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
  elsif app_private.is_pricing_excluded(p_organization_id, p_product_id) then
    -- Categoría excluida (carnicería): el costo queda guardado (rentabilidad) y el precio de venta vigente NO cambia.
    price_outcome := 'MANUAL_PRICE';
  else
    -- La vigencia de precio empieza ahora (o en la fecha futura pedida): nunca antes de un precio que otra transacción ya haya
    -- confirmado (p_at por defecto es el inicio de ESTA transacción), para no solapar vigencias.
    price_outcome := app_private.reprice_from_margin(
      p_organization_id, p_product_id, p_cost_cents, margin, greatest(p_at, clock_timestamp()), p_actor
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Carga masiva de costos (cuerpo de 202610060065 + 'manualPrice')
-- ---------------------------------------------------------------------------------------------
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
    'costUnchanged', cost_unchanged, 'scheduledPrice', scheduled, 'marginConfigured', margin is not null,
    'branchOverrides', overrides, 'manualPrice', manual_price
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Recálculo masivo al cambiar el margen (o al sacar una categoría de la exclusión)
-- ---------------------------------------------------------------------------------------------
-- Alcance: productos ACTIVOS y vendibles con costo vigente > 0 que NO pertenecen a una categoría excluida (p_excluded_ids: la lista
-- PROPUESTA, todavía sin guardar cuando es una vista previa). p_scope_ids (opcional) limita el recálculo a esas categorías: se usa cuando
-- el margen no cambió y sólo se sacaron categorías de la exclusión (los demás productos NO se recalculan: sus precios manuales previos no
-- se pisan). Los excluidos no generan vigencia. Un precio global programado a futuro se respeta; los overrides por sucursal no se tocan
-- salvo p_close_overrides.
-- Cuentas (sobre productos activos y vendibles; cada producto en UNA sola): excludedByCategory + withoutCost + scheduledPrice + unchanged +
-- recalculated = productos de venta en alcance. 'sample' (sólo en la vista previa): hasta 10 precios que cambiarían.
drop function app_private.recalculate_prices_from_margin(uuid, integer, uuid, boolean, boolean);
create function app_private.recalculate_prices_from_margin(
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
    count(*) filter (where not coalesce(p.category_id = any (excluded), false)
      and (p_scope_ids is null or coalesce(p.category_id = any (p_scope_ids), false))),
    count(*) filter (where coalesce(p.category_id = any (excluded), false)
      and (p_scope_ids is null or coalesce(p.category_id = any (p_scope_ids), false)))
  into automatic_count, excluded_count
  from public.products p
  where p.organization_id = p_organization_id and p.active and p.inventory_role in ('SELLABLE', 'BOTH');

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
    'withoutCost', automatic_count - eligible_count, 'excludedByCategory', excluded_count,
    'branchOverrides', override_count, 'branchOverridesOther', override_other, 'branchOverridesClosed', override_closed,
    'sample', sample
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Guardar la configuración global (+ categorías excluidas), todo en una transacción
-- ---------------------------------------------------------------------------------------------
-- Pide confirmación (p_confirm = true) si el margen cambia O si se SACA alguna categoría de la exclusión: sin confirmar NO escribe nada y
-- devuelve la vista previa. Con un margen distinto se recalculan todos los productos automáticos; con el mismo margen y categorías sacadas,
-- sólo los de esas categorías (pasan a ser automáticos). Agregar una categoría a la exclusión no reprecia ni pide confirmación: desde ese
-- momento deja de repreciarse. p_excluded_category_ids null = no tocar la lista; '{}' = sin categorías excluidas.
drop function public.save_pricing_config(integer, integer, integer, integer, boolean, boolean);
create function public.save_pricing_config(
  p_margin_bps integer,
  p_unit_bulk_discount_bps integer,
  p_pack_discount_bps integer,
  p_card_surcharge_bps integer,
  p_confirm boolean default false,
  p_close_branch_overrides boolean default false,
  p_excluded_category_ids uuid[] default null
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
  current_excluded uuid[];
  new_excluded uuid[];
  added_excluded uuid[];
  removed_excluded uuid[];
  margin_changed boolean;
  bulk_changed boolean;
  pack_changed boolean;
  needs_recalculation boolean;
  recalculation_scope uuid[];
  newly_automatic integer;
  recalculation jsonb := jsonb_build_object('recalculated', 0, 'unchanged', 0, 'scheduledPrice', 0, 'withoutCost', 0, 'excludedByCategory', 0,
    'branchOverrides', 0, 'branchOverridesOther', 0, 'branchOverridesClosed', 0, 'sample', '[]'::jsonb);
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

  select coalesce(array_agg(e.category_id order by e.category_id), '{}') into current_excluded
  from public.organization_pricing_excluded_categories e where e.organization_id = current_organization_id;
  if p_excluded_category_ids is null then
    new_excluded := current_excluded;
  else
    select coalesce(array_agg(distinct x order by x), '{}') into new_excluded from unnest(p_excluded_category_ids) as t(x) where x is not null;
    -- Sólo categorías de ESTA organización (la FK lo garantiza al escribir; acá el error nombra el problema antes de la vista previa).
    if exists (
      select 1 from unnest(new_excluded) as t(x)
      where not exists (select 1 from public.categories c where c.id = x and c.organization_id = current_organization_id)
    ) then
      raise exception 'Una de las categorías excluidas no existe en esta organización' using errcode = '42501';
    end if;
  end if;
  select coalesce(array_agg(x order by x), '{}') into added_excluded from unnest(new_excluded) as t(x) where x <> all (current_excluded);
  select coalesce(array_agg(x order by x), '{}') into removed_excluded from unnest(current_excluded) as t(x) where x <> all (new_excluded);

  margin_changed := current_settings.margin_bps is distinct from p_margin_bps;
  bulk_changed := current_settings.unit_bulk_discount_bps is distinct from p_unit_bulk_discount_bps;
  pack_changed := current_settings.pack_discount_bps is distinct from p_pack_discount_bps;
  -- Margen distinto: se recalculan TODOS los automáticos. Mismo margen pero categorías sacadas de la exclusión: sólo los de esas categorías.
  needs_recalculation := margin_changed or cardinality(removed_excluded) > 0;
  recalculation_scope := case when margin_changed then null else removed_excluded end;

  if bulk_changed and app_private.require_permission('catalog.write') <> current_organization_id then
    raise exception 'Permission catalog.write is required' using errcode = '42501';
  end if;
  if pack_changed and app_private.require_permission('products.write') <> current_organization_id then
    raise exception 'Permission products.write is required' using errcode = '42501';
  end if;

  if needs_recalculation and not coalesce(p_confirm, false) then
    select count(*) into newly_automatic
    from public.products p
    where p.organization_id = current_organization_id and p.active and p.inventory_role in ('SELLABLE', 'BOTH')
      and p.category_id = any (removed_excluded);
    return jsonb_build_object(
      'requiresConfirmation', true, 'previousMarginBps', current_settings.margin_bps, 'marginBps', p_margin_bps,
      'marginChanged', margin_changed, 'excludedCategoryIds', to_jsonb(new_excluded),
      'removedExcludedCategoryIds', to_jsonb(removed_excluded), 'addedExcludedCategoryIds', to_jsonb(added_excluded),
      'newlyAutomatic', newly_automatic
    ) || app_private.recalculate_prices_from_margin(
      current_organization_id, p_margin_bps, auth.uid(), false, coalesce(p_close_branch_overrides, false), new_excluded, recalculation_scope
    );
  end if;

  insert into public.organization_pricing_settings (
    organization_id, margin_bps, unit_bulk_discount_bps, pack_discount_bps, updated_by
  ) values (
    current_organization_id, p_margin_bps, p_unit_bulk_discount_bps, p_pack_discount_bps, auth.uid()
  )
  on conflict (organization_id) do update
  set margin_bps = excluded.margin_bps, unit_bulk_discount_bps = excluded.unit_bulk_discount_bps,
      pack_discount_bps = excluded.pack_discount_bps, updated_by = excluded.updated_by;

  if cardinality(removed_excluded) > 0 then
    delete from public.organization_pricing_excluded_categories e
    where e.organization_id = current_organization_id and e.category_id = any (removed_excluded);
  end if;
  if cardinality(added_excluded) > 0 then
    insert into public.organization_pricing_excluded_categories (organization_id, category_id, created_by)
    select current_organization_id, x, auth.uid() from unnest(added_excluded) as t(x);
  end if;

  if needs_recalculation then
    recalculation := app_private.recalculate_prices_from_margin(
      current_organization_id, p_margin_bps, auth.uid(), true, coalesce(p_close_branch_overrides, false), new_excluded, recalculation_scope
    );
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
    'marginChanged', margin_changed, 'excludedCategoryIds', to_jsonb(new_excluded),
    'removedExcludedCategoryIds', to_jsonb(removed_excluded), 'addedExcludedCategoryIds', to_jsonb(added_excluded),
    'unitBulkDiscountBps', p_unit_bulk_discount_bps, 'packDiscountBps', p_pack_discount_bps,
    'cardSurchargeBps', p_card_surcharge_bps, 'packsUpdated', packs_updated, 'branchPromotionsUpdated', promotions_updated,
    'cardSurchargeChanged', not coalesce((card_result ->> 'unchanged')::boolean, false)
  ) || recalculation;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Importación (cuerpo de 202610060065; sólo cambia v_derive)
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
  v_margin := app_private.pricing_margin_bps(v_org);
  -- D-069: un producto de una categoría EXCLUIDA no forma el precio desde el costo (precio manual): se guarda el costo (set_product_cost no
  -- reprecia a los excluidos) y, si la fila trae un precio explícito, rige la regla de siempre (se usa ese precio). La categoría ya quedó
  -- guardada arriba (save_product), así que se evalúa la de ESTA fila.
  v_derive := v_margin is not null and v_cost is not null and coalesce(v_sellable, false)
    and not app_private.is_pricing_excluded(v_org, v_id);
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
-- Permisos
-- ---------------------------------------------------------------------------------------------
revoke all on function
  app_private.is_pricing_excluded(uuid, uuid),
  app_private.apply_product_cost(uuid, uuid, bigint, timestamptz, uuid),
  app_private.recalculate_prices_from_margin(uuid, integer, uuid, boolean, boolean, uuid[], uuid[])
from public, anon, authenticated;
revoke all on function app_private.import_apply_product(public.import_batches, public.import_rows, uuid) from public, anon, authenticated;

revoke all on function public.bulk_set_product_costs(jsonb, timestamptz) from public, anon;
grant execute on function public.bulk_set_product_costs(jsonb, timestamptz) to authenticated;
revoke all on function public.save_pricing_config(integer, integer, integer, integer, boolean, boolean, uuid[]) from public, anon;
grant execute on function public.save_pricing_config(integer, integer, integer, integer, boolean, boolean, uuid[]) to authenticated;

commit;
