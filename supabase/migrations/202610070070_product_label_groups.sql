begin;

-- Etiquetas de góndola en lote (D-073): grupos persistentes de productos, historial de generaciones y detección de etiquetas desactualizadas.
--
--   * `product_label_groups`           un grupo por fila («Góndolas Despensa Central»; multiempresa; `branch_id` opcional = sucursal cuyo
--                                      precio/promoción lleva la etiqueta física). Se archiva (`active = false`), no se borra.
--   * `product_label_group_items`      productos del grupo, con su orden. Quitar un producto lo desactiva (`active = false`): se conserva
--                                      su vínculo con el historial de impresión.
--   * `product_label_print_runs`       una fila por PDF generado (cabecera: grupo, sucursal, quién, cuántas etiquetas).
--   * `product_label_print_run_items`  SNAPSHOT de lo efectivamente impreso por producto (nombre, precio normal, precio promocional,
--                                      condición). Es historial/auditoría: NUNCA es el precio vigente. Su única función de negocio es
--                                      compararse contra el precio actual para saber qué etiquetas físicas quedaron desactualizadas.
--
-- No se guarda el PDF (ni bytes ni base64): sólo metadata y snapshots.
--
-- Seguridad:
--   * Las tablas no tienen grants de escritura para ningún cliente: sólo escriben las RPC SECURITY DEFINER (permiso `catalog.write`);
--     leen las RPC/policies con `products.read`. Todo se filtra por la organización del llamador.
--   * Los snapshots de impresión son inmutables (trigger: ningún UPDATE).
--   * Nada de costos, márgenes, stock ni ventas: la RPC de lectura entrega sólo hechos comerciales de etiqueta.
--
-- El PRECIO se resuelve igual que el POS (`pull_pos_state`) y la cartelería (D-072): precio de la sucursal vigente > precio global vigente,
-- y la regla «llevando N» de la sucursal (o la global D-068 si el grupo no tiene sucursal). La matemática de la oferta NO vive acá: la RPC
-- entrega los hechos y el Admin los pasa por el motor de pricing de TypeScript (`calculateBranchPromotionLinePricing`).

-- ---------------------------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------------------------
create table public.product_label_groups (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Sucursal cuyo precio y promoción lleva la etiqueta; NULL = precio global de la organización.
  branch_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id)
);

create unique index product_label_groups_org_name_idx on public.product_label_groups (organization_id, lower(btrim(name))) where active;
create index product_label_groups_org_idx on public.product_label_groups (organization_id, created_at);

create table public.product_label_group_items (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  group_id uuid not null,
  product_id uuid not null,
  position integer not null check (position >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, product_id),
  foreign key (group_id, organization_id) references public.product_label_groups(id, organization_id) on delete cascade,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete cascade
);

create index product_label_group_items_group_idx on public.product_label_group_items (group_id, active, position);

create table public.product_label_print_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  group_id uuid not null,
  -- Sucursal del grupo en el momento de generar (el grupo puede cambiar de sucursal después).
  branch_id uuid,
  generated_at timestamptz not null default clock_timestamp(),
  generated_by uuid references public.profiles(id) on delete set null,
  product_count integer not null check (product_count > 0),
  label_count integer not null check (label_count > 0),
  unique (id, organization_id),
  foreign key (group_id, organization_id) references public.product_label_groups(id, organization_id) on delete cascade
);

create index product_label_print_runs_group_idx on public.product_label_print_runs (organization_id, group_id, generated_at desc);

