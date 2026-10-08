import { hasPromotion, type OfferArtworkModel, type OfferItem } from "../../lib/artwork";
import { collageLayout, tileParts, type CollageFormat, type TileSpec } from "../../lib/artwork-layout";
import { fitText } from "../../lib/artwork-text";
import { ARTWORK_COLORS as C } from "../../lib/artwork-tokens";
import { BrandBand, Box, Canvas, ContactBlock, Headline, PhotoBlock, PriceBadge, TextBlock } from "./artwork-parts";

/**
 * Plantilla «Collage de ofertas» (D-075): de 2 a 5 productos en una sola pieza, Feed (1080 × 1350) o Story (1080 × 1920). Misma
 * identidad que el protagonista (franja verde con el logo, titular rojo, precio negro sobre pastilla amarilla, contacto abajo a la
 * izquierda): lo compartido vive en `artwork-parts.tsx`. La distribución sale de `collageLayout` (2 → apilados; 3 → 2 + 1 grande;
 * 4 → 2 × 2; 5 → 2 + 2 + 1 ancho), no de una grilla rígida. Sin versión TV en este sprint.
 */

function Tile({ spec, item }: { spec: TileSpec; item: OfferItem }) {
  const parts = tileParts(spec, hasPromotion(item));
  const name = fitText({ text: item.productName, maxWidth: parts.name.w, maxLines: parts.nameMaxLines, maxSize: parts.nameMaxSize, minSize: 22, maxHeight: parts.name.h });
  return <>
    <PhotoBlock imageUrl={item.imageUrl} rect={parts.photo} />
    <Box rect={parts.name} style={{ alignItems: "center", justifyContent: "center" }}><TextBlock color={C.BLACK} fitted={name} /></Box>
    <PriceBadge conditionMaxSize={Math.round(parts.priceMaxSize * 0.34)} item={item} maxPriceSize={parts.priceMaxSize} rect={parts.price} />
  </>;
}

function CollageOffer({ model, format }: { model: OfferArtworkModel; format: CollageFormat }) {
  const layout = collageLayout(model.items.length, format);
  return <Canvas format={format} testId={`artwork-collage-${format}`}>
    <BrandBand branding={model.branding} format={format} />
    <Headline color={model.branding.colors.red} maxSize={format === "story" ? 132 : 122} rect={layout.headline} text={model.headline} />
    {model.items.map((item, index) => {
      const spec = layout.tiles[index];
      return spec ? <Tile item={item} key={`${item.productId}-${String(index)}`} spec={spec} /> : null;
    })}
    <ContactBlock contact={model.branding.contact} rect={layout.contact} />
  </Canvas>;
}

export function FeedCollageOffer({ model }: { model: OfferArtworkModel }) {
  return <CollageOffer format="feed" model={model} />;
}

export function StoryCollageOffer({ model }: { model: OfferArtworkModel }) {
  return <CollageOffer format="story" model={model} />;
}
