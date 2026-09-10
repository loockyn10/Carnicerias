begin;

-- RLS policies decide which rows are visible, but PostgreSQL checks table ACLs
-- first. Keep anonymous access closed and grant authenticated only the
-- operations for which Phase 1A already defines policies.
revoke all on table
  public.organizations,
  public.branches,
  public.profiles,
  public.roles,
  public.permissions,
  public.role_permissions,
  public.organization_members,
  public.branch_members,
  public.categories,
  public.products,
  public.product_prices
from anon;

grant usage on schema public, app_private to authenticated;

grant select, update on public.organizations to authenticated;
grant select, insert, update on public.branches to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.roles to authenticated;
grant select on public.permissions to authenticated;
grant select on public.role_permissions to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;
grant select, insert, update, delete on public.branch_members to authenticated;
grant select, insert, update on public.categories to authenticated;
grant select, insert, update on public.products to authenticated;
grant select, insert, update on public.product_prices to authenticated;

-- Reassert the narrow helper surface used by RLS. Trigger functions remain
-- non-callable directly by API roles.
revoke all on function app_private.is_org_member(uuid) from public, anon;
revoke all on function app_private.has_permission(uuid, text) from public, anon;
revoke all on function app_private.is_branch_member(uuid) from public, anon;
revoke all on function app_private.can_read_profile(uuid) from public, anon;

grant execute on function app_private.is_org_member(uuid) to authenticated;
grant execute on function app_private.has_permission(uuid, text) to authenticated;
grant execute on function app_private.is_branch_member(uuid) to authenticated;
grant execute on function app_private.can_read_profile(uuid) to authenticated;

commit;

