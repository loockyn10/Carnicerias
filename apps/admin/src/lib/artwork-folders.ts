import { buildOfferSlide, parseSlideFacts, summarizeOffer, type MediaRef, type OfferSlideData, type SlideFacts } from "./signage";
import { formatIsoDate } from "./date-range";

/**
 * Carpetas de gráficas (D-086): una selección ordenada de PROMOCIONES (o productos sin promoción) y los formatos a generar. La carpeta guarda
 * referencias, nunca precio, descuento, foto ni nombre: al abrirla o generarla, la base resuelve lo VIGENTE (`get_signage_folder_facts`) y
 * el motor de pricing de la cartelería arma la oferta. Puro y sin red: de lo que entrega la base a lo que muestra y genera el Admin.
 */

export type FolderItemKind = "PROMOTION" | "PRODUCT";

export interface FolderItemRef {
  itemId: string;
  kind: FolderItemKind;
  /** promotionId o productId, según `kind`. */
  id: string;
  name: string | null;
  sku: string | null;
  unitType: "UNIT" | "WEIGHT" | null;
}

export interface FolderSummary {
  id: string;
  name: string;
  generateFeed: boolean;
  generateStory: boolean;
  items: FolderItemRef[];
  usedByDisplays: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

function parseItemRef(raw: unknown): FolderItemRef | null {
  if (!isRecord(raw)) return null;
  const itemId = asString(raw.itemId);
  const id = asString(raw.id);
  const kind = raw.kind;
  if (!itemId || !id || (kind !== "PROMOTION" && kind !== "PRODUCT")) return null;
  const unitType = raw.unitType === "UNIT" || raw.unitType === "WEIGHT" ? raw.unitType : null;
  return { itemId, kind, id, name: asString(raw.name), sku: asString(raw.sku), unitType };
}

/** JSON de `get_signage_folders` → carpetas. Una fila rara se descarta: nunca rompe la pantalla. */
export function parseFolders(raw: unknown): FolderSummary[] {
  if (!Array.isArray(raw)) return [];
  const folders: FolderSummary[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    const name = asString(entry.name);
    if (!id || !name) continue;
    const items = (Array.isArray(entry.items) ? entry.items as unknown[] : []).map(parseItemRef).filter((item): item is FolderItemRef => item !== null);
    const used = typeof entry.usedByDisplays === "number" && Number.isSafeInteger(entry.usedByDisplays) ? entry.usedByDisplays : 0;
    folders.push({ id, name, generateFeed: entry.generateFeed !== false, generateStory: entry.generateStory !== false, items, usedByDisplays: used });
  }
  return folders;
}

export function folderFormatsLabel(folder: Pick<FolderSummary, "generateFeed" | "generateStory">): string {
  if (folder.generateFeed && folder.generateStory) return "Feed + Story";
  return folder.generateFeed ? "Feed" : "Story";
}

export function folderItemsLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "elemento" : "elementos"}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hechos vigentes de cada elemento de una carpeta
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Estado de un elemento de la carpeta HOY, para una sucursal:
 *   READY       se puede generar / reproducir ahora;
 *   EXPIRED     la promoción venció;
 *   INACTIVE    la promoción está desactivada (no por fecha) o el producto está inactivo;
 *   UPCOMING    la promoción todavía no empezó;
 *   NOT_IN_BRANCH  no aplica a la sucursal elegida;
 *   NO_PRICE    el producto no tiene precio vigente.
 */
export type FolderItemState = "READY" | "EXPIRED" | "INACTIVE" | "UPCOMING" | "NOT_IN_BRANCH" | "NO_PRICE";

export const FOLDER_STATE_LABELS: Record<FolderItemState, string> = {
  READY: "Vigente",
  EXPIRED: "Promoción vencida",
  INACTIVE: "Inactiva",
  UPCOMING: "Todavía no empezó",
  NOT_IN_BRANCH: "No aplica a esta sucursal",
  NO_PRICE: "Sin precio vigente"
};

export interface FolderItemFacts {
  itemId: string;
  /** El producto de la promoción (o el producto suelto) al que pertenece la pieza. */
  productId: string;
  position: number;
  kind: FolderItemKind;
  name: string;
  sku: string | null;
  unitType: "UNIT" | "WEIGHT";
  state: FolderItemState;
  /** Los hechos del motor (null si el elemento no se puede mostrar) y la oferta resuelta con el motor de pricing. */
  facts: SlideFacts | null;
  offer: OfferSlideData | null;
  /** «$ 1.729,75 c/u · llevando 3 unidades»: lo que se va a generar. */
  summary: string | null;
  photo: MediaRef | null;
  hasPhoto: boolean;
  /** Fin de la vigencia (ISO) de la promoción; null = sin fin / no es una promoción. */
  validUntil: string | null;
  /** La promoción vence hoy o mañana (aviso antes de generar). */
  expiresSoon: boolean;
  productName: string;
}

