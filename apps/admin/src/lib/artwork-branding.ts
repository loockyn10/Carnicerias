import { sanitizeGlyphs } from "./artwork-text";
import { ARTWORK_COLORS, BRAND_NAME } from "./artwork-tokens";

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
  return { storagePath, contentType, width, height };
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
  const logo = facts.logo && logoImageUrl ? { imageUrl: logoImageUrl, width: facts.logo.width, height: facts.logo.height } : null;
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
export function placeLogo(logo: { width: number; height: number }, area: { x: number; y: number; w: number; h: number }): LogoPlacement {
  const rotate = logo.width > logo.height ? -90 : 0;
  // Lo que ocupa en pantalla (después de rotar): ancho/alto intercambiados si se gira.
  const shownW = rotate === 0 ? logo.width : logo.height;
  const shownH = rotate === 0 ? logo.height : logo.width;
  const scale = Math.min(area.w / shownW, area.h / shownH);
  const width = Math.max(1, Math.round(logo.width * scale));
  const height = Math.max(1, Math.round(logo.height * scale));
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  return { left: Math.round(cx - width / 2), top: Math.round(cy - height / 2), width, height, rotate };
}
