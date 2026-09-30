begin;

-- Import engine (see docs/IMPORTS.md). Flow, all through RPCs, all inside the caller's RLS/permission
-- envelope (no service_role, no direct table writes):
--
--   create_import_batch  → stage_import_rows (1..n calls) → preview_import_batch → apply_import_batch
--                                                      ↘ cancel_import_batch (any time before apply)
--
-- preview_import_batch classifies every staged row WITHOUT writing any business data:
--   CREATE  nothing with that external id exists yet → a new entity will be created
--   UPDATE  known external id (or explicitly allowed match) whose content changed
--   IGNORE  nothing to do (unchanged since last import / zero stock / already opened)
--   ERROR   cannot be applied; reason_code + Spanish message say why
-- apply_import_batch re-classifies right before writing and refuses to run if the result differs
-- from what was previewed (what you confirmed is what gets applied), then writes everything in ONE
-- transaction: any failure rolls the whole batch back.
--
-- Golden rule for duplicates: an import never writes to an entity it did not create itself or was
-- explicitly allowed to link (options.linkExistingBy). Everything else that collides is an ERROR,
-- not a silent merge. Running the same file twice therefore yields all-IGNORE the second time.

-- ---------------------------------------------------------------------------------------------
-- Small pure helpers
-- ---------------------------------------------------------------------------------------------

-- Hard cap per batch. Preview/apply are single atomic calls, and Supabase API roles run under a
-- short statement_timeout, so large files are split into several batches by the uploader.
create function app_private.import_max_batch_rows()
returns integer language sql immutable set search_path = '' as $$ select 1000; $$;

