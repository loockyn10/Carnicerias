begin;

-- Cartelería TV — misma identidad que las piezas (D-076): el televisor público dibuja las ofertas con la franja verde + LOGO, la FOTO
-- comercial del producto y la pastilla amarilla (los mismos componentes que Piezas). Para eso la pantalla pública necesita las
-- REFERENCIAS de esas imágenes y poder leerlas, y hoy viven en el bucket PRIVADO `product-artwork`.
--
--   * `app_private.signage_payload` (compartida por `get_signage_display` y `get_signage_display_admin`) agrega a cada slide la foto
--     (`photo`: ruta + tipo) y al nivel superior el `logo` (ruta, tipo, medidas) de la organización. Nada de precios ni de otras filas.
--   * Lectura de Storage para el televisor (rol `anon`, sin sesión): SÓLO los objetos que una pantalla HABILITADA muestra hoy (la foto
--     de un producto publicado en ella o el logo de su organización). El navegador del televisor nunca habla con Storage: la ruta
--     `/api/tv/<token>/media/<id>` valida el token, lee esa ruta y devuelve los bytes. El bucket sigue privado; las políticas de la 071
--     (authenticated, por organización) no cambian; no hay escritura anónima.
--
-- Incremental: no edita la 069/071/072; reemplaza la función privada con `create or replace` (misma firma).

-- ---------------------------------------------------------------------------------------------
-- 1. Payload con foto y logo
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
    order by bp.valid_from desc, bp.id
    limit 1;
  else
    select s.unit_bulk_discount_bps into v_bulk_bps
    from public.organization_pricing_settings s where s.organization_id = d.organization_id;
    if coalesce(v_bulk_bps, 0) > 0 then v_bulk_minimum := 3; else v_bulk_bps := null; end if;
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

-- ---------------------------------------------------------------------------------------------
-- 2. Lectura de Storage del televisor (anon) limitada a lo que una pantalla habilitada publica
-- ---------------------------------------------------------------------------------------------
create function public.signage_object_is_published(p_name text)
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
          where s.display_id = d.id and a.storage_path = p_name
        )
        or exists (
          select 1 from public.organization_artwork_logos l where l.organization_id = d.organization_id and l.storage_path = p_name
        )
      )
  )
$$;

revoke all on function public.signage_object_is_published(text) from public, authenticated;
grant execute on function public.signage_object_is_published(text) to anon;

create policy signage_published_objects_select on storage.objects
for select to anon
using (bucket_id = 'product-artwork' and public.signage_object_is_published(name));

commit;
