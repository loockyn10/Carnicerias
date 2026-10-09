begin;

-- Auditoría por PRODUCTO + SUCURSAL (sólo lectura): reconstruir cómo se llegó al stock teórico.
--
--   get_product_sales_summary   Ventas filtradas por producto: cantidad (kg o unidades), importe y tickets,
--                               sólo ventas COMPLETED, por día calendario de la zona horaria de la
--                               organización (sales.completed_at, el mismo timestamp canónico que
--                               get_branch_sales_summary).
--   get_stock_audit_summary     Stock inicial + movimientos agrupados por tipo = stock del período, el stock
--                               teórico actual y el control "ventas COMPLETED vs. movimientos del ledger".
--   list_stock_audit_movements  Detalle cronológico paginado con el saldo resultante de cada movimiento.
--
-- NO es un segundo stock: todo sale de `stock_movements` (el ledger append-only) y de `sales`/`sale_items`.
-- No escribe nada, no cambia ninguna función ni tabla existente. La organización siempre sale de la sesión
-- (app_private.require_permission); los ids de sucursal/producto se validan contra esa organización y el
-- acceso por sucursal se resuelve con app_private.can_access_branch.
--
-- Saldo: el stock teórico en un instante es sum(quantity_grams) de los movimientos anteriores, ordenados por
-- (occurred_at, created_at, id). Esa tupla es el orden canónico del detalle y de los límites del período, de
-- modo que "stock inicial + movimientos del período = stock al cierre" se cumple sin huecos ni solapes aun
-- con dos movimientos en el mismo instante.

-- ---------------------------------------------------------------------------------------------
-- Ventana del período (privada). La invocan las dos RPC de stock con la organización ya derivada
-- de la sesión; no es ejecutable por navegadores (confía en su argumento de organización).
--   RANGE               [p_from 00:00, p_to + 1 día 00:00) en la zona horaria de la organización.
--   SINCE_LAST_INBOUND  desde el último movimiento de ENTRADA real (PURCHASE, TRANSFER_IN,
--                       PRODUCTION_YIELD u OPENING_BALANCE), inclusive, hasta hoy. RETURN y
--                       ADJUSTMENT_POSITIVE NO son recepciones: no cuentan como ancla.
--   ALL_HISTORY         SINCE_LAST_INBOUND pedido para un producto que nunca tuvo una entrada: todo el
--                       historial del ledger.
-- ---------------------------------------------------------------------------------------------
create function app_private.stock_audit_scope(
  p_organization_id uuid,
  p_branch_id uuid,
  p_product_id uuid,
  p_from date,
  p_to date,
  p_since_last_inbound boolean
)
returns table (
  timezone text,
  mode text,
  start_ts timestamptz,
  start_created_at timestamptz,
  start_id uuid,
  end_ts timestamptz,
  anchor_id uuid,
  anchor_type public.stock_movement_type,
  anchor_occurred_at timestamptz,
  anchor_quantity bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org_timezone text;
  span_days integer;
  nil_id constant uuid := '00000000-0000-0000-0000-000000000000';
  a_id uuid;
  a_type public.stock_movement_type;
  a_occurred_at timestamptz;
  a_created_at timestamptz;
  a_quantity bigint;
begin
  select o.timezone into org_timezone
  from public.organizations o
  where o.id = p_organization_id and o.active;
  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;
  if p_branch_id is null or p_product_id is null then
    raise exception 'La sucursal y el producto son obligatorios' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = p_organization_id
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.products p where p.id = p_product_id and p.organization_id = p_organization_id
  ) then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
  if not app_private.can_access_branch(p_organization_id, p_branch_id, 'stock.read') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;

  if coalesce(p_since_last_inbound, false) then
    select sm.id, sm.type, sm.occurred_at, sm.created_at, sm.quantity_grams
    into a_id, a_type, a_occurred_at, a_created_at, a_quantity
    from public.stock_movements sm
    where sm.organization_id = p_organization_id
      and sm.branch_id = p_branch_id
      and sm.product_id = p_product_id
      and sm.type in ('PURCHASE', 'TRANSFER_IN', 'PRODUCTION_YIELD', 'OPENING_BALANCE')
    order by sm.occurred_at desc, sm.created_at desc, sm.id desc
    limit 1;

    if a_id is null then
      return query select org_timezone, 'ALL_HISTORY'::text,
        '-infinity'::timestamptz, '-infinity'::timestamptz, nil_id, 'infinity'::timestamptz,
        null::uuid, null::public.stock_movement_type, null::timestamptz, null::bigint;
    else
      return query select org_timezone, 'SINCE_LAST_INBOUND'::text,
        a_occurred_at, a_created_at, a_id, 'infinity'::timestamptz,
        a_id, a_type, a_occurred_at, a_quantity;
    end if;
    return;
  end if;

  if p_from is null or p_to is null then
    raise exception 'El rango de fechas es obligatorio' using errcode = '22023';
  end if;
  if p_from > p_to then
    raise exception 'La fecha inicial no puede ser posterior a la final' using errcode = '22023';
  end if;
  span_days := (p_to - p_from) + 1;
  if span_days > 366 then
    raise exception 'El rango no puede superar 366 días' using errcode = '22023';
  end if;

  return query select org_timezone, 'RANGE'::text,
    (p_from::timestamp at time zone org_timezone), '-infinity'::timestamptz, nil_id,
    ((p_to + 1)::timestamp at time zone org_timezone),
    null::uuid, null::public.stock_movement_type, null::timestamptz, null::bigint;
