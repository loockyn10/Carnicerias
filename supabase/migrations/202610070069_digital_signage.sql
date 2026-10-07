begin;

-- Cartelería digital (D-072): un televisor abre /tv/<token> y rota las ofertas de SU pantalla.
--
--   * `digital_signage_displays`  una pantalla por fila (multiempresa; `branch_id` opcional = sucursal cuyo precio/promoción se muestra).
--                                 Sólo se guarda el HASH SHA-256 del token (el token en claro se devuelve UNA vez al crear/regenerar).
--   * `digital_signage_slides`    productos publicados de la pantalla, con su posición. NO guarda precios: apuntan al producto, así que un
--                                 cambio de precio/promoción se refleja solo en el televisor (sin snapshots).
--
-- Seguridad:
--   * Las tablas no tienen grants de escritura para ningún cliente: sólo escriben las RPC SECURITY DEFINER (permiso `catalog.write`).
--   * `get_signage_display(token)` es la ÚNICA superficie pública (anon): valida el token por hash y devuelve exclusivamente los HECHOS
--     comerciales de los slides de esa pantalla (nombre, tipo de venta, precio de lista, regla «llevando N»). Nunca costo, margen, stock,
--     ventas, empleados ni otras organizaciones. Token inexistente/mal formado => NULL (indistinguible).
--   * Las tablas no llevan el trigger de auditoría de fila (to_jsonb(row) copiaría el hash del token al log): las RPC auditan a mano.
--
-- El PRECIO se resuelve igual que el POS (`pull_pos_state`): precio de la sucursal vigente > precio global vigente. La matemática de la
-- oferta («llevando 3u») NO vive acá: la RPC entrega los hechos y el Admin los pasa por el motor de pricing de TypeScript
-- (`calculateBranchPromotionLinePricing`), el mismo que usa el POS y la etiqueta de góndola.

-- ---------------------------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------------------------
create table public.digital_signage_displays (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Sucursal cuyo precio y promoción muestra la pantalla; NULL = precio global de la organización.
  branch_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- SHA-256 (hex) del token. El token en claro nunca se guarda.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_rotated_at timestamptz not null default now(),
  slide_duration_seconds integer not null default 8 check (slide_duration_seconds between 3 and 60),
  enabled boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete cascade
);

create index digital_signage_displays_org_idx on public.digital_signage_displays (organization_id, created_at);

create table public.digital_signage_slides (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  display_id uuid not null,
  product_id uuid not null,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  unique (display_id, product_id),
  unique (display_id, position),
  foreign key (display_id, organization_id) references public.digital_signage_displays(id, organization_id) on delete cascade,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete cascade
);

create trigger digital_signage_displays_set_updated_at before update on public.digital_signage_displays
for each row execute function app_private.set_updated_at();

alter table public.digital_signage_displays enable row level security;
alter table public.digital_signage_slides enable row level security;
create policy digital_signage_displays_admin_select on public.digital_signage_displays
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));
create policy digital_signage_slides_admin_select on public.digital_signage_slides
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));

revoke all on table public.digital_signage_displays from public, anon, authenticated;
revoke all on table public.digital_signage_slides from public, anon, authenticated;
-- El hash del token no sale de la base: columnas explícitas (un `select *` desde el cliente falla a propósito).
grant select (id, organization_id, branch_id, name, token_rotated_at, slide_duration_seconds, enabled, created_at, updated_at)
  on public.digital_signage_displays to authenticated;
grant select on public.digital_signage_slides to authenticated;

comment on table public.digital_signage_displays is
  'Pantallas de cartelería digital (televisores). Sólo el hash SHA-256 del token; se escribe únicamente con las RPC create/save/regenerate_signage_*.';
comment on table public.digital_signage_slides is
  'Productos publicados de una pantalla, en orden. Sin precios: apuntan al producto, el precio/promoción se resuelve en cada lectura.';

