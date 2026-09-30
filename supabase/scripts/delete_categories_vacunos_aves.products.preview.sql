-- ============================================================================
-- supabase/scripts/delete_categories_vacunos_aves.products.preview.sql
-- ============================================================================
-- READ-ONLY. Per-product dependency report for every product that is in
-- "Vacunos" or "Aves" (principal or secondary). One row per product; `refs`
-- lists ONLY the tables that hold rows for that product (empty {} = no
-- dependencies at all). `history_refs` is the subset that makes a product
-- NON-deletable (sales / stock / production / transfers). Also lists FKs that
-- really exist in the database, POS devices, and the remaining categories
-- (candidate targets if a product must be reassigned instead).
-- Changes nothing. Run in the Supabase SQL Editor and export the result.
-- ============================================================================
with cats as (
  select id from public.categories where lower(btrim(name)) in ('vacunos', 'aves')
), t as (
  select p.*, c.name as cat_name
  from public.products p join public.categories c on c.id = p.category_id and c.organization_id = p.organization_id
  where p.category_id in (select id from cats)
     or p.id in (select product_id from public.product_category_assignments where category_id in (select id from cats))
), refs as (
  select t.id,
    jsonb_strip_nulls(jsonb_build_object(
      'product_prices',                (select nullif(count(*), 0) from public.product_prices x where x.product_id = t.id),
      'product_costs',                 (select nullif(count(*), 0) from public.product_costs x where x.product_id = t.id),
      'product_pricing_settings',      (select nullif(count(*), 0) from public.product_pricing_settings x where x.product_id = t.id),
      'product_weight_discounts',      (select nullif(count(*), 0) from public.product_weight_discounts x where x.product_id = t.id),
      'branch_product_stock_settings', (select nullif(count(*), 0) from public.branch_product_stock_settings x where x.product_id = t.id),
      'product_category_assignments',  (select nullif(count(*), 0) from public.product_category_assignments x where x.product_id = t.id),
      'audit_logs (sin fk)',           (select nullif(count(*), 0) from public.audit_logs x where x.entity_id = t.id)
    )) as config_refs,
    jsonb_strip_nulls(jsonb_build_object(
      'sale_items',             (select nullif(count(*), 0) from public.sale_items x where x.product_id = t.id),
      'stock_movements',        (select nullif(count(*), 0) from public.stock_movements x where x.product_id = t.id),
      'stock_operation_items',  (select nullif(count(*), 0) from public.stock_operation_items x where x.product_id = t.id),
      'product_restock_events', (select nullif(count(*), 0) from public.product_restock_events x where x.product_id = t.id),
      'production_batches',     (select nullif(count(*), 0) from public.production_batches x where x.source_product_id = t.id),
      'production_batch_outputs', (select nullif(count(*), 0) from public.production_batch_outputs x where x.product_id = t.id),
      'stock_transfer_items',   (select nullif(count(*), 0) from public.stock_transfer_items x where x.product_id = t.id)
    )) as history_refs
  from t
)
select '1 producto' as section, t.cat_name || ' / ' || t.name as item,
  'id ' || t.id || ' | sku ' || coalesce(t.sku, '-') || ' | ' || case when t.active then 'ACTIVO' else 'inactivo' end
  || ' | creado ' || t.created_at::date || ' | actualizado ' || t.updated_at::date
  || ' | id_seed ' || (t.id::text like '40000000-0000-4000-8000-00000000000_')
  || ' | config ' || r.config_refs::text || ' | HISTORIA ' || r.history_refs::text as value
from t join refs r on r.id = t.id
union all
select '2 fk reales hacia products', conrelid::regclass::text, conname || ' -> ' || pg_get_constraintdef(oid)
from pg_constraint where confrelid = 'public.products'::regclass and contype = 'f'
union all
select '3 pos_devices', d.id::text,
  'branch ' || d.branch_id || ' | ' || d.status || ' | last_seen ' || coalesce(d.last_seen_at::text, 'nunca')
  || ' | ultimo cambio de los productos ' || (select max(updated_at) from t)
from public.pos_devices d
union all
select '4 categorias restantes (destino si hay que reasignar)', c.name,
  c.id || ' | active ' || c.active || ' | productos ' || (select count(*) from public.products p where p.category_id = c.id)
from public.categories c where c.id not in (select id from cats)
order by 1, 2;
