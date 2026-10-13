/** Filas de `get_signage_promotion_catalog` para probar los carteles de ofertas (la forma real de la RPC; precios en centavos como texto). */

const BRANCH = "b0000000-0000-4000-8000-000000000001";

let counter = 0;
const id = (prefix: string) => `${prefix}0000000-0000-4000-8000-${String((counter += 1)).padStart(12, "0")}`;

export type CatalogRow = Record<string, unknown>;

function row(base: Record<string, unknown>): CatalogRow {
  return {
    promotionId: id("a"), productId: id("c"), sku: null, branchId: BRANCH, branchName: "Central", status: "ACTIVE", validFrom: "2026-10-01", validUntil: null,
    hasPhoto: false, unavailableReason: null, minimumGrams: null, discountType: null, discountValue: null,
    packQuantityGrams: null, packQuantityUnits: null, packPriceCents: null, ...base
  };
}

/** «Desde 2 kg a $6.500/kg» con precio normal $7.000/kg (el caso de referencia del negocio). */
export const choricito = (): CatalogRow => row({
  productName: "Choricito de cerdo", unitType: "WEIGHT", mode: "THRESHOLD", listPriceCents: "700000", minimumGrams: 2000, discountType: "FIXED_PRICE_PER_KG", discountValue: "650000"
});

export const pataMuslo = (): CatalogRow => row({
  productName: "Pata muslo", unitType: "WEIGHT", mode: "THRESHOLD", listPriceCents: "790000", minimumGrams: 3000, discountType: "FIXED_PRICE_PER_KG", discountValue: "699900"
});

/** Porcentaje: 10 % sobre $12.000/kg desde 3 kg → $10.800/kg. */
export const filetPechuga = (): CatalogRow => row({
  productName: "Filet de pechuga", unitType: "WEIGHT", mode: "THRESHOLD", listPriceCents: "1200000", minimumGrams: 3000, discountType: "PERCENTAGE", discountValue: "1000"
});

/** Pack por peso: 2 kg por $15.000 (normal $17.000). */
export const costilla = (): CatalogRow => row({
  productName: "Costilla", unitType: "WEIGHT", mode: "PACK_FIXED_TOTAL", listPriceCents: "850000", packQuantityGrams: 2000, packPriceCents: "1500000"
});

/** Pack por unidades: 12 unidades por $8.900 (normal $10.200; $741,67 c/u). */
export const hamburguesas = (): CatalogRow => row({
  productName: "Hamburguesas caseras", unitType: "UNIT", mode: "PACK_FIXED_TOTAL", listPriceCents: "85000", packQuantityUnits: 12, packPriceCents: "890000"
});

export const nombreLargo = (): CatalogRow => row({
  productName: "Milanesa de pollo rebozada con jamón y queso", unitType: "WEIGHT", mode: "THRESHOLD", listPriceCents: "1450000", minimumGrams: 2500, discountType: "FIXED_PRICE_PER_KG", discountValue: "1299950"
});

/** Precio con centavos reales ($1.729,75). */
export const conCentavos = (): CatalogRow => row({
  productName: "Mayonesa", unitType: "UNIT", mode: "PACK_FIXED_TOTAL", listPriceCents: "210000", packQuantityUnits: 3, packPriceCents: "518975"
});

export const vencida = (): CatalogRow => row({
  productName: "Promo vencida", unitType: "WEIGHT", mode: "THRESHOLD", status: "EXPIRED", validUntil: "2026-09-01", listPriceCents: "700000", minimumGrams: 2000, discountType: "FIXED_PRICE_PER_KG", discountValue: "650000"
});

export const proxima = (): CatalogRow => row({
  productName: "Promo próxima", unitType: "WEIGHT", mode: "THRESHOLD", status: "UPCOMING", validFrom: "2026-12-01", listPriceCents: "700000", minimumGrams: 2000, discountType: "FIXED_PRICE_PER_KG", discountValue: "650000"
});

export const productoInactivo = (): CatalogRow => row({
  productName: "Producto inactivo", unitType: "WEIGHT", mode: "THRESHOLD", unavailableReason: "INACTIVE", listPriceCents: "700000", minimumGrams: 2000, discountType: "FIXED_PRICE_PER_KG", discountValue: "650000"
});

/** Un pack que cuesta MÁS que comprar suelto: no baja el precio, no hay oferta que anunciar. */
export const packCaro = (): CatalogRow => row({
  productName: "Pack caro", unitType: "UNIT", mode: "PACK_FIXED_TOTAL", listPriceCents: "85000", packQuantityUnits: 12, packPriceCents: "1500000"
});

export const catalog = (...rows: CatalogRow[]) => ({ promotions: rows, groups: [] });
export { BRANCH };
