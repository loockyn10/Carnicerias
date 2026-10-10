"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "../../lib/supabase/server";
import { requireAdminContext } from "../../lib/admin";
import { parsePesosToCents } from "../../lib/settlements";
import { decimal, ids, kilogramsToGrams, optionalId, parseBarcodes, pesosToCents, text, unitsToInteger } from "../../lib/form-parsing";
import { parseStockQuantityInput } from "@carnicerias/business-logic";
import { buildCarryPlanReport, type CarryPlanReport } from "../../lib/carry-plan";
import { toProductActivity, type ProductModalData } from "../../lib/product-insight";
import { parseStockAuditSummary, periodRpcArgs } from "../../lib/stock-audit";
import { isUuid } from "../../lib/uuid";
import { isIsoDate } from "../../lib/date-range";
import { parseCompleteOutcome, parseMissingCosts, type CompleteMissingCostsOutcome, type MissingCostsReport } from "../../lib/missing-costs";
import { parseOperatingCosts, type OperatingCostsReport } from "../../lib/operating-costs";
import { buildSaveWeightDiscountArgs } from "../../lib/weight-discount-args";
import { MAX_BULK_DEACTIVATE, normalizeProductIds } from "../../lib/product-selection";
import { parseCurrentPackSize, parsePackSizeUnits } from "../../lib/unit-promotions";
import { resolveNewProductPricing } from "../../lib/new-product-pricing";
import { isRequestKey, parseBulkItems, toReceiptRpcItems, type ReceiptProductInfo } from "../../lib/bulk-costs";
import { MAX_QUICK_ITEMS, parseQuickOutcome, type QuickApplyItem, type QuickStockOutcome, type QuickStockRow, type QuickStockSearchResult } from "../../lib/quick-stock";
import { parsePricingRowsPage, PRICING_PAGE_SIZE, type PricingRow, type PricingRowsPage } from "../../lib/pricing-rows";
import { parseCurrentCustomMargin, parseCustomMarginForm } from "../../lib/product-margin";
import { parseExcludedCategoryIds, parsePricingConfigForm, parsePricingConfigOutcome, type PricingConfigOutcome } from "../../lib/pricing-config";
import type { Database, Json } from "@carnicerias/database";

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
    // A NEW branch starts with an empty assortment; optionally copy another branch's (additive).
    const copyFrom = !optionalId(formData, "branch_id") ? optionalId(formData, "copy_assortment_from") : null;
    if (copyFrom) await rpcOrThrow("copy_branch_assortment", { p_source_branch_id: copyFrom, p_destination_branch_id: branchId });
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

/** Margen global vigente de la organización (basis points), o null si todavía no se configuró. */
async function currentMarginBps(): Promise<number | null> {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.from("organization_pricing_settings").select("margin_bps").eq("organization_id", context.organizationId).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.margin_bps ?? null;
}

