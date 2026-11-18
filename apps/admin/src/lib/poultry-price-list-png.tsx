import { ImageResponse } from "next/og";

import { readImageInfo } from "./image-size";
import { parsePriceBoard } from "./poultry";
import {
  buildPoultryPriceListModel, fitLogo, L, layoutPoultryPriceList, localDate, PRICE_LIST_FOOTER, PRICE_LIST_SUBTITLE, PRICE_LIST_TITLE,
  priceListFilename, PriceListError, priceListProductCount, type PoultryPriceListModel, type PriceListLayout
} from "./poultry-price-list";
import { parsePriceListSettings, type PriceListImageRef } from "./poultry-price-list-images";
import {
  PRICE_LIST_SANS_800_ITALIC_BASE64, PRICE_LIST_SANS_FAMILY, PRICE_LIST_SERIF_400_BASE64, PRICE_LIST_SERIF_700_BASE64, PRICE_LIST_SERIF_700_ITALIC_BASE64,
  PRICE_LIST_SERIF_FAMILY
} from "./price-list-font-data";

/**
 * PNG de la «Lista de precios» de Pollos (D-100), lado servidor, con la plantilla de la lista SUPER OFERTAS: franja amarilla con el logo,
 * fotografía de fondo, tabla blanca con marco verde y esquinas superiores redondeadas, «LISTA DE PRECIOS», pastilla «POLLO», «Precio por
 * cajón», encabezado verde «CONGELADOS» para la segunda sección, nombres en serif a la izquierda, precios en negrita cursiva a la derecha, separadores negros y pie amarillo de medios de pago.
 *
 * Productos y precios se leen con la sesión del usuario (`get_poultry_price_board`); logo y fondo son los configurados en Pollos → Imágenes
 * de la lista (`get_poultry_price_list_settings`, bucket privado `product-artwork`). Fuentes embebidas (Gelasio + Open Sans): nada se
 * descarga de terceros al generar. Todo se posiciona en absoluto con las medidas de `layoutPoultryPriceList`.
 */

const C = {
  yellow: "#ffde59",
  green: "#1f6e48",
  ink: "#141414",
  muted: "#5f5f5f",
  line: "#111111",
  card: "#ffffff"
} as const;

export interface PriceListImages {
  logo: { src: string; widthPx: number; heightPx: number } | null;
  background: { src: string } | null;
}

function at(left: number, top: number, extra: Record<string, string | number> = {}) {
  return { position: "absolute" as const, left, top, display: "flex", ...extra };
}

