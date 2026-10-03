begin;

-- Ticket por WhatsApp iniciado por el CLIENTE (D-060). El POS muestra un QR que abre WhatsApp con el
-- mensaje `TICKET <token>`; cuando ese mensaje llega al webhook, el backend resuelve la venta por el
-- token y responde con el ticket. Se reutiliza `ticket_deliveries` / `ticket_delivery_events` de la 056.
--
--   * `whatsapp_ticket_claims`  un token por solicitud del POS, asociado a UNA venta. Sólo se guarda el
--                               HASH SHA-256 (el token en claro se devuelve una sola vez al POS).
--                               Vence a las 24 h. Se "canjea" por el primer teléfono que lo envía: ese
--                               teléfono puede repetirlo (reenvío idempotente, con tope); otro teléfono
--                               recibe "ya fue utilizado" sin datos de la venta.
--   * `wa_create_claim`         POS (dispositivo + operador): sólo venta COMPLETED (y pago CONFIRMED).
--   * `wa_redeem_claim`         sólo service_role (webhook): dedupe por message.id, valida token, vencimiento,
--                               estado de la venta, y devuelve los datos del ticket o el motivo del rechazo.

create table public.whatsapp_ticket_claims (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  sale_id uuid not null,
  -- SHA-256 (hex) del token normalizado en mayúsculas. El token en claro nunca se guarda.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  -- Remitente tal como lo informa Meta (sólo dígitos). Sin acceso desde clientes.
  redeemed_phone text check (redeemed_phone is null or redeemed_phone ~ '^[0-9]{8,15}$'),
  redeemed_message_id text check (redeemed_message_id is null or char_length(redeemed_message_id) <= 200),
  device_id uuid references public.pos_devices(id) on delete restrict,
  created_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (sale_id, organization_id, branch_id)
    references public.sales(id, organization_id, branch_id) on delete restrict,
  check ((redeemed_at is null) = (redeemed_phone is null))
);

comment on table public.whatsapp_ticket_claims is
  'Tokens de un solo uso lógico (por teléfono) para que el CLIENTE pida su ticket por WhatsApp. Sólo hash; sin sale_id en el token.';

create index whatsapp_ticket_claims_sale_idx on public.whatsapp_ticket_claims (sale_id, created_at desc);

alter table public.whatsapp_ticket_claims enable row level security;
-- Sin policies ni grants para anon/authenticated: sólo las RPC SECURITY DEFINER y service_role la tocan.
revoke all on table public.whatsapp_ticket_claims from anon, authenticated;
grant select, insert, update on public.whatsapp_ticket_claims to service_role;

alter table public.ticket_deliveries
  add column claim_id uuid references public.whatsapp_ticket_claims(id) on delete restrict;
create index ticket_deliveries_claim_idx on public.ticket_deliveries (claim_id) where claim_id is not null;
-- Ya no hay un operador/dispositivo detrás de cada entrega: las iniciadas por el cliente sólo tienen claim.
-- (device_id/requested_by ya eran nullable en la 056.)

-- ---------------------------------------------------------------------------
-- Helpers privados (compartidos por wa_prepare_ticket, wa_create_claim y wa_redeem_claim)
-- ---------------------------------------------------------------------------

