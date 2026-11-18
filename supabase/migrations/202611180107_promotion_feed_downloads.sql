begin;

-- Promociones → «Descargar promociones Feed» desde el celular (D-103): descarga INCREMENTAL de las piezas Feed.
--
--   * Se registra, por promoción, la FIRMA de los precios que mostraba la imagen descargada (sha-256 en hex de los importes y condiciones que
--     dibuja la pieza; la calcula el servidor del Admin con el mismo motor que dibuja). Una promoción está pendiente si es nueva (sin fila) o si
--     su firma de HOY difiere de la registrada: así un cambio del precio de lista del producto, del descuento o del pack la vuelve pendiente,
--     y un cambio de nombre, foto o vigencia no.
--   * No se guardan PNG ni archivos: sólo la firma, un resumen legible del precio («$ 9.000 / kg · desde 2 kg»), la tanda y quién/cuándo.
--   * La tanda (`batch_id`) agrupa lo registrado en una misma descarga: «Repetir la última tanda» vuelve a pedir esas promociones.
--   * La sucursal de los precios y del contacto es la que ya usa Cartelería → Gráficas por defecto: la activa llamada «Central» o, si no hay,
--     la primera activa por nombre (sin sucursales activas: precio general). Las promociones son las de «Todas las promociones activas» de esa
--     sucursal: explícitas (módulo Promociones), vigentes hoy, globales o de esa sucursal. Las resuelve el MISMO resolvedor de la TV y las carpetas.
--   * Lectura `products.read` (como `get_signage_folder_facts`); registrar `catalog.write` (como las carpetas). Sin acceso directo a la tabla
--     para escribir; todo por organización.

create table public.promotion_feed_downloads (
  promotion_id uuid primary key references public.product_weight_discounts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  price_signature text not null check (price_signature ~ '^[0-9a-f]{64}$'),
  price_summary text check (price_summary is null or char_length(price_summary) between 1 and 200),
  batch_id uuid not null,
  downloaded_at timestamptz not null default now(),
  downloaded_by uuid references public.profiles(id) on delete set null
);
create index promotion_feed_downloads_org_recent_idx on public.promotion_feed_downloads (organization_id, downloaded_at desc);
create index promotion_feed_downloads_org_batch_idx on public.promotion_feed_downloads (organization_id, batch_id);

alter table public.promotion_feed_downloads enable row level security;
create policy promotion_feed_downloads_select on public.promotion_feed_downloads
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));
revoke all on table public.promotion_feed_downloads from public, anon, authenticated;
grant select on public.promotion_feed_downloads to authenticated;

comment on table public.promotion_feed_downloads is
  'Última versión de precios descargada como imagen Feed de cada promoción (firma sha-256 de lo dibujado). Sin imágenes ni archivos.';

