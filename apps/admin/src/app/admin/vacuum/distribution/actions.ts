"use server";

import type { Database, Json } from "@carnicerias/database";
import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../../lib/admin";
import { friendlyDbError } from "../../../../lib/db-errors";
import { isIsoDate } from "../../../../lib/date-range";
import { isUuid } from "../../../../lib/uuid";
import { COMMERCIAL_MODES, PACKAGING_STATES, RETURN_REASONS } from "../../../../lib/distribution/model";
import { createClient } from "../../../../lib/supabase/server";

/**
 * Acciones del servidor de Distribución. Cada una valida lo mínimo (ids, fechas, largos) para dar un mensaje en castellano y delega TODO lo demás en la RPC:
 * la organización, el permiso (distribution.read/write/approve_reentry), la sucursal, el estado de cada paquete y la idempotencia las decide la base.
 */

export type ActionResult = { ok: true; data: Json } | { ok: false; error: string };
export interface DistributionFormState { error?: string; successToken?: string }

type Functions = Database["public"]["Functions"];

async function call<Name extends keyof Functions>(name: Name, args: Functions[Name]["Args"], paths: string[] = ["/admin/vacuum/distribution"]): Promise<ActionResult> {
  try {
    await requireAdminContext();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(name, args);
    if (error) return { ok: false, error: friendlyDbError(error.message) };
    for (const path of paths) revalidatePath(path, "layout");
    return { ok: true, data };
  } catch (error) {
    // `redirect()` de la sesión vencida también pasa por acá: se deja pasar para que Next navegue.
    if (error instanceof Error && error.message === "NEXT_REDIRECT") throw error;
    return { ok: false, error: error instanceof Error ? error.message : "No se pudo completar la operación" };
  }
}

const fail = (error: string): ActionResult => ({ ok: false, error });
const uuids = (values: unknown, max = 500): values is string[] => Array.isArray(values) && values.length > 0 && values.length <= max && values.every((value) => typeof value === "string" && isUuid(value));
const optionalText = (value: FormDataEntryValue | null) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const requiredText = (value: FormDataEntryValue | null) => (typeof value === "string" ? value : "");

// ---------------------------------------------------------------------------------------------------------------------
// Supermercados
// ---------------------------------------------------------------------------------------------------------------------

export async function saveDistributionClientAction(_: DistributionFormState, formData: FormData): Promise<DistributionFormState> {
  const id = optionalText(formData.get("id"));
  const mode = requiredText(formData.get("commercial_mode"));
  if (id !== undefined && !isUuid(id)) return { error: "Cliente inválido" };
  if (!(COMMERCIAL_MODES as readonly string[]).includes(mode)) return { error: "Elegí la modalidad comercial" };
  const legal = optionalText(formData.get("legal_name"));
  const tax = optionalText(formData.get("tax_id"));
  const notes = optionalText(formData.get("notes"));
  const result = await call("save_distribution_client", {
    ...(id ? { p_id: id } : {}), p_trade_name: requiredText(formData.get("trade_name")), ...(legal ? { p_legal_name: legal } : {}), ...(tax ? { p_tax_id: tax } : {}),
    p_commercial_mode: mode, ...(notes ? { p_notes: notes } : {}), p_active: formData.get("active") !== "off"
  });
  return result.ok ? { successToken: crypto.randomUUID() } : { error: result.error };
}

