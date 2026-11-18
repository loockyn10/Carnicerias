begin;

-- Pollos → categoría (POLLO / CONGELADOS) y número de orden manual por producto (D-101). Los dos son configuración de Pollos del producto
-- (`poultry_products`), no del catálogo general. El tablero de Precios y la «Lista de precios» PNG ordenan por categoría (POLLO primero),
-- número de orden, nombre e id. El número es independiente por categoría y NO es único: dos productos con el mismo número se muestran
-- los dos (desempata el nombre). No toca pedidos, costos ni precios.
--
-- Productos existentes: categoría POLLO y números 1..n por organización en el orden en que hoy se ven en el tablero (activos primero,
-- nombre, id; los eliminados al final). El relleno no cuenta como edición: se hace con los triggers de auditoría y `updated_at` apagados.

alter table public.poultry_products
  add column category text not null default 'POLLO',
  add column sort_order integer;

alter table public.poultry_products disable trigger poultry_products_set_updated_at;
alter table public.poultry_products disable trigger poultry_products_audit;
with ranked as (
  select p.id, row_number() over (
    partition by p.organization_id
    order by (p.deleted_at is not null), p.active desc, lower(coalesce(pr.name, p.name)), p.id
  ) as n
  from public.poultry_products p
  left join public.products pr on pr.id = p.product_id and pr.organization_id = p.organization_id
)
update public.poultry_products p set sort_order = least(r.n, 99999)::integer from ranked r where r.id = p.id;
alter table public.poultry_products enable trigger poultry_products_set_updated_at;
alter table public.poultry_products enable trigger poultry_products_audit;

alter table public.poultry_products
  alter column sort_order set not null,
  add constraint poultry_products_category_check check (category in ('POLLO', 'CONGELADOS')),
  add constraint poultry_products_sort_order_check check (sort_order between 1 and 99999);
create index poultry_products_org_category_order_idx on public.poultry_products (organization_id, category, sort_order);
comment on column public.poultry_products.category is 'Categoría de Pollos: POLLO o CONGELADOS (secciones de la lista de precios).';
comment on column public.poultry_products.sort_order is 'Posición manual dentro de la categoría (1 = primero). No es única: desempata el nombre.';

-- Siguiente número libre al final de una categoría (sin contar eliminados ni el propio producto).
create function app_private.poultry_next_sort_order(p_organization_id uuid, p_category text, p_exclude uuid default null)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select least(coalesce(max(x.sort_order), 0) + 1, 99999)::integer
  from public.poultry_products x
  where x.organization_id = p_organization_id and x.category = p_category and x.deleted_at is null
    and (p_exclude is null or x.id <> p_exclude);
$$;
revoke all on function app_private.poultry_next_sort_order(uuid, text, uuid) from public, anon, authenticated;

