begin;

-- Distribución a supermercados (D-093), parte 2 — conciliación, devoluciones y estadísticas. Se apoya en 202611120097 y NO la modifica.
--
--   * Conciliación: lo que el supermercado informa se registra de DOS maneras que nunca se mezclan: paquetes identificados individualmente como vendidos
--     (`distribution_delivery_items.outcome = SOLD_REPORTED`, el paquete pasa a SOLD_EXTERNAL) y ventas informadas sólo por CANTIDAD
--     (`distribution_quantity_reports`, una cifra por producto: NO se inventa qué paquetes fueron). Los pendientes son lo que queda sin explicar.
--   * Devoluciones: un paquete devuelto NUNCA vuelve solo a estar disponible. Recorre PENDING_RECEIPT → IN_QUARANTINE → PENDING_INSPECTION y sólo una decisión
--     explícita de quien tiene `distribution.approve_reentry` lo reingresa (APPROVED: usuario, fecha y motivo; sin vencer, envase intacto y conservación
--     verificada — también garantizado por un check de la tabla), lo rechaza o lo descarta. Las fechas del paquete no se tocan (`vacuum_packages` es inmutable).
--   * Inventario: sólo el reingreso aprobado mueve stock (DISTRIBUTION_RETURN, +gramos reales, un movimiento por devolución, índice único). Rechazar o
--     descartar no mueve stock: la mercadería ya había salido al despachar.

-- ---------------------------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------------------------
alter table public.distribution_delivery_items add constraint distribution_delivery_items_id_org_uq unique (id, organization_id);

alter table public.distribution_deliveries
  add column reconciled_at timestamptz,
  add column reconciled_by uuid references public.profiles(id) on delete set null,
  add column reconciliation_note text check (reconciliation_note is null or char_length(btrim(reconciliation_note)) between 3 and 500),
  add column reconciliation_pending integer;

create table public.distribution_quantity_reports (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  delivery_id uuid not null,
  product_id uuid not null,
  quantity integer not null check (quantity > 0),
  reported_on date not null,
  note text check (note is null or char_length(btrim(note)) between 1 and 300),
  request_key uuid,
  reported_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (delivery_id, organization_id) references public.distribution_deliveries(id, organization_id) on delete restrict,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict
);
create unique index distribution_quantity_reports_key_uq on public.distribution_quantity_reports (organization_id, request_key, product_id) where request_key is not null;
create index distribution_quantity_reports_delivery_idx on public.distribution_quantity_reports (delivery_id);

create table public.distribution_returns (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  delivery_id uuid not null,
  item_id uuid not null,
  package_id uuid not null,
  request_key uuid,
  status text not null default 'PENDING_RECEIPT' check (status in ('PENDING_RECEIPT', 'IN_QUARANTINE', 'PENDING_INSPECTION', 'APPROVED', 'REJECTED', 'DISCARDED')),
  reason text not null check (reason in ('UNSOLD', 'NEAR_EXPIRY', 'DAMAGED', 'CLIENT_REQUEST', 'OTHER')),
  reason_note text check (reason_note is null or char_length(btrim(reason_note)) between 1 and 300),
  returned_on date not null,
  -- Venta mayorista firme devuelta: queda pendiente una nota de crédito (no se emite acá: no hay facturación en esta etapa).
  credit_required boolean not null default false,
  packaging_state text check (packaging_state is null or packaging_state in ('INTACT', 'VACUUM_LOST', 'DAMAGED', 'OPEN')),
  conservation_verified boolean,
  conservation_note text check (conservation_note is null or char_length(btrim(conservation_note)) between 1 and 300),
  registered_by uuid references public.profiles(id) on delete set null,
  registered_at timestamptz not null default now(),
  received_by uuid references public.profiles(id) on delete set null,
  received_at timestamptz,
  inspection_started_by uuid references public.profiles(id) on delete set null,
  inspection_started_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  decision_reason text check (decision_reason is null or char_length(btrim(decision_reason)) between 3 and 300),
  unique (id, organization_id),
  foreign key (delivery_id, organization_id) references public.distribution_deliveries(id, organization_id) on delete restrict,
  foreign key (item_id, organization_id) references public.distribution_delivery_items(id, organization_id) on delete restrict,
  foreign key (package_id, organization_id) references public.vacuum_packages(id, organization_id) on delete restrict,
  check ((status <> 'PENDING_RECEIPT') = (received_at is not null)),
  check ((status in ('APPROVED', 'REJECTED', 'DISCARDED')) = (decided_at is not null and decision_reason is not null)),
  -- Garantía de la base: ningún camino puede aprobar el reingreso de un paquete con el envase dañado o sin conservación verificada.
  check (status <> 'APPROVED' or (packaging_state = 'INTACT' and conservation_verified is true))
);
-- Un paquete tiene a lo sumo UNA devolución en curso.
create unique index distribution_returns_open_package_uq on public.distribution_returns (package_id) where status in ('PENDING_RECEIPT', 'IN_QUARANTINE', 'PENDING_INSPECTION', 'REJECTED');
create unique index distribution_returns_key_uq on public.distribution_returns (organization_id, request_key, package_id) where request_key is not null;
create index distribution_returns_status_idx on public.distribution_returns (organization_id, status, registered_at desc);
create index distribution_returns_delivery_idx on public.distribution_returns (delivery_id);
create trigger distribution_returns_audit after insert or update on public.distribution_returns for each row execute function app_private.audit_row_change();

alter table public.stock_movements add column distribution_return_id uuid;
alter table public.stock_movements
  add constraint stock_movements_distribution_return_fk foreign key (distribution_return_id, organization_id) references public.distribution_returns(id, organization_id) on delete restrict;
alter table public.stock_movements add constraint stock_movements_distribution_return_link_check check ((type = 'DISTRIBUTION_RETURN') = (distribution_return_id is not null));
-- Un solo reingreso de stock por devolución: aprobar dos veces no duplica el movimiento.
create unique index stock_movements_distribution_return_uq on public.stock_movements (distribution_return_id) where type = 'DISTRIBUTION_RETURN';
comment on column public.stock_movements.distribution_return_id is 'Set only for DISTRIBUTION_RETURN rows written by decide_distribution_return (APPROVE).';

