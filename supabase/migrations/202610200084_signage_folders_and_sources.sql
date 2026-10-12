begin;

-- Cartelería: CARPETAS de gráficas y TV alimentada directamente por PROMOCIONES (D-086).
--
--   1. PROMOCIONES es la fuente de verdad comercial. Una pantalla de TV ya no necesita una lista armada a mano: su FUENTE de contenido es
--      «todas las promociones activas que le aplican» (por defecto) o «una carpeta». La lista manual de D-072/D-084 queda sólo como
--      origen anterior (MANUAL) de las pantallas que ya la tenían: no se puede elegir de nuevo.
--   2. CARPETA = los «grupos de promociones» de D-084 (mismas tablas) ampliados: además de promociones admiten productos sueltos y
--      guardan los formatos a generar (Feed / Story). NO copian precio, nombre ni foto: sólo referencias (ids) en un orden. Al
--      generar o reproducir se resuelve el precio, la promoción y la foto VIGENTES.
--   3. UN SOLO resolvedor de hechos (`app_private.signage_resolve_entries`): lo usan la TV pública, el editor, la generación de gráficas
--      de una carpeta y la vista previa. Es el cuerpo de `signage_payload` (D-084) extraído sin cambiar sus reglas (precio de la
--      sucursal > global, vigencia, surtido, producto activo, promoción de otra sucursal => NOT_IN_BRANCH) y con 2 hechos nuevos del
--      producto (pack: tamaño y descuento) para anunciar «PACK 10 UNIDADES» con el motor de pricing de TypeScript.
--   4. Seguridad sin cambios de fondo: `get_signage_display(token)` sigue siendo la única superficie pública; las fotos siguen en el
--      bucket PRIVADO `product-artwork` y la política `anon` de Storage sólo alcanza a las de lo que una pantalla habilitada reproduce
--      HOY con su fuente (todas las promociones activas / su carpeta / su lista anterior). Nada de escritura anónima.
--
-- Incremental: no edita la 069/073/082; reemplaza funciones con `create or replace` (misma firma) y suma columnas/funciones nuevas.
-- Requiere la 082 (grupos de promociones) y la 081 (escalones por cantidad).

-- ---------------------------------------------------------------------------------------------
-- 1. Carpetas: formatos + productos sueltos
-- ---------------------------------------------------------------------------------------------
alter table public.signage_promotion_groups
  add column generate_feed boolean not null default true,
  add column generate_story boolean not null default true,
  add constraint signage_folders_formats_check check (generate_feed or generate_story);

alter table public.signage_promotion_group_items
  add column product_id uuid,
  alter column promotion_id drop not null,
  add constraint signage_folder_items_shape check ((promotion_id is null) <> (product_id is null)),
  add constraint signage_folder_items_product_fk foreign key (product_id, organization_id)
    references public.products(id, organization_id) on delete cascade;
create unique index signage_folder_items_product_idx on public.signage_promotion_group_items (group_id, product_id) where product_id is not null;
create index signage_folder_items_product_ref_idx on public.signage_promotion_group_items (product_id) where product_id is not null;

comment on table public.signage_promotion_groups is
  'CARPETA de cartelería (D-086; antes «grupo de promociones», D-084): una selección ordenada de promociones o productos y los formatos a generar (Feed/Story). Sólo referencias: el precio, el nombre y la foto se resuelven en cada lectura con lo vigente.';
comment on table public.signage_promotion_group_items is
  'Elementos de una carpeta, en orden: una promoción (product_weight_discounts) o un producto sin promoción. Sin snapshots: una promoción vencida o desactivada se conserva acá (con su estado) pero no se genera ni se reproduce.';

-- ---------------------------------------------------------------------------------------------
-- 2. Fuente de contenido de la pantalla
-- ---------------------------------------------------------------------------------------------
alter table public.digital_signage_displays
  add column content_source text not null default 'ALL_PROMOTIONS' check (content_source in ('ALL_PROMOTIONS', 'FOLDER', 'MANUAL')),
  add column folder_id uuid,
  add constraint digital_signage_displays_folder_fk foreign key (folder_id, organization_id)
    references public.signage_promotion_groups(id, organization_id) on delete restrict,
  add constraint digital_signage_displays_source_shape check ((content_source = 'FOLDER') = (folder_id is not null));

-- Las pantallas que ya tenían una lista armada a mano siguen mostrando exactamente eso hasta que alguien elija otra fuente.
update public.digital_signage_displays d set content_source = 'MANUAL'
where exists (select 1 from public.digital_signage_slides s where s.display_id = d.id);

grant select (content_source, folder_id) on public.digital_signage_displays to authenticated;

-- Las RPC anteriores (`save_signage_display`, `save_signage_display_entries`) arman una lista a mano: si alguien la guarda, esa lista es la
-- que se reproduce. Un Admin ya desplegado sigue funcionando igual hasta que se elija una fuente nueva (`save_signage_display_source`).
create function app_private.digital_signage_slides_use_manual_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.digital_signage_displays
  set content_source = 'MANUAL', folder_id = null
  where id = new.display_id and organization_id = new.organization_id and content_source <> 'MANUAL';
  return new;
