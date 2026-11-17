begin;

-- Pollos → «Eliminar» producto (D-100). `poultry_products` es sólo la configuración de Pollos de un producto del catálogo general
-- (D-089, ajuste 094): eliminar NUNCA toca `products` ni la historia de Pollos (pedidos, costos, precios por lista o por cliente).
--
--   * Sin historia (ningún costo, precio de lista, precio por cliente ni línea de pedido): se borra la fila de configuración (física).
--     El borrado queda en `audit_logs` (POULTRY_PRODUCTS_DELETE con la fila completa).
--   * Con historia: eliminación LÓGICA (`deleted_at` + inactivo). Las FK `on delete restrict` de la historia siguen protegiendo la fila.
--
-- Un producto eliminado no aparece en el tablero de Precios (ni en la «Lista de precios» PNG, que lo lee), ni en Nuevo pedido (inactivo),
-- ni en los precios de la ficha del cliente. Los reportes históricos (pedidos, rentabilidad, resumen) siguen leyendo sus snapshots.
-- Volver a agregarlo desde «+ Agregar producto» lo restaura. «Quitar de Pollos» (desactivar sin eliminar) sigue existiendo.

alter table public.poultry_products add column deleted_at timestamptz;
alter table public.poultry_products add constraint poultry_products_deleted_inactive_check check (deleted_at is null or not active);
comment on column public.poultry_products.deleted_at is 'Eliminado de Pollos con historia (eliminación lógica). Null = visible en el tablero.';