alter table public.distribution_quantity_reports enable row level security;
alter table public.distribution_returns enable row level security;
create policy distribution_quantity_reports_select on public.distribution_quantity_reports for select to authenticated
using (app_private.has_permission(organization_id, 'distribution.read'));
create policy distribution_returns_select on public.distribution_returns for select to authenticated
using (app_private.has_permission(organization_id, 'distribution.read'));
revoke all on table public.distribution_quantity_reports, public.distribution_returns from public, anon, authenticated;
grant select on table public.distribution_quantity_reports, public.distribution_returns to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Helpers privados
-- ---------------------------------------------------------------------------------------------
create function app_private.dist_today(p_org uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$ select (clock_timestamp() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'UTC'))::date $$;

-- Entrega CONFIRMADA (bloqueada) de la organización y visible para el usuario.
create function app_private.dist_confirmed_for_update(p_org uuid, p_delivery_id uuid)
returns public.distribution_deliveries
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d public.distribution_deliveries%rowtype;
begin
  select * into v_d from public.distribution_deliveries d where d.id = p_delivery_id and d.organization_id = p_org for update;
  if not found then raise exception 'Entrega no encontrada' using errcode = '42501'; end if;
  perform app_private.require_visible_branch(p_org, v_d.origin_branch_id);
  if v_d.status <> 'CONFIRMED' then raise exception 'La entrega % no está confirmada', app_private.dist_number_label(v_d.number) using errcode = '22023'; end if;
  return v_d;
end;
$$;

-- Cantidades por producto de una entrega: entregados, vendidos (firme, identificados, inferidos por cantidad), devueltos, devoluciones por recibir y PENDIENTES.
-- Pendiente = entregado − vendido firme − vendido identificado − vendido por cantidad − devuelto − devolución registrada y por recibir.
create function app_private.dist_product_counts(p_org uuid, p_delivery_id uuid)
returns table (product_id uuid, product_name text, delivered integer, sold_firm integer, sold_identified integer, sold_inferred integer, returned integer, return_pending integer, pending integer)
language sql
stable
security definer
set search_path = ''
as $$
  with items as (
    select p.product_id, max(p.product_name_snapshot) as name, count(*) as delivered,
      count(*) filter (where i.outcome = 'SOLD_FIRM') as sold_firm,
      count(*) filter (where i.outcome = 'SOLD_REPORTED') as sold_identified,
      count(*) filter (where i.outcome = 'RETURNED') as returned
    from public.distribution_delivery_items i join public.vacuum_packages p on p.id = i.package_id and p.organization_id = i.organization_id
    where i.delivery_id = p_delivery_id and i.organization_id = p_org group by p.product_id
  ), pend as (
    select p.product_id, count(*) as n
    from public.distribution_returns r
    join public.distribution_delivery_items i on i.id = r.item_id and i.organization_id = r.organization_id
    join public.vacuum_packages p on p.id = r.package_id and p.organization_id = r.organization_id
    where r.delivery_id = p_delivery_id and r.organization_id = p_org and r.status = 'PENDING_RECEIPT' and i.outcome = 'PENDING' group by p.product_id
  ), inf as (
    select q.product_id, sum(q.quantity) as n from public.distribution_quantity_reports q where q.delivery_id = p_delivery_id and q.organization_id = p_org group by q.product_id
  )
  select it.product_id, it.name, it.delivered::integer, it.sold_firm::integer, it.sold_identified::integer, coalesce(inf.n, 0)::integer, it.returned::integer, coalesce(pend.n, 0)::integer,
    (it.delivered - it.sold_firm - it.sold_identified - coalesce(inf.n, 0) - it.returned - coalesce(pend.n, 0))::integer
  from items it left join pend on pend.product_id = it.product_id left join inf on inf.product_id = it.product_id
$$;

create function app_private.dist_assert_not_reconciled(p_d public.distribution_deliveries)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_d.reconciled_at is not null then
    raise exception 'La conciliación de la entrega % ya está cerrada', app_private.dist_number_label(p_d.number) using errcode = '22023';
  end if;
end;
$$;

-- Marca UN paquete como vendido (identificado) por el supermercado. Devuelve false si ya estaba informado (idempotente).
create function app_private.dist_report_sold(p_org uuid, p_d public.distribution_deliveries, p_package_id uuid, p_sold_on date)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item public.distribution_delivery_items%rowtype;
  v_state public.vacuum_package_state%rowtype;
  v_code text;
begin
  select * into v_item from public.distribution_delivery_items i where i.delivery_id = p_d.id and i.package_id = p_package_id and i.organization_id = p_org for update;
  select l.code into v_code from public.vacuum_package_logistics l where l.package_id = p_package_id;
  if v_item.id is null then raise exception 'El paquete % no pertenece a esta entrega', coalesce(v_code, p_package_id::text) using errcode = '22023'; end if;
  if v_item.outcome = 'SOLD_REPORTED' then return false; end if;
  if v_item.outcome = 'SOLD_FIRM' then raise exception 'El paquete % ya es parte de una venta mayorista firme', coalesce(v_code, p_package_id::text) using errcode = '22023'; end if;
  if v_item.outcome = 'RETURNED' or v_item.closed_at is not null then raise exception 'El paquete % ya volvió a Central', coalesce(v_code, p_package_id::text) using errcode = '22023'; end if;
  if exists (select 1 from public.distribution_returns r where r.item_id = v_item.id and r.status = 'PENDING_RECEIPT') then
    raise exception 'El paquete % tiene una devolución registrada', coalesce(v_code, p_package_id::text) using errcode = '22023';
  end if;
  select * into v_state from public.vacuum_package_state s where s.package_id = p_package_id for update;
  if v_state.status <> 'DISPATCHED' or v_state.distribution_delivery_id is distinct from p_d.id then
    raise exception 'El paquete % no figura despachado en esta entrega (estado: %)', coalesce(v_code, p_package_id::text), v_state.status using errcode = '22023';
  end if;
  update public.distribution_delivery_items set outcome = 'SOLD_REPORTED', sold_on = p_sold_on, sold_reported_by = auth.uid(), sold_reported_at = now(), closed_at = now() where id = v_item.id;
  update public.vacuum_package_state set status = 'SOLD_EXTERNAL', updated_at = now() where package_id = p_package_id;
  perform app_private.dist_package_event(p_org, p_package_id, p_d.origin_branch_id, 'SOLD_EXTERNAL', app_private.dist_number_label(p_d.number));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: conciliación
