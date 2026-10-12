import type { CSSProperties, ReactNode } from "react";

import { formatPriceText, hasPromotion, heroPrice, type OfferItem } from "../../lib/artwork";
import { placeLogoFor, type ArtworkBranding, type ArtworkContact } from "../../lib/artwork-branding";
import { ARTWORK_DISPLAY_FONT_FAMILY } from "../../lib/artwork-display-font-data";
import { ARTWORK_FONT_FAMILY } from "../../lib/artwork-font-data";
import type { Rect } from "../../lib/artwork-layout";
import { burstPoints, organicBlobPath, organicPillPath } from "../../lib/artwork-shapes";
import { fitText, textWidth, type FittedText } from "../../lib/artwork-text";
import { ARTWORK_COLORS as C, ARTWORK_FORMATS, BAND_WIDTH, PRICE_BADGE, STORY_SAFE, type ArtworkFormat } from "../../lib/artwork-tokens";
import type { OfferPrice } from "../../lib/signage";

/**
 * Piezas COMPARTIDAS por todas las plantillas y formatos (D-074 / D-075): lienzo, franja verde con el logo, titular, nombre, foto,
 * pastilla de precio y bloque de contacto. El protagonista (`hero-offer.tsx`) y el collage (`collage-offer.tsx`) sólo las componen:
 * no hay una segunda versión de la identidad en ninguna plantilla.
 *
 * Están escritas para el subconjunto de CSS que entienden a la vez el navegador (preview) y Satori (PNG): cajas absolutas con
 * medidas en px, `display: flex` en todo contenedor, un renglón por elemento (los saltos los decide `lib/artwork-text.ts` con los
 * anchos reales de la fuente) y nada de sombras, gradientes ni efectos.
 */

export const FONT_STACK = `${ARTWORK_FONT_FAMILY}, Arial, Helvetica, sans-serif`;
/** Fuente de TÍTULOS promocionales (Anton, condensada y pesada): sólo el titular («OFERTA»); nombre, mecánica y precio siguen en la sans. */
export const DISPLAY_FONT_STACK = `${ARTWORK_DISPLAY_FONT_FAMILY}, Impact, "Arial Narrow", sans-serif`;

export function Box({ rect, children, style }: { rect: Rect; children?: ReactNode; style?: CSSProperties }) {
  return <div style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h, display: "flex", ...style }}>{children}</div>;
}

/** Alineación horizontal de un bloque de texto dentro de su caja. */
export type TextAlign = "start" | "center" | "end";

const JUSTIFY: Record<TextAlign, "flex-start" | "center" | "flex-end"> = { start: "flex-start", center: "center", end: "flex-end" };

/** Línea de texto de un solo renglón, sin ajuste automático (el tamaño ya viene calculado). */
export function Line({ text, size, color, weight = 900, lineHeight = 1, align = "center", decoration }: {
  text: string; size: number; color: string; weight?: 400 | 700 | 900; lineHeight?: number; align?: "center" | "flex-start" | "flex-end"; decoration?: "line-through";
}) {
  const height = Math.round(size * lineHeight);
  return <div style={{
    display: "flex", justifyContent: align, alignItems: "center", width: "100%", height, fontSize: size, lineHeight: `${String(height)}px`,
    fontWeight: weight, color, whiteSpace: "nowrap", ...(weight === 400 ? { fontFamily: DISPLAY_FONT_STACK } : {}), ...(decoration ? { textDecoration: decoration } : {})
  }}>{text}</div>;
}

export function TextBlock({ fitted, color, lineHeight = 1.02, weight = 900, align = "center" }: {
  fitted: FittedText; color: string; lineHeight?: number; weight?: 400 | 700 | 900; align?: TextAlign;
}) {
  return <div style={{ display: "flex", flexDirection: "column", width: "100%", alignItems: JUSTIFY[align], justifyContent: "center" }}>
    {fitted.lines.map((line, index) => <Line align={JUSTIFY[align]} color={color} key={`${String(index)}-${line}`} lineHeight={lineHeight} size={fitted.size} text={line} weight={weight} />)}
  </div>;
}