create table public.product_label_print_run_items (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  group_id uuid not null,
  product_id uuid not null,
  position integer not null check (position >= 0),
  copies integer not null check (copies between 1 and 99),
  displayed_name text not null check (char_length(btrim(displayed_name)) between 1 and 200),
  unit_type public.unit_type not null,
  -- PROMO = oferta «llevando N» · SIMPLE = precio unitario sin promoción · WEIGHT = precio por kg.
  variant text not null check (variant in ('PROMO', 'SIMPLE', 'WEIGHT')),
  -- Precio normal mostrado (por unidad o por kg).
  list_price_cents bigint not null check (list_price_cents > 0),
  -- Precio promocional mostrado y su condición (sólo PROMO).
  promo_price_cents bigint,
  promo_minimum_units integer,
  promo_discount_bps integer,
  condition_text text,
  generated_at timestamptz not null,
  foreign key (run_id, organization_id) references public.product_label_print_runs(id, organization_id) on delete cascade,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete cascade,
  check ((variant = 'WEIGHT') = (unit_type = 'WEIGHT')),
  check ((variant = 'PROMO') = (promo_price_cents is not null)),
  check ((promo_price_cents is null) = (promo_minimum_units is null) and (promo_price_cents is null) = (promo_discount_bps is null)),
  check (promo_price_cents is null or (promo_price_cents > 0 and promo_price_cents < list_price_cents)),
  check (promo_minimum_units is null or promo_minimum_units >= 1),
  check (promo_discount_bps is null or promo_discount_bps between 1 and 9999)
);

-- «Última impresión conocida de este producto en este grupo».
create index product_label_print_run_items_last_idx on public.product_label_print_run_items (group_id, product_id, generated_at desc);
create index product_label_print_run_items_run_idx on public.product_label_print_run_items (run_id, position);

create trigger product_label_groups_set_updated_at before update on public.product_label_groups
for each row execute function app_private.set_updated_at();
create trigger product_label_group_items_set_updated_at before update on public.product_label_group_items
for each row execute function app_private.set_updated_at();

-- Los snapshots de impresión no se reescriben jamás (el borrado sólo ocurre en cascada por baja de la organización/producto).
create function app_private.prevent_label_print_history_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'El historial de impresión de etiquetas no se modifica' using errcode = '23000';
end;
$$;

create trigger product_label_print_runs_immutable before update on public.product_label_print_runs
for each row execute function app_private.prevent_label_print_history_rewrite();
create trigger product_label_print_run_items_immutable before update on public.product_label_print_run_items
for each row execute function app_private.prevent_label_print_history_rewrite();

alter table public.product_label_groups enable row level security;
alter table public.product_label_group_items enable row level security;
alter table public.product_label_print_runs enable row level security;
alter table public.product_label_print_run_items enable row level security;
create policy product_label_groups_admin_select on public.product_label_groups
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));
create policy product_label_group_items_admin_select on public.product_label_group_items
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));
create policy product_label_print_runs_admin_select on public.product_label_print_runs
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));
create policy product_label_print_run_items_admin_select on public.product_label_print_run_items
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));

revoke all on table public.product_label_groups from public, anon, authenticated;
revoke all on table public.product_label_group_items from public, anon, authenticated;
revoke all on table public.product_label_print_runs from public, anon, authenticated;
revoke all on table public.product_label_print_run_items from public, anon, authenticated;
grant select on public.product_label_groups to authenticated;
grant select on public.product_label_group_items to authenticated;
grant select on public.product_label_print_runs to authenticated;
grant select on public.product_label_print_run_items to authenticated;
revoke all on function app_private.prevent_label_print_history_rewrite() from public, anon, authenticated;

comment on table public.product_label_groups is
  'Grupos de etiquetas de góndola (p. ej. «Góndolas Despensa Central»). Se escribe únicamente con las RPC save_label_group / set_label_group_products.';
comment on table public.product_label_group_items is
  'Productos de un grupo de etiquetas, en orden. Quitar = active false (se conserva el vínculo con el historial).';
comment on table public.product_label_print_runs is
  'Una fila por PDF de etiquetas generado. No guarda el PDF. Se escribe únicamente con record_label_print_run.';
comment on table public.product_label_print_run_items is
  'Snapshot de lo impreso por producto (historial/auditoría, NO precio vigente). Inmutable; sirve para detectar etiquetas desactualizadas.';

