begin;

-- Support for Admin → Importación de productos (docs/IMPORTS.md, "Pantalla de importación").
-- 202609300043/044/046 may already be applied, so every change lives in this migration; the three
-- functions below are replaced with CREATE OR REPLACE (same signatures, same bodies) plus the
-- additions marked "NEW".
--
--   1. create_import_batch accepts two more options:
--        createMissingCategories  (product batches) a row whose categoryName matches no category
--                                 creates it. The PREVIEW already classifies the row as CREATE
--                                 (instead of CATEGORY_NOT_FOUND), so nothing is written before the
--                                 operator confirms; apply creates the category once and every later
--                                 row with the same (normalized) name finds it.
--        runId                    uuid shared by the batches of ONE logical import (a 3000-row file
--                                 is staged as several <=1000-row batches); lets the history screen
--                                 show a single line per import.
--   2. import_classify_product
--        * a row whose payload carries `invalidReason` is an ERROR (INVALID_ROW) with that message.
--          The uploader stages EVERY row of the file, including the ones it already knows are
--          unusable (missing price, repeated across batches, ...), so import_rows is the complete
--          record of the file and the preview lists each rejected row with its cause.
--        * "category not found" is split from "category ambiguous" (two categories whose normalized
--          names collide) and "category name too long".
--        * adopting (linkExistingBy) an existing product whose forma de venta differs from the file's
--          is UNIT_TYPE_MISMATCH instead of silently flipping it (UNIT_TYPE_LOCKED still wins when the
--          product has history, as before).
--   3. import_apply_product creates the missing category (only with createMissingCategories).
--
-- Nothing else changes: same actions/reason codes, same dedupe rules, same atomic apply.

