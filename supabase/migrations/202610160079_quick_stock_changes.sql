begin;

-- Stock rápido desde el celular (D-081). Complementa record_stock_operation (202609100007, ya aplicada): NO se edita ni se reemplaza.
--
--   Fran carga varios cambios de stock de una vez («Pata muslo +15 kg, Molida +8 kg, Costilla −2 kg…», a veces de dos sucursales) y los
--   guarda con UN toque. Esta migración agrega UNA tabla de idempotencia y UNA RPC que reutiliza record_stock_operation (el único flujo
--   canónico del ledger stock_movements). No hay un segundo mecanismo de stock, no se fija el stock directamente y no se toca ninguna
--   fórmula de reposición, precio ni «qué llevar».
--
--   public.apply_quick_stock_changes(p_request_key, p_items): items = [{branchId, productId, mode, quantity | physicalQuantity,
--   expectedSystemQuantity?}] con mode:
--     ADD     quantity > 0 → ingreso (PURCHASE): SUMA al ledger, nunca fija el stock.
--     REMOVE  quantity > 0 → baja: el servidor calcula «stock actual − quantity» BAJO EL MISMO LOCK por producto/sucursal y la registra como
--                            ajuste (ADJUSTMENT_NEGATIVE). Es una corrección de inventario, NO una merma (no ensucia el reporte de mermas).
--                            Si el stock actual es menor a lo que se quiere quitar, ese producto falla (INSUFFICIENT_STOCK): nunca deja stock negativo.
--     COUNT   physicalQuantity >= 0 → conteo físico: el ajuste (ADJUSTMENT_POSITIVE/NEGATIVE) lleva el stock al valor contado y el ledger conserva
--                            «stock anterior», «conteo» y «diferencia» (stock_operation_items.system_quantity_before_grams / physical_quantity_grams).
--                            Con expectedSystemQuantity, si el stock del sistema cambió desde que se mostró la pantalla (una venta, una
--                            transferencia) ese producto NO se ajusta (STOCK_CHANGED): la diferencia que el usuario confirmó ya no sería la real.
--   Cantidades crudas del ledger: gramos para WEIGHT, unidades enteras para UNIT.
--
--   Resultado PARCIAL y seguro: cada producto se valida por separado (el que no está en el surtido de la sucursal, no tiene tanto stock o cambió
--   de stock falla solo; el resto se aplica). Los productos válidos se agrupan por sucursal y tipo en UNA operación del ledger (≤ 100 líneas); si esa
--   operación falla por un error inesperado, se revierte SOLO ese grupo (subtransacción) y sus productos se informan como fallidos.
--
--   Idempotencia (doble toque, reintento de red): la misma p_request_key con el MISMO pedido devuelve el resultado guardado SIN volver a
--   registrar nada (replayed = true); con otro pedido se rechaza. Dos pedidos simultáneos con la misma clave: el segundo espera al primero (índice
--   único) y después ve su fila. Para reintentar sólo lo que falló hay que usar una clave nueva.
--
--   Permisos: stock.write en la organización y en cada sucursal. Un producto de otra organización o una sucursal no autorizada rechaza TODO el
--   pedido (error de seguridad, no un fallo parcial).

-- ---------------------------------------------------------------------------------------------
-- 1. Idempotencia del lote
-- ---------------------------------------------------------------------------------------------
create table public.quick_stock_requests (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_key uuid not null,
  -- md5 del jsonb canónico del pedido: la misma clave con OTROS datos es un error, no un reintento.
  payload_hash text not null,
  result jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (organization_id, request_key)
);

alter table public.quick_stock_requests enable row level security;
revoke all on table public.quick_stock_requests from public, anon, authenticated;

comment on table public.quick_stock_requests is
  'Claves de idempotencia de apply_quick_stock_changes (D-081): una fila por lote de Stock rápido ya aplicado. Sin acceso directo desde el navegador.';