export function PoultryPriceListArtwork({ layout, images }: { layout: PriceListLayout; images: PriceListImages }) {
  const { card } = layout;
  const cardCenter = card.x + card.width / 2;
  const logo = images.logo ? { ...images.logo, ...fitLogo(images.logo.widthPx, images.logo.heightPx) } : null;
  const backgroundHeight = layout.footerTop - L.headerHeight;

  return <div style={{ width: layout.width, height: layout.height, display: "flex", position: "relative", backgroundColor: "#d6d2d8", fontFamily: PRICE_LIST_SERIF_FAMILY }}>
    {/* Fondo: la fotografía configurada (cubre todo el ancho, como en la referencia) o un fondo neutro claro. */}
    {images.background
      ? <img alt="" height={backgroundHeight} src={images.background.src} style={{ position: "absolute", left: 0, top: L.headerHeight, objectFit: "cover" }} width={layout.width} />
      : <div style={at(0, L.headerHeight, { width: layout.width, height: backgroundHeight, backgroundImage: "linear-gradient(115deg, #e6e3e8 0%, #cfcad1 38%, #e1dde2 62%, #c4bfc6 100%)" })} />}

    {/* Franja superior */}
    <div style={at(0, 0, { width: layout.width, height: L.headerHeight, backgroundColor: C.yellow })} />

    {/* Tabla */}
    <div style={at(card.x, card.y, { width: card.width, height: card.height, backgroundColor: C.card, border: `${String(L.cardBorder)}px solid ${C.green}`, borderRadius: `${String(L.cardRadius)}px ${String(L.cardRadius)}px 0 0` })} />
    <div style={at(layout.innerX, card.y + layout.titleY, { width: layout.innerWidth, height: L.titleLine, alignItems: "center", justifyContent: "center", fontSize: L.titleSize, fontWeight: 700, color: C.ink, letterSpacing: 0.5 })}>{PRICE_LIST_TITLE}</div>
    <div style={at(layout.innerX, card.y + layout.subRowY, { width: layout.innerWidth, height: L.subRowHeight, alignItems: "center", justifyContent: "space-between" })}>
      <div style={{ display: "flex", alignItems: "center", height: L.subRowHeight, padding: `0 ${String(L.pillPadX)}px`, borderRadius: L.subRowHeight / 2, backgroundColor: C.yellow, color: C.green, fontSize: L.pillSize, fontWeight: 700, letterSpacing: 1 }}>{layout.pillTitle}</div>
      <div style={{ display: "flex", paddingRight: 4, color: C.green, fontFamily: PRICE_LIST_SANS_FAMILY, fontSize: L.subtitleSize, fontWeight: 800, fontStyle: "italic" }}>{PRICE_LIST_SUBTITLE}</div>
    </div>

    {/* Encabezados de las secciones siguientes («CONGELADOS»): la letra y el verde de «POLLO», alineados con los nombres, como en la referencia. */}
    {layout.headings.map((heading) => <div data-testid="price-list-heading" key={`h-${heading.title}`} style={at(layout.innerX, card.y + heading.y, { width: layout.innerWidth, height: heading.height, alignItems: "center", paddingLeft: 2, color: C.green, fontSize: L.pillSize, fontWeight: 700, letterSpacing: 1 })}>{heading.title}</div>)}

    {layout.rows.map((row, index) => <div data-testid="price-list-row" key={`row-${String(index)}`} style={at(layout.innerX, card.y + row.y, { width: layout.innerWidth, height: row.height, alignItems: "center", justifyContent: "space-between", borderBottom: `${String(L.separator)}px solid ${C.line}` })}>
      <div style={{ display: "flex", flexDirection: "column", width: layout.nameColumnWidth, paddingLeft: 2 }}>
        {row.lines.map((line, lineIndex) => <div key={`l-${String(lineIndex)}`} style={{ display: "flex", height: L.nameLine, alignItems: "center", fontSize: L.nameSize, fontWeight: 400, color: C.ink, whiteSpace: "nowrap" }}>{line}</div>)}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", width: layout.priceColumnWidth, paddingRight: 4, fontFamily: PRICE_LIST_SANS_FAMILY, fontSize: row.hasPrice ? L.priceSize : L.priceSize - 4, fontWeight: 800, fontStyle: "italic", color: row.hasPrice ? C.ink : C.muted, whiteSpace: "nowrap" }}>{
        // Un span por carácter: Satori aplica kerning al dibujar pero no al medir, y eso corría unos px el borde derecho de algunos precios.
        Array.from(row.price).map((character, charIndex) => <span key={`c-${String(charIndex)}`}>{character}</span>)
      }</div>
    </div>)}

    {/* Logo (asoma por debajo de la franja, sobre la tabla, como en la referencia). Sin logo cargado no se dibuja nada en su lugar. */}
    {logo ? <img alt="" height={logo.height} src={logo.src} style={{ position: "absolute", left: Math.round(cardCenter - logo.width / 2), top: L.logoTop }} width={logo.width} /> : null}

    {/* Pie */}
    <div style={at(0, layout.footerTop, { width: layout.width, height: L.footerHeight, backgroundColor: C.yellow, alignItems: "center", justifyContent: "center", color: C.ink, fontSize: layout.footerSize, fontWeight: 700, fontStyle: "italic" })}>{PRICE_LIST_FOOTER}</div>
  </div>;
}

