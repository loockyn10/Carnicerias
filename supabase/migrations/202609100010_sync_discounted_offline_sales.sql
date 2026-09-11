begin;

create function public.sync_discounted_offline_sale(p_device_id uuid, p_event_id uuid, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare profile_id uuid:=auth.uid(); org_id uuid; branch_id uuid; device_status public.pos_device_status; receipt public.pos_sync_receipts%rowtype; payload_hash text:=encode(extensions.digest(convert_to(p_payload::text,'UTF8'),'sha256'),'hex'); inserted boolean; sale_id uuid; completed_at timestamptz; created_at timestamptz; item jsonb; movement jsonb; product_id uuid; grams integer; original_price bigint; final_price bigint; subtotal bigint; discount_cents bigint; discount record; total bigint:=0; total_weight bigint:=0; method public.payment_method; item_index integer;
begin
 if profile_id is null or p_payload->>'schemaVersion' <> '1' then raise exception 'Unsupported offline sale payload' using errcode='22023'; end if;
 select organization_id,branch_id,status into org_id,branch_id,device_status from public.pos_devices where id=p_device_id;
 if not found or device_status<>'ACTIVE' or not app_private.can_access_branch(org_id,branch_id,'sales.create') then raise exception 'Device or branch is not authorized for this user' using errcode='42501'; end if;
 if (p_payload->>'eventId')::uuid<>p_event_id or (p_payload->>'deviceId')::uuid<>p_device_id or (p_payload->>'organizationId')::uuid<>org_id or (p_payload->>'branchId')::uuid<>branch_id or (p_payload->>'profileId')::uuid<>profile_id then raise exception 'Offline sale identity does not match the authenticated device' using errcode='42501'; end if;
 sale_id:=(p_payload->>'saleId')::uuid; completed_at:=(p_payload->>'completedAt')::timestamptz; created_at:=(p_payload->>'createdAt')::timestamptz;
 insert into public.pos_sync_receipts(event_id,sale_id,device_id,payload_hash) values(p_event_id,sale_id,p_device_id,payload_hash) on conflict(event_id) do nothing returning true into inserted;
 if not coalesce(inserted,false) then select * into receipt from public.pos_sync_receipts where event_id=p_event_id; if receipt.sale_id<>sale_id or receipt.device_id<>p_device_id or receipt.payload_hash<>payload_hash then raise exception 'Idempotency key was reused with a different payload' using errcode='23505'; end if; return jsonb_build_object('saleId',receipt.sale_id,'duplicate',true,'syncedAt',receipt.received_at); end if;
 if exists(select 1 from public.sales where id=sale_id) then raise exception 'Sale id already exists with another sync event' using errcode='23505'; end if;
 if jsonb_typeof(p_payload->'items')<>'array' or jsonb_array_length(p_payload->'items')<1 or jsonb_array_length(p_payload->'items')>100 then raise exception 'Offline sale items are invalid' using errcode='22023'; end if;
 insert into public.sales(id,organization_id,branch_id,profile_id,status,total_cents,total_weight_grams,created_at,completed_at,device_id,sync_event_id) values(sale_id,org_id,branch_id,profile_id,'COMPLETED',0,0,created_at,completed_at,p_device_id,p_event_id);
 for item_index in 0..jsonb_array_length(p_payload->'items')-1 loop
  item:=p_payload->'items'->item_index; movement:=p_payload->'stockMovements'->item_index; product_id:=(item->>'productId')::uuid; grams:=(item->>'weightGrams')::integer; original_price:=coalesce((item->>'originalPricePerKgCents')::bigint,(item->>'pricePerKgCents')::bigint); final_price:=(item->>'pricePerKgCents')::bigint; subtotal:=(item->>'subtotalCents')::bigint; discount_cents:=coalesce((item->>'discountCents')::bigint,0);
  if grams<=0 or subtotal<>(final_price*grams+500)/1000 or discount_cents<>(original_price*grams+500)/1000-subtotal or (movement->>'productId')::uuid<>product_id or (movement->>'quantityGrams')::bigint<>-grams then raise exception 'Offline item snapshot is invalid' using errcode='22023'; end if;
  if not exists(select 1 from public.products p join lateral(select pp.price_cents from public.product_prices pp where pp.organization_id=org_id and pp.product_id=p.id and (pp.branch_id=branch_id or pp.branch_id is null) and pp.valid_from<=completed_at and (pp.valid_to is null or pp.valid_to>completed_at) order by (pp.branch_id=branch_id) desc,pp.valid_from desc limit 1) price on true where p.id=product_id and p.organization_id=org_id and p.active and p.unit_type='WEIGHT' and price.price_cents=original_price) then raise exception 'Offline price snapshot is not valid at the sale timestamp' using errcode='40001'; end if;
  select * into discount from public.resolve_weight_discount(org_id,product_id,branch_id,grams,original_price,completed_at);
  if coalesce(discount.final_price_cents,original_price)<>final_price then raise exception 'Offline discount snapshot is not valid at the sale timestamp' using errcode='40001'; end if;
  insert into public.sale_items(id,sale_id,organization_id,branch_id,product_id,product_name_snapshot,weight_grams,price_per_kg_cents,original_price_per_kg_cents,discount_rule_id,discount_type,discount_value,final_price_per_kg_cents,discount_cents,subtotal_cents,created_at) values((item->>'id')::uuid,sale_id,org_id,branch_id,product_id,item->>'productNameSnapshot',grams,final_price,original_price,nullif(item->>'discountRuleId','')::uuid,nullif(item->>'discountType','')::public.weight_discount_type,nullif(item->>'discountValue','')::bigint,final_price,discount_cents,subtotal,completed_at);
  insert into public.stock_movements(id,organization_id,branch_id,product_id,type,quantity_grams,sale_id,profile_id,occurred_at,created_at) values((movement->>'id')::uuid,org_id,branch_id,product_id,'SALE',-grams,sale_id,profile_id,(movement->>'occurredAt')::timestamptz,completed_at);
  total:=total+subtotal; total_weight:=total_weight+grams;
 end loop;
 method:=upper(p_payload->'payment'->>'method')::public.payment_method;
 if total<>(p_payload->>'totalCents')::bigint or total_weight<>(p_payload->>'totalWeightGrams')::bigint or (p_payload->'payment'->>'amountCents')::bigint<>total then raise exception 'Offline sale totals do not match its details' using errcode='22023'; end if;
 update public.sales set total_cents=total,total_weight_grams=total_weight where id=sale_id;
 insert into public.payments(id,sale_id,organization_id,branch_id,method,amount_cents,created_at) values((p_payload->'payment'->>'id')::uuid,sale_id,org_id,branch_id,method,total,completed_at);
 return jsonb_build_object('saleId',sale_id,'duplicate',false,'syncedAt',now());
end; $$;
revoke all on function public.sync_discounted_offline_sale(uuid,uuid,jsonb) from public,anon;
grant execute on function public.sync_discounted_offline_sale(uuid,uuid,jsonb) to authenticated;
commit;
