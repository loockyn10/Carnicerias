/**
 * Alta rápida de producto desde el scanner (POS de Central). Lógica pura: validación del formulario
 * mínimo (nombre, costo opcional, precio) y lectura tipada de la respuesta de la RPC
 * `create_pos_quick_product`. Nada acá toca red ni SQLite.
 */

/** Tope de cordura contra un cero de más tipeado en el mostrador ($1.000.000.000). */
const MAX_PRICE_CENTS = 100_000_000_000n;

/**
 * "1200", "1200,50", "1200.5", "$ 1.200", "1.200,50" -> centavos. `null` si no es un importe válido.
 * Con punto + 3 dígitos se interpreta como separador de miles ("1.200" = 1200), nunca como decimal.
 */
export function parsePesosToCents(raw: string): bigint | null {
  const value = raw.replace(/[$\s]/g, "");
  if (value === "") return null;
  const plain = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value);
  const grouped = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(value);
  const match = grouped ?? plain;
  if (!match) return null;
  const whole = (match[1] ?? "").replace(/\./g, "");
  const cents = BigInt(whole) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return cents > MAX_PRICE_CENTS ? null : cents;
}

export interface QuickProductForm {
  name: string;
  /** Texto del campo "Costo" (opcional: vacío = sin costo). */
  cost: string;
  price: string;
}

export interface QuickProductFieldErrors {
  name?: string;
  cost?: string;
  price?: string;
}

export type QuickProductValidation =
  | { ok: true; name: string; priceCents: bigint; costCents: bigint | null }
  | { ok: false; errors: QuickProductFieldErrors };

export function validateQuickProduct(form: QuickProductForm): QuickProductValidation {
  const errors: QuickProductFieldErrors = {};
  const name = form.name.trim().replace(/\s+/g, " ");
  if (name === "") errors.name = "Escribí el nombre del producto";
  else if (name.length > 120) errors.name = "El nombre es demasiado largo (máx. 120)";

  const priceCents = parsePesosToCents(form.price);
  if (form.price.trim() === "") errors.price = "Escribí el precio de venta";
  else if (priceCents === null || priceCents <= 0n) errors.price = "Precio inválido";

  let costCents: bigint | null = null;
  if (form.cost.trim() !== "") {
    costCents = parsePesosToCents(form.cost);
    if (costCents === null || costCents <= 0n) errors.cost = "Costo inválido (o dejalo vacío)";
  }

  if (errors.name || errors.price || errors.cost || priceCents === null) return { ok: false, errors };
  return { ok: true, name, priceCents, costCents };
}

/** Fila de catálogo tal como la devuelve la RPC (misma forma que `pull_pos_state`). */
export interface QuickCatalogRow {
  organizationId: string;
  branchId: string;
  branchName: string;
  categoryId: string;
  categoryName: string;
  categoryColorHex: string | null;
  categorySortOrder: number;
  categoryIds: string[];
  productId: string;
  productName: string;
  productSku: string | null;
  unitType: "WEIGHT" | "UNIT";
  pricePerKgCents: string;
  barcodes: string[];
}

export type QuickCreateResult =
  /** Producto nuevo creado y habilitado sólo en esta sucursal. */
  | { status: "CREATED"; product: QuickCatalogRow }
  /** El código ya era de un producto vendible acá (catálogo local desactualizado): no se creó nada. */
  | { status: "EXISTS_SELLABLE"; product: QuickCatalogRow }
  /** Existía (activo, con precio) pero no estaba en el surtido de esta sucursal: el servidor lo habilitó acá. */
  | { status: "EXISTS_ENABLED"; product: QuickCatalogRow }
  /** Existe pero hoy no es vendible (inactivo, sin precio o categoría inactiva): no se reactiva ni se habilita. */
  | { status: "EXISTS_UNSELLABLE"; productName: string };

