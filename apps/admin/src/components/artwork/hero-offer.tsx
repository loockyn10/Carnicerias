import { hasPromotion, type OfferArtworkModel, type OfferItem } from "../../lib/artwork";
import { heroLayout, pickHeroVariant, type HeroVariantId } from "../../lib/artwork-hero-layouts";
import type { ArtworkFormat } from "../../lib/artwork-tokens";
import { BrandBand, Canvas, ContactBlock, Headline, MechanicTag, NameBlock, NormalPriceLine, PhotoStage, PriceBadge, SavingsSticker } from "./artwork-parts";
import { TvOfferSlide } from "./tv-offer";

/**
 * Renderers de la plantilla «Producto protagonista» (D-074, identidad D-075, composiciones D-086): FeedHeroOffer (1080 × 1350) y
 * StoryHeroOffer (1080 × 1920); la versión TV (1920 × 1080) es `TvOfferSlide` (`tv-offer.tsx`). Todos leen el MISMO `OfferArtworkModel`
 * (un único ítem) y comparten con el collage la franja verde con el logo, el titular, la pastilla de precio y el contacto
 * (`artwork-parts.tsx`). Feed y Story tienen CUATRO composiciones (`lib/artwork-hero-layouts.ts`) que se eligen de forma estable: nunca
 * al azar. En TV el contacto no se muestra (prioridad: producto, imagen, precio, condición y marca).
 *
 * Jerarquía: 1) la FOTO (grande, con una mancha amarilla detrás si es un recorte), 2) el PRECIO (mancha amarilla enorme), 3) el nombre,
 * 4) la MECÁNICA («LLEVANDO 3», «PACK 10 UNIDADES») y el sello de ahorro, 5) la marca, 6) el contacto (chico, nunca compite).
 */

function heroItem(model: OfferArtworkModel): OfferItem {
  const item = model.items[0];
  if (!item) throw new Error("La pieza «Producto protagonista» necesita un producto");
  return item;
}

/** La composición de una pieza: la configurada, la que toca por su posición en la serie, o la derivada del producto (siempre la misma). */
export function heroVariantFor(model: OfferArtworkModel, options: { variant?: HeroVariantId | null | undefined; index?: number | null | undefined } = {}): HeroVariantId {
  return pickHeroVariant({ explicit: options.variant ?? null, index: options.index ?? null, seed: heroItem(model).productId });
}

function ColumnHeroOffer({ model, format, variant }: { model: OfferArtworkModel; format: "feed" | "story"; variant: HeroVariantId }) {
  const item = heroItem(model);
  const promo = hasPromotion(item);
  const layout = heroLayout(format, variant, { promo, mechanic: item.mechanic !== null });
  const hasMechanic = item.mechanic !== null;
  return <Canvas format={format} testId={`artwork-${format}`} variant={variant}>
    <BrandBand branding={model.branding} format={format} />
    <PhotoStage blob={layout.blob} imageUrl={item.imageUrl} photo={layout.photo} seed={layout.blobSeed} transparent={item.imageTransparent} />
    <Headline align={layout.headlineAlign} color={model.branding.colors.red} maxSize={layout.headlineSize} rect={layout.headline} text={model.headline} />
    <NameBlock align={layout.nameAlign} item={item} maxLines={layout.nameLines} maxSize={layout.nameSize} minSize={40} rect={layout.name} />
    <PriceBadge
      align={layout.priceAlign} conditionMaxSize={layout.mechanicSize} item={item} maxPriceSize={layout.priceSize} rect={layout.price}
      seed={layout.blobSeed + 3} shape="splash" showCondition={!hasMechanic}
    />
    <MechanicTag align={layout.mechanicAlign} maxSize={layout.mechanicSize} rect={layout.mechanic} rotate={layout.mechanicRotate} text={item.mechanic} />
    <SavingsSticker rect={layout.sticker} text={item.savings} />
    {promo ? <NormalPriceLine align={layout.normalAlign} item={item} rect={layout.normal} size={layout.normalSize} /> : null}
    <ContactBlock contact={model.branding.contact} rect={layout.contact} />
  </Canvas>;
}

export function FeedHeroOffer({ model, variant }: { model: OfferArtworkModel; variant?: HeroVariantId | null | undefined }) {
  return <ColumnHeroOffer format="feed" model={model} variant={heroVariantFor(model, { variant })} />;
}

export function StoryHeroOffer({ model, variant }: { model: OfferArtworkModel; variant?: HeroVariantId | null | undefined }) {
  return <ColumnHeroOffer format="story" model={model} variant={heroVariantFor(model, { variant })} />;
}

/**
 * El renderer del protagonista que corresponde a un formato (misma pieza, tres composiciones). En TV `slideIndex` elige la disposición de
 * la diapositiva; en Feed y Story, `variant` (explícita) o `slideIndex` (posición en una serie, p. ej. una carpeta) eligen la composición.
 */
export function HeroOffer({ format, model, slideIndex, variant }: { format: ArtworkFormat; model: OfferArtworkModel; slideIndex?: number | undefined; variant?: HeroVariantId | null | undefined }) {
  if (format === "tv") return <TvOfferSlide model={model} slideIndex={slideIndex ?? 0} />;
  const chosen = heroVariantFor(model, { variant, index: slideIndex ?? null });
  return <ColumnHeroOffer format={format} model={model} variant={chosen} />;
}
