begin;

-- Productos → Precios como pantalla de REMITO (D-077). Complementa D-068/D-069/D-070/D-071 (202610060065–202610070068, ya aplicadas): NO se editan.
--
--   Fran recibe la boleta/remito del proveedor y desde UNA pantalla carga, por producto: costo nuevo, margen propio, cantidad RECIBIDA y,
--   donde el precio es manual, el precio. Esta migración agrega dos RPC y una tabla de idempotencia; no cambia ninguna fórmula, ningún
--   helper de pricing ni el ledger de stock:
--
--   1. public.list_pricing_rows(p_query, p_product_ids, p_limit, p_offset): búsqueda GLOBAL en el servidor (nombre, categoría, SKU o código
--      de barras) con paginación, devolviendo por fila costo vigente, precio de lista global vigente y la regla de margen EFECTIVA
--      (app_private.effective_margin, el mismo helper que usa el resto del pricing). El navegador nunca carga el catálogo entero.
--   2. public.apply_pricing_receipt(p_request_key, p_items): UNA transacción para todo el lote. Reutiliza los helpers canónicos
--        - set_product_custom_margin (margen propio)            -> sin repreciar si la fila trae costo (el costo forma el precio UNA vez);
--        - app_private.apply_product_cost                        -> vigencia de costo + precio automático (costo / (1 - margen), $50);
--        - app_private.set_price_history                         -> vigencia de precio MANUAL (sólo donde el precio no se deriva);
--        - public.record_stock_operation('PURCHASE')             -> ingreso al ledger stock_movements en la sucursal productiva.
--      Como son llamadas dentro de una única función, cualquier error revierte el lote completo: nunca queda un costo o un margen guardado
--      con el stock fallado (ni al revés). La clave de idempotencia (p_request_key) hace que un doble click o un reintento de red del MISMO
--      pedido devuelva el resultado guardado sin volver a registrar el ingreso.
--
--   Semántica de «cantidad» (receivedQuantity): lo RECIBIDO en esta entrega, en unidades del ledger (gramos para WEIGHT, unidades enteras
--   para UNIT). Siempre SUMA (movimiento PURCHASE positivo); nunca fija el stock. Un movimiento por producto.
--   No cambia la regla de Central en el POS (D-058): registrar ingresos no activa ningún bloqueo por stock.
--
-- No recalcula ningún precio al aplicarse.

-- ---------------------------------------------------------------------------------------------
-- 1. Idempotencia del lote
-- ---------------------------------------------------------------------------------------------
create table public.pricing_receipt_requests (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_key uuid not null,
  -- md5 del jsonb canónico del pedido: la misma clave con OTROS datos es un error, no un reintento.
  payload_hash text not null,
  result jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (organization_id, request_key)
);

alter table public.pricing_receipt_requests enable row level security;
revoke all on table public.pricing_receipt_requests from public, anon, authenticated;

comment on table public.pricing_receipt_requests is
  'Claves de idempotencia de apply_pricing_receipt (D-077): una fila por lote de remito ya aplicado. Sin acceso directo desde el navegador.';

