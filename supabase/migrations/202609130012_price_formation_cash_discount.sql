begin;

-- Automatic price formation is opt-in. Existing products keep their current manual price.
create table public.product_costs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  cost_cents bigint not null check (cost_cents >= 0),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict,
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (product_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create index product_costs_current_idx on public.product_costs(product_id, valid_from desc) where valid_to is null;

create table public.product_pricing_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  profit_markup_bps integer not null check (profit_markup_bps between 0 and 100000),
  updated_by uuid references public.profiles(id) on delete set null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict,
  unique(id, organization_id),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (product_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create index product_pricing_settings_current_idx on public.product_pricing_settings(product_id,valid_from desc) where valid_to is null;
create trigger product_pricing_settings_set_updated_at before update on public.product_pricing_settings
for each row execute function app_private.set_updated_at();

-- A dated history makes delayed offline sales reconstructible after later setting changes.
create table public.organization_cash_discounts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cash_discount_bps integer not null check (cash_discount_bps between 0 and 9999),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (organization_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
);
create index organization_cash_discounts_current_idx on public.organization_cash_discounts(organization_id, valid_from desc) where valid_to is null;
insert into public.organization_cash_discounts(organization_id, cash_discount_bps, valid_from)
select id, 1000, now() from public.organizations;

alter table public.sale_items
  add column cash_discount_bps integer not null default 0 check (cash_discount_bps between 0 and 9999),
  add column cash_discount_cents bigint not null default 0 check (cash_discount_cents >= 0),
  add column promotion_discount_cents bigint not null default 0 check (promotion_discount_cents >= 0),
  add column cost_cents_snapshot bigint check (cost_cents_snapshot >= 0),
  add column profit_markup_bps_snapshot integer check (profit_markup_bps_snapshot between 0 and 100000);
update public.sale_items set promotion_discount_cents = discount_cents where discount_cents > 0;

create function app_private.round_ratio_half_up(p_numerator bigint, p_denominator bigint)
returns bigint language plpgsql immutable set search_path = '' as $$
begin
  if p_numerator < 0 or p_denominator <= 0 then raise exception 'Invalid monetary ratio' using errcode='22023'; end if;
  return (p_numerator + p_denominator / 2) / p_denominator;
end; $$;

create function public.calculate_product_price(p_cost_cents bigint, p_profit_markup_bps integer, p_cash_discount_bps integer)
returns table(target_cash_price_cents bigint, list_price_cents bigint, effective_cash_price_cents bigint)
language plpgsql immutable security definer set search_path = '' as $$
begin
  if p_cost_cents < 0 or p_profit_markup_bps not between 0 and 100000 or p_cash_discount_bps not between 0 and 9999 then
    raise exception 'Invalid price formation values' using errcode='22023';
  end if;
  target_cash_price_cents := app_private.round_ratio_half_up(p_cost_cents * (10000 + p_profit_markup_bps), 10000);
  list_price_cents := app_private.round_ratio_half_up(p_cost_cents * (10000 + p_profit_markup_bps), 10000 - p_cash_discount_bps);
  effective_cash_price_cents := app_private.round_ratio_half_up(list_price_cents * (10000 - p_cash_discount_bps), 10000);
  return next;
end; $$;

create function app_private.set_price_history(p_organization_id uuid, p_product_id uuid, p_price_cents bigint, p_effective_at timestamptz, p_actor uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare result_id uuid;
begin
  if p_price_cents <= 0 then raise exception 'Calculated price must be positive' using errcode='22023'; end if;
  update public.product_prices set valid_to=p_effective_at
    where organization_id=p_organization_id and product_id=p_product_id and branch_id is null
      and valid_from<p_effective_at and (valid_to is null or valid_to>p_effective_at);
  insert into public.product_prices(organization_id,product_id,branch_id,price_cents,valid_from,created_by)
  values(p_organization_id,p_product_id,null,p_price_cents,p_effective_at,p_actor) returning id into result_id;
  return result_id;
end; $$;

create function public.save_product_pricing(p_product_id uuid, p_cost_cents bigint, p_profit_markup_bps integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare org_id uuid:=app_private.require_permission('prices.write'); at_time timestamptz:=clock_timestamp(); cash_bps integer; calculated record; price_id uuid;
begin
  if p_cost_cents <= 0 or p_profit_markup_bps not between 0 and 100000 then raise exception 'Cost must be positive and profit must be between 0%% and 1000%%'
  using errcode='22023'; end if;
  if not exists(select 1 from public.products where id=p_product_id and organization_id=org_id) then raise exception 'Product was not found in this organization' using errcode='42501'; end if;
  select cash_discount_bps into cash_bps from public.organization_cash_discounts where organization_id=org_id and valid_from<=at_time and (valid_to is null or valid_to>at_time) order by valid_from desc limit 1;
  cash_bps:=coalesce(cash_bps,1000);
  update public.product_costs set valid_to=at_time where organization_id=org_id and product_id=p_product_id and valid_from<at_time and (valid_to is null or valid_to>at_time);
  insert into public.product_costs(organization_id,product_id,cost_cents,valid_from,created_by) values(org_id,p_product_id,p_cost_cents,at_time,auth.uid());
  update public.product_pricing_settings set valid_to=at_time where organization_id=org_id and product_id=p_product_id and valid_from<at_time and (valid_to is null or valid_to>at_time);
  insert into public.product_pricing_settings(organization_id,product_id,profit_markup_bps,updated_by,valid_from)
    values(org_id,p_product_id,p_profit_markup_bps,auth.uid(),at_time);
  select * into calculated from public.calculate_product_price(p_cost_cents,p_profit_markup_bps,cash_bps);
  price_id:=app_private.set_price_history(org_id,p_product_id,calculated.list_price_cents,at_time,auth.uid());
  return jsonb_build_object('priceId',price_id,'targetCashPriceCents',calculated.target_cash_price_cents::text,'listPriceCents',calculated.list_price_cents::text,'effectiveCashPriceCents',calculated.effective_cash_price_cents::text);
end; $$;

create function public.set_cash_discount_and_reprice(p_cash_discount_bps integer, p_confirm boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare org_id uuid:=app_private.require_permission('prices.write'); at_time timestamptz:=clock_timestamp(); old_bps integer; affected integer; skipped integer; row record; calculated record;
begin
  if p_cash_discount_bps not between 0 and 9999 then raise exception 'Cash discount must be between 0%% and 99.99%%' using errcode='22023'; end if;
  select cash_discount_bps into old_bps from public.organization_cash_discounts where organization_id=org_id and valid_to is null order by valid_from desc limit 1;
  select count(*) into affected from public.product_pricing_settings s where s.organization_id=org_id and s.valid_to is null and exists(select 1 from public.product_costs c where c.product_id=s.product_id and c.valid_to is null and c.cost_cents>0);
  select count(*) into skipped from public.products p where p.organization_id=org_id and p.active and not exists(select 1 from public.product_pricing_settings s join public.product_costs c on c.product_id=s.product_id and c.valid_to is null and c.cost_cents>0 where s.product_id=p.id and s.valid_to is null);
  if not p_confirm then return jsonb_build_object('requiresConfirmation',true,'affectedProducts',affected,'skippedProducts',skipped,'currentCashDiscountBps',coalesce(old_bps,1000)); end if;
  if coalesce(old_bps,1000)=p_cash_discount_bps then return jsonb_build_object('requiresConfirmation',false,'affectedProducts',0,'skippedProducts',skipped,'cashDiscountBps',p_cash_discount_bps,'unchanged',true); end if;
  update public.organization_cash_discounts set valid_to=at_time where organization_id=org_id and valid_to is null and valid_from<at_time;
  insert into public.organization_cash_discounts(organization_id,cash_discount_bps,valid_from,created_by) values(org_id,p_cash_discount_bps,at_time,auth.uid());
  for row in select s.product_id,s.profit_markup_bps,c.cost_cents from public.product_pricing_settings s join public.product_costs c on c.product_id=s.product_id and c.valid_to is null where s.organization_id=org_id and s.valid_to is null and c.cost_cents>0 loop
    select * into calculated from public.calculate_product_price(row.cost_cents,row.profit_markup_bps,p_cash_discount_bps);
    perform app_private.set_price_history(org_id,row.product_id,calculated.list_price_cents,at_time,auth.uid());
  end loop;
  return jsonb_build_object('requiresConfirmation',false,'affectedProducts',affected,'skippedProducts',skipped,'previousCashDiscountBps',coalesce(old_bps,1000),'cashDiscountBps',p_cash_discount_bps);
end; $$;

create function public.create_product_with_pricing(p_category_id uuid,p_name text,p_slug text,p_sku text,p_unit_type public.unit_type,p_active boolean,p_cost_cents bigint default null,p_profit_markup_bps integer default null)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare product_id uuid;
begin
 if (p_cost_cents is null)<>(p_profit_markup_bps is null) then raise exception 'Cost and target profit must be provided together' using errcode='22023'; end if;
 product_id:=public.save_product(null,p_category_id,p_name,p_slug,p_sku,p_unit_type,p_active);
 if p_cost_cents is not null then perform public.save_product_pricing(product_id,p_cost_cents,p_profit_markup_bps); end if;
 return product_id;
end; $$;

create trigger product_costs_audit after insert or update on public.product_costs for each row execute function app_private.audit_row_change();
create trigger product_pricing_settings_audit after insert or update on public.product_pricing_settings for each row execute function app_private.audit_row_change();
create trigger organization_cash_discounts_audit after insert or update on public.organization_cash_discounts for each row execute function app_private.audit_row_change();

alter table public.product_costs enable row level security;
alter table public.product_pricing_settings enable row level security;
alter table public.organization_cash_discounts enable row level security;
create policy product_costs_admin_select on public.product_costs for select to authenticated using(app_private.has_permission(organization_id,'prices.write'));
create policy product_pricing_settings_admin_select on public.product_pricing_settings for select to authenticated using(app_private.has_permission(organization_id,'prices.write'));
create policy organization_cash_discounts_admin_select on public.organization_cash_discounts for select to authenticated using(app_private.has_permission(organization_id,'prices.write'));
revoke all on table public.product_costs,public.product_pricing_settings,public.organization_cash_discounts from public,anon,authenticated;
grant select on table public.product_costs,public.product_pricing_settings,public.organization_cash_discounts to authenticated;
revoke all on function app_private.round_ratio_half_up(bigint,bigint),app_private.set_price_history(uuid,uuid,bigint,timestamptz,uuid) from public,anon,authenticated;
revoke all on function public.calculate_product_price(bigint,integer,integer),public.save_product_pricing(uuid,bigint,integer),public.set_cash_discount_and_reprice(integer,boolean),public.create_product_with_pricing(uuid,text,text,text,public.unit_type,boolean,bigint,integer) from public,anon;
grant execute on function public.calculate_product_price(bigint,integer,integer),public.save_product_pricing(uuid,bigint,integer),public.set_cash_discount_and_reprice(integer,boolean),public.create_product_with_pricing(uuid,text,text,text,public.unit_type,boolean,bigint,integer) to authenticated;

-- Percentage promotions now use the same half-up integer rule as every other monetary step.
create or replace function public.resolve_weight_discount(p_organization_id uuid,p_product_id uuid,p_branch_id uuid,p_grams integer,p_price_cents bigint,p_at timestamptz default now())
returns table(rule_id uuid,discount_type public.weight_discount_type,discount_value bigint,final_price_cents bigint)
language sql stable security definer set search_path='' as $$
  with candidate as (select d.id,d.discount_type,d.discount_value from public.product_weight_discounts d where d.organization_id=p_organization_id and d.product_id=p_product_id and (d.branch_id=p_branch_id or d.branch_id is null) and d.minimum_grams<=p_grams and d.active and d.valid_from<=p_at and (d.valid_until is null or d.valid_until>p_at) order by d.minimum_grams desc,(d.branch_id=p_branch_id) desc limit 1)
  select id,discount_type,discount_value,case when discount_type='PERCENTAGE' then app_private.round_ratio_half_up(p_price_cents*(10000-discount_value),10000) else discount_value end from candidate;
$$;

create or replace function public.get_pos_commercial_config(p_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare org_id uuid; at_time timestamptz:=now(); cash_bps integer;
begin
 select organization_id into org_id from public.branches where id=p_branch_id and active;
 if auth.uid() is null or org_id is null or not app_private.can_access_branch(org_id,p_branch_id,'sales.create') then raise exception 'Branch is not authorized for this user' using errcode='42501'; end if;
 select cash_discount_bps into cash_bps from public.organization_cash_discounts where organization_id=org_id and valid_from<=at_time and (valid_to is null or valid_to>at_time) order by valid_from desc limit 1;
 return jsonb_build_object('cashDiscountBps',coalesce(cash_bps,1000),
  'discounts',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'productId',d.product_id,'branchId',d.branch_id,'minimumGrams',d.minimum_grams,'discountType',d.discount_type,'discountValue',d.discount_value::text) order by d.product_id,d.minimum_grams) from public.product_weight_discounts d where d.organization_id=org_id and (d.branch_id=p_branch_id or d.branch_id is null) and d.active and d.valid_from<=at_time and (d.valid_until is null or d.valid_until>at_time)),'[]'::jsonb),
  'announcements',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'message',a.message,'type',a.type,'priority',a.priority,'branchId',a.branch_id) order by a.priority desc,a.starts_at desc) from public.announcements a where a.organization_id=org_id and (a.branch_id=p_branch_id or a.branch_id is null) and a.active and a.starts_at<=at_time and (a.ends_at is null or a.ends_at>at_time)),'[]'::jsonb));
