begin;

-- Shared POS recent sales. The existing offline outbox remains the only write path: this migration
-- adds a device-scoped read model over the already immutable sale/item/payment snapshots.

alter table public.sales
  add column operator_name_snapshot text check (operator_name_snapshot is null or char_length(btrim(operator_name_snapshot)) between 1 and 120),
  add column branch_name_snapshot text check (branch_name_snapshot is null or char_length(btrim(branch_name_snapshot)) between 1 and 120);

-- Older rows did not retain these two display strings. Preserve the best historical representation
-- available at rollout time; all new rows are captured at sale creation and never rebuilt from catalog data.
update public.sales s
set operator_name_snapshot = p.display_name
from public.profiles p
where s.operator_name_snapshot is null and p.id = s.profile_id;

update public.sales s
set branch_name_snapshot = b.name
from public.branches b
where s.branch_name_snapshot is null and b.id = s.branch_id and b.organization_id = s.organization_id;

create index sales_branch_completed_recent_idx
  on public.sales (organization_id, branch_id, completed_at desc, id desc)
  where completed_at is not null;

create function app_private.snapshot_sale_receipt_names()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.operator_name_snapshot is null then
    select p.display_name into new.operator_name_snapshot
    from public.profiles p where p.id = new.profile_id;
  end if;
  if new.branch_name_snapshot is null then
    select b.name into new.branch_name_snapshot
    from public.branches b
    where b.id = new.branch_id and b.organization_id = new.organization_id;
  end if;
  return new;
end;
$$;

create trigger sales_snapshot_sale_receipt_names
before insert on public.sales
for each row execute function app_private.snapshot_sale_receipt_names();

-- Operator-mode sync creates the sale under the technical auth user and immediately assigns the
-- employee. Replace the provisional name exactly once during that handoff; retries leave the first
-- immutable employee snapshot unchanged.
create or replace function public.sync_pos_operator_offline_sale(
  p_device_id uuid,p_event_id uuid,p_payload jsonb,p_operator_profile_id uuid,p_operator_token text
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare access record; delegated jsonb; result jsonb; sale_uuid uuid; occurred timestamptz; operator_name text;
begin
  occurred:=(p_payload->>'completedAt')::timestamptz;
  select * into access from app_private.resolve_pos_operator(p_device_id,p_operator_profile_id,p_operator_token,occurred);
  if (p_payload->>'profileId')::uuid<>p_operator_profile_id then raise exception 'Sale operator does not match its authorization' using errcode='42501'; end if;
  delegated:=jsonb_set(p_payload,'{profileId}',to_jsonb(auth.uid()::text));
  result:=public.sync_offline_sale(p_device_id,p_event_id,delegated);
  sale_uuid:=(result->>'saleId')::uuid;
  select display_name into operator_name from public.profiles where id = p_operator_profile_id;
  update public.sales s
  set profile_id=p_operator_profile_id,
      operator_name_snapshot=case when s.profile_id is distinct from p_operator_profile_id then operator_name else s.operator_name_snapshot end
  where s.id=sale_uuid and s.organization_id=access.organization_id and s.branch_id=access.branch_id;
  update public.stock_movements set profile_id=p_operator_profile_id where sale_id=sale_uuid and organization_id=access.organization_id;
  return result;
end;
$$;

-- The device resolves its own organization and branch on the server. The client never supplies a
-- branch id, so a compromised terminal cannot browse another branch by changing a parameter.
create function public.get_pos_recent_sales(p_device_id uuid, p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  current_branch_id uuid;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'Limit must be between 1 and 50' using errcode = '22023'; end if;

  select d.organization_id, d.branch_id into current_organization_id, current_branch_id
  from public.pos_devices d where d.id = p_device_id and d.status = 'ACTIVE';
  if current_organization_id is null or not app_private.can_access_branch(current_organization_id, current_branch_id, 'sales.create') then
    raise exception 'Device is not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object('sales', coalesce(jsonb_agg(jsonb_build_object(
    'saleId', r.id,
    'status', r.status,
    'totalCents', r.total_cents::text,
    'totalWeightGrams', r.total_weight_grams::text,
    'completedAt', r.completed_at,
    'syncedAt', r.completed_at,
    'provider', r.provider,
    'verificationStatus', r.verification_status,
    'terminalLabel', r.terminal_label
  ) order by r.completed_at desc, r.id desc), '[]'::jsonb))
  into result
  from (
    select s.id, s.status::text as status, s.total_cents, s.total_weight_grams, s.completed_at,
      pay.provider, pay.verification_status, device.label as terminal_label
    from public.sales s
    left join lateral (
      select p.provider, p.verification_status
      from public.payments p
      where p.sale_id = s.id and p.organization_id = s.organization_id and p.branch_id = s.branch_id
      order by p.created_at, p.id limit 1
    ) pay on true
    left join public.pos_devices device on device.id = s.device_id
    where s.organization_id = current_organization_id and s.branch_id = current_branch_id and s.completed_at is not null
    order by s.completed_at desc, s.id desc
    limit p_limit
  ) r;
  return result;
