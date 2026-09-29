-- ============================================================================
-- apps/pos/scripts/reset_local_operational_data.sql
-- ============================================================================
-- MANUAL script for the LOCAL SQLite database of ONE real POS.
-- Not a migration, not run by the app, never bundled in the installer.
--
-- File to run it against (Windows):
--   %APPDATA%\com.carnicerias.pos\carnicerias-pos.sqlite
--
-- REQUIREMENTS
--   * The POS application must be COMPLETELY CLOSED (check Task Manager: no
--     "Carnicerías POS" / "carnicerias-pos" process). Closing it with an active
--     operator writes a local clock-out + outbox row; this script removes it.
--   * Make a copy of carnicerias-pos.sqlite (and -wal / -shm if they exist)
--     BEFORE running.
--   * Run it with sqlite3 using -bail so ANY failed check stops the script
--     before COMMIT (the open transaction is then rolled back on exit):
--
--       sqlite3 -bail "%APPDATA%\com.carnicerias.pos\carnicerias-pos.sqlite" ".read reset_local_operational_data.sql"
--
-- DELETES (only these):
--   local_sale_items, local_payments, local_stock_movements, local_sales,
--   sync_outbox (all statuses: SALE and SHIFT events), local_employee_shifts,
--   local_active_operator.
-- UPDATES (only these):
--   local_pos_operators.has_shift_issue = 0
--   sync_metadata.last_sync_error = ''   (same value the app writes after a good sync)
--
-- KEEPS (verified by the checks below; any difference aborts):
--   schema_migrations, local_device (identity + authorization), local_pos_operators
--   (PIN salt/verifier, operator token, grant validity, lockout state),
--   catalog_categories, catalog_products, catalog_prices, catalog_product_categories,
--   local_weight_discounts, local_announcements, and every other sync_metadata key
--   (catalog_cursor, cash_discount_bps, max_shift_hours, last_successful_sync_at,
--   scale configuration).
--
-- Written for the schema after local migration 011. If the app was updated with
-- newer local migrations, review this script first (the schema_migrations check
-- below only guarantees ">= 11").
-- ============================================================================

pragma foreign_keys = on;

begin immediate;

-- ---------------------------------------------------------------------------
-- 0. Check machinery: a row with ok <> 1 aborts with a readable message.
-- ---------------------------------------------------------------------------
drop table if exists temp.reset_guard;
drop table if exists temp.reset_keep;
create temp table reset_guard (ok integer not null, what text not null);
create temp trigger reset_guard_check before insert on reset_guard
when new.ok <> 1
begin
  select raise(abort, 'RESET ABORTADO (rollback): ' || new.what);
end;

-- ---------------------------------------------------------------------------
-- 1. Preconditions.
-- ---------------------------------------------------------------------------
insert into reset_guard select case when coalesce((select max(version) from schema_migrations), 0) >= 11 then 1 else 0 end,
  'schema_migrations < 11: este script no corresponde a esta version de la base local';
insert into reset_guard select case when (select count(*) from local_device where singleton = 1) = 1 then 1 else 0 end,
  'no existe la fila local_device (dispositivo sin identidad); no es un POS inicializado';