end;
$$;
revoke all on function app_private.digital_signage_slides_use_manual_source() from public, anon, authenticated;
create trigger digital_signage_slides_use_manual_source after insert on public.digital_signage_slides
for each row execute function app_private.digital_signage_slides_use_manual_source();

-- ---------------------------------------------------------------------------------------------
-- 2b. Transparencia de la foto comercial
-- ---------------------------------------------------------------------------------------------
-- Una foto con fondo TRANSPARENTE (PNG recortado) se aprovecha con una mancha amarilla detrás; una con fondo propio (JPG o PNG opaco) se deja
-- tal cual. Es un hecho derivado de los bytes del archivo: lo registra el Admin al subir la foto (o, para las ya subidas, la primera vez
-- que se necesita). NULL = todavía no se sabe (se trata como opaca: la pieza se ve como siempre). Un JPG nunca tiene transparencia.
alter table public.product_artwork_photos add column has_alpha boolean;
update public.product_artwork_photos set has_alpha = false where content_type = 'image/jpeg';

create function app_private.product_artwork_photos_reset_alpha()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.storage_path is distinct from old.storage_path then
    new.has_alpha := case when new.content_type = 'image/jpeg' then false else null end;
  end if;
  return new;
end;
$$;
revoke all on function app_private.product_artwork_photos_reset_alpha() from public, anon, authenticated;
create trigger product_artwork_photos_reset_alpha before insert or update on public.product_artwork_photos
for each row execute function app_private.product_artwork_photos_reset_alpha();

create function public.set_product_artwork_photo_alpha(p_product_id uuid, p_storage_path text, p_has_alpha boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  v_updated integer;
begin
  if p_has_alpha is null then
    raise exception 'has_alpha is required' using errcode = '22023';
  end if;
  -- Sólo se registra si la foto actual SIGUE siendo la que se analizó (si se cambió mientras tanto, el dato ya no vale).
  update public.product_artwork_photos a set has_alpha = p_has_alpha
  where a.product_id = p_product_id and a.organization_id = current_organization_id and a.storage_path = p_storage_path and a.content_type = 'image/png';
  get diagnostics v_updated = row_count;
  return jsonb_build_object('productId', p_product_id, 'updated', v_updated = 1);
end;
$$;
revoke all on function public.set_product_artwork_photo_alpha(uuid, text, boolean) from public, anon;
grant execute on function public.set_product_artwork_photo_alpha(uuid, text, boolean) to authenticated;

-- Escalones «llevando N» VIGENTES (todos, de menor a mayor cantidad): los que lee el POS (los de la sucursal) o, sin sucursal, la configuración
-- global de la organización. Misma fuente que el pricing; acá sólo se leen.
create function app_private.signage_bulk_tiers(p_organization_id uuid, p_branch_id uuid, p_at timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('minimumUnits', x.minimum_units, 'discountBps', x.discount_bps) order by x.minimum_units), '[]'::jsonb)
  from (
    select bp.minimum_units, bp.discount_bps
    from public.branch_promotions bp
    where p_branch_id is not null and bp.organization_id = p_organization_id and bp.branch_id = p_branch_id and bp.active
      and bp.semantics = 'FROM_MINIMUM' and bp.valid_from <= p_at and (bp.valid_until is null or bp.valid_until > p_at)
    union all
    select t.minimum_units, t.discount_bps
    from public.organization_quantity_discount_tiers t
    where p_branch_id is null and t.organization_id = p_organization_id
  ) x;