end;
$$;

create function public.get_pos_sale_receipt(p_device_id uuid, p_sale_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  current_branch_id uuid;
  sale_row record;
  payment_row record;
  item_rows jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select d.organization_id, d.branch_id into current_organization_id, current_branch_id
  from public.pos_devices d where d.id = p_device_id and d.status = 'ACTIVE';
  if current_organization_id is null or not app_private.can_access_branch(current_organization_id, current_branch_id, 'sales.create') then
    raise exception 'Device is not authorized' using errcode = '42501';
  end if;

  select s.id, s.status::text as status, s.completed_at, s.total_cents, s.ticket_discount_bps, s.ticket_discount_cents,
    coalesce(s.branch_name_snapshot, b.name) as branch_name,
    coalesce(s.operator_name_snapshot, profile.display_name) as operator_name
  into sale_row
  from public.sales s
  join public.branches b on b.id = s.branch_id and b.organization_id = s.organization_id
  left join public.profiles profile on profile.id = s.profile_id
  where s.id = p_sale_id and s.organization_id = current_organization_id and s.branch_id = current_branch_id;
  if not found then return null; end if;

  select p.method::text as method, p.provider, p.verification_status
  into payment_row
  from public.payments p
  where p.sale_id = sale_row.id and p.organization_id = current_organization_id and p.branch_id = current_branch_id
  order by p.created_at, p.id limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'productName', si.product_name_snapshot,
    'weightGrams', si.weight_grams,
    'quantityUnits', si.quantity_units,
    'chargedPriceCents', si.price_per_kg_cents::text,
    'originalPriceCents', coalesce(si.original_price_per_kg_cents, si.price_per_kg_cents)::text,
    'subtotalCents', si.subtotal_cents::text,
    'promotionDiscountCents', coalesce(si.promotion_discount_cents, 0)::text,
    'cardSurchargeCents', coalesce(si.card_surcharge_cents, 0)::text,
    'promotionMode', si.promotion_mode::text,
    'discountType', si.discount_type::text,
    'discountValue', si.discount_value,
    'manualPriceApplied', coalesce(si.manual_price_applied, false),
    'manualUnitPriceCents', case when si.manual_unit_price_cents is null then null else si.manual_unit_price_cents::text end,
    'soldAsPack', coalesce(si.sold_as_pack, false),
    'packCount', si.pack_count,
    'packSizeUnitsSnapshot', si.pack_size_units_snapshot,
    'packDiscountBps', si.pack_discount_bps,
    'branchPromotionMinimumUnits', si.branch_promotion_every_units,
    'branchPromotionDiscountBps', si.branch_promotion_discount_bps
  ) order by si.created_at, si.id), '[]'::jsonb)
  into item_rows
  from public.sale_items si
  where si.sale_id = sale_row.id and si.organization_id = current_organization_id and si.branch_id = current_branch_id;

  return jsonb_build_object(
    'saleId', sale_row.id,
    'status', sale_row.status,
    'completedAt', sale_row.completed_at,
    'branchName', sale_row.branch_name,
    'operatorName', sale_row.operator_name,
    'totalCents', sale_row.total_cents::text,
    'ticketDiscountBps', coalesce(sale_row.ticket_discount_bps, 0),
    'ticketDiscountCents', coalesce(sale_row.ticket_discount_cents, 0)::text,
    'payment', case when payment_row.method is null then null else jsonb_build_object(
      'method', payment_row.method, 'provider', payment_row.provider, 'verificationStatus', payment_row.verification_status
    ) end,
    'items', item_rows
  );
end;
$$;

revoke all on function public.get_pos_recent_sales(uuid, integer) from public, anon;
revoke all on function public.get_pos_sale_receipt(uuid, uuid) from public, anon;
grant execute on function public.get_pos_recent_sales(uuid, integer) to authenticated;
grant execute on function public.get_pos_sale_receipt(uuid, uuid) to authenticated;

commit;
