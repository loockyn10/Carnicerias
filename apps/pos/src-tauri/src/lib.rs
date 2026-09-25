use std::{fs, sync::{atomic::{AtomicBool, Ordering}, Mutex}};

use chrono::Utc;
use argon2::Argon2;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use uuid::Uuid;

mod scale;

const INITIAL_SCHEMA: &str = include_str!("../migrations/001_offline_core.sql");
const COMMERCIAL_SCHEMA: &str = include_str!("../migrations/002_commercial_config.sql");
const DISCOUNT_SNAPSHOT_SCHEMA: &str = include_str!("../migrations/003_discount_sale_snapshots.sql");
const CASH_DISCOUNT_SNAPSHOT_SCHEMA: &str = include_str!("../migrations/004_cash_discount_snapshots.sql");
const CATEGORY_COLORS_SCHEMA: &str = include_str!("../migrations/005_category_colors.sql");
const POS_OPERATORS_TIMEKEEPING_SCHEMA: &str = include_str!("../migrations/006_pos_operators_timekeeping.sql");
const WEIGHT_DISCOUNT_PACK_MODE_SCHEMA: &str = include_str!("../migrations/007_weight_discount_pack_mode.sql");
const PRODUCT_CATEGORY_ASSIGNMENTS_SCHEMA: &str = include_str!("../migrations/008_product_category_assignments.sql");
const UNIT_SALE_SUPPORT_SCHEMA: &str = include_str!("../migrations/009_unit_sale_support.sql");
const CARD_SURCHARGE_PRICING_SCHEMA: &str = include_str!("../migrations/010_card_surcharge_pricing.sql");

