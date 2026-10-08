/**
 * Identidad visual de la cartelería (D-074, D-075). ÚNICO lugar de colores, marca y medidas de las piezas: el preview, los renderers
 * (TV, Feed, Story; protagonista y collage) y el PNG exportado leen de acá; ningún color ni tamaño suelto vive en los componentes.
 *
 * Referencia de estilo (piezas actuales del negocio): fondo blanco, franja verde lateral con el LOGO REAL, rojo para el titular,
 * productos recortados y protagonistas, precio negro muy grande sobre pastilla amarilla y bloque de contacto abajo a la izquierda.
 * Sin sombras, sin efectos 3D, una sola familia tipográfica.
 */

export const ARTWORK_COLORS = {
  BRAND_GREEN: "#0B8A2F",
  PRICE_YELLOW: "#FFD400",
  ACCENT_RED: "#D8201B",
  BLACK: "#111111",
  WHITE: "#FFFFFF",
  /** Texto secundario (precio normal, dirección). */
  INK_MUTED: "#4A4A45",
  /** Panel suave (foto que no existe, bloque de contacto). */
  SURFACE_SOFT: "#EEF4EC"
} as const;

/** Amarillo de la pastilla del precio: firma visual de las piezas del negocio (protagonista y collage lo comparten). */
export const PRICE_BADGE_YELLOW = ARTWORK_COLORS.PRICE_YELLOW;

/** Forma de la pastilla de precio, compartida por todas las plantillas: radio y relleno relativos al alto de la pastilla. */
export const PRICE_BADGE = { color: PRICE_BADGE_YELLOW, radiusRatio: 0.28, paddingRatio: 0.14 } as const;

/**
 * Nombre que se imprime SÓLO como último recurso, cuando la organización todavía no cargó su logo (se dibuja vertical dentro de la
 * franja). La identidad real es el logo (Productos → Cartelería → Configurar identidad).
 */
export const BRAND_NAME = "SUPER OFERTAS";

export type ArtworkFormat = "tv" | "feed" | "story";

export interface ArtworkFormatSpec {
  readonly id: ArtworkFormat;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** Se puede descargar como PNG (TV sólo tiene preview en este sprint). */
  readonly exportable: boolean;
}

export const ARTWORK_FORMATS: Readonly<Record<ArtworkFormat, ArtworkFormatSpec>> = {
  tv: { id: "tv", label: "TV 16:9", width: 1920, height: 1080, exportable: false },
  feed: { id: "feed", label: "Feed 4:5", width: 1080, height: 1350, exportable: true },
  story: { id: "story", label: "Story 9:16", width: 1080, height: 1920, exportable: true }
};

export const ARTWORK_FORMAT_ORDER: readonly ArtworkFormat[] = ["tv", "feed", "story"];

export type ExportableArtworkFormat = "feed" | "story";

export function isExportableFormat(value: unknown): value is ExportableArtworkFormat {
  return value === "feed" || value === "story";
}

export function isArtworkFormat(value: unknown): value is ArtworkFormat {
  return value === "tv" || value === "feed" || value === "story";
}

/** Plantillas: una pieza con UN producto protagonista o un collage de 2 a 5 productos. */
export type ArtworkTemplate = "HERO" | "COLLAGE";

export const ARTWORK_TEMPLATES: readonly ArtworkTemplate[] = ["HERO", "COLLAGE"];

export const ARTWORK_TEMPLATE_LABELS: Readonly<Record<ArtworkTemplate, string>> = { HERO: "Producto protagonista", COLLAGE: "Collage" };

export function isArtworkTemplate(value: unknown): value is ArtworkTemplate {
  return value === "HERO" || value === "COLLAGE";
}

export const COLLAGE_MIN_ITEMS = 2;
export const COLLAGE_MAX_ITEMS = 5;

/** Formatos disponibles por plantilla: el collage no tiene versión TV en este sprint. */
export function formatsForTemplate(template: ArtworkTemplate): readonly ArtworkFormat[] {
  return template === "COLLAGE" ? ["feed", "story"] : ARTWORK_FORMAT_ORDER;
}

/**
 * Zonas seguras de Story / WhatsApp Estado: las apps tapan la parte alta (perfil, barra de progreso) y la baja (responder, enviar).
 * Todo lo importante de la pieza vive entre `top` y `height - bottom`.
 */
export const STORY_SAFE = { top: 250, bottom: 340, side: 64 } as const;

/** Franja verde lateral (donde va el logo) y márgenes del contenido, por formato. */
export const BAND_WIDTH: Readonly<Record<ArtworkFormat, number>> = { tv: 170, feed: 150, story: 150 };
/** Separación entre la franja y el contenido, y margen derecho. */
export const CONTENT_GAP = 36;
export const CONTENT_RIGHT_MARGIN = 40;

/** Titulares sugeridos (el usuario puede escribir otro corto). */
export const HEADLINE_PRESETS = ["OFERTA", "X MAYOR", "IMPERDIBLE", "ESPECIAL"] as const;
export const COLLAGE_HEADLINE_PRESETS = ["OFERTAS", "X MAYOR", "IMPERDIBLE", "OFERTAS DE POLLO"] as const;
export const DEFAULT_HEADLINE = "OFERTA";
export const DEFAULT_COLLAGE_HEADLINE = "OFERTAS";
export const MAX_HEADLINE_LENGTH = 20;

export function defaultHeadline(template: ArtworkTemplate): string {
  return template === "COLLAGE" ? DEFAULT_COLLAGE_HEADLINE : DEFAULT_HEADLINE;
}
