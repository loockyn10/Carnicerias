begin;

-- Descuentos generales POR CANTIDAD con escalones configurables (D-083). Generaliza el «Dto llevando 3u» (una sola regla "desde 3") a una
-- lista de escalones: «desde 3 unidades 15 %», «desde 5 unidades 20 %»... Se aplica SIEMPRE el mayor escalón alcanzado por la línea
-- (nunca se acumulan: 5 unidades = 20 %, no 15 % + 20 %).
--
-- NO cambia la precedencia de pricing (precio manual > Pack > promoción del producto PACK_FIXED_TOTAL > promoción de sucursal; sin
-- acumular; después recargo de tarjeta y descuento general del ticket) ni los snapshots de venta: cada escalón sigue siendo una fila
-- de branch_promotions (FROM_MINIMUM) con su id, que la venta guarda en sale_items.branch_promotion_*.
--
-- Cómo viaja (todo ya existía y soporta N reglas por sucursal):
--   * Admin: Configuración de precios -> «Descuentos por cantidad» -> save_pricing_config(p_quantity_tiers) -> tabla de escalones por
--     organización + materialización en branch_promotions de CADA sucursal (una fila activa por escalón).
--   * POS: pull_pos_state ya entrega branchPromotionsFromMinimum como ARRAY; el POS lo guarda en catalog_branch_promotions y elige el
--     mayor escalón alcanzado SIN internet. Cada venta guarda el id/mínimo/porcentaje del escalón aplicado.
--   * Sync: sync_offline_sale_core valida la línea contra LA REGLA que ella declara (id, sucursal, mínimo, porcentaje, vigencia con la
--     tolerancia de 24 h 10 min): un escalón editado/cerrado sigue validando las ventas offline hechas antes de que el POS lo supiera.
--
-- Editar un escalón CIERRA la fila vigente (active=false, valid_until) y abre otra con id nuevo: las ventas históricas conservan el
-- porcentaje con el que se hicieron. Cambiar la configuración sólo afecta ventas FUTURAS.

-- ---------------------------------------------------------------------------------------------
-- 1. Configuración: una fila por escalón de la organización (el estado ACTUAL; el histórico vive en branch_promotions)
-- ---------------------------------------------------------------------------------------------
create table public.organization_quantity_discount_tiers (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Cantidad mínima (entera, >= 2) del MISMO producto UNIT desde la cual el escalón aplica a TODAS las unidades de la línea.
  minimum_units integer not null check (minimum_units between 2 and 1000),
  -- Descuento en basis points enteros (nunca floats): 1500 = 15 %.
  discount_bps integer not null check (discount_bps between 1 and 9999),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, minimum_units)
);

create trigger organization_quantity_discount_tiers_set_updated_at before update on public.organization_quantity_discount_tiers
for each row execute function app_private.set_updated_at();
create trigger organization_quantity_discount_tiers_audit after insert or update or delete on public.organization_quantity_discount_tiers
for each row execute function app_private.audit_row_change();

alter table public.organization_quantity_discount_tiers enable row level security;
create policy organization_quantity_discount_tiers_admin_select on public.organization_quantity_discount_tiers
for select to authenticated using (app_private.has_permission(organization_id, 'prices.write'));
revoke all on table public.organization_quantity_discount_tiers from public, anon, authenticated;
grant select on table public.organization_quantity_discount_tiers to authenticated;

comment on table public.organization_quantity_discount_tiers is
  'Escalones del descuento general por cantidad (D-083): desde minimum_units unidades del mismo producto UNIT, discount_bps sobre toda la línea; aplica el MAYOR escalón alcanzado. Se materializa en branch_promotions de cada sucursal (la fuente que lee el POS). Sólo se escribe con save_pricing_config.';
comment on column public.organization_pricing_settings.unit_bulk_discount_bps is
  'Desde D-083 es el espejo del escalón MÁS BAJO (0 = sin escalones; NULL = todavía sin configurar). La fuente de verdad son los escalones de organization_quantity_discount_tiers.';