/** ¿La categoría está excluida del margen automático (D-069)? Sus productos conservan el precio manual aunque tengan costo y haya margen. */
async function isCategoryExcludedFromMargin(categoryId: string): Promise<boolean> {
  if (!categoryId) return false;
  const context = await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.from("organization_pricing_excluded_categories").select("category_id")
    .eq("organization_id", context.organizationId).eq("category_id", categoryId).maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
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

export interface ProductManageState { error?: string; successToken?: string; warning?: string }

/** Branches where the product is enabled (surtido) and its barcodes, from the product form. Returns
 * a warning when a branch stopped carrying a product that still has stock there. */
async function saveProductBranchesAndBarcodes(productId: string, formData: FormData): Promise<string | undefined> {
  const result = await rpcOrThrow("set_product_branches", { p_product_id: productId, p_branch_ids: ids(formData, "branch_ids") });
  await rpcOrThrow("set_product_barcodes", { p_product_id: productId, p_barcodes: parseBarcodes(text(formData, "barcodes")) });
  const withStock = (result as { disabledWithStock?: unknown[] } | null)?.disabledWithStock;
  return Array.isArray(withStock) && withStock.length > 0
    ? `Este producto todavía tiene stock en ${String(withStock.length)} sucursal${withStock.length === 1 ? "" : "es"} donde ya no se vende. El stock se conserva, pero no aparece en el POS de esas sucursales.`
    : undefined;
}

/** Proveedor principal (opcional) de la ficha del producto: vacío = sin proveedor. Sólo llama al servidor si cambió. */
async function savePrimarySupplier(productId: string, formData: FormData): Promise<void> {
  if (!formData.has("supplier_id")) return;
  const supplierId = optionalId(formData, "supplier_id");
  if (supplierId === optionalId(formData, "current_supplier_id")) return;
  await rpcOrThrow("set_product_primary_supplier", { p_product_id: productId, p_supplier_id: supplierId });
}

export async function manageProductAction(_: ProductManageState, formData: FormData): Promise<ProductManageState> {
  try {
    const name = text(formData, "name");
    const productId = text(formData, "product_id");
    // Margen personalizado (D-070): se valida ANTES de escribir nada. `undefined` = el formulario no trae el selector (no se toca).
    const wantedCustomMargin = formData.has("margin_mode") ? parseCustomMarginForm(formData) : undefined;
    const currentCustomMargin = parseCurrentCustomMargin(text(formData, "current_custom_margin_bps"));
    // Pack (sólo productos por unidad): SÓLO las unidades por pack (vacío = sin pack). El descuento del pack ya no es del producto: sale
    // de la configuración global de precios (D-068), así que este formulario no lo envía. Quitar el pack va ANTES de guardar el producto
    // (si pasa a «por kg» no puede conservarlo); fijarlo va DESPUÉS (el producto tiene que ser por unidad ya). Cambiar las unidades abre
    // una versión nueva del pack en el servidor. No es una promoción ni toca precios.
    const wantedPackSize = text(formData, "unit_type") === "UNIT" ? parsePackSizeUnits(text(formData, "pack_size_units")) : null;
    const currentPackSize = parseCurrentPackSize(text(formData, "current_pack_size_units"));
    if (wantedPackSize === null && currentPackSize !== null) {
      await rpcOrThrow("set_product_pack_size", { p_product_id: productId, p_pack_size_units: null });
    }
    await rpcOrThrow("save_product", {
      p_product_id: productId, p_category_id: text(formData, "category_id"),
      p_name: name, p_slug: text(formData, "slug") || slugify(name), p_sku: text(formData, "sku"),
      p_unit_type: text(formData, "unit_type") as "WEIGHT" | "UNIT",
      p_active: formData.get("active") === "on"
    });
    if (wantedPackSize !== null && wantedPackSize !== currentPackSize) {
      await rpcOrThrow("set_product_pack_size", { p_product_id: productId, p_pack_size_units: wantedPackSize });
    }
    await rpcOrThrow("set_product_inventory_role", { p_product_id: productId, p_inventory_role: inventoryRole(formData) });
    // Una sola categoría por producto: la que guarda save_product (products.category_id). No hay categorías adicionales.

    // Costo directo (productos comprados ya terminados, no producidos por desposte). Un producto
    // producido por desposte tiene su costo alimentado automáticamente al finalizar el lote; este
    // campo permite corregirlo o cargarlo a mano para lo que no sale de desposte. Con margen efectivo (propio o global),
    // guardar un costo nuevo recalcula el precio de lista en la misma operación (D-068 / D-070).
    const rawDirectCost = text(formData, "direct_cost");
    const costToSave = rawDirectCost && pesosToCents(rawDirectCost) !== Number(text(formData, "current_cost_cents") || 0) ? pesosToCents(rawDirectCost) : null;
    // Margen personalizado (D-070): se guarda ANTES del costo, así un costo nuevo en la misma edición ya se forma con el margen nuevo. Si además
    // se guarda un costo, el margen no reprecia por su cuenta (el costo lo hace una sola vez). Poner/quitar el margen reprecia ese producto.
    if (wantedCustomMargin !== undefined && wantedCustomMargin !== currentCustomMargin) {
      await rpcOrThrow("set_product_custom_margin", { p_product_id: productId, p_margin_bps: wantedCustomMargin, p_reprice: costToSave === null });
    }
    if (costToSave !== null) {
      await rpcOrThrow("set_product_cost", { p_product_id: productId, p_cost_cents: costToSave });
    }
    // Precio de lista escrito a mano: sólo es el FALLBACK cuando el precio no puede derivarse (sin costo o sin margen efectivo, o
    // producto inactivo / materia prima). Con costo y margen el precio se forma desde el costo y un precio escrito no gana (el formulario
    // ni lo envía). Sólo se escribe si el admin lo CAMBIÓ respecto al vigente.
    const rawPrice = text(formData, "price");
    const costKnown = Boolean(rawDirectCost) || Number(text(formData, "current_cost_cents") || 0) > 0;
    // Margen efectivo (D-070): el propio gana siempre; si no hay, una categoría excluida (D-069, carnicería) no deriva el precio y sin margen
    // global tampoco. Si el formulario no trae el selector, vale el margen propio que ya tenía el producto.
    const hasCustomMargin = (wantedCustomMargin === undefined ? currentCustomMargin : wantedCustomMargin) !== null;
    const derivedPrice = costKnown && inventoryRole(formData) !== "RAW_MATERIAL" && formData.get("active") === "on"
      && (hasCustomMargin || ((await currentMarginBps()) !== null && !(await isCategoryExcludedFromMargin(text(formData, "category_id")))));
    if (rawPrice && !derivedPrice) {
      const priceCents = pesosToCents(rawPrice);
      if (priceCents !== Number(text(formData, "current_price_cents") || 0)) {
        await rpcOrThrow("set_product_price", { p_product_id: productId, p_branch_id: null, p_price_cents: priceCents });
      }
    }

    const warning = await saveProductBranchesAndBarcodes(productId, formData);
    await savePrimarySupplier(productId, formData);

    revalidatePath("/admin/catalog");
    revalidatePath("/admin/products");
    revalidatePath("/admin/promotions");
    revalidatePath("/admin/suppliers");
    return { successToken: crypto.randomUUID(), ...(warning ? { warning } : {}) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar el producto" };
  }
}

export interface BulkDeactivateState { error?: string; deactivated?: number; alreadyInactive?: number }

/**
 * Desactivación masiva desde /admin/products. NO borra nada: una sola llamada atómica a
 * `deactivate_products` (202610060064), que aplica la misma semántica que la acción individual
 * (`save_product` con active = false) a todos los ids. Si falla, no se desactiva ninguno.
 */
export async function deactivateProductsAction(productIds: string[]): Promise<BulkDeactivateState> {
  const ids = normalizeProductIds(productIds);
  if (!ids) return { error: `Seleccioná entre 1 y ${String(MAX_BULK_DEACTIVATE)} productos para desactivar.` };
  try {
    const result = await rpcOrThrow("deactivate_products", { p_product_ids: ids }) as { deactivated?: number; alreadyInactive?: number } | null;
    revalidatePath("/admin/catalog");
    revalidatePath("/admin/products");
    revalidatePath("/admin/promotions");
    revalidatePath("/admin/suppliers");
    return { deactivated: result?.deactivated ?? ids.length, alreadyInactive: result?.alreadyInactive ?? 0 };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudieron desactivar los productos" };
  }
}

export interface ProductModalState { error?: string; success?: boolean }

export async function createProductModalAction(_: ProductModalState, formData: FormData): Promise<ProductModalState> {
  try {
    const name = text(formData, "name");
    const role = inventoryRole(formData);
    const rawPrice = text(formData, "price");
    const rawDirectCost = text(formData, "direct_cost");
    // Una materia prima pura (insumo de Desposte, nunca se vende directo) no tiene precio de lista: su costo se registra en cada desposte.
    // Un producto de venta necesita precio, pero NO hace falta escribirlo si hay un costo válido y un margen global configurado: entonces
    // lo forma el servidor (D-068, misma función que set_product_cost). Sin margen o sin costo hace falta el precio manual: si no se puede
    // formar ningún precio, el error dice por qué y NO se crea nada.
    const pricing = resolveNewProductPricing({
      sellable: role !== "RAW_MATERIAL", active: formData.get("active") === "on", marginBps: await currentMarginBps(), costRaw: rawDirectCost, priceRaw: rawPrice,
      // Categoría excluida del margen automático (D-069): el costo se guarda igual, pero el precio se escribe a mano.
      excludedCategory: await isCategoryExcludedFromMargin(text(formData, "category_id"))
    });
    // create_product_with_pricing (202609130012) is called purely as "create the product row"
    // here: cost/markup are always omitted, so its optional save_product_pricing branch never
    // fires — the cost (which derives the price when there is a margin) and the manual price are set separately right below.
    const productId = await rpcOrThrow("create_product_with_pricing", {
      p_category_id: text(formData, "category_id"), p_name: name,
      p_slug: text(formData, "slug") || slugify(name), p_sku: text(formData, "sku"),
      p_unit_type: text(formData, "unit_type") as "WEIGHT" | "UNIT", p_active: formData.get("active") === "on"
    });
    await rpcOrThrow("set_product_inventory_role", { p_product_id: productId, p_inventory_role: role });
    // El costo se guarda primero (con el margen global configurado deriva el precio: pricing === "DERIVED"); el precio escrito a mano sólo se
    // usa como fallback (pricing === "MANUAL": sin costo o sin margen) y NUNCA le gana a costo + margen.
    if (rawDirectCost) await rpcOrThrow("set_product_cost", { p_product_id: productId, p_cost_cents: pesosToCents(rawDirectCost) });
    if (pricing === "MANUAL") await rpcOrThrow("set_product_price", { p_product_id: productId, p_branch_id: null, p_price_cents: pesosToCents(rawPrice) });
    await saveProductBranchesAndBarcodes(productId, formData);
    await savePrimarySupplier(productId, formData);
    revalidatePath("/admin/products");
    revalidatePath("/admin/catalog");
    revalidatePath("/admin/promotions");
    revalidatePath("/admin/suppliers");
    return { success: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo crear el producto" };
  }
}

// ---- Proveedores -----------------------------------------------------------------------------
export interface SupplierFormState { error?: string; successToken?: string }

/** Alta o edición. Sólo el nombre es obligatorio; el resto vacío = sin dato. Duplicados (nombre o código) los rechaza el servidor. */
export async function saveSupplierFormAction(_: SupplierFormState, formData: FormData): Promise<SupplierFormState> {
  try {
    await rpcOrThrow("save_supplier", {
      p_supplier_id: optionalId(formData, "supplier_id"),
      p_name: text(formData, "name"),
      p_code: text(formData, "code") || null,
      p_tax_id: text(formData, "tax_id") || null,
      p_phone: text(formData, "phone") || null,
      p_email: text(formData, "email") || null,
      p_notes: text(formData, "notes") || null,
      p_active: formData.get("active") === "on"
    });
    revalidatePath("/admin/suppliers");
    revalidatePath("/admin/products");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar el proveedor" };
  }
}

/** Activar / desactivar (un proveedor no se borra: conserva sus productos y su historial). */
export async function setSupplierActiveFormAction(_: SupplierFormState, formData: FormData): Promise<SupplierFormState> {
  try {
    await rpcOrThrow("set_supplier_active", { p_supplier_id: text(formData, "supplier_id"), p_active: formData.get("active") === "on" });
    revalidatePath("/admin/suppliers");
    revalidatePath("/admin/products");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo cambiar el estado del proveedor" };
  }
}

export interface PricingConfigState {
  error?: string;
  successToken?: string;
  /** Firma de los valores del formulario con los que se pidió (la UI sólo muestra la vista previa si siguen siendo los mismos). */
  signature?: string;
  /** Margen cambiado sin confirmar: no se escribió nada; cuántos precios se recalcularían. */
  preview?: PricingConfigOutcome;
  result?: PricingConfigOutcome;
}

/**
 * Guarda la configuración global de precios (margen, descuentos por cantidad con escalones, dto por pack, recargo por tarjeta) con UNA llamada atómica a
 * save_pricing_config (202610060065). Cambiar el margen recalcula los precios de lista de todos los productos con costo (en el
 * servidor, nunca en el navegador), así que sin confirmación el servidor sólo devuelve la vista previa y no escribe nada.
 * El recargo por tarjeta conserva su nombre histórico en la base (cash_discount_bps, D-044): CASH/TRANSFER/OTHER no tienen ajuste.
 */
export async function savePricingConfigAction(_: PricingConfigState, formData: FormData): Promise<PricingConfigState> {
  const signature = text(formData, "signature");
  try {
    const input = parsePricingConfigForm(formData);
    // Categorías excluidas del margen automático (D-069): por ID. Si el formulario no mandó la lista (null) el servidor la deja como está.
    const excluded = parseExcludedCategoryIds(formData);
    const data = await rpcOrThrow("save_pricing_config", {
      p_margin_bps: input.marginBps, p_unit_bulk_discount_bps: input.unitBulkDiscountBps,
      // Descuentos por cantidad (D-083): la lista completa de escalones; el servidor la valida y la materializa en cada sucursal.
      p_quantity_tiers: input.quantityTiers.map((tier) => ({ minimumUnits: tier.minimumUnits, discountBps: tier.discountBps })),
      p_pack_discount_bps: input.packDiscountBps, p_card_surcharge_bps: input.cardSurchargeBps,
      ...(excluded !== null ? { p_excluded_category_ids: excluded } : {}),
      p_confirm: formData.get("confirm") === "1",
      // Cerrar (nunca borrar) los precios por sucursal de los productos que se reprecian, para que no le ganen al global. Sólo aplica con confirmación.
      p_close_branch_overrides: formData.get("close_overrides") === "on"
    });
    const outcome = parsePricingConfigOutcome(data);
    if (outcome.requiresConfirmation) return { signature, preview: outcome };
    revalidatePath("/admin/products");
    revalidatePath("/admin/promotions");
    return { signature, successToken: crypto.randomUUID(), result: outcome };
  } catch (error) {
    return { signature, error: error instanceof Error ? error.message : "No se pudo guardar la configuración de precios" };
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

export interface BulkCostState {
  error?: string;
  successToken?: string;
  /** El servidor reconoció la misma clave de operación: devolvió el resultado ya guardado y NO volvió a escribir nada (ni stock). */
  replayed?: boolean;
  applied?: number;
  costsSaved?: number;
  /** Productos cuyo margen propio se puso, cambió o quitó en este guardado. */
  marginsChanged?: number;
  /** Precios AUTOMÁTICOS formados (costo y/o margen). */
  repriced?: number;
  /** Precios MANUALES escritos (productos sin margen efectivo, p. ej. Cerdo). */
  manualPrices?: number;
  scheduledPrice?: number;
  /** Ingresos de mercadería registrados en la sucursal productiva (un movimiento por producto). */
  stockMovements?: number;
  /** Productos guardados que tienen un precio vigente de sucursal que le gana al precio global recién escrito. */
  branchOverrides?: number;
  /** Filas frescas (costo, precio y regla vigentes) de los productos guardados: la planilla se actualiza sin recargar el catálogo. */
  rows?: PricingRow[];
}

export interface CloseOverridesState { error?: string; successToken?: string; closed?: number }

/**
 * Cierra (nunca borra) todos los precios vigentes por sucursal de la organización, para que valga el precio global. La fila conserva su
 * precio y queda en el historial. Server-side y atómico (close_branch_price_overrides, 202610060065).
 */
export async function closeBranchPriceOverridesAction(): Promise<CloseOverridesState> {
  try {
    const result = await rpcOrThrow("close_branch_price_overrides", {}) as { closed?: number } | null;
    revalidatePath("/admin/products");
    return { successToken: crypto.randomUUID(), closed: result?.closed ?? 0 };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudieron cerrar los precios por sucursal" };
  }
}

/**
 * Remito de "Productos → Precios" (D-077): recibe sólo las filas que el cliente marcó como modificadas (ver bulk-cost-editor.tsx) y las
 * aplica en UNA llamada atómica a apply_pricing_receipt (202610110074), que reutiliza los helpers canónicos (margen propio, costo + precio
 * automático, vigencia de precio manual, ingreso PURCHASE en la sucursal productiva). Estrategia de atomicidad: todo el lote en una sola
 * transacción de base de datos; un error en cualquier fila o en el stock revierte TODO y Fran puede reintentar. `requestKey` es la clave de
 * idempotencia del intento: un doble click o un reintento de red devuelve el resultado ya guardado en vez de sumar el ingreso otra vez.
 * La cantidad se convierte acá con el parser canónico del stock y el tipo de venta del producto en la base (nunca el del cliente).
 */
export async function applyPricingReceiptAction(input: { requestKey: string; items: unknown }): Promise<BulkCostState> {
  try {
    if (!isRequestKey(input.requestKey)) throw new Error("La operación es inválida: recargá la pantalla");
    const items = parseBulkItems(input.items);
    if (!items.length) throw new Error("No hay cambios para guardar");
    const context = await requireAdminContext();
    const supabase = await createClient();
    const quantityIds = items.filter((item) => item.quantity !== undefined).map((item) => item.productId);
    const products = new Map<string, ReceiptProductInfo>();
    if (quantityIds.length) {
      const { data, error } = await supabase.from("products").select("id, name, unit_type").eq("organization_id", context.organizationId).in("id", quantityIds);
      if (error) throw new Error(error.message);
      for (const row of data) products.set(row.id, { name: row.name, unitType: row.unit_type });
    }
    const result = await rpcOrThrow("apply_pricing_receipt", { p_request_key: input.requestKey, p_items: toReceiptRpcItems(items, products) as unknown as Json }) as {
      applied?: number; costsSaved?: number; marginsChanged?: number; repriced?: number; manualPrices?: number; scheduledPrice?: number;
      stockMovements?: number; branchOverrides?: number; replayed?: boolean;
    } | null;
    revalidatePath("/admin/products");
    revalidatePath("/admin/stock");
    revalidatePath("/admin/replenishment");
    const rows = await fetchPricingRows(items.map((item) => item.productId));
    return {
      successToken: crypto.randomUUID(), replayed: result?.replayed === true, applied: result?.applied ?? items.length, costsSaved: result?.costsSaved ?? 0,
      marginsChanged: result?.marginsChanged ?? 0, repriced: result?.repriced ?? 0, manualPrices: result?.manualPrices ?? 0,
      scheduledPrice: result?.scheduledPrice ?? 0, stockMovements: result?.stockMovements ?? 0, branchOverrides: result?.branchOverrides ?? 0, rows
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudieron guardar los cambios" };
  }
}

/** Filas vigentes de unos productos (de a 100, el máximo del RPC), después de guardar. */
async function fetchPricingRows(productIds: string[]): Promise<PricingRow[]> {
  const rows: PricingRow[] = [];
  for (let offset = 0; offset < productIds.length; offset += 100) {
    const page = parsePricingRowsPage(await rpcOrThrow("list_pricing_rows", { p_product_ids: productIds.slice(offset, offset + 100), p_limit: 100 }));
    rows.push(...page.rows);
  }
  return rows;
}

export type PricingSearchResult = { page: PricingRowsPage; error?: undefined } | { error: string; page?: undefined };

/**
 * ÚNICO buscador de Productos → Precios: busca en el servidor contra TODO el catálogo de la organización (nombre, categoría, SKU o código de
 * barras exacto), paginado. El navegador nunca carga los ~3000 productos.
 */
export async function searchPricingRowsAction(query: string, offset: number): Promise<PricingSearchResult> {
  try {
    const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const text = query.trim().slice(0, 80);
    const data = await rpcOrThrow("list_pricing_rows", { p_limit: PRICING_PAGE_SIZE, p_offset: safeOffset, ...(text ? { p_query: text } : {}) });
    return { page: parsePricingRowsPage(data) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo buscar" };
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

export interface ProductOption { id: string; name: string; sku: string | null; unitType: "WEIGHT" | "UNIT"; barcodes: string[]; active?: boolean }

/** Typeahead for the product pickers: a Central with thousands of products is never loaded whole.
 * Matches name/SKU (accent-insensitive) or an exact barcode, optionally only among the products
 * enabled in `branchId`. `includeInactive` is for the audit/sales filters: a deactivated product
 * still has sales and ledger history worth investigating. */
export async function searchProductsAction(query: string, branchId: string | null, includeInactive = false): Promise<ProductOption[]> {
  await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_products", {
    p_query: query.trim().slice(0, 80), p_limit: 15, ...(branchId ? { p_branch_id: branchId } : {}), ...(includeInactive ? { p_active_only: false } : {})
  });
  if (error) throw new Error(error.message);
  return data.map((row) => ({ id: row.product_id, name: row.product_name, sku: row.sku, unitType: row.unit_type, barcodes: row.barcodes, active: row.active }));
}

export type CarryPlanResult = { report: CarryPlanReport; error?: undefined } | { error: string; report?: undefined };

/**
 * "Qué llevar ahora": calcula en el momento, desde `get_branch_carry_plan` (sólo lectura: no crea
 * movimientos ni transferencias). `branchId` null = todas las sucursales no productivas accesibles.
 * La organización, los permisos y el acceso por sucursal los resuelve la RPC desde la sesión.
 */
export async function calculateCarryPlanAction(branchId: string | null): Promise<CarryPlanResult> {
  await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_branch_carry_plan", branchId ? { p_branch_id: branchId } : {});
  if (error) return { error: error.message };
  return { report: buildCarryPlanReport(data) };
}

export type MissingCostsLoadResult = { ok: true; report: MissingCostsReport } | { ok: false; error: string };

/**
 * «Completar costos faltantes» del Resumen de sucursal: las líneas vendidas sin costo histórico del período, agrupadas por producto
 * (`get_missing_sale_costs`, sólo lectura). La organización, los permisos y el acceso a la sucursal los resuelve la RPC desde la sesión.
 */
export async function loadMissingCostsAction(branchId: string, from: string, to: string): Promise<MissingCostsLoadResult> {
  try {
    await requireAdminContext();
    if (!isUuid(branchId)) throw new Error("Sucursal inválida");
    if (!isIsoDate(from) || !isIsoDate(to)) throw new Error("Período inválido");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_missing_sale_costs", { p_branch_id: branchId, p_from: from, p_to: to });
    if (error) throw new Error(error.message);
    return { ok: true, report: parseMissingCosts(data) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudieron cargar los costos faltantes" };
  }
}

export type CompleteMissingCostsResult = { ok: true; outcome: CompleteMissingCostsOutcome } | { ok: false; error: string };

const MAX_REPAIR_LINES = 5000;

/**
 * Completa el costo HISTÓRICO faltante de un producto (`complete_missing_sale_costs`, una transacción en el servidor) y, sólo si
 * `alsoSetCurrentCost`, guarda además el costo vigente con el flujo canónico de costos (que recalcula el precio de venta si el producto
 * se rige por margen). El navegador manda el costo POR MEDIDA ($/kg o $/u, en centavos) y los ids de línea que vio; nunca un total por línea,
 * ni la organización. Una línea que ya tiene costo no se modifica: el servidor sólo completa las que siguen sin costo.
 */
export async function completeMissingCostsAction(input: { branchId: string; from: string; to: string; productId: string; unitCostCents: number; lineIds: string[]; alsoSetCurrentCost: boolean }): Promise<CompleteMissingCostsResult> {
  try {
    if (!isUuid(input.branchId) || !isUuid(input.productId)) throw new Error("Producto o sucursal inválidos");
    if (!isIsoDate(input.from) || !isIsoDate(input.to)) throw new Error("Período inválido");
    if (!Number.isSafeInteger(input.unitCostCents) || input.unitCostCents <= 0) throw new Error("El costo tiene que ser un importe mayor a cero");
    if (!Array.isArray(input.lineIds) || input.lineIds.length === 0 || input.lineIds.length > MAX_REPAIR_LINES || !input.lineIds.every(isUuid)) throw new Error("Líneas inválidas: recargá la pantalla");
    const data = await rpcOrThrow("complete_missing_sale_costs", {
      p_branch_id: input.branchId, p_from: input.from, p_to: input.to, p_product_id: input.productId, p_unit_cost_cents: input.unitCostCents,
      p_line_ids: input.lineIds, p_also_set_current_cost: input.alsoSetCurrentCost
    });
    const outcome = parseCompleteOutcome(data);
    revalidatePath("/admin/branches", "layout");
    revalidatePath("/admin/analytics");
    if (outcome.currentCostSaved) revalidatePath("/admin/products");
    return { ok: true, outcome };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudieron completar los costos" };
  }
}

export type OperatingCostsLoadResult = { ok: true; report: OperatingCostsReport } | { ok: false; error: string };

/**
 * Modal «Costos operativos» del Resumen de sucursal (D-082): los costos mensuales (con lo imputado al período) y los gastos puntuales
 * recientes (`get_branch_operating_costs`, sólo lectura). La organización, los permisos y el acceso a la sucursal los resuelve la RPC.
 */
export async function loadOperatingCostsAction(branchId: string, from: string, to: string): Promise<OperatingCostsLoadResult> {
  try {
    await requireAdminContext();
    if (!isUuid(branchId)) throw new Error("Sucursal inválida");
    if (!isIsoDate(from) || !isIsoDate(to)) throw new Error("Período inválido");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_branch_operating_costs", { p_branch_id: branchId, p_from: from, p_to: to });
    if (error) throw new Error(error.message);
    return { ok: true, report: parseOperatingCosts(data) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudieron cargar los costos operativos" };
  }
}

export type OperatingCostsMutationResult = { ok: true } | { ok: false; error: string };

const MAX_COST_CENTS = 100_000_000_000;

function refreshOperatingResult() {
  revalidatePath("/admin/branches", "layout");
  revalidatePath("/admin");
}

/**
 * Alta de un costo mensual (`costId` null) o cambio de su importe desde una fecha (`save_branch_recurring_cost`). El importe viaja en centavos
 * enteros; el historial es append-only en el servidor (el importe viejo sigue valiendo para los períodos anteriores). `requestKey` hace
 * idempotente el alta (doble clic / reintento).
 */
export async function saveRecurringCostAction(input: { branchId: string; costId: string | null; name: string; amountCents: number; from: string; requestKey: string | null }): Promise<OperatingCostsMutationResult> {
  try {
    if (!isUuid(input.branchId) || (input.costId !== null && !isUuid(input.costId)) || (input.requestKey !== null && !isUuid(input.requestKey))) throw new Error("Datos inválidos: recargá la pantalla");
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > MAX_COST_CENTS) throw new Error("El importe mensual tiene que ser mayor a cero");
    if (!isIsoDate(input.from)) throw new Error("La fecha desde la que rige no es válida");
    await rpcOrThrow("save_branch_recurring_cost", {
      p_branch_id: input.branchId, p_cost_id: input.costId, p_name: input.name, p_amount_cents: input.amountCents, p_effective_from: input.from, p_request_key: input.requestKey
    });
    refreshOperatingResult();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudo guardar el costo" };
  }
}

/** Da de baja un costo mensual desde una fecha (deja de aplicarse ese día; el historial queda). */
export async function endRecurringCostAction(input: { costId: string; to: string }): Promise<OperatingCostsMutationResult> {
  try {
    if (!isUuid(input.costId) || !isIsoDate(input.to)) throw new Error("Datos inválidos: recargá la pantalla");
    await rpcOrThrow("end_branch_recurring_cost", { p_cost_id: input.costId, p_effective_to: input.to });
    refreshOperatingResult();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudo dar de baja el costo" };
  }
}

/** Registra un gasto puntual (fecha, concepto, importe). Idempotente por `requestKey`. */
export async function recordExpenseAction(input: { branchId: string; date: string; concept: string; amountCents: number; requestKey: string | null }): Promise<OperatingCostsMutationResult> {
  try {
    if (!isUuid(input.branchId) || (input.requestKey !== null && !isUuid(input.requestKey))) throw new Error("Datos inválidos: recargá la pantalla");
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > MAX_COST_CENTS) throw new Error("El importe del gasto tiene que ser mayor a cero");
    if (!isIsoDate(input.date)) throw new Error("La fecha del gasto no es válida");
    await rpcOrThrow("record_branch_expense", {
      p_branch_id: input.branchId, p_expense_date: input.date, p_concept: input.concept, p_amount_cents: input.amountCents, p_request_key: input.requestKey
    });
    refreshOperatingResult();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudo registrar el gasto" };
  }
}

/** Anula un gasto (queda en la base con quién y por qué; deja de imputarse). */
export async function voidExpenseAction(input: { expenseId: string; reason: string }): Promise<OperatingCostsMutationResult> {
  try {
    if (!isUuid(input.expenseId)) throw new Error("Datos inválidos: recargá la pantalla");
    await rpcOrThrow("void_branch_expense", { p_expense_id: input.expenseId, p_reason: input.reason });
    refreshOperatingResult();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudo anular el gasto" };
  }
}

export type ProductModalResult = { ok: true; data: ProductModalData } | { ok: false; error: string };

/**
 * Datos del modal de producto del Resumen de sucursal: la auditoría del ledger desde el último ingreso
 * (`get_stock_audit_summary`) y el estado del producto en las sucursales accesibles (`get_product_branch_activity`).
 * Sólo lectura; la organización, los permisos y el acceso por sucursal los resuelven las RPC desde la sesión.
 */
export async function loadProductModalAction(branchId: string, productId: string): Promise<ProductModalResult> {
  try {
    await requireAdminContext();
    if (!isUuid(branchId) || !isUuid(productId)) throw new Error("Producto o sucursal inválidos");
    const supabase = await createClient();
    const [auditResult, activityResult] = await Promise.all([
      supabase.rpc("get_stock_audit_summary", { p_branch_id: branchId, p_product_id: productId, ...periodRpcArgs({ mode: "since-inbound" }) }),
      supabase.rpc("get_product_branch_activity", { p_product_id: productId })
    ]);
    if (auditResult.error) throw new Error(auditResult.error.message);
    if (activityResult.error) throw new Error(activityResult.error.message);
    return { ok: true, data: { audit: parseStockAuditSummary(auditResult.data), activity: toProductActivity(activityResult.data) } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudo cargar el producto" };
  }
}

/** Converts what the operator typed into the raw ledger quantity using each product REAL unit type
 * (looked up here, never trusted from the client): kg -> grams for WEIGHT, whole units for UNIT. */
async function ledgerQuantities(productIds: string[], raws: string[], allowZero = false): Promise<number[]> {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.from("products").select("id, name, unit_type")
    .eq("organization_id", context.organizationId).in("id", productIds);
  if (error) throw new Error(error.message);
  const byId = new Map(data.map((row) => [row.id, row]));
  return productIds.map((productId, index) => {
    const product = byId.get(productId);
    if (!product) throw new Error("Producto inválido para esta organización");
    try {
      return parseStockQuantityInput(raws[index] ?? "", product.unit_type, { allowZero });
    } catch (error) {
      throw new Error(`${product.name}: ${error instanceof Error ? error.message : "cantidad inválida"}`);
    }
  });
}

export interface StockOperationState { error?: string; successToken?: string }

export async function setStockPolicyFormAction(_: StockOperationState, formData: FormData): Promise<StockOperationState> {
  try {
    const productId = text(formData, "product_id");
    if (!productId) throw new Error("Elegí un producto");
    const [minimum, target] = await ledgerQuantities([productId, productId], [text(formData, "minimum"), text(formData, "target")], true);
    await rpcOrThrow("set_stock_policy", {
      p_branch_id: text(formData, "branch_id"), p_product_id: productId,
      p_minimum_stock_grams: minimum ?? 0, p_target_stock_grams: target ?? 0
    });
    revalidatePath("/admin/stock");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo guardar el mínimo y objetivo" };
  }
}

export async function recordPurchaseFormAction(_: StockOperationState, formData: FormData): Promise<StockOperationState> {
  try {
    const productIds = formData.getAll("product_id").map(String);
    const quantities = formData.getAll("quantity").map(String);
    const rows = productIds.map((productId, index) => ({ productId, raw: (quantities[index] ?? "").trim() })).filter((row) => row.productId || row.raw);
    if (!rows.length) throw new Error("Agregá al menos un producto con su cantidad");
    if (rows.some((row) => !row.productId)) throw new Error("Hay una cantidad sin producto");
    const grams = await ledgerQuantities(rows.map((row) => row.productId), rows.map((row) => row.raw));
    await rpcOrThrow("record_stock_operation", {
      p_branch_id: text(formData, "branch_id"), p_operation_type: "PURCHASE",
      p_items: rows.map((row, index) => ({ product_id: row.productId, quantity_grams: grams[index] ?? 0 })),
      p_supplier: text(formData, "supplier"), p_note: text(formData, "note") || null
    });
    revalidatePath("/admin/stock");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo registrar la compra" };
  }
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

export async function recordWasteFormAction(_: StockOperationState, formData: FormData): Promise<StockOperationState> {
  try {
    const productId = text(formData, "product_id");
    if (!productId) throw new Error("Elegí un producto");
    const [quantity] = await ledgerQuantities([productId], [text(formData, "quantity")]);
    await rpcOrThrow("record_stock_operation", {
      p_branch_id: text(formData, "branch_id"), p_operation_type: "WASTE",
      p_items: [{ product_id: productId, quantity_grams: quantity ?? 0 }],
      p_waste_reason: text(formData, "waste_reason"), p_note: text(formData, "note") || null
    });
    revalidatePath("/admin/stock");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo registrar la merma" };
  }
}

export interface StockAdjustmentState { error?: string; successToken?: string }

export async function recordAdjustmentFormAction(_: StockAdjustmentState, formData: FormData): Promise<StockAdjustmentState> {
  try {
    const productId = text(formData, "product_id");
    if (!productId) throw new Error("Elegí un producto");
    const [physical] = await ledgerQuantities([productId], [text(formData, "physical")], true);
    await rpcOrThrow("record_stock_operation", {
      p_branch_id: text(formData, "branch_id"), p_operation_type: "ADJUSTMENT",
      p_items: [{ product_id: productId, physical_quantity_grams: physical ?? 0 }],
      p_note: text(formData, "note") || null
    });
    revalidatePath("/admin/stock");
    return { successToken: crypto.randomUUID() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo registrar el ajuste" };
  }
}

export interface PhysicalCountAdjustmentInput {
  branchId: string;
  productId: string;
  /** Lo que escribió el operador (kg con coma o unidades): se interpreta con el tipo REAL del producto. */
  physicalRaw: string;
  /** El stock del sistema que la pantalla mostraba cuando se calculó la diferencia. */
  expectedSystemQuantity: number;
  note: string;
}
export type PhysicalCountAdjustmentResult = { ok: true; difference: number } | { ok: false; error: string };

/**
 * Ajuste confirmado desde la auditoría de un producto: el MISMO flujo de inventario físico de Stock → Operaciones
 * (`record_stock_operation` ADJUSTMENT, que fija el stock al valor contado con un ADJUSTMENT_POSITIVE/NEGATIVE en el
 * ledger). Sólo agrega una guarda: si el stock del sistema cambió desde que se abrió la vista (una venta, una
 * transferencia), no ajusta — la diferencia que el usuario confirmó ya no sería la real.
 */
export async function applyPhysicalCountAdjustmentAction(input: PhysicalCountAdjustmentInput): Promise<PhysicalCountAdjustmentResult> {
  try {
    const context = await requireAdminContext();
    const note = input.note.trim();
    if (note.length < 2 || note.length > 500) throw new Error("Escribí el motivo del ajuste (entre 2 y 500 caracteres)");
    if (!input.branchId || !input.productId) throw new Error("Elegí una sucursal y un producto");
    const [physical] = await ledgerQuantities([input.productId], [input.physicalRaw], true);
    const supabase = await createClient();
    const { data: level, error: levelError } = await supabase.from("stock_levels").select("quantity_grams")
      .eq("organization_id", context.organizationId).eq("branch_id", input.branchId).eq("product_id", input.productId).maybeSingle();
    if (levelError) throw new Error(levelError.message);
    const current = level?.quantity_grams ?? 0;
    if (current !== input.expectedSystemQuantity) throw new Error("El stock del sistema cambió mientras tenías la pantalla abierta. Recargá la vista y volvé a calcular la diferencia.");
    if ((physical ?? 0) === current) throw new Error("El stock físico coincide con el del sistema: no hay nada que ajustar");
    await rpcOrThrow("record_stock_operation", {
      p_branch_id: input.branchId, p_operation_type: "ADJUSTMENT",
      p_items: [{ product_id: input.productId, physical_quantity_grams: physical ?? 0 }],
      p_note: note
    });
    revalidatePath("/admin/stock");
    revalidatePath("/admin/branch-stock");
    revalidatePath("/admin/branch-stock/movements");
    revalidatePath("/admin/replenishment");
    return { ok: true, difference: (physical ?? 0) - current };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudo registrar el ajuste" };
  }
}

// ---- Stock rápido (celular, D-081) -----------------------------------------------------------
const QUICK_STOCK_PAGE_SIZE = 20;

/**
 * Productos de una sucursal con su stock actual, para el buscador de «Stock rápido». Buscar y paginar ocurre SIEMPRE en el servidor
 * (`get_branch_stock_status`: nombre / SKU, sólo el surtido de esa sucursal, de a 20): nunca se carga el catálogo entero. Si el texto no
 * encuentra nada por nombre, se prueba como código de barras exacto (`search_products`), pensado para pegar o escribir un código.
 */
export async function searchQuickStockAction(input: { branchId: string; query: string; offset: number }): Promise<QuickStockSearchResult> {
  const context = await requireAdminContext();
  if (!isUuid(input.branchId)) throw new Error("Sucursal inválida");
  const query = input.query.trim().slice(0, 80);
  const offset = Number.isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 0;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_branch_stock_status", {
    p_branch_id: input.branchId, p_limit: QUICK_STOCK_PAGE_SIZE, p_offset: offset, ...(query ? { p_search: query } : {})
  });
  if (error) throw new Error(error.message);
  const rows = data.filter((row) => row.stock_status !== "DISCONTINUED")
    .map((row): QuickStockRow => ({ productId: row.product_id, name: row.product_name, sku: row.sku, unitType: row.unit_type, current: row.current_stock_grams }));
  if (rows.length || !query || offset > 0) return { rows, total: data[0]?.total_count ?? 0 };

  const { data: matches, error: searchError } = await supabase.rpc("search_products", { p_query: query, p_limit: 10, p_branch_id: input.branchId });
  if (searchError) throw new Error(searchError.message);
  if (!matches.length) return { rows: [], total: 0 };
  const { data: levels, error: levelsError } = await supabase.from("stock_levels").select("product_id, quantity_grams")
    .eq("organization_id", context.organizationId).eq("branch_id", input.branchId).in("product_id", matches.map((match) => match.product_id));
  if (levelsError) throw new Error(levelsError.message);
  const stockByProduct = new Map(levels.map((level) => [level.product_id, level.quantity_grams]));
  const barcodeRows = matches.map((match): QuickStockRow => ({ productId: match.product_id, name: match.product_name, sku: match.sku, unitType: match.unit_type, current: stockByProduct.get(match.product_id) ?? 0 }));
  return { rows: barcodeRows, total: barcodeRows.length };
}

export type QuickStockApplyResult = { ok: true; outcome: QuickStockOutcome } | { ok: false; error: string };

/**
 * Guarda de una vez los cambios de «Stock rápido» (agregar / quitar / conteo, de una o varias sucursales). Las cantidades se interpretan acá con el
 * tipo REAL de cada producto (kg → gramos o unidades enteras) y todo se manda en UNA llamada a `apply_quick_stock_changes`, que usa el flujo canónico del
 * ledger y es idempotente por `requestKey` (un doble toque o un reintento de red no duplica nada). El resultado es parcial por producto.
 */
export async function applyQuickStockAction(input: { requestKey: string; items: QuickApplyItem[] }): Promise<QuickStockApplyResult> {
  try {
    const context = await requireAdminContext();
    if (!isRequestKey(input.requestKey)) throw new Error("La operación no es válida: recargá la pantalla.");
    const items = input.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_QUICK_ITEMS) throw new Error("No hay cambios para guardar.");
    for (const item of items) {
      if (!isUuid(item.branchId) || !isUuid(item.productId) || !["ADD", "REMOVE", "COUNT"].includes(item.mode) || typeof item.raw !== "string") throw new Error("Los cambios no son válidos: recargá la pantalla.");
      if (item.expectedSystemQuantity !== undefined && !Number.isSafeInteger(item.expectedSystemQuantity)) throw new Error("Los cambios no son válidos: recargá la pantalla.");
    }
    const supabase = await createClient();
    const { data: products, error: productsError } = await supabase.from("products").select("id, name, unit_type")
      .eq("organization_id", context.organizationId).in("id", [...new Set(items.map((item) => item.productId))]);
    if (productsError) throw new Error(productsError.message);
    const byId = new Map(products.map((product) => [product.id, product]));
    const rpcItems = items.map((item) => {
      const product = byId.get(item.productId);
      if (!product) throw new Error("Uno de los productos no existe en esta organización.");
      let quantity: number;
      try {
        quantity = parseStockQuantityInput(item.raw, product.unit_type, { allowZero: item.mode === "COUNT" });
      } catch (error) {
        throw new Error(`${product.name}: ${error instanceof Error ? error.message : "cantidad inválida"}`);
      }
      return item.mode === "COUNT"
        ? { branchId: item.branchId, productId: item.productId, mode: item.mode, physicalQuantity: quantity, ...(item.expectedSystemQuantity !== undefined ? { expectedSystemQuantity: item.expectedSystemQuantity } : {}) }
        : { branchId: item.branchId, productId: item.productId, mode: item.mode, quantity };
    });
    const { data, error } = await supabase.rpc("apply_quick_stock_changes", { p_request_key: input.requestKey, p_items: rpcItems });
    if (error) throw new Error(error.message);
    const outcome = parseQuickOutcome(data);
    if (!outcome) throw new Error("No pudimos confirmar si se guardó. Revisá el stock antes de volver a intentar.");
    for (const path of ["/admin", "/admin/stock", "/admin/branch-stock", "/admin/branch-stock/movements", "/admin/replenishment", "/admin/branches"]) revalidatePath(path);
    return { ok: true, outcome };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudo guardar el stock" };
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
    const quantities = formData.getAll("quantity").map(String);
    const rows = productIds
      .map((productId, index) => ({ productId, raw: (quantities[index] ?? "").trim() }))
      .filter((row) => row.productId || row.raw);
    if (!rows.length) throw new Error("Agregá al menos un producto para transferir");
    if (rows.some((row) => !row.productId)) throw new Error("Hay una cantidad sin producto");
    // WEIGHT products move in kg (stored as grams), UNIT products in whole units — decided per
    // product from the database, never by the form.
    const quantitiesLedger = await ledgerQuantities(rows.map((row) => row.productId), rows.map((row) => row.raw));
    const items = rows.map((row, index) => ({ product_id: row.productId, quantity_grams: quantitiesLedger[index] ?? 0 }));
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
