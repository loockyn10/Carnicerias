-- Versión (configuración histórica) del pack de productos UNIT. Espeja en SQLite la tabla product_pack_versions de
-- supabase/migrations/202610030060_unit_packs_and_branch_promotions.sql. Sólo `ALTER TABLE ADD COLUMN` nullable (mismo
-- patrón de bajo riesgo que 004, 010, 016 y 017): no se reconstruye ninguna tabla y nada anterior cambia.
--
-- `catalog_product_packs.pack_config_id`: id de la versión VIGENTE del pack que el servidor le dio a este dispositivo junto
-- con el tamaño (pull_pos_state.packConfigId). Una fila sin versión (guardada antes de esta migración) no se ofrece como
-- Pack hasta el próximo pull que toque al producto, porque el servidor no podría validar la venta.
alter table catalog_product_packs add column pack_config_id text;

-- Versión con la que se vendió cada línea Pack (snapshot histórico: nunca se relee del producto). El servidor valida la venta
-- contra ESA versión, así que una venta hecha con un pack de 8 sincroniza bien aunque el producto ya sea de 12.
alter table local_sale_items add column pack_config_id text;
