begin;

create type public.weight_discount_type as enum ('PERCENTAGE', 'FIXED_PRICE_PER_KG');
create type public.announcement_type as enum ('INFO', 'WARNING', 'PROMOTION', 'STOCK', 'INTERNAL');

create table public.product_weight_discounts (
  id uuid primary key default extensions.gen_random_uuid(), organization_id uuid not null,
  product_id uuid not null, branch_id uuid, minimum_grams integer not null check (minimum_grams > 0),
  discount_type public.weight_discount_type not null, discount_value bigint not null check (discount_value > 0),
  active boolean not null default true, valid_from timestamptz not null default now(), valid_until timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict,
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  check (valid_until is null or valid_until > valid_from),
  check ((discount_type = 'PERCENTAGE' and discount_value between 1 and 10000)
    or (discount_type = 'FIXED_PRICE_PER_KG' and discount_value > 0))
);
create unique index product_weight_discounts_scope_threshold_active_idx
  on public.product_weight_discounts (organization_id, product_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), minimum_grams)
  where active;
create index product_weight_discounts_current_idx on public.product_weight_discounts (organization_id, product_id, branch_id, valid_from);
create trigger product_weight_discounts_set_updated_at before update on public.product_weight_discounts for each row execute function app_private.set_updated_at();

create table public.announcements (
  id uuid primary key default extensions.gen_random_uuid(), organization_id uuid not null, branch_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  message text not null check (char_length(btrim(message)) between 1 and 1000),
  type public.announcement_type not null default 'INFO', priority smallint not null default 0 check (priority between 0 and 3),
  starts_at timestamptz not null default now(), ends_at timestamptz, active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  check (ends_at is null or ends_at > starts_at)
);
create index announcements_pos_idx on public.announcements (organization_id, branch_id, starts_at) where active;
create trigger announcements_set_updated_at before update on public.announcements for each row execute function app_private.set_updated_at();

create table public.product_restock_events (
  id uuid primary key default extensions.gen_random_uuid(), organization_id uuid not null, branch_id uuid not null,
  product_id uuid not null, stock_movement_id uuid not null unique references public.stock_movements(id) on delete restrict,
  occurred_at timestamptz not null default now(), announcement_id uuid references public.announcements(id) on delete set null,
  foreign key (branch_id, organization_id) references public.branches(id, organization_id) on delete restrict,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete restrict
);
create index product_restock_events_recent_idx on public.product_restock_events (organization_id, branch_id, occurred_at desc);

alter table public.sale_items
  add column original_price_per_kg_cents bigint,
  add column discount_rule_id uuid references public.product_weight_discounts(id) on delete set null,
  add column discount_type public.weight_discount_type,
  add column discount_value bigint,
  add column final_price_per_kg_cents bigint,
  add column discount_cents bigint not null default 0 check (discount_cents >= 0);
update public.sale_items set original_price_per_kg_cents = price_per_kg_cents, final_price_per_kg_cents = price_per_kg_cents where original_price_per_kg_cents is null;
alter table public.sale_items alter column original_price_per_kg_cents set not null;
alter table public.sale_items alter column final_price_per_kg_cents set not null;

create function public.resolve_weight_discount(p_organization_id uuid, p_product_id uuid, p_branch_id uuid, p_grams integer, p_price_cents bigint, p_at timestamptz default now())
returns table (rule_id uuid, discount_type public.weight_discount_type, discount_value bigint, final_price_cents bigint)
language sql stable security definer set search_path = '' as $$
  with candidate as (
    select d.id, d.discount_type, d.discount_value
    from public.product_weight_discounts d
    where d.organization_id = p_organization_id and d.product_id = p_product_id
      and (d.branch_id = p_branch_id or d.branch_id is null) and d.minimum_grams <= p_grams
      and d.active and d.valid_from <= p_at and (d.valid_until is null or d.valid_until > p_at)
    order by d.minimum_grams desc, (d.branch_id = p_branch_id) desc
    limit 1
  ) select id, discount_type, discount_value,
    case when discount_type = 'PERCENTAGE' then p_price_cents * (10000 - discount_value) / 10000 else discount_value end
  from candidate;
$$;