-- ---------------------------------------------------------------------------------------------
-- 2. Lectura
-- ---------------------------------------------------------------------------------------------
-- Grupos de mi organización con su cantidad de productos activos y la fecha de su última generación.
create function public.list_label_groups(p_include_inactive boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'groupId', g.id, 'name', g.name, 'branchId', g.branch_id, 'branchName', b.name, 'active', g.active,
      'itemCount', (select count(*) from public.product_label_group_items i where i.group_id = g.id and i.active),
      'lastRunAt', (select max(r.generated_at) from public.product_label_print_runs r where r.group_id = g.id)
    ) order by lower(g.name), g.id)
    from public.product_label_groups g
    left join public.branches b on b.id = g.branch_id and b.organization_id = g.organization_id
    where g.organization_id = current_organization_id and (g.active or coalesce(p_include_inactive, false))
  ), '[]'::jsonb);
end;
$$;

-- Hechos de UN grupo de mi organización: sus productos activos con el precio vigente de SU sucursal, la regla «llevando N» y la última
-- impresión conocida (snapshot) de cada producto dentro del grupo. NULL = el grupo no existe o es de otra organización.
-- «Disponible» = producto activo y vendible, categoría activa, en el surtido de la sucursal (si el grupo tiene una) y con precio vigente > 0
-- (precio 0 = «sin precio definido», D-057: una etiqueta física nunca sale a $0).
create function public.get_label_group(p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  g public.product_label_groups%rowtype;
  at_time timestamptz := now();
  v_branch_name text;
  v_bulk_minimum integer;
  v_bulk_bps integer;
  v_items jsonb;
begin
  select * into g from public.product_label_groups x where x.id = p_group_id and x.organization_id = current_organization_id;
  if not found then return null; end if;

  -- «Llevando N unidades» (sólo productos UNIT): la regla vigente de la sucursal (la que lee el POS) o, sin sucursal, la configuración
  -- global de la organización (D-068: «desde 3», toda la línea).
  if g.branch_id is not null then
    select b.name into v_branch_name from public.branches b where b.id = g.branch_id and b.organization_id = g.organization_id;
    select bp.minimum_units, bp.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.branch_promotions bp
    where bp.organization_id = g.organization_id and bp.branch_id = g.branch_id and bp.active
      and bp.semantics = 'FROM_MINIMUM' and bp.valid_from <= at_time and (bp.valid_until is null or bp.valid_until > at_time)
    order by bp.valid_from desc, bp.id
    limit 1;
  else
    select s.unit_bulk_discount_bps into v_bulk_bps
    from public.organization_pricing_settings s where s.organization_id = g.organization_id;
    if coalesce(v_bulk_bps, 0) > 0 then v_bulk_minimum := 3; else v_bulk_bps := null; end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', r.product_id, 'position', r.position, 'name', r.name, 'sku', r.sku, 'unitType', r.unit_type,
    'available', r.reason is null, 'unavailableReason', r.reason,
    'listPriceCents', r.price_cents::text,
    'bulkMinimumUnits', case when r.unit_type = 'UNIT' then v_bulk_minimum end,
    'bulkDiscountBps', case when r.unit_type = 'UNIT' then v_bulk_bps end,
    'last', r.last_print
  ) order by r.position, r.name, r.product_id), '[]'::jsonb)
  into v_items
  from (
    select i.product_id, i.position, p.name, p.sku, p.unit_type, price.price_cents,
      case
        when not (p.active and c.active is true and p.inventory_role in ('SELLABLE', 'BOTH')) then 'INACTIVE'
        when g.branch_id is not null and not exists (
          select 1 from public.branch_product_assortment a
          where a.branch_id = g.branch_id and a.product_id = p.id and a.organization_id = p.organization_id
        ) then 'NOT_IN_BRANCH'
        when coalesce(price.price_cents, 0) <= 0 then 'NO_PRICE'
      end as reason,
      (
        select jsonb_build_object(
          'runId', ri.run_id, 'generatedAt', ri.generated_at, 'displayedName', ri.displayed_name, 'variant', ri.variant,
          'listPriceCents', ri.list_price_cents::text, 'promoPriceCents', ri.promo_price_cents::text,
          'promoMinimumUnits', ri.promo_minimum_units, 'promoDiscountBps', ri.promo_discount_bps, 'copies', ri.copies)
        from public.product_label_print_run_items ri
        where ri.group_id = g.id and ri.product_id = p.id and ri.organization_id = g.organization_id
        order by ri.generated_at desc, ri.id desc
        limit 1
      ) as last_print
    from public.product_label_group_items i
    join public.products p on p.id = i.product_id and p.organization_id = i.organization_id
    left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    -- Mismo orden que el POS (`pull_pos_state`): el precio de la sucursal vigente gana sobre el global vigente.
    left join lateral (
      select pp.price_cents
      from public.product_prices pp
      where pp.organization_id = p.organization_id and pp.product_id = p.id
        and (pp.branch_id = g.branch_id or pp.branch_id is null)
        and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time)
      order by (pp.branch_id = g.branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) price on true
    where i.group_id = g.id and i.active
  ) r;

  return jsonb_build_object('groupId', g.id, 'name', g.name, 'branchId', g.branch_id, 'branchName', v_branch_name,
    'active', g.active, 'items', v_items);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Escritura