create function app_private.poultry_check_category(p_category text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_category is null or p_category not in ('POLLO', 'CONGELADOS') then
    raise exception 'Elegí la categoría: Pollo o Congelados' using errcode = '22023';
  end if;
  return p_category;
end;
$$;
revoke all on function app_private.poultry_check_category(text) from public, anon, authenticated;

-- Alta: con categoría; el producto entra al final de su categoría. Al reactivar uno quitado conserva su lugar si sigue en la misma
-- categoría; si cambia de categoría o vuelve después de eliminado, pasa al final de la categoría elegida.
drop function public.add_poultry_product(uuid, public.unit_type, boolean, integer);
create function public.add_poultry_product(
  p_product_id uuid,
  p_sale_unit public.unit_type,
  p_requires_weight boolean default false,
  p_reference_weight_grams integer default null,
  p_category text default 'POLLO'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_category text := app_private.poultry_check_category(p_category);
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
      requires_weight = p_sale_unit = 'WEIGHT' or coalesce(p_requires_weight, false), reference_weight_grams = p_reference_weight_grams,
      category = v_category,
      sort_order = case when v_existing.deleted_at is null and v_existing.category = v_category then v_existing.sort_order
        else app_private.poultry_next_sort_order(v_org, v_category, v_existing.id) end
    where id = v_existing.id;
    return v_existing.id;
  end if;

  insert into public.poultry_products (organization_id, product_id, name, sale_unit, requires_weight, reference_weight_grams, active, category, sort_order)
  values (v_org, p_product_id, v_product.name, p_sale_unit, p_sale_unit = 'WEIGHT' or coalesce(p_requires_weight, false), p_reference_weight_grams, true,
    v_category, app_private.poultry_next_sort_order(v_org, v_category))
  returning id into v_id;
  return v_id;
end;
$$;

-- Configuración: la categoría es opcional (null = no cambia). Si cambia, el producto pasa al final de la nueva categoría.
drop function public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean);
create function public.save_poultry_product_settings(
  p_poultry_product_id uuid,
  p_sale_unit public.unit_type,
  p_requires_weight boolean default false,
  p_reference_weight_grams integer default null,
  p_active boolean default true,
  p_category text default null
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
  v_category text;
begin
  if p_sale_unit is null then raise exception 'Elegí la modalidad de venta' using errcode = '22023'; end if;
  if p_reference_weight_grams is not null and p_reference_weight_grams <= 0 then raise exception 'El peso de referencia tiene que ser positivo' using errcode = '22023'; end if;
  if p_category is not null then perform app_private.poultry_check_category(p_category); end if;
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
  v_category := coalesce(p_category, v_existing.category);
  update public.poultry_products set sale_unit = p_sale_unit, requires_weight = p_sale_unit = 'WEIGHT' or coalesce(p_requires_weight, false),
    reference_weight_grams = p_reference_weight_grams, active = coalesce(p_active, true),
    category = v_category,
    sort_order = case when v_category = v_existing.category then v_existing.sort_order
      else app_private.poultry_next_sort_order(v_org, v_category, v_existing.id) end
  where id = v_existing.id;
  return v_existing.id;
end;
$$;

-- Número de orden editado desde el listado. Entero de 1 a 99999; repetirlo no es error.
create function public.set_poultry_product_sort_order(p_poultry_product_id uuid, p_sort_order integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_existing public.poultry_products%rowtype;
begin
  if p_sort_order is null or p_sort_order < 1 or p_sort_order > 99999 then
    raise exception 'El orden tiene que ser un número entero entre 1 y 99999' using errcode = '22023';
  end if;
  select * into v_existing from public.poultry_products x where x.id = p_poultry_product_id and x.organization_id = v_org and x.deleted_at is null for update;
  if not found then raise exception 'Producto de pollos no encontrado' using errcode = '42501'; end if;
  if v_existing.sort_order <> p_sort_order then
    update public.poultry_products set sort_order = p_sort_order where id = v_existing.id;
  end if;
  return jsonb_build_object('id', v_existing.id, 'category', v_existing.category, 'sortOrder', p_sort_order);
end;
$$;

-- Tablero de Precios (y la «Lista de precios» PNG, que lo lee completo, sin límite ni paginación): categoría y orden manual.
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
        'category', p.category, 'sortOrder', p.sort_order,
        'costCents', cost.cost_cents::text, 'costSince', cost.valid_from,
        'prices', coalesce((
          select jsonb_object_agg(lp.price_list_id::text, jsonb_build_object('cents', lp.price_cents::text, 'since', lp.valid_from))
          from public.poultry_price_list_prices lp
          where lp.organization_id = v_org and lp.product_id = p.id and lp.valid_from <= v_at and (lp.valid_to is null or lp.valid_to > v_at)
        ), '{}'::jsonb)
      ) order by (p.category <> 'POLLO'), p.sort_order, lower(coalesce(pr.name, p.name)), p.id)
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

revoke all on function
  public.add_poultry_product(uuid, public.unit_type, boolean, integer, text),
  public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean, text),
  public.set_poultry_product_sort_order(uuid, integer)
from public, anon;
grant execute on function
  public.add_poultry_product(uuid, public.unit_type, boolean, integer, text),
  public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean, text),
  public.set_poultry_product_sort_order(uuid, integer)
to authenticated;

commit;
