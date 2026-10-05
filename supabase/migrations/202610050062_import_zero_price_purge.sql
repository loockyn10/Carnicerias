begin;

-- Purga (hard delete) de productos importados cuyo PRECIO VIGENTE es $0 ("SIN PRECIO ($0)" en el Admin).
--
-- Es un SEGUNDO modo de la infraestructura de purga de 202610030059 (D-062), no un mecanismo paralelo:
--   * La clasificación de cada producto con vínculo externo la hace el MISMO clasificador de la 059
--     (app_private.classify_import_product_purge), así que heredan, sin copiarlas, todas sus protecciones: sólo productos que
--     creó una importación aplicada del origen, sólo habilitados en Central, nada vinculado a otro origen y nada con ventas,
--     movimientos de stock, operaciones/transferencias de stock, producción o eventos de reposición.
--   * El borrado de catálogo es el de la 059 (precios, costos, markup, barcodes, proveedor del producto, surtido,
--     categorías, política de stock, promociones del producto, vínculos externos), más las versiones de pack
--     (product_pack_versions, agregadas por la 060). El `delete` del producto dispara el log de cambios del cursor del POS:
--     `pull_pos_state` (059) lo entrega en `removedProductIds` y el POS lo saca de su SQLite.
--   * El modo por CANTIDAD del archivo de SimplyGest (preview_import_product_purge / purge_import_products) no se toca.
--
-- Qué cambia respecto del modo por CANTIDAD: los candidatos no vienen de un archivo sino de la base. Candidato = producto de
-- la organización con un precio VIGENTE EXISTENTE con price_cents = 0 (valid_from <= now() y sin cerrar). La AUSENCIA de
-- precio no cuenta: un producto sin ninguna fila de precio vigente nunca es candidato. Candidato no es "borrable": cada
-- uno se clasifica y sólo DELETE_SAFE se borra.
--
-- Un candidato queda BLOCKED, además de por los bloqueos de la 059, por:
--   NOT_IMPORTED_FROM_SOURCE   no tiene vínculo externo con este origen (producto de carnicería / alta rápida): se informa, no se toca;
--   HAS_POSITIVE_CURRENT_PRICE tiene un precio $0 vigente pero además otro vigente > 0 (p. ej. 0 global y un precio de sucursal):
--                              no está realmente "sin precio", se decide a mano.
--
-- Seguridad del apply: exige el conteo del preview (40001 si cambió), una purga a la vez por organización (mismo lock que la
-- 059), una sola transacción, cada producto en su sub-transacción (una referencia FK que nadie conocía lo deja intacto y
-- se informa), un registro de auditoría PRODUCTS_IMPORT_PURGE por producto, y re-verifica el precio $0 con la fila del
-- producto bloqueada. Repetirlo es inocuo: lo ya borrado ya no existe, así que no vuelve a ser candidato.

