begin;

-- Pollos → «Lista de precios» (D-100, ajuste 104): imágenes configurables de la plantilla, guardadas UNA vez por organización.
--
--   * Logo: se reutilizan los logos que la aplicación YA guarda (Cartelería: `organization_artwork_logos` = logo de identidad, y
--     `organization_offer_sign_settings.butcher_*` = logo de la carnicería) o uno propio de la lista. Sin configuración se usa el de
--     identidad si existe. Nunca se dibuja ni se recrea un logo.
--   * Fondo: una fotografía propia de la lista (opcional). Sin fondo, la plantilla usa un fondo neutro.
--   * Archivos: MISMO bucket privado `product-artwork` y mismas políticas de Storage de la 071 (aíslan por la primera carpeta), carpeta
--     `<organización>/poultry-price-list/<uuid>.<jpg|png>`. En Postgres sólo la referencia (ruta, tipo, peso y medidas), como D-075.
--   * Escritura sólo por RPC (`poultry.write`); lectura por RPC (`poultry.read`). Tipo y peso salen de los metadatos de Storage; las
--     medidas las lee el servidor de la cabecera del archivo.

create table public.poultry_price_list_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  logo_source text not null default 'ARTWORK' check (logo_source in ('ARTWORK', 'BUTCHER', 'CUSTOM')),
  custom_logo_path text unique,
  custom_logo_type text check (custom_logo_type in ('image/jpeg', 'image/png')),
  custom_logo_size integer check (custom_logo_size between 1 and 5242880),
  custom_logo_width integer check (custom_logo_width between 1 and 10000),
  custom_logo_height integer check (custom_logo_height between 1 and 10000),
  background_path text unique,
  background_type text check (background_type in ('image/jpeg', 'image/png')),
  background_size integer check (background_size between 1 and 5242880),
  background_width integer check (background_width between 1 and 10000),
  background_height integer check (background_height between 1 and 10000),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Cada imagen es todo o nada.
  check ((custom_logo_path is null) = (custom_logo_type is null) and (custom_logo_path is null) = (custom_logo_size is null)
    and (custom_logo_path is null) = (custom_logo_width is null) and (custom_logo_path is null) = (custom_logo_height is null)),
  check ((background_path is null) = (background_type is null) and (background_path is null) = (background_size is null)
    and (background_path is null) = (background_width is null) and (background_path is null) = (background_height is null)),
  check (logo_source <> 'CUSTOM' or custom_logo_path is not null),
  check (custom_logo_path is null or (
    custom_logo_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/poultry-price-list/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$'
    and starts_with(custom_logo_path, organization_id::text || '/poultry-price-list/'))),
  check (background_path is null or (
    background_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/poultry-price-list/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$'
    and starts_with(background_path, organization_id::text || '/poultry-price-list/')))
);

create trigger poultry_price_list_settings_set_updated_at before update on public.poultry_price_list_settings
for each row execute function app_private.set_updated_at();
create trigger poultry_price_list_settings_audit after insert or update on public.poultry_price_list_settings
for each row execute function app_private.audit_row_change();

alter table public.poultry_price_list_settings enable row level security;
create policy poultry_price_list_settings_select on public.poultry_price_list_settings
for select to authenticated using (app_private.has_permission(organization_id, 'poultry.read'));
revoke all on table public.poultry_price_list_settings from public, anon, authenticated;
grant select on public.poultry_price_list_settings to authenticated;

comment on table public.poultry_price_list_settings is
  'Imágenes de la «Lista de precios» de Pollos: origen del logo y fondo. Referencias a objetos del bucket privado product-artwork, sin bytes.';

-- Imagen como JSON (o null) para las respuestas.
create function app_private.poultry_price_list_image(p_path text, p_type text, p_width integer, p_height integer)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_path is null then null
    else jsonb_build_object('storagePath', p_path, 'contentType', p_type, 'widthPx', p_width, 'heightPx', p_height) end
$$;
revoke all on function app_private.poultry_price_list_image(text, text, integer, integer) from public, anon, authenticated;

-- Configuración + los logos disponibles + el logo que se usará (el elegido; si ya no existe, el de identidad; si tampoco, ninguno).
create function public.get_poultry_price_list_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.read');
  v_settings public.poultry_price_list_settings%rowtype;
  v_artwork jsonb;
  v_butcher jsonb;
  v_custom jsonb;
  v_source text;
  v_logo jsonb;
  v_used text;
begin
  select * into v_settings from public.poultry_price_list_settings s where s.organization_id = v_org;
  select app_private.poultry_price_list_image(l.storage_path, l.content_type, l.width_px, l.height_px) into v_artwork
  from public.organization_artwork_logos l where l.organization_id = v_org;
  select app_private.poultry_price_list_image(o.butcher_storage_path, o.butcher_content_type, o.butcher_width_px, o.butcher_height_px) into v_butcher
  from public.organization_offer_sign_settings o where o.organization_id = v_org;
  v_custom := app_private.poultry_price_list_image(v_settings.custom_logo_path, v_settings.custom_logo_type, v_settings.custom_logo_width, v_settings.custom_logo_height);
  v_source := coalesce(v_settings.logo_source, 'ARTWORK');
  v_logo := case v_source when 'ARTWORK' then v_artwork when 'BUTCHER' then v_butcher else v_custom end;
  v_used := case when v_logo is not null then v_source when v_artwork is not null then 'ARTWORK' end;
  if v_logo is null then v_logo := v_artwork; end if;

  return jsonb_build_object(
    'configured', v_settings.organization_id is not null,
    'logoSource', v_source,
    'logoUsed', v_used,
    'logo', v_logo,
    'background', app_private.poultry_price_list_image(v_settings.background_path, v_settings.background_type, v_settings.background_width, v_settings.background_height),
    'options', jsonb_build_object('ARTWORK', v_artwork, 'BUTCHER', v_butcher, 'CUSTOM', v_custom)
  );
