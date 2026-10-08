begin;

-- Cartelería — identidad visual de las piezas (D-075): LOGO de la organización + TELÉFONO / CIUDAD de cada sucursal.
--
--   * Logo: un asset por organización en el MISMO bucket privado `product-artwork` de la migración 071, bajo la carpeta
--     `<organization_id>/branding/<uuid>.<ext>` (las políticas de `storage.objects` de la 071 ya aíslan por la primera carpeta:
--     `products.read` lee, `catalog.write` escribe/borra). En Postgres sólo queda la referencia (ruta, tipo, peso y medidas en px).
--   * Contacto: `branches.address` ya existía (D-074); se agregan `branches.phone` y `branches.city`. El contacto es de la SUCURSAL
--     (la pieza ya elige sucursal): una pieza nunca mezcla datos de otra.
--   * `get_artwork_branding(sucursal)` entrega logo + contacto de esa sucursal en un único JSON; el precio/promoción NO pasan por acá
--     (siguen saliendo de `get_product_artwork`, sin cambios).
--
-- Incremental: no modifica la migración 071 ni ninguna función existente (`save_branch` sigue igual: teléfono y ciudad se editan con
-- `set_branch_artwork_contact`).

-- ---------------------------------------------------------------------------------------------
-- 1. Teléfono y ciudad de la sucursal
-- ---------------------------------------------------------------------------------------------
alter table public.branches
  add column phone text check (phone is null or (char_length(phone) between 3 and 40 and phone ~ '^[0-9 +()./-]+$')),
  add column city text check (city is null or char_length(city) between 2 and 80);

comment on column public.branches.phone is 'Teléfono de contacto que se imprime en la cartelería (sólo dígitos y + ( ) . / -). NULL = no se muestra.';
comment on column public.branches.city is 'Ciudad y provincia que se imprimen en la cartelería (p. ej. «Esperanza, Santa Fe»). NULL = no se muestra.';

-- ---------------------------------------------------------------------------------------------
-- 2. Logo de cartelería de la organización
-- ---------------------------------------------------------------------------------------------
create table public.organization_artwork_logos (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- `<organization_id>/branding/<uuid>.<ext>` dentro del bucket `product-artwork`.
  storage_path text not null unique,
  content_type text not null check (content_type in ('image/jpeg', 'image/png')),
  size_bytes integer not null check (size_bytes between 1 and 5242880),
  width_px integer not null check (width_px between 1 and 10000),
  height_px integer not null check (height_px between 1 and 10000),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/branding/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$'
    and starts_with(storage_path, organization_id::text || '/branding/')
  )
);

create trigger organization_artwork_logos_set_updated_at before update on public.organization_artwork_logos
for each row execute function app_private.set_updated_at();

alter table public.organization_artwork_logos enable row level security;
create policy organization_artwork_logos_select on public.organization_artwork_logos
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));

revoke all on table public.organization_artwork_logos from public, anon, authenticated;
grant select on public.organization_artwork_logos to authenticated;

comment on table public.organization_artwork_logos is
  'Logo de cartelería de la organización: referencia a un objeto del bucket privado product-artwork. Sin bytes. Se escribe sólo con set/remove_organization_artwork_logo.';

