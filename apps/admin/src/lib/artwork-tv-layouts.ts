import type { Align } from "./artwork-hero-layouts";
import type { Rect } from "./artwork-layout";
import { ARTWORK_FORMATS, BAND_WIDTH, CONTENT_GAP, CONTENT_RIGHT_MARGIN } from "./artwork-tokens";

/**
 * Composiciones 16:9 de las diapositivas de TV (D-076, D-086): la MISMA identidad que las piezas (franja verde + logo, titular rojo,
 * nombre, foto comercial protagonista, mancha amarilla detrás de un recorte, mancha de precio amarilla, etiqueta de la mecánica y sello de
 * ahorro) en cuatro disposiciones distintas para que la presentación no repita siempre lo mismo. Datos puros (rectángulos en px del lienzo
 * de 1920 × 1080): el preview del Admin, el televisor y el PNG leen esta misma lista. La asignación es determinística: diapositiva `n` →
 * variante `n % 4` (no se guarda nada en la base y un refresco de la lista no cambia la disposición de lo que ya está).
 *
 * No es una pieza de Instagram estirada: la foto ocupa más de la mitad del área útil y el precio se monta sobre su borde.
 */

export type TvVariantId = "PHOTO_LEFT" | "PHOTO_RIGHT" | "PHOTO_CENTER" | "DIAGONAL";

export interface TvLayout {
  id: TvVariantId;
  photo: Rect;
  /** Mancha amarilla suave detrás de una foto con fondo transparente. */
  blob: Rect;
  headline: Rect;
  headlineAlign: Align;
  name: Rect;
  nameAlign: Align;
  /** Zona de la mancha de precio (se ajusta al contenido y se ancla según `priceAlign`). */
  price: Rect;
  priceAlign: Align;
  /** Etiqueta de la mecánica («LLEVANDO 3»). */
  mechanic: Rect;
  mechanicAlign: Align;
  mechanicRotate: number;
  /** Sello de ahorro («25% OFF»). */
  sticker: Rect;
  /** Línea «PRECIO NORMAL …». */
  normal: Rect;
  normalAlign: Align;
  headlineSize: number;
  nameSize: number;
  priceSize: number;
  /** Tamaño máximo de la condición dentro de la pastilla (sin etiqueta de mecánica) y de la etiqueta. */
  conditionSize: number;
  mechanicSize: number;
  normalSize: number;
}

const { width: W, height: H } = ARTWORK_FORMATS.tv;
/** Zona útil: a la derecha de la franja verde y dentro de los márgenes. */
export const TV_AREA: Rect = { x: BAND_WIDTH.tv + CONTENT_GAP, y: 40, w: W - (BAND_WIDTH.tv + CONTENT_GAP) - CONTENT_RIGHT_MARGIN, h: H - 80 };

const LEFT = TV_AREA.x;
const RIGHT = TV_AREA.x + TV_AREA.w;

/** Alto de la línea «PRECIO NORMAL …» que va bajo el precio cuando hay promoción. */
export const TV_NORMAL_LINE_HEIGHT = 50;

function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

const COLUMN_W = 680;
const SIZES = { headlineSize: 130, nameSize: 84, priceSize: 230, conditionSize: 48, mechanicSize: 56, normalSize: 40 } as const;

/** Foto a la izquierda (más de la mitad del área); titular, nombre, mecánica y precio en la columna derecha, con el precio montado sobre la foto. */
const PHOTO_LEFT: TvLayout = (() => {
  const photo: Rect = { x: LEFT, y: 50, w: 970, h: 980 };
  const col = RIGHT - COLUMN_W;
  return {
    id: "PHOTO_LEFT", photo, blob: inflate(photo, 22),
    headline: { x: col, y: 56, w: COLUMN_W, h: 130 }, headlineAlign: "center",
    name: { x: col, y: 196, w: COLUMN_W, h: 250 }, nameAlign: "center",
    mechanic: { x: col, y: 470, w: COLUMN_W, h: 92 }, mechanicAlign: "center", mechanicRotate: -2,
    price: { x: 1060, y: 574, w: RIGHT - 1060, h: 290 }, priceAlign: "end",
    normal: { x: col, y: 884, w: COLUMN_W, h: TV_NORMAL_LINE_HEIGHT }, normalAlign: "center",
    sticker: { x: 1000, y: 58, w: 210, h: 210 },
    ...SIZES
  };
})();

