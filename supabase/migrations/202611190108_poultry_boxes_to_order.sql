begin;

-- Pollos → «Mercadería a encargar» (D-105): cuántos cajones de cada producto hay que comprarle al proveedor para cumplir los pedidos
-- abiertos. SÓLO LECTURA: una RPC que agrega las líneas de los pedidos ya registrados (sin tablas nuevas, sin copiar datos, sin tocar
-- precios, costos, estados ni historia). Cada consulta lee el estado actual: editar, cancelar, entregar o cambiar la fecha de un pedido
-- se refleja solo, porque no hay nada materializado que sincronizar.
--
-- Reglas:
--   * cuentan los pedidos abiertos (PENDING / PREPARING / READY) y NINGÚN otro (DELIVERED y CANCELLED quedan fuera);
--   * se suman los cajones completos de la línea (`boxes`, entero). No existe entrega parcial en el modelo (un pedido se entrega entero),
--     así que lo pendiente de un pedido abierto es todo lo pedido;
--   * no se descuenta stock (este módulo no lleva existencias);
--   * `delivery_on` null = «sin fecha»: NO se le asigna la fecha de hoy. Un pedido abierto con fecha pasada sigue contando;
--   * mismo aislamiento por sucursal que el resto de Pollos (`branches.read_all` o miembro de la sucursal) y permiso `poultry.read`;
--   * un producto quitado o eliminado de Pollos que todavía tiene pedidos abiertos igual aparece (hay que encargarlo).
--
-- Devuelve las líneas agrupadas por producto y fecha de entrega (el cliente arma las tres vistas: sin fecha, por fecha, total general):
--   { today, lines: [{ productId, name, category, sortOrder, deliveryOn | null, boxes, orders }] }
-- ordenadas por categoría (Pollo primero), número de orden del catálogo de Pollos (D-101), nombre e id, y luego fecha (sin fecha primero).

create function public.get_poultry_boxes_to_order()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_tz text;
  v_today date;
begin
  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_today := (clock_timestamp() at time zone coalesce(v_tz, 'UTC'))::date;

  return jsonb_build_object(
    'today', v_today,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'productId', t.product_id, 'name', t.name, 'category', t.category, 'sortOrder', t.sort_order,
        'deliveryOn', t.delivery_on, 'boxes', t.boxes, 'orders', t.orders
      ) order by (t.category <> 'POLLO'), t.sort_order, lower(t.name), t.product_id, t.delivery_on asc nulls first)
      from (
        select i.product_id, coalesce(pr.name, p.name) as name, p.category, p.sort_order, o.delivery_on,
          sum(i.boxes)::bigint as boxes, count(distinct o.id)::bigint as orders
        from public.poultry_order_items i
        join public.poultry_orders o on o.id = i.order_id and o.organization_id = i.organization_id
        join public.poultry_products p on p.id = i.product_id and p.organization_id = i.organization_id
        left join public.products pr on pr.id = p.product_id and pr.organization_id = p.organization_id
        where o.organization_id = v_org
          and o.status in ('PENDING', 'PREPARING', 'READY')
          and (v_vis is null or o.branch_id = any(v_vis))
        group by i.product_id, coalesce(pr.name, p.name), p.category, p.sort_order, o.delivery_on
      ) t
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_poultry_boxes_to_order() from public, anon;
grant execute on function public.get_poultry_boxes_to_order() to authenticated;

commit;