$$;
revoke all on function app_private.signage_bulk_tiers(uuid, uuid, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Resolvedor ÚNICO de hechos comerciales
-- ---------------------------------------------------------------------------------------------
-- p_entries: [{"slide_id","entry_id","kind":"PRODUCT"|"PROMOTION","ord","product_ref","promotion_id"}]: qué mostrar y en qué orden.
-- Devuelve un arreglo json con los HECHOS de cada uno (precio de lista vigente de la sucursal, regla «llevando N», tramos de peso, la
-- promoción, la foto) y, si no se puede mostrar, el motivo. p_admin = false (televisor): sólo los disponibles y lo mínimo imprescindible.
-- Los cálculos de la oferta NO viven acá: los hace el motor de TypeScript (D-072).
create function app_private.signage_resolve_entries(
  p_organization_id uuid,
  p_branch_id uuid,
  p_entries jsonb,
  p_admin boolean,
  p_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bulk_minimum integer;
  v_bulk_bps integer;
  v_bulk_tiers jsonb := app_private.signage_bulk_tiers(p_organization_id, p_branch_id, p_at);
  v_slides jsonb;
begin
  -- «Llevando N unidades» (sólo productos UNIT): el escalón más bajo vigente de la sucursal (la que lee el POS) o, sin sucursal, el de la
  -- configuración global de la organización.
  if p_branch_id is not null then
    select bp.minimum_units, bp.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.branch_promotions bp
    where bp.organization_id = p_organization_id and bp.branch_id = p_branch_id and bp.active
      and bp.semantics = 'FROM_MINIMUM' and bp.valid_from <= p_at and (bp.valid_until is null or bp.valid_until > p_at)
    order by bp.minimum_units, bp.valid_from desc, bp.id
    limit 1;
  else
    select t.minimum_units, t.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.organization_quantity_discount_tiers t where t.organization_id = p_organization_id
    order by t.minimum_units limit 1;
  end if;

  select coalesce(jsonb_agg(
    case when p_admin then
      jsonb_build_object(
        'slideId', r.slide_id, 'entryId', r.entry_id, 'kind', r.kind, 'position', r.ord, 'productId', r.product_id, 'name', r.name, 'sku', r.sku,
        'unitType', r.unit_type, 'photo', r.photo, 'available', r.reason is null, 'unavailableReason', r.reason,
        'listPriceCents', r.price_cents::text,
        'bulkMinimumUnits', case when r.unit_type = 'UNIT' then v_bulk_minimum end,
        'bulkDiscountBps', case when r.unit_type = 'UNIT' then v_bulk_bps end,
        'bulkTiers', case when r.unit_type = 'UNIT' then v_bulk_tiers end,
        'packSizeUnits', case when r.unit_type = 'UNIT' then r.pack_size_units end,
        'packDiscountBps', case when r.unit_type = 'UNIT' then r.pack_discount_bps end,
        'weightTiers', r.weight_tiers, 'promotion', r.promotion)
    else
      jsonb_build_object(
        'slideId', r.slide_id, 'kind', r.kind, 'name', r.name, 'unitType', r.unit_type, 'photo', r.photo, 'listPriceCents', r.price_cents::text,
        'bulkMinimumUnits', case when r.unit_type = 'UNIT' then v_bulk_minimum end,
        'bulkDiscountBps', case when r.unit_type = 'UNIT' then v_bulk_bps end,
        'bulkTiers', case when r.unit_type = 'UNIT' then v_bulk_tiers end,
        'packSizeUnits', case when r.unit_type = 'UNIT' then r.pack_size_units end,
        'packDiscountBps', case when r.unit_type = 'UNIT' then r.pack_discount_bps end,
        'weightTiers', r.weight_tiers, 'promotion', r.promotion)
    end
    order by r.ord, r.slide_id
  ), '[]'::jsonb)
  into v_slides
  from (
    select base.slide_id, base.entry_id, base.kind, base.ord, p.id as product_id, p.name, p.sku, p.unit_type, price.price_cents,
      p.pack_size_units, p.pack_discount_bps,
      (select jsonb_build_object('storagePath', a.storage_path, 'contentType', a.content_type, 'hasAlpha', a.has_alpha)
         from public.product_artwork_photos a where a.product_id = p.id and a.organization_id = p.organization_id) as photo,
      case
        when base.kind = 'PROMOTION' and ps.st = 'EXPIRED' then 'PROMO_EXPIRED'
        when base.kind = 'PROMOTION' and ps.st = 'UPCOMING' then 'PROMO_UPCOMING'
        when not (p.active and c.active is true and p.inventory_role in ('SELLABLE', 'BOTH')) then 'INACTIVE'
        -- Una promoción de OTRA sucursal (o de una sucursal cuando la pantalla es global) nunca se muestra: se decide por ids.
        when base.kind = 'PROMOTION' and w.branch_id is not null and w.branch_id is distinct from p_branch_id then 'NOT_IN_BRANCH'
        when p_branch_id is not null and not exists (
          select 1 from public.branch_product_assortment a
          where a.branch_id = p_branch_id and a.product_id = p.id and a.organization_id = p.organization_id
        ) then 'NOT_IN_BRANCH'
        when coalesce(price.price_cents, 0) <= 0 then 'NO_PRICE'
      end as reason,
      case when base.kind = 'PRODUCT' and p.unit_type = 'WEIGHT' then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id, 'minimumGrams', t.minimum_grams, 'discountType', t.discount_type, 'discountValue', t.discount_value::text
        ) order by t.minimum_grams, (t.branch_id is null))
        from public.product_weight_discounts t
        where t.organization_id = p_organization_id and t.product_id = p.id and t.active
          and t.promotion_mode = 'THRESHOLD' and t.minimum_grams is not null
          and t.valid_from <= p_at and (t.valid_until is null or t.valid_until > p_at)
          and (t.branch_id is null or t.branch_id = p_branch_id)
      ), '[]'::jsonb) else '[]'::jsonb end as weight_tiers,
      case when base.kind = 'PROMOTION' then jsonb_build_object(
        'promotionId', w.id, 'mode', w.promotion_mode, 'status', ps.st, 'active', w.active, 'branchId', w.branch_id,
        'validFrom', w.valid_from, 'validUntil', w.valid_until,
        'minimumGrams', w.minimum_grams, 'discountType', w.discount_type, 'discountValue', w.discount_value::text,
        'packQuantityGrams', w.pack_quantity_grams, 'packQuantityUnits', w.pack_quantity_units, 'packPriceCents', w.pack_price_cents::text
      ) end as promotion
    from jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb)) as base(slide_id uuid, entry_id uuid, kind text, ord integer, product_ref uuid, promotion_id uuid)
    left join public.product_weight_discounts w on base.kind = 'PROMOTION' and w.id = base.promotion_id and w.organization_id = p_organization_id
    join public.products p on p.organization_id = p_organization_id and p.id = case when base.kind = 'PRODUCT' then base.product_ref else w.product_id end
    left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    cross join lateral (select app_private.signage_promotion_status(w.active, w.valid_from, w.valid_until, p_at) as st) ps
    -- Mismo orden que el POS (`pull_pos_state`): el precio de la sucursal vigente gana sobre el global vigente.
    left join lateral (
      select pp.price_cents
      from public.product_prices pp
      where pp.organization_id = p.organization_id and pp.product_id = p.id
        and (pp.branch_id = p_branch_id or pp.branch_id is null)
        and pp.valid_from <= p_at and (pp.valid_to is null or pp.valid_to > p_at)
      order by (pp.branch_id = p_branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) price on true
  ) r
  where p_admin or r.reason is null;

  return v_slides;
