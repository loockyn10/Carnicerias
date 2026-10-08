begin;

-- Cartelería — pieza «Producto protagonista» (D-074): una FOTO COMERCIAL por producto, en Supabase Storage.
--
--   * Bucket privado `product-artwork` (5 MB, JPG/PNG). Los bytes viven en Storage; en Postgres sólo la referencia.
--   * `product_artwork_photos`  una fila por producto: ruta del objeto + tipo + peso. Sin base64 ni blobs.
--   * Ruta del objeto: `<organization_id>/<product_id>/<uuid>.<ext>`. Las políticas de Storage y los checks de la tabla exigen que la
--     primera carpeta sea una organización en la que el usuario tenga el permiso (`catalog.write` para escribir, `products.read` para leer):
--     una organización nunca ve ni toca el objeto de otra.
--   * `get_product_artwork(producto, sucursal)` entrega los HECHOS de la pieza (precio vigente con la misma precedencia que el POS:
--     precio de la sucursal > global; regla «llevando N»; tramos de peso; foto). La cuenta de la oferta la hace el motor de pricing de
--     TypeScript, igual que en la cartelería de TV (D-072) y las etiquetas (D-073): acá no hay ninguna fórmula de descuento.
--
-- No guarda piezas, textos ni exportaciones: la pieza se calcula en cada lectura y el titular viaja en el pedido.

-- ---------------------------------------------------------------------------------------------
-- 1. Bucket privado
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-artwork', 'product-artwork', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------------------------
-- 2. Tabla de referencia
-- ---------------------------------------------------------------------------------------------
create table public.product_artwork_photos (
  product_id uuid primary key,
  organization_id uuid not null,
  -- `<organization_id>/<product_id>/<uuid>.<ext>` dentro del bucket `product-artwork`.
  storage_path text not null unique,
  content_type text not null check (content_type in ('image/jpeg', 'image/png')),
  size_bytes integer not null check (size_bytes between 1 and 5242880),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete cascade,
  check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$'
    and starts_with(storage_path, organization_id::text || '/' || product_id::text || '/')
  )
);

create trigger product_artwork_photos_set_updated_at before update on public.product_artwork_photos
for each row execute function app_private.set_updated_at();

alter table public.product_artwork_photos enable row level security;
create policy product_artwork_photos_select on public.product_artwork_photos
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));

revoke all on table public.product_artwork_photos from public, anon, authenticated;
grant select on public.product_artwork_photos to authenticated;

comment on table public.product_artwork_photos is
  'Foto comercial (cartelería) de un producto: referencia a un objeto del bucket privado product-artwork. Sin bytes. Se escribe sólo con set/remove_product_artwork_photo.';

