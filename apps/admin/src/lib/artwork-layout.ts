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

export const TILE_GAP = 18;

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

export type TileVariant = "stack" | "side";

export interface TileSpec { rect: Rect; variant: TileVariant }

export interface CollageLayout {
  headline: Rect;
  /** Zona de los mosaicos (entre el titular y el contacto). */
  area: Rect;
  tiles: TileSpec[];
  contact: Rect;
}

const HEADLINE_HEIGHT: Record<CollageFormat, number> = { feed: 128, story: 140 };

/** Un mosaico bajo (muy apaisado) se compone de lado: foto a la izquierda, nombre y precio a la derecha. */
const SIDE_RATIO = 1.95;

function tile(rect: Rect): TileSpec {
  return { rect, variant: rect.w / rect.h >= SIDE_RATIO ? "side" : "stack" };
}

/**
 * Composición del collage según la cantidad (no una grilla rígida):
 *   2 → uno arriba y otro abajo, a todo el ancho;     3 → dos arriba y uno grande abajo;
 *   4 → grilla de 2 × 2;                              5 → dos, dos y uno ancho abajo (el «protagonista»).
 */
export function collageLayout(count: number, format: CollageFormat): CollageLayout {
  if (!Number.isInteger(count) || count < 2 || count > 5) throw new RangeError(`El collage lleva de 2 a 5 productos (recibió ${String(count)})`);
  const column = contentColumn(format);
  const { top } = verticalBounds(format);
  const contact = contactRect(format);
  const headline: Rect = { x: column.x, y: top, w: column.w, h: HEADLINE_HEIGHT[format] };
  const areaTop = headline.y + headline.h + 10;
  const area: Rect = { x: column.x, y: areaTop, w: column.w, h: contact.y - 14 - areaTop };
  const g = TILE_GAP;
  const half = Math.floor((area.w - g) / 2);
  const right = area.x + half + g;
  const tiles: TileSpec[] = [];

  if (count === 2) {
    const h = Math.floor((area.h - g) / 2);
    tiles.push(tile({ x: area.x, y: area.y, w: area.w, h }), tile({ x: area.x, y: area.y + h + g, w: area.w, h: area.h - h - g }));
  } else if (count === 3) {
    const h1 = Math.floor((area.h - g) * 0.4);
    tiles.push(
      tile({ x: area.x, y: area.y, w: half, h: h1 }), tile({ x: right, y: area.y, w: area.w - half - g, h: h1 }),
      tile({ x: area.x, y: area.y + h1 + g, w: area.w, h: area.h - h1 - g })
    );
  } else if (count === 4) {
    const h = Math.floor((area.h - g) / 2);
    const y2 = area.y + h + g;
    const h2 = area.h - h - g;
    tiles.push(
      tile({ x: area.x, y: area.y, w: half, h }), tile({ x: right, y: area.y, w: area.w - half - g, h }),
      tile({ x: area.x, y: y2, w: half, h: h2 }), tile({ x: right, y: y2, w: area.w - half - g, h: h2 })
    );
  } else {
    // Las dos filas de arriba llevan foto + nombre + precio apilados (más alto); la ancha de abajo compone de lado.
    const h = Math.floor((area.h - 2 * g) * 0.345);
    const y2 = area.y + h + g;
    const y3 = y2 + h + g;
    const h3 = area.y + area.h - y3;
    tiles.push(
      tile({ x: area.x, y: area.y, w: half, h }), tile({ x: right, y: area.y, w: area.w - half - g, h }),
      tile({ x: area.x, y: y2, w: half, h }), tile({ x: right, y: y2, w: area.w - half - g, h }),
      tile({ x: area.x, y: y3, w: area.w, h: h3 })
    );
  }
  return { headline, area, tiles, contact };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface TileParts {
  name: Rect;
  nameMaxSize: number;
  nameMaxLines: number;
  photo: Rect;
  /** Zona de la pastilla de precio (la pastilla se centra y se ajusta al contenido dentro de esta zona). */
  price: Rect;
  priceMaxSize: number;
}

/** Cómo se reparte un mosaico: nombre, foto y precio. Con promoción la pastilla es más alta (lleva la condición debajo del precio). */
export function tileParts(spec: TileSpec, hasCondition: boolean): TileParts {
  const { rect, variant } = spec;
  if (variant === "stack") {
    const nameMaxSize = clamp(Math.round(rect.w * 0.092), 30, 64);
    const nameH = Math.round(nameMaxSize * 2.08);
    const base = clamp(Math.round(rect.h * 0.27), 74, 150);
    const priceH = Math.round(base * (hasCondition ? 1.28 : 1));
    const price: Rect = { x: rect.x, y: rect.y + rect.h - priceH, w: rect.w, h: priceH };
    const photoTop = rect.y + nameH + 4;
    // La pastilla se superpone al borde inferior de la foto (como en las piezas actuales): la foto llega hasta el 42 % de la pastilla.
    const photoBottom = price.y + Math.round(priceH * 0.42);
    return {
      name: { x: rect.x, y: rect.y, w: rect.w, h: nameH }, nameMaxSize, nameMaxLines: 3,
      photo: { x: rect.x, y: photoTop, w: rect.w, h: Math.max(40, photoBottom - photoTop) },
      price, priceMaxSize: Math.round(priceH * (hasCondition ? 0.6 : 0.74))
    };
  }
  const photoW = Math.round(rect.w * 0.52);
  const colX = rect.x + photoW + 16;
  const colW = rect.w - photoW - 16;
  const nameMaxSize = clamp(Math.round(rect.h * 0.17), 30, 60);
  const nameH = Math.round(nameMaxSize * 3.12);
  const nameY = rect.y + Math.round(rect.h * 0.04);
  const priceY = nameY + nameH + 8;
  const priceH = Math.min(hasCondition ? 190 : 150, rect.y + rect.h - priceY - Math.round(rect.h * 0.03));
  return {
    name: { x: colX, y: nameY, w: colW, h: nameH }, nameMaxSize, nameMaxLines: 3,
    photo: { x: rect.x, y: rect.y, w: photoW, h: rect.h },
    price: { x: colX, y: priceY, w: colW, h: Math.max(60, priceH) },
    priceMaxSize: Math.round(Math.max(60, priceH) * (hasCondition ? 0.6 : 0.74))
  };
}
