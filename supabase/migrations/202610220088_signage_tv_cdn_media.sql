begin;

-- TV/CDN: los originales de `product-artwork` siguen privados. Este bucket sólo contiene WebP derivados,
-- versionados por el UUID inmutable del original y aptos para ser públicos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signage-tv-media', 'signage-tv-media', true, 2097152, array['image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create table public.signage_tv_media (
  source_path text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  public_path text not null unique,
  size_bytes integer not null check (size_bytes between 1 and 2097152),
  created_at timestamptz not null default now(),
  check (source_path ~ '^[0-9a-f-]{36}/([0-9a-f-]{36}|branding)/[0-9a-f-]{36}\.(jpg|png)$'),
  check (public_path = regexp_replace(source_path, '\.(jpg|png)$', '-tv-v1.webp')),
  check (starts_with(public_path, organization_id::text || '/'))
);
alter table public.signage_tv_media enable row level security;
revoke all on public.signage_tv_media from public, anon, authenticated;
comment on table public.signage_tv_media is 'Índice de derivados públicos e inmutables WebP para Cartelería TV; los originales siguen en product-artwork privado.';

create policy signage_tv_media_objects_insert on storage.objects for insert to authenticated
with check (bucket_id = 'signage-tv-media' and app_private.has_permission(app_private.product_artwork_path_org(name), 'catalog.write'));

create function public.register_signage_tv_media(p_source_path text, p_public_path text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  v_object storage.objects%rowtype;
begin
  if p_source_path is null or p_public_path is null
     or not starts_with(p_source_path, current_organization_id::text || '/')
     or p_public_path <> regexp_replace(p_source_path, '\.(jpg|png)$', '-tv-v1.webp') then
    raise exception 'Ruta de derivado TV inválida' using errcode = '22023';
  end if;
  if not exists (select 1 from public.product_artwork_photos where organization_id = current_organization_id and storage_path = p_source_path)
     and not exists (select 1 from public.organization_artwork_logos where organization_id = current_organization_id and storage_path = p_source_path) then
    raise exception 'Original no encontrado en esta organización' using errcode = '42501';
  end if;
  select * into v_object from storage.objects where bucket_id = 'signage-tv-media' and name = p_public_path;
  if not found or v_object.metadata ->> 'mimetype' <> 'image/webp' or coalesce((v_object.metadata ->> 'size')::integer, 0) not between 1 and 2097152 then
    raise exception 'Derivado TV inválido' using errcode = '22023';
  end if;
  insert into public.signage_tv_media(source_path, organization_id, public_path, size_bytes)
  values (p_source_path, current_organization_id, p_public_path, (v_object.metadata ->> 'size')::integer)
  on conflict (source_path) do nothing;
  return jsonb_build_object('sourcePath', p_source_path, 'publicPath', p_public_path);
end;
$$;
revoke all on function public.register_signage_tv_media(text, text) from public, anon;
grant execute on function public.register_signage_tv_media(text, text) to authenticated;

-- Sólo se exponen candidatos de mi organización; el backfill no descarga ni transforma desde el navegador.
create function public.get_signage_tv_media_backfill_candidates()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare current_organization_id uuid := app_private.require_permission('catalog.write');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('sourcePath', x.storage_path) order by x.storage_path)
    from (
      select a.storage_path from public.product_artwork_photos a
      where a.organization_id = current_organization_id and not exists (select 1 from public.signage_tv_media m where m.source_path = a.storage_path)
      union all
      select l.storage_path from public.organization_artwork_logos l
      where l.organization_id = current_organization_id and not exists (select 1 from public.signage_tv_media m where m.source_path = l.storage_path)
    ) x
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.get_signage_tv_media_backfill_candidates() from public, anon;
grant execute on function public.get_signage_tv_media_backfill_candidates() to authenticated;

-- Añade al payload únicamente la ruta pública ya registrada. Sin derivado, imageUrl queda null y el renderer usa su fallback;
-- nunca vuelve a la ruta Vercel de bytes privados.
create function app_private.signage_tv_cdn_payload(p_payload jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_set(
    jsonb_set(p_payload, '{logo}', case when jsonb_typeof(p_payload -> 'logo') = 'object' then
      (p_payload -> 'logo') || jsonb_build_object('publicPath', (select m.public_path from public.signage_tv_media m where m.source_path = p_payload #>> '{logo,storagePath}'))
      else p_payload -> 'logo' end, true),
    '{slides}', coalesce((select jsonb_agg(s.slide || case when jsonb_typeof(s.slide -> 'photo') = 'object' then jsonb_build_object('photo',
      (s.slide -> 'photo') || jsonb_build_object('publicPath', (select m.public_path from public.signage_tv_media m where m.source_path = s.slide #>> '{photo,storagePath}')))
      else '{}'::jsonb end order by s.ord)
      from jsonb_array_elements(coalesce(p_payload -> 'slides', '[]'::jsonb)) with ordinality s(slide, ord)), '[]'::jsonb), true);
$$;

create or replace function public.get_signage_display(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_display_id uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select d.id into v_display_id from public.digital_signage_displays d
  where d.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  if v_display_id is null then return null; end if;
  return app_private.signage_tv_cdn_payload(app_private.signage_payload(v_display_id, false));
end;
$$;

create or replace function public.get_signage_display_admin(p_display_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare current_organization_id uuid := app_private.require_permission('products.read');
begin
  if not exists (select 1 from public.digital_signage_displays d where d.id = p_display_id and d.organization_id = current_organization_id) then return null; end if;
  return app_private.signage_tv_cdn_payload(app_private.signage_payload(p_display_id, true));
end;
$$;

commit;
