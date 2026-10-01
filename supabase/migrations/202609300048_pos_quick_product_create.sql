begin;

-- Alta rápida de producto desde el scanner del POS de Central (almacén).
--
-- Fran escanea un código que el catálogo local no conoce; el POS abre un modal mínimo (nombre,
-- costo opcional, precio) y esta RPC crea TODO en una sola transacción: producto, categoría
-- "Almacen", barcode, surtido (sólo la sucursal del dispositivo), precio y costo. Si cualquier
-- paso falla, la excepción revierte la función completa: nunca queda un producto a medias.
--
-- Por qué no llama a save_product / set_product_price / ...: todas exigen `products.write` /
-- `prices.write` sobre auth.uid(), y auth.uid() en el POS es la cuenta TÉCNICA del dispositivo, no
-- la persona. Dar esos permisos a la cuenta del dispositivo abriría el Admin entero a cualquier
-- caja. Esta RPC es la única vía estrecha: autoriza por (dispositivo activo + operador con PIN
-- vigente + permiso `products.quick_create` del operador + dispositivo = sucursal de Central) y
-- reutiliza los helpers privados que ya comparten el Admin y el importador (slug único, barcode
-- normalizado/único, surtido). Las tablas escritas conservan sus triggers (auditoría, cola de
-- cambios del POS) y la restricción única de barcode sigue siendo la última garantía.

insert into public.permissions (key, description) values
  ('products.quick_create', 'Create a minimal warehouse product from the POS of the central branch')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-4000-8000-000000000001', 'products.quick_create'),
  ('10000000-0000-4000-8000-000000000002', 'products.quick_create')
on conflict (role_id, permission_key) do nothing;

-- Categoría real "Almacen": se asegura UNA vez por organización (nunca una por alta). Si ya existe
-- una categoría con ese nombre (con o sin tilde, activa o no) no se crea otra.
insert into public.categories (organization_id, name, slug, sort_order, active)
select o.id, 'Almacen', app_private.import_unique_slug(o.id, 'categories', 'Almacen'), 0, true
from public.organizations o
where not exists (
  select 1 from public.categories c
  where c.organization_id = o.id and app_private.import_slugify(c.name) = 'almacen'
);

-- Qué sabe hacer este dispositivo (hoy: si es el POS de Central y puede dar de alta productos).
-- "Central" = la sucursal productiva configurada de la organización (D-033,
-- organizations.production_branch_id). Sin esa configuración el alta queda deshabilitada.
create function public.get_pos_device_capabilities(p_device_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_branch uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select d.organization_id, d.branch_id into v_org, v_branch
  from public.pos_devices d
  where d.id = p_device_id and d.status = 'ACTIVE';
  if v_org is null or not app_private.can_access_branch(v_org, v_branch, 'sales.create') then
    raise exception 'Device is not authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'branchId', v_branch,
    'quickProductCreate', exists (
      select 1 from public.organizations o where o.id = v_org and o.production_branch_id = v_branch
    )
  );
end;
$$;

