-- Espeja en SQLite supabase/migrations/202610040061_pack_discount_single_category_threshold_promotions.sql. Tres cambios, sin
-- reconstruir ninguna tabla (sólo ADD/RENAME COLUMN y limpiezas de filas del catálogo, que es una réplica del servidor):
-- las ventas locales ya confirmadas y su outbox quedan intactas.
--
-- 1. Descuento del pack por producto. `catalog_product_packs.pack_discount_bps` guarda el porcentaje (basis points) de la versión
--    vigente del pack que el servidor le dio a este dispositivo, junto con el tamaño y el id de la versión. Las filas que ya
--    existían vienen de un servidor anterior donde todo pack era 20 %: el default 2000 las deja exactamente como se vendían.
alter table catalog_product_packs add column pack_discount_bps integer not null default 2000;

-- 2. Promoción global "DESDE N unidades" (cantidad mínima), no "cada N". La columna se llamaba every_units; la regla guardada
--    (p. ej. 3 / 15 %) NO se conserva (ver abajo). Es una foto que cada pull reemplaza entera. (`local_sale_items.branch_promotion_every_units` conserva su nombre histórico: guarda la cantidad mínima de la regla
--    con la que se vendió cada línea, igual que sale_items.branch_promotion_every_units en el servidor.)
alter table catalog_branch_promotions rename column every_units to minimum_units;
-- Las reglas guardadas hasta acá son de la semántica anterior ("cada N", el servidor las cerró en 202610040061): se descartan. Aplicarlas
-- como "desde N" sería otra promoción y el servidor rechazaría esas ventas. Hasta la próxima sincronización (que trae la regla "desde N"
-- vigente bajo branchPromotionsFromMinimum) el POS vende sin promoción de sucursal, nunca con la regla equivocada.
delete from catalog_branch_promotions;

-- 3. Una categoría por producto. catalog_product_categories queda como proyección de catalog_products.category_id: se borran las
--    asignaciones secundarias que hubiera de antes y se asegura la fila de la principal. El próximo pull de cada producto la
--    reemplaza igual (el servidor ya sólo manda [categoryId]).
delete from catalog_product_categories
where not exists (
  select 1 from catalog_products p
  where p.id = catalog_product_categories.product_id and p.category_id = catalog_product_categories.category_id
);
insert or ignore into catalog_product_categories(product_id, category_id)
select p.id, p.category_id from catalog_products p;
