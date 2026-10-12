import { sanitizeGlyphs } from "./artwork-text";
import { ARTWORK_COLORS, ARTWORK_FORMATS, BAND_WIDTH, BRAND_NAME, STORY_SAFE, type ArtworkFormat } from "./artwork-tokens";

/**
 * Identidad compartida de TODAS las piezas (D-075): logo, colores de marca y contacto de la sucursal. Una sola especificación que leen
 * el protagonista, el collage, Feed, Story y TV: nada de esto se duplica por plantilla.
 *
 * De dónde sale cada dato (nada se escribe en el renderer):
 *   - logo      → `organization_artwork_logos` (Storage, bucket privado `product-artwork`, carpeta `<org>/branding/`);
 *   - teléfono / dirección / ciudad → la SUCURSAL elegida (`branches.phone`, `branches.address`, `branches.city`);
 *   - colores   → `ARTWORK_COLORS` (tokens de marca).
 * Puro: sin acceso a datos ni a React.
 */

/** Referencia al logo tal como la devuelve `get_artwork_branding`. */
export interface ArtworkLogoRef {
  storagePath: string;
  contentType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  /** Tamaño elegido en «Configurar identidad» (70-160; 100 = base). Ausente = 100. */
  scalePercent?: number;
}

/** Hechos que entrega `get_artwork_branding(sucursal)`. */
export interface ArtworkBrandingFacts {
  organizationName: string | null;
  logo: ArtworkLogoRef | null;
  branch: { id: string; name: string; phone: string | null; address: string | null; city: string | null } | null;
}

export interface ArtworkLogo {
  /** URL (firmada) o data-URL de la imagen. */
  imageUrl: string;
  width: number;
  height: number;
  /** 70-160 (100 = tamaño base de la franja). */
  scalePercent: number;
}

export const LOGO_SCALE_MIN = 70;
export const LOGO_SCALE_MAX = 160;
export const LOGO_SCALE_DEFAULT = 100;

/** Porcentaje válido (entero entre 70 y 160); cualquier otra cosa vuelve al tamaño base. */
export function normalizeLogoScale(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(LOGO_SCALE_MAX, Math.max(LOGO_SCALE_MIN, Math.round(value))) : LOGO_SCALE_DEFAULT;
}

/** Contacto ya normalizado para imprimir: al menos un dato presente (si no hay ninguno, la pieza no dibuja el bloque). */
export interface ArtworkContact {
  phone: string | null;
  address: string | null;
  city: string | null;
}

export interface ArtworkBranding {
  /** Nombre de respaldo (se imprime vertical sólo si no hay logo). */
  businessName: string;
  logo: ArtworkLogo | null;
  /** Contacto de la sucursal elegida; null = sin sucursal o sin datos cargados. */
  contact: ArtworkContact | null;
  colors: { green: string; yellow: string; red: string };
}

export const BRAND_COLORS = {
  green: ARTWORK_COLORS.BRAND_GREEN,
  yellow: ARTWORK_COLORS.PRICE_YELLOW,
  red: ARTWORK_COLORS.ACCENT_RED
} as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function parseLogo(raw: unknown): ArtworkLogoRef | null {
  if (!isRecord(raw)) return null;
  const storagePath = asText(raw.storagePath);
  const width = asPositiveInt(raw.width);
  const height = asPositiveInt(raw.height);
  const contentType = raw.contentType;
  if (!storagePath || !width || !height || (contentType !== "image/jpeg" && contentType !== "image/png")) return null;
  return { storagePath, contentType, width, height, scalePercent: normalizeLogoScale(raw.scalePercent) };
}

/** JSON de `get_artwork_branding` → hechos. `null` = respuesta que no se entiende. */
export function parseArtworkBrandingFacts(payload: unknown): ArtworkBrandingFacts | null {
  if (!isRecord(payload)) return null;
  const rawBranch = payload.branch;
  let branch: ArtworkBrandingFacts["branch"] = null;
  if (isRecord(rawBranch)) {
    const id = asText(rawBranch.id);
    const name = asText(rawBranch.name);
    if (id && name) branch = { id, name, phone: asText(rawBranch.phone), address: asText(rawBranch.address), city: asText(rawBranch.city) };
  }
  return { organizationName: asText(payload.organizationName), logo: parseLogo(payload.logo), branch };
}

/** Limpia un dato de contacto para imprimirlo: sólo glifos de la fuente y en mayúsculas (como el resto de la pieza). */
function printable(value: string | null): string | null {
  if (!value) return null;
  const text = sanitizeGlyphs(value).toLocaleUpperCase("es-AR");
  return text || null;
}

/** Contacto de la sucursal (null si no hay sucursal o no tiene ningún dato). Nunca inventa ni completa datos que faltan. */
export function buildArtworkContact(branch: ArtworkBrandingFacts["branch"]): ArtworkContact | null {
  if (!branch) return null;
  const contact: ArtworkContact = { phone: printable(branch.phone), address: printable(branch.address), city: printable(branch.city) };
  return contact.phone || contact.address || contact.city ? contact : null;
}

