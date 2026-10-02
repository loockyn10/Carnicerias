-- Mercado Pago (QR) — conciliación de cobros digitales contra las ventas del POS (D-054).
--
-- Principios:
--   * NO hay un segundo modelo de pagos: `payments` sigue siendo el pago de la venta. Gana sólo
--     la verificación (`provider`, `verification_status`, `verified_at`, `verified_amount_cents`).
--     El método de pago de una venta Mercado Pago sigue siendo TRANSFER (mismo precio de lista,
--     sin recargo de tarjeta: no cambia pricing ni métodos elegibles); `provider` lo distingue.
--   * Esas columnas sólo las escribe el backend (trigger de guarda + funciones SECURITY DEFINER);
--     ningún empleado, POS ni Admin puede marcar una venta Mercado Pago como verificada a mano.
--   * Trazabilidad 1:1 sale_id <-> external_reference <-> order_id de Mercado Pago. El intento 1
--     usa el `sale_id` exacto como external_reference; un reintento (tras vencer/cancelar) usa
--     `<sale_id>-<n>`. A lo sumo UN intento activo por venta (índice único parcial) => reintentar
--     nunca crea dos órdenes vivas.
--   * Offline-first: `mercadopago_orders.sale_id` NO tiene FK a `sales`, porque la orden se crea
--     online mientras la venta puede llegar al servidor después (o antes) por el outbox. Ambos
--     caminos convergen en `app_private.mp_reconcile_sale`, idempotente.
--   * Los secretos (MERCADOPAGO_ACCESS_TOKEN / MERCADOPAGO_WEBHOOK_SECRET) viven sólo en las Edge
--     Functions; nada de esto los guarda ni los recibe.

begin;

-- ---------------------------------------------------------------------------
-- Permisos (sólo el rol admin)
-- ---------------------------------------------------------------------------
insert into public.permissions (key, description) values
  ('payments.read', 'Read Mercado Pago reconciliation and branch configuration'),
  ('payments.manage', 'Configure Mercado Pago for branches')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select '10000000-0000-4000-8000-000000000001'::uuid, permission.key