end;
$$;

revoke all on function app_private.stock_audit_scope(uuid, uuid, uuid, date, date, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Ventas de UN producto por sucursal: cantidad vendida, importe y tickets.
-- · Sólo sales.status = 'COMPLETED' (PENDING_PAYMENT, CANCELLED, REFUNDED y borradores no cuentan).
-- · Rango por sales.completed_at en días calendario de la organización: [p_from 00:00, p_to + 1 día 00:00).
-- · quantity: gramos para un producto WEIGHT, unidades para un UNIT (la unidad la informa unit_type);
--   nunca se suman kilos con unidades porque la consulta es de un único producto.
-- · revenue_cents: subtotal de la línea menos su parte del descuento general del ticket, el mismo
--   ingreso que usan el dashboard y Rentabilidad.
-- · tickets: ventas distintas en las que apareció el producto.
-- · Una fila por sucursal activa accesible (con p_branch_id: sólo esa), también las que no vendieron.
-- ---------------------------------------------------------------------------------------------
create function public.get_product_sales_summary(
  p_product_id uuid,
  p_from date,
  p_to date,
  p_branch_id uuid default null
)
returns table (
  branch_id uuid,
  branch_name text,
  unit_type public.unit_type,
  quantity bigint,
  revenue_cents bigint,
  tickets bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('sales.read');
  org_timezone text;
  product_unit_type public.unit_type;
  range_start timestamptz;
  range_end timestamptz;
begin
  if p_product_id is null then
    raise exception 'El producto es obligatorio' using errcode = '22023';
  end if;
  if p_from is null or p_to is null then
    raise exception 'El rango de fechas es obligatorio' using errcode = '22023';
  end if;
  if p_from > p_to then
    raise exception 'La fecha inicial no puede ser posterior a la final' using errcode = '22023';
  end if;
  if (p_to - p_from) + 1 > 366 then
    raise exception 'El rango no puede superar 366 días' using errcode = '22023';
  end if;

  select o.timezone into org_timezone
  from public.organizations o
  where o.id = current_organization_id and o.active;
  if not found then
    raise exception 'Organization was not found' using errcode = '42501';
  end if;

  select p.unit_type into product_unit_type
  from public.products p
  where p.id = p_product_id and p.organization_id = current_organization_id;
  if not found then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;

  if p_branch_id is not null then
    if not exists (
      select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
    ) then
      raise exception 'Branch was not found in this organization' using errcode = '42501';
    end if;
    if not app_private.can_access_branch(current_organization_id, p_branch_id, 'sales.read') then
      raise exception 'Branch is not authorized for this user' using errcode = '42501';
    end if;
  end if;

  range_start := p_from::timestamp at time zone org_timezone;
  range_end := (p_to + 1)::timestamp at time zone org_timezone;

  return query
  with scoped_branches as (
    select b.id, b.name
    from public.branches b
    where b.organization_id = current_organization_id
      and b.active
      and (p_branch_id is null or b.id = p_branch_id)
      and app_private.can_access_branch(current_organization_id, b.id, 'sales.read')
  ), sold as (
    select si.branch_id as sold_branch_id,
      coalesce(sum(coalesce(si.weight_grams, si.quantity_units)), 0)::bigint as sold_quantity,
      coalesce(sum(si.subtotal_cents - si.ticket_discount_cents), 0)::bigint as sold_revenue,
      count(distinct si.sale_id)::bigint as sold_tickets
    from public.sale_items si
    join public.sales s
      on s.id = si.sale_id
     and s.organization_id = si.organization_id
     and s.branch_id = si.branch_id
    where s.organization_id = current_organization_id
      and s.status = 'COMPLETED'
      and s.completed_at >= range_start
      and s.completed_at < range_end
      and si.product_id = p_product_id
      and s.branch_id in (select sb.id from scoped_branches sb)
    group by si.branch_id
  )
  select sb.id, sb.name, product_unit_type,
    coalesce(sd.sold_quantity, 0)::bigint,
    coalesce(sd.sold_revenue, 0)::bigint,
    coalesce(sd.sold_tickets, 0)::bigint
  from scoped_branches sb
  left join sold sd on sd.sold_branch_id = sb.id
  order by sb.name, sb.id;
end;
$$;

revoke all on function public.get_product_sales_summary(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_product_sales_summary(uuid, date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Resumen de auditoría de stock de un producto en una sucursal.
--
--   stock inicial        = sum(ledger) de lo anterior al inicio del período
--   + movimientos        = byType: una fila por tipo REAL del ledger con su cantidad firmada (el cliente los
--                          agrupa por rubro; ningún tipo queda fuera porque se devuelven todos)
--   = stock al cierre    (closingQuantity = openingQuantity + windowQuantity)
--   + lo posterior       (afterPeriodQuantity: movimientos desde el fin del período hasta hoy; 0 si el
--                          período llega a hoy)
--   = stock teórico actual (currentQuantity = sum de TODO el ledger de la sucursal y el producto)
--
-- Control ventas vs. ledger (`sales`; null si el usuario no tiene sales.read en la sucursal). Se compara
-- TICKET POR TICKET, con las ventas que cayeron en el período por completed_at:
--   · lado ventas  : sum(sale_items) del producto en cada venta;
--   · lado ledger  : -(sum de sus movimientos SALE + RETURN para ese producto y sucursal), o sea lo que el
--                    ledger terminó descontando por esa venta (una venta anulada devuelve con RETURN, y una
--                    restablecida por Mercado Pago vuelve a descontar con otro SALE);
--   · esperado     : COMPLETED y PENDING_PAYMENT (reserva stock) = lo vendido; CANCELLED = 0.
--   Cualquier ticket con ledger <> esperado es una discrepancia. La diferencia de titulares
--   (completedQuantity - ledgerQuantityForCompleted) sólo mira las COMPLETED. Además se cuentan los SALE del
--   período que no tienen línea del producto en su venta (orphanSaleMovements).
-- No corrige nada: sólo informa.
-- ---------------------------------------------------------------------------------------------
create function public.get_stock_audit_summary(
  p_branch_id uuid,
  p_product_id uuid,
  p_from date default null,
  p_to date default null,
  p_since_last_inbound boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.read');
  win record;
  product_row record;
  branch_name text;
  current_quantity bigint;
  opening_quantity bigint;
  window_quantity bigint;
  movement_count bigint;
  by_type jsonb;
  sales_json jsonb := null;
  completed_tickets bigint;
  completed_quantity bigint;
  completed_revenue bigint;
  ledger_for_completed bigint;
  pending_tickets bigint;
  pending_quantity bigint;
  mismatched_sales bigint;
  mismatches jsonb;
  orphan_count bigint;
  orphan_quantity bigint;
begin
  select * into win
  from app_private.stock_audit_scope(
    current_organization_id, p_branch_id, p_product_id, p_from, p_to, p_since_last_inbound
  );

  select p.id, p.name, p.sku, p.unit_type, p.active into product_row
  from public.products p
  where p.id = p_product_id and p.organization_id = current_organization_id;
  select b.name into branch_name
  from public.branches b
  where b.id = p_branch_id and b.organization_id = current_organization_id;

  select coalesce(sum(sm.quantity_grams), 0)::bigint into current_quantity
  from public.stock_movements sm
  where sm.organization_id = current_organization_id
    and sm.branch_id = p_branch_id
    and sm.product_id = p_product_id;

  select coalesce(sum(sm.quantity_grams), 0)::bigint into opening_quantity
  from public.stock_movements sm
  where sm.organization_id = current_organization_id
    and sm.branch_id = p_branch_id
    and sm.product_id = p_product_id
    and sm.occurred_at <= win.start_ts
    and (sm.occurred_at, sm.created_at, sm.id) < (win.start_ts, win.start_created_at, win.start_id);

  select coalesce(jsonb_agg(jsonb_build_object('type', t.type, 'count', t.movement_count, 'quantity', t.total_quantity) order by t.type), '[]'::jsonb),
    coalesce(sum(t.total_quantity), 0)::bigint,
    coalesce(sum(t.movement_count), 0)::bigint
  into by_type, window_quantity, movement_count
  from (
    select sm.type, count(*)::bigint as movement_count, sum(sm.quantity_grams)::bigint as total_quantity
    from public.stock_movements sm
    where sm.organization_id = current_organization_id
      and sm.branch_id = p_branch_id
      and sm.product_id = p_product_id
      and sm.occurred_at >= win.start_ts
      and sm.occurred_at < win.end_ts
      and (sm.occurred_at, sm.created_at, sm.id) >= (win.start_ts, win.start_created_at, win.start_id)
    group by sm.type
  ) t;

  if app_private.can_access_branch(current_organization_id, p_branch_id, 'sales.read') then
    with window_sales as (
      select s.id, s.status, s.completed_at,
        sum(coalesce(si.weight_grams, si.quantity_units))::bigint as items_quantity,
        sum(si.subtotal_cents - si.ticket_discount_cents)::bigint as items_revenue
      from public.sales s
      join public.sale_items si
        on si.sale_id = s.id
       and si.organization_id = s.organization_id
       and si.branch_id = s.branch_id
      where s.organization_id = current_organization_id
        and s.branch_id = p_branch_id
        and si.product_id = p_product_id
        and s.status in ('COMPLETED', 'PENDING_PAYMENT', 'CANCELLED')
        and s.completed_at >= win.start_ts
        and s.completed_at < win.end_ts
      group by s.id, s.status, s.completed_at
    ), ledger as (
      select sm.sale_id as ledger_sale_id, (-sum(sm.quantity_grams))::bigint as ledger_quantity
      from public.stock_movements sm
      where sm.organization_id = current_organization_id
        and sm.branch_id = p_branch_id
        and sm.product_id = p_product_id
        and sm.type in ('SALE', 'RETURN')
        and sm.sale_id in (select ws.id from window_sales ws)
      group by sm.sale_id
    ), compared as (
      select ws.id, ws.status, ws.completed_at, ws.items_quantity, ws.items_revenue,
        coalesce(l.ledger_quantity, 0)::bigint as ledger_quantity,
        (case when ws.status in ('COMPLETED', 'PENDING_PAYMENT') then ws.items_quantity else 0 end)::bigint as expected_quantity
      from window_sales ws
      left join ledger l on l.ledger_sale_id = ws.id
    )
    select
      count(*) filter (where c.status = 'COMPLETED'),
      coalesce(sum(c.items_quantity) filter (where c.status = 'COMPLETED'), 0)::bigint,
      coalesce(sum(c.items_revenue) filter (where c.status = 'COMPLETED'), 0)::bigint,
      coalesce(sum(c.ledger_quantity) filter (where c.status = 'COMPLETED'), 0)::bigint,
      count(*) filter (where c.status = 'PENDING_PAYMENT'),
      coalesce(sum(c.items_quantity) filter (where c.status = 'PENDING_PAYMENT'), 0)::bigint,
      count(*) filter (where c.ledger_quantity <> c.expected_quantity),
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'saleId', m.id, 'status', m.status, 'completedAt', m.completed_at,
          'saleQuantity', m.items_quantity, 'ledgerQuantity', m.ledger_quantity, 'expectedQuantity', m.expected_quantity
        ) order by abs(m.ledger_quantity - m.expected_quantity) desc, m.completed_at desc, m.id)
        from (
          select c2.*
          from compared c2
          where c2.ledger_quantity <> c2.expected_quantity
          order by abs(c2.ledger_quantity - c2.expected_quantity) desc, c2.completed_at desc, c2.id
          limit 20
        ) m
      ), '[]'::jsonb)
    into completed_tickets, completed_quantity, completed_revenue, ledger_for_completed,
         pending_tickets, pending_quantity, mismatched_sales, mismatches
    from compared c;

    select count(*)::bigint, coalesce(-sum(sm.quantity_grams), 0)::bigint
    into orphan_count, orphan_quantity
    from public.stock_movements sm
    where sm.organization_id = current_organization_id
      and sm.branch_id = p_branch_id
      and sm.product_id = p_product_id
      and sm.type = 'SALE'
      and sm.occurred_at >= win.start_ts
      and sm.occurred_at < win.end_ts
      and (sm.occurred_at, sm.created_at, sm.id) >= (win.start_ts, win.start_created_at, win.start_id)
      and not exists (
        select 1 from public.sale_items si
        where si.sale_id = sm.sale_id and si.product_id = sm.product_id
      );

    sales_json := jsonb_build_object(
      'completedTickets', completed_tickets,
      'completedQuantity', completed_quantity,
      'completedRevenueCents', completed_revenue,
      'ledgerQuantityForCompleted', ledger_for_completed,
      'difference', completed_quantity - ledger_for_completed,
      'pendingPaymentTickets', pending_tickets,
      'pendingPaymentQuantity', pending_quantity,
      'mismatchedSales', mismatched_sales,
      'mismatches', mismatches,
      'orphanSaleMovements', jsonb_build_object('count', orphan_count, 'quantity', orphan_quantity)
    );
  end if;

  return jsonb_build_object(
    'product', jsonb_build_object(
      'id', product_row.id, 'name', product_row.name, 'sku', product_row.sku,
      'unitType', product_row.unit_type, 'active', product_row.active
    ),
    'branch', jsonb_build_object('id', p_branch_id, 'name', branch_name),
    'mode', win.mode,
    'timezone', win.timezone,
    'periodStart', case when isfinite(win.start_ts) then win.start_ts end,
    'periodEnd', case when isfinite(win.end_ts) then win.end_ts end,
    'anchor', case when win.anchor_id is null then null else jsonb_build_object(
      'movementId', win.anchor_id, 'type', win.anchor_type,
      'occurredAt', win.anchor_occurred_at, 'quantity', win.anchor_quantity
    ) end,
    'openingQuantity', opening_quantity,
    'windowQuantity', window_quantity,
    'closingQuantity', opening_quantity + window_quantity,
    'afterPeriodQuantity', current_quantity - (opening_quantity + window_quantity),
    'currentQuantity', current_quantity,
    'movementCount', movement_count,
    'byType', by_type,
    'sales', sales_json,
    'computedAt', now()
  );
end;
$$;

revoke all on function public.get_stock_audit_summary(uuid, uuid, date, date, boolean) from public, anon;
grant execute on function public.get_stock_audit_summary(uuid, uuid, date, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Detalle cronológico paginado del mismo período (mismos parámetros que el resumen).
-- · balanceAfter: stock teórico inmediatamente después de cada movimiento (stock inicial + acumulado en
--   el orden (occurred_at, created_at, id)); el último movimiento del período deja closingQuantity.
-- · Orden ascendente por defecto; p_newest_first invierte el orden sin cambiar los saldos.
-- · Referencias: venta (con su estado actual), transferencia (sucursal contraparte), operación de stock
--   (proveedor/nota) o desposte. operatorName = perfil que registró el movimiento (el cajero en una venta).
-- ---------------------------------------------------------------------------------------------
create function public.list_stock_audit_movements(
  p_branch_id uuid,
  p_product_id uuid,
  p_from date default null,
  p_to date default null,
  p_since_last_inbound boolean default false,
  p_limit integer default 50,
  p_offset integer default 0,
  p_newest_first boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.read');
  win record;
  opening_quantity bigint;
  total_rows bigint;
  page_rows jsonb;
begin
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'Limit must be between 1 and 200' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception 'Offset must not be negative' using errcode = '22023';
  end if;

  select * into win
  from app_private.stock_audit_scope(
    current_organization_id, p_branch_id, p_product_id, p_from, p_to, p_since_last_inbound
  );

  select coalesce(sum(sm.quantity_grams), 0)::bigint into opening_quantity
  from public.stock_movements sm
  where sm.organization_id = current_organization_id
    and sm.branch_id = p_branch_id
    and sm.product_id = p_product_id
    and sm.occurred_at <= win.start_ts
    and (sm.occurred_at, sm.created_at, sm.id) < (win.start_ts, win.start_created_at, win.start_id);

  with numbered as (
    select sm.id, sm.type, sm.quantity_grams, sm.occurred_at, sm.reason, sm.profile_id, sm.sale_id,
      sm.stock_transfer_id, sm.stock_operation_id, sm.production_batch_id,
      opening_quantity + sum(sm.quantity_grams) over (order by sm.occurred_at, sm.created_at, sm.id) as balance_after,
      row_number() over (order by sm.occurred_at, sm.created_at, sm.id) as position,
      count(*) over () as total_count
    from public.stock_movements sm
    where sm.organization_id = current_organization_id
      and sm.branch_id = p_branch_id
      and sm.product_id = p_product_id
      and sm.occurred_at >= win.start_ts
      and sm.occurred_at < win.end_ts
      and (sm.occurred_at, sm.created_at, sm.id) >= (win.start_ts, win.start_created_at, win.start_id)
  ), page as (
    select n.*
    from numbered n
    where (not coalesce(p_newest_first, false) and n.position > p_offset and n.position <= p_offset + p_limit)
       or (coalesce(p_newest_first, false) and n.position <= n.total_count - p_offset and n.position > n.total_count - p_offset - p_limit)
  )
  select
    (select count(*) from public.stock_movements sm
      where sm.organization_id = current_organization_id
        and sm.branch_id = p_branch_id
        and sm.product_id = p_product_id
        and sm.occurred_at >= win.start_ts
        and sm.occurred_at < win.end_ts
        and (sm.occurred_at, sm.created_at, sm.id) >= (win.start_ts, win.start_created_at, win.start_id)),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', pg.id,
      'occurredAt', pg.occurred_at,
      'type', pg.type,
      'quantity', pg.quantity_grams,
      'balanceAfter', pg.balance_after,
      'reason', pg.reason,
      'operatorName', operator.display_name,
      'saleId', pg.sale_id,
      'saleStatus', linked_sale.status,
      'transferId', pg.stock_transfer_id,
      'counterpartBranchName', case
        when pg.type = 'TRANSFER_OUT' then destination_branch.name
        when pg.type = 'TRANSFER_IN' then source_branch.name
      end,
      'stockOperationId', pg.stock_operation_id,
      'supplier', linked_operation.supplier,
      'productionBatchId', pg.production_batch_id
    ) order by case when coalesce(p_newest_first, false) then -pg.position else pg.position end), '[]'::jsonb)
  into total_rows, page_rows
  from page pg
  left join public.profiles operator on operator.id = pg.profile_id
  left join public.sales linked_sale on linked_sale.id = pg.sale_id and linked_sale.organization_id = current_organization_id
  left join public.stock_transfers linked_transfer on linked_transfer.id = pg.stock_transfer_id and linked_transfer.organization_id = current_organization_id
  left join public.branches source_branch on source_branch.id = linked_transfer.source_branch_id and source_branch.organization_id = current_organization_id
  left join public.branches destination_branch on destination_branch.id = linked_transfer.destination_branch_id and destination_branch.organization_id = current_organization_id
  left join public.stock_operations linked_operation on linked_operation.id = pg.stock_operation_id and linked_operation.organization_id = current_organization_id;

  return jsonb_build_object(
    'total', total_rows,
    'openingQuantity', opening_quantity,
    'limit', p_limit,
    'offset', p_offset,
    'newestFirst', coalesce(p_newest_first, false),
    'rows', page_rows
  );
end;
$$;

revoke all on function public.list_stock_audit_movements(uuid, uuid, date, date, boolean, integer, integer, boolean) from public, anon;
grant execute on function public.list_stock_audit_movements(uuid, uuid, date, date, boolean, integer, integer, boolean) to authenticated;

comment on function public.get_product_sales_summary(uuid, date, date, uuid) is
  'Ventas COMPLETED de un producto por sucursal en un rango de días de la organización: cantidad, importe y tickets. Sólo lectura.';
comment on function public.get_stock_audit_summary(uuid, uuid, date, date, boolean) is
  'Auditoría de stock de un producto en una sucursal: stock inicial, movimientos por tipo, stock teórico actual y control ventas COMPLETED vs. ledger. Sólo lectura; el ledger sigue siendo la única fuente de verdad.';
comment on function public.list_stock_audit_movements(uuid, uuid, date, date, boolean, integer, integer, boolean) is
  'Detalle cronológico paginado de stock_movements de un producto en una sucursal, con el saldo resultante de cada movimiento. Sólo lectura.';

commit;
