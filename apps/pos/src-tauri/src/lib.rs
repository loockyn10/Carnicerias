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
const SHIFT_HEARTBEAT_SCHEMA: &str = include_str!("../migrations/011_shift_heartbeat.sql");
const BRANCH_STOCK_PROJECTION_SCHEMA: &str = include_str!("../migrations/012_branch_stock_projection.sql");
const PRODUCT_BARCODES_SCHEMA: &str = include_str!("../migrations/013_product_barcodes.sql");
const PAYMENT_VERIFICATION_SCHEMA: &str = include_str!("../migrations/014_payment_verification.sql");
const CATALOG_ZERO_PRICE_SCHEMA: &str = include_str!("../migrations/015_catalog_zero_price.sql");
const FLEXIBLE_PRICING_SCHEMA: &str = include_str!("../migrations/016_flexible_pricing.sql");
const UNIT_PACKS_PROMOTIONS_SCHEMA: &str = include_str!("../migrations/017_unit_packs_and_branch_promotions.sql");
const PACK_CONFIG_SCHEMA: &str = include_str!("../migrations/018_pack_config_versions.sql");
const PACK_DISCOUNT_SCHEMA: &str = include_str!("../migrations/019_pack_discount_single_category_threshold_promotions.sql");

/// Un producto sin precio (precio 0, importado desde SimplyGest) nunca se vende: el POS pide el precio antes de agregarlo al ticket.
const PRICE_REQUIRED: &str = "PRICE_REQUIRED: el producto no tiene precio; fijá el precio antes de venderlo.";

/// Mensaje (y código estable) cuando se intenta registrar una Transferencia manual donde Mercado Pago es obligatorio.
const FLEXIBLE_PRICING_NOT_ALLOWED: &str = "FLEXIBLE_PRICING_NOT_ALLOWED: el precio manual y el descuento general sólo están habilitados en el POS de Central.";
/// Porcentaje de un pack cuando el servidor no lo informa (un servidor anterior a 202610040061, donde TODO pack era 20 %).
/// Ya NO es una regla: cada producto tiene el suyo (products.pack_discount_bps) y viaja en packDiscountBps con la versión.
const DEFAULT_PACK_DISCOUNT_BPS: i64 = 2_000;
const MANUAL_TRANSFER_NOT_ALLOWED: &str = "MANUAL_TRANSFER_NOT_ALLOWED: la transferencia manual no está permitida en esta sucursal; cobrá con Mercado Pago.";

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
    /// Normalized barcodes of the product (scanner codes), for LOCAL scan resolution.
    barcodes: Vec<String>,
    /// Unidades por pack (sólo UNIT; None = sin pack). El POS ofrece "Pack" únicamente si existe.
    pack_size_units: Option<i64>,
    /// Id de la versión vigente del pack (product_pack_versions del servidor): va en cada línea vendida como Pack.
    pack_config_id: Option<String>,
    /// Descuento de esa versión del pack, en basis points: el porcentaje propio de este producto (no hay uno global).
    pack_discount_bps: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalCategoryRow {
    id: String,
    name: String,
    color_hex: Option<String>,
    sort_order: i64,
}

