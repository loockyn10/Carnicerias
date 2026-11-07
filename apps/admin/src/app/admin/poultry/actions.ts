"use server";

import type { Database, Json } from "@carnicerias/database";
import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../lib/admin";
import { friendlyDbError } from "../../../lib/db-errors";
import { kilogramsToGrams, optionalId, pesosToCents, text } from "../../../lib/form-parsing";
import { localDateTimeToIso } from "../../../lib/local-datetime";
import { isPoultryStatus, orderRpcItems, parseOrderInput } from "../../../lib/poultry";
import { createClient } from "../../../lib/supabase/server";
import { isUuid } from "../../../lib/uuid";

export interface PoultryFormState { error?: string; successToken?: string }

type Functions = Database["public"]["Functions"];

async function rpc<Name extends keyof Functions>(name: Name, args: Functions[Name]["Args"]) {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(friendlyDbError(error.message));
  return { data, context };
}

function done(): PoultryFormState {
  revalidatePath("/admin/poultry", "layout");
  return { successToken: crypto.randomUUID() };
}

function failure(error: unknown, fallback: string): PoultryFormState {
  return { error: error instanceof Error ? error.message : fallback };
}

/** «Vigente desde» opcional (fecha y hora en la zona de la organización). Vacío = ahora. */
function effectiveAt(formData: FormData, timeZone: string): { p_effective_at?: string } {
  const raw = text(formData, "effective_from");
  if (!raw) return {};
  const iso = localDateTimeToIso(raw, timeZone);
  if (!iso) throw new Error("La fecha «Vigente desde» es inválida");
  return { p_effective_at: iso };
}

function money(raw: string, label: string): number {
  try { return pesosToCents(raw); } catch { throw new Error(`${label} inválido`); }
}

// ---- Productos, costos y listas -------------------------------------------------------------------------------------

function saleSettings(formData: FormData) {
  const saleUnit = text(formData, "sale_unit") === "WEIGHT" ? "WEIGHT" as const : "UNIT" as const;
  const reference = text(formData, "reference_weight_kg");
  return { p_sale_unit: saleUnit, p_requires_weight: formData.get("requires_weight") === "on", ...(reference ? { p_reference_weight_grams: kilogramsToGrams(reference) } : {}) };
}

/** Busca en el catálogo general (server-side: nombre, SKU o código de barras) los productos que se pueden asociar a Pollos. */
export async function searchPoultryCandidatesAction(search: string): Promise<{ data: Json } | { error: string }> {
  try {
    const { data } = await rpc("search_poultry_candidate_products", { ...(search.trim() ? { p_search: search.trim().slice(0, 80) } : {}), p_limit: 20 });
    return { data };
  } catch (error) { return { error: error instanceof Error ? error.message : "No se pudo buscar" }; }
}

/** Asocia un producto del catálogo general a Pollos (no crea ni copia el producto). */
export async function addPoultryProductAction(_: PoultryFormState, formData: FormData): Promise<PoultryFormState> {
  try {
    const productId = text(formData, "product_id");
    if (!isUuid(productId)) throw new Error("Elegí un producto del catálogo");
    await rpc("add_poultry_product", { p_product_id: productId, ...saleSettings(formData) });
    return done();
  } catch (error) { return failure(error, "No se pudo agregar el producto"); }
}

/** Modalidad, peso de referencia y activo/inactivo de un producto ya asociado. Quitarlo de Pollos lo desactiva: no borra historia. */
export async function savePoultryProductSettingsAction(_: PoultryFormState, formData: FormData): Promise<PoultryFormState> {
  try {
    const id = text(formData, "poultry_product_id");
    if (!isUuid(id)) throw new Error("Producto inválido");
    await rpc("save_poultry_product_settings", { p_poultry_product_id: id, ...saleSettings(formData), p_active: formData.get("active") === "on" });
    return done();
  } catch (error) { return failure(error, "No se pudo guardar el producto"); }
}

