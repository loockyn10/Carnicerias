import type { CSSProperties, ReactNode } from "react";

import { priceFitFor, type OfferSlideData } from "../lib/signage";

/**
 * Tamaño de DISEÑO de la plantilla. Se dibuja siempre en estos píxeles: el reproductor del televisor la escala a la pantalla real
 * con `transform` (proporción 16:9 intacta) y una futura exportación PNG puede renderizarla tal cual a 1920 × 1080.
 */
export const OFFER_SLIDE_WIDTH = 1920;
export const OFFER_SLIDE_HEIGHT = 1080;

const BASE_PRICE_PX = 360;
const BASE_NAME_PX = 112;

const RED = "#9f1239";
const RED_DARK = "#6b0b26";
const YELLOW = "#fde047";

/**
 * Plantilla de UNA oferta (cartel). Presentacional puro: todo el texto llega ya resuelto en `offer` (ver `lib/signage.ts`); acá no hay
 * ninguna cuenta de precios ni descuentos. `media` es el lugar reservado para la foto del producto (todavía no hay gestión de
 * imágenes): sin foto el contenido se centra a todo el ancho; con foto queda a la izquierda y la imagen a la derecha.
 */
export function OfferSlide({ offer, brand, media }: { offer: OfferSlideData; brand?: string | undefined; media?: ReactNode }) {
  const fit = priceFitFor(offer.price, offer.priceSuffix);
  const priceSize = BASE_PRICE_PX * fit;
  const smallSize = priceSize * 0.36;
  const nameSize = BASE_NAME_PX * offer.nameFit;
  const accent = offer.promo ? YELLOW : "#ffffff";

  const frame: CSSProperties = {
    position: "relative", width: OFFER_SLIDE_WIDTH, height: OFFER_SLIDE_HEIGHT, overflow: "hidden", boxSizing: "border-box",
    background: `radial-gradient(ellipse at 50% 38%, ${RED} 0%, ${RED_DARK} 100%)`, color: "#ffffff",
    fontFamily: "Inter, ui-sans-serif, system-ui, 'Segoe UI', Arial, sans-serif", textAlign: "center"
  };

  return <div data-offer-variant={offer.variant} data-testid="offer-slide" style={frame}>
    <div style={{ position: "absolute", top: 48, left: 72, right: 72, display: "flex", alignItems: "center", justifyContent: "space-between", height: 64 }}>
      <span data-testid="offer-brand" style={{ fontSize: 40, fontWeight: 800, letterSpacing: 6, textTransform: "uppercase", opacity: 0.85 }}>{brand ?? ""}</span>
      {offer.promo ? <span data-testid="offer-tag" style={{ background: YELLOW, color: RED_DARK, fontSize: 40, fontWeight: 900, letterSpacing: 6, padding: "6px 36px", borderRadius: 999 }}>OFERTA</span> : null}
    </div>

    <div style={{ position: "absolute", top: 140, bottom: 40, left: 72, right: 72, display: "flex", alignItems: "center", gap: 48 }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <p data-testid="offer-name" style={{
          margin: 0, maxWidth: "100%", fontSize: nameSize, lineHeight: 1.05, fontWeight: 900, textTransform: "uppercase",
          display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 3, overflow: "hidden", overflowWrap: "anywhere"
        }}>{offer.name}</p>

        <p data-testid="offer-price" style={{ margin: "18px 0 0", display: "flex", alignItems: "flex-start", justifyContent: "center", whiteSpace: "nowrap", color: accent, fontWeight: 900, lineHeight: 0.95, textShadow: "0 6px 0 rgba(0,0,0,0.18)" }}>
          <span style={{ fontSize: smallSize, marginTop: priceSize * 0.08, marginRight: priceSize * 0.03 }}>$</span>
          <span style={{ fontSize: priceSize, letterSpacing: -priceSize * 0.02 }}>{offer.price.whole}</span>
          {offer.price.cents ? <span data-testid="offer-cents" style={{ fontSize: smallSize, marginTop: priceSize * 0.08, marginLeft: priceSize * 0.03 }}>{offer.price.cents}</span> : null}
          {offer.priceSuffix ? <span data-testid="offer-suffix" style={{ fontSize: smallSize * 0.9, alignSelf: "flex-end", marginLeft: priceSize * 0.05, paddingBottom: priceSize * 0.1 }}>{offer.priceSuffix}</span> : null}
        </p>

        <p data-testid="offer-condition" style={{
          margin: "26px 0 0", background: offer.promo ? "#ffffff" : "rgba(255,255,255,0.16)", color: offer.promo ? RED : "#ffffff",
          fontSize: 68, fontWeight: 900, letterSpacing: 3, padding: "10px 52px", borderRadius: 999, whiteSpace: "nowrap"
        }}>{offer.condition}</p>

        {offer.secondary ? <p data-testid="offer-secondary" style={{ margin: "26px 0 0", fontSize: 52, fontWeight: 600, color: "#ffe4e6" }}>{offer.secondary}</p> : null}
      </div>
      {media ? <div data-testid="offer-media" style={{ width: 640, height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>{media}</div> : null}
    </div>
  </div>;
}