export function Canvas({ format, children, testId, variant }: { format: ArtworkFormat; children: ReactNode; testId: string; variant?: string }) {
  const spec = ARTWORK_FORMATS[format];
  return <div data-artwork-format={format} data-artwork-variant={variant} data-testid={testId} style={{
    position: "relative", display: "flex", width: spec.width, height: spec.height, background: C.WHITE, color: C.BLACK, fontFamily: FONT_STACK, fontKerning: "none", overflow: "hidden"
  }}>{children}</div>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Franja verde + LOGO real
// ---------------------------------------------------------------------------------------------------------------------

/** Zona base del logo (en Story, dentro de las zonas seguras): sólo para el nombre de respaldo; el logo usa `placeLogoFor`. */
function logoArea(format: ArtworkFormat): Rect {
  const { height } = ARTWORK_FORMATS[format];
  const band = BAND_WIDTH[format];
  const pad = Math.round(band * 0.11);
  const top = format === "story" ? STORY_SAFE.top : 40;
  const bottom = format === "story" ? height - STORY_SAFE.bottom : height - 40;
  return { x: pad, y: top + 12, w: band - pad * 2, h: bottom - top - 24 };
}

/**
 * Franja lateral verde de marca, de punta a punta, con el LOGO REAL de la organización dentro (una imagen cargada por el usuario;
 * nunca se dibuja ni se recrea). Un logo apaisado se gira -90° (se lee de abajo hacia arriba, como en las piezas actuales). Si la
 * organización todavía no cargó logo, queda su nombre en vertical como último recurso.
 */
export function BrandBand({ branding, format }: { branding: ArtworkBranding; format: ArtworkFormat }) {
  const spec = ARTWORK_FORMATS[format];
  const band = BAND_WIDTH[format];
  const area = logoArea(format);
  const logo = branding.logo;
  const placement = logo ? placeLogoFor(logo, format, logo.scalePercent) : null;
  return <>
    <Box rect={{ x: 0, y: 0, w: placement?.band ?? band, h: spec.height }} style={{ background: branding.colors.green }} />
    {logo && placement ? <LogoImage imageUrl={logo.imageUrl} place={placement} /> : <FallbackName area={area} name={branding.businessName} />}
  </>;
}

function LogoImage({ imageUrl, place }: { imageUrl: string; place: ReturnType<typeof placeLogoFor> }) {
  return <Box rect={{ x: place.left, y: place.top, w: place.width, h: place.height }} style={place.rotate === 0 ? {} : { transform: `rotate(${String(place.rotate)}deg)` }}>
    {/* Satori (PNG) y el preview comparten esta etiqueta <img>: next/image no aplica. */}
    <img alt="" data-testid="artwork-logo" height={place.height} src={imageUrl} style={{ width: place.width, height: place.height, objectFit: "contain" }} width={place.width} />
  </Box>;
}

function FallbackName({ area, name }: { area: Rect; name: string }) {
  const length = Math.min(area.h, 760);
  const fitted = fitText({ text: name, maxWidth: length, maxLines: 1, maxSize: Math.round(area.w * 0.62), minSize: 24 });
  const thickness = Math.round(fitted.size * 1.1);
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  return <Box rect={{ x: Math.round(cx - length / 2), y: Math.round(cy - thickness / 2), w: length, h: thickness }} style={{ transform: "rotate(-90deg)" }}>
    <Line color={C.WHITE} size={fitted.size} text={fitted.lines[0] ?? name} />
  </Box>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Texto, foto
// ---------------------------------------------------------------------------------------------------------------------

/** Anton es mucho más angosta que la sans: el mismo tamaño de diseño se agranda para que el titular siga ocupando su lugar y se lea a distancia. */
const DISPLAY_SIZE_BOOST = 1.5;

/** Titular manual de la pieza («OFERTA»), en rojo, de un solo renglón y en la fuente de títulos (Anton). */
export function Headline({ rect, text, maxSize, color, align = "center" }: { rect: Rect; text: string; maxSize: number; color: string; align?: TextAlign }) {
  const fitted = fitText({ text, maxWidth: rect.w, maxLines: 1, maxSize: Math.min(Math.round(maxSize * DISPLAY_SIZE_BOOST), rect.h), minSize: 44, weight: 400 });
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: JUSTIFY[align] }}><TextBlock align={align} color={color} fitted={fitted} lineHeight={1} weight={400} /></Box>;
}

