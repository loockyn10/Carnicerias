-- Pack de productos UNIT (20 % de descuento) y promoción global por sucursal. Espeja en SQLite
-- supabase/migrations/202610030060_unit_packs_and_branch_promotions.sql. Sólo tablas nuevas y
-- `ALTER TABLE ADD COLUMN` con default (mismo patrón de bajo riesgo que 004, 010 y 016): no se reconstruye ninguna
-- tabla y las ventas locales ya confirmadas (y su outbox) quedan intactas — una venta anterior queda sin pack ni
-- promoción de sucursal, exactamente lo que era.
--
-- `catalog_product_packs`: unidades por pack del producto (sólo UNIT con pack). Es una tabla aparte (como los
-- barcodes) y no una columna de `catalog_products` para no alterar la forma de esa tabla. Se reemplaza por producto
-- en cada pull que lo toca y se borra cuando el producto sale del surtido de la sucursal.
create table if not exists catalog_product_packs (
  product_id text primary key,
  pack_size_units integer not null check (pack_size_units >= 2),
  foreign key (product_id) references catalog_products(id)
);

-- Promoción global activa de la sucursal del dispositivo ("cada N unidades, X %" para todos sus productos UNIT).
-- Foto completa: cada pull la reemplaza entera (como el directorio de categorías), no es un delta.
create table if not exists catalog_branch_promotions (
  id text primary key,
  branch_id text not null,
  scope text not null default 'ALL_UNIT_PRODUCTS',
  every_units integer not null check (every_units >= 2),
  discount_bps integer not null check (discount_bps between 1 and 9999)
);

-- Snapshot de cómo se vendió cada línea UNIT (nunca se reconstruye desde el producto actual).
alter table local_sale_items add column sold_as_pack integer not null default 0 check (sold_as_pack in (0, 1));
alter table local_sale_items add column pack_size_units_snapshot integer;
alter table local_sale_items add column pack_count integer;
alter table local_sale_items add column pack_discount_bps integer;
alter table local_sale_items add column pack_discount_cents integer not null default 0;
alter table local_sale_items add column branch_promotion_id text;
alter table local_sale_items add column branch_promotion_every_units integer;
alter table local_sale_items add column branch_promotion_discount_bps integer;
alter table local_sale_items add column branch_promotion_discounted_units integer;
alter table local_sale_items add column branch_promotion_discount_cents integer not null default 0;