-- ¿La venta admite comprobante? null = sí; si no, el motivo. Misma regla que la 056.
create function app_private.wa_sale_blocker(p_sale_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status public.sale_status;
begin
  select s.status into v_status from public.sales s where s.id = p_sale_id;
  if not found then return jsonb_build_object('code', 'SALE_NOT_FOUND'); end if;
  if v_status <> 'COMPLETED' then
    return jsonb_build_object('code', 'SALE_NOT_COMPLETED', 'saleStatus', v_status);
  end if;
  if exists (
    select 1 from public.payments p
    where p.sale_id = p_sale_id and p.provider is not null and p.verification_status <> 'CONFIRMED'
  ) then
    return jsonb_build_object('code', 'PAYMENT_NOT_CONFIRMED');
  end if;
  return null;
end;
$$;

-- Hechos del ticket (nunca costo, proveedor, margen, stock ni datos del empleado).
create function app_private.wa_sale_ticket_json(p_sale_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'saleId', s.id,
    'status', s.status,
    'completedAt', s.completed_at,
    'totalCents', s.total_cents,
    'organizationName', o.name,
    'branchName', b.name,
    'timezone', o.timezone,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', i.product_name_snapshot,
        'weightGrams', i.weight_grams,
        'quantityUnits', i.quantity_units,
        'unitPriceCents', i.original_price_per_kg_cents,
        'promotionDiscountCents', i.promotion_discount_cents,
        'cardSurchargeCents', i.card_surcharge_cents,
        'subtotalCents', i.subtotal_cents,
        'promotionMode', i.promotion_mode
      ) order by i.created_at, i.id)
      from public.sale_items i where i.sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', p.method, 'provider', p.provider,
        'verificationStatus', p.verification_status, 'amountCents', p.amount_cents
      ) order by p.created_at, p.id)
      from public.payments p where p.sale_id = s.id
    ), '[]'::jsonb)
  )
  from public.sales s
  join public.organizations o on o.id = s.organization_id
  join public.branches b on b.id = s.branch_id
  where s.id = p_sale_id
$$;

