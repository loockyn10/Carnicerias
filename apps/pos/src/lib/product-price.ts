/**
 * Productos sin precio en el POS de Central. SimplyGest trae productos válidos con precio 0 ("se le
 * pone el precio en el momento"): se muestran normalmente pero NUNCA se agregan al ticket a $0. Al
 * tocarlos o escanearlos el POS pide el precio y lo guarda (RPC `set_pos_product_price`): el precio
 * ingresado es el precio vigente del producto, no un precio temporal de esa venta. Lógica pura: nada
 * acá toca red ni SQLite.
 */
import { parsePesosToCents, parseCatalogRow, type QuickCatalogRow } from "./quick-product";

/** Un producto vendible tiene precio > 0; 0 es "sin precio definido". */
export function isPriceMissing(product: { pricePerKgCents: bigint }): boolean {
  return product.pricePerKgCents <= 0n;
}

/** Sin conexión no se puede fijar el precio (no hay cola offline de precios) y tampoco vender el producto a $0. */
export const NO_PRICE_OFFLINE_MESSAGE = "Este producto no tiene precio.\nNecesitás conexión para establecerlo.";

export type PriceValidation = { ok: true; priceCents: bigint } | { ok: false; error: string };

/** El precio ingresado tiene que ser un importe válido y MAYOR a cero ("0" o vacío no sirven). */
export function validateProductPrice(raw: string): PriceValidation {
  if (raw.trim() === "") return { ok: false, error: "Escribí el precio de venta" };
  const priceCents = parsePesosToCents(raw);
  if (priceCents === null) return { ok: false, error: "Precio inválido" };
  if (priceCents <= 0n) return { ok: false, error: "El precio tiene que ser mayor a cero" };
  return { ok: true, priceCents };
}

export interface SetPriceResult {
  /** SET = se fijó ahora; UNCHANGED = el producto ya valía exactamente eso (reintento). */
  status: "SET" | "UNCHANGED";
  priceCents: bigint;
  product: QuickCatalogRow;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Respuesta inválida del servidor (respuesta)");
  return value as Record<string, unknown>;
}

/** Lectura tipada de la respuesta de `set_pos_product_price`. */
export function parseSetPriceResult(data: unknown): SetPriceResult {
  const record = asRecord(data);
  if (record.status !== "SET" && record.status !== "UNCHANGED") throw new Error("Respuesta inválida del servidor (status)");
  const price = record.priceCents;
  if (typeof price !== "string" || !/^[1-9]\d*$/.test(price)) throw new Error("Respuesta inválida del servidor (precio)");
  return { status: record.status, priceCents: BigInt(price), product: parseCatalogRow(record.product) };
}

export type ProductRequestOutcome =
  /** Tiene precio: sigue el flujo normal (stock/cantidad/peso). */
  | "ADD"
  /** Sin precio y con conexión: se abre el modal "Producto sin precio" para fijarlo. */
  | "ASK_PRICE"
  /** Sin precio y sin conexión: no se vende a $0 ni se guarda un precio pendiente; sólo se avisa. */
  | "NO_PRICE_OFFLINE";

/**
 * ÚNICO punto de decisión para escanear, tocar la tarjeta, buscar o recibir del servidor un producto:
 * ninguna vía agrega un producto sin precio al ticket. Con precio no cambia nada (stock, pack, recargo
 * y offline funcionan igual que siempre); sin conexión sólo se bloquea el establecimiento del precio.
 */
export function resolveProductRequest(product: { pricePerKgCents: bigint }, online: boolean): ProductRequestOutcome {
  if (!isPriceMissing(product)) return "ADD";
  return online ? "ASK_PRICE" : "NO_PRICE_OFFLINE";
}