end; $$;

create or replace function public.complete_discounted_sale(p_branch_id uuid,p_items jsonb,p_payment_method text)
returns table(sale_id uuid,total_cents bigint,total_weight_grams bigint,completed_at timestamptz)
language plpgsql volatile security definer set search_path='' as $$
declare profile_id uuid:=auth.uid(); org_id uuid; sale uuid; at_time timestamptz:=clock_timestamp(); item jsonb; product uuid; grams integer; expected_price bigint; expected_cash_bps integer; expected_final_price bigint; name text; list_price bigint; cash_price bigint; final_price bigint; promo record; list_subtotal bigint; cash_subtotal bigint; subtotal bigint; total bigint:=0; weight bigint:=0; method public.payment_method; cash_bps integer:=0; cost_snapshot bigint; profit_snapshot integer;
begin
 if profile_id is null or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Invalid sale' using errcode='22023'; end if;
 select organization_id into org_id from public.branches where id=p_branch_id and active;
 if org_id is null or not app_private.can_access_branch(org_id,p_branch_id,'sales.create') then raise exception 'Branch is not authorized for this user' using errcode='42501'; end if;
 method:=upper(p_payment_method)::public.payment_method;
 if method='CASH' then select cash_discount_bps into cash_bps from public.organization_cash_discounts where organization_id=org_id and valid_from<=at_time and (valid_to is null or valid_to>at_time) order by valid_from desc limit 1; cash_bps:=coalesce(cash_bps,1000); end if;
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