-- ---------------------------------------------------------------------------------------------
-- 2. Hechos de la pantalla (helper privado compartido por la RPC pública y la del Admin)
-- ---------------------------------------------------------------------------------------------
-- p_admin = false (televisor): sólo los slides disponibles y lo mínimo imprescindible. p_admin = true (editor/preview): todos los slides,
-- con el motivo si no se pueden mostrar. «Disponible» = producto activo y vendible, categoría activa, en el surtido de la sucursal (si la
-- pantalla tiene una) y con precio vigente > 0 (precio 0 = «sin precio definido», D-057: nunca se muestra a $0).
create function app_private.signage_payload(p_display_id uuid, p_admin boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.digital_signage_displays%rowtype;
  at_time timestamptz := now();
  v_org_name text;
  v_branch_name text;
  v_bulk_minimum integer;
  v_bulk_bps integer;
  v_slides jsonb;
begin
  select * into d from public.digital_signage_displays where id = p_display_id;
  if not found then return null; end if;
  select o.name into v_org_name from public.organizations o where o.id = d.organization_id;

  if not p_admin and not d.enabled then
    return jsonb_build_object('status', 'DISABLED', 'slideDurationSeconds', d.slide_duration_seconds,
      'organizationName', v_org_name, 'slides', '[]'::jsonb);
  end if;

  -- «Llevando N unidades» (sólo productos UNIT): la regla vigente de la sucursal (la que lee el POS) o, sin sucursal, la configuración
  -- global de la organización (D-068: «desde 3», toda la línea).
  if d.branch_id is not null then
    select b.name into v_branch_name from public.branches b where b.id = d.branch_id;
    select bp.minimum_units, bp.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.branch_promotions bp
    where bp.organization_id = d.organization_id and bp.branch_id = d.branch_id and bp.active
      and bp.semantics = 'FROM_MINIMUM' and bp.valid_from <= at_time and (bp.valid_until is null or bp.valid_until > at_time)
    order by bp.valid_from desc, bp.id
    limit 1;
  else
    select s.unit_bulk_discount_bps into v_bulk_bps
    from public.organization_pricing_settings s where s.organization_id = d.organization_id;
    if coalesce(v_bulk_bps, 0) > 0 then v_bulk_minimum := 3; else v_bulk_bps := null; end if;
  end if;

  select coalesce(jsonb_agg(
    case when p_admin then
      jsonb_build_object(
        'slideId', r.slide_id, 'position', r.position, 'productId', r.product_id, 'name', r.name, 'sku', r.sku,
        'unitType', r.unit_type, 'available', r.reason is null, 'unavailableReason', r.reason,
        'listPriceCents', r.price_cents::text,
        'bulkMinimumUnits', case when r.unit_type = 'UNIT' then v_bulk_minimum end,
        'bulkDiscountBps', case when r.unit_type = 'UNIT' then v_bulk_bps end,
        'weightTiers', r.weight_tiers)
    else
      jsonb_build_object(
        'slideId', r.slide_id, 'name', r.name, 'unitType', r.unit_type, 'listPriceCents', r.price_cents::text,
        'bulkMinimumUnits', case when r.unit_type = 'UNIT' then v_bulk_minimum end,
        'bulkDiscountBps', case when r.unit_type = 'UNIT' then v_bulk_bps end,
        'weightTiers', r.weight_tiers)
    end
    order by r.position
  ), '[]'::jsonb)
  into v_slides
  from (
    select s.id as slide_id, s.position, p.id as product_id, p.name, p.sku, p.unit_type, price.price_cents,
      case
        when not (p.active and c.active is true and p.inventory_role in ('SELLABLE', 'BOTH')) then 'INACTIVE'
        when d.branch_id is not null and not exists (
          select 1 from public.branch_product_assortment a
          where a.branch_id = d.branch_id and a.product_id = p.id and a.organization_id = p.organization_id
        ) then 'NOT_IN_BRANCH'
        when coalesce(price.price_cents, 0) <= 0 then 'NO_PRICE'
      end as reason,
      case when p.unit_type = 'WEIGHT' then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', w.id, 'minimumGrams', w.minimum_grams, 'discountType', w.discount_type, 'discountValue', w.discount_value::text
        ) order by w.minimum_grams, (w.branch_id is null))
        from public.product_weight_discounts w
        where w.organization_id = d.organization_id and w.product_id = p.id and w.active
          and w.promotion_mode = 'THRESHOLD' and w.minimum_grams is not null
          and w.valid_from <= at_time and (w.valid_until is null or w.valid_until > at_time)
          and (w.branch_id is null or w.branch_id = d.branch_id)
      ), '[]'::jsonb) else '[]'::jsonb end as weight_tiers
    from public.digital_signage_slides s
    join public.products p on p.id = s.product_id and p.organization_id = s.organization_id
    left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    -- Mismo orden que el POS (`pull_pos_state`): el precio de la sucursal vigente gana sobre el global vigente.
    left join lateral (
      select pp.price_cents
      from public.product_prices pp
      where pp.organization_id = p.organization_id and pp.product_id = p.id
        and (pp.branch_id = d.branch_id or pp.branch_id is null)
        and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time)
      order by (pp.branch_id = d.branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) price on true
    where s.display_id = d.id
  ) r
  where p_admin or r.reason is null;

  if p_admin then
    return jsonb_build_object(
      'displayId', d.id, 'name', d.name, 'enabled', d.enabled, 'branchId', d.branch_id, 'branchName', v_branch_name,
      'slideDurationSeconds', d.slide_duration_seconds, 'organizationName', v_org_name, 'tokenRotatedAt', d.token_rotated_at,
      'status', case when d.enabled then 'ACTIVE' else 'DISABLED' end, 'slides', v_slides);
  end if;
  return jsonb_build_object('status', 'ACTIVE', 'slideDurationSeconds', d.slide_duration_seconds,
    'organizationName', v_org_name, 'slides', v_slides);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. RPC pública del televisor (única superficie anónima)
