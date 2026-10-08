import { BRAND_COLORS, emptyArtworkBranding, type ArtworkBranding } from "../artwork-branding";
import type { OfferSlideData, SignageView } from "../signage";

/** Oferta de TV lista para dibujar (sin promoción salvo que se pida con `overrides`). */
export function slideOffer(key: string, name = `Producto ${key}`, whole = "1.000", overrides: Partial<OfferSlideData> = {}): OfferSlideData {
  return {
    key, variant: "REGULAR", name, price: { whole, cents: null }, priceSuffix: null, condition: "PRECIO UNITARIO", secondary: null, promo: false,
    unitType: "UNIT", regularPrice: { whole, cents: null }, imageUrl: null, ...overrides
  };
}

export function tvBranding(overrides: Partial<ArtworkBranding> = {}): ArtworkBranding {
  return { ...emptyArtworkBranding(), colors: BRAND_COLORS, ...overrides };
}

export function signageView(slides: OfferSlideData[], overrides: Partial<SignageView> = {}): SignageView {
  return { status: "ACTIVE", slideDurationSeconds: 8, organizationName: "Despensa Demo", branding: tvBranding(), slides, ...overrides };
}