struct DatabaseState(Mutex<Connection>);
struct OperatorSessionState(AtomicBool);

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
    category_ids: Vec<String>,
    product_id: String,
    product_name: String,
    product_sku: Option<String>,
    unit_type: String,
    price_per_kg_cents: String,
    price_valid_from: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalCategoryRow {
    id: String,
    name: String,
    color_hex: Option<String>,
    sort_order: i64,
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
    #[serde(default)]
    category_ids: Vec<String>,
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
struct CatalogDirectoryCategory {
    id: String,
    name: String,
    color_hex: Option<String>,
    sort_order: i64,
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
    #[serde(default)]
    categories: Vec<CatalogDirectoryCategory>,
}

fn default_threshold_mode() -> String { "THRESHOLD".to_string() }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommercialDiscount {
    id: String,
    product_id: String,
    branch_id: Option<String>,
    #[serde(default = "default_threshold_mode")]
    promotion_mode: String,
    minimum_grams: Option<i64>,
    discount_type: Option<String>,
    discount_value: Option<String>,
    #[serde(default)] pack_quantity_grams: Option<i64>,
    #[serde(default)] pack_quantity_units: Option<i64>,
    #[serde(default)] pack_price_cents: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAnnouncement { id: String, title: String, message: String, r#type: String, priority: i64, branch_id: Option<String> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalCommercialConfig { cash_discount_bps: i64, discounts: Vec<LocalDiscount>, announcements: Vec<LocalAnnouncement> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDiscount {
    id: String,
    product_id: String,
    branch_id: Option<String>,
    promotion_mode: String,
    minimum_grams: Option<i64>,
    discount_type: Option<String>,
    discount_value: Option<String>,
    pack_quantity_grams: Option<i64>,
    pack_quantity_units: Option<i64>,
    pack_price_cents: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommercialConfig { #[serde(default)] cash_discount_bps: i64, discounts: Vec<CommercialDiscount>, announcements: Vec<LocalAnnouncement> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflineSaleItem {
    id: String,
    product_id: String,
    product_name_snapshot: String,
    #[serde(default)] weight_grams: Option<i64>,
    #[serde(default)] quantity_units: Option<i64>,
    price_per_kg_cents: String,
    #[serde(default)] original_price_per_kg_cents: Option<String>,
    #[serde(default)] discount_rule_id: Option<String>,
    #[serde(default)] discount_type: Option<String>,
    #[serde(default)] discount_value: Option<String>,
    #[serde(default)] promotion_mode: Option<String>,
    #[serde(default)] discount_cents: Option<String>,
    #[serde(default)] cash_discount_bps: Option<String>,
    #[serde(default)] cash_discount_cents: Option<String>,
    #[serde(default)] card_surcharge_cents: Option<String>,
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
    #[serde(default)]
    operator_token: Option<String>,
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
    payload: serde_json::Value,
    status: String,
    attempts: i64,
    created_at: String,
    last_attempt_at: Option<String>,
    next_attempt_at: String,
    last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperatorRosterRow { profile_id: String, display_name: String, role_name: String, has_pin: bool, has_shift_issue: bool }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedOperatorInput { profile_id: String, display_name: String, role_name: String, operator_token: String, valid_until: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalOperator { profile_id: String, display_name: String, role_name: String, has_pin: bool, has_shift_issue: bool, operator_token: Option<String>, valid_until: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalShift { shift_id: String, employee_id: String, clock_in_at: String, clock_out_at: Option<String>, clock_in_source: String, clock_out_source: Option<String>, status: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseActiveOperatorResult { clock_out_created: bool, shift: Option<LocalShift> }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflineTimeEvent { schema_version: i64, event_id: String, shift_id: String, employee_id: String, device_id: String, operator_token: String, action: String, occurred_at: String }

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn parse_i64(value: &str, field: &str) -> Result<i64, String> {
    value.parse::<i64>().map_err(|_| format!("Invalid {field}"))
}

// Name and partition kept exactly as-is (still CASH/TRANSFER/OTHER on this side) — see D-044.
// Under the pre-D-044 model this partition got a cash discount; now it gets NO adjustment at
// all (list price unchanged), while its negation (DEBIT/CREDIT) gets a card surcharge instead.
// Callers use `!payment_method_receives_discount(method)` to gate the surcharge.
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
    let timekeeping_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 6)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !timekeeping_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(POS_OPERATORS_TIMEKEEPING_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (6, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let pack_mode_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 7)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !pack_mode_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(WEIGHT_DISCOUNT_PACK_MODE_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (7, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let category_assignments_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 8)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !category_assignments_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(PRODUCT_CATEGORY_ASSIGNMENTS_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (8, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let unit_sale_support_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 9)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !unit_sale_support_applied {
        // This migration drops and rebuilds local_sales/local_sale_items (see the file's own
        // header comment for why: relaxing CHECK constraints that SQLite can't ALTER directly,
        // without losing existing rows). `pragma foreign_keys` is a documented no-op while a
        // transaction is open, so it must be toggled here, OUTSIDE transaction.execute_batch —
        // toggling it from inside the migration's own SQL (inside the transaction below) would
        // silently do nothing, and the DROP TABLE would then fail against any existing row that
        // references the table being dropped.
        connection.execute_batch("pragma foreign_keys = off;").map_err(|error| error.to_string())?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(UNIT_SALE_SUPPORT_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (9, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        connection.execute_batch("pragma foreign_keys = on;").map_err(|error| error.to_string())?;
    }
    let card_surcharge_pricing_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 10)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !card_surcharge_pricing_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(CARD_SURCHARGE_PRICING_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (10, ?1)", [now()]).map_err(|error| error.to_string())?;
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

    // Every category a product is assigned to (principal included) — fetched once up front and
    // merged in below, instead of a per-row subquery.
    let mut category_ids_by_product: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut assignments = connection
        .prepare("select product_id, category_id from catalog_product_categories order by product_id")
        .map_err(|error| error.to_string())?;
    let assignment_rows = assignments
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?;
    for pair in assignment_rows {
        let (product_id, category_id) = pair.map_err(|error| error.to_string())?;
        category_ids_by_product.entry(product_id).or_default().push(category_id);
    }

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
            let product_id: String = row.get(6)?;
            let principal_category_id: String = row.get(2)?;
            let category_ids = category_ids_by_product
                .get(&product_id)
                .cloned()
                .unwrap_or_else(|| vec![principal_category_id.clone()]);
            Ok(LocalCatalogRow {
                organization_id: row.get(0)?,
                branch_id: row.get(1)?,
                branch_name: branch_name.clone(),
                category_id: principal_category_id,
                category_name: row.get(3)?,
                category_color_hex: row.get(4)?,
                category_sort_order: row.get(5)?,
                category_ids,
                product_id,
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
fn get_local_categories(state: State<'_, DatabaseState>) -> Result<Vec<LocalCategoryRow>, String> {
    // The POS tab directory: every category the last pull marked active (see apply_catalog_pull —
    // a full "mark all inactive, then upsert this pull's directory as active" replace each sync),
    // independent of any product's principal category.
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let mut statement = connection
        .prepare("select id, name, color_hex, sort_order from catalog_categories where active = 1 order by sort_order, name")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(LocalCategoryRow { id: row.get(0)?, name: row.get(1)?, color_hex: row.get(2)?, sort_order: row.get(3)? })
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

    // Category DIRECTORY (POS tab source): always a full current snapshot, independent of the
    // incremental product cursor (a small table, cheap to fully resend every pull). Deliberately
    // NOT derived from catalog_products' own category_id anymore: a category used only as a
    // secondary ("también aparece en") assignment must still get a tab, and this is the only
    // place that guarantees that.
    //
    // Mark-all-inactive-then-upsert, NOT delete-then-reinsert: catalog_products.category_id has a
    // hard FK to catalog_categories(id), and a product that this pull marks inactive via
    // removed_product_ids above is NOT deleted (same "deactivate, never delete" convention as the
    // rest of this file) — its row can still reference a category that just dropped out of the
    // fresh directory. Deleting that category row would violate the FK. Flipping `active` instead
    // never removes a row, so it can never violate that reference; get_local_categories below
    // filters on active = 1, which is exactly this pull's fresh directory.
    transaction.execute("update catalog_categories set active = 0, updated_at = ?1", params![timestamp]).map_err(|error| error.to_string())?;
    for category in &pull.categories {
        transaction
            .execute(
                "insert into catalog_categories(id, organization_id, name, color_hex, sort_order, active, updated_at)
                 values (?1, ?2, ?3, ?4, ?5, 1, ?6)
                 on conflict(id) do update set name = excluded.name, color_hex = excluded.color_hex,
                   sort_order = excluded.sort_order, active = 1, updated_at = excluded.updated_at",
                params![category.id, pull.organization_id, category.name, category.color_hex, category.sort_order, timestamp],
            )
            .map_err(|error| error.to_string())?;
    }

    for row in &pull.catalog {
        let price = parse_i64(&row.price_per_kg_cents, "pricePerKgCents")?;
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

        // Full membership set for this product, delivered on every pull that touches it (not a
        // delta) — replace what's stored for just this product, same idempotent pattern as the
        // rest of this function.
        let category_ids = if row.category_ids.is_empty() { vec![row.category_id.clone()] } else { row.category_ids.clone() };
        transaction
            .execute("delete from catalog_product_categories where product_id = ?1", params![row.product_id])
            .map_err(|error| error.to_string())?;
        for category_id in &category_ids {
            transaction
                .execute(
                    "insert into catalog_product_categories(product_id, category_id) values (?1, ?2) on conflict(product_id, category_id) do nothing",
                    params![row.product_id, category_id],
                )
                .map_err(|error| error.to_string())?;
        }

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
    for discount in config.discounts {
        let discount_value = discount.discount_value.as_deref().map(|value| parse_i64(value, "discountValue")).transpose()?;
        let pack_price_cents = discount.pack_price_cents.as_deref().map(|value| parse_i64(value, "packPriceCents")).transpose()?;
        transaction.execute(
            "insert into local_weight_discounts(id,product_id,branch_id,promotion_mode,minimum_grams,discount_type,discount_value,pack_quantity_grams,pack_quantity_units,pack_price_cents) values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![discount.id, discount.product_id, discount.branch_id, discount.promotion_mode, discount.minimum_grams,
                    discount.discount_type, discount_value, discount.pack_quantity_grams, discount.pack_quantity_units, pack_price_cents]
        ).map_err(|error| error.to_string())?;
    }
    for notice in config.announcements { transaction.execute("insert into local_announcements(id,title,message,type,priority,branch_id) values(?1,?2,?3,?4,?5,?6)", params![notice.id,notice.title,notice.message,notice.r#type,notice.priority,notice.branch_id]).map_err(|error| error.to_string())?; }
    if !(0..10_000).contains(&config.cash_discount_bps) { return Err("Invalid cash discount configuration".to_string()); }
    set_metadata(&transaction, "cash_discount_bps", &config.cash_discount_bps.to_string(), &now())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_local_commercial_config(state: State<'_, DatabaseState>) -> Result<LocalCommercialConfig, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let mut discounts = connection.prepare("select id,product_id,branch_id,promotion_mode,minimum_grams,discount_type,discount_value,pack_quantity_grams,pack_quantity_units,pack_price_cents from local_weight_discounts order by minimum_grams desc, branch_id is not null desc").map_err(|e| e.to_string())?;
    let discounts = discounts.query_map([], |r| Ok(LocalDiscount {
        id: r.get(0)?, product_id: r.get(1)?, branch_id: r.get(2)?, promotion_mode: r.get(3)?,
        minimum_grams: r.get(4)?, discount_type: r.get(5)?,
        discount_value: r.get::<_, Option<i64>>(6)?.map(|value| value.to_string()),
        pack_quantity_grams: r.get(7)?, pack_quantity_units: r.get(8)?,
        pack_price_cents: r.get::<_, Option<i64>>(9)?.map(|value| value.to_string()),
    })).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
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

fn verifier(pin: &str, salt: &str) -> Result<String, String> {
    let mut output = [0_u8; 32];
    Argon2::default().hash_password_into(pin.as_bytes(), salt.as_bytes(), &mut output).map_err(|error| error.to_string())?;
    Ok(output.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[tauri::command]
fn apply_operator_roster(state: State<'_, DatabaseState>, operators: Vec<OperatorRosterRow>, max_shift_hours: i64) -> Result<(), String> {
    if !(1..=24).contains(&max_shift_hours) { return Err("Invalid maximum shift duration".into()); }
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction.execute("update local_pos_operators set active=0,updated_at=?1", [now()]).map_err(|error| error.to_string())?;
    for operator in operators {
        transaction.execute(
            "insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,updated_at) values(?1,?2,?3,?4,1,?5,?6)
             on conflict(profile_id) do update set display_name=excluded.display_name,role_name=excluded.role_name,has_pin=excluded.has_pin,active=1,
             has_shift_issue=excluded.has_shift_issue,pin_salt=case when excluded.has_pin=1 then local_pos_operators.pin_salt else null end,
             pin_verifier=case when excluded.has_pin=1 then local_pos_operators.pin_verifier else null end,
             operator_token=case when excluded.has_pin=1 then local_pos_operators.operator_token else null end,
             grant_valid_until=case when excluded.has_pin=1 then local_pos_operators.grant_valid_until else null end,updated_at=excluded.updated_at",
            params![operator.profile_id,operator.display_name,operator.role_name,if operator.has_pin {1} else {0},if operator.has_shift_issue {1} else {0},now()]
        ).map_err(|error| error.to_string())?;
    }
    transaction.execute("delete from local_active_operator where profile_id in(select profile_id from local_pos_operators where active=0)", []).map_err(|error| error.to_string())?;
    set_metadata(&transaction,"max_shift_hours",&max_shift_hours.to_string(),&now())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_local_operators(state: State<'_, DatabaseState>) -> Result<Vec<LocalOperator>, String> {
    let connection=state.0.lock().map_err(|_|"SQLite lock poisoned".to_string())?;
    let mut statement=connection.prepare("select profile_id,display_name,role_name,has_pin,has_shift_issue,operator_token,grant_valid_until from local_pos_operators where active=1 order by display_name").map_err(|e|e.to_string())?;
    let rows=statement.query_map([],|r|Ok(LocalOperator{profile_id:r.get(0)?,display_name:r.get(1)?,role_name:r.get(2)?,has_pin:r.get::<_,i64>(3)?==1,has_shift_issue:r.get::<_,i64>(4)?==1,operator_token:r.get(5)?,valid_until:r.get(6)?})).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
fn cache_verified_operator(state: State<'_, DatabaseState>, session: State<'_, OperatorSessionState>, verification: VerifiedOperatorInput, pin: String) -> Result<LocalOperator, String> {
    if !(4..=6).contains(&pin.len()) || !pin.chars().all(|character| character.is_ascii_digit()) { return Err("El PIN debe tener entre 4 y 6 dígitos".into()); }
    let salt=Uuid::new_v4().to_string(); let hash=verifier(&pin,&salt)?; let timestamp=now();
    let mut connection=state.0.lock().map_err(|_|"SQLite lock poisoned".to_string())?;
    let transaction=connection.transaction().map_err(|e|e.to_string())?;
    transaction.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,pin_salt,pin_verifier,operator_token,grant_valid_until,verified_at,failed_attempts,locked_until,updated_at) values(?1,?2,?3,1,1,0,?4,?5,?6,?7,?8,0,null,?8) on conflict(profile_id) do update set display_name=excluded.display_name,role_name=excluded.role_name,has_pin=1,active=1,pin_salt=excluded.pin_salt,pin_verifier=excluded.pin_verifier,operator_token=excluded.operator_token,grant_valid_until=excluded.grant_valid_until,verified_at=excluded.verified_at,failed_attempts=0,locked_until=null,updated_at=excluded.updated_at",params![verification.profile_id,verification.display_name,verification.role_name,salt,hash,verification.operator_token,verification.valid_until,timestamp]).map_err(|e|e.to_string())?;
    transaction.execute("insert into local_active_operator(singleton,profile_id,selected_at) values(1,?1,?2) on conflict(singleton) do update set profile_id=excluded.profile_id,selected_at=excluded.selected_at",params![verification.profile_id,timestamp]).map_err(|e|e.to_string())?;
    transaction.commit().map_err(|e|e.to_string())?;
    session.0.store(true, Ordering::SeqCst);
    Ok(LocalOperator{profile_id:verification.profile_id,display_name:verification.display_name,role_name:verification.role_name,has_pin:true,has_shift_issue:false,operator_token:Some(verification.operator_token),valid_until:Some(verification.valid_until)})
}

#[tauri::command]
fn verify_local_operator(state: State<'_, DatabaseState>, session: State<'_, OperatorSessionState>, profile_id: String, pin: String) -> Result<LocalOperator, String> {
    let connection=state.0.lock().map_err(|_|"SQLite lock poisoned".to_string())?;
    let timestamp=now();
    let row=connection.query_row("select display_name,role_name,has_pin,has_shift_issue,pin_salt,pin_verifier,operator_token,grant_valid_until,failed_attempts,locked_until from local_pos_operators where profile_id=?1 and active=1 and julianday(grant_valid_until)>julianday(?2)",params![profile_id,timestamp],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,i64>(8)?,r.get::<_,Option<String>>(9)?))).optional().map_err(|e|e.to_string())?.ok_or_else(||"Este empleado debe validar su PIN online nuevamente".to_string())?;
    if row.9.as_ref().is_some_and(|until| connection.query_row("select julianday(?1)>julianday(?2)",params![until,timestamp],|r|r.get::<_,bool>(0)).unwrap_or(false)) { return Err("Demasiados intentos. Esperá unos minutos.".into()); }
    let salt=row.4.ok_or_else(||"No hay un verificador offline para este empleado".to_string())?; let expected=row.5.ok_or_else(||"No hay un verificador offline para este empleado".to_string())?;
    if verifier(&pin,&salt)? != expected { let failures=(row.8+1).min(20); connection.execute("update local_pos_operators set failed_attempts=?2,locked_until=case when ?2>=5 then datetime(?3,'+5 minutes') else null end,updated_at=?3 where profile_id=?1",params![profile_id,failures,timestamp]).map_err(|e|e.to_string())?; return Err(if failures>=5 {"Demasiados intentos. Esperá unos minutos."} else {"PIN incorrecto"}.into()); }
    connection.execute("update local_pos_operators set failed_attempts=0,locked_until=null,updated_at=?2 where profile_id=?1",params![profile_id,timestamp]).map_err(|e|e.to_string())?;
    connection.execute("insert into local_active_operator(singleton,profile_id,selected_at) values(1,?1,?2) on conflict(singleton) do update set profile_id=excluded.profile_id,selected_at=excluded.selected_at",params![profile_id,now()]).map_err(|e|e.to_string())?;
    session.0.store(true, Ordering::SeqCst);
    Ok(LocalOperator{profile_id,display_name:row.0,role_name:row.1,has_pin:row.2==1,has_shift_issue:row.3==1,operator_token:row.6,valid_until:row.7})
}

#[tauri::command]
fn get_active_operator(state: State<'_, DatabaseState>) -> Result<Option<LocalOperator>, String> {
    let connection=state.0.lock().map_err(|_|"SQLite lock poisoned".to_string())?;
    connection.query_row("select o.profile_id,o.display_name,o.role_name,o.has_pin,o.has_shift_issue,o.operator_token,o.grant_valid_until from local_active_operator a join local_pos_operators o on o.profile_id=a.profile_id where a.singleton=1 and o.active=1",[],|r|Ok(LocalOperator{profile_id:r.get(0)?,display_name:r.get(1)?,role_name:r.get(2)?,has_pin:r.get::<_,i64>(3)?==1,has_shift_issue:r.get::<_,i64>(4)?==1,operator_token:r.get(5)?,valid_until:r.get(6)?})).optional().map_err(|e|e.to_string())
}

#[tauri::command]
fn clear_active_operator(state: State<'_, DatabaseState>, session: State<'_, OperatorSessionState>) -> Result<(), String> { let connection=state.0.lock().map_err(|_|"SQLite lock poisoned".to_string())?; connection.execute("delete from local_active_operator",[]).map_err(|e|e.to_string())?; session.0.store(false, Ordering::SeqCst); Ok(()) }

#[tauri::command]
fn get_local_current_shift(state: State<'_, DatabaseState>, employee_id: String) -> Result<Option<LocalShift>, String> {
    let connection=state.0.lock().map_err(|_|"SQLite lock poisoned".to_string())?;
    let max_hours=metadata(&connection,"max_shift_hours")?.and_then(|value|value.parse::<i64>().ok()).unwrap_or(12);
    connection.execute("update local_employee_shifts set status='REQUIRES_REVIEW',updated_at=?2 where employee_id=?1 and clock_out_at is null and status='OPEN' and julianday(clock_in_at)+(cast(?3 as real)/24.0)<julianday(?2)",params![&employee_id,now(),max_hours]).map_err(|e|e.to_string())?;
    connection.query_row("select id,employee_id,clock_in_at,clock_out_at,clock_in_source,clock_out_source,status from local_employee_shifts where employee_id=?1 and clock_out_at is null order by clock_in_at desc limit 1",[employee_id],|r|Ok(LocalShift{shift_id:r.get(0)?,employee_id:r.get(1)?,clock_in_at:r.get(2)?,clock_out_at:r.get(3)?,clock_in_source:r.get(4)?,clock_out_source:r.get(5)?,status:r.get(6)?})).optional().map_err(|e|e.to_string())
}

#[tauri::command]
fn clear_reconciled_local_shift(state: State<'_, DatabaseState>, employee_id: String) -> Result<(), String> {
    let connection=state.0.lock().map_err(|_|"SQLite lock poisoned".to_string())?;
    connection.execute("delete from local_employee_shifts where employee_id=?1 and clock_out_at is null and not exists(select 1 from sync_outbox o where o.aggregate_type='SHIFT' and o.aggregate_id=local_employee_shifts.id and o.status<>'SYNCED')",[employee_id]).map_err(|e|e.to_string())?;
    Ok(())
}

#[tauri::command]
fn apply_server_shift(state: State<'_, DatabaseState>, shift: LocalShift) -> Result<(), String> {
    let connection=state.0.lock().map_err(|_|"SQLite lock poisoned".to_string())?;
    let runtime:(String,String)=connection.query_row("select branch_id,device_id from local_device where singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    connection.execute("insert into local_employee_shifts(id,employee_id,branch_id,device_id,clock_in_at,clock_out_at,clock_in_source,clock_out_source,status,updated_at) values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) on conflict(id) do update set clock_out_at=excluded.clock_out_at,clock_out_source=excluded.clock_out_source,status=excluded.status,updated_at=excluded.updated_at",params![shift.shift_id,shift.employee_id,runtime.0,runtime.1,shift.clock_in_at,shift.clock_out_at,shift.clock_in_source,shift.clock_out_source,shift.status,now()]).map_err(|e|e.to_string())?; Ok(())
}

fn record_offline_time_event_in_connection(connection: &mut Connection, action: &str) -> Result<LocalShift, String> {
    if action!="CLOCK_IN" && action!="CLOCK_OUT" { return Err("Invalid time event action".into()); }
    let tx=connection.transaction().map_err(|e|e.to_string())?; let timestamp=now();
    let (employee,token,branch,device):(String,String,String,String)=tx.query_row("select o.profile_id,o.operator_token,d.branch_id,d.device_id from local_active_operator a join local_pos_operators o on o.profile_id=a.profile_id join local_device d on d.singleton=1 where o.active=1 and julianday(o.grant_valid_until)>julianday(?1) and d.device_status='ACTIVE' and julianday(d.authorization_expires_at)>julianday(?1)",[&timestamp],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|"La autorización offline del empleado o dispositivo venció".to_string())?;
    let existing:Option<LocalShift>=tx.query_row("select id,employee_id,clock_in_at,clock_out_at,clock_in_source,clock_out_source,status from local_employee_shifts where employee_id=?1 and clock_out_at is null",[&employee],|r|Ok(LocalShift{shift_id:r.get(0)?,employee_id:r.get(1)?,clock_in_at:r.get(2)?,clock_out_at:r.get(3)?,clock_in_source:r.get(4)?,clock_out_source:r.get(5)?,status:r.get(6)?})).optional().map_err(|e|e.to_string())?;
    let event_id=Uuid::new_v4().to_string();
    let shift=if action=="CLOCK_IN" {
        if let Some(open)=existing { if open.status=="REQUIRES_REVIEW" { return Err("Tenés un turno anterior pendiente de revisión".into()); } open }
        else { let created=LocalShift{shift_id:Uuid::new_v4().to_string(),employee_id:employee.clone(),clock_in_at:timestamp.clone(),clock_out_at:None,clock_in_source:"OFFLINE".into(),clock_out_source:None,status:"OPEN".into()}; tx.execute("insert into local_employee_shifts(id,employee_id,branch_id,device_id,clock_in_at,clock_in_source,status,updated_at) values(?1,?2,?3,?4,?5,'OFFLINE','OPEN',?5)",params![created.shift_id,employee,branch,device,timestamp]).map_err(|e|e.to_string())?; created }
    } else { let mut open=existing.ok_or_else(||"No hay un turno activo para marcar salida".to_string())?; let max_hours=metadata(&tx,"max_shift_hours")?.and_then(|v|v.parse::<i64>().ok()).unwrap_or(12); let started=chrono::DateTime::parse_from_rfc3339(&open.clock_in_at).map_err(|e|e.to_string())?; let current=chrono::DateTime::parse_from_rfc3339(&timestamp).map_err(|e|e.to_string())?; if current.signed_duration_since(started).num_hours()>=max_hours { tx.execute("update local_employee_shifts set status='REQUIRES_REVIEW',updated_at=?2 where id=?1",params![open.shift_id,timestamp]).map_err(|e|e.to_string())?; open.status="REQUIRES_REVIEW".into(); tx.commit().map_err(|e|e.to_string())?; return Ok(open); } tx.execute("update local_employee_shifts set clock_out_at=?2,clock_out_source='OFFLINE',status='CLOSED',updated_at=?2 where id=?1",params![open.shift_id,timestamp]).map_err(|e|e.to_string())?; open.clock_out_at=Some(timestamp.clone()); open.clock_out_source=Some("OFFLINE".into()); open.status="CLOSED".into(); open };
    let payload=OfflineTimeEvent{schema_version:1,event_id:event_id.clone(),shift_id:shift.shift_id.clone(),employee_id:employee,device_id:device,operator_token:token,action:action.to_string(),occurred_at:timestamp.clone()};
    tx.execute("insert into sync_outbox(id,aggregate_type,aggregate_id,operation,payload,status,attempts,created_at,next_attempt_at) values(?1,'SHIFT',?2,'EVENT',?3,'PENDING',0,?4,?4)",params![event_id,shift.shift_id,serde_json::to_string(&payload).map_err(|e|e.to_string())?,timestamp]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?; Ok(shift)
}

fn close_active_operator_shift_in_connection(connection: &mut Connection) -> Result<CloseActiveOperatorResult, String> {
    let active_employee = connection.query_row("select profile_id from local_active_operator where singleton=1",[],|row|row.get::<_,String>(0)).optional().map_err(|error|error.to_string())?;
    let Some(employee_id) = active_employee else { return Ok(CloseActiveOperatorResult { clock_out_created: false, shift: None }); };
    let open_shift = connection.query_row("select id,employee_id,clock_in_at,clock_out_at,clock_in_source,clock_out_source,status from local_employee_shifts where employee_id=?1 and clock_out_at is null order by clock_in_at desc limit 1",[employee_id],|row|Ok(LocalShift{shift_id:row.get(0)?,employee_id:row.get(1)?,clock_in_at:row.get(2)?,clock_out_at:row.get(3)?,clock_in_source:row.get(4)?,clock_out_source:row.get(5)?,status:row.get(6)?})).optional().map_err(|error|error.to_string())?;
    let shift = if matches!(open_shift.as_ref().map(|current|current.status.as_str()), Some("OPEN")) {
        Some(record_offline_time_event_in_connection(connection, "CLOCK_OUT")?)
    } else {
        open_shift
    };
    connection.execute("delete from local_active_operator",[]).map_err(|error|error.to_string())?;
    let clock_out_created = matches!(shift.as_ref().map(|current|current.status.as_str()), Some("CLOSED"));
    Ok(CloseActiveOperatorResult { clock_out_created, shift })
}

fn close_authenticated_operator_session(connection: &mut Connection, session_active: &AtomicBool) -> Result<CloseActiveOperatorResult, String> {
    if !session_active.load(Ordering::SeqCst) {
        connection.execute("delete from local_active_operator",[]).map_err(|error|error.to_string())?;
        return Ok(CloseActiveOperatorResult { clock_out_created: false, shift: None });
    }
    let result = close_active_operator_shift_in_connection(connection)?;
    session_active.store(false, Ordering::SeqCst);
    Ok(result)
}

#[tauri::command]
fn record_offline_time_event(state: State<'_, DatabaseState>, action: String) -> Result<LocalShift, String> {
    let mut connection=state.0.lock().map_err(|_|"SQLite lock poisoned".to_string())?;
    record_offline_time_event_in_connection(&mut connection, &action)
}

#[tauri::command]
fn close_active_operator_shift(state: State<'_, DatabaseState>, session: State<'_, OperatorSessionState>) -> Result<CloseActiveOperatorResult, String> {
    let mut connection=state.0.lock().map_err(|_|"SQLite lock poisoned".to_string())?;
    close_authenticated_operator_session(&mut connection, &session.0)
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
               select 1 from local_device d
               join local_pos_operators o on o.profile_id = ?4 and o.active = 1
               where d.singleton = 1 and d.device_id = ?1 and d.organization_id = ?2 and d.branch_id = ?3
                 and d.device_status = 'ACTIVE' and o.operator_token = ?6
                 and julianday(d.authorization_expires_at) > julianday(?5)
                 and julianday(o.grant_valid_until) > julianday(?5)
             )",
            params![sale.device_id, sale.organization_id, sale.branch_id, sale.profile_id, now(), sale.operator_token],
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
        let card_surcharge_cents = item.card_surcharge_cents.as_deref().map(|value| parse_i64(value, "cardSurchargeCents")).transpose()?.unwrap_or(0);
        let promotion_discount_cents = item.promotion_discount_cents.as_deref().map(|value| parse_i64(value, "promotionDiscountCents")).transpose()?.unwrap_or(discount_cents - cash_discount_cents);
        // D-044 (corrected 2026-09-24): only DEBIT/CREDIT may carry a nonzero bps now (the card
        // surcharge); CASH/TRANSFER/OTHER must not (they get no adjustment off the list price at
        // all), and no payment method gets an actual discount anymore, so cash_discount_cents is
        // always 0. The surcharge itself is computed per-branch below — list -> promotion/pack ->
        // surcharge, applied to the WHOLE commercial result with no exception for a pack.
        if !(0..10_000).contains(&cash_discount_bps)
            || (payment_method_receives_discount(&sale.payment.method) && cash_discount_bps != 0)
            || cash_discount_cents != 0
        {
            return Err("Invalid local sale calculation".to_string());
        }
        let product_unit_type: &str;

        match (item.weight_grams, item.quantity_units) {
            (Some(weight_grams), None) => {
                product_unit_type = "WEIGHT";
                if weight_grams <= 0 { return Err("Invalid local sale calculation".to_string()); }
                let list_subtotal = original_price.checked_mul(weight_grams).and_then(|value| value.checked_add(500)).map(|value| value / 1000).ok_or_else(|| "Sale amount overflow".to_string())?;
                let cash_subtotal: i64;
                if item.promotion_mode.as_deref() == Some("PACK_FIXED_TOTAL") {
                    // Pack line: subtotal is the pack's own fixed total, not a per-kg rate applied
                    // to the weighed grams, so the generic "subtotal == price*weight/1000" identity
                    // does not hold here (final_price is only a derived per-kg equivalent for
                    // display/reporting). Re-validated against local_weight_discounts, same sanity
                    // guard as the server (pack price must not exceed LIST price for the actual
                    // weighed amount — before any card surcharge).
                    if item.discount_type.is_some() || item.discount_value.is_some() {
                        return Err("Offline pack promotion metadata is inconsistent".to_string());
                    }
                    let rule_id = item.discount_rule_id.as_deref().ok_or_else(|| "Missing pack promotion id".to_string())?;
                    let pack_price: i64 = transaction
                        .query_row(
                            "select pack_price_cents from local_weight_discounts where id = ?1 and product_id = ?2 and promotion_mode = 'PACK_FIXED_TOTAL'",
                            params![rule_id, item.product_id],
                            |row| row.get(0),
                        )
                        .map_err(|_| "Offline pack promotion is unknown".to_string())?;
                    if pack_price > list_subtotal {
                        return Err("Offline pack promotion is inconsistent".to_string());
                    }
                    cash_subtotal = pack_price;
                    let expected_promotion_discount = (list_subtotal - cash_subtotal).max(0);
                    if promotion_discount_cents != expected_promotion_discount || discount_cents != expected_promotion_discount {
                        return Err("Invalid local sale calculation".to_string());
                    }
                    // Surcharge (D-044, corrected): ONE rounding on the WHOLE pack total below —
                    // no pack exception. final_price_per_kg_cents is only a derived display value.
                    let expected_subtotal = if cash_discount_bps > 0 {
                        cash_subtotal.checked_mul(10_000 + cash_discount_bps).and_then(|value| value.checked_add(5_000)).map(|value| value / 10_000).ok_or_else(|| "Sale amount overflow".to_string())?
                    } else { cash_subtotal };
                    if subtotal != expected_subtotal { return Err("Offline pack promotion is inconsistent".to_string()); }
                    let expected_price = subtotal.checked_mul(1000).and_then(|value| value.checked_add(weight_grams / 2)).map(|value| value / weight_grams).ok_or_else(|| "Sale amount overflow".to_string())?;
                    if price != expected_price { return Err("Offline pack promotion is inconsistent".to_string()); }
                } else {
                    // Promotion evaluated against plain LIST price (never a card-adjusted one).
                    let promo_price: i64 = match item.discount_type.as_deref() {
                        Some("PERCENTAGE") => {
                            let value = item.discount_value.as_deref().ok_or_else(|| "Missing percentage promotion value".to_string()).and_then(|value| parse_i64(value, "discountValue"))?;
                            if !(1..=10_000).contains(&value) { return Err("Invalid percentage promotion".to_string()); }
                            original_price.checked_mul(10_000 - value).and_then(|amount| amount.checked_add(5_000)).map(|amount| amount / 10_000).ok_or_else(|| "Sale amount overflow".to_string())?
                        }
                        Some("FIXED_PRICE_PER_KG") => {
                            let value = item.discount_value.as_deref().ok_or_else(|| "Missing fixed-price promotion value".to_string()).and_then(|value| parse_i64(value, "discountValue"))?;
                            if value <= 0 { return Err("Fixed-price promotion snapshot is inconsistent".to_string()); }
                            value
                        }
                        Some(_) => return Err("Unsupported promotion type".to_string()),
                        None => original_price,
                    };
                    if promo_price > original_price { return Err("Offline promotion cannot increase a price".to_string()); }
                    cash_subtotal = promo_price.checked_mul(weight_grams).and_then(|value| value.checked_add(500)).map(|value| value / 1000).ok_or_else(|| "Sale amount overflow".to_string())?;
                    if promotion_discount_cents != list_subtotal - cash_subtotal || discount_cents != promotion_discount_cents {
                        return Err("Invalid local sale calculation".to_string());
                    }
                    // Surcharge (D-044, corrected): round once at the per-kg level (mirrors
                    // calculateSalePricing exactly), THEN derive the subtotal from grams.
                    let expected_price = if cash_discount_bps > 0 {
                        promo_price.checked_mul(10_000 + cash_discount_bps).and_then(|value| value.checked_add(5_000)).map(|value| value / 10_000).ok_or_else(|| "Sale amount overflow".to_string())?
                    } else { promo_price };
                    if price != expected_price { return Err("Percentage promotion snapshot is inconsistent".to_string()); }
                    let expected_subtotal = price.checked_mul(weight_grams).and_then(|value| value.checked_add(500)).map(|value| value / 1000).ok_or_else(|| "Sale amount overflow".to_string())?;
                    if subtotal != expected_subtotal { return Err("Invalid local sale calculation".to_string()); }
                }
                if card_surcharge_cents != subtotal - cash_subtotal { return Err("Invalid local sale calculation".to_string()); }
                computed_weight = computed_weight.checked_add(weight_grams).ok_or_else(|| "Sale weight overflow".to_string())?;
            }
            (None, Some(quantity_units)) => {
                // UNIT line: no per-kg division, quantities multiply directly. THRESHOLD
                // promotions never apply to UNIT (WEIGHT-only by design, see save_weight_discount)
                // — the only supported promotion here is PACK_FIXED_TOTAL, applied in exact
                // multiples of the pack's quantity, with any remainder at plain list price (never a
                // discounted rate — mirrors calculateUnitPackSalePricing exactly). UNIT lines
                // contribute nothing to the sale's total WEIGHT (that total stays a pure weight
                // tally).
                product_unit_type = "UNIT";
                if quantity_units <= 0 { return Err("Invalid local sale calculation".to_string()); }
                if item.discount_type.is_some() || item.discount_value.is_some() {
                    return Err("Offline unit sale discount metadata is inconsistent".to_string());
                }
                let list_subtotal = original_price.checked_mul(quantity_units).ok_or_else(|| "Sale amount overflow".to_string())?;
                let cash_subtotal: i64;
                if item.promotion_mode.as_deref() == Some("PACK_FIXED_TOTAL") {
                    let rule_id = item.discount_rule_id.as_deref().ok_or_else(|| "Missing pack promotion id".to_string())?;
                    let (pack_quantity, pack_price): (i64, i64) = transaction
                        .query_row(
                            "select pack_quantity_units, pack_price_cents from local_weight_discounts where id = ?1 and product_id = ?2 and promotion_mode = 'PACK_FIXED_TOTAL'",
                            params![rule_id, item.product_id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .map_err(|_| "Offline pack promotion is unknown".to_string())?;
                    if pack_quantity <= 0 { return Err("Offline pack promotion is unknown".to_string()); }
                    if pack_price > original_price.checked_mul(pack_quantity).ok_or_else(|| "Sale amount overflow".to_string())? {
                        return Err("Offline pack promotion is inconsistent".to_string());
                    }
                    let whole_packs = quantity_units / pack_quantity;
                    let remainder = quantity_units % pack_quantity;
                    // CASH-equivalent total: whole packs at their fixed price, remainder at plain
                    // list price (never card-adjusted at this stage).
                    cash_subtotal = pack_price.checked_mul(whole_packs)
                        .and_then(|value| original_price.checked_mul(remainder).and_then(|rest| value.checked_add(rest)))
                        .ok_or_else(|| "Sale amount overflow".to_string())?;
                    let whole_pack_units = whole_packs.checked_mul(pack_quantity).ok_or_else(|| "Sale amount overflow".to_string())?;
                    let whole_pack_list_value = original_price.checked_mul(whole_pack_units).ok_or_else(|| "Sale amount overflow".to_string())?;
                    let whole_pack_charged = pack_price.checked_mul(whole_packs).ok_or_else(|| "Sale amount overflow".to_string())?;
                    let expected_promotion_discount = (whole_pack_list_value - whole_pack_charged).max(0);
                    if promotion_discount_cents != expected_promotion_discount || discount_cents != expected_promotion_discount {
                        return Err("Invalid local sale calculation".to_string());
                    }
                    // Surcharge (D-044, corrected): ONE rounding applied to the WHOLE total below —
                    // never only to the remainder. final_price_per_kg_cents reuses the total, same
                    // as calculateUnitPackSalePricing (no single per-unit rate for a mixed line).
                    let expected_subtotal = if cash_discount_bps > 0 {
                        cash_subtotal.checked_mul(10_000 + cash_discount_bps).and_then(|value| value.checked_add(5_000)).map(|value| value / 10_000).ok_or_else(|| "Sale amount overflow".to_string())?
                    } else { cash_subtotal };
                    if subtotal != expected_subtotal || price != subtotal { return Err("Offline pack promotion is inconsistent".to_string()); }
                } else {
                    cash_subtotal = list_subtotal;
                    if promotion_discount_cents != 0 || discount_cents != 0 {
                        return Err("Invalid local sale calculation".to_string());
                    }
                    // Non-pack: round once at the per-unit level, then multiply exactly (mirrors
                    // calculateSalePricing — quantityDivisor 1 makes its own subtotal rounding a
                    // no-op), never a single rounding directly on the subtotal.
                    let expected_price = if cash_discount_bps > 0 {
                        original_price.checked_mul(10_000 + cash_discount_bps).and_then(|value| value.checked_add(5_000)).map(|value| value / 10_000).ok_or_else(|| "Sale amount overflow".to_string())?
                    } else { original_price };
                    if price != expected_price { return Err("Undiscounted snapshot is inconsistent".to_string()); }
                    let expected_subtotal = price.checked_mul(quantity_units).ok_or_else(|| "Sale amount overflow".to_string())?;
                    if subtotal != expected_subtotal { return Err("Undiscounted snapshot is inconsistent".to_string()); }
                }
                if card_surcharge_cents != subtotal - cash_subtotal { return Err("Invalid local sale calculation".to_string()); }
            }
            _ => return Err("A sale item must have exactly one of weightGrams or quantityUnits".to_string()),
        }

        let catalog_matches: bool = transaction
            .query_row(
                "select exists(
                   select 1 from catalog_products p join catalog_prices cp on cp.product_id = p.id
                   where p.id = ?1 and p.active = 1 and p.unit_type = ?2 and cp.branch_id = ?3 and cp.price_per_kg_cents = ?4
                 )",
                params![item.product_id, product_unit_type, sale.branch_id, original_price],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !catalog_matches {
            return Err(format!("Product {} is unavailable or its local price changed", item.product_id));
        }
        computed_total = computed_total.checked_add(subtotal).ok_or_else(|| "Sale total overflow".to_string())?;
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
        let card_surcharge_cents = item.card_surcharge_cents.as_deref().map(|value| parse_i64(value, "cardSurchargeCents")).transpose()?.unwrap_or(0);
        let promotion_discount_cents = item.promotion_discount_cents.as_deref().map(|value| parse_i64(value, "promotionDiscountCents")).transpose()?.unwrap_or(discount_cents - cash_discount_cents);
        let cost_snapshot = item.cost_cents_snapshot.as_deref().map(|value| parse_i64(value, "costCentsSnapshot")).transpose()?;
        let profit_snapshot = item.profit_markup_bps_snapshot.as_deref().map(|value| parse_i64(value, "profitMarkupBpsSnapshot")).transpose()?;
        transaction
            .execute(
                "insert into local_sale_items(id, sale_id, product_id, product_name_snapshot, weight_grams, quantity_units,
                  price_per_kg_cents, original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_cents_snapshot, profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
                params![item.id, sale.sale_id, item.product_id, item.product_name_snapshot, item.weight_grams, item.quantity_units,
                        parse_i64(&item.price_per_kg_cents, "pricePerKgCents")?, original_price, item.discount_rule_id, item.discount_type, discount_value, discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_snapshot, profit_snapshot, parse_i64(&item.subtotal_cents, "subtotalCents")?, item.promotion_mode, sale.created_at],
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
    let (aggregate_type, aggregate_id): (String,String) = transaction
        .query_row("select aggregate_type,aggregate_id from sync_outbox where id = ?1", [&event_id], |row| Ok((row.get(0)?,row.get(1)?)))
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "update sync_outbox set status = 'SYNCED', synced_at = ?2, next_attempt_at = ?2,
              last_error = null where id = ?1",
            params![event_id, synced_at],
        )
        .map_err(|error| error.to_string())?;
    if aggregate_type == "SALE" {
        transaction.execute("update local_sales set synced_at = ?2 where id = ?1", params![aggregate_id, synced_at]).map_err(|error| error.to_string())?;
        transaction.execute("update local_stock_movements set synced_at = ?2 where sale_id = ?1", params![aggregate_id, synced_at]).map_err(|error| error.to_string())?;
    }
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
fn clear_offline_authorization(state: State<'_, DatabaseState>, session: State<'_, OperatorSessionState>) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let transaction=connection.transaction().map_err(|error|error.to_string())?;
    transaction
        .execute(
            "update local_device set profile_id = null, user_email = null, role_name = null,
              authorization_validated_at = null, authorization_expires_at = null, updated_at = ?1
             where singleton = 1",
            [now()],
        )
        .map_err(|error| error.to_string())?;
    transaction.execute("delete from local_active_operator",[]).map_err(|error|error.to_string())?;
    transaction.commit().map_err(|error|error.to_string())?;
    session.0.store(false, Ordering::SeqCst);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data)?;
            let mut connection = Connection::open(app_data.join("carnicerias-pos.sqlite"))?;
            initialize_connection(&mut connection).map_err(std::io::Error::other)?;
            let scale_config = scale::load_persisted_config(&connection);
            let autoconnect_scale = scale_config.autoconnect && scale_config.kind != scale::ScaleKind::Manual;
            app.manage(DatabaseState(Mutex::new(connection)));
            app.manage(OperatorSessionState(AtomicBool::new(false)));
            app.manage(scale::ScaleRuntimeState::new(scale_config));
            if autoconnect_scale {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<scale::ScaleRuntimeState>();
                    if let Err(error) = scale::connect_scale(handle.clone(), state) {
                        eprintln!("Scale autoconnect failed: {error}");
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let state = window.state::<DatabaseState>();
                let session = window.state::<OperatorSessionState>();
                match state.0.lock() {
                    Ok(mut connection) => {
                        if let Err(error) = close_authenticated_operator_session(&mut connection, &session.0) {
                            eprintln!("Could not persist the operator clock-out before closing: {error}");
                        }
                    }
                    Err(_) => eprintln!("Could not lock SQLite before closing the POS"),
                };
                let scale_state = window.state::<scale::ScaleRuntimeState>();
                if let Err(error) = scale::disconnect_internal(&scale_state) {
                    eprintln!("Could not release the scale connection before closing: {error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_local_runtime,
            get_local_catalog,
            get_local_categories,
            apply_catalog_pull,
            apply_commercial_config,
            get_local_commercial_config,
            apply_operator_roster,
            get_local_operators,
            cache_verified_operator,
            verify_local_operator,
            get_active_operator,
            clear_active_operator,
            get_local_current_shift,
            clear_reconciled_local_shift,
            apply_server_shift,
            record_offline_time_event,
            close_active_operator_shift,
            confirm_local_sale,
            get_recent_local_sales,
            get_due_outbox,
            get_outbox_summary,
            mark_outbox_syncing,
            mark_outbox_synced,
            mark_outbox_failed,
            force_outbox_retry,
            force_last_outbox_retry,
            clear_offline_authorization,
            scale::get_scale_config,
            scale::get_scale_snapshot,
            scale::set_scale_config,
            scale::list_scale_ports,
            scale::connect_scale,
            scale::disconnect_scale,
            scale::set_simulated_scale_weight,
            scale::simulate_scale_disconnect
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
        assert_eq!(connection.query_row("select count(*) from schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 10);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'discount_cents'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'cash_discount_cents'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'card_surcharge_cents'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'promotion_mode'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'quantity_units'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_weight_discounts') where name = 'pack_price_cents'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from sqlite_master where type='table' and name='catalog_product_categories'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select color_hex from catalog_categories where id='color-category'", [], |row| row.get::<_,String>(0)).unwrap(), "#E99BAD");
        assert!(payment_method_receives_discount("CASH"));
        assert!(payment_method_receives_discount("TRANSFER"));
        assert!(payment_method_receives_discount("OTHER"));
        assert!(!payment_method_receives_discount("DEBIT"));
        assert!(!payment_method_receives_discount("CREDIT"));
    }

    #[test]
    fn unit_sale_migration_preserves_preexisting_local_sale_history() {
        // The real upgrade scenario: a device already has confirmed local sales (under the old,
        // WEIGHT-only local_sales/local_sale_items schema) before migration 9 ever runs. Applying
        // it must rebuild both tables (relaxing total_weight_grams's CHECK and weight_grams's
        // NOT NULL) WITHOUT losing that existing row — this is the scenario the table-rebuild
        // pattern (vs. a destructive drop+recreate) exists to protect.
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("pragma foreign_keys = on; create table if not exists schema_migrations (version integer primary key, applied_at text not null);").unwrap();
        for (version, schema) in [
            (1, INITIAL_SCHEMA), (2, COMMERCIAL_SCHEMA), (3, DISCOUNT_SNAPSHOT_SCHEMA),
            (4, CASH_DISCOUNT_SNAPSHOT_SCHEMA), (5, CATEGORY_COLORS_SCHEMA), (6, POS_OPERATORS_TIMEKEEPING_SCHEMA),
            (7, WEIGHT_DISCOUNT_PACK_MODE_SCHEMA), (8, PRODUCT_CATEGORY_ASSIGNMENTS_SCHEMA),
        ] {
            let transaction = connection.transaction().unwrap();
            transaction.execute_batch(schema).unwrap();
            transaction.execute("insert into schema_migrations(version, applied_at) values (?1, ?2)", params![version, now()]).unwrap();
            transaction.commit().unwrap();
        }
        // Pre-existing confirmed sale under the OLD (pre-migration-9) schema.
        connection.execute(
            "insert into local_sales(id, organization_id, branch_id, profile_id, device_id, status, total_cents, total_weight_grams, created_at, completed_at)
             values ('old-sale', 'org', 'branch', 'profile', 'device', 'COMPLETED', 123400, 1000, '2026-09-01T00:00:00Z', '2026-09-01T00:00:01Z')",
            [],
        ).unwrap();
        connection.execute(
            "insert into local_sale_items(id, sale_id, product_id, product_name_snapshot, weight_grams, price_per_kg_cents, subtotal_cents, created_at)
             values ('old-item', 'old-sale', 'old-product', 'Asado', 1000, 123400, 123400, '2026-09-01T00:00:00Z')",
            [],
        ).unwrap();

        // Now bring the connection up to date — this is where migrations 9 (rebuild) and 10 (new
        // card_surcharge_cents column) run.
        initialize_connection(&mut connection).unwrap();

        assert_eq!(connection.query_row("select count(*) from schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 10);
        assert_eq!(connection.query_row("select total_cents from local_sales where id = 'old-sale'", [], |row| row.get::<_, i64>(0)).unwrap(), 123400);
        assert_eq!(connection.query_row("select weight_grams from local_sale_items where id = 'old-item'", [], |row| row.get::<_, i64>(0)).unwrap(), 1000);
        assert_eq!(connection.query_row("select quantity_units from local_sale_items where id = 'old-item'", [], |row| row.get::<_, Option<i64>>(0)).unwrap(), None);
        assert_eq!(connection.query_row("select card_surcharge_cents from local_sale_items where id = 'old-item'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        // The rebuilt schema now genuinely accepts a UNIT row (nullable weight_grams, new
        // quantity_units, and a sale whose total weight is legitimately zero).
        connection.execute(
            "insert into local_sales(id, organization_id, branch_id, profile_id, device_id, status, total_cents, total_weight_grams, created_at, completed_at)
             values ('unit-sale', 'org', 'branch', 'profile', 'device', 'COMPLETED', 28000, 0, '2026-09-23T00:00:00Z', '2026-09-23T00:00:01Z')",
            [],
        ).unwrap();
        connection.execute(
            "insert into local_sale_items(id, sale_id, product_id, product_name_snapshot, quantity_units, price_per_kg_cents, subtotal_cents, created_at)
             values ('unit-item', 'unit-sale', 'hamburguesa', 'Hamburguesa', 40, 700, 28000, '2026-09-23T00:00:00Z')",
            [],
        ).unwrap();
        assert_eq!(connection.query_row("select quantity_units from local_sale_items where id = 'unit-item'", [], |row| row.get::<_, i64>(0)).unwrap(), 40);
    }

    // D-044: base $14.444,44/kg, 10% card surcharge configured, 5% quantity promo, DEBIT ("Tarjeta").
    // cash_price = 14.444,44 * 1,10 = 15.888,88; promo 5% off that = 15.094,44. card_surcharge_cents
    // (15.888,88 - 14.444,44 = 1.444,44) and promotion_discount_cents (15.888,88 - 15.094,44 =
    // 794,44) must persist separately, and cash_discount_cents must be 0 — no payment method gets
    // an actual discount anymore, only DEBIT/CREDIT get a surcharge (see calculateSalePricing's
    // "applies a sequential percentage promotion after the card surcharge" test for the same numbers).
    #[test]
    fn card_surcharge_sale_persists_separated_snapshots() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        connection.execute("update local_device set organization_id='org',branch_id='branch',profile_id='profile',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('profile','Operador','Empleado',1,1,0,'token','2099-01-01T00:00:00Z','2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_categories(id,organization_id,name,sort_order,active,updated_at) values('category','org','Carnes',0,1,'2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_products values('product','org','category','Asado',null,'WEIGHT',1,'2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_prices values('product','branch',1444444,'2026-09-13T00:00:00Z','2026-09-13T00:00:00Z')", []).unwrap();
        let device_id: String = connection.query_row("select device_id from local_device", [], |row| row.get(0)).unwrap();
        let sale = OfflineSalePayload {
            schema_version: 1, event_id: Uuid::new_v4().to_string(), sale_id: Uuid::new_v4().to_string(),
            organization_id: "org".into(), branch_id: "branch".into(), profile_id: "profile".into(), operator_token: Some("token".into()), device_id,
            status: "COMPLETED".into(), total_cents: "1509444".into(), total_weight_grams: "1000".into(),
            created_at: "2026-09-13T00:00:00Z".into(), completed_at: "2026-09-13T00:00:00Z".into(),
            items: vec![OfflineSaleItem { id: Uuid::new_v4().to_string(), product_id: "product".into(), product_name_snapshot: "Asado".into(), weight_grams: Some(1000), quantity_units: None,
                price_per_kg_cents: "1509444".into(), original_price_per_kg_cents: Some("1444444".into()), discount_rule_id: Some(Uuid::new_v4().to_string()), discount_type: Some("PERCENTAGE".into()), discount_value: Some("500".into()), promotion_mode: None, discount_cents: Some("72222".into()),
                cash_discount_bps: Some("1000".into()), cash_discount_cents: Some("0".into()), card_surcharge_cents: Some("137222".into()), promotion_discount_cents: Some("72222".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "1509444".into() }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "DEBIT".into(), amount_cents: "1509444".into() },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-1000".into(), occurred_at: "2026-09-13T00:00:00Z".into() }]
        };
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select cash_discount_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        // D-044 (corrected): promotion is evaluated against LIST first (5% off 1.444.444 =
        // 1.372.222, a 72.222 promo discount), THEN the 10% card surcharge applies to that
        // promo'd result (1.372.222 * 1,10 = 1.509.444, a 137.222 surcharge) — not the other way
        // around. The final total (1.509.444) is a coincidental match to the old, wrong order for
        // this specific example; the breakdown between promo and surcharge is not.
        assert_eq!(connection.query_row("select card_surcharge_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 137222);
        assert_eq!(connection.query_row("select promotion_discount_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 72222);
    }

    // Same base/percentage as above, but CASH: no adjustment at all — list price unchanged, only
    // the promotion applies. Confirms switching Efectivo <-> Tarjeta recalculates from the same
    // immutable list price rather than leaving a residual adjustment.
    #[test]
    fn cash_sale_with_promotion_has_no_card_surcharge() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        connection.execute("update local_device set organization_id='org',branch_id='branch',profile_id='profile',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('profile','Operador','Empleado',1,1,0,'token','2099-01-01T00:00:00Z','2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_categories(id,organization_id,name,sort_order,active,updated_at) values('category','org','Carnes',0,1,'2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_products values('product','org','category','Asado',null,'WEIGHT',1,'2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_prices values('product','branch',1444444,'2026-09-13T00:00:00Z','2026-09-13T00:00:00Z')", []).unwrap();
        let device_id: String = connection.query_row("select device_id from local_device", [], |row| row.get(0)).unwrap();
        // 5% off the (unchanged) list price: 1.444.444 * 0,95 rounded half up = 1.372.222.
        let sale = OfflineSalePayload {
            schema_version: 1, event_id: Uuid::new_v4().to_string(), sale_id: Uuid::new_v4().to_string(),
            organization_id: "org".into(), branch_id: "branch".into(), profile_id: "profile".into(), operator_token: Some("token".into()), device_id,
            status: "COMPLETED".into(), total_cents: "1372222".into(), total_weight_grams: "1000".into(),
            created_at: "2026-09-13T00:00:00Z".into(), completed_at: "2026-09-13T00:00:00Z".into(),
            items: vec![OfflineSaleItem { id: Uuid::new_v4().to_string(), product_id: "product".into(), product_name_snapshot: "Asado".into(), weight_grams: Some(1000), quantity_units: None,
                price_per_kg_cents: "1372222".into(), original_price_per_kg_cents: Some("1444444".into()), discount_rule_id: Some(Uuid::new_v4().to_string()), discount_type: Some("PERCENTAGE".into()), discount_value: Some("500".into()), promotion_mode: None, discount_cents: Some("72222".into()),
                cash_discount_bps: Some("0".into()), cash_discount_cents: Some("0".into()), card_surcharge_cents: Some("0".into()), promotion_discount_cents: Some("72222".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "1372222".into() }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "CASH".into(), amount_cents: "1372222".into() },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-1000".into(), occurred_at: "2026-09-13T00:00:00Z".into() }]
        };
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select cash_discount_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        assert_eq!(connection.query_row("select card_surcharge_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        assert_eq!(connection.query_row("select promotion_discount_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 72222);
    }

    // A CASH sale carrying a nonzero cash_discount_bps (the pre-D-044 shape) must now be rejected
    // — CASH/TRANSFER/OTHER get no adjustment at all.
    #[test]
    fn cash_sale_cannot_carry_a_nonzero_surcharge_bps() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        connection.execute("update local_device set organization_id='org',branch_id='branch',profile_id='profile',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('profile','Operador','Empleado',1,1,0,'token','2099-01-01T00:00:00Z','2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_categories(id,organization_id,name,sort_order,active,updated_at) values('category','org','Carnes',0,1,'2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_products values('product','org','category','Asado',null,'WEIGHT',1,'2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_prices values('product','branch',1000000,'2026-09-13T00:00:00Z','2026-09-13T00:00:00Z')", []).unwrap();
        let device_id: String = connection.query_row("select device_id from local_device", [], |row| row.get(0)).unwrap();
        let sale = OfflineSalePayload {
            schema_version: 1, event_id: Uuid::new_v4().to_string(), sale_id: Uuid::new_v4().to_string(),
            organization_id: "org".into(), branch_id: "branch".into(), profile_id: "profile".into(), operator_token: Some("token".into()), device_id,
            status: "COMPLETED".into(), total_cents: "1100000".into(), total_weight_grams: "1000".into(),
            created_at: "2026-09-13T00:00:00Z".into(), completed_at: "2026-09-13T00:00:00Z".into(),
            items: vec![OfflineSaleItem { id: Uuid::new_v4().to_string(), product_id: "product".into(), product_name_snapshot: "Asado".into(), weight_grams: Some(1000), quantity_units: None,
                price_per_kg_cents: "1100000".into(), original_price_per_kg_cents: Some("1000000".into()), discount_rule_id: None, discount_type: None, discount_value: None, promotion_mode: None, discount_cents: Some("0".into()),
                cash_discount_bps: Some("1000".into()), cash_discount_cents: Some("0".into()), card_surcharge_cents: Some("100000".into()), promotion_discount_cents: Some("0".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "1100000".into() }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "CASH".into(), amount_cents: "1100000".into() },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-1000".into(), occurred_at: "2026-09-13T00:00:00Z".into() }]
        };
        let transaction = connection.transaction().unwrap();
        assert!(insert_sale(&transaction, &sale).is_err());
    }

    fn pack_sale_fixture(connection: &Connection) -> (String, OfflineSalePayload) {
        connection.execute("update local_device set organization_id='org',branch_id='branch',profile_id='profile',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('profile','Operador','Empleado',1,1,0,'token','2099-01-01T00:00:00Z','2026-09-23T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_categories(id,organization_id,name,sort_order,active,updated_at) values('category','org','Carnes',0,1,'2026-09-23T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_products values('product','org','category','Vacio',null,'WEIGHT',1,'2026-09-23T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_prices values('product','branch',10000,'2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')", []).unwrap();
        connection.execute("insert into local_weight_discounts(id,product_id,branch_id,promotion_mode,pack_price_cents) values('pack-1','product',null,'PACK_FIXED_TOTAL',18000)", []).unwrap();
        let device_id: String = connection.query_row("select device_id from local_device", [], |row| row.get(0)).unwrap();
        let sale = OfflineSalePayload {
            schema_version: 1, event_id: Uuid::new_v4().to_string(), sale_id: Uuid::new_v4().to_string(),
            organization_id: "org".into(), branch_id: "branch".into(), profile_id: "profile".into(), operator_token: Some("token".into()), device_id: device_id.clone(),
            status: "COMPLETED".into(), total_cents: "18000".into(), total_weight_grams: "2050".into(),
            created_at: "2026-09-23T00:00:00Z".into(), completed_at: "2026-09-23T00:00:00Z".into(),
            items: vec![OfflineSaleItem {
                id: Uuid::new_v4().to_string(), product_id: "product".into(), product_name_snapshot: "Vacio".into(), weight_grams: Some(2050), quantity_units: None,
                price_per_kg_cents: "8780".into(), original_price_per_kg_cents: Some("10000".into()),
                discount_rule_id: Some("pack-1".into()), discount_type: None, discount_value: None, promotion_mode: Some("PACK_FIXED_TOTAL".into()),
                // D-044 (corrected): cash_discount_cents stays 0 for every payment method (no
                // method gets an actual discount), and the promotion discount is measured against
                // the LIST price (20.500 for 2.050g at $10.000/kg): 20.500 - 18.000 = 2.500. This
                // fixture uses CASH (bps=0), so card_surcharge_cents is 0 here too — see
                // weight_pack_sale_surcharges_the_whole_total_for_debit for the DEBIT case, where
                // the pack's total itself carries the surcharge (no pack exception).
                discount_cents: Some("2500".into()), cash_discount_bps: Some("0".into()), cash_discount_cents: Some("0".into()),
                card_surcharge_cents: Some("0".into()),
                promotion_discount_cents: Some("2500".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "18000".into()
            }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "CASH".into(), amount_cents: "18000".into() },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-2050".into(), occurred_at: "2026-09-23T00:00:00Z".into() }]
        };
        (device_id, sale)
    }

    #[test]
    fn pack_sale_charges_fixed_total_regardless_of_weighed_grams() {
        // "Vacío: 2kg por $18.000" sold as a real 2.050kg piece — subtotal must be exactly the
        // pack's configured total (18000), not a per-kg rate applied to the weighed grams.
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let (_, sale) = pack_sale_fixture(&connection);
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 18000);
        assert_eq!(connection.query_row("select promotion_mode from local_sale_items", [], |row| row.get::<_, Option<String>>(0)).unwrap(), Some("PACK_FIXED_TOTAL".to_string()));
    }

    #[test]
    fn pack_sale_rejects_a_price_above_list_for_the_weighed_amount() {
        // A tiny 100g weighed amount makes the $180 pack total exceed even the full list price
        // for that little a piece (10000c/kg * 0.1kg = 1000c) — must be rejected, not silently
        // accepted as a below-cost "discount".
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let (_, mut sale) = pack_sale_fixture(&connection);
        sale.items[0].weight_grams = Some(100);
        sale.stock_movements[0].quantity_grams = "-100".into();
        let transaction = connection.transaction().unwrap();
        let result = insert_sale(&transaction, &sale);
        assert!(result.is_err());
    }

    // D-044 correction (2026-09-24), required example: "Vacio: 2kg por $18.000" -> DEBIT =
    // $19.800 (18.000 * 1,10), not $18.000. No pack exception to the card surcharge.
    #[test]
    fn weight_pack_sale_surcharges_the_whole_total_for_debit() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let (_, mut sale) = pack_sale_fixture(&connection);
        sale.payment.method = "DEBIT".into();
        sale.items[0].cash_discount_bps = Some("1000".into());
        sale.items[0].card_surcharge_cents = Some("1800".into());
        sale.items[0].subtotal_cents = "19800".into();
        // Derived $/kg display value from the surcharged subtotal: (19800*1000+1025)/2050 = 9659.
        sale.items[0].price_per_kg_cents = "9659".into();
        sale.total_cents = "19800".into();
        sale.payment.amount_cents = "19800".into();
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 19800);
        assert_eq!(connection.query_row("select card_surcharge_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 1800);
    }

    // D-044, required example: promo = $9.000/kg. CASH pays exactly that; DEBIT pays that PLUS
    // the surcharge (promotion is evaluated against list first, surcharge applies to its result).
    #[test]
    fn threshold_sale_surcharges_after_the_promotion_for_debit() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        connection.execute("update local_device set organization_id='org',branch_id='branch',profile_id='profile',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('profile','Operador','Empleado',1,1,0,'token','2099-01-01T00:00:00Z','2026-09-24T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_categories(id,organization_id,name,sort_order,active,updated_at) values('category','org','Carnes',0,1,'2026-09-24T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_products values('product','org','category','Vacio',null,'WEIGHT',1,'2026-09-24T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_prices values('product','branch',1000000,'2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')", []).unwrap();
        let device_id: String = connection.query_row("select device_id from local_device", [], |row| row.get(0)).unwrap();
        // 1kg at $10.000/kg list, FIXED_PRICE_PER_KG promo = $9.000/kg, DEBIT +10% -> $9.900/kg.
        let sale = OfflineSalePayload {
            schema_version: 1, event_id: Uuid::new_v4().to_string(), sale_id: Uuid::new_v4().to_string(),
            organization_id: "org".into(), branch_id: "branch".into(), profile_id: "profile".into(), operator_token: Some("token".into()), device_id,
            status: "COMPLETED".into(), total_cents: "990000".into(), total_weight_grams: "1000".into(),
            created_at: "2026-09-24T00:00:00Z".into(), completed_at: "2026-09-24T00:00:00Z".into(),
            items: vec![OfflineSaleItem { id: Uuid::new_v4().to_string(), product_id: "product".into(), product_name_snapshot: "Vacio".into(), weight_grams: Some(1000), quantity_units: None,
                price_per_kg_cents: "990000".into(), original_price_per_kg_cents: Some("1000000".into()), discount_rule_id: Some(Uuid::new_v4().to_string()), discount_type: Some("FIXED_PRICE_PER_KG".into()), discount_value: Some("900000".into()), promotion_mode: None, discount_cents: Some("100000".into()),
                cash_discount_bps: Some("1000".into()), cash_discount_cents: Some("0".into()), card_surcharge_cents: Some("90000".into()), promotion_discount_cents: Some("100000".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "990000".into() }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "DEBIT".into(), amount_cents: "990000".into() },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-1000".into(), occurred_at: "2026-09-24T00:00:00Z".into() }]
        };
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 990000);
        assert_eq!(connection.query_row("select card_surcharge_cents from local_sale_items", [], |row| row.get::<_,i64>(0)).unwrap(), 90000);
    }

    fn unit_sale_device(connection: &Connection) -> String {
        connection.execute("update local_device set organization_id='org',branch_id='branch',profile_id='profile',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('profile','Operador','Empleado',1,1,0,'token','2099-01-01T00:00:00Z','2026-09-23T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_categories(id,organization_id,name,sort_order,active,updated_at) values('category','org','Carnes',0,1,'2026-09-23T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_products values('hamburguesa','org','category','Hamburguesa',null,'UNIT',1,'2026-09-23T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_prices values('hamburguesa','branch',800,'2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')", []).unwrap();
        connection.query_row("select device_id from local_device", [], |row| row.get(0)).unwrap()
    }

    fn unit_sale_item(quantity: i64, subtotal: i64, discount_cents: i64, promotion_discount_cents: i64, pack_rule_id: Option<&str>) -> OfflineSaleItem {
        // A PACK_FIXED_TOTAL line reuses subtotal_cents as its final_price_per_kg_cents snapshot
        // (there is no single per-unit rate for a mixed pack+remainder line — mirrors
        // calculateUnitPackSalePricing exactly); a plain line uses the genuine $800/u price.
        let price_per_kg_cents = if pack_rule_id.is_some() { subtotal.to_string() } else { "800".to_string() };
        OfflineSaleItem {
            id: Uuid::new_v4().to_string(), product_id: "hamburguesa".into(), product_name_snapshot: "Hamburguesa".into(),
            weight_grams: None, quantity_units: Some(quantity),
            price_per_kg_cents, original_price_per_kg_cents: Some("800".into()),
            discount_rule_id: pack_rule_id.map(|id| id.to_string()),
            discount_type: None, discount_value: None,
            promotion_mode: pack_rule_id.map(|_| "PACK_FIXED_TOTAL".to_string()),
            discount_cents: Some(discount_cents.to_string()), cash_discount_bps: Some("0".into()),
            cash_discount_cents: Some("0".into()), card_surcharge_cents: Some("0".into()),
            promotion_discount_cents: Some(promotion_discount_cents.to_string()),
            cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: subtotal.to_string(),
        }
    }

    fn unit_sale_payload(device_id: String, quantity: i64, subtotal: i64, item: OfflineSaleItem) -> OfflineSalePayload {
        OfflineSalePayload {
            schema_version: 1, event_id: Uuid::new_v4().to_string(), sale_id: Uuid::new_v4().to_string(),
            organization_id: "org".into(), branch_id: "branch".into(), profile_id: "profile".into(), operator_token: Some("token".into()), device_id,
            status: "COMPLETED".into(), total_cents: subtotal.to_string(), total_weight_grams: "0".into(),
            created_at: "2026-09-23T00:00:00Z".into(), completed_at: "2026-09-23T00:00:00Z".into(),
            items: vec![item],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "CASH".into(), amount_cents: subtotal.to_string() },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "hamburguesa".into(), quantity_grams: (-quantity).to_string(), occurred_at: "2026-09-23T00:00:00Z".into() }],
        }
    }

    #[test]
    fn unit_sale_charges_quantity_times_normal_price() {
        // "Hamburguesa": $800/u sin descuento — 3 unidades = $2.400 (misma secuencia comercial:
        // lista -> descuento por pago -> promoción -> final, sin balanza ni gramos involucrados).
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        let sale = unit_sale_payload(device_id, 3, 2400, unit_sale_item(3, 2400, 0, 0, None));
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 2400);
        assert_eq!(connection.query_row("select quantity_units from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 3);
        assert_eq!(connection.query_row("select weight_grams from local_sale_items", [], |row| row.get::<_, Option<i64>>(0)).unwrap(), None);
        assert_eq!(connection.query_row("select total_weight_grams from local_sales", [], |row| row.get::<_, i64>(0)).unwrap(), 0, "a pure-UNIT sale has zero total weight, no longer rejected by the old > 0 check");
    }

    #[test]
    fn unit_pack_sale_applies_exact_multiples() {
        // 40 hamburguesas con pack "40 por $28.000": exactamente 1 pack, sin resto.
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        connection.execute("insert into local_weight_discounts(id,product_id,branch_id,promotion_mode,pack_quantity_units,pack_price_cents) values('pack-1','hamburguesa',null,'PACK_FIXED_TOTAL',40,28000)", []).unwrap();
        // normal_subtotal = 40*800 = 32000; pack subtotal = 28000; discount = 4000.
        let sale = unit_sale_payload(device_id, 40, 28000, unit_sale_item(40, 28000, 4000, 4000, Some("pack-1")));
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 28000);
    }

    #[test]
    fn unit_pack_sale_applies_one_pack_plus_remainder_at_normal_price() {
        // 45 hamburguesas: 1 pack de 40 ($28.000) + 5 x $800 normal = $32.000 — el ejemplo exacto
        // del pedido.
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        connection.execute("insert into local_weight_discounts(id,product_id,branch_id,promotion_mode,pack_quantity_units,pack_price_cents) values('pack-1','hamburguesa',null,'PACK_FIXED_TOTAL',40,28000)", []).unwrap();
        // normal_subtotal = 45*800 = 36000; pack subtotal = 28000 + 5*800 = 32000; discount = 4000.
        let sale = unit_sale_payload(device_id, 45, 32000, unit_sale_item(45, 32000, 4000, 4000, Some("pack-1")));
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 32000);
    }

    #[test]
    fn unit_sale_below_pack_size_gets_no_discount() {
        // 39 hamburguesas con pack "40 por $28.000" configurado: no llega al pack, se cobra a
        // precio normal sin inventar descuento parcial.
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        connection.execute("insert into local_weight_discounts(id,product_id,branch_id,promotion_mode,pack_quantity_units,pack_price_cents) values('pack-1','hamburguesa',null,'PACK_FIXED_TOTAL',40,28000)", []).unwrap();
        let sale = unit_sale_payload(device_id, 39, 31200, unit_sale_item(39, 31200, 0, 0, None));
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 31200);
    }

    // D-044 correction (2026-09-24), required example: "40 unidades por $28.000" -> DEBIT =
    // $30.800 (28.000 * 1,10). No pack exception, even for an exact multiple with no remainder.
    #[test]
    fn unit_pack_sale_surcharges_the_whole_total_for_debit_exact_multiple() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        connection.execute("insert into local_weight_discounts(id,product_id,branch_id,promotion_mode,pack_quantity_units,pack_price_cents) values('pack-1','hamburguesa',null,'PACK_FIXED_TOTAL',40,28000)", []).unwrap();
        let mut item = unit_sale_item(40, 30800, 4000, 4000, Some("pack-1"));
        item.price_per_kg_cents = "30800".into();
        item.cash_discount_bps = Some("1000".into());
        item.card_surcharge_cents = Some("2800".into());
        let mut sale = unit_sale_payload(device_id, 40, 30800, item);
        sale.payment.method = "DEBIT".into();
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 30800);
        assert_eq!(connection.query_row("select card_surcharge_cents from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 2800);
    }

    // D-044 correction, required example: 45 units (1 pack $28.000 + 5 remainder at $800 =
    // $32.000 CASH-equivalent) -> DEBIT = $35.200 (32.000 * 1,10). The surcharge applies to the
    // WHOLE total, never only to the $4.000 remainder (which alone * 1,10 would give $4.400,
    // for a wrong total of $32.400 — this test guards against exactly that mistake).
    #[test]
    fn unit_pack_sale_with_remainder_surcharges_the_whole_total_for_debit() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        connection.execute("insert into local_weight_discounts(id,product_id,branch_id,promotion_mode,pack_quantity_units,pack_price_cents) values('pack-1','hamburguesa',null,'PACK_FIXED_TOTAL',40,28000)", []).unwrap();
        let mut item = unit_sale_item(45, 35200, 4000, 4000, Some("pack-1"));
        item.price_per_kg_cents = "35200".into();
        item.cash_discount_bps = Some("1000".into());
        item.card_surcharge_cents = Some("3200".into());
        let mut sale = unit_sale_payload(device_id, 45, 35200, item);
        sale.payment.method = "DEBIT".into();
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 35200);
        assert_eq!(connection.query_row("select card_surcharge_cents from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 3200);
    }

    #[test]
    fn timekeeping_schema_preserves_shift_and_separates_two_events() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let first = verifier("1234", "device-one").unwrap();
        assert_eq!(first, verifier("1234", "device-one").unwrap());
        assert_ne!(first, verifier("1234", "device-two").unwrap());
        connection.execute("insert into local_employee_shifts(id,employee_id,branch_id,device_id,clock_in_at,clock_in_source,status,updated_at) values('shift','employee','branch','device','2026-09-13T08:00:00Z','OFFLINE','OPEN','2026-09-13T08:00:00Z')", []).unwrap();
        connection.execute("insert into sync_outbox(id,aggregate_type,aggregate_id,operation,payload,status,created_at,next_attempt_at) values('in','SHIFT','shift','EVENT','{}','PENDING','2026-09-13T08:00:00Z','2026-09-13T08:00:00Z')", []).unwrap();
        connection.execute("insert into sync_outbox(id,aggregate_type,aggregate_id,operation,payload,status,created_at,next_attempt_at) values('out','SHIFT','shift','EVENT','{}','PENDING','2026-09-13T15:30:00Z','2026-09-13T15:30:00Z')", []).unwrap();
        initialize_connection(&mut connection).unwrap();
        assert_eq!(connection.query_row("select count(*) from local_employee_shifts where clock_out_at is null", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from sync_outbox where aggregate_type='SHIFT'", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn closing_an_active_operator_persists_exactly_one_local_clock_out() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let timestamp = now();
        connection.execute("update local_device set organization_id='org',branch_id='branch',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('employee','Fede','Operador',1,1,0,'token','2099-01-01T00:00:00Z',?1)", [&timestamp]).unwrap();
        connection.execute("insert into local_active_operator(singleton,profile_id,selected_at) values(1,'employee',?1)", [&timestamp]).unwrap();
        connection.execute("insert into local_employee_shifts(id,employee_id,branch_id,device_id,clock_in_at,clock_in_source,status,updated_at) select 'shift','employee','branch',device_id,?1,'ONLINE','OPEN',?1 from local_device where singleton=1", [&timestamp]).unwrap();

        let session_active = AtomicBool::new(true);
        let first = close_authenticated_operator_session(&mut connection, &session_active).unwrap();
        assert!(first.clock_out_created);
        assert_eq!(first.shift.unwrap().status, "CLOSED");
        assert_eq!(connection.query_row("select count(*) from sync_outbox where aggregate_type='SHIFT' and json_extract(payload,'$.action')='CLOCK_OUT'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from local_active_operator", [], |row| row.get::<_, i64>(0)).unwrap(), 0);

        let second = close_authenticated_operator_session(&mut connection, &session_active).unwrap();
        assert!(!second.clock_out_created);
        assert!(second.shift.is_none());
        assert_eq!(connection.query_row("select count(*) from sync_outbox where aggregate_type='SHIFT' and json_extract(payload,'$.action')='CLOCK_OUT'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn closing_an_operator_without_a_shift_only_clears_the_operator() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let timestamp = now();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,updated_at) values('employee','María','Operador',1,1,0,?1)", [&timestamp]).unwrap();
        connection.execute("insert into local_active_operator(singleton,profile_id,selected_at) values(1,'employee',?1)", [&timestamp]).unwrap();

        let result = close_active_operator_shift_in_connection(&mut connection).unwrap();
        assert!(!result.clock_out_created);
        assert!(result.shift.is_none());
        assert_eq!(connection.query_row("select count(*) from local_active_operator", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(connection.query_row("select count(*) from sync_outbox where aggregate_type='SHIFT'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn closing_before_reauthentication_does_not_invent_a_clock_out() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let timestamp = now();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,updated_at) values('employee','Fede','Operador',1,1,0,?1)", [&timestamp]).unwrap();
        connection.execute("insert into local_active_operator(singleton,profile_id,selected_at) values(1,'employee',?1)", [&timestamp]).unwrap();
        connection.execute("insert into local_employee_shifts(id,employee_id,branch_id,device_id,clock_in_at,clock_in_source,status,updated_at) values('shift','employee','branch','device',?1,'OFFLINE','OPEN',?1)", [&timestamp]).unwrap();
        let session_active = AtomicBool::new(false);

        let result = close_authenticated_operator_session(&mut connection, &session_active).unwrap();
        assert!(!result.clock_out_created);
        assert_eq!(connection.query_row("select count(*) from local_employee_shifts where clock_out_at is null", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from sync_outbox where aggregate_type='SHIFT'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(connection.query_row("select count(*) from local_active_operator", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }
}