/** Nombre del producto (hasta `maxLines` renglones) y, para productos por peso, «X KG» en verde debajo (sólo `showUnitLabel`). */
export function NameBlock({ rect, item, maxSize, minSize, maxLines, showUnitLabel = true, align = "center" }: {
  rect: Rect; item: OfferItem; maxSize: number; minSize: number; maxLines: number; showUnitLabel?: boolean; align?: TextAlign;
}) {
  const label = showUnitLabel ? item.unitLabel : null;
  // El renglón «X KG» ocupa lugar: se descuenta del alto disponible para el nombre.
  const reserve = label ? Math.round(maxSize * 0.62) : 0;
  const fitted = fitText({ text: item.productName, maxWidth: rect.w, maxLines, maxSize, minSize, maxHeight: rect.h - reserve });
  const labelSize = Math.round(fitted.size * 0.72);
  return <Box rect={rect} style={{ flexDirection: "column", alignItems: JUSTIFY[align], justifyContent: "center" }}>
    <TextBlock align={align} color={C.BLACK} fitted={fitted} />
    {label ? <div style={{ display: "flex", width: "100%", marginTop: Math.round(fitted.size * 0.1) }}><Line align={JUSTIFY[align]} color={C.BRAND_GREEN} size={labelSize} text={label} /></div> : null}
  </Box>;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Reemplazo de una foto que no existe: panel suave con una etiqueta de precio. Sobrio, sin texto de error. */
function PhotoFallback({ rect }: { rect: Rect }) {
  const icon = Math.round(Math.min(rect.w, rect.h) * 0.42);
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: "center", background: C.SURFACE_SOFT, borderRadius: Math.round(Math.min(rect.w, rect.h) * 0.08) }}>
    <svg height={icon} viewBox="0 0 100 100" width={icon} xmlns={SVG_NS}>
      <path d="M8 52 L52 8 H92 V48 L48 92 Z" fill={C.BRAND_GREEN} />
      <circle cx="72" cy="28" fill={C.WHITE} r="8" />
    </svg>
  </Box>;
}

/** Foto comercial: se ve entera (sin recortes), centrada y grande. PNG transparente o JPG con fondo blanco. */
export function PhotoBlock({ rect, imageUrl }: { rect: Rect; imageUrl: string | null }) {
  if (!imageUrl) return <PhotoFallback rect={rect} />;
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: "center" }}>
    <img alt="" height={rect.h} src={imageUrl} style={{ width: rect.w, height: rect.h, objectFit: "contain" }} width={rect.w} />
  </Box>;
}

/** Mancha orgánica que se estira a `rect` (un `<path>` de la forma 0..100 de `organicBlobPath`). Sólo decoración, sin texto. */
export function Blob({ rect, seed, color, wobble = 0.16, testId }: { rect: Rect; seed: number; color: string; wobble?: number; testId?: string }) {
  return <Box rect={rect}>
    <svg data-testid={testId} height={rect.h} preserveAspectRatio="none" viewBox="0 0 100 100" width={rect.w} xmlns={SVG_NS}>
      <path d={organicBlobPath(seed, { wobble })} fill={color} />
    </svg>
  </Box>;
}