-- Forma exacta de una fila del catálogo del POS (misma que pull_pos_state) para UN producto de UNA
-- sucursal. null si hoy no es vendible ahí (inactivo, sin precio vigente, categoría inactiva o no
-- habilitado en la sucursal).
create function app_private.pos_catalog_product_json(
  p_organization_id uuid,
  p_branch_id uuid,
  p_product_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'organizationId', p.organization_id, 'branchId', b.id, 'branchName', b.name,
    'branchActive', b.active, 'categoryId', c.id, 'categoryName', c.name,
    'categoryColorHex', c.color_hex, 'categorySortOrder', c.sort_order,
    'categoryActive', c.active,
    'categoryIds', coalesce(to_jsonb(assigned.category_ids), jsonb_build_array(c.id)),
    'productId', p.id, 'productName', p.name, 'productSku', p.sku, 'unitType', p.unit_type,
    'productActive', p.active, 'pricePerKgCents', effective_price.price_cents::text,
    'priceValidFrom', effective_price.valid_from,
    'barcodes', coalesce(to_jsonb(codes.barcodes), '[]'::jsonb)
  )
  from public.products p
  join public.branches b on b.id = p_branch_id and b.organization_id = p.organization_id and b.active
  join public.branch_product_assortment a
    on a.product_id = p.id and a.branch_id = b.id and a.organization_id = p.organization_id
  join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id and c.active
  join lateral (
    select pp.price_cents, pp.valid_from
    from public.product_prices pp
    where pp.organization_id = p.organization_id and pp.product_id = p.id
      and (pp.branch_id = b.id or pp.branch_id is null)
      and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
    order by (pp.branch_id = b.id) desc nulls last, pp.valid_from desc
    limit 1
  ) effective_price on true
  left join lateral (
    select array_agg(pca.category_id) as category_ids
    from public.product_category_assignments pca
    join public.categories cc on cc.id = pca.category_id and cc.organization_id = p.organization_id and cc.active
    where pca.product_id = p.id and pca.organization_id = p.organization_id
  ) assigned on true
  left join lateral (
    select array_agg(pb.barcode order by pb.barcode) as barcodes
    from public.product_barcodes pb
    where pb.product_id = p.id and pb.organization_id = p.organization_id
  ) codes on true
  where p.id = p_product_id and p.organization_id = p_organization_id and p.active;
$$;


-- Autorización compartida por las RPC del scanner de Central. Devuelve (organización, sucursal del
-- dispositivo). El permiso lo tiene la PERSONA (operador con PIN), no la cuenta técnica del dispositivo.
create function app_private.pos_scan_authorize(
  p_device_id uuid,
  p_operator_profile_id uuid,
  p_operator_token text
)
returns table (organization_id uuid, branch_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  access record;
begin
  select * into access
  from app_private.resolve_pos_operator(p_device_id, p_operator_profile_id, p_operator_token);

  -- Sólo el POS de Central (sucursal productiva configurada). Fail-closed si no está configurada.
  if not exists (
    select 1 from public.organizations o
    where o.id = access.organization_id and o.production_branch_id = access.branch_id
  ) then
    raise exception 'El alta rápida de productos sólo está habilitada en el POS de la sucursal Central' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.organization_members om
    join public.roles r on r.id = om.role_id
    join public.role_permissions rp on rp.role_id = r.id
    where om.organization_id = access.organization_id and om.profile_id = p_operator_profile_id and om.status = 'ACTIVE'
      and rp.permission_key = 'products.quick_create'
      and (r.organization_id is null or r.organization_id = access.organization_id)
  ) then
    raise exception 'Este operador no puede crear productos' using errcode = '42501';
  end if;

  return query select access.organization_id, access.branch_id;
end;
$$;

-- Un barcode que YA existe en la organización. null si no existe (el llamador decide si crear).
--   EXISTS_SELLABLE  ya se vendía en esta sucursal: se devuelve su fila de catálogo (el catálogo local
--                    estaba desactualizado).
--   EXISTS_ENABLED   producto activo y con precio que todavía no estaba en el surtido de esta sucursal:
--                    se HABILITA acá (sólo esta sucursal) y se devuelve su fila de catálogo.
--   EXISTS_UNSELLABLE  existe pero hoy no es vendible (inactivo, sin precio vigente o categoría
--                    inactiva): no se reactiva ni se habilita.
-- Nunca crea un producto. Serializa por organización (mismo lock que el alta).
create function app_private.pos_resolve_existing_barcode(
  p_organization_id uuid,
  p_branch_id uuid,
  p_operator_profile_id uuid,
  p_device_id uuid,
  p_barcode text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_product_id uuid;
  v_name text;
  v_sellable boolean;
  v_product jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('pos-quick-product:' || p_organization_id::text, 0));

  select pb.product_id, p.name into v_product_id, v_name
  from public.product_barcodes pb
  join public.products p on p.id = pb.product_id and p.organization_id = pb.organization_id
  where pb.organization_id = p_organization_id and pb.barcode = p_barcode;
  if not found then
    return null;
  end if;

  v_product := app_private.pos_catalog_product_json(p_organization_id, p_branch_id, v_product_id);
  if v_product is not null then
    return jsonb_build_object('status', 'EXISTS_SELLABLE', 'product', v_product, 'productName', v_name);
  end if;

  -- No vendible acá todavía: sólo se habilita un producto activo, con categoría activa y precio vigente.
  select p.active and c.active and exists (
    select 1 from public.product_prices pp
    where pp.organization_id = p.organization_id and pp.product_id = p.id
      and (pp.branch_id = p_branch_id or pp.branch_id is null)
      and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
  ) into v_sellable
  from public.products p
  join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
  where p.id = v_product_id;

  if coalesce(v_sellable, false) and not exists (
    select 1 from public.branch_product_assortment a
    where a.organization_id = p_organization_id and a.branch_id = p_branch_id and a.product_id = v_product_id
  ) then
    perform app_private.enable_product_in_branch(p_organization_id, p_branch_id, v_product_id);
    perform app_private.write_audit(
      p_organization_id, p_branch_id, 'POS_QUICK_PRODUCT_ENABLED', 'product', v_product_id, null,
      jsonb_build_object('operatorProfileId', p_operator_profile_id, 'deviceId', p_device_id, 'barcode', p_barcode)
    );
    v_product := app_private.pos_catalog_product_json(p_organization_id, p_branch_id, v_product_id);
    if v_product is not null then
      return jsonb_build_object('status', 'EXISTS_ENABLED', 'product', v_product, 'productName', v_name);
    end if;
  end if;
  return jsonb_build_object('status', 'EXISTS_UNSELLABLE', 'productName', v_name);