-- ---------------------------------------------------------------------------------------------
create function public.report_delivery_sales(p_delivery_id uuid, p_package_ids uuid[], p_sold_on date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_d public.distribution_deliveries%rowtype;
  v_day date;
  v_id uuid;
  v_reported integer := 0;
  v_already integer := 0;
begin
  if p_package_ids is null or cardinality(p_package_ids) = 0 or cardinality(p_package_ids) > 500 then raise exception 'Elegí entre 1 y 500 paquetes' using errcode = '22023'; end if;
  v_d := app_private.dist_confirmed_for_update(v_org, p_delivery_id);
  perform app_private.dist_assert_not_reconciled(v_d);
  v_day := coalesce(p_sold_on, app_private.dist_today(v_org));
  if v_day < v_d.delivery_date or v_day > app_private.dist_today(v_org) then raise exception 'La fecha de venta tiene que estar entre la entrega y hoy' using errcode = '22023'; end if;
  foreach v_id in array (select array_agg(distinct x) from unnest(p_package_ids) x) loop
    if app_private.dist_report_sold(v_org, v_d, v_id, v_day) then v_reported := v_reported + 1; else v_already := v_already + 1; end if;
  end loop;
  return jsonb_build_object('reported', v_reported, 'alreadyReported', v_already);
end;
$$;

create function public.report_delivery_sales_by_codes(p_delivery_id uuid, p_codes text[], p_sold_on date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_code text;
  v_ids uuid[] := '{}';
  v_id uuid;
begin
  if p_codes is null or cardinality(p_codes) = 0 or cardinality(p_codes) > 500 then raise exception 'Ingresá entre 1 y 500 códigos' using errcode = '22023'; end if;
  foreach v_code in array p_codes loop
    if not app_private.logistic_code_is_valid(app_private.logistic_code_normalize(v_code)) then raise exception 'El código % no es un identificador logístico válido', v_code using errcode = '22023'; end if;
    select l.package_id into v_id from public.vacuum_package_logistics l where l.organization_id = v_org and l.code = app_private.logistic_code_normalize(v_code);
    if v_id is null then raise exception 'No se encontró ningún paquete con el código %', v_code using errcode = '22023'; end if;
    v_ids := v_ids || v_id;
  end loop;
  return public.report_delivery_sales(p_delivery_id, v_ids, p_sold_on);
end;
$$;

-- Ventas informadas SÓLO por cantidad (el supermercado no identifica paquetes). Es una estimación de conciliación: no marca ningún paquete.
create function public.report_delivery_quantity_sales(p_delivery_id uuid, p_items jsonb, p_reported_on date default null, p_note text default null, p_request_key uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_d public.distribution_deliveries%rowtype;
  v_day date;
  v_item jsonb;
  v_product uuid;
  v_qty integer;
  v_pending integer;
  v_recorded integer := 0;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then raise exception 'Indicá los productos y cantidades' using errcode = '22023'; end if;
  v_d := app_private.dist_confirmed_for_update(v_org, p_delivery_id);
  perform app_private.dist_assert_not_reconciled(v_d);
  if v_d.commercial_mode = 'WHOLESALE' then raise exception 'Una venta mayorista firme no se concilia por cantidad: ya está vendida' using errcode = '22023'; end if;
  v_day := coalesce(p_reported_on, app_private.dist_today(v_org));
  if v_day < v_d.delivery_date or v_day > app_private.dist_today(v_org) then raise exception 'La fecha del informe tiene que estar entre la entrega y hoy' using errcode = '22023'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      v_product := (v_item ->> 'productId')::uuid;
      v_qty := (v_item ->> 'quantity')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Producto o cantidad inválidos' using errcode = '22023';
    end;
    if v_product is null or v_qty is null or v_qty < 1 or v_qty > 1000 then raise exception 'Producto o cantidad inválidos' using errcode = '22023'; end if;
    -- Idempotencia: el mismo pedido (clave + producto) ya registrado no se vuelve a sumar.
    if p_request_key is not null and exists (select 1 from public.distribution_quantity_reports q where q.organization_id = v_org and q.request_key = p_request_key and q.product_id = v_product) then continue; end if;
    select c.pending into v_pending from app_private.dist_product_counts(v_org, v_d.id) c where c.product_id = v_product;
    if v_pending is null then raise exception 'Ese producto no está en la entrega' using errcode = '22023'; end if;
    if v_qty > v_pending then raise exception 'Se informaron % vendidos pero sólo hay % sin conciliar de ese producto', v_qty, greatest(v_pending, 0) using errcode = '22023'; end if;
    insert into public.distribution_quantity_reports (organization_id, delivery_id, product_id, quantity, reported_on, note, request_key, reported_by)
    values (v_org, v_d.id, v_product, v_qty, v_day, v_note, p_request_key, auth.uid());
    v_recorded := v_recorded + 1;
  end loop;
  return jsonb_build_object('recorded', v_recorded);
end;
$$;

create function public.get_delivery_reconciliation(p_delivery_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_d public.distribution_deliveries%rowtype;
  v_today date;
  v_products jsonb;
  v_totals jsonb;
begin
  select * into v_d from public.distribution_deliveries d where d.id = p_delivery_id and d.organization_id = v_org and (v_vis is null or d.origin_branch_id = any(v_vis));
  if not found then return null; end if;
  v_today := app_private.dist_today(v_org);
  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', c.product_id, 'productName', c.product_name, 'delivered', c.delivered, 'soldFirm', c.sold_firm, 'soldIdentified', c.sold_identified, 'soldInferred', c.sold_inferred,
    'returned', c.returned, 'returnPending', c.return_pending, 'pending', c.pending, 'overReported', c.pending < 0,
    'estimatedInferredCents', (
      select (c.sold_inferred * coalesce(avg(i.unit_cents), 0))::bigint::text
      from public.distribution_delivery_items i join public.vacuum_packages p on p.id = i.package_id and p.organization_id = i.organization_id
      where i.delivery_id = v_d.id and p.product_id = c.product_id
    )
  ) order by lower(c.product_name)), '[]'::jsonb) into v_products from app_private.dist_product_counts(v_org, v_d.id) c;
  select jsonb_build_object(
    'delivered', coalesce(sum(c.delivered), 0), 'soldFirm', coalesce(sum(c.sold_firm), 0), 'soldIdentified', coalesce(sum(c.sold_identified), 0), 'soldInferred', coalesce(sum(c.sold_inferred), 0),
    'returned', coalesce(sum(c.returned), 0), 'returnPending', coalesce(sum(c.return_pending), 0), 'pending', coalesce(sum(c.pending), 0)
  ) into v_totals from app_private.dist_product_counts(v_org, v_d.id) c;
  return jsonb_build_object(
    'delivery', app_private.distribution_delivery_json(v_d, false),
    'products', v_products, 'totals', v_totals,
    'packages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'packageId', i.package_id, 'logisticCode', l.code, 'productId', p.product_id, 'productName', p.product_name_snapshot, 'weightGrams', i.weight_grams, 'lot', p.lot,
        'expiresOn', p.expires_on, 'expired', p.expires_on < v_today, 'unitCents', i.unit_cents::text, 'outcome', i.outcome, 'soldOn', i.sold_on,
        'returnId', r.id, 'returnStatus', r.status
      ) order by p.product_name_snapshot, p.lot)
      from public.distribution_delivery_items i
      join public.vacuum_packages p on p.id = i.package_id and p.organization_id = i.organization_id
      left join public.vacuum_package_logistics l on l.package_id = p.id
      left join lateral (select x.id, x.status from public.distribution_returns x where x.item_id = i.id order by x.registered_at desc limit 1) r on true
      where i.delivery_id = v_d.id
    ), '[]'::jsonb),
    'quantityReports', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'productId', q.product_id, 'productName', pr.name, 'quantity', q.quantity, 'reportedOn', q.reported_on, 'note', q.note, 'createdAt', q.created_at) order by q.created_at)
      from public.distribution_quantity_reports q join public.products pr on pr.id = q.product_id and pr.organization_id = q.organization_id where q.delivery_id = v_d.id
    ), '[]'::jsonb),
    'closure', jsonb_build_object('closedAt', v_d.reconciled_at, 'closedBy', (select pr.display_name from public.profiles pr where pr.id = v_d.reconciled_by), 'note', v_d.reconciliation_note, 'pendingAtClose', v_d.reconciliation_pending)
  );
