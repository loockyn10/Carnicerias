begin;

-- Pollos → «Nombre para lista de precios» (D-102): un nombre comercial opcional por producto de Pollos («Gallina X 20kg») que SÓLO usa la
-- «Lista de precios» PNG. El nombre del producto (catálogo general o el propio de Pollos) no cambia, y ni el POS, ni los pedidos, ni los
-- costos, ni los precios lo leen. Vacío o NULL = la lista usa el nombre original. Los productos existentes quedan en NULL (nada que rellenar).

alter table public.poultry_products
  add column price_list_name text,
  add constraint poultry_products_price_list_name_check check (
    price_list_name is null or (char_length(price_list_name) between 1 and 80 and price_list_name = btrim(price_list_name))
  );
comment on column public.poultry_products.price_list_name is 'Nombre sólo para la lista de precios PNG de Pollos. NULL = se usa el nombre del producto.';

-- Configurar: el nombre para la lista es opcional (null = no cambia, así un Admin anterior que no lo manda no lo borra); texto vacío o sólo
-- espacios = se quita. Se guarda sin espacios sobrantes. El resto queda igual que en la migración 202611170105.
drop function public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean, text);
create function public.save_poultry_product_settings(
  p_poultry_product_id uuid,
  p_sale_unit public.unit_type,
  p_requires_weight boolean default false,
  p_reference_weight_grams integer default null,
  p_active boolean default true,
  p_category text default null,
  p_price_list_name text default null
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
  v_list_name text;
begin
  if p_sale_unit is null then raise exception 'Elegí la modalidad de venta' using errcode = '22023'; end if;
  if p_reference_weight_grams is not null and p_reference_weight_grams <= 0 then raise exception 'El peso de referencia tiene que ser positivo' using errcode = '22023'; end if;
  if p_category is not null then perform app_private.poultry_check_category(p_category); end if;
  if p_price_list_name is not null then
    v_list_name := nullif(regexp_replace(btrim(p_price_list_name), '\s+', ' ', 'g'), '');
    if char_length(v_list_name) > 80 then
      raise exception 'El nombre para la lista de precios puede tener hasta 80 caracteres' using errcode = '22023';
    end if;
  end if;
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
      else app_private.poultry_next_sort_order(v_org, v_category, v_existing.id) end,
    price_list_name = case when p_price_list_name is null then v_existing.price_list_name else v_list_name end
  where id = v_existing.id;
  return v_existing.id;
end;
$$;

-- Tablero de Precios (y la «Lista de precios» PNG): agrega `priceListName`. `name` sigue siendo el nombre original (lo que muestra el Admin).
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
        'category', p.category, 'sortOrder', p.sort_order, 'priceListName', p.price_list_name,
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

revoke all on function public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean, text, text) from public, anon;
grant execute on function public.save_poultry_product_settings(uuid, public.unit_type, boolean, integer, boolean, text, text) to authenticated;

commit;