export async function saveDistributionSiteAction(_: DistributionFormState, formData: FormData): Promise<DistributionFormState> {
  const id = optionalText(formData.get("id"));
  const clientId = optionalText(formData.get("client_id"));
  if (id !== undefined && !isUuid(id)) return { error: "Establecimiento inválido" };
  if (id === undefined && (clientId === undefined || !isUuid(clientId))) return { error: "Elegí el cliente" };
  const weekdayRaw = optionalText(formData.get("restock_weekday"));
  const weekday = weekdayRaw === undefined ? undefined : Number.parseInt(weekdayRaw, 10);
  if (weekday !== undefined && !(weekday >= 1 && weekday <= 7)) return { error: "El día de reposición no es válido" };
  const mode = optionalText(formData.get("commercial_mode"));
  if (mode !== undefined && !(COMMERCIAL_MODES as readonly string[]).includes(mode)) return { error: "Modalidad comercial inválida" };
  const text = (key: string) => optionalText(formData.get(key));
  const address = text("address"); const city = text("city"); const phone = text("phone"); const contact = text("contact_name"); const notes = text("notes");
  const result = await call("save_distribution_site", {
    ...(id ? { p_id: id } : {}), ...(clientId ? { p_client_id: clientId } : {}), p_name: requiredText(formData.get("name")), ...(address ? { p_address: address } : {}), ...(city ? { p_city: city } : {}),
    ...(phone ? { p_phone: phone } : {}), ...(contact ? { p_contact_name: contact } : {}), ...(notes ? { p_notes: notes } : {}), ...(weekday !== undefined ? { p_restock_weekday: weekday } : {}),
    ...(mode ? { p_commercial_mode: mode } : {}), p_active: formData.get("active") !== "off"
  });
  return result.ok ? { successToken: crypto.randomUUID() } : { error: result.error };
}

// ---------------------------------------------------------------------------------------------------------------------
// Entregas
// ---------------------------------------------------------------------------------------------------------------------

export async function createDeliveryAction(input: { siteId: string; deliveryDate: string; requestKey: string; referenceDeliveryId?: string | null; notes?: string | null }): Promise<ActionResult> {
  if (!isUuid(input.siteId)) return fail("Elegí el supermercado");
  if (!isIsoDate(input.deliveryDate)) return fail("La fecha de entrega es inválida");
  if (!isUuid(input.requestKey)) return fail("Pedido inválido");
  if (input.referenceDeliveryId && !isUuid(input.referenceDeliveryId)) return fail("Entrega de referencia inválida");
  return call("create_distribution_delivery", {
    p_site_id: input.siteId, p_delivery_date: input.deliveryDate, p_request_key: input.requestKey,
    ...(input.referenceDeliveryId ? { p_reference_delivery_id: input.referenceDeliveryId } : {}), ...(input.notes?.trim() ? { p_notes: input.notes.trim().slice(0, 1000) } : {})
  });
}

export async function getDeliveryAction(deliveryId: string): Promise<ActionResult> {
  if (!isUuid(deliveryId)) return fail("Entrega inválida");
  return call("get_distribution_delivery", { p_delivery_id: deliveryId }, []);
}

export async function addDeliveryPackagesAction(deliveryId: string, packageIds: string[]): Promise<ActionResult> {
  if (!isUuid(deliveryId) || !uuids(packageIds)) return fail("Elegí los paquetes");
  return call("add_delivery_packages", { p_delivery_id: deliveryId, p_package_ids: packageIds });
}

export async function addDeliveryPackageByCodeAction(deliveryId: string, code: string): Promise<ActionResult> {
  if (!isUuid(deliveryId) || code.trim() === "" || code.length > 80) return fail("Escaneá o ingresá el código del paquete");
  return call("add_delivery_package_by_code", { p_delivery_id: deliveryId, p_code: code.trim() });
}

export async function addDeliveryByQuantityAction(deliveryId: string, items: { productId: string; quantity: number }[]): Promise<ActionResult> {
  if (!isUuid(deliveryId)) return fail("Entrega inválida");
  const clean = items.filter((item) => isUuid(item.productId) && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 500);
  if (clean.length === 0) return fail("Indicá al menos un producto con su cantidad");
  return call("add_delivery_packages_by_quantity", { p_delivery_id: deliveryId, p_items: clean });
}

export async function removeDeliveryPackagesAction(deliveryId: string, packageIds: string[]): Promise<ActionResult> {
  if (!isUuid(deliveryId) || !uuids(packageIds)) return fail("Elegí los paquetes");
  return call("remove_delivery_packages", { p_delivery_id: deliveryId, p_package_ids: packageIds });
}