end;
$$;
revoke all on function app_private.signage_resolve_entries(uuid, uuid, jsonb, boolean, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Qué reproduce una pantalla según su fuente
-- ---------------------------------------------------------------------------------------------
-- ALL_PROMOTIONS: todas las promociones ACTIVAS (activas y dentro de su vigencia) que le aplican a la pantalla: globales o de SU sucursal y
--   de productos de su surtido. Una pantalla sin sucursal sólo toma las globales. Orden estable por nombre de producto. Tope de 100.
-- FOLDER:         los elementos de la carpeta, en su orden (la vigencia/estado de cada uno lo decide el resolvedor).
-- MANUAL:         la lista anterior (productos, promociones y grupos), con las promociones repetidas una sola vez.
create function app_private.signage_display_entries(p_display_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.digital_signage_displays%rowtype;
  at_time timestamptz := now();
  v_result jsonb;
  v_tiers jsonb;
begin
  select * into d from public.digital_signage_displays where id = p_display_id;
  if not found then return '[]'::jsonb; end if;
  v_tiers := app_private.signage_bulk_tiers(d.organization_id, d.branch_id, at_time);

  if d.content_source = 'ALL_PROMOTIONS' then
    -- Tres fuentes, todas ya existentes (nada se copia ni se crea): (1) promociones explícitas de producto (product_weight_discounts: tramos por
    -- peso y packs por total fijo); (2) productos UNIT con escalón «llevando N» vigente (los de la sucursal, o los globales sin sucursal); (3)
    -- productos UNIT con Pack propio (D-064). (2) y (3) entran como UNA presentación por producto: el motor de TypeScript anuncia la de menor
    -- precio por unidad (no una pantalla por escalón). Un producto con promoción explícita no se repite como producto.
    select coalesce(jsonb_agg(jsonb_build_object(
      'slide_id', x.ref_id, 'entry_id', x.ref_id, 'kind', x.kind, 'ord', x.ord,
      'product_ref', case when x.kind = 'PRODUCT' then x.ref_id end, 'promotion_id', case when x.kind = 'PROMOTION' then x.ref_id end
    ) order by x.ord), '[]'::jsonb)
    into v_result
    from (
      select u.ref_id, u.kind, (row_number() over (order by u.name, u.ref_id))::integer as ord
      from (
        select w.id as ref_id, 'PROMOTION'::text as kind, p.name
        from public.product_weight_discounts w
        join public.products p on p.id = w.product_id and p.organization_id = w.organization_id
        where w.organization_id = d.organization_id
          and app_private.signage_promotion_status(w.active, w.valid_from, w.valid_until, at_time) = 'ACTIVE'
          and (w.branch_id is null or w.branch_id = d.branch_id)
          and (d.branch_id is null or exists (
            select 1 from public.branch_product_assortment a
            where a.branch_id = d.branch_id and a.product_id = p.id and a.organization_id = p.organization_id
          ))
        union all
        select p.id, 'PRODUCT', p.name
        from public.products p
        where p.organization_id = d.organization_id and p.active and p.unit_type = 'UNIT'
          and (jsonb_array_length(v_tiers) > 0 or (p.pack_size_units is not null and coalesce(p.pack_discount_bps, 0) > 0))
          and exists (
            select 1 from public.product_prices pp
            where pp.organization_id = p.organization_id and pp.product_id = p.id and (pp.branch_id = d.branch_id or pp.branch_id is null)
              and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time) and pp.price_cents > 0
          )
          and (d.branch_id is null or exists (
            select 1 from public.branch_product_assortment a
            where a.branch_id = d.branch_id and a.product_id = p.id and a.organization_id = p.organization_id
          ))
          and not exists (
            select 1 from public.product_weight_discounts w
            where w.product_id = p.id and w.organization_id = p.organization_id
              and app_private.signage_promotion_status(w.active, w.valid_from, w.valid_until, at_time) = 'ACTIVE'
              and (w.branch_id is null or w.branch_id = d.branch_id)
          )
      ) u
      order by u.name, u.ref_id
      limit 100
    ) x;
    return v_result;
  end if;

  if d.content_source = 'FOLDER' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'slide_id', coalesce(gi.promotion_id, gi.product_id), 'entry_id', gi.id,
      'kind', case when gi.promotion_id is not null then 'PROMOTION' else 'PRODUCT' end,
      'ord', gi.position + 1, 'product_ref', gi.product_id, 'promotion_id', gi.promotion_id
    ) order by gi.position), '[]'::jsonb)
    into v_result
    from public.signage_promotion_group_items gi
    where gi.group_id = d.folder_id and gi.organization_id = d.organization_id;
    return v_result;
  end if;

  -- MANUAL (lista anterior)
  select coalesce(jsonb_agg(jsonb_build_object(
    'slide_id', y.slide_id, 'entry_id', y.entry_id, 'kind', y.kind, 'ord', y.ord, 'product_ref', y.product_ref, 'promotion_id', y.promotion_id
  ) order by y.ord), '[]'::jsonb)
  into v_result
  from (
    select z.*, (row_number() over (order by z.pos, z.sub))::integer as ord
    from (
      select u.*, row_number() over (partition by u.kind, coalesce(u.promotion_id, u.product_ref) order by u.pos, u.sub) as rn
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
        where s.display_id = d.id and s.kind = 'GROUP' and gi.promotion_id is not null
        union all
        select gi.product_id, s.id, s.position, gi.position + 1, 'PRODUCT', gi.product_id, null::uuid
        from public.digital_signage_slides s
        join public.signage_promotion_group_items gi on gi.group_id = s.group_id and gi.organization_id = s.organization_id
        where s.display_id = d.id and s.kind = 'GROUP' and gi.product_id is not null
      ) u
    ) z
    where z.rn = 1
  ) y;
  return v_result;