export interface FolderFacts {
  folderId: string;
  name: string;
  generateFeed: boolean;
  generateStory: boolean;
  branchId: string | null;
  branchName: string | null;
  items: FolderItemFacts[];
}

function parsePhoto(raw: unknown): MediaRef | null {
  if (!isRecord(raw)) return null;
  const storagePath = asString(raw.storagePath);
  const contentType = raw.contentType;
  if (!storagePath || (contentType !== "image/jpeg" && contentType !== "image/png")) return null;
  return { storagePath, contentType, hasAlpha: typeof raw.hasAlpha === "boolean" ? raw.hasAlpha : null };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** ¿La promoción termina hoy o mañana (en las próximas 48 h)? Una vencida o sin fin no. */
export function endsSoon(validUntil: string | null, now: Date): boolean {
  if (!validUntil) return false;
  const end = Date.parse(validUntil);
  if (Number.isNaN(end)) return false;
  const remaining = end - now.getTime();
  return remaining > 0 && remaining <= 2 * DAY_MS;
}

/** «Vence hoy» / «Vence mañana» / «Vence el 15/10/2026» según falte; usa el calendario local de quien mira. */
export function expiryText(validUntil: string, now: Date): string {
  const end = new Date(validUntil);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(end, now)) return "Vence hoy";
  if (sameDay(end, new Date(now.getTime() + DAY_MS))) return "Vence mañana";
  return `Vence el ${formatIsoDate(`${String(end.getFullYear())}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`)}`;
}

function stateOf(raw: JsonRecord, promotionActive: boolean | null): FolderItemState {
  const reason = raw.unavailableReason;
  if (reason === "PROMO_EXPIRED") return promotionActive === false ? "INACTIVE" : "EXPIRED";
  if (reason === "PROMO_UPCOMING") return "UPCOMING";
  if (reason === "INACTIVE") return "INACTIVE";
  if (reason === "NOT_IN_BRANCH") return "NOT_IN_BRANCH";
  if (reason === "NO_PRICE") return "NO_PRICE";
  return "READY";
}

function parseItemFacts(raw: unknown, now: Date): FolderItemFacts | null {
  if (!isRecord(raw)) return null;
  const itemId = asString(raw.entryId);
  const productId = asString(raw.productId);
  const name = asString(raw.name);
  const unitType = raw.unitType === "UNIT" || raw.unitType === "WEIGHT" ? raw.unitType : null;
  if (!itemId || !productId || !name || !unitType) return null;
  const kind: FolderItemKind = raw.kind === "PROMOTION" ? "PROMOTION" : "PRODUCT";
  const facts = parseSlideFacts(raw);
  const promotion = facts?.promotion ?? null;
  const state = stateOf(raw, promotion?.active ?? null);
  const offer = state === "READY" && facts ? buildOfferSlide(facts) : null;
  // Un elemento «vigente» cuyo precio el motor no puede armar se trata como sin precio (nunca sale una pieza a $0).
  const finalState: FolderItemState = state === "READY" && !offer ? "NO_PRICE" : state;
  const photo = parsePhoto(raw.photo);
  const validUntil = promotion?.validUntil ?? null;
  return {
    itemId, productId, position: typeof raw.position === "number" ? raw.position : 0, kind, name, sku: asString(raw.sku), unitType,
    state: finalState, facts, offer: finalState === "READY" ? offer : null, summary: finalState === "READY" && offer ? summarizeOffer(offer) : null,
    photo, hasPhoto: photo !== null, validUntil, expiresSoon: finalState === "READY" && endsSoon(validUntil, now), productName: name
  };
}

