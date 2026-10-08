import type { CSSProperties, ReactNode } from "react";

import { formatPriceText, hasPromotion, heroPrice, type OfferArtworkModel } from "../../lib/artwork";
import { ARTWORK_FONT_FAMILY } from "../../lib/artwork-font-data";
import { fitText, textWidth, type FittedText } from "../../lib/artwork-text";
import { ARTWORK_COLORS as C, ARTWORK_FORMATS, STORY_SAFE, type ArtworkFormat } from "../../lib/artwork-tokens";
import type { OfferPrice } from "../../lib/signage";

/**
 * Renderers de la pieza «Producto protagonista» (D-074): TvHeroOffer (1920 × 1080), FeedHeroOffer (1080 × 1350) y StoryHeroOffer
 * (1080 × 1920). Los tres leen el MISMO `OfferArtworkModel` y los MISMOS tokens (`lib/artwork-tokens.ts`); sólo cambia la
 * composición.
 *
 * Están escritos para el subconjunto de CSS que entienden a la vez el navegador (preview) y Satori (PNG): cajas absolutas con
 * medidas en px, `display: flex` en todo contenedor, un renglón por elemento (los saltos los decide `lib/artwork-text.ts` con los
 * anchos reales de la fuente) y nada de sombras, gradientes ni efectos. Así el preview y el PNG salen de la misma especificación.
 */

const FONT_STACK = `${ARTWORK_FONT_FAMILY}, Arial, Helvetica, sans-serif`;

interface Rect { x: number; y: number; w: number; h: number }

function Box({ rect, children, style }: { rect: Rect; children?: ReactNode; style?: CSSProperties }) {
  return <div style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h, display: "flex", ...style }}>{children}</div>;
}

/** Línea de texto de un solo renglón, sin ajuste automático (el tamaño ya viene calculado). */
function Line({ text, size, color, weight = 900, lineHeight = 1, align = "center" }: {
  text: string; size: number; color: string; weight?: 700 | 900; lineHeight?: number; align?: "center" | "flex-start";
}) {
  const height = Math.round(size * lineHeight);
  return <div style={{
    display: "flex", justifyContent: align, alignItems: "center", width: "100%", height, fontSize: size, lineHeight: `${String(height)}px`,
    fontWeight: weight, color, whiteSpace: "nowrap"
  }}>{text}</div>;
}

function TextBlock({ fitted, color, lineHeight = 1.02, weight = 900 }: { fitted: FittedText; color: string; lineHeight?: number; weight?: 700 | 900 }) {
  return <div style={{ display: "flex", flexDirection: "column", width: "100%", alignItems: "center", justifyContent: "center" }}>
    {fitted.lines.map((line, index) => <Line color={color} key={`${String(index)}-${line}`} lineHeight={lineHeight} size={fitted.size} text={line} weight={weight} />)}
  </div>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Piezas compartidas
// ---------------------------------------------------------------------------------------------------------------------

/** Franja lateral verde de marca, de punta a punta. */
function GreenBand({ width, height }: { width: number; height: number }) {
  return <Box rect={{ x: 0, y: 0, w: width, h: height }} style={{ background: C.BRAND_GREEN }} />;
}

/** Marca: texto «SUPER OFERTAS» sobre una bandera verde que sale de la franja lateral, con un subrayado amarillo. */
function BrandFlag({ name, bandWidth, textLeft, y, height, size }: { name: string; bandWidth: number; textLeft: number; y: number; height: number; size: number }) {
  const textW = textWidth(name, size);
  const width = Math.round(textLeft + textW + size * 0.7);
  const underline = Math.max(6, Math.round(size * 0.12));
  return <>
    <Box rect={{ x: bandWidth - 1, y, w: width - bandWidth + 1, h: height }} style={{ background: C.BRAND_GREEN, borderTopRightRadius: height / 2, borderBottomRightRadius: height / 2 }} />
    <Box rect={{ x: textLeft, y, w: Math.ceil(textW), h: height - underline }} style={{ alignItems: "center", color: C.WHITE, fontSize: size, fontWeight: 900, whiteSpace: "nowrap" }}>{name}</Box>
    <Box rect={{ x: textLeft, y: y + height - underline - Math.round(height * 0.12), w: Math.ceil(textW), h: underline }} style={{ background: C.PRICE_YELLOW, borderRadius: underline / 2 }} />
  </>;
}

function Headline({ rect, text, maxSize }: { rect: Rect; text: string; maxSize: number }) {
  const fitted = fitText({ text, maxWidth: rect.w, maxLines: 1, maxSize, minSize: 56 });
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: "center" }}><TextBlock color={C.ACCENT_RED} fitted={fitted} lineHeight={1} /></Box>;
}

