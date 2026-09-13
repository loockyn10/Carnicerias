begin;

alter table public.categories
  add column color_hex text
  check (color_hex is null or color_hex ~ '^#[0-9A-Fa-f]{6}$');

create function public.save_category(
  p_category_id uuid,
  p_name text,
  p_slug text,
  p_sort_order integer,
  p_active boolean,
  p_color_hex text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  current_category_id uuid;
  normalized_color text := upper(nullif(btrim(p_color_hex), ''));
begin
  if char_length(btrim(p_name)) not between 1 and 100
     or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or (normalized_color is not null and normalized_color !~ '^#[0-9A-F]{6}$') then
    raise exception 'Category name, slug, or color is invalid' using errcode = '22023';
  end if;

  if p_category_id is null then
    insert into public.categories (organization_id, name, slug, color_hex, sort_order, active)
    values (current_organization_id, btrim(p_name), p_slug, normalized_color, p_sort_order, p_active)
    returning id into current_category_id;
  else
    update public.categories
    set name = btrim(p_name), slug = p_slug, color_hex = normalized_color,
        sort_order = p_sort_order, active = p_active
    where id = p_category_id and organization_id = current_organization_id
    returning id into current_category_id;
    if current_category_id is null then
      raise exception 'Category was not found in this organization' using errcode = '42501';
    end if;
  end if;
  return current_category_id;
end;
$$;

create function app_private.payment_method_receives_discount(p_method public.payment_method)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_method not in ('DEBIT'::public.payment_method, 'CREDIT'::public.payment_method);
$$;

revoke all on function app_private.payment_method_receives_discount(public.payment_method) from public, anon, authenticated;

create or replace function public.complete_discounted_sale(p_branch_id uuid,p_items jsonb,p_payment_method text)
returns table(sale_id uuid,total_cents bigint,total_weight_grams bigint,completed_at timestamptz)
language plpgsql volatile security definer set search_path='' as $$
declare profile_id uuid:=auth.uid(); org_id uuid; sale uuid; at_time timestamptz:=clock_timestamp(); item jsonb; product uuid; grams integer; expected_price bigint; expected_cash_bps integer; expected_final_price bigint; name text; list_price bigint; cash_price bigint; final_price bigint; promo record; list_subtotal bigint; cash_subtotal bigint; subtotal bigint; total bigint:=0; weight bigint:=0; method public.payment_method; cash_bps integer:=0; cost_snapshot bigint; profit_snapshot integer;
begin
 if profile_id is null or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Invalid sale' using errcode='22023'; end if;
 select organization_id into org_id from public.branches where id=p_branch_id and active;
 if org_id is null or not app_private.can_access_branch(org_id,p_branch_id,'sales.create') then raise exception 'Branch is not authorized for this user' using errcode='42501'; end if;
 method:=upper(p_payment_method)::public.payment_method;
 if app_private.payment_method_receives_discount(method) then select cash_discount_bps into cash_bps from public.organization_cash_discounts where organization_id=org_id and valid_from<=at_time and (valid_to is null or valid_to>at_time) order by valid_from desc limit 1; cash_bps:=coalesce(cash_bps,1000); end if;
 insert into public.sales(organization_id,branch_id,profile_id,status,total_cents,total_weight_grams,completed_at) values(org_id,p_branch_id,profile_id,'COMPLETED',0,0,at_time) returning id into sale;
 for item in select value from jsonb_array_elements(p_items) loop
  product:=(item->>'product_id')::uuid; grams:=(item->>'weight_grams')::integer; expected_price:=(item->>'expected_price_per_kg_cents')::bigint;
  expected_cash_bps:=nullif(item->>'expected_cash_discount_bps','')::integer; expected_final_price:=nullif(item->>'expected_final_price_per_kg_cents','')::bigint;
  if grams<=0 then raise exception 'Invalid weight' using errcode='22023'; end if;
  select p.name,pp.price_cents into name,list_price from public.products p join lateral(select price_cents from public.product_prices where organization_id=org_id and product_id=p.id and (branch_id=p_branch_id or branch_id is null) and valid_from<=at_time and (valid_to is null or valid_to>at_time) order by (branch_id=p_branch_id) desc,valid_from desc limit 1) pp on true where p.id=product and p.organization_id=org_id and p.active and p.unit_type='WEIGHT';
  if not found or list_price<>expected_price then raise exception 'Product price changed; reload and retry' using errcode='40001'; end if;
  cash_price:=app_private.round_ratio_half_up(list_price*(10000-cash_bps),10000);
  select * into promo from public.resolve_weight_discount(org_id,product,p_branch_id,grams,cash_price,at_time);
  final_price:=coalesce(promo.final_price_cents,cash_price); if final_price>cash_price then raise exception 'Promotion is not a discount for this payment method' using errcode='22023'; end if;
  if (expected_cash_bps is not null and expected_cash_bps<>cash_bps) or (expected_final_price is not null and expected_final_price<>final_price) then raise exception 'Commercial configuration changed; reload and retry' using errcode='40001'; end if;
  list_subtotal:=app_private.round_ratio_half_up(list_price*grams,1000); cash_subtotal:=app_private.round_ratio_half_up(cash_price*grams,1000); subtotal:=app_private.round_ratio_half_up(final_price*grams,1000);
  select c.cost_cents into cost_snapshot from public.product_costs c where c.organization_id=org_id and c.product_id=product and c.valid_from<=at_time and (c.valid_to is null or c.valid_to>at_time) order by c.valid_from desc limit 1;
  select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s where s.organization_id=org_id and s.product_id=product and s.valid_from<=at_time and (s.valid_to is null or s.valid_to>at_time) order by s.valid_from desc limit 1;
  insert into public.sale_items(sale_id,organization_id,branch_id,product_id,product_name_snapshot,weight_grams,price_per_kg_cents,original_price_per_kg_cents,discount_rule_id,discount_type,discount_value,final_price_per_kg_cents,discount_cents,cash_discount_bps,cash_discount_cents,promotion_discount_cents,cost_cents_snapshot,profit_markup_bps_snapshot,subtotal_cents,created_at)
  values(sale,org_id,p_branch_id,product,name,grams,final_price,list_price,promo.rule_id,promo.discount_type,promo.discount_value,final_price,list_subtotal-subtotal,cash_bps,list_subtotal-cash_subtotal,cash_subtotal-subtotal,cost_snapshot,profit_snapshot,subtotal,at_time);
  insert into public.stock_movements(organization_id,branch_id,product_id,type,quantity_grams,sale_id,profile_id,occurred_at,created_at) values(org_id,p_branch_id,product,'SALE',-grams,sale,profile_id,at_time,at_time);
  total:=total+subtotal; weight:=weight+grams;
 end loop;
 update public.sales set total_cents=total,total_weight_grams=weight where id=sale;
 insert into public.payments(sale_id,organization_id,branch_id,method,amount_cents,created_at) values(sale,org_id,p_branch_id,method,total,at_time);
 return query select sale,total,weight,at_time;
end; $$;

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
  if grams<=0 or list_price<=0 or final_price<=0 or cash_bps not between 0 and 9999 or (not app_private.payment_method_receives_discount(method) and cash_bps<>0) then raise exception 'Offline sale item values are invalid' using errcode='22023'; end if;
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

revoke all on function public.save_category(uuid,text,text,integer,boolean,text) from public, anon;
grant execute on function public.save_category(uuid,text,text,integer,boolean,text) to authenticated;

drop function public.get_pos_catalog(uuid);

create function public.get_pos_catalog(p_branch_id uuid)
returns table (
  organization_id uuid,
  branch_id uuid,
  branch_name text,
  category_id uuid,
  category_name text,
  category_color_hex text,
  category_sort_order integer,
  product_id uuid,
  product_name text,
  product_sku text,
  unit_type public.unit_type,
  price_per_kg_cents bigint,
  price_valid_from timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select b.organization_id into current_organization_id
  from public.branches b
  where b.id = p_branch_id and b.active;
  if current_organization_id is null
     or not app_private.can_access_branch(current_organization_id, p_branch_id, 'sales.create') then
    raise exception 'Branch is not authorized for this user' using errcode = '42501';
  end if;
  return query
  select p.organization_id, b.id, b.name, c.id, c.name, c.color_hex, c.sort_order,
         p.id, p.name, p.sku, p.unit_type, effective_price.price_cents, effective_price.valid_from
  from public.products p
  join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id and c.active
  join public.branches b on b.id = p_branch_id and b.organization_id = p.organization_id
  join lateral (
    select pp.price_cents, pp.valid_from
    from public.product_prices pp
    where pp.organization_id = p.organization_id and pp.product_id = p.id
      and (pp.branch_id = p_branch_id or pp.branch_id is null)
      and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
    order by (pp.branch_id = p_branch_id) desc nulls last, pp.valid_from desc
    limit 1
  ) effective_price on true
  where p.organization_id = current_organization_id and p.active
  order by c.sort_order, c.name, p.name;
end;
$$;

revoke all on function public.get_pos_catalog(uuid) from public, anon;
grant execute on function public.get_pos_catalog(uuid) to authenticated;

create or replace function public.pull_pos_state(p_device_id uuid, p_after_sequence bigint default 0)
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
  current_branch_name text;
  current_branch_active boolean;
  current_device_status public.pos_device_status;
  current_role_name text;
  current_cursor bigint;
  current_server_time timestamptz := now();
  catalog_payload jsonb;
  removed_payload jsonb;
begin
  if current_profile_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select d.organization_id, d.branch_id, b.name, b.active, d.status, r.name
  into current_organization_id, current_branch_id, current_branch_name,
       current_branch_active, current_device_status, current_role_name
  from public.pos_devices d
  join public.branches b on b.id = d.branch_id and b.organization_id = d.organization_id
  join public.organization_members om on om.organization_id = d.organization_id and om.profile_id = current_profile_id and om.status = 'ACTIVE'
  join public.roles r on r.id = om.role_id
  where d.id = p_device_id;
  if not found or current_device_status <> 'ACTIVE' or not current_branch_active
     or not app_private.can_access_branch(current_organization_id, current_branch_id, 'sales.create') then
    raise exception 'Device or branch is not authorized for this user' using errcode = '42501';
  end if;
  select coalesce(max(c.sequence), p_after_sequence) into current_cursor
  from public.pos_catalog_changes c
  where c.organization_id = current_organization_id and (c.branch_id is null or c.branch_id = current_branch_id);
  with changed_products as (
    select distinct p.id
    from public.products p
    where p.organization_id = current_organization_id and (
      p_after_sequence = 0 or exists (
        select 1 from public.pos_catalog_changes c
        where c.organization_id = current_organization_id and c.sequence > p_after_sequence
          and (c.branch_id is null or c.branch_id = current_branch_id)
          and ((c.entity_type in ('PRODUCT', 'PRICE') and c.entity_id = p.id)
            or (c.entity_type = 'CATEGORY' and c.entity_id = p.category_id)
            or c.entity_type = 'BRANCH')
      )
    )
  ), effective_catalog as (
    select p.organization_id, current_branch_id as branch_id, current_branch_name as branch_name,
      current_branch_active as branch_active, c.id as category_id, c.name as category_name,
      c.color_hex as category_color_hex, c.sort_order as category_sort_order, c.active as category_active,
      p.id as product_id, p.name as product_name, p.sku as product_sku, p.unit_type,
      p.active as product_active, effective_price.price_cents, effective_price.valid_from
    from changed_products changed
    join public.products p on p.id = changed.id and p.organization_id = current_organization_id
    join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    join lateral (
      select pp.price_cents, pp.valid_from
      from public.product_prices pp
      where pp.organization_id = p.organization_id and pp.product_id = p.id
        and (pp.branch_id = current_branch_id or pp.branch_id is null)
        and pp.valid_from <= current_server_time and (pp.valid_to is null or pp.valid_to > current_server_time)
      order by (pp.branch_id = current_branch_id) desc nulls last, pp.valid_from desc
      limit 1
    ) effective_price on true
    where p.active and c.active and current_branch_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', organization_id, 'branchId', branch_id, 'branchName', branch_name,
    'branchActive', branch_active, 'categoryId', category_id, 'categoryName', category_name,
    'categoryColorHex', category_color_hex, 'categorySortOrder', category_sort_order,
    'categoryActive', category_active, 'productId', product_id, 'productName', product_name,
    'productSku', product_sku, 'unitType', unit_type, 'productActive', product_active,
    'pricePerKgCents', price_cents::text, 'priceValidFrom', valid_from
  ) order by category_sort_order, category_name, product_name), '[]'::jsonb)
  into catalog_payload from effective_catalog;
  with changed_products as (
    select distinct p.id
    from public.products p
    where p.organization_id = current_organization_id and (
      p_after_sequence = 0 or exists (
        select 1 from public.pos_catalog_changes c
        where c.organization_id = current_organization_id and c.sequence > p_after_sequence
          and (c.branch_id is null or c.branch_id = current_branch_id)
          and ((c.entity_type in ('PRODUCT', 'PRICE') and c.entity_id = p.id)
            or (c.entity_type = 'CATEGORY' and c.entity_id = p.category_id)
            or c.entity_type = 'BRANCH')
      )
    )
  )
  select coalesce(jsonb_agg(changed.id), '[]'::jsonb) into removed_payload
  from changed_products changed
  where not exists (
    select 1 from public.products p
    join public.categories c on c.id = p.category_id and c.active
    join lateral (
      select 1 from public.product_prices pp
      where pp.product_id = p.id and pp.organization_id = p.organization_id
        and (pp.branch_id = current_branch_id or pp.branch_id is null)
        and pp.valid_from <= current_server_time and (pp.valid_to is null or pp.valid_to > current_server_time)
      limit 1
    ) price_exists on true
    where p.id = changed.id and p.active and current_branch_active
  );
  update public.pos_devices set last_seen_at = current_server_time where id = p_device_id;
  return jsonb_build_object(
    'cursor', current_cursor, 'serverTime', current_server_time,
    'authorizationExpiresAt', current_server_time + interval '24 hours',
    'organizationId', current_organization_id, 'branchId', current_branch_id,
    'branchName', current_branch_name, 'branchActive', current_branch_active,
    'deviceStatus', current_device_status, 'roleName', current_role_name,
    'catalog', catalog_payload, 'removedProductIds', removed_payload
  );
end;
$$;

commit;
