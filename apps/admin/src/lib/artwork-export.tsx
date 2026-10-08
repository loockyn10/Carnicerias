import { ImageResponse } from "next/og";

import { OfferArtwork } from "../components/artwork/offer-artwork";
import {
  artworkFilename, buildCollageArtworkModel, buildOfferArtworkModel, heroPrice, normalizeHeadline, parseArtworkFacts, priceToCents,
  ARTWORK_UNAVAILABLE_LABELS, COLLAGE_COUNT_MESSAGE, type ArtworkFacts, type ArtworkPhotoRef, type OfferArtworkModel
} from "./artwork";
import { buildArtworkBranding, parseArtworkBrandingFacts, type ArtworkBranding, type ArtworkContact } from "./artwork-branding";
import { MAX_PHOTO_BYTES } from "./artwork-photo";
import { ARTWORK_FONT_700_BASE64, ARTWORK_FONT_900_BASE64, ARTWORK_FONT_FAMILY } from "./artwork-font-data";
import {
  ARTWORK_FORMATS, COLLAGE_MAX_ITEMS, COLLAGE_MIN_ITEMS, defaultHeadline, isArtworkTemplate, isExportableFormat,
  type ArtworkFormat, type ArtworkTemplate, type ExportableArtworkFormat
} from "./artwork-tokens";
import { readImageInfo } from "./image-size";
import { isUuid } from "./uuid";

/**
 * Exportación PNG de la pieza (D-074 / D-075), lado servidor:
 *   1. valida el pedido: SÓLO `template`, `productId(s)`, `branchId`, `headline` y `format`. Precios, nombres, promociones, imágenes,
 *      logo y contacto NO viajan desde el navegador (cualquier otro campo se ignora);
 *   2. vuelve a leer en la base cada producto, su foto, el precio vigente de la sucursal y la promoción (`get_product_artwork`) y la
 *      identidad (`get_artwork_branding`: logo de la organización + teléfono/dirección/ciudad de ESA sucursal); la organización y el
 *      permiso los valida cada RPC. Arma el MISMO `OfferArtworkModel` que usa el preview;
 *   3. dibuja con el mismo renderer (`OfferArtwork`) en Satori (`next/og`) a 1080 × 1350 (Feed) o 1080 × 1920 (Story).
 * Devuelve además un `snapshot` de lo que se dibujó (productos, formato, precios): hoy no se guarda en ningún lado, pero es lo que
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
  template: ArtworkTemplate;
  /** HERO: exactamente 1. COLLAGE: de 2 a 5, en el orden de la pieza. */
  productIds: string[];
  /** null = precio general (sin sucursal: sin contacto en la pieza). */
  branchId: string | null;
  headline: string;
  format: ExportableArtworkFormat;
}

type ParsedRequest = { ok: true; value: ArtworkExportRequest } | { ok: false; error: string };

/** Valida el cuerpo del pedido. Cualquier otro campo (precio, nombre, imagen, logo, contacto…) se IGNORA: el servidor no confía en el navegador. */
export function parseArtworkExportRequest(body: unknown): ParsedRequest {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Pedido inválido" };
  const record = body as Record<string, unknown>;
  const template = record.template ?? "HERO";
  if (!isArtworkTemplate(template)) return { ok: false, error: "Plantilla inválida" };

  let rawIds: unknown[];
  if (template === "HERO") {
    rawIds = Array.isArray(record.productIds) ? record.productIds : [record.productId];
    if (rawIds.length !== 1) return { ok: false, error: "El producto protagonista lleva un solo producto" };
  } else {
    if (!Array.isArray(record.productIds)) return { ok: false, error: COLLAGE_COUNT_MESSAGE };
    rawIds = record.productIds;
    if (rawIds.length < COLLAGE_MIN_ITEMS || rawIds.length > COLLAGE_MAX_ITEMS) return { ok: false, error: COLLAGE_COUNT_MESSAGE };
  }
  const productIds: string[] = [];
  for (const id of rawIds) {
    if (!isUuid(id)) return { ok: false, error: "Producto inválido" };
    productIds.push(id.toLowerCase());
  }
  if (new Set(productIds).size !== productIds.length) return { ok: false, error: "Un producto no puede repetirse en el collage" };

  const branchId = record.branchId ?? null;
  if (branchId !== null && !isUuid(branchId)) return { ok: false, error: "Sucursal inválida" };
  if (!isExportableFormat(record.format)) return { ok: false, error: "Formato inválido: se puede descargar Feed o Story" };
  if (record.headline !== undefined && record.headline !== null && typeof record.headline !== "string") return { ok: false, error: "Titular inválido" };
  return {
    ok: true,
    value: {
      template, productIds, branchId: branchId === null ? null : branchId.toLowerCase(),
      headline: normalizeHeadline(record.headline, defaultHeadline(template)), format: record.format
    }
  };
}

