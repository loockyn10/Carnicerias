-- Read-only projection of the device branch's stock, refreshed as a full snapshot on every sync
-- by get_pos_branch_stock (Postgres migration 202609300040_pos_branch_stock.sql). It is NOT a
-- second stock ledger: nothing here is ever written by a sale, and the authoritative value
-- stays the server's stock_movements sum. Purely additive (new table, no existing data touched).
--
-- quantity_grams is the signed ledger sum at snapshot time (grams for WEIGHT, units for UNIT,
-- same convention as stock_movements). A product with no row means "no movements in this
-- branch" (= 0). Whether a snapshot exists at all is tracked in sync_metadata
-- (branch_stock_branch_id / branch_stock_applied_at) so "never synced" is distinguishable
-- from "synced and this product has none".
create table if not exists catalog_branch_stock (
  branch_id text not null,
  product_id text not null,
  quantity_grams integer not null,
  primary key (branch_id, product_id)
);
