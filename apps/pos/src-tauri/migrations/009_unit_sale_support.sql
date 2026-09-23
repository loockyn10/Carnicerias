-- Enables selling UNIT products offline. Unlike the pure-cache tables touched
-- in earlier migrations, local_sales/local_sale_items hold REAL confirmed
-- local sale history that must never be lost — so this uses the standard
-- SQLite "rebuild" pattern (create new table, copy every row, drop old,
-- rename) to relax two CHECK constraints that were written when every sale
-- was WEIGHT-only, instead of a destructive drop+recreate.
--
-- local_sales.total_weight_grams was `> 0` (every sale assumed some weight);
-- a sale made entirely of UNIT items has zero weight, so it becomes `>= 0`
-- (matching public.sales.total_weight_grams in Postgres, already >= 0).
--
-- local_sale_items.weight_grams was `not null, > 0`; it becomes nullable, and
-- a new `quantity_units` column (nullable, > 0) is added for a UNIT line.
-- Exactly one of the two must be set per row — enforced by a CHECK, mirroring
-- production_batch_outputs (Postgres) and this same file's own
-- product_weight_discounts pack columns: two mutually-exclusive optional
-- columns rather than overloading one field with two meanings.
--
-- IMPORTANT: `pragma foreign_keys` is a documented no-op while a transaction
-- is open, and every migration in this file runs inside one (see
-- initialize_connection in lib.rs) — so it CANNOT be toggled from within this
-- SQL file. Dropping local_sales/local_sale_items here while FK enforcement
-- is on fails with "FOREIGN KEY constraint failed" the moment any existing
-- row references the table being dropped (confirmed by
-- unit_sale_migration_preserves_preexisting_local_sale_history in lib.rs,
-- which reproduces this against real pre-existing local sale data before this
-- fix). initialize_connection disables foreign_keys OUTSIDE the transaction
-- specifically around this migration's block and re-enables it right after.

create table local_sales_new (
  id text primary key,
  organization_id text not null,
  branch_id text not null,
  profile_id text not null,
  device_id text not null,
  status text not null check (status = 'COMPLETED'),
  total_cents integer not null check (total_cents > 0),
  total_weight_grams integer not null check (total_weight_grams >= 0),
  created_at text not null,
  completed_at text not null,
  synced_at text
);
insert into local_sales_new (id, organization_id, branch_id, profile_id, device_id, status, total_cents, total_weight_grams, created_at, completed_at, synced_at)
select id, organization_id, branch_id, profile_id, device_id, status, total_cents, total_weight_grams, created_at, completed_at, synced_at from local_sales;
drop table local_sales;
alter table local_sales_new rename to local_sales;
create index if not exists local_sales_created_idx on local_sales(created_at desc);

create table local_sale_items_new (
  id text primary key,
  sale_id text not null,
  product_id text not null,
  product_name_snapshot text not null,
  weight_grams integer check (weight_grams is null or weight_grams > 0),
  quantity_units integer check (quantity_units is null or quantity_units > 0),
  price_per_kg_cents integer not null check (price_per_kg_cents > 0),
  subtotal_cents integer not null check (subtotal_cents > 0),
  created_at text not null,
  original_price_per_kg_cents integer,
  discount_rule_id text,
  discount_type text,
  discount_value integer,
  discount_cents integer not null default 0,
  cash_discount_bps integer not null default 0,
  cash_discount_cents integer not null default 0,
  promotion_discount_cents integer not null default 0,
  cost_cents_snapshot integer,
  profit_markup_bps_snapshot integer,
  promotion_mode text,
  check ((weight_grams is not null) <> (quantity_units is not null)),
  foreign key (sale_id) references local_sales(id)
);
insert into local_sale_items_new (
  id, sale_id, product_id, product_name_snapshot, weight_grams, quantity_units,
  price_per_kg_cents, subtotal_cents, created_at, original_price_per_kg_cents,
  discount_rule_id, discount_type, discount_value, discount_cents,
  cash_discount_bps, cash_discount_cents, promotion_discount_cents,
  cost_cents_snapshot, profit_markup_bps_snapshot, promotion_mode
)
select
  id, sale_id, product_id, product_name_snapshot, weight_grams, null,
  price_per_kg_cents, subtotal_cents, created_at, original_price_per_kg_cents,
  discount_rule_id, discount_type, discount_value, discount_cents,
  cash_discount_bps, cash_discount_cents, promotion_discount_cents,
  cost_cents_snapshot, profit_markup_bps_snapshot, promotion_mode
from local_sale_items;
drop table local_sale_items;
alter table local_sale_items_new rename to local_sale_items;