export async function cancelDeliveryAction(deliveryId: string, reason: string): Promise<ActionResult> {
  if (!isUuid(deliveryId)) return fail("Entrega inválida");
  return call("cancel_distribution_delivery", { p_delivery_id: deliveryId, p_reason: reason.trim().slice(0, 300) });
}

/** Confirma el despacho (transaccional e idempotente en la base: confirmar dos veces devuelve la misma entrega sin mover stock otra vez). */
export async function confirmDeliveryAction(deliveryId: string): Promise<ActionResult> {
  if (!isUuid(deliveryId)) return fail("Entrega inválida");
  return call("confirm_distribution_delivery", { p_delivery_id: deliveryId }, ["/admin/vacuum", "/admin/stock"]);
}

export async function listDistributablePackagesAction(input: { branchId: string; deliveryDate: string; productId?: string | null; search?: string; offset?: number }): Promise<ActionResult> {
  if (!isUuid(input.branchId) || !isIsoDate(input.deliveryDate)) return fail("Datos inválidos");
  return call("list_distributable_packages", {
    p_branch_id: input.branchId, p_delivery_date: input.deliveryDate, ...(input.productId && isUuid(input.productId) ? { p_product_id: input.productId } : {}),
    ...(input.search?.trim() ? { p_search: input.search.trim().slice(0, 80) } : {}), p_limit: 50, p_offset: Math.max(0, Math.trunc(input.offset ?? 0))
  }, []);
}

export async function getAvailableSummaryAction(branchId: string, deliveryDate: string): Promise<ActionResult> {
  if (!isUuid(branchId) || !isIsoDate(deliveryDate)) return fail("Datos inválidos");
  return call("get_distribution_available_summary", { p_branch_id: branchId, p_delivery_date: deliveryDate }, []);
}

export async function getSiteReferenceAction(siteId: string): Promise<ActionResult> {
  if (!isUuid(siteId)) return fail("Elegí el supermercado");
  return call("get_site_reference_delivery", { p_site_id: siteId }, []);
}

// ---------------------------------------------------------------------------------------------------------------------
// Conciliación
// ---------------------------------------------------------------------------------------------------------------------

export async function reportDeliverySalesAction(deliveryId: string, packageIds: string[], soldOn?: string): Promise<ActionResult> {
  if (!isUuid(deliveryId) || !uuids(packageIds)) return fail("Elegí los paquetes vendidos");
  if (soldOn && !isIsoDate(soldOn)) return fail("La fecha de venta es inválida");
  return call("report_delivery_sales", { p_delivery_id: deliveryId, p_package_ids: packageIds, ...(soldOn ? { p_sold_on: soldOn } : {}) });
}

export async function reportDeliverySalesByCodesAction(deliveryId: string, codes: string[], soldOn?: string): Promise<ActionResult> {
  const clean = codes.map((code) => code.trim()).filter((code) => code !== "");
  if (!isUuid(deliveryId) || clean.length === 0 || clean.length > 500) return fail("Escaneá o ingresá los códigos de los paquetes vendidos");
  if (soldOn && !isIsoDate(soldOn)) return fail("La fecha de venta es inválida");
  return call("report_delivery_sales_by_codes", { p_delivery_id: deliveryId, p_codes: clean, ...(soldOn ? { p_sold_on: soldOn } : {}) });
}

export async function reportQuantitySalesAction(input: { deliveryId: string; items: { productId: string; quantity: number }[]; note?: string; requestKey: string }): Promise<ActionResult> {
  if (!isUuid(input.deliveryId) || !isUuid(input.requestKey)) return fail("Pedido inválido");
  const clean = input.items.filter((item) => isUuid(item.productId) && Number.isInteger(item.quantity) && item.quantity > 0);
  if (clean.length === 0) return fail("Indicá cuántos se vendieron de cada producto");
  return call("report_delivery_quantity_sales", { p_delivery_id: input.deliveryId, p_items: clean, ...(input.note?.trim() ? { p_note: input.note.trim().slice(0, 300) } : {}), p_request_key: input.requestKey });
}