end;
$$;

-- Cierra la conciliación de la entrega. Con paquetes sin explicar hace falta una nota (queda la cantidad como diferencia).
create function public.close_delivery_reconciliation(p_delivery_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_d public.distribution_deliveries%rowtype;
  v_pending integer;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v_d := app_private.dist_confirmed_for_update(v_org, p_delivery_id);
  if v_d.reconciled_at is not null then return jsonb_build_object('closedAt', v_d.reconciled_at, 'pendingAtClose', v_d.reconciliation_pending, 'alreadyClosed', true); end if;
  select coalesce(sum(c.pending), 0)::integer into v_pending from app_private.dist_product_counts(v_org, v_d.id) c;
  if v_pending <> 0 and (v_note is null or char_length(v_note) < 3) then
    raise exception 'Quedan % paquetes sin conciliar: explicá la diferencia en una nota para cerrar', v_pending using errcode = '22023';
  end if;
  update public.distribution_deliveries set reconciled_at = now(), reconciled_by = auth.uid(), reconciliation_note = left(v_note, 500), reconciliation_pending = v_pending where id = v_d.id;
  return jsonb_build_object('closedAt', now(), 'pendingAtClose', v_pending, 'alreadyClosed', false);
end;
$$;

-- Historial de reposiciones de un establecimiento: una fila por entrega confirmada con su resultado.
create function public.get_site_replenishment_history(p_site_id uuid, p_limit integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'numberLabel', app_private.dist_number_label(r.number), 'deliveryDate', r.delivery_date, 'commercialMode', r.commercial_mode,
      'delivered', r.delivered, 'soldConfirmed', r.sold_confirmed, 'soldInferred', r.sold_inferred, 'returned', r.returned, 'pending', r.delivered - r.sold_confirmed - r.sold_inferred - r.returned - r.return_pending,
      'returnPending', r.return_pending, 'totalCents', r.total_cents::text, 'closedAt', r.reconciled_at
    ) order by r.delivery_date desc, r.number desc)
    from (
      select d.id, d.number, d.delivery_date, d.commercial_mode, d.total_cents, d.reconciled_at,
        count(i.id) as delivered,
        count(i.id) filter (where i.outcome in ('SOLD_FIRM', 'SOLD_REPORTED')) as sold_confirmed,
        count(i.id) filter (where i.outcome = 'RETURNED') as returned,
        (select coalesce(sum(q.quantity), 0) from public.distribution_quantity_reports q where q.delivery_id = d.id) as sold_inferred,
        (select count(*) from public.distribution_returns x join public.distribution_delivery_items xi on xi.id = x.item_id where x.delivery_id = d.id and x.status = 'PENDING_RECEIPT' and xi.outcome = 'PENDING') as return_pending
      from public.distribution_deliveries d left join public.distribution_delivery_items i on i.delivery_id = d.id
      where d.organization_id = v_org and d.site_id = p_site_id and d.status = 'CONFIRMED' and (v_vis is null or d.origin_branch_id = any(v_vis))
      group by d.id
      order by d.delivery_date desc, d.number desc
      limit least(greatest(coalesce(p_limit, 12), 1), 60)
    ) r
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: devoluciones
-- ---------------------------------------------------------------------------------------------
-- Registra los paquetes que se retiran de un supermercado. El paquete sigue siendo del supermercado (DISPATCHED) hasta que se RECIBE en Central.
create function public.register_distribution_returns(p_delivery_id uuid, p_items jsonb, p_returned_on date default null, p_request_key uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_d public.distribution_deliveries%rowtype;
  v_day date;
  v_item jsonb;
  v_package uuid;
  v_code text;
  v_reason text;
  v_note text;
  v_it public.distribution_delivery_items%rowtype;
  v_state public.vacuum_package_state%rowtype;
  v_registered integer := 0;
  v_existing integer := 0;
  v_label text;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then raise exception 'Elegí los paquetes que se devuelven' using errcode = '22023'; end if;
  v_d := app_private.dist_confirmed_for_update(v_org, p_delivery_id);
  v_day := coalesce(p_returned_on, app_private.dist_today(v_org));
  if v_day < v_d.delivery_date or v_day > app_private.dist_today(v_org) then raise exception 'La fecha de devolución tiene que estar entre la entrega y hoy' using errcode = '22023'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_code := nullif(btrim(coalesce(v_item ->> 'code', '')), '');
    begin
      v_package := (v_item ->> 'packageId')::uuid;
    exception when invalid_text_representation then
      raise exception 'Paquete inválido' using errcode = '22023';
    end;
    if v_package is null and v_code is not null then
      select l.package_id into v_package from public.vacuum_package_logistics l where l.organization_id = v_org and l.code = app_private.logistic_code_normalize(v_code);
    end if;
    if v_package is null then raise exception 'Indicá el paquete (id o código logístico)' using errcode = '22023'; end if;
    v_reason := coalesce(v_item ->> 'reason', 'UNSOLD');
    if v_reason not in ('UNSOLD', 'NEAR_EXPIRY', 'DAMAGED', 'CLIENT_REQUEST', 'OTHER') then raise exception 'Motivo de devolución inválido' using errcode = '22023'; end if;
    v_note := nullif(btrim(coalesce(v_item ->> 'reasonNote', '')), '');
    if v_reason = 'OTHER' and v_note is null then raise exception 'Explicá el motivo de la devolución' using errcode = '22023'; end if;
    -- Idempotencia por pedido: el mismo paquete con la misma clave ya registrado.
    if p_request_key is not null and exists (select 1 from public.distribution_returns r where r.organization_id = v_org and r.request_key = p_request_key and r.package_id = v_package) then
      v_existing := v_existing + 1; continue;
    end if;
    select * into v_it from public.distribution_delivery_items i where i.delivery_id = v_d.id and i.package_id = v_package and i.organization_id = v_org for update;
    select l.code into v_label from public.vacuum_package_logistics l where l.package_id = v_package;
    if v_it.id is null then raise exception 'El paquete % no pertenece a esta entrega', coalesce(v_label, v_package::text) using errcode = '22023'; end if;
    if v_it.closed_at is not null or v_it.outcome in ('RETURNED', 'SOLD_REPORTED') then
      raise exception 'El paquete % ya no está en el supermercado (%)', coalesce(v_label, v_package::text), v_it.outcome using errcode = '22023';
    end if;
    select * into v_state from public.vacuum_package_state s where s.package_id = v_package for update;
    if v_state.status <> 'DISPATCHED' then raise exception 'El paquete % no figura despachado (estado: %)', coalesce(v_label, v_package::text), v_state.status using errcode = '22023'; end if;
    begin
      insert into public.distribution_returns (organization_id, delivery_id, item_id, package_id, request_key, reason, reason_note, returned_on, credit_required, registered_by)
      values (v_org, v_d.id, v_it.id, v_package, p_request_key, v_reason, v_note, v_day, v_it.outcome = 'SOLD_FIRM', auth.uid());
    exception when unique_violation then
      raise exception 'El paquete % ya tiene una devolución en curso', coalesce(v_label, v_package::text) using errcode = '22023';
    end;
    v_registered := v_registered + 1;
  end loop;
  return jsonb_build_object('registered', v_registered, 'alreadyRegistered', v_existing);
end;
$$;

-- Recepción en Central: el paquete entra en CUARENTENA (no es stock vendible). Se registra el estado del envase y la conservación observados.
create function public.receive_distribution_returns(p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.write');
  v_item jsonb;
  v_id uuid;
  v_r public.distribution_returns%rowtype;
  v_d public.distribution_deliveries%rowtype;
  v_packaging text;
  v_verified boolean;
  v_note text;
  v_received integer := 0;
  v_already integer := 0;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then raise exception 'Elegí las devoluciones a recibir' using errcode = '22023'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      v_id := (v_item ->> 'returnId')::uuid;
      v_verified := (v_item ->> 'conservationVerified')::boolean;
    exception when invalid_text_representation then
      raise exception 'Devolución inválida' using errcode = '22023';
    end;
    v_packaging := v_item ->> 'packagingState';
    v_note := nullif(btrim(coalesce(v_item ->> 'conservationNote', '')), '');
    if v_packaging is null or v_packaging not in ('INTACT', 'VACUUM_LOST', 'DAMAGED', 'OPEN') then raise exception 'Indicá el estado del envase' using errcode = '22023'; end if;
    if v_verified is null then raise exception 'Indicá si se pudieron verificar las condiciones de conservación' using errcode = '22023'; end if;
    select * into v_r from public.distribution_returns r where r.id = v_id and r.organization_id = v_org for update;
    if not found then raise exception 'Devolución no encontrada' using errcode = '42501'; end if;
    select * into v_d from public.distribution_deliveries d where d.id = v_r.delivery_id and d.organization_id = v_org;
    perform app_private.require_visible_branch(v_org, v_d.origin_branch_id);
    if v_r.status <> 'PENDING_RECEIPT' then v_already := v_already + 1; continue; end if;
    perform 1 from public.vacuum_package_state s where s.package_id = v_r.package_id for update;
    update public.vacuum_package_state set status = 'QUARANTINE', distribution_delivery_id = null, updated_at = now()
    where package_id = v_r.package_id and status = 'DISPATCHED' and distribution_delivery_id = v_r.delivery_id;
    if not found then raise exception 'El paquete de esta devolución no figura despachado' using errcode = '22023'; end if;
    update public.distribution_delivery_items set outcome = 'RETURNED', closed_at = now() where id = v_r.item_id;
    update public.distribution_returns set status = 'IN_QUARANTINE', received_by = auth.uid(), received_at = now(), packaging_state = v_packaging, conservation_verified = v_verified, conservation_note = left(v_note, 300)
    where id = v_r.id;
    perform app_private.dist_package_event(v_org, v_r.package_id, v_d.origin_branch_id, 'RETURN_RECEIVED', app_private.dist_number_label(v_d.number));
    v_received := v_received + 1;
  end loop;
  return jsonb_build_object('received', v_received, 'alreadyReceived', v_already);
end;
$$;

create function public.start_return_inspection(p_return_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.approve_reentry');
  v_r public.distribution_returns%rowtype;
begin
  select * into v_r from public.distribution_returns r where r.id = p_return_id and r.organization_id = v_org for update;
  if not found then raise exception 'Devolución no encontrada' using errcode = '42501'; end if;
  if v_r.status = 'PENDING_INSPECTION' then return jsonb_build_object('id', v_r.id, 'status', v_r.status, 'alreadyStarted', true); end if;
  if v_r.status <> 'IN_QUARANTINE' then raise exception 'Sólo se inspecciona un paquete recibido en cuarentena (estado: %)', v_r.status using errcode = '22023'; end if;
  update public.distribution_returns set status = 'PENDING_INSPECTION', inspection_started_by = auth.uid(), inspection_started_at = now() where id = v_r.id;
  return jsonb_build_object('id', v_r.id, 'status', 'PENDING_INSPECTION', 'alreadyStarted', false);
end;
$$;

-- Decisión sanitaria/comercial sobre un paquete devuelto: APPROVE (reingreso), REJECT o DISCARD. Siempre con motivo; queda usuario y fecha.
create function public.decide_distribution_return(
  p_return_id uuid,
  p_decision text,
  p_reason text,
  p_packaging_state text default null,
  p_conservation_verified boolean default null,
  p_conservation_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.approve_reentry');
  v_r public.distribution_returns%rowtype;
  v_d public.distribution_deliveries%rowtype;
  v_pkg public.vacuum_packages%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_packaging text;
  v_verified boolean;
  v_note text;
begin
  if p_decision not in ('APPROVE', 'REJECT', 'DISCARD') then raise exception 'Decisión inválida' using errcode = '22023'; end if;
  if v_reason is null or char_length(v_reason) < 3 then raise exception 'Indicá el motivo de la decisión' using errcode = '22023'; end if;
  if p_packaging_state is not null and p_packaging_state not in ('INTACT', 'VACUUM_LOST', 'DAMAGED', 'OPEN') then raise exception 'Estado de envase inválido' using errcode = '22023'; end if;
  select * into v_r from public.distribution_returns r where r.id = p_return_id and r.organization_id = v_org for update;
  if not found then raise exception 'Devolución no encontrada' using errcode = '42501'; end if;
  select * into v_d from public.distribution_deliveries d where d.id = v_r.delivery_id and d.organization_id = v_org;
  perform app_private.require_visible_branch(v_org, v_d.origin_branch_id);
  select * into v_pkg from public.vacuum_packages p where p.id = v_r.package_id and p.organization_id = v_org;

  -- Idempotencia: repetir una decisión ya tomada devuelve el resultado sin tocar nada.
  if (p_decision = 'APPROVE' and v_r.status = 'APPROVED') or (p_decision = 'REJECT' and v_r.status = 'REJECTED') or (p_decision = 'DISCARD' and v_r.status = 'DISCARDED') then
    return jsonb_build_object('id', v_r.id, 'status', v_r.status, 'alreadyDecided', true);
  end if;

  if p_decision = 'APPROVE' then
    if v_r.status not in ('IN_QUARANTINE', 'PENDING_INSPECTION') then raise exception 'Sólo se puede aprobar un paquete en cuarentena o en inspección (estado: %)', v_r.status using errcode = '22023'; end if;
    v_packaging := coalesce(p_packaging_state, v_r.packaging_state);
    v_verified := coalesce(p_conservation_verified, v_r.conservation_verified);
    v_note := coalesce(nullif(btrim(coalesce(p_conservation_note, '')), ''), v_r.conservation_note);
    if v_pkg.expires_on < app_private.dist_today(v_org) then raise exception 'El paquete venció el %: no se puede reingresar', to_char(v_pkg.expires_on, 'DD/MM/YYYY') using errcode = '22023'; end if;
    if v_packaging is distinct from 'INTACT' then raise exception 'El envase no está intacto (%): no se puede reingresar', coalesce(v_packaging, 'sin informar') using errcode = '22023'; end if;
    if v_verified is not true then raise exception 'Sin condiciones de conservación verificadas no se puede reingresar' using errcode = '22023'; end if;
    perform 1 from public.vacuum_package_state s where s.package_id = v_r.package_id for update;
    update public.vacuum_package_state set status = 'AVAILABLE', current_branch_id = v_d.origin_branch_id, distribution_delivery_id = null, updated_at = now()
    where package_id = v_r.package_id and status = 'QUARANTINE';
    if not found then raise exception 'El paquete no está en cuarentena' using errcode = '22023'; end if;
    insert into public.stock_movements (organization_id, branch_id, product_id, type, quantity_grams, reason, profile_id, occurred_at, distribution_return_id)
    values (v_org, v_d.origin_branch_id, v_pkg.product_id, 'DISTRIBUTION_RETURN', v_pkg.weight_grams, left('Reingreso aprobado de ' || app_private.dist_number_label(v_d.number) || ': ' || v_reason, 500), auth.uid(), now(), v_r.id);
    update public.distribution_returns set status = 'APPROVED', packaging_state = v_packaging, conservation_verified = v_verified, conservation_note = left(v_note, 300),
      decided_by = auth.uid(), decided_at = now(), decision_reason = left(v_reason, 300) where id = v_r.id;
    perform app_private.dist_package_event(v_org, v_r.package_id, v_d.origin_branch_id, 'REENTERED', left(v_reason, 300));
  elsif p_decision = 'REJECT' then
    if v_r.status not in ('IN_QUARANTINE', 'PENDING_INSPECTION') then raise exception 'Sólo se puede rechazar un paquete en cuarentena o en inspección (estado: %)', v_r.status using errcode = '22023'; end if;
    update public.distribution_returns set status = 'REJECTED', packaging_state = coalesce(p_packaging_state, packaging_state), conservation_verified = coalesce(p_conservation_verified, conservation_verified),
      decided_by = auth.uid(), decided_at = now(), decision_reason = left(v_reason, 300) where id = v_r.id;
    perform app_private.dist_package_event(v_org, v_r.package_id, v_d.origin_branch_id, 'RETURN_REJECTED', left(v_reason, 300));
  else
    if v_r.status not in ('IN_QUARANTINE', 'PENDING_INSPECTION', 'REJECTED') then raise exception 'Sólo se puede descartar un paquete en cuarentena, en inspección o rechazado (estado: %)', v_r.status using errcode = '22023'; end if;
    perform 1 from public.vacuum_package_state s where s.package_id = v_r.package_id for update;
    update public.vacuum_package_state set status = 'DISCARDED', updated_at = now() where package_id = v_r.package_id and status = 'QUARANTINE';
    if not found then raise exception 'El paquete no está en cuarentena' using errcode = '22023'; end if;
    update public.distribution_returns set status = 'DISCARDED', packaging_state = coalesce(p_packaging_state, packaging_state), decided_by = auth.uid(), decided_at = now(), decision_reason = left(v_reason, 300) where id = v_r.id;
    perform app_private.dist_package_event(v_org, v_r.package_id, v_d.origin_branch_id, 'DISCARDED', left(v_reason, 300));
  end if;
  return jsonb_build_object('id', v_r.id, 'status', (select r.status from public.distribution_returns r where r.id = v_r.id), 'alreadyDecided', false);
end;
$$;

create function public.list_distribution_returns(
  p_status text default null,
  p_site_id uuid default null,
  p_delivery_id uuid default null,
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
  v_org uuid := app_private.require_permission('distribution.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_today date := app_private.dist_today(v_org);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_total bigint;
  v_rows jsonb;
begin
  if p_status is not null and p_status not in ('PENDING_RECEIPT', 'IN_QUARANTINE', 'PENDING_INSPECTION', 'APPROVED', 'REJECTED', 'DISCARDED', 'OPEN') then raise exception 'Estado inválido' using errcode = '22023'; end if;
  select count(*) into v_total
  from public.distribution_returns r join public.distribution_deliveries d on d.id = r.delivery_id and d.organization_id = r.organization_id
  where r.organization_id = v_org and (v_vis is null or d.origin_branch_id = any(v_vis))
    and (p_status is null or r.status = p_status or (p_status = 'OPEN' and r.status in ('PENDING_RECEIPT', 'IN_QUARANTINE', 'PENDING_INSPECTION', 'REJECTED')))
    and (p_site_id is null or d.site_id = p_site_id) and (p_delivery_id is null or r.delivery_id = p_delivery_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'status', x.status, 'reason', x.reason, 'reasonNote', x.reason_note, 'returnedOn', x.returned_on, 'creditRequired', x.credit_required,
    'packagingState', x.packaging_state, 'conservationVerified', x.conservation_verified, 'conservationNote', x.conservation_note,
    'packageId', x.package_id, 'logisticCode', x.code, 'productName', x.product_name_snapshot, 'weightGrams', x.weight_grams, 'lot', x.lot,
    'packedOn', x.packed_on, 'expiresOn', x.expires_on, 'expired', x.expires_on < v_today, 'unitCents', x.unit_cents::text,
    'deliveryId', x.delivery_id, 'deliveryLabel', app_private.dist_number_label(x.number), 'siteName', x.site_name, 'clientName', x.client_name,
    'registeredAt', x.registered_at, 'receivedAt', x.received_at,
    'decidedAt', x.decided_at, 'decidedBy', (select pr.display_name from public.profiles pr where pr.id = x.decided_by), 'decisionReason', x.decision_reason
  ) order by x.registered_at desc, x.id), '[]'::jsonb) into v_rows
  from (
    select r.*, p.product_name_snapshot, p.weight_grams, p.lot, p.packed_on, p.expires_on, l.code, i.unit_cents, d.number, s.name as site_name, c.trade_name as client_name
    from public.distribution_returns r
    join public.distribution_deliveries d on d.id = r.delivery_id and d.organization_id = r.organization_id
    join public.distribution_sites s on s.id = d.site_id and s.organization_id = d.organization_id
    join public.distribution_clients c on c.id = s.client_id and c.organization_id = s.organization_id
    join public.distribution_delivery_items i on i.id = r.item_id and i.organization_id = r.organization_id
    join public.vacuum_packages p on p.id = r.package_id and p.organization_id = r.organization_id
    left join public.vacuum_package_logistics l on l.package_id = p.id
    where r.organization_id = v_org and (v_vis is null or d.origin_branch_id = any(v_vis))
      and (p_status is null or r.status = p_status or (p_status = 'OPEN' and r.status in ('PENDING_RECEIPT', 'IN_QUARANTINE', 'PENDING_INSPECTION', 'REJECTED')))
      and (p_site_id is null or d.site_id = p_site_id) and (p_delivery_id is null or r.delivery_id = p_delivery_id)
    order by r.registered_at desc, r.id
    limit v_limit offset greatest(coalesce(p_offset, 0), 0)
  ) x;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: estadísticas (sólo entregas CONFIRMADAS)
-- ---------------------------------------------------------------------------------------------
-- Datos CONFIRMADOS: lo entregado, las ventas mayoristas firmes, los paquetes identificados como vendidos y lo devuelto. ESTIMADOS: las ventas informadas sólo por
-- cantidad (cantidad × valor promedio del producto en esa entrega). Los pendientes no son ventas. Los valores son el precio comercial de los paquetes (el de góndola):
-- no es facturación ni cobranza.
create function public.get_distribution_stats(
  p_from date default null,
  p_to date default null,
  p_client_id uuid default null,
  p_site_id uuid default null,
  p_product_id uuid default null,
  p_category_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('distribution.read');
  v_vis uuid[] := app_private.visible_branch_ids(v_org);
  v_to date := coalesce(p_to, app_private.dist_today(v_org));
  v_from date := coalesce(p_from, coalesce(p_to, app_private.dist_today(v_org)) - 29);
  v_result jsonb;
begin
  if v_from > v_to or v_to - v_from > 800 then raise exception 'El rango de fechas es inválido' using errcode = '22023'; end if;
  with scope as (
    select i.*, d.site_id, d.number as delivery_number, p.product_id, p.product_name_snapshot as product_name, pr.category_id, cat.name as category_name,
      s.client_id, s.name as site_name, c.trade_name as client_name
    from public.distribution_delivery_items i
    join public.distribution_deliveries d on d.id = i.delivery_id and d.organization_id = i.organization_id
    join public.distribution_sites s on s.id = d.site_id and s.organization_id = d.organization_id
    join public.distribution_clients c on c.id = s.client_id and c.organization_id = s.organization_id
    join public.vacuum_packages p on p.id = i.package_id and p.organization_id = i.organization_id
    join public.products pr on pr.id = p.product_id and pr.organization_id = p.organization_id
    left join public.categories cat on cat.id = pr.category_id and cat.organization_id = pr.organization_id
    where i.organization_id = v_org and d.status = 'CONFIRMED' and (v_vis is null or d.origin_branch_id = any(v_vis))
      and d.delivery_date between v_from and v_to
      and (p_client_id is null or s.client_id = p_client_id) and (p_site_id is null or d.site_id = p_site_id)
      and (p_product_id is null or p.product_id = p_product_id) and (p_category_id is null or pr.category_id = p_category_id)
  ), inferred as (
    -- Cantidad informada por producto y entrega, valorizada con el precio promedio de ESE producto en ESA entrega.
    select q.delivery_id, q.product_id, sum(q.quantity)::integer as qty,
      (sum(q.quantity) * coalesce((select avg(sc.unit_cents) from scope sc where sc.delivery_id = q.delivery_id and sc.product_id = q.product_id), 0))::bigint as est_cents
    from public.distribution_quantity_reports q
    where q.organization_id = v_org and exists (select 1 from scope sc where sc.delivery_id = q.delivery_id and sc.product_id = q.product_id)
    group by q.delivery_id, q.product_id
  ), by_product as (
    select s.product_id, max(s.product_name) as name, max(s.category_name) as category,
      count(*) as delivered, sum(s.weight_grams) as grams, sum(s.unit_cents) as delivered_cents,
      count(*) filter (where s.outcome in ('SOLD_FIRM', 'SOLD_REPORTED')) as sold_confirmed,
      coalesce(sum(s.unit_cents) filter (where s.outcome in ('SOLD_FIRM', 'SOLD_REPORTED')), 0) as sold_confirmed_cents,
      count(*) filter (where s.outcome = 'RETURNED') as returned,
      count(*) filter (where s.outcome = 'PENDING') as pending
    from scope s group by s.product_id
  ), inferred_by_product as (
    select product_id, sum(qty) as qty, sum(est_cents) as est_cents from inferred group by product_id
  ), by_site as (
    select s.site_id, max(s.site_name) as site_name, max(s.client_name) as client_name,
      count(*) as delivered, sum(s.unit_cents) as delivered_cents,
      count(*) filter (where s.outcome in ('SOLD_FIRM', 'SOLD_REPORTED')) as sold_confirmed,
      count(*) filter (where s.outcome = 'RETURNED') as returned,
      count(*) filter (where s.outcome = 'PENDING') as pending,
      count(distinct s.delivery_id) as deliveries
    from scope s group by s.site_id
  ), inferred_by_site as (
    select d.site_id, sum(i.qty) as qty, sum(i.est_cents) as est_cents from inferred i join public.distribution_deliveries d on d.id = i.delivery_id group by d.site_id
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'activeClients', (select count(distinct client_id) from scope),
    'activeSites', (select count(distinct site_id) from scope),
    'deliveries', (select count(distinct delivery_id) from scope),
    'delivered', jsonb_build_object('packages', (select count(*) from scope), 'grams', (select coalesce(sum(weight_grams), 0) from scope)::text, 'cents', (select coalesce(sum(unit_cents), 0) from scope)::text),
    'confirmed', jsonb_build_object(
      'packages', (select count(*) from scope where outcome in ('SOLD_FIRM', 'SOLD_REPORTED')),
      'firmPackages', (select count(*) from scope where outcome = 'SOLD_FIRM'),
      'identifiedPackages', (select count(*) from scope where outcome = 'SOLD_REPORTED'),
      'grams', (select coalesce(sum(weight_grams), 0) from scope where outcome in ('SOLD_FIRM', 'SOLD_REPORTED'))::text,
      'cents', (select coalesce(sum(unit_cents), 0) from scope where outcome in ('SOLD_FIRM', 'SOLD_REPORTED'))::text),
    'estimated', jsonb_build_object('packages', (select coalesce(sum(qty), 0) from inferred), 'cents', (select coalesce(sum(est_cents), 0) from inferred)::text),
    'returned', jsonb_build_object('packages', (select count(*) from scope where outcome = 'RETURNED'), 'grams', (select coalesce(sum(weight_grams), 0) from scope where outcome = 'RETURNED')::text),
    'pending', jsonb_build_object('packages', (select count(*) from scope where outcome = 'PENDING') - (select coalesce(sum(qty), 0) from inferred)),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'productId', b.product_id, 'productName', b.name, 'categoryName', b.category, 'delivered', b.delivered, 'grams', b.grams::text, 'deliveredCents', b.delivered_cents::text,
        'soldConfirmed', b.sold_confirmed, 'soldConfirmedCents', b.sold_confirmed_cents::text, 'soldEstimated', coalesce(ip.qty, 0), 'soldEstimatedCents', coalesce(ip.est_cents, 0)::text,
        'returned', b.returned, 'pending', b.pending - coalesce(ip.qty, 0),
        'rotationConfirmedPct', round(100.0 * b.sold_confirmed / nullif(b.delivered, 0), 1),
        'rotationWithEstimatePct', round(100.0 * (b.sold_confirmed + coalesce(ip.qty, 0)) / nullif(b.delivered, 0), 1),
        'returnPct', round(100.0 * b.returned / nullif(b.delivered, 0), 1)
      ) order by b.sold_confirmed + coalesce(ip.qty, 0) desc, lower(b.name))
      from by_product b left join inferred_by_product ip on ip.product_id = b.product_id
    ), '[]'::jsonb),
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'siteId', b.site_id, 'siteName', b.site_name, 'clientName', b.client_name, 'deliveries', b.deliveries, 'delivered', b.delivered, 'deliveredCents', b.delivered_cents::text,
        'soldConfirmed', b.sold_confirmed, 'soldEstimated', coalesce(i.qty, 0), 'returned', b.returned, 'pending', b.pending - coalesce(i.qty, 0),
        'rotationConfirmedPct', round(100.0 * b.sold_confirmed / nullif(b.delivered, 0), 1),
        'rotationWithEstimatePct', round(100.0 * (b.sold_confirmed + coalesce(i.qty, 0)) / nullif(b.delivered, 0), 1)
      ) order by b.delivered desc, lower(b.site_name))
      from by_site b left join inferred_by_site i on i.site_id = b.site_id
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function
  app_private.dist_today(uuid), app_private.dist_confirmed_for_update(uuid, uuid), app_private.dist_product_counts(uuid, uuid),
  app_private.dist_assert_not_reconciled(public.distribution_deliveries), app_private.dist_report_sold(uuid, public.distribution_deliveries, uuid, date)