/**
 * La foto del producto como protagonista: con fondo TRANSPARENTE se aprovecha con una mancha amarilla suave detrás (un recorte flota
 * sobre blanco); con fondo propio (JPG o PNG opaco) se deja tal cual para no degradar el diseño con un recuadro blanco sobre color.
 */
export function PhotoStage({ photo, blob, seed, imageUrl, transparent }: { photo: Rect; blob: Rect; seed: number; imageUrl: string | null; transparent: boolean }) {
  return <>
    {imageUrl && transparent ? <Blob color={C.BLOB_YELLOW} rect={blob} seed={seed} testId="artwork-blob" /> : null}
    <PhotoBlock imageUrl={imageUrl} rect={photo} />
  </>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Mecánica promocional y sello de ahorro
// ---------------------------------------------------------------------------------------------------------------------

/**
 * La mecánica de la oferta dicha en grande («LLEVANDO 3», «PACK 10 UNIDADES», «DESDE 2 KG»): una etiqueta verde con letras blancas,
 * ajustada al texto y apenas girada, anclada a `align` dentro de su zona. No se dibuja si la oferta no tiene promoción.
 */
export function MechanicTag({ rect, text, maxSize, align = "center", rotate = 0 }: { rect: Rect; text: string | null; maxSize: number; align?: TextAlign; rotate?: number }) {
  if (!text) return null;
  const padX = Math.round(maxSize * 0.5);
  const fitted = fitText({ text, maxWidth: rect.w - padX * 2, maxLines: 1, maxSize, minSize: 28 });
  const width = Math.min(rect.w, Math.ceil(textWidth(fitted.lines[0] ?? text, fitted.size) + padX * 2));
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: JUSTIFY[align] }}>
    <div data-testid="artwork-mechanic" style={{
      display: "flex", alignItems: "center", justifyContent: "center", width, height: rect.h, background: C.BRAND_GREEN, borderRadius: Math.round(rect.h * 0.3),
      transform: rotate ? `rotate(${String(rotate)}deg)` : "none"
    }}><Line color={C.WHITE} size={fitted.size} text={fitted.lines[0] ?? text} /></div>
  </Box>;
}

/** Sello rojo de ahorro («25% OFF»): estrella de puntas suaves con el porcentaje grande. Sólo si la regla vigente es un porcentaje real. */
export function SavingsSticker({ rect, text }: { rect: Rect; text: string | null }) {
  if (!text) return null;
  const [percent = text, ...rest] = text.split(" ");
  const tail = rest.join(" ") || "OFF";
  const percentSize = fitText({ text: percent, maxWidth: Math.round(rect.w * 0.66), maxLines: 1, maxSize: Math.round(rect.w * 0.34), minSize: 24 });
  const tailSize = Math.round(percentSize.size * 0.5);
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: "center", transform: "rotate(-8deg)" }}>
    <svg data-testid="artwork-sticker" height={rect.h} style={{ position: "absolute", left: 0, top: 0 }} viewBox="0 0 100 100" width={rect.w} xmlns={SVG_NS}>
      <polygon fill={C.ACCENT_RED} points={burstPoints(18, 0.88)} />
    </svg>
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%" }}>
      <Line color={C.WHITE} size={percentSize.size} text={percentSize.lines[0] ?? percent} />
      <Line color={C.WHITE} size={tailSize} text={tail} />
    </div>
  </Box>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pastilla de precio (PRICE_BADGE_YELLOW)
// ---------------------------------------------------------------------------------------------------------------------

const DOLLAR_RATIO = 0.5;
const CENTS_RATIO = 0.5;
const SUFFIX_RATIO = 0.3;
const CAP_TOP_RATIO = 0.1365;

interface PriceRowMetrics { size: number; dollar: number; cents: number; suffix: number; width: number }

