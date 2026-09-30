-- One-off pre-production cleanup (NOT a migration). Paste the whole file in the Supabase SQL Editor.
-- Deletes every inactive product of organization 20000000-0000-4000-8000-000000000001 with all its
-- dependent rows (history included), headers left without items, and the categories Vacunos / Aves.
-- Active products are never referenced by a DELETE. Any FK violation aborts the whole transaction.
-- To rehearse, replace the final COMMIT with ROLLBACK.

BEGIN;

-- 1. Ids to delete (computed BEFORE any delete).
CREATE TEMP TABLE products_to_delete AS
SELECT id
FROM public.products
WHERE organization_id = '20000000-0000-4000-8000-000000000001'
  AND active = false;

-- Headers whose items are ALL from products to delete.
CREATE TEMP TABLE sales_to_delete AS
SELECT DISTINCT si.sale_id AS id
FROM public.sale_items si
WHERE si.product_id IN (SELECT id FROM products_to_delete)
  AND NOT EXISTS (
    SELECT 1 FROM public.sale_items o
    WHERE o.sale_id = si.sale_id
      AND o.product_id NOT IN (SELECT id FROM products_to_delete)
  );

CREATE TEMP TABLE operations_to_delete AS
SELECT DISTINCT i.operation_id AS id
FROM public.stock_operation_items i
WHERE i.product_id IN (SELECT id FROM products_to_delete)
  AND NOT EXISTS (
    SELECT 1 FROM public.stock_operation_items o
    WHERE o.operation_id = i.operation_id
      AND o.product_id NOT IN (SELECT id FROM products_to_delete)
  );

CREATE TEMP TABLE transfers_to_delete AS
SELECT DISTINCT i.transfer_id AS id
FROM public.stock_transfer_items i
WHERE i.product_id IN (SELECT id FROM products_to_delete)
  AND NOT EXISTS (
    SELECT 1 FROM public.stock_transfer_items o
    WHERE o.transfer_id = i.transfer_id
      AND o.product_id NOT IN (SELECT id FROM products_to_delete)
  );

-- 2. Stock ledger and its dependents.
DELETE FROM public.product_restock_events
WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM public.stock_movements
WHERE product_id IN (SELECT id FROM products_to_delete);

-- 3. Sales: items, then sales left without items (with their payments).
DELETE FROM public.sale_items
WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM public.payments
WHERE sale_id IN (SELECT id FROM sales_to_delete);

DELETE FROM public.sales
WHERE id IN (SELECT id FROM sales_to_delete);

-- 4. Stock operations (purchases / waste / adjustments).
DELETE FROM public.stock_operation_items
WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM public.stock_operations
WHERE id IN (SELECT id FROM operations_to_delete);

-- 5. Transfers.
DELETE FROM public.stock_transfer_items
WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM public.stock_transfers
WHERE id IN (SELECT id FROM transfers_to_delete);

-- 6. Production (batches whose SOURCE product is being deleted; their outputs cascade).
DELETE FROM public.production_batch_outputs
WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM public.production_batches
WHERE source_product_id IN (SELECT id FROM products_to_delete);

-- 7. Catalog / commercial configuration.
DELETE FROM public.product_prices
WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM public.product_costs
WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM public.product_pricing_settings
WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM public.product_weight_discounts
WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM public.branch_product_stock_settings
WHERE product_id IN (SELECT id FROM products_to_delete);

DELETE FROM public.product_category_assignments
WHERE product_id IN (SELECT id FROM products_to_delete);

-- 8. Products, then the two categories.
DELETE FROM public.products
WHERE id IN (SELECT id FROM products_to_delete);

DELETE FROM public.categories
WHERE id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002'
);

-- 9. Result (one row): inactive_left = 0, vacunos_left = 0, aves_left = 0.
SELECT
  (SELECT count(*) FROM public.products
    WHERE organization_id = '20000000-0000-4000-8000-000000000001' AND active = false) AS inactive_left,
  (SELECT count(*) FROM public.categories
    WHERE id = '30000000-0000-4000-8000-000000000001') AS vacunos_left,
  (SELECT count(*) FROM public.categories
    WHERE id = '30000000-0000-4000-8000-000000000002') AS aves_left,
  (SELECT count(*) FROM public.products
    WHERE organization_id = '20000000-0000-4000-8000-000000000001' AND active = true) AS active_products;

COMMIT;
