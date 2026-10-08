import type { OfferArtworkModel } from "../../lib/artwork";
import type { ArtworkFormat } from "../../lib/artwork-tokens";
import { FeedCollageOffer, StoryCollageOffer } from "./collage-offer";
import { HeroOffer } from "./hero-offer";

/**
 * El renderer de una pieza según su plantilla y su formato. El preview y el PNG exportado llaman a ESTE componente: una sola
 * especificación visual. En TV (16:9) `slideIndex` elige una de las cuatro disposiciones de la diapositiva. El collage sólo existe en Feed y Story (TV cae en la composición Feed; la interfaz no lo ofrece).
 */
export function OfferArtwork({ format, model, slideIndex = 0 }: { format: ArtworkFormat; model: OfferArtworkModel; slideIndex?: number }) {
  if (model.type === "COLLAGE") return format === "story" ? <StoryCollageOffer model={model} /> : <FeedCollageOffer model={model} />;
  return <HeroOffer format={format} model={model} slideIndex={slideIndex} />;
}
