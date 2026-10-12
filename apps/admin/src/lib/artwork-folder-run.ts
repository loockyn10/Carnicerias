import { assignFilenames, zipEntryPath, type ZipFormat } from "./artwork-folders";
import { buildZip, type ZipEntry } from "./zip";

/**
 * «Generar todo actualizado» desde el navegador (D-086): reparte los elementos de una carpeta en lotes chicos, pide cada lote al servidor
 * (`POST /api/artwork/folder`, que dibuja con los datos de HOY) de a pocos a la vez, informa el avance («8 / 20») y junta el resultado.
 * Nada se dibuja en el navegador y la pantalla no se congela: cada lote es un pedido independiente.
 *
 * Aislamiento de errores: un lote que falla (red, 5xx, respuesta rara) marca SUS piezas como error y el resto sigue; las piezas ya
 * generadas no se pierden y `retryItemIds` permite volver a pedir sólo las que fallaron.
 */

export type RunFormat = "feed" | "story";

export interface RunPiece {
  itemId: string;
  productName: string;
  format: RunFormat;
  status: "OK" | "SKIPPED" | "ERROR";
  message: string | null;
  warnings: ("NO_PHOTO" | "EXPIRES_SOON")[];
  summary: string | null;
  png: Uint8Array | null;
}

export interface RunItem { itemId: string; name: string }

/** Avance en piezas ya terminadas (de cualquier resultado, también las que fallaron) sobre las que se piden. */
export interface RunProgress { done: number; total: number }

export interface RunResult {
  pieces: RunPiece[];
  /** Piezas dibujadas. */
  generated: number;
  /** Piezas que no salieron (error) o que no se generaron (promoción vencida, inactiva, sin precio…): hay que revisarlas. */
  needsReview: number;
  /** Piezas generadas con el panel de reemplazo de la foto (conviene cargar la foto). */
  withoutPhoto: number;
  /** Elementos con alguna pieza que falló (para «Reintentar los que fallaron»). */
  retryItemIds: string[];
}

export interface FetchResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  /** Con `application/x-ndjson` la respuesta es un stream de piezas (una línea por pieza). */
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
}

export type FetchJson = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<FetchResponse>;

/** Tamaño de lote y pedidos simultáneos: lotes chicos (hasta 6 elementos × 2 formatos) y de a dos para que 30 piezas no ahoguen al servidor. */
export const DEFAULT_CHUNK_SIZE = 3;
export const DEFAULT_CONCURRENCY = 2;

