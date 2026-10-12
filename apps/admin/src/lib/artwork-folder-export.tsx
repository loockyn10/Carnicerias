import { slideToItemBase, normalizeHeadline, type OfferArtworkModel } from "./artwork";
import { parseFolderFacts, isGeneratable, FOLDER_STATE_LABELS, type FolderItemFacts, type FolderFacts } from "./artwork-folders";
import { photoToDataUrl, renderArtworkPng, resolveBranding, ArtworkExportError, type ArtworkExportDeps } from "./artwork-export";
import { DEFAULT_HEADLINE, isExportableFormat, type ExportableArtworkFormat } from "./artwork-tokens";
import { isUuid } from "./uuid";

/**
 * Generación de las gráficas de una CARPETA (D-086), lado servidor: «Generar todo actualizado».
 *
 * El navegador sólo manda `{ folderId, branchId, itemIds, formats, headline }`: el precio, la promoción, la foto, el logo y el contacto se
 * resuelven acá, con la sesión del usuario, EN ESTE MOMENTO (`get_signage_folder_facts` trae todos los elementos del lote en UNA consulta;
 * la identidad y cada foto se leen una sola vez por lote). Si Fran cambió una promoción ayer, la pieza de hoy sale con el valor nuevo.
 *
 * Aislamiento de errores: cada pieza se dibuja por separado y un fallo se informa en ELLA (las otras 19 se conservan). Lo que no está
 * vigente (promoción vencida, inactiva, producto sin precio…) NO se genera como si lo estuviera: vuelve como `SKIPPED` con el motivo.
 * Un lote es chico (hasta `MAX_ITEMS_PER_REQUEST` elementos) para no bloquear el servidor: el Admin lo reparte en varios pedidos.
 */

export const MAX_ITEMS_PER_REQUEST = 6;

export interface FolderGenerationRequest {
  folderId: string;
  branchId: string | null;
  itemIds: string[];
  formats: ExportableArtworkFormat[];
  headline: string;
}

type ParsedRequest = { ok: true; value: FolderGenerationRequest } | { ok: false; error: string };

/** Valida el cuerpo del pedido; cualquier otro campo (precio, nombre, imagen…) se IGNORA. */
export function parseFolderGenerationRequest(body: unknown): ParsedRequest {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Pedido inválido" };
  const record = body as Record<string, unknown>;
  if (!isUuid(record.folderId)) return { ok: false, error: "Carpeta inválida" };
  const branchId = record.branchId ?? null;
  if (branchId !== null && !isUuid(branchId)) return { ok: false, error: "Sucursal inválida" };
  if (!Array.isArray(record.itemIds) || record.itemIds.length < 1 || record.itemIds.length > MAX_ITEMS_PER_REQUEST) {
    return { ok: false, error: `Cada pedido lleva de 1 a ${String(MAX_ITEMS_PER_REQUEST)} elementos` };
  }
  const itemIds: string[] = [];
  for (const id of record.itemIds as unknown[]) {
    if (!isUuid(id)) return { ok: false, error: "Elemento inválido" };
    itemIds.push(id.toLowerCase());
  }
  if (new Set(itemIds).size !== itemIds.length) return { ok: false, error: "Elemento repetido" };
  if (!Array.isArray(record.formats) || record.formats.length < 1 || record.formats.length > 2 || !(record.formats as unknown[]).every(isExportableFormat)) {
    return { ok: false, error: "Formato inválido: Feed o Story" };
  }
  const formats = [...new Set(record.formats as ExportableArtworkFormat[])];
  if (record.headline !== undefined && record.headline !== null && typeof record.headline !== "string") return { ok: false, error: "Titular inválido" };
  return {
    ok: true,
    value: {
      folderId: record.folderId.toLowerCase(), branchId: branchId === null ? null : branchId.toLowerCase(), itemIds, formats,
      headline: normalizeHeadline(record.headline, DEFAULT_HEADLINE)
    }
  };
}

export interface FolderGenerationDeps {
  /** Respuesta cruda de `get_signage_folder_facts(carpeta, sucursal, elementos)`. */
  getFolderFacts: (folderId: string, branchId: string | null, itemIds: string[]) => Promise<unknown>;
  getBranding: ArtworkExportDeps["getBranding"];
  readPhoto: ArtworkExportDeps["readPhoto"];
}

export type PieceStatus = "OK" | "SKIPPED" | "ERROR";

export type PieceWarning = "NO_PHOTO" | "EXPIRES_SOON";

export interface GeneratedPiece {
  itemId: string;
  productName: string;
  format: ExportableArtworkFormat;
  status: PieceStatus;
  /** Motivo (en lenguaje simple) cuando no es OK. */
  message: string | null;
  warnings: PieceWarning[];
  /** Resumen de lo que dice la pieza («$ 4.900 · desde 2 kg»): lo que se dibujó. */
  summary: string | null;
  png: Uint8Array | null;
}

function modelFor(facts: FolderFacts, item: FolderItemFacts, headline: string, branding: OfferArtworkModel["branding"], imageUrl: string | null): OfferArtworkModel {
  if (!item.offer) throw new ArtworkExportError(422, "La oferta no se puede armar");
  return {
    type: "HERO", headline, branch: facts.branchName ? { name: facts.branchName } : null, branding,
    items: [{ ...slideToItemBase(item.productId, item.offer), imageTransparent: item.photo?.hasAlpha === true, imageUrl }]
  };
}