end;
$$;
revoke all on function app_private.signage_display_entries(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Hechos de la pantalla (reemplaza el cuerpo de 202610190082; misma firma)
-- ---------------------------------------------------------------------------------------------
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
  v_folder_name text;
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

  v_slides := app_private.signage_resolve_entries(d.organization_id, d.branch_id, app_private.signage_display_entries(d.id), p_admin, at_time);

  if p_admin then
    if d.branch_id is not null then
      select b.name into v_branch_name from public.branches b where b.id = d.branch_id;
    end if;
    if d.folder_id is not null then
      select g.name into v_folder_name from public.signage_promotion_groups g where g.id = d.folder_id and g.organization_id = d.organization_id;
    end if;
    -- Sólo la lista anterior tiene «entradas» editables; con las otras fuentes la lista sale de las promociones o de la carpeta.
    select coalesce(jsonb_agg(jsonb_build_object(
      'entryId', s.id, 'position', s.position, 'kind', s.kind, 'productId', s.product_id, 'promotionId', s.promotion_id, 'groupId', s.group_id,
      'groupName', g.name,
      'groupPromotionCount', (select count(*) from public.signage_promotion_group_items gi where gi.group_id = s.group_id)
    ) order by s.position), '[]'::jsonb)
    into v_entries
    from public.digital_signage_slides s
    left join public.signage_promotion_groups g on g.id = s.group_id and g.organization_id = s.organization_id
    where s.display_id = d.id and d.content_source = 'MANUAL';
    return jsonb_build_object(
      'displayId', d.id, 'name', d.name, 'enabled', d.enabled, 'branchId', d.branch_id, 'branchName', v_branch_name,
      'slideDurationSeconds', d.slide_duration_seconds, 'organizationName', v_org_name, 'logo', v_logo, 'tokenRotatedAt', d.token_rotated_at,
      'contentSource', d.content_source, 'folderId', d.folder_id, 'folderName', v_folder_name,
      'status', case when d.enabled then 'ACTIVE' else 'DISABLED' end, 'entries', v_entries, 'slides', v_slides);
  end if;
  return jsonb_build_object('status', 'ACTIVE', 'slideDurationSeconds', d.slide_duration_seconds,
    'organizationName', v_org_name, 'logo', v_logo, 'slides', v_slides);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Lectura de Storage del televisor (anon): sólo la foto de lo que una pantalla habilitada reproduce HOY
-- ---------------------------------------------------------------------------------------------
-- Se parte del objeto pedido (por su ruta) y se comprueba que alguna pantalla HABILITADA de su organización lo incluya en SU lista
-- actual (según su fuente): nunca una foto cualquiera de la organización. El logo de la organización se publica mientras haya una
-- pantalla habilitada.
create or replace function public.signage_object_is_published(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_name is not null and (
    exists (
      select 1 from public.organization_artwork_logos l
      where l.storage_path = p_name
        and exists (select 1 from public.digital_signage_displays d where d.organization_id = l.organization_id and d.enabled)
    )
    or exists (
      select 1
      from public.product_artwork_photos a
      join public.digital_signage_displays d on d.organization_id = a.organization_id and d.enabled
      where a.storage_path = p_name
        and exists (
          select 1
          from jsonb_to_recordset(app_private.signage_display_entries(d.id)) as e(product_ref uuid, promotion_id uuid)
          left join public.product_weight_discounts w on w.id = e.promotion_id and w.organization_id = d.organization_id
          where coalesce(e.product_ref, w.product_id) = a.product_id
        )
    )
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Hechos del producto para una pieza (get_product_artwork de 202610180081 + datos del pack)
-- ---------------------------------------------------------------------------------------------
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
  v_bulk_tiers jsonb := app_private.signage_bulk_tiers(current_organization_id, p_branch_id, at_time);
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
    'bulkTiers', case when p.unit_type = 'UNIT' then v_bulk_tiers end,
    'packSizeUnits', case when p.unit_type = 'UNIT' then p.pack_size_units end,
    'packDiscountBps', case when p.unit_type = 'UNIT' then p.pack_discount_bps end,
    'weightTiers', r.weight_tiers,
    'organizationName', v_org_name, 'branchId', p_branch_id, 'branchName', v_branch_name, 'branchAddress', v_branch_address,
    'photo', (
      select jsonb_build_object('storagePath', a.storage_path, 'contentType', a.content_type, 'sizeBytes', a.size_bytes, 'hasAlpha', a.has_alpha)
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

-- ---------------------------------------------------------------------------------------------
-- 8. Elegir la fuente de una pantalla
-- ---------------------------------------------------------------------------------------------
-- p_content_source: 'ALL_PROMOTIONS' (todas las promociones activas que le aplican) o 'FOLDER' (+ p_folder_id). La lista anterior ('MANUAL')
-- no se puede volver a elegir; al pasar a otra fuente se descarta (una sola transacción).
create function public.save_signage_display_source(
  p_display_id uuid,
  p_name text,
  p_branch_id uuid,
  p_slide_duration_seconds integer,
  p_enabled boolean,
  p_content_source text,
  p_folder_id uuid default null
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
  v_before jsonb;
  v_dropped integer;
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
  if p_content_source is null or p_content_source not in ('ALL_PROMOTIONS', 'FOLDER') then
    raise exception 'La fuente de contenido tiene que ser todas las promociones activas o una carpeta' using errcode = '22023';
  end if;
  if (p_content_source = 'FOLDER') <> (p_folder_id is not null) then
    raise exception 'Elegí una carpeta para esta fuente (y sólo con esa fuente)' using errcode = '22023';
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
  if p_folder_id is not null and not exists (
    select 1 from public.signage_promotion_groups g where g.id = p_folder_id and g.organization_id = current_organization_id
  ) then
    raise exception 'Folder was not found in this organization' using errcode = '42501';
  end if;

  v_before := jsonb_build_object('name', d.name, 'branch_id', d.branch_id, 'slide_duration_seconds', d.slide_duration_seconds,
    'enabled', d.enabled, 'content_source', d.content_source, 'folder_id', d.folder_id);

  update public.digital_signage_displays
  set name = v_name, branch_id = p_branch_id, slide_duration_seconds = p_slide_duration_seconds, enabled = p_enabled,
      content_source = p_content_source, folder_id = p_folder_id
  where id = d.id;
  delete from public.digital_signage_slides where display_id = d.id;
  get diagnostics v_dropped = row_count;

  perform app_private.write_audit(current_organization_id, p_branch_id, 'DIGITAL_SIGNAGE_DISPLAYS_SOURCE_UPDATE', 'digital_signage_displays', d.id,
    v_before, jsonb_build_object('name', v_name, 'branch_id', p_branch_id, 'slide_duration_seconds', p_slide_duration_seconds,
      'enabled', p_enabled, 'content_source', p_content_source, 'folder_id', p_folder_id, 'manual_entries_dropped', v_dropped));
  return jsonb_build_object('id', d.id, 'contentSource', p_content_source, 'folderId', p_folder_id, 'manualEntriesDropped', v_dropped);
end;
$$;
revoke all on function public.save_signage_display_source(uuid, text, uuid, integer, boolean, text, uuid) from public, anon;
grant execute on function public.save_signage_display_source(uuid, text, uuid, integer, boolean, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 9. Resumen de las pantallas (una sola llamada: nada de una consulta por pantalla)
-- ---------------------------------------------------------------------------------------------
-- Por pantalla: fuente, carpeta, cuántas ofertas se reproducen hoy (`playable`), cuántas no (`blocked`: inactivo, sin precio, vencida…) y
-- cuántas se reproducen sin foto. Usa el MISMO payload que el televisor y la vista previa.
create function public.get_signage_displays_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  v_result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'name', d.name, 'enabled', d.enabled, 'branchId', d.branch_id, 'branchName', b.name,
    'slideDurationSeconds', d.slide_duration_seconds, 'contentSource', d.content_source, 'folderId', d.folder_id, 'folderName', g.name,
    'tokenRotatedAt', d.token_rotated_at,
    'legacyEntries', (select count(*) from public.digital_signage_slides s where s.display_id = d.id),
    'playable', (select count(*) from jsonb_array_elements(pl.payload -> 'slides') s where (s ->> 'available')::boolean),
    'blocked', (select count(*) from jsonb_array_elements(pl.payload -> 'slides') s where not (s ->> 'available')::boolean),
    'withoutPhoto', (select count(*) from jsonb_array_elements(pl.payload -> 'slides') s
                     where (s ->> 'available')::boolean and jsonb_typeof(s -> 'photo') is distinct from 'object')
  ) order by d.created_at, d.id), '[]'::jsonb)
  into v_result
  from public.digital_signage_displays d
  left join public.branches b on b.id = d.branch_id and b.organization_id = d.organization_id
  left join public.signage_promotion_groups g on g.id = d.folder_id and g.organization_id = d.organization_id
  cross join lateral (select app_private.signage_payload(d.id, true) as payload) pl
  where d.organization_id = current_organization_id;
  return v_result;
end;
$$;
revoke all on function public.get_signage_displays_overview() from public, anon;
grant execute on function public.get_signage_displays_overview() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 10. Carpetas: guardar (crear / editar), eliminar, listar y resolver
-- ---------------------------------------------------------------------------------------------
-- p_items: [{"kind":"PROMOTION"|"PRODUCT","id":"<uuid>"}, ...] EN ORDEN (1 a 100). Todo de ESTA organización, sin repetidos. Una sola transacción.
create function public.save_signage_folder(
  p_folder_id uuid,
  p_name text,
  p_items jsonb,
  p_generate_feed boolean,
  p_generate_story boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  v_name text := btrim(coalesce(p_name, ''));
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_count integer;
  v_folder_id uuid;
  v_before jsonb;
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception 'El nombre de la carpeta tiene que tener entre 1 y 80 caracteres' using errcode = '22023';
  end if;
  if p_generate_feed is null or p_generate_story is null or not (p_generate_feed or p_generate_story) then
    raise exception 'Elegí al menos un formato: Feed o Story' using errcode = '22023';
  end if;
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'La lista de la carpeta tiene que ser una lista' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(v_items);
  if v_count not between 1 and 100 then
    raise exception 'Una carpeta necesita entre 1 y 100 elementos' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_items) e
    where jsonb_typeof(e) <> 'object' or (e ->> 'kind') is null or (e ->> 'kind') not in ('PRODUCT', 'PROMOTION')
      or (e ->> 'id') is null or (e ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'La lista de la carpeta tiene elementos inválidos' using errcode = '22023';
  end if;
  if (select count(distinct (e ->> 'kind') || ':' || lower(e ->> 'id')) from jsonb_array_elements(v_items) e) <> v_count then
    raise exception 'La lista de la carpeta tiene elementos repetidos' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(v_items) e join public.product_weight_discounts w on w.id = (e ->> 'id')::uuid and w.organization_id = current_organization_id
        where e ->> 'kind' = 'PROMOTION')
     <> (select count(*) from jsonb_array_elements(v_items) e where e ->> 'kind' = 'PROMOTION') then
    raise exception 'Promotion was not found in this organization' using errcode = '42501';
  end if;
  if (select count(*) from jsonb_array_elements(v_items) e join public.products p on p.id = (e ->> 'id')::uuid and p.organization_id = current_organization_id
        where e ->> 'kind' = 'PRODUCT')
     <> (select count(*) from jsonb_array_elements(v_items) e where e ->> 'kind' = 'PRODUCT') then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.signage_promotion_groups g
    where g.organization_id = current_organization_id and lower(btrim(g.name)) = lower(v_name) and g.id is distinct from p_folder_id
  ) then
    raise exception 'Ya existe una carpeta con el nombre «%»', v_name using errcode = '22023';
  end if;

  if p_folder_id is null then
    insert into public.signage_promotion_groups (organization_id, name, created_by, generate_feed, generate_story)
    values (current_organization_id, v_name, auth.uid(), p_generate_feed, p_generate_story)
    returning id into v_folder_id;
    v_before := null;
  else
    select g.id into v_folder_id from public.signage_promotion_groups g
    where g.id = p_folder_id and g.organization_id = current_organization_id
    for update;
    if not found then
      raise exception 'Folder was not found in this organization' using errcode = '42501';
    end if;
    v_before := jsonb_build_object('name', (select g.name from public.signage_promotion_groups g where g.id = v_folder_id),
      'items', coalesce((select jsonb_agg(jsonb_build_object('kind', case when i.promotion_id is not null then 'PROMOTION' else 'PRODUCT' end,
        'id', coalesce(i.promotion_id, i.product_id)) order by i.position) from public.signage_promotion_group_items i where i.group_id = v_folder_id), '[]'::jsonb));
    update public.signage_promotion_groups set name = v_name, generate_feed = p_generate_feed, generate_story = p_generate_story where id = v_folder_id;
    delete from public.signage_promotion_group_items where group_id = v_folder_id;
  end if;

  insert into public.signage_promotion_group_items (organization_id, group_id, promotion_id, product_id, position)
  select current_organization_id, v_folder_id,
    case when t.value ->> 'kind' = 'PROMOTION' then (t.value ->> 'id')::uuid end,
    case when t.value ->> 'kind' = 'PRODUCT' then (t.value ->> 'id')::uuid end,
    (t.ord - 1)::integer
  from jsonb_array_elements(v_items) with ordinality as t(value, ord);

  perform app_private.write_audit(current_organization_id, null, case when p_folder_id is null then 'SIGNAGE_FOLDER_CREATED' else 'SIGNAGE_FOLDER_UPDATED' end,
    'signage_promotion_groups', v_folder_id, v_before,
    jsonb_build_object('name', v_name, 'items', v_items, 'generate_feed', p_generate_feed, 'generate_story', p_generate_story));
  return jsonb_build_object('id', v_folder_id, 'items', v_count);
end;
$$;
revoke all on function public.save_signage_folder(uuid, text, jsonb, boolean, boolean) from public, anon;
grant execute on function public.save_signage_folder(uuid, text, jsonb, boolean, boolean) to authenticated;

-- Una carpeta que alguna pantalla usa (como fuente o en su lista anterior) NO se elimina: la pantalla perdería contenido sin avisar.
create function public.delete_signage_folder(p_folder_id uuid)
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
  where x.id = p_folder_id and x.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Folder was not found in this organization' using errcode = '42501';
  end if;
  select count(*)::integer, string_agg(u.name, ', ' order by u.name)
  into v_used, v_names
  from (
    select d.name from public.digital_signage_displays d where d.folder_id = g.id and d.organization_id = g.organization_id
    union
    select d.name from public.digital_signage_slides s
    join public.digital_signage_displays d on d.id = s.display_id and d.organization_id = s.organization_id
    where s.group_id = g.id and s.kind = 'GROUP'
  ) u;
  if v_used > 0 then
    raise exception 'La carpeta «%» está en uso en % pantalla(s): %. Cambiá la fuente de esas pantallas antes de eliminarla', g.name, v_used, v_names using errcode = '23503';
  end if;
  delete from public.signage_promotion_groups where id = g.id;
  perform app_private.write_audit(current_organization_id, null, 'SIGNAGE_FOLDER_DELETED', 'signage_promotion_groups', g.id,
    jsonb_build_object('name', g.name), null);
  return jsonb_build_object('id', g.id, 'deleted', true);
end;
$$;
revoke all on function public.delete_signage_folder(uuid) from public, anon;
grant execute on function public.delete_signage_folder(uuid) to authenticated;

-- Carpetas de la organización (sólo referencias): cuántos elementos tiene, formatos y en cuántas pantallas se usa. Una sola llamada.
create function public.get_signage_folders()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  v_result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', g.id, 'name', g.name, 'generateFeed', g.generate_feed, 'generateStory', g.generate_story,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'itemId', i.id, 'kind', case when i.promotion_id is not null then 'PROMOTION' else 'PRODUCT' end, 'id', coalesce(i.promotion_id, i.product_id),
        'name', p.name, 'sku', p.sku, 'unitType', p.unit_type
      ) order by i.position)
      from public.signage_promotion_group_items i
      left join public.product_weight_discounts w on w.id = i.promotion_id and w.organization_id = i.organization_id
      left join public.products p on p.id = coalesce(i.product_id, w.product_id) and p.organization_id = i.organization_id
      where i.group_id = g.id
    ), '[]'::jsonb),
    'usedByDisplays', (
      select count(distinct u.display_id) from (
        select d.id as display_id from public.digital_signage_displays d where d.folder_id = g.id
        union all
        select s.display_id from public.digital_signage_slides s where s.group_id = g.id and s.kind = 'GROUP'
      ) u
    )
  ) order by g.name, g.id), '[]'::jsonb)
  into v_result
  from public.signage_promotion_groups g
  where g.organization_id = current_organization_id;
  return v_result;