-- ---------------------------------------------------------------------------------------------
create function public.get_signage_display(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_display_id uuid;
begin
  -- Formato exacto del token que emite la base (32 bytes en hex minúscula): cualquier otra cosa ni siquiera se hashea.
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select d.id into v_display_id
  from public.digital_signage_displays d
  where d.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  if v_display_id is null then return null; end if;
  return app_private.signage_payload(v_display_id, false);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. RPC del Admin
-- ---------------------------------------------------------------------------------------------
-- Configuración + slides (todos, con su motivo de indisponibilidad) de UNA pantalla de mi organización. Alimenta el editor y la vista previa.
create function public.get_signage_display_admin(p_display_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
begin
  if not exists (
    select 1 from public.digital_signage_displays d where d.id = p_display_id and d.organization_id = current_organization_id
  ) then
    return null;
  end if;
  return app_private.signage_payload(p_display_id, true);
end;
$$;

-- Crea una pantalla (sin slides) y devuelve su token EN CLARO, una sola vez.
create function public.create_signage_display(p_name text, p_branch_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  v_name text := btrim(coalesce(p_name, ''));
  v_token text;
  v_id uuid;
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception 'El nombre de la pantalla tiene que tener entre 1 y 80 caracteres' using errcode = '22023';
  end if;
  if p_branch_id is not null and not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;
  if (select count(*) from public.digital_signage_displays d where d.organization_id = current_organization_id) >= 20 then
    raise exception 'Se alcanzó el máximo de 20 pantallas' using errcode = '22023';
  end if;

  -- 256 bits de un CSPRNG, en hex (64 caracteres). No deriva de ningún id ni es secuencial.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.digital_signage_displays (organization_id, branch_id, name, token_hash, created_by)
  values (current_organization_id, p_branch_id, v_name,
          encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'), auth.uid())
  returning id into v_id;

  perform app_private.write_audit(current_organization_id, p_branch_id, 'DIGITAL_SIGNAGE_DISPLAYS_INSERT', 'digital_signage_displays', v_id,
    null, jsonb_build_object('name', v_name, 'branch_id', p_branch_id));
  return jsonb_build_object('id', v_id, 'token', v_token);
end;
$$;

-- Guarda la configuración y REEMPLAZA los slides con `p_product_ids` en ese orden (una sola transacción: «Guardar / Publicar»).
create function public.save_signage_display(
  p_display_id uuid,
  p_name text,
  p_branch_id uuid,
  p_slide_duration_seconds integer,
  p_enabled boolean,
  p_product_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  d public.digital_signage_displays%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_ids uuid[] := coalesce(p_product_ids, array[]::uuid[]);
  v_before jsonb;
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception 'El nombre de la pantalla tiene que tener entre 1 y 80 caracteres' using errcode = '22023';
  end if;
  if p_slide_duration_seconds is null or p_slide_duration_seconds not between 3 and 60 then
    raise exception 'La duración de cada slide tiene que estar entre 3 y 60 segundos' using errcode = '22023';
  end if;
  if p_enabled is null then
    raise exception 'Enabled is required' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 50 then
    raise exception 'Una pantalla admite hasta 50 slides' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_ids) as t(id) where t.id is null)
     or (select count(distinct t.id) from unnest(v_ids) as t(id)) <> cardinality(v_ids) then
    raise exception 'La lista de productos tiene ids vacíos o repetidos' using errcode = '22023';
  end if;

  select * into d from public.digital_signage_displays x
  where x.id = p_display_id and x.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Signage display not found' using errcode = '42501';
  end if;
  if p_branch_id is not null and not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;
  if (select count(*) from public.products p where p.organization_id = current_organization_id and p.id = any(v_ids)) <> cardinality(v_ids) then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;

  v_before := jsonb_build_object('name', d.name, 'branch_id', d.branch_id, 'slide_duration_seconds', d.slide_duration_seconds,
    'enabled', d.enabled, 'product_ids', coalesce((select jsonb_agg(s.product_id order by s.position)
      from public.digital_signage_slides s where s.display_id = d.id), '[]'::jsonb));

  update public.digital_signage_displays
  set name = v_name, branch_id = p_branch_id, slide_duration_seconds = p_slide_duration_seconds, enabled = p_enabled
  where id = d.id;
  delete from public.digital_signage_slides where display_id = d.id;
  insert into public.digital_signage_slides (organization_id, display_id, product_id, position)
  select current_organization_id, d.id, t.id, (t.ord - 1)::integer
  from unnest(v_ids) with ordinality as t(id, ord);

  perform app_private.write_audit(current_organization_id, p_branch_id, 'DIGITAL_SIGNAGE_DISPLAYS_UPDATE', 'digital_signage_displays', d.id,
    v_before, jsonb_build_object('name', v_name, 'branch_id', p_branch_id, 'slide_duration_seconds', p_slide_duration_seconds,
      'enabled', p_enabled, 'product_ids', to_jsonb(v_ids)));
  return jsonb_build_object('id', d.id, 'slides', cardinality(v_ids));
end;
$$;

-- Invalida el enlace anterior y devuelve el nuevo token EN CLARO, una sola vez.
create function public.regenerate_signage_token(p_display_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  d public.digital_signage_displays%rowtype;
  v_token text;
begin
  select * into d from public.digital_signage_displays x
  where x.id = p_display_id and x.organization_id = current_organization_id
  for update;
  if not found then
    raise exception 'Signage display not found' using errcode = '42501';
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  update public.digital_signage_displays
  set token_hash = encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'), token_rotated_at = clock_timestamp()
  where id = d.id;
  perform app_private.write_audit(current_organization_id, d.branch_id, 'DIGITAL_SIGNAGE_DISPLAYS_TOKEN_REGENERATED',
    'digital_signage_displays', d.id, null, jsonb_build_object('name', d.name));
  return jsonb_build_object('id', d.id, 'token', v_token);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Permisos
-- ---------------------------------------------------------------------------------------------
revoke all on function app_private.signage_payload(uuid, boolean) from public, anon, authenticated;

revoke all on function public.get_signage_display(text) from public;
grant execute on function public.get_signage_display(text) to anon, authenticated;

revoke all on function public.get_signage_display_admin(uuid) from public, anon;
grant execute on function public.get_signage_display_admin(uuid) to authenticated;
revoke all on function public.create_signage_display(text, uuid) from public, anon;
grant execute on function public.create_signage_display(text, uuid) to authenticated;
revoke all on function public.save_signage_display(uuid, text, uuid, integer, boolean, uuid[]) from public, anon;
grant execute on function public.save_signage_display(uuid, text, uuid, integer, boolean, uuid[]) to authenticated;
revoke all on function public.regenerate_signage_token(uuid) from public, anon;
grant execute on function public.regenerate_signage_token(uuid) to authenticated;

commit;