end;
$$;

-- Primer paso de un scan desconocido localmente en Central: ¿existe ya ese barcode en la organización?
-- Devuelve jsonb { status, product?, productName? }: NOT_FOUND (el POS abre el modal de alta) o el
-- resultado de pos_resolve_existing_barcode (EXISTS_SELLABLE / EXISTS_ENABLED / EXISTS_UNSELLABLE).
-- Sólo el POS de Central; nunca crea productos.
create function public.resolve_pos_scan_barcode(
  p_device_id uuid,
  p_operator_profile_id uuid,
  p_operator_token text,
  p_barcode text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_branch uuid;
  v_barcode text := app_private.normalize_barcode(p_barcode);
  v_result jsonb;
begin
  select a.organization_id, a.branch_id into v_org, v_branch
  from app_private.pos_scan_authorize(p_device_id, p_operator_profile_id, p_operator_token) a;
  if v_barcode is null or v_barcode !~ '^[A-Z0-9][A-Z0-9._-]{2,63}$' then
    raise exception 'Código de barras inválido' using errcode = '22023';
  end if;
  v_result := app_private.pos_resolve_existing_barcode(v_org, v_branch, p_operator_profile_id, p_device_id, v_barcode);
  return coalesce(v_result, jsonb_build_object('status', 'NOT_FOUND'));
end;
$$;

-- Alta rápida. Devuelve jsonb { status, product?, productName? }:
--   CREATED  producto nuevo creado; `product` = fila de catálogo lista para vender.
--   EXISTS_* el barcode ya existía (ver pos_resolve_existing_barcode): no se crea nada.
-- Idempotente por barcode: repetir la llamada (timeout, reintento) no crea un segundo producto.
create function public.create_pos_quick_product(
  p_device_id uuid,
  p_operator_profile_id uuid,
  p_operator_token text,
  p_barcode text,
  p_name text,
  p_price_cents bigint,
  p_cost_cents bigint default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_branch uuid;
  v_barcode text := app_private.normalize_barcode(p_barcode);
  v_name text := btrim(coalesce(p_name, ''));
  v_existing jsonb;
  v_category_id uuid;
  v_product_id uuid;
  v_product jsonb;
begin
  select a.organization_id, a.branch_id into v_org, v_branch
  from app_private.pos_scan_authorize(p_device_id, p_operator_profile_id, p_operator_token) a;

  if v_barcode is null or v_barcode !~ '^[A-Z0-9][A-Z0-9._-]{2,63}$' then
    raise exception 'Código de barras inválido' using errcode = '22023';
  end if;

  v_existing := app_private.pos_resolve_existing_barcode(v_org, v_branch, p_operator_profile_id, p_device_id, v_barcode);
  if v_existing is not null then
    return v_existing;
  end if;


  if char_length(v_name) not between 1 and 120 then
    raise exception 'El nombre es obligatorio (hasta 120 caracteres)' using errcode = '22023';
  end if;
  if p_price_cents is null or p_price_cents <= 0 then
    raise exception 'El precio de venta debe ser mayor a cero' using errcode = '22023';
  end if;
  if p_cost_cents is not null and p_cost_cents <= 0 then
    raise exception 'El costo debe ser mayor a cero (o dejalo vacío)' using errcode = '22023';
  end if;

  -- Categoría real "Almacen" resuelta acá, por id; la migración la asegura una vez por organización.
  select c.id into v_category_id
  from public.categories c
  where c.organization_id = v_org and c.active and app_private.import_slugify(c.name) = 'almacen'
  order by (c.slug = 'almacen') desc, c.created_at, c.id
  limit 1;
  if v_category_id is null then
    raise exception 'No existe una categoría "Almacen" activa. Pedile al administrador que la active.' using errcode = '22023';
  end if;

  begin
    -- Sin SKU: es opcional en el modelo (el barcode identifica al producto). Rol de inventario
    -- explícito SELLABLE ("Producto de venta"); forma de venta UNIT; activo.
    insert into public.products (organization_id, category_id, name, slug, sku, unit_type, active, inventory_role)
    values (v_org, v_category_id, v_name, app_private.import_unique_slug(v_org, 'products', v_name), null, 'UNIT', true, 'SELLABLE')
    returning id into v_product_id;

    insert into public.product_category_assignments (organization_id, product_id, category_id)
    values (v_org, v_product_id, v_category_id)
    on conflict (product_id, category_id) do nothing;

    perform app_private.add_product_barcodes(v_org, v_product_id, array[v_barcode]);
    -- Sólo la sucursal del dispositivo (Central): Avenida y Janssen no reciben el producto.
    perform app_private.enable_product_in_branch(v_org, v_branch, v_product_id);

    -- Precio global vigente, igual que el alta de Admin (el surtido limita dónde se vende).
    insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from, created_by)
    values (v_org, v_product_id, null, p_price_cents, now(), p_operator_profile_id);
    if p_cost_cents is not null then
      insert into public.product_costs (organization_id, product_id, cost_cents, valid_from, created_by)
      values (v_org, v_product_id, p_cost_cents, now(), p_operator_profile_id);
    end if;
  exception when unique_violation then
    raise exception 'Ya existe un producto con ese código. Volvé a escanearlo.' using errcode = '23505';
  end;

  perform app_private.write_audit(
    v_org, v_branch, 'POS_QUICK_PRODUCT_CREATED', 'product', v_product_id, null,
    jsonb_build_object(
      'operatorProfileId', p_operator_profile_id, 'deviceId', p_device_id, 'barcode', v_barcode,
      'name', v_name, 'priceCents', p_price_cents, 'costCents', p_cost_cents
    )
  );

  v_product := app_private.pos_catalog_product_json(v_org, v_branch, v_product_id);
  if v_product is null then
    raise exception 'El producto no quedó vendible en esta sucursal' using errcode = 'XX000';
  end if;
  return jsonb_build_object('status', 'CREATED', 'product', v_product, 'productName', v_name);
end;
$$;

revoke all on function app_private.pos_catalog_product_json(uuid, uuid, uuid), app_private.pos_scan_authorize(uuid, uuid, text), app_private.pos_resolve_existing_barcode(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.resolve_pos_scan_barcode(uuid, uuid, text, text) from public, anon;
grant execute on function public.resolve_pos_scan_barcode(uuid, uuid, text, text) to authenticated;
revoke all on function public.get_pos_device_capabilities(uuid) from public, anon;
revoke all on function public.create_pos_quick_product(uuid, uuid, text, text, text, bigint, bigint) from public, anon;
grant execute on function public.get_pos_device_capabilities(uuid) to authenticated;
grant execute on function public.create_pos_quick_product(uuid, uuid, text, text, text, bigint, bigint) to authenticated;

commit;
