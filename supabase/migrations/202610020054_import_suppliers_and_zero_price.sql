begin;

-- Sprint "Proveedores + importación real SimplyGest" — motor de importación (docs/IMPORTS.md).
-- Las migraciones 043–049 pueden estar aplicadas, así que todo vive acá (CREATE OR REPLACE con la
-- misma firma que la 049, más lo marcado "NEW"):
--
--   1. product_prices acepta precio 0 (= "sin precio definido"; SimplyGest tiene productos así y el
--      cajero de Central les pone el precio en el momento, ver 202610020055). Un precio negativo
--      sigue siendo imposible. public.set_product_price (Admin) NO cambia: Admin nunca fija un 0.
--   2. El importador acepta priceCents >= 0 (antes > 0). Un 0 del archivo sólo crea la primera
--      vigencia del producto; nunca pisa un precio ya cargado.
--   3. Proveedores: payload { supplierName?, supplierCode? }. Proveedor vacío = producto sin
--      proveedor. Se reutiliza el existente (vínculo externo, mismo código o mismo nombre
--      normalizado) o se crea UNA vez; queda como proveedor principal del producto. Reimportar el
--      mismo archivo no crea nada (la fila es UNCHANGED y ni se mira).
--   4. list_import_batch_suppliers: qué proveedores se crearían / se reutilizarían, para auditarlo en
--      la vista previa (nada se escribe antes de confirmar).
--
-- Intacto: tipos de acción, códigos de razón, dedupe, apply atómico, surtido sólo en la sucursal
-- destino (Central), stock (no se importa stock de SimplyGest; el motor de OPENING_BALANCE no cambia).

alter table public.product_prices drop constraint product_prices_price_cents_check;
alter table public.product_prices add constraint product_prices_price_cents_check check (price_cents >= 0);

comment on column public.product_prices.price_cents is
  'Integer ARS cents per kilogram for WEIGHT products or per unit for UNIT products. 0 = precio sin definir: el producto aparece en el POS de Central pero no se vende hasta que el cajero fija un precio.';

-- Entero >= 0 (<= 2^53-1) desde un number jsonb; null para cualquier otra cosa.
create function app_private.import_nonnegative_bigint(p_value jsonb)
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
  if numeric_value < 0 or numeric_value <> trunc(numeric_value) or numeric_value > 9007199254740991 then
    return null;
  end if;
  return numeric_value::bigint;
end;
$$;

