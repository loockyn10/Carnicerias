import { COLLAGE_LAYOUTS, COLLAGE_PRICE_SCALE, type CollageCount, type CollageSlot, type PricePlacement } from "./artwork-collage-slots";
import { BAND_WIDTH, CONTENT_GAP, CONTENT_RIGHT_MARGIN, STORY_SAFE, ARTWORK_FORMATS, type ArtworkFormat } from "./artwork-tokens";

/**
 * Geometría pura de las piezas (D-075): dónde va cada bloque en Feed (1080 × 1350) y Story (1080 × 1920). Los renderers sólo dibujan
 * estos rectángulos; acá viven las medidas para poder probar que nada se sale del lienzo, que Story respeta las zonas seguras y que
 * los mosaicos del collage no se pisan.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export type CollageFormat = "feed" | "story";

/** Alto del bloque de contacto (3 renglones) por formato. */
const CONTACT_HEIGHT: Record<CollageFormat, number> = { feed: 118, story: 128 };
const FEED_MARGIN = { top: 44, bottom: 36 } as const;

/** Columna de contenido (a la derecha de la franja verde). */
export function contentColumn(format: ArtworkFormat): { x: number; w: number } {
  const spec = ARTWORK_FORMATS[format];
  const x = BAND_WIDTH[format] + CONTENT_GAP;
  return { x, w: spec.width - x - CONTENT_RIGHT_MARGIN };
}

/** Zona vertical utilizable: Feed usa casi todo el alto; Story respeta las zonas seguras de arriba y abajo. */
export function verticalBounds(format: CollageFormat): { top: number; bottom: number } {
  const { height } = ARTWORK_FORMATS[format];
  return format === "story" ? { top: STORY_SAFE.top, bottom: height - STORY_SAFE.bottom } : { top: FEED_MARGIN.top, bottom: height - FEED_MARGIN.bottom };
}

/** Bloque de contacto: abajo a la izquierda de la columna de contenido, siempre dentro de la zona segura. */
export function contactRect(format: CollageFormat): Rect {
  const column = contentColumn(format);
  const { bottom } = verticalBounds(format);
  const h = CONTACT_HEIGHT[format];
  return { x: column.x, y: bottom - h, w: column.w, h };
}

export interface TileSpec {
  /** Bloque «foto + precio» del slot, en px del lienzo (el nombre va encima). */
  rect: Rect;
  slot: CollageSlot;
  /** Zona del nombre, siempre encima de la foto y dentro del área. */
  name: Rect;
  nameMaxSize: number;
}

export interface CollageLayout {
  headline: Rect;
  /** Zona de los mosaicos (entre el titular y el contacto). */
  area: Rect;
  tiles: TileSpec[];
  contact: Rect;
}

const HEADLINE_HEIGHT: Record<CollageFormat, number> = { feed: 128, story: 140 };
/** Aire entre el titular y el primer producto: la pieza no arranca como una tabla pegada al título. */
const HEADLINE_AIR: Record<CollageFormat, number> = { feed: 34, story: 44 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Tamaño máximo del nombre según el ancho de la foto (un poco menor que antes para dar lugar a fotos más grandes). */
function nameSizeFor(blockWidth: number): number {
  return clamp(Math.round(blockWidth * 0.066), 26, 38);
}

function nameRect(block: Rect, slot: CollageSlot, size: number): Rect {
  const h = Math.round(size * 2.08);
  const w = slot.namePlacement === "top" ? block.w : Math.round(block.w * 0.92);
  const x = slot.namePlacement === "top-end" ? block.x + block.w - w : block.x;
  return { x, y: block.y - h - 4, w, h };
}

/**
 * Composición del collage según la cantidad: lee los slots predefinidos de `COLLAGE_LAYOUTS` (asimétricos, en zig-zag; distintos
 * para Feed y Story) y los convierte a px. Es la ÚNICA fuente de posiciones: la usan el preview y el PNG.
 */
export function collageLayout(count: number, format: CollageFormat): CollageLayout {
  if (!Number.isInteger(count) || count < 2 || count > 5) throw new RangeError(`El collage lleva de 2 a 5 productos (recibió ${String(count)})`);
  const column = contentColumn(format);
  const { top } = verticalBounds(format);
  const contact = contactRect(format);
  const headline: Rect = { x: column.x, y: top, w: column.w, h: HEADLINE_HEIGHT[format] };
  const areaTop = headline.y + headline.h + HEADLINE_AIR[format];
  const area: Rect = { x: column.x, y: areaTop, w: column.w, h: contact.y - 14 - areaTop };
  const slots = COLLAGE_LAYOUTS[format][count as CollageCount];
  const tiles = slots.map((slot): TileSpec => {
    const rect: Rect = { x: area.x + Math.round(slot.x * area.w), y: area.y + Math.round(slot.y * area.h), w: Math.round(slot.w * area.w), h: Math.round(slot.h * area.h) };
    const nameMaxSize = nameSizeFor(rect.w);
    return { rect, slot, name: nameRect(rect, slot, nameMaxSize), nameMaxSize };
  });
  return { headline, area, tiles, contact };
}

export interface TileParts {
  name: Rect;
  nameMaxSize: number;
  nameMaxLines: number;
  photo: Rect;
  /** Zona de la pastilla de precio (la pastilla se ancla según `priceAlign` y se ajusta al contenido dentro de esta zona). */
  price: Rect;
  priceMaxSize: number;
  priceAlign: PricePlacement;
}

/** La pastilla ocupa como mucho este ancho del bloque (deja respirar al producto vecino y no la convierte en protagonista). */
const PRICE_WIDTH_SHARE = 0.9;
/** Cuánto de la pastilla se superpone al borde inferior de la foto. */
const PRICE_OVERLAP = 0.6;

/** Cómo se reparte un mosaico: nombre, foto y precio. Con promoción la pastilla es más alta (lleva la condición debajo del precio). */
export function tileParts(spec: TileSpec, hasCondition: boolean, bounds?: Rect): TileParts {
  const { rect, slot } = spec;
  const priceH = Math.round(slot.badgeH * (hasCondition ? 1.28 : 1));
  const priceW = Math.round(rect.w * PRICE_WIDTH_SHARE);
  const priceX = slot.pricePlacement === "start" ? rect.x : slot.pricePlacement === "end" ? rect.x + rect.w - priceW : rect.x + Math.round((rect.w - priceW) / 2);
  const price: Rect = { x: priceX, y: rect.y + rect.h - priceH, w: priceW, h: priceH };
  // La pastilla se superpone al borde inferior de la foto; la foto llega hasta `PRICE_OVERLAP` de la pastilla.
  const baseH = Math.max(40, price.y + Math.round(priceH * PRICE_OVERLAP) - rect.y);
  // La foto crece hacia los costados y hacia abajo (nunca hacia el nombre) usando el espacio en blanco vecino, sin salirse del área.
  const w = Math.round(rect.w * slot.imageScale);
  const h = Math.round(baseH * slot.imageScale);
  const area = bounds ?? { x: rect.x - 1000, y: rect.y - 1000, w: 3000, h: 3000 };
  const x = clamp(rect.x + Math.round((rect.w - w) / 2), area.x, area.x + area.w - w);
  const y = rect.y;
  return {
    name: spec.name, nameMaxSize: spec.nameMaxSize, nameMaxLines: 2,
    photo: { x, y, w, h },
    price, priceMaxSize: Math.round(priceH * (hasCondition ? 0.6 : 0.74)), priceAlign: slot.pricePlacement
  };
}

export { COLLAGE_PRICE_SCALE };
