-- Una selección global de etiquetas se resuelve y registra por sucursal, sin perder
-- la identidad física grupo + producto. Cada grupo recibe su propia corrida histórica.

begin;

create function public.get_label_branch_groups(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
begin
  if not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;

  -- Una sola RPC para todos los grupos de la sucursal. get_label_group conserva la
  -- misma resolución de precio/promo y comparación de última impresión que la vista local.
  return coalesce((
    select jsonb_agg(public.get_label_group(g.id) order by lower(g.name), g.id)
    from public.product_label_groups g
    where g.organization_id = current_organization_id and g.branch_id = p_branch_id and g.active
  ), '[]'::jsonb);
end;
$$;

create function public.record_label_branch_print_runs(p_branch_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('catalog.write');
  entry record;
  v_result jsonb;
  v_runs jsonb := '[]'::jsonb;
  v_product_count integer := 0;
  v_label_count integer := 0;
begin
  if not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.organization_id = current_organization_id
  ) then
    raise exception 'Branch not found' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'Se esperaba una lista de 1 a 500 productos' using errcode = '22023';
  end if;

  -- Agrupar en el servidor conserva que el mismo product_id en dos grupos sean dos etiquetas.
  for entry in
    select r."groupId" as group_id, jsonb_agg(source.item - 'groupId' order by source.ordinality) as items
    from jsonb_array_elements(p_items) with ordinality as source(item, ordinality)
    cross join lateral jsonb_to_record(source.item) as r("groupId" uuid)
    group by r."groupId"
  loop
    if entry.group_id is null or not exists (
      select 1 from public.product_label_groups g
      where g.id = entry.group_id and g.organization_id = current_organization_id and g.branch_id = p_branch_id and g.active
    ) then
      raise exception 'El grupo no pertenece a esta sucursal' using errcode = '42501';
    end if;
    v_result := public.record_label_print_run(entry.group_id, entry.items);
    v_runs := v_runs || jsonb_build_array(jsonb_build_object('groupId', entry.group_id, 'runId', v_result->'runId'));
    v_product_count := v_product_count + coalesce((v_result->>'productCount')::integer, 0);
    v_label_count := v_label_count + coalesce((v_result->>'labelCount')::integer, 0);
  end loop;

  return jsonb_build_object('runs', v_runs, 'productCount', v_product_count, 'labelCount', v_label_count);
end;
$$;

revoke all on function public.get_label_branch_groups(uuid) from public, anon;
grant execute on function public.get_label_branch_groups(uuid) to authenticated;
revoke all on function public.record_label_branch_print_runs(uuid, jsonb) from public, anon;
grant execute on function public.record_label_branch_print_runs(uuid, jsonb) to authenticated;

commit;
