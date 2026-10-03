begin;

-- Limpieza controlada de productos importados desde un sistema de origen (SimplyGest) cuyo stock ORIGINAL era <= 0.
--
-- Qué es y qué NO es:
--   * Es un procedimiento de datos de una sola pasada (preview + purga), NO una acción general de "eliminar producto":
--     ninguna pantalla del Admin lo invoca. La política de producto sigue siendo "desactivar, no borrar" (PRODUCT.md);
--     esta es la excepción acotada que se pidió para sacar de la base los productos de almacén que se importaron sin
--     stock, y sólo ellos.
--   * La decisión de qué se borra la toma la CANTIDAD ORIGINAL del archivo de origen (columna CANTIDAD de SimplyGest),
--     que viaja en `p_candidates`. NUNCA el stock del ledger de Supabase (la importación no cargó el stock de SimplyGest,
--     D-058, así que el ledger no dice nada sobre ese dato). El servidor sólo rechaza lo que el archivo no puede
--     justificar: una cantidad > 0 jamás es candidata.
--   * Los productos se identifican por el código externo (`external_entity_links`), nunca por nombre.
--
-- Seguridad, en este orden:
--   1. sólo productos CREADOS por una importación aplicada de ese `source_system` (no los de carnicería cargados antes,
--      ni los adoptados con `linkExistingBy`, ni los del alta rápida del scanner);
--   2. sólo productos habilitados únicamente en la sucursal productiva (Central): uno habilitado en Avenida/Janssen se
--      informa y no se toca;
--   3. cualquier historia transaccional (ventas, movimientos de stock, operaciones/transferencias de stock, producción,
--      eventos de reposición) lo bloquea: se informa con el motivo y NO se borra ni se archiva nada;
--   4. sólo se borran relaciones puramente de catálogo (precios, costos, códigos de barras, proveedores, surtido,
--      categorías, promociones por producto, política de stock, vínculos externos) junto con el producto;
--   5. cada producto se borra en su propia sub-transacción: una referencia inesperada (FK) lo deja intacto y lo informa;
--   6. la purga exige el conteo del preview (`p_expected_delete_count`): si algo cambió entre el preview y la purga, aborta;
--   7. queda un registro de auditoría por producto borrado (con su código externo y la cantidad original).
-- Repetirla es inocuo: lo ya borrado ya no tiene vínculo y se informa como NOT_LINKED.

-- ---------------------------------------------------------------------------------------------
-- Validación del lote de candidatos (compartida por el preview y la purga)
-- ---------------------------------------------------------------------------------------------
create function app_private.purge_validate_candidates(p_source_system text, p_candidates jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_ordinal integer := 0;
  v_external text;
  v_quantity numeric;
  v_seen text[] := array[]::text[];
begin
  if p_source_system is null or p_source_system !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'Sistema de origen inválido' using errcode = '22023';
  end if;
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' then
    raise exception 'La lista de candidatos tiene que ser un arreglo' using errcode = '22023';
  end if;
  if jsonb_array_length(p_candidates) not between 1 and 1000 then
    raise exception 'Cada llamada acepta entre 1 y 1000 candidatos' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_candidates) loop
    v_ordinal := v_ordinal + 1;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Candidato % inválido: se espera { externalId, quantity }', v_ordinal using errcode = '22023';
    end if;
    v_external := btrim(v_item ->> 'externalId');
    if v_external is null or v_external = '' or char_length(v_external) > 200 then
      raise exception 'Candidato %: falta el código externo', v_ordinal using errcode = '22023';
    end if;
    if coalesce(jsonb_typeof(v_item -> 'quantity'), 'null') not in ('number', 'string') then
      raise exception 'Candidato % (%): falta la CANTIDAD original del archivo de origen', v_ordinal, v_external using errcode = '22023';
    end if;
    begin
      v_quantity := (v_item ->> 'quantity')::numeric;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Candidato % (%): la CANTIDAD original no es un número', v_ordinal, v_external using errcode = '22023';
    end;
    -- La regla de oro: sólo CANTIDAD <= 0 puede ser candidata. Un valor positivo es un error del que llama, no un "skip".
    if v_quantity > 0 then
      raise exception 'Candidato % (%): CANTIDAD original % > 0; nunca es candidato a purga', v_ordinal, v_external, v_quantity using errcode = '22023';
    end if;
    if v_external = any (v_seen) then
      raise exception 'Candidato % (%): código repetido en el lote', v_ordinal, v_external using errcode = '22023';
    end if;
    v_seen := v_seen || v_external;
  end loop;
