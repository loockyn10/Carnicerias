-- D-061: precio manual por línea y descuento general del ticket (sólo POS de Central). Espeja en SQLite
-- supabase/migrations/202610020058_flexible_pricing_central.sql. Sólo `ALTER TABLE ADD COLUMN` con
-- default (mismo patrón de bajo riesgo que 004 y 010): no se reconstruye ninguna tabla y las ventas locales
-- ya confirmadas (y su outbox) quedan intactas — una venta anterior a esta migración queda con
-- manual_price_applied = 0 y descuento general 0, exactamente lo que era.
--
-- local_sales.total_cents / local_payments.amount_cents siguen siendo lo REALMENTE cobrado (ya con el
-- descuento general): la suma de local_sale_items.subtotal_cents menos ticket_discount_cents.
-- local_sale_items.price_per_kg_cents de una línea manual ES el precio manual (por kg o por unidad) y
-- original_price_per_kg_cents el precio normal del catálogo; manual_adjustment_cents = subtotal cobrado
-- menos lo que habría costado a precio normal (negativo = rebaja).
alter table local_sales add column ticket_discount_bps integer not null default 0 check (ticket_discount_bps between 0 and 10000);
alter table local_sales add column ticket_discount_cents integer not null default 0 check (ticket_discount_cents >= 0);
alter table local_sale_items add column manual_price_applied integer not null default 0 check (manual_price_applied in (0, 1));
alter table local_sale_items add column manual_unit_price_cents integer check (manual_unit_price_cents is null or manual_unit_price_cents > 0);
alter table local_sale_items add column manual_adjustment_cents integer not null default 0;
