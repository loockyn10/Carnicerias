-- Productos "sin precio" en el catálogo local (Central: importados desde SimplyGest con precio 0).
--
-- El servidor ahora entrega esos productos con pricePerKgCents = "0" (product_prices acepta 0, ver
-- Postgres 202610020054). `catalog_prices.price_per_kg_cents` nació con `check (> 0)` (migración 001) y
-- SQLite no permite ALTERar un CHECK, así que una fila de precio 0 haría fallar TODO el pull del
-- catálogo. Se reconstruye la tabla (patrón no destructivo ya usado por la 009: tabla `_new`, copia de
-- las filas existentes, DROP + RENAME) relajando sólo ese check a `>= 0`.
--
-- Seguridad de venta: un precio 0 NUNCA se vende. La UI no agrega un producto sin precio al ticket (pide
-- el precio) y `insert_sale` (Rust) lo rechaza con PRICE_REQUIRED aunque llegue una línea a $0; además
-- `local_sale_items.price_per_kg_cents` conserva su `check (> 0)`.
--
-- catalog_prices sólo es hija de catalog_products (nada la referencia): no hace falta apagar las FK.
create table catalog_prices_new (
  product_id text not null,
  branch_id text not null,
  price_per_kg_cents integer not null check (price_per_kg_cents >= 0),
  valid_from text not null,
  synced_at text not null,
  primary key (product_id, branch_id),
  foreign key (product_id) references catalog_products(id)
);

insert into catalog_prices_new(product_id, branch_id, price_per_kg_cents, valid_from, synced_at)
select product_id, branch_id, price_per_kg_cents, valid_from, synced_at from catalog_prices;

drop table catalog_prices;
alter table catalog_prices_new rename to catalog_prices;
