begin;

-- Cartelería TV con PROMOCIONES y GRUPOS de promociones (D-084). Una pantalla ya rotaba productos con su precio/promoción vigentes (D-072,
-- D-076); ahora su lista puede incluir, además de productos:
--   * una PROMOCIÓN ya cargada en Promociones (product_weight_discounts: umbral por kg o pack a precio total), sin volver a cargar nada;
--   * un GRUPO de promociones («Ofertas fin de semana»): una selección guardada y reutilizable, en un orden, que se expande al reproducir.
--
-- NADA se copia: ni el grupo ni la pantalla guardan precio, nombre ni foto. Apuntan a la promoción (por id), y cada lectura resuelve la
-- promoción VIGENTE real: si Fran cambia el precio de una promoción, la TV muestra el nuevo valor sin recrear el grupo; si la promoción
-- vence (o todavía no empezó, o se desactivó) la pantalla la SALTEA aunque el grupo la conserve para edición/historial.
--
-- Sucursal: una pantalla con sucursal sólo muestra promociones globales o de ESA sucursal (por id, nunca por nombre) y de productos del surtido
-- de esa sucursal; una pantalla sin sucursal sólo muestra promociones globales (su precio es el global).
--
-- Seguridad: igual que antes, la ÚNICA superficie pública es get_signage_display(token) (hash del token) y devuelve sólo hechos comerciales de
-- SU pantalla. Las fotos siguen en el bucket PRIVADO product-artwork: el televisor las pide por /api/tv/<token>/media/<id>; la política de
-- Storage del rol anon se amplía únicamente a la foto de los productos de las promociones que esa pantalla (habilitada) puede mostrar.

-- ---------------------------------------------------------------------------------------------
-- 1. Tablas de grupos
-- ---------------------------------------------------------------------------------------------
-- Para poder referenciar una promoción junto con su organización (una FK compuesta impide mezclar organizaciones).
alter table public.product_weight_discounts add constraint product_weight_discounts_id_org_key unique (id, organization_id);

create table public.signage_promotion_groups (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index signage_promotion_groups_name_idx on public.signage_promotion_groups (organization_id, lower(btrim(name)));
create trigger signage_promotion_groups_set_updated_at before update on public.signage_promotion_groups
for each row execute function app_private.set_updated_at();

create table public.signage_promotion_group_items (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  group_id uuid not null,
  promotion_id uuid not null,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  unique (group_id, promotion_id),
  unique (group_id, position),
  foreign key (group_id, organization_id) references public.signage_promotion_groups(id, organization_id) on delete cascade,
  foreign key (promotion_id, organization_id) references public.product_weight_discounts(id, organization_id) on delete cascade
);
create index signage_promotion_group_items_promotion_idx on public.signage_promotion_group_items (promotion_id);

alter table public.signage_promotion_groups enable row level security;
alter table public.signage_promotion_group_items enable row level security;
create policy signage_promotion_groups_admin_select on public.signage_promotion_groups
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));
create policy signage_promotion_group_items_admin_select on public.signage_promotion_group_items
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));
revoke all on table public.signage_promotion_groups from public, anon, authenticated;
revoke all on table public.signage_promotion_group_items from public, anon, authenticated;
grant select on table public.signage_promotion_groups to authenticated;
grant select on table public.signage_promotion_group_items to authenticated;

comment on table public.signage_promotion_groups is
  'Grupo reutilizable de promociones para la cartelería de TV (D-084). Sólo es una selección ordenada: el precio, el nombre y la foto se resuelven en cada lectura desde la promoción vigente.';
comment on table public.signage_promotion_group_items is
  'Promociones de un grupo, en orden. Apuntan a product_weight_discounts por id (sin snapshots): una promoción vencida se conserva acá pero la TV la saltea.';

-- ---------------------------------------------------------------------------------------------
-- 2. La lista de una pantalla admite productos, promociones y grupos
-- ---------------------------------------------------------------------------------------------
alter table public.digital_signage_slides
  add column kind text not null default 'PRODUCT' check (kind in ('PRODUCT', 'PROMOTION', 'GROUP')),
  add column promotion_id uuid,
  add column group_id uuid;
