import { contactRect, contentColumn, verticalBounds, type Rect } from "./artwork-layout";
import { seedFromText } from "./artwork-shapes";

/**
 * Composiciones del «Producto protagonista» para Feed (1080 × 1350) y Story (1080 × 1920) (D-086). Cuatro VARIANTES determinísticas de la
 * misma identidad (franja verde con el logo, titular rojo, foto grande, precio amarillo, contacto abajo a la izquierda) para que diez
 * piezas seguidas no parezcan copias: foto al centro, foto a la izquierda con el precio a la derecha, su espejo, y precio arriba.
 *
 * Datos puros (rectángulos en px del lienzo): el preview, el PNG y las pruebas leen esta misma función. La variante se elige de forma
 * ESTABLE (`pickHeroVariant`): configuración explícita > posición en la serie > id del producto. Nunca se sortea: regenerar la misma
 * pieza da siempre la misma composición.
 */

export type HeroVariantId = "CENTER" | "PHOTO_LEFT" | "PHOTO_RIGHT" | "PRICE_FIRST";

export const HERO_VARIANTS: readonly HeroVariantId[] = ["CENTER", "PHOTO_LEFT", "PHOTO_RIGHT", "PRICE_FIRST"];

export const HERO_VARIANT_LABELS: Readonly<Record<HeroVariantId, string>> = {
  CENTER: "Foto al centro",
  PHOTO_LEFT: "Foto a la izquierda",
  PHOTO_RIGHT: "Foto a la derecha",
  PRICE_FIRST: "Precio arriba"
};

export function isHeroVariant(value: unknown): value is HeroVariantId {
  return typeof value === "string" && (HERO_VARIANTS as readonly string[]).includes(value);
}

/**
 * La variante de una pieza, sin azar: la configurada si existe; si no, la que corresponde a su posición en la serie (las piezas de una
 * carpeta rotan A, B, C, D, A…); si no hay posición, una derivada del id del producto (siempre la misma para ese producto).
 */
export function pickHeroVariant(input: { explicit?: HeroVariantId | null; index?: number | null; seed?: string | null }): HeroVariantId {
  if (input.explicit && isHeroVariant(input.explicit)) return input.explicit;
  const count = HERO_VARIANTS.length;
  const raw = input.index !== undefined && input.index !== null && Number.isFinite(input.index) ? Math.trunc(input.index) : seedFromText(input.seed ?? "");
  const variant = HERO_VARIANTS[((raw % count) + count) % count];
  return variant ?? "CENTER";
}

export type Align = "start" | "center" | "end";

export interface HeroLayout {
  id: HeroVariantId;
  headline: Rect;
  headlineAlign: Align;
  headlineSize: number;
  name: Rect;
  nameAlign: Align;
  nameSize: number;
  nameLines: number;
  photo: Rect;
  /** Mancha amarilla suave detrás de una foto con fondo transparente (se dibuja sólo si la foto lo tiene). */
  blob: Rect;
  blobSeed: number;
  /** Zona de la pastilla del precio (se ajusta al contenido y se ancla según `priceAlign`). */
  price: Rect;
  priceAlign: Align;
  priceSize: number;
  /** Etiqueta de la mecánica («LLEVANDO 3»): zona + giro en grados. */
  mechanic: Rect;
  mechanicAlign: Align;
  mechanicSize: number;
  mechanicRotate: number;
  /** Sello de ahorro («25% OFF»): cuadrado. */
  sticker: Rect;
  /** Línea «PRECIO NORMAL …». */
  normal: Rect;
  normalSize: number;
  normalAlign: Align;
  contact: Rect;
}

export interface HeroFlags {
  /** La oferta tiene promoción real (lleva la línea «precio normal»). */
  promo: boolean;
  /** Tiene una mecánica para destacar (etiqueta). */
  mechanic: boolean;
}

type HeroFormat = "feed" | "story";

interface Metrics {
  headlineH: number; headlineSize: number; nameSize: number; nameLines: number;
  priceH: number; priceSize: number; normalH: number; normalSize: number; mechanicH: number; mechanicSize: number; sticker: number;
}

const METRICS: Record<HeroFormat, Metrics> = {
  feed: { headlineH: 124, headlineSize: 140, nameSize: 76, nameLines: 3, priceH: 206, priceSize: 178, normalH: 40, normalSize: 36, mechanicH: 72, mechanicSize: 46, sticker: 184 },
  story: { headlineH: 134, headlineSize: 150, nameSize: 86, nameLines: 3, priceH: 236, priceSize: 200, normalH: 44, normalSize: 40, mechanicH: 82, mechanicSize: 52, sticker: 208 }
};

/** El nombre reserva dos renglones; uno largo admite un tercero achicando la letra (nunca se corta con «...»). */
function nameHeight(m: Metrics): number {
  return Math.round(m.nameSize * 2 * 1.06);
}

function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

/** El rectángulo de una pastilla de ancho `w` anclada a `align` dentro de la columna. */
function anchored(column: { x: number; w: number }, w: number, align: Align): { x: number; w: number } {
  const width = Math.min(w, column.w);
  return { x: align === "start" ? column.x : align === "end" ? column.x + column.w - width : column.x + Math.round((column.w - width) / 2), w: width };
}

/** Cuánto de la pastilla de precio se monta sobre el borde inferior de la foto. */
const PRICE_OVERLAP = 0.34;

