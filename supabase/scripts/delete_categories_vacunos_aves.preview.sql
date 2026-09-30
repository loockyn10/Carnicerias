-- ============================================================================
-- supabase/scripts/delete_categories_vacunos_aves.preview.sql
-- ============================================================================
-- READ-ONLY. One-off cleanup helper (NOT a migration: `supabase db push` never
-- runs it). Reports everything needed to decide whether the categories
-- "Vacunos" and "Aves" can be hard-deleted, and doubles as the logical backup
-- (section 'backup' = full row as JSON; export the result before deleting) and
-- as the post-delete verification (run it again: sections 1-3 must be empty,
-- section 'baseline' must be unchanged except categories - 2).
-- Changes nothing. Run in the Supabase SQL Editor.
-- ============================================================================
with t as (
  select c.* from public.categories c where lower(btrim(c.name)) in ('vacunos', 'aves')
)
select '1 categoria' as section, t.name as item,
  t.id || ' | org ' || t.organization_id || ' | slug ' || t.slug || ' | active ' || t.active as value
from t
union all
select '2 producto (principal)', t.name,
  p.name || ' [' || coalesce(p.sku, '-') || '] ' || case when p.active then 'ACTIVO' else 'inactivo' end
from t join public.products p on p.category_id = t.id and p.organization_id = t.organization_id
union all
select '3 producto (secundaria)', t.name,
  p.name || ' [' || coalesce(p.sku, '-') || '] ' || case when p.active then 'ACTIVO' else 'inactivo' end
  || case when p.category_id = t.id then ' (tambien principal)' else '' end
from t
join public.product_category_assignments a on a.category_id = t.id and a.organization_id = t.organization_id
join public.products p on p.id = a.product_id
union all
select '4 fk hacia categories', conrelid::regclass::text, conname || ' -> ' || pg_get_constraintdef(oid)
from pg_constraint where confrelid = 'public.categories'::regclass and contype = 'f'
union all
select '5 referencia logica (sin fk)', 'pos_catalog_changes CATEGORY', count(*)::text
from public.pos_catalog_changes where entity_type = 'CATEGORY' and entity_id in (select id from t)
union all
select '5 referencia logica (sin fk)', 'audit_logs entity_id', count(*)::text
from public.audit_logs where entity_id in (select id from t)
union all
select '6 triggers en categories', tgname, pg_get_triggerdef(oid)
from pg_trigger where tgrelid = 'public.categories'::regclass and not tgisinternal
union all
select '7 backup (row json)', t.name, to_jsonb(t)::text from t
union all
select '8 baseline', 'categories (total)', count(*)::text from public.categories
union all
select '8 baseline', 'products', count(*)::text from public.products
union all
select '8 baseline', 'product_category_assignments', count(*)::text from public.product_category_assignments
union all
select '8 baseline', 'product_prices', count(*)::text from public.product_prices
union all
select '8 baseline', 'stock_movements', count(*)::text from public.stock_movements
order by 1, 2, 3;
