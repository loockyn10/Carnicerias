begin;

-- Desactivación masiva de productos desde Admin (selección múltiple en /admin/products).
--
-- NO es un mecanismo nuevo de "eliminación": es exactamente la misma semántica que ya usa la acción
-- individual (`save_product(... p_active => false)`, D-005 "desactivar, no borrar historia"), aplicada a
-- varios productos en UNA llamada y UNA transacción en vez de N requests. Sólo escribe `products.active`:
-- no borra filas ni toca precios, costos, stock/movimientos, ventas, compras, códigos de barras,
-- proveedores, promociones ni asignaciones de sucursal. Los triggers por fila de `products` siguen
-- corriendo igual que en la desactivación individual (auditoría `products_audit`, log de cambios del POS
-- `products_log_pos_change`, `updated_at`), así que el POS recibe cada baja por su sync normal.
--
-- Mismo permiso (`products.write`) y mismo aislamiento por organización que `save_product`. Atómica:
-- si algún id no pertenece a la organización no se desactiva ninguno. Idempotente: un producto que ya
-- estaba inactivo no se toca (no genera auditoría ni cambio de sync) y se informa aparte.

create function public.deactivate_products(p_product_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  requested_ids uuid[];
  existing_count integer;
  deactivated_count integer;
begin
  if p_product_ids is null or cardinality(p_product_ids) not between 1 and 500
     or exists (select 1 from unnest(p_product_ids) as requested(id) where requested.id is null) then
    raise exception 'Debe enviar entre 1 y 500 productos' using errcode = '22023';
  end if;

  select array_agg(distinct requested.id) into requested_ids from unnest(p_product_ids) as requested(id);

  select count(*) into existing_count from public.products p
  where p.id = any (requested_ids) and p.organization_id = current_organization_id;
  if existing_count <> cardinality(requested_ids) then
    raise exception 'Uno de los productos no existe en esta organización' using errcode = '42501';
  end if;

  with updated as (
    update public.products p set active = false
    where p.id = any (requested_ids) and p.organization_id = current_organization_id and p.active
    returning p.id
  )
  select count(*) into deactivated_count from updated;

  return jsonb_build_object(
    'requested', cardinality(requested_ids),
    'deactivated', deactivated_count,
    'alreadyInactive', cardinality(requested_ids) - deactivated_count
  );
end;
$$;

revoke all on function public.deactivate_products(uuid[]) from public, anon;
grant execute on function public.deactivate_products(uuid[]) to authenticated;

comment on function public.deactivate_products(uuid[]) is
  'Desactivación masiva (products.active = false) con la semántica de save_product(p_active => false): atómica, por organización, sin DELETE ni cambios de historial. Devuelve {requested, deactivated, alreadyInactive}.';

commit;