alter table public.digital_signage_slides alter column product_id drop not null;
alter table public.digital_signage_slides drop constraint digital_signage_slides_display_id_product_id_key;
alter table public.digital_signage_slides
  add constraint digital_signage_slides_kind_shape check (
    (kind = 'PRODUCT' and product_id is not null and promotion_id is null and group_id is null)
    or (kind = 'PROMOTION' and promotion_id is not null and product_id is null and group_id is null)
    or (kind = 'GROUP' and group_id is not null and product_id is null and promotion_id is null)),
  add constraint digital_signage_slides_promotion_fk foreign key (promotion_id, organization_id)
    references public.product_weight_discounts(id, organization_id) on delete cascade,
  -- Un grupo en uso no se elimina (la función de borrado lo explica antes); la FK es la red de seguridad.
  add constraint digital_signage_slides_group_fk foreign key (group_id, organization_id)
    references public.signage_promotion_groups(id, organization_id) on delete restrict;
create unique index digital_signage_slides_product_idx on public.digital_signage_slides (display_id, product_id) where kind = 'PRODUCT';
create unique index digital_signage_slides_promotion_idx on public.digital_signage_slides (display_id, promotion_id) where kind = 'PROMOTION';
create unique index digital_signage_slides_group_idx on public.digital_signage_slides (display_id, group_id) where kind = 'GROUP';

comment on table public.digital_signage_slides is
  'Entradas publicadas de una pantalla, en orden: un producto, una promoción o un grupo de promociones (kind). Sin precios: apuntan al origen, el precio/promoción se resuelve en cada lectura.';

