begin;

-- Ticket digital por WhatsApp (D-059). Esta migración sólo guarda la AUDITORÍA de los envíos y expone
-- las RPC que usan las Edge Functions `whatsapp-send-ticket` / `whatsapp-webhook`. NO hay credenciales
-- de Meta en Postgres (access token, app secret y número viven en los secrets de Edge Functions) y NO se
-- crea ni se actualiza ningún cliente: el teléfono sólo es el destino de ese comprobante.
--
--   * `ticket_deliveries`       un intento de envío por fila (reintentar = otra fila). Canal WHATSAPP.
--   * `ticket_delivery_events`  eventos del webhook, deduplicados (idempotencia) y reaplicables si
--                               llegaron antes de que el envío registrara su `provider_message_id`.
--   * `wa_prepare_ticket`       POS (JWT de dispositivo + token de operador): valida la venta REAL del
--                               servidor, bloquea ventas no cobradas y devuelve los datos del ticket.
--   * `wa_record_send_result` / `wa_apply_status_event`   sólo service_role (Edge Functions).

create table public.ticket_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid not null,
  sale_id uuid not null,
  channel text not null default 'WHATSAPP' check (channel in ('WHATSAPP')),
  -- E.164 con "+" (ej. +5493496123456). Sólo lo lee el backend: ver grants de columnas más abajo.
  recipient_phone text not null check (recipient_phone ~ '^\+[1-9][0-9]{7,14}$'),
  recipient_phone_masked text generated always as (
    left(recipient_phone, 3) || repeat('*', greatest(char_length(recipient_phone) - 7, 0)) || right(recipient_phone, 4)
  ) stored,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) between 1 and 200),
  provider_error_code text check (provider_error_code is null or char_length(provider_error_code) <= 80),
  provider_error_message text check (provider_error_message is null or char_length(provider_error_message) <= 500),
  template_name text check (template_name is null or char_length(template_name) <= 120),
  device_id uuid references public.pos_devices(id) on delete restrict,
  requested_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (sale_id, organization_id, branch_id)
    references public.sales(id, organization_id, branch_id) on delete restrict
);

comment on table public.ticket_deliveries is
  'Auditoría de comprobantes enviados por canal externo (hoy WhatsApp Cloud API). Un intento por fila; no es una ficha de cliente.';
comment on column public.ticket_deliveries.recipient_phone is
  'Teléfono destino (E.164). Sin SELECT para authenticated: se muestra enmascarado (recipient_phone_masked).';

create unique index ticket_deliveries_provider_message_uidx
  on public.ticket_deliveries (provider_message_id) where provider_message_id is not null;
create index ticket_deliveries_sale_idx on public.ticket_deliveries (sale_id, created_at desc);
create index ticket_deliveries_org_created_idx on public.ticket_deliveries (organization_id, created_at desc);

create trigger ticket_deliveries_set_updated_at before update on public.ticket_deliveries
for each row execute function app_private.set_updated_at();

create table public.ticket_delivery_events (
  id uuid primary key default extensions.gen_random_uuid(),
  dedupe_key text not null unique check (char_length(dedupe_key) <= 300),
  delivery_id uuid references public.ticket_deliveries(id) on delete cascade,
  provider_message_id text not null check (char_length(provider_message_id) between 1 and 200),
  event_status text not null check (char_length(event_status) <= 40),
  event_at timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 80),
  error_message text check (error_message is null or char_length(error_message) <= 500),
  result text not null check (char_length(result) <= 40),
  delivery_count integer not null default 1,
  received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now()
);
create index ticket_delivery_events_message_idx on public.ticket_delivery_events (provider_message_id);

alter table public.ticket_deliveries enable row level security;
alter table public.ticket_delivery_events enable row level security;

-- Lectura (Admin): misma regla que las ventas, pero SIN el teléfono completo, el id del proveedor ni el
-- dispositivo/operador. Escritura sólo por las RPC SECURITY DEFINER.
create policy ticket_deliveries_select on public.ticket_deliveries
for select to authenticated
using (app_private.can_access_branch(organization_id, branch_id, 'sales.read'));