-- Datos existentes: el «Dto llevando 3u» configurado pasa a ser el escalón «desde 3 unidades».
insert into public.organization_quantity_discount_tiers (organization_id, minimum_units, discount_bps)
select s.organization_id, 3, s.unit_bulk_discount_bps
from public.organization_pricing_settings s
where coalesce(s.unit_bulk_discount_bps, 0) > 0;

-- ---------------------------------------------------------------------------------------------
-- 2. branch_promotions: varias reglas vigentes por sucursal (una por escalón)
-- ---------------------------------------------------------------------------------------------
drop index public.branch_promotions_one_active_idx;
create unique index branch_promotions_one_active_tier_idx on public.branch_promotions (branch_id, scope, minimum_units) where active;

comment on table public.branch_promotions is
  'Escalones del descuento general por cantidad de una sucursal (D-083): desde minimum_units unidades del mismo producto UNIT, discount_bps sobre TODAS las unidades de la línea (semantics FROM_MINIMUM); a lo sumo UNA fila vigente por sucursal y mínimo y aplica el mayor escalón alcanzado. Filas inmutables: editar cierra la vigente (active=false, valid_until) y crea otra. El POS las recibe en pull_pos_state (branchPromotionsFromMinimum, un array) y cada venta guarda el id y el snapshot en sale_items.';

-- ---------------------------------------------------------------------------------------------
-- 3. Validación y materialización de escalones
-- ---------------------------------------------------------------------------------------------
-- Valida y normaliza una lista de escalones [{"minimumUnits": 3, "discountBps": 1500}, ...]: ordenada por cantidad, sin cantidades
-- repetidas, cantidad entera >= 2, porcentaje entre 0,01 % y 99,99 % y descuento estrictamente creciente con la cantidad (llevar más
-- nunca puede costar más por unidad que llevar menos). Máximo 10 escalones.
create function app_private.normalize_quantity_tiers(p_tiers jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  tier jsonb;
  minimum_value numeric;
  bps_value numeric;
  seen integer[] := array[]::integer[];
  result jsonb;
  previous_bps integer := 0;
  item record;
begin
  if p_tiers is null or jsonb_typeof(p_tiers) <> 'array' then
    raise exception 'Los descuentos por cantidad tienen que ser una lista de escalones' using errcode = '22023';
  end if;
  if jsonb_array_length(p_tiers) > 10 then
    raise exception 'Se admiten hasta 10 escalones de descuento por cantidad' using errcode = '22023';
  end if;
  for tier in select value from jsonb_array_elements(p_tiers)
  loop
    if jsonb_typeof(tier) <> 'object' or coalesce(jsonb_typeof(tier -> 'minimumUnits'), '') <> 'number' or coalesce(jsonb_typeof(tier -> 'discountBps'), '') <> 'number' then
      raise exception 'Cada escalón necesita una cantidad mínima y un porcentaje' using errcode = '22023';
    end if;
    minimum_value := (tier ->> 'minimumUnits')::numeric;
    bps_value := (tier ->> 'discountBps')::numeric;
    if minimum_value <> trunc(minimum_value) or minimum_value not between 2 and 1000 then
      raise exception 'La cantidad mínima de cada escalón tiene que ser un entero entre 2 y 1000' using errcode = '22023';
    end if;
    if bps_value <> trunc(bps_value) or bps_value not between 1 and 9999 then
      raise exception 'El descuento de cada escalón tiene que ser mayor a 0 %% y menor a 100 %%' using errcode = '22023';
    end if;
    if minimum_value::integer = any (seen) then
      raise exception 'No puede haber dos escalones con la misma cantidad (%)', minimum_value::integer using errcode = '22023';
    end if;
    seen := seen || minimum_value::integer;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('minimumUnits', t."minimumUnits", 'discountBps', t."discountBps") order by t."minimumUnits"), '[]'::jsonb)
  into result
  from jsonb_to_recordset(p_tiers) as t("minimumUnits" integer, "discountBps" integer);
  for item in select t."minimumUnits" as minimum_units, t."discountBps" as discount_bps
    from jsonb_to_recordset(result) as t("minimumUnits" integer, "discountBps" integer) order by t."minimumUnits"
  loop
    if item.discount_bps <= previous_bps then
      raise exception 'Llevar más unidades tiene que dar más descuento: el escalón de % unidades no supera al anterior', item.minimum_units using errcode = '22023';
    end if;
    previous_bps := item.discount_bps;
  end loop;
  return result;
