/**
 * Identidad visual de los descuentos por cantidad del POS (solo presentación: no toca pricing, escalones, Pack ni sync).
 *
 * Cada ESCALÓN configurado toma su variante por POSICIÓN (el 1.º escalón por cantidad, el 2.º, ...), nunca por su cantidad mínima
 * ("desde 3" / "desde 5" son configurables: mañana pueden ser 2, 4, 6, 10). El Pack tiene siempre su variante propia (azul), distinta de
 * todas las de los escalones. Como la paleta es corta, un 6.º escalón vuelve a empezar, pero dos escalones CONSECUTIVOS nunca comparten color.
 *
 * Son clases de Tailwind completas (escritas literales para que el escáner las vea). Todas son fondo oscuro 950 + texto 300 (contraste alto
 * sobre el POS oscuro) y un anillo del mismo tono; ninguna es roja/rosa, para que no se lea como un error (el rojo/rosa es el del precio).
 * El color nunca es la única señal: el chip siempre dice «desde N u» o «Pack N u».
 */

export interface DiscountPalette {
  /** Nombre de la variante (también es el valor de `data-discount-variant`). */
  readonly variant: string;
  /** Chip compacto (fondo + texto + anillo). */
  readonly chip: string;
  /** Sólo el color del texto (líneas de «Descuento aplicado» del diálogo). */
  readonly text: string;
  /** Recuadro destacado del diálogo (fondo + borde + texto). */
  readonly panel: string;
}

/** Escalones por cantidad, en orden de posición: ámbar → verde → violeta → naranja → lima. */
export const TIER_PALETTES: readonly DiscountPalette[] = [
  { variant: "tier-1", chip: "bg-amber-950 text-amber-300 ring-amber-500/60", text: "text-amber-300", panel: "border-amber-500/60 bg-amber-950/40 text-amber-200" },
  { variant: "tier-2", chip: "bg-emerald-950 text-emerald-300 ring-emerald-500/60", text: "text-emerald-300", panel: "border-emerald-500/60 bg-emerald-950/40 text-emerald-200" },
  { variant: "tier-3", chip: "bg-violet-950 text-violet-300 ring-violet-500/60", text: "text-violet-300", panel: "border-violet-500/60 bg-violet-950/40 text-violet-200" },
  { variant: "tier-4", chip: "bg-orange-950 text-orange-300 ring-orange-500/60", text: "text-orange-300", panel: "border-orange-500/60 bg-orange-950/40 text-orange-200" },
  { variant: "tier-5", chip: "bg-lime-950 text-lime-300 ring-lime-500/60", text: "text-lime-300", panel: "border-lime-500/60 bg-lime-950/40 text-lime-200" }
];

/** El Pack (siempre su propia identidad: azul/cielo, el color que ya tenía). */
export const PACK_PALETTE: DiscountPalette = {
  variant: "pack", chip: "bg-sky-950 text-sky-300 ring-sky-500/60", text: "text-sky-300", panel: "border-sky-500/60 bg-sky-950/40 text-sky-200"
};

/** Chip neutro «+N» de la fila cuando hay más descuentos de los que entran en una fila de alto fijo (no es un descuento: es un aviso). */
export const MORE_PALETTE: DiscountPalette = {
  variant: "more", chip: "bg-stone-800 text-stone-300 ring-stone-600", text: "text-stone-300", panel: "border-stone-600 bg-stone-900 text-stone-200"
};

/** Cuántos chips entran cómodos en una fila de la lista (alto fijo, sin segunda línea) en el ancho típico del POS. */
export const MAX_ROW_CHIPS = 4;

/**
 * Los chips que se dibujan en una fila: todos si entran; si no, el Pack se conserva SIEMPRE (es el beneficio que no puede quedar tapado),
 * se muestran los primeros escalones en orden y el resto se agrupa en un chip «+N» (con la lista completa en el título).
 */
export function limitRowChips<T extends { kind: "PACK" | "PROMO" }>(chips: readonly T[], max: number = MAX_ROW_CHIPS): { shown: T[]; hidden: T[] } {
  if (chips.length <= max) return { shown: [...chips], hidden: [] };
  const packs = chips.filter((chip) => chip.kind === "PACK").length;
  let slots = Math.max(0, max - 1 - packs);
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const chip of chips) {
    if (chip.kind === "PACK") shown.push(chip);
    else if (slots > 0) { shown.push(chip); slots -= 1; } else hidden.push(chip);
  }
  return { shown, hidden };
}

/** Variante de un escalón por su posición (0 = el de menor cantidad). Una posición inválida usa la primera. */
export function tierPalette(index: number): DiscountPalette {
  const palette = TIER_PALETTES;
  const safe = Number.isInteger(index) && index >= 0 ? index % palette.length : 0;
  return palette[safe] ?? PACK_PALETTE;
}

/** La paleta de un chip del catálogo: Pack = azul; promo con posición de escalón = la de ese escalón; cualquier otra promo (p. ej. de peso) = la del 1.º. */
export function discountPalette(kind: "PACK" | "PROMO", tierIndex?: number): DiscountPalette {
  return kind === "PACK" ? PACK_PALETTE : tierPalette(tierIndex ?? 0);
}

/** Posición de un escalón entre TODOS los configurados, ordenados por cantidad mínima (estable aunque alguno no se muestre). */
export function tierPositionByMinimumUnits(tiers: readonly { minimumUnits: number }[], minimumUnits: number): number {
  const sorted = [...tiers].map((tier) => tier.minimumUnits).sort((left, right) => left - right);
  const position = sorted.indexOf(minimumUnits);
  return position < 0 ? 0 : position;
}