/** Lee una foto (con tope de pedidos en paralelo) y la deja como data-URL validada por sus bytes. */
async function readPhotos(deps: FolderGenerationDeps, items: readonly FolderItemFacts[]): Promise<Map<string, { url: string } | { error: string }>> {
  const paths = [...new Set(items.filter((item) => isGeneratable(item) && item.photo).map((item) => item.photo?.storagePath ?? ""))].filter(Boolean);
  const result = new Map<string, { url: string } | { error: string }>();
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const photo = items.find((item) => item.photo?.storagePath === path)?.photo;
      if (!photo) continue;
      try {
        const file = await deps.readPhoto(path);
        result.set(path, file ? { url: photoToDataUrl({ storagePath: photo.storagePath, contentType: photo.contentType }, file.bytes) } : { error: "No se pudo leer la foto del producto. Probá de nuevo." });
      } catch (error) {
        result.set(path, { error: error instanceof ArtworkExportError ? error.message : "No se pudo leer la foto del producto. Probá de nuevo." });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker));
  return result;
}

/** Todo lo que un lote necesita ya resuelto: la carpeta de hoy, la identidad y las fotos. Se arma UNA vez por lote. */
export interface PreparedFolderGeneration {
  facts: FolderFacts;
  items: FolderItemFacts[];
  branding: OfferArtworkModel["branding"];
  photos: Map<string, { url: string } | { error: string }>;
}

/**
 * Resuelve el lote: lee la carpeta (UNA consulta con todos los elementos pedidos), la identidad y cada foto una sola vez. Lanza
 * `ArtworkExportError` sólo si el lote entero no se puede resolver (carpeta inexistente, identidad ilegible); así la ruta puede contestar con
 * el estado correcto ANTES de empezar a enviar piezas.
 */
export async function prepareFolderGeneration(deps: FolderGenerationDeps, request: FolderGenerationRequest, now: () => Date = () => new Date()): Promise<PreparedFolderGeneration> {
  const raw = await deps.getFolderFacts(request.folderId, request.branchId, request.itemIds);
  const facts = parseFolderFacts(raw, now());
  if (!facts) throw new ArtworkExportError(404, "La carpeta no existe");
  const requested = new Set(request.itemIds);
  const items = facts.items.filter((item) => requested.has(item.itemId));
  if (!items.length) throw new ArtworkExportError(404, "Esos elementos ya no están en la carpeta");
  const [branding, photos] = await Promise.all([resolveBranding(deps, request.branchId), readPhotos(deps, items)]);
  return { facts, items, branding, photos };
}

/**
 * Dibuja las piezas del lote de a UNA y entrega cada una apenas está lista (`onPiece`): la ruta las envía en streaming (sin juntar todos los PNG en
 * memoria ni chocar con el tope de tamaño de una respuesta) y el Admin muestra el avance pieza por pieza. Una pieza que falla se informa en ELLA.
 */
export async function renderFolderPieces(prepared: PreparedFolderGeneration, request: FolderGenerationRequest, onPiece: (piece: GeneratedPiece) => void | Promise<void>): Promise<void> {
  const { facts, items, branding, photos } = prepared;
  for (const item of items) {
    for (const format of request.formats) {
      const base = { itemId: item.itemId, productName: item.name, format, summary: item.summary };
      if (!isGeneratable(item)) {
        await onPiece({ ...base, status: "SKIPPED", message: FOLDER_STATE_LABELS[item.state], warnings: [], png: null });
        continue;
      }
      const warnings: PieceWarning[] = [];
      if (!item.hasPhoto) warnings.push("NO_PHOTO");
      if (item.expiresSoon) warnings.push("EXPIRES_SOON");
      let piece: GeneratedPiece;
      try {
        let imageUrl: string | null = null;
        if (item.photo) {
          const photo = photos.get(item.photo.storagePath);
          if (!photo || "error" in photo) throw new ArtworkExportError(502, photo && "error" in photo ? photo.error : "No se pudo leer la foto del producto. Probá de nuevo.");
          imageUrl = photo.url;
        }
        const model = modelFor(facts, item, request.headline, branding, imageUrl);
        // La composición rota con la posición del elemento en la carpeta (A, B, C, D…): estable, nunca al azar.
        const png = await renderArtworkPng(model, format, item.position - 1);
        piece = { ...base, status: "OK", message: null, warnings, png };
      } catch (error) {
        piece = { ...base, status: "ERROR", message: error instanceof ArtworkExportError ? error.message : "No se pudo generar la pieza", warnings, png: null };
      }
      await onPiece(piece);
      // Dibujar es CPU puro y encadena sólo microtareas: sin ceder el turno, el servidor no llega a escribir la pieza en el socket hasta el final.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }
  }
}

/** Todo junto (para pruebas y usos que quieren las piezas en una lista). Devuelve una pieza por combinación, en el orden de la carpeta. */
export async function executeFolderGeneration(deps: FolderGenerationDeps, request: FolderGenerationRequest, now: () => Date = () => new Date()): Promise<{ pieces: GeneratedPiece[]; folderName: string }> {
  const prepared = await prepareFolderGeneration(deps, request, now);
  const pieces: GeneratedPiece[] = [];
  await renderFolderPieces(prepared, request, (piece) => { pieces.push(piece); });
  return { pieces, folderName: prepared.facts.name };
}

/** Línea de la respuesta en streaming (NDJSON): una por pieza y una última de cierre. El PNG viaja en base64. */
export type FolderStreamLine =
  | { type: "piece"; piece: Omit<GeneratedPiece, "png"> & { pngBase64: string | null } }
  | { type: "done"; folderName: string }
  | { type: "error"; message: string };

export function pieceToLine(piece: GeneratedPiece): FolderStreamLine {
  const { png, ...rest } = piece;
  return { type: "piece", piece: { ...rest, pngBase64: png ? Buffer.from(png).toString("base64") : null } };
}
