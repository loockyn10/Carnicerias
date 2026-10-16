-- Cada producto conserva, por defecto, los escalones globales ya existentes.
alter table catalog_products add column global_quantity_discounts_enabled integer not null default 1 check (global_quantity_discounts_enabled in (0, 1));