export interface PhotoBytes {
  bytes: Uint8Array;
}

export interface ArtworkExportDeps {
  /** Respuesta cruda de `get_product_artwork(producto, sucursal)`. */
  getFacts: (productId: string, branchId: string | null) => Promise<unknown>;
  /** Respuesta cruda de `get_artwork_branding(sucursal)`: logo de la organización + contacto de la sucursal. */
  getBranding: (branchId: string | null) => Promise<unknown>;
  /** Descarga el objeto de Storage con la sesión del usuario (foto o logo). null = el objeto no existe / no se pudo leer. */
  readPhoto: (storagePath: string) => Promise<PhotoBytes | null>;
}

export interface ArtworkSnapshotItem {
  productId: string;
  productName: string;
  /** Precio grande del ítem (promocional si hay promoción; si no, el vigente) en centavos. */
  heroPriceCents: string;
  regularPriceCents: string;
  promotionalPriceCents: string | null;
  promotionCondition: string | null;
  hasPhoto: boolean;
}

/** Lo que se dibujó, listo para un historial futuro (fecha, plantilla, productos, formato, precios, logo y contacto usados). */
export interface ArtworkSnapshot {
  generatedAt: string;
  template: ArtworkTemplate;
  branchId: string | null;
  format: ExportableArtworkFormat;
  headline: string;
  items: ArtworkSnapshotItem[];
  hasLogo: boolean;
  contact: ArtworkContact | null;
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

function toDataUrl(contentType: "image/jpeg" | "image/png", bytes: Uint8Array, invalid: string): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) throw new ArtworkExportError(422, invalid);
  const isPng = startsWith(bytes, PNG_MAGIC);
  const isJpeg = startsWith(bytes, JPEG_MAGIC);
  if ((contentType === "image/png" && !isPng) || (contentType === "image/jpeg" && !isJpeg) || (!isPng && !isJpeg)) throw new ArtworkExportError(422, invalid);
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** data-URL de la foto, sólo si los bytes REALES coinciden con el tipo registrado (PNG/JPEG): lo que dice el navegador no cuenta. */
export function photoToDataUrl(photo: ArtworkPhotoRef, bytes: Uint8Array): string {
  return toDataUrl(photo.contentType, bytes, "La foto del producto no es válida (máximo 5 MB; JPG o PNG): subila de nuevo.");
}

/** Identidad de la pieza: logo (leído de Storage, validado y embebido) + contacto de la sucursal elegida. Todo sale del servidor. */
export async function resolveBranding(deps: ArtworkExportDeps, branchId: string | null): Promise<ArtworkBranding> {
  const facts = parseArtworkBrandingFacts(await deps.getBranding(branchId));
  if (!facts) throw new ArtworkExportError(500, "No se pudo leer la identidad de la cartelería");
  let logoUrl: string | null = null;
  let measured: { width: number; height: number } | null = null;
  if (facts.logo) {
    const file = await deps.readPhoto(facts.logo.storagePath);
    if (!file) throw new ArtworkExportError(502, "No se pudo leer el logo. Probá de nuevo.");
    logoUrl = toDataUrl(facts.logo.contentType, file.bytes, "El logo no es un PNG o JPG válido (máximo 5 MB): subilo de nuevo.");
    measured = readImageInfo(file.bytes);
  }
  // Las medidas de los bytes reales mandan sobre lo registrado (sólo acomodan el logo dentro de la franja).
  const withMeasures = facts.logo && measured ? { ...facts, logo: { ...facts.logo, width: measured.width, height: measured.height } } : facts;
  return buildArtworkBranding(withMeasures, logoUrl);
}

