import { formatCurrency } from "@carnicerias/business-logic";

import type { GlyphWidths } from "./artwork-metrics";
import type { PoultryPriceBoard } from "./poultry";
import { PRICE_LIST_SANS_800_ITALIC_WIDTHS, PRICE_LIST_SERIF_400_WIDTHS, PRICE_LIST_SERIF_700_ITALIC_WIDTHS, PRICE_LIST_SERIF_700_WIDTHS } from "./price-list-font-metrics";

/**
 * «Lista de precios» de Pollos (D-100): una sola imagen PNG con TODOS los productos activos por cajón y su precio de la lista General
 * vigente, con la plantilla de la lista SUPER OFERTAS (`docs/referencias/lista-superofertas.jpg`). Este módulo es puro (sin Satori ni
 * Supabase): arma el modelo desde el tablero de Precios (`get_poultry_price_board`) y calcula la diagramación con los anchos reales de las
 * fuentes embebidas, así ningún nombre ni precio se corta y el alto sale de la cantidad de productos.
 *
 * Reglas de datos (no se calcula ni se inventa ningún precio):
 *   - precio = el vigente de la lista General (`isDefault`) para ese producto, tal cual está registrado;
 *   - sólo productos de Pollos activos (los quitados y eliminados no vienen o vienen inactivos);
 *   - los productos «Por kg» NO entran: su precio General es por kilo, no por cajón (se informan como omitidos);
 *   - un producto por cajón sin precio General no se omite: se muestra «Consultar» (y se informa).
 */

export const PRICE_LIST_TITLE = "LISTA DE PRECIOS";
export const PRICE_LIST_SUBTITLE = "Precio por cajón";
export const PRICE_LIST_SECTION = "POLLO";
export const PRICE_LIST_FOOTER = "TRABAJAMOS CON TODOS LOS MEDIOS DE PAGO.";
export const PRICE_LIST_NO_PRICE = "Consultar";

export interface PriceListRow { name: string; priceCents: bigint | null }

export interface PoultryPriceListModel {
  rows: PriceListRow[];
  /** Productos activos «Por kg»: no tienen precio por cajón y no se listan. */
  omittedByWeight: number;
  /** Productos por cajón sin precio General vigente (se listan como «Consultar»). */
  missingPrice: number;
  /** Fecha local de la organización (AAAA-MM-DD) para el nombre del archivo. */
  date: string;
}

export class PriceListError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PriceListError";
    this.status = status;
  }
}