-- ---------------------------------------------------------------------------------------------
-- 3. Vigencia de una promoción
-- ---------------------------------------------------------------------------------------------
-- ACTIVE: activa y dentro de su vigencia. UPCOMING: activa pero todavía no empezó. EXPIRED: ya venció o fue desactivada.
create function app_private.signage_promotion_status(p_active boolean, p_valid_from timestamptz, p_valid_until timestamptz, p_at timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_active is null then null
    when not p_active then 'EXPIRED'
    when p_valid_from > p_at then 'UPCOMING'
    when p_valid_until is not null and p_valid_until <= p_at then 'EXPIRED'
    else 'ACTIVE'
  end
$$;
revoke all on function app_private.signage_promotion_status(boolean, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Hechos de la pantalla (cuerpo de 202610180081; cambia sólo la lista de diapositivas y sus motivos)
-- ---------------------------------------------------------------------------------------------
-- Cada entrada se expande en diapositivas: producto -> 1; promoción -> 1; grupo -> sus promociones en el orden del grupo. Una promoción que
-- aparece dos veces (directa y por un grupo) se reproduce una sola vez, en su primera posición. El televisor (p_admin = false) sólo recibe
-- las disponibles; el editor (p_admin = true) las recibe todas con el motivo: INACTIVE, NOT_IN_BRANCH, NO_PRICE, PROMO_EXPIRED, PROMO_UPCOMING.
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
  v_entries jsonb;
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

  -- «Llevando N unidades» (sólo productos UNIT): el escalón más bajo vigente de la sucursal (la que lee el POS) o, sin sucursal, el de la
  -- configuración global de la organización.
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
        'slideId', r.slide_id, 'entryId', r.entry_id, 'kind', r.kind, 'position', r.ord, 'productId', r.product_id, 'name', r.name, 'sku', r.sku,
        'unitType', r.unit_type, 'photo', r.photo, 'available', r.reason is null, 'unavailableReason', r.reason,
        'listPriceCents', r.price_cents::text,
        'bulkMinimumUnits', case when r.kind = 'PRODUCT' and r.unit_type = 'UNIT' then v_bulk_minimum end,
        'bulkDiscountBps', case when r.kind = 'PRODUCT' and r.unit_type = 'UNIT' then v_bulk_bps end,
        'weightTiers', r.weight_tiers, 'promotion', r.promotion)
    else
      jsonb_build_object(
        'slideId', r.slide_id, 'kind', r.kind, 'name', r.name, 'unitType', r.unit_type, 'photo', r.photo, 'listPriceCents', r.price_cents::text,
        'bulkMinimumUnits', case when r.kind = 'PRODUCT' and r.unit_type = 'UNIT' then v_bulk_minimum end,
        'bulkDiscountBps', case when r.kind = 'PRODUCT' and r.unit_type = 'UNIT' then v_bulk_bps end,
        'weightTiers', r.weight_tiers, 'promotion', r.promotion)
    end
    order by r.ord
  ), '[]'::jsonb)
  into v_slides
  from (
    select base.slide_id, base.entry_id, base.kind, base.ord, p.id as product_id, p.name, p.sku, p.unit_type, price.price_cents,
      (select jsonb_build_object('storagePath', a.storage_path, 'contentType', a.content_type)
         from public.product_artwork_photos a where a.product_id = p.id and a.organization_id = p.organization_id) as photo,
      case
        when base.kind = 'PROMOTION' and ps.st = 'EXPIRED' then 'PROMO_EXPIRED'
        when base.kind = 'PROMOTION' and ps.st = 'UPCOMING' then 'PROMO_UPCOMING'
        when not (p.active and c.active is true and p.inventory_role in ('SELLABLE', 'BOTH')) then 'INACTIVE'
        -- Una promoción de OTRA sucursal (o de una sucursal cuando la pantalla es global) nunca se muestra: se decide por ids.
        when base.kind = 'PROMOTION' and w.branch_id is not null and w.branch_id is distinct from d.branch_id then 'NOT_IN_BRANCH'
        when d.branch_id is not null and not exists (
          select 1 from public.branch_product_assortment a
          where a.branch_id = d.branch_id and a.product_id = p.id and a.organization_id = p.organization_id
        ) then 'NOT_IN_BRANCH'
        when coalesce(price.price_cents, 0) <= 0 then 'NO_PRICE'
      end as reason,
      case when base.kind = 'PRODUCT' and p.unit_type = 'WEIGHT' then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id, 'minimumGrams', t.minimum_grams, 'discountType', t.discount_type, 'discountValue', t.discount_value::text
        ) order by t.minimum_grams, (t.branch_id is null))
        from public.product_weight_discounts t
        where t.organization_id = d.organization_id and t.product_id = p.id and t.active
          and t.promotion_mode = 'THRESHOLD' and t.minimum_grams is not null
          and t.valid_from <= at_time and (t.valid_until is null or t.valid_until > at_time)
          and (t.branch_id is null or t.branch_id = d.branch_id)
      ), '[]'::jsonb) else '[]'::jsonb end as weight_tiers,
      case when base.kind = 'PROMOTION' then jsonb_build_object(
        'promotionId', w.id, 'mode', w.promotion_mode, 'status', ps.st, 'branchId', w.branch_id,
        'validFrom', w.valid_from, 'validUntil', w.valid_until,
        'minimumGrams', w.minimum_grams, 'discountType', w.discount_type, 'discountValue', w.discount_value::text,
        'packQuantityGrams', w.pack_quantity_grams, 'packQuantityUnits', w.pack_quantity_units, 'packPriceCents', w.pack_price_cents::text
      ) end as promotion
    from (
      select y.*, row_number() over (order by y.pos, y.sub) as ord
      from (
        select z.*, row_number() over (partition by coalesce(z.promotion_id, z.slide_id) order by z.pos, z.sub) as rn
        from (
          select s.id as slide_id, s.id as entry_id, s.position as pos, 0 as sub, 'PRODUCT'::text as kind, s.product_id as product_ref, null::uuid as promotion_id
          from public.digital_signage_slides s where s.display_id = d.id and s.kind = 'PRODUCT'
          union all
          select s.promotion_id, s.id, s.position, 0, 'PROMOTION', null::uuid, s.promotion_id
          from public.digital_signage_slides s where s.display_id = d.id and s.kind = 'PROMOTION'
          union all
          select gi.promotion_id, s.id, s.position, gi.position + 1, 'PROMOTION', null::uuid, gi.promotion_id
          from public.digital_signage_slides s
          join public.signage_promotion_group_items gi on gi.group_id = s.group_id and gi.organization_id = s.organization_id
          where s.display_id = d.id and s.kind = 'GROUP'
        ) z
      ) y
      where y.rn = 1
    ) base
    left join public.product_weight_discounts w on base.kind = 'PROMOTION' and w.id = base.promotion_id and w.organization_id = d.organization_id
    join public.products p on p.organization_id = d.organization_id and p.id = case when base.kind = 'PRODUCT' then base.product_ref else w.product_id end
    left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    cross join lateral (select app_private.signage_promotion_status(w.active, w.valid_from, w.valid_until, at_time) as st) ps
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
  ) r
  where p_admin or r.reason is null;

  if p_admin then
    select coalesce(jsonb_agg(jsonb_build_object(
      'entryId', s.id, 'position', s.position, 'kind', s.kind, 'productId', s.product_id, 'promotionId', s.promotion_id, 'groupId', s.group_id,
      'groupName', g.name,
      'groupPromotionCount', (select count(*) from public.signage_promotion_group_items gi where gi.group_id = s.group_id)
    ) order by s.position), '[]'::jsonb)
    into v_entries
    from public.digital_signage_slides s
    left join public.signage_promotion_groups g on g.id = s.group_id and g.organization_id = s.organization_id
    where s.display_id = d.id;
    return jsonb_build_object(
      'displayId', d.id, 'name', d.name, 'enabled', d.enabled, 'branchId', d.branch_id, 'branchName', v_branch_name,
      'slideDurationSeconds', d.slide_duration_seconds, 'organizationName', v_org_name, 'logo', v_logo, 'tokenRotatedAt', d.token_rotated_at,
      'status', case when d.enabled then 'ACTIVE' else 'DISABLED' end, 'entries', v_entries, 'slides', v_slides);
  end if;
  return jsonb_build_object('status', 'ACTIVE', 'slideDurationSeconds', d.slide_duration_seconds,
    'organizationName', v_org_name, 'logo', v_logo, 'slides', v_slides);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Lectura de Storage del televisor (anon): también la foto de los productos de las promociones que la pantalla puede mostrar
