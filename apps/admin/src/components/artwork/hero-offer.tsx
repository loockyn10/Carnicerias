import { hasPromotion, type OfferArtworkModel, type OfferItem } from "../../lib/artwork";
import { contactRect, contentColumn, verticalBounds, type Rect } from "../../lib/artwork-layout";
import type { ArtworkFormat } from "../../lib/artwork-tokens";
import { BrandBand, Canvas, ContactBlock, Headline, NameBlock, NormalPriceLine, PhotoBlock, PriceBadge } from "./artwork-parts";
import { TvOfferSlide } from "./tv-offer";

/**
 * Renderers de la plantilla «Producto protagonista» (D-074, identidad D-075): FeedHeroOffer (1080 × 1350) y StoryHeroOffer
 * (1080 × 1920); la versión TV (1920 × 1080) es `TvOfferSlide` (`tv-offer.tsx`, cuatro disposiciones). Todos leen el MISMO `OfferArtworkModel` (un único ítem) y comparten con el
 * collage la franja verde con el logo, el titular, la pastilla de precio y el contacto (`artwork-parts.tsx`); sólo cambia la
 * composición. En TV el contacto no se muestra (prioridad: producto, imagen, precio, condición y marca).
 */

function heroItem(model: OfferArtworkModel): OfferItem {
  const item = model.items[0];
  if (!item) throw new Error("La pieza «Producto protagonista» necesita un producto");
  return item;
}

// ---------------------------------------------------------------------------------------------------------------------
// Feed 1080 × 1350 (4:5) y Story 1080 × 1920 (9:16): misma columna, el contenido se ancla desde abajo (contacto → precio → foto).
// ---------------------------------------------------------------------------------------------------------------------

interface ColumnSizes { headline: number; name: number; nameLines: number; price: number; condition: number; normal: number; pillPromo: number; pillPlain: number }

const FEED_SIZES: ColumnSizes = { headline: 150, name: 82, nameLines: 3, price: 190, condition: 46, normal: 38, pillPromo: 232, pillPlain: 204 };
const STORY_SIZES: ColumnSizes = { headline: 160, name: 90, nameLines: 3, price: 210, condition: 50, normal: 42, pillPromo: 250, pillPlain: 224 };

function ColumnHeroOffer({ model, format, sizes }: { model: OfferArtworkModel; format: "feed" | "story"; sizes: ColumnSizes }) {
  const item = heroItem(model);
  const promo = hasPromotion(item);
  const column = contentColumn(format);
  const { top } = verticalBounds(format);
  const contact = contactRect(format);
  const normalH = 44;
  const pillH = promo ? sizes.pillPromo : sizes.pillPlain;
  const normalY = contact.y - 16 - normalH;
  const pillY = promo ? normalY - 6 - pillH : contact.y - 14 - pillH;
  const headline: Rect = { x: column.x, y: top, w: column.w, h: sizes.headline };
  const name: Rect = { x: column.x, y: headline.y + headline.h + 4, w: column.w, h: Math.round(sizes.name * 2.1) };
  const photoY = name.y + name.h + 6;
  const pill: Rect = { x: column.x, y: pillY, w: column.w, h: pillH };
  return <Canvas format={format} testId={`artwork-${format}`}>
    <BrandBand branding={model.branding} format={format} />
    <PhotoBlock imageUrl={item.imageUrl} rect={{ x: column.x, y: photoY, w: column.w, h: pill.y - 10 - photoY }} />
    <Headline color={model.branding.colors.red} maxSize={sizes.headline} rect={headline} text={model.headline} />
    <NameBlock item={item} maxLines={sizes.nameLines} maxSize={sizes.name} minSize={40} rect={name} />
    <PriceBadge conditionMaxSize={sizes.condition} item={item} maxPriceSize={sizes.price} rect={pill} />
    <NormalPriceLine item={item} rect={{ x: column.x, y: normalY, w: column.w, h: normalH }} size={sizes.normal} />
    <ContactBlock contact={model.branding.contact} rect={contact} />
  </Canvas>;
}

export function FeedHeroOffer({ model }: { model: OfferArtworkModel }) {
  return <ColumnHeroOffer format="feed" model={model} sizes={FEED_SIZES} />;
}

export function StoryHeroOffer({ model }: { model: OfferArtworkModel }) {
  return <ColumnHeroOffer format="story" model={model} sizes={STORY_SIZES} />;
}

/** El renderer del protagonista que corresponde a un formato (misma pieza, tres composiciones). */
export function HeroOffer({ format, model, slideIndex = 0 }: { format: ArtworkFormat; model: OfferArtworkModel; slideIndex?: number }) {
  if (format === "tv") return <TvOfferSlide model={model} slideIndex={slideIndex} />;
  if (format === "story") return <StoryHeroOffer model={model} />;
  return <FeedHeroOffer model={model} />;
}
