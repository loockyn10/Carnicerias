import { isIsoDate } from "../date-range";
import { asArray, asRecord, int, strOrNull } from "../rpc-json";
import { buildEan13, type EanSchemeConfig } from "../vacuum-ean";
import { defaultExpiry, parseVacuumProducts, type VacuumProductOption } from "../vacuum";

/**
 * Datos de la pantalla de la estación: lectura de las RPC de `202611070096`, y las reglas de «este corte está listo para envasar solo».
 * Todo lo comercial (precio, vencimiento, PLU, esquema EAN) sale de lo que ya existe en Envasados: acá no se inventa ninguna regla.
 */

export interface StationProduct extends VacuumProductOption {
  categoryId: string | null;
  categoryName: string | null;
  /** Paquetes de este corte en los últimos 14 días en la sucursal (orden de «frecuentes»). */
  recentPackages: number;
}

export function parseStationProducts(value: unknown): StationProduct[] {
  const base = parseVacuumProducts(value);
  const raw = asArray(value);
  return base.map((product, index) => {
    const record = asRecord(raw[index]);
    return { ...product, categoryId: strOrNull(record.categoryId), categoryName: strOrNull(record.categoryName), recentPackages: int(record.recentPackages) };
  });
}

export interface StationSummary {
  packages: number;
  grams: number;
  lastProductName: string | null;
  lastAt: string | null;
}

export const EMPTY_STATION_SUMMARY: StationSummary = { packages: 0, grams: 0, lastProductName: null, lastAt: null };

export function parseStationSummary(value: unknown): StationSummary {
  const record = asRecord(value);
  return { packages: int(record.packages), grams: int(record.grams), lastProductName: strOrNull(record.lastProductName), lastAt: strOrNull(record.lastAt) };
}

// ---------------------------------------------------------------------------------------------------------------------
// ¿Está listo el corte? (nada se registra solo si falta algo)
// ---------------------------------------------------------------------------------------------------------------------

export interface ProductionParams {
  /** Fecha de elaboración. `null` = la de hoy en la zona horaria de la organización (sigue al día si la pantalla queda abierta). */
  packedOn: string | null;
  /** Vencimiento cargado a mano por corte, SÓLO para los cortes sin vida útil configurada (id de producto → fecha). */
  expiryByProduct: Record<string, string>;
}

export interface Readiness {
  ready: boolean;
  /** Lo que impide registrar, en castellano (vacío si está listo). */
  problems: string[];
  /** Vencimiento que se va a usar (calculado con la vida útil o cargado a mano); null si falta. */
  expiresOn: string | null;
  /** Vencimiento que se manda al servidor: null = que lo calcule él con la vida útil configurada (así nunca hace falta el permiso de corregirlo). */
  expiresOnToSend: string | null;
}

export function productReadiness(product: StationProduct | null, params: ProductionParams, today: string, ean: EanSchemeConfig | null): Readiness {
  if (!product) return { ready: false, problems: ["Elegí el corte que vas a envasar"], expiresOn: null, expiresOnToSend: null };
  const problems: string[] = [];
  const packedOn = params.packedOn ?? today;
  if (!isIsoDate(packedOn)) problems.push("La fecha de elaboración es inválida");
  if (product.pricePerKgCents === null) problems.push("El corte no tiene un precio vigente en esta sucursal");
  if (!ean) problems.push("Falta configurar el esquema EAN-13 de envasados");
  else {
    // Una prueba con valores neutros: sólo detecta lo que depende del corte (PLU ausente o inválido para el esquema).
    const probe = buildEan13(ean, { plu: product.plu, priceCents: 100n, weightGrams: 100 });
    if (!probe.ok) problems.push(probe.message);
  }
  let expiresOn: string | null = null;
  let expiresOnToSend: string | null = null;
  if (product.shelfLifeDays !== null) {
    expiresOn = isIsoDate(packedOn) ? defaultExpiry(packedOn, product.shelfLifeDays) : null;
  } else {
    const manual = params.expiryByProduct[product.productId] ?? null;
    if (manual === null || !isIsoDate(manual)) problems.push("Este corte no tiene vida útil configurada: cargá el vencimiento");
    else if (isIsoDate(packedOn) && manual < packedOn) problems.push("El vencimiento no puede ser anterior a la elaboración");
    else { expiresOn = manual; expiresOnToSend = manual; }
  }
  return { ready: problems.length === 0, problems, expiresOn, expiresOnToSend };
}

// ---------------------------------------------------------------------------------------------------------------------
// Selección de cortes: favoritos, frecuentes, categorías y búsqueda
// ---------------------------------------------------------------------------------------------------------------------

export interface ProductFilter {
  query: string;
  /** null = todas; "FAVORITES" = sólo favoritos; si no, un id de categoría. */
  category: string | null;
}

export const FAVORITES_FILTER = "FAVORITES";

function normalizeSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/** Cortes visibles: favoritos primero, después los más usados de los últimos días y por último alfabético. */
export function visibleProducts(products: StationProduct[], filter: ProductFilter, favorites: readonly string[]): StationProduct[] {
  const query = normalizeSearch(filter.query);
  const favoriteSet = new Set(favorites);
  const matches = products.filter((product) => {
    if (filter.category === FAVORITES_FILTER && !favoriteSet.has(product.productId)) return false;
    if (filter.category !== null && filter.category !== FAVORITES_FILTER && product.categoryId !== filter.category) return false;
    if (query === "") return true;
    return [product.name, product.sku ?? "", product.plu ?? "", product.categoryName ?? ""].some((field) => normalizeSearch(field).includes(query));
  });
  return matches.toSorted((a, b) => {
    const favorite = Number(favoriteSet.has(b.productId)) - Number(favoriteSet.has(a.productId));
    if (favorite !== 0) return favorite;
    if (b.recentPackages !== a.recentPackages) return b.recentPackages - a.recentPackages;
    return a.name.localeCompare(b.name, "es");
  });
}

export interface CategoryOption {
  id: string;
  name: string;
  count: number;
}

export function categoryOptions(products: StationProduct[]): CategoryOption[] {
  const byId = new Map<string, CategoryOption>();
  for (const product of products) {
    if (product.categoryId === null) continue;
    const existing = byId.get(product.categoryId);
    if (existing) existing.count += 1;
    else byId.set(product.categoryId, { id: product.categoryId, name: product.categoryName ?? "Sin nombre", count: 1 });
  }
  return [...byId.values()].toSorted((a, b) => a.name.localeCompare(b.name, "es"));
}

/** Peso en kg con tres decimales y coma («0,825 kg»): siempre el mismo largo para que el número no salte en pantalla. */
export function formatKg(grams: number): string {
  return `${(Math.max(0, grams) / 1000).toFixed(3).replace(".", ",")} kg`;
}
