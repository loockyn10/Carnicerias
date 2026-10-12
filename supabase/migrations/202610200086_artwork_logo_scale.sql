begin;

-- Tamaño del logo de cartelería (pulido visual, D-086): un porcentaje por organización, guardado junto al logo ya existente
-- (`organization_artwork_logos`). 100 = el tamaño de siempre; 70-160 = rango que ofrece «Configurar identidad». Es sólo presentación:
-- no toca precios, promociones ni nada de lo comercial. Cambiar el logo (otro archivo) conserva el porcentaje elegido.
alter table public.organization_artwork_logos
  add column scale_percent integer not null default 100 check (scale_percent between 70 and 160);

comment on column public.organization_artwork_logos.scale_percent is
  'Tamaño del logo dentro de la franja verde de las piezas, en % (70-160; 100 = tamaño base). Cada formato lo limita internamente para que nunca se corte.';

create function public.set_organization_artwork_logo_scale(p_scale_percent integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  v_previous integer;
begin
  if p_scale_percent is null or p_scale_percent not between 70 and 160 then
    raise exception 'El tamaño del logo tiene que estar entre 70 y 160' using errcode = '22023';
  end if;
  select l.scale_percent into v_previous from public.organization_artwork_logos l where l.organization_id = current_organization_id for update;
  if not found then
    raise exception 'Todavía no hay un logo cargado' using errcode = '22023';
  end if;
  update public.organization_artwork_logos set scale_percent = p_scale_percent where organization_id = current_organization_id;
  perform app_private.write_audit(current_organization_id, null, 'ARTWORK_LOGO_SCALE_SET', 'organization_artwork_logos', current_organization_id,
    jsonb_build_object('scale_percent', v_previous), jsonb_build_object('scale_percent', p_scale_percent));
  return jsonb_build_object('scalePercent', p_scale_percent);
end;
$$;
revoke all on function public.set_organization_artwork_logo_scale(integer) from public, anon;
grant execute on function public.set_organization_artwork_logo_scale(integer) to authenticated;

-- La lectura de la identidad entrega también el porcentaje (misma firma y mismos permisos que antes).
create or replace function public.get_artwork_branding(p_branch_id uuid default null)
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
        'width', l.width_px, 'height', l.height_px, 'scalePercent', l.scale_percent)
      from public.organization_artwork_logos l where l.organization_id = current_organization_id
    ),
    'branch', v_branch
  );
end;
$$;

-- La TV (presentación de una pantalla) recibe el mismo porcentaje: misma función que la 084, sólo suma `scalePercent` al logo.
create or replace function app_private.signage_payload(p_display_id uuid, p_admin boolean)
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
  v_logo jsonb;
  v_branch_name text;
  v_folder_name text;
  v_slides jsonb;
  v_entries jsonb;
begin
  select * into d from public.digital_signage_displays where id = p_display_id;
  if not found then return null; end if;
  select o.name into v_org_name from public.organizations o where o.id = d.organization_id;
  select jsonb_build_object('storagePath', l.storage_path, 'contentType', l.content_type, 'width', l.width_px, 'height', l.height_px, 'scalePercent', l.scale_percent)
  into v_logo from public.organization_artwork_logos l where l.organization_id = d.organization_id;

  if not p_admin and not d.enabled then
    return jsonb_build_object('status', 'DISABLED', 'slideDurationSeconds', d.slide_duration_seconds,
      'organizationName', v_org_name, 'logo', v_logo, 'slides', '[]'::jsonb);
  end if;

  v_slides := app_private.signage_resolve_entries(d.organization_id, d.branch_id, app_private.signage_display_entries(d.id), p_admin, at_time);

  if p_admin then
    if d.branch_id is not null then
      select b.name into v_branch_name from public.branches b where b.id = d.branch_id;
    end if;
    if d.folder_id is not null then
      select g.name into v_folder_name from public.signage_promotion_groups g where g.id = d.folder_id and g.organization_id = d.organization_id;
    end if;
    -- Sólo la lista anterior tiene «entradas» editables; con las otras fuentes la lista sale de las promociones o de la carpeta.
    select coalesce(jsonb_agg(jsonb_build_object(
      'entryId', s.id, 'position', s.position, 'kind', s.kind, 'productId', s.product_id, 'promotionId', s.promotion_id, 'groupId', s.group_id,
      'groupName', g.name,
      'groupPromotionCount', (select count(*) from public.signage_promotion_group_items gi where gi.group_id = s.group_id)
    ) order by s.position), '[]'::jsonb)
    into v_entries
    from public.digital_signage_slides s
    left join public.signage_promotion_groups g on g.id = s.group_id and g.organization_id = s.organization_id
    where s.display_id = d.id and d.content_source = 'MANUAL';
    return jsonb_build_object(
      'displayId', d.id, 'name', d.name, 'enabled', d.enabled, 'branchId', d.branch_id, 'branchName', v_branch_name,
      'slideDurationSeconds', d.slide_duration_seconds, 'organizationName', v_org_name, 'logo', v_logo, 'tokenRotatedAt', d.token_rotated_at,
      'contentSource', d.content_source, 'folderId', d.folder_id, 'folderName', v_folder_name,
      'status', case when d.enabled then 'ACTIVE' else 'DISABLED' end, 'entries', v_entries, 'slides', v_slides);
  end if;
  return jsonb_build_object('status', 'ACTIVE', 'slideDurationSeconds', d.slide_duration_seconds,
    'organizationName', v_org_name, 'logo', v_logo, 'slides', v_slides);
end;
$$;

commit;
