begin;

-- Manual pricing: the sale price becomes a direct, manual decision (competitor-driven, changed
-- whenever the business wants), never derived from cost + markup. Cost becomes the derived side:
-- automatically from a completed Desposte batch (see 202609220029) or, for finished products
-- bought ready-made, entered directly here with no markup involved. product_prices stays exactly
-- as it is (public.set_product_price, defined in 202609100007, already does manual price-setting
-- with vigencia and global/branch scope) — this migration only adds what was missing: a
-- cost-only write path, an atomic bulk price editor, and a cash-discount setter that does not
-- reprice anything. public.save_product_pricing/calculate_product_price/
-- set_cash_discount_and_reprice (202609130012) are left untouched in the database (history,
-- D-005): the Admin UI simply stops calling them.

-- Sets a product's current cost directly, with no markup and no effect on product_prices. Used
-- for products bought already finished (not produced by Desposte, which instead feeds
-- product_costs automatically on complete_production_batch).
create function public.set_product_cost(
  p_product_id uuid,
  p_cost_cents bigint,
  p_effective_at timestamptz default now()
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  current_cost_id uuid;
begin
  if p_effective_at < now() - interval '5 minutes' then
    raise exception 'A new cost cannot start in the historical past' using errcode = '22023';
  end if;
  if p_cost_cents is null or p_cost_cents <= 0 then
    raise exception 'Cost must be positive' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.products p
    where p.id = p_product_id and p.organization_id = current_organization_id
  ) then
    raise exception 'Product was not found in this organization' using errcode = '42501';
  end if;

  update public.product_costs pc
  set valid_to = p_effective_at
  where pc.organization_id = current_organization_id
    and pc.product_id = p_product_id
    and pc.valid_from < p_effective_at
    and (pc.valid_to is null or pc.valid_to > p_effective_at);

  insert into public.product_costs (organization_id, product_id, cost_cents, valid_from, created_by)
  values (current_organization_id, p_product_id, p_cost_cents, p_effective_at, auth.uid())
  returning id into current_cost_id;

  return current_cost_id;
end;
$$;

-- Atomic bulk price editor for "Productos → Precios": validates every item up front (clear error
-- naming the offending product), then applies each one through the existing public.set_product_price
-- (same vigencia/history semantics, one row per product). A single PL/pgSQL function call is one
-- Postgres statement/transaction: an exception at any point — validation or mid-apply — rolls back
-- every write this call already made, so a bad row never leaves a partial update applied silently.
create function public.bulk_set_product_prices(
  p_items jsonb,
  p_branch_id uuid default null,
  p_effective_at timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  item jsonb;
  product_id uuid;
  price_cents bigint;
  product_name text;
  applied integer := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'Debe enviar entre 1 y 500 precios' using errcode = '22023';
  end if;
  if p_branch_id is not null and not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;

  -- Validate every item before writing anything, so the error names the offending product instead
  -- of a generic failure partway through.
  for item in select * from jsonb_array_elements(p_items)
  loop
    product_id := (item ->> 'productId')::uuid;
    price_cents := (item ->> 'priceCents')::bigint;
    if price_cents is null or price_cents <= 0 then
      raise exception 'El precio debe ser mayor a cero' using errcode = '22023';
    end if;
    select p.name into product_name from public.products p
    where p.id = product_id and p.organization_id = current_organization_id and p.active
      and p.inventory_role in ('SELLABLE', 'BOTH');
    if not found then
      raise exception 'Uno de los productos enviados no existe, está inactivo o no es un producto de venta' using errcode = '42501';
    end if;
  end loop;

  for item in select * from jsonb_array_elements(p_items)
  loop
    perform public.set_product_price(
      (item ->> 'productId')::uuid,
      p_branch_id,
      (item ->> 'priceCents')::bigint,
      p_effective_at
    );
    applied := applied + 1;
  end loop;

  return jsonb_build_object('applied', applied);
end;
$$;

-- Sets the organization-wide payment-method discount percentage without repricing any product.
-- Replaces set_cash_discount_and_reprice (202609130012) as the write path the UI calls: that RPC
-- is left in the database untouched (D-005/history), it is simply no longer invoked, since its
-- reprice loop would silently overwrite manually-set list prices — exactly what this sprint
-- removes. The discount percentage itself is still read the same way by
-- complete_discounted_sale/get_pos_commercial_config (organization_cash_discounts, unchanged).
create function public.set_cash_discount(p_cash_discount_bps integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('prices.write');
  at_time timestamptz := clock_timestamp();
  previous_bps integer;
begin
  if p_cash_discount_bps not between 0 and 9999 then
    raise exception 'Cash discount must be between 0%% and 99.99%%' using errcode = '22023';
  end if;
  select cash_discount_bps into previous_bps
  from public.organization_cash_discounts
  where organization_id = current_organization_id and valid_to is null
  order by valid_from desc limit 1;

  if coalesce(previous_bps, 1000) = p_cash_discount_bps then
    return jsonb_build_object('cashDiscountBps', p_cash_discount_bps, 'unchanged', true);
  end if;

  update public.organization_cash_discounts
  set valid_to = at_time
  where organization_id = current_organization_id and valid_to is null and valid_from < at_time;

  insert into public.organization_cash_discounts (organization_id, cash_discount_bps, valid_from, created_by)
  values (current_organization_id, p_cash_discount_bps, at_time, auth.uid());

  return jsonb_build_object('previousCashDiscountBps', coalesce(previous_bps, 1000), 'cashDiscountBps', p_cash_discount_bps);
end;
$$;

revoke all on function
  public.set_product_cost(uuid, bigint, timestamptz),
  public.bulk_set_product_prices(jsonb, uuid, timestamptz),
  public.set_cash_discount(integer)
from public, anon;

grant execute on function
  public.set_product_cost(uuid, bigint, timestamptz),
  public.bulk_set_product_prices(jsonb, uuid, timestamptz),
  public.set_cash_discount(integer)
to authenticated;

commit;