-- Reutiliza o crea el proveedor de una fila y, si trae código, deja el vínculo externo
-- (source_system + código -> proveedor). Es la ÚNICA vía por la que el importador crea proveedores.
create function app_private.import_ensure_supplier(
  p_batch public.import_batches,
  p_name text,
  p_code text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := p_batch.organization_id;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_code text := nullif(upper(btrim(coalesce(p_code, ''))), '');
  v_id uuid;
begin
  v_id := app_private.find_supplier(v_org, p_batch.source_system, v_code, v_name);
  if v_id is null then
    if v_name is null then
      raise exception 'El proveedor no existe y la fila no trae su nombre' using errcode = '22023';
    end if;
    begin
      insert into public.suppliers (organization_id, name, code, active)
      values (v_org, v_name, v_code, true)
      returning id into v_id;
    exception when unique_violation then
      -- Otro proceso lo creó entre la búsqueda y el alta: se reutiliza ese.
      v_id := app_private.find_supplier(v_org, p_batch.source_system, v_code, v_name);
      if v_id is null then raise; end if;
    end;
  end if;
  if v_code is not null then
    insert into public.external_entity_links (
      organization_id, source_system, entity_type, external_id, internal_id, content_hash, first_batch_id, last_batch_id
    ) values (
      v_org, p_batch.source_system, 'supplier', v_code, v_id,
      encode(extensions.digest(convert_to(v_code || '|' || coalesce(app_private.import_normalize_text(v_name), ''), 'UTF8'), 'sha256'), 'hex'),
      p_batch.id, p_batch.id
    )
    on conflict (organization_id, source_system, entity_type, external_id) do update
    set internal_id = excluded.internal_id, content_hash = excluded.content_hash, last_batch_id = excluded.last_batch_id;
  end if;
  return v_id;
end;
$$;

-- Proveedores que una vista previa crearía o reutilizaría (filas CREATE / UPDATE / IGNORE; las
-- ERROR no se aplican, así que no cuentan). Un elemento por proveedor distinto del lote:
--   { key, supplierId (null = se crearía), name, code, rows }
-- Sólo lectura. El cliente une los lotes de una importación grande.
create function public.list_import_batch_suppliers(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('imports.read');
  v_batch public.import_batches%rowtype;
begin
  select * into v_batch from public.import_batches b where b.id = p_batch_id and b.organization_id = v_org;
  if not found then
    raise exception 'Import batch was not found' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'key', g.key, 'supplierId', g.supplier_id, 'name', g.name, 'code', g.code, 'rows', g.rows
    ) order by g.name)
    from (
      select k.key, min(k.supplier_id::text)::uuid as supplier_id,
        coalesce(min(s.name), min(k.supplier_name)) as name, min(k.supplier_code) as code, count(*) as rows
      from (
        select
          r.supplier_name, r.supplier_code, r.supplier_id,
          -- Un proveedor existente se agrupa por su id (código y nombre distintos, mismo proveedor);
          -- uno nuevo, por su nombre normalizado (lo que apply crearía una sola vez).
          coalesce(
            r.supplier_id::text,
            case when r.supplier_name is not null then 'N:' || app_private.import_normalize_text(r.supplier_name) else 'C:' || r.supplier_code end
          ) as key
        from (
          select n.supplier_name, n.supplier_code,
                 app_private.find_supplier(v_batch.organization_id, v_batch.source_system, n.supplier_code, n.supplier_name) as supplier_id
          from (
            select nullif(btrim(i.payload ->> 'supplierName'), '') as supplier_name,
                   nullif(upper(btrim(i.payload ->> 'supplierCode')), '') as supplier_code
            from public.import_rows i
            where i.batch_id = v_batch.id and i.action in ('CREATE', 'UPDATE', 'IGNORE')
          ) n
          where n.supplier_name is not null or n.supplier_code is not null
        ) r
      ) k
      left join public.suppliers s on s.id = k.supplier_id and s.organization_id = v_batch.organization_id
      group by k.key
    ) g
  ), '[]'::jsonb);
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
  v_supplier_name text := nullif(btrim(v_payload ->> 'supplierName'), '');
  v_supplier_code text := nullif(upper(btrim(v_payload ->> 'supplierCode')), '');
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
  -- NEW: 0 es un precio válido (SimplyGest tiene productos "sin precio fijo" que se cobran a lo que
  -- diga el cajero); sólo un precio negativo o fraccionario es inválido.
  if v_payload ? 'priceCents' and jsonb_typeof(v_payload -> 'priceCents') <> 'null'
     and app_private.import_nonnegative_bigint(v_payload -> 'priceCents') is null then
    o_action := 'ERROR'; o_reason := 'INVALID_PRICE';
    o_message := 'priceCents debe ser un entero mayor o igual a 0 (centavos)';
    return;
  end if;
  if v_payload ? 'costCents' and jsonb_typeof(v_payload -> 'costCents') <> 'null'
     and app_private.import_positive_bigint(v_payload -> 'costCents') is null then
    o_action := 'ERROR'; o_reason := 'INVALID_COST';
    o_message := 'costCents debe ser un entero mayor a 0 (centavos)';
    return;
  end if;
  -- NEW: proveedor (opcional). Nombre y código son texto; el código sin nombre sólo sirve si el
  -- código ya identifica a un proveedor existente (no hay con qué crear uno nuevo).
  if (v_payload ? 'supplierName' and jsonb_typeof(v_payload -> 'supplierName') not in ('string', 'null'))
     or (v_payload ? 'supplierCode' and jsonb_typeof(v_payload -> 'supplierCode') not in ('string', 'null'))
     or char_length(coalesce(v_supplier_name, '')) > 120 or char_length(coalesce(v_supplier_code, '')) > 60 then
    o_action := 'ERROR'; o_reason := 'INVALID_SUPPLIER';
    o_message := 'El proveedor es inválido (nombre hasta 120 caracteres, código hasta 60)';
    return;
  end if;
  if v_supplier_name is null and v_supplier_code is not null
     and app_private.find_supplier(v_org, p_batch.source_system, v_supplier_code, null) is null then
    o_action := 'ERROR'; o_reason := 'SUPPLIER_NAME_REQUIRED';
    o_message := format('El proveedor con código %s no existe todavía y la fila no trae su nombre', v_supplier_code);
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
  v_price bigint := app_private.import_nonnegative_bigint(v_payload -> 'priceCents');
  v_cost bigint := app_private.import_positive_bigint(v_payload -> 'costCents');
  v_current bigint;
  v_current_found boolean;
  v_supplier_name text := nullif(btrim(v_payload ->> 'supplierName'), '');
  v_supplier_code text := nullif(upper(btrim(v_payload ->> 'supplierCode')), '');
  v_supplier_id uuid;
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
    v_current_found := found;
    if v_price = 0 then
      -- NEW: precio 0 = "sin precio definido" (se pide en la caja). Sólo crea la PRIMERA vigencia
      -- del producto; nunca pisa un precio ya cargado (ni el que el cajero guardó desde el POS
      -- cuando el producto se actualiza por otra columna): un 0 del archivo no es una baja de precio.
      -- public.set_product_price rechaza <= 0 a propósito (Admin no fija precios en cero), por eso se
      -- inserta directo; el trigger de historia/auditoría/cola del POS dispara igual.
      if not v_current_found then
        insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from, created_by)
        values (v_org, v_id, null, 0, now(), auth.uid());
      end if;
    elsif v_current is distinct from v_price then
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

  -- NEW: proveedor principal. Vacío = el producto se importa sin proveedor (y no se le quita el que
  -- ya tuviera). Con proveedor: se reutiliza el existente o se crea una sola vez.
  if v_supplier_name is not null or v_supplier_code is not null then
    v_supplier_id := app_private.import_ensure_supplier(p_batch, v_supplier_name, v_supplier_code);
    perform app_private.set_primary_supplier(v_org, v_id, v_supplier_id);
  end if;

  perform app_private.import_upsert_link(p_batch, p_row, 'product', v_id);
  return v_id;
end;
$$;

revoke all on function
  app_private.import_nonnegative_bigint(jsonb),
  app_private.import_ensure_supplier(public.import_batches, text, text),
  app_private.import_classify_product(public.import_batches, public.import_rows),
  app_private.import_apply_product(public.import_batches, public.import_rows, uuid)
from public, anon, authenticated;

revoke all on function public.list_import_batch_suppliers(uuid) from public, anon;
grant execute on function public.list_import_batch_suppliers(uuid) to authenticated;

commit;
