begin;

-- Precio de un producto "sin precio" fijado desde la caja de Central (Sprint Proveedores + SimplyGest).
--
-- SimplyGest trae productos válidos con precio 0 ("el cajero le pone el precio en el momento",
-- o simplemente ya no se usan). El POS de Central los muestra normalmente pero NO los vende a $0:
-- al tocarlos o escanearlos pide el precio y lo guarda. El precio ingresado es el precio vigente del
-- producto (no un precio temporal de esa venta): el próximo escaneo ya vale lo que se cargó.
--
-- Por qué una RPC propia: la cuenta Supabase del POS es técnica (rol empleado: sin `prices.write`) y
-- darle `prices.write` abriría el Admin a cualquier caja. Esta RPC es la única vía estrecha y exige,
-- igual que el alta rápida (D-052): dispositivo activo + token de operador vigente (PIN) + permiso del
-- OPERADOR + dispositivo en la sucursal productiva configurada (Central). Además sólo puede fijar el
-- precio de un producto que HOY no tiene precio (vigente 0 o inexistente): un cambio de precio de un
-- producto que ya vale algo sigue siendo una decisión de Admin (D-037), nunca de la caja.
--
-- Historial: nunca se pisa. Se cierra la vigencia anterior (valid_to) y se inserta la nueva; el
-- trigger de la cola de cambios del POS la entrega por el cursor incremental del pull.
-- Idempotente: repetir la llamada con el mismo precio (timeout, reintento) no crea otra vigencia.

insert into public.permissions (key, description) values
  ('prices.pos_set_missing', 'Set the price of an unpriced (0) product from the POS of the central branch')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key) values
  ('10000000-0000-4000-8000-000000000001', 'prices.pos_set_missing'),
  ('10000000-0000-4000-8000-000000000002', 'prices.pos_set_missing')
on conflict (role_id, permission_key) do nothing;

-- Autorización de la caja de Central para fijar un precio. Devuelve (organización, sucursal del
-- dispositivo). El permiso lo tiene la PERSONA (operador con PIN), no la cuenta técnica.
create function app_private.pos_price_authorize(
  p_device_id uuid,
  p_operator_profile_id uuid,
  p_operator_token text
)
returns table (organization_id uuid, branch_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  access record;
begin
  select * into access
  from app_private.resolve_pos_operator(p_device_id, p_operator_profile_id, p_operator_token);

  -- Sólo el POS de Central (sucursal productiva configurada). Fail-closed si no está configurada.
  if not exists (
    select 1 from public.organizations o
    where o.id = access.organization_id and o.production_branch_id = access.branch_id
  ) then
    raise exception 'El precio de un producto sin precio sólo se puede fijar desde el POS de la sucursal Central' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.organization_members om
    join public.roles r on r.id = om.role_id
    join public.role_permissions rp on rp.role_id = r.id
    where om.organization_id = access.organization_id and om.profile_id = p_operator_profile_id and om.status = 'ACTIVE'
      and rp.permission_key = 'prices.pos_set_missing'
      and (r.organization_id is null or r.organization_id = access.organization_id)
  ) then
    raise exception 'Este operador no puede fijar precios' using errcode = '42501';
  end if;

  return query select access.organization_id, access.branch_id;
end;
$$;

-- Devuelve jsonb { status, priceCents, product }:
--   SET        el producto no tenía precio (vigente 0 o ninguno): ahora vale p_price_cents.
--   UNCHANGED  ya valía exactamente p_price_cents (reintento): no se escribe nada.
-- `product` = fila de catálogo del POS (misma forma que pull_pos_state) con el precio nuevo.
create function public.set_pos_product_price(
  p_device_id uuid,
  p_operator_profile_id uuid,
  p_operator_token text,
  p_product_id uuid,
  p_price_cents bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_branch uuid;
  v_prior public.product_prices%rowtype;
  v_has_prior boolean;
  v_at timestamptz;
  v_status text;
  v_product jsonb;
begin
  select a.organization_id, a.branch_id into v_org, v_branch
  from app_private.pos_price_authorize(p_device_id, p_operator_profile_id, p_operator_token) a;

  if p_price_cents is null or p_price_cents <= 0 then
    raise exception 'El precio de venta debe ser mayor a cero' using errcode = '22023';
  end if;
  if p_price_cents > 100000000000 then
    raise exception 'El precio de venta es demasiado alto' using errcode = '22023';
  end if;

  -- Serializa por producto: dos cajas que fijan el precio a la vez no pueden dejar dos vigencias.
  perform pg_advisory_xact_lock(hashtextextended('pos-set-price:' || p_product_id::text, 0));

  if not exists (
    select 1
    from public.products p
    join public.branch_product_assortment a
      on a.product_id = p.id and a.organization_id = p.organization_id and a.branch_id = v_branch
    where p.id = p_product_id and p.organization_id = v_org and p.active
  ) then
    raise exception 'El producto no existe, está inactivo o no se vende en esta sucursal' using errcode = '42501';
  end if;

  -- La vigencia que hoy aplica a esta sucursal (misma precedencia que el catálogo del POS).
  select pp.* into v_prior
  from public.product_prices pp
  where pp.organization_id = v_org and pp.product_id = p_product_id
    and (pp.branch_id = v_branch or pp.branch_id is null)
    and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
  order by (pp.branch_id = v_branch) desc nulls last, pp.valid_from desc
  limit 1;
  v_has_prior := found;

  if v_has_prior and v_prior.price_cents > 0 then
    if v_prior.price_cents <> p_price_cents then
      raise exception 'Este producto ya tiene precio. Un cambio de precio se hace desde Administración.' using errcode = '22023';
    end if;
    v_status := 'UNCHANGED';
  else
    -- Normalmente now(); el desplazamiento sólo evita una vigencia vacía si el precio 0 anterior
    -- se creó en esta misma transacción (importación y venta no ocurren juntas fuera de tests).
    v_at := case when v_has_prior then greatest(now(), v_prior.valid_from + interval '1 millisecond') else now() end;
    if v_has_prior then
      update public.product_prices set valid_to = v_at where id = v_prior.id;
    end if;
    insert into public.product_prices (organization_id, product_id, branch_id, price_cents, valid_from, created_by)
    values (v_org, p_product_id, case when v_has_prior then v_prior.branch_id else null end, p_price_cents, v_at, p_operator_profile_id);
    v_status := 'SET';
    perform app_private.write_audit(
      v_org, v_branch, 'POS_PRODUCT_PRICE_SET', 'products', p_product_id,
      jsonb_build_object('priceCents', case when v_has_prior then v_prior.price_cents else null end),
      jsonb_build_object('priceCents', p_price_cents, 'operatorProfileId', p_operator_profile_id, 'deviceId', p_device_id)
    );
  end if;

  v_product := app_private.pos_catalog_product_json(v_org, v_branch, p_product_id);
  if v_product is null then
    raise exception 'El producto no quedó vendible en esta sucursal' using errcode = 'XX000';
  end if;
  -- El catálogo se evalúa con now() de esta transacción: se devuelve el precio recién fijado.
  v_product := v_product || jsonb_build_object('pricePerKgCents', p_price_cents::text);
  return jsonb_build_object('status', v_status, 'priceCents', p_price_cents::text, 'product', v_product);
end;
$$;

revoke all on function app_private.pos_price_authorize(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.set_pos_product_price(uuid, uuid, text, uuid, bigint) from public, anon;
grant execute on function public.set_pos_product_price(uuid, uuid, text, uuid, bigint) to authenticated;

commit;