create function public.delete_poultry_product(p_poultry_product_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_row public.poultry_products%rowtype;
begin
  -- El bloqueo de la fila serializa contra altas concurrentes de costos/precios/pedidos (sus FK toman FOR KEY SHARE sobre esta fila).
  select * into v_row from public.poultry_products x
  where x.id = p_poultry_product_id and x.organization_id = v_org and x.deleted_at is null
  for update;
  if not found then raise exception 'Producto de pollos no encontrado' using errcode = '42501'; end if;

  if exists (select 1 from public.poultry_product_costs c where c.product_id = v_row.id)
    or exists (select 1 from public.poultry_price_list_prices x where x.product_id = v_row.id)
    or exists (select 1 from public.poultry_customer_prices x where x.product_id = v_row.id)
    or exists (select 1 from public.poultry_order_items x where x.product_id = v_row.id)
  then
    update public.poultry_products set active = false, deleted_at = clock_timestamp() where id = v_row.id;
    return jsonb_build_object('id', v_row.id, 'mode', 'ARCHIVED');
  end if;

  delete from public.poultry_products where id = v_row.id;
  perform app_private.write_audit(v_org, null, 'POULTRY_PRODUCTS_DELETE', 'poultry_products', v_row.id, to_jsonb(v_row), null);
  return jsonb_build_object('id', v_row.id, 'mode', 'DELETED');
end;
$$;
-- Reactivar desde «+ Agregar producto» también restaura un producto eliminado con historia (vuelve con sus costos y precios vigentes).
create or replace function public.add_poultry_product(
  p_product_id uuid,
  p_sale_unit public.unit_type,
  p_requires_weight boolean default false,
  p_reference_weight_grams integer default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_product public.products%rowtype;
  v_existing public.poultry_products%rowtype;
  v_id uuid;
begin
  if p_sale_unit is null then raise exception 'Elegí la modalidad de venta' using errcode = '22023'; end if;
  if p_reference_weight_grams is not null and p_reference_weight_grams <= 0 then raise exception 'El peso de referencia tiene que ser positivo' using errcode = '22023'; end if;
  select * into v_product from public.products p where p.id = p_product_id and p.organization_id = v_org;
  if not found then raise exception 'Producto no encontrado' using errcode = '42501'; end if;
  if not v_product.active then raise exception 'El producto está inactivo en el catálogo' using errcode = '22023'; end if;

  select * into v_existing from public.poultry_products x where x.product_id = p_product_id and x.organization_id = v_org for update;
  if found then
    if v_existing.active then raise exception 'El producto ya está en Pollos' using errcode = '23505'; end if;
    if v_existing.sale_unit <> p_sale_unit and (
      exists (select 1 from public.poultry_product_costs c where c.product_id = v_existing.id)
      or exists (select 1 from public.poultry_price_list_prices x where x.product_id = v_existing.id)
      or exists (select 1 from public.poultry_customer_prices x where x.product_id = v_existing.id)
      or exists (select 1 from public.poultry_order_items x where x.product_id = v_existing.id)
    ) then
      raise exception 'Este producto ya tiene historia en Pollos: la modalidad de venta no se puede cambiar' using errcode = '22023';
    end if;
    update public.poultry_products set active = true, deleted_at = null, name = v_product.name, sale_unit = p_sale_unit,
      requires_weight = p_sale_unit = 'WEIGHT' or coalesce(p_requires_weight, false), reference_weight_grams = p_reference_weight_grams
    where id = v_existing.id;
    return v_existing.id;
  end if;

  insert into public.poultry_products (organization_id, product_id, name, sale_unit, requires_weight, reference_weight_grams, active)
  values (v_org, p_product_id, v_product.name, p_sale_unit, p_sale_unit = 'WEIGHT' or coalesce(p_requires_weight, false), p_reference_weight_grams, true)
  returning id into v_id;
  return v_id;
end;
$$;

-- Un producto eliminado ya no se configura (sólo se puede volver a agregar).
create or replace function public.save_poultry_product_settings(
  p_poultry_product_id uuid,
  p_sale_unit public.unit_type,
  p_requires_weight boolean default false,
  p_reference_weight_grams integer default null,
  p_active boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_existing public.poultry_products%rowtype;
begin
  if p_sale_unit is null then raise exception 'Elegí la modalidad de venta' using errcode = '22023'; end if;
  if p_reference_weight_grams is not null and p_reference_weight_grams <= 0 then raise exception 'El peso de referencia tiene que ser positivo' using errcode = '22023'; end if;
  select * into v_existing from public.poultry_products x where x.id = p_poultry_product_id and x.organization_id = v_org and x.deleted_at is null for update;
  if not found then raise exception 'Producto de pollos no encontrado' using errcode = '42501'; end if;
  if v_existing.sale_unit <> p_sale_unit and (
    exists (select 1 from public.poultry_product_costs c where c.product_id = v_existing.id)
    or exists (select 1 from public.poultry_price_list_prices x where x.product_id = v_existing.id)
    or exists (select 1 from public.poultry_customer_prices x where x.product_id = v_existing.id)
    or exists (select 1 from public.poultry_order_items x where x.product_id = v_existing.id)
  ) then
    raise exception 'No se puede cambiar la modalidad de un producto con costos, precios o pedidos' using errcode = '22023';
  end if;
  update public.poultry_products set sale_unit = p_sale_unit, requires_weight = p_sale_unit = 'WEIGHT' or coalesce(p_requires_weight, false),
    reference_weight_grams = p_reference_weight_grams, active = coalesce(p_active, true)
  where id = v_existing.id;
  return v_existing.id;
end;
$$;

-- Tablero de Precios (y por lo tanto la «Lista de precios» PNG): los eliminados no aparecen.
create or replace function public.get_poultry_price_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_at timestamptz := clock_timestamp();
begin
  return jsonb_build_object(
    'lists', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'notes', l.notes, 'isDefault', l.is_default, 'active', l.active,
        'customerCount', (select count(*) from public.poultry_customers c where c.price_list_id = l.id and c.active))
        order by l.is_default desc, lower(l.name), l.id)
      from public.poultry_price_lists l where l.organization_id = v_org
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'catalogProductId', p.product_id, 'name', coalesce(pr.name, p.name), 'sku', pr.sku, 'saleUnit', p.sale_unit,
        'requiresWeight', p.requires_weight, 'referenceWeightGrams', p.reference_weight_grams, 'active', p.active,
        'costCents', cost.cost_cents::text, 'costSince', cost.valid_from,
        'prices', coalesce((
          select jsonb_object_agg(lp.price_list_id::text, jsonb_build_object('cents', lp.price_cents::text, 'since', lp.valid_from))
          from public.poultry_price_list_prices lp
          where lp.organization_id = v_org and lp.product_id = p.id and lp.valid_from <= v_at and (lp.valid_to is null or lp.valid_to > v_at)
        ), '{}'::jsonb)
      ) order by p.active desc, lower(coalesce(pr.name, p.name)), p.id)
      from public.poultry_products p
      left join public.products pr on pr.id = p.product_id and pr.organization_id = p.organization_id
      left join lateral (
        select c.cost_cents, c.valid_from from public.poultry_product_costs c
        where c.product_id = p.id and c.valid_from <= v_at and (c.valid_to is null or c.valid_to > v_at)
        order by c.valid_from desc limit 1
      ) cost on true
      where p.organization_id = v_org and p.deleted_at is null
    ), '[]'::jsonb)
  );
