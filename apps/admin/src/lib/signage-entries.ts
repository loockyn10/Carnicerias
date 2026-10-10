import { MAX_SIGNAGE_SLIDES, type EditorChild, type EditorEntry, type EditorUnavailableReason, type EntryKind } from "./signage";
import type { PromotionCatalog, PromotionGroup, PromotionOption } from "./signage-promotions";

/**
 * Las entradas de la lista de una pantalla (D-084): producto, promoción o grupo. Puro: arma las entradas que muestra el editor a partir
 * de lo elegido y las convierte en lo que viaja al servidor (sólo `{ kind, id }`: nada de precios ni de nombres).
 */

/** Clave única de una entrada dentro de la pantalla (el servidor rechaza repetidos). */
export function entryKey(entry: Pick<EditorEntry, "kind" | "id">): string {
  return `${entry.kind}:${entry.id}`;
}

export function entriesToInput(entries: readonly EditorEntry[]): { kind: EntryKind; id: string }[] {
  return entries.map((entry) => ({ kind: entry.kind, id: entry.id }));
}

/** Motivo con el que una promoción no se reproduce hoy (null = se reproduce). Vencida o próxima mandan sobre el estado del producto. */
export function promotionReason(option: Pick<PromotionOption, "status" | "unavailable">): EditorUnavailableReason | null {
  if (option.status === "EXPIRED") return "PROMO_EXPIRED";
  if (option.status === "UPCOMING") return "PROMO_UPCOMING";
  return option.unavailable;
}

export function entryFromPromotion(option: PromotionOption): EditorEntry {
  return {
    kind: "PROMOTION", id: option.promotionId, name: option.productName, sku: option.sku, unitType: option.unitType, summary: option.summary,
    unavailable: promotionReason(option), hasPhoto: option.hasPhoto, children: []
  };
}

/** Las promociones de un grupo tal como se reproducirían hoy (con el motivo si alguna se saltea). Una promoción que ya no existe se omite. */
export function childrenOfGroup(group: PromotionGroup, promotions: readonly PromotionOption[]): EditorChild[] {
  const byId = new Map(promotions.map((option) => [option.promotionId, option]));
  return group.promotionIds.flatMap((promotionId) => {
    const option = byId.get(promotionId);
    return option ? [{ promotionId, name: option.productName, summary: option.summary, unavailable: promotionReason(option), hasPhoto: option.hasPhoto }] : [];
  });
}

export function entryFromGroup(group: PromotionGroup, catalog: Pick<PromotionCatalog, "promotions">): EditorEntry {
  return { kind: "GROUP", id: group.id, name: group.name, sku: null, unitType: null, summary: null, unavailable: null, hasPhoto: true, children: childrenOfGroup(group, catalog.promotions) };
}

export function entryFromProduct(product: { id: string; name: string; sku: string | null; unitType: "UNIT" | "WEIGHT" }): EditorEntry {
  return { kind: "PRODUCT", id: product.id, name: product.name, sku: product.sku, unitType: product.unitType, summary: null, unavailable: null, hasPhoto: true, children: [] };
}

const DUPLICATE_MESSAGES: Record<EntryKind, string> = {
  PRODUCT: "Ese producto ya está en la presentación",
  PROMOTION: "Esa promoción ya está en la presentación",
  GROUP: "Ese grupo ya está en la presentación"
};

/** Agrega al final y evita repetidos; con el tope de la pantalla no agrega y lo explica. */
export function addEntry(entries: readonly EditorEntry[], entry: EditorEntry): { entries: EditorEntry[]; error: string | null } {
  if (entries.some((existing) => entryKey(existing) === entryKey(entry))) return { entries: [...entries], error: DUPLICATE_MESSAGES[entry.kind] };
  if (entries.length >= MAX_SIGNAGE_SLIDES) return { entries: [...entries], error: `Una pantalla admite hasta ${String(MAX_SIGNAGE_SLIDES)} ofertas` };
  return { entries: [...entries, entry], error: null };
}

/** Agrega varias promociones de una vez (lo elegido en el selector), salteando las que ya estaban; devuelve cuántas se agregaron. */
export function addPromotions(entries: readonly EditorEntry[], options: readonly PromotionOption[]): { entries: EditorEntry[]; added: number; error: string | null } {
  let current = [...entries];
  let added = 0;
  let error: string | null = null;
  for (const option of options) {
    const outcome = addEntry(current, entryFromPromotion(option));
    if (outcome.error !== null) {
      if (!outcome.error.includes("ya está")) { error = outcome.error; break; }
      continue;
    }
    current = outcome.entries;
    added += 1;
  }
  return { entries: current, added, error };
}

/** Cuántas entradas no se reproducen hoy (por el motivo que sea) y cuántas promociones sin foto hay: lo que el editor resume. */
export function summarizeEntries(entries: readonly EditorEntry[]): { blocked: number; withoutPhoto: number } {
  let blocked = 0;
  let withoutPhoto = 0;
  for (const entry of entries) {
    if (entry.kind === "GROUP") {
      for (const child of entry.children) {
        if (child.unavailable) blocked += 1;
        else if (!child.hasPhoto) withoutPhoto += 1;
      }
    } else if (entry.unavailable) blocked += 1;
    else if (entry.kind === "PROMOTION" && !entry.hasPhoto) withoutPhoto += 1;
  }
  return { blocked, withoutPhoto };
}
