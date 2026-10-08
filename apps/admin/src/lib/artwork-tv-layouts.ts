import type { Rect } from "./artwork-layout";
import { ARTWORK_FORMATS, BAND_WIDTH, CONTENT_GAP, CONTENT_RIGHT_MARGIN } from "./artwork-tokens";

/**
 * Composiciones 16:9 de las diapositivas de TV (D-076): la MISMA identidad que las piezas (franja verde + logo, titular rojo, nombre,
 * foto comercial protagonista y pastilla de precio amarilla) en cuatro disposiciones distintas para que la presentación no repita
 * siempre lo mismo. Datos puros (rectángulos en px del lienzo de 1920 × 1080): el preview del Admin, el televisor y el PNG leen
 * esta misma lista. La asignación es determinística: diapositiva `n` → variante `n % 4` (no se guarda nada en la base).
 */

export type TvVariantId = "PHOTO_LEFT" | "PHOTO_RIGHT" | "PHOTO_CENTER" | "DIAGONAL";

export interface TvLayout {
  id: TvVariantId;
  photo: Rect;
  headline: Rect;
  name: Rect;
  /** Zona de la pastilla de precio (se ancla según `priceAlign`; con promoción necesita más alto). La línea «precio normal» va debajo. */
  price: Rect;
  priceAlign: "start" | "center" | "end";
  headlineSize: number;
  nameSize: number;
  priceSize: number;
  conditionSize: number;
  normalSize: number;
}

const { width: W, height: H } = ARTWORK_FORMATS.tv;
/** Zona útil: a la derecha de la franja verde y dentro de los márgenes. */
export const TV_AREA: Rect = { x: BAND_WIDTH.tv + CONTENT_GAP, y: 40, w: W - (BAND_WIDTH.tv + CONTENT_GAP) - CONTENT_RIGHT_MARGIN, h: H - 80 };

const LEFT = TV_AREA.x;
const RIGHT = TV_AREA.x + TV_AREA.w;

/** Alto de la línea «PRECIO NORMAL …» que va bajo la pastilla cuando hay promoción. */
export const TV_NORMAL_LINE_HEIGHT = 50;

/** Foto a la izquierda (grande, a casi toda la altura); titular, nombre y precio en la columna derecha. */
const PHOTO_LEFT: TvLayout = {
  id: "PHOTO_LEFT",
  photo: { x: LEFT, y: 60, w: 920, h: 960 },
  headline: { x: 1160, y: 70, w: RIGHT - 1160, h: 140 },
  name: { x: 1160, y: 230, w: RIGHT - 1160, h: 280 },
  price: { x: 1160, y: 530, w: RIGHT - 1160, h: 340 },
  priceAlign: "center",
  headlineSize: 140, nameSize: 92, priceSize: 230, conditionSize: 48, normalSize: 40
};

/** Titular, nombre y precio a la izquierda; la foto grande a la derecha. */
const PHOTO_RIGHT: TvLayout = {
  id: "PHOTO_RIGHT",
  photo: { x: 960, y: 90, w: RIGHT - 960, h: 920 },
  headline: { x: LEFT, y: 70, w: 700, h: 140 },
  name: { x: LEFT, y: 240, w: 700, h: 280 },
  price: { x: LEFT, y: 560, w: 700, h: 340 },
  priceAlign: "center",
  headlineSize: 140, nameSize: 92, priceSize: 230, conditionSize: 48, normalSize: 40
};

/** Titular arriba, la foto protagonista al centro y, abajo, el nombre a la izquierda y el precio a la derecha. */
const PHOTO_CENTER: TvLayout = {
  id: "PHOTO_CENTER",
  photo: { x: 493, y: 178, w: 1100, h: 612 },
  headline: { x: LEFT, y: 40, w: TV_AREA.w, h: 130 },
  name: { x: LEFT, y: 815, w: 800, h: 200 },
  price: { x: 1040, y: 790, w: RIGHT - 1040, h: 220 },
  priceAlign: "center",
  headlineSize: 130, nameSize: 80, priceSize: 160, conditionSize: 40, normalSize: 36
};

/** Diagonal: nombre en la esquina superior izquierda, foto grande abajo a la derecha y la pastilla pegada a la foto. */
const DIAGONAL: TvLayout = {
  id: "DIAGONAL",
  photo: { x: 760, y: 245, w: RIGHT - 760, h: 785 },
  headline: { x: 900, y: 50, w: RIGHT - 900, h: 150 },
  name: { x: LEFT, y: 60, w: 540, h: 310 },
  price: { x: LEFT, y: 560, w: 660, h: 340 },
  priceAlign: "end",
  headlineSize: 140, nameSize: 88, priceSize: 220, conditionSize: 46, normalSize: 40
};

export const TV_LAYOUTS: readonly TvLayout[] = [PHOTO_LEFT, PHOTO_RIGHT, PHOTO_CENTER, DIAGONAL];

/** La disposición de la diapositiva número `index` (0 = la primera): rota A, B, C, D, A… */
export function tvLayoutFor(index: number): TvLayout {
  const count = TV_LAYOUTS.length;
  const safe = Number.isFinite(index) ? Math.trunc(index) : 0;
  const layout = TV_LAYOUTS[((safe % count) + count) % count];
  if (!layout) throw new Error("Sin disposiciones de TV");
  return layout;
}