-- ---------------------------------------------------------------------------
-- 2. Snapshot of everything that must survive.
-- ---------------------------------------------------------------------------
create temp table reset_keep (name text primary key, v text not null);
insert into reset_keep values
  ('n:schema_migrations',            (select count(*) from schema_migrations)),
  ('n:local_device',                 (select count(*) from local_device)),
  ('n:local_pos_operators',          (select count(*) from local_pos_operators)),
  ('n:catalog_categories',           (select count(*) from catalog_categories)),
  ('n:catalog_products',             (select count(*) from catalog_products)),
  ('n:catalog_prices',               (select count(*) from catalog_prices)),
  ('n:catalog_product_categories',   (select count(*) from catalog_product_categories)),
  ('n:local_weight_discounts',       (select count(*) from local_weight_discounts)),
  ('n:local_announcements',          (select count(*) from local_announcements)),
  ('n:sync_metadata',                (select count(*) from sync_metadata)),
  ('v:local_device', coalesce((select group_concat(
      device_id || '|' || coalesce(organization_id, '') || '|' || coalesce(branch_id, '') || '|' || device_status || '|' ||
      coalesce(profile_id, '') || '|' || coalesce(authorization_validated_at, '') || '|' || coalesce(authorization_expires_at, '') || '|' || updated_at, ';')
    from local_device), '')),
  ('v:local_pos_operators', coalesce((select group_concat(
      profile_id || '|' || has_pin || '|' || active || '|' || coalesce(pin_salt, '') || '|' || coalesce(pin_verifier, '') || '|' ||
      coalesce(operator_token, '') || '|' || coalesce(grant_valid_until, '') || '|' || coalesce(verified_at, '') || '|' ||
      failed_attempts || '|' || coalesce(locked_until, '') || '|' || updated_at, ';')
    from (select * from local_pos_operators order by profile_id)), '')),
  ('v:sync_metadata_other', coalesce((select group_concat(key || '=' || value, ';')
    from (select * from sync_metadata where key <> 'last_sync_error' order by key)), '')),
  ('v:catalog_prices', coalesce((select group_concat(product_id || '|' || branch_id || '|' || price_per_kg_cents, ';')
    from (select * from catalog_prices order by product_id, branch_id)), ''));

-- What is about to be removed (visible in the terminal for a last look).
select 'ANTES' as fase, 'local_sales' as tabla, count(*) as filas from local_sales
union all select 'ANTES', 'local_sale_items', count(*) from local_sale_items
union all select 'ANTES', 'local_payments', count(*) from local_payments
union all select 'ANTES', 'local_stock_movements', count(*) from local_stock_movements
union all select 'ANTES', 'sync_outbox (no SYNCED)', count(*) from sync_outbox where status <> 'SYNCED'
union all select 'ANTES', 'sync_outbox (total)', count(*) from sync_outbox
union all select 'ANTES', 'local_employee_shifts', count(*) from local_employee_shifts
union all select 'ANTES', 'local_active_operator', count(*) from local_active_operator;

-- ---------------------------------------------------------------------------
-- 3. Reset (children before parents; foreign_keys = on).
-- ---------------------------------------------------------------------------
delete from local_sale_items;
delete from local_payments;
delete from local_stock_movements;
delete from local_sales;
delete from sync_outbox;
delete from local_employee_shifts;
delete from local_active_operator;

update local_pos_operators set has_shift_issue = 0 where has_shift_issue <> 0;
update sync_metadata set value = '', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  where key = 'last_sync_error' and value <> '';

-- ---------------------------------------------------------------------------
-- 4. Verification. Any failure aborts (with -bail) and nothing is committed.
-- ---------------------------------------------------------------------------
insert into reset_guard select case when (select count(*) from local_sales) = 0 then 1 else 0 end, 'quedan ventas (local_sales)';
insert into reset_guard select case when (select count(*) from local_sale_items) = 0 then 1 else 0 end, 'quedan items de venta';
insert into reset_guard select case when (select count(*) from local_payments) = 0 then 1 else 0 end, 'quedan pagos';
insert into reset_guard select case when (select count(*) from local_stock_movements) = 0 then 1 else 0 end, 'quedan movimientos de stock locales';
insert into reset_guard select case when (select count(*) from sync_outbox) = 0 then 1 else 0 end, 'quedan filas en sync_outbox';
insert into reset_guard select case when (select count(*) from local_employee_shifts) = 0 then 1 else 0 end, 'quedan turnos locales';
insert into reset_guard select case when (select count(*) from local_active_operator) = 0 then 1 else 0 end, 'queda un operador activo';
insert into reset_guard select case when (select count(*) from local_pos_operators where has_shift_issue <> 0) = 0 then 1 else 0 end, 'quedan operadores con has_shift_issue = 1';
insert into reset_guard select case when coalesce((select value from sync_metadata where key = 'last_sync_error'), '') = '' then 1 else 0 end, 'last_sync_error no quedo vacio';