-- ---------------------------------------------------------------------------------------------
-- Clasificación (compartida por el preview y el apply)
-- ---------------------------------------------------------------------------------------------
create function app_private.classify_import_zero_price_purge(
  p_organization_id uuid,
  p_source_system text,
  p_branch_id uuid
)
returns table (
  ordinal integer,
  external_id text,
  product_id uuid,
  product_name text,
  product_sku text,
  product_active boolean,
  verdict text,
  reasons text[],
  catalog_refs jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with zero_price as (
    -- Precio vigente EXISTENTE = 0 (la misma definición de vigencia que usa el catálogo y el POS).
    select p.id, p.name, p.sku, p.active
    from public.products p
    where p.organization_id = p_organization_id
      and exists (
        select 1 from public.product_prices pp
        where pp.organization_id = p.organization_id and pp.product_id = p.id and pp.price_cents = 0
          and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
      )
  ), linked as (
    -- Un solo código externo por producto (el menor): clasificar dos veces el mismo producto lo borraría dos veces.
    select z.id, min(l.external_id) as external_id
    from zero_price z
    join public.external_entity_links l
      on l.organization_id = p_organization_id and l.source_system = p_source_system
     and l.entity_type = 'product' and l.internal_id = z.id
    group by z.id
  ), classified as (
    -- El clasificador de la 059, tal cual: sin CANTIDAD (no aplica a este modo), identificando por el código externo.
    select c.*
    from app_private.classify_import_product_purge(
      p_organization_id, p_source_system, p_branch_id,
      (select coalesce(jsonb_agg(jsonb_build_object('externalId', k.external_id)), '[]'::jsonb) from linked k)
    ) c
  ), resolved as (
    select z.id, z.name, z.sku, z.active, k.external_id, c.verdict as base_verdict, c.reasons as base_reasons, c.catalog_refs,
      array_remove(array[
        case when k.external_id is null then 'NOT_IMPORTED_FROM_SOURCE' end,
        case when k.external_id is null and exists (
          select 1 from public.external_entity_links o
          where o.organization_id = p_organization_id and o.entity_type = 'product'
            and o.internal_id = z.id and o.source_system <> p_source_system
        ) then 'LINKED_TO_OTHER_SOURCE' end,
        case when exists (
          select 1 from public.product_prices pp
          where pp.organization_id = p_organization_id and pp.product_id = z.id and pp.price_cents > 0
            and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
        ) then 'HAS_POSITIVE_CURRENT_PRICE' end,
        -- Red de seguridad: un producto con vínculo siempre tiene fila del clasificador; si no la tuviera, nunca es borrable.
        case when k.external_id is not null and c.verdict is null then 'UNCLASSIFIED' end
      ], null) as extra_reasons
    from zero_price z
    left join linked k on k.id = z.id
    left join classified c on c.product_id = z.id
  )
  select (row_number() over (order by r.name, r.id))::integer,
         r.external_id, r.id, r.name, r.sku, r.active,
         case when cardinality(coalesce(r.base_reasons, '{}'::text[]) || r.extra_reasons) > 0 then 'BLOCKED' else 'DELETE_SAFE' end,
         coalesce(r.base_reasons, '{}'::text[]) || r.extra_reasons,
         coalesce(r.catalog_refs, '{}'::jsonb)
  from resolved r
  order by 1;
$$;

revoke all on function app_private.classify_import_zero_price_purge(uuid, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Preview: no escribe nada.
-- ---------------------------------------------------------------------------------------------
create function public.preview_import_zero_price_purge(p_source_system text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('imports.write');
  v_branch uuid;
  v_branch_name text;
  v_items jsonb;
  v_summary jsonb;
  v_by_reason jsonb;
begin
  perform app_private.require_permission('products.write');
  if p_source_system is null or p_source_system !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'Sistema de origen inválido' using errcode = '22023';
  end if;
  v_branch := app_private.purge_destination_branch(v_org);
  select b.name into v_branch_name from public.branches b where b.id = v_branch;

  with c as materialized (
    select * from app_private.classify_import_zero_price_purge(v_org, p_source_system, v_branch)
  )
  select
    (select coalesce(jsonb_agg(jsonb_build_object(
       'ordinal', c.ordinal, 'externalId', c.external_id, 'productId', c.product_id, 'productName', c.product_name,
       'sku', c.product_sku, 'active', c.product_active, 'verdict', c.verdict, 'reasons', to_jsonb(c.reasons),
       'catalogRefs', c.catalog_refs
     ) order by c.ordinal), '[]'::jsonb) from c),
    (select jsonb_build_object(
       'total', count(*),
       'deleteSafe', count(*) filter (where c.verdict = 'DELETE_SAFE'),
       'blocked', count(*) filter (where c.verdict = 'BLOCKED'),
       'notImported', count(*) filter (where 'NOT_IMPORTED_FROM_SOURCE' = any (c.reasons))
     ) from c),
    (select coalesce(jsonb_object_agg(r.reason, r.n), '{}'::jsonb)
       from (select reason, count(*) as n from c, unnest(c.reasons) as reason group by reason) r)
  into v_items, v_summary, v_by_reason;

  return jsonb_build_object(
    'mode', 'ZERO_CURRENT_PRICE', 'sourceSystem', p_source_system, 'branchId', v_branch, 'branchName', v_branch_name,
    'summary', v_summary, 'blockedByReason', v_by_reason, 'items', v_items
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Apply: borra de verdad (hard delete) los DELETE_SAFE y sólo ésos. Una transacción por llamada.
-- p_batch_size (opcional) limita cuántos borra ESTA llamada (para quien tenga un statement_timeout corto);
-- p_expected_delete_count es siempre el total de DELETE_SAFE pendiente antes de la llamada.
-- ---------------------------------------------------------------------------------------------
create function public.purge_import_zero_price_products(
  p_source_system text,
  p_expected_delete_count integer,
  p_batch_size integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('imports.write');
  v_branch uuid;
  v_rows jsonb;
  v_item jsonb;
  v_product uuid;
  v_external text;
  v_deleted jsonb := '[]'::jsonb;
  v_blocked jsonb := '[]'::jsonb;
  v_to_delete integer;
  v_candidates integer;
  v_before jsonb;
  v_count integer;
  v_refs jsonb;
begin
  perform app_private.require_permission('products.write');
  if p_source_system is null or p_source_system !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'Sistema de origen inválido' using errcode = '22023';
  end if;
  if p_expected_delete_count is null or p_expected_delete_count < 0 then
    raise exception 'Falta el conteo del preview (p_expected_delete_count)' using errcode = '22023';
  end if;
  if p_batch_size is not null and p_batch_size < 1 then
    raise exception 'p_batch_size tiene que ser >= 1' using errcode = '22023';
  end if;
  v_branch := app_private.purge_destination_branch(v_org);
  -- Mismo lock que purge_import_products: dos purgas (de cualquier modo) no se pisan.
  perform pg_advisory_xact_lock(hashtextextended('purge_import_products:' || v_org::text, 0));

  -- Una sola clasificación: candidatos y bloqueos se recalculan ACÁ, dentro de la transacción, antes de borrar nada.
  select coalesce(jsonb_agg(jsonb_build_object(
           'ordinal', c.ordinal, 'externalId', c.external_id, 'productId', c.product_id, 'productName', c.product_name,
           'sku', c.product_sku, 'verdict', c.verdict, 'reasons', to_jsonb(c.reasons), 'catalogRefs', c.catalog_refs
         ) order by c.ordinal), '[]'::jsonb)
  into v_rows
  from app_private.classify_import_zero_price_purge(v_org, p_source_system, v_branch) c;

  select count(*) filter (where e.value ->> 'verdict' = 'DELETE_SAFE'), count(*)
  into v_to_delete, v_candidates
  from jsonb_array_elements(v_rows) e;
  if v_to_delete <> p_expected_delete_count then
    raise exception 'PURGE_PREVIEW_STALE: el preview informó % productos a borrar y ahora son %; generá el preview de nuevo', p_expected_delete_count, v_to_delete
      using errcode = '40001';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'externalId', e.value ->> 'externalId', 'productId', e.value -> 'productId', 'productName', e.value ->> 'productName',
           'sku', e.value ->> 'sku', 'reasons', e.value -> 'reasons') order by e.ord), '[]'::jsonb)
  into v_blocked
  from jsonb_array_elements(v_rows) with ordinality e(value, ord)
  where e.value ->> 'verdict' = 'BLOCKED';

  for v_item in
    select e.value
    from jsonb_array_elements(v_rows) with ordinality e(value, ord)
    where e.value ->> 'verdict' = 'DELETE_SAFE'
    order by e.ord
    limit p_batch_size
  loop
    v_product := (v_item ->> 'productId')::uuid;
    v_external := v_item ->> 'externalId';
    -- Todo o nada para ESTE producto (si una FK inesperada lo impide, se deshace y se informa).
    begin
      perform 1 from public.products p where p.id = v_product and p.organization_id = v_org for update;
      -- Con la fila bloqueada, el precio $0 se verifica una última vez (no se borra un producto al que acaban de ponerle precio).
      if not exists (
           select 1 from public.product_prices pp
           where pp.organization_id = v_org and pp.product_id = v_product and pp.price_cents = 0
             and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now()))
         or exists (
           select 1 from public.product_prices pp
           where pp.organization_id = v_org and pp.product_id = v_product and pp.price_cents > 0
             and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())) then
        v_blocked := v_blocked || jsonb_build_array(jsonb_build_object(
          'externalId', v_external, 'productId', v_product, 'productName', v_item ->> 'productName', 'sku', v_item ->> 'sku',
          'reasons', jsonb_build_array('PRICE_CHANGED')));
        continue;
      end if;

      select to_jsonb(p) || jsonb_build_object('purge', jsonb_build_object(
               'mode', 'ZERO_CURRENT_PRICE', 'sourceSystem', p_source_system, 'externalId', v_external))
        into v_before from public.products p where p.id = v_product;
      v_refs := (v_item -> 'catalogRefs') || jsonb_build_object(
        'packVersions', (select count(*) from public.product_pack_versions x where x.product_id = v_product));

      delete from public.product_prices where product_id = v_product and organization_id = v_org;
      delete from public.product_costs where product_id = v_product and organization_id = v_org;
      delete from public.product_pricing_settings where product_id = v_product and organization_id = v_org;
      delete from public.product_barcodes where product_id = v_product and organization_id = v_org;
      delete from public.product_suppliers where product_id = v_product and organization_id = v_org;
      delete from public.branch_product_assortment where product_id = v_product and organization_id = v_org;
      delete from public.product_category_assignments where product_id = v_product and organization_id = v_org;
      delete from public.branch_product_stock_settings where product_id = v_product and organization_id = v_org;
      delete from public.product_weight_discounts where product_id = v_product and organization_id = v_org;
      delete from public.product_pack_versions where product_id = v_product and organization_id = v_org;
      delete from public.external_entity_links
      where organization_id = v_org and entity_type = 'product' and internal_id = v_product;
      delete from public.products where id = v_product and organization_id = v_org;
      get diagnostics v_count = row_count;
      if v_count <> 1 then
        raise exception 'PURGE_PRODUCT_NOT_DELETED' using errcode = 'P0001';
      end if;

      perform app_private.write_audit(v_org, null, 'PRODUCTS_IMPORT_PURGE', 'products', v_product, v_before, null);
      v_deleted := v_deleted || jsonb_build_array(jsonb_build_object(
        'externalId', v_external, 'productId', v_product, 'productName', v_item ->> 'productName', 'sku', v_item ->> 'sku',
        'removed', v_refs));
    exception when foreign_key_violation or restrict_violation then
      v_blocked := v_blocked || jsonb_build_array(jsonb_build_object(
        'externalId', v_external, 'productId', v_product, 'productName', v_item ->> 'productName', 'sku', v_item ->> 'sku',
        'reasons', jsonb_build_array('UNEXPECTED_REFERENCE'), 'detail', sqlerrm));
    end;
  end loop;

  return jsonb_build_object(
    'mode', 'ZERO_CURRENT_PRICE', 'sourceSystem', p_source_system, 'branchId', v_branch,
    'summary', jsonb_build_object(
      'candidates', v_candidates,
      'expectedDelete', v_to_delete,
      'deleted', jsonb_array_length(v_deleted),
      'blocked', jsonb_array_length(v_blocked),
      'remainingDeletable', v_to_delete - jsonb_array_length(v_deleted)
    ),
    'deleted', v_deleted, 'blocked', v_blocked
  );
end;
$$;

revoke all on function public.preview_import_zero_price_purge(text) from public, anon;
revoke all on function public.purge_import_zero_price_products(text, integer, integer) from public, anon;
grant execute on function public.preview_import_zero_price_purge(text) to authenticated;
grant execute on function public.purge_import_zero_price_products(text, integer, integer) to authenticated;

comment on function public.purge_import_zero_price_products(text, integer, integer) is
  'Hard-delete controlado de productos importados cuyo precio VIGENTE existente es 0. Reutiliza el clasificador de la purga por CANTIDAD (202610030059). Ver docs/IMPORTS.md "Purga de productos importados sin stock".';

commit;