export function planBatches<T>(items: readonly T[], size: number = DEFAULT_CHUNK_SIZE): T[][] {
  const batches: T[][] = [];
  const chunk = Math.max(1, Math.trunc(size));
  for (let index = 0; index < items.length; index += chunk) batches.push(items.slice(index, index + chunk));
  return batches;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

function readPiece(raw: unknown, allowedItems: ReadonlySet<string>, allowedFormats: ReadonlySet<string>): RunPiece | null {
  if (!isRecord(raw)) return null;
  const itemId = typeof raw.itemId === "string" ? raw.itemId : null;
  const format = raw.format;
  const status = raw.status;
  if (!itemId || !allowedItems.has(itemId) || (format !== "feed" && format !== "story") || !allowedFormats.has(format)) return null;
  if (status !== "OK" && status !== "SKIPPED" && status !== "ERROR") return null;
  let png: Uint8Array | null = null;
  if (status === "OK") {
    if (typeof raw.pngBase64 !== "string" || !raw.pngBase64) return null;
    try { png = base64ToBytes(raw.pngBase64); } catch { return null; }
  }
  const warnings = (Array.isArray(raw.warnings) ? raw.warnings as unknown[] : []).filter((warning): warning is "NO_PHOTO" | "EXPIRES_SOON" => warning === "NO_PHOTO" || warning === "EXPIRES_SOON");
  return {
    itemId, format, status, png, warnings,
    productName: typeof raw.productName === "string" ? raw.productName : "Pieza",
    message: typeof raw.message === "string" ? raw.message : null,
    summary: typeof raw.summary === "string" ? raw.summary : null
  };
}

/** Lee una respuesta NDJSON (una línea JSON por pieza) a medida que llega; las líneas rotas se ignoran. */
async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (line: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    try { onLine(JSON.parse(text)); } catch { /* una línea rota no cuenta: la pieza queda como «no llegó completa» */ }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      flush(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  flush(buffer + decoder.decode());
}

async function requestBatch(options: {
  fetchJson: FetchJson; folderId: string; branchId: string | null; batch: RunItem[]; formats: RunFormat[]; headline?: string; signal?: AbortSignal;
  /** Cada pieza apenas llega (el servidor las envía de a una): alimenta el avance. */
  onPiece?: (piece: RunPiece) => void;
}): Promise<RunPiece[]> {
  const { batch, formats } = options;
  const allowedItems = new Set(batch.map((item) => item.itemId));
  const allowedFormats = new Set<string>(formats);
  const errorPieces = (message: string, only?: ReadonlySet<string>): RunPiece[] => batch.flatMap((item) => formats
    .filter((format) => !only || only.has(`${item.itemId}:${format}`))
    .map((format): RunPiece => ({ itemId: item.itemId, productName: item.name, format, status: "ERROR", message, warnings: [], summary: null, png: null })));
  let lastMessage = "No se pudo generar la pieza. Probá de nuevo.";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await options.fetchJson("/api/artwork/folder", {
        method: "POST", headers: { "Content-Type": "application/json" }, ...(options.signal ? { signal: options.signal } : {}),
        body: JSON.stringify({ folderId: options.folderId, branchId: options.branchId, itemIds: batch.map((item) => item.itemId), formats, ...(options.headline ? { headline: options.headline } : {}) })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        lastMessage = isRecord(body) && typeof body.error === "string" ? body.error : lastMessage;
        // Un error del pedido (4xx) no se arregla reintentando; uno del servidor o de la red, sí (una vez).
        if (response.status < 500) return errorPieces(lastMessage);
        continue;
      }

      const pieces: RunPiece[] = [];
      const seen = new Set<string>();
      const accept = (raw: unknown) => {
        const piece = readPiece(raw, allowedItems, allowedFormats);
        const key = piece ? `${piece.itemId}:${piece.format}` : "";
        if (!piece || seen.has(key)) return;
        seen.add(key);
        pieces.push(piece);
        options.onPiece?.(piece);
      };
      // Lo que el servidor no devolvió (o devolvió roto) queda marcado como error: nunca se pierde una pieza en silencio.
      const withMissing = (message: string): RunPiece[] => {
        const missing = new Set(batch.flatMap((item) => formats.map((format) => `${item.itemId}:${format}`)).filter((key) => !seen.has(key)));
        const extra = errorPieces(message, missing);
        for (const piece of extra) options.onPiece?.(piece);
        return [...pieces, ...extra];
      };

      const contentType = response.headers?.get("content-type") ?? "";
      if (contentType.includes("ndjson") && response.body) {
        // Respuesta en streaming: las piezas llegan de a una. Si se corta a la mitad no se repite el lote (ya se hizo el trabajo): lo que falta se marca.
        let streamMessage: string | null = null;
        try {
          await readNdjson(response.body, (line) => {
            if (!isRecord(line)) return;
            if (line.type === "piece") accept(line.piece);
            else if (line.type === "error" && typeof line.message === "string") streamMessage = line.message;
          });
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return withMissing("Se canceló la generación.");
          streamMessage = "Se cortó la conexión mientras se generaban las piezas.";
        }
        return withMissing(streamMessage ?? "La pieza no llegó completa. Probá de nuevo.");
      }

      // Respuesta completa en JSON (servidores anteriores y pruebas).
      const body = await response.json().catch(() => null);
      const raw = isRecord(body) && Array.isArray(body.pieces) ? body.pieces as unknown[] : null;
      if (!raw) { lastMessage = "El servidor devolvió una respuesta que no se entiende."; continue; }
      for (const piece of raw) accept(piece);
      return withMissing("La pieza no llegó completa. Probá de nuevo.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return errorPieces("Se canceló la generación.");
      lastMessage = "No se pudo conectar con el servidor. Revisá tu conexión.";
    }
  }
  return errorPieces(lastMessage);
}

/** Orden estable de las piezas: el de la carpeta y, dentro de cada elemento, Feed antes que Story. */
function sortPieces(pieces: RunPiece[], order: readonly string[]): RunPiece[] {
  const position = new Map(order.map((id, index) => [id, index]));
  return [...pieces].sort((a, b) => (position.get(a.itemId) ?? 0) - (position.get(b.itemId) ?? 0) || (a.format === b.format ? 0 : a.format === "feed" ? -1 : 1));
}

export function summarizeRun(pieces: RunPiece[], order: readonly string[]): RunResult {
  const sorted = sortPieces(pieces, order);
  const failed = new Set<string>();
  let generated = 0;
  let needsReview = 0;
  let withoutPhoto = 0;
  for (const piece of sorted) {
    if (piece.status === "OK") {
      generated += 1;
      if (piece.warnings.includes("NO_PHOTO")) withoutPhoto += 1;
    } else {
      needsReview += 1;
      if (piece.status === "ERROR") failed.add(piece.itemId);
    }
  }
  return { pieces: sorted, generated, needsReview, withoutPhoto, retryItemIds: [...failed] };
}

/**
 * Genera `items` (los elementos vigentes de la carpeta) en todos los `formats`. `skipped` son los elementos que NO se generan por no estar
 * vigentes (se informan en el resultado, no se piden al servidor). `onProgress` recibe cuántas piezas ya terminaron (de las que se piden).
 */
export async function runFolderGeneration(options: {
  fetchJson: FetchJson;
  folderId: string;
  branchId: string | null;
  items: RunItem[];
  skipped?: { itemId: string; name: string; message: string }[];
  formats: RunFormat[];
  headline?: string;
  chunkSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: RunProgress) => void;
}): Promise<RunResult> {
  const batches = planBatches(options.items, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  // El avance se cuenta en PIEZAS (elementos × formatos): «Generando… 8 / 20».
  const total = options.items.length * options.formats.length;
  let done = 0;
  options.onProgress?.({ done, total });
  const collected: RunPiece[] = [];
  const queue = [...batches];
  const worker = async () => {
    for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
      let counted = 0;
      const pieces = await requestBatch({
        fetchJson: options.fetchJson, folderId: options.folderId, branchId: options.branchId, batch, formats: options.formats,
        ...(options.headline ? { headline: options.headline } : {}), ...(options.signal ? { signal: options.signal } : {}),
        onPiece: () => { counted += 1; done += 1; options.onProgress?.({ done, total }); }
      });
      collected.push(...pieces);
      // Un lote que falló entero no avisó pieza por pieza: se cuentan igual (no queda un avance trabado).
      const expected = batch.length * options.formats.length;
      if (counted < expected) { done += expected - counted; options.onProgress?.({ done, total }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY), Math.max(batches.length, 1)) }, worker));
  const skipped = (options.skipped ?? []).flatMap((item) => options.formats.map((format): RunPiece => ({
    itemId: item.itemId, productName: item.name, format, status: "SKIPPED", message: item.message, warnings: [], summary: null, png: null
  })));
  const order = [...options.items.map((item) => item.itemId), ...(options.skipped ?? []).map((item) => item.itemId)];
  return summarizeRun([...collected, ...skipped], order);
}