-- ---------------------------------------------------------------------------------------------
-- 3. Escritura
-- ---------------------------------------------------------------------------------------------
-- Registra el logo YA SUBIDO a Storage. Tipo y peso salen de los metadatos que Storage guardó del objeto; las medidas las informa el
-- servidor (las lee de la cabecera del archivo) y sólo se usan para acomodar el logo dentro de la franja. Devuelve la ruta anterior.
create function public.set_organization_artwork_logo(p_storage_path text, p_width_px integer, p_height_px integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  v_object storage.objects%rowtype;
  v_type text;
  v_size integer;
  v_previous text;
begin
  if p_storage_path is null
     or not starts_with(p_storage_path, current_organization_id::text || '/branding/')
     or p_storage_path !~ '^[0-9a-f-]{36}/branding/[0-9a-f-]{36}\.(jpg|png)$' then
    raise exception 'Ruta de logo inválida' using errcode = '22023';
  end if;
  if p_width_px is null or p_height_px is null or p_width_px not between 1 and 10000 or p_height_px not between 1 and 10000 then
    raise exception 'Medidas de logo inválidas' using errcode = '22023';
  end if;

  select * into v_object from storage.objects o where o.bucket_id = 'product-artwork' and o.name = p_storage_path;
  if not found then
    raise exception 'El logo todavía no se subió' using errcode = '22023';
  end if;
  v_type := v_object.metadata ->> 'mimetype';
  v_size := (v_object.metadata ->> 'size')::integer;
  if v_type is null or v_type not in ('image/jpeg', 'image/png') then
    raise exception 'El logo tiene que ser PNG o JPG' using errcode = '22023';
  end if;
  if v_size is null or v_size not between 1 and 5242880 then
    raise exception 'El logo pesa demasiado (máximo 5 MB)' using errcode = '22023';
  end if;
  if (v_type = 'image/jpeg' and p_storage_path !~ '\.jpg$') or (v_type = 'image/png' and p_storage_path !~ '\.png$') then
    raise exception 'La extensión del logo no coincide con su tipo' using errcode = '22023';
  end if;

  select l.storage_path into v_previous from public.organization_artwork_logos l where l.organization_id = current_organization_id for update;
  insert into public.organization_artwork_logos (organization_id, storage_path, content_type, size_bytes, width_px, height_px, created_by)
  values (current_organization_id, p_storage_path, v_type, v_size, p_width_px, p_height_px, auth.uid())
  on conflict (organization_id) do update
  set storage_path = excluded.storage_path, content_type = excluded.content_type, size_bytes = excluded.size_bytes,
      width_px = excluded.width_px, height_px = excluded.height_px, created_by = excluded.created_by;

  perform app_private.write_audit(current_organization_id, null, 'ARTWORK_LOGO_SET', 'organization_artwork_logos', current_organization_id,
    case when v_previous is null then null else jsonb_build_object('storage_path', v_previous) end,
    jsonb_build_object('storage_path', p_storage_path, 'content_type', v_type, 'size_bytes', v_size));
  return jsonb_build_object('previousPath', case when v_previous is distinct from p_storage_path then v_previous end);
end;
$$;

-- Quita la referencia del logo y devuelve la ruta del objeto para que el servidor lo borre de Storage. Sin logo => removedPath NULL.
create function public.remove_organization_artwork_logo()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  v_path text;
begin
  delete from public.organization_artwork_logos l where l.organization_id = current_organization_id returning l.storage_path into v_path;
  if v_path is not null then
    perform app_private.write_audit(current_organization_id, null, 'ARTWORK_LOGO_REMOVED', 'organization_artwork_logos', current_organization_id,
      jsonb_build_object('storage_path', v_path), null);
  end if;
  return jsonb_build_object('removedPath', v_path);
end;
$$;

-- Teléfono, dirección y ciudad que la cartelería imprime para UNA sucursal (vacío = se borra el dato). La edición de nombre/código/activa
-- sigue en `save_branch` (permiso branches.write, el mismo que esta función).
create function public.set_branch_artwork_contact(p_branch_id uuid, p_phone text, p_address text, p_city text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('branches.write');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  v_city text := nullif(btrim(coalesce(p_city, '')), '');
begin
  if v_phone is not null and (char_length(v_phone) not between 3 and 40 or v_phone !~ '^[0-9 +()./-]+$') then
    raise exception 'El teléfono sólo puede tener números, espacios y + ( ) . / - (3 a 40 caracteres)' using errcode = '22023';
  end if;
  if v_address is not null and char_length(v_address) > 200 then
    raise exception 'La dirección es demasiado larga (máximo 200 caracteres)' using errcode = '22023';
  end if;
  if v_city is not null and char_length(v_city) not between 2 and 80 then
    raise exception 'La ciudad debe tener entre 2 y 80 caracteres' using errcode = '22023';
  end if;
  update public.branches b set phone = v_phone, address = v_address, city = v_city
  where b.id = p_branch_id and b.organization_id = current_organization_id;
  if not found then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;
  return jsonb_build_object('branchId', p_branch_id, 'phone', v_phone, 'address', v_address, 'city', v_city);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Lectura (permiso products.read)
-- ---------------------------------------------------------------------------------------------
-- Identidad de la pieza: logo de la organización + contacto de la sucursal elegida (NULL = precio general: sin contacto). Una sucursal
-- de otra organización => 42501; el logo y el contacto son siempre de la organización de la sesión.
create function public.get_artwork_branding(p_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  v_branch jsonb;
begin
  if p_branch_id is not null then
    select jsonb_build_object('id', b.id, 'name', b.name, 'phone', nullif(btrim(b.phone), ''),
      'address', nullif(btrim(b.address), ''), 'city', nullif(btrim(b.city), ''))
    into v_branch
    from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id;
    if v_branch is null then
      raise exception 'Branch not found' using errcode = '42501';
    end if;
  end if;
  return jsonb_build_object(
    'organizationName', (select o.name from public.organizations o where o.id = current_organization_id),
    'logo', (
      select jsonb_build_object('storagePath', l.storage_path, 'contentType', l.content_type, 'sizeBytes', l.size_bytes,
        'width', l.width_px, 'height', l.height_px)
      from public.organization_artwork_logos l where l.organization_id = current_organization_id
    ),
    'branch', v_branch
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Permisos
-- ---------------------------------------------------------------------------------------------
revoke all on function public.set_organization_artwork_logo(text, integer, integer) from public, anon;
grant execute on function public.set_organization_artwork_logo(text, integer, integer) to authenticated;
revoke all on function public.remove_organization_artwork_logo() from public, anon;
grant execute on function public.remove_organization_artwork_logo() to authenticated;
revoke all on function public.set_branch_artwork_contact(uuid, text, text, text) from public, anon;
grant execute on function public.set_branch_artwork_contact(uuid, text, text, text) to authenticated;
revoke all on function public.get_artwork_branding(uuid) from public, anon;
grant execute on function public.get_artwork_branding(uuid) to authenticated;

commit;