create function app_private.log_commercial_change() returns trigger language plpgsql security definer set search_path = '' as $$
declare r jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.pos_catalog_changes(organization_id, branch_id, entity_type, entity_id)
  values ((r ->> 'organization_id')::uuid, nullif(r ->> 'branch_id','')::uuid,
    case when tg_table_name = 'product_weight_discounts' then 'DISCOUNT' else 'ANNOUNCEMENT' end, (r ->> 'id')::uuid);
  return case when tg_op = 'DELETE' then old else new end;
end; $$;
alter table public.pos_catalog_changes drop constraint pos_catalog_changes_entity_type_check;
alter table public.pos_catalog_changes add constraint pos_catalog_changes_entity_type_check check (entity_type in ('BRANCH','CATEGORY','PRODUCT','PRICE','DISCOUNT','ANNOUNCEMENT'));
create trigger product_weight_discounts_log_pos_change after insert or update or delete on public.product_weight_discounts for each row execute function app_private.log_commercial_change();
create trigger announcements_log_pos_change after insert or update or delete on public.announcements for each row execute function app_private.log_commercial_change();

create function app_private.log_restock_event() returns trigger language plpgsql security definer set search_path = '' as $$
declare previous_stock bigint;
begin
  if new.quantity_grams <= 0 then return new; end if;
  select coalesce(sum(quantity_grams), 0) - new.quantity_grams into previous_stock
  from public.stock_movements where organization_id = new.organization_id and branch_id = new.branch_id and product_id = new.product_id;
  if previous_stock <= 0 then
    insert into public.product_restock_events(organization_id, branch_id, product_id, stock_movement_id, occurred_at)
    values(new.organization_id, new.branch_id, new.product_id, new.id, new.occurred_at);
  end if;
  return new;
end; $$;
create trigger stock_movements_log_restock after insert on public.stock_movements for each row execute function app_private.log_restock_event();

create or replace view public.branch_stock_status with (security_invoker = true) as
select b.organization_id, b.id branch_id, b.name branch_name, p.id product_id, p.name product_name, p.sku,
  coalesce(sl.quantity_grams, 0)::bigint current_stock_grams, coalesce(s.minimum_stock_grams, 0)::bigint minimum_stock_grams,
  coalesce(s.target_stock_grams, 0)::bigint target_stock_grams,
  greatest(coalesce(s.target_stock_grams,0)-coalesce(sl.quantity_grams,0),0)::bigint suggested_replenishment_grams,
  case when not p.active then 'DISCONTINUED' when coalesce(sl.quantity_grams,0) <= 0 then 'OUT_OF_STOCK'
       when coalesce(sl.quantity_grams,0) < coalesce(s.minimum_stock_grams,0) then 'LOW_STOCK' else 'AVAILABLE' end stock_status,
  sl.last_movement_at
from public.branches b join public.products p on p.organization_id=b.organization_id and p.unit_type='WEIGHT'
left join public.stock_levels sl on sl.organization_id=b.organization_id and sl.branch_id=b.id and sl.product_id=p.id
left join public.branch_product_stock_settings s on s.organization_id=b.organization_id and s.branch_id=b.id and s.product_id=p.id
where b.active;

