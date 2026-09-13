use std::{fs, sync::Mutex};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use uuid::Uuid;

const INITIAL_SCHEMA: &str = include_str!("../migrations/001_offline_core.sql");
const COMMERCIAL_SCHEMA: &str = include_str!("../migrations/002_commercial_config.sql");
const DISCOUNT_SNAPSHOT_SCHEMA: &str = include_str!("../migrations/003_discount_sale_snapshots.sql");
const CASH_DISCOUNT_SNAPSHOT_SCHEMA: &str = include_str!("../migrations/004_cash_discount_snapshots.sql");
const CATEGORY_COLORS_SCHEMA: &str = include_str!("../migrations/005_category_colors.sql");

struct DatabaseState(Mutex<Connection>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalRuntime {
    device_id: String,
    organization_id: Option<String>,
    branch_id: Option<String>,
    branch_name: Option<String>,
    profile_id: Option<String>,
    user_email: Option<String>,
    role_name: Option<String>,
    device_status: String,
    authorization_expires_at: Option<String>,
    catalog_cursor: i64,
    pending_count: i64,
    last_successful_sync_at: Option<String>,
    last_error: Option<String>,
    local_sales_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalCatalogRow {
    organization_id: String,
    branch_id: String,
    branch_name: String,
    category_id: String,
    category_name: String,
    category_color_hex: Option<String>,
    category_sort_order: i64,
    product_id: String,
    product_name: String,
    product_sku: Option<String>,
    unit_type: String,
    price_per_kg_cents: String,
    price_valid_from: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogPullRow {
    organization_id: String,
    branch_id: String,
    branch_name: String,
    category_id: String,
    category_name: String,
    category_color_hex: Option<String>,
    category_sort_order: i64,
    category_active: bool,
    product_id: String,
    product_name: String,
    product_sku: Option<String>,
    unit_type: String,
    product_active: bool,
    price_per_kg_cents: String,
    price_valid_from: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogPullPayload {
    cursor: i64,
    server_time: String,
    authorization_expires_at: String,
    organization_id: String,
    branch_id: String,
    branch_name: String,
    device_status: String,
    role_name: String,
    catalog: Vec<CatalogPullRow>,
    removed_product_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommercialDiscount { id: String, product_id: String, branch_id: Option<String>, minimum_grams: i64, discount_type: String, discount_value: String }
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAnnouncement { id: String, title: String, message: String, r#type: String, priority: i64, branch_id: Option<String> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalCommercialConfig { cash_discount_bps: i64, discounts: Vec<LocalDiscount>, announcements: Vec<LocalAnnouncement> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDiscount { id: String, product_id: String, branch_id: Option<String>, minimum_grams: i64, discount_type: String, discount_value: String }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommercialConfig { #[serde(default)] cash_discount_bps: i64, discounts: Vec<CommercialDiscount>, announcements: Vec<LocalAnnouncement> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflineSaleItem {
    id: String,
    product_id: String,
    product_name_snapshot: String,
    weight_grams: i64,
    price_per_kg_cents: String,
    #[serde(default)] original_price_per_kg_cents: Option<String>,
    #[serde(default)] discount_rule_id: Option<String>,
    #[serde(default)] discount_type: Option<String>,
    #[serde(default)] discount_value: Option<String>,
    #[serde(default)] discount_cents: Option<String>,
    #[serde(default)] cash_discount_bps: Option<String>,
    #[serde(default)] cash_discount_cents: Option<String>,
    #[serde(default)] promotion_discount_cents: Option<String>,
    #[serde(default)] cost_cents_snapshot: Option<String>,
    #[serde(default)] profit_markup_bps_snapshot: Option<String>,
    subtotal_cents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflinePayment {
    id: String,
    method: String,
    amount_cents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflineStockMovement {
    id: String,
    product_id: String,
    quantity_grams: String,
    occurred_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflineSalePayload {
    schema_version: i64,
    event_id: String,
    sale_id: String,
    organization_id: String,
    branch_id: String,
    profile_id: String,
    device_id: String,
    status: String,
    total_cents: String,
    total_weight_grams: String,
    created_at: String,
    completed_at: String,
    items: Vec<OfflineSaleItem>,
    payment: OfflinePayment,
    stock_movements: Vec<OfflineStockMovement>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSaleReceipt {
    sale_id: String,
    total_cents: String,
    total_weight_grams: String,
    completed_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentLocalSale {
    sale_id: String,
    status: String,
    total_cents: String,
    total_weight_grams: String,
    completed_at: String,
    synced_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboxSummary { pending: i64, syncing: i64, failed: i64, synced: i64, last_error: Option<String> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboxRecord {
    id: String,
    aggregate_type: String,
    aggregate_id: String,
    operation: String,
    payload: OfflineSalePayload,
    status: String,
    attempts: i64,
    created_at: String,
    last_attempt_at: Option<String>,
    next_attempt_at: String,
    last_error: Option<String>,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn parse_i64(value: &str, field: &str) -> Result<i64, String> {
    value.parse::<i64>().map_err(|_| format!("Invalid {field}"))
}

fn payment_method_receives_discount(method: &str) -> bool {
    matches!(method, "CASH" | "TRANSFER" | "OTHER")
}

fn initialize_connection(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "pragma foreign_keys = on;
             create table if not exists schema_migrations (
               version integer primary key,
               applied_at text not null
             );",
        )
        .map_err(|error| error.to_string())?;

    let applied = connection
        .query_row(
            "select exists(select 1 from schema_migrations where version = 1)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;

    if !applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(INITIAL_SCHEMA).map_err(|error| error.to_string())?;
        transaction
            .execute(
                "insert into schema_migrations(version, applied_at) values (1, ?1)",
                [now()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let commercial_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 2)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !commercial_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(COMMERCIAL_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (2, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let snapshots_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 3)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !snapshots_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(DISCOUNT_SNAPSHOT_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (3, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let cash_snapshots_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 4)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !cash_snapshots_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(CASH_DISCOUNT_SNAPSHOT_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (4, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let category_colors_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 5)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !category_colors_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(CATEGORY_COLORS_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (5, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    let timestamp = now();
    connection
        .execute(
            "insert or ignore into local_device(singleton, device_id, created_at, updated_at)
             values (1, ?1, ?2, ?2)",
            params![Uuid::new_v4().to_string(), timestamp],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "update sync_outbox
             set status = 'FAILED', last_error = 'Recovered after application restart', next_attempt_at = ?1
             where status = 'SYNCING'",
            [now()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn metadata(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row("select value from sync_metadata where key = ?1", [key], |row| row.get(0))
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_local_runtime(state: State<'_, DatabaseState>) -> Result<LocalRuntime, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let mut runtime = connection
        .query_row(
            "select device_id, organization_id, branch_id, branch_name, profile_id, user_email,
                    role_name, device_status, authorization_expires_at
             from local_device where singleton = 1",
            [],
            |row| {
                Ok(LocalRuntime {
                    device_id: row.get(0)?,
                    organization_id: row.get(1)?,
                    branch_id: row.get(2)?,
                    branch_name: row.get(3)?,
                    profile_id: row.get(4)?,
                    user_email: row.get(5)?,
                    role_name: row.get(6)?,
                    device_status: row.get(7)?,
                    authorization_expires_at: row.get(8)?,
                    catalog_cursor: 0,
                    pending_count: 0,
                    last_successful_sync_at: None,
                    last_error: None,
                    local_sales_count: 0,
                })
            },
        )
        .map_err(|error| error.to_string())?;

    runtime.catalog_cursor = metadata(&connection, "catalog_cursor")?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    runtime.last_successful_sync_at = metadata(&connection, "last_successful_sync_at")?;
    runtime.last_error = metadata(&connection, "last_sync_error")?;
    runtime.pending_count = connection
        .query_row(
            "select count(*) from sync_outbox where status <> 'SYNCED'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    runtime.local_sales_count = connection
        .query_row("select count(*) from local_sales", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(runtime)
}

#[tauri::command]
fn get_local_catalog(state: State<'_, DatabaseState>, branch_id: String) -> Result<Vec<LocalCatalogRow>, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let branch_name: String = connection
        .query_row("select branch_name from local_device where singleton = 1 and branch_id = ?1", [&branch_id], |row| row.get(0))
        .map_err(|_| "Device is not assigned to this branch".to_string())?;
    let mut statement = connection
        .prepare(
            "select p.organization_id, cp.branch_id, c.id, c.name, c.color_hex, c.sort_order,
                    p.id, p.name, p.sku, p.unit_type, cp.price_per_kg_cents, cp.valid_from
             from catalog_products p
             join catalog_categories c on c.id = p.category_id and c.active = 1
             join catalog_prices cp on cp.product_id = p.id and cp.branch_id = ?1
             where p.active = 1
             order by c.sort_order, c.name, p.name",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([&branch_id], |row| {
            Ok(LocalCatalogRow {
                organization_id: row.get(0)?,
                branch_id: row.get(1)?,
                branch_name: branch_name.clone(),
                category_id: row.get(2)?,
                category_name: row.get(3)?,
                category_color_hex: row.get(4)?,
                category_sort_order: row.get(5)?,
                product_id: row.get(6)?,
                product_name: row.get(7)?,
                product_sku: row.get(8)?,
                unit_type: row.get(9)?,
                price_per_kg_cents: row.get::<_, i64>(10)?.to_string(),
                price_valid_from: row.get(11)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_catalog_pull(
    state: State<'_, DatabaseState>,
    pull: CatalogPullPayload,
    profile_id: String,
    user_email: String,
) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let timestamp = now();

    transaction
        .execute(
            "update local_device set organization_id = ?1, branch_id = ?2, branch_name = ?3,
                    profile_id = ?4, user_email = ?5, role_name = ?6, device_status = ?7,
                    authorization_validated_at = ?8, authorization_expires_at = ?9, updated_at = ?8
             where singleton = 1",
            params![pull.organization_id, pull.branch_id, pull.branch_name, profile_id, user_email,
                    pull.role_name, pull.device_status, pull.server_time, pull.authorization_expires_at],
        )
        .map_err(|error| error.to_string())?;

    for product_id in &pull.removed_product_ids {
        transaction
            .execute("update catalog_products set active = 0, updated_at = ?2 where id = ?1", params![product_id, timestamp])
            .map_err(|error| error.to_string())?;
    }

    for row in &pull.catalog {
        let price = parse_i64(&row.price_per_kg_cents, "pricePerKgCents")?;
        transaction
            .execute(
                "insert into catalog_categories(id, organization_id, name, color_hex, sort_order, active, updated_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 on conflict(id) do update set name = excluded.name, sort_order = excluded.sort_order,
                   color_hex = excluded.color_hex, active = excluded.active, updated_at = excluded.updated_at",
                params![row.category_id, row.organization_id, row.category_name, row.category_color_hex, row.category_sort_order,
                        if row.category_active { 1_i64 } else { 0_i64 }, timestamp],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "insert into catalog_products(id, organization_id, category_id, name, sku, unit_type, active, updated_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 on conflict(id) do update set category_id = excluded.category_id, name = excluded.name,
                   sku = excluded.sku, unit_type = excluded.unit_type, active = excluded.active, updated_at = excluded.updated_at",
                params![row.product_id, row.organization_id, row.category_id, row.product_name, row.product_sku,
                        row.unit_type, if row.product_active { 1_i64 } else { 0_i64 }, timestamp],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "insert into catalog_prices(product_id, branch_id, price_per_kg_cents, valid_from, synced_at)
                 values (?1, ?2, ?3, ?4, ?5)
                 on conflict(product_id, branch_id) do update set price_per_kg_cents = excluded.price_per_kg_cents,
                   valid_from = excluded.valid_from, synced_at = excluded.synced_at",
                params![row.product_id, row.branch_id, price, row.price_valid_from, timestamp],
            )
            .map_err(|error| error.to_string())?;
    }

    set_metadata(&transaction, "catalog_cursor", &pull.cursor.to_string(), &timestamp)?;
    set_metadata(&transaction, "last_successful_sync_at", &pull.server_time, &timestamp)?;
    set_metadata(&transaction, "last_sync_error", "", &timestamp)?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_commercial_config(state: State<'_, DatabaseState>, config: CommercialConfig) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction.execute("delete from local_weight_discounts", []).map_err(|error| error.to_string())?;
    transaction.execute("delete from local_announcements", []).map_err(|error| error.to_string())?;
    for discount in config.discounts { transaction.execute("insert into local_weight_discounts(id,product_id,branch_id,minimum_grams,discount_type,discount_value) values(?1,?2,?3,?4,?5,?6)", params![discount.id,discount.product_id,discount.branch_id,discount.minimum_grams,discount.discount_type,parse_i64(&discount.discount_value,"discountValue")?]).map_err(|error| error.to_string())?; }
    for notice in config.announcements { transaction.execute("insert into local_announcements(id,title,message,type,priority,branch_id) values(?1,?2,?3,?4,?5,?6)", params![notice.id,notice.title,notice.message,notice.r#type,notice.priority,notice.branch_id]).map_err(|error| error.to_string())?; }
    if !(0..10_000).contains(&config.cash_discount_bps) { return Err("Invalid cash discount configuration".to_string()); }
    set_metadata(&transaction, "cash_discount_bps", &config.cash_discount_bps.to_string(), &now())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_local_commercial_config(state: State<'_, DatabaseState>) -> Result<LocalCommercialConfig, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let mut discounts = connection.prepare("select id,product_id,branch_id,minimum_grams,discount_type,discount_value from local_weight_discounts order by minimum_grams desc, branch_id is not null desc").map_err(|e| e.to_string())?;
    let discounts = discounts.query_map([], |r| Ok(LocalDiscount { id:r.get(0)?, product_id:r.get(1)?, branch_id:r.get(2)?, minimum_grams:r.get(3)?, discount_type:r.get(4)?, discount_value:r.get::<_,i64>(5)?.to_string() })).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let mut notices = connection.prepare("select id,title,message,type,priority,branch_id from local_announcements order by priority desc").map_err(|e|e.to_string())?;
    let announcements = notices.query_map([], |r| Ok(LocalAnnouncement { id:r.get(0)?, title:r.get(1)?, message:r.get(2)?, r#type:r.get(3)?, priority:r.get(4)?, branch_id:r.get(5)? })).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let cash_discount_bps = metadata(&connection, "cash_discount_bps")?.and_then(|value| value.parse().ok()).unwrap_or(0);
    Ok(LocalCommercialConfig { cash_discount_bps, discounts, announcements })
}

fn set_metadata(transaction: &Transaction<'_>, key: &str, value: &str, timestamp: &str) -> Result<(), String> {
    transaction
        .execute(
            "insert into sync_metadata(key, value, updated_at) values (?1, ?2, ?3)
             on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, timestamp],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_sale(transaction: &Transaction<'_>, sale: &OfflineSalePayload) -> Result<(), String> {
    if sale.schema_version != 1 || sale.status != "COMPLETED" || sale.items.is_empty() || sale.items.len() > 100 {
        return Err("Unsupported or empty offline sale".to_string());
    }
    if sale.items.len() != sale.stock_movements.len() {
        return Err("Every sale item needs one stock movement".to_string());
    }

    let authorized: bool = transaction
        .query_row(
            "select exists(
               select 1 from local_device
               where singleton = 1 and device_id = ?1 and organization_id = ?2 and branch_id = ?3
                 and profile_id = ?4 and device_status = 'ACTIVE'
                 and julianday(authorization_expires_at) > julianday(?5)
             )",
            params![sale.device_id, sale.organization_id, sale.branch_id, sale.profile_id, now()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !authorized {
        return Err("Offline authorization is missing, expired, or does not match this device".to_string());
    }

    let mut computed_total = 0_i64;
    let mut computed_weight = 0_i64;
    for item in &sale.items {
        let price = parse_i64(&item.price_per_kg_cents, "pricePerKgCents")?;
        let original_price = item.original_price_per_kg_cents.as_deref().map(|value| parse_i64(value, "originalPricePerKgCents")).transpose()?.unwrap_or(price);
        let subtotal = parse_i64(&item.subtotal_cents, "subtotalCents")?;
        let discount_cents = item.discount_cents.as_deref().map(|value| parse_i64(value, "discountCents")).transpose()?.unwrap_or(0);
        let cash_discount_bps = item.cash_discount_bps.as_deref().map(|value| parse_i64(value, "cashDiscountBps")).transpose()?.unwrap_or(0);
        let cash_discount_cents = item.cash_discount_cents.as_deref().map(|value| parse_i64(value, "cashDiscountCents")).transpose()?.unwrap_or(0);
        let promotion_discount_cents = item.promotion_discount_cents.as_deref().map(|value| parse_i64(value, "promotionDiscountCents")).transpose()?.unwrap_or(discount_cents - cash_discount_cents);
        if item.weight_grams <= 0 || !(0..10_000).contains(&cash_discount_bps) || (!payment_method_receives_discount(&sale.payment.method) && cash_discount_bps != 0) {
            return Err("Invalid local sale calculation".to_string());
        }
        let expected = price
            .checked_mul(item.weight_grams)
            .and_then(|value| value.checked_add(500))
            .map(|value| value / 1000)
            .ok_or_else(|| "Sale amount overflow".to_string())?;
        let normal_subtotal = original_price.checked_mul(item.weight_grams).and_then(|value| value.checked_add(500)).map(|value| value / 1000).ok_or_else(|| "Sale amount overflow".to_string())?;
        let cash_price = original_price.checked_mul(10_000 - cash_discount_bps).and_then(|value| value.checked_add(5_000)).map(|value| value / 10_000).ok_or_else(|| "Sale amount overflow".to_string())?;
        let cash_subtotal = cash_price.checked_mul(item.weight_grams).and_then(|value| value.checked_add(500)).map(|value| value / 1000).ok_or_else(|| "Sale amount overflow".to_string())?;
        let has_new_pricing = item.cash_discount_bps.is_some() || item.promotion_discount_cents.is_some();
        match item.discount_type.as_deref() {
            Some("PERCENTAGE") => {
                let value = item.discount_value.as_deref().ok_or_else(|| "Missing percentage promotion value".to_string()).and_then(|value| parse_i64(value, "discountValue"))?;
                if !(1..=10_000).contains(&value) { return Err("Invalid percentage promotion".to_string()); }
                let rounded = cash_price.checked_mul(10_000 - value).and_then(|amount| amount.checked_add(5_000)).map(|amount| amount / 10_000).ok_or_else(|| "Sale amount overflow".to_string())?;
                let legacy = cash_price.checked_mul(10_000 - value).map(|amount| amount / 10_000).ok_or_else(|| "Sale amount overflow".to_string())?;
                if price != rounded && (has_new_pricing || price != legacy) { return Err("Percentage promotion snapshot is inconsistent".to_string()); }
            }
            Some("FIXED_PRICE_PER_KG") => {
                let value = item.discount_value.as_deref().ok_or_else(|| "Missing fixed-price promotion value".to_string()).and_then(|value| parse_i64(value, "discountValue"))?;
                if price != value || price > cash_price { return Err("Fixed-price promotion snapshot is inconsistent".to_string()); }
            }
            Some(_) => return Err("Unsupported promotion type".to_string()),
            None if price != cash_price => return Err("Undiscounted snapshot is inconsistent".to_string()),
            None => {}
        }
        if subtotal != expected || cash_discount_cents != normal_subtotal - cash_subtotal || promotion_discount_cents != cash_subtotal - subtotal || discount_cents != cash_discount_cents + promotion_discount_cents {
            return Err("Invalid local sale calculation".to_string());
        }
        let catalog_matches: bool = transaction
            .query_row(
                "select exists(
                   select 1 from catalog_products p join catalog_prices cp on cp.product_id = p.id
                   where p.id = ?1 and p.active = 1 and cp.branch_id = ?2 and cp.price_per_kg_cents = ?3
                 )",
                params![item.product_id, sale.branch_id, original_price],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !catalog_matches {
            return Err(format!("Product {} is unavailable or its local price changed", item.product_id));
        }
        computed_total = computed_total.checked_add(subtotal).ok_or_else(|| "Sale total overflow".to_string())?;
        computed_weight = computed_weight.checked_add(item.weight_grams).ok_or_else(|| "Sale weight overflow".to_string())?;
    }

    if parse_i64(&sale.total_cents, "totalCents")? != computed_total
        || parse_i64(&sale.total_weight_grams, "totalWeightGrams")? != computed_weight
        || parse_i64(&sale.payment.amount_cents, "payment.amountCents")? != computed_total
    {
        return Err("Sale, item, and payment totals differ".to_string());
    }

    transaction
        .execute(
            "insert into local_sales(id, organization_id, branch_id, profile_id, device_id, status,
              total_cents, total_weight_grams, created_at, completed_at)
             values (?1, ?2, ?3, ?4, ?5, 'COMPLETED', ?6, ?7, ?8, ?9)",
            params![sale.sale_id, sale.organization_id, sale.branch_id, sale.profile_id, sale.device_id,
                    computed_total, computed_weight, sale.created_at, sale.completed_at],
        )
        .map_err(|error| error.to_string())?;

    for item in &sale.items {
        let original_price = item.original_price_per_kg_cents.as_deref().map(|value| parse_i64(value, "originalPricePerKgCents")).transpose()?.unwrap_or_else(|| parse_i64(&item.price_per_kg_cents, "pricePerKgCents").unwrap_or(0));
        let discount_value = item.discount_value.as_deref().map(|value| parse_i64(value, "discountValue")).transpose()?;
        let discount_cents = item.discount_cents.as_deref().map(|value| parse_i64(value, "discountCents")).transpose()?.unwrap_or(0);
        let cash_discount_bps = item.cash_discount_bps.as_deref().map(|value| parse_i64(value, "cashDiscountBps")).transpose()?.unwrap_or(0);
        let cash_discount_cents = item.cash_discount_cents.as_deref().map(|value| parse_i64(value, "cashDiscountCents")).transpose()?.unwrap_or(0);
        let promotion_discount_cents = item.promotion_discount_cents.as_deref().map(|value| parse_i64(value, "promotionDiscountCents")).transpose()?.unwrap_or(discount_cents - cash_discount_cents);
        let cost_snapshot = item.cost_cents_snapshot.as_deref().map(|value| parse_i64(value, "costCentsSnapshot")).transpose()?;
        let profit_snapshot = item.profit_markup_bps_snapshot.as_deref().map(|value| parse_i64(value, "profitMarkupBpsSnapshot")).transpose()?;
        transaction
            .execute(
                "insert into local_sale_items(id, sale_id, product_id, product_name_snapshot, weight_grams,
                  price_per_kg_cents, original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, discount_cents, cash_discount_bps, cash_discount_cents, promotion_discount_cents, cost_cents_snapshot, profit_markup_bps_snapshot, subtotal_cents, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                params![item.id, sale.sale_id, item.product_id, item.product_name_snapshot, item.weight_grams,
                        parse_i64(&item.price_per_kg_cents, "pricePerKgCents")?, original_price, item.discount_rule_id, item.discount_type, discount_value, discount_cents, cash_discount_bps, cash_discount_cents, promotion_discount_cents, cost_snapshot, profit_snapshot, parse_i64(&item.subtotal_cents, "subtotalCents")?, sale.created_at],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "insert into local_payments(id, sale_id, method, amount_cents, created_at) values (?1, ?2, ?3, ?4, ?5)",
            params![sale.payment.id, sale.sale_id, sale.payment.method, computed_total, sale.created_at],
        )
        .map_err(|error| error.to_string())?;
    for movement in &sale.stock_movements {
        transaction
            .execute(
                "insert into local_stock_movements(id, sale_id, organization_id, branch_id, product_id,
                  movement_type, quantity_grams, profile_id, occurred_at, created_at)
                 values (?1, ?2, ?3, ?4, ?5, 'SALE', ?6, ?7, ?8, ?9)",
                params![movement.id, sale.sale_id, sale.organization_id, sale.branch_id, movement.product_id,
                        parse_i64(&movement.quantity_grams, "quantityGrams")?, sale.profile_id,
                        movement.occurred_at, sale.created_at],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn confirm_local_sale(state: State<'_, DatabaseState>, sale: OfflineSalePayload) -> Result<LocalSaleReceipt, String> {
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    insert_sale(&transaction, &sale)?;
    let serialized = serde_json::to_string(&sale).map_err(|error| error.to_string())?;
    transaction
        .execute(
            "insert into sync_outbox(id, aggregate_type, aggregate_id, operation, payload, status,
              attempts, created_at, next_attempt_at)
             values (?1, 'SALE', ?2, 'UPSERT', ?3, 'PENDING', 0, ?4, ?4)",
            params![sale.event_id, sale.sale_id, serialized, sale.created_at],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(LocalSaleReceipt {
        sale_id: sale.sale_id,
        total_cents: sale.total_cents,
        total_weight_grams: sale.total_weight_grams,
        completed_at: sale.completed_at,
    })
}

#[tauri::command]
fn get_recent_local_sales(state: State<'_, DatabaseState>, limit: i64) -> Result<Vec<RecentLocalSale>, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let safe_limit = limit.clamp(1, 25);
    let mut statement = connection
        .prepare(
            "select id, status, total_cents, total_weight_grams, completed_at, synced_at
             from local_sales order by completed_at desc, id desc limit ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([safe_limit], |row| {
            Ok(RecentLocalSale {
                sale_id: row.get(0)?,
                status: row.get(1)?,
                total_cents: row.get::<_, i64>(2)?.to_string(),
                total_weight_grams: row.get::<_, i64>(3)?.to_string(),
                completed_at: row.get(4)?,
                synced_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_due_outbox(state: State<'_, DatabaseState>, current_time: String) -> Result<Vec<OutboxRecord>, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let mut statement = connection
        .prepare(
            "select id, aggregate_type, aggregate_id, operation, payload, status, attempts,
                    created_at, last_attempt_at, next_attempt_at, last_error
             from sync_outbox where status <> 'SYNCED' and next_attempt_at <= ?1
             order by created_at, id limit 100",
        )
        .map_err(|error| error.to_string())?;
    let mapped = statement
        .query_map([current_time], |row| {
            let payload: String = row.get(4)?;
            Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, payload, row.get::<_, String>(5)?, row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, String>(9)?,
                row.get::<_, Option<String>>(10)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut records = Vec::new();
    for row in mapped {
        let (id, aggregate_type, aggregate_id, operation, payload, status, attempts, created_at,
            last_attempt_at, next_attempt_at, last_error) = row.map_err(|error| error.to_string())?;
        records.push(OutboxRecord {
            id,
            aggregate_type,
            aggregate_id,
            operation,
            payload: serde_json::from_str(&payload).map_err(|error| error.to_string())?,
            status,
            attempts,
            created_at,
            last_attempt_at,
            next_attempt_at,
            last_error,
        });
    }
    Ok(records)
}

#[tauri::command]
fn get_outbox_summary(state: State<'_, DatabaseState>) -> Result<OutboxSummary, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    connection.query_row(
        "select count(*) filter(where status='PENDING'), count(*) filter(where status='SYNCING'), count(*) filter(where status='FAILED'), count(*) filter(where status='SYNCED'), (select last_error from sync_outbox where last_error is not null order by last_attempt_at desc limit 1) from sync_outbox",
        [], |row| Ok(OutboxSummary { pending: row.get(0)?, syncing: row.get(1)?, failed: row.get(2)?, synced: row.get(3)?, last_error: row.get(4)? })
    ).map_err(|error| error.to_string())
}

#[tauri::command]
fn mark_outbox_syncing(state: State<'_, DatabaseState>, event_id: String, attempted_at: String) -> Result<(), String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    connection
        .execute(
            "update sync_outbox set status = 'SYNCING', attempts = attempts + 1,
              last_attempt_at = ?2, last_error = null where id = ?1 and status <> 'SYNCED'",
            params![event_id, attempted_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn mark_outbox_synced(state: State<'_, DatabaseState>, event_id: String, synced_at: String) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let sale_id: String = transaction
        .query_row("select aggregate_id from sync_outbox where id = ?1", [&event_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "update sync_outbox set status = 'SYNCED', synced_at = ?2, next_attempt_at = ?2,
              last_error = null where id = ?1",
            params![event_id, synced_at],
        )
        .map_err(|error| error.to_string())?;
    transaction.execute("update local_sales set synced_at = ?2 where id = ?1", params![sale_id, synced_at])
        .map_err(|error| error.to_string())?;
    transaction.execute("update local_stock_movements set synced_at = ?2 where sale_id = ?1", params![sale_id, synced_at])
        .map_err(|error| error.to_string())?;
    set_metadata(&transaction, "last_successful_sync_at", &synced_at, &synced_at)?;
    set_metadata(&transaction, "last_sync_error", "", &synced_at)?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn mark_outbox_failed(
    state: State<'_, DatabaseState>,
    event_id: String,
    error: String,
    next_attempt_at: String,
) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            "update sync_outbox set status = 'FAILED', last_error = ?2, next_attempt_at = ?3
             where id = ?1 and status <> 'SYNCED'",
            params![event_id, error, next_attempt_at],
        )
        .map_err(|error| error.to_string())?;
    set_metadata(&transaction, "last_sync_error", &error, &now())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn force_outbox_retry(state: State<'_, DatabaseState>, event_id: String) -> Result<(), String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    connection
        .execute(
            "update sync_outbox set status = 'PENDING', next_attempt_at = ?2 where id = ?1",
            params![event_id, now()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn force_last_outbox_retry(state: State<'_, DatabaseState>) -> Result<Option<String>, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let event_id = connection
        .query_row(
            "select id from sync_outbox order by created_at desc, id desc limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(id) = &event_id {
        connection
            .execute(
                "update sync_outbox set status = 'PENDING', next_attempt_at = ?2 where id = ?1",
                params![id, now()],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(event_id)
}

#[tauri::command]
fn clear_offline_authorization(state: State<'_, DatabaseState>) -> Result<(), String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    connection
        .execute(
            "update local_device set profile_id = null, user_email = null, role_name = null,
              authorization_validated_at = null, authorization_expires_at = null, updated_at = ?1
             where singleton = 1",
            [now()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data)?;
            let mut connection = Connection::open(app_data.join("carnicerias-pos.sqlite"))?;
            initialize_connection(&mut connection).map_err(std::io::Error::other)?;
            app.manage(DatabaseState(Mutex::new(connection)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_local_runtime,
            get_local_catalog,
            apply_catalog_pull,
            apply_commercial_config,
            get_local_commercial_config,
            confirm_local_sale,
            get_recent_local_sales,
            get_due_outbox,
            get_outbox_summary,
            mark_outbox_syncing,
            mark_outbox_synced,
            mark_outbox_failed,
            force_outbox_retry,
            force_last_outbox_retry,
            clear_offline_authorization
        ])
        .run(tauri::generate_context!())
        .expect("error while running Carnicerías POS");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_create_a_stable_device_and_recover_syncing_events() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let first: String = connection.query_row("select device_id from local_device", [], |row| row.get(0)).unwrap();
        connection.execute("insert into catalog_categories(id,organization_id,name,color_hex,sort_order,active,updated_at) values('color-category','org','Cerdo','#E99BAD',0,1,'2026-09-13T00:00:00Z')", []).unwrap();
        initialize_connection(&mut connection).unwrap();
        let second: String = connection.query_row("select device_id from local_device", [], |row| row.get(0)).unwrap();
        assert_eq!(first, second);
        assert_eq!(connection.query_row("select count(*) from schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 5);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'discount_cents'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'cash_discount_cents'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select color_hex from catalog_categories where id='color-category'", [], |row| row.get::<_,String>(0)).unwrap(), "#E99BAD");
        assert!(payment_method_receives_discount("CASH"));
        assert!(payment_method_receives_discount("TRANSFER"));
        assert!(payment_method_receives_discount("OTHER"));
        assert!(!payment_method_receives_discount("DEBIT"));
        assert!(!payment_method_receives_discount("CREDIT"));
    }

    #[test]
    fn discounted_cash_sale_persists_separated_snapshots() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        connection.execute("update local_device set organization_id='org',branch_id='branch',profile_id='profile',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into catalog_categories(id,organization_id,name,sort_order,active,updated_at) values('category','org','Carnes',0,1,'2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_products values('product','org','category','Asado',null,'WEIGHT',1,'2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_prices values('product','branch',1444444,'2026-09-13T00:00:00Z','2026-09-13T00:00:00Z')", []).unwrap();
        let device_id: String = connection.query_row("select device_id from local_device", [], |row| row.get(0)).unwrap();
        let sale = OfflineSalePayload {
            schema_version: 1, event_id: Uuid::new_v4().to_string(), sale_id: Uuid::new_v4().to_string(),
            organization_id: "org".into(), branch_id: "branch".into(), profile_id: "profile".into(), device_id,
            status: "COMPLETED".into(), total_cents: "1235000".into(), total_weight_grams: "1000".into(),
            created_at: "2026-09-13T00:00:00Z".into(), completed_at: "2026-09-13T00:00:00Z".into(),
            items: vec![OfflineSaleItem { id: Uuid::new_v4().to_string(), product_id: "product".into(), product_name_snapshot: "Asado".into(), weight_grams: 1000,
                price_per_kg_cents: "1235000".into(), original_price_per_kg_cents: Some("1444444".into()), discount_rule_id: Some(Uuid::new_v4().to_string()), discount_type: Some("PERCENTAGE".into()), discount_value: Some("500".into()), discount_cents: Some("209444".into()),
                cash_discount_bps: Some("1000".into()), cash_discount_cents: Some("144444".into()), promotion_discount_cents: Some("65000".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "1235000".into() }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "CASH".into(), amount_cents: "1235000".into() },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-1000".into(), occurred_at: "2026-09-13T00:00:00Z".into() }]
        };
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select cash_discount_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 144444);
        assert_eq!(connection.query_row("select promotion_discount_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 65000);
    }
}