/** JSON de `get_signage_folder_facts` → hechos de la carpeta para una sucursal. null = no es una respuesta de carpeta (no existe / otra organización). */
export function parseFolderFacts(raw: unknown, now: Date = new Date()): FolderFacts | null {
  if (!isRecord(raw)) return null;
  const folderId = asString(raw.folderId);
  const name = asString(raw.name);
  if (!folderId || !name) return null;
  const items = (Array.isArray(raw.items) ? raw.items as unknown[] : []).map((item) => parseItemFacts(item, now)).filter((item): item is FolderItemFacts => item !== null);
  items.sort((a, b) => a.position - b.position);
  return {
    folderId, name, generateFeed: raw.generateFeed !== false, generateStory: raw.generateStory !== false,
    branchId: asString(raw.branchId), branchName: asString(raw.branchName), items
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Revisión antes de generar
// ---------------------------------------------------------------------------------------------------------------------

export interface FolderReview {
  total: number;
  /** Se generan (vigentes). */
  ready: number;
  withoutPhoto: number;
  expiringSoon: number;
  /** Cuántos NO se generan, por estado. */
  skipped: Record<Exclude<FolderItemState, "READY">, number>;
  lines: { tone: "ok" | "warn"; text: string }[];
}

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`;

/** Resumen para el encabezado de la carpeta: lo que está bien (✓) y lo que hay que mirar (⚠), en lenguaje simple. */
export function reviewFolder(facts: Pick<FolderFacts, "items">): FolderReview {
  const skipped: FolderReview["skipped"] = { EXPIRED: 0, INACTIVE: 0, UPCOMING: 0, NOT_IN_BRANCH: 0, NO_PRICE: 0 };
  let ready = 0;
  let withoutPhoto = 0;
  let expiringSoon = 0;
  for (const item of facts.items) {
    if (item.state === "READY") {
      ready += 1;
      if (!item.hasPhoto) withoutPhoto += 1;
      if (item.expiresSoon) expiringSoon += 1;
    } else skipped[item.state] += 1;
  }
  const total = facts.items.length;
  const lines: FolderReview["lines"] = [];
  if (ready > 0) {
    lines.push(withoutPhoto === 0 ? { tone: "ok", text: "Fotos completas" } : { tone: "warn", text: `${plural(withoutPhoto, "producto sin foto", "productos sin foto")}: la pieza usa un panel de reemplazo` });
    lines.push({ tone: "ok", text: "Precios vigentes" });
  }
  if (expiringSoon > 0) lines.push({ tone: "warn", text: `${plural(expiringSoon, "promoción vence", "promociones vencen")} hoy o mañana` });
  if (skipped.EXPIRED > 0) lines.push({ tone: "warn", text: `${plural(skipped.EXPIRED, "promoción vencida", "promociones vencidas")}: no se generan` });
  if (skipped.INACTIVE > 0) lines.push({ tone: "warn", text: `${plural(skipped.INACTIVE, "elemento inactivo", "elementos inactivos")}: no se generan` });
  if (skipped.UPCOMING > 0) lines.push({ tone: "warn", text: `${plural(skipped.UPCOMING, "promoción todavía no empezó", "promociones todavía no empezaron")}: no se generan` });
  if (skipped.NOT_IN_BRANCH > 0) lines.push({ tone: "warn", text: `${plural(skipped.NOT_IN_BRANCH, "elemento no aplica", "elementos no aplican")} a esta sucursal: no se generan` });
  if (skipped.NO_PRICE > 0) lines.push({ tone: "warn", text: `${plural(skipped.NO_PRICE, "producto sin precio vigente", "productos sin precio vigente")}: no se generan` });
  return { total, ready, withoutPhoto, expiringSoon, skipped, lines };
}

/** Se genera sólo lo vigente: una promoción vencida, desactivada o que no aplica NO sale como si estuviera vigente. */
export function isGeneratable(item: Pick<FolderItemFacts, "state">): boolean {
  return item.state === "READY";
}

// ---------------------------------------------------------------------------------------------------------------------
// Nombres de archivo y de carpeta dentro del ZIP
// ---------------------------------------------------------------------------------------------------------------------

/** «Pata Muslo» → «pata-muslo»: minúsculas, sin acentos ni símbolos, con guiones; nunca vacío. */
export function slugify(text: string, max = 60): string {
  const slug = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return slug || "pieza";
}

/** Nombre de carpeta legible para el ZIP: conserva mayúsculas y espacios, saca lo que Windows/ZIP no admiten. */
export function sanitizeFolderName(name: string, max = 60): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "").slice(0, max).trim();
  return cleaned || "Carpeta";
}

/** 11/10/2026 → «11-10-2026» (día-mes-año, con la fecha de quien genera). */
export function dateStamp(date: Date): string {
  return `${String(date.getDate()).padStart(2, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getFullYear())}`;
}

export type ZipFormat = "feed" | "story";
export const ZIP_FORMAT_FOLDERS: Record<ZipFormat, string> = { feed: "Feed", story: "Story" };

/** Nombres únicos por formato: dos productos que se llaman igual no se pisan («pata-muslo.png», «pata-muslo-2.png»). */
export function assignFilenames(items: readonly { itemId: string; name: string }[]): Map<string, string> {
  const used = new Map<string, number>();
  const result = new Map<string, string>();
  for (const item of items) {
    const base = slugify(item.name);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    result.set(item.itemId, count === 1 ? `${base}.png` : `${base}-${String(count)}.png`);
  }
  return result;
}

/** Ruta dentro del ZIP: «Ofertas finde - 11-10-2026/Feed/pata-muslo.png». */
export function zipEntryPath(folderName: string, date: Date, format: ZipFormat, filename: string): string {
  return `${sanitizeFolderName(folderName)} - ${dateStamp(date)}/${ZIP_FORMAT_FOLDERS[format]}/${filename}`;
}

/** Nombre del archivo ZIP descargado. */
export function zipFilename(folderName: string, date: Date): string {
  return `${sanitizeFolderName(folderName)} - ${dateStamp(date)}.zip`;
}
