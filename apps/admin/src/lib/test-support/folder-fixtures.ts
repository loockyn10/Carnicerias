/**
 * Hechos de una carpeta tal como los devuelve `get_signage_folder_facts` (D-086): el JSON de cada elemento con su promoción, su estado,
 * su precio de lista y su foto. Sirven para probar la lógica de carpetas, la generación en lote y la interfaz sin base de datos.
 */

export const FOLDER_ID = "f1000000-0000-4000-8000-000000000001";
export const ORG = "c2000000-0000-4000-8000-000000000001";
export const FOLDER_BRANCH = "c3000000-0000-4000-8000-000000000001";

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const itemId = (n: number) => uuid("f2000000", n);
export const productId = (n: number) => uuid("c5000000", n);
export const promotionId = (n: number) => uuid("96000000", n);

type Raw = Record<string, unknown>;

export function photoOf(product: number, hasAlpha: boolean | null = true): Raw {
  return { storagePath: `${ORG}/${productId(product)}/c6000000-0000-4000-8000-0000000000${String(product).padStart(2, "0")}.png`, contentType: "image/png", hasAlpha };
}

interface ItemOptions {
  n: number;
  name: string;
  unitType?: "UNIT" | "WEIGHT";
  listPriceCents?: number;
  reason?: string | null;
  photo?: Raw | null;
  promotion?: Raw | null;
  extra?: Raw;
}

/** Un elemento de la carpeta (n = posición 1-based; el id del elemento, del producto y de la promoción derivan de n). */
export function rawItem(options: ItemOptions): Raw {
  const { n, name } = options;
  const reason = options.reason ?? null;
  return {
    slideId: itemId(n), entryId: itemId(n), kind: options.promotion ? "PROMOTION" : "PRODUCT", position: n, productId: productId(n), name, sku: `SKU-${String(n)}`,
    unitType: options.unitType ?? "WEIGHT", photo: options.photo === undefined ? photoOf(n) : options.photo, available: reason === null, unavailableReason: reason,
    listPriceCents: String(options.listPriceCents ?? 1_000_000), bulkMinimumUnits: null, bulkDiscountBps: null, packSizeUnits: null, packDiscountBps: null,
    weightTiers: [], promotion: options.promotion ?? null, ...options.extra
  };
}

/** Promoción por umbral: «desde 2 kg, 10 %». */
export function thresholdPromotion(n: number, extra: Raw = {}): Raw {
  return {
    promotionId: promotionId(n), mode: "THRESHOLD", status: "ACTIVE", active: true, branchId: null, validFrom: "2026-10-01T00:00:00Z", validUntil: null,
    minimumGrams: 2000, discountType: "PERCENTAGE", discountValue: "1000", packQuantityGrams: null, packQuantityUnits: null, packPriceCents: null, ...extra
  };
}

/** Pack a precio total: «2 kg por $14.000». */
export function packPromotion(n: number, extra: Raw = {}): Raw {
  return {
    promotionId: promotionId(n), mode: "PACK_FIXED_TOTAL", status: "ACTIVE", active: true, branchId: null, validFrom: "2026-10-01T00:00:00Z", validUntil: null,
    minimumGrams: null, discountType: null, discountValue: null, packQuantityGrams: 2000, packQuantityUnits: null, packPriceCents: "1400000", ...extra
  };
}

export function rawFolderFacts(items: Raw[], extra: Raw = {}): Raw {
  return {
    folderId: FOLDER_ID, name: "Ofertas finde", generateFeed: true, generateStory: true, branchId: FOLDER_BRANCH, branchName: "Central",
    itemCount: items.length, items, ...extra
  };
}

/**
 * La carpeta «Ofertas finde» de la validación: 4 promociones vigentes (una vence mañana, una sin foto), una vencida, una desactivada y un
 * producto suelto sin promoción.
 */
export function weekendFolder(now: Date = new Date()): Raw {
  const tomorrow = new Date(now.getTime() + 20 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  return rawFolderFacts([
    rawItem({ n: 1, name: "Pata muslo", listPriceCents: 1_000_000, promotion: thresholdPromotion(1) }),
    rawItem({ n: 2, name: "Costilla de cerdo", listPriceCents: 800_000, promotion: packPromotion(2, { validUntil: tomorrow }) }),
    rawItem({ n: 3, name: "Coca Cola", unitType: "UNIT", listPriceCents: 200_000, promotion: packPromotion(3, { packQuantityGrams: null, packQuantityUnits: 3, packPriceCents: "540000" }) }),
    rawItem({ n: 4, name: "Matambre", listPriceCents: 1_200_000, photo: null, promotion: thresholdPromotion(4, { minimumGrams: 1000, discountType: "FIXED_PRICE_PER_KG", discountValue: "1100000" }) }),
    rawItem({ n: 5, name: "Chorizo vencido", unitType: "UNIT", reason: "PROMO_EXPIRED", promotion: packPromotion(5, { status: "EXPIRED", validUntil: yesterday, packQuantityGrams: null, packQuantityUnits: 6, packPriceCents: "800000" }) }),
    rawItem({ n: 6, name: "Bife desactivado", reason: "PROMO_EXPIRED", promotion: thresholdPromotion(6, { status: "EXPIRED", active: false }) }),
    rawItem({ n: 7, name: "Nalga vacuna", listPriceCents: 1_790_000 })
  ], { name: "Ofertas finde" });
}