end;
$$;

-- Ficha del cliente: los precios que se le aplicarían no listan productos eliminados (sus pedidos y totales históricos no cambian).
create or replace function public.get_poultry_customer_detail(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_at timestamptz := clock_timestamp();
  c public.poultry_customers%rowtype;
  v_list_name text;
  v_totals jsonb;
  v_recent jsonb;
  v_prices jsonb;
begin
  select * into c from public.poultry_customers x where x.id = p_customer_id and x.organization_id = v_org;
  if not found then return null; end if;
  select l.name into v_list_name from public.poultry_price_lists l where l.id = c.price_list_id and l.organization_id = v_org;

  select jsonb_build_object(
    'orders', count(*), 'boxes', coalesce(sum(b.boxes), 0), 'weightGrams', coalesce(sum(b.grams), 0),
    'revenueCents', coalesce(sum(o.revenue_cents), 0)::text, 'costCents', coalesce(sum(o.cost_cents), 0)::text,
    'profitCents', coalesce(sum(o.revenue_cents - o.cost_cents), 0)::text,
    'marginBps', app_private.poultry_margin_bps(coalesce(sum(o.revenue_cents), 0), coalesce(sum(o.cost_cents), 0))
  ) into v_totals
  from public.poultry_orders o
  left join lateral (
    select sum(i.boxes) as boxes, sum(i.actual_weight_grams) as grams from public.poultry_order_items i where i.order_id = o.id
  ) b on true
  where o.organization_id = v_org and o.customer_id = c.id and o.status = 'DELIVERED' and (v_vis is null or o.branch_id = any(v_vis));

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'orderNumber', x.order_number, 'status', x.status, 'orderedOn', x.ordered_on, 'deliveryOn', x.delivery_on,
    'revenueCents', x.revenue_cents::text, 'costCents', x.cost_cents::text, 'boxes', x.boxes
  ) order by x.ordered_on desc, x.order_number desc), '[]'::jsonb) into v_recent
  from (
    select o.id, o.order_number, o.status, o.ordered_on, o.delivery_on, o.revenue_cents, o.cost_cents,
      (select coalesce(sum(i.boxes), 0) from public.poultry_order_items i where i.order_id = o.id) as boxes
    from public.poultry_orders o
    where o.organization_id = v_org and o.customer_id = c.id and (v_vis is null or o.branch_id = any(v_vis))
    order by o.ordered_on desc, o.order_number desc limit 10
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', p.id, 'productName', p.name, 'saleUnit', p.sale_unit, 'active', p.active,
    'specialCents', special.price_cents::text, 'effectiveCents', resolved.price_cents::text, 'source', resolved.source
  ) order by p.active desc, lower(p.name), p.id), '[]'::jsonb) into v_prices
  from public.poultry_products p
  left join lateral (
    select cp.price_cents from public.poultry_customer_prices cp
    where cp.customer_id = c.id and cp.product_id = p.id and cp.valid_from <= v_at and (cp.valid_to is null or cp.valid_to > v_at)
    order by cp.valid_from desc limit 1
  ) special on true
  left join lateral app_private.poultry_resolve_price(v_org, c.id, p.id, v_at) resolved on true
  where p.organization_id = v_org and p.deleted_at is null;

  return jsonb_build_object(
    'customer', jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'address', c.address, 'taxId', c.tax_id, 'notes', c.notes,
      'active', c.active, 'priceListId', c.price_list_id, 'priceListName', v_list_name),
    'totals', v_totals, 'recentOrders', v_recent, 'prices', v_prices
  );
end;
$$;

revoke all on function public.delete_poultry_product(uuid) from public, anon;
grant execute on function public.delete_poultry_product(uuid) to authenticated;

commit;
