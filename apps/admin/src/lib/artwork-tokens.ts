/**
 * Identidad visual de la cartelería (D-074). ÚNICO lugar de colores, marca y medidas de las piezas: el preview, los tres renderers
 * (TV, Feed, Story) y el PNG exportado leen de acá; ningún color ni tamaño suelto vive en los componentes.
 *
 * Referencia de estilo (piezas actuales del negocio): fondo blanco, verde fuerte de marca, rojo para el titular, producto recortado y
 * protagonista, precio negro muy grande sobre pastilla amarilla. Sin sombras, sin efectos 3D, una sola familia tipográfica.
 */

export const ARTWORK_COLORS = {
  BRAND_GREEN: "#0B8A2F",
  PRICE_YELLOW: "#FFD400",
  ACCENT_RED: "#D8201B",
  BLACK: "#111111",
  WHITE: "#FFFFFF",
  /** Texto secundario (precio normal, dirección). */
  INK_MUTED: "#4A4A45",
  /** Panel suave de la foto (sólo cuando el producto no tiene foto). */
  SURFACE_SOFT: "#EEF4EC"
} as const;

/**
 * Nombre de la marca que se imprime en las piezas. No existe todavía un logo/wordmark en el repositorio: se usa texto con el
 * tratamiento visual de marca (ver `BrandFlag`). Cuando haya un logo se reemplaza acá y en `hero-offer.tsx`.
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

/**
 * Zonas seguras de Story / WhatsApp Estado: las apps tapan la parte alta (perfil, barra de progreso) y la baja (responder, enviar).
 * Todo lo importante de la pieza vive entre `top` y `height - bottom`.
 */
export const STORY_SAFE = { top: 250, bottom: 340, side: 64 } as const;

/** Titulares sugeridos (el usuario puede escribir otro corto). */
export const HEADLINE_PRESETS = ["OFERTA", "X MAYOR", "IMPERDIBLE", "ESPECIAL"] as const;
export const DEFAULT_HEADLINE = "OFERTA";
export const MAX_HEADLINE_LENGTH = 16;
