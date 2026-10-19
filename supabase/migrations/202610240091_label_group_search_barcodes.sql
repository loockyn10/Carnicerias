-- D-073: la lectura agregada de etiquetas también expone los códigos de barras
-- del producto. Sólo se usan para buscar; no entran al PDF ni al historial.
begin;

create or replace function public.get_label_group(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  current_organization_id uuid := app_private.require_permission('products.read');
  g public.product_label_groups%rowtype;
  at_time timestamptz := now();
  v_branch_name text; v_bulk_minimum integer; v_bulk_bps integer; v_items jsonb;
begin
  select * into g from public.product_label_groups x where x.id = p_group_id and x.organization_id = current_organization_id;
  if not found then return null; end if;
  if g.branch_id is not null then
    select b.name into v_branch_name from public.branches b where b.id = g.branch_id and b.organization_id = g.organization_id;
    select bp.minimum_units, bp.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.branch_promotions bp where bp.organization_id = g.organization_id and bp.branch_id = g.branch_id and bp.active
      and bp.semantics = 'FROM_MINIMUM' and bp.valid_from <= at_time and (bp.valid_until is null or bp.valid_until > at_time)
    order by bp.minimum_units, bp.valid_from desc, bp.id limit 1;
  else
    select t.minimum_units, t.discount_bps into v_bulk_minimum, v_bulk_bps
    from public.organization_quantity_discount_tiers t where t.organization_id = g.organization_id order by t.minimum_units limit 1;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', r.product_id, 'position', r.position, 'name', r.name, 'sku', r.sku, 'barcodes', r.barcodes, 'unitType', r.unit_type,
    'available', r.reason is null, 'unavailableReason', r.reason, 'listPriceCents', r.price_cents::text,
    'bulkMinimumUnits', case when r.unit_type = 'UNIT' then v_bulk_minimum end,
    'bulkDiscountBps', case when r.unit_type = 'UNIT' then v_bulk_bps end, 'last', r.last_print
  ) order by r.position, r.name, r.product_id), '[]'::jsonb) into v_items
  from (
    select i.product_id, i.position, p.name, p.sku, p.unit_type, price.price_cents,
      coalesce((select jsonb_agg(pb.barcode order by pb.barcode) from public.product_barcodes pb
        where pb.organization_id = p.organization_id and pb.product_id = p.id), '[]'::jsonb) as barcodes,
      case
        when not (p.active and c.active is true and p.inventory_role in ('SELLABLE', 'BOTH')) then 'INACTIVE'
        when g.branch_id is not null and not exists (select 1 from public.branch_product_assortment a where a.branch_id = g.branch_id and a.product_id = p.id and a.organization_id = p.organization_id) then 'NOT_IN_BRANCH'
        when coalesce(price.price_cents, 0) <= 0 then 'NO_PRICE'
      end as reason,
      (select jsonb_build_object('runId', ri.run_id, 'generatedAt', ri.generated_at, 'displayedName', ri.displayed_name, 'variant', ri.variant,
        'listPriceCents', ri.list_price_cents::text, 'promoPriceCents', ri.promo_price_cents::text,
        'promoMinimumUnits', ri.promo_minimum_units, 'promoDiscountBps', ri.promo_discount_bps, 'copies', ri.copies)
       from public.product_label_print_run_items ri where ri.group_id = g.id and ri.product_id = p.id and ri.organization_id = g.organization_id
       order by ri.generated_at desc, ri.id desc limit 1) as last_print
    from public.product_label_group_items i
    join public.products p on p.id = i.product_id and p.organization_id = i.organization_id
    left join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
    left join lateral (select pp.price_cents from public.product_prices pp
      where pp.organization_id = p.organization_id and pp.product_id = p.id and (pp.branch_id = g.branch_id or pp.branch_id is null)
        and pp.valid_from <= at_time and (pp.valid_to is null or pp.valid_to > at_time)
      order by (pp.branch_id = g.branch_id) desc nulls last, pp.valid_from desc limit 1) price on true
    where i.group_id = g.id and i.active
  ) r;
  return jsonb_build_object('groupId', g.id, 'name', g.name, 'branchId', g.branch_id, 'branchName', v_branch_name, 'active', g.active, 'items', v_items);
end;
$$;

commit;
