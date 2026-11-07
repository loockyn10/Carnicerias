begin;

-- Estación de producción de Envasados (D-092). SOLO LECTURA: dos RPC para la pantalla de la estación. No cambia tablas, no toca el registro de
-- paquetes (`create_vacuum_package` sigue siendo el único que los crea, idempotente por `request_key`) y no modifica ninguna migración anterior.
-- Se apoya en 202611010093 (Envasados) y en 202611070095 (estado de los paquetes, para no contar los anulados).
--
--   1. `list_vacuum_station_products(branch)`: TODOS los cortes habilitados para envasar con el precio/kg vigente de la sucursal, su categoría (un producto
--      tiene una sola: `products.category_id`) y
--      cuántos paquetes de ese corte se envasaron en los últimos 14 días en esa sucursal (para el orden de «frecuentes»). `search_vacuum_products`
--      queda como estaba (tope de 50, sin categorías) y sigue usándola el formulario manual.
--   2. `get_vacuum_station_summary(branch, date)`: paquetes, gramos y último corte del día (en la zona horaria de la organización), sin los anulados.

create function public.list_vacuum_station_products(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  v_at timestamptz := clock_timestamp();
begin
  perform app_private.require_visible_branch(v_org, p_branch_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'productId', r.id, 'name', r.name, 'sku', r.sku, 'shelfLifeDays', r.shelf_life_days, 'plu', r.plu,
      'conservationText', r.conservation_text, 'pricePerKgCents', r.price_cents::text,
      'categoryId', r.category_id, 'categoryName', r.category_name, 'recentPackages', r.recent_packages
    ) order by lower(r.name), r.id)
    from (
      select p.id, p.name, p.sku, s.shelf_life_days, s.plu, s.conservation_text,
        app_private.vacuum_price_per_kg(v_org, p.id, p_branch_id, v_at) as price_cents,
        p.category_id, c.name as category_name,
        (
          select count(*) from public.vacuum_packages x
          where x.organization_id = p.organization_id and x.branch_id = p_branch_id and x.product_id = p.id
            and x.created_at >= v_at - interval '14 days'
        ) as recent_packages
      from public.products p
      join public.product_vacuum_settings s on s.product_id = p.id and s.organization_id = p.organization_id and s.enabled
      left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
      where p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT'
      order by lower(p.name), p.id
      limit 300
    ) r
  ), '[]'::jsonb);
end;
$$;

create function public.get_vacuum_station_summary(p_branch_id uuid, p_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  v_tz text;
  v_day date;
  v_result jsonb;
begin
  perform app_private.require_visible_branch(v_org, p_branch_id);
  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_tz := coalesce(v_tz, 'UTC');
  v_day := coalesce(p_date, (clock_timestamp() at time zone v_tz)::date);
  select jsonb_build_object(
    'date', v_day,
    'packages', count(*),
    'grams', coalesce(sum(x.weight_grams), 0),
    'lastProductName', (array_agg(x.product_name_snapshot order by x.created_at desc, x.id))[1],
    'lastAt', max(x.created_at)
  ) into v_result
  from public.vacuum_packages x
  left join public.vacuum_package_state st on st.package_id = x.id
  where x.organization_id = v_org and x.branch_id = p_branch_id
    and (x.created_at at time zone v_tz)::date = v_day
    and st.status is distinct from 'VOIDED';
  return v_result;
end;
$$;

revoke all on function
  public.list_vacuum_station_products(uuid),
  public.get_vacuum_station_summary(uuid, date)
from public, anon;
grant execute on function
  public.list_vacuum_station_products(uuid),
  public.get_vacuum_station_summary(uuid, date)
to authenticated;

commit;
