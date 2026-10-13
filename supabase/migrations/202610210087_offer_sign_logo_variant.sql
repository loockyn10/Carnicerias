begin;

-- Carteles de ofertas impresos (D-087): qué logo llevan. La organización ya tiene UN logo de identidad (`organization_artwork_logos`, el de la
-- despensa «Super Ofertas»); la carnicería usa otro. Se suma un único registro por organización con:
--   * `logo_variant`: cuál de los dos usan los carteles impresos (GENERAL = el de identidad, BUTCHER = el de la carnicería);
--   * el logo de la carnicería (misma forma que el de identidad: sólo la referencia a un objeto del bucket privado `product-artwork`,
--     carpeta `<organization_id>/branding/`, cuyas políticas de Storage ya aíslan por organización).
-- No toca el logo de identidad ni lo que leen Instagram, Story, TV y las etiquetas de góndola: esos siguen usando `get_artwork_branding`.

create table public.organization_offer_sign_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  logo_variant text not null default 'GENERAL' check (logo_variant in ('GENERAL', 'BUTCHER')),
  butcher_storage_path text unique,
  butcher_content_type text check (butcher_content_type in ('image/jpeg', 'image/png')),
  butcher_size_bytes integer check (butcher_size_bytes between 1 and 5242880),
  butcher_width_px integer check (butcher_width_px between 1 and 10000),
  butcher_height_px integer check (butcher_height_px between 1 and 10000),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  -- El logo de la carnicería es todo o nada, y no se puede elegir un logo que no existe.
  check ((butcher_storage_path is null) = (butcher_content_type is null)
    and (butcher_storage_path is null) = (butcher_size_bytes is null)
    and (butcher_storage_path is null) = (butcher_width_px is null)
    and (butcher_storage_path is null) = (butcher_height_px is null)),
  check (logo_variant <> 'BUTCHER' or butcher_storage_path is not null),
  check (
    butcher_storage_path is null
    or (butcher_storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/branding/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$'
      and starts_with(butcher_storage_path, organization_id::text || '/branding/'))
  )
);

create trigger organization_offer_sign_settings_set_updated_at before update on public.organization_offer_sign_settings
for each row execute function app_private.set_updated_at();

alter table public.organization_offer_sign_settings enable row level security;
create policy organization_offer_sign_settings_select on public.organization_offer_sign_settings
for select to authenticated using (app_private.has_permission(organization_id, 'products.read'));

revoke all on table public.organization_offer_sign_settings from public, anon, authenticated;
grant select on public.organization_offer_sign_settings to authenticated;

comment on table public.organization_offer_sign_settings is
  'Ajustes de los carteles de ofertas impresos: logo elegido (GENERAL o BUTCHER) y la referencia al logo de la carnicería. Sin bytes. Sólo presentación: no toca precios ni promociones.';

-- Ajustes de la organización de la sesión (sin fila = logo general y sin logo de carnicería).
create function public.get_offer_sign_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  v public.organization_offer_sign_settings%rowtype;
begin
  select * into v from public.organization_offer_sign_settings s where s.organization_id = current_organization_id;
  return jsonb_build_object(
    'logoVariant', coalesce(v.logo_variant, 'GENERAL'),
    'butcherLogo', case when v.butcher_storage_path is null then null else jsonb_build_object(
      'storagePath', v.butcher_storage_path, 'contentType', v.butcher_content_type, 'sizeBytes', v.butcher_size_bytes,
      'width', v.butcher_width_px, 'height', v.butcher_height_px) end
  );
end;
$$;

-- Elige el logo de los carteles. BUTCHER exige que ya exista el logo de la carnicería.
create function public.set_offer_sign_logo_variant(p_variant text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
begin
  if p_variant is null or p_variant not in ('GENERAL', 'BUTCHER') then
    raise exception 'Logo inválido' using errcode = '22023';
  end if;
  if p_variant = 'BUTCHER' and not exists (
    select 1 from public.organization_offer_sign_settings s where s.organization_id = current_organization_id and s.butcher_storage_path is not null
  ) then
    raise exception 'Todavía no cargaste el logo de la carnicería' using errcode = '22023';
  end if;
  -- BUTCHER sólo llega acá con la fila ya creada (se comprobó arriba): se actualiza; GENERAL puede crear la fila.
  update public.organization_offer_sign_settings s set logo_variant = p_variant, updated_by = auth.uid() where s.organization_id = current_organization_id;
  if not found then
    insert into public.organization_offer_sign_settings (organization_id, logo_variant, updated_by) values (current_organization_id, p_variant, auth.uid());
  end if;
  return jsonb_build_object('logoVariant', p_variant);
end;
$$;

-- Registra el logo de la carnicería YA SUBIDO a Storage (mismas validaciones que el logo de identidad). Devuelve la ruta anterior para borrarla.
create function public.set_offer_sign_butcher_logo(p_storage_path text, p_width_px integer, p_height_px integer)
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

  select s.butcher_storage_path into v_previous from public.organization_offer_sign_settings s where s.organization_id = current_organization_id for update;
  insert into public.organization_offer_sign_settings (organization_id, butcher_storage_path, butcher_content_type, butcher_size_bytes, butcher_width_px, butcher_height_px, updated_by)
  values (current_organization_id, p_storage_path, v_type, v_size, p_width_px, p_height_px, auth.uid())
  on conflict (organization_id) do update
  set butcher_storage_path = excluded.butcher_storage_path, butcher_content_type = excluded.butcher_content_type, butcher_size_bytes = excluded.butcher_size_bytes,
      butcher_width_px = excluded.butcher_width_px, butcher_height_px = excluded.butcher_height_px, updated_by = excluded.updated_by;
  return jsonb_build_object('previousPath', case when v_previous is distinct from p_storage_path then v_previous end);
end;
$$;

-- Quita el logo de la carnicería (vuelve al logo general) y devuelve la ruta del objeto para que el servidor lo borre de Storage.
create function public.remove_offer_sign_butcher_logo()
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
  select s.butcher_storage_path into v_path from public.organization_offer_sign_settings s where s.organization_id = current_organization_id for update;
  update public.organization_offer_sign_settings s
  set logo_variant = 'GENERAL', butcher_storage_path = null, butcher_content_type = null, butcher_size_bytes = null,
      butcher_width_px = null, butcher_height_px = null, updated_by = auth.uid()
  where s.organization_id = current_organization_id;
  return jsonb_build_object('removedPath', v_path);
end;
$$;

revoke all on function public.get_offer_sign_settings() from public, anon;
grant execute on function public.get_offer_sign_settings() to authenticated;
revoke all on function public.set_offer_sign_logo_variant(text) from public, anon;
grant execute on function public.set_offer_sign_logo_variant(text) to authenticated;
revoke all on function public.set_offer_sign_butcher_logo(text, integer, integer) from public, anon;
grant execute on function public.set_offer_sign_butcher_logo(text, integer, integer) to authenticated;
revoke all on function public.remove_offer_sign_butcher_logo() from public, anon;
grant execute on function public.remove_offer_sign_butcher_logo() to authenticated;

commit;