function fontBytes(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

export async function renderPoultryPriceListPng(model: PoultryPriceListModel, images: PriceListImages = { logo: null, background: null }): Promise<{ png: Uint8Array; layout: PriceListLayout }> {
  const layout = layoutPoultryPriceList(model);
  const response = new ImageResponse(<PoultryPriceListArtwork images={images} layout={layout} />, {
    width: layout.width,
    height: layout.height,
    fonts: [
      { name: PRICE_LIST_SERIF_FAMILY, data: fontBytes(PRICE_LIST_SERIF_400_BASE64), weight: 400, style: "normal" },
      { name: PRICE_LIST_SERIF_FAMILY, data: fontBytes(PRICE_LIST_SERIF_700_BASE64), weight: 700, style: "normal" },
      { name: PRICE_LIST_SERIF_FAMILY, data: fontBytes(PRICE_LIST_SERIF_700_ITALIC_BASE64), weight: 700, style: "italic" },
      { name: PRICE_LIST_SANS_FAMILY, data: fontBytes(PRICE_LIST_SANS_800_ITALIC_BASE64), weight: 800, style: "italic" }
    ]
  });
  return { png: new Uint8Array(await response.arrayBuffer()), layout };
}

/** Bytes de una imagen guardada → data URL para Satori, sólo si de verdad es un PNG/JPG (lo que diga la base no alcanza). */
export function imageDataUrl(bytes: Uint8Array): { src: string; widthPx: number; heightPx: number } | null {
  const info = readImageInfo(bytes);
  if (!info) return null;
  return { src: `data:${info.type};base64,${Buffer.from(bytes).toString("base64")}`, widthPx: info.width, heightPx: info.height };
}

export { streamBytes } from "./stream-bytes";

export interface PriceListDeps {
  /** Lee `get_poultry_price_board` con la sesión del usuario (la RPC valida `poultry.read` y la organización). */
  getBoard: () => Promise<unknown>;
  /** Lee `get_poultry_price_list_settings` (logo y fondo configurados). */
  getSettings: () => Promise<unknown>;
  /** Descarga una imagen del bucket privado; null si no se pudo leer. */
  readImage: (storagePath: string) => Promise<Uint8Array | null>;
  timeZone: string;
  now?: () => Date;
}

export interface PriceListResult {
  png: Uint8Array; filename: string; width: number; height: number; products: number; omittedByWeight: number; missingPrice: number; hasLogo: boolean;
}

async function loadImage(deps: PriceListDeps, ref: PriceListImageRef | null, label: string) {
  if (!ref) return null;
  const bytes = await deps.readImage(ref.storagePath);
  const image = bytes ? imageDataUrl(bytes) : null;
  // Una imagen configurada que no se puede leer no se reemplaza en silencio: se avisa y se puede reintentar.
  if (!image) throw new PriceListError(502, `No se pudo leer ${label} de la lista. Probá de nuevo o volvé a cargarlo en «Imágenes de la lista».`);
  return image;
}

export async function executePoultryPriceList(deps: PriceListDeps): Promise<PriceListResult> {
  const [boardData, settingsData] = await Promise.all([deps.getBoard(), deps.getSettings()]);
  const model = buildPoultryPriceListModel(parsePriceBoard(boardData), localDate((deps.now ?? (() => new Date()))(), deps.timeZone));
  const products = priceListProductCount(model);
  if (products === 0) {
    throw new PriceListError(422, model.omittedByWeight > 0
      ? "No hay productos de Pollos activos por cajón: los productos por kg no llevan precio por cajón."
      : "No hay productos de Pollos activos para armar la lista.");
  }
  const settings = parsePriceListSettings(settingsData);
  const [logo, background] = await Promise.all([loadImage(deps, settings.logo, "el logo"), loadImage(deps, settings.background, "la foto de fondo")]);
  const { png, layout } = await renderPoultryPriceListPng(model, { logo, background: background ? { src: background.src } : null });
  return {
    png, filename: priceListFilename(model.date), width: layout.width, height: layout.height,
    products, omittedByWeight: model.omittedByWeight, missingPrice: model.missingPrice, hasLogo: logo !== null
  };
}
