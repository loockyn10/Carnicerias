-- Mercado Pago — ciclo de vida de la VENTA (D-055). Reemplaza el supuesto de 202610010050 de que una
-- venta Mercado Pago ya nace COMPLETED: el dinero recién cuenta cuando el backend lo confirma.
--
--   venta iniciada ─ PENDING_PAYMENT ─┬─ Mercado Pago acredita (monto exacto) ─→ COMPLETED
--                                      └─ cancelado / vencido sin acreditar ───→ CANCELLED (stock restituido UNA vez)
--
-- Principios:
--   * Una sola función de transición: `app_private.mp_reconcile_sale`. La llaman el polling
--     (mp-order-status), el webhook (mp-webhook), la cancelación (mp-cancel-order) y la llegada de la
--     venta (sync). Todos convergen en el mismo resultado; el webhook es complementario, nunca obligatorio.
--   * La transición de la venta ocurre bajo lock de la fila de `sales` => un cancelar repetido, un
--     webhook duplicado o una carrera cancelar-vs-pago nunca restituyen stock dos veces ni anulan dos veces.
--   * "CONFIRMED siempre gana": si un cobro ya fue acreditado nada lo anula; si llega la acreditación
--     después de que la venta se anuló automáticamente (carrera), la venta se restablece.
--   * El stock sigue siendo el ledger `stock_movements`: la anulación reutiliza `RETURN` (igual que
--     `cancel_sale`) y el restablecimiento un `SALE` nuevo. Ningún mecanismo paralelo.
--   * Transferencia manual: una sucursal con Mercado Pago habilitado y
--     `require_verified_digital_payments` no admite una venta TRANSFER sin proveedor, venga de donde
--     venga (trigger sobre `payments`), no sólo escondida en el POS.

begin;

-- ---------------------------------------------------------------------------
-- Configuración por sucursal: pagos digitales verificados obligatorios
-- ---------------------------------------------------------------------------
alter table public.mercadopago_branch_pos
  add column require_verified_digital_payments boolean not null default true;

comment on column public.mercadopago_branch_pos.require_verified_digital_payments is
  'Con enabled = true, la sucursal no acepta Transferencia manual (TRANSFER sin proveedor): el único medio digital es Mercado Pago, verificado por el backend. false = se permite además la transferencia declarada (p. ej. si Mercado Pago está caído).';

-- ---------------------------------------------------------------------------
-- Helpers de transición de la venta (privados)
-- ---------------------------------------------------------------------------