/** Costo y precios de un producto en una sola operación: cada valor que cambió abre una vigencia nueva (los iguales a los vigentes no hacen nada). */
export async function savePoultryPricesAction(_: PoultryFormState, formData: FormData): Promise<PoultryFormState> {
  try {
    const context = await requireAdminContext();
    const productId = text(formData, "product_id");
    if (!isUuid(productId)) throw new Error("Producto inválido");
    const when = effectiveAt(formData, context.timezone);
    const cost = text(formData, "cost");
    const listPrices: { listId: string; cents: number }[] = [];
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("price_") || typeof value !== "string" || value.trim() === "") continue;
      const listId = key.slice("price_".length);
      if (!isUuid(listId)) throw new Error("Lista de precios inválida");
      listPrices.push({ listId, cents: money(value, "Precio") });
    }
    const costCents = cost ? money(cost, "Costo") : null;
    if (costCents === null && listPrices.length === 0) throw new Error("Ingresá un costo o un precio");
    if (costCents !== null) await rpc("set_poultry_product_cost", { p_product_id: productId, p_cost_cents: costCents, ...when });
    for (const price of listPrices) await rpc("set_poultry_list_price", { p_price_list_id: price.listId, p_product_id: productId, p_price_cents: price.cents, ...when });
    return done();
  } catch (error) { return failure(error, "No se pudieron guardar los valores"); }
}

export async function savePoultryPriceListAction(_: PoultryFormState, formData: FormData): Promise<PoultryFormState> {
  try {
    const listId = optionalId(formData, "price_list_id");
    const notes = text(formData, "notes");
    await rpc("save_poultry_price_list", {
      p_name: text(formData, "name"), ...(notes ? { p_notes: notes } : {}), p_active: formData.get("active") === "on", ...(listId ? { p_price_list_id: listId } : {})
    });
    return done();
  } catch (error) { return failure(error, "No se pudo guardar la lista"); }
}

export async function getPoultryPriceHistoryAction(productId: string): Promise<{ data: Json } | { error: string }> {
  try {
    if (!isUuid(productId)) throw new Error("Producto inválido");
    const { data } = await rpc("get_poultry_price_history", { p_product_id: productId });
    return { data };
  } catch (error) { return { error: error instanceof Error ? error.message : "No se pudo leer la historia" }; }
}

// ---- Clientes -------------------------------------------------------------------------------------------------------

export async function savePoultryCustomerAction(_: PoultryFormState, formData: FormData): Promise<PoultryFormState> {
  try {
    const customerId = optionalId(formData, "customer_id");
    const listId = optionalId(formData, "price_list_id");
    const optional = (key: string, arg: "p_phone" | "p_address" | "p_tax_id" | "p_notes") => { const value = text(formData, key); return value ? { [arg]: value } : {}; };
    await rpc("save_poultry_customer", {
      p_name: text(formData, "name"), ...optional("phone", "p_phone"), ...optional("address", "p_address"), ...optional("tax_id", "p_tax_id"),
      ...(listId ? { p_price_list_id: listId } : {}), ...optional("notes", "p_notes"), p_active: formData.get("active") === "on",
      ...(customerId ? { p_customer_id: customerId } : {})
    });
    return done();
  } catch (error) { return failure(error, "No se pudo guardar el cliente"); }
}

/** Precios específicos de un cliente: un valor lo fija, vacío lo quita (el cliente vuelve a su lista). */
export async function savePoultryCustomerPricesAction(_: PoultryFormState, formData: FormData): Promise<PoultryFormState> {
  try {
    const context = await requireAdminContext();
    const customerId = text(formData, "customer_id");
    if (!isUuid(customerId)) throw new Error("Cliente inválido");
    const when = effectiveAt(formData, context.timezone);
    const changes: { productId: string; cents: number | null }[] = [];
    const had = new Set(formData.getAll("had").filter((value): value is string => typeof value === "string"));
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("price_") || typeof value !== "string") continue;
      const productId = key.slice("price_".length);
      if (!isUuid(productId)) throw new Error("Producto inválido");
      if (value.trim() === "") { if (had.has(productId)) changes.push({ productId, cents: null }); continue; }
      changes.push({ productId, cents: money(value, "Precio") });
    }
    for (const change of changes) {
      await rpc("set_poultry_customer_price", { p_customer_id: customerId, p_product_id: change.productId, ...(change.cents !== null ? { p_price_cents: change.cents } : {}), ...when });
    }
    return done();
  } catch (error) { return failure(error, "No se pudieron guardar los precios del cliente"); }
}

