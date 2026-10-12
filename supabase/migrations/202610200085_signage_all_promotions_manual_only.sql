begin;

-- Corrige 202610200084 (ya aplicada): «Todas las promociones activas» (content_source = 'ALL_PROMOTIONS') debe reproducir SÓLO las promociones
-- EXPLÍCITAS creadas en el módulo Promociones (public.product_weight_discounts: tramos por peso y packs por total fijo, ej. «12 u por $8.900»).
-- La versión aplicada de signage_display_entries también sumaba productos UNIT por tener escalones globales «llevando N» o Pack de producto:
-- son reglas de pricing del POS, NO contenido promocional elegido, y convertirían el catálogo entero en diapositivas.
--
-- Sólo se recrean funciones (create or replace, misma firma, mismos permisos): sin tablas nuevas ni cambios de pricing, POS u offline.
--   * signage_display_entries: ALL_PROMOTIONS = sólo product_weight_discounts activas, vigentes, de la sucursal (o globales), del surtido.
--   * signage_resolve_entries / signage_bulk_tiers / get_signage_folder_facts: exponen `bulkTiers` (todos los escalones vigentes) sólo como HECHO
--     para anunciar la mejor oferta de un producto agregado a mano a una carpeta o lista; NUNCA hace entrar un producto por sí solo.
-- Es idempotente: sirve igual si la 084 aplicada ya traía alguna de estas definiciones.


create or replace function app_private.signage_bulk_tiers(p_organization_id uuid, p_branch_id uuid, p_at timestamptz)
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

create or replace function app_private.signage_resolve_entries(
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

create or replace function app_private.signage_display_entries(p_display_id uuid)
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
begin
  select * into d from public.digital_signage_displays where id = p_display_id;
  if not found then return '[]'::jsonb; end if;

  if d.content_source = 'ALL_PROMOTIONS' then
    -- Las promociones EXPLÍCITAS creadas en el módulo Promociones (product_weight_discounts: tramos por peso y packs por total fijo, p. ej.
    -- «12 u por $8.900»). Las reglas globales de pricing (escalones «llevando N», Packs de producto) NO son contenido promocional elegido: siguen
    -- funcionando en el POS pero no generan diapositivas por sí solas.
    select coalesce(jsonb_agg(jsonb_build_object(
      'slide_id', x.promotion_id, 'entry_id', x.promotion_id, 'kind', 'PROMOTION', 'ord', x.ord, 'product_ref', null, 'promotion_id', x.promotion_id
    ) order by x.ord), '[]'::jsonb)
    into v_result
    from (
      select w.id as promotion_id, (row_number() over (order by p.name, w.id))::integer as ord
      from public.product_weight_discounts w
      join public.products p on p.id = w.product_id and p.organization_id = w.organization_id
      where w.organization_id = d.organization_id
        and app_private.signage_promotion_status(w.active, w.valid_from, w.valid_until, at_time) = 'ACTIVE'
        and (w.branch_id is null or w.branch_id = d.branch_id)
        and (d.branch_id is null or exists (
          select 1 from public.branch_product_assortment a
          where a.branch_id = d.branch_id and a.product_id = p.id and a.organization_id = p.organization_id
        ))
      order by p.name, w.id
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

create or replace function public.get_signage_folder_facts(p_folder_id uuid, p_branch_id uuid default null, p_item_ids uuid[] default null)
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
