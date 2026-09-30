begin;

-- Read-only stock projection for the POS catalog screen ("disponible" vs "sin stock").
--
-- The POS had no per-branch stock locally (only its own pending sale movements), so it could
-- not tell which catalog products a branch actually holds. This RPC exposes the existing
-- ledger sum (stock_movements.quantity_grams, same arithmetic as stock_levels /
-- get_branch_stock_status) for ONE branch; it does not create a second stock model, change
-- movements, or alter any stock calculation. For a UNIT product quantity_grams counts units
-- (same convention as the rest of the ledger, see D-038/D-042).
--
-- SECURITY DEFINER because an operator role without stock.read must still be able to learn
-- whether a product is sellable; authorization mirrors get_pos_catalog (same branch +
-- 'sales.create' gate), so the caller can only read the branch they are allowed to sell in.
--
-- Returns jsonb { serverTime, branchId, items: [{ productId, quantityGrams (text) }] }.
-- Quantities are signed and unclamped (negative stock is a real ledger state); the POS decides
-- availability with `quantityGrams > 0` on the real value. Products with no movements in the
-- branch are simply absent (the POS treats absence as zero).
create function public.get_pos_branch_stock(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid;
  stock_items jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', s.product_id, 'quantityGrams', s.quantity_grams::text
  ) order by s.product_id), '[]'::jsonb)
  into stock_items
  from (
    select sm.product_id, sum(sm.quantity_grams)::bigint as quantity_grams
    from public.stock_movements sm
    where sm.organization_id = current_organization_id and sm.branch_id = p_branch_id
    group by sm.product_id
  ) s;

  return jsonb_build_object('serverTime', now(), 'branchId', p_branch_id, 'items', stock_items);
end;
$$;

revoke all on function public.get_pos_branch_stock(uuid) from public, anon;
grant execute on function public.get_pos_branch_stock(uuid) to authenticated;

commit;
