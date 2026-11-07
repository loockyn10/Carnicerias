-- Envasados al vacío vendidos desde el POS (D-091). Todo aditivo: tablas nuevas y dos columnas nuevas en local_sale_items; ninguna venta ni dato
-- existente cambia.
--
-- El POS reconoce los EAN-13 de importe variable de Envasados SIN Internet con tres cosas que baja de `get_pos_vacuum_state` en cada sync:
--   * vacuum_scheme        el esquema EAN-13 configurado (prefijo, dígitos de PLU y de valor, divisor). Una sola fila; ausente = Envasados sin configurar.
--   * catalog_vacuum_plu   el PLU de cada corte habilitado para envasar.
--   * local_vacuum_packages los paquetes DISPONIBLES de la sucursal del dispositivo (peso real, importe a cobrar, lote, fechas).
--
-- `sold_sale_id` es el reclamo LOCAL: al confirmar una venta con un paquete, la misma transacción que registra la venta marca el paquete como
-- vendido, así que esta caja no lo ofrece dos veces aunque no haya Internet. Es sólo una protección local: el servidor es quien decide
-- cuando las cajas sincronizan (si dos cajas lo vendieron offline queda un conflicto abierto, la venta no se pierde).
create table if not exists vacuum_scheme (
  singleton integer primary key check (singleton = 1),
  branch_id text not null,
  scheme text not null,
  prefix text not null,
  plu_digits integer not null,
  value_digits integer not null,
  value_step integer not null,
  applied_at text not null
);

create table if not exists catalog_vacuum_plu (
  product_id text primary key,
  plu text not null
);

create table if not exists local_vacuum_packages (
  package_id text primary key,
  product_id text not null,
  product_name text not null,
  ean13 text not null,
  weight_grams integer not null check (weight_grams > 0),
  charge_cents integer not null check (charge_cents > 0),
  lot text not null,
  packed_on text not null,
  expires_on text not null,
  sold_sale_id text,
  updated_at text not null
);
create index if not exists local_vacuum_packages_ean_idx on local_vacuum_packages(ean13);

-- La línea PACKAGE de una venta guarda a qué paquete (y con qué EAN) corresponde.
alter table local_sale_items add column vacuum_package_id text;
alter table local_sale_items add column vacuum_ean13 text;