-- ---------------------------------------------------------------------------
-- wa_prepare_ticket (envío iniciado por el negocio, fallback): mismo contrato que la 056, ahora sobre los helpers.
-- ---------------------------------------------------------------------------
create or replace function public.wa_prepare_ticket(
  p_device_id uuid,
  p_sale_id uuid,
  p_operator_profile_id uuid,
  p_operator_token text,
  p_phone text,
  p_resend boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  access record;
  v_sale public.sales%rowtype;
  v_blocker jsonb;
  v_sent record;
  v_delivery_id uuid;
begin
  if p_sale_id is null or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Invalid ticket request' using errcode = '22023';
  end if;
  select * into access
  from app_private.resolve_pos_operator(p_device_id, p_operator_profile_id, p_operator_token, now());

  perform pg_advisory_xact_lock(hashtextextended('wa-ticket:' || p_sale_id::text, 0));

  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'SALE_NOT_FOUND');
  end if;
  if v_sale.organization_id <> access.organization_id or v_sale.branch_id <> access.branch_id then
    raise exception 'Sale is not available for this device' using errcode = '42501';
  end if;

  v_blocker := app_private.wa_sale_blocker(v_sale.id);
  if v_blocker is not null then return jsonb_build_object('ok', false) || v_blocker; end if;

  select td.status, td.sent_at, td.recipient_phone_masked into v_sent
  from public.ticket_deliveries td
  where td.sale_id = v_sale.id and td.channel = 'WHATSAPP' and td.status in ('SENT', 'DELIVERED', 'READ')
  order by td.created_at desc limit 1;
  if found and not coalesce(p_resend, false) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_SENT', 'status', v_sent.status,
      'sentAt', v_sent.sent_at, 'phoneMasked', v_sent.recipient_phone_masked);
  end if;

  if exists (
    select 1 from public.ticket_deliveries td
    where td.sale_id = v_sale.id and td.channel = 'WHATSAPP' and td.status = 'PENDING'
      and td.recipient_phone = p_phone and td.created_at > now() - interval '60 seconds'
  ) then
    return jsonb_build_object('ok', false, 'code', 'IN_PROGRESS');
  end if;

  insert into public.ticket_deliveries(organization_id, branch_id, sale_id, recipient_phone, device_id, requested_by)
  values (v_sale.organization_id, v_sale.branch_id, v_sale.id, p_phone, p_device_id, access.operator_profile_id)
  returning id into v_delivery_id;

  return jsonb_build_object('ok', true, 'deliveryId', v_delivery_id, 'sale', app_private.wa_sale_ticket_json(v_sale.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- POS: pide un claim para una venta. El token en claro se devuelve UNA vez; sólo queda su hash.
-- Cada apertura del QR genera un token nuevo; los anteriores siguen válidos hasta vencer o canjearse
-- (no se invalidan, para no romper un QR que el cliente ya está escaneando). Tope: 20 por venta / 24 h.
-- Códigos (ok = false): SALE_NOT_FOUND, SALE_NOT_COMPLETED, PAYMENT_NOT_CONFIRMED, TOO_MANY_CLAIMS.
-- ---------------------------------------------------------------------------
create function public.wa_create_claim(
  p_device_id uuid,
  p_sale_id uuid,
  p_operator_profile_id uuid,
  p_operator_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  access record;
  v_sale public.sales%rowtype;
  v_blocker jsonb;
  v_token text;
  v_expires timestamptz := now() + interval '24 hours';
begin
  if p_sale_id is null then
    raise exception 'Invalid ticket request' using errcode = '22023';
  end if;
  select * into access
  from app_private.resolve_pos_operator(p_device_id, p_operator_profile_id, p_operator_token, now());

  perform pg_advisory_xact_lock(hashtextextended('wa-claim:' || p_sale_id::text, 0));

  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'SALE_NOT_FOUND');
  end if;
  if v_sale.organization_id <> access.organization_id or v_sale.branch_id <> access.branch_id then
    raise exception 'Sale is not available for this device' using errcode = '42501';
  end if;

  v_blocker := app_private.wa_sale_blocker(v_sale.id);
  if v_blocker is not null then return jsonb_build_object('ok', false) || v_blocker; end if;

  if (select count(*) from public.whatsapp_ticket_claims c
      where c.sale_id = v_sale.id and c.created_at > now() - interval '24 hours') >= 20 then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_CLAIMS');
  end if;

  -- 128 bits de un CSPRNG, en hex mayúsculas (32 caracteres). No deriva del sale_id ni es secuencial.
  v_token := upper(encode(extensions.gen_random_bytes(16), 'hex'));
  insert into public.whatsapp_ticket_claims(organization_id, branch_id, sale_id, token_hash, expires_at, device_id, created_by)
  values (v_sale.organization_id, v_sale.branch_id, v_sale.id,
          encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'),
          v_expires, p_device_id, access.operator_profile_id);

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'expiresAt', v_expires,
    'previouslyDelivered', exists (
      select 1 from public.ticket_deliveries td
      where td.sale_id = v_sale.id and td.channel = 'WHATSAPP' and td.status in ('SENT', 'DELIVERED', 'READ')
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Backend (webhook): mensaje entrante `TICKET <token>`.
--   action NONE   -> nada que hacer (mensaje ya procesado: Meta reenvía eventos).
--   action REPLY  -> responder un texto corto de `kind` (INVALID | EXPIRED | USED | ALREADY_SENT | NOT_AVAILABLE)
--                    sin datos de la venta.
--   action SEND   -> `deliveryId` (PENDING) + datos del ticket, para responder con el comprobante.
-- Idempotente por `message.id` (misma tabla de eventos que los estados). El teléfono sale SIEMPRE del
-- remitente del mensaje de Meta (`p_from`, sólo dígitos); jamás de un parámetro del POS ni del texto.
-- Mismo teléfono + mismo claim = reenvío permitido hasta 3 entregas; otro teléfono = USED.
-- ---------------------------------------------------------------------------
create function public.wa_redeem_claim(
  p_token text,
  p_message_id text,
  p_from text,
  p_received_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_token text := upper(btrim(coalesce(p_token, '')));
  v_claim public.whatsapp_ticket_claims%rowtype;
  v_blocker jsonb;
  v_delivery_id uuid;
begin
  if p_message_id is null or btrim(p_message_id) = '' or char_length(p_message_id) > 200 then
    raise exception 'Invalid inbound message' using errcode = '22023';
  end if;

  insert into public.ticket_delivery_events(dedupe_key, provider_message_id, event_status, event_at, result)
  values ('in|' || p_message_id, p_message_id, 'INBOUND', p_received_at, 'PENDING')
  on conflict (dedupe_key) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    update public.ticket_delivery_events
    set delivery_count = delivery_count + 1, last_received_at = now()
    where dedupe_key = 'in|' || p_message_id;
    return jsonb_build_object('action', 'NONE', 'result', 'DUPLICATE');
  end if;

  if p_from is null or p_from !~ '^[0-9]{8,15}$' then
    update public.ticket_delivery_events set result = 'BAD_SENDER' where id = v_event_id;
    return jsonb_build_object('action', 'NONE', 'result', 'BAD_SENDER');
  end if;

  if v_token !~ '^[0-9A-F]{32}$' then
    update public.ticket_delivery_events set result = 'INVALID_TOKEN' where id = v_event_id;
    return jsonb_build_object('action', 'REPLY', 'kind', 'INVALID', 'result', 'INVALID_TOKEN');
  end if;

  select * into v_claim from public.whatsapp_ticket_claims
  where token_hash = encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex')
  for update;
  if not found then
    update public.ticket_delivery_events set result = 'INVALID_TOKEN' where id = v_event_id;
    return jsonb_build_object('action', 'REPLY', 'kind', 'INVALID', 'result', 'INVALID_TOKEN');
  end if;

  if v_claim.expires_at <= now() then
    update public.ticket_delivery_events set result = 'EXPIRED' where id = v_event_id;
    return jsonb_build_object('action', 'REPLY', 'kind', 'EXPIRED', 'result', 'EXPIRED');
  end if;

  if v_claim.redeemed_phone is not null and v_claim.redeemed_phone <> p_from then
    update public.ticket_delivery_events set result = 'USED_BY_OTHER' where id = v_event_id;
    return jsonb_build_object('action', 'REPLY', 'kind', 'USED', 'result', 'USED_BY_OTHER');
  end if;

  v_blocker := app_private.wa_sale_blocker(v_claim.sale_id);
  if v_blocker is not null then
    update public.ticket_delivery_events set result = 'SALE_NOT_AVAILABLE' where id = v_event_id;
    return jsonb_build_object('action', 'REPLY', 'kind', 'NOT_AVAILABLE', 'result', 'SALE_NOT_AVAILABLE');
  end if;

  if (select count(*) from public.ticket_deliveries td where td.claim_id = v_claim.id) >= 3 then
    update public.ticket_delivery_events set result = 'RESEND_LIMIT' where id = v_event_id;
    return jsonb_build_object('action', 'REPLY', 'kind', 'ALREADY_SENT', 'result', 'RESEND_LIMIT');
  end if;

  update public.whatsapp_ticket_claims
  set redeemed_at = coalesce(redeemed_at, now()), redeemed_phone = p_from,
      redeemed_message_id = coalesce(redeemed_message_id, p_message_id)
  where id = v_claim.id;

  insert into public.ticket_deliveries(organization_id, branch_id, sale_id, recipient_phone, claim_id)
  values (v_claim.organization_id, v_claim.branch_id, v_claim.sale_id, '+' || p_from, v_claim.id)
  returning id into v_delivery_id;

  update public.ticket_delivery_events set delivery_id = v_delivery_id, result = 'CLAIM_ACCEPTED' where id = v_event_id;
  return jsonb_build_object('action', 'SEND', 'result', 'CLAIM_ACCEPTED', 'deliveryId', v_delivery_id,
    'sale', app_private.wa_sale_ticket_json(v_claim.sale_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke all on function
  app_private.wa_sale_blocker(uuid),
  app_private.wa_sale_ticket_json(uuid)
from public, anon, authenticated;

revoke all on function public.wa_create_claim(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.wa_create_claim(uuid, uuid, uuid, text) to authenticated;

revoke all on function public.wa_redeem_claim(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.wa_redeem_claim(text, text, text, timestamptz) to service_role;

commit;
