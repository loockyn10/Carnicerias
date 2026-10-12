import { hasPromotion, type OfferArtworkModel } from "../../lib/artwork";
import { tvLayoutFor } from "../../lib/artwork-tv-layouts";
import { seedFromText } from "../../lib/artwork-shapes";
import { BrandBand, Canvas, Headline, MechanicTag, NameBlock, NormalPriceLine, PhotoStage, PriceBadge, SavingsSticker } from "./artwork-parts";

/**
 * Diapositiva de TV 16:9 (1920 × 1080), D-076 / D-086: el MISMO `OfferArtworkModel` que las piezas de Feed/Story (franja verde con el logo,
 * titular rojo, nombre, foto comercial con su mancha, precio sobre mancha amarilla, etiqueta de la mecánica, sello de ahorro y, con
 * promoción, «precio normal») con una de las cuatro disposiciones de `TV_LAYOUTS` según la posición de la diapositiva. Sin contacto (el
 * televisor prioriza marca, producto, foto y precio). Es una composición propia de 16:9, no una pieza vertical estirada.
 * La usan la vista previa del Admin, el televisor público y el PNG: no existe otro renderer de TV.
 */
export function TvOfferSlide({ model, slideIndex = 0 }: { model: OfferArtworkModel; slideIndex?: number }) {
  const item = model.items[0];
  if (!item) throw new Error("La diapositiva de TV necesita un producto");
  const layout = tvLayoutFor(slideIndex);
  const promo = hasPromotion(item);
  const seed = seedFromText(`tv-${layout.id}`);
  return <Canvas format="tv" testId="artwork-tv" variant={layout.id}>
    <BrandBand branding={model.branding} format="tv" />
    <PhotoStage blob={layout.blob} imageUrl={item.imageUrl} photo={layout.photo} seed={seed} transparent={item.imageTransparent} />
    <Headline align={layout.headlineAlign} color={model.branding.colors.red} maxSize={layout.headlineSize} rect={layout.headline} text={model.headline} />
    <NameBlock align={layout.nameAlign} item={item} maxLines={5} maxSize={layout.nameSize} minSize={40} rect={layout.name} />
    <PriceBadge
      align={layout.priceAlign} conditionMaxSize={layout.conditionSize} item={item} maxPriceSize={layout.priceSize} rect={layout.price}
      seed={seed + 3} shape="splash" showCondition={item.mechanic === null}
    />
    <MechanicTag align={layout.mechanicAlign} maxSize={layout.mechanicSize} rect={layout.mechanic} rotate={layout.mechanicRotate} text={item.mechanic} />
    <SavingsSticker rect={layout.sticker} text={item.savings} />
    {promo ? <NormalPriceLine align={layout.normalAlign} item={item} rect={layout.normal} size={layout.normalSize} /> : null}
  </Canvas>;
}