/** Medidas de «$ 17.900,50 /KG» a `size` px de dígito: $ y centavos chicos arriba, sufijo sobre la línea base. */
function priceRowMetrics(price: OfferPrice, suffix: string | null, size: number): PriceRowMetrics {
  const suffixText = suffix ? suffix.replace(/\s+/g, "") : null;
  const dollar = size * DOLLAR_RATIO;
  const cents = size * CENTS_RATIO;
  const suffixSize = size * SUFFIX_RATIO;
  const width = textWidth("$", dollar) + size * 0.04 + textWidth(price.whole, size)
    + (price.cents ? size * 0.04 + textWidth(price.cents, cents) : 0)
    + (suffixText ? size * 0.06 + textWidth(suffixText, suffixSize) : 0);
  return { size, dollar, cents, suffix: suffixSize, width };
}

/** «$ 17.900,50 /KG» en una sola fila (el precio, en negro extra bold, es el elemento dominante). */
function PriceRow({ price, suffix, metrics }: { price: OfferPrice; suffix: string | null; metrics: PriceRowMetrics }) {
  const { size, dollar, cents, suffix: suffixSize } = metrics;
  const raised = Math.round(CAP_TOP_RATIO * (size - dollar));
  const lowered = Math.round(CAP_TOP_RATIO * (size - suffixSize));
  const height = Math.round(size);
  return <div data-testid="artwork-price" style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", justifyContent: "center", height, color: C.BLACK, whiteSpace: "nowrap" }}>
    <div style={{ display: "flex", fontSize: dollar, lineHeight: `${String(Math.round(dollar))}px`, fontWeight: 900, marginTop: raised, marginRight: Math.round(size * 0.04) }}>$</div>
    <div style={{ display: "flex", fontSize: size, lineHeight: `${String(height)}px`, fontWeight: 900 }}>{price.whole}</div>
    {price.cents ? <div style={{ display: "flex", fontSize: cents, lineHeight: `${String(Math.round(cents))}px`, fontWeight: 900, marginTop: raised, marginLeft: Math.round(size * 0.04) }}>{price.cents}</div> : null}
    {suffix ? <div style={{ display: "flex", alignSelf: "flex-end", fontSize: suffixSize, lineHeight: `${String(Math.round(suffixSize))}px`, fontWeight: 900, marginLeft: Math.round(size * 0.06), marginBottom: lowered }}>{suffix.replace(/\s+/g, "")}</div> : null}
  </div>;
}

export interface BadgeGeometry { size: number; width: number; height: number; padX: number; padY: number; metrics: PriceRowMetrics; conditionSize: number; conditionHeight: number; conditionGap: number }

export type BadgeShape = "pill" | "splash";

export interface BadgeOptions {
  /** `pill`: rectángulo redondeado (collage). `splash`: mancha orgánica amarilla (protagonista). */
  shape?: BadgeShape;
  /** La condición («LLEVANDO 3 UNIDADES») va dentro de la pastilla. Con etiqueta de mecánica aparte se apaga. */
  showCondition?: boolean;
}

/**
 * Pastilla amarilla que se ajusta al contenido: el precio más grande que entra en `rect` (tope `maxPriceSize`), con la condición
 * («LLEVANDO 3 UNIDADES») debajo cuando hay promoción. Misma forma para protagonista y collage.
 */
