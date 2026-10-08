import { ImageResponse } from "next/og";

import { HeroOffer } from "../components/artwork/hero-offer";
import {
  artworkFilename, buildOfferArtworkModel, heroPrice, normalizeHeadline, parseArtworkFacts, priceToCents,
  ARTWORK_UNAVAILABLE_LABELS, type ArtworkFacts, type ArtworkPhotoRef, type OfferArtworkModel
} from "./artwork";
import { MAX_PHOTO_BYTES } from "./artwork-photo";
import { ARTWORK_FONT_700_BASE64, ARTWORK_FONT_900_BASE64, ARTWORK_FONT_FAMILY } from "./artwork-font-data";
import { ARTWORK_FORMATS, isExportableFormat, type ArtworkFormat, type ExportableArtworkFormat } from "./artwork-tokens";
import { isUuid } from "./uuid";

/**
 * Exportación PNG de la pieza (D-074), lado servidor:
 *   1. valida el pedido: SÓLO `productId`, `branchId`, `headline` y `format`. Precios, nombres, promociones e imagen NO viajan desde
 *      el navegador (cualquier otro campo se ignora);
 *   2. vuelve a leer en la base el producto, su foto, el precio vigente de la sucursal y la promoción (`get_product_artwork`; la
 *      organización y el permiso los valida la RPC) y arma el MISMO `OfferArtworkModel` que usa el preview;
 *   3. dibuja con los mismos renderers (`HeroOffer`) en Satori (`next/og`) a 1080 × 1350 (Feed) o 1080 × 1920 (Story).
 * Devuelve además un `snapshot` de lo que se dibujó (producto, formato, precios): hoy no se guarda en ningún lado, pero es lo que
 * un historial de publicaciones futuro tendría que persistir.
 * Las lecturas se inyectan (`ArtworkExportDeps`): la ruta HTTP las conecta a Supabase y las pruebas a un doble.
 */

export class ArtworkExportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ArtworkExportError";
    this.status = status;
  }
}

export interface ArtworkExportRequest {
  productId: string;
  /** null = precio general (sin sucursal). */
  branchId: string | null;
  headline: string;
  format: ExportableArtworkFormat;
}

/** Valida el cuerpo del pedido. Cualquier otro campo (precio, nombre, imagen…) se IGNORA: el servidor no confía en el navegador. */
export function parseArtworkExportRequest(body: unknown): { ok: true; value: ArtworkExportRequest } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Pedido inválido" };
  const record = body as Record<string, unknown>;
  if (!isUuid(record.productId)) return { ok: false, error: "Producto inválido" };
  const branchId = record.branchId ?? null;
  if (branchId !== null && !isUuid(branchId)) return { ok: false, error: "Sucursal inválida" };
  if (!isExportableFormat(record.format)) return { ok: false, error: "Formato inválido: se puede descargar Feed o Story" };
  if (record.headline !== undefined && record.headline !== null && typeof record.headline !== "string") return { ok: false, error: "Titular inválido" };
  return {
    ok: true,
    value: { productId: record.productId.toLowerCase(), branchId: branchId === null ? null : branchId.toLowerCase(), headline: normalizeHeadline(record.headline), format: record.format }
  };
}

export interface PhotoBytes {
  bytes: Uint8Array;
}

export interface ArtworkExportDeps {
  /** Respuesta cruda de `get_product_artwork(producto, sucursal)`. */
  getFacts: (productId: string, branchId: string | null) => Promise<unknown>;
  /** Descarga el objeto de Storage con la sesión del usuario. null = el objeto no existe / no se pudo leer. */
  readPhoto: (storagePath: string) => Promise<PhotoBytes | null>;
}

/** Lo que se dibujó, listo para un historial futuro (fecha, producto, formato y precios usados). */
export interface ArtworkSnapshot {
  generatedAt: string;
  productId: string;
  branchId: string | null;
  format: ExportableArtworkFormat;
  headline: string;
  productName: string;
  /** Precio grande de la pieza (promocional si hay promoción; si no, el vigente) en centavos. */
  heroPriceCents: string;
  regularPriceCents: string;
  promotionalPriceCents: string | null;
  promotionCondition: string | null;
  hasPhoto: boolean;
}