/** Hechos + URL de la imagen del logo (ya resuelta: firmada para el preview o data-URL para el PNG) → identidad de la pieza. */
export function buildArtworkBranding(facts: ArtworkBrandingFacts, logoImageUrl: string | null): ArtworkBranding {
  const logo = facts.logo && logoImageUrl ? { imageUrl: logoImageUrl, width: facts.logo.width, height: facts.logo.height, scalePercent: normalizeLogoScale(facts.logo.scalePercent) } : null;
  return {
    businessName: printable(facts.organizationName) ?? BRAND_NAME,
    logo,
    contact: buildArtworkContact(facts.branch),
    colors: BRAND_COLORS
  };
}

/** Identidad vacía (sin logo ni contacto): el estado antes de que se carguen los datos. */
export function emptyArtworkBranding(): ArtworkBranding {
  return { businessName: BRAND_NAME, logo: null, contact: null, colors: BRAND_COLORS };
}

// ---------------------------------------------------------------------------------------------------------------------
// Geometría del logo dentro de la franja
// ---------------------------------------------------------------------------------------------------------------------

export interface LogoPlacement {
  /** Caja del elemento ANTES de rotar (posición absoluta en px dentro de la franja). */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Grados (0 o -90): un logo apaisado se acuesta de abajo hacia arriba, como en las piezas actuales. */
  rotate: 0 | -90;
}

/**
 * Cómo se acomoda el logo en `area` (px dentro de la franja). Un logo apaisado (más ancho que alto, p. ej. «SuperOfertas» escrito
 * en horizontal) se gira -90° para que ocupe el alto de la franja; uno vertical se deja como está. Siempre entra entero y centrado.
 */
export function placeLogo(
  logo: { width: number; height: number }, area: { x: number; y: number; w: number; h: number }, scalePercent = LOGO_SCALE_DEFAULT,
  limit?: { w: number; h: number }
): LogoPlacement {
  const rotate = logo.width > logo.height ? -90 : 0;
  // Lo que ocupa en pantalla (después de rotar): ancho/alto intercambiados si se gira.
  const shownW = rotate === 0 ? logo.width : logo.height;
  const shownH = rotate === 0 ? logo.height : logo.width;
  const fit = Math.min(area.w / shownW, area.h / shownH);
  // El porcentaje agranda o achica el tamaño base SIN deformar (misma escala en ancho y alto); `limit` es lo máximo que entra en la franja.
  const wanted = fit * (normalizeLogoScale(scalePercent) / 100);
  const scale = limit ? Math.min(wanted, limit.w / shownW, limit.h / shownH) : wanted;
  const width = Math.max(1, Math.round(logo.width * scale));
  const height = Math.max(1, Math.round(logo.height * scale));
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  return { left: Math.round(cx - width / 2), top: Math.round(cy - height / 2), width, height, rotate };
}

/**
 * Dónde va el logo en cada formato: `area` es la zona base (100 %: dentro de los márgenes de la franja y, en Story, de las zonas seguras)
 * y `limit` lo máximo que puede ocupar un logo agrandado (casi todo el ancho de la franja; nunca se corta ni sale de ella).
 */
export function logoSlot(format: ArtworkFormat): { area: { x: number; y: number; w: number; h: number }; limit: { w: number; h: number } } {
  const { height } = ARTWORK_FORMATS[format];
  const band = BAND_WIDTH[format];
  const pad = Math.round(band * 0.11);
  const top = format === "story" ? STORY_SAFE.top : 40;
  const bottom = format === "story" ? height - STORY_SAFE.bottom : height - 40;
  const area = { x: pad, y: top + 12, w: band - pad * 2, h: bottom - top - 24 };
  return { area, limit: { w: Math.round((band + BAND_EXTRA_MAX) * 0.94), h: area.h } };
}

/**
 * Cuánto puede ensancharse la franja verde (px) cuando un logo agrandado lo necesita: sale del espacio en blanco que ya separa la franja
 * del contenido (`CONTENT_GAP`, 36 px), así que ninguna composición se mueve ni se achica. Con el tamaño base la franja NO cambia.
 */
export const BAND_EXTRA_MAX = 20;

/** Lo más grande (en %) que el logo puede mostrarse en `format` sin salirse de la franja; a partir de ahí el porcentaje ya no crece. */
export function maxLogoScalePercent(logo: { width: number; height: number }, format: ArtworkFormat): number {
  const { area, limit } = logoSlot(format);
  const rotated = logo.width > logo.height;
  const shownW = rotated ? logo.height : logo.width;
  const shownH = rotated ? logo.width : logo.height;
  const fit = Math.min(area.w / shownW, area.h / shownH);
  return Math.floor((Math.min(limit.w / shownW, limit.h / shownH) / fit) * 100);
}

/** Caja del logo ya escalada para `format` (la usan las piezas y la vista previa de «Configurar identidad»). */
export function placeLogoFor(logo: { width: number; height: number }, format: ArtworkFormat, scalePercent: number): LogoPlacement & { band: number } {
  const { area, limit } = logoSlot(format);
  const place = placeLogo(logo, area, scalePercent, limit);
  const shownW = place.rotate === 0 ? place.width : place.height;
  const base = BAND_WIDTH[format];
  // La franja sólo se ensancha lo justo para que el logo agrandado respire (6 % de margen a cada lado) y nunca más que `BAND_EXTRA_MAX`.
  const band = Math.min(base + BAND_EXTRA_MAX, Math.max(base, Math.ceil(shownW / 0.88)));
  const shift = Math.round((band - base) / 2);
  return { ...place, left: place.left + shift, band };
}