/** Clave de una pieza dentro de un resultado: «<itemId>:<formato>». */
export const pieceKey = (piece: Pick<RunPiece, "itemId" | "format">): string => `${piece.itemId}:${piece.format}`;

/** Nombre de archivo de cada pieza OK, por `pieceKey`: sale del producto (sin acentos ni símbolos) y no se pisa dentro de un mismo formato. */
export function pieceFilenames(pieces: readonly RunPiece[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const format of ["feed", "story"] as const satisfies readonly ZipFormat[]) {
    const ok = pieces.filter((piece) => piece.format === format && piece.status === "OK" && piece.png);
    const assigned = assignFilenames(ok.map((piece) => ({ itemId: piece.itemId, name: piece.productName })));
    for (const piece of ok) names.set(pieceKey(piece), assigned.get(piece.itemId) ?? "pieza.png");
  }
  return names;
}

/** Nombre de una pieza descargada SUELTA (fuera del ZIP no hay subcarpeta de formato): «pata-muslo-feed.png». */
export function looseFilename(filename: string, format: RunFormat): string {
  return filename.replace(/\.png$/, `-${format}.png`);
}

/**
 * Entradas del ZIP «Ofertas finde - 11-10-2026/Feed/pata-muslo.png» con las piezas generadas. Los nombres salen del producto (sin acentos
 * ni símbolos) y no se pisan entre sí.
 */
export function buildRunZipEntries(folderName: string, date: Date, pieces: readonly RunPiece[]): ZipEntry[] {
  const names = pieceFilenames(pieces);
  const entries: ZipEntry[] = [];
  for (const format of ["feed", "story"] as const satisfies readonly ZipFormat[]) {
    for (const piece of pieces) {
      const filename = names.get(pieceKey(piece));
      if (piece.format === format && piece.png && filename) entries.push({ path: zipEntryPath(folderName, date, format, filename), data: piece.png, modified: date });
    }
  }
  return entries;
}

/** El ZIP completo de lo generado; null si no hay ninguna pieza para descargar. */
export function buildRunZip(folderName: string, date: Date, pieces: readonly RunPiece[]): Uint8Array | null {
  const entries = buildRunZipEntries(folderName, date, pieces);
  return entries.length ? buildZip(entries) : null;
}

/**
 * Vuelve a pedir sólo los elementos que fallaron y los mezcla con lo que ya estaba bien: las piezas de los otros elementos se conservan
 * tal cual y las de los reintentados se reemplazan por el resultado nuevo.
 */
export function mergeRetry(previous: readonly RunPiece[], retried: ReadonlySet<string>, fresh: readonly RunPiece[], order: readonly string[]): RunResult {
  return summarizeRun([...previous.filter((piece) => !retried.has(piece.itemId)), ...fresh], order);
}
