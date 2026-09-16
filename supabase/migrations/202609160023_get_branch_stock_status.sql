begin;

-- branch_stock_status is security_invoker; stock_levels aggregates stock_movements,
-- and stock_movements RLS runs app_private.can_access_branch() once per ledger row
-- before the view's GROUP BY collapses it to branch x product. That ledger grows
-- forever (it is the stock source of truth, see D-010), so the per-row permission
-- check dominates /admin, /admin/branches and /admin/stock (measured 1.1-2.2s
-- locally with ~2k stock_movements rows).
--
-- get_replenishment_plan already solves the same class of problem: it is
-- SECURITY DEFINER (owned by postgres, which has BYPASSRLS), checks
-- app_private.require_permission() once, then applies
-- app_private.can_access_branch() only to the small `branches` row it is
-- driving from -- not to every fact-table row. This function follows the same
-- pattern for stock status: one authorization check per branch (a handful of
-- rows) instead of one per stock_movements row (unbounded, ever-growing).
--
-- Only the 'admin' role currently reaches the pages that call this function,
-- and 'admin' holds every permission (see 202609100001), including
-- 'branches.read_all'. can_access_branch(org, branch, 'stock.read') is
-- therefore always true for any active branch in the caller's organization
-- for that role, so the result set is identical to what branch_stock_status
-- already returns for today's only caller. For any future, more restricted
-- role, this function is stricter than the view ever was: the view's own
-- `branches` RLS policy did not require 'stock.read' at all (only
-- 'branches.read_all' or branch membership), so a caller without 'stock.read'
-- could see branch/product rows with current_stock_grams silently coerced to
-- 0 by the LEFT JOIN. This function omits such a row entirely instead,
-- which is a tightening, not a weakening, of who sees what.
--
-- branch_stock_status is NOT dropped: /admin/attention, /admin/branches/compare
-- and the branch detail view (components/branch-detail.tsx) still read it
-- directly and are out of scope for this change.
create function public.get_branch_stock_status(p_branch_id uuid default null)
returns table (
  branch_id uuid,
  branch_name text,
  product_id uuid,
  product_name text,
  current_stock_grams bigint,
  minimum_stock_grams bigint,
  target_stock_grams bigint,
  suggested_replenishment_grams bigint,
  stock_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('stock.read');
begin
  return query
  select
    b.id,
    b.name,
    p.id,
    p.name,
    coalesce(sl.quantity_grams, 0)::bigint,
    coalesce(s.minimum_stock_grams, 0)::bigint,
    coalesce(s.target_stock_grams, 0)::bigint,
    greatest(coalesce(s.target_stock_grams, 0) - coalesce(sl.quantity_grams, 0), 0)::bigint,
    case
      when not p.active then 'DISCONTINUED'
      when coalesce(sl.quantity_grams, 0) <= 0 then 'OUT_OF_STOCK'
      when coalesce(sl.quantity_grams, 0) < coalesce(s.minimum_stock_grams, 0) then 'LOW_STOCK'
      else 'AVAILABLE'
    end
  from public.branches b
  join public.products p
    on p.organization_id = b.organization_id
   and p.unit_type = 'WEIGHT'
  left join public.stock_levels sl
    on sl.organization_id = b.organization_id
   and sl.branch_id = b.id
   and sl.product_id = p.id
  left join public.branch_product_stock_settings s
    on s.organization_id = b.organization_id
   and s.branch_id = b.id
   and s.product_id = p.id
  where b.organization_id = current_organization_id
    and b.active
    and (p_branch_id is null or b.id = p_branch_id)
    and app_private.can_access_branch(current_organization_id, b.id, 'stock.read')
  order by b.name, p.name;
end;
$$;

revoke all on function public.get_branch_stock_status(uuid) from public, anon;
grant execute on function public.get_branch_stock_status(uuid) to authenticated;

commit;
