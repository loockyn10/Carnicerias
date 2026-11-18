import { createHash } from "node:crypto";

import { slideToItemBase } from "./artwork";
import { FOLDER_STATE_LABELS, isGeneratable, parseItemFacts, slugify, type FolderItemFacts } from "./artwork-folders";

/**
 * «Descargar promociones Feed» (D-103), lado servidor y puro: de lo que entrega `get_promotion_feed_state` a qué promociones hay que
 * descargar. La base trae las promociones activas de la sucursal de Cartelería resueltas por el resolvedor compartido (precio, promoción,
 * foto y estado de HOY) y lo último descargado de cada una; acá el MISMO motor que dibuja la pieza (`buildOfferSlide` → `slideToItemBase`)
 * arma lo que la imagen muestra y se calcula su firma.
 *
 * Firma: sha-256 de los importes y condiciones que dibuja la pieza Feed (precio grande, precio normal, condición, mecánica, % OFF, sufijo
 * y unidad). Una promoción está PENDIENTE si se puede generar hoy y su firma difiere de la última descargada (o nunca se descargó). Cambiar
 * el precio de lista del producto, el descuento o el pack cambia lo dibujado y la vuelve pendiente; cambiar el nombre, la foto o la vigencia no.
 */

export const FEED_SIGNATURE_VERSION = "feed-v1";

export interface PromotionFeedDownload {
  signature: string;
  summary: string | null;
  at: string | null;
  batchId: string;
}

export interface PromotionFeedItem extends FolderItemFacts {
  promotionId: string;
  /** Firma de lo que la pieza mostraría HOY; null = hoy no se puede generar. */
  signature: string | null;
  downloaded: PromotionFeedDownload | null;
}

export interface PromotionFeedLastBatch {
  batchId: string;
  at: string | null;
  count: number;
}

export interface PromotionFeedState {
  branchId: string | null;
  branchName: string | null;
  items: PromotionFeedItem[];
  lastBatch: PromotionFeedLastBatch | null;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

/** Firma de lo que dibuja la pieza Feed de un elemento vigente; null si hoy no se puede generar. */
export function feedPriceSignature(item: Pick<FolderItemFacts, "state" | "offer" | "productId">): string | null {
  if (!isGeneratable(item) || !item.offer) return null;
  const drawn = slideToItemBase(item.productId, item.offer);
  // Orden de claves fijo: la misma pieza siempre da el mismo texto. Sin nombre, foto ni vigencia.
  const canonical = JSON.stringify([
    FEED_SIGNATURE_VERSION, drawn.unitType, drawn.regularPrice, drawn.promotionalPrice, drawn.promotionCondition, drawn.mechanic, drawn.savings,
    drawn.priceSuffix, drawn.unitLabel
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function parseDownload(raw: unknown): PromotionFeedDownload | null {
  if (!isRecord(raw)) return null;
  const signature = asString(raw.signature);
  const batchId = asString(raw.batchId);
  if (!signature || !batchId) return null;
  return { signature, batchId, summary: asString(raw.summary), at: asString(raw.at) };
}

function parseLastBatch(raw: unknown): PromotionFeedLastBatch | null {
  if (!isRecord(raw)) return null;
  const batchId = asString(raw.batchId);
  if (!batchId) return null;
  const count = typeof raw.count === "number" && Number.isSafeInteger(raw.count) ? raw.count : 0;
  return { batchId, at: asString(raw.at), count };
}

/** JSON de `get_promotion_feed_state` → estado. null = no es una respuesta válida. Un elemento raro se descarta. */
export function parsePromotionFeedState(raw: unknown, now: Date = new Date()): PromotionFeedState | null {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null;
  const items: PromotionFeedItem[] = [];
  for (const entry of raw.items as unknown[]) {
    const facts = parseItemFacts(entry, now);
    if (facts?.kind !== "PROMOTION" || !isRecord(entry)) continue;
    items.push({ ...facts, promotionId: facts.itemId, signature: feedPriceSignature(facts), downloaded: parseDownload(entry.downloaded) });
  }
  items.sort((a, b) => a.position - b.position);
  return { branchId: asString(raw.branchId), branchName: asString(raw.branchName), items, lastBatch: parseLastBatch(raw.lastBatch) };
}

/** Lo que hay que descargar: se puede generar hoy y nunca se descargó o lo dibujado cambió desde la última descarga. */
export function isPending(item: Pick<PromotionFeedItem, "signature" | "downloaded">): boolean {
  return item.signature !== null && item.signature !== item.downloaded?.signature;
}

export function pendingPromotions(state: Pick<PromotionFeedState, "items">): PromotionFeedItem[] {
  return state.items.filter(isPending);
}

/** Lo que no se puede generar hoy (sin precio, producto inactivo, no se vende en la sucursal…), con el motivo en lenguaje simple. */
export function skippedPromotions(state: Pick<PromotionFeedState, "items">): { name: string; reason: string }[] {
  return state.items.filter((item) => item.signature === null).map((item) => ({ name: item.name, reason: FOLDER_STATE_LABELS[item.state] }));
}

/** «Promo-Feed_pata-muslo_2026-11-18_a1b2c3.png»: el producto para reconocerla en la galería, la fecha de la descarga y el final del id. */
export function feedFilename(item: Pick<PromotionFeedItem, "name" | "promotionId">, localDate: string): string {
  return `Promo-Feed_${slugify(item.name, 50)}_${localDate}_${item.promotionId.replace(/-/g, "").slice(-6)}.png`;
}