-- Case/accent/whitespace-insensitive comparison key for names ("Vacío" = "vacio  ").
create function app_private.import_normalize_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    regexp_replace(lower(translate(btrim(coalesce(p_text, '')), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunaeiouun')), '\s+', ' ', 'g'),
    ''
  );
$$;

create function app_private.import_slugify(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    nullif(trim(both '-' from left(regexp_replace(coalesce(app_private.import_normalize_text(p_text), ''), '[^a-z0-9]+', '-', 'g'), 80)), ''),
    'item'
  );
$$;

-- products.slug / categories.slug are unique per organization and required by save_product /
-- save_category; imports generate them ("coca-cola-2-25-l", "…-2" on collision).
create function app_private.import_unique_slug(p_organization_id uuid, p_table text, p_name text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  base_slug text := app_private.import_slugify(p_name);
  candidate text := base_slug;
  suffix integer := 1;
  taken boolean;
begin
  loop
    if p_table = 'products' then
      select exists (select 1 from public.products p where p.organization_id = p_organization_id and p.slug = candidate) into taken;
    else
      select exists (select 1 from public.categories c where c.organization_id = p_organization_id and c.slug = candidate) into taken;
    end if;
    exit when not taken;
    suffix := suffix + 1;
    candidate := base_slug || '-' || suffix;
  end loop;
  return candidate;
end;
$$;

-- Positive integer (<= 2^53-1) out of a jsonb number; null for anything else. Explicit IFs: SQL
-- AND/CASE do not guarantee evaluation order, and a bad cast here must never raise.
create function app_private.import_positive_bigint(p_value jsonb)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  numeric_value numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then
    return null;
  end if;
  numeric_value := (p_value #>> '{}')::numeric;
  if numeric_value <= 0 or numeric_value <> trunc(numeric_value) or numeric_value > 9007199254740991 then
    return null;
  end if;
  return numeric_value::bigint;
end;
$$;

-- Integral number (any sign, |n| <= 2^53-1) out of a jsonb number; null for anything else.
create function app_private.import_int_value(p_value jsonb)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  numeric_value numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then
    return null;
  end if;
  numeric_value := (p_value #>> '{}')::numeric;
  if numeric_value <> trunc(numeric_value) or abs(numeric_value) > 9007199254740991 then
    return null;
  end if;
  return numeric_value;
end;
$$;

-- options.linkExistingBy: which keys may link an unlinked EXISTING entity to an external id.
create function app_private.import_link_existing_by(p_options jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(value), array[]::text[])
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_options -> 'linkExistingBy') = 'array' then p_options -> 'linkExistingBy' else '[]'::jsonb end
  );
$$;

-- Normalized, de-duplicated barcodes of a product payload (invalid ones are rejected earlier by
-- the classifier, so they are simply skipped here).
create function app_private.import_payload_barcodes(p_payload jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  raw_value text;
  normalized text;
  result text[] := array[]::text[];
begin
  if jsonb_typeof(p_payload -> 'barcodes') <> 'array' then
    return result;
  end if;
  for raw_value in select jsonb_array_elements_text(p_payload -> 'barcodes')
  loop
    normalized := app_private.normalize_barcode(raw_value);
    if normalized is not null and normalized ~ '^[A-Z0-9][A-Z0-9._-]{2,63}$' and not (normalized = any (result)) then
      result := result || normalized;
    end if;
  end loop;
  return result;
end;
$$;

-- Same five "operational history" checks as save_product's unit-type guard (202609230032), so the
-- preview can report UNIT_TYPE_LOCKED instead of failing later inside apply.
create function app_private.product_has_operational_history(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.sale_items where product_id = p_product_id)
    or exists (select 1 from public.stock_movements where product_id = p_product_id)
    or exists (select 1 from public.production_batch_outputs where product_id = p_product_id)
    or exists (select 1 from public.production_batches where source_product_id = p_product_id)
    or exists (select 1 from public.product_weight_discounts where product_id = p_product_id);
$$;

-- A product is found by normalized name without a sequential scan per staged row.
create index products_normalized_name_idx
  on public.products (organization_id, (app_private.import_normalize_text(name)));

-- ---------------------------------------------------------------------------------------------
-- Category resolution for product rows (shared by the classifier and the apply step)
-- ---------------------------------------------------------------------------------------------
-- o_provided: the row says WHICH category it wants (categoryExternalId / categoryName).
-- o_category_id: the resolved internal category, or null if it cannot be resolved.
-- The batch default (options.defaultCategoryId) only ever applies to NEW products, never to an
-- update of a product that already has a category.
create function app_private.import_resolve_product_category(
  p_batch public.import_batches,
  p_payload jsonb,
  p_allow_default boolean,
  out o_provided boolean,
  out o_category_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  external_category text := nullif(btrim(p_payload ->> 'categoryExternalId'), '');
  category_name text := nullif(btrim(p_payload ->> 'categoryName'), '');
  matched uuid[];
begin
  o_provided := false;
  o_category_id := null;
  if external_category is not null then
    o_provided := true;
    select l.internal_id into o_category_id
    from public.external_entity_links l
    join public.categories c on c.id = l.internal_id and c.organization_id = l.organization_id
    where l.organization_id = p_batch.organization_id and l.source_system = p_batch.source_system
      and l.entity_type = 'category' and l.external_id = external_category;
  elsif category_name is not null then
    o_provided := true;
    select array_agg(c.id) into matched
    from public.categories c
    where c.organization_id = p_batch.organization_id
      and app_private.import_normalize_text(c.name) = app_private.import_normalize_text(category_name);
    if coalesce(array_length(matched, 1), 0) = 1 then
      o_category_id := matched[1];
    end if;
  elsif p_allow_default and nullif(p_batch.options ->> 'defaultCategoryId', '') is not null then
    select c.id into o_category_id
    from public.categories c
    where c.id = (p_batch.options ->> 'defaultCategoryId')::uuid and c.organization_id = p_batch.organization_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Classifiers: one per entity type. Pure reads; never write business data.
-- ---------------------------------------------------------------------------------------------

create function app_private.import_classify_category(
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
  v_name text := btrim(p_row.payload ->> 'name');
  v_normalized text := app_private.import_normalize_text(p_row.payload ->> 'name');
  v_link_by text[] := app_private.import_link_existing_by(p_batch.options);
  v_link public.external_entity_links%rowtype;
  v_linked_id uuid;
  v_all_ids uuid[];
  v_unlinked_ids uuid[];
  v_sort numeric;
begin
  if v_name is null or char_length(v_name) not between 1 and 100 then
    o_action := 'ERROR'; o_reason := 'INVALID_NAME';
    o_message := 'El nombre de la categoría es obligatorio (1 a 100 caracteres)';
    return;
  end if;
  if p_row.payload ? 'sortOrder' and jsonb_typeof(p_row.payload -> 'sortOrder') <> 'null' then
    v_sort := app_private.import_int_value(p_row.payload -> 'sortOrder');
    if v_sort is null or abs(v_sort) > 1000000 then
      o_action := 'ERROR'; o_reason := 'INVALID_SORT_ORDER';
      o_message := 'sortOrder debe ser un número entero';
      return;
    end if;
  end if;
  if p_row.payload ? 'active' and jsonb_typeof(p_row.payload -> 'active') not in ('boolean', 'null') then
    o_action := 'ERROR'; o_reason := 'INVALID_ACTIVE';
    o_message := 'active debe ser true o false';
    return;
  end if;

  select * into v_link from public.external_entity_links l
  where l.organization_id = v_org and l.source_system = p_batch.source_system
    and l.entity_type = 'category' and l.external_id = p_row.external_id;
  if found then
    select c.id into v_linked_id from public.categories c where c.id = v_link.internal_id and c.organization_id = v_org;
  end if;

  if v_linked_id is not null then
    o_internal_id := v_linked_id;
    if v_link.content_hash = p_row.content_hash then
      o_action := 'IGNORE'; o_reason := 'UNCHANGED'; o_message := 'Sin cambios desde la última importación';
    else
      o_action := 'UPDATE'; o_reason := 'CHANGED'; o_message := null;
    end if;
    return;
  end if;

  -- No usable link: is there an existing category with this name?
  select coalesce(array_agg(c.id), array[]::uuid[]) into v_all_ids
  from public.categories c
  where c.organization_id = v_org and app_private.import_normalize_text(c.name) = v_normalized;
  select coalesce(array_agg(c.id), array[]::uuid[]) into v_unlinked_ids
  from public.categories c
  where c.organization_id = v_org and app_private.import_normalize_text(c.name) = v_normalized
    and not exists (
      select 1 from public.external_entity_links l
      where l.organization_id = v_org and l.source_system = p_batch.source_system
        and l.entity_type = 'category' and l.internal_id = c.id
    );

  if cardinality(v_all_ids) = 0 then
    o_action := 'CREATE'; o_reason := case when v_link.internal_id is null then 'NEW' else 'RELINK' end; o_message := null;
  elsif 'name' = any (v_link_by) and cardinality(v_all_ids) = 1 and cardinality(v_unlinked_ids) = 1 then
    o_action := 'UPDATE'; o_reason := 'LINK_EXISTING'; o_message := 'Se vincula con la categoría existente del mismo nombre';
    o_internal_id := v_unlinked_ids[1];
  elsif 'name' = any (v_link_by) then
    o_action := 'ERROR'; o_reason := 'AMBIGUOUS_MATCH';
    o_message := 'Hay más de una categoría con ese nombre o ya está vinculada a otro código';
  else
    o_action := 'ERROR'; o_reason := 'NAME_CONFLICT';
    o_message := format('Ya existe una categoría llamada "%s" que no fue importada desde este sistema', v_name);
  end if;
end;
$$;

create function app_private.import_classify_product(
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
begin
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
    o_action := 'ERROR'; o_reason := 'CATEGORY_NOT_FOUND';
    o_message := 'No se encontró la categoría del producto; importá las categorías primero o indicá defaultCategoryId';
    return;
  end if;
  if v_target is not null then
    select * into v_existing from public.products p where p.id = v_target and p.organization_id = v_org;
    if v_existing.unit_type::text <> v_unit and app_private.product_has_operational_history(v_target) then
      o_action := 'ERROR'; o_reason := 'UNIT_TYPE_LOCKED';
      o_message := 'No se puede cambiar la forma de venta: el producto ya tiene ventas, stock, producción o promociones';
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

create function app_private.import_classify_stock_opening(
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
  v_product_id uuid;
  v_unit public.unit_type;
  v_has_grams boolean := v_payload ? 'quantityGrams' and jsonb_typeof(v_payload -> 'quantityGrams') <> 'null';
  v_has_units boolean := v_payload ? 'quantityUnits' and jsonb_typeof(v_payload -> 'quantityUnits') <> 'null';
  v_value jsonb;
  v_quantity numeric;
begin
  select p.id, p.unit_type into v_product_id, v_unit
  from public.external_entity_links l
  join public.products p on p.id = l.internal_id and p.organization_id = l.organization_id
  where l.organization_id = v_org and l.source_system = p_batch.source_system
    and l.entity_type = 'product' and l.external_id = p_row.external_id;
  if v_product_id is null then
    o_action := 'ERROR'; o_reason := 'PRODUCT_NOT_IMPORTED';
    o_message := format('El producto con código %s todavía no fue importado; importá los productos primero', p_row.external_id);
    return;
  end if;

  if v_has_grams = v_has_units then
    o_action := 'ERROR'; o_reason := 'INVALID_QUANTITY';
    o_message := 'Indicá quantityGrams (producto por peso) o quantityUnits (producto por unidad), uno solo';
    return;
  end if;
  if (v_has_grams and v_unit <> 'WEIGHT') or (v_has_units and v_unit <> 'UNIT') then
    o_action := 'ERROR'; o_reason := 'UNIT_MISMATCH';
    o_message := case when v_has_grams
      then 'El producto se vende por unidad: usá quantityUnits, no quantityGrams'
      else 'El producto se vende por peso: usá quantityGrams (gramos), no quantityUnits' end;
    return;
  end if;
  v_value := case when v_has_grams then v_payload -> 'quantityGrams' else v_payload -> 'quantityUnits' end;
  v_quantity := app_private.import_int_value(v_value);
  if v_quantity is null then
    o_action := 'ERROR'; o_reason := 'INVALID_QUANTITY';
    o_message := 'La cantidad debe ser un número entero (gramos o unidades)';
    return;
  end if;
  o_internal_id := v_product_id;
  if v_quantity < 0 then
    o_action := 'ERROR'; o_reason := 'NEGATIVE_QUANTITY';
    o_message := 'El stock inicial no puede ser negativo';
    return;
  end if;
  if v_quantity = 0 then
    o_action := 'IGNORE'; o_reason := 'ZERO_QUANTITY'; o_message := 'Stock inicial en cero: no se registra movimiento';
    return;
  end if;
  if exists (
    select 1 from public.stock_movements sm
    where sm.organization_id = v_org and sm.branch_id = p_batch.branch_id and sm.product_id = v_product_id
  ) then
    o_action := 'IGNORE'; o_reason := 'ALREADY_HAS_STOCK_HISTORY';
    o_message := 'El producto ya tiene movimientos de stock en la sucursal; para corregirlo usá un ajuste por conteo físico';
    return;
  end if;
  o_action := 'CREATE'; o_reason := 'OPENING_BALANCE'; o_message := null;
end;
$$;

create function app_private.import_classify_row(
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
begin
  if p_batch.entity_type = 'category' then
    select c.o_action, c.o_reason, c.o_message, c.o_internal_id
    into o_action, o_reason, o_message, o_internal_id
    from app_private.import_classify_category(p_batch, p_row) c;
  elsif p_batch.entity_type = 'product' then
    select c.o_action, c.o_reason, c.o_message, c.o_internal_id
    into o_action, o_reason, o_message, o_internal_id
    from app_private.import_classify_product(p_batch, p_row) c;
  elsif p_batch.entity_type = 'stock_opening_balance' then
    select c.o_action, c.o_reason, c.o_message, c.o_internal_id
    into o_action, o_reason, o_message, o_internal_id
    from app_private.import_classify_stock_opening(p_batch, p_row) c;
  else
    o_action := 'ERROR'; o_reason := 'UNSUPPORTED_ENTITY'; o_message := 'Tipo de entidad no soportado';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Apply handlers: the ONLY code that writes business data for an import. Each reuses the existing
-- RPCs (save_product, set_product_price, …) so every rule/guard/audit/POS-sync trigger that applies
-- to a manual edit applies to an imported one too.
-- ---------------------------------------------------------------------------------------------

create function app_private.import_upsert_link(
  p_batch public.import_batches,
  p_row public.import_rows,
  p_entity_type text,
  p_internal_id uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.external_entity_links (
    organization_id, source_system, entity_type, external_id, internal_id, content_hash, first_batch_id, last_batch_id
  ) values (
    p_batch.organization_id, p_batch.source_system, p_entity_type, p_row.external_id, p_internal_id,
    p_row.content_hash, p_batch.id, p_batch.id
  )
  on conflict (organization_id, source_system, entity_type, external_id) do update
  set internal_id = excluded.internal_id, content_hash = excluded.content_hash, last_batch_id = excluded.last_batch_id;
$$;

create function app_private.import_apply_category(
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
  v_existing public.categories%rowtype;
  v_sort integer;
  v_active boolean;
  v_id uuid;
begin
  if p_target is null then
    v_id := public.save_category(
      null, v_name, app_private.import_unique_slug(v_org, 'categories', v_name),
      coalesce((v_payload ->> 'sortOrder')::numeric::integer, 0),
      coalesce((v_payload ->> 'active')::boolean, true), null
    );
  else
    select * into v_existing from public.categories c where c.id = p_target and c.organization_id = v_org for update;
    v_sort := coalesce((v_payload ->> 'sortOrder')::numeric::integer, v_existing.sort_order);
    v_active := coalesce((v_payload ->> 'active')::boolean, v_existing.active);
    -- Keep slug and color: save_category rewrites every column it receives.
    v_id := public.save_category(p_target, v_name, v_existing.slug, v_sort, v_active, v_existing.color_hex);
  end if;
  perform app_private.import_upsert_link(p_batch, p_row, 'category', v_id);
  return v_id;
end;
$$;

create function app_private.import_apply_product(
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
  v_provided boolean;
  v_id uuid;
  v_price bigint := app_private.import_positive_bigint(v_payload -> 'priceCents');
  v_cost bigint := app_private.import_positive_bigint(v_payload -> 'costCents');
  v_current bigint;
begin
  select r.o_provided, r.o_category_id into v_provided, v_category_id
  from app_private.import_resolve_product_category(p_batch, v_payload, p_target is null) r;

  if p_target is null then
    v_id := public.save_product(
      null, v_category_id, v_name, app_private.import_unique_slug(v_org, 'products', v_name),
      v_sku, v_unit, coalesce((v_payload ->> 'active')::boolean, true)
    );
    perform public.set_product_categories(v_id, v_category_id, array[v_category_id]);
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

create function app_private.import_apply_stock_opening(
  p_batch public.import_batches,
  p_row public.import_rows,
  p_product_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_quantity bigint := coalesce(
    (p_row.payload ->> 'quantityGrams')::numeric, (p_row.payload ->> 'quantityUnits')::numeric
  )::bigint;
begin
  -- The ledger's own insert trigger (lock_stock_movement) serializes per (branch, product), and
  -- stock_movements_opening_balance_uq makes a second opening for the same pair impossible.
  insert into public.stock_movements (
    organization_id, branch_id, product_id, type, quantity_grams, reason, profile_id, occurred_at, import_batch_id
  ) values (
    p_batch.organization_id, p_batch.branch_id, p_product_id, 'OPENING_BALANCE', v_quantity,
    coalesce(nullif(btrim(p_row.payload ->> 'note'), ''), 'Stock inicial importado de ' || p_batch.source_system),
    auth.uid(), now(), p_batch.id
  );
  return p_product_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Summary used by preview / get / apply results
-- ---------------------------------------------------------------------------------------------
create function app_private.import_batch_summary(p_batch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'totalRows', count(*),
    'pending', count(*) filter (where r.action is null),
    'create', count(*) filter (where r.action = 'CREATE'),
    'update', count(*) filter (where r.action = 'UPDATE'),
    'ignore', count(*) filter (where r.action = 'IGNORE'),
    'error', count(*) filter (where r.action = 'ERROR'),
    'byReason', coalesce((
      select jsonb_object_agg(x.reason, x.n)
      from (
        select coalesce(i.reason_code, 'UNKNOWN') as reason, count(*) as n
        from public.import_rows i
        where i.batch_id = p_batch_id and i.action in ('IGNORE', 'ERROR')
        group by coalesce(i.reason_code, 'UNKNOWN')
      ) x
    ), '{}'::jsonb),
    'errors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'rowNumber', e.row_number, 'externalId', e.external_id, 'reason', e.reason_code, 'message', e.message
      ) order by e.row_number)
      from (
        select i.row_number, i.external_id, i.reason_code, i.message
        from public.import_rows i
        where i.batch_id = p_batch_id and i.action = 'ERROR'
        order by i.row_number limit 50
      ) e
    ), '[]'::jsonb)
  )
  from public.import_rows r
  where r.batch_id = p_batch_id;
$$;

create function app_private.import_batch_json(p_batch public.import_batches)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_batch.id, 'sourceSystem', p_batch.source_system, 'entityType', p_batch.entity_type,
    'branchId', p_batch.branch_id, 'fileName', p_batch.file_name, 'fileSha256', p_batch.file_sha256,
    'options', p_batch.options, 'status', p_batch.status,
    'createdAt', p_batch.created_at, 'previewedAt', p_batch.previewed_at, 'appliedAt', p_batch.applied_at,
    'sameFileAlreadyApplied', p_batch.file_sha256 is not null and exists (
      select 1 from public.import_batches o
      where o.organization_id = p_batch.organization_id and o.id <> p_batch.id and o.status = 'APPLIED'
        and o.source_system = p_batch.source_system and o.entity_type = p_batch.entity_type
        and o.branch_id is not distinct from p_batch.branch_id and o.file_sha256 = p_batch.file_sha256
    ),
    'summary', app_private.import_batch_summary(p_batch.id)
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Public RPC surface
-- ---------------------------------------------------------------------------------------------

create function public.create_import_batch(
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
  elsif p_branch_id is not null then
    raise exception 'Sólo el stock inicial se importa por sucursal' using errcode = '22023';
  end if;

  if jsonb_typeof(normalized_options) <> 'object' then
    raise exception 'options debe ser un objeto' using errcode = '22023';
  end if;
  for option_key in select jsonb_object_keys(normalized_options)
  loop
    if option_key not in ('linkExistingBy', 'defaultCategoryId') then
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

-- Uploads mapped rows (idempotent per row_number: re-sending a chunk overwrites it). Any staging
-- change invalidates a previous preview, so apply can never run on stale classifications.
-- p_rows: [{ "rowNumber": 1, "externalId": "00123", "payload": { … canonical … }, "raw": { … original … } }]
create function public.stage_import_rows(p_batch_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('imports.write');
  current_batch public.import_batches%rowtype;
  item jsonb;
  new_row_count integer;
  total_rows integer;
begin
  select * into current_batch from public.import_batches b
  where b.id = p_batch_id and b.organization_id = current_organization_id for update;
  if not found then
    raise exception 'Import batch was not found' using errcode = '42501';
  end if;
  if current_batch.status not in ('STAGING', 'READY') then
    raise exception 'El lote ya fue aplicado o cancelado y no admite más filas' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 1000 then
    raise exception 'Debe enviar entre 1 y 1000 filas por llamada' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(item) <> 'object'
       or app_private.import_positive_bigint(item -> 'rowNumber') is null
       or coalesce(jsonb_typeof(item -> 'payload'), '') <> 'object'
       or (item ? 'raw' and jsonb_typeof(item -> 'raw') not in ('object', 'null')) then
      raise exception 'Fila inválida: se espera { rowNumber, externalId, payload, raw }' using errcode = '22023';
    end if;
  end loop;

  if (select count(distinct x.value ->> 'rowNumber') from jsonb_array_elements(p_rows) as x(value)) <> jsonb_array_length(p_rows) then
    raise exception 'La llamada repite un rowNumber' using errcode = '22023';
  end if;

  insert into public.import_rows (batch_id, organization_id, row_number, external_id, raw, payload, content_hash)
  select current_batch.id, current_organization_id,
         (x.value ->> 'rowNumber')::integer,
         nullif(btrim(x.value ->> 'externalId'), ''),
         case when jsonb_typeof(x.value -> 'raw') = 'object' then x.value -> 'raw' else '{}'::jsonb end,
         x.value -> 'payload',
         encode(extensions.digest(convert_to((x.value -> 'payload')::text, 'UTF8'), 'sha256'), 'hex')
  from jsonb_array_elements(p_rows) as x(value)
  on conflict (batch_id, row_number) do update
  set external_id = excluded.external_id, raw = excluded.raw, payload = excluded.payload,
      content_hash = excluded.content_hash;
  get diagnostics new_row_count = row_count;

  select count(*) into total_rows from public.import_rows r where r.batch_id = current_batch.id;
  if total_rows > app_private.import_max_batch_rows() then
    raise exception 'Un lote admite hasta % filas; dividí el archivo en varios lotes', app_private.import_max_batch_rows()
      using errcode = '22023';
  end if;

  update public.import_rows
  set action = null, reason_code = null, message = null, internal_id = null
  where batch_id = current_batch.id and action is not null;
  update public.import_batches
  set status = 'STAGING', preview_summary = null, previewed_at = null
  where id = current_batch.id;

  return jsonb_build_object('staged', new_row_count, 'totalRows', total_rows);
end;
$$;

-- Dry run: classifies every staged row. Writes ONLY to import_rows/import_batches.
create function public.preview_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('imports.write');
  current_batch public.import_batches%rowtype;
  current_row public.import_rows%rowtype;
  verdict record;
  summary jsonb;
begin
  select * into current_batch from public.import_batches b
  where b.id = p_batch_id and b.organization_id = current_organization_id for update;
  if not found then
    raise exception 'Import batch was not found' using errcode = '42501';
  end if;
  if current_batch.status not in ('STAGING', 'READY') then
    raise exception 'El lote ya fue aplicado o cancelado' using errcode = '22023';
  end if;
  if not exists (select 1 from public.import_rows r where r.batch_id = current_batch.id) then
    raise exception 'El lote no tiene filas para previsualizar' using errcode = '22023';
  end if;
  if not app_private.has_permission(
       current_organization_id, case when current_batch.entity_type = 'stock_opening_balance' then 'stock.write' else 'products.write' end) then
    raise exception 'Permiso insuficiente para importar este tipo de dato' using errcode = '42501';
  end if;

  update public.import_rows
  set action = null, reason_code = null, message = null, internal_id = null
  where batch_id = current_batch.id;

  -- Generic in-file checks (first occurrence wins, later ones are the errors).
  update public.import_rows r
  set action = 'ERROR', reason_code = 'MISSING_EXTERNAL_ID',
      message = 'La fila no tiene código externo (identificador del sistema de origen)'
  where r.batch_id = current_batch.id and r.external_id is null;
  update public.import_rows r
  set action = 'ERROR', reason_code = 'DUPLICATE_EXTERNAL_ID',
      message = format('El código %s ya aparece en una fila anterior del archivo', r.external_id)
  where r.batch_id = current_batch.id and r.action is null
    and exists (
      select 1 from public.import_rows o
      where o.batch_id = r.batch_id and o.external_id = r.external_id and o.row_number < r.row_number
    );

  if current_batch.entity_type = 'product' then
    update public.import_rows r
    set action = 'ERROR', reason_code = 'DUPLICATE_SKU_IN_FILE',
        message = format('El SKU %s ya aparece en una fila anterior del archivo', upper(btrim(r.payload ->> 'sku')))
    from (
      select i.id, row_number() over (partition by upper(btrim(i.payload ->> 'sku')) order by i.row_number) as rn
      from public.import_rows i
      where i.batch_id = current_batch.id and nullif(btrim(i.payload ->> 'sku'), '') is not null
    ) d
    where r.id = d.id and d.rn > 1 and r.action is null;

    with codes as (
      select distinct i.id, i.row_number as row_no, app_private.normalize_barcode(b.value) as code
      from public.import_rows i
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(i.payload -> 'barcodes') = 'array' then i.payload -> 'barcodes' else '[]'::jsonb end
      ) as b(value)
      where i.batch_id = current_batch.id
    ), ranked as (
      select c.id, row_number() over (partition by c.code order by c.row_no) as rn
      from codes c where c.code is not null
    )
    update public.import_rows r
    set action = 'ERROR', reason_code = 'DUPLICATE_BARCODE_IN_FILE',
        message = 'Un código de barras de la fila ya aparece en una fila anterior del archivo'
    from ranked
    where r.id = ranked.id and ranked.rn > 1 and r.action is null;
  end if;

  for current_row in
    select * from public.import_rows r where r.batch_id = current_batch.id and r.action is null order by r.row_number
  loop
    select * into verdict from app_private.import_classify_row(current_batch, current_row);
    update public.import_rows
    set action = verdict.o_action, reason_code = verdict.o_reason, message = verdict.o_message,
        internal_id = verdict.o_internal_id
    where id = current_row.id;
  end loop;

  -- Two rows must never resolve to the same internal record (e.g. two external codes that match
  -- one existing product by name): the later one would silently overwrite the earlier one.
  update public.import_rows r
  set action = 'ERROR', reason_code = 'DUPLICATE_TARGET',
      message = 'Una fila anterior del archivo ya apunta al mismo registro existente'
  from (
    select i.id, row_number() over (partition by i.internal_id order by i.row_number) as rn
    from public.import_rows i
    where i.batch_id = current_batch.id and i.action in ('CREATE', 'UPDATE') and i.internal_id is not null
  ) d
  where r.id = d.id and d.rn > 1;

  summary := app_private.import_batch_summary(current_batch.id);
  update public.import_batches
  set status = 'READY', preview_summary = summary, previewed_at = now()
  where id = current_batch.id;

  return app_private.import_batch_json((select b from public.import_batches b where b.id = current_batch.id));
end;
$$;

create function public.get_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('imports.read');
  current_batch public.import_batches%rowtype;
begin
  select * into current_batch from public.import_batches b
  where b.id = p_batch_id and b.organization_id = current_organization_id;
  if not found then
    raise exception 'Import batch was not found' using errcode = '42501';
  end if;
  return app_private.import_batch_json(current_batch);
end;
$$;

-- Confirms a previewed batch. Atomic: every CREATE/UPDATE row is written in this one call or none.
-- Idempotent: calling it again on an APPLIED batch (e.g. a retry after a dropped connection)
-- returns the stored result and writes nothing.
create function public.apply_import_batch(p_batch_id uuid, p_skip_errors boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('imports.write');
  current_batch public.import_batches%rowtype;
  current_row public.import_rows%rowtype;
  verdict record;
  created_count integer := 0;
  updated_count integer := 0;
  ignored_count integer;
  skipped_error_count integer;
  result_id uuid;
  result_summary jsonb;
begin
  select * into current_batch from public.import_batches b
  where b.id = p_batch_id and b.organization_id = current_organization_id for update;
  if not found then
    raise exception 'Import batch was not found' using errcode = '42501';
  end if;
  if current_batch.status = 'APPLIED' then
    return app_private.import_batch_json(current_batch) || jsonb_build_object('alreadyApplied', true);
  end if;
  if current_batch.status <> 'READY' then
    raise exception 'El lote necesita una vista previa vigente antes de aplicarse' using errcode = '22023';
  end if;
  if not app_private.has_permission(
       current_organization_id, case when current_batch.entity_type = 'stock_opening_balance' then 'stock.write' else 'products.write' end) then
    raise exception 'Permiso insuficiente para importar este tipo de dato' using errcode = '42501';
  end if;
  if current_batch.entity_type = 'stock_opening_balance'
     and not app_private.can_access_branch(current_organization_id, current_batch.branch_id, 'stock.write') then
    raise exception 'La sucursal del lote ya no está activa o autorizada' using errcode = '42501';
  end if;

  select count(*) into skipped_error_count from public.import_rows r where r.batch_id = current_batch.id and r.action = 'ERROR';
  if skipped_error_count > 0 and not p_skip_errors then
    raise exception 'El lote tiene % filas con error; corregí el archivo o confirmá que se ignoren', skipped_error_count
      using errcode = '22023';
  end if;

  -- Phase 1 — nothing written yet: what is about to be applied must be exactly what was previewed.
  for current_row in
    select * from public.import_rows r
    where r.batch_id = current_batch.id and r.action in ('CREATE', 'UPDATE') order by r.row_number
  loop
    select * into verdict from app_private.import_classify_row(current_batch, current_row);
    if verdict.o_action is distinct from current_row.action
       or verdict.o_internal_id is distinct from current_row.internal_id then
      raise exception 'Los datos cambiaron desde la vista previa (fila %); volvé a generar la vista previa', current_row.row_number
        using errcode = '40001';
    end if;
  end loop;

  -- Phase 2 — write.
  for current_row in
    select * from public.import_rows r
    where r.batch_id = current_batch.id and r.action in ('CREATE', 'UPDATE') order by r.row_number
  loop
    if current_batch.entity_type = 'category' then
      result_id := app_private.import_apply_category(current_batch, current_row, current_row.internal_id);
    elsif current_batch.entity_type = 'product' then
      result_id := app_private.import_apply_product(current_batch, current_row, current_row.internal_id);
    else
      result_id := app_private.import_apply_stock_opening(current_batch, current_row, current_row.internal_id);
    end if;
    update public.import_rows set internal_id = result_id, applied_at = now() where id = current_row.id;
    if current_row.action = 'CREATE' then created_count := created_count + 1; else updated_count := updated_count + 1; end if;
  end loop;

  select count(*) into ignored_count from public.import_rows r where r.batch_id = current_batch.id and r.action = 'IGNORE';
  result_summary := jsonb_build_object(
    'created', created_count, 'updated', updated_count, 'ignored', ignored_count, 'skippedErrors', skipped_error_count
  );
  update public.import_batches
  set status = 'APPLIED', applied_at = now(), applied_by = auth.uid(), applied_summary = result_summary
  where id = current_batch.id;

  perform app_private.write_audit(
    current_organization_id, current_batch.branch_id, 'IMPORT_BATCH_APPLIED', 'import_batches', current_batch.id,
    null, jsonb_build_object('sourceSystem', current_batch.source_system, 'entityType', current_batch.entity_type) || result_summary
  );
  return app_private.import_batch_json((select b from public.import_batches b where b.id = current_batch.id))
    || jsonb_build_object('alreadyApplied', false, 'result', result_summary);
end;
$$;

create function public.cancel_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('imports.write');
  current_batch public.import_batches%rowtype;
begin
  select * into current_batch from public.import_batches b
  where b.id = p_batch_id and b.organization_id = current_organization_id for update;
  if not found then
    raise exception 'Import batch was not found' using errcode = '42501';
  end if;
  if current_batch.status = 'APPLIED' then
    raise exception 'Un lote aplicado no se puede cancelar' using errcode = '22023';
  end if;
  if current_batch.status <> 'CANCELLED' then
    update public.import_batches set status = 'CANCELLED' where id = current_batch.id
    returning * into current_batch;
    perform app_private.write_audit(
      current_organization_id, current_batch.branch_id, 'IMPORT_BATCH_CANCELLED', 'import_batches',
      current_batch.id, null, jsonb_build_object('sourceSystem', current_batch.source_system)
    );
  end if;
  return app_private.import_batch_json(current_batch);
end;
$$;

revoke all on function
  app_private.import_max_batch_rows(),
  app_private.import_normalize_text(text),
  app_private.import_slugify(text),
  app_private.import_unique_slug(uuid, text, text),
  app_private.import_positive_bigint(jsonb),
  app_private.import_int_value(jsonb),
  app_private.import_link_existing_by(jsonb),
  app_private.import_payload_barcodes(jsonb),
  app_private.product_has_operational_history(uuid),
  app_private.import_resolve_product_category(public.import_batches, jsonb, boolean),
  app_private.import_classify_category(public.import_batches, public.import_rows),
  app_private.import_classify_product(public.import_batches, public.import_rows),
  app_private.import_classify_stock_opening(public.import_batches, public.import_rows),
  app_private.import_classify_row(public.import_batches, public.import_rows),
  app_private.import_upsert_link(public.import_batches, public.import_rows, text, uuid),
  app_private.import_apply_category(public.import_batches, public.import_rows, uuid),
  app_private.import_apply_product(public.import_batches, public.import_rows, uuid),
  app_private.import_apply_stock_opening(public.import_batches, public.import_rows, uuid),
  app_private.import_batch_summary(uuid),
  app_private.import_batch_json(public.import_batches)
from public, anon, authenticated;

-- Pure, side-effect free; evaluated by the products name index on every authorized write path.
grant execute on function app_private.import_normalize_text(text) to authenticated;

revoke all on function
  public.create_import_batch(text, text, text, text, uuid, jsonb),
  public.stage_import_rows(uuid, jsonb),
  public.preview_import_batch(uuid),
  public.get_import_batch(uuid),
  public.apply_import_batch(uuid, boolean),
  public.cancel_import_batch(uuid)
from public, anon;
grant execute on function
  public.create_import_batch(text, text, text, text, uuid, jsonb),
  public.stage_import_rows(uuid, jsonb),
  public.preview_import_batch(uuid),
  public.get_import_batch(uuid),
  public.apply_import_batch(uuid, boolean),
  public.cancel_import_batch(uuid)
to authenticated;

commit;