/** Espejo: titular, nombre, mecánica y precio a la izquierda; la foto grande a la derecha. */
const PHOTO_RIGHT: TvLayout = (() => {
  const photo: Rect = { x: RIGHT - 970, y: 50, w: 970, h: 980 };
  return {
    id: "PHOTO_RIGHT", photo, blob: inflate(photo, 22),
    headline: { x: LEFT, y: 56, w: COLUMN_W, h: 130 }, headlineAlign: "center",
    name: { x: LEFT, y: 196, w: COLUMN_W, h: 250 }, nameAlign: "center",
    mechanic: { x: LEFT, y: 470, w: COLUMN_W, h: 92 }, mechanicAlign: "center", mechanicRotate: 2,
    price: { x: LEFT, y: 574, w: 900, h: 290 }, priceAlign: "start",
    normal: { x: LEFT, y: 884, w: COLUMN_W, h: TV_NORMAL_LINE_HEIGHT }, normalAlign: "center",
    sticker: { x: photo.x - 24, y: 58, w: 210, h: 210 },
    ...SIZES
  };
})();

/** Titular arriba, la foto protagonista al centro y, abajo, el nombre a la izquierda y el precio a la derecha. */
const PHOTO_CENTER: TvLayout = (() => {
  const photo: Rect = { x: 380, y: 162, w: 1160, h: 660 };
  return {
    id: "PHOTO_CENTER", photo, blob: inflate(photo, 20),
    headline: { x: LEFT, y: 34, w: TV_AREA.w, h: 126 }, headlineAlign: "center",
    name: { x: LEFT, y: 836, w: 780, h: 160 }, nameAlign: "start",
    mechanic: { x: 1090, y: 730, w: RIGHT - 1090, h: 84 }, mechanicAlign: "end", mechanicRotate: -2,
    price: { x: 1010, y: 818, w: RIGHT - 1010, h: 214 }, priceAlign: "end",
    normal: { x: LEFT, y: 996, w: 780, h: 40 }, normalAlign: "start",
    sticker: { x: 1580, y: 176, w: 200, h: 200 },
    headlineSize: 124, nameSize: 78, priceSize: 190, conditionSize: 44, mechanicSize: 52, normalSize: 36
  };
})();

/** Diagonal: nombre arriba a la izquierda, titular arriba a la derecha, foto grande abajo a la derecha y el precio montado sobre ella. */
const DIAGONAL: TvLayout = (() => {
  const photo: Rect = { x: 740, y: 220, w: 1140, h: 810 };
  return {
    id: "DIAGONAL", photo, blob: inflate(photo, 20),
    headline: { x: 880, y: 50, w: RIGHT - 880, h: 140 }, headlineAlign: "end",
    name: { x: LEFT, y: 56, w: 520, h: 300 }, nameAlign: "start",
    mechanic: { x: LEFT, y: 468, w: 640, h: 86 }, mechanicAlign: "start", mechanicRotate: -2,
    price: { x: LEFT, y: 566, w: 800, h: 280 }, priceAlign: "start",
    normal: { x: LEFT, y: 860, w: 640, h: TV_NORMAL_LINE_HEIGHT }, normalAlign: "start",
    sticker: { x: 1650, y: 196, w: 200, h: 200 },
    headlineSize: 140, nameSize: 88, priceSize: 220, conditionSize: 46, mechanicSize: 54, normalSize: 40
  };
})();

export const TV_LAYOUTS: readonly TvLayout[] = [PHOTO_LEFT, PHOTO_RIGHT, PHOTO_CENTER, DIAGONAL];

/** La disposición de la diapositiva número `index` (0 = la primera): rota A, B, C, D, A… */
export function tvLayoutFor(index: number): TvLayout {
  const count = TV_LAYOUTS.length;
  const safe = Number.isFinite(index) ? Math.trunc(index) : 0;
  const layout = TV_LAYOUTS[((safe % count) + count) % count];
  if (!layout) throw new Error("Sin disposiciones de TV");
  return layout;
}