create or replace function public.create_import_batch(
  p_source_system text,
  p_entity_type text,
  p_file_name text default null,
  p_file_sha256 text default null,
  p_branch_id uuid default null,
  p_options jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('imports.write');
  normalized_options jsonb := coalesce(p_options, '{}'::jsonb);
  option_key text;
  link_key text;
  new_batch_id uuid;
begin
  if p_source_system is null or p_source_system !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'source_system debe ser minúsculas/números/guion bajo (ej. simplygest)' using errcode = '22023';
  end if;
  if p_entity_type is null or p_entity_type not in ('category', 'product', 'stock_opening_balance') then
    raise exception 'Tipo de entidad no soportado: %', p_entity_type using errcode = '22023';
  end if;
  -- The caller must also be allowed to write the entity itself (defense in depth: imports.write
  -- alone never grants product/stock writes).
  if not app_private.has_permission(
       current_organization_id, case when p_entity_type = 'stock_opening_balance' then 'stock.write' else 'products.write' end) then
    raise exception 'Permiso insuficiente para importar este tipo de dato' using errcode = '42501';
  end if;

  if p_entity_type = 'stock_opening_balance' then
    if p_branch_id is null or not app_private.can_access_branch(current_organization_id, p_branch_id, 'stock.write') then
      raise exception 'El stock inicial requiere una sucursal activa autorizada' using errcode = '42501';
    end if;
  elsif p_entity_type = 'product' then
    -- Imported products are enabled ONLY in the destination branch (surtido), so the destination
    -- is mandatory: a product imported "nowhere" would be invisible in every POS.
    if p_branch_id is null or not app_private.can_access_branch(current_organization_id, p_branch_id, 'products.write') then
      raise exception 'Los productos se importan hacia una sucursal destino activa' using errcode = '42501';
    end if;
  elsif p_branch_id is not null then
    raise exception 'Las categorías se importan para toda la organización, sin sucursal' using errcode = '22023';
  end if;

  if jsonb_typeof(normalized_options) <> 'object' then
    raise exception 'options debe ser un objeto' using errcode = '22023';
  end if;
  for option_key in select jsonb_object_keys(normalized_options)
  loop
    if option_key not in ('linkExistingBy', 'defaultCategoryId', 'createMissingCategories', 'runId') then
      raise exception 'Opción desconocida: %', option_key using errcode = '22023';
    end if;
  end loop;
  if normalized_options ? 'linkExistingBy' then
    if jsonb_typeof(normalized_options -> 'linkExistingBy') <> 'array' then
      raise exception 'linkExistingBy debe ser una lista' using errcode = '22023';
    end if;
    for link_key in select jsonb_array_elements_text(normalized_options -> 'linkExistingBy')
    loop
      if not (link_key = any (case p_entity_type
            when 'product' then array['sku', 'barcode', 'name']
            when 'category' then array['name']
            else array[]::text[] end)) then
        raise exception 'linkExistingBy no admite "%" para %', link_key, p_entity_type using errcode = '22023';
      end if;
    end loop;
  end if;
  if normalized_options ? 'defaultCategoryId' then
    if p_entity_type <> 'product' or not exists (
      select 1 from public.categories c
      where c.organization_id = current_organization_id
        and c.id::text = normalized_options ->> 'defaultCategoryId'
    ) then
      raise exception 'defaultCategoryId debe ser una categoría existente (sólo para productos)' using errcode = '22023';
    end if;
  end if;
  -- NEW
  if normalized_options ? 'createMissingCategories' then
    if p_entity_type <> 'product' or jsonb_typeof(normalized_options -> 'createMissingCategories') <> 'boolean' then
      raise exception 'createMissingCategories debe ser true o false (sólo para productos)' using errcode = '22023';
    end if;
  end if;
  -- NEW
  if normalized_options ? 'runId' then
    if jsonb_typeof(normalized_options -> 'runId') <> 'string'
       or (normalized_options ->> 'runId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'runId debe ser un UUID' using errcode = '22023';
    end if;
  end if;

  insert into public.import_batches (
    organization_id, source_system, entity_type, branch_id, file_name, file_sha256, options, created_by
  ) values (
    current_organization_id, p_source_system, p_entity_type, p_branch_id,
    nullif(btrim(p_file_name), ''), lower(nullif(btrim(p_file_sha256), '')), normalized_options, auth.uid()
  ) returning id into new_batch_id;

  perform app_private.write_audit(
    current_organization_id, p_branch_id, 'IMPORT_BATCH_CREATED', 'import_batches', new_batch_id, null,
    jsonb_build_object('sourceSystem', p_source_system, 'entityType', p_entity_type, 'fileName', p_file_name)
  );
  return new_batch_id;
end;
$$;

create or replace function app_private.import_classify_product(
  p_batch public.import_batches,
  p_row public.import_rows,
  out o_action text,
  out o_reason text,
  out o_message text,
  out o_internal_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := p_batch.organization_id;
  v_payload jsonb := p_row.payload;
  v_name text := btrim(v_payload ->> 'name');
  v_unit text := v_payload ->> 'unitType';
  v_sku text := nullif(upper(btrim(v_payload ->> 'sku')), '');
  v_barcodes text[] := array[]::text[];
  v_raw text;
  v_code text;
  v_link_by text[] := app_private.import_link_existing_by(p_batch.options);
  v_link public.external_entity_links%rowtype;
  v_linked_id uuid;
  v_target uuid;
  v_existing public.products%rowtype;
  v_candidates uuid[] := array[]::uuid[];
  v_ids uuid[];
  v_owner uuid;
  v_owner_name text;
  v_category_provided boolean;
  v_category_id uuid;
  v_category_name text := nullif(btrim(v_payload ->> 'categoryName'), '');
  v_category_matches integer;
  v_category_will_be_created boolean := false;
begin
  -- NEW: a row the uploader already rejected is reported as such (and never applied).
  if v_payload ? 'invalidReason' and jsonb_typeof(v_payload -> 'invalidReason') = 'string' then
    o_action := 'ERROR'; o_reason := 'INVALID_ROW';
    o_message := left(coalesce(nullif(btrim(v_payload ->> 'invalidReason'), ''), 'Fila inválida'), 500);
    return;
  end if;

  -- ---- field validation -------------------------------------------------------------------
  if v_name is null or char_length(v_name) not between 1 and 120 then
    o_action := 'ERROR'; o_reason := 'INVALID_NAME';
    o_message := 'El nombre del producto es obligatorio (1 a 120 caracteres)';
    return;
  end if;
  if v_unit is null or v_unit not in ('WEIGHT', 'UNIT') then
    o_action := 'ERROR'; o_reason := 'INVALID_UNIT_TYPE';
    o_message := 'unitType debe ser WEIGHT (por peso) o UNIT (por unidad)';
    return;
  end if;
  if v_sku is not null and char_length(v_sku) > 50 then
    o_action := 'ERROR'; o_reason := 'INVALID_SKU';
    o_message := 'El SKU supera los 50 caracteres';
    return;
  end if;
  if v_payload ? 'barcodes' and jsonb_typeof(v_payload -> 'barcodes') <> 'null' then
    if jsonb_typeof(v_payload -> 'barcodes') <> 'array' then
      o_action := 'ERROR'; o_reason := 'INVALID_BARCODE';
      o_message := 'barcodes debe ser una lista de códigos';
      return;
    end if;
    for v_raw in select jsonb_array_elements_text(v_payload -> 'barcodes')
    loop
      v_code := app_private.normalize_barcode(v_raw);
      if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9._-]{2,63}$' then
        o_action := 'ERROR'; o_reason := 'INVALID_BARCODE';
        o_message := format('Código de barras inválido: %s', v_raw);
        return;
      end if;
      if not (v_code = any (v_barcodes)) then
        v_barcodes := v_barcodes || v_code;
      end if;
    end loop;
  end if;
  if v_payload ? 'priceCents' and jsonb_typeof(v_payload -> 'priceCents') <> 'null'
     and app_private.import_positive_bigint(v_payload -> 'priceCents') is null then
    o_action := 'ERROR'; o_reason := 'INVALID_PRICE';
    o_message := 'priceCents debe ser un entero mayor a 0 (centavos)';
    return;
  end if;
  if v_payload ? 'costCents' and jsonb_typeof(v_payload -> 'costCents') <> 'null'
     and app_private.import_positive_bigint(v_payload -> 'costCents') is null then
    o_action := 'ERROR'; o_reason := 'INVALID_COST';
    o_message := 'costCents debe ser un entero mayor a 0 (centavos)';
    return;
  end if;
  if v_payload ? 'active' and jsonb_typeof(v_payload -> 'active') not in ('boolean', 'null') then
    o_action := 'ERROR'; o_reason := 'INVALID_ACTIVE';
    o_message := 'active debe ser true o false';
    return;
  end if;
  if v_payload ? 'inventoryRole' and jsonb_typeof(v_payload -> 'inventoryRole') <> 'null'
     and coalesce(v_payload ->> 'inventoryRole', '') not in ('RAW_MATERIAL', 'SELLABLE', 'BOTH') then
    o_action := 'ERROR'; o_reason := 'INVALID_INVENTORY_ROLE';
    o_message := 'inventoryRole debe ser RAW_MATERIAL, SELLABLE o BOTH';
    return;
  end if;

  -- ---- known external id? ------------------------------------------------------------------
  select * into v_link from public.external_entity_links l
  where l.organization_id = v_org and l.source_system = p_batch.source_system
    and l.entity_type = 'product' and l.external_id = p_row.external_id;
  if found then
    select p.id into v_linked_id from public.products p where p.id = v_link.internal_id and p.organization_id = v_org;
  end if;

  if v_linked_id is not null and v_link.content_hash = p_row.content_hash then
    o_action := 'IGNORE'; o_reason := 'UNCHANGED'; o_message := 'Sin cambios desde la última importación';
    o_internal_id := v_linked_id;
    return;
  end if;

  -- ---- which existing product (if any) is the target? ---------------------------------------
  if v_linked_id is not null then
    v_target := v_linked_id;
  else
    if v_sku is not null and 'sku' = any (v_link_by) then
      select p.id into v_owner from public.products p where p.organization_id = v_org and p.sku = v_sku;
      if v_owner is not null then v_candidates := v_candidates || v_owner; end if;
    end if;
    if 'barcode' = any (v_link_by) and cardinality(v_barcodes) > 0 then
      select coalesce(array_agg(distinct pb.product_id), array[]::uuid[]) into v_ids
      from public.product_barcodes pb where pb.organization_id = v_org and pb.barcode = any (v_barcodes);
      v_candidates := v_candidates || v_ids;
    end if;
    if 'name' = any (v_link_by) then
      select coalesce(array_agg(p.id), array[]::uuid[]) into v_ids
      from public.products p
      where p.organization_id = v_org and app_private.import_normalize_text(p.name) = app_private.import_normalize_text(v_name);
      v_candidates := v_candidates || v_ids;
    end if;
    select coalesce(array_agg(distinct c), array[]::uuid[]) into v_candidates from unnest(v_candidates) as c;
    if cardinality(v_candidates) > 1 then
      o_action := 'ERROR'; o_reason := 'AMBIGUOUS_MATCH';
      o_message := 'La fila coincide con más de un producto existente; no se puede elegir uno automáticamente';
      return;
    end if;
    if cardinality(v_candidates) = 1 then
      v_target := v_candidates[1];
      if exists (
        select 1 from public.external_entity_links l
        where l.organization_id = v_org and l.source_system = p_batch.source_system
          and l.entity_type = 'product' and l.internal_id = v_target
      ) then
        o_action := 'ERROR'; o_reason := 'ALREADY_LINKED';
        o_message := 'El producto existente que coincide ya está vinculado a otro código externo';
        return;
      end if;
    end if;
  end if;

  -- ---- collisions with OTHER products --------------------------------------------------------
  if v_sku is not null then
    select p.id, p.name into v_owner, v_owner_name
    from public.products p where p.organization_id = v_org and p.sku = v_sku;
    if v_owner is not null and v_owner is distinct from v_target then
      o_action := 'ERROR'; o_reason := 'SKU_CONFLICT';
      o_message := format('El SKU %s ya pertenece al producto "%s"', v_sku, v_owner_name);
      return;
    end if;
  end if;
  if cardinality(v_barcodes) > 0 then
    select p.name into v_owner_name
    from public.product_barcodes pb
    join public.products p on p.id = pb.product_id and p.organization_id = pb.organization_id
    where pb.organization_id = v_org and pb.barcode = any (v_barcodes) and pb.product_id is distinct from v_target
    limit 1;
    if found then
      o_action := 'ERROR'; o_reason := 'BARCODE_CONFLICT';
      o_message := format('Un código de barras de la fila ya pertenece al producto "%s"', v_owner_name);
      return;
    end if;
  end if;
  if v_linked_id is null then
    select p.name into v_owner_name
    from public.products p
    where p.organization_id = v_org
      and app_private.import_normalize_text(p.name) = app_private.import_normalize_text(v_name)
      and p.id is distinct from v_target
    limit 1;
    if found then
      o_action := 'ERROR'; o_reason := 'NAME_CONFLICT';
      o_message := format('Ya existe un producto llamado "%s" que no fue importado desde este sistema', v_owner_name);
      return;
    end if;
  end if;

  -- ---- category and unit-type rules ------------------------------------------------------------
  select r.o_provided, r.o_category_id into v_category_provided, v_category_id
  from app_private.import_resolve_product_category(p_batch, v_payload, v_target is null) r;
  if v_category_id is null and (v_target is null or v_category_provided) then
    -- NEW: with createMissingCategories a categoryName that matches nothing is not an error, the
    -- category is created on apply. More than one match stays an error (we cannot pick one).
    if v_category_provided and nullif(btrim(v_payload ->> 'categoryExternalId'), '') is null and v_category_name is not null then
      select count(*) into v_category_matches from public.categories c
      where c.organization_id = v_org
        and app_private.import_normalize_text(c.name) = app_private.import_normalize_text(v_category_name);
      if v_category_matches > 1 then
        o_action := 'ERROR'; o_reason := 'CATEGORY_AMBIGUOUS';
        o_message := format('Hay más de una categoría llamada "%s"; el sistema no puede elegir una', v_category_name);
        return;
      elsif v_category_matches = 0 and coalesce((p_batch.options ->> 'createMissingCategories')::boolean, false) then
        if char_length(v_category_name) > 100 then
          o_action := 'ERROR'; o_reason := 'INVALID_CATEGORY';
          o_message := 'El nombre de la categoría supera los 100 caracteres';
          return;
        end if;
        v_category_will_be_created := true;
      end if;
    end if;
    if not v_category_will_be_created then
      o_action := 'ERROR'; o_reason := 'CATEGORY_NOT_FOUND';
      o_message := 'No se encontró la categoría del producto; importá las categorías primero o indicá defaultCategoryId';
      return;
    end if;
  end if;
  if v_target is not null then
    select * into v_existing from public.products p where p.id = v_target and p.organization_id = v_org;
    if v_existing.unit_type::text <> v_unit and app_private.product_has_operational_history(v_target) then
      o_action := 'ERROR'; o_reason := 'UNIT_TYPE_LOCKED';
      o_message := 'No se puede cambiar la forma de venta: el producto ya tiene ventas, stock, producción o promociones';
      return;
    end if;
    -- NEW: adopting a product this import did not create must not silently flip its forma de venta
    -- (a butcher product sold by kg whose SKU happens to equal a SimplyGest code stays untouched).
    if v_linked_id is null and v_existing.unit_type::text <> v_unit then
      o_action := 'ERROR'; o_reason := 'UNIT_TYPE_MISMATCH';
      o_message := format('El producto existente "%s" se vende por %s y el archivo lo trae por %s: no se vincula automáticamente',
        v_existing.name, case v_existing.unit_type::text when 'WEIGHT' then 'peso' else 'unidad' end, case v_unit when 'WEIGHT' then 'peso' else 'unidad' end);
      return;
    end if;
  end if;

  -- ---- verdict -----------------------------------------------------------------------------------
  if v_target is not null then
    o_action := 'UPDATE'; o_internal_id := v_target; o_message := null;
    o_reason := case when v_linked_id is null then 'LINK_EXISTING' else 'CHANGED' end;
  else
    o_action := 'CREATE'; o_message := null;
    o_reason := case when v_link.internal_id is null then 'NEW' else 'RELINK' end;
  end if;
end;
$$;

create or replace function app_private.import_apply_product(
  p_batch public.import_batches,
  p_row public.import_rows,
  p_target uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := p_batch.organization_id;
  v_payload jsonb := p_row.payload;
  v_name text := btrim(v_payload ->> 'name');
  v_unit public.unit_type := (v_payload ->> 'unitType')::public.unit_type;
  v_sku text := nullif(upper(btrim(v_payload ->> 'sku')), '');
  v_existing public.products%rowtype;
  v_category_id uuid;
  v_category_name text := nullif(btrim(v_payload ->> 'categoryName'), '');
  v_provided boolean;
  v_id uuid;
  v_price bigint := app_private.import_positive_bigint(v_payload -> 'priceCents');
  v_cost bigint := app_private.import_positive_bigint(v_payload -> 'costCents');
  v_current bigint;
begin
  select r.o_provided, r.o_category_id into v_provided, v_category_id
  from app_private.import_resolve_product_category(p_batch, v_payload, p_target is null) r;

  -- NEW: createMissingCategories. Re-checked here (not just trusted from the preview) so a category
  -- another user created meanwhile is reused instead of duplicated.
  if v_category_id is null and v_provided and v_category_name is not null
     and nullif(btrim(v_payload ->> 'categoryExternalId'), '') is null
     and coalesce((p_batch.options ->> 'createMissingCategories')::boolean, false)
     and not exists (
       select 1 from public.categories c
       where c.organization_id = v_org
         and app_private.import_normalize_text(c.name) = app_private.import_normalize_text(v_category_name)
     ) then
    v_category_id := public.save_category(
      null, v_category_name, app_private.import_unique_slug(v_org, 'categories', v_category_name), 0, true, null
    );
  end if;

  if p_target is null then
    v_id := public.save_product(
      null, v_category_id, v_name, app_private.import_unique_slug(v_org, 'products', v_name),
      v_sku, v_unit, coalesce((v_payload ->> 'active')::boolean, true)
    );
    perform public.set_product_categories(v_id, v_category_id, array[v_category_id]);
    -- New products are enabled ONLY in the batch's destination branch. Updates of an existing
    -- product never touch its assortment (that is managed from Admin / the product modal).
    perform app_private.enable_product_in_branch(v_org, p_batch.branch_id, v_id);
  else
    select * into v_existing from public.products p where p.id = p_target and p.organization_id = v_org for update;
    if not v_provided then v_category_id := v_existing.category_id; end if;
    -- A blank/absent sku never clears an existing one (a mapper emitting "" must not wipe data).
    v_id := public.save_product(
      p_target, v_category_id, v_name, v_existing.slug, coalesce(v_sku, v_existing.sku), v_unit,
      coalesce((v_payload ->> 'active')::boolean, v_existing.active)
    );
    if v_category_id is distinct from v_existing.category_id then
      -- New principal replaces the old one; "also appears in" categories are kept.
      perform public.set_product_categories(
        v_id, v_category_id,
        coalesce((
          select array_agg(a.category_id) from public.product_category_assignments a
          where a.product_id = v_id and a.organization_id = v_org and a.category_id <> v_existing.category_id
        ), array[]::uuid[])
      );
    end if;
  end if;

  if v_payload ? 'inventoryRole' and jsonb_typeof(v_payload -> 'inventoryRole') <> 'null' then
    perform public.set_product_inventory_role(v_id, v_payload ->> 'inventoryRole');
  end if;
  perform app_private.add_product_barcodes(v_org, v_id, app_private.import_payload_barcodes(v_payload));

  -- Price/cost: only write when the value actually differs, so a re-import never piles up
  -- identical history rows (product_prices/product_costs are append-only with vigencia).
  if v_price is not null then
    select pp.price_cents into v_current
    from public.product_prices pp
    where pp.organization_id = v_org and pp.product_id = v_id and pp.branch_id is null
      and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
    order by pp.valid_from desc limit 1;
    if v_current is distinct from v_price then
      perform public.set_product_price(v_id, null, v_price);
    end if;
  end if;
  if v_cost is not null then
    select pc.cost_cents into v_current
    from public.product_costs pc
    where pc.organization_id = v_org and pc.product_id = v_id and pc.valid_to is null
    order by pc.valid_from desc limit 1;
    if v_current is distinct from v_cost then
      perform public.set_product_cost(v_id, v_cost);
    end if;
  end if;

  perform app_private.import_upsert_link(p_batch, p_row, 'product', v_id);
  return v_id;
end;
$$;

-- CREATE OR REPLACE keeps the existing grants, but state them again so this file is self-describing.
revoke all on function
  app_private.import_classify_product(public.import_batches, public.import_rows),
  app_private.import_apply_product(public.import_batches, public.import_rows, uuid)
from public, anon, authenticated;

revoke all on function public.create_import_batch(text, text, text, text, uuid, jsonb) from public, anon;
grant execute on function public.create_import_batch(text, text, text, text, uuid, jsonb) to authenticated;

commit;
