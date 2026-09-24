"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "../../lib/supabase/server";
import { requireAdminContext } from "../../lib/admin";
import { parsePesosToCents } from "../../lib/settlements";
import { decimal, ids, kilogramsToGrams, optionalId, percentageToBasisPointsAllowZero, pesosToCents, text, unitsToInteger } from "../../lib/form-parsing";
import { buildSaveWeightDiscountArgs } from "../../lib/weight-discount-args";
import type { Database } from "@carnicerias/database";

function inventoryRole(formData: FormData): "RAW_MATERIAL" | "SELLABLE" | "BOTH" {
  const sellable = formData.get("is_sellable") === "on";
  const rawMaterial = formData.get("is_raw_material") === "on";
  if (rawMaterial && sellable) return "BOTH";
  if (rawMaterial) return "RAW_MATERIAL";
  return "SELLABLE";
}

function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function rpcOrThrow<Name extends keyof Database["public"]["Functions"]>(
  name: Name,
  args: Database["public"]["Functions"][Name]["Args"]
) {
  await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}

export interface BranchFormState { error?: string; branchId?: string }

export async function saveBranchFormAction(_: BranchFormState, formData: FormData): Promise<BranchFormState> {
  try {
    const branchId = await rpcOrThrow("save_branch", {
      p_branch_id: optionalId(formData, "branch_id"),
      p_name: text(formData, "name"),
      p_code: text(formData, "code"),
      p_address: text(formData, "address") || null,
      p_active: formData.get("active") === "on"
    });
    revalidatePath("/admin/branches");
    revalidatePath(`/admin/branches/${branchId}`);
    return { branchId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar la sucursal" };
  }
}

export async function setBranchActiveFormAction(_: BranchFormState, formData: FormData): Promise<BranchFormState> {
  const branchId = text(formData, "branch_id");
  try {
    await rpcOrThrow("set_branch_active", { p_branch_id: branchId, p_active: formData.get("active") === "on" });
    revalidatePath("/admin/branches");
    revalidatePath(`/admin/branches/${branchId}`);
    return { branchId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo cambiar el estado de la sucursal", branchId };
  }
}

export async function deleteBranchFormAction(_: BranchFormState, formData: FormData): Promise<BranchFormState> {
  const branchId = text(formData, "branch_id");
  try {
    await rpcOrThrow("delete_branch", { p_branch_id: branchId });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo eliminar la sucursal", branchId };
  }
  revalidatePath("/admin/branches");
  redirect("/admin/branches");
}

export async function saveCategoryAction(formData: FormData) {
  const name = text(formData, "name");
  await rpcOrThrow("save_category", {
    p_category_id: optionalId(formData, "category_id"), p_name: name,
    p_slug: text(formData, "slug") || slugify(name),
    p_sort_order: Number(text(formData, "sort_order") || 0),
    p_active: formData.get("active") === "on",
    p_color_hex: text(formData, "color_hex") || null
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/admin/products");
}

export async function saveProductAction(formData: FormData) {
  const name = text(formData, "name");
  await rpcOrThrow("save_product", {
    p_product_id: optionalId(formData, "product_id"), p_category_id: text(formData, "category_id"),
    p_name: name, p_slug: text(formData, "slug") || slugify(name), p_sku: text(formData, "sku"),
    p_unit_type: text(formData, "unit_type") as "WEIGHT" | "UNIT",
    p_active: formData.get("active") === "on"
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/admin/products");
}

export interface ProductManageState { error?: string; successToken?: string }

export async function manageProductAction(_: ProductManageState, formData: FormData): Promise<ProductManageState> {
  try {
    const name = text(formData, "name");
    const productId = text(formData, "product_id");
    await rpcOrThrow("save_product", {
      p_product_id: productId, p_category_id: text(formData, "category_id"),
      p_name: name, p_slug: text(formData, "slug") || slugify(name), p_sku: text(formData, "sku"),
      p_unit_type: text(formData, "unit_type") as "WEIGHT" | "UNIT",
      p_active: formData.get("active") === "on"
    });
    await rpcOrThrow("set_product_inventory_role", { p_product_id: productId, p_inventory_role: inventoryRole(formData) });
    // Categoría principal + adicionales en una sola llamada transaccional: set_product_categories
    // agrega la principal si faltara en el set marcado, así el formulario no tiene que forzar el
    // checkbox de la categoría principal para que quede coherente.
    await rpcOrThrow("set_product_categories", {
      p_product_id: productId, p_primary_category_id: text(formData, "category_id"),
      p_category_ids: ids(formData, "category_ids")
    });

    // Precio de venta = decisión manual: se guarda directo, nunca derivado de costo+margen. Sólo
    // escribe si cambió respecto al valor vigente (hidden input), igual que el patrón anterior.
    const rawPrice = text(formData, "price");
    if (rawPrice) {
      const priceCents = pesosToCents(rawPrice);
      if (priceCents !== Number(text(formData, "current_price_cents") || 0)) {
        await rpcOrThrow("set_product_price", { p_product_id: productId, p_branch_id: null, p_price_cents: priceCents });
      }
    }
    // Costo directo (productos comprados ya terminados, no producidos por desposte). Un producto
    // producido por desposte tiene su costo alimentado automáticamente al finalizar el lote; este
    // campo permite corregirlo o cargarlo a mano para lo que no sale de desposte.
    const rawDirectCost = text(formData, "direct_cost");
    if (rawDirectCost) {
      const costCents = pesosToCents(rawDirectCost);
      if (costCents !== Number(text(formData, "current_cost_cents") || 0)) {
        await rpcOrThrow("set_product_cost", { p_product_id: productId, p_cost_cents: costCents });
      }
    }

    revalidatePath("/admin/catalog");
    revalidatePath("/admin/products");
    revalidatePath("/admin/promotions");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar el producto" };
  }
}

export interface ProductModalState { error?: string; success?: boolean }

export async function createProductModalAction(_: ProductModalState, formData: FormData): Promise<ProductModalState> {
  try {
    const name = text(formData, "name");
    const role = inventoryRole(formData);
    const rawPrice = text(formData, "price");
    const rawDirectCost = text(formData, "direct_cost");
    // A pure raw material (Desposte input, never sold directly) has no list price to form: its
    // cost is captured per Desposte batch instead. Any sellable role still needs a manual price.
    if (role !== "RAW_MATERIAL" && !rawPrice) throw new Error("Completá el precio de venta");
    // create_product_with_pricing (202609130012) is called purely as "create the product row"
    // here: cost/markup are always omitted, so its optional save_product_pricing branch never
    // fires — this sprint's manual price/cost are set separately right below, never derived.
    const productId = await rpcOrThrow("create_product_with_pricing", {
      p_category_id: text(formData, "category_id"), p_name: name,
      p_slug: text(formData, "slug") || slugify(name), p_sku: text(formData, "sku"),
      p_unit_type: text(formData, "unit_type") as "WEIGHT" | "UNIT", p_active: formData.get("active") === "on"
    });
    await rpcOrThrow("set_product_inventory_role", { p_product_id: productId, p_inventory_role: role });
    await rpcOrThrow("set_product_categories", {
      p_product_id: productId, p_primary_category_id: text(formData, "category_id"),
      p_category_ids: ids(formData, "category_ids")
    });
    if (rawPrice) await rpcOrThrow("set_product_price", { p_product_id: productId, p_branch_id: null, p_price_cents: pesosToCents(rawPrice) });
    if (rawDirectCost) await rpcOrThrow("set_product_cost", { p_product_id: productId, p_cost_cents: pesosToCents(rawDirectCost) });
    revalidatePath("/admin/products");
    revalidatePath("/admin/catalog");
    revalidatePath("/admin/promotions");
    return { success: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo crear el producto" };
  }
}

export interface PricingSettingsState { error?: string; successToken?: string }
export async function saveCashDiscountAction(_: PricingSettingsState, formData: FormData): Promise<PricingSettingsState> {
  try {
    // set_cash_discount (202609220030) only writes the percentage — it never repriced any
    // product, unlike set_cash_discount_and_reprice (left untouched in the database, unused by
    // this UI): a manual price must never change on its own when this percentage changes. Kept
    // under its legacy name (see D-044): it now configures the card surcharge percentage, not a
    // cash discount — CASH/TRANSFER/OTHER get no adjustment at all, DEBIT/CREDIT pay list price
    // plus this percentage.
    await rpcOrThrow("set_cash_discount", {
      p_cash_discount_bps: percentageToBasisPointsAllowZero(text(formData, "cash_discount"), "Recargo por tarjeta", 9_999n)
    });
    revalidatePath("/admin/products");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo actualizar la configuración" };
  }
}

export async function setPriceAction(formData: FormData) {
  const closeOverride = formData.get("close_override") === "on";
  await rpcOrThrow("set_product_price", {
    p_product_id: text(formData, "product_id"), p_branch_id: optionalId(formData, "branch_id"),
    p_price_cents: closeOverride ? null : pesosToCents(text(formData, "price")),
    p_effective_at: text(formData, "effective_at") ? new Date(text(formData, "effective_at")).toISOString() : new Date().toISOString()
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/admin/products");
}

export interface BulkPriceState { error?: string; successToken?: string; applied?: number }

/**
 * Carga masiva de "Productos → Precios": recibe sólo las filas que el cliente marcó como
 * modificadas (ver bulk-price-editor.tsx) y las aplica en una única llamada atómica a
 * bulk_set_product_prices (202609220030) — precio global (sin sucursal) para esta primera carga;
 * los overrides por sucursal existentes siguen editables uno por uno vía setPriceAction.
 */
export async function bulkSetProductPricesAction(_: BulkPriceState, formData: FormData): Promise<BulkPriceState> {
  try {
    const raw = text(formData, "items");
    const items = raw ? (JSON.parse(raw) as { productId: string; priceCents: number }[]) : [];
    if (!items.length) throw new Error("No hay cambios para guardar");
    const result = await rpcOrThrow("bulk_set_product_prices", { p_items: items });
    revalidatePath("/admin/products");
    const applied = result && typeof result === "object" && "applied" in result ? Number((result as { applied: unknown }).applied) : items.length;
    return { successToken: crypto.randomUUID(), applied };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudieron guardar los precios" };
  }
}

async function commercialRpc(name: string, args: Record<string, unknown>) {
  await requireAdminContext();
  const supabase = await createClient();
  const client = supabase as unknown as { rpc: (rpcName: string, rpcArgs: Record<string, unknown>) => Promise<{ error: { message: string } | null }> };
  const { error } = await client.rpc(name, args);
  if (error) throw new Error(error.message);
}

async function saveWeightDiscount(formData: FormData) {
  // See weight-discount-args.ts for why every call must always name all 13 parameters
  // of save_weight_discount (the database has two overloads; PostgREST resolves them by
  // the exact set of parameter names in the request body).
  await commercialRpc("save_weight_discount", { ...buildSaveWeightDiscountArgs(formData) });
  revalidatePath("/admin/catalog");
  revalidatePath("/admin/promotions");
  revalidatePath("/admin/products");
}

export async function saveWeightDiscountAction(formData: FormData) {
  await saveWeightDiscount(formData);
}

export interface PromotionFormState { error?: string; successToken?: string }

export async function saveWeightDiscountFormAction(_: PromotionFormState, formData: FormData): Promise<PromotionFormState> {
  try {
    await saveWeightDiscount(formData);
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar la promoción" };
  }
}

export async function saveAnnouncementAction(formData: FormData) {
  await commercialRpc("save_announcement", {
    p_id: optionalId(formData, "announcement_id"), p_branch_id: optionalId(formData, "branch_id"), p_title: text(formData, "title"), p_message: text(formData, "message"),
    p_type: text(formData, "type"), p_priority: Number(text(formData, "priority") || 0), p_active: formData.get("active") === "on",
    p_starts_at: text(formData, "starts_at") ? new Date(text(formData, "starts_at")).toISOString() : new Date().toISOString(), p_ends_at: text(formData, "ends_at") ? new Date(text(formData, "ends_at")).toISOString() : null
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/admin/announcements");
}

export async function setStockPolicyAction(formData: FormData) {
  await rpcOrThrow("set_stock_policy", {
    p_branch_id: text(formData, "branch_id"), p_product_id: text(formData, "product_id"),
    p_minimum_stock_grams: kilogramsToGrams(text(formData, "minimum_kg")),
    p_target_stock_grams: kilogramsToGrams(text(formData, "target_kg"))
  });
  revalidatePath("/admin/stock");
}

export async function recordPurchaseAction(formData: FormData) {
  const productIds = formData.getAll("product_id").map(String);
  const items = productIds.flatMap((productId) => {
    const raw = text(formData, `quantity_${productId}`);
    return raw && decimal(raw, "Peso") > 0 ? [{ product_id: productId, quantity_grams: kilogramsToGrams(raw) }] : [];
  });
  await rpcOrThrow("record_stock_operation", {
    p_branch_id: text(formData, "branch_id"), p_operation_type: "PURCHASE", p_items: items,
    p_supplier: text(formData, "supplier"), p_note: text(formData, "note") || null
  });
  revalidatePath("/admin/stock");
}

export interface ReplenishmentFormState { error?: string; successToken?: string }

export async function recordReplenishmentFormAction(_: ReplenishmentFormState, formData: FormData): Promise<ReplenishmentFormState> {
  try {
    const context = await requireAdminContext();
    const supabase = await createClient();
    const productId = text(formData, "product_id");
    const { data: product, error: productError } = await supabase.from("products")
      .select("unit_type").eq("organization_id", context.organizationId).eq("id", productId).single();
    if (productError) throw new Error("Producto inválido para esta organización");
    const quantity = product.unit_type === "UNIT"
      ? unitsToInteger(text(formData, "quantity"))
      : kilogramsToGrams(text(formData, "quantity"));
    const { error } = await supabase.rpc("record_stock_operation", {
      p_branch_id: text(formData, "branch_id"), p_operation_type: "PURCHASE",
      p_items: [{ product_id: productId, quantity_grams: quantity }],
      p_supplier: null, p_note: text(formData, "note") || "Ingreso desde reposición"
    });
    if (error) throw new Error(error.message);
    revalidatePath("/admin/replenishment");
    revalidatePath("/admin/stock");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo registrar el ingreso" };
  }
}

export async function setReplenishmentTargetDaysFormAction(_: ReplenishmentFormState, formData: FormData): Promise<ReplenishmentFormState> {
  try {
    const targetDays = decimal(text(formData, "target_days"), "Objetivo de cobertura");
    if (targetDays <= 0 || targetDays > 30) throw new Error("El objetivo debe estar entre 0,01 y 30 días");
    await rpcOrThrow("set_replenishment_target_days", { p_target_days: targetDays });
    revalidatePath("/admin/replenishment");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar el objetivo" };
  }
}

export async function recordWasteAction(formData: FormData) {
  await rpcOrThrow("record_stock_operation", {
    p_branch_id: text(formData, "branch_id"), p_operation_type: "WASTE",
    p_items: [{ product_id: text(formData, "product_id"), quantity_grams: kilogramsToGrams(text(formData, "quantity_kg")) }],
    p_waste_reason: text(formData, "waste_reason"), p_note: text(formData, "note") || null
  });
  revalidatePath("/admin/stock");
}

export async function recordAdjustmentAction(formData: FormData) {
  await rpcOrThrow("record_stock_operation", {
    p_branch_id: text(formData, "branch_id"), p_operation_type: "ADJUSTMENT",
    p_items: [{ product_id: text(formData, "product_id"), physical_quantity_grams: kilogramsToGrams(text(formData, "physical_kg"), true) }],
    p_note: text(formData, "note") || null
  });
  revalidatePath("/admin/stock");
}

export interface StockAdjustmentState { error?: string; successToken?: string }

export async function recordAdjustmentFormAction(_: StockAdjustmentState, formData: FormData): Promise<StockAdjustmentState> {
  try {
    await recordAdjustmentAction(formData);
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo registrar el ajuste" };
  }
}

export async function manageMemberAction(formData: FormData) {
  await rpcOrThrow("manage_existing_member", {
    p_email: text(formData, "email"), p_display_name: text(formData, "display_name"),
    p_role_key: text(formData, "role_key"), p_branch_id: optionalId(formData, "branch_id"),
    p_status: text(formData, "status") as "INVITED" | "ACTIVE" | "DISABLED"
  });
  revalidatePath("/admin/employees");
}

export async function createPosEmployeeAction(formData: FormData) {
  const pin = text(formData, "pin");
  if (!/^\d{4,6}$/.test(pin)) throw new Error("El PIN debe tener entre 4 y 6 dígitos");
  await rpcOrThrow("create_pos_employee", {
    p_display_name: text(formData, "display_name"),
    p_pin: pin,
    p_branch_ids: ids(formData, "branch_ids"),
    p_rate_cents_per_hour: parsePesosToCents(text(formData, "rate")),
    p_rate_valid_from_local: text(formData, "rate_valid_from"),
    p_status: text(formData, "status") as "ACTIVE" | "DISABLED"
  });
  revalidatePath("/admin/employees");
  revalidatePath("/admin/timekeeping");
}

export async function updatePosEmployeeAction(formData: FormData) {
  await rpcOrThrow("update_pos_employee", {
    p_employee_id: text(formData, "employee_id"),
    p_display_name: text(formData, "display_name"),
    p_branch_ids: ids(formData, "branch_ids"),
    p_status: text(formData, "status") as "INVITED" | "ACTIVE" | "DISABLED"
  });
  revalidatePath("/admin/employees");
  revalidatePath("/admin/timekeeping");
}

export async function setEmployeePinAction(formData: FormData) {
  const pin = text(formData, "pin");
  if (!/^\d{4,6}$/.test(pin)) throw new Error("El PIN debe tener entre 4 y 6 dígitos");
  await rpcOrThrow("set_employee_pos_pin", { p_profile_id: text(formData, "profile_id"), p_pin: pin });
  revalidatePath("/admin/employees");
}

export async function setHourlyRateAction(formData: FormData) {
  await rpcOrThrow("set_employee_hourly_rate", {
    p_employee_id: text(formData, "employee_id"),
    p_rate_cents_per_hour: parsePesosToCents(text(formData, "rate")),
    p_valid_from_local: text(formData, "valid_from")
  });
  revalidatePath("/admin/timekeeping");
  revalidatePath("/admin/employees");
}

export async function correctShiftAction(formData: FormData) {
  await rpcOrThrow("correct_employee_shift", {
    p_shift_id: text(formData, "shift_id"),
    p_clock_out_local: text(formData, "clock_out_at"),
    p_reason: text(formData, "reason")
  });
  revalidatePath("/admin/timekeeping");
}

export async function setMaxShiftHoursAction(formData: FormData) {
  const hours = Number(text(formData, "hours"));
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new Error("La duración debe estar entre 1 y 24 horas");
  await rpcOrThrow("set_timekeeping_max_shift_hours", { p_hours: hours });
  revalidatePath("/admin/timekeeping");
}

export async function setDeviceStatusAction(formData: FormData) {
  await rpcOrThrow("set_pos_device_status", {
    p_device_id: text(formData, "device_id"),
    p_status: text(formData, "status") as "ACTIVE" | "DISABLED"
  });
  revalidatePath("/admin/devices");
}

export async function cancelSaleAction(formData: FormData) {
  await rpcOrThrow("cancel_sale", {
    p_sale_id: text(formData, "sale_id"), p_idempotency_key: text(formData, "idempotency_key"),
    p_reason: text(formData, "reason")
  });
  revalidatePath("/admin/sales");
  revalidatePath("/admin");
}

export interface SettlementFormState { error?: string; settlementId?: string }

export async function confirmSettlementFormAction(_: SettlementFormState, formData: FormData): Promise<SettlementFormState> {
  try {
    const settlementId = await rpcOrThrow("confirm_settlement", {
      p_branch_id: text(formData, "branch_id"),
      p_period_start_local: text(formData, "period_start"),
      p_period_end_local: text(formData, "period_end"),
      p_received_cash_cents: parsePesosToCents(text(formData, "received_cash")),
      p_notes: text(formData, "notes") || null
    });
    revalidatePath("/admin/settlements");
    revalidatePath("/admin/audit");
    return { settlementId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo confirmar la rendición" };
  }
}

export async function voidSettlementFormAction(_: SettlementFormState, formData: FormData): Promise<SettlementFormState> {
  try {
    const settlementId = text(formData, "settlement_id");
    await rpcOrThrow("void_settlement", { p_settlement_id: settlementId, p_reason: text(formData, "reason") });
    revalidatePath("/admin/settlements");
    revalidatePath("/admin/audit");
    return { settlementId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo anular la rendición" };
  }
}

export interface ProductionBatchFormState { error?: string; batchId?: string }

function optionalUnitCount(formData: FormData): number | undefined {
  const raw = text(formData, "input_unit_count");
  return raw ? unitsToInteger(raw) : undefined;
}

export async function createProductionBatchFormAction(_: ProductionBatchFormState, formData: FormData): Promise<ProductionBatchFormState> {
  try {
    const inputUnitCount = optionalUnitCount(formData);
    const description = text(formData, "description");
    const notes = text(formData, "notes");
    // No p_branch_id: the batch always lands in the organization's configured production branch
    // (normally Central). Fran never picks a branch here — see SetProductionBranchForm for the
    // one place that default is configured. exactOptionalPropertyTypes rejects an explicit
    // `undefined` for an optional key, so these are omitted entirely when empty.
    const batchId = await rpcOrThrow("create_production_batch", {
      p_source_product_id: text(formData, "source_product_id"),
      p_input_weight_grams: kilogramsToGrams(text(formData, "input_weight_kg")),
      p_cost_per_kg_cents: pesosToCents(text(formData, "cost_per_kg")),
      ...(inputUnitCount !== undefined ? { p_input_unit_count: inputUnitCount } : {}),
      ...(description ? { p_description: description } : {}),
      ...(notes ? { p_notes: notes } : {})
    });
    revalidatePath("/admin/production");
    return { batchId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo crear el desposte" };
  }
}

export async function updateProductionBatchHeaderFormAction(_: ProductionBatchFormState, formData: FormData): Promise<ProductionBatchFormState> {
  const batchId = text(formData, "batch_id");
  try {
    const inputUnitCount = optionalUnitCount(formData);
    const description = text(formData, "description");
    const notes = text(formData, "notes");
    await rpcOrThrow("update_production_batch_header", {
      p_batch_id: batchId,
      p_source_product_id: text(formData, "source_product_id"),
      p_input_weight_grams: kilogramsToGrams(text(formData, "input_weight_kg")),
      p_cost_per_kg_cents: pesosToCents(text(formData, "cost_per_kg")),
      ...(inputUnitCount !== undefined ? { p_input_unit_count: inputUnitCount } : {}),
      ...(description ? { p_description: description } : {}),
      ...(notes ? { p_notes: notes } : {})
    });
    revalidatePath("/admin/production");
    return { batchId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo actualizar el desposte", batchId };
  }
}

export async function setProductionBatchOutputFormAction(_: ProductionBatchFormState, formData: FormData): Promise<ProductionBatchFormState> {
  const batchId = text(formData, "batch_id");
  try {
    // Weight is always required (real physical weight produced, feeds merma/rendimiento for every
    // output, WEIGHT or UNIT alike). Quantity is additional and only present for a UNIT product's
    // output (the form only renders that second input then) — omitted entirely otherwise, rather
    // than sent as null, matching the pattern used elsewhere in this file.
    const rawUnits = text(formData, "output_quantity_units");
    await rpcOrThrow("set_production_batch_output", {
      p_batch_id: batchId,
      p_product_id: text(formData, "product_id"),
      p_output_weight_grams: kilogramsToGrams(text(formData, "output_weight_kg")),
      ...(rawUnits ? { p_output_quantity_units: unitsToInteger(rawUnits) } : {})
    });
    revalidatePath("/admin/production");
    return { batchId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo agregar el producto obtenido", batchId };
  }
}

export async function removeProductionBatchOutputAction(formData: FormData) {
  await rpcOrThrow("remove_production_batch_output", { p_output_id: text(formData, "output_id") });
  revalidatePath("/admin/production");
}

export async function cancelProductionBatchAction(formData: FormData) {
  await rpcOrThrow("cancel_production_batch", { p_batch_id: text(formData, "batch_id") });
  revalidatePath("/admin/production");
}

export async function completeProductionBatchFormAction(_: ProductionBatchFormState, formData: FormData): Promise<ProductionBatchFormState> {
  const batchId = text(formData, "batch_id");
  try {
    await rpcOrThrow("complete_production_batch", { p_batch_id: batchId });
    revalidatePath("/admin/production");
    return { batchId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo finalizar el desposte", batchId };
  }
}

export async function deleteProductionBatchAction(formData: FormData) {
  await rpcOrThrow("delete_production_batch", { p_batch_id: text(formData, "batch_id") });
  revalidatePath("/admin/production");
  redirect("/admin/production");
}

export interface ProductionBranchFormState { error?: string; successToken?: string }

export async function setProductionBranchFormAction(_: ProductionBranchFormState, formData: FormData): Promise<ProductionBranchFormState> {
  try {
    await rpcOrThrow("set_production_branch", { p_branch_id: text(formData, "branch_id") });
    revalidatePath("/admin/production");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar la sucursal de producción" };
  }
}

export interface StockTransferFormState { error?: string; transferId?: string }

export async function createStockTransferFormAction(_: StockTransferFormState, formData: FormData): Promise<StockTransferFormState> {
  try {
    const productIds = formData.getAll("product_id").map(String);
    const quantities = formData.getAll("quantity_kg").map(String);
    const items = productIds
      .map((productId, index) => ({ productId, quantityRaw: quantities[index] ?? "" }))
      .filter((row) => row.productId)
      .map((row) => ({ product_id: row.productId, quantity_grams: kilogramsToGrams(row.quantityRaw) }));
    if (!items.length) throw new Error("Agregá al menos un producto para transferir");
    const notes = text(formData, "notes");

    const transferId = await rpcOrThrow("create_stock_transfer", {
      p_source_branch_id: text(formData, "source_branch_id"),
      p_destination_branch_id: text(formData, "destination_branch_id"),
      p_items: items,
      ...(notes ? { p_notes: notes } : {})
    });
    revalidatePath("/admin/transfers");
    revalidatePath("/admin/stock");
    revalidatePath("/admin/branch-stock");
    return { transferId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo registrar la transferencia" };
  }
}
