begin;

-- Envasados: PLU automático, vencimiento general por organización y habilitación de cortes en un clic (D-094). Incremental: no edita 093/095/096.
--
--   1. `organization_vacuum_settings.default_shelf_life_days` (14 por defecto, configurable): los días de vencimiento de todo corte que NO tenga
--      un valor propio. `product_vacuum_settings.shelf_life_days` pasa a significar «excepción del corte»; NULL = usa el general. El vencimiento
--      de un paquete ya registrado no cambia nunca: `vacuum_packages.expires_on` y `shelf_life_days_snapshot` son un snapshot inmutable.
--   2. El PLU lo asigna el sistema (`app_private.vacuum_next_plu`): transaccional, serializado por organización con un lock consultivo, único
--      (índice de 093 como respaldo), dentro de los dígitos del esquema EAN-13, sin reutilizar jamás un PLU que esté en otro corte (habilitado
--      o no) ni en una etiqueta ya impresa. Deshabilitar conserva el PLU; rehabilitar lo reutiliza.
--   3. RPC nuevas: `set_vacuum_product_enabled`, `save_vacuum_product_overrides`, `save_vacuum_default_shelf_life`,
--      `get_pos_vacuum_code_status` (el POS explica por qué un código de Envasados no se puede vender).
--   4. Reemplazadas con cambios mínimos (misma firma): `get_vacuum_settings`, `list_vacuum_config_products_page`, `search_vacuum_products`,
--      `list_vacuum_station_products` y `create_vacuum_package` (vencimiento efectivo = propio del corte > general).
--   5. Datos: los cortes HABILITADOS que no tenían PLU reciben uno (en orden de alta). Ningún PLU existente ni ningún paquete cambia.
--
-- `save_vacuum_product_config` (093, con PLU manual) queda intacta para el Admin ya desplegado; la pantalla nueva no la usa.

alter table public.organization_vacuum_settings
  add column default_shelf_life_days integer not null default 14 check (default_shelf_life_days between 1 and 3650);
comment on column public.organization_vacuum_settings.default_shelf_life_days is
  'Días de vencimiento de los cortes sin valor propio (parámetro operativo configurable; no es una validación sanitaria).';
comment on column public.product_vacuum_settings.shelf_life_days is
  'Excepción del corte. NULL = usa organization_vacuum_settings.default_shelf_life_days.';

-- ---------------------------------------------------------------------------------------------
-- Helpers privados
-- ---------------------------------------------------------------------------------------------

-- Una organización sin fila de configuración usa el mismo valor inicial que la columna (14).
create function app_private.vacuum_default_shelf_life_days(p_org uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.default_shelf_life_days from public.organization_vacuum_settings s where s.organization_id = p_org), 14);
$$;

-- PLU que ya significan algo en la organización: los de cualquier corte (habilitado o no) y los embebidos en etiquetas ya impresas.
create function app_private.vacuum_used_plu_numbers(p_org uuid)
returns setof bigint
language sql
stable
security definer
set search_path = ''
as $$
  select (s.plu)::bigint from public.product_vacuum_settings s where s.organization_id = p_org and s.plu is not null
  union
  select (p.label_snapshot -> 'ean' ->> 'plu')::bigint from public.vacuum_packages p
  where p.organization_id = p_org and (p.label_snapshot -> 'ean' ->> 'plu') ~ '^[0-9]{1,8}$';
$$;

