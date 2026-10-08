import { hasPromotion, type OfferArtworkModel } from "../../lib/artwork";
import { TV_NORMAL_LINE_HEIGHT, tvLayoutFor } from "../../lib/artwork-tv-layouts";
import { BrandBand, Canvas, Headline, NameBlock, NormalPriceLine, PhotoBlock, PriceBadge } from "./artwork-parts";

/**
 * Diapositiva de TV 16:9 (1920 × 1080), D-076: el MISMO `OfferArtworkModel` que las piezas de Feed/Story (franja verde con el logo,
 * titular rojo, nombre, foto comercial, pastilla amarilla y, con promoción, «precio normal») con una de las cuatro disposiciones de
 * `TV_LAYOUTS` según la posición de la diapositiva. Sin contacto (el televisor prioriza marca, producto, foto y precio).
 * La usan la vista previa del Admin, el televisor público y el PNG: no existe otro renderer de TV.
 */
export function TvOfferSlide({ model, slideIndex = 0 }: { model: OfferArtworkModel; slideIndex?: number }) {
  const item = model.items[0];
  if (!item) throw new Error("La diapositiva de TV necesita un producto");
  const layout = tvLayoutFor(slideIndex);
  const promo = hasPromotion(item);
  const normal = { x: layout.price.x, y: layout.price.y + layout.price.h + 8, w: layout.price.w, h: TV_NORMAL_LINE_HEIGHT };
  return <Canvas format="tv" testId="artwork-tv" variant={layout.id}>
    <BrandBand branding={model.branding} format="tv" />
    <PhotoBlock imageUrl={item.imageUrl} rect={layout.photo} />
    <Headline color={model.branding.colors.red} maxSize={layout.headlineSize} rect={layout.headline} text={model.headline} />
    <NameBlock item={item} maxLines={3} maxSize={layout.nameSize} minSize={40} rect={layout.name} />
    <PriceBadge align={layout.priceAlign} conditionMaxSize={layout.conditionSize} item={item} maxPriceSize={layout.priceSize} rect={layout.price} />
    {promo ? <NormalPriceLine item={item} rect={normal} size={layout.normalSize} /> : null}
  </Canvas>;
}
