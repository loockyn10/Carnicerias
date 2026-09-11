begin;

-- Keep the original online RPC safe for older POS builds after snapshot columns became NOT NULL.
create or replace function public.complete_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_payment_method text
)
returns table (
  sale_id uuid,
  total_cents bigint,
  total_weight_grams bigint,
  completed_at timestamptz
)
language sql
volatile
security definer
set search_path = ''
as $$
  select * from public.complete_discounted_sale(p_branch_id, p_items, p_payment_method);
$$;

-- One canonical push accepts both legacy items and discount-aware items.
create or replace function public.sync_offline_sale(
  p_device_id uuid,
  p_event_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_profile_id uuid := auth.uid();
  current_organization_id uuid;
  current_branch_id uuid;
  current_device_status public.pos_device_status;
  current_payload_hash text := encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
  existing_receipt public.pos_sync_receipts%rowtype;
  receipt_inserted boolean;
  current_sale_id uuid;
  current_created_at timestamptz;
  current_completed_at timestamptz;
  declared_total_cents bigint;
  declared_total_weight bigint;
  computed_total_cents bigint := 0;
  computed_total_weight bigint := 0;
  current_method public.payment_method;
  item jsonb;
  movement jsonb;
  item_index integer;
  current_product_id uuid;
  current_weight integer;
  current_original_price bigint;
  current_effective_price bigint;
  current_discount_cents bigint;
  current_discount_type public.weight_discount_type;
  current_discount_value bigint;
  current_discount_rule_id uuid;
  current_subtotal bigint;
  expected_normal_subtotal bigint;
  expected_final_subtotal bigint;
begin
  if current_profile_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_payload is null or p_payload ->> 'schemaVersion' <> '1' then
    raise exception 'Unsupported offline sale payload' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'items') <> 'array'
     or jsonb_array_length(p_payload -> 'items') not between 1 and 100
     or jsonb_typeof(p_payload -> 'stockMovements') <> 'array'
     or jsonb_array_length(p_payload -> 'stockMovements') <> jsonb_array_length(p_payload -> 'items') then
    raise exception 'Offline sale items are invalid' using errcode = '22023';
  end if;

  select d.organization_id, d.branch_id, d.status
  into current_organization_id, current_branch_id, current_device_status
  from public.pos_devices d
  where d.id = p_device_id;
  if not found or current_device_status <> 'ACTIVE'
     or not app_private.can_access_branch(current_organization_id, current_branch_id, 'sales.create') then
    raise exception 'Device or branch is not authorized for this user' using errcode = '42501';
  end if;

  begin
    current_sale_id := (p_payload ->> 'saleId')::uuid;
    current_created_at := (p_payload ->> 'createdAt')::timestamptz;
    current_completed_at := (p_payload ->> 'completedAt')::timestamptz;
    declared_total_cents := (p_payload ->> 'totalCents')::bigint;
    declared_total_weight := (p_payload ->> 'totalWeightGrams')::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Offline sale header is invalid' using errcode = '22023';
  end;
  if (p_payload ->> 'eventId')::uuid <> p_event_id
     or (p_payload ->> 'deviceId')::uuid <> p_device_id
     or (p_payload ->> 'organizationId')::uuid <> current_organization_id
     or (p_payload ->> 'branchId')::uuid <> current_branch_id
     or (p_payload ->> 'profileId')::uuid <> current_profile_id
     or p_payload ->> 'status' <> 'COMPLETED'
     or current_created_at > current_completed_at
     or current_completed_at > now() + interval '5 minutes' then
    raise exception 'Offline sale identity or timestamps are invalid' using errcode = '42501';
  end if;

  insert into public.pos_sync_receipts (event_id, sale_id, device_id, payload_hash)
  values (p_event_id, current_sale_id, p_device_id, current_payload_hash)
  on conflict (event_id) do nothing
  returning true into receipt_inserted;
  if not coalesce(receipt_inserted, false) then
    select * into existing_receipt from public.pos_sync_receipts where event_id = p_event_id;
    if existing_receipt.sale_id <> current_sale_id
       or existing_receipt.device_id <> p_device_id
       or existing_receipt.payload_hash <> current_payload_hash then
      raise exception 'Idempotency key was reused with a different payload' using errcode = '23505';
    end if;
    return jsonb_build_object('saleId', current_sale_id, 'duplicate', true, 'syncedAt', existing_receipt.received_at);
  end if;
  if exists (select 1 from public.sales s where s.id = current_sale_id) then
    raise exception 'Sale id already exists with another sync event' using errcode = '23505';
  end if;

  insert into public.sales (
    id, organization_id, branch_id, profile_id, status, total_cents, total_weight_grams,
    created_at, completed_at, device_id, sync_event_id
  ) values (
    current_sale_id, current_organization_id, current_branch_id, current_profile_id,
    'COMPLETED', 0, 0, current_created_at, current_completed_at, p_device_id, p_event_id
  );

  for item_index in 0 .. jsonb_array_length(p_payload -> 'items') - 1 loop
    item := p_payload -> 'items' -> item_index;
    movement := p_payload -> 'stockMovements' -> item_index;
    begin
      current_product_id := (item ->> 'productId')::uuid;
      current_weight := (item ->> 'weightGrams')::integer;
      current_effective_price := (item ->> 'pricePerKgCents')::bigint;
      current_original_price := coalesce(nullif(item ->> 'originalPricePerKgCents', '')::bigint, current_effective_price);
      current_discount_cents := coalesce(nullif(item ->> 'discountCents', '')::bigint, 0);
      current_discount_type := nullif(item ->> 'discountType', '')::public.weight_discount_type;
      current_discount_value := nullif(item ->> 'discountValue', '')::bigint;
      current_discount_rule_id := nullif(item ->> 'discountRuleId', '')::uuid;
      current_subtotal := (item ->> 'subtotalCents')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Offline sale item snapshot is malformed' using errcode = '22023';
    end;

    if current_weight <= 0 or current_original_price <= 0 or current_effective_price <= 0
       or current_effective_price > current_original_price then
      raise exception 'Offline sale item values are invalid' using errcode = '22023';
    end if;
    expected_normal_subtotal := (current_original_price * current_weight::bigint + 500) / 1000;
    expected_final_subtotal := (current_effective_price * current_weight::bigint + 500) / 1000;
    if current_subtotal <> expected_final_subtotal
       or current_discount_cents <> expected_normal_subtotal - expected_final_subtotal
       or current_discount_cents < 0 then
      raise exception 'Offline sale item arithmetic is invalid' using errcode = '22023';
    end if;
    if current_discount_cents = 0 and (current_discount_type is not null or current_discount_value is not null) then
      raise exception 'A non-discounted item cannot contain discount metadata' using errcode = '22023';
    elsif current_discount_cents > 0 and (
      current_discount_type is null or current_discount_value is null
      or (current_discount_type = 'PERCENTAGE' and (
        current_discount_value not between 1 and 10000
        or current_effective_price <> current_original_price * (10000 - current_discount_value) / 10000
      ))
      or (current_discount_type = 'FIXED_PRICE_PER_KG' and current_effective_price <> current_discount_value)
    ) then
      raise exception 'Offline discount metadata is inconsistent' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.products p
      where p.id = current_product_id and p.organization_id = current_organization_id and p.unit_type = 'WEIGHT'
    ) then
      raise exception 'Offline sale product does not belong to the device organization' using errcode = '42501';
    end if;
    if current_discount_rule_id is not null and not exists (
      select 1 from public.product_weight_discounts d
      where d.id = current_discount_rule_id and d.organization_id = current_organization_id and d.product_id = current_product_id
    ) then
      raise exception 'Offline discount rule does not belong to the sale product' using errcode = '42501';
    end if;
    if (movement ->> 'productId')::uuid <> current_product_id
       or (movement ->> 'quantityGrams')::bigint <> -current_weight::bigint then
      raise exception 'Offline stock movement does not match its sale item' using errcode = '22023';
    end if;

    insert into public.sale_items (
      id, sale_id, organization_id, branch_id, product_id, product_name_snapshot,
      weight_grams, price_per_kg_cents, original_price_per_kg_cents,
      discount_rule_id, discount_type, discount_value, final_price_per_kg_cents,
      discount_cents, subtotal_cents, created_at
    ) values (
      (item ->> 'id')::uuid, current_sale_id, current_organization_id, current_branch_id,
      current_product_id, item ->> 'productNameSnapshot', current_weight,
      current_effective_price, current_original_price, current_discount_rule_id,
      current_discount_type, current_discount_value, current_effective_price,
      current_discount_cents, current_subtotal, current_completed_at
    );
    insert into public.stock_movements (
      id, organization_id, branch_id, product_id, type, quantity_grams,
      sale_id, profile_id, occurred_at, created_at
    ) values (
      (movement ->> 'id')::uuid, current_organization_id, current_branch_id,
      current_product_id, 'SALE', -current_weight::bigint, current_sale_id,
      current_profile_id, (movement ->> 'occurredAt')::timestamptz, current_completed_at
    );
    computed_total_cents := computed_total_cents + current_subtotal;
    computed_total_weight := computed_total_weight + current_weight;
  end loop;

  begin
    current_method := upper(p_payload -> 'payment' ->> 'method')::public.payment_method;
  exception when invalid_text_representation then
    raise exception 'Unsupported payment method' using errcode = '22023';
  end;
  if computed_total_cents <> declared_total_cents
     or computed_total_weight <> declared_total_weight
     or (p_payload -> 'payment' ->> 'amountCents')::bigint <> declared_total_cents then
    raise exception 'Offline sale totals do not match its details' using errcode = '22023';
  end if;
  update public.sales set total_cents = computed_total_cents, total_weight_grams = computed_total_weight
  where id = current_sale_id;
  insert into public.payments (
    id, sale_id, organization_id, branch_id, method, amount_cents, created_at
  ) values (
    (p_payload -> 'payment' ->> 'id')::uuid, current_sale_id,
    current_organization_id, current_branch_id, current_method,
    declared_total_cents, current_completed_at
  );
  return jsonb_build_object('saleId', current_sale_id, 'duplicate', false, 'syncedAt', now());
end;
$$;

-- Intermediate clients that already call the temporary split RPC remain compatible.
create or replace function public.sync_discounted_offline_sale(
  p_device_id uuid,
  p_event_id uuid,
  p_payload jsonb
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.sync_offline_sale(p_device_id, p_event_id, p_payload);
$$;

revoke all on function public.complete_sale(uuid, jsonb, text) from public, anon;
revoke all on function public.sync_offline_sale(uuid, uuid, jsonb) from public, anon;
revoke all on function public.sync_discounted_offline_sale(uuid, uuid, jsonb) from public, anon;
grant execute on function public.complete_sale(uuid, jsonb, text) to authenticated;
grant execute on function public.sync_offline_sale(uuid, uuid, jsonb) to authenticated;
grant execute on function public.sync_discounted_offline_sale(uuid, uuid, jsonb) to authenticated;

commit;
