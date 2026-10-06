"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "../../lib/supabase/server";
import { requireAdminContext } from "../../lib/admin";
import { parsePesosToCents } from "../../lib/settlements";
import { decimal, ids, kilogramsToGrams, optionalId, parseBarcodes, pesosToCents, text, unitsToInteger } from "../../lib/form-parsing";
import { parseStockQuantityInput } from "@carnicerias/business-logic";
import type { CarryPlanReport } from "../../lib/carry-plan";
import { buildSaveWeightDiscountArgs } from "../../lib/weight-discount-args";
import { MAX_BULK_DEACTIVATE, normalizeProductIds } from "../../lib/product-selection";
import { parseCurrentPackSize, parsePackSizeUnits } from "../../lib/unit-promotions";
import { resolveNewProductPricing } from "../../lib/new-product-pricing";
import { parseExcludedCategoryIds, parsePricingConfigForm, parsePricingConfigOutcome, type PricingConfigOutcome } from "../../lib/pricing-config";
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
    // campo permite corregirlo o cargarlo a mano para lo que no sale de desposte. Con el margen global
    // configurado, guardar un costo nuevo recalcula el precio de lista en la misma operación (D-068).
    const rawDirectCost = text(formData, "direct_cost");
    if (rawDirectCost) {
      const costCents = pesosToCents(rawDirectCost);
      if (costCents !== Number(text(formData, "current_cost_cents") || 0)) {
        await rpcOrThrow("set_product_cost", { p_product_id: productId, p_cost_cents: costCents });
      }
    }
    // Precio de lista escrito a mano: sólo es el FALLBACK cuando el precio no puede derivarse (sin costo o sin margen configurado, o
    // producto inactivo / materia prima). Con costo y margen el precio se forma desde el costo y un precio escrito no gana (el formulario
    // ni lo envía). Sólo se escribe si el admin lo CAMBIÓ respecto al vigente.
    const rawPrice = text(formData, "price");
    const costKnown = Boolean(rawDirectCost) || Number(text(formData, "current_cost_cents") || 0) > 0;
    // Una categoría excluida del margen automático (D-069, carnicería) nunca deriva el precio: el costo se guarda y el precio sigue siendo manual.
    const derivedPrice = costKnown && inventoryRole(formData) !== "RAW_MATERIAL" && formData.get("active") === "on" && (await currentMarginBps()) !== null
      && !(await isCategoryExcludedFromMargin(text(formData, "category_id")));
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
 * Guarda la configuración global de precios (margen, dto llevando 3u, dto por pack, recargo por tarjeta) con UNA llamada atómica a
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
  applied?: number;
  repriced?: number;
  scheduledPrice?: number;
  /** Costos guardados de productos de categorías excluidas del margen (precio manual): su precio NO cambió. */
  manualPrice?: number;
  marginConfigured?: boolean;
  /** Productos guardados que tienen un precio vigente de sucursal que le gana al precio global recién formado. */
  branchOverrides?: number;
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
 * Carga masiva de COSTOS de "Productos → Precios": recibe sólo las filas que el cliente marcó como modificadas (ver
 * bulk-cost-editor.tsx) y las aplica en una única llamada atómica a bulk_set_product_costs (202610060065). Cada costo guardado abre
 * su vigencia de costo y, con el margen global configurado, recalcula el precio de lista en la misma transacción. Un precio de venta
 * nunca viaja desde acá; los precios manuales se cargan en la ficha del producto.
 */
export async function bulkSetProductCostsAction(_: BulkCostState, formData: FormData): Promise<BulkCostState> {
  try {
    const raw = text(formData, "items");
    const items = raw ? (JSON.parse(raw) as { productId: string; costCents: number }[]) : [];
    if (!items.length) throw new Error("No hay cambios para guardar");
    const result = await rpcOrThrow("bulk_set_product_costs", { p_items: items }) as { applied?: number; repriced?: number; scheduledPrice?: number; manualPrice?: number; marginConfigured?: boolean; branchOverrides?: number } | null;
    revalidatePath("/admin/products");
    return {
      successToken: crypto.randomUUID(), applied: result?.applied ?? items.length, repriced: result?.repriced ?? 0,
      scheduledPrice: result?.scheduledPrice ?? 0, manualPrice: result?.manualPrice ?? 0, marginConfigured: result?.marginConfigured ?? false, branchOverrides: result?.branchOverrides ?? 0
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudieron guardar los costos" };
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

export interface ProductOption { id: string; name: string; sku: string | null; unitType: "WEIGHT" | "UNIT"; barcodes: string[] }

/** Typeahead for the product pickers: a Central with thousands of products is never loaded whole.
 * Matches name/SKU (accent-insensitive) or an exact barcode, optionally only among the products
 * enabled in `branchId`. */
export async function searchProductsAction(query: string, branchId: string | null): Promise<ProductOption[]> {
  await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_products", {
    p_query: query.trim().slice(0, 80), p_limit: 15, ...(branchId ? { p_branch_id: branchId } : {})
  });
  if (error) throw new Error(error.message);
  return data.map((row) => ({ id: row.product_id, name: row.product_name, sku: row.sku, unitType: row.unit_type, barcodes: row.barcodes }));
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
  const first = data[0];
  return {
    report: {
      calculatedAt: first?.calculated_at ?? new Date().toISOString(),
      windowStart: first?.window_start ?? "",
      windowDays: first?.window_days ?? 7,
      rows: data.map((row) => ({
        branchId: row.branch_id, branchName: row.branch_name, productId: row.product_id, productName: row.product_name,
        unitType: row.unit_type, soldQuantity: row.sold_quantity, currentQuantity: row.current_quantity, suggestedQuantity: row.suggested_quantity
      }))
    }
  };
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
