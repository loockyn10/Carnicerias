import { extensionFor, type StoredPhotoType } from "./artwork-photo";
import { asRecord, int, str } from "./rpc-json";

/**
 * Imágenes de la «Lista de precios» de Pollos (D-100, migración 202611170104): qué logo usa (uno de los que la aplicación ya guarda para
 * Cartelería o uno propio) y la foto de fondo. Se configuran UNA vez en Pollos → Imágenes de la lista; el botón de descarga sólo las usa.
 * Mismo bucket privado y mismas reglas de subida que las fotos y logos de Cartelería (`artwork-photo`).
 */

export const PRICE_LIST_LOGO_SOURCES = ["ARTWORK", "BUTCHER", "CUSTOM"] as const;
export type PriceListLogoSource = (typeof PRICE_LIST_LOGO_SOURCES)[number];
export type PriceListImageKind = "LOGO" | "BACKGROUND";

export const PRICE_LIST_LOGO_LABELS: Record<PriceListLogoSource, { title: string; detail: string }> = {
  ARTWORK: { title: "Logo de identidad", detail: "El que ya usa Cartelería (piezas y TV)." },
  BUTCHER: { title: "Logo de la carnicería", detail: "El que ya usan los carteles de ofertas impresos." },
  CUSTOM: { title: "Logo propio de la lista", detail: "Subido para esta lista." }
};

export function isPriceListLogoSource(value: unknown): value is PriceListLogoSource {
  return typeof value === "string" && (PRICE_LIST_LOGO_SOURCES as readonly string[]).includes(value);
}

export interface PriceListImageRef { storagePath: string; contentType: string; widthPx: number; heightPx: number }

export interface PriceListSettings {
  /** Hay una configuración guardada (si no, se usa el logo de identidad si existe). */
  configured: boolean;
  logoSource: PriceListLogoSource;
  /** El logo que se dibuja de verdad (el elegido o, si ya no existe, el de identidad); null = ninguno cargado. */
  logoUsed: PriceListLogoSource | null;
  logo: PriceListImageRef | null;
  background: PriceListImageRef | null;
  options: Record<PriceListLogoSource, PriceListImageRef | null>;
}

function imageRef(value: unknown): PriceListImageRef | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value);
  const storagePath = str(record.storagePath);
  if (!storagePath) return null;
  return { storagePath, contentType: str(record.contentType), widthPx: int(record.widthPx), heightPx: int(record.heightPx) };
}

export function parsePriceListSettings(value: unknown): PriceListSettings {
  const record = asRecord(value);
  const options = asRecord(record.options);
  return {
    configured: record.configured === true,
    logoSource: isPriceListLogoSource(record.logoSource) ? record.logoSource : "ARTWORK",
    logoUsed: isPriceListLogoSource(record.logoUsed) ? record.logoUsed : null,
    logo: imageRef(record.logo),
    background: imageRef(record.background),
    options: { ARTWORK: imageRef(options.ARTWORK), BUTCHER: imageRef(options.BUTCHER), CUSTOM: imageRef(options.CUSTOM) }
  };
}

const UUID_PART = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH_PATTERN = new RegExp(`^(${UUID_PART})/poultry-price-list/${UUID_PART}\\.(jpg|png)$`);

/** `<organización>/poultry-price-list/<uuid>.<ext>` en el bucket `product-artwork` (la organización es la primera carpeta: la política de Storage aísla por ella). */
export function buildPriceListImagePath(organizationId: string, fileId: string, type: StoredPhotoType): string {
  return `${organizationId}/poultry-price-list/${fileId}.${extensionFor(type)}`.toLowerCase();
}

/** ¿La ruta es una imagen de la lista de ESTA organización? */
export function isValidPriceListImagePath(path: unknown, organizationId: string): path is string {
  if (typeof path !== "string") return false;
  const match = PATH_PATTERN.exec(path);
  return match !== null && match[1] === organizationId.toLowerCase();
}