revoke all on table public.ticket_deliveries, public.ticket_delivery_events from anon, authenticated;
grant select (
  id, organization_id, branch_id, sale_id, channel, recipient_phone_masked, status,
  provider_error_code, provider_error_message, created_at, sent_at, delivered_at, read_at, failed_at
) on public.ticket_deliveries to authenticated;
grant select, insert, update on public.ticket_deliveries, public.ticket_delivery_events to service_role;

-- ---------------------------------------------------------------------------
-- Transición de estado (única): monótona. SENT < DELIVERED < READ; FAILED sólo desde PENDING/SENT.
-- Un evento viejo o repetido NUNCA retrocede un estado ni resucita un FAILED.
-- ---------------------------------------------------------------------------
create function app_private.wa_status_rank(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status when 'PENDING' then 0 when 'SENT' then 1 when 'DELIVERED' then 2 when 'READ' then 3 else null end
$$;

create function app_private.wa_apply_event(
  p_delivery_id uuid,
  p_new_status text,
  p_event_at timestamptz,
  p_error_code text,
  p_error_message text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.ticket_deliveries%rowtype;
  at_time timestamptz := coalesce(p_event_at, now());
begin
  select * into d from public.ticket_deliveries where id = p_delivery_id for update;
  if not found then return 'UNKNOWN_MESSAGE'; end if;

  if p_new_status = 'FAILED' then
    if d.status in ('PENDING', 'SENT') then
      update public.ticket_deliveries
      set status = 'FAILED', failed_at = at_time,
          provider_error_code = left(p_error_code, 80), provider_error_message = left(p_error_message, 500)
      where id = d.id;
      return 'APPLIED';
    end if;
    -- Ya entregado/leído (o ya fallido): un "failed" tardío no deshace nada.
    return case when d.status = 'FAILED' then 'NO_CHANGE' else 'IGNORED_OUT_OF_ORDER' end;
  end if;

  if d.status = 'FAILED' then return 'IGNORED_OUT_OF_ORDER'; end if;

  if app_private.wa_status_rank(p_new_status) > app_private.wa_status_rank(d.status) then
    update public.ticket_deliveries
    set status = p_new_status,
        sent_at = case when p_new_status = 'SENT' then coalesce(sent_at, at_time) else sent_at end,
        delivered_at = case when p_new_status = 'DELIVERED' then coalesce(delivered_at, at_time) else delivered_at end,
        read_at = case when p_new_status = 'READ' then coalesce(read_at, at_time) else read_at end
    where id = d.id;
    return 'APPLIED';
  end if;

  -- Evento de un estado ya superado: sólo completa su marca de tiempo si faltaba; el estado no cambia.
  update public.ticket_deliveries
  set sent_at = case when p_new_status = 'SENT' then coalesce(sent_at, at_time) else sent_at end,
      delivered_at = case when p_new_status = 'DELIVERED' then coalesce(delivered_at, at_time) else delivered_at end,
      read_at = case when p_new_status = 'READ' then coalesce(read_at, at_time) else read_at end
  where id = d.id;
  return case when app_private.wa_status_rank(p_new_status) = app_private.wa_status_rank(d.status) then 'NO_CHANGE' else 'IGNORED_OUT_OF_ORDER' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- POS: prepara un envío. Valida dispositivo + operador (mismo mecanismo que mp_prepare_order), toma la
-- venta REAL del servidor y devuelve sólo los hechos del ticket (jamás costo, proveedor, margen ni stock).
-- Códigos de dominio (ok = false): SALE_NOT_FOUND, SALE_NOT_COMPLETED, PAYMENT_NOT_CONFIRMED,
-- ALREADY_SENT, IN_PROGRESS. Errores de autorización: 42501 (también venta de otra sucursal/organización).
-- ---------------------------------------------------------------------------
create function public.wa_prepare_ticket(
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
  v_org record;
  v_branch_name text;
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
    -- La venta del POS todavía no llegó al servidor (sync pendiente) o el id no existe.
    return jsonb_build_object('ok', false, 'code', 'SALE_NOT_FOUND');
  end if;
  if v_sale.organization_id <> access.organization_id or v_sale.branch_id <> access.branch_id then
    raise exception 'Sale is not available for this device' using errcode = '42501';
  end if;

  if v_sale.status <> 'COMPLETED' then
    return jsonb_build_object('ok', false, 'code', 'SALE_NOT_COMPLETED', 'saleStatus', v_sale.status);
  end if;
  if exists (
    select 1 from public.payments p
    where p.sale_id = v_sale.id and p.provider is not null and p.verification_status <> 'CONFIRMED'
  ) then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_NOT_CONFIRMED');
  end if;

  select td.status, td.sent_at, td.recipient_phone_masked into v_sent
  from public.ticket_deliveries td
  where td.sale_id = v_sale.id and td.channel = 'WHATSAPP' and td.status in ('SENT', 'DELIVERED', 'READ')
  order by td.created_at desc limit 1;
  if found and not coalesce(p_resend, false) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_SENT', 'status', v_sent.status,
      'sentAt', v_sent.sent_at, 'phoneMasked', v_sent.recipient_phone_masked);
  end if;

  -- Doble toque: un envío al mismo número iniciado hace menos de 60 s todavía en curso no se duplica.
  if exists (
    select 1 from public.ticket_deliveries td
    where td.sale_id = v_sale.id and td.channel = 'WHATSAPP' and td.status = 'PENDING'
      and td.recipient_phone = p_phone and td.created_at > now() - interval '60 seconds'
  ) then
    return jsonb_build_object('ok', false, 'code', 'IN_PROGRESS');
  end if;

  select o.name, o.timezone into v_org from public.organizations o where o.id = v_sale.organization_id;
  select b.name into v_branch_name from public.branches b where b.id = v_sale.branch_id;

  insert into public.ticket_deliveries(organization_id, branch_id, sale_id, recipient_phone, device_id, requested_by)
  values (v_sale.organization_id, v_sale.branch_id, v_sale.id, p_phone, p_device_id, access.operator_profile_id)
  returning id into v_delivery_id;

  return jsonb_build_object(
    'ok', true,
    'deliveryId', v_delivery_id,
    'sale', jsonb_build_object(
      'saleId', v_sale.id,
      'status', v_sale.status,
      'completedAt', v_sale.completed_at,
      'totalCents', v_sale.total_cents,
      'organizationName', v_org.name,
      'branchName', v_branch_name,
      'timezone', v_org.timezone,
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
        from public.sale_items i where i.sale_id = v_sale.id
      ), '[]'::jsonb),
      'payments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'method', p.method, 'provider', p.provider,
          'verificationStatus', p.verification_status, 'amountCents', p.amount_cents
        ) order by p.created_at, p.id)
        from public.payments p where p.sale_id = v_sale.id
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Backend: resultado del POST a WhatsApp (message id => SENT; error definitivo => FAILED) y reaplicación
-- de eventos del webhook que llegaron antes de que el id quedara registrado.
-- ---------------------------------------------------------------------------
create function public.wa_record_send_result(
  p_delivery_id uuid,
  p_provider_message_id text,
  p_error_code text,
  p_error_message text,
  p_template_name text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.ticket_deliveries%rowtype;
  ev record;
  v_status text;
begin
  select * into d from public.ticket_deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'Unknown ticket delivery' using errcode = 'P0002';
  end if;

  if d.status = 'PENDING' then
    if p_provider_message_id is not null then
      update public.ticket_deliveries
      set status = 'SENT', sent_at = now(), provider_message_id = p_provider_message_id,
          template_name = coalesce(p_template_name, template_name)
      where id = d.id;
    else
      update public.ticket_deliveries
      set status = 'FAILED', failed_at = now(), provider_error_code = left(p_error_code, 80),
          provider_error_message = left(p_error_message, 500), template_name = coalesce(p_template_name, template_name)
      where id = d.id;
    end if;

    -- Eventos que Meta mandó antes de que este registro existiera (carrera): se aplican ahora, en orden.
    if p_provider_message_id is not null then
      for ev in
        select e.id, e.event_status, e.event_at, e.error_code, e.error_message
        from public.ticket_delivery_events e
        where e.provider_message_id = p_provider_message_id and e.delivery_id is null
        order by coalesce(e.event_at, e.received_at), e.received_at
      loop
        perform app_private.wa_apply_event(d.id, ev.event_status, ev.event_at, ev.error_code, ev.error_message);
        update public.ticket_delivery_events set delivery_id = d.id, result = 'APPLIED_LATE' where id = ev.id;
      end loop;
    end if;
  end if;

  select status into v_status from public.ticket_deliveries where id = d.id;
  return jsonb_build_object('deliveryId', d.id, 'status', v_status);
end;
$$;

-- Evento de estado del webhook. Idempotente por `p_dedupe_key` (message id + estado + timestamp).
-- p_status ya viene normalizado por la Edge Function: SENT | DELIVERED | READ | FAILED; otro valor se ignora.
create function public.wa_apply_status_event(
  p_provider_message_id text,
  p_status text,
  p_event_at timestamptz,
  p_error_code text,
  p_error_message text,
  p_dedupe_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery_id uuid;
  v_result text;
  v_event_id uuid;
begin
  if p_provider_message_id is null or p_dedupe_key is null then
    raise exception 'Invalid webhook event' using errcode = '22023';
  end if;

  insert into public.ticket_delivery_events(dedupe_key, provider_message_id, event_status, event_at, error_code, error_message, result)
  values (p_dedupe_key, p_provider_message_id, left(coalesce(p_status, 'UNKNOWN'), 40), p_event_at,
          left(p_error_code, 80), left(p_error_message, 500), 'PENDING')
  on conflict (dedupe_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    update public.ticket_delivery_events
    set delivery_count = delivery_count + 1, last_received_at = now()
    where dedupe_key = p_dedupe_key;
    return jsonb_build_object('result', 'DUPLICATE');
  end if;

  if p_status is null or p_status not in ('SENT', 'DELIVERED', 'READ', 'FAILED') then
    update public.ticket_delivery_events set result = 'IGNORED_STATUS' where id = v_event_id;
    return jsonb_build_object('result', 'IGNORED_STATUS');
  end if;

  select id into v_delivery_id from public.ticket_deliveries where provider_message_id = p_provider_message_id;
  if v_delivery_id is null then
    -- Todavía no registrado (carrera con el envío) o mensaje ajeno: queda guardado para reaplicarse.
    update public.ticket_delivery_events set result = 'UNKNOWN_MESSAGE' where id = v_event_id;
    return jsonb_build_object('result', 'UNKNOWN_MESSAGE');
  end if;

  v_result := app_private.wa_apply_event(v_delivery_id, p_status, p_event_at, p_error_code, p_error_message);
  update public.ticket_delivery_events set delivery_id = v_delivery_id, result = v_result where id = v_event_id;
  return jsonb_build_object('result', v_result, 'deliveryId', v_delivery_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke all on function
  app_private.wa_status_rank(text),
  app_private.wa_apply_event(uuid, text, timestamptz, text, text)
from public, anon, authenticated;

revoke all on function public.wa_prepare_ticket(uuid, uuid, uuid, text, text, boolean) from public, anon;
grant execute on function public.wa_prepare_ticket(uuid, uuid, uuid, text, text, boolean) to authenticated;

-- Sólo el backend (service_role, desde Edge Functions) registra resultados de WhatsApp.
revoke all on function
  public.wa_record_send_result(uuid, text, text, text, text),
  public.wa_apply_status_event(text, text, timestamptz, text, text, text)
from public, anon, authenticated;
grant execute on function
  public.wa_record_send_result(uuid, text, text, text, text),
  public.wa_apply_status_event(text, text, timestamptz, text, text, text)
to service_role;

commit;
