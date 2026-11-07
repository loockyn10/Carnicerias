begin;

-- Pollos reutiliza el catálogo general: `poultry_products` deja de ser un catálogo paralelo y pasa a ser sólo la CONFIGURACIÓN de Pollos de un
-- producto de `products` (modalidad de venta, peso de referencia, activo/inactivo). El nombre/SKU/códigos de barras viven en `products`.
--
-- `poultry_products.name` queda como espejo de sólo lectura (lo sincroniza un trigger desde `products`) para no reescribir las funciones y los
-- snapshots de pedidos que ya lo leen; no es una fuente de verdad ni se edita desde Pollos.
--
-- Filas previas (si la 092 ya se aplicó y se cargaron productos de Pollos): se vinculan por nombre normalizado cuando hay UN solo producto del
-- catálogo con ese nombre; las que no se pueden vincular quedan con product_id nulo (siguen funcionando, sin SKU) hasta que se agreguen de nuevo.

alter table public.poultry_products add column product_id uuid;

update public.poultry_products pp
set product_id = (
  select case when count(*) = 1 then (array_agg(p.id))[1] end
  from public.products p
  where p.organization_id = pp.organization_id
    and app_private.import_normalize_text(p.name) = app_private.import_normalize_text(pp.name)
)
where pp.product_id is null;

alter table public.poultry_products
  add constraint poultry_products_catalog_fk foreign key (product_id, organization_id)
  references public.products(id, organization_id) on delete restrict;
create unique index poultry_products_product_uq on public.poultry_products (product_id) where product_id is not null;
drop index public.poultry_products_org_name_uq;

create function app_private.poultry_sync_product_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.name is distinct from old.name then
    update public.poultry_products set name = new.name where product_id = new.id and organization_id = new.organization_id;
  end if;
  return new;
end;
$$;
create trigger products_poultry_sync_name after update of name on public.products
for each row execute function app_private.poultry_sync_product_name();
revoke all on function app_private.poultry_sync_product_name() from public, anon, authenticated;

drop function public.save_poultry_product(text, public.unit_type, boolean, integer, boolean, uuid);

-- Asocia un producto del catálogo general a Pollos (o lo reactiva si había sido quitado).
create function public.add_poultry_product(
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
    update public.poultry_products set active = true, name = v_product.name, sale_unit = p_sale_unit,
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

-- Configuración de Pollos de un producto ya asociado. Desactivar ("Quitar de Pollos") NO borra nada: pedidos, costos y precios quedan.
create function public.save_poultry_product_settings(
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
  select * into v_existing from public.poultry_products x where x.id = p_poultry_product_id and x.organization_id = v_org for update;
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

-- Búsqueda server-side en el catálogo general (nombre, SKU o código de barras), sólo de la organización y sin traer el catálogo entero.
create function public.search_poultry_candidate_products(p_search text default null, p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_text text := app_private.import_normalize_text(p_search);
  v_pattern text := case when v_text is null then null else '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_code text := app_private.normalize_barcode(p_search);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'productId', r.id, 'name', r.name, 'sku', r.sku, 'unitType', r.unit_type,
      'alreadyAdded', r.added, 'removedFromPoultry', r.removed
    ) order by lower(r.name), r.id)
    from (
      select p.id, p.name, p.sku, p.unit_type,
        exists (select 1 from public.poultry_products x where x.product_id = p.id and x.organization_id = p.organization_id and x.active) as added,
        exists (select 1 from public.poultry_products x where x.product_id = p.id and x.organization_id = p.organization_id and not x.active) as removed
      from public.products p
      where p.organization_id = v_org and p.active
        and (v_pattern is null
          or app_private.import_normalize_text(p.name) like v_pattern escape '\'
          or lower(coalesce(p.sku, '')) like v_pattern escape '\'
          or (v_code is not null and exists (select 1 from public.product_barcodes pb where pb.product_id = p.id and pb.organization_id = p.organization_id and pb.barcode like v_code || '%')))
      order by lower(p.name), p.id
      limit least(greatest(coalesce(p_limit, 20), 1), 30)
    ) r
  ), '[]'::jsonb);
end;
$$;

-- Tablero de Precios: ahora también trae el producto del catálogo (id y SKU).
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
      where p.organization_id = v_org
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function
  public.add_poultry_product(uuid, public.unit_type, boolean, integer),
  public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean),
  public.search_poultry_candidate_products(text, integer)
from public, anon;
grant execute on function
  public.add_poultry_product(uuid, public.unit_type, boolean, integer),
  public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean),
  public.search_poultry_candidate_products(text, integer)
to authenticated;

commit;
