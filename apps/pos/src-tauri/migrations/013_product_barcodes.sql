-- Barcodes of the branch catalog, synced with the catalog (pull_pos_state -> "barcodes" on every
-- item) so a scan resolves LOCALLY, offline, with no per-scan server call. Purely additive (new
-- table, no existing data touched).
--
-- A barcode identifies exactly one product within the organization (the server enforces it), so
-- the code itself is the primary key. Stored normalized exactly as the server sends it (trimmed,
-- no spaces, upper-case). Rows are replaced per product on every pull that touches the product
-- (full set, not a delta) and removed when the product leaves this branch assortment.
create table if not exists catalog_product_barcodes (
  barcode text primary key,
  product_id text not null
);

create index if not exists catalog_product_barcodes_product_idx on catalog_product_barcodes(product_id);