-- ---------------------------------------------------------------------------------------------
-- 2. Aplicar el lote
-- ---------------------------------------------------------------------------------------------
create function public.apply_quick_stock_changes(
  p_request_key uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.write');
  request_hash text;
  existing record;
  inserted integer;
  entry record;
  grp record;
  current_quantity bigint;
  target_quantity bigint;
  plan jsonb := '[]'::jsonb;
  results jsonb := '[]'::jsonb;
  operation_ids jsonb := '[]'::jsonb;
  chunk_ops jsonb;
  chunk_plan jsonb;
  plan_item jsonb;
  op_id uuid;
  group_note text;
  group_type text;
  failure_message text;
  index_in_group integer;
  total_in_group integer;
  applied_count integer;
  unchanged_count integer;
  failed_count integer;
  batch_result jsonb;
begin
  if p_request_key is null then
    raise exception 'Falta la clave de la operación' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 200 then
    raise exception 'Debe enviar entre 1 y 200 productos' using errcode = '22023';
  end if;

  -- 1. Forma de cada línea (antes de escribir nada: un pedido mal armado se rechaza entero y el error dice por qué).
  for entry in select value as item from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(entry.item) <> 'object'
       or jsonb_typeof(entry.item -> 'branchId') is distinct from 'string'
       or (entry.item ->> 'branchId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(entry.item -> 'productId') is distinct from 'string'
       or (entry.item ->> 'productId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Los cambios de stock son inválidos' using errcode = '22023';
    end if;
    if (entry.item ->> 'mode') is null or (entry.item ->> 'mode') not in ('ADD', 'REMOVE', 'COUNT') then
      raise exception 'Cada cambio tiene que ser agregar, quitar o contar' using errcode = '22023';
    end if;
    if (entry.item ->> 'mode') in ('ADD', 'REMOVE') and (jsonb_typeof(entry.item -> 'quantity') is distinct from 'number'
       or (entry.item ->> 'quantity') !~ '^[0-9]{1,15}$' or (entry.item ->> 'quantity')::numeric <= 0) then
      raise exception 'La cantidad a agregar o quitar tiene que ser mayor a cero' using errcode = '22023';
    end if;
    if (entry.item ->> 'mode') = 'COUNT' and (jsonb_typeof(entry.item -> 'physicalQuantity') is distinct from 'number'
       or (entry.item ->> 'physicalQuantity') !~ '^[0-9]{1,15}$') then
      raise exception 'El conteo tiene que ser una cantidad (puede ser cero)' using errcode = '22023';
    end if;
    if entry.item ? 'expectedSystemQuantity' and jsonb_typeof(entry.item -> 'expectedSystemQuantity') <> 'null'
       and (jsonb_typeof(entry.item -> 'expectedSystemQuantity') <> 'number' or (entry.item ->> 'expectedSystemQuantity') !~ '^-?[0-9]{1,15}$') then
      raise exception 'El stock esperado es inválido' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct (i ->> 'branchId') || ':' || (i ->> 'productId')) from jsonb_array_elements(p_items) i) <> jsonb_array_length(p_items) then
    raise exception 'Un producto no puede venir dos veces para la misma sucursal en la misma carga' using errcode = '22023';
  end if;

  -- 2. Aislamiento: todos los productos son de esta organización y todas las sucursales están autorizadas (si no, se rechaza TODO).
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where not exists (
      select 1 from public.products p where p.id = (i ->> 'productId')::uuid and p.organization_id = current_organization_id
    )
  ) then
    raise exception 'Uno de los productos enviados no existe en esta organización' using errcode = '42501';
  end if;
  for entry in select distinct (i ->> 'branchId')::uuid as branch_id from jsonb_array_elements(p_items) i
  loop
    if not exists (select 1 from public.branches b where b.id = entry.branch_id and b.organization_id = current_organization_id and b.active)
       or not app_private.can_access_branch(current_organization_id, entry.branch_id, 'stock.write') then
      raise exception 'Una de las sucursales no está autorizada para operar stock' using errcode = '42501';
    end if;
  end loop;

  -- 3. Idempotencia: la misma clave ya aplicada devuelve el resultado guardado SIN volver a escribir (doble toque, reintento de red).
  request_hash := md5(p_items::text);
  insert into public.quick_stock_requests (organization_id, request_key, payload_hash, created_by)
  values (current_organization_id, p_request_key, request_hash, auth.uid())
  on conflict (organization_id, request_key) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then
    select r.payload_hash, r.result into existing
    from public.quick_stock_requests r
    where r.organization_id = current_organization_id and r.request_key = p_request_key;
    if existing.payload_hash <> request_hash then
      raise exception 'Esta operación ya se registró con otros datos: recargá la pantalla' using errcode = '22023';
    end if;
    return coalesce(existing.result, '{}'::jsonb) || jsonb_build_object('replayed', true);
  end if;

  -- 4. Validar cada producto por separado, siempre en el mismo orden (sucursal, producto) para no cruzar locks. El lock por producto/sucursal es
  --    el mismo que toma record_stock_operation: el stock leído acá es el que ese flujo va a ver.
  for entry in
    select (i ->> 'branchId')::uuid as branch_id, (i ->> 'productId')::uuid as product_id, i ->> 'mode' as mode,
           (i ->> 'quantity')::bigint as quantity, (i ->> 'physicalQuantity')::bigint as physical,
           nullif(i ->> 'expectedSystemQuantity', '')::bigint as expected
    from jsonb_array_elements(p_items) i
    order by (i ->> 'branchId'), (i ->> 'productId')
  loop
    if not exists (
      select 1 from public.branch_product_assortment a
      where a.organization_id = current_organization_id and a.branch_id = entry.branch_id and a.product_id = entry.product_id
    ) then
      results := results || jsonb_build_array(jsonb_build_object(
        'branchId', entry.branch_id, 'productId', entry.product_id, 'mode', entry.mode, 'ok', false, 'code', 'NOT_IN_BRANCH'));
      continue;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry.branch_id::text || ':' || entry.product_id::text, 0));
    select coalesce(sum(sm.quantity_grams), 0)::bigint into current_quantity
    from public.stock_movements sm
    where sm.organization_id = current_organization_id and sm.branch_id = entry.branch_id and sm.product_id = entry.product_id;

    if entry.mode = 'ADD' then
      target_quantity := current_quantity + entry.quantity;
    elsif entry.mode = 'REMOVE' then
      if current_quantity < entry.quantity then
        results := results || jsonb_build_array(jsonb_build_object(
          'branchId', entry.branch_id, 'productId', entry.product_id, 'mode', entry.mode, 'ok', false, 'code', 'INSUFFICIENT_STOCK', 'current', current_quantity));
        continue;
      end if;
      target_quantity := current_quantity - entry.quantity;
    else
      if entry.expected is not null and entry.expected <> current_quantity then
        results := results || jsonb_build_array(jsonb_build_object(
          'branchId', entry.branch_id, 'productId', entry.product_id, 'mode', entry.mode, 'ok', false, 'code', 'STOCK_CHANGED', 'current', current_quantity));
        continue;
      end if;
      target_quantity := entry.physical;
      if target_quantity = current_quantity then
        results := results || jsonb_build_array(jsonb_build_object(
          'branchId', entry.branch_id, 'productId', entry.product_id, 'mode', entry.mode, 'ok', true, 'unchanged', true,
          'before', current_quantity, 'after', current_quantity, 'difference', 0));
        continue;
      end if;
    end if;

    plan := plan || jsonb_build_array(jsonb_build_object(
      'branchId', entry.branch_id, 'productId', entry.product_id, 'mode', entry.mode,
      'before', current_quantity, 'after', target_quantity,
      'opItem', case when entry.mode = 'ADD'
        then jsonb_build_object('product_id', entry.product_id, 'quantity_grams', entry.quantity)
        else jsonb_build_object('product_id', entry.product_id, 'physical_quantity_grams', target_quantity) end));
  end loop;

  -- 5. Una operación del ledger por (sucursal, tipo) con los productos válidos, en lotes de hasta 100 (límite de record_stock_operation).
  --    Un fallo inesperado revierte SÓLO ese grupo (subtransacción) y se informa por producto.
  for grp in
    select (p ->> 'branchId')::uuid as branch_id, p ->> 'mode' as mode, jsonb_agg(p order by (p ->> 'productId')) as plan_items
    from jsonb_array_elements(plan) p
    group by 1, 2
    order by 1, 2
  loop
    group_type := case when grp.mode = 'ADD' then 'PURCHASE' else 'ADJUSTMENT' end;
    group_note := case grp.mode when 'ADD' then 'Stock rápido: ingreso' when 'REMOVE' then 'Stock rápido: baja' else 'Stock rápido: conteo físico' end;
    total_in_group := jsonb_array_length(grp.plan_items);
    chunk_ops := '[]'::jsonb;
    chunk_plan := '[]'::jsonb;
    for index_in_group in 0 .. total_in_group - 1
    loop
      chunk_plan := chunk_plan || jsonb_build_array(grp.plan_items -> index_in_group);
      chunk_ops := chunk_ops || jsonb_build_array((grp.plan_items -> index_in_group) -> 'opItem');
      if jsonb_array_length(chunk_ops) = 100 or index_in_group = total_in_group - 1 then
        begin
          op_id := public.record_stock_operation(grp.branch_id, group_type, chunk_ops, null, null, group_note, now());
          operation_ids := operation_ids || to_jsonb(op_id);
          for plan_item in select value from jsonb_array_elements(chunk_plan)
          loop
            results := results || jsonb_build_array(jsonb_build_object(
              'branchId', plan_item ->> 'branchId', 'productId', plan_item ->> 'productId', 'mode', plan_item ->> 'mode', 'ok', true, 'unchanged', false,
              'before', (plan_item ->> 'before')::bigint, 'after', (plan_item ->> 'after')::bigint,
              'difference', (plan_item ->> 'after')::bigint - (plan_item ->> 'before')::bigint));
          end loop;
        exception when others then
          get stacked diagnostics failure_message = message_text;
          for plan_item in select value from jsonb_array_elements(chunk_plan)
          loop
            results := results || jsonb_build_array(jsonb_build_object(
              'branchId', plan_item ->> 'branchId', 'productId', plan_item ->> 'productId', 'mode', plan_item ->> 'mode', 'ok', false,
              'code', 'FAILED', 'message', failure_message));
          end loop;
        end;
        chunk_ops := '[]'::jsonb;
        chunk_plan := '[]'::jsonb;
      end if;
    end loop;
  end loop;

  select count(*) filter (where (r ->> 'ok')::boolean and not coalesce((r ->> 'unchanged')::boolean, false)),
         count(*) filter (where (r ->> 'ok')::boolean and coalesce((r ->> 'unchanged')::boolean, false)),
         count(*) filter (where not (r ->> 'ok')::boolean)
  into applied_count, unchanged_count, failed_count
  from jsonb_array_elements(results) r;

  batch_result := jsonb_build_object(
    'requested', jsonb_array_length(p_items), 'applied', applied_count, 'unchanged', unchanged_count, 'failed', failed_count,
    'items', results, 'operationIds', operation_ids, 'replayed', false);
  update public.quick_stock_requests r set result = batch_result
  where r.organization_id = current_organization_id and r.request_key = p_request_key;
  perform app_private.write_audit(current_organization_id, null, 'QUICK_STOCK_APPLIED', 'quick_stock_requests', p_request_key, null,
    jsonb_build_object('requested', jsonb_array_length(p_items), 'applied', applied_count, 'unchanged', unchanged_count, 'failed', failed_count, 'operationIds', operation_ids));
  return batch_result;
end;
$$;

comment on function public.apply_quick_stock_changes(uuid, jsonb) is
  'Stock rápido (D-081): agregar / quitar / conteo físico de varios productos y sucursales en una llamada idempotente. Reutiliza record_stock_operation (PURCHASE / ADJUSTMENT); resultado parcial por producto.';

-- ---------------------------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------------------------
revoke all on function public.apply_quick_stock_changes(uuid, jsonb) from public, anon;
grant execute on function public.apply_quick_stock_changes(uuid, jsonb) to authenticated;

commit;