end;
$$;

revoke all on function app_private.purge_validate_candidates(text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Clasificación de cada candidato: DELETE (se puede borrar), BLOCKED (tiene algo que lo impide, se informa),
-- SKIP (no hay nada que borrar: sin vínculo / producto ya borrado).
-- ---------------------------------------------------------------------------------------------
create function app_private.classify_import_product_purge(
  p_organization_id uuid,
  p_source_system text,
  p_branch_id uuid,
  p_candidates jsonb
)
returns table (
  ordinal integer,
  external_id text,
  quantity numeric,
  file_name text,
  product_id uuid,
  product_name text,
  product_sku text,
  product_active boolean,
  verdict text,
  reasons text[],
  link_exists boolean,
  catalog_refs jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with cand as (
    select e.ord::integer as ordinal,
           btrim(e.value ->> 'externalId') as external_id,
           (e.value ->> 'quantity')::numeric as quantity,
           nullif(btrim(e.value ->> 'name'), '') as file_name
    from jsonb_array_elements(p_candidates) with ordinality as e(value, ord)
  ), resolved as (
    select c.ordinal, c.external_id, c.quantity, c.file_name,
           l.internal_id as linked_id,
           p.id as pid, p.name as pname, p.sku as psku, p.active as pactive
    from cand c
    left join public.external_entity_links l
      on l.organization_id = p_organization_id and l.source_system = p_source_system
     and l.entity_type = 'product' and l.external_id = c.external_id
    left join public.products p on p.id = l.internal_id and p.organization_id = p_organization_id
  ), checked as (
    select r.*,
      array_remove(array[
        case when r.pid is not null and not exists (
          select 1 from public.import_rows ir
          join public.import_batches ib on ib.id = ir.batch_id and ib.organization_id = ir.organization_id
          where ir.organization_id = p_organization_id and ir.internal_id = r.pid
            and ir.action = 'CREATE' and ir.applied_at is not null
            and ib.source_system = p_source_system and ib.entity_type = 'product' and ib.status = 'APPLIED'
        ) then 'NOT_CREATED_BY_IMPORT' end,
        case when r.pid is not null and exists (
          select 1 from public.external_entity_links o
          where o.organization_id = p_organization_id and o.entity_type = 'product'
            and o.internal_id = r.pid and o.source_system <> p_source_system
        ) then 'LINKED_TO_OTHER_SOURCE' end,
        case when r.pid is not null and exists (
          select 1 from public.branch_product_assortment a
          where a.product_id = r.pid and a.branch_id <> p_branch_id
        ) then 'ENABLED_IN_OTHER_BRANCH' end,
        case when r.pid is not null and exists (select 1 from public.sale_items x where x.product_id = r.pid) then 'HAS_SALES' end,
        case when r.pid is not null and exists (select 1 from public.stock_movements x where x.product_id = r.pid) then 'HAS_STOCK_MOVEMENTS' end,
        case when r.pid is not null and exists (select 1 from public.stock_operation_items x where x.product_id = r.pid) then 'HAS_STOCK_OPERATIONS' end,
        case when r.pid is not null and exists (select 1 from public.stock_transfer_items x where x.product_id = r.pid) then 'HAS_STOCK_TRANSFERS' end,
        case when r.pid is not null and (
          exists (select 1 from public.production_batch_outputs x where x.product_id = r.pid)
          or exists (select 1 from public.production_batches x where x.source_product_id = r.pid)
        ) then 'HAS_PRODUCTION' end,
        case when r.pid is not null and exists (select 1 from public.product_restock_events x where x.product_id = r.pid) then 'HAS_RESTOCK_EVENTS' end
      ], null) as blockers
    from resolved r
  )
  select k.ordinal, k.external_id, k.quantity, k.file_name,
         k.pid, k.pname, k.psku, k.pactive,
         case
           when k.linked_id is null or k.pid is null then 'SKIP'
           when cardinality(k.blockers) > 0 then 'BLOCKED'
           else 'DELETE'
         end,
         case
           when k.linked_id is null then array['NOT_LINKED']
           when k.pid is null then array['PRODUCT_ALREADY_DELETED']
           else k.blockers
         end,
         k.linked_id is not null,
         case when k.pid is null then '{}'::jsonb else jsonb_build_object(
           'prices', (select count(*) from public.product_prices x where x.product_id = k.pid),
           'costs', (select count(*) from public.product_costs x where x.product_id = k.pid),
           'pricingSettings', (select count(*) from public.product_pricing_settings x where x.product_id = k.pid),
           'barcodes', (select count(*) from public.product_barcodes x where x.product_id = k.pid),
           'suppliers', (select count(*) from public.product_suppliers x where x.product_id = k.pid),
           'assortment', (select count(*) from public.branch_product_assortment x where x.product_id = k.pid),
           'categories', (select count(*) from public.product_category_assignments x where x.product_id = k.pid),
           'stockSettings', (select count(*) from public.branch_product_stock_settings x where x.product_id = k.pid),
           'promotions', (select count(*) from public.product_weight_discounts x where x.product_id = k.pid),
           'externalLinks', (select count(*) from public.external_entity_links x where x.organization_id = p_organization_id and x.entity_type = 'product' and x.internal_id = k.pid)
         ) end
  from checked k
  order by k.ordinal;
$$;

revoke all on function app_private.classify_import_product_purge(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- Sucursal productiva (Central) de la organización: el único destino de los productos importados (D-049/D-053).
create function app_private.purge_destination_branch(p_organization_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
begin
  select o.production_branch_id into v_branch from public.organizations o where o.id = p_organization_id;
  if v_branch is null then
    raise exception 'La sucursal productiva (Central) no está configurada: no se puede determinar el destino de los productos importados' using errcode = '22023';
  end if;
  return v_branch;
end;
$$;

revoke all on function app_private.purge_destination_branch(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Preview: no escribe nada. Lista, por candidato, qué pasaría.
-- ---------------------------------------------------------------------------------------------
create function public.preview_import_product_purge(p_source_system text, p_candidates jsonb)
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
begin
  perform app_private.require_permission('products.write');
  perform app_private.purge_validate_candidates(p_source_system, p_candidates);
  v_branch := app_private.purge_destination_branch(v_org);
  select b.name into v_branch_name from public.branches b where b.id = v_branch;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ordinal', c.ordinal, 'externalId', c.external_id, 'quantity', c.quantity, 'fileName', c.file_name,
           'productId', c.product_id, 'productName', c.product_name, 'sku', c.product_sku, 'active', c.product_active,
           'verdict', c.verdict, 'reasons', to_jsonb(c.reasons), 'catalogRefs', c.catalog_refs
         ) order by c.ordinal), '[]'::jsonb)
  into v_items
  from app_private.classify_import_product_purge(v_org, p_source_system, v_branch, p_candidates) c;

  select jsonb_build_object(
           'total', count(*),
           'delete', count(*) filter (where c.verdict = 'DELETE'),
           'blocked', count(*) filter (where c.verdict = 'BLOCKED'),
           'skipped', count(*) filter (where c.verdict = 'SKIP')
         )
  into v_summary
  from app_private.classify_import_product_purge(v_org, p_source_system, v_branch, p_candidates) c;

  return jsonb_build_object(
    'sourceSystem', p_source_system, 'branchId', v_branch, 'branchName', v_branch_name,
    'summary', v_summary, 'items', v_items
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Purga: borra de verdad (hard delete) los candidatos que el preview marca DELETE y sólo ésos.
-- ---------------------------------------------------------------------------------------------
create function public.purge_import_products(p_source_system text, p_candidates jsonb, p_expected_delete_count integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('imports.write');
  v_branch uuid;
  v_row record;
  v_deleted jsonb := '[]'::jsonb;
  v_blocked jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_to_delete integer;
  v_stale_links integer := 0;
  v_removed jsonb;
  v_before jsonb;
  v_count integer;
begin
  perform app_private.require_permission('products.write');
  if p_expected_delete_count is null or p_expected_delete_count < 0 then
    raise exception 'Falta el conteo del preview (p_expected_delete_count)' using errcode = '22023';
  end if;
  perform app_private.purge_validate_candidates(p_source_system, p_candidates);
  v_branch := app_private.purge_destination_branch(v_org);
  -- Una purga a la vez por organización: dos operadores no se pisan.
  perform pg_advisory_xact_lock(hashtextextended('purge_import_products:' || v_org::text, 0));

  select count(*) into v_to_delete
  from app_private.classify_import_product_purge(v_org, p_source_system, v_branch, p_candidates) c
  where c.verdict = 'DELETE';
  if v_to_delete <> p_expected_delete_count then
    raise exception 'PURGE_PREVIEW_STALE: el preview informó % productos a borrar y ahora son %; generá el preview de nuevo', p_expected_delete_count, v_to_delete
      using errcode = '40001';
  end if;

  for v_row in
    select * from app_private.classify_import_product_purge(v_org, p_source_system, v_branch, p_candidates) order by ordinal
  loop
    if v_row.verdict = 'SKIP' then
      -- Un vínculo huérfano (el producto ya no existe) no sirve para nada y haría que una reimportación lo "relinkee": se limpia.
      if v_row.link_exists and v_row.product_id is null then
        delete from public.external_entity_links l
        where l.organization_id = v_org and l.source_system = p_source_system and l.entity_type = 'product' and l.external_id = v_row.external_id;
        v_stale_links := v_stale_links + 1;
      end if;
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('externalId', v_row.external_id, 'reasons', to_jsonb(v_row.reasons)));
      continue;
    end if;
    if v_row.verdict = 'BLOCKED' then
      v_blocked := v_blocked || jsonb_build_array(jsonb_build_object(
        'externalId', v_row.external_id, 'quantity', v_row.quantity, 'productId', v_row.product_id,
        'productName', v_row.product_name, 'sku', v_row.product_sku, 'reasons', to_jsonb(v_row.reasons)));
      continue;
    end if;

    -- verdict = DELETE: todo o nada para ESTE producto (si una FK inesperada lo impide, se deshace y se informa).
    begin
      perform 1 from public.products p where p.id = v_row.product_id and p.organization_id = v_org for update;
      select to_jsonb(p) || jsonb_build_object('purge', jsonb_build_object(
               'sourceSystem', p_source_system, 'externalId', v_row.external_id, 'originalQuantity', v_row.quantity))
        into v_before from public.products p where p.id = v_row.product_id;

      delete from public.product_prices where product_id = v_row.product_id and organization_id = v_org;
      delete from public.product_costs where product_id = v_row.product_id and organization_id = v_org;
      delete from public.product_pricing_settings where product_id = v_row.product_id and organization_id = v_org;
      delete from public.product_barcodes where product_id = v_row.product_id and organization_id = v_org;
      delete from public.product_suppliers where product_id = v_row.product_id and organization_id = v_org;
      delete from public.branch_product_assortment where product_id = v_row.product_id and organization_id = v_org;
      delete from public.product_category_assignments where product_id = v_row.product_id and organization_id = v_org;
      delete from public.branch_product_stock_settings where product_id = v_row.product_id and organization_id = v_org;
      delete from public.product_weight_discounts where product_id = v_row.product_id and organization_id = v_org;
      delete from public.external_entity_links
      where organization_id = v_org and entity_type = 'product' and internal_id = v_row.product_id;
      delete from public.products where id = v_row.product_id and organization_id = v_org;
      get diagnostics v_count = row_count;
      if v_count <> 1 then
        raise exception 'PURGE_PRODUCT_NOT_DELETED' using errcode = 'P0001';
      end if;

      perform app_private.write_audit(v_org, null, 'PRODUCTS_IMPORT_PURGE', 'products', v_row.product_id, v_before, null);
      v_removed := v_row.catalog_refs;
      v_deleted := v_deleted || jsonb_build_array(jsonb_build_object(
        'externalId', v_row.external_id, 'quantity', v_row.quantity, 'productId', v_row.product_id,
        'productName', v_row.product_name, 'sku', v_row.product_sku, 'removed', v_removed));
    exception when foreign_key_violation or restrict_violation then
      v_blocked := v_blocked || jsonb_build_array(jsonb_build_object(
        'externalId', v_row.external_id, 'quantity', v_row.quantity, 'productId', v_row.product_id,
        'productName', v_row.product_name, 'sku', v_row.product_sku,
        'reasons', jsonb_build_array('UNEXPECTED_REFERENCE'), 'detail', sqlerrm));
    end;
  end loop;

  return jsonb_build_object(
    'sourceSystem', p_source_system, 'branchId', v_branch,
    'summary', jsonb_build_object(
      'requested', jsonb_array_length(p_candidates),
      'deleted', jsonb_array_length(v_deleted),
      'blocked', jsonb_array_length(v_blocked),
      'skipped', jsonb_array_length(v_skipped),
      'staleLinksRemoved', v_stale_links
    ),
    'deleted', v_deleted, 'blocked', v_blocked, 'skipped', v_skipped
  );
end;
$$;

revoke all on function public.preview_import_product_purge(text, jsonb) from public, anon;
revoke all on function public.purge_import_products(text, jsonb, integer) from public, anon;
grant execute on function public.preview_import_product_purge(text, jsonb) to authenticated;
grant execute on function public.purge_import_products(text, jsonb, integer) to authenticated;

comment on function public.purge_import_products(text, jsonb, integer) is
  'Hard-delete controlado de productos importados cuya CANTIDAD original (archivo de origen, nunca el ledger) era <= 0. Ver docs/IMPORTS.md "Purga de productos importados sin stock".';

-- ---------------------------------------------------------------------------------------------
-- Sync del POS: un producto BORRADO de verdad (hard delete) ya no existe en `products`, así que el POS nunca lo veía en
-- `removedProductIds` (que sólo se arma con productos que todavía existen) y lo seguiría mostrando y vendiendo desde su
-- SQLite. El log del cursor sí lo recuerda (el trigger de `products` registra el DELETE): los ids PRODUCT del log que
-- ya no existen se agregan a `removedProductIds`. Es la única diferencia con la versión de 202609300045.
-- ---------------------------------------------------------------------------------------------
create or replace function public.pull_pos_state(p_device_id uuid, p_after_sequence bigint default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_profile_id uuid := auth.uid();
  current_organization_id uuid;
  current_branch_id uuid;
  current_branch_name text;
  current_branch_active boolean;
  current_device_status public.pos_device_status;
  current_role_name text;
  current_cursor bigint;
  current_server_time timestamptz := now();
  catalog_payload jsonb;
  removed_payload jsonb;
  categories_payload jsonb;
begin
  if current_profile_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select d.organization_id, d.branch_id, b.name, b.active, d.status, r.name
  into current_organization_id, current_branch_id, current_branch_name,
       current_branch_active, current_device_status, current_role_name
  from public.pos_devices d
  join public.branches b on b.id = d.branch_id and b.organization_id = d.organization_id
  join public.organization_members om on om.organization_id = d.organization_id and om.profile_id = current_profile_id and om.status = 'ACTIVE'
  join public.roles r on r.id = om.role_id
  where d.id = p_device_id;
  if not found or current_device_status <> 'ACTIVE' or not current_branch_active
     or not app_private.can_access_branch(current_organization_id, current_branch_id, 'sales.create') then
    raise exception 'Device or branch is not authorized for this user' using errcode = '42501';
  end if;
  select coalesce(max(c.sequence), p_after_sequence) into current_cursor
  from public.pos_catalog_changes c
  where c.organization_id = current_organization_id and (c.branch_id is null or c.branch_id = current_branch_id);
  with changed_products as (
    select distinct p.id
    from public.products p
    where p.organization_id = current_organization_id and (
      p_after_sequence = 0 or exists (
        select 1 from public.pos_catalog_changes c
        where c.organization_id = current_organization_id and c.sequence > p_after_sequence
          and (c.branch_id is null or c.branch_id = current_branch_id)
          and ((c.entity_type in ('PRODUCT', 'PRICE') and c.entity_id = p.id)
            or (c.entity_type = 'CATEGORY' and c.entity_id = p.category_id)
            or c.entity_type = 'BRANCH')
      )
    )
  ), effective_catalog as (
    select p.organization_id, current_branch_id as branch_id, current_branch_name as branch_name,
      current_branch_active as branch_active, c.id as category_id, c.name as category_name,
      c.color_hex as category_color_hex, c.sort_order as category_sort_order, c.active as category_active,
      p.id as product_id, p.name as product_name, p.sku as product_sku, p.unit_type,
      p.active as product_active, effective_price.price_cents, effective_price.valid_from,
      assigned_categories.category_ids, product_codes.barcodes
    from changed_products changed
    join public.products p on p.id = changed.id and p.organization_id = current_organization_id
    join public.branch_product_assortment a
      on a.product_id = p.id and a.branch_id = current_branch_id and a.organization_id = p.organization_id
    join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    join lateral (
      select pp.price_cents, pp.valid_from
      from public.product_prices pp
      where pp.organization_id = p.organization_id and pp.product_id = p.id
        and (pp.branch_id = current_branch_id or pp.branch_id is null)
        and pp.valid_from <= current_server_time and (pp.valid_to is null or pp.valid_to > current_server_time)
      order by (pp.branch_id = current_branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) effective_price on true
    left join lateral (
      select array_agg(pca.category_id) as category_ids
      from public.product_category_assignments pca
      join public.categories cc on cc.id = pca.category_id and cc.organization_id = p.organization_id and cc.active
      where pca.product_id = p.id and pca.organization_id = p.organization_id
    ) assigned_categories on true
    left join lateral (
      select array_agg(pb.barcode order by pb.barcode) as barcodes
      from public.product_barcodes pb
      where pb.product_id = p.id and pb.organization_id = p.organization_id
    ) product_codes on true
    where p.active and c.active and current_branch_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', organization_id, 'branchId', branch_id, 'branchName', branch_name,
    'branchActive', branch_active, 'categoryId', category_id, 'categoryName', category_name,
    'categoryColorHex', category_color_hex, 'categorySortOrder', category_sort_order,
    'categoryActive', category_active, 'categoryIds', coalesce(to_jsonb(category_ids), jsonb_build_array(category_id)),
    'productId', product_id, 'productName', product_name,
    'productSku', product_sku, 'unitType', unit_type, 'productActive', product_active,
    'pricePerKgCents', price_cents::text, 'priceValidFrom', valid_from,
    'barcodes', coalesce(to_jsonb(barcodes), '[]'::jsonb)
  ) order by category_sort_order, category_name, product_name), '[]'::jsonb)
  into catalog_payload from effective_catalog;
  with changed_products as (
    select distinct p.id
    from public.products p
    where p.organization_id = current_organization_id and (
      p_after_sequence = 0 or exists (
        select 1 from public.pos_catalog_changes c
        where c.organization_id = current_organization_id and c.sequence > p_after_sequence
          and (c.branch_id is null or c.branch_id = current_branch_id)
          and ((c.entity_type in ('PRODUCT', 'PRICE') and c.entity_id = p.id)
            or (c.entity_type = 'CATEGORY' and c.entity_id = p.category_id)
            or c.entity_type = 'BRANCH')
      )
    )
  )
  select coalesce(jsonb_agg(changed.id), '[]'::jsonb) into removed_payload
  from changed_products changed
  where not exists (
    select 1 from public.products p
    join public.branch_product_assortment a
      on a.product_id = p.id and a.branch_id = current_branch_id and a.organization_id = p.organization_id
    join public.categories c on c.id = p.category_id and c.active
    join lateral (
      select 1 from public.product_prices pp
      where pp.product_id = p.id and pp.organization_id = p.organization_id
        and (pp.branch_id = current_branch_id or pp.branch_id is null)
        and pp.valid_from <= current_server_time and (pp.valid_to is null or pp.valid_to > current_server_time)
      limit 1
    ) price_exists on true
    where p.id = changed.id and p.active and current_branch_active
  );
  -- Productos borrados de verdad: ya no existen en `products`, pero el log del cursor guarda su id.
  if p_after_sequence > 0 then
    select removed_payload || coalesce(jsonb_agg(deleted.id), '[]'::jsonb) into removed_payload
    from (
      select distinct c.entity_id as id
      from public.pos_catalog_changes c
      where c.organization_id = current_organization_id and c.sequence > p_after_sequence
        and (c.branch_id is null or c.branch_id = current_branch_id)
        and c.entity_type = 'PRODUCT'
        and not exists (select 1 from public.products p where p.id = c.entity_id)
    ) deleted;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'colorHex', c.color_hex, 'sortOrder', c.sort_order
  ) order by c.sort_order, c.name), '[]'::jsonb)
  into categories_payload
  from public.categories c
  where c.organization_id = current_organization_id and c.active
    and exists (
      select 1
      from public.product_category_assignments pca
      join public.branch_product_assortment a
        on a.product_id = pca.product_id and a.branch_id = current_branch_id and a.organization_id = pca.organization_id
      where pca.category_id = c.id and pca.organization_id = c.organization_id
    );

  update public.pos_devices set last_seen_at = current_server_time where id = p_device_id;
  return jsonb_build_object(
    'cursor', current_cursor, 'serverTime', current_server_time,
    'authorizationExpiresAt', current_server_time + interval '24 hours',
    'organizationId', current_organization_id, 'branchId', current_branch_id,
    'branchName', current_branch_name, 'branchActive', current_branch_active,
    'deviceStatus', current_device_status, 'roleName', current_role_name,
    'catalog', catalog_payload, 'removedProductIds', removed_payload, 'categories', categories_payload
  );
end;
$$;

commit;