async function resolveEntry(deps: ArtworkExportDeps, productId: string, branchId: string | null): Promise<{ facts: ArtworkFacts; imageUrl: string | null }> {
  const facts = parseArtworkFacts(await deps.getFacts(productId, branchId));
  if (!facts) throw new ArtworkExportError(404, "El producto no existe");
  let imageUrl: string | null = null;
  if (facts.available && facts.photo) {
    const photo = await deps.readPhoto(facts.photo.storagePath);
    if (!photo) throw new ArtworkExportError(502, "No se pudo leer la foto del producto. Probá de nuevo.");
    imageUrl = photoToDataUrl(facts.photo, photo.bytes);
  }
  return { facts, imageUrl };
}

/** Hechos + fotos + identidad → el modelo de la pieza (el mismo que dibuja el preview). Los productos se resuelven EN ORDEN. */
export async function resolveArtwork(deps: ArtworkExportDeps, request: Pick<ArtworkExportRequest, "template" | "productIds" | "branchId" | "headline">): Promise<{ model: OfferArtworkModel }> {
  const [branding, entries] = await Promise.all([
    resolveBranding(deps, request.branchId),
    Promise.all(request.productIds.map((productId) => resolveEntry(deps, productId, request.branchId)))
  ]);

  if (request.template === "COLLAGE") {
    const built = buildCollageArtworkModel(entries, { headline: request.headline, branding });
    if (!built.ok) throw new ArtworkExportError(422, built.message);
    return { model: built.model };
  }
  const entry = entries[0];
  if (!entry) throw new ArtworkExportError(400, "Falta el producto");
  if (!entry.facts.available || !entry.facts.item) throw new ArtworkExportError(422, ARTWORK_UNAVAILABLE_LABELS[entry.facts.unavailableReason ?? "NO_PRICE"]);
  const model = buildOfferArtworkModel(entry.facts, { headline: request.headline, imageUrl: entry.imageUrl, branding });
  if (!model) throw new ArtworkExportError(422, ARTWORK_UNAVAILABLE_LABELS.NO_PRICE);
  return { model };
}

function fontBytes(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/** Dibuja el modelo en PNG a las dimensiones exactas del formato. Determinista: misma entrada, mismos píxeles. */
export async function renderArtworkPng(model: OfferArtworkModel, format: ArtworkFormat): Promise<Uint8Array> {
  if (model.type === "COLLAGE" && format === "tv") throw new Error("El collage no tiene formato TV");
  const spec = ARTWORK_FORMATS[format];
  const response = new ImageResponse(<OfferArtwork format={format} model={model} />, {
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
  return {
    png,
    filename: artworkFilename(model, request.format),
    width: spec.width,
    height: spec.height,
    snapshot: {
      generatedAt: now().toISOString(),
      template: model.type,
      branchId: request.branchId,
      format: request.format,
      headline: model.headline,
      items: model.items.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        heroPriceCents: priceToCents(heroPrice(item)).toString(),
        regularPriceCents: priceToCents(item.regularPrice).toString(),
        promotionalPriceCents: item.promotionalPrice ? priceToCents(item.promotionalPrice).toString() : null,
        promotionCondition: item.promotionCondition,
        hasPhoto: item.imageUrl !== null
      })),
      hasLogo: model.branding.logo !== null,
      contact: model.branding.contact
    }
  };
}