/** Precios que se le aplicarían hoy a un cliente (precarga del formulario de pedido). El servidor los resuelve; el navegador no los inventa. */
export async function resolvePoultryPricesAction(customerId: string | null): Promise<{ data: Json } | { error: string }> {
  try {
    if (customerId !== null && !isUuid(customerId)) throw new Error("Cliente inválido");
    const { data } = await rpc("resolve_poultry_prices", customerId ? { p_customer_id: customerId } : {});
    return { data };
  } catch (error) { return { error: error instanceof Error ? error.message : "No se pudieron leer los precios" }; }
}

// ---- Pedidos --------------------------------------------------------------------------------------------------------

export type SavePoultryOrderResult = { ok: true; orderId: string; orderNumber: number } | { ok: false; error: string };

/** Crea o edita un pedido. El precio de cada línea lo resuelve el servidor (snapshot); un precio manual viaja como excepción. */
export async function savePoultryOrderAction(raw: unknown): Promise<SavePoultryOrderResult> {
  try {
    const parsed = parseOrderInput(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const input = parsed.value;
    const { data } = await rpc("save_poultry_order", {
      p_branch_id: input.branchId, p_customer_id: input.customerId, p_ordered_on: input.orderedOn, p_items: orderRpcItems(input.items) as Json,
      ...(input.deliveryOn ? { p_delivery_on: input.deliveryOn } : {}), ...(input.paymentMethod ? { p_payment_method: input.paymentMethod } : {}),
      ...(input.notes ? { p_notes: input.notes } : {}), ...(input.orderId ? { p_order_id: input.orderId } : {}), ...(input.requestKey ? { p_request_key: input.requestKey } : {})
    });
    const record = (typeof data === "object" && data !== null && !Array.isArray(data) ? data : {}) as Record<string, Json | undefined>;
    revalidatePath("/admin/poultry", "layout");
    const orderId = typeof record.orderId === "string" ? record.orderId : "";
    const orderNumber = typeof record.orderNumber === "number" ? record.orderNumber : 0;
    if (!orderId) return { ok: false, error: "No se pudo guardar el pedido" };
    return { ok: true, orderId, orderNumber };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "No se pudo guardar el pedido" }; }
}

export async function setPoultryOrderStatusAction(orderId: string, status: string): Promise<PoultryFormState> {
  try {
    if (!isUuid(orderId) || !isPoultryStatus(status)) throw new Error("Pedido inválido");
    await rpc("set_poultry_order_status", { p_order_id: orderId, p_status: status });
    return done();
  } catch (error) { return failure(error, "No se pudo cambiar el estado"); }
}

/** Peso real de las líneas de un pedido abierto (kg con coma o punto; vacío = todavía sin pesar). */
export async function setPoultryOrderWeightsAction(orderId: string, weights: { itemId: string; kg: string }[]): Promise<PoultryFormState> {
  try {
    if (!isUuid(orderId) || weights.length === 0) throw new Error("Pedido inválido");
    const payload = weights.map((entry) => {
      if (!isUuid(entry.itemId)) throw new Error("Línea inválida");
      const kg = entry.kg.trim();
      return { itemId: entry.itemId, actualWeightGrams: kg === "" ? null : kilogramsToGrams(kg) };
    });
    await rpc("set_poultry_order_weights", { p_order_id: orderId, p_weights: payload });
    return done();
  } catch (error) { return failure(error, "No se pudo guardar el peso"); }
}
