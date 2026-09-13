begin;

create or replace function public.publish_restock_announcement(
  p_restock_event_id uuid,
  p_title text,
  p_message text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  org_id uuid := app_private.require_permission('stock.write');
  event public.product_restock_events%rowtype;
  result_id uuid;
begin
  select * into event
  from public.product_restock_events
  where id = p_restock_event_id and organization_id = org_id;

  if not found then
    raise exception 'Restock event not found' using errcode = '42501';
  end if;

  select public.save_announcement(
    null::uuid,
    event.branch_id,
    p_title,
    p_message,
    'STOCK'::text,
    1::smallint,
    true,
    now(),
    null::timestamptz
  ) into result_id;

  update public.product_restock_events
  set announcement_id = result_id
  where id = event.id;

  return result_id;
end;
$$;

create or replace function public.sync_offline_sale(p_device_id uuid,p_event_id uuid,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 profile_id uuid:=auth.uid(); org_id uuid; branch_uuid uuid; device_status public.pos_device_status;
 payload_hash text:=encode(extensions.digest(convert_to(p_payload::text,'UTF8'),'sha256'),'hex'); receipt public.pos_sync_receipts%rowtype; inserted boolean;
 sale_id uuid; created_at timestamptz; completed_at timestamptz; declared_total bigint; declared_weight bigint; computed_total bigint:=0; computed_weight bigint:=0; method public.payment_method;
 item jsonb; movement jsonb; current_product_id uuid; grams integer; list_price bigint; cash_price bigint; final_price bigint; subtotal bigint;
 discount_total bigint; cash_bps integer; cash_discount bigint; promo_discount bigint; discount_type public.weight_discount_type; discount_value bigint; discount_rule uuid;
 list_subtotal bigint; cash_subtotal bigint; cost_snapshot bigint; profit_snapshot integer; has_new_pricing boolean;
begin
 if profile_id is null then raise exception 'Authentication required' using errcode='28000'; end if;
 if p_payload is null or p_payload->>'schemaVersion'<>'1' then raise exception 'Unsupported offline sale payload' using errcode='22023'; end if;
 if jsonb_typeof(p_payload->'items')<>'array' or jsonb_array_length(p_payload->'items') not between 1 and 100 or jsonb_typeof(p_payload->'stockMovements')<>'array' or jsonb_array_length(p_payload->'stockMovements')<>jsonb_array_length(p_payload->'items') then raise exception 'Offline sale items are invalid' using errcode='22023'; end if;
 select d.organization_id,d.branch_id,d.status into org_id,branch_uuid,device_status from public.pos_devices d where d.id=p_device_id;
 if not found or device_status<>'ACTIVE' or not app_private.can_access_branch(org_id,branch_uuid,'sales.create') then raise exception 'Device or branch is not authorized for this user' using errcode='42501'; end if;
 begin
  sale_id:=(p_payload->>'saleId')::uuid; created_at:=(p_payload->>'createdAt')::timestamptz; completed_at:=(p_payload->>'completedAt')::timestamptz;
  declared_total:=(p_payload->>'totalCents')::bigint; declared_weight:=(p_payload->>'totalWeightGrams')::bigint;
  method:=upper(p_payload->'payment'->>'method')::public.payment_method;
 exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale header is invalid' using errcode='22023'; end;
 if (p_payload->>'eventId')::uuid<>p_event_id or (p_payload->>'deviceId')::uuid<>p_device_id or (p_payload->>'organizationId')::uuid<>org_id or (p_payload->>'branchId')::uuid<>branch_uuid or (p_payload->>'profileId')::uuid<>profile_id or p_payload->>'status'<>'COMPLETED' or created_at>completed_at or completed_at>now()+interval '5 minutes' then raise exception 'Offline sale identity or timestamps are invalid' using errcode='42501'; end if;
 insert into public.pos_sync_receipts(event_id,sale_id,device_id,payload_hash) values(p_event_id,sale_id,p_device_id,payload_hash) on conflict(event_id) do nothing returning true into inserted;
 if not coalesce(inserted,false) then
  select * into receipt from public.pos_sync_receipts where event_id=p_event_id;
  if receipt.sale_id<>sale_id or receipt.device_id<>p_device_id or receipt.payload_hash<>payload_hash then raise exception 'Idempotency key was reused with a different payload' using errcode='23505'; end if;
  return jsonb_build_object('saleId',sale_id,'duplicate',true,'syncedAt',receipt.received_at);
 end if;
 if exists(select 1 from public.sales where id=sale_id) then raise exception 'Sale id already exists with another sync event' using errcode='23505'; end if;
 insert into public.sales(id,organization_id,branch_id,profile_id,status,total_cents,total_weight_grams,created_at,completed_at,device_id,sync_event_id)
 values(sale_id,org_id,branch_uuid,profile_id,'COMPLETED',0,0,created_at,completed_at,p_device_id,p_event_id);
 for item_index in 0..jsonb_array_length(p_payload->'items')-1 loop
  item:=p_payload->'items'->item_index; movement:=p_payload->'stockMovements'->item_index;
  has_new_pricing:=item ? 'cashDiscountBps' or item ? 'promotionDiscountCents';
  begin
   current_product_id:=(item->>'productId')::uuid; grams:=(item->>'weightGrams')::integer; final_price:=(item->>'pricePerKgCents')::bigint;
   list_price:=coalesce(nullif(item->>'originalPricePerKgCents','')::bigint,final_price);
   discount_total:=coalesce(nullif(item->>'discountCents','')::bigint,0);
   cash_bps:=coalesce(nullif(item->>'cashDiscountBps','')::integer,0);
   cash_discount:=coalesce(nullif(item->>'cashDiscountCents','')::bigint,0);
   promo_discount:=coalesce(nullif(item->>'promotionDiscountCents','')::bigint,discount_total-cash_discount);
   discount_type:=nullif(item->>'discountType','')::public.weight_discount_type; discount_value:=nullif(item->>'discountValue','')::bigint; discount_rule:=nullif(item->>'discountRuleId','')::uuid;
   subtotal:=(item->>'subtotalCents')::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Offline sale item snapshot is malformed' using errcode='22023'; end;
  if grams<=0 or list_price<=0 or final_price<=0 or cash_bps not between 0 and 9999 or (method<>'CASH' and cash_bps<>0) then raise exception 'Offline sale item values are invalid' using errcode='22023'; end if;
  cash_price:=app_private.round_ratio_half_up(list_price*(10000-cash_bps),10000);
  list_subtotal:=app_private.round_ratio_half_up(list_price*grams,1000); cash_subtotal:=app_private.round_ratio_half_up(cash_price*grams,1000);
  if discount_type='PERCENTAGE' then
   if discount_value not between 1 and 10000 or (has_new_pricing and final_price<>app_private.round_ratio_half_up(cash_price*(10000-discount_value),10000)) or (not has_new_pricing and final_price<>app_private.round_ratio_half_up(cash_price*(10000-discount_value),10000) and final_price<>cash_price*(10000-discount_value)/10000) then raise exception 'Offline percentage promotion is inconsistent' using errcode='22023'; end if;
  elsif discount_type='FIXED_PRICE_PER_KG' then
   if discount_value<=0 or final_price<>discount_value then raise exception 'Offline fixed-price promotion is inconsistent' using errcode='22023'; end if;
  elsif discount_rule is not null or discount_value is not null then raise exception 'Offline promotion metadata is inconsistent' using errcode='22023';
  else
   if final_price<>cash_price then raise exception 'Offline undiscounted price is inconsistent' using errcode='22023'; end if;
  end if;
  if final_price>cash_price then raise exception 'Offline promotion cannot increase a price' using errcode='22023'; end if;
  if subtotal<>app_private.round_ratio_half_up(final_price*grams,1000) or cash_discount<>list_subtotal-cash_subtotal or promo_discount<>cash_subtotal-subtotal or discount_total<>cash_discount+promo_discount then raise exception 'Offline sale item arithmetic is invalid' using errcode='22023'; end if;
  if not exists(select 1 from public.products p where p.id=current_product_id and p.organization_id=org_id and p.unit_type='WEIGHT') then raise exception 'Offline sale product does not belong to the device organization' using errcode='42501'; end if;
  if discount_rule is not null and not exists(select 1 from public.product_weight_discounts pwd where pwd.id=discount_rule and pwd.organization_id=org_id and pwd.product_id=current_product_id) then raise exception 'Offline discount rule does not belong to the sale product' using errcode='42501'; end if;
  if (movement->>'productId')::uuid<>current_product_id or (movement->>'quantityGrams')::bigint<>-grams::bigint then raise exception 'Offline stock movement does not match its sale item' using errcode='22023'; end if;
  select c.cost_cents into cost_snapshot from public.product_costs c where c.organization_id=org_id and c.product_id=current_product_id and c.valid_from<=completed_at and (c.valid_to is null or c.valid_to>completed_at) order by c.valid_from desc limit 1;
  select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s where s.organization_id=org_id and s.product_id=current_product_id and s.valid_from<=completed_at and (s.valid_to is null or s.valid_to>completed_at) order by s.valid_from desc limit 1;
  insert into public.sale_items(id,sale_id,organization_id,branch_id,product_id,product_name_snapshot,weight_grams,price_per_kg_cents,original_price_per_kg_cents,discount_rule_id,discount_type,discount_value,final_price_per_kg_cents,discount_cents,cash_discount_bps,cash_discount_cents,promotion_discount_cents,cost_cents_snapshot,profit_markup_bps_snapshot,subtotal_cents,created_at)
  values((item->>'id')::uuid,sale_id,org_id,branch_uuid,current_product_id,item->>'productNameSnapshot',grams,final_price,list_price,discount_rule,discount_type,discount_value,final_price,discount_total,cash_bps,cash_discount,promo_discount,cost_snapshot,profit_snapshot,subtotal,completed_at);
  insert into public.stock_movements(id,organization_id,branch_id,product_id,type,quantity_grams,sale_id,profile_id,occurred_at,created_at)
  values((movement->>'id')::uuid,org_id,branch_uuid,current_product_id,'SALE',-grams::bigint,sale_id,profile_id,(movement->>'occurredAt')::timestamptz,completed_at);
  computed_total:=computed_total+subtotal; computed_weight:=computed_weight+grams;
 end loop;
 if computed_total<>declared_total or computed_weight<>declared_weight or (p_payload->'payment'->>'amountCents')::bigint<>declared_total then raise exception 'Offline sale totals do not match its details' using errcode='22023'; end if;
 update public.sales set total_cents=computed_total,total_weight_grams=computed_weight where id=sale_id;
 insert into public.payments(id,sale_id,organization_id,branch_id,method,amount_cents,created_at) values((p_payload->'payment'->>'id')::uuid,sale_id,org_id,branch_uuid,method,declared_total,completed_at);
 return jsonb_build_object('saleId',sale_id,'duplicate',false,'syncedAt',now());
end; $$;

commit;
