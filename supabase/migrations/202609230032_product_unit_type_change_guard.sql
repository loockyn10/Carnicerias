begin;

-- save_product already allowed changing unit_type on an existing product (its
-- UPDATE branch writes p_unit_type unconditionally) with zero protection — the
-- only thing stopping it in practice was that the Admin edit modal sent
-- unit_type as a hidden, non-editable field. This migration closes that gap
-- with a real server-side guard, ahead of making the field editable in Admin:
-- a product with operational history (sales, stock movements, production, or
-- any promotion ever configured for it) can no longer switch WEIGHT <-> UNIT,
-- because every one of those rows encodes weight-vs-unit semantics that cannot
-- be reinterpreted after the fact (3000 grams must never become 3000 units).
-- product_prices/product_costs are deliberately NOT part of this guard: a
-- price/cost amount carries no weight-or-unit semantics of its own.
--
-- Same signature as the original (202609100007), so CREATE OR REPLACE is safe
-- and no new grants are required. Behavior is unchanged for every call that
-- doesn't actually change unit_type (the overwhelming majority of edits).

create or replace function public.save_product(
  p_product_id uuid, p_category_id uuid, p_name text, p_slug text, p_sku text,
  p_unit_type public.unit_type, p_active boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_organization_id uuid := app_private.require_permission('products.write');
  current_product_id uuid;
  existing_unit_type public.unit_type;
begin
  if char_length(btrim(p_name)) not between 1 and 120 or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or not exists (select 1 from public.categories c where c.id = p_category_id and c.organization_id = current_organization_id)
  then
    raise exception 'Product name, slug, or category is invalid' using errcode = '22023';
  end if;

  if p_product_id is null then
    insert into public.products (organization_id, category_id, name, slug, sku, unit_type, active)
    values (current_organization_id, p_category_id, btrim(p_name), p_slug, nullif(upper(btrim(p_sku)), ''), p_unit_type, p_active)
    returning id into current_product_id;
  else
    select unit_type into existing_unit_type from public.products
    where id = p_product_id and organization_id = current_organization_id;
    if existing_unit_type is null then
      raise exception 'Product was not found in this organization' using errcode = '42501';
    end if;

    if existing_unit_type <> p_unit_type and (
      exists (select 1 from public.sale_items where product_id = p_product_id)
      or exists (select 1 from public.stock_movements where product_id = p_product_id)
      or exists (select 1 from public.production_batch_outputs where product_id = p_product_id)
      or exists (select 1 from public.production_batches where source_product_id = p_product_id)
      or exists (select 1 from public.product_weight_discounts where product_id = p_product_id)
    ) then
      raise exception 'No se puede cambiar la forma de venta porque este producto ya tiene ventas, movimientos de stock, producción o promociones asociadas' using errcode = '22023';
    end if;

    update public.products
    set category_id = p_category_id, name = btrim(p_name), slug = p_slug,
        sku = nullif(upper(btrim(p_sku)), ''), unit_type = p_unit_type, active = p_active
    where id = p_product_id and organization_id = current_organization_id
    returning id into current_product_id;
  end if;
  return current_product_id;
end;
$$;

-- Lets the Admin product list disable the "forma de venta" selector up front
-- for products that save_product would reject anyway, instead of only telling
-- the user after a failed submit. Mirrors the exact same five EXISTS checks as
-- the guard above, so the UI and the server never disagree about which
-- products are locked.
create function public.get_products_with_unit_type_history()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from public.products p
  where p.organization_id = app_private.require_permission('products.read')
    and (
      exists (select 1 from public.sale_items si where si.product_id = p.id)
      or exists (select 1 from public.stock_movements sm where sm.product_id = p.id)
      or exists (select 1 from public.production_batch_outputs pbo where pbo.product_id = p.id)
      or exists (select 1 from public.production_batches pb where pb.source_product_id = p.id)
      or exists (select 1 from public.product_weight_discounts pwd where pwd.product_id = p.id)
    );
$$;

revoke all on function public.get_products_with_unit_type_history() from public, anon;
grant execute on function public.get_products_with_unit_type_history() to authenticated;

commit;
