/**
 * Composiciones del collage (D-075, iteración editorial): slots PREDEFINIDOS por cantidad (2 a 5) y formato (Feed / Story). No es un
 * editor libre: cada composición es una constante determinística que lee `collageLayout`, y el preview y el PNG (Satori) usan esa
 * misma función; no existe una segunda definición de las posiciones.
 *
 * Idea visual: los productos NO comparten top, ancho ni alto; alternan izquierda/derecha y bajan en zig-zag, con fotos de tamaños
 * apenas distintos y espacio en blanco intencional. Los slots están en FRACCIONES del área de mosaicos (entre el titular y el
 * contacto), así se adaptan al alto de cada formato sin tocar números sueltos en los componentes.
 */

/** Dónde queda el nombre respecto de la foto: arriba y centrado, o corrido hacia el borde izquierdo / derecho de la foto. */
export type NamePlacement = "top" | "top-start" | "top-end";
/** Dónde se ancla la pastilla de precio dentro del ancho de su foto. */
export type PricePlacement = "start" | "center" | "end";

export interface CollageSlot {
  /** Bloque «foto + precio» en fracciones del área: `y` es el borde superior de la foto (el nombre va encima). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Multiplicador de la foto alrededor de su centro (la foto usa parte del espacio en blanco vecino). */
  imageScale: number;
  namePlacement: NamePlacement;
  pricePlacement: PricePlacement;
  /** Alto de la pastilla de precio en px, sin promoción (con «llevando N» se agranda para alojar la condición). */
  badgeH: number;
}

export type CollageCount = 2 | 3 | 4 | 5;

/** Escala de la pastilla amarilla respecto del collage anterior (objetivo 80–85 %). */
export const COLLAGE_PRICE_SCALE = 0.82;

function slot(x: number, y: number, w: number, h: number, extra: Partial<CollageSlot> & Pick<CollageSlot, "badgeH">): CollageSlot {
  return { x, y, w, h, imageScale: 1, namePlacement: "top", pricePlacement: "center", ...extra };
}

/** Feed 4:5 (1080 × 1350). */
const FEED: Record<CollageCount, readonly CollageSlot[]> = {
  // 2 → una diagonal: el primero arriba a la izquierda, el segundo abajo a la derecha, cada uno con su aire.
  2: [
    slot(0.00, 0.095, 0.76, 0.40, { badgeH: 116, namePlacement: "top-start", pricePlacement: "start", imageScale: 1.08 }),
    slot(0.24, 0.605, 0.76, 0.395, { badgeH: 116, namePlacement: "top-end", pricePlacement: "end", imageScale: 1.08 })
  ],
  // 3 → diagonal: arriba a la derecha, al medio a la izquierda, abajo a la derecha (el último, el más grande).
  3: [
    slot(0.50, 0.085, 0.50, 0.34, { badgeH: 100, namePlacement: "top-end", pricePlacement: "end" }),
    slot(0.00, 0.335, 0.50, 0.335, { badgeH: 100, namePlacement: "top-start", pricePlacement: "start" }),
    slot(0.44, 0.575, 0.56, 0.425, { badgeH: 104, namePlacement: "top-end", pricePlacement: "end", imageScale: 1.05 })
  ],
  // 4 → zig-zag: derecha, izquierda, derecha, izquierda; cada columna arranca a otra altura.
  4: [
    slot(0.48, 0.075, 0.52, 0.38, { badgeH: 109, namePlacement: "top-end", pricePlacement: "end" }),
    slot(0.00, 0.165, 0.52, 0.365, { badgeH: 109, namePlacement: "top-start", pricePlacement: "start" }),
    slot(0.48, 0.55, 0.52, 0.425, { badgeH: 109, namePlacement: "top-end", pricePlacement: "end" }),
    slot(0.00, 0.625, 0.52, 0.375, { badgeH: 109, namePlacement: "top-start", pricePlacement: "start" })
  ],
  // 5 → zig-zag 3 + 2: tres chicos a la izquierda y dos grandes a la derecha, intercalados (I, D, I, D, I).
  5: [
    slot(0.00, 0.075, 0.49, 0.255, { badgeH: 76, namePlacement: "top-start", pricePlacement: "start" }),
    slot(0.51, 0.165, 0.49, 0.375, { badgeH: 88, namePlacement: "top-end", pricePlacement: "end" }),
    slot(0.00, 0.44, 0.49, 0.25, { badgeH: 76, namePlacement: "top-start", pricePlacement: "start" }),
    slot(0.51, 0.635, 0.49, 0.365, { badgeH: 88, namePlacement: "top-end", pricePlacement: "end" }),
    slot(0.00, 0.775, 0.49, 0.225, { badgeH: 76, namePlacement: "top-start", pricePlacement: "start" })
  ]
};

/** Story 9:16 (1080 × 1920): composición propia, espejada y con más desfase; no son las coordenadas del Feed. */
const STORY: Record<CollageCount, readonly CollageSlot[]> = {
  2: [
    slot(0.24, 0.095, 0.76, 0.40, { badgeH: 113, namePlacement: "top-end", pricePlacement: "end", imageScale: 1.08 }),
    slot(0.00, 0.60, 0.76, 0.40, { badgeH: 113, namePlacement: "top-start", pricePlacement: "start", imageScale: 1.08 })
  ],
  3: [
    slot(0.00, 0.085, 0.50, 0.34, { badgeH: 102, namePlacement: "top-start", pricePlacement: "start" }),
    slot(0.50, 0.335, 0.50, 0.335, { badgeH: 102, namePlacement: "top-end", pricePlacement: "end" }),
    slot(0.00, 0.575, 0.56, 0.425, { badgeH: 106, namePlacement: "top-start", pricePlacement: "start", imageScale: 1.05 })
  ],
  4: [
    slot(0.00, 0.075, 0.52, 0.37, { badgeH: 113, namePlacement: "top-start", pricePlacement: "start" }),
    slot(0.48, 0.22, 0.52, 0.36, { badgeH: 113, namePlacement: "top-end", pricePlacement: "end" }),
    slot(0.00, 0.545, 0.52, 0.425, { badgeH: 113, namePlacement: "top-start", pricePlacement: "start" }),
    slot(0.48, 0.68, 0.52, 0.32, { badgeH: 113, namePlacement: "top-end", pricePlacement: "end" })
  ],
  5: [
    slot(0.51, 0.075, 0.49, 0.255, { badgeH: 78, namePlacement: "top-end", pricePlacement: "end" }),
    slot(0.00, 0.145, 0.49, 0.385, { badgeH: 90, namePlacement: "top-start", pricePlacement: "start" }),
    slot(0.51, 0.44, 0.49, 0.25, { badgeH: 78, namePlacement: "top-end", pricePlacement: "end" }),
    slot(0.00, 0.635, 0.49, 0.365, { badgeH: 90, namePlacement: "top-start", pricePlacement: "start" }),
    slot(0.51, 0.775, 0.49, 0.225, { badgeH: 78, namePlacement: "top-end", pricePlacement: "end" })
  ]
};

export const COLLAGE_LAYOUTS: Readonly<Record<"feed" | "story", Record<CollageCount, readonly CollageSlot[]>>> = { feed: FEED, story: STORY };