from (values ('payments.read'), ('payments.manage')) as permission(key)
on conflict (role_id, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- payments: verificación del cobro
-- ---------------------------------------------------------------------------
alter table public.payments
  add column provider text check (provider is null or provider in ('MERCADOPAGO')),
  add column verification_status text not null default 'NOT_REQUIRED'
    check (verification_status in ('NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'ERROR', 'MISMATCH', 'REFUNDED')),
  add column verified_at timestamptz,
  add column verified_amount_cents bigint check (verified_amount_cents is null or verified_amount_cents >= 0),
  add constraint payments_provider_verification_check check (
    (provider is null and verification_status = 'NOT_REQUIRED' and verified_at is null and verified_amount_cents is null)
    or (provider is not null and verification_status <> 'NOT_REQUIRED')
  );

comment on column public.payments.provider is
  'Proveedor que debe verificar el cobro (hoy sólo MERCADOPAGO). NULL = medio manual sin verificación (efectivo, transferencia declarada, tarjeta).';
comment on column public.payments.verification_status is
  'Estado de verificación contra el proveedor. Sólo lo escribe el backend (app_private.mp_reconcile_sale); NUNCA acción manual del empleado.';

create index payments_provider_status_idx
  on public.payments (organization_id, branch_id, created_at desc)
  where provider is not null;

create function app_private.guard_payment_verification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('carnicerias.payment_verifier', true), '') = 'mercadopago' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.provider is not null or new.verification_status <> 'NOT_REQUIRED'
       or new.verified_at is not null or new.verified_amount_cents is not null then
      raise exception 'Payment verification can only be written by the payment backend' using errcode = '42501';
    end if;
  elsif (new.provider, new.verification_status, new.verified_at, new.verified_amount_cents)
        is distinct from (old.provider, old.verification_status, old.verified_at, old.verified_amount_cents) then
    raise exception 'Payment verification can only be written by the payment backend' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger payments_guard_verification
before insert or update on public.payments
for each row execute function app_private.guard_payment_verification();

-- ---------------------------------------------------------------------------
-- Configuración por sucursal (Store / POS-caja de Mercado Pago). Sin secretos.
-- ---------------------------------------------------------------------------
create table public.mercadopago_branch_pos (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  -- `external_id` de la caja en Mercado Pago (config.qr.external_pos_id de cada orden).
  external_pos_id text not null check (external_pos_id ~ '^[A-Za-z0-9]{1,40}$'),
  mp_store_id text check (mp_store_id is null or char_length(mp_store_id) between 1 and 40),
  mp_pos_id text check (mp_pos_id is null or char_length(mp_pos_id) between 1 and 40),
  qr_mode text not null default 'static' check (qr_mode in ('static', 'dynamic', 'hybrid')),
  expiration_minutes integer not null default 15 check (expiration_minutes between 1 and 120),
  -- Apagado hasta que alguien lo habilite explícitamente después de crear Store/POS en MP.
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  unique (branch_id),
  unique (organization_id, external_pos_id)
);

create trigger mercadopago_branch_pos_set_updated_at before update on public.mercadopago_branch_pos
for each row execute function app_private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Intentos de cobro (una orden de MP por intento)
-- ---------------------------------------------------------------------------
create table public.mercadopago_orders (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  device_id uuid references public.pos_devices(id) on delete restrict,
  -- Sin FK a sales a propósito (ver cabecera): la venta puede sincronizarse después.
  sale_id uuid not null,
  attempt integer not null check (attempt between 1 and 20),
  external_reference text not null check (char_length(external_reference) <= 64),
  -- Se reenvía idéntica si el alta se reintenta => Mercado Pago deduplica (X-Idempotency-Key).
  idempotency_key uuid not null default extensions.gen_random_uuid(),
  external_pos_id text not null,
  expiration_minutes integer not null check (expiration_minutes between 1 and 120),
  expected_amount_cents bigint not null check (expected_amount_cents > 0),
  confirmed_amount_cents bigint check (confirmed_amount_cents is null or confirmed_amount_cents >= 0),
  status text not null default 'REQUESTING'
    check (status in ('REQUESTING', 'CREATED', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'ERROR')),
  amount_mismatch boolean not null default false,
  mp_order_id text,
  mp_payment_id text,
  mp_status text,
  mp_status_detail text,
  error_code text check (error_code is null or char_length(error_code) <= 80),
  requested_by uuid references public.profiles(id) on delete restrict,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  mp_created_at timestamptz,
  confirmed_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  last_event_at timestamptz,
  last_checked_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  unique (sale_id, attempt),
  unique (external_reference),
  unique (mp_order_id)
);

create unique index mercadopago_orders_one_active_per_sale
  on public.mercadopago_orders (sale_id) where status in ('REQUESTING', 'CREATED');
create index mercadopago_orders_branch_created_idx
  on public.mercadopago_orders (organization_id, branch_id, created_at desc);

create trigger mercadopago_orders_set_updated_at before update on public.mercadopago_orders
for each row execute function app_private.set_updated_at();

comment on table public.mercadopago_orders is
  'Un intento de cobro Mercado Pago por fila. sale_id (client UUID) = external_reference del intento 1. Sin secretos ni cuerpos crudos: sólo metadata de auditoría.';

-- ---------------------------------------------------------------------------
-- Auditoría de webhooks (metadata segura, deduplicada)
-- ---------------------------------------------------------------------------
create table public.mercadopago_webhook_events (
  id uuid primary key default extensions.gen_random_uuid(),
  dedupe_key text not null unique,
  action text,
  event_type text,
  mp_order_id text,
  request_id text,
  external_reference text,
  mp_status text,
  mp_status_detail text,
  result text not null check (char_length(result) <= 60),
  delivery_count integer not null default 1,
  received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now()
);
create index mercadopago_webhook_events_order_idx on public.mercadopago_webhook_events (mp_order_id, received_at desc);

alter table public.mercadopago_branch_pos enable row level security;
alter table public.mercadopago_orders enable row level security;
alter table public.mercadopago_webhook_events enable row level security;
-- Sin políticas para authenticated: se consulta únicamente por las RPC de abajo (security definer).
revoke all on table public.mercadopago_branch_pos, public.mercadopago_orders, public.mercadopago_webhook_events
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers internos
-- ---------------------------------------------------------------------------
create function app_private.mp_external_reference(p_sale_id uuid, p_attempt integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_attempt = 1 then p_sale_id::text else p_sale_id::text || '-' || p_attempt::text end;
$$;

create function app_private.mp_order_json(p_order public.mercadopago_orders)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'orderId', p_order.id,
    'saleId', p_order.sale_id,
    'attempt', p_order.attempt,
    'status', p_order.status,
    'externalReference', p_order.external_reference,
    'idempotencyKey', p_order.idempotency_key,
    'externalPosId', p_order.external_pos_id,
    'expirationMinutes', p_order.expiration_minutes,
    'expectedAmountCents', p_order.expected_amount_cents,
    'confirmedAmountCents', p_order.confirmed_amount_cents,
    'amountMismatch', p_order.amount_mismatch,
    'mpOrderId', p_order.mp_order_id,
    'expiresAt', p_order.expires_at,
    'createdAt', p_order.created_at,
    'confirmedAt', p_order.confirmed_at,
    'lastCheckedAt', p_order.last_checked_at,
    'needsMpCall', p_order.status = 'REQUESTING'
  );
$$;

-- Única función que traduce intentos de cobro en el estado de verificación del pago de la venta.
-- Idempotente; la llaman la alta de orden, el resultado de MP, el webhook y la llegada de la venta.
create function app_private.mp_reconcile_sale(p_sale_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  pay public.payments%rowtype;
  ord public.mercadopago_orders%rowtype;
  new_status text;
  new_verified_at timestamptz := null;
  new_amount bigint := null;
begin
  select * into pay from public.payments
  where sale_id = p_sale_id and provider = 'MERCADOPAGO'
  order by created_at limit 1;
  if not found then return; end if;

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

  if (new_status, new_verified_at, new_amount)
     is distinct from (pay.verification_status, pay.verified_at, pay.verified_amount_cents) then
    perform set_config('carnicerias.payment_verifier', 'mercadopago', true);
    update public.payments
    set verification_status = new_status, verified_at = new_verified_at, verified_amount_cents = new_amount
    where id = pay.id;
    perform set_config('carnicerias.payment_verifier', '', true);
  end if;
end;
$$;

-- La venta llegó al servidor declarada como Mercado Pago: queda PENDING hasta que el backend
-- confirme. Sólo se acepta sobre un pago TRANSFER (la forma en que el POS declara el medio).
create function app_private.mp_declare_sale_payment(p_sale_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform set_config('carnicerias.payment_verifier', 'mercadopago', true);
  update public.payments
  set provider = 'MERCADOPAGO', verification_status = 'PENDING'
  where sale_id = p_sale_id and method = 'TRANSFER' and provider is null;
  perform set_config('carnicerias.payment_verifier', '', true);
  perform app_private.mp_reconcile_sale(p_sale_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Sync de ventas: wrapper delgado sobre la función existente (sin tocar su pricing).
-- La función vigente (202609250036) pasa a app_private.sync_offline_sale_core con su cuerpo
-- intacto; la pública, con la misma firma, delega y luego aplica la declaración `payment.provider`.
-- sync_pos_operator_offline_sale llama a public.sync_offline_sale, así que ambos caminos cubiertos.
-- ---------------------------------------------------------------------------
alter function public.sync_offline_sale(uuid, uuid, jsonb) set schema app_private;
alter function app_private.sync_offline_sale(uuid, uuid, jsonb) rename to sync_offline_sale_core;
revoke all on function app_private.sync_offline_sale_core(uuid, uuid, jsonb) from public, anon, authenticated;

create function public.sync_offline_sale(p_device_id uuid, p_event_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  result := app_private.sync_offline_sale_core(p_device_id, p_event_id, p_payload);
  -- También en el reintento idempotente (`duplicate: true`): la declaración converge igual.
  if upper(coalesce(p_payload->'payment'->>'provider', '')) = 'MERCADOPAGO' then
    perform app_private.mp_declare_sale_payment((result->>'saleId')::uuid);
  end if;
  return result;
end;
$$;

revoke all on function public.sync_offline_sale(uuid, uuid, jsonb) from public, anon;
grant execute on function public.sync_offline_sale(uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC del POS (usuario técnico del dispositivo + token de operador)
-- ---------------------------------------------------------------------------

-- Reserva (idempotente) el intento de cobro de una venta. NO habla con Mercado Pago: lo hace la
-- Edge Function `mp-create-order`, que luego informa el resultado con mp_record_order_result.
create function public.mp_prepare_order(
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
  select s.organization_id, s.branch_id, s.total_cents into existing_sale
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

-- Estado del cobro de una venta (el POS NUNCA lo escribe; sólo lo lee). Prefiere el intento
-- confirmado; si no, el más reciente.
create function public.mp_get_order_status(p_device_id uuid, p_sale_id uuid)
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

  if ord.id is null then
    return case when v_verification is null then null
      else jsonb_build_object('saleId', p_sale_id, 'status', null, 'verificationStatus', v_verification) end;
  end if;
  return app_private.mp_order_json(ord) || jsonb_build_object('verificationStatus', v_verification);
end;
$$;

-- ¿Esta caja puede cobrar con Mercado Pago? (sin exponer ids; el POS sólo decide si muestra el botón)
create function public.mp_get_branch_config(p_device_id uuid)
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
  return jsonb_build_object('branchId', v_branch, 'enabled', found and cfg.enabled,
    'qrMode', case when found then cfg.qr_mode else null end);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC sólo para service_role (Edge Functions). Nunca expuestas a authenticated.
-- ---------------------------------------------------------------------------

-- Resultado del POST /v1/orders: orden creada (mp_order_id) o error definitivo (error_code).
create function public.mp_record_order_result(
  p_order_id uuid,
  p_mp_order_id text,
  p_mp_status text,
  p_mp_status_detail text,
  p_mp_payment_id text,
  p_error_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  ord public.mercadopago_orders%rowtype;
begin
  select * into ord from public.mercadopago_orders where id = p_order_id for update;
  if not found then
    raise exception 'Mercado Pago order not found' using errcode = 'P0002';
  end if;
  if p_mp_order_id is not null then
    update public.mercadopago_orders
    set mp_order_id = coalesce(mp_order_id, p_mp_order_id),
        mp_payment_id = coalesce(p_mp_payment_id, mp_payment_id),
        mp_status = p_mp_status,
        mp_status_detail = p_mp_status_detail,
        status = case when status = 'REQUESTING' then 'CREATED' else status end,
        mp_created_at = coalesce(mp_created_at, now()),
        expires_at = case when status = 'REQUESTING' then now() + make_interval(mins => expiration_minutes) else expires_at end,
        last_checked_at = now()
    where id = p_order_id
    returning * into ord;
  elsif p_error_code is not null and ord.status = 'REQUESTING' then
    update public.mercadopago_orders
    set status = 'ERROR', error_code = left(p_error_code, 80), last_checked_at = now()
    where id = p_order_id
    returning * into ord;
  end if;
  perform app_private.mp_reconcile_sale(ord.sale_id);
  return app_private.mp_order_json(ord);
end;
$$;

-- Aplica el estado REAL de una orden (siempre obtenido consultando a Mercado Pago, nunca del
-- cuerpo del webhook ni del POS). p_new_status viene ya interpretado (CREATED/CONFIRMED/EXPIRED/
-- CANCELLED/REFUNDED/ERROR; cualquier otra cosa = "UNKNOWN": sólo se anota, no cambia nada).
-- Transiciones: un estado final no retrocede; un pago acreditado tarde (EXPIRED/CANCELLED/ERROR ->
-- CONFIRMED) sí se acepta porque el dinero ingresó de verdad.
create function public.mp_apply_order_state(
  p_mp_order_id text,
  p_external_reference text,
  p_new_status text,
  p_mp_status text,
  p_mp_status_detail text,
  p_mp_payment_id text,
  p_paid_amount_cents bigint,
  p_total_amount_cents bigint,
  p_source text default 'POLL'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  ord public.mercadopago_orders%rowtype;
  effective text;
  paid bigint;
  mismatch boolean;
begin
  select * into ord from public.mercadopago_orders where mp_order_id = p_mp_order_id for update;
  if not found and p_external_reference is not null then
    -- Se perdió la respuesta del alta: se enlaza la orden de MP por nuestra referencia.
    select * into ord from public.mercadopago_orders
    where external_reference = p_external_reference and mp_order_id is null for update;
    if found then
      update public.mercadopago_orders set mp_order_id = p_mp_order_id where id = ord.id;
      ord.mp_order_id := p_mp_order_id;
    end if;
  end if;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  if p_external_reference is not null and p_external_reference <> ord.external_reference then
    return jsonb_build_object('found', true, 'ignored', 'REFERENCE_MISMATCH', 'saleId', ord.sale_id);
  end if;

  effective := ord.status;
  if p_new_status in ('CREATED', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'ERROR') then
    if ord.status in ('REQUESTING', 'CREATED') then
      effective := p_new_status;
    elsif ord.status in ('EXPIRED', 'CANCELLED', 'ERROR') and p_new_status in ('CONFIRMED', 'REFUNDED') then
      effective := p_new_status;
    elsif ord.status = 'CONFIRMED' and p_new_status = 'REFUNDED' then
      effective := 'REFUNDED';
    end if;
  end if;

  paid := ord.confirmed_amount_cents;
  mismatch := ord.amount_mismatch;
  if effective = 'CONFIRMED' and ord.status <> 'CONFIRMED' then
    paid := coalesce(p_paid_amount_cents, p_total_amount_cents);
    mismatch := paid is distinct from ord.expected_amount_cents
      or (p_total_amount_cents is not null and p_total_amount_cents <> ord.expected_amount_cents);
  end if;

  update public.mercadopago_orders
  set status = effective,
      confirmed_amount_cents = paid,
      amount_mismatch = mismatch,
      mp_status = coalesce(p_mp_status, mp_status),
      mp_status_detail = coalesce(p_mp_status_detail, mp_status_detail),
      mp_payment_id = coalesce(p_mp_payment_id, mp_payment_id),
      mp_created_at = coalesce(mp_created_at, now()),
      confirmed_at = case when effective = 'CONFIRMED' then coalesce(confirmed_at, now()) else confirmed_at end,
      expired_at = case when effective = 'EXPIRED' then coalesce(expired_at, now()) else expired_at end,
      cancelled_at = case when effective = 'CANCELLED' then coalesce(cancelled_at, now()) else cancelled_at end,
      last_checked_at = now(),
      last_event_at = case when p_source = 'WEBHOOK' then now() else last_event_at end
  where id = ord.id
  returning * into ord;

  perform app_private.mp_reconcile_sale(ord.sale_id);
  return app_private.mp_order_json(ord) || jsonb_build_object('found', true);
end;
$$;

create function public.mp_record_webhook_event(
  p_dedupe_key text,
  p_action text,
  p_event_type text,
  p_mp_order_id text,
  p_request_id text,
  p_external_reference text,
  p_mp_status text,
  p_mp_status_detail text,
  p_result text
)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.mercadopago_webhook_events as e(
    dedupe_key, action, event_type, mp_order_id, request_id, external_reference, mp_status, mp_status_detail, result
  ) values (
    left(p_dedupe_key, 300), left(p_action, 60), left(p_event_type, 60), left(p_mp_order_id, 80), left(p_request_id, 120),
    left(p_external_reference, 64), left(p_mp_status, 60), left(p_mp_status_detail, 60), left(p_result, 60)
  )
  on conflict (dedupe_key) do update
    set delivery_count = e.delivery_count + 1,
        last_received_at = now(),
        result = excluded.result,
        mp_status = coalesce(excluded.mp_status, e.mp_status),
        mp_status_detail = coalesce(excluded.mp_status_detail, e.mp_status_detail)
  returning delivery_count;
$$;

-- ---------------------------------------------------------------------------
-- RPC de administración (rol admin)
-- ---------------------------------------------------------------------------
create function public.mp_admin_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('payments.manage');
begin
  return jsonb_build_object('organizationId', v_org);
end;
$$;

create function public.set_mercadopago_branch_pos(
  p_branch_id uuid,
  p_external_pos_id text,
  p_mp_store_id text default null,
  p_mp_pos_id text default null,
  p_qr_mode text default 'static',
  p_expiration_minutes integer default 15,
  p_enabled boolean default false
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
    organization_id, branch_id, external_pos_id, mp_store_id, mp_pos_id, qr_mode, expiration_minutes, enabled
  ) values (
    v_org, p_branch_id, p_external_pos_id, nullif(btrim(p_mp_store_id), ''), nullif(btrim(p_mp_pos_id), ''),
    p_qr_mode, p_expiration_minutes, coalesce(p_enabled, false)
  )
  on conflict (branch_id) do update
    set external_pos_id = excluded.external_pos_id,
        mp_store_id = excluded.mp_store_id,
        mp_pos_id = excluded.mp_pos_id,
        qr_mode = excluded.qr_mode,
        expiration_minutes = excluded.expiration_minutes,
        enabled = excluded.enabled
  returning id into v_id;
  perform app_private.write_audit(
    v_org, p_branch_id, 'MERCADOPAGO_BRANCH_POS_SET', 'mercadopago_branch_pos', v_id, null,
    jsonb_build_object('externalPosId', p_external_pos_id, 'qrMode', p_qr_mode,
      'expirationMinutes', p_expiration_minutes, 'enabled', coalesce(p_enabled, false))
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
  enabled boolean
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
  select b.id, b.name, c.external_pos_id, c.mp_store_id, c.mp_pos_id, c.qr_mode, c.expiration_minutes, c.enabled
  from public.branches b
  left join public.mercadopago_branch_pos c on c.branch_id = b.id and c.organization_id = b.organization_id
  where b.organization_id = v_org
  order by b.name;
end;
$$;

-- Informe de conciliación (base para el cierre diario y la revisión de cámaras). Una fila por venta
-- declarada Mercado Pago más las órdenes cuya venta todavía no llegó al servidor.
--   classification: VERIFIED | PENDING | NO_ACCREDITATION | AMOUNT_MISMATCH | REFUNDED |
--                   PAID_SALE_CANCELLED | AWAITING_SALE_SYNC | PAYMENT_WITHOUT_SALE | ORDER_WITHOUT_SALE
create function public.get_mercadopago_reconciliation(
  p_from timestamptz,
  p_to timestamptz,
  p_branch_id uuid default null,
  p_only_issues boolean default false
)
returns table (
  occurred_at timestamptz,
  branch_id uuid,
  branch_name text,
  sale_id uuid,
  sale_status text,
  sale_total_cents bigint,
  verification_status text,
  expected_amount_cents bigint,
  confirmed_amount_cents bigint,
  order_status text,
  mp_order_id text,
  mp_payment_id text,
  attempts integer,
  order_created_at timestamptz,
  confirmed_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  classification text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app_private.require_permission('payments.read');
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Invalid reconciliation period' using errcode = '22023';
  end if;
  return query
  with best as (
    select distinct on (o.sale_id) o.*
    from public.mercadopago_orders o
    where o.organization_id = v_org
    order by o.sale_id, (o.status = 'CONFIRMED') desc, o.attempt desc
  ),
  attempt_counts as (
    select o.sale_id, count(*)::integer as n from public.mercadopago_orders o where o.organization_id = v_org group by o.sale_id
  ),
  rows_with_sale as (
    select s.completed_at as occurred_at, s.branch_id, s.id as sale_id, s.status::text as sale_status,
           s.total_cents as sale_total_cents, pay.verification_status, pay.amount_cents,
           b.id as best_id
    from public.sales s
    join public.payments pay on pay.sale_id = s.id and pay.provider = 'MERCADOPAGO'
    left join best b on b.sale_id = s.id
    where s.organization_id = v_org
      and s.completed_at >= p_from and s.completed_at < p_to
      and (p_branch_id is null or s.branch_id = p_branch_id)
  ),
  rows_without_sale as (
    select b.created_at as occurred_at, b.branch_id, b.sale_id, null::text as sale_status,
           null::bigint as sale_total_cents, null::text as verification_status, null::bigint as amount_cents,
           b.id as best_id
    from best b
    where b.created_at >= p_from and b.created_at < p_to
      and (p_branch_id is null or b.branch_id = p_branch_id)
      and not exists (select 1 from public.sales s where s.id = b.sale_id)
  ),
  all_rows as (
    select * from rows_with_sale union all select * from rows_without_sale
  ),
  detailed as (
    select r.occurred_at, r.branch_id, br.name as branch_name, r.sale_id, r.sale_status, r.sale_total_cents,
           r.verification_status, coalesce(b.expected_amount_cents, r.amount_cents) as expected_amount_cents,
           b.confirmed_amount_cents, b.status as order_status, b.mp_order_id, b.mp_payment_id,
           coalesce(ac.n, 0) as attempts, b.created_at as order_created_at, b.confirmed_at, b.expired_at, b.cancelled_at,
           case
             when r.sale_status is null then
               case
                 when b.created_at > now() - interval '30 minutes' then 'AWAITING_SALE_SYNC'
                 when b.status = 'CONFIRMED' then 'PAYMENT_WITHOUT_SALE'
                 else 'ORDER_WITHOUT_SALE'
               end
             when r.verification_status = 'CONFIRMED' then
               case when r.sale_status <> 'COMPLETED' then 'PAID_SALE_CANCELLED' else 'VERIFIED' end
             when r.verification_status = 'MISMATCH' then 'AMOUNT_MISMATCH'
             when r.verification_status = 'REFUNDED' then 'REFUNDED'
             when r.verification_status = 'PENDING' and r.occurred_at > now() - interval '20 minutes' then 'PENDING'
             else 'NO_ACCREDITATION'
           end as classification
    from all_rows r
    join public.branches br on br.id = r.branch_id
    left join best b on b.id = r.best_id
    left join attempt_counts ac on ac.sale_id = r.sale_id
  )
  select d.occurred_at, d.branch_id, d.branch_name, d.sale_id, d.sale_status, d.sale_total_cents,
         d.verification_status, d.expected_amount_cents, d.confirmed_amount_cents, d.order_status, d.mp_order_id,
         d.mp_payment_id, d.attempts, d.order_created_at, d.confirmed_at, d.expired_at, d.cancelled_at, d.classification
  from detailed d
  where not coalesce(p_only_issues, false) or d.classification <> 'VERIFIED'
  order by d.occurred_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke all on function
  app_private.guard_payment_verification(),
  app_private.mp_external_reference(uuid, integer),
  app_private.mp_order_json(public.mercadopago_orders),
  app_private.mp_reconcile_sale(uuid),
  app_private.mp_declare_sale_payment(uuid)
from public, anon, authenticated;

revoke all on function
  public.mp_prepare_order(uuid, uuid, bigint, uuid, text, boolean),
  public.mp_get_order_status(uuid, uuid),
  public.mp_get_branch_config(uuid),
  public.mp_admin_context(),
  public.set_mercadopago_branch_pos(uuid, text, text, text, text, integer, boolean),
  public.get_mercadopago_branch_pos(),
  public.get_mercadopago_reconciliation(timestamptz, timestamptz, uuid, boolean)
from public, anon;
grant execute on function
  public.mp_prepare_order(uuid, uuid, bigint, uuid, text, boolean),
  public.mp_get_order_status(uuid, uuid),
  public.mp_get_branch_config(uuid),
  public.mp_admin_context(),
  public.set_mercadopago_branch_pos(uuid, text, text, text, text, integer, boolean),
  public.get_mercadopago_branch_pos(),
  public.get_mercadopago_reconciliation(timestamptz, timestamptz, uuid, boolean)
to authenticated;

-- Sólo el backend (service_role, desde Edge Functions) puede informar resultados de Mercado Pago.
revoke all on function
  public.mp_record_order_result(uuid, text, text, text, text, text),
  public.mp_apply_order_state(text, text, text, text, text, text, bigint, bigint, text),
  public.mp_record_webhook_event(text, text, text, text, text, text, text, text, text)
from public, anon, authenticated;
grant execute on function
  public.mp_record_order_result(uuid, text, text, text, text, text),
  public.mp_apply_order_state(text, text, text, text, text, text, bigint, bigint, text),
  public.mp_record_webhook_event(text, text, text, text, text, text, text, text, text)
to service_role;

commit;