-- PLU del corte: el que ya tiene; si no, el de sus propias etiquetas históricas (si ningún otro corte lo usa); si no, el siguiente libre.
-- Toma un lock consultivo por organización hasta el fin de la transacción: dos habilitaciones simultáneas nunca reciben el mismo número.
-- Quien llama escribe el valor en product_vacuum_settings dentro de la misma transacción.
create function app_private.vacuum_next_plu(p_org uuid, p_product_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_current text;
  v_digits integer;
  v_max bigint;
  v_own bigint;
  v_next bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('vacuum_plu:' || p_org::text, 0));
  select s.plu into v_current from public.product_vacuum_settings s where s.product_id = p_product_id and s.organization_id = p_org;
  if v_current is not null then return v_current; end if;

  -- Dígitos del esquema configurado; sin esquema todavía, cuatro (el EAN-13 se arma recién cuando hay esquema y valida que el PLU entre).
  select s.ean_plu_digits into v_digits from public.organization_vacuum_settings s where s.organization_id = p_org;
  v_digits := coalesce(v_digits, 4);
  v_max := (power(10::numeric, v_digits))::bigint - 1;

  select (p.label_snapshot -> 'ean' ->> 'plu')::bigint into v_own
  from public.vacuum_packages p
  where p.organization_id = p_org and p.product_id = p_product_id and (p.label_snapshot -> 'ean' ->> 'plu') ~ '^[0-9]{1,8}$'
  order by p.created_at desc, p.id desc limit 1;
  if v_own is not null and v_own between 1 and v_max
     and not exists (select 1 from public.product_vacuum_settings s where s.organization_id = p_org and s.plu is not null and (s.plu)::bigint = v_own)
     and not exists (
       select 1 from public.vacuum_packages p
       where p.organization_id = p_org and p.product_id <> p_product_id and (p.label_snapshot -> 'ean' ->> 'plu') ~ '^[0-9]{1,8}$'
         and (p.label_snapshot -> 'ean' ->> 'plu')::bigint = v_own) then
    return v_own::text;
  end if;

  select coalesce(max(u.n), 0) + 1 into v_next from app_private.vacuum_used_plu_numbers(p_org) u(n) where u.n <= v_max;
  if v_next > v_max then
    -- Se llegó al tope: el primer hueco que nunca se usó (un PLU usado no vuelve a estar libre).
    select g.n into v_next
    from generate_series(1::bigint, v_max) g(n)
    where not exists (select 1 from app_private.vacuum_used_plu_numbers(p_org) u(n) where u.n = g.n)
    order by g.n limit 1;
    if v_next is null then
      raise exception 'Se agotaron los PLU disponibles (1 a %): ampliá los dígitos del PLU en el esquema EAN-13', v_max using errcode = '54000';
    end if;
  end if;
  return v_next::text;
end;
$$;

revoke all on function
  app_private.vacuum_default_shelf_life_days(uuid), app_private.vacuum_used_plu_numbers(uuid), app_private.vacuum_next_plu(uuid, uuid)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Datos: regularizar cortes habilitados sin PLU (ningún PLU existente cambia)
-- ---------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select s.product_id, s.organization_id from public.product_vacuum_settings s
    where s.enabled and s.plu is null order by s.organization_id, s.created_at, s.product_id
  loop
    update public.product_vacuum_settings set plu = app_private.vacuum_next_plu(r.organization_id, r.product_id) where product_id = r.product_id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RPC: configuración
-- ---------------------------------------------------------------------------------------------

create or replace function public.get_vacuum_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  s public.organization_vacuum_settings%rowtype;
begin
  select * into s from public.organization_vacuum_settings x where x.organization_id = v_org;
  return jsonb_build_object(
    'businessName', s.business_name, 'address', s.address, 'establishmentInfo', s.establishment_info,
    'defaultConservationText', s.default_conservation_text, 'extraText', s.extra_text,
    'labelWidthMm', s.label_width_mm, 'infoHeightMm', s.info_height_mm, 'priceHeightMm', s.price_height_mm,
    'defaultShelfLifeDays', coalesce(s.default_shelf_life_days, 14),
    'ean', jsonb_build_object(
      'configured', s.ean_scheme is not null, 'scheme', s.ean_scheme, 'prefix', s.ean_prefix,
      'pluDigits', s.ean_plu_digits, 'valueDigits', s.ean_value_digits, 'valueStep', coalesce(s.ean_value_step, 1)
    )
  );
end;
$$;