-- ---------------------------------------------------------------------------------------------
-- 3. Políticas de Storage (bucket product-artwork)
-- ---------------------------------------------------------------------------------------------
-- Organización a la que pertenece una ruta de objeto: su PRIMERA carpeta, sólo si es un uuid (cualquier otra cosa => NULL => sin acceso).
create function app_private.product_artwork_path_org(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then substr(p_name, 1, 36)::uuid
  end
$$;

revoke all on function app_private.product_artwork_path_org(text) from public, anon;
grant execute on function app_private.product_artwork_path_org(text) to authenticated;

create policy product_artwork_objects_select on storage.objects
for select to authenticated
using (bucket_id = 'product-artwork' and app_private.has_permission(app_private.product_artwork_path_org(name), 'products.read'));

create policy product_artwork_objects_insert on storage.objects
for insert to authenticated
with check (bucket_id = 'product-artwork' and app_private.has_permission(app_private.product_artwork_path_org(name), 'catalog.write'));

create policy product_artwork_objects_delete on storage.objects
for delete to authenticated
using (bucket_id = 'product-artwork' and app_private.has_permission(app_private.product_artwork_path_org(name), 'catalog.write'));

-- ---------------------------------------------------------------------------------------------
-- 4. Escritura (RPC SECURITY DEFINER, permiso catalog.write)
-- ---------------------------------------------------------------------------------------------
-- Registra la foto YA SUBIDA a Storage como la foto comercial del producto. Tipo y peso salen de los metadatos que Storage guardó del
-- objeto (no de lo que diga el navegador). Devuelve la ruta anterior (si había otra) para que el servidor borre ese objeto.
create function public.set_product_artwork_photo(p_product_id uuid, p_storage_path text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  v_product public.products%rowtype;
  v_object storage.objects%rowtype;
  v_type text;
  v_size integer;
  v_previous text;
begin
  select * into v_product from public.products p where p.id = p_product_id and p.organization_id = current_organization_id;
  if not found then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
  if p_storage_path is null
     or not starts_with(p_storage_path, current_organization_id::text || '/' || p_product_id::text || '/')
     or p_storage_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png)$' then
    raise exception 'Ruta de foto inválida' using errcode = '22023';
  end if;

  select * into v_object from storage.objects o where o.bucket_id = 'product-artwork' and o.name = p_storage_path;
  if not found then
    raise exception 'La foto todavía no se subió' using errcode = '22023';
  end if;
  v_type := v_object.metadata ->> 'mimetype';
  v_size := (v_object.metadata ->> 'size')::integer;
  if v_type is null or v_type not in ('image/jpeg', 'image/png') then
    raise exception 'La foto tiene que ser JPG o PNG' using errcode = '22023';
  end if;
  if v_size is null or v_size not between 1 and 5242880 then
    raise exception 'La foto pesa demasiado (máximo 5 MB)' using errcode = '22023';
  end if;
  -- La extensión de la ruta tiene que coincidir con el tipo real del objeto.
  if (v_type = 'image/jpeg' and p_storage_path !~ '\.jpg$') or (v_type = 'image/png' and p_storage_path !~ '\.png$') then
    raise exception 'La extensión de la foto no coincide con su tipo' using errcode = '22023';
  end if;

  select a.storage_path into v_previous from public.product_artwork_photos a where a.product_id = p_product_id for update;
  insert into public.product_artwork_photos (product_id, organization_id, storage_path, content_type, size_bytes, created_by)
  values (p_product_id, current_organization_id, p_storage_path, v_type, v_size, auth.uid())
  on conflict (product_id) do update
  set storage_path = excluded.storage_path, content_type = excluded.content_type, size_bytes = excluded.size_bytes, created_by = excluded.created_by;

  perform app_private.write_audit(current_organization_id, null, 'PRODUCT_ARTWORK_PHOTO_SET', 'product_artwork_photos', p_product_id,
    case when v_previous is null then null else jsonb_build_object('storage_path', v_previous) end,
    jsonb_build_object('storage_path', p_storage_path, 'content_type', v_type, 'size_bytes', v_size));
  return jsonb_build_object('productId', p_product_id, 'previousPath', case when v_previous is distinct from p_storage_path then v_previous end);
end;
$$;

-- Quita la referencia de la foto y devuelve la ruta del objeto para que el servidor lo borre de Storage. Sin foto => removedPath NULL.
create function public.remove_product_artwork_photo(p_product_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  v_path text;
begin
  if not exists (select 1 from public.products p where p.id = p_product_id and p.organization_id = current_organization_id) then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
  delete from public.product_artwork_photos a
  where a.product_id = p_product_id and a.organization_id = current_organization_id
  returning a.storage_path into v_path;
  if v_path is not null then
    perform app_private.write_audit(current_organization_id, null, 'PRODUCT_ARTWORK_PHOTO_REMOVED', 'product_artwork_photos', p_product_id,
      jsonb_build_object('storage_path', v_path), null);
  end if;
  return jsonb_build_object('productId', p_product_id, 'removedPath', v_path);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Lectura (permiso products.read)
-- ---------------------------------------------------------------------------------------------
-- Foto comercial de UN producto de mi organización (NULL = el producto no existe, es de otra organización o no tiene foto).
create function public.get_product_artwork_photo(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
begin
  return (
    select jsonb_build_object('productId', a.product_id, 'storagePath', a.storage_path, 'contentType', a.content_type,
      'sizeBytes', a.size_bytes, 'updatedAt', a.updated_at)
    from public.product_artwork_photos a
    where a.product_id = p_product_id and a.organization_id = current_organization_id
  );
end;
$$;

-- Hechos de la pieza de UN producto para UNA sucursal (NULL = precio general). NULL = el producto no existe o es de otra organización.
-- «Disponible» = producto activo y vendible, categoría activa, en el surtido de la sucursal (si se eligió una) y con precio vigente > 0
-- (precio 0 = «sin precio definido», D-057: una pieza nunca sale a $0). El precio sigue el orden del POS (`pull_pos_state`): el precio de
-- la sucursal vigente gana sobre el global vigente.
create function public.get_product_artwork(p_product_id uuid, p_branch_id uuid default null)
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
    order by bp.valid_from desc, bp.id
    limit 1;
  else
    -- Sin sucursal: la configuración global de la organización (D-068: «desde 3», toda la línea).
    select s.unit_bulk_discount_bps into v_bulk_bps
    from public.organization_pricing_settings s where s.organization_id = current_organization_id;
    if coalesce(v_bulk_bps, 0) > 0 then v_bulk_minimum := 3; else v_bulk_bps := null; end if;
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

-- ---------------------------------------------------------------------------------------------
-- 6. Permisos
-- ---------------------------------------------------------------------------------------------
revoke all on function public.set_product_artwork_photo(uuid, text) from public, anon;
grant execute on function public.set_product_artwork_photo(uuid, text) to authenticated;
revoke all on function public.remove_product_artwork_photo(uuid) from public, anon;
grant execute on function public.remove_product_artwork_photo(uuid) to authenticated;
revoke all on function public.get_product_artwork_photo(uuid) from public, anon;
grant execute on function public.get_product_artwork_photo(uuid) to authenticated;
revoke all on function public.get_product_artwork(uuid, uuid) from public, anon;
grant execute on function public.get_product_artwork(uuid, uuid) to authenticated;

commit;