export async function closeReconciliationAction(deliveryId: string, note: string): Promise<ActionResult> {
  if (!isUuid(deliveryId)) return fail("Entrega inválida");
  return call("close_delivery_reconciliation", { p_delivery_id: deliveryId, ...(note.trim() ? { p_note: note.trim().slice(0, 500) } : {}) });
}

export async function getReconciliationAction(deliveryId: string): Promise<ActionResult> {
  if (!isUuid(deliveryId)) return fail("Entrega inválida");
  return call("get_delivery_reconciliation", { p_delivery_id: deliveryId }, []);
}

// ---------------------------------------------------------------------------------------------------------------------
// Devoluciones
// ---------------------------------------------------------------------------------------------------------------------

export async function registerReturnsAction(input: { deliveryId: string; items: { packageId: string; reason: string; reasonNote?: string }[]; returnedOn?: string; requestKey: string }): Promise<ActionResult> {
  if (!isUuid(input.deliveryId) || !isUuid(input.requestKey) || input.items.length === 0 || input.items.length > 500) return fail("Elegí los paquetes que se devuelven");
  if (input.returnedOn && !isIsoDate(input.returnedOn)) return fail("La fecha de devolución es inválida");
  if (!input.items.every((item) => isUuid(item.packageId) && (RETURN_REASONS as readonly string[]).includes(item.reason))) return fail("Revisá el motivo de cada paquete");
  return call("register_distribution_returns", {
    p_delivery_id: input.deliveryId, p_items: input.items.map((item) => ({ packageId: item.packageId, reason: item.reason, ...(item.reasonNote?.trim() ? { reasonNote: item.reasonNote.trim().slice(0, 300) } : {}) })),
    ...(input.returnedOn ? { p_returned_on: input.returnedOn } : {}), p_request_key: input.requestKey
  });
}

export async function receiveReturnsAction(items: { returnId: string; packagingState: string; conservationVerified: boolean; conservationNote?: string }[]): Promise<ActionResult> {
  if (items.length === 0 || items.length > 500 || !items.every((item) => isUuid(item.returnId) && (PACKAGING_STATES as readonly string[]).includes(item.packagingState))) return fail("Indicá el estado del envase de cada paquete");
  return call("receive_distribution_returns", {
    p_items: items.map((item) => ({ returnId: item.returnId, packagingState: item.packagingState, conservationVerified: item.conservationVerified, ...(item.conservationNote?.trim() ? { conservationNote: item.conservationNote.trim().slice(0, 300) } : {}) }))
  });
}

export async function startReturnInspectionAction(returnId: string): Promise<ActionResult> {
  if (!isUuid(returnId)) return fail("Devolución inválida");
  return call("start_return_inspection", { p_return_id: returnId });
}

/** Decisión sobre un paquete devuelto. El reingreso (APPROVE) sólo lo permite la base con envase intacto, conservación verificada, sin vencer y con el permiso específico. */
export async function decideReturnAction(input: { returnId: string; decision: "APPROVE" | "REJECT" | "DISCARD"; reason: string; packagingState?: string; conservationVerified?: boolean; conservationNote?: string }): Promise<ActionResult> {
  if (!isUuid(input.returnId)) return fail("Devolución inválida");
  if (input.reason.trim().length < 3) return fail("Indicá el motivo de la decisión");
  if (input.packagingState && !(PACKAGING_STATES as readonly string[]).includes(input.packagingState)) return fail("Estado de envase inválido");
  return call("decide_distribution_return", {
    p_return_id: input.returnId, p_decision: input.decision, p_reason: input.reason.trim().slice(0, 300), ...(input.packagingState ? { p_packaging_state: input.packagingState } : {}),
    ...(input.conservationVerified !== undefined ? { p_conservation_verified: input.conservationVerified } : {}), ...(input.conservationNote?.trim() ? { p_conservation_note: input.conservationNote.trim().slice(0, 300) } : {})
  }, ["/admin/vacuum", "/admin/stock"]);
}