export interface ArtworkExportResult {
  png: Uint8Array;
  filename: string;
  width: number;
  height: number;
  snapshot: ArtworkSnapshot;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((value, index) => bytes[index] === value);
}

/** data-URL de la foto, sólo si los bytes REALES coinciden con el tipo registrado (PNG/JPEG): lo que dice el navegador no cuenta. */
export function photoToDataUrl(photo: ArtworkPhotoRef, bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) throw new ArtworkExportError(422, "La foto del producto no es válida (máximo 5 MB).");
  const isPng = startsWith(bytes, PNG_MAGIC);
  const isJpeg = startsWith(bytes, JPEG_MAGIC);
  if ((photo.contentType === "image/png" && !isPng) || (photo.contentType === "image/jpeg" && !isJpeg) || (!isPng && !isJpeg)) {
    throw new ArtworkExportError(422, "La foto del producto no es un JPG o PNG válido: subila de nuevo.");
  }
  return `data:${photo.contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Hechos + foto → el modelo de la pieza (el mismo que dibuja el preview). */
export async function resolveArtwork(deps: ArtworkExportDeps, request: Pick<ArtworkExportRequest, "productId" | "branchId" | "headline">): Promise<{ facts: ArtworkFacts; model: OfferArtworkModel }> {
  const raw = await deps.getFacts(request.productId, request.branchId);
  const facts = parseArtworkFacts(raw);
  if (!facts) throw new ArtworkExportError(404, "El producto no existe");
  if (!facts.available || !facts.model) {
    throw new ArtworkExportError(422, ARTWORK_UNAVAILABLE_LABELS[facts.unavailableReason ?? "NO_PRICE"]);
  }
  let imageUrl: string | null = null;
  if (facts.photo) {
    const photo = await deps.readPhoto(facts.photo.storagePath);
    if (!photo) throw new ArtworkExportError(502, "No se pudo leer la foto del producto. Probá de nuevo.");
    imageUrl = photoToDataUrl(facts.photo, photo.bytes);
  }
  const model = buildOfferArtworkModel(facts, { headline: request.headline, imageUrl });
  if (!model) throw new ArtworkExportError(422, ARTWORK_UNAVAILABLE_LABELS.NO_PRICE);
  return { facts, model };
}

function fontBytes(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/** Dibuja el modelo en PNG a las dimensiones exactas del formato. Determinista: misma entrada, mismos píxeles. */
export async function renderArtworkPng(model: OfferArtworkModel, format: ArtworkFormat): Promise<Uint8Array> {
  const spec = ARTWORK_FORMATS[format];
  const response = new ImageResponse(<HeroOffer format={format} model={model} />, {
    width: spec.width,
    height: spec.height,
    fonts: [
      { name: ARTWORK_FONT_FAMILY, data: fontBytes(ARTWORK_FONT_900_BASE64), weight: 900, style: "normal" },
      { name: ARTWORK_FONT_FAMILY, data: fontBytes(ARTWORK_FONT_700_BASE64), weight: 700, style: "normal" }
    ]
  });
  return new Uint8Array(await response.arrayBuffer());
}

export async function executeArtworkExport(deps: ArtworkExportDeps, request: ArtworkExportRequest, now: () => Date = () => new Date()): Promise<ArtworkExportResult> {
  const { model } = await resolveArtwork(deps, request);
  const spec = ARTWORK_FORMATS[request.format];
  const png = await renderArtworkPng(model, request.format);
  const hero = heroPrice(model);
  return {
    png,
    filename: artworkFilename(model, request.format),
    width: spec.width,
    height: spec.height,
    snapshot: {
      generatedAt: now().toISOString(),
      productId: request.productId,
      branchId: request.branchId,
      format: request.format,
      headline: model.headline,
      productName: model.productName,
      heroPriceCents: priceToCents(hero).toString(),
      regularPriceCents: priceToCents(model.regularPrice).toString(),
      promotionalPriceCents: model.promotionalPrice ? priceToCents(model.promotionalPrice).toString() : null,
      promotionCondition: model.promotionCondition,
      hasPhoto: model.imageUrl !== null
    }
  };
}
