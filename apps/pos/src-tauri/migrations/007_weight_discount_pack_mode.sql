-- Mirrors Postgres migration 202609230031_promotion_pack_fixed_total.sql: a
-- discount row can now be a PACK_FIXED_TOTAL (fixed total price for a concrete
-- quantity) instead of only a THRESHOLD (percentage/fixed-per-kg from a
-- minimum weight). local_weight_discounts is a pure offline cache, always
-- fully replaced by apply_commercial_config on every sync (delete-all-then-
-- reinsert) and never a source of truth, so rebuilding it here to make
-- minimum_grams/discount_type/discount_value nullable is safe: nothing is
-- lost — the very next sync repopulates it exactly as an empty table would.
drop table if exists local_weight_discounts;
create table local_weight_discounts (
  id text primary key,
  product_id text not null,
  branch_id text,
  promotion_mode text not null default 'THRESHOLD',
  minimum_grams integer,
  discount_type text,
  discount_value integer,
  pack_quantity_grams integer,
  pack_quantity_units integer,
  pack_price_cents integer,
  active integer not null default 1
);
create index if not exists local_weight_discounts_product_idx on local_weight_discounts(product_id, minimum_grams desc);

-- Snapshot on the local sale line, mirroring sale_items.promotion_mode.
alter table local_sale_items add column promotion_mode text;