end;
$$;
revoke all on function app_private.normalize_quantity_tiers(jsonb) from public, anon, authenticated;

-- Deja las reglas vigentes de UNA sucursal exactamente iguales a la lista de escalones: cierra las que ya no están (o cambiaron de
-- porcentaje) y abre las que faltan, con id nuevo. Devuelve si algo cambió. Con `[]` apaga la promoción de la sucursal.
create function app_private.apply_quantity_discount_tiers(p_organization_id uuid, p_branch_id uuid, p_tiers jsonb, p_actor uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed boolean := false;
  current_row public.branch_promotions%rowtype;
  tier record;
begin
  perform pg_advisory_xact_lock(hashtextextended('branch_promotion:' || p_branch_id::text, 0));
  for current_row in
    select * from public.branch_promotions bp
    where bp.branch_id = p_branch_id and bp.scope = 'ALL_UNIT_PRODUCTS' and bp.active
    order by bp.minimum_units for update
  loop
    if current_row.semantics <> 'FROM_MINIMUM' or not exists (
      select 1 from jsonb_to_recordset(p_tiers) as t("minimumUnits" integer, "discountBps" integer)
      where t."minimumUnits" = current_row.minimum_units and t."discountBps" = current_row.discount_bps
    ) then
      update public.branch_promotions set active = false, valid_until = greatest(now(), valid_from) where id = current_row.id;
      changed := true;
    end if;
  end loop;
  for tier in
    select t."minimumUnits" as minimum_units, t."discountBps" as discount_bps
    from jsonb_to_recordset(p_tiers) as t("minimumUnits" integer, "discountBps" integer) order by t."minimumUnits"
  loop
    if not exists (
      select 1 from public.branch_promotions bp
      where bp.branch_id = p_branch_id and bp.scope = 'ALL_UNIT_PRODUCTS' and bp.active and bp.semantics = 'FROM_MINIMUM'
        and bp.minimum_units = tier.minimum_units and bp.discount_bps = tier.discount_bps
    ) then
      insert into public.branch_promotions (organization_id, branch_id, minimum_units, discount_bps, semantics, created_by)
      values (p_organization_id, p_branch_id, tier.minimum_units, tier.discount_bps, 'FROM_MINIMUM', p_actor);
      changed := true;
    end if;
  end loop;
  return changed;
end;
$$;
revoke all on function app_private.apply_quantity_discount_tiers(uuid, uuid, jsonb, uuid) from public, anon, authenticated;

-- Compatibilidad (Admin anterior): «Dto llevando 3u» = un único escalón «desde 3». Misma firma que 202610060065.
create or replace function app_private.apply_unit_bulk_promotion(
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
begin
  return app_private.apply_quantity_discount_tiers(
    p_organization_id, p_branch_id,
    case when p_discount_bps > 0 then jsonb_build_array(jsonb_build_object('minimumUnits', 3, 'discountBps', p_discount_bps)) else '[]'::jsonb end,
    p_actor
  );
end;
$$;

-- Una sucursal nueva nace con los escalones vigentes de la organización.
create or replace function app_private.apply_unit_bulk_promotion_to_new_branch()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  tiers jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('minimumUnits', t.minimum_units, 'discountBps', t.discount_bps) order by t.minimum_units), '[]'::jsonb)
  into tiers
  from public.organization_quantity_discount_tiers t where t.organization_id = new.organization_id;
  if jsonb_array_length(tiers) > 0 then
    perform app_private.apply_quantity_discount_tiers(new.organization_id, new.id, tiers, auth.uid());
  end if;
  return new;
end;
$$;

