begin;

-- Destination branch for imports (Central = carnicería + almacén; Avenida/Janssen only butcher
-- shops). Changes to 202609300043/044 live here because those migrations may already be applied.
--
--   * product batches now REQUIRE a destination branch; every NEW product the batch creates is
--     enabled (branch_product_assortment) only in that branch. Existing products that the batch
--     updates keep their assortment untouched.
--   * stock_opening_balance keeps its branch (the OPENING_BALANCE is written only to that branch's
--     ledger) and now also requires the product to be enabled there (NOT_IN_ASSORTMENT), so stock
--     can never be loaded for something the branch does not carry.
--   * categories stay organization-wide (no branch).

do $$
declare
  old_check text;
begin
  select conname into old_check
  from pg_constraint
  where conrelid = 'public.import_batches'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%stock_opening_balance%'
    and pg_get_constraintdef(oid) like '%branch_id IS NOT NULL%';
  if old_check is null then
    raise exception 'Could not locate the import_batches branch check constraint';
  end if;
  execute format('alter table public.import_batches drop constraint %I', old_check);
end;
$$;

-- NOT VALID: only new batches are checked (a batch created before this rule keeps working as history).
alter table public.import_batches
  add constraint import_batches_branch_required_check
  check ((entity_type in ('product', 'stock_opening_balance')) = (branch_id is not null)) not valid;

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

create or replace function app_private.import_classify_stock_opening(
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

  if not exists (
    select 1 from public.branch_product_assortment a
    where a.organization_id = v_org and a.branch_id = p_batch.branch_id and a.product_id = v_product_id
  ) then
    o_action := 'ERROR'; o_reason := 'NOT_IN_ASSORTMENT';
    o_message := 'El producto no está habilitado en la sucursal destino; habilitalo antes de cargar su stock inicial';
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

commit;