-- Sucursal de la descarga Feed: «Central» activa o la primera activa por nombre (la misma regla que el selector de Cartelería → Gráficas).
create function app_private.promotion_feed_branch(p_organization_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id from public.branches b
  where b.organization_id = p_organization_id and b.active
  order by (lower(btrim(b.name)) = 'central') desc, b.name, b.id
  limit 1;
$$;
revoke all on function app_private.promotion_feed_branch(uuid) from public, anon, authenticated;

-- Estado de la descarga Feed: las promociones (todas las activas, o las pedidas, o las de la última tanda) resueltas con precio, foto y estado de
-- HOY por `signage_resolve_entries`, cada una con lo último descargado (`downloaded`: firma, resumen, fecha y tanda). La firma de hoy la calcula el
-- Admin con el motor de pricing; esta función sólo entrega los hechos.
create function public.get_promotion_feed_state(p_promotion_ids uuid[] default null, p_last_batch boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('products.read');
  v_at timestamptz := now();
  v_branch_id uuid := app_private.promotion_feed_branch(v_org);
  v_branch_name text;
  v_last_batch uuid;
  v_last_at timestamptz;
  v_last_count integer;
  v_entries jsonb;
  v_items jsonb;
begin
  if p_promotion_ids is not null and cardinality(p_promotion_ids) > 200 then
    raise exception 'Too many promotions' using errcode = '22023';
  end if;
  select b.name into v_branch_name from public.branches b where b.id = v_branch_id;

  select d.batch_id into v_last_batch from public.promotion_feed_downloads d
  where d.organization_id = v_org order by d.downloaded_at desc, d.batch_id limit 1;
  if v_last_batch is not null then
    select max(d.downloaded_at), count(*)::integer into v_last_at, v_last_count
    from public.promotion_feed_downloads d where d.organization_id = v_org and d.batch_id = v_last_batch;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'slide_id', x.id, 'entry_id', x.id, 'kind', 'PROMOTION', 'ord', x.ord, 'product_ref', null, 'promotion_id', x.id
  ) order by x.ord), '[]'::jsonb)
  into v_entries
  from (
    select w.id, (row_number() over (order by p.name, w.id))::integer as ord
    from public.product_weight_discounts w
    join public.products p on p.id = w.product_id and p.organization_id = w.organization_id
    where w.organization_id = v_org
      and case
        when p_promotion_ids is not null then w.id = any(p_promotion_ids)
        when p_last_batch then v_last_batch is not null and exists (
          select 1 from public.promotion_feed_downloads d where d.promotion_id = w.id and d.organization_id = v_org and d.batch_id = v_last_batch)
        else app_private.signage_promotion_status(w.active, w.valid_from, w.valid_until, v_at) = 'ACTIVE'
          and (w.branch_id is null or w.branch_id = v_branch_id)
      end
  ) x;

  v_items := app_private.signage_resolve_entries(v_org, v_branch_id, v_entries, true, v_at);

  select coalesce(jsonb_agg(i.value || jsonb_build_object('downloaded', case when d.promotion_id is null then null else jsonb_build_object(
      'signature', d.price_signature, 'summary', d.price_summary, 'at', d.downloaded_at, 'batchId', d.batch_id) end) order by i.ord), '[]'::jsonb)
  into v_items
  from jsonb_array_elements(v_items) with ordinality as i(value, ord)
  left join public.promotion_feed_downloads d on d.promotion_id = (i.value ->> 'entryId')::uuid and d.organization_id = v_org;

  return jsonb_build_object(
    'branchId', v_branch_id, 'branchName', v_branch_name, 'items', v_items,
    'lastBatch', case when v_last_batch is null then null else jsonb_build_object('batchId', v_last_batch, 'at', v_last_at, 'count', v_last_count) end);
end;
$$;
revoke all on function public.get_promotion_feed_state(uuid[], boolean) from public, anon;
grant execute on function public.get_promotion_feed_state(uuid[], boolean) to authenticated;

-- Registra lo que YA se empezó a descargar: por cada promoción, la firma y el resumen de la imagen generada (los devuelve el servidor junto al
-- PNG). Reemplaza el registro anterior de esa promoción. Una promoción de otra organización o borrada se ignora (no revela nada).
-- Devuelve cuántas quedaron registradas.
create function public.record_promotion_feed_downloads(p_batch_id uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('catalog.write');
  v_count integer;
begin
  if p_batch_id is null then
    raise exception 'Batch is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Between 1 and 100 items are required' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) e
    where jsonb_typeof(e) <> 'object'
      or coalesce(e ->> 'promotionId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or coalesce(e ->> 'signature', '') !~ '^[0-9a-f]{64}$'
      or (e ? 'summary' and jsonb_typeof(e -> 'summary') <> 'null' and (jsonb_typeof(e -> 'summary') <> 'string' or char_length(e ->> 'summary') not between 1 and 200))
  ) then
    raise exception 'Invalid item' using errcode = '22023';
  end if;

  with items as (
    -- Una promoción repetida en el mismo pedido: vale la última.
    select distinct on ((e ->> 'promotionId')::uuid) (e ->> 'promotionId')::uuid as promotion_id, e ->> 'signature' as signature, e ->> 'summary' as summary
    from jsonb_array_elements(p_items) with ordinality as t(e, ord)
    order by (e ->> 'promotionId')::uuid, ord desc
  ), saved as (
    insert into public.promotion_feed_downloads (promotion_id, organization_id, price_signature, price_summary, batch_id, downloaded_at, downloaded_by)
    select i.promotion_id, v_org, i.signature, i.summary, p_batch_id, clock_timestamp(), auth.uid()
    from items i
    join public.product_weight_discounts w on w.id = i.promotion_id and w.organization_id = v_org
    on conflict (promotion_id) do update set
      price_signature = excluded.price_signature, price_summary = excluded.price_summary, batch_id = excluded.batch_id,
      downloaded_at = excluded.downloaded_at, downloaded_by = excluded.downloaded_by
    where public.promotion_feed_downloads.organization_id = excluded.organization_id
    returning 1
  )
  select count(*)::integer into v_count from saved;
  return v_count;
end;
$$;
revoke all on function public.record_promotion_feed_downloads(uuid, jsonb) from public, anon;
grant execute on function public.record_promotion_feed_downloads(uuid, jsonb) to authenticated;

commit;