-- API anterior por sucursal (sin editor en el Admin desde D-068): deja a ESA sucursal con un único escalón «desde N». Misma firma y mismos
-- errores que 202610040061.
create or replace function public.save_branch_promotion(
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
  closing_id uuid;
  result_id uuid;
begin
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;
  if not coalesce(p_active, true) then
    select bp.id into closing_id from public.branch_promotions bp
    where bp.branch_id = p_branch_id and bp.scope = 'ALL_UNIT_PRODUCTS' and bp.active
    order by bp.minimum_units limit 1;
    perform app_private.apply_quantity_discount_tiers(current_organization_id, p_branch_id, '[]'::jsonb, auth.uid());
    return closing_id;
  end if;
  if p_every_units is null or p_every_units not between 2 and 1000 then
    raise exception 'La cantidad mínima tiene que ser un entero entre 2 y 1000' using errcode = '22023';
  end if;
  if p_discount_bps is null or p_discount_bps not between 1 and 9999 then
    raise exception 'El descuento tiene que estar entre 0,01 %% y 99,99 %%' using errcode = '22023';
  end if;
  perform app_private.apply_quantity_discount_tiers(
    current_organization_id, p_branch_id,
    jsonb_build_array(jsonb_build_object('minimumUnits', p_every_units, 'discountBps', p_discount_bps)), auth.uid()
  );
  select bp.id into result_id from public.branch_promotions bp
  where bp.branch_id = p_branch_id and bp.scope = 'ALL_UNIT_PRODUCTS' and bp.active and bp.minimum_units = p_every_units;
  return result_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. save_pricing_config: ahora también guarda los escalones (p_quantity_tiers; null = no tocar / compatibilidad con el Admin anterior)
-- ---------------------------------------------------------------------------------------------
-- Cuerpo de 202610070066 con tres cambios: valida y guarda la lista de escalones, materializa CADA escalón en branch_promotions de cada sucursal y
-- mantiene organization_pricing_settings.unit_bulk_discount_bps como espejo del escalón más bajo. Cambiar escalones exige catalog.write (igual que
-- antes el «Dto llevando 3u»). No cambia ningún precio de lista.
drop function public.save_pricing_config(integer, integer, integer, integer, boolean, boolean, uuid[]);
create function public.save_pricing_config(
  p_margin_bps integer,
  p_unit_bulk_discount_bps integer,
  p_pack_discount_bps integer,
  p_card_surcharge_bps integer,
  p_confirm boolean default false,
  p_close_branch_overrides boolean default false,
  p_excluded_category_ids uuid[] default null,
  p_quantity_tiers jsonb default null
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
  tiers_changed boolean;
  current_tiers jsonb;
  new_tiers jsonb;
  mirror_bps integer;
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
    raise exception 'El descuento por cantidad tiene que estar entre 0 %% y 99,99 %%' using errcode = '22023';
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

  -- Escalones del descuento por cantidad (D-083). Con p_quantity_tiers la lista manda; sin él (Admin anterior) sólo cuenta el viejo
  -- «Dto llevando 3u»: si es el mismo valor que ya había se respetan los escalones configurados, y si cambió pasa a ser el único escalón «desde 3».
  select coalesce(jsonb_agg(jsonb_build_object('minimumUnits', t.minimum_units, 'discountBps', t.discount_bps) order by t.minimum_units), '[]'::jsonb)
  into current_tiers
  from public.organization_quantity_discount_tiers t where t.organization_id = current_organization_id;
  if p_quantity_tiers is not null then
    new_tiers := app_private.normalize_quantity_tiers(p_quantity_tiers);
  elsif current_settings.unit_bulk_discount_bps is not distinct from p_unit_bulk_discount_bps then
    new_tiers := current_tiers;
  elsif p_unit_bulk_discount_bps > 0 then
    new_tiers := jsonb_build_array(jsonb_build_object('minimumUnits', 3, 'discountBps', p_unit_bulk_discount_bps));
  else
    new_tiers := '[]'::jsonb;
  end if;
  tiers_changed := new_tiers is distinct from current_tiers;
  -- El espejo histórico (organization_pricing_settings.unit_bulk_discount_bps) es el escalón más bajo; 0 = sin escalones.
  mirror_bps := coalesce((new_tiers -> 0 ->> 'discountBps')::integer, 0);

  margin_changed := current_settings.margin_bps is distinct from p_margin_bps;
  bulk_changed := tiers_changed or current_settings.unit_bulk_discount_bps is distinct from mirror_bps;
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
    current_organization_id, p_margin_bps, mirror_bps, p_pack_discount_bps, auth.uid()
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

  if tiers_changed then
    delete from public.organization_quantity_discount_tiers t
    where t.organization_id = current_organization_id
      and not exists (select 1 from jsonb_to_recordset(new_tiers) as r("minimumUnits" integer, "discountBps" integer) where r."minimumUnits" = t.minimum_units);
    insert into public.organization_quantity_discount_tiers as t (organization_id, minimum_units, discount_bps, updated_by)
    select current_organization_id, r."minimumUnits", r."discountBps", auth.uid()
    from jsonb_to_recordset(new_tiers) as r("minimumUnits" integer, "discountBps" integer)
    on conflict (organization_id, minimum_units) do update
    set discount_bps = excluded.discount_bps, updated_by = excluded.updated_by
    where t.discount_bps is distinct from excluded.discount_bps;
  end if;
  if bulk_changed then
    for branch_row in select b.id from public.branches b where b.organization_id = current_organization_id order by b.id
    loop
      if app_private.apply_quantity_discount_tiers(current_organization_id, branch_row.id, new_tiers, auth.uid()) then
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
    'unitBulkDiscountBps', mirror_bps, 'quantityTiers', new_tiers, 'packDiscountBps', p_pack_discount_bps,
    'cardSurchargeBps', p_card_surcharge_bps, 'packsUpdated', packs_updated, 'branchPromotionsUpdated', promotions_updated,
    'cardSurchargeChanged', not coalesce((card_result ->> 'unchanged')::boolean, false)
  ) || recalculation;
end;
$$;

revoke all on function public.save_pricing_config(integer, integer, integer, integer, boolean, boolean, uuid[], jsonb) from public, anon;
grant execute on function public.save_pricing_config(integer, integer, integer, integer, boolean, boolean, uuid[], jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Lecturas que anuncian «llevando N» (etiqueta de góndola, pieza de cartelería, TV): con varios escalones muestran el MÁS BAJO («desde 3»),
--    igual que antes con la única regla. Cuerpos vigentes (202610070070 / 202610080071 / 202610100073); sólo cambia la elección de la regla.
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_label_group(p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  g public.product_label_groups%rowtype;
  at_time timestamptz := now();
  v_branch_name text;
  v_bulk_minimum integer;
  v_bulk_bps integer;
  v_items jsonb;
begin
  select * into g from public.product_label_groups x where x.id = p_group_id and x.organization_id = current_organization_id;
  if not found then return null; end if;

  -- «Llevando N unidades» (sólo productos UNIT): la regla vigente de la sucursal (la que lee el POS) o, sin sucursal, la configuración
  -- global de la organización (D-068: «desde 3», toda la línea).
  if g.branch_id is not null then
    select b.name into v_branch_name from public.branches b where b.id = g.branch_id and b.organization_id = g.organization_id;
    select bp.minimum_units, bp.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.branch_promotions bp
    where bp.organization_id = g.organization_id and bp.branch_id = g.branch_id and bp.active
      and bp.semantics = 'FROM_MINIMUM' and bp.valid_from <= at_time and (bp.valid_until is null or bp.valid_until > at_time)
    order by bp.minimum_units, bp.valid_from desc, bp.id
    limit 1;
  else
    select t.minimum_units, t.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.organization_quantity_discount_tiers t where t.organization_id = g.organization_id
    order by t.minimum_units limit 1;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', r.product_id, 'position', r.position, 'name', r.name, 'sku', r.sku, 'unitType', r.unit_type,
    'available', r.reason is null, 'unavailableReason', r.reason,
    'listPriceCents', r.price_cents::text,
    'bulkMinimumUnits', case when r.unit_type = 'UNIT' then v_bulk_minimum end,
    'bulkDiscountBps', case when r.unit_type = 'UNIT' then v_bulk_bps end,
    'last', r.last_print
  ) order by r.position, r.name, r.product_id), '[]'::jsonb)
  into v_items
  from (
    select i.product_id, i.position, p.name, p.sku, p.unit_type, price.price_cents,
      case
        when not (p.active and c.active is true and p.inventory_role in ('SELLABLE', 'BOTH')) then 'INACTIVE'
        when g.branch_id is not null and not exists (
          select 1 from public.branch_product_assortment a
          where a.branch_id = g.branch_id and a.product_id = p.id and a.organization_id = p.organization_id
        ) then 'NOT_IN_BRANCH'
        when coalesce(price.price_cents, 0) <= 0 then 'NO_PRICE'
      end as reason,
      (
        select jsonb_build_object(
          'runId', ri.run_id, 'generatedAt', ri.generated_at, 'displayedName', ri.displayed_name, 'variant', ri.variant,
          'listPriceCents', ri.list_price_cents::text, 'promoPriceCents', ri.promo_price_cents::text,
          'promoMinimumUnits', ri.promo_minimum_units, 'promoDiscountBps', ri.promo_discount_bps, 'copies', ri.copies)
        from public.product_label_print_run_items ri
        where ri.group_id = g.id and ri.product_id = p.id and ri.organization_id = g.organization_id
        order by ri.generated_at desc, ri.id desc
        limit 1
      ) as last_print
    from public.product_label_group_items i
    join public.products p on p.id = i.product_id and p.organization_id = i.organization_id
    left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    -- Mismo orden que el POS (`pull_pos_state`): el precio de la sucursal vigente gana sobre el global vigente.
    left join lateral (
      select pp.price_cents
      from public.product_prices pp
      where pp.organization_id = p.organization_id and pp.product_id = p.id
        and (pp.branch_id = g.branch_id or pp.branch_id is null)
        and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time)
      order by (pp.branch_id = g.branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) price on true
    where i.group_id = g.id and i.active
  ) r;

  return jsonb_build_object('groupId', g.id, 'name', g.name, 'branchId', g.branch_id, 'branchName', v_branch_name,
    'active', g.active, 'items', v_items);