/** Resultado del paso previo al modal (`resolve_pos_scan_barcode`): el código no existe, o ya existía. */
export type ScanResolveResult = { status: "NOT_FOUND" } | Exclude<QuickCreateResult, { status: "CREATED" }>;

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Respuesta inválida del servidor (${what})`);
  return value as Record<string, unknown>;
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw new Error(`Respuesta inválida del servidor (${key})`);
  return value;
}

function parseRow(value: unknown): QuickCatalogRow {
  const row = asRecord(value, "producto");
  const unitType = row.unitType;
  if (unitType !== "WEIGHT" && unitType !== "UNIT") throw new Error("Respuesta inválida del servidor (unitType)");
  const price = text(row, "pricePerKgCents");
  if (!/^\d+$/.test(price)) throw new Error("Respuesta inválida del servidor (precio)");
  const categoryId = text(row, "categoryId");
  const categoryIds = Array.isArray(row.categoryIds) ? row.categoryIds.filter((id): id is string => typeof id === "string") : [];
  return {
    organizationId: text(row, "organizationId"),
    branchId: text(row, "branchId"),
    branchName: text(row, "branchName"),
    categoryId,
    categoryName: text(row, "categoryName"),
    categoryColorHex: typeof row.categoryColorHex === "string" ? row.categoryColorHex : null,
    categorySortOrder: typeof row.categorySortOrder === "number" ? row.categorySortOrder : 0,
    categoryIds: categoryIds.length > 0 ? categoryIds : [categoryId],
    productId: text(row, "productId"),
    productName: text(row, "productName"),
    productSku: typeof row.productSku === "string" ? row.productSku : null,
    unitType,
    pricePerKgCents: price,
    barcodes: Array.isArray(row.barcodes) ? row.barcodes.filter((code): code is string => typeof code === "string") : []
  };
}

export function parseQuickCreateResult(data: unknown): QuickCreateResult {
  const record = asRecord(data, "respuesta");
  switch (record.status) {
    case "CREATED":
    case "EXISTS_SELLABLE":
    case "EXISTS_ENABLED":
      return { status: record.status, product: parseRow(record.product) };
    case "EXISTS_UNSELLABLE":
      return { status: record.status, productName: typeof record.productName === "string" ? record.productName : "" };
    default:
      throw new Error("Respuesta inválida del servidor (status)");
  }
}

export function parseScanResolveResult(data: unknown): ScanResolveResult {
  if (asRecord(data, "respuesta").status === "NOT_FOUND") return { status: "NOT_FOUND" };
  const result = parseQuickCreateResult(data);
  if (result.status === "CREATED") throw new Error("Respuesta inválida del servidor (status)");
  return result;
}

/**
 * Capacidad "este dispositivo es el POS de Central y puede dar de alta productos". El servidor la
 * decide (`get_pos_device_capabilities`); acá sólo se recuerda, por sucursal, para que el modal
 * también abra sin conexión y después de reiniciar. Sin dato (primer arranque sin sync) = no.
 * Se refresca como mucho cada `CAPABILITY_MAX_AGE_MS` (cambia sólo si Admin reconfigura la sucursal
 * de Central), no en cada sync; la RPC de alta vuelve a verificarlo siempre en el servidor.
 */
const CAPABILITY_KEY = "pos.quickProductCreate";
export const CAPABILITY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

interface CapabilityMemory { branchId: string; enabled: boolean; checkedAt: number }

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readMemory(storage: StorageLike | null): CapabilityMemory | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(CAPABILITY_KEY) ?? "null") as Partial<CapabilityMemory> | null;
    if (!parsed || typeof parsed.branchId !== "string" || typeof parsed.enabled !== "boolean") return null;
    return { branchId: parsed.branchId, enabled: parsed.enabled, checkedAt: typeof parsed.checkedAt === "number" ? parsed.checkedAt : 0 };
  } catch {
    return null;
  }
}

export function readQuickProductCreate(branchId: string | null, storage: StorageLike | null = defaultStorage()): boolean {
  if (!branchId) return false;
  const memory = readMemory(storage);
  return memory?.branchId === branchId && memory.enabled;
}

export function writeQuickProductCreate(branchId: string, enabled: boolean, storage: StorageLike | null = defaultStorage(), now = Date.now()): void {
  if (!storage) return;
  try {
    storage.setItem(CAPABILITY_KEY, JSON.stringify({ branchId, enabled, checkedAt: now } satisfies CapabilityMemory));
  } catch {
    // Almacenamiento bloqueado/lleno: la capacidad simplemente no se recuerda.
  }
}

/** True when the server should be asked again: nothing remembered for this branch, or it is stale.
 * Without usable storage there is nowhere to remember the answer, so never ask. */
export function shouldRefreshQuickProductCreate(branchId: string, storage: StorageLike | null = defaultStorage(), now = Date.now()): boolean {
  if (!storage) return false;
  const memory = readMemory(storage);
  return memory?.branchId !== branchId || now - memory.checkedAt > CAPABILITY_MAX_AGE_MS;
}