/// Effective stock of the device branch as the POS screen needs it: the last server snapshot
/// (catalog_branch_stock) adjusted by this device's own sale movements that the snapshot cannot
/// include yet. `snapshot_applied = false` means stock was never synced (upgrade/offline first
/// start) — the UI must treat that as "unknown" and keep every product sellable, NOT as zero.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBranchStock {
    snapshot_applied: bool,
    items: Vec<LocalBranchStockItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBranchStockItem {
    product_id: String,
    quantity_grams: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchStockSnapshotItem {
    product_id: String,
    quantity_grams: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchStockSnapshot {
    branch_id: String,
    items: Vec<BranchStockSnapshotItem>,
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
    /// Contrato anterior ("categorías del producto"): se acepta pero se IGNORA. Un producto tiene una sola categoría (category_id).
    #[serde(default)]
    #[allow(dead_code)]
    category_ids: Vec<String>,
    product_id: String,
    product_name: String,
    product_sku: Option<String>,
    unit_type: String,
    product_active: bool,
    price_per_kg_cents: String,
    price_valid_from: String,
    #[serde(default)]
    barcodes: Vec<String>,
    #[serde(default)]
    pack_size_units: Option<i64>,
    #[serde(default)]
    pack_config_id: Option<String>,
    /// Descuento (basis points) de la versión del pack. Ausente = un servidor anterior, donde todo pack era 20 %.
    #[serde(default)]
    pack_discount_bps: Option<i64>,
}

/// Promoción global de la sucursal del dispositivo ("desde N unidades, X %" sobre TODAS las unidades de la línea de sus productos UNIT).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogBranchPromotion {
    id: String,
    /// Cantidad mínima: con esa cantidad o más del mismo producto, TODAS las unidades de la línea llevan el descuento.
    minimum_units: i64,
    discount_bps: i64,
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
    /// Foto completa de las promociones globales "desde N" activas de la sucursal. Viaja bajo una clave PROPIA
    /// (`branchPromotionsFromMinimum`): la clave anterior (`branchPromotions`, la que lee un POS de antes de 202610040061 y que
    /// aplicaría "cada N") el servidor la entrega vacía y este POS no la lee nunca. None = un servidor que no la envía: no se toca
    /// lo guardado (la migración 019 ya vació las reglas de la semántica anterior).
    #[serde(default)]
    branch_promotions_from_minimum: Option<Vec<CatalogBranchPromotion>>,
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
struct LocalCommercialConfig { cash_discount_bps: i64, discounts: Vec<LocalDiscount>, announcements: Vec<LocalAnnouncement>, branch_promotions: Vec<LocalBranchPromotion> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBranchPromotion { id: String, minimum_units: i64, discount_bps: i64 }
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

fn is_false(value: &bool) -> bool { !*value }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Precio manual de la línea (D-061, sólo POS de Central): `price_per_kg_cents` ES el precio fijado por el
    /// operador (por kg o por unidad) y `original_price_per_kg_cents` el precio normal del catálogo. Las tres
    /// claves se omiten al serializar cuando no hay precio manual: el payload del outbox de una línea
    /// normal no cambia.
    #[serde(default, skip_serializing_if = "is_false")]
    manual_price_applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manual_unit_price_cents: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manual_adjustment_cents: Option<String>,
    /// Pack de un producto UNIT: `quantity_units` son las unidades REALES (pack_count × pack_size_units_snapshot) y todas
    /// llevan `pack_discount_bps` (20 %). Las claves se omiten al serializar cuando la línea no es un pack: el payload
    /// del outbox de una línea normal no cambia.
    #[serde(default, skip_serializing_if = "is_false")]
    sold_as_pack: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pack_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pack_size_units_snapshot: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pack_discount_bps: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pack_discount_cents: Option<String>,
    /// Versión del pack (product_pack_versions) con la que se vendió la línea: el servidor valida la venta contra esa versión,
    /// nunca contra el tamaño actual del producto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pack_config_id: Option<String>,
    /// Promoción global de la sucursal aplicada a la línea (snapshot de la regla "desde N unidades"; sólo si aplicó): todas las
    /// unidades de la línea llevan el descuento. (El formato anterior "cada N" era `branchPromotionEveryUnits`: este POS ya no lo
    /// genera ni lo acepta.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch_promotion_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch_promotion_minimum_units: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch_promotion_discount_bps: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch_promotion_discounted_units: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch_promotion_discount_cents: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflinePayment {
    id: String,
    method: String,
    amount_cents: String,
    /// Proveedor que debe verificar el cobro (hoy sólo "MERCADOPAGO", siempre con method
    /// "TRANSFER": mismo precio, sin recargo). Ausente = medio manual. Se omite al serializar
    /// cuando no existe para que el payload del outbox de una venta normal no cambie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflineStockMovement {
    id: String,
    product_id: String,
    quantity_grams: String,
    occurred_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Descuento general del ticket (D-061, sólo POS de Central): porcentaje en basis points, su importe y la
    /// suma de las líneas antes del descuento. Se omiten cuando no hay descuento. `total_cents` es lo cobrado.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ticket_discount_bps: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ticket_discount_cents: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subtotal_cents: Option<String>,
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
    /// Proveedor que verifica el cobro (hoy sólo "MERCADOPAGO"); None = medio manual.
    provider: Option<String>,
    /// Estado de verificación cacheado del pago (NOT_REQUIRED para medios manuales).
    verification_status: Option<String>,
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
struct OfflineTimeEvent { schema_version: i64, event_id: String, shift_id: String, employee_id: String, device_id: String, operator_token: String, action: String, occurred_at: String, #[serde(default)] inferred: bool }

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
    let shift_heartbeat_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 11)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !shift_heartbeat_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(SHIFT_HEARTBEAT_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (11, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let branch_stock_projection_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 12)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !branch_stock_projection_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(BRANCH_STOCK_PROJECTION_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (12, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    let product_barcodes_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 13)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !product_barcodes_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(PRODUCT_BARCODES_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (13, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    let payment_verification_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 14)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !payment_verification_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(PAYMENT_VERIFICATION_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (14, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    // 015: catalog_prices accepts price 0 ("sin precio", Central). Rebuilds a table nothing references, so
    // the foreign-key pragma does not need to be toggled (unlike 009).
    let catalog_zero_price_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 15)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !catalog_zero_price_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(CATALOG_ZERO_PRICE_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (15, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    // 016: precio manual por línea y descuento general del ticket (D-061). Sólo ALTER TABLE ADD COLUMN con
    // defaults: no reconstruye ninguna tabla y las ventas locales ya confirmadas quedan intactas.
    let flexible_pricing_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 16)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !flexible_pricing_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(FLEXIBLE_PRICING_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (16, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    // 017: pack de productos UNIT (20 %) y promoción global por sucursal. Tablas nuevas y ALTER TABLE ADD COLUMN con
    // defaults: no reconstruye ninguna tabla y las ventas locales ya confirmadas quedan intactas.
    let unit_packs_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 17)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !unit_packs_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(UNIT_PACKS_PROMOTIONS_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (17, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    // 018: versión (configuración histórica) del pack: el POS guarda el id de la versión vigente que le dio el servidor y cada
    // línea vendida como Pack lo lleva. Sólo ALTER TABLE ADD COLUMN nullable: no reconstruye tablas y nada anterior cambia.
    let pack_config_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 18)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !pack_config_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(PACK_CONFIG_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (18, ?1)", [now()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    // 019: descuento del pack por producto (pack_discount_bps), promoción global "desde N unidades" (every_units -> minimum_units) y una
    // sola categoría por producto. ADD/RENAME COLUMN y limpieza de filas del catálogo (réplica del servidor): sin reconstruir tablas.
    let pack_discount_applied = connection.query_row("select exists(select 1 from schema_migrations where version = 19)", [], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if !pack_discount_applied {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(PACK_DISCOUNT_SCHEMA).map_err(|error| error.to_string())?;
        transaction.execute("insert into schema_migrations(version, applied_at) values (19, ?1)", [now()]).map_err(|error| error.to_string())?;
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
    reconcile_stale_open_shifts(connection)?;
    Ok(())
}

// A shift still OPEN in local_employee_shifts at the moment this runs can only be one
// the previous process run left behind without going through the normal close path:
// a clean "Salir"/window-close always closes it first via
// close_active_operator_shift_in_connection before the process exits (see
// on_window_event / the CloseRequested handlers), and the in-memory OperatorSessionState
// flag that gates that path always starts false on every fresh process. So finding an
// OPEN row here means the app crashed, was killed, or lost power with that shift open.
//
// Reconcile it now using the last locally-recorded heartbeat as the shift's effective
// end (never "now" — that would count time up to this restart/reconnection as worked,
// which is exactly what docs/DOMAIN_RULES.md "Control horario" forbids inventing). This
// both frees the employee to clock in again immediately instead of silently resuming a
// shift that may be hours or days stale, and gives the server real evidence to close the
// same shift with (p_inferred=true forces REQUIRES_REVIEW + auto_closed_by_heartbeat,
// see app_private.apply_employee_time_event) once this event reaches it.
fn reconcile_stale_open_shifts(connection: &mut Connection) -> Result<(), String> {
    let timestamp = now();
    let stale: Vec<(String, String, String, String, Option<String>)> = {
        let mut statement = connection
            .prepare("select id, employee_id, device_id, clock_in_at, last_heartbeat_at from local_employee_shifts where status = 'OPEN' and clock_out_at is null")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    for (shift_id, employee_id, device_id, clock_in_at, last_heartbeat_at) in stale {
        // No heartbeat was ever recorded (died within the first tick): the only honest
        // evidence left is the clock-in itself, never "now"/this restart's timestamp.
        let inferred_at = last_heartbeat_at.unwrap_or(clock_in_at);
        let operator_token: Option<String> = connection
            .query_row("select operator_token from local_pos_operators where profile_id = ?1", [&employee_id], |row| row.get(0))
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute(
            "update local_employee_shifts set clock_out_at=?2,clock_out_source='OFFLINE',status='REQUIRES_REVIEW',updated_at=?3 where id=?1",
            params![shift_id, inferred_at, timestamp],
        ).map_err(|error| error.to_string())?;
        // Without a cached operator token the server can't authenticate this device's
        // synthetic event; the local row is still closed above so a fresh clock-in isn't
        // blocked, and the server's own heartbeat-lease sweep (independent of this local
        // reconciliation) remains the source of truth once this device reconnects.
        if let Some(token) = operator_token {
            let event_id = Uuid::new_v4().to_string();
            let payload = OfflineTimeEvent {
                schema_version: 1, event_id: event_id.clone(), shift_id: shift_id.clone(),
                employee_id, device_id, operator_token: token,
                action: "CLOCK_OUT".into(), occurred_at: inferred_at, inferred: true,
            };
            transaction.execute(
                "insert into sync_outbox(id,aggregate_type,aggregate_id,operation,payload,status,attempts,created_at,next_attempt_at) values(?1,'SHIFT',?2,'EVENT',?3,'PENDING',0,?4,?4)",
                params![event_id, shift_id, serde_json::to_string(&payload).map_err(|error| error.to_string())?, timestamp],
            ).map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
    }
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
    local_catalog_inner(&connection, &branch_id)
}

fn local_catalog_inner(connection: &Connection, branch_id: &str) -> Result<Vec<LocalCatalogRow>, String> {
    let branch_id = branch_id.to_string();
    let branch_name: String = connection
        .query_row("select branch_name from local_device where singleton = 1 and branch_id = ?1", [&branch_id], |row| row.get(0))
        .map_err(|_| "Device is not assigned to this branch".to_string())?;

    // Barcodes of every product, fetched once (same approach as the category assignments above).
    let mut barcodes_by_product: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut barcode_statement = connection
        .prepare("select product_id, barcode from catalog_product_barcodes order by barcode")
        .map_err(|error| error.to_string())?;
    let barcode_rows = barcode_statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?;
    for pair in barcode_rows {
        let (product_id, barcode) = pair.map_err(|error| error.to_string())?;
        barcodes_by_product.entry(product_id).or_default().push(barcode);
    }

    // Pack de cada producto (si tiene): tamaño + id de la versión vigente, una sola consulta como las categorías y los barcodes.
    // Un pack sin versión (fila anterior a la migración 18) no se ofrece: la venta no podría validarse en el servidor.
    let mut pack_sizes: std::collections::HashMap<String, (i64, String, i64)> = std::collections::HashMap::new();
    let mut pack_statement = connection
        .prepare("select product_id, pack_size_units, pack_config_id, pack_discount_bps from catalog_product_packs where pack_config_id is not null")
        .map_err(|error| error.to_string())?;
    let pack_rows = pack_statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)))
        .map_err(|error| error.to_string())?;
    for quad in pack_rows {
        let (product_id, size, config_id, discount_bps) = quad.map_err(|error| error.to_string())?;
        pack_sizes.insert(product_id, (size, config_id, discount_bps));
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
            // Un producto tiene UNA sola categoría: categoryIds es siempre [categoryId] (contrato anterior, conservado).
            let category_ids = vec![principal_category_id.clone()];
            let barcodes = barcodes_by_product.get(&product_id).cloned().unwrap_or_default();
            let (pack_size_units, pack_config_id, pack_discount_bps) = match pack_sizes.get(&product_id) {
                Some((size, config_id, discount_bps)) => (Some(*size), Some(config_id.clone()), Some(*discount_bps)),
                None => (None, None, None),
            };
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
                barcodes,
                pack_size_units,
                pack_config_id,
                pack_discount_bps,
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
    apply_catalog_pull_inner(&mut connection, &pull, &profile_id, &user_email)
}

fn apply_catalog_pull_inner(
    connection: &mut Connection,
    pull: &CatalogPullPayload,
    profile_id: &str,
    user_email: &str,
) -> Result<(), String> {
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
        // A product that left this branch assortment must stop resolving from a scan. If it is
        // enabled again later, the pull that re-sends it re-sends its barcodes too.
        transaction
            .execute("delete from catalog_product_barcodes where product_id = ?1", params![product_id])
            .map_err(|error| error.to_string())?;
        // Tampoco debe ofrecer un Pack: se vuelve a enviar con el producto si vuelve al surtido.
        transaction
            .execute("delete from catalog_product_packs where product_id = ?1", params![product_id])
            .map_err(|error| error.to_string())?;
    }

    // Promociones globales de la sucursal: foto completa, se reemplaza entera (como el directorio de categorías).
    // Un servidor que no las envía (None) no cambia lo guardado.
    if let Some(promotions) = &pull.branch_promotions_from_minimum {
        transaction.execute("delete from catalog_branch_promotions", []).map_err(|error| error.to_string())?;
        for promotion in promotions {
            if promotion.minimum_units < 2 || !(1..10_000).contains(&promotion.discount_bps) {
                return Err("Invalid branch promotion".to_string());
            }
            transaction
                .execute(
                    "insert into catalog_branch_promotions(id, branch_id, scope, minimum_units, discount_bps) values (?1, ?2, 'ALL_UNIT_PRODUCTS', ?3, ?4)",
                    params![promotion.id, pull.branch_id, promotion.minimum_units, promotion.discount_bps],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    // Category DIRECTORY (POS tab source): always a full current snapshot, independent of the
    // incremental product cursor (a small table, cheap to fully resend every pull). Each product has
    // ONE category, so the directory is simply the categories of the products enabled in this branch.
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
        // Barcodes: full set for this product, same replace-per-product pattern. A code that moved
        // to another product (the server guarantees one owner) is re-pointed by the upsert.
        transaction
            .execute("delete from catalog_product_barcodes where product_id = ?1", params![row.product_id])
            .map_err(|error| error.to_string())?;
        for barcode in &row.barcodes {
            transaction
                .execute(
                    "insert into catalog_product_barcodes(barcode, product_id) values (?1, ?2)
                     on conflict(barcode) do update set product_id = excluded.product_id",
                    params![barcode, row.product_id],
                )
                .map_err(|error| error.to_string())?;
        }

        // Pack: valor único por producto (None = sin pack), reemplazado en cada pull que lo toca. Se guarda junto con el id de su
        // versión y su porcentaje; sin ese id (un servidor anterior) no se ofrece Pack, porque la venta no podría validarse en el
        // servidor. Sin porcentaje (servidor anterior a 202610040061) el pack era 20 %; un porcentaje fuera de 0 < % < 100 no se ofrece.
        transaction
            .execute("delete from catalog_product_packs where product_id = ?1", params![row.product_id])
            .map_err(|error| error.to_string())?;
        if let (Some(pack_size), Some(pack_config_id)) = (row.pack_size_units, row.pack_config_id.as_deref().filter(|id| !id.is_empty())) {
            let pack_discount_bps = row.pack_discount_bps.unwrap_or(DEFAULT_PACK_DISCOUNT_BPS);
            if row.unit_type == "UNIT" && pack_size >= 2 && (1..=9_999).contains(&pack_discount_bps) {
                transaction
                    .execute(
                        "insert into catalog_product_packs(product_id, pack_size_units, pack_config_id, pack_discount_bps) values (?1, ?2, ?3, ?4)",
                        params![row.product_id, pack_size, pack_config_id, pack_discount_bps],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }

        // Una sola categoría por producto: el conjunto local se reemplaza por [categoría del producto]. Se ignora cualquier lista
        // `categoryIds` del servidor (contrato anterior): nunca se guardan categorías secundarias.
        transaction
            .execute("delete from catalog_product_categories where product_id = ?1", params![row.product_id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "insert into catalog_product_categories(product_id, category_id) values (?1, ?2) on conflict(product_id, category_id) do nothing",
                params![row.product_id, row.category_id],
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

/// Replaces the stored stock snapshot for the device branch with the server's current one.
/// Full replace (not a delta): a product that dropped out of the payload has no movements
/// anymore and must read as zero, never keep a stale positive value.
fn apply_branch_stock_inner(connection: &mut Connection, snapshot: &BranchStockSnapshot) -> Result<(), String> {
    let device_branch: Option<String> = connection
        .query_row("select branch_id from local_device where singleton = 1", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if device_branch.as_deref() != Some(snapshot.branch_id.as_str()) {
        return Err("Stock snapshot is for a different branch than this device".to_string());
    }
    let mut parsed: Vec<(&str, i64)> = Vec::with_capacity(snapshot.items.len());
    for item in &snapshot.items {
        parsed.push((item.product_id.as_str(), parse_i64(&item.quantity_grams, "quantityGrams")?));
    }
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let timestamp = now();
    transaction
        .execute("delete from catalog_branch_stock where branch_id = ?1", params![snapshot.branch_id])
        .map_err(|error| error.to_string())?;
    for (product_id, quantity_grams) in parsed {
        transaction
            .execute(
                "insert into catalog_branch_stock(branch_id, product_id, quantity_grams) values (?1, ?2, ?3)",
                params![snapshot.branch_id, product_id, quantity_grams],
            )
            .map_err(|error| error.to_string())?;
    }
    set_metadata(&transaction, "branch_stock_branch_id", &snapshot.branch_id, &timestamp)?;
    set_metadata(&transaction, "branch_stock_applied_at", &timestamp, &timestamp)?;
    transaction.commit().map_err(|error| error.to_string())
}

fn local_branch_stock_inner(connection: &Connection, branch_id: &str) -> Result<LocalBranchStock, String> {
    let snapshot_branch = metadata(connection, "branch_stock_branch_id")?;
    let applied_at = metadata(connection, "branch_stock_applied_at")?;
    let Some(applied_at) = applied_at.filter(|_| snapshot_branch.as_deref() == Some(branch_id)) else {
        return Ok(LocalBranchStock { snapshot_applied: false, items: Vec::new() });
    };

    let mut quantities: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut snapshot = connection
        .prepare("select product_id, quantity_grams from catalog_branch_stock where branch_id = ?1")
        .map_err(|error| error.to_string())?;
    let snapshot_rows = snapshot
        .query_map([branch_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|error| error.to_string())?;
    for pair in snapshot_rows {
        let (product_id, quantity) = pair.map_err(|error| error.to_string())?;
        quantities.insert(product_id, quantity);
    }

    // A Mercado Pago sale that ended without accreditation (cancelled / expired) is annulled by the
    // server and its stock goes back to the ledger, so it must not hold stock here either: excluded
    // by construction (exactly once, no second local ledger). If the snapshot already contains its
    // SALE movement but not yet the server's RETURN, the figure is briefly conservative until the
    // next snapshot (the POS syncs right after a cancellation).
    // Sales this device made that the snapshot cannot contain: still unsynced, or synced after the
    // snapshot was applied (the server figure predates them). Sales synced before the snapshot are
    // already in the server sum, so counting them again would double-subtract. julianday() (not a
    // string comparison) because the two timestamps come from different formatters (Rust RFC 3339
    // vs JS toISOString) with different fractional-second widths.
    let mut pending = connection
        .prepare(
            "select product_id, sum(quantity_grams) from local_stock_movements
             where branch_id = ?1 and (synced_at is null or julianday(synced_at) > julianday(?2))
               and sale_id not in (
                 select sale_id from local_payments
                 where provider is not null and verification_status in ('CANCELLED', 'EXPIRED')
               )
             group by product_id",
        )
        .map_err(|error| error.to_string())?;
    let pending_rows = pending
        .query_map(params![branch_id, applied_at], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|error| error.to_string())?;
    for pair in pending_rows {
        let (product_id, quantity) = pair.map_err(|error| error.to_string())?;
        *quantities.entry(product_id).or_insert(0) += quantity;
    }

    let items = quantities
        .into_iter()
        .map(|(product_id, quantity_grams)| LocalBranchStockItem { product_id, quantity_grams })
        .collect();
    Ok(LocalBranchStock { snapshot_applied: true, items })
}

#[tauri::command]
fn apply_branch_stock(state: State<'_, DatabaseState>, snapshot: BranchStockSnapshot) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    apply_branch_stock_inner(&mut connection, &snapshot)
}

#[tauri::command]
fn get_local_branch_stock(state: State<'_, DatabaseState>, branch_id: String) -> Result<LocalBranchStock, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    local_branch_stock_inner(&connection, &branch_id)
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
    // Promociones globales de ESTA sucursal (la del dispositivo), ya guardadas por el último pull: se leen sin red.
    let mut promotions = connection.prepare("select id, minimum_units, discount_bps from catalog_branch_promotions where branch_id = (select branch_id from local_device where singleton = 1) order by id").map_err(|e| e.to_string())?;
    let branch_promotions = promotions.query_map([], |r| Ok(LocalBranchPromotion { id: r.get(0)?, minimum_units: r.get(1)?, discount_bps: r.get(2)? })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(LocalCommercialConfig { cash_discount_bps, discounts, announcements, branch_promotions })
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
    let payload=OfflineTimeEvent{schema_version:1,event_id:event_id.clone(),shift_id:shift.shift_id.clone(),employee_id:employee,device_id:device,operator_token:token,action:action.to_string(),occurred_at:timestamp.clone(),inferred:false};
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

// Local half of the presence lease (see docs/DOMAIN_RULES.md "Control horario"): persisted
// every ~30s from the frontend regardless of connectivity, so reconcile_stale_open_shifts has
// real evidence of the last moment this device was alive if the process dies before its next
// tick. Resolves the target shift from local_active_operator rather than trusting a caller-
// supplied shift id, same pattern as record_offline_time_event_in_connection. No-op (returns
// None) if there's no active operator with an OPEN shift — never an error, since a heartbeat
// tick racing a clock-out/logout is expected, not exceptional.
fn record_shift_heartbeat_local_in_connection(connection: &Connection) -> Result<Option<String>, String> {
    let timestamp = now();
    let updated = connection.execute(
        "update local_employee_shifts set last_heartbeat_at=?1,updated_at=?1
         where status='OPEN' and clock_out_at is null
           and employee_id=(select profile_id from local_active_operator where singleton=1)",
        params![timestamp],
    ).map_err(|error| error.to_string())?;
    Ok(if updated > 0 { Some(timestamp) } else { None })
}

#[tauri::command]
fn record_shift_heartbeat_local(state: State<'_, DatabaseState>) -> Result<Option<String>, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    record_shift_heartbeat_local_in_connection(&connection)
}

fn insert_sale(transaction: &Transaction<'_>, sale: &OfflineSalePayload) -> Result<(), String> {
    if sale.schema_version != 1 || sale.status != "COMPLETED" || sale.items.is_empty() || sale.items.len() > 100 {
        return Err("Unsupported or empty offline sale".to_string());
    }
    if sale.items.len() != sale.stock_movements.len() {
        return Err("Every sale item needs one stock movement".to_string());
    }
    // Una sucursal con Mercado Pago obligatorio no admite Transferencia manual: la política la informó
    // el servidor (`mp_get_branch_config`) y se recuerda en SQLite para valer también sin Internet. No
    // es sólo un botón oculto: la venta ni siquiera se registra (y el servidor la rechazaría igual).
    if sale.payment.method == "TRANSFER" && sale.payment.provider.is_none()
        && metadata(transaction, "manual_transfer_blocked_branch")?.as_deref() == Some(sale.branch_id.as_str())
    {
        return Err(MANUAL_TRANSFER_NOT_ALLOWED.to_string());
    }

    // Precio manual y descuento general (D-061) sólo existen en el POS de Central: la sucursal productiva
    // que informó el servidor (`get_pos_device_capabilities`) y se recuerda en SQLite para valer también sin
    // Internet. No es sólo un control visual: la venta ni siquiera se registra (y el servidor la rechazaría igual).
    let uses_flexible_pricing = sale.ticket_discount_bps.is_some()
        || sale.ticket_discount_cents.is_some()
        || sale.items.iter().any(|item| item.manual_price_applied || item.manual_unit_price_cents.is_some() || item.manual_adjustment_cents.is_some());
    if uses_flexible_pricing && metadata(transaction, "flexible_pricing_branch")?.as_deref() != Some(sale.branch_id.as_str()) {
        return Err(FLEXIBLE_PRICING_NOT_ALLOWED.to_string());
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
        // A product without price (0) is never sold, whatever the UI did: the line would be worth $0.
        if price <= 0 || original_price <= 0 {
            return Err(PRICE_REQUIRED.to_string());
        }
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

        // Pack / promoción de sucursal: sólo en líneas UNIT normales, nunca juntos, nunca con precio manual ni con una
        // promoción específica del producto (un solo descuento por línea). El detalle se revalida en la rama UNIT.
        let has_pack_fields = item.sold_as_pack || item.pack_count.is_some() || item.pack_size_units_snapshot.is_some() || item.pack_discount_bps.is_some() || item.pack_discount_cents.is_some() || item.pack_config_id.is_some();
        let has_promotion_fields = item.branch_promotion_id.is_some() || item.branch_promotion_minimum_units.is_some() || item.branch_promotion_discount_bps.is_some()
            || item.branch_promotion_discounted_units.is_some() || item.branch_promotion_discount_cents.is_some();
        if has_pack_fields || has_promotion_fields {
            if item.manual_price_applied || item.quantity_units.is_none() || item.weight_grams.is_some()
                || item.promotion_mode.is_some() || item.discount_rule_id.is_some() || item.discount_type.is_some() || item.discount_value.is_some()
                || (item.sold_as_pack && has_promotion_fields) || (!item.sold_as_pack && has_pack_fields)
            {
                return Err("Offline unit discount metadata is inconsistent".to_string());
            }
        }

        if item.manual_price_applied {
            // Precio manual (D-061): el precio fijado por el operador ES el precio final de la línea. No recibe
            // promoción, pack, recargo por tarjeta ni ajuste por medio de pago, así que no se recalcula contra
            // ninguna regla: se valida su aritmética tal cual (precio * cantidad) y el ajuste contra el precio normal.
            let manual_price = item.manual_unit_price_cents.as_deref().ok_or_else(|| "A manual price line is missing its price".to_string()).and_then(|value| parse_i64(value, "manualUnitPriceCents"))?;
            let manual_adjustment = item.manual_adjustment_cents.as_deref().ok_or_else(|| "A manual price line is missing its adjustment".to_string()).and_then(|value| parse_i64(value, "manualAdjustmentCents"))?;
            if manual_price <= 0 || manual_price != price {
                return Err("Invalid manual price".to_string());
            }
            if item.discount_rule_id.is_some() || item.discount_type.is_some() || item.discount_value.is_some() || item.promotion_mode.is_some()
                || discount_cents != 0 || promotion_discount_cents != 0 || card_surcharge_cents != 0 || cash_discount_bps != 0
            {
                return Err("A manual price line cannot carry promotions, surcharges or discounts".to_string());
            }
            let (list_subtotal, expected_subtotal) = match (item.weight_grams, item.quantity_units) {
                (Some(weight_grams), None) => {
                    product_unit_type = "WEIGHT";
                    if weight_grams <= 0 { return Err("Invalid local sale calculation".to_string()); }
                    computed_weight = computed_weight.checked_add(weight_grams).ok_or_else(|| "Sale weight overflow".to_string())?;
                    let half_up = |unit_price: i64| unit_price.checked_mul(weight_grams).and_then(|value| value.checked_add(500)).map(|value| value / 1000).ok_or_else(|| "Sale amount overflow".to_string());
                    (half_up(original_price)?, half_up(manual_price)?)
                }
                (None, Some(quantity_units)) => {
                    product_unit_type = "UNIT";
                    if quantity_units <= 0 { return Err("Invalid local sale calculation".to_string()); }
                    let multiply = |unit_price: i64| unit_price.checked_mul(quantity_units).ok_or_else(|| "Sale amount overflow".to_string());
                    (multiply(original_price)?, multiply(manual_price)?)
                }
                _ => return Err("A sale item must have exactly one of weightGrams or quantityUnits".to_string()),
            };
            if subtotal != expected_subtotal || subtotal <= 0 || manual_adjustment != subtotal - list_subtotal {
                return Err("Invalid local sale calculation".to_string());
            }
        } else {
            if item.manual_unit_price_cents.is_some() || item.manual_adjustment_cents.is_some() {
                return Err("Manual price metadata without a manual price".to_string());
            }
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
                    if item.sold_as_pack || item.branch_promotion_id.is_some() {
                        // Un solo descuento sobre las unidades REALES de la línea (todas: el Pack con el % de SU versión y la promoción
                        // "desde N" sobre toda la línea), calculado una vez sobre el total de lista y redondeado half-up (espeja
                        // calculateUnitPackLinePricing / calculateBranchPromotionLinePricing y sync_offline_sale_core). Después, el recargo de tarjeta una sola vez sobre el total comercial de la línea.
                        let half_up = |numerator: i64, denominator: i64| numerator.checked_add(denominator / 2).map(|value| value / denominator).ok_or_else(|| "Sale amount overflow".to_string());
                        let unit_discount: i64;
                        if item.sold_as_pack {
                            let pack_count = item.pack_count.ok_or_else(|| "A pack line is missing its pack count".to_string())?;
                            let pack_size = item.pack_size_units_snapshot.ok_or_else(|| "A pack line is missing its pack size".to_string())?;
                            let pack_bps = item.pack_discount_bps.ok_or_else(|| "A pack line is missing its discount".to_string())?;
                            let declared = item.pack_discount_cents.as_deref().ok_or_else(|| "A pack line is missing its discount amount".to_string()).and_then(|value| parse_i64(value, "packDiscountCents"))?;
                            if pack_count < 1 || !(2..=10_000).contains(&pack_size) || pack_count.checked_mul(pack_size) != Some(quantity_units) || !(1..=9_999).contains(&pack_bps) {
                                return Err("Offline pack line is inconsistent".to_string());
                            }
                            // El dispositivo sólo vende el pack (versión y tamaño) que su catálogo local conoce, el mismo que mostró la UI y
                            // que el servidor reconocerá como versión de ESTE producto. Nada se relee del producto actual del servidor.
                            let pack_config_id = item.pack_config_id.as_deref().filter(|id| !id.is_empty()).ok_or_else(|| "A pack line is missing its pack configuration".to_string())?;
                            let local_pack: Option<(i64, Option<String>, i64)> = transaction
                                .query_row("select pack_size_units, pack_config_id, pack_discount_bps from catalog_product_packs where product_id = ?1", params![item.product_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                                .optional()
                                .map_err(|error| error.to_string())?;
                            match local_pack {
                                Some((local_size, _, _)) if local_size != pack_size => return Err("Offline pack size does not match the local catalog".to_string()),
                                // El porcentaje es el de ESA versión (cada producto tiene el suyo y cambia con el tiempo): no se acepta otro.
                                Some((_, Some(local_config), local_bps)) if local_config == pack_config_id => {
                                    if local_bps != pack_bps { return Err("Offline pack discount does not match the local catalog".to_string()); }
                                }
                                _ => return Err("Offline pack configuration does not match the local catalog".to_string()),
                            }
                            unit_discount = half_up(list_subtotal.checked_mul(pack_bps).ok_or_else(|| "Sale amount overflow".to_string())?, 10_000)?;
                            if declared != unit_discount { return Err("Offline pack discount does not match its percentage".to_string()); }
                        } else {
                            let promotion_id = item.branch_promotion_id.as_deref().ok_or_else(|| "Missing branch promotion id".to_string())?;
                            let minimum = item.branch_promotion_minimum_units.ok_or_else(|| "A promotion line is missing its minimum quantity".to_string())?;
                            let bps = item.branch_promotion_discount_bps.ok_or_else(|| "A promotion line is missing its percentage".to_string())?;
                            let discounted_units = item.branch_promotion_discounted_units.ok_or_else(|| "A promotion line is missing its discounted units".to_string())?;
                            let declared = item.branch_promotion_discount_cents.as_deref().ok_or_else(|| "A promotion line is missing its discount amount".to_string()).and_then(|value| parse_i64(value, "branchPromotionDiscountCents"))?;
                            // "Desde N": la línea (un solo producto) llega al mínimo y TODAS sus unidades llevan el descuento.
                            if minimum < 2 || !(1..10_000).contains(&bps) || quantity_units < minimum || discounted_units != quantity_units {
                                return Err("Offline branch promotion line is inconsistent".to_string());
                            }
                            let known: bool = transaction
                                .query_row(
                                    "select exists(select 1 from catalog_branch_promotions where id = ?1 and branch_id = ?2 and minimum_units = ?3 and discount_bps = ?4)",
                                    params![promotion_id, sale.branch_id, minimum, bps], |row| row.get(0),
                                )
                                .map_err(|error| error.to_string())?;
                            if !known { return Err("Offline branch promotion does not match a rule of this branch".to_string()); }
                            // Precedencia: una promoción específica del producto aplicable (pack con al menos un pack completo) manda sobre la de sucursal.
                            let specific_applies: bool = transaction
                                .query_row(
                                    "select exists(select 1 from local_weight_discounts where product_id = ?1 and promotion_mode = 'PACK_FIXED_TOTAL'
                                       and (branch_id is null or branch_id = ?2) and pack_quantity_units is not null and pack_quantity_units <= ?3)",
                                    params![item.product_id, sale.branch_id, quantity_units], |row| row.get(0),
                                )
                                .map_err(|error| error.to_string())?;
                            if specific_applies { return Err("A specific product promotion takes precedence over the branch promotion".to_string()); }
                            unit_discount = half_up(original_price.checked_mul(discounted_units).and_then(|value| value.checked_mul(bps)).ok_or_else(|| "Sale amount overflow".to_string())?, 10_000)?;
                            if declared != unit_discount { return Err("Offline branch promotion discount does not match its percentage".to_string()); }
                        }
                        if promotion_discount_cents != unit_discount || discount_cents != unit_discount {
                            return Err("Invalid local sale calculation".to_string());
                        }
                        cash_subtotal = list_subtotal - unit_discount;
                        if cash_subtotal <= 0 { return Err("Offline unit discount leaves the line at zero".to_string()); }
                        let expected_subtotal = if cash_discount_bps > 0 {
                            half_up(cash_subtotal.checked_mul(10_000 + cash_discount_bps).ok_or_else(|| "Sale amount overflow".to_string())?, 10_000)?
                        } else { cash_subtotal };
                        let expected_price = half_up(subtotal, quantity_units)?;
                        if subtotal != expected_subtotal || price != expected_price {
                            return Err("Offline unit discount line is inconsistent".to_string());
                        }
                    } else if item.promotion_mode.as_deref() == Some("PACK_FIXED_TOTAL") {
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

    // Descuento general del ticket (D-061): se recalcula acá con la misma regla que el servidor (porcentaje en
    // basis points sobre la suma final de las líneas, half-up) y la venta sólo se registra si coincide con
    // lo que declaró el POS. Lo cobrado (total y pago) es la suma de las líneas menos ese descuento.
    let items_subtotal = computed_total;
    if sale.ticket_discount_bps.is_some() != sale.ticket_discount_cents.is_some() {
        return Err("The ticket discount needs both its percentage and its amount".to_string());
    }
    let ticket_discount_bps = sale.ticket_discount_bps.as_deref().map(|value| parse_i64(value, "ticketDiscountBps")).transpose()?.unwrap_or(0);
    let ticket_discount_cents = sale.ticket_discount_cents.as_deref().map(|value| parse_i64(value, "ticketDiscountCents")).transpose()?.unwrap_or(0);
    if sale.ticket_discount_bps.is_some() && !(1..=10_000).contains(&ticket_discount_bps) {
        return Err("The ticket discount percentage is outside 0-100%".to_string());
    }
    let expected_ticket_discount = items_subtotal.checked_mul(ticket_discount_bps).and_then(|value| value.checked_add(5_000)).map(|value| value / 10_000).ok_or_else(|| "Sale amount overflow".to_string())?;
    if ticket_discount_cents != expected_ticket_discount {
        return Err("The ticket discount does not match its percentage".to_string());
    }
    if let Some(declared_subtotal) = sale.subtotal_cents.as_deref() {
        if parse_i64(declared_subtotal, "subtotalCents")? != items_subtotal {
            return Err("The ticket subtotal does not match its items".to_string());
        }
    }
    computed_total = items_subtotal - ticket_discount_cents;
    if computed_total <= 0 {
        return Err("A sale total must be greater than zero".to_string());
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
              total_cents, total_weight_grams, created_at, completed_at, ticket_discount_bps, ticket_discount_cents)
             values (?1, ?2, ?3, ?4, ?5, 'COMPLETED', ?6, ?7, ?8, ?9, ?10, ?11)",
            params![sale.sale_id, sale.organization_id, sale.branch_id, sale.profile_id, sale.device_id,
                    computed_total, computed_weight, sale.created_at, sale.completed_at, ticket_discount_bps, ticket_discount_cents],
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
        let manual_unit_price = item.manual_unit_price_cents.as_deref().map(|value| parse_i64(value, "manualUnitPriceCents")).transpose()?;
        let manual_adjustment = item.manual_adjustment_cents.as_deref().map(|value| parse_i64(value, "manualAdjustmentCents")).transpose()?.unwrap_or(0);
        let pack_discount_cents = item.pack_discount_cents.as_deref().map(|value| parse_i64(value, "packDiscountCents")).transpose()?.unwrap_or(0);
        let promotion_snapshot_cents = item.branch_promotion_discount_cents.as_deref().map(|value| parse_i64(value, "branchPromotionDiscountCents")).transpose()?.unwrap_or(0);
        transaction
            .execute(
                "insert into local_sale_items(id, sale_id, product_id, product_name_snapshot, weight_grams, quantity_units,
                  price_per_kg_cents, original_price_per_kg_cents, discount_rule_id, discount_type, discount_value, discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_cents_snapshot, profit_markup_bps_snapshot, subtotal_cents, promotion_mode, created_at,
                  manual_price_applied, manual_unit_price_cents, manual_adjustment_cents,
                  sold_as_pack, pack_size_units_snapshot, pack_count, pack_discount_bps, pack_discount_cents,
                  branch_promotion_id, branch_promotion_every_units, branch_promotion_discount_bps, branch_promotion_discounted_units, branch_promotion_discount_cents,
                  pack_config_id)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
                         ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35)",
                params![item.id, sale.sale_id, item.product_id, item.product_name_snapshot, item.weight_grams, item.quantity_units,
                        parse_i64(&item.price_per_kg_cents, "pricePerKgCents")?, original_price, item.discount_rule_id, item.discount_type, discount_value, discount_cents, cash_discount_bps, cash_discount_cents, card_surcharge_cents, promotion_discount_cents, cost_snapshot, profit_snapshot, parse_i64(&item.subtotal_cents, "subtotalCents")?, item.promotion_mode, sale.created_at,
                        i64::from(item.manual_price_applied), manual_unit_price, manual_adjustment,
                        i64::from(item.sold_as_pack), item.pack_size_units_snapshot, item.pack_count, item.pack_discount_bps, pack_discount_cents,
                        item.branch_promotion_id, item.branch_promotion_minimum_units, item.branch_promotion_discount_bps, item.branch_promotion_discounted_units, promotion_snapshot_cents,
                        item.pack_config_id],
            )
            .map_err(|error| error.to_string())?;
    }
    // Mercado Pago: sólo se acepta como proveedor sobre TRANSFER (no cambia el pricing ni los
    // métodos elegibles). La venta nace PENDING: ninguna acción local puede marcarla verificada.
    let (provider, verification_status): (Option<&str>, &str) = match sale.payment.provider.as_deref() {
        None => (None, "NOT_REQUIRED"),
        Some("MERCADOPAGO") if sale.payment.method == "TRANSFER" => (Some("MERCADOPAGO"), "PENDING"),
        Some(_) => return Err("Invalid local sale payment provider".to_string()),
    };
    transaction
        .execute(
            "insert into local_payments(id, sale_id, method, amount_cents, created_at, provider, verification_status) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![sale.payment.id, sale.sale_id, sale.payment.method, computed_total, sale.created_at, provider, verification_status],
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
    recent_local_sales(&connection, limit)
}

fn recent_local_sales(connection: &Connection, limit: i64) -> Result<Vec<RecentLocalSale>, String> {
    let safe_limit = limit.clamp(1, 25);
    let mut statement = connection
        .prepare(
            "select s.id, s.status, s.total_cents, s.total_weight_grams, s.completed_at, s.synced_at, p.provider, p.verification_status
             from local_sales s left join local_payments p on p.sale_id = s.id
             order by s.completed_at desc, s.id desc limit ?1",
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
                provider: row.get(6)?,
                verification_status: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingProviderPayment {
    sale_id: String,
    total_cents: String,
    completed_at: String,
    verification_status: String,
}

/// Cobros Mercado Pago que el cajero todavía puede RETOMAR (más recientes primero): sólo los que siguen
/// esperando (`PENDING`) o fallaron técnicamente y se pueden reintentar (`ERROR`). Un cobro terminado
/// (CONFIRMED, CANCELLED, EXPIRED) o que resuelve el administrador (MISMATCH, REFUNDED) NUNCA figura.
/// Es un caché: el servidor decide. `include_stale` también trae los de más de 12 h (para que el POS
/// los reconcilie contra el servidor al arrancar); el aviso de pantalla no los muestra.
#[tauri::command]
fn get_pending_provider_payments(state: State<'_, DatabaseState>, limit: i64, include_stale: bool) -> Result<Vec<PendingProviderPayment>, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    let cutoff: String = if include_stale {
        "0000-01-01T00:00:00Z".to_string()
    } else {
        // Sólo las de las últimas 12 h: el aviso del cajero no puede quedar clavado para siempre.
        connection
            .query_row("select strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-12 hours')", [], |row| row.get(0))
            .map_err(|error| error.to_string())?
    };
    pending_provider_payments(&connection, limit, &cutoff)
}

fn pending_provider_payments(connection: &Connection, limit: i64, completed_since: &str) -> Result<Vec<PendingProviderPayment>, String> {
    let safe_limit = limit.clamp(1, 25);
    let mut statement = connection
        .prepare(
            "select s.id, s.total_cents, s.completed_at, p.verification_status
             from local_payments p join local_sales s on s.id = p.sale_id
             where p.provider = 'MERCADOPAGO' and p.verification_status in ('PENDING', 'ERROR')
               and s.completed_at >= ?2
             order by s.completed_at desc, s.id desc limit ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![safe_limit, completed_since], |row| {
            Ok(PendingProviderPayment {
                sale_id: row.get(0)?,
                total_cents: row.get::<_, i64>(1)?.to_string(),
                completed_at: row.get(2)?,
                verification_status: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

const PROVIDER_VERIFICATION_STATUSES: [&str; 7] = ["PENDING", "CONFIRMED", "EXPIRED", "CANCELLED", "ERROR", "MISMATCH", "REFUNDED"];

/// Refleja localmente el estado que informó el SERVIDOR. Sólo actúa sobre pagos de proveedor, valida
/// el estado y no retrocede: un pago CONFIRMED sólo puede pasar a REFUNDED, y un cobro ya terminado sin
/// acreditación (CANCELLED / EXPIRED / MISMATCH) no vuelve a PENDING/ERROR por una consulta vieja.
fn apply_provider_payment_status(connection: &Connection, sale_id: &str, status: &str) -> Result<bool, String> {
    if !PROVIDER_VERIFICATION_STATUSES.contains(&status) {
        return Err("Invalid payment verification status".to_string());
    }
    let changed = connection
        .execute(
            "update local_payments set verification_status = ?2
             where sale_id = ?1 and provider is not null and verification_status <> ?2
               and (verification_status <> 'CONFIRMED' or ?2 = 'REFUNDED')
               and verification_status <> 'REFUNDED'
               and (?2 not in ('PENDING', 'ERROR') or verification_status in ('PENDING', 'ERROR'))",
            params![sale_id, status],
        )
        .map_err(|error| error.to_string())?;
    Ok(changed > 0)
}

/// Recuerda (por sucursal del dispositivo) si la Transferencia manual está prohibida. Sólo la sucursal
/// de este dispositivo puede fijarla; `allowed = true` la levanta.
fn set_manual_transfer_policy_inner(connection: &mut Connection, branch_id: &str, allowed: bool) -> Result<(), String> {
    let device_branch: Option<String> = connection
        .query_row("select branch_id from local_device where singleton = 1", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if device_branch.as_deref() != Some(branch_id) {
        return Err("The transfer policy is for a different branch than this device".to_string());
    }
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    set_metadata(&transaction, "manual_transfer_blocked_branch", if allowed { "" } else { branch_id }, &now())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_manual_transfer_policy(state: State<'_, DatabaseState>, branch_id: String, allowed: bool) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    set_manual_transfer_policy_inner(&mut connection, &branch_id, allowed)
}

/// Recuerda (por sucursal del dispositivo) si este POS es el de Central (la sucursal productiva que decide el
/// servidor), único donde se admiten el precio manual por línea y el descuento general del ticket (D-061).
/// Sólo la sucursal de este dispositivo puede habilitarse; `enabled = false` lo deshabilita.
fn set_flexible_pricing_branch_inner(connection: &mut Connection, branch_id: &str, enabled: bool) -> Result<(), String> {
    let device_branch: Option<String> = connection
        .query_row("select branch_id from local_device where singleton = 1", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if device_branch.as_deref() != Some(branch_id) {
        return Err("The flexible pricing capability is for a different branch than this device".to_string());
    }
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    set_metadata(&transaction, "flexible_pricing_branch", if enabled { branch_id } else { "" }, &now())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_flexible_pricing_branch(state: State<'_, DatabaseState>, branch_id: String, enabled: bool) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    set_flexible_pricing_branch_inner(&mut connection, &branch_id, enabled)
}

#[tauri::command]
fn set_local_payment_verification(state: State<'_, DatabaseState>, sale_id: String, status: String) -> Result<bool, String> {
    let connection = state.0.lock().map_err(|_| "SQLite lock poisoned".to_string())?;
    apply_provider_payment_status(&connection, &sale_id, &status)
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
            apply_branch_stock,
            get_local_branch_stock,
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
            record_shift_heartbeat_local,
            confirm_local_sale,
            get_recent_local_sales,
            get_pending_provider_payments,
            set_local_payment_verification,
            set_manual_transfer_policy,
            set_flexible_pricing_branch,
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
            scale::detect_scale_port,
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
        assert_eq!(connection.query_row("select count(*) from schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 19);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'discount_cents'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'cash_discount_cents'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'card_surcharge_cents'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'promotion_mode'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_sale_items') where name = 'quantity_units'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_weight_discounts') where name = 'pack_price_cents'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(connection.query_row("select count(*) from pragma_table_info('local_employee_shifts') where name = 'last_heartbeat_at'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
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

        // Now bring the connection up to date — this is where migrations 9 (rebuild), 10 (new
        // card_surcharge_cents column) and 11 (shift heartbeat lease) run.
        initialize_connection(&mut connection).unwrap();

        assert_eq!(connection.query_row("select count(*) from schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 19);
        assert_eq!(connection.query_row("select total_cents from local_sales where id = 'old-sale'", [], |row| row.get::<_, i64>(0)).unwrap(), 123400);
        assert_eq!(connection.query_row("select weight_grams from local_sale_items where id = 'old-item'", [], |row| row.get::<_, i64>(0)).unwrap(), 1000);
        assert_eq!(connection.query_row("select quantity_units from local_sale_items where id = 'old-item'", [], |row| row.get::<_, Option<i64>>(0)).unwrap(), None);
        assert_eq!(connection.query_row("select card_surcharge_cents from local_sale_items where id = 'old-item'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        // 016 (D-061): a sale confirmed before flexible pricing existed keeps no manual price and no ticket discount.
        assert_eq!(connection.query_row("select manual_price_applied from local_sale_items where id = 'old-item'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(connection.query_row("select manual_unit_price_cents is null from local_sale_items where id = 'old-item'", [], |row| row.get::<_, bool>(0)).unwrap(), true);
        assert_eq!(connection.query_row("select ticket_discount_bps from local_sales where id = 'old-sale'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(connection.query_row("select ticket_discount_cents from local_sales where id = 'old-sale'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
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
                cash_discount_bps: Some("1000".into()), cash_discount_cents: Some("0".into()), card_surcharge_cents: Some("137222".into()), promotion_discount_cents: Some("72222".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "1509444".into(), ..Default::default() }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "DEBIT".into(), amount_cents: "1509444".into(), provider: None },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-1000".into(), occurred_at: "2026-09-13T00:00:00Z".into() }], ..Default::default()
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
                cash_discount_bps: Some("0".into()), cash_discount_cents: Some("0".into()), card_surcharge_cents: Some("0".into()), promotion_discount_cents: Some("72222".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "1372222".into(), ..Default::default() }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "CASH".into(), amount_cents: "1372222".into(), provider: None },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-1000".into(), occurred_at: "2026-09-13T00:00:00Z".into() }], ..Default::default()
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
                cash_discount_bps: Some("1000".into()), cash_discount_cents: Some("0".into()), card_surcharge_cents: Some("100000".into()), promotion_discount_cents: Some("0".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "1100000".into(), ..Default::default() }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "CASH".into(), amount_cents: "1100000".into(), provider: None },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-1000".into(), occurred_at: "2026-09-13T00:00:00Z".into() }], ..Default::default()
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
                promotion_discount_cents: Some("2500".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "18000".into(), ..Default::default()
            }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "CASH".into(), amount_cents: "18000".into(), provider: None },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-2050".into(), occurred_at: "2026-09-23T00:00:00Z".into() }], ..Default::default()
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
                cash_discount_bps: Some("1000".into()), cash_discount_cents: Some("0".into()), card_surcharge_cents: Some("90000".into()), promotion_discount_cents: Some("100000".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "990000".into(), ..Default::default() }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "DEBIT".into(), amount_cents: "990000".into(), provider: None },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-1000".into(), occurred_at: "2026-09-24T00:00:00Z".into() }], ..Default::default()
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
            cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: subtotal.to_string(), ..Default::default()
        }
    }

    fn unit_sale_payload(device_id: String, quantity: i64, subtotal: i64, item: OfflineSaleItem) -> OfflineSalePayload {
        OfflineSalePayload {
            schema_version: 1, event_id: Uuid::new_v4().to_string(), sale_id: Uuid::new_v4().to_string(),
            organization_id: "org".into(), branch_id: "branch".into(), profile_id: "profile".into(), operator_token: Some("token".into()), device_id,
            status: "COMPLETED".into(), total_cents: subtotal.to_string(), total_weight_grams: "0".into(),
            created_at: "2026-09-23T00:00:00Z".into(), completed_at: "2026-09-23T00:00:00Z".into(),
            items: vec![item],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "CASH".into(), amount_cents: subtotal.to_string(), provider: None },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "hamburguesa".into(), quantity_grams: (-quantity).to_string(), occurred_at: "2026-09-23T00:00:00Z".into() }], ..Default::default()
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
    fn timekeeping_schema_preserves_migrations_and_separates_two_events() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let first = verifier("1234", "device-one").unwrap();
        assert_eq!(first, verifier("1234", "device-one").unwrap());
        assert_ne!(first, verifier("1234", "device-two").unwrap());
        connection.execute("insert into local_employee_shifts(id,employee_id,branch_id,device_id,clock_in_at,clock_in_source,status,updated_at) values('shift','employee','branch','device','2026-09-13T08:00:00Z','OFFLINE','OPEN','2026-09-13T08:00:00Z')", []).unwrap();
        connection.execute("insert into sync_outbox(id,aggregate_type,aggregate_id,operation,payload,status,created_at,next_attempt_at) values('in','SHIFT','shift','EVENT','{}','PENDING','2026-09-13T08:00:00Z','2026-09-13T08:00:00Z')", []).unwrap();
        connection.execute("insert into sync_outbox(id,aggregate_type,aggregate_id,operation,payload,status,created_at,next_attempt_at) values('out','SHIFT','shift','EVENT','{}','PENDING','2026-09-13T15:30:00Z','2026-09-13T15:30:00Z')", []).unwrap();
        initialize_connection(&mut connection).unwrap();
        // No local_pos_operators row exists for 'employee' here, so restart reconciliation
        // (see reconcile_stale_open_shifts) has no cached token to synthesize a sync event
        // with — it still closes the orphaned local row (falling back to clock_in_at, since
        // no heartbeat was ever recorded) so it doesn't silently stay "open" forever, but adds
        // no new outbox event. Migrations aren't replayed either: still exactly the two
        // pre-existing SHIFT events.
        assert_eq!(connection.query_row("select count(*) from local_employee_shifts where clock_out_at is null", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        let (status, clock_out_at): (String, Option<String>) = connection.query_row(
            "select status, clock_out_at from local_employee_shifts where id='shift'", [], |row| Ok((row.get(0)?, row.get(1)?))
        ).unwrap();
        assert_eq!(status, "REQUIRES_REVIEW");
        assert_eq!(clock_out_at.as_deref(), Some("2026-09-13T08:00:00Z"));
        assert_eq!(connection.query_row("select count(*) from sync_outbox where aggregate_type='SHIFT'", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn heartbeat_updates_last_heartbeat_at_for_the_active_operators_open_shift() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let timestamp = now();
        connection.execute("update local_device set organization_id='org',branch_id='branch',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('employee','Fede','Operador',1,1,0,'token','2099-01-01T00:00:00Z',?1)", [&timestamp]).unwrap();
        connection.execute("insert into local_active_operator(singleton,profile_id,selected_at) values(1,'employee',?1)", [&timestamp]).unwrap();
        connection.execute("insert into local_employee_shifts(id,employee_id,branch_id,device_id,clock_in_at,clock_in_source,status,updated_at) select 'shift','employee','branch',device_id,?1,'ONLINE','OPEN',?1 from local_device where singleton=1", [&timestamp]).unwrap();

        assert!(connection.query_row("select last_heartbeat_at from local_employee_shifts where id='shift'", [], |row| row.get::<_, Option<String>>(0)).unwrap().is_none());
        let heartbeat_at = record_shift_heartbeat_local_in_connection(&connection).unwrap();
        assert!(heartbeat_at.is_some());
        assert_eq!(connection.query_row("select last_heartbeat_at from local_employee_shifts where id='shift'", [], |row| row.get::<_, Option<String>>(0)).unwrap(), heartbeat_at);
    }

    #[test]
    fn heartbeat_is_a_noop_without_an_active_operator() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        assert_eq!(record_shift_heartbeat_local_in_connection(&connection).unwrap(), None);
    }

    #[test]
    fn reconcile_stale_open_shifts_closes_orphaned_shift_using_last_heartbeat() {
        // The scenario this whole feature exists for: Task Manager kill / forced shutdown /
        // power loss never delivers CloseRequested, so the shift is still OPEN when the app
        // starts again. The last locally-recorded heartbeat — not "now" — is the honest
        // evidence of when it actually ended (docs/DOMAIN_RULES.md "Control horario").
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let clock_in_at = "2026-09-28T08:00:00Z";
        let last_heartbeat = "2026-09-28T10:15:00Z";
        connection.execute("update local_device set organization_id='org',branch_id='branch',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('employee','Fede','Operador',1,1,0,'token','2099-01-01T00:00:00Z',?1)", [clock_in_at]).unwrap();
        // A crash never runs close_authenticated_operator_session, so local_active_operator is
        // left behind exactly like this.
        connection.execute("insert into local_active_operator(singleton,profile_id,selected_at) values(1,'employee',?1)", [clock_in_at]).unwrap();
        connection.execute(
            "insert into local_employee_shifts(id,employee_id,branch_id,device_id,clock_in_at,clock_in_source,status,last_heartbeat_at,updated_at) select 'shift','employee','branch',device_id,?1,'ONLINE','OPEN',?2,?1 from local_device where singleton=1",
            params![clock_in_at, last_heartbeat],
        ).unwrap();

        reconcile_stale_open_shifts(&mut connection).unwrap();

        let (status, clock_out_at): (String, Option<String>) = connection.query_row(
            "select status, clock_out_at from local_employee_shifts where id='shift'", [], |row| Ok((row.get(0)?, row.get(1)?))
        ).unwrap();
        assert_eq!(status, "REQUIRES_REVIEW");
        assert_eq!(clock_out_at.as_deref(), Some(last_heartbeat));
        let (occurred_at, inferred): (String, i64) = connection.query_row(
            "select json_extract(payload,'$.occurredAt'), json_extract(payload,'$.inferred') from sync_outbox where aggregate_type='SHIFT' and json_extract(payload,'$.action')='CLOCK_OUT'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        // Never invents time up to "now"/reconnection — the outbox event carries the exact
        // last-known heartbeat.
        assert_eq!(occurred_at, last_heartbeat);
        assert_eq!(inferred, 1);
        // The employee isn't blocked from clocking in again: the row is no longer "open".
        assert_eq!(connection.query_row("select count(*) from local_employee_shifts where employee_id='employee' and clock_out_at is null", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn reconcile_stale_open_shifts_falls_back_to_clock_in_at_without_a_heartbeat() {
        // Died before ever sending a heartbeat (e.g. within the first 30s): the only honest
        // evidence left is the clock-in itself, never "now".
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let clock_in_at = "2026-09-28T08:00:00Z";
        connection.execute("update local_device set organization_id='org',branch_id='branch',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('employee','Fede','Operador',1,1,0,'token','2099-01-01T00:00:00Z',?1)", [clock_in_at]).unwrap();
        connection.execute("insert into local_employee_shifts(id,employee_id,branch_id,device_id,clock_in_at,clock_in_source,status,updated_at) select 'shift','employee','branch',device_id,?1,'ONLINE','OPEN',?1 from local_device where singleton=1", [clock_in_at]).unwrap();

        reconcile_stale_open_shifts(&mut connection).unwrap();

        assert_eq!(connection.query_row("select clock_out_at from local_employee_shifts where id='shift'", [], |row| row.get::<_, Option<String>>(0)).unwrap().as_deref(), Some(clock_in_at));
    }

    #[test]
    fn reconcile_stale_open_shifts_is_a_noop_when_nothing_is_open() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        reconcile_stale_open_shifts(&mut connection).unwrap();
        assert_eq!(connection.query_row("select count(*) from sync_outbox where aggregate_type='SHIFT'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
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

    fn branch_stock_fixture() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        connection.execute("update local_device set organization_id='org',branch_id='branch',device_status='ACTIVE'", []).unwrap();
        // Stock movements reference a sale row by FK; these tests only care about the movement rows.
        connection.execute_batch("pragma foreign_keys = off;").unwrap();
        connection
    }

    fn snapshot(items: &[(&str, &str)]) -> BranchStockSnapshot {
        BranchStockSnapshot {
            branch_id: "branch".into(),
            items: items.iter().map(|(product_id, grams)| BranchStockSnapshotItem { product_id: (*product_id).into(), quantity_grams: (*grams).into() }).collect(),
        }
    }

    fn stock_of(stock: &LocalBranchStock, product_id: &str) -> Option<i64> {
        stock.items.iter().find(|item| item.product_id == product_id).map(|item| item.quantity_grams)
    }

    fn insert_movement(connection: &Connection, id: &str, product_id: &str, grams: i64, synced_at: Option<&str>) {
        connection
            .execute(
                "insert into local_stock_movements(id,sale_id,organization_id,branch_id,product_id,movement_type,quantity_grams,profile_id,occurred_at,created_at,synced_at)
                 values(?1,'sale','org','branch',?2,'SALE',?3,'profile','2026-09-30T00:00:00Z','2026-09-30T00:00:00Z',?4)",
                params![id, product_id, grams, synced_at],
            )
            .unwrap();
    }

    #[test]
    fn branch_stock_is_unknown_until_the_first_snapshot_is_applied() {
        let connection = branch_stock_fixture();
        let stock = local_branch_stock_inner(&connection, "branch").unwrap();
        assert!(!stock.snapshot_applied);
        assert!(stock.items.is_empty());
    }

    #[test]
    fn branch_stock_snapshot_keeps_the_exact_signed_fractional_values() {
        let mut connection = branch_stock_fixture();
        apply_branch_stock_inner(&mut connection, &snapshot(&[("vacio", "8000"), ("peceto", "0"), ("bondiola", "-1000"), ("costilla", "10"), ("asado", "1350")])).unwrap();
        let stock = local_branch_stock_inner(&connection, "branch").unwrap();
        assert!(stock.snapshot_applied);
        assert_eq!(stock_of(&stock, "vacio"), Some(8000));
        assert_eq!(stock_of(&stock, "peceto"), Some(0));
        assert_eq!(stock_of(&stock, "bondiola"), Some(-1000));
        assert_eq!(stock_of(&stock, "costilla"), Some(10));
        assert_eq!(stock_of(&stock, "asado"), Some(1350));
        // A product with no row is simply absent; the UI reads absence as zero once a snapshot exists.
        assert_eq!(stock_of(&stock, "sin-movimientos"), None);
    }

    #[test]
    fn a_new_snapshot_replaces_the_previous_one_so_restocked_products_become_available() {
        let mut connection = branch_stock_fixture();
        apply_branch_stock_inner(&mut connection, &snapshot(&[("vacio", "0"), ("asado", "5000")])).unwrap();
        // Reposición +10 kg for vacio; asado vanished from the ledger sum payload entirely.
        apply_branch_stock_inner(&mut connection, &snapshot(&[("vacio", "10000")])).unwrap();
        let stock = local_branch_stock_inner(&connection, "branch").unwrap();
        assert_eq!(stock_of(&stock, "vacio"), Some(10000));
        assert_eq!(stock_of(&stock, "asado"), None);
    }

    #[test]
    fn a_pending_local_sale_reduces_stock_until_the_server_snapshot_includes_it() {
        let mut connection = branch_stock_fixture();
        apply_branch_stock_inner(&mut connection, &snapshot(&[("vacio", "1000")])).unwrap();
        // Sold 1 kg offline, not synced yet: stock must already read 0 (positive -> 0 transition).
        insert_movement(&connection, "m1", "vacio", -1000, None);
        assert_eq!(stock_of(&local_branch_stock_inner(&connection, "branch").unwrap(), "vacio"), Some(0));
        // A product only ever sold locally (no snapshot row) also goes through the adjustment.
        insert_movement(&connection, "m2", "nuevo", -250, None);
        assert_eq!(stock_of(&local_branch_stock_inner(&connection, "branch").unwrap(), "nuevo"), Some(-250));
    }

    #[test]
    fn sales_synced_before_the_snapshot_are_not_subtracted_twice_but_later_ones_are() {
        let mut connection = branch_stock_fixture();
        // Synced well before the snapshot is applied: the server sum already includes it.
        insert_movement(&connection, "old", "vacio", -500, Some("2000-01-01T00:00:00.000Z"));
        apply_branch_stock_inner(&mut connection, &snapshot(&[("vacio", "4500")])).unwrap();
        assert_eq!(stock_of(&local_branch_stock_inner(&connection, "branch").unwrap(), "vacio"), Some(4500));
        // Synced after the snapshot was applied (mixed fractional widths on purpose): the snapshot predates it.
        insert_movement(&connection, "late", "vacio", -500, Some("2999-01-01T00:00:00.5Z"));
        assert_eq!(stock_of(&local_branch_stock_inner(&connection, "branch").unwrap(), "vacio"), Some(4000));
    }

    #[test]
    fn a_snapshot_for_another_branch_is_rejected() {
        let mut connection = branch_stock_fixture();
        let mut foreign = snapshot(&[("vacio", "1000")]);
        foreign.branch_id = "other-branch".into();
        assert!(apply_branch_stock_inner(&mut connection, &foreign).is_err());
        assert!(!local_branch_stock_inner(&connection, "branch").unwrap().snapshot_applied);
    }
    // ---- barcodes / assortment in the offline catalog --------------------------------------------

    fn catalog_row(product_id: &str, name: &str, unit_type: &str, barcodes: &[&str]) -> CatalogPullRow {
        CatalogPullRow {
            organization_id: "org".into(),
            branch_id: "central".into(),
            branch_name: "Central".into(),
            category_id: "cat".into(),
            category_name: "Almacen".into(),
            category_color_hex: None,
            category_sort_order: 0,
            category_active: true,
            category_ids: vec!["cat".into()],
            product_id: product_id.into(),
            product_name: name.into(),
            product_sku: None,
            unit_type: unit_type.into(),
            product_active: true,
            price_per_kg_cents: "450000".into(),
            price_valid_from: "2026-09-30T00:00:00Z".into(),
            barcodes: barcodes.iter().map(|code| (*code).to_string()).collect(),
            pack_size_units: None,
            pack_config_id: None,
            pack_discount_bps: None,
        }
    }

    fn pull(catalog: Vec<CatalogPullRow>, removed: &[&str]) -> CatalogPullPayload {
        CatalogPullPayload {
            cursor: 1,
            server_time: "2026-09-30T00:00:00Z".into(),
            authorization_expires_at: "2026-10-01T00:00:00Z".into(),
            organization_id: "org".into(),
            branch_id: "central".into(),
            branch_name: "Central".into(),
            device_status: "ACTIVE".into(),
            role_name: "admin".into(),
            catalog,
            removed_product_ids: removed.iter().map(|id| (*id).to_string()).collect(),
            categories: vec![CatalogDirectoryCategory { id: "cat".into(), name: "Almacen".into(), color_hex: None, sort_order: 0 }],
            branch_promotions_from_minimum: None,
        }
    }

    fn catalog_fixture() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        connection
    }

    fn barcodes_of(connection: &Connection, product_id: &str) -> Vec<String> {
        local_catalog_inner(connection, "central")
            .unwrap()
            .into_iter()
            .find(|row| row.product_id == product_id)
            .map(|row| row.barcodes)
            .unwrap_or_default()
    }

    #[test]
    fn catalog_pull_stores_barcodes_locally_and_the_local_catalog_returns_them() {
        let mut connection = catalog_fixture();
        apply_catalog_pull_inner(
            &mut connection,
            &pull(vec![
                catalog_row("coca", "Coca Cola 2.25 L", "UNIT", &["7790895000010", "7790895000027"]),
                catalog_row("vacio", "Vacio", "WEIGHT", &[]),
            ], &[]),
            "profile", "admin@example.test",
        ).unwrap();
        // Everything a scan needs is now in SQLite: no server call is involved from here on.
        assert_eq!(barcodes_of(&connection, "coca"), vec!["7790895000010".to_string(), "7790895000027".to_string()]);
        assert!(barcodes_of(&connection, "vacio").is_empty());
        let catalog = local_catalog_inner(&connection, "central").unwrap();
        assert_eq!(catalog.iter().find(|row| row.product_id == "coca").unwrap().unit_type, "UNIT");
        assert_eq!(catalog.iter().find(|row| row.product_id == "vacio").unwrap().unit_type, "WEIGHT");
    }

    #[test]
    fn a_product_that_leaves_the_branch_assortment_stops_being_in_the_local_catalog_and_its_barcodes_go() {
        let mut connection = catalog_fixture();
        apply_catalog_pull_inner(&mut connection, &pull(vec![catalog_row("coca", "Coca Cola 2.25 L", "UNIT", &["7790895000010"])], &[]), "profile", "admin@example.test").unwrap();
        assert!(!barcodes_of(&connection, "coca").is_empty());

        // The server disables the product for this branch: it arrives in removedProductIds.
        apply_catalog_pull_inner(&mut connection, &pull(vec![], &["coca"]), "profile", "admin@example.test").unwrap();
        assert!(local_catalog_inner(&connection, "central").unwrap().iter().all(|row| row.product_id != "coca"));
        assert_eq!(connection.query_row("select count(*) from catalog_product_barcodes", [], |row| row.get::<_, i64>(0)).unwrap(), 0);

        // Enabled again later: the pull that re-sends the product re-sends its barcodes.
        apply_catalog_pull_inner(&mut connection, &pull(vec![catalog_row("coca", "Coca Cola 2.25 L", "UNIT", &["7790895000010"])], &[]), "profile", "admin@example.test").unwrap();
        assert_eq!(barcodes_of(&connection, "coca"), vec!["7790895000010".to_string()]);
    }

    #[test]
    fn an_incremental_pull_replaces_the_barcode_set_of_the_changed_product_only() {
        let mut connection = catalog_fixture();
        apply_catalog_pull_inner(&mut connection, &pull(vec![
            catalog_row("coca", "Coca Cola 2.25 L", "UNIT", &["7790895000010", "7790895000027"]),
            catalog_row("agua", "Agua 500 cc", "UNIT", &["7791111111111"]),
        ], &[]), "profile", "admin@example.test").unwrap();
        // Only Coca changed on the server: one barcode was removed, another added.
        apply_catalog_pull_inner(&mut connection, &pull(vec![catalog_row("coca", "Coca Cola 2.25 L", "UNIT", &["7790895000010", "7790895000034"])], &[]), "profile", "admin@example.test").unwrap();
        assert_eq!(barcodes_of(&connection, "coca"), vec!["7790895000010".to_string(), "7790895000034".to_string()]);
        assert_eq!(barcodes_of(&connection, "agua"), vec!["7791111111111".to_string()]);
    }

    #[test]
    fn a_barcode_that_moves_to_another_product_is_repointed_not_duplicated() {
        let mut connection = catalog_fixture();
        apply_catalog_pull_inner(&mut connection, &pull(vec![catalog_row("coca", "Coca Cola 2.25 L", "UNIT", &["7790895000010"])], &[]), "profile", "admin@example.test").unwrap();
        apply_catalog_pull_inner(&mut connection, &pull(vec![catalog_row("coca-light", "Coca Cola Light 2.25 L", "UNIT", &["7790895000010"])], &[]), "profile", "admin@example.test").unwrap();
        assert_eq!(barcodes_of(&connection, "coca-light"), vec!["7790895000010".to_string()]);
        assert_eq!(connection.query_row("select count(*) from catalog_product_barcodes where barcode = '7790895000010'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn a_pull_from_an_older_server_without_barcodes_still_applies() {
        // `barcodes` is #[serde(default)]: a payload that predates the field must deserialize.
        let payload = serde_json::json!({
            "cursor": 1, "serverTime": "2026-09-30T00:00:00Z", "authorizationExpiresAt": "2026-10-01T00:00:00Z",
            "organizationId": "org", "branchId": "central", "branchName": "Central", "deviceStatus": "ACTIVE", "roleName": "admin",
            "catalog": [{
                "organizationId": "org", "branchId": "central", "branchName": "Central", "categoryId": "cat", "categoryName": "Almacen",
                "categoryColorHex": null, "categorySortOrder": 0, "categoryActive": true, "categoryIds": ["cat"],
                "productId": "vacio", "productName": "Vacio", "productSku": null, "unitType": "WEIGHT", "productActive": true,
                "pricePerKgCents": "1200000", "priceValidFrom": "2026-09-30T00:00:00Z"
            }],
            "removedProductIds": [],
            "categories": [{ "id": "cat", "name": "Almacen", "colorHex": null, "sortOrder": 0 }]
        });
        let parsed: CatalogPullPayload = serde_json::from_value(payload).unwrap();
        let mut connection = catalog_fixture();
        apply_catalog_pull_inner(&mut connection, &parsed, "profile", "admin@example.test").unwrap();
        assert!(barcodes_of(&connection, "vacio").is_empty());
        assert_eq!(local_catalog_inner(&connection, "central").unwrap().len(), 1);
    }

    // ---- Mercado Pago (D-054): la venta se declara con provider y nace PENDING ------------------
    fn mercadopago_payload(device_id: String, method: &str, provider: Option<&str>) -> OfflineSalePayload {
        let mut sale = unit_sale_payload(device_id, 3, 2400, unit_sale_item(3, 2400, 0, 0, None));
        sale.payment.method = method.into();
        sale.payment.provider = provider.map(|value| value.to_string());
        sale
    }

    #[test]
    fn mercadopago_sale_is_stored_pending_priced_like_transfer_and_never_confirmed_locally() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        let sale = mercadopago_payload(device_id, "TRANSFER", Some("MERCADOPAGO"));
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select provider from local_payments", [], |row| row.get::<_, Option<String>>(0)).unwrap().as_deref(), Some("MERCADOPAGO"));
        assert_eq!(connection.query_row("select verification_status from local_payments", [], |row| row.get::<_, String>(0)).unwrap(), "PENDING");
        assert_eq!(connection.query_row("select method from local_payments", [], |row| row.get::<_, String>(0)).unwrap(), "TRANSFER");
        // Same price as CASH/TRANSFER: no card surcharge, no discount (pricing is untouched).
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 2400);
        assert_eq!(connection.query_row("select card_surcharge_cents from local_sale_items", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn a_manual_sale_stays_unverified_not_required() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        let sale = mercadopago_payload(device_id, "TRANSFER", None);
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(connection.query_row("select verification_status from local_payments", [], |row| row.get::<_, String>(0)).unwrap(), "NOT_REQUIRED");
        assert_eq!(connection.query_row("select provider is null from local_payments", [], |row| row.get::<_, bool>(0)).unwrap(), true);
        assert!(pending_provider_payments(&connection, 10, "0000").unwrap().is_empty());
    }

    #[test]
    fn a_provider_is_only_accepted_on_transfer_and_only_mercadopago() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        for (method, provider) in [("CASH", "MERCADOPAGO"), ("DEBIT", "MERCADOPAGO"), ("TRANSFER", "OTHERPAY")] {
            let sale = mercadopago_payload(device_id.clone(), method, Some(provider));
            let transaction = connection.transaction().unwrap();
            let error = insert_sale(&transaction, &sale).unwrap_err();
            assert_eq!(error, "Invalid local sale payment provider");
            drop(transaction);
        }
        assert_eq!(connection.query_row("select count(*) from local_payments", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn the_outbox_payload_only_carries_the_provider_when_there_is_one() {
        let manual = serde_json::to_value(&mercadopago_payload("device".into(), "CASH", None)).unwrap();
        assert!(manual["payment"].get("provider").is_none(), "a normal sale payload must stay byte-compatible");
        let mercadopago = serde_json::to_value(&mercadopago_payload("device".into(), "TRANSFER", Some("MERCADOPAGO"))).unwrap();
        assert_eq!(mercadopago["payment"]["provider"], "MERCADOPAGO");
        let roundtrip: OfflineSalePayload = serde_json::from_value(mercadopago).unwrap();
        assert_eq!(roundtrip.payment.provider.as_deref(), Some("MERCADOPAGO"));
    }

    #[test]
    fn local_provider_status_mirrors_the_server_and_never_regresses_a_confirmation() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        let sale = mercadopago_payload(device_id, "TRANSFER", Some("MERCADOPAGO"));
        let sale_id = sale.sale_id.clone();
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        let status = |connection: &Connection| connection.query_row("select verification_status from local_payments", [], |row| row.get::<_, String>(0)).unwrap();

        assert_eq!(pending_provider_payments(&connection, 10, "0000").unwrap().len(), 1, "an unconfirmed Mercado Pago sale is listed as pending");
        assert!(apply_provider_payment_status(&connection, &sale_id, "EXPIRED").unwrap());
        assert_eq!(status(&connection), "EXPIRED");
        assert!(apply_provider_payment_status(&connection, &sale_id, "CONFIRMED").unwrap(), "a late accreditation is accepted");
        assert!(!apply_provider_payment_status(&connection, &sale_id, "EXPIRED").unwrap(), "a confirmation is never undone by an older state");
        assert!(!apply_provider_payment_status(&connection, &sale_id, "PENDING").unwrap());
        assert_eq!(status(&connection), "CONFIRMED");
        assert!(pending_provider_payments(&connection, 10, "0000").unwrap().is_empty(), "confirmed sales are not pending any more");
        assert!(apply_provider_payment_status(&connection, &sale_id, "REFUNDED").unwrap());
        assert!(!apply_provider_payment_status(&connection, &sale_id, "CONFIRMED").unwrap(), "a refund is final");
        assert!(apply_provider_payment_status(&connection, &sale_id, "NOT_REQUIRED").is_err(), "unknown statuses are rejected");
        assert!(apply_provider_payment_status(&connection, &sale_id, "CONFIRMED ").is_err());
    }

    #[test]
    fn the_cashier_reminder_ignores_sales_older_than_the_cutoff() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        let sale = mercadopago_payload(device_id, "TRANSFER", Some("MERCADOPAGO"));
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        // The fixture sale is dated 2026-09-23.
        assert_eq!(pending_provider_payments(&connection, 10, "2026-09-23T00:00:00Z").unwrap().len(), 1);
        assert!(pending_provider_payments(&connection, 10, "2026-09-24T00:00:00Z").unwrap().is_empty());
    }

    #[test]
    fn local_provider_status_cannot_be_applied_to_a_manual_payment() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        let sale = mercadopago_payload(device_id, "TRANSFER", None);
        let sale_id = sale.sale_id.clone();
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert!(!apply_provider_payment_status(&connection, &sale_id, "CONFIRMED").unwrap());
        assert_eq!(connection.query_row("select verification_status from local_payments", [], |row| row.get::<_, String>(0)).unwrap(), "NOT_REQUIRED");
    }

    #[test]
    fn payment_verification_migration_preserves_existing_payments() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        // Simulate a pre-014 install: drop the new columns' effect by checking an old-style insert still works.
        connection.execute("insert into local_sales(id, organization_id, branch_id, profile_id, device_id, status, total_cents, total_weight_grams, created_at, completed_at) values('s','org','branch','profile','device','COMPLETED',100,1,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')", []).unwrap();
        connection.execute("insert into local_payments(id, sale_id, method, amount_cents, created_at) values('p','s','CASH',100,'2026-09-30T00:00:00Z')", []).unwrap();
        assert_eq!(connection.query_row("select verification_status from local_payments where id='p'", [], |row| row.get::<_, String>(0)).unwrap(), "NOT_REQUIRED");
        assert!(connection.query_row("select provider is null from local_payments where id='p'", [], |row| row.get::<_, bool>(0)).unwrap());
    }

    // ---- Mercado Pago (D-055): el ciclo de vida de la venta en la caja ---------------------------
    fn pending_mercadopago_sale(connection: &mut Connection, device_id: &str, quantity: i64) -> String {
        let mut sale = unit_sale_payload(device_id.to_string(), quantity, 800 * quantity, unit_sale_item(quantity, 800 * quantity, 0, 0, None));
        sale.payment.method = "TRANSFER".into();
        sale.payment.provider = Some("MERCADOPAGO".into());
        let sale_id = sale.sale_id.clone();
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        sale_id
    }

    #[test]
    fn mp_pending_chip_lists_only_charges_the_cashier_can_resume() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        let mut expected_listed = Vec::new();
        for status in ["PENDING", "ERROR", "EXPIRED", "CANCELLED", "CONFIRMED", "MISMATCH", "REFUNDED"] {
            let sale_id = pending_mercadopago_sale(&mut connection, &device_id, 1);
            if status != "PENDING" {
                apply_provider_payment_status(&connection, &sale_id, status).unwrap();
            }
            if status == "PENDING" || status == "ERROR" {
                expected_listed.push(sale_id);
            }
        }
        let mut listed: Vec<String> = pending_provider_payments(&connection, 25, "0000").unwrap().into_iter().map(|payment| payment.sale_id).collect();
        listed.sort();
        expected_listed.sort();
        assert_eq!(listed, expected_listed, "only PENDING and ERROR are recoverable: CONFIRMED / CANCELLED / EXPIRED / MISMATCH / REFUNDED never are");
    }

    #[test]
    fn closing_the_panel_keeps_a_pending_charge_but_a_cancellation_removes_it_for_good() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        let sale_id = pending_mercadopago_sale(&mut connection, &device_id, 2);
        // Closing the modal changes nothing locally: the charge is still pending and listed.
        assert_eq!(pending_provider_payments(&connection, 10, "0000").unwrap().len(), 1);
        assert_eq!(pending_provider_payments(&connection, 10, "0000").unwrap().len(), 1);
        // The backend reports the cancellation: it is gone and never comes back (not even by a stale PENDING).
        assert!(apply_provider_payment_status(&connection, &sale_id, "CANCELLED").unwrap());
        assert!(pending_provider_payments(&connection, 10, "0000").unwrap().is_empty());
        assert!(!apply_provider_payment_status(&connection, &sale_id, "PENDING").unwrap(), "a stale poll can never bring a finished charge back to PENDING");
        assert!(!apply_provider_payment_status(&connection, &sale_id, "ERROR").unwrap());
        assert!(pending_provider_payments(&connection, 10, "0000").unwrap().is_empty());
    }

    #[test]
    fn an_unaccredited_mercadopago_sale_does_not_hold_local_stock_and_returns_it_exactly_once() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        apply_branch_stock_inner(&mut connection, &snapshot(&[("hamburguesa", "10")])).unwrap();
        let stock = |connection: &Connection| stock_of(&local_branch_stock_inner(connection, "branch").unwrap(), "hamburguesa");

        let sale_id = pending_mercadopago_sale(&mut connection, &device_id, 3);
        assert_eq!(stock(&connection), Some(7), "while pending the stock is reserved");

        apply_provider_payment_status(&connection, &sale_id, "CANCELLED").unwrap();
        assert_eq!(stock(&connection), Some(10), "a cancelled charge gives the stock back");
        apply_provider_payment_status(&connection, &sale_id, "CANCELLED").unwrap();
        apply_provider_payment_status(&connection, &sale_id, "EXPIRED").unwrap();
        assert_eq!(stock(&connection), Some(10), "repeating or re-reporting the cancellation never restores it twice");

        let paid = pending_mercadopago_sale(&mut connection, &device_id, 2);
        assert_eq!(stock(&connection), Some(8));
        apply_provider_payment_status(&connection, &paid, "CONFIRMED").unwrap();
        assert_eq!(stock(&connection), Some(8), "a confirmed payment keeps the stock deducted");
        apply_provider_payment_status(&connection, &paid, "CANCELLED").unwrap();
        assert_eq!(stock(&connection), Some(8), "and a confirmation never regresses");

        let expired = pending_mercadopago_sale(&mut connection, &device_id, 4);
        assert_eq!(stock(&connection), Some(4));
        apply_provider_payment_status(&connection, &expired, "EXPIRED").unwrap();
        assert_eq!(stock(&connection), Some(8), "an expired charge gives its stock back too");
    }

    #[test]
    fn a_cash_sale_always_holds_its_stock() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        apply_branch_stock_inner(&mut connection, &snapshot(&[("hamburguesa", "10")])).unwrap();
        let sale = unit_sale_payload(device_id, 3, 2400, unit_sale_item(3, 2400, 0, 0, None));
        let transaction = connection.transaction().unwrap();
        insert_sale(&transaction, &sale).unwrap();
        transaction.commit().unwrap();
        assert_eq!(stock_of(&local_branch_stock_inner(&connection, "branch").unwrap(), "hamburguesa"), Some(7));
    }

    #[test]
    fn manual_transfer_is_refused_where_mercadopago_is_required_and_everything_else_still_sells() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        let attempt = |connection: &mut Connection, method: &str, provider: Option<&str>| -> Result<(), String> {
            let sale = mercadopago_payload(device_id.clone(), method, provider);
            let transaction = connection.transaction().unwrap();
            let result = insert_sale(&transaction, &sale);
            if result.is_ok() { transaction.commit().unwrap(); }
            result
        };
        // Without any policy (Central, or not learned yet) a manual transfer works as always.
        assert!(attempt(&mut connection, "TRANSFER", None).is_ok());

        set_manual_transfer_policy_inner(&mut connection, "branch", false).unwrap();
        let blocked = attempt(&mut connection, "TRANSFER", None).unwrap_err();
        assert!(blocked.starts_with("MANUAL_TRANSFER_NOT_ALLOWED"), "{blocked}");
        assert!(attempt(&mut connection, "TRANSFER", Some("MERCADOPAGO")).is_ok(), "Mercado Pago is the legitimate digital method");
        assert!(attempt(&mut connection, "CASH", None).is_ok(), "cash is untouched");
        let blocked_count: i64 = connection.query_row("select count(*) from local_sales", [], |row| row.get(0)).unwrap();
        assert_eq!(blocked_count, 3, "the refused sale was not stored: manual + Mercado Pago + cash");

        // The rule is lifted the moment the server says so.
        set_manual_transfer_policy_inner(&mut connection, "branch", true).unwrap();
        assert!(attempt(&mut connection, "TRANSFER", None).is_ok());
    }

    #[test]
    fn the_transfer_policy_only_applies_to_the_branch_of_this_device() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let _device_id = unit_sale_device(&connection);
        assert!(set_manual_transfer_policy_inner(&mut connection, "another-branch", false).is_err());
        assert_eq!(metadata(&connection, "manual_transfer_blocked_branch").unwrap(), None);
        set_manual_transfer_policy_inner(&mut connection, "branch", false).unwrap();
        assert_eq!(metadata(&connection, "manual_transfer_blocked_branch").unwrap().as_deref(), Some("branch"));
    }

    #[test]
    fn recent_sales_report_the_payment_provider_and_verification() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        let sale_id = pending_mercadopago_sale(&mut connection, &device_id, 1);
        apply_provider_payment_status(&connection, &sale_id, "CANCELLED").unwrap();
        let recent = recent_local_sales(&connection, 10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].provider.as_deref(), Some("MERCADOPAGO"));
        assert_eq!(recent[0].verification_status.as_deref(), Some("CANCELLED"));
    }

    // ---- products without price (Central, SimplyGest price 0) --------------------------------------

    #[test]
    fn zero_price_migration_keeps_existing_prices_and_relaxes_only_the_check() {
        // Real upgrade scenario: a device already synced prices under the old `check (> 0)`.
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("pragma foreign_keys = on;").unwrap();
        connection.execute_batch(INITIAL_SCHEMA).unwrap();
        connection.execute("insert into catalog_categories(id,organization_id,name,sort_order,active,updated_at) values('cat','org','Almacen',0,1,'2026-09-30T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_products values('coca','org','cat','Coca Cola',null,'UNIT',1,'2026-09-30T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_prices values('coca','central',350000,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')", []).unwrap();
        // Before: a zero price is rejected by the old schema.
        assert!(connection.execute("insert into catalog_prices values('coca','other',0,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')", []).is_err());

        let transaction = connection.transaction().unwrap();
        transaction.execute_batch(CATALOG_ZERO_PRICE_SCHEMA).unwrap();
        transaction.commit().unwrap();

        assert_eq!(connection.query_row("select price_per_kg_cents from catalog_prices where product_id='coca' and branch_id='central'", [], |row| row.get::<_, i64>(0)).unwrap(), 350000);
        // After: 0 is accepted, a negative price is still impossible, and the FK to the product stays.
        connection.execute("insert into catalog_prices values('coca','other',0,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')", []).unwrap();
        assert!(connection.execute("insert into catalog_prices values('coca','neg',-1,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')", []).is_err());
        assert!(connection.execute("insert into catalog_prices values('ghost','central',100,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')", []).is_err());
    }

    #[test]
    fn a_catalog_pull_with_a_zero_price_product_is_stored_and_listed() {
        let mut connection = catalog_fixture();
        let mut priceless = catalog_row("galletitas", "GALLETITAS X", "UNIT", &["7791234000001"]);
        priceless.price_per_kg_cents = "0".into();
        let coca = catalog_row("coca", "Coca Cola 2.25 L", "UNIT", &["7790895000010"]);
        apply_catalog_pull_inner(&mut connection, &pull(vec![priceless, coca], &[]), "profile", "device@example.test").unwrap();

        let rows = local_catalog_inner(&connection, "central").unwrap();
        let price_of = |id: &str| rows.iter().find(|row| row.product_id == id).map(|row| row.price_per_kg_cents.clone());
        // The product WITHOUT price still reaches the screen (it is shown as "Sin precio") ...
        assert_eq!(price_of("galletitas").as_deref(), Some("0"));
        assert_eq!(price_of("coca").as_deref(), Some("450000"));
        // ... and its barcode resolves, so a scan can open the price dialog.
        assert_eq!(barcodes_of(&connection, "galletitas"), vec!["7791234000001".to_string()]);
    }

    #[test]
    fn a_later_pull_replaces_a_zero_price_with_the_one_the_cashier_set() {
        let mut connection = catalog_fixture();
        let mut priceless = catalog_row("galletitas", "GALLETITAS X", "UNIT", &[]);
        priceless.price_per_kg_cents = "0".into();
        apply_catalog_pull_inner(&mut connection, &pull(vec![priceless], &[]), "profile", "device@example.test").unwrap();
        // Fran sets $1800: the next incremental pull delivers the product with its new price.
        let mut priced = catalog_row("galletitas", "GALLETITAS X", "UNIT", &[]);
        priced.price_per_kg_cents = "180000".into();
        apply_catalog_pull_inner(&mut connection, &pull(vec![priced], &[]), "profile", "device@example.test").unwrap();
        let rows = local_catalog_inner(&connection, "central").unwrap();
        assert_eq!(rows.iter().filter(|row| row.product_id == "galletitas").count(), 1);
        assert_eq!(rows.iter().find(|row| row.product_id == "galletitas").unwrap().price_per_kg_cents, "180000");
    }

    #[test]
    fn a_sale_line_at_price_zero_is_rejected_locally_even_if_the_ui_let_it_through() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        connection.execute("update local_device set organization_id='org',branch_id='branch',profile_id='profile',device_status='ACTIVE',authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        connection.execute("insert into local_pos_operators(profile_id,display_name,role_name,has_pin,active,has_shift_issue,operator_token,grant_valid_until,updated_at) values('profile','Operador','Empleado',1,1,0,'token','2099-01-01T00:00:00Z','2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_categories(id,organization_id,name,sort_order,active,updated_at) values('category','org','Almacen',0,1,'2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_products values('product','org','category','GALLETITAS X',null,'UNIT',1,'2026-09-13T00:00:00Z')", []).unwrap();
        connection.execute("insert into catalog_prices values('product','branch',0,'2026-09-13T00:00:00Z','2026-09-13T00:00:00Z')", []).unwrap();
        let device_id: String = connection.query_row("select device_id from local_device", [], |row| row.get(0)).unwrap();
        let sale = OfflineSalePayload {
            schema_version: 1, event_id: Uuid::new_v4().to_string(), sale_id: Uuid::new_v4().to_string(),
            organization_id: "org".into(), branch_id: "branch".into(), profile_id: "profile".into(), operator_token: Some("token".into()), device_id,
            status: "COMPLETED".into(), total_cents: "0".into(), total_weight_grams: "0".into(),
            created_at: "2026-09-13T00:00:00Z".into(), completed_at: "2026-09-13T00:00:00Z".into(),
            items: vec![OfflineSaleItem { id: Uuid::new_v4().to_string(), product_id: "product".into(), product_name_snapshot: "GALLETITAS X".into(), weight_grams: None, quantity_units: Some(1),
                price_per_kg_cents: "0".into(), original_price_per_kg_cents: Some("0".into()), discount_rule_id: None, discount_type: None, discount_value: None, promotion_mode: None, discount_cents: Some("0".into()),
                cash_discount_bps: Some("0".into()), cash_discount_cents: Some("0".into()), card_surcharge_cents: Some("0".into()), promotion_discount_cents: Some("0".into()), cost_cents_snapshot: None, profit_markup_bps_snapshot: None, subtotal_cents: "0".into(), ..Default::default() }],
            payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: "CASH".into(), amount_cents: "0".into(), provider: None },
            stock_movements: vec![OfflineStockMovement { id: Uuid::new_v4().to_string(), product_id: "product".into(), quantity_grams: "-1".into(), occurred_at: "2026-09-13T00:00:00Z".into() }], ..Default::default()
        };
        let transaction = connection.transaction().unwrap();
        let error = insert_sale(&transaction, &sale).unwrap_err();
        assert!(error.starts_with("PRICE_REQUIRED"), "unexpected error: {error}");
        drop(transaction);
        assert_eq!(connection.query_row("select count(*) from local_sales", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    // ---- Pricing flexible de Central (D-061): precio manual por línea + descuento general ------------
    // Dinero en centavos: $12.000 = 1_200_000.
    fn flexible_fixture(central: bool) -> (Connection, String) {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_connection(&mut connection).unwrap();
        let device_id = unit_sale_device(&connection);
        for (id, name, unit, price) in [("coca", "Coca Cola 2.25 L", "UNIT", 1_200_000), ("fanta", "Fanta 2.25 L", "UNIT", 1_400_000), ("vacio", "Vacío", "WEIGHT", 1_500_000)] {
            connection.execute("insert into catalog_products values(?1,'org','category',?2,null,?3,1,'2026-10-02T00:00:00Z')", params![id, name, unit]).unwrap();
            connection.execute("insert into catalog_prices values(?1,'branch',?2,'2026-10-02T00:00:00Z','2026-10-02T00:00:00Z')", params![id, price]).unwrap();
        }
        if central { set_flexible_pricing_branch_inner(&mut connection, "branch", true).unwrap(); }
        (connection, device_id)
    }

    fn flex_item(product: &str, unit: &str, quantity: i64, list: i64, price: i64, subtotal: i64) -> OfflineSaleItem {
        OfflineSaleItem {
            id: Uuid::new_v4().to_string(), product_id: product.into(), product_name_snapshot: product.into(),
            weight_grams: if unit == "WEIGHT" { Some(quantity) } else { None },
            quantity_units: if unit == "UNIT" { Some(quantity) } else { None },
            price_per_kg_cents: price.to_string(), original_price_per_kg_cents: Some(list.to_string()),
            discount_cents: Some("0".into()), cash_discount_bps: Some("0".into()), cash_discount_cents: Some("0".into()),
            card_surcharge_cents: Some("0".into()), promotion_discount_cents: Some("0".into()), subtotal_cents: subtotal.to_string(),
            ..Default::default()
        }
    }

    /// Línea normal por UNIT a precio de lista (efectivo).
    fn normal_unit(product: &str, quantity: i64, list: i64) -> OfflineSaleItem { flex_item(product, "UNIT", quantity, list, list, list * quantity) }

    /// Línea manual por UNIT: `manual` por unidad contra `list` normal.
    fn manual_unit(product: &str, quantity: i64, list: i64, manual: i64) -> OfflineSaleItem {
        let mut item = flex_item(product, "UNIT", quantity, list, manual, manual * quantity);
        item.manual_price_applied = true;
        item.manual_unit_price_cents = Some(manual.to_string());
        item.manual_adjustment_cents = Some((manual * quantity - list * quantity).to_string());
        item
    }

    fn flex_payload(device_id: String, method: &str, items: Vec<OfflineSaleItem>, discount: Option<(i64, i64)>) -> OfflineSalePayload {
        let subtotal: i64 = items.iter().map(|item| item.subtotal_cents.parse::<i64>().unwrap()).sum();
        let discount_cents = discount.map(|(_, cents)| cents).unwrap_or(0);
        let total = subtotal - discount_cents;
        let weight: i64 = items.iter().map(|item| item.weight_grams.unwrap_or(0)).sum();
        let stock_movements = items.iter().map(|item| OfflineStockMovement {
            id: Uuid::new_v4().to_string(), product_id: item.product_id.clone(),
            quantity_grams: (-item.weight_grams.or(item.quantity_units).unwrap()).to_string(), occurred_at: "2026-10-02T00:00:00Z".into(),
        }).collect();
        OfflineSalePayload {
            schema_version: 1, event_id: Uuid::new_v4().to_string(), sale_id: Uuid::new_v4().to_string(),
            organization_id: "org".into(), branch_id: "branch".into(), profile_id: "profile".into(), operator_token: Some("token".into()), device_id,
            status: "COMPLETED".into(), total_cents: total.to_string(), total_weight_grams: weight.to_string(),
            created_at: "2026-10-02T00:00:00Z".into(), completed_at: "2026-10-02T00:00:00Z".into(),
            ticket_discount_bps: discount.map(|(bps, _)| bps.to_string()), ticket_discount_cents: discount.map(|(_, cents)| cents.to_string()),
            subtotal_cents: discount.map(|_| subtotal.to_string()),
            items, payment: OfflinePayment { id: Uuid::new_v4().to_string(), method: method.into(), amount_cents: total.to_string(), provider: None },
            stock_movements,
        }
    }

    fn try_insert(connection: &mut Connection, sale: &OfflineSalePayload) -> Result<(), String> {
        let transaction = connection.transaction().unwrap();
        let result = insert_sale(&transaction, sale);
        if result.is_ok() { transaction.commit().unwrap(); }
        result
    }

    fn count(connection: &Connection, table: &str) -> i64 {
        connection.query_row(&format!("select count(*) from {table}"), [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn migration_016_adds_the_flexible_pricing_columns_with_safe_defaults() {
        let (connection, _) = flexible_fixture(false);
        for (table, column) in [("local_sales", "ticket_discount_bps"), ("local_sales", "ticket_discount_cents"), ("local_sale_items", "manual_price_applied"), ("local_sale_items", "manual_unit_price_cents"), ("local_sale_items", "manual_adjustment_cents")] {
            assert_eq!(connection.query_row("select count(*) from pragma_table_info(?1) where name = ?2", params![table, column], |row| row.get::<_, i64>(0)).unwrap(), 1, "{table}.{column}");
        }
    }

    #[test]
    fn manual_unit_price_is_stored_as_an_auditable_snapshot_and_never_touches_the_catalog() {
        // Coca Cola de $12.000 vendida a $10.000.
        let (mut connection, device_id) = flexible_fixture(true);
        let sale = flex_payload(device_id, "CASH", vec![manual_unit("coca", 1, 1_200_000, 1_000_000)], None);
        try_insert(&mut connection, &sale).unwrap();
        let row: (i64, i64, i64, i64, i64, i64) = connection.query_row(
            "select manual_price_applied, manual_unit_price_cents, manual_adjustment_cents, original_price_per_kg_cents, price_per_kg_cents, subtotal_cents from local_sale_items",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))).unwrap();
        assert_eq!(row, (1, 1_000_000, -200_000, 1_200_000, 1_000_000, 1_000_000));
        assert_eq!(connection.query_row("select total_cents from local_sales", [], |r| r.get::<_, i64>(0)).unwrap(), 1_000_000);
        assert_eq!(connection.query_row("select amount_cents from local_payments", [], |r| r.get::<_, i64>(0)).unwrap(), 1_000_000);
        // El precio manual afecta sólo esa línea: el catálogo local (y por lo tanto las próximas ventas) queda en $12.000.
        assert_eq!(connection.query_row("select price_per_kg_cents from catalog_prices where product_id = 'coca'", [], |r| r.get::<_, i64>(0)).unwrap(), 1_200_000);
        assert_eq!(connection.query_row("select ticket_discount_bps from local_sales", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn manual_weight_price_is_per_kg_and_prorated_by_the_real_weight() {
        // 1,250 kg de Vacío: lista $15.000/kg, manual $13.000/kg -> $16.250 en vez de $18.750.
        let (mut connection, device_id) = flexible_fixture(true);
        let mut item = flex_item("vacio", "WEIGHT", 1_250, 1_500_000, 1_300_000, 1_625_000);
        item.manual_price_applied = true;
        item.manual_unit_price_cents = Some("1300000".into());
        item.manual_adjustment_cents = Some("-250000".into());
        let sale = flex_payload(device_id, "CASH", vec![item], None);
        try_insert(&mut connection, &sale).unwrap();
        assert_eq!(connection.query_row("select subtotal_cents from local_sale_items", [], |r| r.get::<_, i64>(0)).unwrap(), 1_625_000);
        assert_eq!(connection.query_row("select total_weight_grams from local_sales", [], |r| r.get::<_, i64>(0)).unwrap(), 1_250);
        assert_eq!(connection.query_row("select manual_adjustment_cents from local_sale_items", [], |r| r.get::<_, i64>(0)).unwrap(), -250_000);
    }

    #[test]
    fn a_manual_price_line_has_no_promotion_surcharge_or_payment_method_adjustment() {
        // Tarjeta (DEBIT): una línea manual ya vale lo fijado; con recargo/promoción en la línea se rechaza.
        let (mut connection, device_id) = flexible_fixture(true);
        let sale = flex_payload(device_id.clone(), "DEBIT", vec![manual_unit("coca", 1, 1_200_000, 1_000_000)], None);
        try_insert(&mut connection, &sale).unwrap();
        let mutations: Vec<fn(&mut OfflineSaleItem)> = vec![
            |item| { item.card_surcharge_cents = Some("100000".into()); },
            |item| { item.cash_discount_bps = Some("1000".into()); },
            |item| { item.promotion_discount_cents = Some("1".into()); item.discount_cents = Some("1".into()); },
            |item| { item.promotion_mode = Some("PACK_FIXED_TOTAL".into()); item.discount_rule_id = Some("rule".into()); },
            |item| { item.discount_type = Some("PERCENTAGE".into()); item.discount_value = Some("500".into()); },
        ];
        for mutate in mutations {
            let mut item = manual_unit("coca", 1, 1_200_000, 1_000_000);
            mutate(&mut item);
            let error = try_insert(&mut connection, &flex_payload(device_id.clone(), "DEBIT", vec![item], None)).unwrap_err();
            assert!(error.contains("manual price line") || error.contains("Invalid local sale calculation"), "unexpected: {error}");
        }
        assert_eq!(count(&connection, "local_sales"), 1);
    }

    #[test]
    fn inconsistent_manual_price_arithmetic_is_rejected() {
        let (mut connection, device_id) = flexible_fixture(true);
        // Subtotal que no es precio * cantidad.
        let mut wrong_subtotal = manual_unit("coca", 2, 1_200_000, 1_000_000);
        wrong_subtotal.subtotal_cents = "1900000".into();
        // Ajuste que no coincide con subtotal - lista.
        let mut wrong_adjustment = manual_unit("coca", 1, 1_200_000, 1_000_000);
        wrong_adjustment.manual_adjustment_cents = Some("-100000".into());
        // Precio manual distinto del precio de la línea.
        let mut wrong_price = manual_unit("coca", 1, 1_200_000, 1_000_000);
        wrong_price.manual_unit_price_cents = Some("900000".into());
        // Falta el precio / el ajuste.
        let mut missing_price = manual_unit("coca", 1, 1_200_000, 1_000_000);
        missing_price.manual_unit_price_cents = None;
        let mut missing_adjustment = manual_unit("coca", 1, 1_200_000, 1_000_000);
        missing_adjustment.manual_adjustment_cents = None;
        // Metadata manual sin la marca.
        let mut stray = normal_unit("coca", 1, 1_200_000);
        stray.manual_unit_price_cents = Some("1000000".into());
        // Precio original que ya no es el del catálogo local.
        let stale = manual_unit("coca", 1, 1_300_000, 1_000_000);
        for item in [wrong_subtotal, wrong_adjustment, wrong_price, missing_price, missing_adjustment, stray, stale] {
            assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![item], None)).is_err());
        }
        assert_eq!(count(&connection, "local_sales"), 0);
        assert_eq!(count(&connection, "local_sale_items"), 0);
        assert_eq!(count(&connection, "local_stock_movements"), 0);
    }

    #[test]
    fn a_zero_or_negative_manual_price_is_rejected() {
        let (mut connection, device_id) = flexible_fixture(true);
        for manual in [0_i64, -100] {
            let mut item = manual_unit("coca", 1, 1_200_000, 1);
            item.price_per_kg_cents = manual.to_string();
            item.manual_unit_price_cents = Some(manual.to_string());
            item.subtotal_cents = "1".into();
            assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![item], None)).is_err());
        }
        assert_eq!(count(&connection, "local_sales"), 0);
    }

    #[test]
    fn flexible_pricing_is_rejected_outside_central_without_persisting_anything() {
        // Avenida/Janssen: ni el precio manual ni el descuento general existen, aunque llegue el payload.
        let (mut connection, device_id) = flexible_fixture(false);
        let manual = flex_payload(device_id.clone(), "CASH", vec![manual_unit("coca", 1, 1_200_000, 1_000_000)], None);
        assert!(try_insert(&mut connection, &manual).unwrap_err().starts_with("FLEXIBLE_PRICING_NOT_ALLOWED"));
        let discounted = flex_payload(device_id.clone(), "CASH", vec![normal_unit("coca", 2, 1_200_000)], Some((500, 120_000)));
        assert!(try_insert(&mut connection, &discounted).unwrap_err().starts_with("FLEXIBLE_PRICING_NOT_ALLOWED"));
        assert_eq!(count(&connection, "local_sales"), 0);
        assert_eq!(count(&connection, "local_stock_movements"), 0);
        // Una venta normal sigue funcionando exactamente igual.
        try_insert(&mut connection, &flex_payload(device_id, "CASH", vec![normal_unit("coca", 2, 1_200_000)], None)).unwrap();
        assert_eq!(count(&connection, "local_sales"), 1);
    }

    #[test]
    fn the_flexible_pricing_capability_is_only_for_the_device_branch_and_can_be_revoked() {
        let (mut connection, device_id) = flexible_fixture(true);
        assert!(set_flexible_pricing_branch_inner(&mut connection, "otra-sucursal", true).is_err());
        set_flexible_pricing_branch_inner(&mut connection, "branch", false).unwrap();
        let sale = flex_payload(device_id, "CASH", vec![manual_unit("coca", 1, 1_200_000, 1_000_000)], None);
        assert!(try_insert(&mut connection, &sale).unwrap_err().starts_with("FLEXIBLE_PRICING_NOT_ALLOWED"));
    }

    #[test]
    fn ticket_discount_five_percent_of_24000_charges_22800() {
        // $10.000 (manual) + $14.000 (normal) = $24.000; 5% = $1.200; se cobra $22.800.
        let (mut connection, device_id) = flexible_fixture(true);
        let items = vec![manual_unit("coca", 1, 1_200_000, 1_000_000), normal_unit("fanta", 1, 1_400_000)];
        let sale = flex_payload(device_id, "CASH", items, Some((500, 120_000)));
        try_insert(&mut connection, &sale).unwrap();
        let (bps, cents, total): (i64, i64, i64) = connection.query_row("select ticket_discount_bps, ticket_discount_cents, total_cents from local_sales", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((bps, cents, total), (500, 120_000, 2_280_000));
        // El pago es lo realmente cobrado; las líneas conservan su subtotal sin descuento.
        assert_eq!(connection.query_row("select amount_cents from local_payments", [], |r| r.get::<_, i64>(0)).unwrap(), 2_280_000);
        assert_eq!(connection.query_row("select sum(subtotal_cents) from local_sale_items", [], |r| r.get::<_, i64>(0)).unwrap(), 2_400_000);
    }

    #[test]
    fn ticket_discount_ten_percent_decimals_and_half_up_rounding() {
        let (mut connection, device_id) = flexible_fixture(true);
        // 10% de $24.000.
        // Cada venta necesita ids de línea propios (UNIQUE): se arma el ticket de nuevo cada vez.
        let items = || vec![normal_unit("coca", 1, 1_200_000), normal_unit("fanta", 1, 1_400_000)];
        try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", items(), Some((1_000, 260_000)))).unwrap();
        // 12,5% de $26.000 = $3.250.
        try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", items(), Some((1_250, 325_000)))).unwrap();
        // 7,25% de $26.000 = $1.885.
        try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", items(), Some((725, 188_500)))).unwrap();
        // Half-up: 5% de 10 centavos = 0,5 -> 1; 5% de 9 centavos = 0,45 -> 0.
        connection.execute("update catalog_prices set price_per_kg_cents = 10 where product_id = 'coca'", []).unwrap();
        try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![normal_unit("coca", 1, 10)], Some((500, 1)))).unwrap();
        assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![normal_unit("coca", 1, 10)], Some((500, 0)))).unwrap_err().contains("does not match its percentage"));
        connection.execute("update catalog_prices set price_per_kg_cents = 9 where product_id = 'coca'", []).unwrap();
        try_insert(&mut connection, &flex_payload(device_id, "CASH", vec![normal_unit("coca", 1, 9)], Some((500, 0)))).unwrap();
        assert_eq!(count(&connection, "local_sales"), 5);
        assert_eq!(connection.query_row("select count(*) from local_sales where total_cents = 9 and ticket_discount_cents = 0", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn a_tampered_ticket_discount_or_total_is_rejected() {
        let (mut connection, device_id) = flexible_fixture(true);
        let items = vec![normal_unit("coca", 1, 1_200_000), normal_unit("fanta", 1, 1_400_000)];
        // Importe que no corresponde al porcentaje (5% de $26.000 es $1.300, no $1.200).
        assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", items.clone(), Some((500, 120_000)))).unwrap_err().contains("does not match its percentage"));
        // Descuento declarado pero total y pago brutos (el POS no descontó lo cobrado).
        let mut gross_total = flex_payload(device_id.clone(), "CASH", items.clone(), Some((500, 130_000)));
        gross_total.total_cents = "2600000".into();
        gross_total.payment.amount_cents = "2600000".into();
        assert!(try_insert(&mut connection, &gross_total).unwrap_err().contains("totals differ"));
        // Total correcto pero pago distinto del total neto.
        let mut wrong_payment = flex_payload(device_id.clone(), "CASH", items.clone(), Some((500, 130_000)));
        wrong_payment.payment.amount_cents = "2600000".into();
        assert!(try_insert(&mut connection, &wrong_payment).unwrap_err().contains("totals differ"));
        // Subtotal declarado que no es la suma de las líneas.
        let mut wrong_subtotal = flex_payload(device_id.clone(), "CASH", items.clone(), Some((500, 130_000)));
        wrong_subtotal.subtotal_cents = Some("9999999".into());
        assert!(try_insert(&mut connection, &wrong_subtotal).is_err());
        // Porcentaje fuera de 0-100 y descuento a medias.
        assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", items.clone(), Some((10_001, 2_600_100)))).is_err());
        assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", items.clone(), Some((0, 0)))).unwrap_err().contains("outside 0-100%"));
        let mut half = flex_payload(device_id.clone(), "CASH", items.clone(), Some((500, 130_000)));
        half.ticket_discount_cents = None;
        assert!(try_insert(&mut connection, &half).unwrap_err().contains("needs both"));
        // 100% deja el total en $0: no se puede cobrar.
        assert!(try_insert(&mut connection, &flex_payload(device_id, "CASH", items, Some((10_000, 2_600_000)))).unwrap_err().contains("greater than zero"));
        assert_eq!(count(&connection, "local_sales"), 0);
        assert_eq!(count(&connection, "local_stock_movements"), 0);
    }

    #[test]
    fn manual_price_and_ticket_discount_combine_with_a_card_surcharged_normal_line() {
        // Tarjeta (+10%): manual $10.000 (sin recargo) + Fanta $14.000 -> $15.400. Subtotal $25.400; 5% = $1.270; total $24.130.
        let (mut connection, device_id) = flexible_fixture(true);
        let mut fanta = flex_item("fanta", "UNIT", 1, 1_400_000, 1_540_000, 1_540_000);
        fanta.cash_discount_bps = Some("1000".into());
        fanta.card_surcharge_cents = Some("140000".into());
        let sale = flex_payload(device_id, "DEBIT", vec![manual_unit("coca", 1, 1_200_000, 1_000_000), fanta], Some((500, 127_000)));
        try_insert(&mut connection, &sale).unwrap();
        assert_eq!(connection.query_row("select total_cents from local_sales", [], |r| r.get::<_, i64>(0)).unwrap(), 2_413_000);
        assert_eq!(connection.query_row("select sum(card_surcharge_cents) from local_sale_items", [], |r| r.get::<_, i64>(0)).unwrap(), 140_000);
    }

    #[test]
    fn the_outbox_payload_keeps_the_manual_snapshot_and_the_discount_and_a_plain_sale_stays_byte_compatible() {
        let (_, device_id) = flexible_fixture(true);
        let flexible = flex_payload(device_id.clone(), "CASH", vec![manual_unit("coca", 1, 1_200_000, 1_000_000), normal_unit("fanta", 1, 1_400_000)], Some((500, 120_000)));
        let json = serde_json::to_value(&flexible).unwrap();
        assert_eq!(json["ticketDiscountBps"], "500");
        assert_eq!(json["ticketDiscountCents"], "120000");
        assert_eq!(json["subtotalCents"], "2400000");
        assert_eq!(json["totalCents"], "2280000");
        assert_eq!(json["items"][0]["manualPriceApplied"], true);
        assert_eq!(json["items"][0]["manualUnitPriceCents"], "1000000");
        assert_eq!(json["items"][0]["manualAdjustmentCents"], "-200000");
        assert_eq!(json["items"][0]["originalPricePerKgCents"], "1200000");
        // La segunda línea (normal) no lleva ninguna clave manual.
        assert!(json["items"][1].get("manualPriceApplied").is_none());
        // Ida y vuelta por el outbox: nada se recalcula ni se pierde.
        let restored: OfflineSalePayload = serde_json::from_value(json).unwrap();
        assert!(restored.items[0].manual_price_applied);
        assert_eq!(restored.items[0].manual_unit_price_cents.as_deref(), Some("1000000"));
        assert_eq!(restored.ticket_discount_cents.as_deref(), Some("120000"));

        let plain = serde_json::to_value(&flex_payload(device_id, "CASH", vec![normal_unit("coca", 1, 1_200_000)], None)).unwrap();
        assert!(plain.get("ticketDiscountBps").is_none() && plain.get("ticketDiscountCents").is_none() && plain.get("subtotalCents").is_none());
        assert!(plain["items"][0].get("manualPriceApplied").is_none() && plain["items"][0].get("manualUnitPriceCents").is_none() && plain["items"][0].get("manualAdjustmentCents").is_none());
    }

    #[test]
    fn a_payload_from_before_flexible_pricing_still_deserializes_and_sells_normally_in_any_branch() {
        let (mut connection, device_id) = flexible_fixture(false);
        let legacy = serde_json::to_string(&flex_payload(device_id, "CASH", vec![normal_unit("coca", 1, 1_200_000)], None)).unwrap();
        assert!(!legacy.contains("manual") && !legacy.contains("ticketDiscount"));
        let parsed: OfflineSalePayload = serde_json::from_str(&legacy).unwrap();
        try_insert(&mut connection, &parsed).unwrap();
        assert_eq!(connection.query_row("select manual_price_applied from local_sale_items", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(connection.query_row("select ticket_discount_bps from local_sales", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    // ---- Pack (% propio de cada producto) y promoción global "desde N" de sucursal en productos UNIT -----------------
    // "Hamburguesa" cuesta $800 (80_000 centavos NO: el fixture la guarda en 800 centavos) — todo el dinero va en centavos.

    fn rounded(numerator: i64, denominator: i64) -> i64 { (numerator + denominator / 2) / denominator }

    /// Línea UNIT con el descuento calculado de forma independiente de la implementación: `discounted_units` unidades al `bps`
    /// sobre el total de lista (half-up, una sola vez) y, si es tarjeta, el recargo una sola vez sobre el total comercial.
    fn discounted_unit(product: &str, list: i64, units: i64, discounted_units: i64, bps: i64, card_bps: i64) -> (OfflineSaleItem, i64, i64) {
        let discount = rounded(list * discounted_units * bps, 10_000);
        let cash = list * units - discount;
        let subtotal = if card_bps > 0 { rounded(cash * (10_000 + card_bps), 10_000) } else { cash };
        let mut item = flex_item(product, "UNIT", units, list, rounded(subtotal, units), subtotal);
        item.discount_cents = Some(discount.to_string());
        item.promotion_discount_cents = Some(discount.to_string());
        item.cash_discount_bps = Some(card_bps.to_string());
        item.card_surcharge_cents = Some((subtotal - cash).to_string());
        (item, subtotal, discount)
    }

    fn pack_line(product: &str, list: i64, count: i64, size: i64, card_bps: i64) -> OfflineSaleItem {
        pack_line_at(product, list, count, size, card_bps, 2_000)
    }

    /// Pack con el porcentaje (basis points) de la versión con la que se vendió.
    fn pack_line_at(product: &str, list: i64, count: i64, size: i64, card_bps: i64, bps: i64) -> OfflineSaleItem {
        let units = count * size;
        let (mut item, _, discount) = discounted_unit(product, list, units, units, bps, card_bps);
        item.sold_as_pack = true;
        item.pack_count = Some(count);
        item.pack_size_units_snapshot = Some(size);
        item.pack_discount_bps = Some(bps);
        item.pack_discount_cents = Some(discount.to_string());
        // La versión del pack que el catálogo local le dio al dispositivo para ese tamaño (fixture: "cfg-<tamaño>").
        item.pack_config_id = Some(format!("cfg-{size}"));
        item
    }

    fn promo_line(product: &str, list: i64, units: i64, minimum: i64, bps: i64, card_bps: i64, promotion_id: &str) -> OfflineSaleItem {
        // "Desde N": con N unidades o más del mismo producto, TODAS llevan el descuento; con menos, ninguna.
        let discounted = if units >= minimum { units } else { 0 };
        let (mut item, _, discount) = discounted_unit(product, list, units, discounted, bps, card_bps);
        item.branch_promotion_id = Some(promotion_id.into());
        item.branch_promotion_minimum_units = Some(minimum);
        item.branch_promotion_discount_bps = Some(bps);
        item.branch_promotion_discounted_units = Some(discounted);
        item.branch_promotion_discount_cents = Some(discount.to_string());
        item
    }

    /// Central con "Hamburguesa" ($800/u, pack de 8 al 20 %) y la promoción "desde 3 unidades, 15 %" de la sucursal.
    fn pack_fixture() -> (Connection, String) {
        let (connection, device_id) = flexible_fixture(false);
        connection.execute("insert into catalog_product_packs(product_id, pack_size_units, pack_config_id, pack_discount_bps) values('hamburguesa', 8, 'cfg-8', 2000)", []).unwrap();
        connection.execute("insert into catalog_branch_promotions(id, branch_id, scope, minimum_units, discount_bps) values('promo-1', 'branch', 'ALL_UNIT_PRODUCTS', 3, 1500)", []).unwrap();
        (connection, device_id)
    }

    fn unit_row(connection: &Connection, column: &str) -> i64 {
        connection.query_row(&format!("select {column} from local_sale_items"), [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn migrations_017_to_019_add_pack_and_promotion_storage_with_safe_defaults() {
        let (connection, _) = flexible_fixture(false);
        for (table, column) in [
            ("local_sale_items", "sold_as_pack"), ("local_sale_items", "pack_size_units_snapshot"), ("local_sale_items", "pack_count"),
            ("local_sale_items", "pack_discount_bps"), ("local_sale_items", "pack_discount_cents"), ("local_sale_items", "branch_promotion_id"),
            ("local_sale_items", "branch_promotion_every_units"), ("local_sale_items", "branch_promotion_discount_bps"),
            ("local_sale_items", "branch_promotion_discounted_units"), ("local_sale_items", "branch_promotion_discount_cents"),
            ("catalog_product_packs", "pack_size_units"), ("catalog_product_packs", "pack_config_id"), ("local_sale_items", "pack_config_id"),
            ("catalog_branch_promotions", "minimum_units"), ("catalog_product_packs", "pack_discount_bps"),
        ] {
            assert_eq!(connection.query_row("select count(*) from pragma_table_info(?1) where name = ?2", params![table, column], |row| row.get::<_, i64>(0)).unwrap(), 1, "{table}.{column}");
        }
    }

    #[test]
    fn a_catalog_pull_stores_the_pack_size_and_the_local_catalog_returns_it() {
        let mut connection = catalog_fixture();
        let mut with_pack = catalog_row("leche", "Leche", "UNIT", &[]);
        with_pack.pack_size_units = Some(8);
        with_pack.pack_config_id = Some("cfg-8".into());
        let without_pack = catalog_row("coca", "Coca", "UNIT", &[]);
        apply_catalog_pull_inner(&mut connection, &pull(vec![with_pack, without_pack], &[]), "profile", "a@b.c").unwrap();
        let rows = local_catalog_inner(&connection, "central").unwrap();
        let leche = rows.iter().find(|row| row.product_id == "leche").unwrap();
        assert_eq!((leche.pack_size_units, leche.pack_config_id.as_deref()), (Some(8), Some("cfg-8")));
        let coca = rows.iter().find(|row| row.product_id == "coca").unwrap();
        assert_eq!((coca.pack_size_units, coca.pack_config_id.as_deref()), (None, None));
        // El pack cambia o se quita: el pull que toca al producto lo reemplaza, con el id de SU versión.
        let mut changed = catalog_row("leche", "Leche", "UNIT", &[]);
        changed.pack_size_units = Some(12);
        changed.pack_config_id = Some("cfg-12".into());
        apply_catalog_pull_inner(&mut connection, &pull(vec![changed], &[]), "profile", "a@b.c").unwrap();
        let changed_row = local_catalog_inner(&connection, "central").unwrap().into_iter().find(|row| row.product_id == "leche").unwrap();
        assert_eq!((changed_row.pack_size_units, changed_row.pack_config_id.as_deref()), (Some(12), Some("cfg-12")));
        apply_catalog_pull_inner(&mut connection, &pull(vec![catalog_row("leche", "Leche", "UNIT", &[])], &[]), "profile", "a@b.c").unwrap();
        assert_eq!(local_catalog_inner(&connection, "central").unwrap().iter().find(|row| row.product_id == "leche").unwrap().pack_size_units, None);
    }

    #[test]
    fn a_pack_size_without_its_configuration_is_not_offered() {
        // Un servidor anterior a la versión del pack manda el tamaño pero no el id: sin id la venta no podría validarse allá.
        let mut connection = catalog_fixture();
        let mut no_config = catalog_row("leche", "Leche", "UNIT", &[]);
        no_config.pack_size_units = Some(8);
        let mut empty_config = catalog_row("coca", "Coca", "UNIT", &[]);
        empty_config.pack_size_units = Some(8);
        empty_config.pack_config_id = Some(String::new());
        apply_catalog_pull_inner(&mut connection, &pull(vec![no_config, empty_config], &[]), "profile", "a@b.c").unwrap();
        assert_eq!(count(&connection, "catalog_product_packs"), 0);
        assert!(local_catalog_inner(&connection, "central").unwrap().iter().all(|row| row.pack_size_units.is_none() && row.pack_config_id.is_none()));
    }

    #[test]
    fn a_pack_size_is_only_stored_for_a_unit_product_and_leaves_with_the_product() {
        let mut connection = catalog_fixture();
        let mut weight = catalog_row("vacio", "Vacío", "WEIGHT", &[]);
        weight.pack_size_units = Some(8);
        weight.pack_config_id = Some("cfg-w".into());
        let mut unit = catalog_row("leche", "Leche", "UNIT", &[]);
        unit.pack_size_units = Some(8);
        unit.pack_config_id = Some("cfg-8".into());
        apply_catalog_pull_inner(&mut connection, &pull(vec![weight, unit], &[]), "profile", "a@b.c").unwrap();
        assert_eq!(count(&connection, "catalog_product_packs"), 1);
        apply_catalog_pull_inner(&mut connection, &pull(vec![], &["leche"]), "profile", "a@b.c").unwrap();
        assert_eq!(count(&connection, "catalog_product_packs"), 0, "a product that left the assortment cannot offer a pack");
    }

    #[test]
    fn a_pull_replaces_the_branch_promotions_and_an_older_server_leaves_them_alone() {
        let mut connection = catalog_fixture();
        let mut first = pull(vec![], &[]);
        first.branch_promotions_from_minimum = Some(vec![CatalogBranchPromotion { id: "p1".into(), minimum_units: 3, discount_bps: 1500 }]);
        apply_catalog_pull_inner(&mut connection, &first, "profile", "a@b.c").unwrap();
        assert_eq!(count(&connection, "catalog_branch_promotions"), 1);
        // Un servidor anterior (sin la clave) no cambia lo guardado.
        apply_catalog_pull_inner(&mut connection, &pull(vec![], &[]), "profile", "a@b.c").unwrap();
        assert_eq!(count(&connection, "catalog_branch_promotions"), 1);
        // La foto completa reemplaza: otra regla, y después ninguna (promoción desactivada).
        let mut second = pull(vec![], &[]);
        second.branch_promotions_from_minimum = Some(vec![CatalogBranchPromotion { id: "p2".into(), minimum_units: 4, discount_bps: 2000 }]);
        apply_catalog_pull_inner(&mut connection, &second, "profile", "a@b.c").unwrap();
        assert_eq!(connection.query_row("select id || minimum_units || discount_bps from catalog_branch_promotions", [], |r| r.get::<_, String>(0)).unwrap(), "p242000");
        let mut none = pull(vec![], &[]);
        none.branch_promotions_from_minimum = Some(vec![]);
        apply_catalog_pull_inner(&mut connection, &none, "profile", "a@b.c").unwrap();
        assert_eq!(count(&connection, "catalog_branch_promotions"), 0);
        // Una regla inválida del servidor no se guarda a medias.
        let mut invalid = pull(vec![], &[]);
        invalid.branch_promotions_from_minimum = Some(vec![CatalogBranchPromotion { id: "bad".into(), minimum_units: 1, discount_bps: 1500 }]);
        assert!(apply_catalog_pull_inner(&mut connection, &invalid, "profile", "a@b.c").is_err());
    }

    #[test]
    fn the_pull_reads_the_threshold_promotions_from_their_own_key_and_never_the_old_cada_n_one() {
        // El servidor entrega la clave anterior (branchPromotions) siempre vacía; un servidor anterior a 061 la mandaba con "cada N"
        // (everyUnits). Este POS no la lee: ni la regla vieja ni la vacía tocan lo guardado.
        let mut connection = catalog_fixture();
        let old_server = serde_json::json!({
            "cursor": 1, "serverTime": "2026-09-30T00:00:00Z", "authorizationExpiresAt": "2026-10-01T00:00:00Z",
            "organizationId": "org", "branchId": "central", "branchName": "Central", "deviceStatus": "ACTIVE", "roleName": "admin",
            "catalog": [], "removedProductIds": [], "categories": [],
            "branchPromotions": [{ "id": "old", "scope": "ALL_UNIT_PRODUCTS", "everyUnits": 3, "discountBps": 1500 }]
        });
        let parsed: CatalogPullPayload = serde_json::from_value(old_server).unwrap();
        assert!(parsed.branch_promotions_from_minimum.is_none());
        apply_catalog_pull_inner(&mut connection, &parsed, "profile", "a@b.c").unwrap();
        assert_eq!(count(&connection, "catalog_branch_promotions"), 0, "the old 'cada N' rule is never stored");
        let current = serde_json::json!({
            "cursor": 2, "serverTime": "2026-09-30T00:00:00Z", "authorizationExpiresAt": "2026-10-01T00:00:00Z",
            "organizationId": "org", "branchId": "central", "branchName": "Central", "deviceStatus": "ACTIVE", "roleName": "admin",
            "catalog": [], "removedProductIds": [], "categories": [],
            "branchPromotions": [],
            "branchPromotionsFromMinimum": [{ "id": "new", "scope": "ALL_UNIT_PRODUCTS", "minimumUnits": 3, "discountBps": 1500 }]
        });
        let parsed: CatalogPullPayload = serde_json::from_value(current).unwrap();
        apply_catalog_pull_inner(&mut connection, &parsed, "profile", "a@b.c").unwrap();
        assert_eq!(connection.query_row("select id || minimum_units || discount_bps from catalog_branch_promotions", [], |r| r.get::<_, String>(0)).unwrap(), "new31500");
        // Una pull de un servidor anterior (sin la clave nueva) no borra la regla vigente.
        let again: CatalogPullPayload = serde_json::from_value(serde_json::json!({
            "cursor": 3, "serverTime": "2026-09-30T00:00:00Z", "authorizationExpiresAt": "2026-10-01T00:00:00Z",
            "organizationId": "org", "branchId": "central", "branchName": "Central", "deviceStatus": "ACTIVE", "roleName": "admin",
            "catalog": [], "removedProductIds": [], "categories": [], "branchPromotions": []
        })).unwrap();
        apply_catalog_pull_inner(&mut connection, &again, "profile", "a@b.c").unwrap();
        assert_eq!(count(&connection, "catalog_branch_promotions"), 1);
    }

    #[test]
    fn the_local_commercial_config_returns_only_this_devices_branch_promotion() {
        let (connection, _) = pack_fixture();
        connection.execute("insert into catalog_branch_promotions(id, branch_id, scope, minimum_units, discount_bps) values('other', 'another-branch', 'ALL_UNIT_PRODUCTS', 2, 500)", []).unwrap();
        let mut statement = connection.prepare("select id from catalog_branch_promotions where branch_id = (select branch_id from local_device where singleton = 1)").unwrap();
        let ids: Vec<String> = statement.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(ids, vec!["promo-1".to_string()]);
    }

    #[test]
    fn one_pack_charges_its_percentage_over_the_8_real_units_and_stores_the_snapshot() {
        let (mut connection, device_id) = pack_fixture();
        // 8 × $8,00 = $64,00 − 20 % = $51,20.
        let sale = flex_payload(device_id, "CASH", vec![pack_line("hamburguesa", 800, 1, 8, 0)], None);
        try_insert(&mut connection, &sale).unwrap();
        assert_eq!(unit_row(&connection, "quantity_units"), 8);
        assert_eq!(unit_row(&connection, "subtotal_cents"), 5_120);
        assert_eq!(unit_row(&connection, "sold_as_pack"), 1);
        assert_eq!(unit_row(&connection, "pack_size_units_snapshot"), 8);
        assert_eq!(unit_row(&connection, "pack_count"), 1);
        assert_eq!(unit_row(&connection, "pack_discount_bps"), 2_000);
        assert_eq!(connection.query_row("select pack_config_id from local_sale_items", [], |r| r.get::<_, String>(0)).unwrap(), "cfg-8", "the line keeps the pack version it was sold with");
        assert_eq!(unit_row(&connection, "pack_discount_cents"), 1_280);
        assert_eq!(unit_row(&connection, "promotion_discount_cents"), 1_280);
        assert_eq!(unit_row(&connection, "branch_promotion_discount_cents"), 0);
        assert_eq!(connection.query_row("select quantity_grams from local_stock_movements", [], |r| r.get::<_, i64>(0)).unwrap(), -8, "stock discounts the 8 real units");
        assert_eq!(connection.query_row("select total_cents from local_sales", [], |r| r.get::<_, i64>(0)).unwrap(), 5_120);
    }

    #[test]
    fn two_packs_are_16_real_units_with_20_percent() {
        let (mut connection, device_id) = pack_fixture();
        let sale = flex_payload(device_id, "CASH", vec![pack_line("hamburguesa", 800, 2, 8, 0)], None);
        try_insert(&mut connection, &sale).unwrap();
        assert_eq!((unit_row(&connection, "quantity_units"), unit_row(&connection, "subtotal_cents"), unit_row(&connection, "pack_discount_cents")), (16, 10_240, 2_560));
        assert_eq!(connection.query_row("select quantity_grams from local_stock_movements", [], |r| r.get::<_, i64>(0)).unwrap(), -16);
    }

    #[test]
    fn a_pack_paid_with_card_surcharges_after_the_discount_and_a_ticket_discount_comes_last() {
        let (mut connection, device_id) = pack_fixture();
        // $51,20 + 10 % de tarjeta = $56,32 (recargo $5,12).
        let sale = flex_payload(device_id, "DEBIT", vec![pack_line("hamburguesa", 800, 1, 8, 1_000)], None);
        try_insert(&mut connection, &sale).unwrap();
        assert_eq!((unit_row(&connection, "subtotal_cents"), unit_row(&connection, "card_surcharge_cents")), (5_632, 512));
        // Central: descuento general del 5 % sobre el pack en efectivo ($51,20 − $2,56 = $48,64).
        let (mut central, central_device) = pack_fixture();
        set_flexible_pricing_branch_inner(&mut central, "branch", true).unwrap();
        try_insert(&mut central, &flex_payload(central_device, "CASH", vec![pack_line("hamburguesa", 800, 1, 8, 0)], Some((500, 256)))).unwrap();
        assert_eq!(central.query_row("select total_cents from local_sales", [], |r| r.get::<_, i64>(0)).unwrap(), 4_864);
    }

    #[test]
    fn a_pack_line_is_rejected_when_it_is_not_exactly_the_pack_rule() {
        let (mut connection, device_id) = pack_fixture();
        let mutations: Vec<(&str, fn(&mut OfflineSaleItem))> = vec![
            // 15 % bien calculado (todo consistente): sólo que no es el porcentaje de la versión del pack que tiene el dispositivo (20 %) lo hace inválido.
            ("not the percentage of the pack the device holds (15 % vs 20 %)", |item| { item.pack_discount_bps = Some(1_500); item.pack_discount_cents = Some("960".into()); item.discount_cents = Some("960".into()); item.promotion_discount_cents = Some("960".into()); item.subtotal_cents = "5440".into(); item.price_per_kg_cents = "680".into(); }),
            ("units do not match the pack", |item| { item.pack_size_units_snapshot = Some(6); }),
            ("amount is not the percentage", |item| { item.pack_discount_cents = Some("1000".into()); }),
            ("size differs from the local catalog", |item| { item.pack_size_units_snapshot = Some(4); item.pack_count = Some(2); }),
            ("no pack configuration", |item| { item.pack_config_id = None; }),
            ("empty pack configuration", |item| { item.pack_config_id = Some(String::new()); }),
            ("a configuration the device never received", |item| { item.pack_config_id = Some("cfg-invented".into()); }),
            ("stacked with the branch promotion", |item| { item.branch_promotion_id = Some("promo-1".into()); item.branch_promotion_minimum_units = Some(3); item.branch_promotion_discount_bps = Some(1_500); item.branch_promotion_discounted_units = Some(8); item.branch_promotion_discount_cents = Some("960".into()); }),
            ("stacked with a specific promotion", |item| { item.promotion_mode = Some("PACK_FIXED_TOTAL".into()); item.discount_rule_id = Some("rule".into()); }),
            ("pack metadata without the pack flag", |item| { item.sold_as_pack = false; }),
            ("price per unit does not match", |item| { item.price_per_kg_cents = "700".into(); }),
        ];
        for (label, mutate) in mutations {
            let mut item = pack_line("hamburguesa", 800, 1, 8, 0);
            mutate(&mut item);
            let result = try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![item], None));
            assert!(result.is_err(), "{label} must be rejected");
        }
        assert_eq!(count(&connection, "local_sales"), 0, "a rejected sale persists nothing");
    }

    #[test]
    fn a_pack_needs_the_local_catalog_to_know_the_pack_and_never_applies_to_weight_or_manual_lines() {
        let (mut connection, device_id) = pack_fixture();
        connection.execute("delete from catalog_product_packs", []).unwrap();
        assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![pack_line("hamburguesa", 800, 1, 8, 0)], None)).is_err(), "a product without a pack in the catalog cannot be sold as one");
        connection.execute("insert into catalog_product_packs(product_id, pack_size_units, pack_config_id, pack_discount_bps) values('hamburguesa', 8, 'cfg-8', 2000)", []).unwrap();
        let mut weight = flex_item("vacio", "WEIGHT", 1_000, 1_500_000, 1_500_000, 1_500_000);
        weight.sold_as_pack = true; weight.pack_count = Some(1); weight.pack_size_units_snapshot = Some(8); weight.pack_discount_bps = Some(2_000); weight.pack_discount_cents = Some("300000".into());
        assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![weight], None)).is_err(), "WEIGHT lines are never packs");
        let (mut central, central_device) = pack_fixture();
        set_flexible_pricing_branch_inner(&mut central, "branch", true).unwrap();
        let mut manual = manual_unit("hamburguesa", 8, 800, 700);
        manual.sold_as_pack = true; manual.pack_count = Some(1); manual.pack_size_units_snapshot = Some(8); manual.pack_discount_bps = Some(2_000); manual.pack_discount_cents = Some("1280".into());
        assert!(try_insert(&mut central, &flex_payload(central_device, "CASH", vec![manual], None)).is_err(), "a manual price excludes the pack");
    }

    #[test]
    fn branch_promotion_discounts_every_unit_of_the_line_once_the_minimum_is_reached() {
        let (mut connection, device_id) = pack_fixture();
        // 8 unidades, desde 3 → las 8 con 15 %: lista $64,00 − 8 × $8,00 × 15 % ($9,60) = $54,40.
        try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![promo_line("hamburguesa", 800, 8, 3, 1_500, 0, "promo-1")], None)).unwrap();
        assert_eq!((unit_row(&connection, "quantity_units"), unit_row(&connection, "subtotal_cents")), (8, 5_440));
        assert_eq!(unit_row(&connection, "branch_promotion_discounted_units"), 8);
        assert_eq!(unit_row(&connection, "branch_promotion_every_units"), 3, "the minimum quantity of the rule (historical column name)");
        assert_eq!(unit_row(&connection, "branch_promotion_discount_bps"), 1_500);
        assert_eq!(unit_row(&connection, "branch_promotion_discount_cents"), 960);
        assert_eq!(unit_row(&connection, "sold_as_pack"), 0);
        // Con tarjeta: el recargo va una sola vez sobre el total ya descontado.
        let (mut card, card_device) = pack_fixture();
        try_insert(&mut card, &flex_payload(card_device, "DEBIT", vec![promo_line("hamburguesa", 800, 3, 3, 1_500, 1_000, "promo-1")], None)).unwrap();
        // 3 × $8,00 = $24,00 − $3,60 = $20,40 + 10 % = $22,44.
        assert_eq!(card.query_row("select subtotal_cents from local_sale_items", [], |r| r.get::<_, i64>(0)).unwrap(), 2_244);
    }

    #[test]
    fn the_threshold_promotion_applies_to_the_whole_line_from_3_units_up() {
        // qty 3, 4, 5, 8 y 20: todas las unidades llevan el 15 % (lista $8,00): total = 85 % de la lista.
        for (units, total) in [(3_i64, 2_040_i64), (4, 2_720), (5, 3_400), (8, 5_440), (20, 13_600)] {
            let (mut connection, device_id) = pack_fixture();
            try_insert(&mut connection, &flex_payload(device_id, "CASH", vec![promo_line("hamburguesa", 800, units, 3, 1_500, 0, "promo-1")], None)).unwrap();
            assert_eq!(unit_row(&connection, "subtotal_cents"), total, "{units} units");
            assert_eq!(unit_row(&connection, "branch_promotion_discounted_units"), units, "all {units} units are discounted");
            assert_eq!(unit_row(&connection, "branch_promotion_discount_cents"), 800 * units - total);
        }
        // 4 × $1.000: base $4.000, 15 % = -$600, total $3.400 (centavos).
        let (mut thousand, thousand_device) = pack_fixture();
        thousand.execute("update catalog_prices set price_per_kg_cents = 100000 where product_id = 'hamburguesa'", []).unwrap();
        try_insert(&mut thousand, &flex_payload(thousand_device, "CASH", vec![promo_line("hamburguesa", 100_000, 4, 3, 1_500, 0, "promo-1")], None)).unwrap();
        assert_eq!((unit_row(&thousand, "subtotal_cents"), unit_row(&thousand, "branch_promotion_discount_cents")), (340_000, 60_000));
    }

    #[test]
    fn the_old_every_n_arithmetic_is_rejected_by_the_current_pos() {
        // 8 unidades con sólo 6 descontadas ("cada 3"): todo consistente salvo que "desde 3" descuenta las 8.
        let (mut connection, device_id) = pack_fixture();
        let (mut item, _, discount) = discounted_unit("hamburguesa", 800, 8, 6, 1_500, 0);
        item.branch_promotion_id = Some("promo-1".into());
        item.branch_promotion_minimum_units = Some(3);
        item.branch_promotion_discount_bps = Some(1_500);
        item.branch_promotion_discounted_units = Some(6);
        item.branch_promotion_discount_cents = Some(discount.to_string());
        assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![item], None)).is_err());
        // Una línea del formato anterior (branchPromotionEveryUnits) deserializa sin cantidad mínima y también se rechaza.
        let mut legacy = serde_json::to_value(promo_line("hamburguesa", 800, 4, 3, 1_500, 0, "promo-1")).unwrap();
        legacy.as_object_mut().unwrap().remove("branchPromotionMinimumUnits");
        legacy.as_object_mut().unwrap().insert("branchPromotionEveryUnits".into(), serde_json::json!(3));
        let parsed: OfflineSaleItem = serde_json::from_value(legacy).unwrap();
        assert!(parsed.branch_promotion_minimum_units.is_none());
        assert!(try_insert(&mut connection, &flex_payload(device_id, "CASH", vec![parsed], None)).unwrap_err().contains("missing its minimum"));
        assert_eq!(count(&connection, "local_sales"), 0);
    }

    #[test]
    fn a_pack_sells_at_the_percentage_of_the_version_the_device_holds_and_no_other() {
        // Leche B: pack de 8 al 25 % (versión "cfg-8"): 8 × $8,00 = $64,00 − 25 % = $48,00.
        let (mut connection, device_id) = pack_fixture();
        connection.execute("update catalog_product_packs set pack_discount_bps = 2500 where product_id = 'hamburguesa'", []).unwrap();
        try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![pack_line_at("hamburguesa", 800, 1, 8, 0, 2_500)], None)).unwrap();
        assert_eq!((unit_row(&connection, "subtotal_cents"), unit_row(&connection, "pack_discount_bps"), unit_row(&connection, "pack_discount_cents")), (4_800, 2_500, 1_600));
        // El 20 % (el de una versión anterior) ya no es el de la versión que tiene este dispositivo.
        let err = try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![pack_line_at("hamburguesa", 800, 1, 8, 0, 2_000)], None)).unwrap_err();
        assert!(err.contains("does not match the local catalog"), "{err}");
        // Un porcentaje inventado (30 %, aritmética incluida) tampoco.
        assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![pack_line_at("hamburguesa", 800, 1, 8, 0, 3_000)], None)).is_err());
        // 0 %, 100 % o más no son un descuento de pack.
        for bps in [0_i64, 10_000, 12_000] {
            let mut item = pack_line_at("hamburguesa", 800, 1, 8, 0, 2_500);
            item.pack_discount_bps = Some(bps);
            assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![item], None)).is_err(), "{bps} bps");
        }
        assert_eq!(count(&connection, "local_sales"), 1);
    }

    #[test]
    fn a_pack_sold_with_the_old_version_keeps_its_percentage_after_the_discount_changes() {
        // Día 1: pack de 8 al 20 % (cfg-8). La venta queda en la outbox. Día 2: el Admin lo pasa al 25 % (cfg-8b) y el
        // dispositivo sincroniza el catálogo: la venta guardada sigue siendo 8 unidades al 20 %; la nueva usa 25 %.
        let (mut connection, device_id) = pack_fixture();
        let day1 = flex_payload(device_id.clone(), "CASH", vec![pack_line("hamburguesa", 800, 1, 8, 0)], None);
        try_insert(&mut connection, &day1).unwrap();
        let mut changed = catalog_row("hamburguesa", "Hamburguesa", "UNIT", &[]);
        changed.branch_id = "branch".into();
        changed.price_per_kg_cents = "800".into();
        changed.pack_size_units = Some(8);
        changed.pack_config_id = Some("cfg-8b".into());
        changed.pack_discount_bps = Some(2_500);
        let mut payload = pull(vec![changed], &[]);
        payload.branch_id = "branch".into();
        apply_catalog_pull_inner(&mut connection, &payload, "profile", "a@b.c").unwrap();
        connection.execute("update local_device set authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        assert_eq!(connection.query_row("select pack_config_id || ':' || pack_discount_bps from catalog_product_packs where product_id = 'hamburguesa'", [], |r| r.get::<_, String>(0)).unwrap(), "cfg-8b:2500");
        assert_eq!((unit_row(&connection, "pack_discount_bps"), unit_row(&connection, "subtotal_cents")), (2_000, 5_120), "the stored Day 1 sale is not rewritten");
        let outbox = serde_json::to_value(&day1).unwrap();
        assert_eq!((outbox["items"][0]["packConfigId"].clone(), outbox["items"][0]["packDiscountBps"].clone()), (serde_json::json!("cfg-8"), serde_json::json!(2000)));
        let mut new_item = pack_line_at("hamburguesa", 800, 1, 8, 0, 2_500);
        new_item.pack_config_id = Some("cfg-8b".into());
        try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![new_item], None)).unwrap();
        assert_eq!(connection.query_row("select subtotal_cents, pack_discount_bps, pack_config_id from local_sale_items order by rowid desc limit 1", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))).unwrap(), (4_800, 2_500, "cfg-8b".to_string()));
        // Armar una línea con la versión vieja después del cambio ya no se acepta en este dispositivo.
        assert!(try_insert(&mut connection, &flex_payload(device_id, "CASH", vec![pack_line("hamburguesa", 800, 1, 8, 0)], None)).is_err());
    }

    #[test]
    fn a_catalog_pull_stores_the_pack_discount_of_each_product() {
        let mut connection = catalog_fixture();
        let mut a = catalog_row("leche-a", "Leche A", "UNIT", &[]);
        a.pack_size_units = Some(8);
        a.pack_config_id = Some("cfg-a".into());
        a.pack_discount_bps = Some(2_000);
        let mut b = catalog_row("leche-b", "Leche B", "UNIT", &[]);
        b.pack_size_units = Some(8);
        b.pack_config_id = Some("cfg-b".into());
        b.pack_discount_bps = Some(2_500);
        let mut c = catalog_row("prod-c", "Producto C", "UNIT", &[]);
        c.pack_size_units = Some(12);
        c.pack_config_id = Some("cfg-c".into());
        c.pack_discount_bps = Some(1_250);
        apply_catalog_pull_inner(&mut connection, &pull(vec![a, b, c], &[]), "profile", "a@b.c").unwrap();
        let rows = local_catalog_inner(&connection, "central").unwrap();
        let of = |id: &str| { let row = rows.iter().find(|row| row.product_id == id).unwrap(); (row.pack_size_units, row.pack_config_id.clone(), row.pack_discount_bps) };
        assert_eq!(of("leche-a"), (Some(8), Some("cfg-a".to_string()), Some(2_000)));
        assert_eq!(of("leche-b"), (Some(8), Some("cfg-b".to_string()), Some(2_500)));
        assert_eq!(of("prod-c"), (Some(12), Some("cfg-c".to_string()), Some(1_250)));
        // El porcentaje cambia: el pull que toca al producto lo reemplaza junto con la versión.
        let mut b2 = catalog_row("leche-b", "Leche B", "UNIT", &[]);
        b2.pack_size_units = Some(8);
        b2.pack_config_id = Some("cfg-b2".into());
        b2.pack_discount_bps = Some(3_000);
        apply_catalog_pull_inner(&mut connection, &pull(vec![b2], &[]), "profile", "a@b.c").unwrap();
        let rows = local_catalog_inner(&connection, "central").unwrap();
        let b_row = rows.iter().find(|row| row.product_id == "leche-b").unwrap();
        assert_eq!((b_row.pack_config_id.as_deref(), b_row.pack_discount_bps), (Some("cfg-b2"), Some(3_000)));
    }

    #[test]
    fn a_pack_without_a_percentage_is_a_20_percent_pack_from_an_older_server_and_an_invalid_one_is_not_offered() {
        let mut connection = catalog_fixture();
        let mut legacy = catalog_row("legacy", "Legacy", "UNIT", &[]);
        legacy.pack_size_units = Some(8);
        legacy.pack_config_id = Some("cfg-legacy".into());
        let mut zero = catalog_row("zero", "Cero", "UNIT", &[]);
        zero.pack_size_units = Some(8);
        zero.pack_config_id = Some("cfg-zero".into());
        zero.pack_discount_bps = Some(0);
        let mut hundred = catalog_row("hundred", "Cien", "UNIT", &[]);
        hundred.pack_size_units = Some(8);
        hundred.pack_config_id = Some("cfg-hundred".into());
        hundred.pack_discount_bps = Some(10_000);
        apply_catalog_pull_inner(&mut connection, &pull(vec![legacy, zero, hundred], &[]), "profile", "a@b.c").unwrap();
        assert_eq!(count(&connection, "catalog_product_packs"), 1);
        let rows = local_catalog_inner(&connection, "central").unwrap();
        let legacy_row = rows.iter().find(|row| row.product_id == "legacy").unwrap();
        assert_eq!((legacy_row.pack_size_units, legacy_row.pack_discount_bps), (Some(8), Some(2_000)));
        assert!(rows.iter().filter(|row| row.product_id == "zero" || row.product_id == "hundred").all(|row| row.pack_size_units.is_none()));
    }

    #[test]
    fn a_product_has_one_category_and_a_pull_never_stores_secondary_ones() {
        let mut connection = catalog_fixture();
        let mut chorizo = catalog_row("chorizo", "Chorizo", "WEIGHT", &[]);
        chorizo.category_ids = vec!["cat".into(), "embutidos".into(), "cerdo".into()]; // un servidor anterior o una lista inventada
        apply_catalog_pull_inner(&mut connection, &pull(vec![chorizo], &[]), "profile", "a@b.c").unwrap();
        let stored: Vec<String> = connection.prepare("select category_id from catalog_product_categories where product_id = 'chorizo'").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(stored, vec!["cat".to_string()]);
        let row = local_catalog_inner(&connection, "central").unwrap().into_iter().find(|row| row.product_id == "chorizo").unwrap();
        assert_eq!((row.category_id.as_str(), row.category_ids), ("cat", vec!["cat".to_string()]));
        // Cambiar de categoría REEMPLAZA la anterior (no agrega otra).
        connection.execute("insert into catalog_categories(id, organization_id, name, color_hex, sort_order, active, updated_at) values('cerdo', 'org', 'Cerdo', null, 1, 1, '2026-09-30T00:00:00Z')", []).unwrap();
        let mut moved = catalog_row("chorizo", "Chorizo", "WEIGHT", &[]);
        moved.category_id = "cerdo".into();
        moved.category_name = "Cerdo".into();
        moved.category_ids = vec!["cerdo".into()];
        apply_catalog_pull_inner(&mut connection, &pull(vec![moved], &[]), "profile", "a@b.c").unwrap();
        let stored: Vec<String> = connection.prepare("select category_id from catalog_product_categories where product_id = 'chorizo'").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(stored, vec!["cerdo".to_string()]);
    }

    /// Una base SQLite de un POS ya instalado: las 18 migraciones anteriores aplicadas (con datos de la versión anterior) y nada más.
    fn database_at_migration_018() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("pragma foreign_keys = on; create table schema_migrations (version integer primary key, applied_at text not null);").unwrap();
        let schemas = [
            INITIAL_SCHEMA, COMMERCIAL_SCHEMA, DISCOUNT_SNAPSHOT_SCHEMA, CASH_DISCOUNT_SNAPSHOT_SCHEMA, CATEGORY_COLORS_SCHEMA, POS_OPERATORS_TIMEKEEPING_SCHEMA,
            WEIGHT_DISCOUNT_PACK_MODE_SCHEMA, PRODUCT_CATEGORY_ASSIGNMENTS_SCHEMA, UNIT_SALE_SUPPORT_SCHEMA, CARD_SURCHARGE_PRICING_SCHEMA, SHIFT_HEARTBEAT_SCHEMA,
            BRANCH_STOCK_PROJECTION_SCHEMA, PRODUCT_BARCODES_SCHEMA, PAYMENT_VERIFICATION_SCHEMA, CATALOG_ZERO_PRICE_SCHEMA, FLEXIBLE_PRICING_SCHEMA,
            UNIT_PACKS_PROMOTIONS_SCHEMA, PACK_CONFIG_SCHEMA,
        ];
        for (index, schema) in schemas.iter().enumerate() {
            if index == 8 { connection.execute_batch("pragma foreign_keys = off;").unwrap(); }
            connection.execute_batch(schema).unwrap();
            if index == 8 { connection.execute_batch("pragma foreign_keys = on;").unwrap(); }
            connection.execute("insert into schema_migrations(version, applied_at) values (?1, 'then')", [index as i64 + 1]).unwrap();
        }
        connection
    }

    #[test]
    fn migration_019_upgrades_an_installed_pos_keeping_its_packs_promotion_and_cleaning_secondary_categories() {
        let mut connection = database_at_migration_018();
        connection.execute("insert or ignore into catalog_categories(id, organization_id, name, color_hex, sort_order, active, updated_at) values('almacen', 'org', 'Almacen', null, 0, 1, 't'), ('lacteos', 'org', 'Lacteos', null, 1, 1, 't'), ('bebidas', 'org', 'Bebidas', null, 2, 1, 't')", []).unwrap();
        for (id, category) in [("leche-a", "almacen"), ("leche-b", "lacteos"), ("coca", "bebidas")] {
            connection.execute("insert into catalog_products(id, organization_id, category_id, name, sku, unit_type, active, updated_at) values(?1, 'org', ?2, ?1, null, 'UNIT', 1, 't')", params![id, category]).unwrap();
        }
        // Multicategoría de la versión anterior: A en 3 categorías, B en 2 (sin su propia principal), Coca sólo en la suya.
        for (product, category) in [("leche-a", "almacen"), ("leche-a", "lacteos"), ("leche-a", "bebidas"), ("leche-b", "almacen"), ("coca", "bebidas")] {
            connection.execute("insert into catalog_product_categories(product_id, category_id) values(?1, ?2)", params![product, category]).unwrap();
        }
        connection.execute("insert into catalog_product_packs(product_id, pack_size_units, pack_config_id) values('leche-a', 8, 'cfg-a'), ('leche-b', 8, 'cfg-b')", []).unwrap();
        connection.execute("insert into catalog_branch_promotions(id, branch_id, scope, every_units, discount_bps) values('promo', 'branch', 'ALL_UNIT_PRODUCTS', 3, 1500)", []).unwrap();
        // Una venta pendiente hecha con el formato anterior: no se toca.
        connection.execute("insert into sync_outbox(id,aggregate_type,aggregate_id,operation,payload,status,created_at,next_attempt_at) values('sale-1','SALE','s1','UPSERT','{\"legacy\":true}','PENDING','t','t')", []).unwrap();

        initialize_connection(&mut connection).unwrap();

        assert_eq!(connection.query_row("select max(version) from schema_migrations", [], |r| r.get::<_, i64>(0)).unwrap(), 19);
        let pairs: Vec<(String, String)> = connection.prepare("select product_id, category_id from catalog_product_categories order by product_id").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(pairs, vec![("coca".into(), "bebidas".into()), ("leche-a".into(), "almacen".into()), ("leche-b".into(), "lacteos".into())], "only the principal category of each product remains");
        let packs: Vec<(String, i64, String, i64)> = connection.prepare("select product_id, pack_size_units, pack_config_id, pack_discount_bps from catalog_product_packs order by product_id").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(packs, vec![("leche-a".into(), 8, "cfg-a".into(), 2_000), ("leche-b".into(), 8, "cfg-b".into(), 2_000)], "existing packs keep their version and are 20 %");
        // La regla guardada por el POS anterior era "cada N": no se conserva (aplicarla como "desde N" sería otra promoción, y el servidor
        // rechazaría la venta contra una regla de la semántica anterior). La siguiente sincronización trae la regla "desde N" vigente.
        assert_eq!(count(&connection, "catalog_branch_promotions"), 0, "the 'cada 3' rule of the previous POS is discarded until the next sync brings the 'desde 3' one");
        assert_eq!(connection.query_row("select payload from sync_outbox where id = 'sale-1'", [], |r| r.get::<_, String>(0)).unwrap(), "{\"legacy\":true}");
        // Idempotente: reabrir la base no la vuelve a migrar.
        initialize_connection(&mut connection).unwrap();
        assert_eq!(connection.query_row("select count(*) from schema_migrations where version = 19", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn a_line_below_the_minimum_is_a_plain_line_and_cannot_claim_the_promotion() {
        let (mut connection, device_id) = pack_fixture();
        try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![normal_unit("hamburguesa", 2, 800)], None)).unwrap();
        assert_eq!(unit_row(&connection, "subtotal_cents"), 1_600);
        assert!(try_insert(&mut connection, &flex_payload(device_id, "CASH", vec![promo_line("hamburguesa", 800, 2, 3, 1_500, 0, "promo-1")], None)).is_err(), "below the minimum, no discount");
    }

    #[test]
    fn a_branch_promotion_must_be_the_one_this_device_received() {
        let (mut connection, device_id) = pack_fixture();
        let attempts: Vec<(&str, OfflineSaleItem)> = vec![
            ("unknown id", promo_line("hamburguesa", 800, 3, 3, 1_500, 0, "nope")),
            ("other percentage", promo_line("hamburguesa", 800, 3, 3, 3_000, 0, "promo-1")),
            ("other minimum quantity", promo_line("hamburguesa", 800, 4, 2, 1_500, 0, "promo-1")),
        ];
        for (label, item) in attempts {
            assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![item], None)).is_err(), "{label} must be rejected");
        }
        let mut partial = promo_line("hamburguesa", 800, 8, 3, 1_500, 0, "promo-1");
        // 6 de 8 unidades con descuento ("cada 3", todo consistente: 15 % de 6 × $8,00 = $7,20): "desde 3" descuenta las 8.
        partial.branch_promotion_discounted_units = Some(6);
        partial.branch_promotion_discount_cents = Some("720".into());
        partial.discount_cents = Some("720".into());
        partial.promotion_discount_cents = Some("720".into());
        partial.subtotal_cents = "5680".into();
        partial.price_per_kg_cents = "710".into();
        assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![partial], None)).is_err(), "every unit of the line is discounted from the minimum");
        let mut wrong_amount = promo_line("hamburguesa", 800, 3, 3, 1_500, 0, "promo-1");
        wrong_amount.branch_promotion_discount_cents = Some("100".into());
        assert!(try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![wrong_amount], None)).is_err());
        // Otra sucursal: la regla de Central no vale en una sucursal que no la recibió.
        connection.execute("update catalog_branch_promotions set branch_id = 'another-branch'", []).unwrap();
        assert!(try_insert(&mut connection, &flex_payload(device_id, "CASH", vec![promo_line("hamburguesa", 800, 3, 3, 1_500, 0, "promo-1")], None)).is_err());
        assert_eq!(count(&connection, "local_sales"), 0);
    }

    #[test]
    fn a_specific_product_promotion_that_applies_takes_precedence_over_the_branch_promotion() {
        let (mut connection, device_id) = pack_fixture();
        // Pack específico "4 por $20,00": con 8 unidades aplica (2 packs); la promoción de sucursal no puede acompañarla.
        connection.execute("insert into local_weight_discounts(id,product_id,branch_id,promotion_mode,pack_quantity_units,pack_price_cents) values('pack-1','hamburguesa',null,'PACK_FIXED_TOTAL',4,2000)", []).unwrap();
        let result = try_insert(&mut connection, &flex_payload(device_id.clone(), "CASH", vec![promo_line("hamburguesa", 800, 8, 3, 1_500, 0, "promo-1")], None));
        assert!(result.unwrap_err().contains("takes precedence"));
        // Con menos unidades que su pack, la específica no aplica y rige la de sucursal.
        try_insert(&mut connection, &flex_payload(device_id, "CASH", vec![promo_line("hamburguesa", 800, 3, 3, 1_500, 0, "promo-1")], None)).unwrap();
        assert_eq!(unit_row(&connection, "branch_promotion_discounted_units"), 3);
    }

    #[test]
    fn the_outbox_payload_keeps_the_pack_and_promotion_snapshots_and_a_plain_line_stays_byte_compatible() {
        let (_, device_id) = pack_fixture();
        let sale = flex_payload(device_id, "CASH", vec![pack_line("hamburguesa", 800, 1, 8, 0), promo_line("hamburguesa", 800, 3, 3, 1_500, 0, "promo-1"), normal_unit("coca", 1, 1_200_000)], None);
        let json = serde_json::to_value(&sale).unwrap();
        assert_eq!(json["items"][0]["soldAsPack"], true);
        assert_eq!(json["items"][0]["packCount"], 1);
        assert_eq!(json["items"][0]["packSizeUnitsSnapshot"], 8);
        assert_eq!(json["items"][0]["packConfigId"], "cfg-8");
        assert_eq!(json["items"][0]["packDiscountBps"], 2000);
        assert_eq!(json["items"][0]["packDiscountCents"], "1280");
        assert!(json["items"][0].get("branchPromotionId").is_none());
        assert_eq!(json["items"][1]["branchPromotionId"], "promo-1");
        assert_eq!(json["items"][1]["branchPromotionMinimumUnits"], 3);
        assert!(json["items"][1].get("branchPromotionEveryUnits").is_none(), "the old key is never produced");
        assert_eq!(json["items"][1]["branchPromotionDiscountedUnits"], 3);
        assert_eq!(json["items"][1]["branchPromotionDiscountCents"], "360");
        assert!(json["items"][1].get("soldAsPack").is_none());
        for key in ["soldAsPack", "packCount", "packSizeUnitsSnapshot", "packConfigId", "packDiscountBps", "packDiscountCents", "branchPromotionId", "branchPromotionMinimumUnits", "branchPromotionDiscountBps", "branchPromotionDiscountedUnits", "branchPromotionDiscountCents"] {
            assert!(json["items"][2].get(key).is_none(), "a plain line must not carry {key}");
        }
        let restored: OfflineSalePayload = serde_json::from_value(json).unwrap();
        assert!(restored.items[0].sold_as_pack);
        assert_eq!(restored.items[0].pack_discount_cents.as_deref(), Some("1280"));
        assert_eq!(restored.items[0].pack_config_id.as_deref(), Some("cfg-8"));
        assert_eq!(restored.items[1].branch_promotion_discounted_units, Some(3));
    }

    #[test]
    fn a_pack_sale_made_before_the_product_changed_its_pack_size_is_not_rewritten() {
        let (mut connection, device_id) = pack_fixture();
        try_insert(&mut connection, &flex_payload(device_id, "CASH", vec![pack_line("hamburguesa", 800, 1, 8, 0)], None)).unwrap();
        // Mañana el producto pasa de 8 a 12: la venta guardada sigue siendo 1 pack × 8 unidades.
        let mut changed = catalog_row("hamburguesa", "Hamburguesa", "UNIT", &[]);
        changed.branch_id = "branch".into();
        changed.pack_size_units = Some(12);
        changed.pack_config_id = Some("cfg-12".into());
        let mut payload = pull(vec![changed], &[]);
        payload.branch_id = "branch".into();
        apply_catalog_pull_inner(&mut connection, &payload, "profile", "a@b.c").unwrap();
        assert_eq!(connection.query_row("select pack_size_units from catalog_product_packs where product_id = 'hamburguesa'", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
        assert_eq!((unit_row(&connection, "pack_size_units_snapshot"), unit_row(&connection, "quantity_units"), unit_row(&connection, "pack_count")), (8, 8, 1));
        assert_eq!(connection.query_row("select pack_config_id from local_sale_items", [], |r| r.get::<_, String>(0)).unwrap(), "cfg-8", "and it still points at the version it was sold with");
    }

    #[test]
    fn after_the_pack_changes_to_12_the_device_sells_the_new_version_and_the_old_one_stays_in_the_outbox_payload() {
        let (mut connection, device_id) = pack_fixture();
        // Venta hecha con el pack de 8 y todavía sin sincronizar: su payload del outbox conserva la versión vieja.
        let old_sale = flex_payload(device_id.clone(), "CASH", vec![pack_line("hamburguesa", 800, 1, 8, 0)], None);
        try_insert(&mut connection, &old_sale).unwrap();
        // El Admin pasa el producto a 12 y el dispositivo sincroniza el catálogo.
        let mut changed = catalog_row("hamburguesa", "Hamburguesa", "UNIT", &[]);
        changed.branch_id = "branch".into();
        changed.pack_size_units = Some(12);
        changed.pack_config_id = Some("cfg-12".into());
        changed.price_per_kg_cents = "800".into(); // el precio del producto no cambia: sólo el pack
        let mut payload = pull(vec![changed], &[]);
        payload.branch_id = "branch".into();
        apply_catalog_pull_inner(&mut connection, &payload, "profile", "a@b.c").unwrap();
        // El pull de prueba trae una autorización ya vencida: se renueva como lo haría un pull real.
        connection.execute("update local_device set authorization_expires_at='2099-01-01T00:00:00Z'", []).unwrap();
        let outbox = serde_json::to_value(&old_sale).unwrap();
        assert_eq!((outbox["items"][0]["packConfigId"].clone(), outbox["items"][0]["packSizeUnitsSnapshot"].clone()), (serde_json::json!("cfg-8"), serde_json::json!(8)));
        // La venta nueva usa 12 (un pack de 12 × $8,00 = $96,00 − 20 % = $76,80).
        let new_sale = flex_payload(device_id.clone(), "CASH", vec![pack_line("hamburguesa", 800, 1, 12, 0)], None);
        try_insert(&mut connection, &new_sale).unwrap();
        assert_eq!(connection.query_row("select quantity_units, subtotal_cents, pack_size_units_snapshot, pack_config_id from local_sale_items order by rowid desc limit 1", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?))).unwrap(), (12, 7_680, 12, "cfg-12".to_string()));
        // Una línea armada con la versión vieja ya no la acepta este dispositivo (vende con el catálogo que tiene hoy).
        let stale = flex_payload(device_id, "CASH", vec![pack_line("hamburguesa", 800, 1, 8, 0)], None);
        assert!(try_insert(&mut connection, &stale).unwrap_err().contains("size does not match"));
    }
}