insert into reset_guard
select case when (select count(*) from schema_migrations) = (select v from reset_keep where name = 'n:schema_migrations') then 1 else 0 end, 'cambio schema_migrations';
insert into reset_guard
select case when (select count(*) from local_device) = (select v from reset_keep where name = 'n:local_device') then 1 else 0 end, 'cambio la cantidad de local_device';
insert into reset_guard
select case when (select count(*) from local_pos_operators) = (select v from reset_keep where name = 'n:local_pos_operators') then 1 else 0 end, 'cambio la cantidad de operadores';
insert into reset_guard
select case when (select count(*) from catalog_categories) = (select v from reset_keep where name = 'n:catalog_categories') then 1 else 0 end, 'cambio catalog_categories';
insert into reset_guard
select case when (select count(*) from catalog_products) = (select v from reset_keep where name = 'n:catalog_products') then 1 else 0 end, 'cambio catalog_products';
insert into reset_guard
select case when (select count(*) from catalog_prices) = (select v from reset_keep where name = 'n:catalog_prices') then 1 else 0 end, 'cambio catalog_prices';
insert into reset_guard
select case when (select count(*) from catalog_product_categories) = (select v from reset_keep where name = 'n:catalog_product_categories') then 1 else 0 end, 'cambio catalog_product_categories';
insert into reset_guard
select case when (select count(*) from local_weight_discounts) = (select v from reset_keep where name = 'n:local_weight_discounts') then 1 else 0 end, 'cambio local_weight_discounts';
insert into reset_guard
select case when (select count(*) from local_announcements) = (select v from reset_keep where name = 'n:local_announcements') then 1 else 0 end, 'cambio local_announcements';
insert into reset_guard
select case when (select count(*) from sync_metadata) = (select v from reset_keep where name = 'n:sync_metadata') then 1 else 0 end, 'cambio la cantidad de claves de sync_metadata';

insert into reset_guard
select case when coalesce((select group_concat(
      device_id || '|' || coalesce(organization_id, '') || '|' || coalesce(branch_id, '') || '|' || device_status || '|' ||
      coalesce(profile_id, '') || '|' || coalesce(authorization_validated_at, '') || '|' || coalesce(authorization_expires_at, '') || '|' || updated_at, ';')
    from local_device), '') = (select v from reset_keep where name = 'v:local_device') then 1 else 0 end,
  'cambio la identidad/autorizacion de local_device';
insert into reset_guard
select case when coalesce((select group_concat(
      profile_id || '|' || has_pin || '|' || active || '|' || coalesce(pin_salt, '') || '|' || coalesce(pin_verifier, '') || '|' ||
      coalesce(operator_token, '') || '|' || coalesce(grant_valid_until, '') || '|' || coalesce(verified_at, '') || '|' ||
      failed_attempts || '|' || coalesce(locked_until, '') || '|' || updated_at, ';')
    from (select * from local_pos_operators order by profile_id)), '') = (select v from reset_keep where name = 'v:local_pos_operators') then 1 else 0 end,
  'cambiaron PIN/salt/token/grants de los operadores';
insert into reset_guard
select case when coalesce((select group_concat(key || '=' || value, ';')
    from (select * from sync_metadata where key <> 'last_sync_error' order by key)), '') = (select v from reset_keep where name = 'v:sync_metadata_other') then 1 else 0 end,
  'cambio sync_metadata (catalog_cursor u otra clave)';
insert into reset_guard
select case when coalesce((select group_concat(product_id || '|' || branch_id || '|' || price_per_kg_cents, ';')
    from (select * from catalog_prices order by product_id, branch_id)), '') = (select v from reset_keep where name = 'v:catalog_prices') then 1 else 0 end,
  'cambiaron los precios del catalogo local';
insert into reset_guard
select case when (select count(*) from pragma_foreign_key_check) = 0 then 1 else 0 end, 'violaciones de foreign key';

-- Final state (visible in the terminal).
select 'DESPUES' as fase, 'local_sales' as tabla, count(*) as filas from local_sales
union all select 'DESPUES', 'sync_outbox', count(*) from sync_outbox
union all select 'DESPUES', 'local_employee_shifts', count(*) from local_employee_shifts
union all select 'DESPUES', 'local_device', count(*) from local_device
union all select 'DESPUES', 'local_pos_operators', count(*) from local_pos_operators
union all select 'DESPUES', 'catalog_products', count(*) from catalog_products
union all select 'DESPUES', 'catalog_prices', count(*) from catalog_prices
union all select 'DESPUES', 'catalog_cursor=' || coalesce((select value from sync_metadata where key = 'catalog_cursor'), '?'), 0;

commit;