end;
$$;

create or replace function public.get_product_artwork(p_product_id uuid, p_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  at_time timestamptz := now();
  v_org_name text;
  v_branch_name text;
  v_branch_address text;
  v_bulk_minimum integer;
  v_bulk_bps integer;
  v_result jsonb;
begin
  if not exists (select 1 from public.products p where p.id = p_product_id and p.organization_id = current_organization_id) then
    return null;
  end if;
  select o.name into v_org_name from public.organizations o where o.id = current_organization_id;

  if p_branch_id is not null then
    select b.name, nullif(btrim(b.address), '') into v_branch_name, v_branch_address
    from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id;
    if not found then
      raise exception 'Branch not found' using errcode = '42501';
    end if;
    -- «Llevando N unidades» (sólo UNIT): la regla vigente de la sucursal (la que lee el POS).
    select bp.minimum_units, bp.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.branch_promotions bp
    where bp.organization_id = current_organization_id and bp.branch_id = p_branch_id and bp.active
      and bp.semantics = 'FROM_MINIMUM' and bp.valid_from <= at_time and (bp.valid_until is null or bp.valid_until > at_time)
    order by bp.minimum_units, bp.valid_from desc, bp.id
    limit 1;
  else
    -- Sin sucursal: la configuración global de la organización (D-068: «desde 3», toda la línea).
    select t.minimum_units, t.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.organization_quantity_discount_tiers t where t.organization_id = current_organization_id
    order by t.minimum_units limit 1;
  end if;

  select jsonb_build_object(
    'slideId', p.id, 'productId', p.id, 'name', p.name, 'unitType', p.unit_type,
    'available', r.reason is null, 'unavailableReason', r.reason,
    'listPriceCents', r.price_cents::text,
    'bulkMinimumUnits', case when p.unit_type = 'UNIT' then v_bulk_minimum end,
    'bulkDiscountBps', case when p.unit_type = 'UNIT' then v_bulk_bps end,
    'weightTiers', r.weight_tiers,
    'organizationName', v_org_name, 'branchId', p_branch_id, 'branchName', v_branch_name, 'branchAddress', v_branch_address,
    'photo', (
      select jsonb_build_object('storagePath', a.storage_path, 'contentType', a.content_type, 'sizeBytes', a.size_bytes)
      from public.product_artwork_photos a where a.product_id = p.id and a.organization_id = p.organization_id
    )
  )
  into v_result
  from public.products p
  left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
  left join lateral (
    select pp.price_cents
    from public.product_prices pp
    where pp.organization_id = p.organization_id and pp.product_id = p.id
      and (pp.branch_id = p_branch_id or pp.branch_id is null)
      and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time)
    order by (pp.branch_id = p_branch_id) desc nulls last, pp.valid_from desc
    limit 1
  ) price on true
  cross join lateral (
    select price.price_cents,
      case
        when not (p.active and c.active is true and p.inventory_role in ('SELLABLE', 'BOTH')) then 'INACTIVE'
        when p_branch_id is not null and not exists (
          select 1 from public.branch_product_assortment a
          where a.branch_id = p_branch_id and a.product_id = p.id and a.organization_id = p.organization_id
        ) then 'NOT_IN_BRANCH'
        when coalesce(price.price_cents, 0) <= 0 then 'NO_PRICE'
      end as reason,
      case when p.unit_type = 'WEIGHT' then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', w.id, 'minimumGrams', w.minimum_grams, 'discountType', w.discount_type, 'discountValue', w.discount_value::text
        ) order by w.minimum_grams, (w.branch_id is null))
        from public.product_weight_discounts w
        where w.organization_id = current_organization_id and w.product_id = p.id and w.active
          and w.promotion_mode = 'THRESHOLD' and w.minimum_grams is not null
          and w.valid_from <= at_time and (w.valid_until is null or w.valid_until > at_time)
          and (w.branch_id is null or w.branch_id = p_branch_id)
      ), '[]'::jsonb) else '[]'::jsonb end as weight_tiers
  ) r
  where p.id = p_product_id and p.organization_id = current_organization_id;

  return v_result;
