begin;

-- Real branch management for Admin ("Sucursales"). The `branches.write` permission and the
-- branches_insert/branches_update RLS policies already existed since 202609100001 (every
-- authenticated admin already has this permission via role_permissions), but nothing ever wrote
-- through them: branches were only ever seeded directly in Postgres. This migration adds the
-- SECURITY DEFINER RPCs Admin calls (same pattern as save_category/save_product) plus a
-- delete_branch guard so a branch with real operational history can never be hard-deleted, only
-- deactivated (see docs/DOMAIN_RULES.md "Borrado y conservación histórica" and D-005).

-- branches never had a generic audit_row_change trigger (categories/products/product_prices do,
-- since 202609100007). Bringing it in line so branch create/edit is visible in /admin/audit.
create trigger branches_audit after insert or update on public.branches
for each row execute function app_private.audit_row_change();

create function public.save_branch(
  p_branch_id uuid,
  p_name text,
  p_code text,
  p_address text default null,
  p_active boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('branches.write');
  current_branch_id uuid;
  normalized_code text := upper(btrim(coalesce(p_code, '')));
  normalized_address text := nullif(btrim(coalesce(p_address, '')), '');
begin
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 120 then
    raise exception 'El nombre de la sucursal debe tener entre 2 y 120 caracteres' using errcode = '22023';
  end if;
  if normalized_code !~ '^[A-Z0-9][A-Z0-9_-]{1,19}$' then
    raise exception 'El código de sucursal debe empezar con letra o número y usar sólo mayúsculas, números, guiones o guión bajo (2 a 20 caracteres)' using errcode = '22023';
  end if;

  if p_branch_id is null then
    insert into public.branches (organization_id, name, code, address, active)
    values (current_organization_id, btrim(p_name), normalized_code, normalized_address, coalesce(p_active, true))
    returning id into current_branch_id;
  else
    update public.branches
    set name = btrim(p_name), code = normalized_code, address = normalized_address,
        active = coalesce(p_active, active)
    where id = p_branch_id and organization_id = current_organization_id
    returning id into current_branch_id;
    if current_branch_id is null then
      raise exception 'Branch was not found in this organization' using errcode = '42501';
    end if;
  end if;
  return current_branch_id;
exception
  when unique_violation then
    raise exception 'Ya existe una sucursal con ese código en esta organización' using errcode = '23505';
end;
$$;

create function public.set_branch_active(p_branch_id uuid, p_active boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('branches.write');
begin
  update public.branches
  set active = p_active
  where id = p_branch_id and organization_id = current_organization_id;
  if not found then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;
end;
$$;

-- Hard delete is only safe for a branch that never had real operation. Any of the tables below
-- having a row for this branch means it has history that must be preserved (D-005): the function
-- refuses and tells the caller to deactivate instead. `product_prices` is included even though it
-- is not "operational" in the same sense, because pricing history must never be silently dropped
-- (see docs/DOMAIN_RULES.md and the CLAUDE.md critical-restrictions list).
create function public.delete_branch(p_branch_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('branches.write');
  history_count bigint;
begin
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch was not found in this organization' using errcode = '42501';
  end if;

  select
    (select count(*) from public.sales s where s.branch_id = p_branch_id)
    + (select count(*) from public.stock_movements sm where sm.branch_id = p_branch_id)
    + (select count(*) from public.settlements st where st.branch_id = p_branch_id)
    + (select count(*) from public.employee_shifts es where es.branch_id = p_branch_id)
    + (select count(*) from public.employee_time_events ete where ete.branch_id = p_branch_id)
    + (select count(*) from public.stock_operations so where so.branch_id = p_branch_id)
    + (select count(*) from public.production_batches pb where pb.branch_id = p_branch_id)
    + (select count(*) from public.stock_transfers tr
         where tr.source_branch_id = p_branch_id or tr.destination_branch_id = p_branch_id)
    + (select count(*) from public.pos_devices d where d.branch_id = p_branch_id)
    + (select count(*) from public.audit_logs a where a.branch_id = p_branch_id)
    + (select count(*) from public.product_prices pp where pp.branch_id = p_branch_id)
  into history_count;

  if history_count > 0 then
    raise exception 'Esta sucursal ya tiene historial operativo (ventas, stock, turnos, dispositivos u otro) y no puede eliminarse; desactivala en su lugar' using errcode = '23503';
  end if;

  delete from public.branches where id = p_branch_id and organization_id = current_organization_id;
  perform app_private.write_audit(
    current_organization_id, null, 'BRANCH_DELETED', 'branches', p_branch_id, null, null
  );
end;
$$;

revoke all on function public.save_branch(uuid, text, text, text, boolean) from public, anon;
revoke all on function public.set_branch_active(uuid, boolean) from public, anon;
revoke all on function public.delete_branch(uuid) from public, anon;
grant execute on function public.save_branch(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.set_branch_active(uuid, boolean) to authenticated;
grant execute on function public.delete_branch(uuid) to authenticated;

comment on function public.save_branch(uuid, text, text, text, boolean) is
  'Creates (p_branch_id null) or updates an organization branch. Requires branches.write.';
comment on function public.delete_branch(uuid) is
  'Hard-deletes a branch only if it has zero operational/pricing history; otherwise raises and tells the caller to deactivate with set_branch_active instead.';

commit;