/** Nombre del producto (hasta 3 renglones) y, para productos por peso, «X KG» en verde debajo. */
function NameBlock({ rect, model, maxSize, minSize, maxLines }: { rect: Rect; model: OfferArtworkModel; maxSize: number; minSize: number; maxLines: number }) {
  // El renglón «X KG» (productos por peso) ocupa lugar: se descuenta del alto disponible para el nombre.
  const reserve = model.unitLabel ? Math.round(maxSize * 0.62) : 0;
  const fitted = fitText({ text: model.productName, maxWidth: rect.w, maxLines, maxSize, minSize, maxHeight: rect.h - reserve });
  const labelSize = Math.round(fitted.size * 0.72);
  return <Box rect={rect} style={{ flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
    <TextBlock color={C.BLACK} fitted={fitted} />
    {model.unitLabel ? <div style={{ display: "flex", width: "100%", marginTop: Math.round(fitted.size * 0.1) }}><Line color={C.BRAND_GREEN} size={labelSize} text={model.unitLabel} /></div> : null}
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

/** Foto comercial: se ve entera (sin recortes), centrada y grande. PNG transparente o JPG/WebP con fondo blanco. */
function PhotoBlock({ rect, imageUrl }: { rect: Rect; imageUrl: string | null }) {
  if (!imageUrl) return <PhotoFallback rect={rect} />;
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: "center" }}>
    {/* Satori (PNG) y el preview comparten esta etiqueta <img>: next/image no aplica. */}
    <img alt="" height={rect.h} src={imageUrl} style={{ width: rect.w, height: rect.h, objectFit: "contain" }} width={rect.w} />
  </Box>;
}

interface PriceRowMetrics { size: number; dollar: number; cents: number; suffix: number; width: number }

const DOLLAR_RATIO = 0.5;
const CENTS_RATIO = 0.5;
const SUFFIX_RATIO = 0.3;
const CAP_TOP_RATIO = 0.1365;

/** Tamaño del precio: el más grande que entra en `maxWidth` (tope `maxSize`). */
function priceMetrics(price: OfferPrice, suffix: string | null, maxWidth: number, maxSize: number): PriceRowMetrics {
  const suffixText = suffix ? suffix.replace(/\s+/g, "") : null;
  let size = maxSize;
  for (; size > 40; size -= 2) {
    const dollar = size * DOLLAR_RATIO;
    const cents = size * CENTS_RATIO;
    const suffixSize = size * SUFFIX_RATIO;
    const width = textWidth("$", dollar) + size * 0.04 + textWidth(price.whole, size)
      + (price.cents ? size * 0.04 + textWidth(price.cents, cents) : 0)
      + (suffixText ? size * 0.06 + textWidth(suffixText, suffixSize) : 0);
    if (width <= maxWidth) return { size, dollar, cents, suffix: suffixSize, width };
  }
  return { size: 40, dollar: 20, cents: 20, suffix: 12, width: maxWidth };
}

/** «$ 17.900,50 / KG» en una sola fila: $ y centavos chicos arriba, dígitos grandes, sufijo sobre la línea base. */
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

/**
 * Pastilla amarilla con el precio vigente (el elemento de mayor peso visual). Con promoción, bajo el precio va la condición
 * («LLEVANDO 3 UNIDADES»); el precio normal va aparte (`NormalPriceLine`).
 */
function PricePill({ rect, model, maxPriceSize, conditionSize }: { rect: Rect; model: OfferArtworkModel; maxPriceSize: number; conditionSize: number }) {
  const price = heroPrice(model);
  const condition = model.promotionCondition;
  const padding = Math.round(rect.h * 0.1);
  const conditionLine = condition ? Math.round(conditionSize * 1.1) : 0;
  const conditionGap = condition ? Math.round(conditionSize * 0.25) : 0;
  const innerW = rect.w - padding * 2;
  const innerH = rect.h - padding * 2 - conditionLine - conditionGap;
  const metrics = priceMetrics(price, model.priceSuffix, innerW, Math.min(maxPriceSize, Math.floor(innerH)));
  const conditionFit = condition ? fitText({ text: condition, maxWidth: innerW, maxLines: 1, maxSize: conditionSize, minSize: 24 }) : null;
  return <Box rect={rect} style={{ background: C.PRICE_YELLOW, borderRadius: Math.round(rect.h * 0.22), flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
    <PriceRow metrics={metrics} price={price} suffix={model.priceSuffix} />
    {conditionFit ? <div style={{ display: "flex", width: "100%", marginTop: conditionGap }}><Line color={C.BLACK} size={conditionFit.size} text={condition ?? ""} /></div> : null}
  </Box>;
}

/** «PRECIO NORMAL $ 2.050» (sólo con promoción real; sin promoción no se duplica el precio ni se inventa un descuento). */
function NormalPriceLine({ rect, model, size }: { rect: Rect; model: OfferArtworkModel; size: number }) {
  if (!hasPromotion(model)) return null;
  const suffix = model.priceSuffix ? ` ${model.priceSuffix.replace(/\s+/g, "")}` : "";
  const text = `PRECIO NORMAL ${formatPriceText(model.regularPrice)}${suffix}`;
  const fitted = fitText({ text, maxWidth: rect.w, maxLines: 1, maxSize: size, minSize: 20, weight: 700 });
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: "center" }}><Line color={C.INK_MUTED} size={fitted.size} text={text} weight={700} /></Box>;
}

/** Dirección de la sucursal (sólo si está cargada), discreta. */
function AddressLine({ rect, model, size }: { rect: Rect; model: OfferArtworkModel; size: number }) {
  const address = model.branch?.address;
  if (!address) return null;
  const fitted = fitText({ text: address.toLocaleUpperCase("es-AR"), maxWidth: rect.w, maxLines: 1, maxSize: size, minSize: 18, weight: 700 });
  return <Box rect={rect} style={{ alignItems: "center", justifyContent: "center" }}><Line color={C.INK_MUTED} size={fitted.size} text={fitted.lines[0] ?? ""} weight={700} /></Box>;
}

function Canvas({ format, children, testId }: { format: ArtworkFormat; children: ReactNode; testId: string }) {
  const spec = ARTWORK_FORMATS[format];
  return <div data-artwork-format={format} data-testid={testId} style={{
    position: "relative", display: "flex", width: spec.width, height: spec.height, background: C.WHITE, color: C.BLACK, fontFamily: FONT_STACK, fontKerning: "none", overflow: "hidden"
  }}>{children}</div>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Feed 1080 × 1350 (4:5)
// ---------------------------------------------------------------------------------------------------------------------

const COLUMN_BAND = 112;
const COLUMN_X = 156;
const COLUMN_W = 880;

export function FeedHeroOffer({ model }: { model: OfferArtworkModel }) {
  const { height } = ARTWORK_FORMATS.feed;
  const promo = hasPromotion(model);
  const pill: Rect = promo ? { x: COLUMN_X, y: 1000, w: COLUMN_W, h: 232 } : { x: COLUMN_X, y: 1020, w: COLUMN_W, h: 204 };
  return <Canvas format="feed" testId="artwork-feed">
    <GreenBand height={height} width={COLUMN_BAND} />
    <BrandFlag bandWidth={COLUMN_BAND} height={92} name={model.businessName} size={52} textLeft={COLUMN_X} y={48} />
    <Headline maxSize={170} rect={{ x: COLUMN_X, y: 160, w: COLUMN_W, h: 160 }} text={model.headline} />
    <NameBlock maxLines={3} maxSize={84} minSize={40} model={model} rect={{ x: COLUMN_X, y: 324, w: COLUMN_W, h: 184 }} />
    <PhotoBlock imageUrl={model.imageUrl} rect={{ x: COLUMN_X, y: 514, w: COLUMN_W, h: promo ? 470 : 490 }} />
    <PricePill conditionSize={46} maxPriceSize={190} model={model} rect={pill} />
    <NormalPriceLine model={model} rect={{ x: COLUMN_X, y: pill.y + pill.h + 8, w: COLUMN_W, h: 46 }} size={38} />
    <AddressLine model={model} rect={{ x: COLUMN_X, y: height - 52, w: COLUMN_W, h: 32 }} size={26} />
  </Canvas>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Story / WhatsApp Estado 1080 × 1920 (9:16)
// ---------------------------------------------------------------------------------------------------------------------

export function StoryHeroOffer({ model }: { model: OfferArtworkModel }) {
  const { height } = ARTWORK_FORMATS.story;
  const promo = hasPromotion(model);
  const top = STORY_SAFE.top;
  const bottom = height - STORY_SAFE.bottom;
  const pill: Rect = promo ? { x: COLUMN_X, y: bottom - 372, w: COLUMN_W, h: 250 } : { x: COLUMN_X, y: bottom - 292, w: COLUMN_W, h: 220 };
  const photoTop = top + 100 + 16 + 170 + 4 + 200 + 8;
  return <Canvas format="story" testId="artwork-story">
    <GreenBand height={height} width={COLUMN_BAND} />
    <BrandFlag bandWidth={COLUMN_BAND} height={100} name={model.businessName} size={56} textLeft={COLUMN_X} y={top} />
    <Headline maxSize={170} rect={{ x: COLUMN_X, y: top + 116, w: COLUMN_W, h: 170 }} text={model.headline} />
    <NameBlock maxLines={3} maxSize={92} minSize={42} model={model} rect={{ x: COLUMN_X, y: top + 290, w: COLUMN_W, h: 200 }} />
    <PhotoBlock imageUrl={model.imageUrl} rect={{ x: COLUMN_X, y: photoTop, w: COLUMN_W, h: pill.y - 16 - photoTop }} />
    <PricePill conditionSize={50} maxPriceSize={210} model={model} rect={pill} />
    <NormalPriceLine model={model} rect={{ x: COLUMN_X, y: pill.y + pill.h + 10, w: COLUMN_W, h: 48 }} size={42} />
    <AddressLine model={model} rect={{ x: COLUMN_X, y: promo ? pill.y + pill.h + 10 + 48 + 6 : pill.y + pill.h + 14, w: COLUMN_W, h: 34 }} size={28} />
  </Canvas>;
}

// ---------------------------------------------------------------------------------------------------------------------
// TV 1920 × 1080 (16:9)
// ---------------------------------------------------------------------------------------------------------------------

const TV_BAND = 150;

export function TvHeroOffer({ model }: { model: OfferArtworkModel }) {
  const { height } = ARTWORK_FORMATS.tv;
  const promo = hasPromotion(model);
  const right = { x: 1090, w: 770 };
  const pill: Rect = promo ? { x: right.x, y: 570, w: right.w, h: 350 } : { x: right.x, y: 590, w: right.w, h: 310 };
  return <Canvas format="tv" testId="artwork-tv">
    <GreenBand height={height} width={TV_BAND} />
    <BrandFlag bandWidth={TV_BAND} height={116} name={model.businessName} size={68} textLeft={190} y={52} />
    <PhotoBlock imageUrl={model.imageUrl} rect={{ x: 180, y: 196, w: 890, h: 850 }} />
    <Headline maxSize={140} rect={{ x: right.x, y: 60, w: right.w, h: 150 }} text={model.headline} />
    <NameBlock maxLines={4} maxSize={96} minSize={44} model={model} rect={{ x: right.x, y: 230, w: right.w, h: 310 }} />
    <PricePill conditionSize={48} maxPriceSize={230} model={model} rect={pill} />
    <NormalPriceLine model={model} rect={{ x: right.x, y: pill.y + pill.h + 14, w: right.w, h: 50 }} size={40} />
  </Canvas>;
}

/** El renderer que corresponde a un formato (misma pieza, tres composiciones). */
export function HeroOffer({ format, model }: { format: ArtworkFormat; model: OfferArtworkModel }) {
  if (format === "tv") return <TvHeroOffer model={model} />;
  if (format === "story") return <StoryHeroOffer model={model} />;
  return <FeedHeroOffer model={model} />;
}