-- ---------------------------------------------------------------------------------------------
-- 2. Búsqueda global paginada para la planilla de remito
-- ---------------------------------------------------------------------------------------------
-- Una sola búsqueda: cada palabra tiene que aparecer en el nombre, la categoría o el SKU (sin acentos ni mayúsculas); un código de barras
-- exacto también encuentra el producto. p_product_ids (si viene) reemplaza la búsqueda y devuelve exactamente esos productos (refresco
-- tras guardar). Sólo productos activos y de venta (los que la planilla puede editar).
-- margin_source: CUSTOM | GLOBAL | MANUAL | NO_MARGIN (app_private.effective_margin).
create function public.list_pricing_rows(
  p_query text default null,
  p_product_ids uuid[] default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  normalized_query text := app_private.import_normalize_text(p_query);
  normalized_code text := app_private.normalize_barcode(p_query);
  tokens text[];
  total bigint;
  result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Limit must be between 1 and 100' using errcode = '22023';
  end if;
  if coalesce(p_offset, 0) < 0 then
    raise exception 'Offset must not be negative' using errcode = '22023';
  end if;
  if p_product_ids is not null and cardinality(p_product_ids) > 500 then
    raise exception 'Too many products requested' using errcode = '22023';
  end if;
  -- Escapa los comodines de LIKE de lo que escribió el usuario (un "%" o "_" es texto, no un patrón).
  tokens := coalesce(
    (select array_agg(replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_'))
     from unnest(regexp_split_to_array(coalesce(normalized_query, ''), '\s+')) as t where t <> ''),
    array[]::text[]
  );

  with matched as (
    select p.id, p.name, p.sku, p.unit_type, p.category_id, coalesce(c.name, 'Sin categoría') as category_name
    from public.products p
    left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    where p.organization_id = current_organization_id
      and p.active and p.inventory_role in ('SELLABLE', 'BOTH')
      and case
        when p_product_ids is not null then p.id = any (p_product_ids)
        else
          not exists (
            select 1 from unnest(tokens) as t
            where (app_private.import_normalize_text(p.name) || ' ' || coalesce(app_private.import_normalize_text(c.name), '') || ' ' || lower(coalesce(p.sku, '')))
              not like '%' || t || '%' escape '\'
          )
          or (normalized_code is not null and exists (
            select 1 from public.product_barcodes pb
            where pb.product_id = p.id and pb.organization_id = p.organization_id and pb.barcode = normalized_code
          ))
      end
  ),
  counted as (select count(*) as n from matched),
  paged as (
    select m.* from matched m order by m.name, m.id limit p_limit offset coalesce(p_offset, 0)
  )
  select counted.n,
    coalesce(jsonb_agg(
      jsonb_build_object(
        'productId', g.id, 'name', g.name, 'sku', g.sku, 'categoryName', g.category_name, 'unitType', g.unit_type,
        'costCents', g.cost_cents, 'priceCents', g.price_cents,
        'marginSource', g.margin_source, 'marginBps', g.margin_bps, 'customMarginBps', g.custom_margin_bps,
        'excludedCategory', g.excluded
      ) order by g.name, g.id
    ) filter (where g.id is not null), '[]'::jsonb)
  into total, result
  from counted
  left join lateral (
    select m.id, m.name, m.sku, m.unit_type, m.category_name,
      (select pc.cost_cents from public.product_costs pc
        where pc.organization_id = current_organization_id and pc.product_id = m.id
          and pc.valid_from <= clock_timestamp() and (pc.valid_to is null or pc.valid_to > clock_timestamp())
        order by pc.valid_from desc limit 1) as cost_cents,
      (select pp.price_cents from public.product_prices pp
        where pp.organization_id = current_organization_id and pp.product_id = m.id and pp.branch_id is null
          and pp.valid_from <= clock_timestamp() and (pp.valid_to is null or pp.valid_to > clock_timestamp())
        order by pp.valid_from desc limit 1) as price_cents,
      e.source as margin_source, e.margin_bps,
      (select cm.custom_margin_bps from public.product_custom_margins cm
        where cm.organization_id = current_organization_id and cm.product_id = m.id) as custom_margin_bps,
      exists (select 1 from public.organization_pricing_excluded_categories x
        where x.organization_id = current_organization_id and x.category_id = m.category_id) as excluded
    from paged m
    cross join lateral app_private.effective_margin(current_organization_id, m.id) e
  ) g on true
  group by counted.n;

  return jsonb_build_object('total', coalesce(total, 0), 'rows', coalesce(result, '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Lote de remito: costo + margen + precio manual + ingreso de stock, en una transacción
-- ---------------------------------------------------------------------------------------------
-- p_items: [{ "productId": uuid,
--             "costCents": int > 0          (opcional: ausente = no cambia el costo),
--             "marginBps": int 1..9999|null (opcional: la CLAVE presente = cambia el margen propio; null = vuelve a la regla por defecto),
--             "priceCents": int > 0         (opcional: precio de lista MANUAL; sólo donde el precio no se deriva del costo),
--             "receivedQuantity": int > 0   (opcional: ingreso en unidades del ledger — gramos WEIGHT / unidades UNIT) }]
-- Cada fila trae al menos uno de los cuatro. Máximo 500 filas. Sin duplicados.
--
-- Precio manual: se acepta sólo si el precio NO se forma desde el costo con el margen EFECTIVO de la fila (después de aplicar el margen y
-- el costo de la propia fila): categoría excluida sin margen propio (MANUAL), organización sin margen (NO_MARGIN) o producto sin costo.
-- Con costo y margen efectivo (propio o global) el precio es automático y escribir uno se rechaza (no se crea una excepción ambigua).
-- Escribe una vigencia nueva en product_prices (cierra la anterior); nunca actualiza una fila. Si el precio global ya es ese, no hace nada;
-- si hay un precio global programado a futuro, se rechaza con un mensaje claro (no se pisa).
--
-- Ingreso: sucursal = organizations.production_branch_id (sin ella el lote se rechaza ENTERO); el producto tiene que estar habilitado ahí
-- (surtido). Usa record_stock_operation('PURCHASE') (tipo canónico de compra/recepción): un movimiento por producto, nunca fija el stock.
--
-- Devuelve: applied, costsSaved, costUnchanged, marginsChanged, repriced, priceUnchanged, manualPrices, scheduledPrice, branchOverrides,
-- stockMovements, stockOperationIds, replayed.
create function public.apply_pricing_receipt(
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
  current_organization_id uuid := app_private.require_permission('prices.write');
  production_branch uuid;
  request_hash text;
  existing record;
  inserted integer;
  item jsonb;
  item_product uuid;
  item_name text;
  item_cost bigint;
  item_price bigint;
  item_qty bigint;
  has_margin boolean;
  item_margin integer;
  has_qty boolean := false;
  current_cost bigint;
  cost_now bigint;
  current_price bigint;
  eff record;
  margin_outcome jsonb;
  outcome text;
  price_touched boolean;
  at_time timestamptz := now();
  stock_items jsonb := '[]'::jsonb;
  stock_chunk jsonb := '[]'::jsonb;
  stock_ids jsonb := '[]'::jsonb;
  stock_count integer := 0;
  op_id uuid;
  applied integer := 0;
  costs_saved integer := 0;
  cost_unchanged integer := 0;
  margins_changed integer := 0;
  repriced integer := 0;
  price_unchanged integer := 0;
  manual_prices integer := 0;
  scheduled integer := 0;
  overrides integer := 0;
  receipt_result jsonb;
begin
  if p_request_key is null then
    raise exception 'Falta la clave de la operación' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'Debe enviar entre 1 y 500 productos' using errcode = '22023';
  end if;

  -- 1. Forma de cada fila (antes de escribir nada, para que el error nombre la causa y no falle a mitad de camino).
  for item in select * from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(item) <> 'object' or jsonb_typeof(item -> 'productId') is distinct from 'string'
       or (item ->> 'productId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Los cambios son inválidos' using errcode = '22023';
    end if;
    if not (item ? 'costCents' or item ? 'marginBps' or item ? 'priceCents' or item ? 'receivedQuantity') then
      raise exception 'Una fila no trae ningún cambio' using errcode = '22023';
    end if;
    if item ? 'costCents' and (jsonb_typeof(item -> 'costCents') is distinct from 'number'
       or (item ->> 'costCents') !~ '^[0-9]{1,15}$' or (item ->> 'costCents')::numeric <= 0) then
      raise exception 'El costo tiene que ser un importe mayor a cero' using errcode = '22023';
    end if;
    if item ? 'priceCents' and (jsonb_typeof(item -> 'priceCents') is distinct from 'number'
       or (item ->> 'priceCents') !~ '^[0-9]{1,15}$' or (item ->> 'priceCents')::numeric <= 0) then
      raise exception 'El precio tiene que ser un importe mayor a cero' using errcode = '22023';
    end if;
    if item ? 'receivedQuantity' and (jsonb_typeof(item -> 'receivedQuantity') is distinct from 'number'
       or (item ->> 'receivedQuantity') !~ '^[0-9]{1,15}$' or (item ->> 'receivedQuantity')::numeric <= 0) then
      raise exception 'La cantidad recibida tiene que ser mayor a cero' using errcode = '22023';
    end if;
    if item ? 'marginBps' and jsonb_typeof(item -> 'marginBps') <> 'null' and (jsonb_typeof(item -> 'marginBps') <> 'number'
       or (item ->> 'marginBps') !~ '^[0-9]{1,5}$' or (item ->> 'marginBps')::integer not between 1 and 9999) then
      raise exception 'El margen personalizado tiene que ser mayor a 0 %% y menor a 100 %%' using errcode = '22023';
    end if;
    if item ? 'receivedQuantity' then has_qty := true; end if;
  end loop;
  if (select count(distinct (i ->> 'productId')) from jsonb_array_elements(p_items) i) <> jsonb_array_length(p_items) then
    raise exception 'Un producto no puede venir dos veces en la misma carga' using errcode = '22023';
  end if;

  -- 2. Todos los productos son de esta organización, activos y de venta (el aislamiento por tenant lo pone el filtro de organización).
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where not exists (
      select 1 from public.products p
      where p.id = (i ->> 'productId')::uuid and p.organization_id = current_organization_id and p.active
        and p.inventory_role in ('SELLABLE', 'BOTH')
    )
  ) then
    raise exception 'Uno de los productos enviados no existe, está inactivo o no es un producto de venta' using errcode = '42501';
  end if;

  -- 3. Ingreso de mercadería: sucursal productiva configurada, permiso de stock y producto habilitado en esa sucursal.
  if has_qty then
    perform app_private.require_permission('stock.write');
    select o.production_branch_id into production_branch from public.organizations o where o.id = current_organization_id;
    if production_branch is null then
      raise exception 'Configurá la sucursal productiva (Desposte) antes de registrar el ingreso de mercadería' using errcode = '22023';
    end if;
    if not app_private.can_access_branch(current_organization_id, production_branch, 'stock.write') then
      raise exception 'No tenés permiso para registrar stock en la sucursal productiva' using errcode = '42501';
    end if;
    select p.name into item_name
    from jsonb_array_elements(p_items) i
    join public.products p on p.id = (i ->> 'productId')::uuid and p.organization_id = current_organization_id
    where i ? 'receivedQuantity'
      and not exists (
        select 1 from public.branch_product_assortment a
        where a.organization_id = current_organization_id and a.branch_id = production_branch and a.product_id = p.id
      )
    order by p.name limit 1;
    if item_name is not null then
      raise exception '% no se vende en la sucursal productiva: habilitalo en Administrar antes de registrar su ingreso', item_name using errcode = '22023';
    end if;
  end if;

  -- 4. Idempotencia: la misma clave ya aplicada devuelve el resultado guardado SIN volver a escribir (doble click, reintento de red).
  --    Con dos pedidos simultáneos con la misma clave, el segundo espera al primero (índice único) y después ve su fila.
  request_hash := md5(p_items::text);
  insert into public.pricing_receipt_requests (organization_id, request_key, payload_hash, created_by)
  values (current_organization_id, p_request_key, request_hash, auth.uid())
  on conflict (organization_id, request_key) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then
    select r.payload_hash, r.result into existing
    from public.pricing_receipt_requests r
    where r.organization_id = current_organization_id and r.request_key = p_request_key;
    if existing.payload_hash <> request_hash then
      raise exception 'Esta operación ya se registró con otros datos: recargá la pantalla' using errcode = '22023';
    end if;
    return coalesce(existing.result, '{}'::jsonb) || jsonb_build_object('replayed', true);
  end if;

  -- 5. Aplicar fila por fila con los helpers canónicos. Cualquier excepción revierte TODO el lote (incluida la clave de idempotencia).
  for item in select * from jsonb_array_elements(p_items)
  loop
    item_product := (item ->> 'productId')::uuid;
    select p.name into item_name from public.products p where p.id = item_product;
    item_cost := case when item ? 'costCents' then (item ->> 'costCents')::bigint end;
    item_price := case when item ? 'priceCents' then (item ->> 'priceCents')::bigint end;
    item_qty := case when item ? 'receivedQuantity' then (item ->> 'receivedQuantity')::bigint end;
    has_margin := item ? 'marginBps';
    item_margin := case when has_margin and jsonb_typeof(item -> 'marginBps') = 'number' then (item ->> 'marginBps')::integer end;
    price_touched := false;

    -- Margen propio primero: con costo en la misma fila NO reprecia (el costo forma el precio una sola vez con el margen nuevo).
    if has_margin then
      margin_outcome := public.set_product_custom_margin(item_product, item_margin, item_cost is null);
      margins_changed := margins_changed + 1;
      if margin_outcome ->> 'outcome' = 'REPRICED' then
        repriced := repriced + 1;
        price_touched := true;
      elsif margin_outcome ->> 'outcome' = 'SCHEDULED' then
        scheduled := scheduled + 1;
      elsif margin_outcome ->> 'outcome' = 'UNCHANGED' then
        price_touched := true;
      end if;
    end if;

    -- Costo: una vigencia nueva; con margen efectivo forma el precio en la misma operación (app_private.apply_product_cost).
    if item_cost is not null then
      select pc.cost_cents into current_cost
      from public.product_costs pc
      where pc.organization_id = current_organization_id and pc.product_id = item_product
        and pc.valid_from <= at_time and (pc.valid_to is null or pc.valid_to > at_time)
      order by pc.valid_from desc limit 1;
      if current_cost is not null and current_cost = item_cost then
        cost_unchanged := cost_unchanged + 1;
      else
        select a.price_outcome into outcome
        from app_private.apply_product_cost(current_organization_id, item_product, item_cost, at_time, auth.uid()) a;
        costs_saved := costs_saved + 1;
        if outcome = 'REPRICED' then repriced := repriced + 1; price_touched := true;
        elsif outcome = 'UNCHANGED' then price_unchanged := price_unchanged + 1; price_touched := true;
        elsif outcome = 'SCHEDULED' then scheduled := scheduled + 1;
        end if;
      end if;
    end if;

    -- Precio MANUAL: sólo donde el precio no se forma desde costo + margen (con el estado final de ESTA fila).
    if item_price is not null then
      select * into eff from app_private.effective_margin(current_organization_id, item_product);
      select pc.cost_cents into cost_now
      from public.product_costs pc
      where pc.organization_id = current_organization_id and pc.product_id = item_product
        and pc.valid_from <= clock_timestamp() and (pc.valid_to is null or pc.valid_to > clock_timestamp())
      order by pc.valid_from desc limit 1;
      if eff.source in ('CUSTOM', 'GLOBAL') and coalesce(cost_now, 0) > 0 then
        raise exception '%: el precio se calcula desde el costo y el margen; para cambiarlo modificá el costo o el margen' , item_name using errcode = '22023';
      end if;
      if exists (
        select 1 from public.product_prices pp
        where pp.organization_id = current_organization_id and pp.product_id = item_product and pp.branch_id is null
          and pp.valid_from > clock_timestamp()
      ) then
        raise exception '%: tiene un precio programado a futuro; cambialo desde Administrar', item_name using errcode = '22023';
      end if;
      select pp.price_cents into current_price
      from public.product_prices pp
      where pp.organization_id = current_organization_id and pp.product_id = item_product and pp.branch_id is null
        and pp.valid_from <= clock_timestamp() and (pp.valid_to is null or pp.valid_to > clock_timestamp())
      order by pp.valid_from desc limit 1;
      if current_price is not null and current_price = item_price then
        price_unchanged := price_unchanged + 1;
      else
        perform app_private.set_price_history(current_organization_id, item_product, item_price, clock_timestamp(), auth.uid());
        manual_prices := manual_prices + 1;
      end if;
      price_touched := true;
    end if;

    -- Un precio vigente de sucursal sigue ganando sobre el global recién escrito: se informa (no se toca).
    if price_touched and exists (
      select 1 from public.product_prices pp
      where pp.organization_id = current_organization_id and pp.product_id = item_product and pp.branch_id is not null
        and pp.valid_from <= clock_timestamp() and (pp.valid_to is null or pp.valid_to > clock_timestamp())
    ) then
      overrides := overrides + 1;
    end if;

    if item_qty is not null then
      stock_items := stock_items || jsonb_build_array(jsonb_build_object('product_id', item_product, 'quantity_grams', item_qty));
    end if;
    applied := applied + 1;
  end loop;

  -- 6. Ingreso al ledger (tipo canónico PURCHASE): un movimiento por producto, en lotes de hasta 100 (límite de record_stock_operation).
  for i in 0 .. coalesce(jsonb_array_length(stock_items), 0) - 1
  loop
    stock_chunk := stock_chunk || jsonb_build_array(stock_items -> i);
    stock_count := stock_count + 1;
    if jsonb_array_length(stock_chunk) = 100 or i = jsonb_array_length(stock_items) - 1 then
      op_id := public.record_stock_operation(
        production_branch, 'PURCHASE', stock_chunk, null, null, 'Ingreso desde carga de costos (remito)', now()
      );
      stock_ids := stock_ids || to_jsonb(op_id);
      stock_chunk := '[]'::jsonb;
    end if;
  end loop;

  receipt_result := jsonb_build_object(
    'applied', applied, 'costsSaved', costs_saved, 'costUnchanged', cost_unchanged, 'marginsChanged', margins_changed,
    'repriced', repriced, 'priceUnchanged', price_unchanged, 'manualPrices', manual_prices, 'scheduledPrice', scheduled,
    'branchOverrides', overrides, 'stockMovements', stock_count, 'stockOperationIds', stock_ids, 'replayed', false
  );
  update public.pricing_receipt_requests r set result = receipt_result
  where r.organization_id = current_organization_id and r.request_key = p_request_key;
  perform app_private.write_audit(current_organization_id, production_branch, 'PRICING_RECEIPT_APPLIED', 'pricing_receipt_requests', p_request_key, null, receipt_result);
  return receipt_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------------------------
revoke all on function public.list_pricing_rows(text, uuid[], integer, integer) from public, anon;
grant execute on function public.list_pricing_rows(text, uuid[], integer, integer) to authenticated;
revoke all on function public.apply_pricing_receipt(uuid, jsonb) from public, anon;
grant execute on function public.apply_pricing_receipt(uuid, jsonb) to authenticated;

commit;