-- ---------------------------------------------------------------------------------------------
-- Crea (p_group_id null) o edita un grupo. Archivar = p_active false.
create function public.save_label_group(p_group_id uuid, p_name text, p_branch_id uuid, p_active boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  g public.product_label_groups%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_active boolean := coalesce(p_active, true);
  v_id uuid;
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception 'El nombre del grupo tiene que tener entre 1 y 80 caracteres' using errcode = '22023';
  end if;
  if p_branch_id is not null and not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;

  if p_group_id is null then
    if (select count(*) from public.product_label_groups x where x.organization_id = current_organization_id) >= 100 then
      raise exception 'Se alcanzó el máximo de 100 grupos de etiquetas' using errcode = '22023';
    end if;
    if v_active and exists (
      select 1 from public.product_label_groups x
      where x.organization_id = current_organization_id and x.active and lower(btrim(x.name)) = lower(v_name)
    ) then
      raise exception 'Ya existe un grupo de etiquetas con ese nombre' using errcode = '23505';
    end if;
    insert into public.product_label_groups (organization_id, branch_id, name, active, created_by)
    values (current_organization_id, p_branch_id, v_name, v_active, auth.uid())
    returning id into v_id;
    perform app_private.write_audit(current_organization_id, p_branch_id, 'PRODUCT_LABEL_GROUPS_INSERT', 'product_label_groups', v_id,
      null, jsonb_build_object('name', v_name, 'branch_id', p_branch_id, 'active', v_active));
    return jsonb_build_object('id', v_id);
  end if;

  select * into g from public.product_label_groups x
  where x.id = p_group_id and x.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Label group not found' using errcode = '42501';
  end if;
  if v_active and exists (
    select 1 from public.product_label_groups x
    where x.organization_id = current_organization_id and x.active and x.id <> g.id and lower(btrim(x.name)) = lower(v_name)
  ) then
    raise exception 'Ya existe un grupo de etiquetas con ese nombre' using errcode = '23505';
  end if;
  update public.product_label_groups set name = v_name, branch_id = p_branch_id, active = v_active where id = g.id;
  perform app_private.write_audit(current_organization_id, p_branch_id, 'PRODUCT_LABEL_GROUPS_UPDATE', 'product_label_groups', g.id,
    jsonb_build_object('name', g.name, 'branch_id', g.branch_id, 'active', g.active),
    jsonb_build_object('name', v_name, 'branch_id', p_branch_id, 'active', v_active));
  return jsonb_build_object('id', g.id);
end;
$$;

-- Agrega y/o quita productos de un grupo EN LOTE (una sola transacción). Los nuevos van al final, en el orden recibido; un producto quitado
-- antes se reactiva. Sólo productos activos de mi organización pueden agregarse.
create function public.set_label_group_products(p_group_id uuid, p_add uuid[], p_remove uuid[] default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  g public.product_label_groups%rowtype;
  v_add uuid[] := coalesce(p_add, array[]::uuid[]);
  v_remove uuid[] := coalesce(p_remove, array[]::uuid[]);
  v_base integer;
  v_added integer := 0;
  v_removed integer := 0;
  v_total integer;
begin
  select * into g from public.product_label_groups x
  where x.id = p_group_id and x.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Label group not found' using errcode = '42501';
  end if;
  if not g.active then
    raise exception 'El grupo está archivado' using errcode = '22023';
  end if;
  if cardinality(v_add) > 500 or cardinality(v_remove) > 500 then
    raise exception 'Demasiados productos en una sola operación' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_add) as t(id) where t.id is null)
     or exists (select 1 from unnest(v_remove) as t(id) where t.id is null)
     or (select count(distinct t.id) from unnest(v_add) as t(id)) <> cardinality(v_add)
     or (select count(distinct t.id) from unnest(v_remove) as t(id)) <> cardinality(v_remove) then
    raise exception 'La lista de productos tiene ids vacíos o repetidos' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_add) as a(id) join unnest(v_remove) as r(id) on r.id = a.id) then
    raise exception 'Un producto no puede agregarse y quitarse a la vez' using errcode = '22023';
  end if;
  if (select count(*) from public.products p where p.organization_id = current_organization_id and p.id = any(v_add)) <> cardinality(v_add) then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
  if exists (select 1 from public.products p where p.organization_id = current_organization_id and p.id = any(v_add) and not p.active) then
    raise exception 'No se pueden agregar productos inactivos' using errcode = '22023';
  end if;

  if cardinality(v_remove) > 0 then
    with removed as (
      update public.product_label_group_items i set active = false
      where i.group_id = g.id and i.active and i.product_id = any(v_remove)
      returning 1
    )
    select count(*) into v_removed from removed;
  end if;

  if cardinality(v_add) > 0 then
    select coalesce(max(i.position) + 1, 0) into v_base from public.product_label_group_items i where i.group_id = g.id;
    with added as (
      insert into public.product_label_group_items (organization_id, group_id, product_id, position)
      select current_organization_id, g.id, t.id, v_base + (t.ord - 1)::integer
      from unnest(v_add) with ordinality as t(id, ord)
      on conflict (group_id, product_id) do update set active = true, position = excluded.position
      where not product_label_group_items.active
      returning 1
    )
    select count(*) into v_added from added;
  end if;

  select count(*) into v_total from public.product_label_group_items i where i.group_id = g.id and i.active;
  if v_total > 500 then
    raise exception 'Un grupo admite hasta 500 productos' using errcode = '22023';
  end if;

  perform app_private.write_audit(current_organization_id, g.branch_id, 'PRODUCT_LABEL_GROUP_ITEMS_CHANGED', 'product_label_groups', g.id,
    null, jsonb_build_object('added', to_jsonb(v_add), 'removed', to_jsonb(v_remove), 'total', v_total));
  return jsonb_build_object('groupId', g.id, 'added', v_added, 'removed', v_removed, 'total', v_total);
