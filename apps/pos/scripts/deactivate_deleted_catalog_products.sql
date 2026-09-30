-- ============================================================================
-- apps/pos/scripts/deactivate_deleted_catalog_products.sql
-- ============================================================================
-- OPTIONAL manual script for the LOCAL SQLite database of ONE POS. Not a
-- migration, not run by the app, never bundled in the installer.
--
-- WHY: the server hard-deleted products (supabase/scripts/delete_categories_vacunos_aves.sql).
-- pull_pos_state derives `removedProductIds` from public.products, so a product
-- that no longer exists is never reported as removed. A POS that was already
-- synced AFTER the products were deactivated has them active=0 and needs
-- nothing. A POS that has NOT synced since (still active=1 locally) would keep
-- offering them until this runs; its sales of them would be rejected by the
-- server (FK) when they sync. One normal online sync also hides any product
-- whose principal category was deleted (Vacunos/Aves), because the category
-- directory is a full snapshot and the local category becomes active=0.
--
-- WHAT: sets catalog_products.active = 0 for the IDs listed below ONLY.
-- Never DELETEs: local_sale_items has a hard FK to catalog_products(id), and
-- "deactivate, never delete" is the convention of apply_catalog_pull. Touches
-- no sales, outbox, shifts, catalog prices, configuration or device authorization.
--
-- HOW: paste the `deleted_product_ids` from the server dry-run/DELETED report
-- into the list below, close the POS completely, copy the .sqlite (+ -wal/-shm),
-- then:
--   sqlite3 -bail "%APPDATA%\com.carnicerias.pos\carnicerias-pos.sqlite" ".read deactivate_deleted_catalog_products.sql"
-- ============================================================================
begin immediate;

create temp table deleted_ids (id text primary key);
insert into deleted_ids (id) values
  ('00000000-0000-0000-0000-000000000000'); -- REPLACE with the real ids, one row each: ('uuid'),

update catalog_products
set active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
where active = 1 and id in (select id from deleted_ids);

select changes() as products_deactivated;

commit;