end;
$$;

-- Elige qué logo usa la lista (sólo uno que exista).
create function public.set_poultry_price_list_logo_source(p_source text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
begin
  if p_source is null or p_source not in ('ARTWORK', 'BUTCHER', 'CUSTOM') then
    raise exception 'Origen de logo inválido' using errcode = '22023';
  end if;
  if (p_source = 'ARTWORK' and not exists (select 1 from public.organization_artwork_logos l where l.organization_id = v_org))
    or (p_source = 'BUTCHER' and not exists (select 1 from public.organization_offer_sign_settings o where o.organization_id = v_org and o.butcher_storage_path is not null))
    or (p_source = 'CUSTOM' and not exists (select 1 from public.poultry_price_list_settings s where s.organization_id = v_org and s.custom_logo_path is not null)) then
    raise exception 'Ese logo no está cargado' using errcode = '22023';
  end if;
  insert into public.poultry_price_list_settings (organization_id, logo_source, updated_by) values (v_org, p_source, auth.uid())
  on conflict (organization_id) do update set logo_source = excluded.logo_source, updated_by = excluded.updated_by;
  return jsonb_build_object('logoSource', p_source);
end;
$$;

-- Registra un logo propio (p_kind = 'LOGO', y lo deja elegido) o el fondo (p_kind = 'BACKGROUND') YA SUBIDOS a Storage. Devuelve la ruta
-- anterior para que el servidor borre ese objeto.
create function public.set_poultry_price_list_image(p_kind text, p_storage_path text, p_width_px integer, p_height_px integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_object storage.objects%rowtype;
  v_type text;
  v_size integer;
  v_previous text;
begin
  if p_kind is null or p_kind not in ('LOGO', 'BACKGROUND') then raise exception 'Imagen inválida' using errcode = '22023'; end if;
  if p_storage_path is null
     or not starts_with(p_storage_path, v_org::text || '/poultry-price-list/')
     or p_storage_path !~ '^[0-9a-f-]{36}/poultry-price-list/[0-9a-f-]{36}\.(jpg|png)$' then
    raise exception 'Ruta de imagen inválida' using errcode = '22023';
  end if;
  if p_width_px is null or p_height_px is null or p_width_px not between 1 and 10000 or p_height_px not between 1 and 10000 then
    raise exception 'Medidas de imagen inválidas' using errcode = '22023';
  end if;
  select * into v_object from storage.objects o where o.bucket_id = 'product-artwork' and o.name = p_storage_path;
  if not found then raise exception 'La imagen todavía no se subió' using errcode = '22023'; end if;
  v_type := v_object.metadata ->> 'mimetype';
  v_size := (v_object.metadata ->> 'size')::integer;
  if v_type is null or v_type not in ('image/jpeg', 'image/png') then raise exception 'La imagen tiene que ser PNG o JPG' using errcode = '22023'; end if;
  if v_size is null or v_size not between 1 and 5242880 then raise exception 'La imagen pesa demasiado (máximo 5 MB)' using errcode = '22023'; end if;
  if (v_type = 'image/jpeg' and p_storage_path !~ '\.jpg$') or (v_type = 'image/png' and p_storage_path !~ '\.png$') then
    raise exception 'La extensión de la imagen no coincide con su tipo' using errcode = '22023';
  end if;

  insert into public.poultry_price_list_settings (organization_id, updated_by) values (v_org, auth.uid()) on conflict (organization_id) do nothing;
  if p_kind = 'LOGO' then
    select s.custom_logo_path into v_previous from public.poultry_price_list_settings s where s.organization_id = v_org for update;
    update public.poultry_price_list_settings set logo_source = 'CUSTOM', custom_logo_path = p_storage_path, custom_logo_type = v_type,
      custom_logo_size = v_size, custom_logo_width = p_width_px, custom_logo_height = p_height_px, updated_by = auth.uid()
    where organization_id = v_org;
  else
    select s.background_path into v_previous from public.poultry_price_list_settings s where s.organization_id = v_org for update;
    update public.poultry_price_list_settings set background_path = p_storage_path, background_type = v_type,
      background_size = v_size, background_width = p_width_px, background_height = p_height_px, updated_by = auth.uid()
    where organization_id = v_org;
  end if;
  return jsonb_build_object('previousPath', case when v_previous is distinct from p_storage_path then v_previous end);
end;
$$;

-- Quita el fondo propio (la lista vuelve al fondo neutro) y devuelve la ruta para borrar el objeto.
create function public.remove_poultry_price_list_background()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('poultry.write');
  v_path text;
begin
  select s.background_path into v_path from public.poultry_price_list_settings s where s.organization_id = v_org for update;
  if v_path is not null then
    update public.poultry_price_list_settings set background_path = null, background_type = null, background_size = null,
      background_width = null, background_height = null, updated_by = auth.uid()
    where organization_id = v_org;
  end if;
  return jsonb_build_object('removedPath', v_path);
end;
$$;

revoke all on function
  public.get_poultry_price_list_settings(),
  public.set_poultry_price_list_logo_source(text),
  public.set_poultry_price_list_image(text, text, integer, integer),
  public.remove_poultry_price_list_background()
from public, anon;
grant execute on function
  public.get_poultry_price_list_settings(),
  public.set_poultry_price_list_logo_source(text),
  public.set_poultry_price_list_image(text, text, integer, integer),
  public.remove_poultry_price_list_background()
to authenticated;

commit;
