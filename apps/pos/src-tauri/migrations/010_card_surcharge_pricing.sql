-- D-044: card surcharge pricing. Mirrors supabase/migrations/202609240035_card_surcharge_pricing.sql
-- on the SQLite side. cash_discount_bps/cash_discount_cents columns keep their physical names
-- (see that migration's header comment for the full rationale) — cash_discount_cents is simply
-- always 0 for a sale inserted after this migration, never removed so historical rows still
-- round-trip. The new concept (how much extra a card payment added) gets its own column, added
-- via a plain ALTER TABLE ADD COLUMN — same low-risk pattern already used by
-- 004_cash_discount_snapshots.sql, no table rebuild needed since this only adds a new
-- always-has-a-default column.
alter table local_sale_items add column card_surcharge_cents integer not null default 0;