/** Deja sólo los caracteres que la fuente de los nombres puede dibujar (nunca un cuadradito de «glifo faltante»). Colapsa espacios. */
export function sanitizeListText(text: string): string {
  let out = "";
  for (const character of text.normalize("NFC")) {
    if (character === "\n" || character === "\t") out += " ";
    else if (PRICE_LIST_SERIF_400_WIDTHS[character.codePointAt(0) ?? 0] !== undefined) out += character;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function buildPoultryPriceListModel(board: PoultryPriceBoard, date: string): PoultryPriceListModel {
  const general = board.lists.find((list) => list.isDefault);
  if (!general) throw new PriceListError(422, "No se encontró la lista de precios General de Pollos");
  const active = board.products.filter((product) => product.active);
  const boxes = active.filter((product) => product.saleUnit === "UNIT");
  const rows = boxes
    .map((product) => ({ name: sanitizeListText(product.name) || product.name, priceCents: product.prices[general.id]?.cents ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base", numeric: true }));
  return { rows, omittedByWeight: active.length - boxes.length, missingPrice: rows.filter((row) => row.priceCents === null).length, date };
}

/** «$65.999» (o «$65.999,50» si el precio registrado tiene centavos): el importe exacto de la base, en pesos argentinos. */
export function formatListPrice(cents: bigint | null): string {
  return cents === null ? PRICE_LIST_NO_PRICE : formatCurrency(cents).replace("$ ", "$");
}

export function priceListFilename(date: string): string {
  return `Carnicerias_Fran_Lista_Pollos_${date}.png`;
}

/** Fecha local (AAAA-MM-DD) de `now` en la zona horaria de la organización. */
export function localDate(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Medición de texto con las fuentes de la plantilla
// ---------------------------------------------------------------------------------------------------------------------

export type PriceListFont = "name" | "title" | "footer" | "price";

const WIDTHS: Record<PriceListFont, GlyphWidths> = {
  name: PRICE_LIST_SERIF_400_WIDTHS,
  title: PRICE_LIST_SERIF_700_WIDTHS,
  footer: PRICE_LIST_SERIF_700_ITALIC_WIDTHS,
  price: PRICE_LIST_SANS_800_ITALIC_WIDTHS
};

/** Margen de seguridad sobre el ancho medido (kerning y redondeos del motor). */
const SAFETY = 1.035;

/** Ancho en px de `text` a `sizePx` con la fuente indicada. */
export function listTextWidth(text: string, sizePx: number, font: PriceListFont): number {
  const table = WIDTHS[font];
  let thousandths = 0;
  for (const character of text) thousandths += table[character.codePointAt(0) ?? 0] ?? 600;
  return (thousandths / 1000) * sizePx * SAFETY;
}

/** Parte `text` en renglones de a lo sumo `maxWidth` px por palabras; una palabra más ancha que la caja se parte por letras. */
export function wrapListText(text: string, sizePx: number, maxWidth: number, font: PriceListFont = "name"): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ").filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (listTextWidth(candidate, sizePx, font) <= maxWidth) { current = candidate; continue; }
    if (current) lines.push(current);
    current = "";
    if (listTextWidth(word, sizePx, font) <= maxWidth) { current = word; continue; }
    for (const character of word) {
      if (current && listTextWidth(current + character, sizePx, font) > maxWidth) { lines.push(current); current = ""; }
      current += character;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

// ---------------------------------------------------------------------------------------------------------------------
// Diagramación: proporciones de la referencia (1000 × 1009 px) escaladas a 1080 px de ancho
// ---------------------------------------------------------------------------------------------------------------------

export const PRICE_LIST_WIDTH = 1080;

export const L = {
  /** Franja amarilla superior (la referencia: 90 de 1000 px). */
  headerHeight: 97,
  /** Caja del logo: centrado sobre la tabla, puede asomar por debajo de la franja como en la referencia. */
  logoTop: 5,
  logoMaxWidth: 430,
  logoMaxHeight: 110,
  /** Tabla: x 236–742 de 1000 en la referencia (algo a la izquierda del centro; el fondo se ve a ambos lados). */
  cardX: 255,
  cardWidth: 546,
  cardTop: 104,
  cardBorder: 5,
  cardRadius: 18,
  cardPadX: 9,
  titleSize: 33,
  titleLine: 38,
  titleTop: 13,
  subRowHeight: 30,
  pillPadX: 28,
  pillSize: 22,
  subtitleSize: 19,
  rowsGap: 6,
  nameSize: 22,
  nameLine: 26,
  priceSize: 23,
  rowMinHeight: 34,
  separator: 2,
  columnGap: 12,
  cardPadBottom: 10,
  footerHeight: 76,
  footerSize: 24,
  footerMaxWidth: 1000
} as const;

export interface PriceListRowLayout { y: number; height: number; lines: string[]; price: string; hasPrice: boolean }

export interface PriceListLayout {
  width: number;
  height: number;
  card: { x: number; y: number; width: number; height: number };
  /** Posiciones verticales relativas a `card.y`. */
  titleY: number;
  subRowY: number;
  rows: PriceListRowLayout[];
  innerX: number;
  innerWidth: number;
  nameColumnWidth: number;
  priceColumnWidth: number;
  footerTop: number;
  footerSize: number;
}

/**
 * Diagrama la lista como la referencia: franja chica, tabla angosta y alta, renglones compactos. Cada fila mide lo que su nombre necesita
 * (un nombre largo baja a otro renglón, nunca se achica ni se corta); el alto total sale de la cantidad de productos, sin estirar filas.
 */
export function layoutPoultryPriceList(model: Pick<PoultryPriceListModel, "rows">): PriceListLayout {
  const innerX = L.cardX + L.cardBorder + L.cardPadX;
  const innerWidth = L.cardWidth - (L.cardBorder + L.cardPadX) * 2;
  const prices = model.rows.map((row) => formatListPrice(row.priceCents));
  const priceColumnWidth = Math.ceil(Math.max(listTextWidth("$000.000", L.priceSize, "price"), ...prices.map((price) => listTextWidth(price, L.priceSize, "price"))));
  const nameColumnWidth = innerWidth - priceColumnWidth - L.columnGap;

  const titleY = L.cardBorder + L.titleTop;
  const subRowY = titleY + L.titleLine + 2;
  let y = subRowY + L.subRowHeight + L.rowsGap;
  const rows: PriceListRowLayout[] = model.rows.map((row, index) => {
    const lines = wrapListText(row.name, L.nameSize, nameColumnWidth, "name");
    const height = Math.max(L.rowMinHeight, lines.length * L.nameLine + (L.rowMinHeight - L.nameLine));
    const layout = { y, height, lines, price: prices[index] ?? PRICE_LIST_NO_PRICE, hasPrice: row.priceCents !== null };
    y += height;
    return layout;
  });
  const footerTop = L.cardTop + y + L.cardPadBottom;
  let footerSize: number = L.footerSize;
  while (footerSize > 14 && listTextWidth(PRICE_LIST_FOOTER, footerSize, "footer") > L.footerMaxWidth) footerSize -= 1;

  return {
    width: PRICE_LIST_WIDTH,
    height: footerTop + L.footerHeight,
    // La tabla sigue por debajo del pie (como en la referencia, el pie la tapa): sin borde inferior visible.
    card: { x: L.cardX, y: L.cardTop, width: L.cardWidth, height: footerTop - L.cardTop + L.cardRadius },
    titleY, subRowY, rows, innerX, innerWidth, nameColumnWidth, priceColumnWidth, footerTop, footerSize
  };
}

/** Tamaño del logo dentro de su caja, sin deformarlo ni agrandarlo más de lo que entra. */
export function fitLogo(widthPx: number, heightPx: number): { width: number; height: number } {
  const scale = Math.min(L.logoMaxWidth / widthPx, L.logoMaxHeight / heightPx);
  return { width: Math.max(1, Math.round(widthPx * scale)), height: Math.max(1, Math.round(heightPx * scale)) };
}