export function fitBadge(item: OfferItem, rect: { w: number; h: number }, maxPriceSize: number, conditionMaxSize: number, options: BadgeOptions = {}): BadgeGeometry {
  const price = heroPrice(item);
  const condition = options.showCondition === false ? null : item.promotionCondition;
  const splash = options.shape === "splash";
  const build = (size: number): BadgeGeometry => {
    const metrics = priceRowMetrics(price, item.priceSuffix, size);
    // La mancha es más angosta en sus bordes que un rectángulo: necesita más aire para que el precio no toque el contorno.
    const padX = Math.round(size * (splash ? 0.36 : 0.3));
    const padY = Math.round(size * (splash ? 0.17 : PRICE_BADGE.paddingRatio));
    const conditionSize = condition ? Math.max(16, Math.min(conditionMaxSize, Math.round(size * 0.34))) : 0;
    const conditionHeight = condition ? Math.round(conditionSize * 1.1) : 0;
    const conditionGap = condition ? Math.round(conditionSize * 0.25) : 0;
    const content = Math.max(metrics.width, condition ? textWidth(condition, conditionSize) : 0);
    return {
      size, metrics, padX, padY, conditionSize, conditionHeight, conditionGap,
      width: Math.ceil(content + padX * 2), height: size + padY * 2 + conditionHeight + conditionGap
    };
  };
  let geometry = build(Math.floor(maxPriceSize));
  while (geometry.size > 32 && (geometry.width > rect.w || geometry.height > rect.h)) geometry = build(geometry.size - 2);
  return geometry;
}

const JUSTIFY_ITEMS: Record<"start" | "center" | "end", "flex-start" | "center" | "flex-end"> = { start: "flex-start", center: "center", end: "flex-end" };

export function PriceBadge({ rect, item, maxPriceSize, conditionMaxSize, align = "center", shape = "pill", showCondition = true, seed = 7 }: {
  rect: Rect; item: OfferItem; maxPriceSize: number; conditionMaxSize: number; align?: "start" | "center" | "end"; shape?: BadgeShape; showCondition?: boolean; seed?: number;
}) {
  const geometry = fitBadge(item, rect, maxPriceSize, conditionMaxSize, { shape, showCondition });
  const condition = showCondition ? item.promotionCondition : null;
  const width = Math.min(geometry.width, rect.w);
  // Sin <>: Satori trata un fragmento como una caja en FILA y deja el precio y la condición lado a lado. Cada cuerpo es una caja en columna.
  const content = (absolute: boolean) => <div style={{
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width, height: geometry.height,
    ...(absolute ? { position: "absolute" as const, left: 0, top: 0 } : {})
  }}>
    <PriceRow metrics={geometry.metrics} price={heroPrice(item)} suffix={item.priceSuffix} />
    {condition ? <div style={{ display: "flex", width: "100%", marginTop: geometry.conditionGap }}><Line color={C.BLACK} size={geometry.conditionSize} text={condition} /></div> : null}
  </div>;
  if (shape === "splash") {
    return <Box rect={rect} style={{ alignItems: "center", justifyContent: JUSTIFY_ITEMS[align] }}>
      <div data-testid="artwork-price-splash" style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width, height: geometry.height, transform: "rotate(-2deg)" }}>
        <svg height={geometry.height} preserveAspectRatio="none" style={{ position: "absolute", left: 0, top: 0 }} viewBox="0 0 100 100" width={width} xmlns={SVG_NS}>
          <path d={organicPillPath(seed)} fill={PRICE_BADGE.color} />
        </svg>
        {content(true)}
      </div>
    </Box>;
  }
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: JUSTIFY_ITEMS[align] }}>
    <div style={{ display: "flex", width, height: geometry.height, background: PRICE_BADGE.color, borderRadius: Math.round(geometry.height * PRICE_BADGE.radiusRatio) }}>
      {content(false)}
    </div>
  </Box>;
}

/** «PRECIO NORMAL $ 2.050» (sólo con promoción real; sin promoción no se duplica el precio ni se inventa un descuento). */
export function NormalPriceLine({ rect, item, size, align = "center" }: { rect: Rect; item: OfferItem; size: number; align?: TextAlign }) {
  if (!hasPromotion(item)) return null;
  // «/KG» acompaña al precio normal de un producto por peso; «C/U» (precio por unidad de una oferta) no: el normal ya es el de una unidad.
  const suffix = item.priceSuffix?.startsWith("/") ? ` ${item.priceSuffix.replace(/\s+/g, "")}` : "";
  const text = `PRECIO NORMAL ${formatPriceText(item.regularPrice)}${suffix}`;
  const fitted = fitText({ text, maxWidth: rect.w, maxLines: 1, maxSize: size, minSize: 20, weight: 700 });
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: JUSTIFY[align] }}><Line align={JUSTIFY[align]} color={C.INK_MUTED} size={fitted.size} text={text} weight={700} /></Box>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Contacto de la sucursal (abajo a la izquierda)
// ---------------------------------------------------------------------------------------------------------------------