-- Vencimiento general de la organización. Sólo afecta a los paquetes que se registren después y a los cortes sin valor propio.
create function public.save_vacuum_default_shelf_life(p_days integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.configure');
begin
  if p_days is null or p_days not between 1 and 3650 then raise exception 'El vencimiento tiene que estar entre 1 y 3650 días' using errcode = '22023'; end if;
  insert into public.organization_vacuum_settings (organization_id, default_shelf_life_days) values (v_org, p_days)
  on conflict (organization_id) do update set default_shelf_life_days = excluded.default_shelf_life_days;
  return p_days;
end;
$$;

create function app_private.vacuum_config_row_json(p_org uuid, p_product_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'productId', p.id, 'name', p.name, 'sku', p.sku, 'enabled', coalesce(s.enabled, false),
    'customShelfLifeDays', s.shelf_life_days,
    'shelfLifeDays', coalesce(s.shelf_life_days, app_private.vacuum_default_shelf_life_days(p_org)),
    'plu', s.plu, 'conservationText', s.conservation_text)
  from public.products p
  left join public.product_vacuum_settings s on s.product_id = p.id and s.organization_id = p.organization_id
  where p.id = p_product_id and p.organization_id = p_org;
$$;
revoke all on function app_private.vacuum_config_row_json(uuid, uuid) from public, anon, authenticated;

-- Habilita o deshabilita un corte en un paso. Habilitar asigna el PLU si todavía no tiene; deshabilitar conserva PLU, vencimiento propio,
-- texto de conservación y todo el historial. Idempotente.
create function public.set_vacuum_product_enabled(p_product_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.configure');
  v_plu text;
begin
  if p_enabled is null then raise exception 'Indicá si el corte queda habilitado' using errcode = '22023'; end if;
  if not exists (select 1 from public.products p where p.id = p_product_id and p.organization_id = v_org and p.unit_type = 'WEIGHT') then
    raise exception 'Sólo los productos por peso de esta organización se pueden envasar' using errcode = '42501';
  end if;
  if p_enabled then
    if not exists (select 1 from public.products p where p.id = p_product_id and p.organization_id = v_org and p.active) then
      raise exception 'El producto está inactivo: activalo en Productos antes de habilitarlo para envasar' using errcode = '22023';
    end if;
    v_plu := app_private.vacuum_next_plu(v_org, p_product_id);
    begin
      insert into public.product_vacuum_settings (product_id, organization_id, enabled, plu) values (p_product_id, v_org, true, v_plu)
      on conflict (product_id) do update set enabled = true, plu = coalesce(public.product_vacuum_settings.plu, excluded.plu);
    exception when unique_violation then
      raise exception 'No se pudo asignar el PLU %: probá de nuevo', v_plu using errcode = '40001';
    end;
  else
    update public.product_vacuum_settings set enabled = false where product_id = p_product_id and organization_id = v_org and enabled;
  end if;
  return app_private.vacuum_config_row_json(v_org, p_product_id);
end;
$$;

-- Excepciones de un corte: vencimiento propio (NULL = volver al general) y texto de conservación. No toca el PLU ni si está habilitado.
create function public.save_vacuum_product_overrides(p_product_id uuid, p_shelf_life_days integer default null, p_conservation_text text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.configure');
  v_text text := nullif(btrim(coalesce(p_conservation_text, '')), '');
begin
  if not exists (select 1 from public.products p where p.id = p_product_id and p.organization_id = v_org and p.unit_type = 'WEIGHT') then
    raise exception 'Sólo los productos por peso de esta organización se pueden envasar' using errcode = '42501';
  end if;
  if p_shelf_life_days is not null and p_shelf_life_days not between 1 and 3650 then
    raise exception 'El vencimiento tiene que estar entre 1 y 3650 días' using errcode = '22023';
  end if;
  insert into public.product_vacuum_settings (product_id, organization_id, enabled, shelf_life_days, conservation_text)
  values (p_product_id, v_org, false, p_shelf_life_days, v_text)
  on conflict (product_id) do update set shelf_life_days = excluded.shelf_life_days, conservation_text = excluded.conservation_text;
  return app_private.vacuum_config_row_json(v_org, p_product_id);
end;
$$;

-- Misma firma que en 093: suma el vencimiento efectivo y el propio de cada corte, y el general de la organización.
create or replace function public.list_vacuum_config_products_page(
  p_search text default null,
  p_filter text default 'all',
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
  v_org uuid := app_private.require_permission('vacuum.configure');
  v_pattern text := case when app_private.import_normalize_text(p_search) is null then null
    else '%' || replace(replace(replace(app_private.import_normalize_text(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_default integer := app_private.vacuum_default_shelf_life_days(v_org);
  v_total bigint;
  v_rows jsonb;
begin
  if p_filter not in ('all', 'enabled', 'disabled') then raise exception 'Filtro inválido' using errcode = '22023'; end if;
  select count(*) into v_total
  from public.products p
  left join public.product_vacuum_settings s on s.product_id = p.id and s.organization_id = p.organization_id
  where p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT'
    and (p_filter = 'all' or (p_filter = 'enabled') = coalesce(s.enabled, false))
    and (v_pattern is null or app_private.import_normalize_text(p.name) like v_pattern escape '\' or lower(coalesce(p.sku, '')) like v_pattern escape '\');
  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', r.id, 'name', r.name, 'sku', r.sku, 'enabled', coalesce(r.enabled, false),
    'customShelfLifeDays', r.shelf_life_days, 'shelfLifeDays', coalesce(r.shelf_life_days, v_default),
    'plu', r.plu, 'conservationText', r.conservation_text
  ) order by lower(r.name), r.id), '[]'::jsonb) into v_rows
  from (
    select p.id, p.name, p.sku, s.enabled, s.shelf_life_days, s.plu, s.conservation_text
    from public.products p
    left join public.product_vacuum_settings s on s.product_id = p.id and s.organization_id = p.organization_id
    where p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT'
      and (p_filter = 'all' or (p_filter = 'enabled') = coalesce(s.enabled, false))
      and (v_pattern is null or app_private.import_normalize_text(p.name) like v_pattern escape '\' or lower(coalesce(p.sku, '')) like v_pattern escape '\')
    order by lower(p.name), p.id limit v_limit offset v_offset
  ) r;
  return jsonb_build_object('total', v_total, 'rows', v_rows, 'defaultShelfLifeDays', v_default);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- POS: por qué un código de Envasados no se puede vender (sólo lectura; mismo control de acceso que get_pos_vacuum_state)
-- ---------------------------------------------------------------------------------------------
create function public.get_pos_vacuum_code_status(p_branch_id uuid, p_ean13 text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select b.organization_id into v_org from public.branches b where b.id = p_branch_id and b.active;
  if v_org is null or not app_private.can_access_branch(v_org, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  if p_ean13 is null or p_ean13 !~ '^[0-9]{13}$' then raise exception 'Código inválido' using errcode = '22023'; end if;
  -- De todos los paquetes con ese código, el más útil para explicar: disponible acá > disponible en otra sucursal > reservado > despachado > resto.
  select jsonb_build_object('status', s.status, 'here', s.current_branch_id = p_branch_id, 'branchName', b.name, 'expiresOn', p.expires_on)
  into v_result
  from public.vacuum_packages p
  join public.vacuum_package_state s on s.package_id = p.id and s.organization_id = p.organization_id
  join public.branches b on b.id = s.current_branch_id and b.organization_id = s.organization_id
  where p.organization_id = v_org and p.ean13 = p_ean13
  order by case
      when s.status = 'AVAILABLE' and s.current_branch_id = p_branch_id then 0
      when s.status = 'AVAILABLE' then 1
      when s.status = 'RESERVED' then 2
      when s.status = 'DISPATCHED' then 3
      when s.status = 'SOLD' then 4
      else 5 end, p.created_at desc, p.id
  limit 1;
  return coalesce(v_result, jsonb_build_object('status', 'UNKNOWN'));
end;
$$;

revoke all on function
  public.save_vacuum_default_shelf_life(integer), public.set_vacuum_product_enabled(uuid, boolean),
  public.save_vacuum_product_overrides(uuid, integer, text), public.get_pos_vacuum_code_status(uuid, text)
from public, anon;
grant execute on function
  public.save_vacuum_default_shelf_life(integer), public.set_vacuum_product_enabled(uuid, boolean),
  public.save_vacuum_product_overrides(uuid, integer, text), public.get_pos_vacuum_code_status(uuid, text)
to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Funciones de 093 / 095 / 096 reemplazadas con cambios mínimos: el vencimiento del corte es el EFECTIVO (propio > general)
-- ---------------------------------------------------------------------------------------------

create or replace function public.search_vacuum_products(p_branch_id uuid, p_search text default null, p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  v_at timestamptz := clock_timestamp();
  v_text text := app_private.import_normalize_text(p_search);
  v_pattern text := case when v_text is null then null else '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_code text := app_private.normalize_barcode(p_search);
begin
  perform app_private.require_visible_branch(v_org, p_branch_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'productId', r.id, 'name', r.name, 'sku', r.sku, 'shelfLifeDays', coalesce(r.shelf_life_days, app_private.vacuum_default_shelf_life_days(v_org)), 'plu', r.plu,
      'conservationText', r.conservation_text, 'pricePerKgCents', r.price_cents::text
    ) order by lower(r.name), r.id)
    from (
      select p.id, p.name, p.sku, s.shelf_life_days, s.plu, s.conservation_text,
        app_private.vacuum_price_per_kg(v_org, p.id, p_branch_id, v_at) as price_cents
      from public.products p
      join public.product_vacuum_settings s on s.product_id = p.id and s.organization_id = p.organization_id and s.enabled
      where p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT'
        and (v_pattern is null
          or app_private.import_normalize_text(p.name) like v_pattern escape '\'
          or lower(coalesce(p.sku, '')) like v_pattern escape '\'
          or (s.plu is not null and s.plu = btrim(p_search))
          or (v_code is not null and exists (select 1 from public.product_barcodes pb where pb.product_id = p.id and pb.organization_id = p.organization_id and pb.barcode like v_code || '%')))
      order by lower(p.name), p.id
      limit least(greatest(coalesce(p_limit, 20), 1), 50)
    ) r
  ), '[]'::jsonb);
end;
$$;

create or replace function public.list_vacuum_station_products(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.read');
  v_at timestamptz := clock_timestamp();
begin
  perform app_private.require_visible_branch(v_org, p_branch_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'productId', r.id, 'name', r.name, 'sku', r.sku, 'shelfLifeDays', coalesce(r.shelf_life_days, app_private.vacuum_default_shelf_life_days(v_org)), 'plu', r.plu,
      'conservationText', r.conservation_text, 'pricePerKgCents', r.price_cents::text,
      'categoryId', r.category_id, 'categoryName', r.category_name, 'recentPackages', r.recent_packages
    ) order by lower(r.name), r.id)
    from (
      select p.id, p.name, p.sku, s.shelf_life_days, s.plu, s.conservation_text,
        app_private.vacuum_price_per_kg(v_org, p.id, p_branch_id, v_at) as price_cents,
        p.category_id, c.name as category_name,
        (
          select count(*) from public.vacuum_packages x
          where x.organization_id = p.organization_id and x.branch_id = p_branch_id and x.product_id = p.id
            and x.created_at >= v_at - interval '14 days'
        ) as recent_packages
      from public.products p
      join public.product_vacuum_settings s on s.product_id = p.id and s.organization_id = p.organization_id and s.enabled
      left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
      where p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT'
      order by lower(p.name), p.id
      limit 300
    ) r
  ), '[]'::jsonb);
end;
$$;

-- create_vacuum_package: idéntica a la de 095 salvo el vencimiento efectivo y el PLU automático de un corte que no lo tenía.
create or replace function public.create_vacuum_package(
  p_branch_id uuid,
  p_product_id uuid,
  p_weight_grams integer,
  p_packed_on date,
  p_expires_on date default null,
  p_lot text default null,
  p_request_key uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('vacuum.write');
  v_at timestamptz := clock_timestamp();
  v_tz text;
  v_today date;
  v_existing public.vacuum_packages%rowtype;
  v_branch public.branches%rowtype;
  v_product public.products%rowtype;
  v_pset public.product_vacuum_settings%rowtype;
  v_org_set public.organization_vacuum_settings%rowtype;
  v_price bigint;
  v_total bigint;
  v_raw_total bigint;
  v_expires date;
  v_shelf integer;
  v_ean text;
  v_lot text := nullif(upper(regexp_replace(btrim(coalesce(p_lot, '')), '\s+', '', 'g')), '');
  v_seq integer;
  v_conservation text;
  v_row public.vacuum_packages%rowtype;
begin
  perform app_private.require_visible_branch(v_org, p_branch_id);
  select * into v_branch from public.branches b where b.id = p_branch_id and b.organization_id = v_org;
  if not v_branch.active then raise exception 'La sucursal está inactiva' using errcode = '22023'; end if;

  if p_request_key is not null then
    select * into v_existing from public.vacuum_packages x where x.organization_id = v_org and x.request_key = p_request_key;
    if found then return app_private.vacuum_package_json(v_existing); end if;
  end if;

  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_today := (v_at at time zone coalesce(v_tz, 'UTC'))::date;
  if p_packed_on is null or p_packed_on < v_today - 366 or p_packed_on > v_today + 366 then
    raise exception 'La fecha de elaboración es inválida' using errcode = '22023';
  end if;
  if p_weight_grams is null or p_weight_grams not between 1 and 99999 then raise exception 'El peso tiene que estar entre 1 g y 99,999 kg' using errcode = '22023'; end if;

  select * into v_product from public.products p where p.id = p_product_id and p.organization_id = v_org and p.active and p.unit_type = 'WEIGHT';
  if not found then raise exception 'Corte no encontrado' using errcode = '42501'; end if;
  select * into v_pset from public.product_vacuum_settings s where s.product_id = p_product_id and s.organization_id = v_org and s.enabled;
  if not found then raise exception 'El corte % no está habilitado para envasar', v_product.name using errcode = '22023'; end if;
  -- Vencimiento efectivo: el propio del corte o, si no tiene, el general de la organización (queda como snapshot del paquete).
  v_shelf := coalesce(v_pset.shelf_life_days, app_private.vacuum_default_shelf_life_days(v_org));
  -- Un corte habilitado sin PLU (configuración anterior) lo recibe acá, igual que al habilitarlo.
  if v_pset.plu is null then
    v_pset.plu := app_private.vacuum_next_plu(v_org, p_product_id);
    update public.product_vacuum_settings set plu = v_pset.plu where product_id = p_product_id and organization_id = v_org;
  end if;

  v_price := app_private.vacuum_price_per_kg(v_org, p_product_id, p_branch_id, v_at);
  if v_price is null or v_price <= 0 then raise exception 'El corte % no tiene un precio vigente', v_product.name using errcode = '22023'; end if;
  -- Mismo redondeo que el POS (priceForWeight): precio por kg × gramos / 1000, half-up en centavos.
  v_raw_total := (v_price * p_weight_grams::bigint + 500) / 1000;
  if v_raw_total <= 0 then raise exception 'El importe del paquete es cero' using errcode = '22023'; end if;

  -- Vencimiento: por defecto elaboración + vencimiento efectivo del corte. Cambiarlo requiere permiso.
  if p_expires_on is null then
    if v_shelf is null then raise exception 'El corte no tiene vida útil configurada: ingresá el vencimiento' using errcode = '22023'; end if;
    v_expires := p_packed_on + v_shelf;
  else
    v_expires := p_expires_on;
    if v_shelf is not null and v_expires <> p_packed_on + v_shelf
       and not app_private.has_permission(v_org, 'vacuum.override_expiry') then
      raise exception 'No tenés permiso para cambiar el vencimiento configurado' using errcode = '42501';
    end if;
  end if;
  if v_expires < p_packed_on then raise exception 'El vencimiento no puede ser anterior a la elaboración' using errcode = '22023'; end if;

  select * into v_org_set from public.organization_vacuum_settings s where s.organization_id = v_org;
  if not found or v_org_set.ean_scheme is null then
    raise exception 'Falta configurar el esquema EAN-13 de envasados (Envasados → Configuración)' using errcode = '22023';
  end if;
  -- Importe comercial ÚNICO: el que se imprime, se embebe en el EAN, muestra el POS y se cobra (con divisor 100, pesos enteros half-up).
  -- El cálculo original con centavos queda en computed_total_cents sólo para auditoría.
  v_total := app_private.vacuum_commercial_total(v_org_set.ean_scheme, v_org_set.ean_value_step, v_raw_total);
  if v_total <= 0 then raise exception 'El importe comercial del paquete es cero' using errcode = '22023'; end if;
  v_ean := app_private.vacuum_build_ean(v_org_set.ean_scheme, v_org_set.ean_prefix, v_org_set.ean_plu_digits, v_org_set.ean_value_digits,
    v_org_set.ean_value_step, v_pset.plu, v_total, p_weight_grams);

  -- Lote: único por organización y legible (SUCURSAL-AAMMDD-0001). Automático con contador por sucursal y día; editable.
  if v_lot is null then
    loop
      insert into public.vacuum_lot_counters (organization_id, branch_id, packed_on, last_seq) values (v_org, p_branch_id, p_packed_on, 1)
      on conflict (organization_id, branch_id, packed_on) do update set last_seq = public.vacuum_lot_counters.last_seq + 1
      returning last_seq into v_seq;
      v_lot := upper(v_branch.code) || '-' || to_char(p_packed_on, 'YYMMDD') || '-' || lpad(v_seq::text, 4, '0');
      exit when not exists (select 1 from public.vacuum_packages x where x.organization_id = v_org and x.lot = v_lot);
      v_lot := null;
    end loop;
  elsif v_lot !~ '^[A-Z0-9][A-Z0-9._/-]{2,39}$' then
    raise exception 'El lote tiene que tener entre 3 y 40 caracteres (letras, números, . _ / -)' using errcode = '22023';
  elsif exists (select 1 from public.vacuum_packages x where x.organization_id = v_org and x.lot = v_lot) then
    raise exception 'El lote % ya existe', v_lot using errcode = '23505';
  end if;

  v_conservation := coalesce(v_pset.conservation_text, v_org_set.default_conservation_text);
  insert into public.vacuum_packages (
    organization_id, branch_id, product_id, request_key, product_name_snapshot, product_sku_snapshot, weight_grams, price_per_kg_cents, total_cents, computed_total_cents,
    packed_on, expires_on, lot, ean13, shelf_life_days_snapshot, conservation_text_snapshot, label_snapshot, created_by
  ) values (
    v_org, p_branch_id, p_product_id, p_request_key, v_product.name, v_product.sku, p_weight_grams, v_price, v_total, v_raw_total,
    p_packed_on, v_expires, v_lot, v_ean, v_shelf, v_conservation,
    jsonb_build_object(
      'businessName', v_org_set.business_name, 'address', v_org_set.address, 'establishmentInfo', v_org_set.establishment_info,
      'extraText', v_org_set.extra_text, 'branchName', v_branch.name,
      'labelWidthMm', v_org_set.label_width_mm, 'infoHeightMm', v_org_set.info_height_mm, 'priceHeightMm', v_org_set.price_height_mm,
      'ean', jsonb_build_object('scheme', v_org_set.ean_scheme, 'prefix', v_org_set.ean_prefix, 'pluDigits', v_org_set.ean_plu_digits,
        'valueDigits', v_org_set.ean_value_digits, 'valueStep', v_org_set.ean_value_step, 'plu', v_pset.plu)
    ),
    auth.uid()
  ) returning * into v_row;
  return app_private.vacuum_package_json(v_row);
end;
$$;

commit;
