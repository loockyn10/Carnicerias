-- ============================================================================
-- supabase/scripts/reset_operational_data.preview.sql
-- ============================================================================
-- READ-ONLY companion of reset_operational_data.sql. Returns one result set:
-- the organization being targeted and the row count of every table, marked
-- DELETE / KEEP. Changes nothing.
-- Edit the organization id below if you target a different organization.
-- ============================================================================
with p as (select '20000000-0000-4000-8000-000000000001'::uuid as org)
select 'ORG' as action, o.name || ' (' || o.id || ')' as tbl, null::bigint as rows
from public.organizations o join p on p.org = o.id
union all select 'DELETE', 'product_restock_events', count(*) from public.product_restock_events, p where organization_id = p.org
union all select 'DELETE', 'stock_movements', count(*) from public.stock_movements, p where organization_id = p.org
union all select 'DELETE', 'payments', count(*) from public.payments, p where organization_id = p.org
union all select 'DELETE', 'sale_items', count(*) from public.sale_items, p where organization_id = p.org
union all select 'DELETE', 'sales', count(*) from public.sales, p where organization_id = p.org
union all select 'DELETE', 'pos_sync_receipts', count(*) from public.pos_sync_receipts r join public.pos_devices d on d.id = r.device_id, p where d.organization_id = p.org
union all select 'DELETE', 'stock_operation_items', count(*) from public.stock_operation_items, p where organization_id = p.org
union all select 'DELETE', 'stock_operations', count(*) from public.stock_operations, p where organization_id = p.org
union all select 'DELETE', 'stock_transfer_items', count(*) from public.stock_transfer_items, p where organization_id = p.org
union all select 'DELETE', 'stock_transfers', count(*) from public.stock_transfers, p where organization_id = p.org
union all select 'DELETE', 'production_batch_outputs', count(*) from public.production_batch_outputs, p where organization_id = p.org
union all select 'DELETE', 'production_batches', count(*) from public.production_batches, p where organization_id = p.org
union all select 'DELETE', 'settlements', count(*) from public.settlements, p where organization_id = p.org
union all select 'DELETE', 'employee_time_events', count(*) from public.employee_time_events, p where organization_id = p.org
union all select 'DELETE', 'employee_shifts', count(*) from public.employee_shifts, p where organization_id = p.org
union all select 'DELETE', 'audit_logs (operational entity types)', count(*) from public.audit_logs, p where organization_id = p.org
  and entity_type in ('sales', 'settlements', 'production_batches', 'stock_transfers', 'stock_operations', 'employee_shift')
union all select 'KEEP', 'audit_logs (everything else)', count(*) from public.audit_logs, p where organization_id = p.org
  and entity_type not in ('sales', 'settlements', 'production_batches', 'stock_transfers', 'stock_operations', 'employee_shift')
union all select 'KEEP', 'pos_catalog_changes', count(*) from public.pos_catalog_changes, p where organization_id = p.org
union all select 'KEEP', 'pos_operator_grants', count(*) from public.pos_operator_grants, p where organization_id = p.org
union all select 'KEEP', 'branches (total)', count(*) from public.branches, p where organization_id = p.org
union all select 'KEEP', 'branches (active)', count(*) from public.branches, p where organization_id = p.org and active
union all select 'KEEP', 'pos_devices', count(*) from public.pos_devices, p where organization_id = p.org
union all select 'KEEP', 'organization_members', count(*) from public.organization_members, p where organization_id = p.org
union all select 'KEEP', 'employee_pos_pins', count(*) from public.employee_pos_pins, p where organization_id = p.org
union all select 'KEEP', 'employee_hourly_rates', count(*) from public.employee_hourly_rates, p where organization_id = p.org
union all select 'KEEP', 'products', count(*) from public.products, p where organization_id = p.org
union all select 'KEEP', 'categories', count(*) from public.categories, p where organization_id = p.org
union all select 'KEEP', 'product_prices', count(*) from public.product_prices, p where organization_id = p.org
union all select 'KEEP', 'branch_product_stock_settings', count(*) from public.branch_product_stock_settings, p where organization_id = p.org
order by 1, 2;