end;
$$;

create or replace function app_private.signage_payload(p_display_id uuid, p_admin boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.digital_signage_displays%rowtype;
  at_time timestamptz := now();
  v_org_name text;
  v_logo jsonb;
  v_branch_name text;
  v_bulk_minimum integer;
  v_bulk_bps integer;
  v_slides jsonb;
begin
  select * into d from public.digital_signage_displays where id = p_display_id;
  if not found then return null; end if;
  select o.name into v_org_name from public.organizations o where o.id = d.organization_id;
  select jsonb_build_object('storagePath', l.storage_path, 'contentType', l.content_type, 'width', l.width_px, 'height', l.height_px)
  into v_logo from public.organization_artwork_logos l where l.organization_id = d.organization_id;

  if not p_admin and not d.enabled then
    return jsonb_build_object('status', 'DISABLED', 'slideDurationSeconds', d.slide_duration_seconds,
      'organizationName', v_org_name, 'logo', v_logo, 'slides', '[]'::jsonb);
  end if;

  -- «Llevando N unidades» (sólo productos UNIT): la regla vigente de la sucursal (la que lee el POS) o, sin sucursal, la configuración
  -- global de la organización (D-068: «desde 3», toda la línea).
  if d.branch_id is not null then
    select b.name into v_branch_name from public.branches b where b.id = d.branch_id;
    select bp.minimum_units, bp.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.branch_promotions bp
    where bp.organization_id = d.organization_id and bp.branch_id = d.branch_id and bp.active
      and bp.semantics = 'FROM_MINIMUM' and bp.valid_from <= at_time and (bp.valid_until is null or bp.valid_until > at_time)
    order by bp.minimum_units, bp.valid_from desc, bp.id
    limit 1;
  else
    select t.minimum_units, t.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.organization_quantity_discount_tiers t where t.organization_id = d.organization_id
    order by t.minimum_units limit 1;
  end if;

  select coalesce(jsonb_agg(
    case when p_admin then
      jsonb_build_object(
        'slideId', r.slide_id, 'position', r.position, 'productId', r.product_id, 'name', r.name, 'sku', r.sku,
        'unitType', r.unit_type, 'photo', r.photo, 'available', r.reason is null, 'unavailableReason', r.reason,
        'listPriceCents', r.price_cents::text,
        'bulkMinimumUnits', case when r.unit_type = 'UNIT' then v_bulk_minimum end,
        'bulkDiscountBps', case when r.unit_type = 'UNIT' then v_bulk_bps end,
        'weightTiers', r.weight_tiers)
    else
      jsonb_build_object(
        'slideId', r.slide_id, 'name', r.name, 'unitType', r.unit_type, 'photo', r.photo, 'listPriceCents', r.price_cents::text,
        'bulkMinimumUnits', case when r.unit_type = 'UNIT' then v_bulk_minimum end,
        'bulkDiscountBps', case when r.unit_type = 'UNIT' then v_bulk_bps end,
        'weightTiers', r.weight_tiers)
    end
    order by r.position
  ), '[]'::jsonb)
  into v_slides
  from (
    select s.id as slide_id, s.position, p.id as product_id, p.name, p.sku, p.unit_type, price.price_cents,
      (select jsonb_build_object('storagePath', a.storage_path, 'contentType', a.content_type)
         from public.product_artwork_photos a where a.product_id = p.id and a.organization_id = p.organization_id) as photo,
      case
        when not (p.active and c.active is true and p.inventory_role in ('SELLABLE', 'BOTH')) then 'INACTIVE'
        when d.branch_id is not null and not exists (
          select 1 from public.branch_product_assortment a
          where a.branch_id = d.branch_id and a.product_id = p.id and a.organization_id = p.organization_id
        ) then 'NOT_IN_BRANCH'
        when coalesce(price.price_cents, 0) <= 0 then 'NO_PRICE'
      end as reason,
      case when p.unit_type = 'WEIGHT' then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', w.id, 'minimumGrams', w.minimum_grams, 'discountType', w.discount_type, 'discountValue', w.discount_value::text
        ) order by w.minimum_grams, (w.branch_id is null))
        from public.product_weight_discounts w
        where w.organization_id = d.organization_id and w.product_id = p.id and w.active
          and w.promotion_mode = 'THRESHOLD' and w.minimum_grams is not null
          and w.valid_from <= at_time and (w.valid_until is null or w.valid_until > at_time)
          and (w.branch_id is null or w.branch_id = d.branch_id)
      ), '[]'::jsonb) else '[]'::jsonb end as weight_tiers
    from public.digital_signage_slides s
    join public.products p on p.id = s.product_id and p.organization_id = s.organization_id
    left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    -- Mismo orden que el POS (`pull_pos_state`): el precio de la sucursal vigente gana sobre el global vigente.
    left join lateral (
      select pp.price_cents
      from public.product_prices pp
      where pp.organization_id = p.organization_id and pp.product_id = p.id
        and (pp.branch_id = d.branch_id or pp.branch_id is null)
        and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time)
      order by (pp.branch_id = d.branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) price on true
    where s.display_id = d.id
  ) r
  where p_admin or r.reason is null;

  if p_admin then
    return jsonb_build_object(
      'displayId', d.id, 'name', d.name, 'enabled', d.enabled, 'branchId', d.branch_id, 'branchName', v_branch_name,
      'slideDurationSeconds', d.slide_duration_seconds, 'organizationName', v_org_name, 'logo', v_logo, 'tokenRotatedAt', d.token_rotated_at,
      'status', case when d.enabled then 'ACTIVE' else 'DISABLED' end, 'slides', v_slides);
  end if;
  return jsonb_build_object('status', 'ACTIVE', 'slideDurationSeconds', d.slide_duration_seconds,
    'organizationName', v_org_name, 'logo', v_logo, 'slides', v_slides);
end;
$$;

commit;
