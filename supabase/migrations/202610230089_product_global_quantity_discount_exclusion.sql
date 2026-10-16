-- Per-product opt-out for the organization-wide UNIT quantity tiers. Existing products keep
-- the historical behaviour; sales retain their line snapshots and are never rewritten.
alter table public.products
  add column global_quantity_discounts_enabled boolean not null default true;

comment on column public.products.global_quantity_discounts_enabled is
  'When false, this UNIT product does not participate in branch/organization global quantity tiers. Product-specific promotions and packs are unaffected.';

create function public.set_product_global_quantity_discounts_enabled(p_product_id uuid, p_enabled boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
begin
  update public.products
  set global_quantity_discounts_enabled = coalesce(p_enabled, true)
  where id = p_product_id and organization_id = current_organization_id;
  if not found then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.set_product_global_quantity_discounts_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_product_global_quantity_discounts_enabled(uuid, boolean) to authenticated;

-- Keep the existing pull implementation intact and wrap its JSON. Older Rust clients deserialize
-- this added catalog key permissively; Central 021 persists it. The product update already writes a
-- PRODUCT catalog change through products_log_pos_change, so this arrives on the normal delta pull.
alter function public.pull_pos_state(uuid, bigint) rename to pull_pos_state_base;

create function public.pull_pos_state(p_device_id uuid, p_after_sequence bigint default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  state jsonb := public.pull_pos_state_base(p_device_id, p_after_sequence);
  catalog jsonb;
begin
  select coalesce(jsonb_agg(
    jsonb_set(entry.value, '{globalQuantityDiscountsEnabled}', to_jsonb(coalesce(p.global_quantity_discounts_enabled, true)), true)
  ), '[]'::jsonb)
  into catalog
  from jsonb_array_elements(coalesce(state -> 'catalog', '[]'::jsonb)) as entry(value)
  join public.products p on p.id = (entry.value ->> 'productId')::uuid;

  return jsonb_set(state, '{catalog}', catalog, true);
end;
$$;

revoke all on function public.pull_pos_state(uuid, bigint) from public, anon;
grant execute on function public.pull_pos_state(uuid, bigint) to authenticated;