-- Anula una venta PENDING_PAYMENT sin acreditación y restituye su stock. Idempotente: sólo actúa
-- sobre PENDING_PAYMENT, bajo lock de la fila, así que la segunda llamada no hace nada.
create function app_private.mp_cancel_pending_sale(p_sale_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_sale public.sales%rowtype;
  cancellation_time timestamptz := now();
begin
  select * into current_sale from public.sales where id = p_sale_id for update;
  if not found or current_sale.status <> 'PENDING_PAYMENT' then
    return false;
  end if;

  insert into public.stock_movements (
    organization_id, branch_id, product_id, type, quantity_grams, sale_id, reason, profile_id, occurred_at
  )
  select
    si.organization_id, si.branch_id, si.product_id, 'RETURN',
    sum(coalesce(si.weight_grams, si.quantity_units))::bigint, si.sale_id,
    p_reason, current_sale.profile_id, cancellation_time
  from public.sale_items si
  where si.sale_id = p_sale_id
  group by si.organization_id, si.branch_id, si.product_id, si.sale_id;

  update public.sales
  set status = 'CANCELLED', cancellation_key = extensions.gen_random_uuid(), cancelled_at = cancellation_time,
      cancelled_by = current_sale.profile_id, cancellation_reason = p_reason
  where id = p_sale_id;

  perform app_private.write_audit(
    current_sale.organization_id, current_sale.branch_id, 'SALE_CANCELLED_NO_ACCREDITATION', 'sales', p_sale_id,
    jsonb_build_object('status', 'PENDING_PAYMENT'),
    jsonb_build_object('status', 'CANCELLED', 'reason', p_reason)
  );
  return true;
end;
$$;

-- Carrera: el dinero SÍ llegó después de que el sistema anuló la venta por falta de acreditación.
-- Sólo revierte anulaciones automáticas de Mercado Pago (nunca una anulación hecha por un
-- administrador con `cancel_sale`): la venta vuelve a COMPLETED y su stock a descontarse.
create function app_private.mp_restore_cancelled_sale(p_sale_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_sale public.sales%rowtype;
  restore_time timestamptz := now();
begin
  select * into current_sale from public.sales where id = p_sale_id for update;
  if not found
     or current_sale.status <> 'CANCELLED'
     or current_sale.cancellation_reason is null
     or current_sale.cancellation_reason not like 'Mercado Pago:%'
     or current_sale.cancelled_by is distinct from current_sale.profile_id then
    return false;
  end if;

  insert into public.stock_movements (
    organization_id, branch_id, product_id, type, quantity_grams, sale_id, reason, profile_id, occurred_at
  )
  select
    si.organization_id, si.branch_id, si.product_id, 'SALE',
    -sum(coalesce(si.weight_grams, si.quantity_units))::bigint, si.sale_id,
    'Pago acreditado por Mercado Pago: se restablece la venta', current_sale.profile_id, restore_time
  from public.sale_items si
  where si.sale_id = p_sale_id
  group by si.organization_id, si.branch_id, si.product_id, si.sale_id;

  update public.sales
  set status = 'COMPLETED', cancellation_key = null, cancelled_at = null, cancelled_by = null, cancellation_reason = null
  where id = p_sale_id;

  perform app_private.write_audit(
    current_sale.organization_id, current_sale.branch_id, 'SALE_RESTORED_PAYMENT_CONFIRMED', 'sales', p_sale_id,
    jsonb_build_object('status', 'CANCELLED'), jsonb_build_object('status', 'COMPLETED')
  );
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- La función de transición única (reemplaza la de 202610010050; misma firma)
-- ---------------------------------------------------------------------------
create or replace function app_private.mp_reconcile_sale(p_sale_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  pay public.payments%rowtype;
  ord public.mercadopago_orders%rowtype;
  current_sale public.sales%rowtype;
  sale_exists boolean;
  new_status text;
  new_verified_at timestamptz := null;
  new_amount bigint := null;
begin
  select * into pay from public.payments
  where sale_id = p_sale_id and provider = 'MERCADOPAGO'
  order by created_at limit 1;
  if not found then return; end if;

  -- Lock primero: serializa cualquier otra transición de esta venta (cancelar vs pagar).
  select * into current_sale from public.sales where id = p_sale_id for update;
  sale_exists := found;

  select * into ord from public.mercadopago_orders
  where sale_id = p_sale_id and status = 'CONFIRMED'
  order by attempt desc limit 1;
  if found then
    -- Confirmado de verdad sólo si lo acreditado, lo esperado y el total validado de la venta coinciden.
    if not ord.amount_mismatch
       and ord.confirmed_amount_cents = pay.amount_cents
       and ord.expected_amount_cents = pay.amount_cents then
      new_status := 'CONFIRMED';
    else
      new_status := 'MISMATCH';
    end if;
    new_verified_at := ord.confirmed_at;
    new_amount := ord.confirmed_amount_cents;
  else
    select * into ord from public.mercadopago_orders
    where sale_id = p_sale_id
    order by attempt desc limit 1;
    if not found then
      new_status := 'PENDING';
    else
      new_status := case ord.status
        when 'EXPIRED' then 'EXPIRED'
        when 'CANCELLED' then 'CANCELLED'
        when 'ERROR' then 'ERROR'
        when 'REFUNDED' then 'REFUNDED'
        else 'PENDING'
      end;
    end if;
  end if;

  -- Una venta ya anulada por falta de acreditación se lee siempre como "no acreditada", nunca
  -- como "pendiente" o "error" (p. ej. anulada sin que hubiera una orden viva).
  if sale_exists and current_sale.status = 'CANCELLED' and new_status in ('PENDING', 'ERROR') then
    new_status := 'CANCELLED';
  end if;

  if (new_status, new_verified_at, new_amount)
     is distinct from (pay.verification_status, pay.verified_at, pay.verified_amount_cents) then
    perform set_config('carnicerias.payment_verifier', 'mercadopago', true);
    update public.payments
    set verification_status = new_status, verified_at = new_verified_at, verified_amount_cents = new_amount
    where id = pay.id;
    perform set_config('carnicerias.payment_verifier', '', true);
  end if;

  -- Ciclo de vida de la venta. MISMATCH / REFUNDED / ERROR / PENDING no mueven la venta: el dinero no
  -- está (o está mal) y requiere a un humano, o la venta sigue esperando.
  if sale_exists then
    if new_status = 'CONFIRMED' then
      if current_sale.status = 'PENDING_PAYMENT' then
        update public.sales set status = 'COMPLETED' where id = p_sale_id;
        perform app_private.write_audit(
          current_sale.organization_id, current_sale.branch_id, 'SALE_PAYMENT_CONFIRMED', 'sales', p_sale_id,
          jsonb_build_object('status', 'PENDING_PAYMENT'), jsonb_build_object('status', 'COMPLETED')
        );
      elsif current_sale.status = 'CANCELLED' then
        perform app_private.mp_restore_cancelled_sale(p_sale_id);
      end if;
    elsif new_status in ('EXPIRED', 'CANCELLED') and current_sale.status = 'PENDING_PAYMENT' then
      perform app_private.mp_cancel_pending_sale(
        p_sale_id,
        case new_status
          when 'EXPIRED' then 'Mercado Pago: cobro vencido sin acreditación'
          else 'Mercado Pago: cobro cancelado sin acreditación'
        end
      );
    end if;
  end if;
end;
$$;

-- La venta llegó al servidor declarada como Mercado Pago: queda PENDING_PAYMENT hasta que el backend
-- confirme (reemplaza la de 202610010050). El pase a PENDING_PAYMENT ocurre sólo en la primera
-- declaración (el reintento idempotente no toca una venta ya resuelta) y la reconciliación posterior
-- la resuelve al instante si la orden ya estaba pagada / cancelada / vencida.
create or replace function app_private.mp_declare_sale_payment(p_sale_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  declared integer;
begin
  perform set_config('carnicerias.payment_verifier', 'mercadopago', true);
  update public.payments
  set provider = 'MERCADOPAGO', verification_status = 'PENDING'
  where sale_id = p_sale_id and method = 'TRANSFER' and provider is null;
  get diagnostics declared = row_count;
  perform set_config('carnicerias.payment_verifier', '', true);

  if declared > 0 then
    update public.sales set status = 'PENDING_PAYMENT' where id = p_sale_id and status = 'COMPLETED';
  end if;
  perform app_private.mp_reconcile_sale(p_sale_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Sync: declarar el proveedor habilita la transferencia sólo para esa venta
-- ---------------------------------------------------------------------------
create or replace function public.sync_offline_sale(p_device_id uuid, p_event_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
  declared_provider boolean := upper(coalesce(p_payload->'payment'->>'provider', '')) = 'MERCADOPAGO';
begin
  -- El trigger `payments_guard_manual_transfer` rechaza TRANSFER sin proveedor en una sucursal con
  -- Mercado Pago obligatorio; una venta Mercado Pago se inserta como TRANSFER y recién después se
  -- le asigna el proveedor, así que se la deja pasar sólo durante esta transacción.
  if declared_provider then
    perform set_config('carnicerias.payment_provider_declared', 'MERCADOPAGO', true);
  end if;
  result := app_private.sync_offline_sale_core(p_device_id, p_event_id, p_payload);
  if declared_provider then
    perform set_config('carnicerias.payment_provider_declared', '', true);
    -- También en el reintento idempotente (`duplicate: true`): la declaración converge igual.
    perform app_private.mp_declare_sale_payment((result->>'saleId')::uuid);
  end if;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Transferencia manual prohibida donde Mercado Pago es obligatorio (no sólo visual)
-- ---------------------------------------------------------------------------
create function app_private.guard_manual_transfer()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.method = 'TRANSFER'
     and new.provider is null
     and coalesce(current_setting('carnicerias.payment_provider_declared', true), '') <> 'MERCADOPAGO'
     and exists (
       select 1 from public.mercadopago_branch_pos c
       where c.organization_id = new.organization_id and c.branch_id = new.branch_id
         and c.enabled and c.require_verified_digital_payments
     ) then
    raise exception 'MANUAL_TRANSFER_NOT_ALLOWED' using errcode = 'P0001',
      hint = 'Esta sucursal cobra los pagos digitales sólo con Mercado Pago verificado.';
  end if;
  return new;
end;
$$;

create trigger payments_guard_manual_transfer
before insert on public.payments
for each row execute function app_private.guard_manual_transfer();

-- ---------------------------------------------------------------------------
-- mp_prepare_order: una venta anulada o que no es Mercado Pago no admite una orden nueva
-- (reemplaza la de 202610010050; misma firma)
-- ---------------------------------------------------------------------------
create or replace function public.mp_prepare_order(
  p_device_id uuid,
  p_sale_id uuid,
  p_amount_cents bigint,
  p_operator_profile_id uuid,
  p_operator_token text,
  p_retry boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  access record;
  cfg public.mercadopago_branch_pos%rowtype;
  ord public.mercadopago_orders%rowtype;
  existing_sale record;
  next_attempt integer := 1;
begin
  if p_sale_id is null or p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 1000000000 then
    raise exception 'Invalid Mercado Pago amount' using errcode = '22023';
  end if;
  select * into access
  from app_private.resolve_pos_operator(p_device_id, p_operator_profile_id, p_operator_token, now());

  select * into cfg from public.mercadopago_branch_pos
  where branch_id = access.branch_id and organization_id = access.organization_id;
  if not found or not cfg.enabled then
    raise exception 'MP_NOT_CONFIGURED' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mp-order:' || p_sale_id::text, 0));

  -- Si la venta ya llegó al servidor, su total validado manda: el monto del POS no se acepta a ciegas.
  select s.organization_id, s.branch_id, s.total_cents, s.status::text as status,
         exists (select 1 from public.payments p where p.sale_id = s.id and p.provider = 'MERCADOPAGO') as is_mercadopago
  into existing_sale
  from public.sales s where s.id = p_sale_id;
  if found and (existing_sale.organization_id <> access.organization_id
                or existing_sale.branch_id <> access.branch_id
                or existing_sale.total_cents <> p_amount_cents) then
    raise exception 'Sale does not match the requested Mercado Pago amount' using errcode = '22023';
  end if;

  select * into ord from public.mercadopago_orders
  where sale_id = p_sale_id and status = 'CONFIRMED'
  order by attempt desc limit 1;
  if not found then
    select * into ord from public.mercadopago_orders
    where sale_id = p_sale_id
    order by attempt desc limit 1;
  end if;

  if found then
    if ord.organization_id <> access.organization_id or ord.branch_id <> access.branch_id then
      raise exception 'Sale is not available for this device' using errcode = '42501';
    end if;
    if ord.expected_amount_cents <> p_amount_cents then
      raise exception 'Mercado Pago order already exists with another amount' using errcode = '22023';
    end if;
    if ord.status in ('REQUESTING', 'CREATED', 'CONFIRMED') or not coalesce(p_retry, false) then
      return app_private.mp_order_json(ord)
        || jsonb_build_object('qrMode', cfg.qr_mode, 'isNew', false);
    end if;
    next_attempt := ord.attempt + 1;
    if next_attempt > 20 then
      raise exception 'Too many Mercado Pago attempts for this sale' using errcode = '22023';
    end if;
  end if;

  -- Una orden nueva sólo tiene sentido para una venta que sigue esperando el pago.
  if existing_sale.status is not null
     and (existing_sale.status <> 'PENDING_PAYMENT' or not existing_sale.is_mercadopago) then
    raise exception 'SALE_NOT_PAYABLE' using errcode = 'P0001';
  end if;

  insert into public.mercadopago_orders(
    organization_id, branch_id, device_id, sale_id, attempt, external_reference,
    external_pos_id, expiration_minutes, expected_amount_cents, requested_by, expires_at
  ) values (
    access.organization_id, access.branch_id, p_device_id, p_sale_id, next_attempt,
    app_private.mp_external_reference(p_sale_id, next_attempt),
    cfg.external_pos_id, cfg.expiration_minutes, p_amount_cents, access.operator_profile_id,
    now() + make_interval(mins => cfg.expiration_minutes)
  ) returning * into ord;

  perform app_private.mp_reconcile_sale(p_sale_id);
  return app_private.mp_order_json(ord) || jsonb_build_object('qrMode', cfg.qr_mode, 'isNew', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- mp_get_order_status: añade el estado de la VENTA (reemplaza la anterior; misma firma)
-- ---------------------------------------------------------------------------
create or replace function public.mp_get_order_status(p_device_id uuid, p_sale_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_branch uuid;
  ord public.mercadopago_orders%rowtype;
  v_verification text;
  v_sale_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select d.organization_id, d.branch_id into v_org, v_branch
  from public.pos_devices d where d.id = p_device_id and d.status = 'ACTIVE';
  if v_org is null or not app_private.can_access_branch(v_org, v_branch, 'sales.create') then
    raise exception 'Device is not authorized' using errcode = '42501';
  end if;

  select * into ord from public.mercadopago_orders
  where sale_id = p_sale_id and organization_id = v_org and branch_id = v_branch and status = 'CONFIRMED'
  order by attempt desc limit 1;
  if not found then
    select * into ord from public.mercadopago_orders
    where sale_id = p_sale_id and organization_id = v_org and branch_id = v_branch
    order by attempt desc limit 1;
  end if;

  select p.verification_status into v_verification
  from public.payments p
  where p.sale_id = p_sale_id and p.organization_id = v_org and p.provider = 'MERCADOPAGO'
  limit 1;

  select s.status::text into v_sale_status
  from public.sales s
  where s.id = p_sale_id and s.organization_id = v_org and s.branch_id = v_branch;

  if ord.id is null then
    return case when v_verification is null then null
      else jsonb_build_object('saleId', p_sale_id, 'status', null, 'verificationStatus', v_verification, 'saleStatus', v_sale_status) end;
  end if;
  return app_private.mp_order_json(ord)
    || jsonb_build_object('verificationStatus', v_verification, 'saleStatus', v_sale_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- mp_get_branch_config: ¿esta caja admite transferencia manual? (reemplaza la anterior; misma firma)
-- ---------------------------------------------------------------------------
create or replace function public.mp_get_branch_config(p_device_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_branch uuid;
  cfg public.mercadopago_branch_pos%rowtype;
  v_found boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select d.organization_id, d.branch_id into v_org, v_branch
  from public.pos_devices d where d.id = p_device_id and d.status = 'ACTIVE';
  if v_org is null or not app_private.can_access_branch(v_org, v_branch, 'sales.create') then
    raise exception 'Device is not authorized' using errcode = '42501';
  end if;
  select * into cfg from public.mercadopago_branch_pos
  where branch_id = v_branch and organization_id = v_org;
  v_found := found;
  return jsonb_build_object(
    'branchId', v_branch,
    'enabled', v_found and cfg.enabled,
    'qrMode', case when v_found then cfg.qr_mode else null end,
    -- Con Mercado Pago habilitado y obligatorio, la transferencia manual no existe en esta sucursal.
    'manualTransferAllowed', not (v_found and cfg.enabled and cfg.require_verified_digital_payments)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Anular una venta Mercado Pago que nunca tuvo (o ya no tiene) una orden viva en Mercado Pago
-- ---------------------------------------------------------------------------
-- Para el POS: "Anular venta" cuando no hay un QR vivo que cancelar (la alta del cobro falló, ERROR).
-- Con una orden viva (CREATED/REQUESTING) la cancelación pasa por Mercado Pago (mp-cancel-order); con
-- una orden CONFIRMED no se anula nada (el pago ya llegó). Idempotente.
create function public.mp_abandon_unpaid_sale(p_device_id uuid, p_sale_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_branch uuid;
  current_sale public.sales%rowtype;
  v_changed boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select d.organization_id, d.branch_id into v_org, v_branch
  from public.pos_devices d where d.id = p_device_id and d.status = 'ACTIVE';
  if v_org is null or not app_private.can_access_branch(v_org, v_branch, 'sales.create') then
    raise exception 'Device is not authorized' using errcode = '42501';
  end if;

  select * into current_sale from public.sales
  where id = p_sale_id and organization_id = v_org and branch_id = v_branch
  for update;
  if not found then
    return jsonb_build_object('saleId', p_sale_id, 'abandoned', false, 'reason', 'SALE_NOT_SYNCED');
  end if;
  if not exists (select 1 from public.payments p where p.sale_id = p_sale_id and p.provider = 'MERCADOPAGO') then
    raise exception 'SALE_NOT_PAYABLE' using errcode = 'P0001';
  end if;
  if current_sale.status = 'CANCELLED' then
    return jsonb_build_object('saleId', p_sale_id, 'abandoned', true, 'changed', false, 'saleStatus', 'CANCELLED');
  end if;
  if current_sale.status <> 'PENDING_PAYMENT' then
    return jsonb_build_object('saleId', p_sale_id, 'abandoned', false, 'reason', 'NOT_PENDING', 'saleStatus', current_sale.status::text);
  end if;
  if exists (
    select 1 from public.mercadopago_orders o
    where o.sale_id = p_sale_id and o.status in ('REQUESTING', 'CREATED', 'CONFIRMED')
  ) then
    return jsonb_build_object('saleId', p_sale_id, 'abandoned', false, 'reason', 'ORDER_ACTIVE', 'saleStatus', 'PENDING_PAYMENT');
  end if;

  v_changed := app_private.mp_cancel_pending_sale(p_sale_id, 'Mercado Pago: venta anulada sin acreditación');
  perform app_private.mp_reconcile_sale(p_sale_id);
  return jsonb_build_object('saleId', p_sale_id, 'abandoned', true, 'changed', v_changed, 'saleStatus', 'CANCELLED');
end;
$$;

-- ---------------------------------------------------------------------------
-- Configuración de sucursal (admin): ahora con la política de transferencia manual
-- ---------------------------------------------------------------------------
drop function public.set_mercadopago_branch_pos(uuid, text, text, text, text, integer, boolean);
drop function public.get_mercadopago_branch_pos();

create function public.set_mercadopago_branch_pos(
  p_branch_id uuid,
  p_external_pos_id text,
  p_mp_store_id text default null,
  p_mp_pos_id text default null,
  p_qr_mode text default 'static',
  p_expiration_minutes integer default 15,
  p_enabled boolean default false,
  p_require_verified_digital_payments boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('payments.manage');
  v_id uuid;
begin
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.organization_id = v_org) then
    raise exception 'Branch not found' using errcode = 'P0002';
  end if;
  insert into public.mercadopago_branch_pos(
    organization_id, branch_id, external_pos_id, mp_store_id, mp_pos_id, qr_mode, expiration_minutes, enabled,
    require_verified_digital_payments
  ) values (
    v_org, p_branch_id, p_external_pos_id, nullif(btrim(p_mp_store_id), ''), nullif(btrim(p_mp_pos_id), ''),
    p_qr_mode, p_expiration_minutes, coalesce(p_enabled, false), coalesce(p_require_verified_digital_payments, true)
  )
  on conflict (branch_id) do update
    set external_pos_id = excluded.external_pos_id,
        mp_store_id = excluded.mp_store_id,
        mp_pos_id = excluded.mp_pos_id,
        qr_mode = excluded.qr_mode,
        expiration_minutes = excluded.expiration_minutes,
        enabled = excluded.enabled,
        require_verified_digital_payments = excluded.require_verified_digital_payments
  returning id into v_id;
  perform app_private.write_audit(
    v_org, p_branch_id, 'MERCADOPAGO_BRANCH_POS_SET', 'mercadopago_branch_pos', v_id, null,
    jsonb_build_object('externalPosId', p_external_pos_id, 'qrMode', p_qr_mode,
      'expirationMinutes', p_expiration_minutes, 'enabled', coalesce(p_enabled, false),
      'requireVerifiedDigitalPayments', coalesce(p_require_verified_digital_payments, true))
  );
  return v_id;
end;
$$;

create function public.get_mercadopago_branch_pos()
returns table (
  branch_id uuid,
  branch_name text,
  external_pos_id text,
  mp_store_id text,
  mp_pos_id text,
  qr_mode text,
  expiration_minutes integer,
  enabled boolean,
  require_verified_digital_payments boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('payments.read');
begin
  return query
  select b.id, b.name, c.external_pos_id, c.mp_store_id, c.mp_pos_id, c.qr_mode, c.expiration_minutes, c.enabled,
         c.require_verified_digital_payments
  from public.branches b
  left join public.mercadopago_branch_pos c on c.branch_id = b.id and c.organization_id = b.organization_id
  where b.organization_id = v_org
  order by b.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Datos existentes: las ventas Mercado Pago anteriores a este ciclo entran al modelo nuevo
-- ---------------------------------------------------------------------------
-- Ventas declaradas Mercado Pago cuyo pago NO está confirmado ni devuelto dejan de contar como
-- cobradas (PENDING_PAYMENT) y se reconcilian: las de cobro cancelado/vencido se anulan y su stock
-- vuelve al ledger (una sola vez, porque sólo se anulan desde PENDING_PAYMENT); las que siguen
-- esperando quedan pendientes. Las CONFIRMED y REFUNDED no se tocan.
update public.sales s
set status = 'PENDING_PAYMENT'
from public.payments p
where p.sale_id = s.id
  and p.provider = 'MERCADOPAGO'
  and s.status = 'COMPLETED'
  and p.verification_status in ('PENDING', 'EXPIRED', 'CANCELLED', 'ERROR', 'MISMATCH');

do $$
declare
  pending record;
begin
  for pending in
    select s.id
    from public.sales s
    where s.status = 'PENDING_PAYMENT'
      and exists (select 1 from public.payments p where p.sale_id = s.id and p.provider = 'MERCADOPAGO')
  loop
    perform app_private.mp_reconcile_sale(pending.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke all on function
  app_private.mp_cancel_pending_sale(uuid, text),
  app_private.mp_restore_cancelled_sale(uuid),
  app_private.guard_manual_transfer()
from public, anon, authenticated;

revoke all on function
  public.mp_abandon_unpaid_sale(uuid, uuid),
  public.set_mercadopago_branch_pos(uuid, text, text, text, text, integer, boolean, boolean),
  public.get_mercadopago_branch_pos()
from public, anon;
grant execute on function
  public.mp_abandon_unpaid_sale(uuid, uuid),
  public.set_mercadopago_branch_pos(uuid, text, text, text, text, integer, boolean, boolean),
  public.get_mercadopago_branch_pos()
to authenticated;

commit;