/**
 * Dónde va cada bloque en `format` con la variante `variant`. La foto siempre se ve entera (`contain`): estos rectángulos son sus cajas,
 * pensadas para que ocupe entre 15 y 30 % más que en la composición anterior sin tapar el nombre ni el precio.
 */
export function heroLayout(format: HeroFormat, variant: HeroVariantId, flags: HeroFlags): HeroLayout {
  const m = METRICS[format];
  const column = contentColumn(format);
  const { top } = verticalBounds(format);
  const contact = contactRect(format);
  const promo = flags.promo;
  const normalY = contact.y - 8 - m.normalH;
  const bottomOfPrice = promo ? normalY - 6 : contact.y - 14;
  const price: Rect = { x: column.x, y: bottomOfPrice - m.priceH, w: column.w, h: m.priceH };
  const normal: Rect = { x: column.x, y: normalY, w: column.w, h: m.normalH };
  const headline: Rect = { x: column.x, y: top - 4, w: column.w, h: m.headlineH };
  const nameH = nameHeight(m);
  const name: Rect = { x: column.x, y: headline.y + headline.h + 2, w: column.w, h: nameH };
  const blobSeed = seedFromText(`${format}-${variant}`);
  const sticker = (x: number, y: number): Rect => ({ x, y, w: m.sticker, h: m.sticker });
  const mechanicZone = (y: number): Rect => ({ x: column.x, y, w: column.w, h: m.mechanicH });

  const common = {
    id: variant, headlineSize: m.headlineSize, nameSize: m.nameSize, nameLines: m.nameLines, blobSeed, priceSize: m.priceSize,
    mechanicSize: m.mechanicSize, normalSize: m.normalSize, contact
  };

  if (variant === "PHOTO_LEFT" || variant === "PHOTO_RIGHT") {
    const left = variant === "PHOTO_LEFT";
    const side: Align = left ? "start" : "end";
    const other: Align = left ? "end" : "start";
    const photoW = Math.round(column.w * 0.94);
    const photoX = left ? column.x : column.x + column.w - photoW;
    const photoTop = name.y + name.h + 4;
    // La foto baja más que en la composición central: el precio queda al costado (no debajo) y se monta sobre su esquina.
    const photoBottom = price.y + Math.round(m.priceH * 0.62);
    const photo: Rect = { x: photoX, y: photoTop, w: photoW, h: photoBottom - photoTop };
    const priceZone = anchored(column, Math.round(column.w * 0.78), other);
    return {
      ...common, headline: { ...headline, x: column.x }, headlineAlign: side,
      name, nameAlign: side,
      photo, blob: inflate(photo, 18),
      price: { x: priceZone.x, y: price.y, w: priceZone.w, h: m.priceH }, priceAlign: other,
      mechanic: { ...mechanicZone(price.y - Math.round(m.mechanicH * 0.62)), x: priceZone.x, w: priceZone.w }, mechanicAlign: other, mechanicRotate: left ? 2 : -2,
      sticker: sticker(left ? column.x + column.w - m.sticker - 4 : column.x + 4, photoTop + 6),
      normal: { ...normal, x: priceZone.x, w: priceZone.w }, normalAlign: other === "end" ? "end" : "start"
    };
  }

  if (variant === "PRICE_FIRST") {
    // Titular, nombre y el precio enseguida (lo primero que se lee); la foto ocupa todo el resto hasta el contacto.
    const priceTop = name.y + name.h + 6;
    // El precio va primero pero un poco más bajo: la foto conserva el espacio que gana en esta composición.
    const priceBox: Rect = { x: column.x, y: priceTop, w: column.w, h: Math.round(m.priceH * 0.86) };
    const normalBox: Rect = { x: column.x, y: priceBox.y + priceBox.h + 2, w: column.w, h: m.normalH };
    const photoTop = (promo ? normalBox.y + normalBox.h : priceBox.y + priceBox.h) + 4;
    const photoBottom = contact.y - 6;
    const photo: Rect = { x: column.x + 6, y: photoTop, w: column.w - 6, h: photoBottom - photoTop };
    return {
      ...common, headline, headlineAlign: "start",
      name, nameAlign: "start",
      photo, blob: inflate(photo, 14),
      price: priceBox, priceAlign: "start",
      // La etiqueta de mecánica va sobre el borde superior de la foto, a la derecha del precio.
      mechanic: { x: column.x, y: photoTop + 6, w: column.w, h: m.mechanicH }, mechanicAlign: "end", mechanicRotate: -3,
      sticker: sticker(column.x + column.w - m.sticker - 6, photoBottom - m.sticker - 8),
      normal: normalBox, normalAlign: "start"
    };
  }

  // CENTER: todo centrado; la foto crece hacia abajo por detrás de la pastilla.
  const photoTop = name.y + name.h + 2;
  const photoBottom = price.y + Math.round(m.priceH * PRICE_OVERLAP);
  const photo: Rect = { x: column.x + 6, y: photoTop, w: column.w - 6, h: photoBottom - photoTop };
  return {
    ...common, headline, headlineAlign: "center",
    name, nameAlign: "center",
    photo, blob: inflate(photo, 16),
    price, priceAlign: "center",
    mechanic: mechanicZone(price.y - Math.round(m.mechanicH * 0.6)), mechanicAlign: "center", mechanicRotate: -2,
    sticker: sticker(column.x + column.w - m.sticker - 2, photoTop + 4),
    normal, normalAlign: "center"
  };
}