-- ---------------------------------------------------------------------------------------------
create or replace function public.signage_object_is_published(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_name is not null and exists (
    select 1
    from public.digital_signage_displays d
    where d.enabled
      and (
        exists (
          select 1
          from public.digital_signage_slides s
          join public.product_artwork_photos a on a.product_id = s.product_id and a.organization_id = s.organization_id
          where s.display_id = d.id and s.kind = 'PRODUCT' and a.storage_path = p_name
        )
        or exists (
          select 1
          from public.digital_signage_slides s
          join public.product_weight_discounts w on w.id = s.promotion_id and w.organization_id = s.organization_id
          join public.product_artwork_photos a on a.product_id = w.product_id and a.organization_id = w.organization_id
          where s.display_id = d.id and s.kind = 'PROMOTION' and a.storage_path = p_name
        )
        or exists (
          select 1
          from public.digital_signage_slides s
          join public.signage_promotion_group_items gi on gi.group_id = s.group_id and gi.organization_id = s.organization_id
          join public.product_weight_discounts w on w.id = gi.promotion_id and w.organization_id = gi.organization_id
          join public.product_artwork_photos a on a.product_id = w.product_id and a.organization_id = w.organization_id
          where s.display_id = d.id and s.kind = 'GROUP' and a.storage_path = p_name
        )
        or exists (
          select 1 from public.organization_artwork_logos l where l.organization_id = d.organization_id and l.storage_path = p_name
        )
      )
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Guardar la pantalla con sus entradas (productos, promociones y grupos), en orden
-- ---------------------------------------------------------------------------------------------
-- p_entries: [{"kind":"PRODUCT"|"PROMOTION"|"GROUP","id":"<uuid>"}, ...]. Misma validación que save_signage_display (hasta 50 entradas, sin
-- repetidos, todo de ESTA organización) y una sola transacción. La función anterior (sólo productos) sigue existiendo para el Admin ya desplegado.
create function public.save_signage_display_entries(
  p_display_id uuid,
  p_name text,
  p_branch_id uuid,
  p_slide_duration_seconds integer,
  p_enabled boolean,
  p_entries jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  d public.digital_signage_displays%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_entries jsonb := coalesce(p_entries, '[]'::jsonb);
  v_before jsonb;
  v_count integer;
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception 'El nombre de la pantalla tiene que tener entre 1 y 80 caracteres' using errcode = '22023';
  end if;
  if p_slide_duration_seconds is null or p_slide_duration_seconds not between 3 and 60 then
    raise exception 'La duración de cada slide tiene que estar entre 3 y 60 segundos' using errcode = '22023';
  end if;
  if p_enabled is null then
    raise exception 'Enabled is required' using errcode = '22023';
  end if;
  if jsonb_typeof(v_entries) <> 'array' then
    raise exception 'La lista de la pantalla tiene que ser una lista' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(v_entries);
  if v_count > 50 then
    raise exception 'Una pantalla admite hasta 50 entradas' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_entries) e
    where jsonb_typeof(e) <> 'object' or (e ->> 'kind') is null or (e ->> 'kind') not in ('PRODUCT', 'PROMOTION', 'GROUP')
      or (e ->> 'id') is null or (e ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'La lista de la pantalla tiene entradas inválidas' using errcode = '22023';
  end if;
  if (select count(distinct (e ->> 'kind') || ':' || lower(e ->> 'id')) from jsonb_array_elements(v_entries) e) <> v_count then
    raise exception 'La lista de la pantalla tiene entradas repetidas' using errcode = '22023';
  end if;

  select * into d from public.digital_signage_displays x
  where x.id = p_display_id and x.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Signage display not found' using errcode = '42501';
  end if;
  if p_branch_id is not null and not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;
  if (select count(*) from jsonb_array_elements(v_entries) e join public.products p on p.id = (e ->> 'id')::uuid and p.organization_id = current_organization_id
        where e ->> 'kind' = 'PRODUCT')
     <> (select count(*) from jsonb_array_elements(v_entries) e where e ->> 'kind' = 'PRODUCT') then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
  if (select count(*) from jsonb_array_elements(v_entries) e join public.product_weight_discounts w on w.id = (e ->> 'id')::uuid and w.organization_id = current_organization_id
        where e ->> 'kind' = 'PROMOTION')
     <> (select count(*) from jsonb_array_elements(v_entries) e where e ->> 'kind' = 'PROMOTION') then
    raise exception 'Promotion was not found in this organization' using errcode = '42501';
  end if;
  if (select count(*) from jsonb_array_elements(v_entries) e join public.signage_promotion_groups g on g.id = (e ->> 'id')::uuid and g.organization_id = current_organization_id
        where e ->> 'kind' = 'GROUP')
     <> (select count(*) from jsonb_array_elements(v_entries) e where e ->> 'kind' = 'GROUP') then
    raise exception 'Promotion group was not found in this organization' using errcode = '42501';
  end if;

  v_before := jsonb_build_object('name', d.name, 'branch_id', d.branch_id, 'slide_duration_seconds', d.slide_duration_seconds,
    'enabled', d.enabled, 'entries', coalesce((select jsonb_agg(jsonb_build_object('kind', s.kind, 'id', coalesce(s.product_id, s.promotion_id, s.group_id)) order by s.position)
      from public.digital_signage_slides s where s.display_id = d.id), '[]'::jsonb));

  update public.digital_signage_displays
  set name = v_name, branch_id = p_branch_id, slide_duration_seconds = p_slide_duration_seconds, enabled = p_enabled
  where id = d.id;
  delete from public.digital_signage_slides where display_id = d.id;
  insert into public.digital_signage_slides (organization_id, display_id, kind, product_id, promotion_id, group_id, position)
  select current_organization_id, d.id, t.value ->> 'kind',
    case when t.value ->> 'kind' = 'PRODUCT' then (t.value ->> 'id')::uuid end,
    case when t.value ->> 'kind' = 'PROMOTION' then (t.value ->> 'id')::uuid end,
    case when t.value ->> 'kind' = 'GROUP' then (t.value ->> 'id')::uuid end,
    (t.ord - 1)::integer
  from jsonb_array_elements(v_entries) with ordinality as t(value, ord);

  perform app_private.write_audit(current_organization_id, p_branch_id, 'DIGITAL_SIGNAGE_DISPLAYS_UPDATE', 'digital_signage_displays', d.id,
    v_before, jsonb_build_object('name', v_name, 'branch_id', p_branch_id, 'slide_duration_seconds', p_slide_duration_seconds,
      'enabled', p_enabled, 'entries', v_entries));
  return jsonb_build_object('id', d.id, 'entries', v_count);
end;
$$;
revoke all on function public.save_signage_display_entries(uuid, text, uuid, integer, boolean, jsonb) from public, anon;
grant execute on function public.save_signage_display_entries(uuid, text, uuid, integer, boolean, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. Grupos de promociones: crear / renombrar / editar (reemplaza la lista ordenada) y eliminar
-- ---------------------------------------------------------------------------------------------
create function public.save_signage_group(p_group_id uuid, p_name text, p_promotion_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  v_name text := btrim(coalesce(p_name, ''));
  v_ids uuid[] := coalesce(p_promotion_ids, array[]::uuid[]);
  v_group_id uuid;
  v_before jsonb;
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception 'El nombre del grupo tiene que tener entre 1 y 80 caracteres' using errcode = '22023';
  end if;
  if cardinality(v_ids) not between 1 and 50 then
    raise exception 'Un grupo necesita entre 1 y 50 promociones' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_ids) as t(id) where t.id is null)
     or (select count(distinct t.id) from unnest(v_ids) as t(id)) <> cardinality(v_ids) then
    raise exception 'La lista de promociones tiene ids vacíos o repetidos' using errcode = '22023';
  end if;
  if (select count(*) from public.product_weight_discounts w where w.organization_id = current_organization_id and w.id = any(v_ids)) <> cardinality(v_ids) then
    raise exception 'Promotion was not found in this organization' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.signage_promotion_groups g
    where g.organization_id = current_organization_id and lower(btrim(g.name)) = lower(v_name) and g.id is distinct from p_group_id
  ) then
    raise exception 'Ya existe un grupo con el nombre «%»', v_name using errcode = '22023';
  end if;

  if p_group_id is null then
    insert into public.signage_promotion_groups (organization_id, name, created_by)
    values (current_organization_id, v_name, auth.uid())
    returning id into v_group_id;
    v_before := null;
  else
    select g.id into v_group_id from public.signage_promotion_groups g
    where g.id = p_group_id and g.organization_id = current_organization_id
    for update;
    if not found then
      raise exception 'Promotion group was not found in this organization' using errcode = '42501';
    end if;
    v_before := jsonb_build_object('name', (select g.name from public.signage_promotion_groups g where g.id = v_group_id),
      'promotion_ids', coalesce((select jsonb_agg(i.promotion_id order by i.position) from public.signage_promotion_group_items i where i.group_id = v_group_id), '[]'::jsonb));
    update public.signage_promotion_groups set name = v_name where id = v_group_id;
    delete from public.signage_promotion_group_items where group_id = v_group_id;
  end if;

  insert into public.signage_promotion_group_items (organization_id, group_id, promotion_id, position)
  select current_organization_id, v_group_id, t.id, (t.ord - 1)::integer
  from unnest(v_ids) with ordinality as t(id, ord);

  perform app_private.write_audit(current_organization_id, null, case when p_group_id is null then 'SIGNAGE_PROMOTION_GROUP_CREATED' else 'SIGNAGE_PROMOTION_GROUP_UPDATED' end,
    'signage_promotion_groups', v_group_id, v_before, jsonb_build_object('name', v_name, 'promotion_ids', to_jsonb(v_ids)));
  return jsonb_build_object('id', v_group_id, 'promotions', cardinality(v_ids));
end;
$$;
revoke all on function public.save_signage_group(uuid, text, uuid[]) from public, anon;
grant execute on function public.save_signage_group(uuid, text, uuid[]) to authenticated;

-- Un grupo que alguna pantalla usa NO se elimina (la pantalla perdería contenido sin avisar): primero se lo saca de esas pantallas.
create function public.delete_signage_group(p_group_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  g public.signage_promotion_groups%rowtype;
  v_used integer;
  v_names text;
begin
  select * into g from public.signage_promotion_groups x
  where x.id = p_group_id and x.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Promotion group was not found in this organization' using errcode = '42501';
  end if;
  select count(*)::integer, string_agg(d.name, ', ' order by d.name)
  into v_used, v_names
  from public.digital_signage_slides s
  join public.digital_signage_displays d on d.id = s.display_id and d.organization_id = s.organization_id
  where s.group_id = g.id and s.kind = 'GROUP';
  if v_used > 0 then
    raise exception 'El grupo «%» está en uso en % pantalla(s): %. Sacalo de esas pantallas antes de eliminarlo', g.name, v_used, v_names using errcode = '23503';
  end if;
  delete from public.signage_promotion_groups where id = g.id;
  perform app_private.write_audit(current_organization_id, null, 'SIGNAGE_PROMOTION_GROUP_DELETED', 'signage_promotion_groups', g.id,
    jsonb_build_object('name', g.name), null);
  return jsonb_build_object('id', g.id, 'deleted', true);
end;
$$;
revoke all on function public.delete_signage_group(uuid) from public, anon;
grant execute on function public.delete_signage_group(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. Catálogo del editor: las promociones cargadas en Promociones + los grupos
-- ---------------------------------------------------------------------------------------------
-- p_applicable_only = true (por defecto): sólo las que esa pantalla podría mostrar (sucursal elegida o, sin sucursal, las globales). Con
-- false: todas (administración de grupos). Devuelve las vigentes y próximas, las vencidas de los últimos 90 días y las que algún grupo conserva.
-- Hechos puros (precio de lista, regla, foto sí/no): el texto de la oferta lo arma el Admin con el motor de pricing.
create function public.get_signage_promotion_catalog(p_branch_id uuid default null, p_applicable_only boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  at_time timestamptz := now();
  v_promotions jsonb;
  v_groups jsonb;
begin
  if p_branch_id is not null and not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'promotionId', r.promotion_id, 'productId', r.product_id, 'productName', r.name, 'sku', r.sku, 'unitType', r.unit_type,
    'branchId', r.branch_id, 'branchName', r.branch_name, 'mode', r.promotion_mode, 'status', r.st,
    'validFrom', r.valid_from, 'validUntil', r.valid_until,
    'listPriceCents', r.price_cents::text, 'hasPhoto', r.has_photo, 'unavailableReason', r.reason,
    'minimumGrams', r.minimum_grams, 'discountType', r.discount_type, 'discountValue', r.discount_value::text,
    'packQuantityGrams', r.pack_quantity_grams, 'packQuantityUnits', r.pack_quantity_units, 'packPriceCents', r.pack_price_cents::text
  ) order by case r.st when 'ACTIVE' then 0 when 'UPCOMING' then 1 else 2 end, r.name, r.promotion_id), '[]'::jsonb)
  into v_promotions
  from (
    select w.id as promotion_id, p.id as product_id, p.name, p.sku, p.unit_type, w.branch_id, br.name as branch_name, w.promotion_mode,
      ps.st, w.valid_from, w.valid_until, price.price_cents,
      exists (select 1 from public.product_artwork_photos a where a.product_id = p.id and a.organization_id = p.organization_id) as has_photo,
      case
        when not (p.active and c.active is true and p.inventory_role in ('SELLABLE', 'BOTH')) then 'INACTIVE'
        when coalesce(price.price_cents, 0) <= 0 then 'NO_PRICE'
      end as reason,
      w.minimum_grams, w.discount_type, w.discount_value, w.pack_quantity_grams, w.pack_quantity_units, w.pack_price_cents
    from public.product_weight_discounts w
    join public.products p on p.id = w.product_id and p.organization_id = w.organization_id
    left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    left join public.branches br on br.id = w.branch_id and br.organization_id = w.organization_id
    cross join lateral (select app_private.signage_promotion_status(w.active, w.valid_from, w.valid_until, at_time) as st) ps
    left join lateral (
      select pp.price_cents
      from public.product_prices pp
      where pp.organization_id = p.organization_id and pp.product_id = p.id
        and (pp.branch_id = coalesce(p_branch_id, w.branch_id) or pp.branch_id is null)
        and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time)
      order by (pp.branch_id = coalesce(p_branch_id, w.branch_id)) desc nulls last, pp.valid_from desc
      limit 1
    ) price on true
    where w.organization_id = current_organization_id
      and (
        ps.st in ('ACTIVE', 'UPCOMING')
        or (w.valid_until is not null and w.valid_until > at_time - interval '90 days')
        or exists (select 1 from public.signage_promotion_group_items gi where gi.promotion_id = w.id)
      )
      and (not coalesce(p_applicable_only, true) or (
        case when p_branch_id is null then w.branch_id is null
        else (w.branch_id is null or w.branch_id = p_branch_id)
          and exists (select 1 from public.branch_product_assortment a where a.branch_id = p_branch_id and a.product_id = p.id and a.organization_id = p.organization_id)
        end
      ))
  ) r;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', g.id, 'name', g.name,
    'promotionIds', coalesce((select jsonb_agg(i.promotion_id order by i.position) from public.signage_promotion_group_items i where i.group_id = g.id), '[]'::jsonb),
    'usedByDisplays', (select count(distinct s.display_id) from public.digital_signage_slides s where s.group_id = g.id and s.kind = 'GROUP')
  ) order by g.name, g.id), '[]'::jsonb)
  into v_groups
  from public.signage_promotion_groups g
  where g.organization_id = current_organization_id;

  return jsonb_build_object('promotions', v_promotions, 'groups', v_groups);
end;
$$;
revoke all on function public.get_signage_promotion_catalog(uuid, boolean) from public, anon;
grant execute on function public.get_signage_promotion_catalog(uuid, boolean) to authenticated;

commit;