from public, anon, authenticated;

revoke all on function
  public.report_delivery_sales(uuid, uuid[], date), public.report_delivery_sales_by_codes(uuid, text[], date),
  public.report_delivery_quantity_sales(uuid, jsonb, date, text, uuid), public.get_delivery_reconciliation(uuid), public.close_delivery_reconciliation(uuid, text),
  public.get_site_replenishment_history(uuid, integer), public.register_distribution_returns(uuid, jsonb, date, uuid), public.receive_distribution_returns(jsonb),
  public.start_return_inspection(uuid), public.decide_distribution_return(uuid, text, text, text, boolean, text),
  public.list_distribution_returns(text, uuid, uuid, integer, integer), public.get_distribution_stats(date, date, uuid, uuid, uuid, uuid)
from public, anon;
grant execute on function
  public.report_delivery_sales(uuid, uuid[], date), public.report_delivery_sales_by_codes(uuid, text[], date),
  public.report_delivery_quantity_sales(uuid, jsonb, date, text, uuid), public.get_delivery_reconciliation(uuid), public.close_delivery_reconciliation(uuid, text),
  public.get_site_replenishment_history(uuid, integer), public.register_distribution_returns(uuid, jsonb, date, uuid), public.receive_distribution_returns(jsonb),
  public.start_return_inspection(uuid), public.decide_distribution_return(uuid, text, text, text, boolean, text),
  public.list_distribution_returns(text, uuid, uuid, integer, integer), public.get_distribution_stats(date, date, uuid, uuid, uuid, uuid)
to authenticated;

commit;