end;
$$;

-- Registra una generación: cabecera + SNAPSHOT de lo que el servidor efectivamente imprimió. El Admin la llama con los valores que usó para
-- dibujar el PDF (resueltos en el servidor, nunca los del navegador). Cada elemento de p_items:
--   { productId, copies, displayedName, unitType, variant, listPriceCents, promoPriceCents?, promoMinimumUnits?, promoDiscountBps?, conditionText? }
create function public.record_label_print_run(p_group_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  g public.product_label_groups%rowtype;
  v_now timestamptz := clock_timestamp();
  v_run_id uuid;
  v_products integer;
  v_labels integer;
  v_distinct integer;
  v_bad boolean;
  v_foreign integer;
begin
  select * into g from public.product_label_groups x
  where x.id = p_group_id and x.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Label group not found' using errcode = '42501';
  end if;
  if not g.active then
    raise exception 'El grupo está archivado' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'Se esperaba una lista de 1 a 500 etiquetas' using errcode = '22023';
  end if;

  -- Una sola lectura del JSON: totales y validaciones (producto/copias presentes, sin repetidos, cada producto es parte ACTIVA del grupo).
  select count(*), coalesce(sum(r.copies), 0), count(distinct r."productId"),
    coalesce(bool_or(r."productId" is null or r.copies is null or r.copies not between 1 and 99), false),
    count(*) filter (where not exists (
      select 1 from public.product_label_group_items i
      where i.group_id = g.id and i.organization_id = current_organization_id and i.product_id = r."productId" and i.active
    ))
  into v_products, v_labels, v_distinct, v_bad, v_foreign
  from jsonb_array_elements(p_items) as t(item),
  lateral jsonb_to_record(t.item) as r(
    "productId" uuid, copies integer, "displayedName" text, "unitType" text, variant text, "listPriceCents" bigint,
    "promoPriceCents" bigint, "promoMinimumUnits" integer, "promoDiscountBps" integer, "conditionText" text
  );
  if v_bad then
    raise exception 'Etiquetas inválidas: producto o cantidad de copias faltante' using errcode = '22023';
  end if;
  if v_distinct <> v_products then
    raise exception 'Hay productos repetidos en la generación' using errcode = '22023';
  end if;
  if v_labels > 1000 then
    raise exception 'Una generación admite hasta 1000 etiquetas' using errcode = '22023';
  end if;
  if v_foreign > 0 then
    raise exception 'Un producto no pertenece al grupo' using errcode = '42501';
  end if;

  insert into public.product_label_print_runs (organization_id, group_id, branch_id, generated_at, generated_by, product_count, label_count)
  values (current_organization_id, g.id, g.branch_id, v_now, auth.uid(), v_products, v_labels)
  returning id into v_run_id;

  insert into public.product_label_print_run_items (
    organization_id, run_id, group_id, product_id, position, copies, displayed_name, unit_type, variant,
    list_price_cents, promo_price_cents, promo_minimum_units, promo_discount_bps, condition_text, generated_at
  )
  select current_organization_id, v_run_id, g.id, r."productId", (t.ord - 1)::integer, r.copies, btrim(r."displayedName"),
    r."unitType"::public.unit_type, r.variant, r."listPriceCents", r."promoPriceCents", r."promoMinimumUnits", r."promoDiscountBps",
    r."conditionText", v_now
  from jsonb_array_elements(p_items) with ordinality as t(item, ord),
  lateral jsonb_to_record(t.item) as r(
    "productId" uuid, copies integer, "displayedName" text, "unitType" text, variant text, "listPriceCents" bigint,
    "promoPriceCents" bigint, "promoMinimumUnits" integer, "promoDiscountBps" integer, "conditionText" text
  );

  perform app_private.write_audit(current_organization_id, g.branch_id, 'PRODUCT_LABEL_PRINT_RUNS_INSERT', 'product_label_print_runs', v_run_id,
    null, jsonb_build_object('group_id', g.id, 'products', v_products, 'labels', v_labels));
  return jsonb_build_object('runId', v_run_id, 'generatedAt', v_now, 'productCount', v_products, 'labelCount', v_labels);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Permisos
-- ---------------------------------------------------------------------------------------------
revoke all on function public.list_label_groups(boolean) from public, anon;
grant execute on function public.list_label_groups(boolean) to authenticated;
revoke all on function public.get_label_group(uuid) from public, anon;
grant execute on function public.get_label_group(uuid) to authenticated;
revoke all on function public.save_label_group(uuid, text, uuid, boolean) from public, anon;
grant execute on function public.save_label_group(uuid, text, uuid, boolean) to authenticated;
revoke all on function public.set_label_group_products(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.set_label_group_products(uuid, uuid[], uuid[]) to authenticated;
revoke all on function public.record_label_print_run(uuid, jsonb) from public, anon;
grant execute on function public.record_label_print_run(uuid, jsonb) to authenticated;

commit;