create function public.save_weight_discount(p_id uuid, p_product_id uuid, p_branch_id uuid, p_minimum_grams integer, p_discount_type text, p_discount_value bigint, p_active boolean, p_valid_from timestamptz, p_valid_until timestamptz default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare org_id uuid := app_private.require_permission('catalog.write'); result_id uuid;
begin
  if not exists(select 1 from public.products where id=p_product_id and organization_id=org_id and unit_type='WEIGHT') then raise exception 'Weight product not found' using errcode='42501'; end if;
  if p_branch_id is not null and not exists(select 1 from public.branches where id=p_branch_id and organization_id=org_id) then raise exception 'Branch not found' using errcode='42501'; end if;
  insert into public.product_weight_discounts(id,organization_id,product_id,branch_id,minimum_grams,discount_type,discount_value,active,valid_from,valid_until)
  values(coalesce(p_id,extensions.gen_random_uuid()),org_id,p_product_id,p_branch_id,p_minimum_grams,p_discount_type::public.weight_discount_type,p_discount_value,p_active,coalesce(p_valid_from,now()),p_valid_until)
  on conflict(id) do update set branch_id=excluded.branch_id,minimum_grams=excluded.minimum_grams,discount_type=excluded.discount_type,discount_value=excluded.discount_value,active=excluded.active,valid_from=excluded.valid_from,valid_until=excluded.valid_until where public.product_weight_discounts.organization_id=org_id
  returning id into result_id; return result_id;
end; $$;
create function public.save_announcement(p_id uuid, p_branch_id uuid, p_title text, p_message text, p_type text, p_priority smallint, p_active boolean, p_starts_at timestamptz, p_ends_at timestamptz default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare org_id uuid := app_private.require_permission('catalog.write'); result_id uuid;
begin
  if p_branch_id is not null and not exists(select 1 from public.branches where id=p_branch_id and organization_id=org_id) then raise exception 'Branch not found' using errcode='42501'; end if;
  insert into public.announcements(id,organization_id,branch_id,title,message,type,priority,active,starts_at,ends_at,created_by)
  values(coalesce(p_id,extensions.gen_random_uuid()),org_id,p_branch_id,p_title,p_message,p_type::public.announcement_type,p_priority,p_active,coalesce(p_starts_at,now()),p_ends_at,auth.uid())
  on conflict(id) do update set branch_id=excluded.branch_id,title=excluded.title,message=excluded.message,type=excluded.type,priority=excluded.priority,active=excluded.active,starts_at=excluded.starts_at,ends_at=excluded.ends_at where public.announcements.organization_id=org_id
  returning id into result_id; return result_id;
end; $$;
create function public.publish_restock_announcement(p_restock_event_id uuid, p_title text, p_message text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare org_id uuid := app_private.require_permission('stock.write'); event public.product_restock_events%rowtype; result_id uuid;
begin
 select * into event from public.product_restock_events where id=p_restock_event_id and organization_id=org_id; if not found then raise exception 'Restock event not found' using errcode='42501'; end if;
 select public.save_announcement(null,event.branch_id,p_title,p_message,'STOCK',1,true,now(),null) into result_id;
 update public.product_restock_events set announcement_id=result_id where id=event.id; return result_id;
end; $$;

alter table public.product_weight_discounts enable row level security;
alter table public.announcements enable row level security;
alter table public.product_restock_events enable row level security;
create policy weight_discounts_admin_select on public.product_weight_discounts for select to authenticated using(app_private.has_permission(organization_id,'catalog.write'));
create policy announcements_admin_select on public.announcements for select to authenticated using(app_private.has_permission(organization_id,'catalog.write'));
create policy restock_events_admin_select on public.product_restock_events for select to authenticated using(app_private.has_permission(organization_id,'stock.read'));
revoke all on table public.product_weight_discounts, public.announcements, public.product_restock_events from public, anon, authenticated;
grant select on table public.product_weight_discounts, public.announcements, public.product_restock_events to authenticated;
revoke all on function public.resolve_weight_discount(uuid,uuid,uuid,integer,bigint,timestamptz), app_private.log_commercial_change(), app_private.log_restock_event() from public, anon, authenticated;
revoke all on function public.save_weight_discount(uuid,uuid,uuid,integer,text,bigint,boolean,timestamptz,timestamptz), public.save_announcement(uuid,uuid,text,text,text,smallint,boolean,timestamptz,timestamptz), public.publish_restock_announcement(uuid,text,text) from public, anon;
grant execute on function public.save_weight_discount(uuid,uuid,uuid,integer,text,bigint,boolean,timestamptz,timestamptz), public.save_announcement(uuid,uuid,text,text,text,smallint,boolean,timestamptz,timestamptz), public.publish_restock_announcement(uuid,text,text) to authenticated;

create function public.get_pos_commercial_config(p_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org_id uuid; at_time timestamptz := now();
begin
 select organization_id into org_id from public.branches where id=p_branch_id and active;
 if auth.uid() is null or org_id is null or not app_private.can_access_branch(org_id,p_branch_id,'sales.create') then raise exception 'Branch is not authorized for this user' using errcode='42501'; end if;
 return jsonb_build_object(
  'discounts', coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'productId',d.product_id,'branchId',d.branch_id,'minimumGrams',d.minimum_grams,'discountType',d.discount_type,'discountValue',d.discount_value::text) order by d.product_id,d.minimum_grams)
    from public.product_weight_discounts d where d.organization_id=org_id and (d.branch_id=p_branch_id or d.branch_id is null) and d.active and d.valid_from<=at_time and (d.valid_until is null or d.valid_until>at_time)),'[]'::jsonb),
  'announcements', coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'message',a.message,'type',a.type,'priority',a.priority,'branchId',a.branch_id) order by a.priority desc,a.starts_at desc)
    from public.announcements a where a.organization_id=org_id and (a.branch_id=p_branch_id or a.branch_id is null) and a.active and a.starts_at<=at_time and (a.ends_at is null or a.ends_at>at_time)),'[]'::jsonb));