const PHONE_ICON = "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z";
const PIN_ICON = "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z";

interface ContactRow { icon: "phone" | "pin" | null; text: string; weight: 700 | 900 }

function contactRows(contact: ArtworkContact): ContactRow[] {
  const rows: ContactRow[] = [];
  if (contact.phone) rows.push({ icon: "phone", text: contact.phone, weight: 900 });
  if (contact.address) rows.push({ icon: "pin", text: contact.address, weight: 700 });
  // La ciudad va debajo de la dirección (alineada con ella); si no hay dirección, lleva el ícono de ubicación.
  if (contact.city) rows.push({ icon: contact.address ? null : "pin", text: contact.city, weight: 700 });
  return rows;
}

function ContactIcon({ icon, size }: { icon: "phone" | "pin" | null; size: number }) {
  if (!icon) return <div style={{ display: "flex", width: size, height: size }} />;
  return <svg height={size} viewBox="0 0 24 24" width={size} xmlns={SVG_NS}><path d={icon === "phone" ? PHONE_ICON : PIN_ICON} fill={C.BRAND_GREEN} /></svg>;
}

/**
 * Bloque de contacto de la SUCURSAL elegida (teléfono, dirección, ciudad). Abajo a la izquierda, se ajusta a lo que haya cargado y
 * no se dibuja si la sucursal no tiene ningún dato (nunca se inventa ni se toma de otra sucursal).
 */
export function ContactBlock({ rect, contact }: { rect: Rect; contact: ArtworkContact | null }) {
  if (!contact) return null;
  const rows = contactRows(contact);
  if (!rows.length) return null;
  const pad = 16;
  const available = rect.h - pad * 2;
  const textSize = Math.max(18, Math.min(34, Math.floor(available / rows.length / 1.18)));
  const icon = Math.round(textSize * 0.9);
  const gap = Math.round(textSize * 0.4);
  const rowH = Math.round(textSize * 1.18);
  const maxText = rect.w - pad * 2 - icon - gap;
  const fitted = rows.map((row) => fitText({ text: row.text, maxWidth: maxText, maxLines: 1, maxSize: row.weight === 900 ? Math.round(textSize * 1.08) : textSize, minSize: 16, weight: row.weight }));
  const widest = Math.max(...fitted.map((fit, index) => textWidth(fit.lines[0] ?? "", fit.size, rows[index]?.weight ?? 700)));
  const width = Math.min(rect.w, Math.ceil(widest + pad * 2 + icon + gap));
  const height = rows.length * rowH + pad * 2;
  return <Box rect={{ x: rect.x, y: rect.y + rect.h - height, w: width, h: height }} style={{
    flexDirection: "column", justifyContent: "center", background: C.SURFACE_SOFT, borderRadius: 22, paddingLeft: pad, paddingRight: pad
  }}>
    {rows.map((row, index) => <div data-testid="artwork-contact-row" key={`${row.text}-${String(index)}`} style={{ display: "flex", flexDirection: "row", alignItems: "center", height: rowH, whiteSpace: "nowrap" }}>
      <ContactIcon icon={row.icon} size={icon} />
      <div style={{
        display: "flex", marginLeft: gap, fontSize: fitted[index]?.size ?? textSize, lineHeight: `${String(rowH)}px`, fontWeight: row.weight, color: C.BLACK
      }}>{fitted[index]?.lines[0] ?? row.text}</div>
    </div>)}
  </Box>;
}
