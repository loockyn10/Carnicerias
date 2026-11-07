"use server";

import type { Database, Json } from "@carnicerias/database";
import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../lib/admin";
import { friendlyDbError } from "../../../lib/db-errors";
import { decimal, text } from "../../../lib/form-parsing";
import { createClient } from "../../../lib/supabase/server";
import { isUuid } from "../../../lib/uuid";
import { parseCreatePackageInput } from "../../../lib/vacuum";
import { isEanScheme, validateEanSchemeConfig } from "../../../lib/vacuum-ean";

export interface VacuumFormState { error?: string; successToken?: string }

type Functions = Database["public"]["Functions"];

async function rpc<Name extends keyof Functions>(name: Name, args: Functions[Name]["Args"]) {
  await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(friendlyDbError(error.message));
  return data;
}

function done(): VacuumFormState {
  revalidatePath("/admin/vacuum", "layout");
  return { successToken: crypto.randomUUID() };
}

function failure(error: unknown, fallback: string): VacuumFormState {
  return { error: error instanceof Error ? error.message : fallback };
}

/** Búsqueda de cortes habilitados para envasar (nombre, SKU, código de barras o PLU) con el precio/kg vigente de la sucursal. */
export async function searchVacuumProductsAction(branchId: string, search: string): Promise<{ data: Json } | { error: string }> {
  try {
    if (!isUuid(branchId)) throw new Error("Elegí la sucursal");
    const data = await rpc("search_vacuum_products", { p_branch_id: branchId, ...(search.trim() ? { p_search: search.trim().slice(0, 80) } : {}), p_limit: 30 });
    return { data };
  } catch (error) { return { error: error instanceof Error ? error.message : "No se pudo buscar" }; }
}

/** Registra el paquete (snapshot auditable). Idempotente por `requestKey`: un doble clic o un reintento devuelve el mismo paquete. */
export async function createVacuumPackageAction(raw: unknown): Promise<{ ok: true; data: Json } | { ok: false; error: string }> {
  try {
    const parsed = parseCreatePackageInput(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const input = parsed.value;
    const data = await rpc("create_vacuum_package", {
      p_branch_id: input.branchId, p_product_id: input.productId, p_weight_grams: input.weightGrams, p_packed_on: input.packedOn,
      ...(input.expiresOn ? { p_expires_on: input.expiresOn } : {}), ...(input.lot ? { p_lot: input.lot } : {}), p_request_key: input.requestKey
    });
    revalidatePath("/admin/vacuum/recent");
    return { ok: true, data };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "No se pudo registrar el paquete" }; }
}

/** Envía paquetes DISPONIBLES a otra sucursal: sólo cambia dónde los ofrece el POS (el stock del corte se mueve con las transferencias de siempre). */
export async function moveVacuumPackagesAction(packageIds: string[], toBranchId: string): Promise<{ ok: true; moved: number } | { ok: false; error: string }> {
  try {
    if (!isUuid(toBranchId) || packageIds.length === 0 || packageIds.length > 500 || !packageIds.every(isUuid)) throw new Error("Elegí los paquetes y la sucursal de destino");
    const moved = await rpc("move_vacuum_packages", { p_package_ids: packageIds, p_to_branch_id: toBranchId });
    revalidatePath("/admin/vacuum", "layout");
    return { ok: true, moved };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "No se pudo enviar el paquete" }; }
}

/** Anula un paquete disponible (se descartó o se rompió el vacío). No mueve stock: envasar nunca lo descontó. */
export async function voidVacuumPackageAction(packageId: string, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!isUuid(packageId)) throw new Error("Paquete inválido");
    await rpc("void_vacuum_package", { p_package_id: packageId, p_reason: reason.trim().slice(0, 300) });
    revalidatePath("/admin/vacuum", "layout");
    return { ok: true };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "No se pudo anular el paquete" }; }
}

/** Da por resuelto un conflicto de venta de un paquete, con la nota de cómo se resolvió. */
export async function resolveVacuumConflictAction(conflictId: string, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!isUuid(conflictId)) throw new Error("Conflicto inválido");
    await rpc("resolve_vacuum_package_conflict", { p_conflict_id: conflictId, p_note: note.trim().slice(0, 500) });
    revalidatePath("/admin/vacuum", "layout");
    return { ok: true };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "No se pudo resolver el conflicto" }; }
}

export async function saveVacuumSettingsAction(_: VacuumFormState, formData: FormData): Promise<VacuumFormState> {
  try {
    const optional = (key: string) => text(formData, key);
    const mm = (key: string, arg: "p_label_width_mm" | "p_info_height_mm" | "p_price_height_mm") => {
      const raw = optional(key);
      return raw ? { [arg]: decimal(raw, "La medida") } : {};
    };
    const textArg = (key: string, arg: "p_business_name" | "p_address" | "p_establishment_info" | "p_default_conservation_text" | "p_extra_text") => {
      const raw = optional(key);
      return raw ? { [arg]: raw } : {};
    };
    await rpc("save_vacuum_settings", {
      ...textArg("business_name", "p_business_name"), ...textArg("address", "p_address"), ...textArg("establishment_info", "p_establishment_info"),
      ...textArg("default_conservation_text", "p_default_conservation_text"), ...textArg("extra_text", "p_extra_text"),
      ...mm("label_width_mm", "p_label_width_mm"), ...mm("info_height_mm", "p_info_height_mm"), ...mm("price_height_mm", "p_price_height_mm")
    });
    return done();
  } catch (error) { return failure(error, "No se pudo guardar la configuración"); }
}

/** Esquema del EAN-13. Vacío (esquema «Sin configurar») borra la configuración: los paquetes ya emitidos conservan su código. */
export async function saveVacuumEanSchemeAction(_: VacuumFormState, formData: FormData): Promise<VacuumFormState> {
  try {
    const scheme = text(formData, "scheme");
    if (scheme === "") { await rpc("save_vacuum_ean_scheme", {}); return done(); }
    if (!isEanScheme(scheme)) throw new Error("Esquema EAN-13 no soportado");
    const config = {
      prefix: text(formData, "prefix"), pluDigits: Number.parseInt(text(formData, "plu_digits"), 10), valueDigits: Number.parseInt(text(formData, "value_digits"), 10),
      valueStep: Number.parseInt(text(formData, "value_step") || "1", 10)
    };
    const problem = validateEanSchemeConfig(config);
    if (problem) throw new Error(problem);
    await rpc("save_vacuum_ean_scheme", { p_scheme: scheme, p_prefix: config.prefix, p_plu_digits: config.pluDigits, p_value_digits: config.valueDigits, p_value_step: config.valueStep });
    return done();
  } catch (error) { return failure(error, "No se pudo guardar el esquema EAN-13"); }
}

export async function saveVacuumProductConfigAction(_: VacuumFormState, formData: FormData): Promise<VacuumFormState> {
  try {
    const productId = text(formData, "product_id");
    if (!isUuid(productId)) throw new Error("Producto inválido");
    const shelf = text(formData, "shelf_life_days");
    if (shelf && !/^\d+$/.test(shelf)) throw new Error("La vida útil son días enteros");
    const plu = text(formData, "plu");
    const conservation = text(formData, "conservation_text");
    await rpc("save_vacuum_product_config", {
      p_product_id: productId, p_enabled: formData.get("enabled") === "on", ...(shelf ? { p_shelf_life_days: Number.parseInt(shelf, 10) } : {}),
      ...(plu ? { p_plu: plu } : {}), ...(conservation ? { p_conservation_text: conservation } : {})
    });
    return done();
  } catch (error) { return failure(error, "No se pudo guardar el producto"); }
}