end; $$;

create function public.complete_discounted_sale(p_branch_id uuid, p_items jsonb, p_payment_method text)
returns table(sale_id uuid,total_cents bigint,total_weight_grams bigint,completed_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare profile_id uuid:=auth.uid(); org_id uuid; sale uuid; at_time timestamptz:=now(); item jsonb; product uuid; grams integer; expected_price bigint; name text; base_price bigint; final_price bigint; discount record; subtotal bigint; total bigint:=0; weight bigint:=0; method public.payment_method;
begin
 if profile_id is null or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Invalid sale' using errcode='22023'; end if;
 select organization_id into org_id from public.branches where id=p_branch_id and active;
 if org_id is null or not app_private.can_access_branch(org_id,p_branch_id,'sales.create') then raise exception 'Branch is not authorized for this user' using errcode='42501'; end if;
 method:=upper(p_payment_method)::public.payment_method;
 insert into public.sales(organization_id,branch_id,profile_id,status,total_cents,total_weight_grams,completed_at) values(org_id,p_branch_id,profile_id,'COMPLETED',0,0,at_time) returning id into sale;
 for item in select value from jsonb_array_elements(p_items) loop
  product:=(item->>'product_id')::uuid; grams:=(item->>'weight_grams')::integer; expected_price:=(item->>'expected_price_per_kg_cents')::bigint;
  if grams<=0 then raise exception 'Invalid weight' using errcode='22023'; end if;
  select p.name,pp.price_cents into name,base_price from public.products p join lateral(select price_cents from public.product_prices where organization_id=org_id and product_id=p.id and (branch_id=p_branch_id or branch_id is null) and valid_from<=at_time and (valid_to is null or valid_to>at_time) order by (branch_id=p_branch_id) desc,valid_from desc limit 1) pp on true where p.id=product and p.organization_id=org_id and p.active and p.unit_type='WEIGHT';
  if not found or base_price<>expected_price then raise exception 'Product price changed; reload and retry' using errcode='40001'; end if;
  select * into discount from public.resolve_weight_discount(org_id,product,p_branch_id,grams,base_price,at_time); final_price:=coalesce(discount.final_price_cents,base_price); subtotal:=(final_price*grams+500)/1000;
  insert into public.sale_items(sale_id,organization_id,branch_id,product_id,product_name_snapshot,weight_grams,price_per_kg_cents,original_price_per_kg_cents,discount_rule_id,discount_type,discount_value,final_price_per_kg_cents,discount_cents,subtotal_cents,created_at)
  values(sale,org_id,p_branch_id,product,name,grams,final_price,base_price,discount.rule_id,discount.discount_type,discount.discount_value,final_price,(base_price*grams+500)/1000-subtotal,subtotal,at_time);
  insert into public.stock_movements(organization_id,branch_id,product_id,type,quantity_grams,sale_id,profile_id,occurred_at,created_at) values(org_id,p_branch_id,product,'SALE',-grams,sale,profile_id,at_time,at_time);
  total:=total+subtotal; weight:=weight+grams;
 end loop;
 update public.sales set total_cents=total,total_weight_grams=weight where id=sale;
 insert into public.payments(sale_id,organization_id,branch_id,method,amount_cents,created_at) values(sale,org_id,p_branch_id,method,total,at_time);
 return query select sale,total,weight,at_time;
end; $$;
revoke all on function public.get_pos_commercial_config(uuid),public.complete_discounted_sale(uuid,jsonb,text) from public,anon;
grant execute on function public.get_pos_commercial_config(uuid),public.complete_discounted_sale(uuid,jsonb,text) to authenticated;

commit;