end;
$$;
revoke all on function public.get_signage_folders() from public, anon;
grant execute on function public.get_signage_folders() to authenticated;

-- Hechos VIGENTES de los elementos de una carpeta para una sucursal, en UNA llamada (nada de una consulta por promoción/producto).
-- p_item_ids (opcional) limita a esos elementos (lotes de generación). Cada elemento trae el estado de su promoción (vigencia, activa),
-- el motivo si no se puede mostrar (producto inactivo, sin precio, otra sucursal…) y la foto (ruta en el bucket privado).
create function public.get_signage_folder_facts(p_folder_id uuid, p_branch_id uuid default null, p_item_ids uuid[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  g public.signage_promotion_groups%rowtype;
  v_branch_name text;
  v_entries jsonb;
  v_items jsonb;
begin
  select * into g from public.signage_promotion_groups x where x.id = p_folder_id and x.organization_id = current_organization_id;
  if not found then
    return null;
  end if;
  if p_branch_id is not null then
    select b.name into v_branch_name from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id;
    if not found then
      raise exception 'Branch not found' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'slide_id', i.id, 'entry_id', i.id, 'kind', case when i.promotion_id is not null then 'PROMOTION' else 'PRODUCT' end,
    'ord', i.position + 1, 'product_ref', i.product_id, 'promotion_id', i.promotion_id
  ) order by i.position), '[]'::jsonb)
  into v_entries
  from public.signage_promotion_group_items i
  where i.group_id = g.id and i.organization_id = g.organization_id and (p_item_ids is null or i.id = any(p_item_ids));

  v_items := app_private.signage_resolve_entries(current_organization_id, p_branch_id, v_entries, true, now());
  return jsonb_build_object(
    'folderId', g.id, 'name', g.name, 'generateFeed', g.generate_feed, 'generateStory', g.generate_story,
    'branchId', p_branch_id, 'branchName', v_branch_name,
    'itemCount', (select count(*) from public.signage_promotion_group_items i where i.group_id = g.id),
    'items', v_items);
end;
$$;
revoke all on function public.get_signage_folder_facts(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.get_signage_folder_facts(uuid, uuid, uuid[]) to authenticated;

commit;