-- Canonical offline push accepts old envelopes and the new separated discount snapshots.
create or replace function public.sync_offline_sale(p_device_id uuid,p_event_id uuid,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 profile_id uuid:=auth.uid(); org_id uuid; branch_uuid uuid; device_status public.pos_device_status;
 payload_hash text:=encode(extensions.digest(convert_to(p_payload::text,'UTF8'),'sha256'),'hex'); receipt public.pos_sync_receipts%rowtype; inserted boolean;
 sale_id uuid; created_at timestamptz; completed_at timestamptz; declared_total bigint; declared_weight bigint; computed_total bigint:=0; computed_weight bigint:=0; method public.payment_method;
 item jsonb; movement jsonb; product_id uuid; grams integer; list_price bigint; cash_price bigint; final_price bigint; subtotal bigint;
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
   product_id:=(item->>'productId')::uuid; grams:=(item->>'weightGrams')::integer; final_price:=(item->>'pricePerKgCents')::bigint;
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
  if not exists(select 1 from public.products where id=product_id and organization_id=org_id and unit_type='WEIGHT') then raise exception 'Offline sale product does not belong to the device organization' using errcode='42501'; end if;
  if discount_rule is not null and not exists(select 1 from public.product_weight_discounts where id=discount_rule and organization_id=org_id and product_id=product_id) then raise exception 'Offline discount rule does not belong to the sale product' using errcode='42501'; end if;
  if (movement->>'productId')::uuid<>product_id or (movement->>'quantityGrams')::bigint<>-grams::bigint then raise exception 'Offline stock movement does not match its sale item' using errcode='22023'; end if;
  select c.cost_cents into cost_snapshot from public.product_costs c where c.organization_id=org_id and c.product_id=product_id and c.valid_from<=completed_at and (c.valid_to is null or c.valid_to>completed_at) order by c.valid_from desc limit 1;
  select s.profit_markup_bps into profit_snapshot from public.product_pricing_settings s where s.organization_id=org_id and s.product_id=product_id and s.valid_from<=completed_at and (s.valid_to is null or s.valid_to>completed_at) order by s.valid_from desc limit 1;
  insert into public.sale_items(id,sale_id,organization_id,branch_id,product_id,product_name_snapshot,weight_grams,price_per_kg_cents,original_price_per_kg_cents,discount_rule_id,discount_type,discount_value,final_price_per_kg_cents,discount_cents,cash_discount_bps,cash_discount_cents,promotion_discount_cents,cost_cents_snapshot,profit_markup_bps_snapshot,subtotal_cents,created_at)
  values((item->>'id')::uuid,sale_id,org_id,branch_uuid,product_id,item->>'productNameSnapshot',grams,final_price,list_price,discount_rule,discount_type,discount_value,final_price,discount_total,cash_bps,cash_discount,promo_discount,cost_snapshot,profit_snapshot,subtotal,completed_at);
  insert into public.stock_movements(id,organization_id,branch_id,product_id,type,quantity_grams,sale_id,profile_id,occurred_at,created_at)
  values((movement->>'id')::uuid,org_id,branch_uuid,product_id,'SALE',-grams::bigint,sale_id,profile_id,(movement->>'occurredAt')::timestamptz,completed_at);
  computed_total:=computed_total+subtotal; computed_weight:=computed_weight+grams;
 end loop;
 if computed_total<>declared_total or computed_weight<>declared_weight or (p_payload->'payment'->>'amountCents')::bigint<>declared_total then raise exception 'Offline sale totals do not match its details' using errcode='22023'; end if;
 update public.sales set total_cents=computed_total,total_weight_grams=computed_weight where id=sale_id;
 insert into public.payments(id,sale_id,organization_id,branch_id,method,amount_cents,created_at) values((p_payload->'payment'->>'id')::uuid,sale_id,org_id,branch_uuid,method,declared_total,completed_at);
 return jsonb_build_object('saleId',sale_id,'duplicate',false,'syncedAt',now());
end; $$;

create or replace function public.sync_discounted_offline_sale(p_device_id uuid,p_event_id uuid,p_payload jsonb)
returns jsonb language sql volatile security definer set search_path='' as $$ select public.sync_offline_sale(p_device_id,p_event_id,p_payload); $$;

revoke all on function public.resolve_weight_discount(uuid,uuid,uuid,integer,bigint,timestamptz) from public,anon,authenticated;
revoke all on function public.get_pos_commercial_config(uuid),public.complete_discounted_sale(uuid,jsonb,text),public.sync_offline_sale(uuid,uuid,jsonb),public.sync_discounted_offline_sale(uuid,uuid,jsonb) from public,anon;
grant execute on function public.get_pos_commercial_config(uuid),public.complete_discounted_sale(uuid,jsonb,text),public.sync_offline_sale(uuid,uuid,jsonb),public.sync_discounted_offline_sale(uuid,uuid,jsonb) to authenticated;

commit;
