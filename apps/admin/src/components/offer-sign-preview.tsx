import { ARTWORK_DISPLAY_FONT_400_BASE64, ARTWORK_DISPLAY_FONT_FAMILY } from "../lib/artwork-display-font-data";
import { MM_PER_PT, OFFER_PAGE_MM, type SignPage } from "../lib/offer-sign-layout";

/** La misma Anton embebida que usa el PDF (como contornos): el preview mide y dibuja las letras igual. */
const FONT_FACE_CSS = `@font-face{font-family:"${ARTWORK_DISPLAY_FONT_FAMILY}";font-weight:400;font-style:normal;src:url(data:font/woff;base64,${ARTWORK_DISPLAY_FONT_400_BASE64}) format("woff")}`;

/**
 * Una hoja A4 apaisada tal como saldrá impresa: dibuja las MISMAS primitivas que el PDF (`buildSignPage`) en un SVG en milímetros.
 * `logoDataUrl` es el logo ya convertido a blanco y negro por el servidor; null = sin logo (el layout ya imprime el nombre del negocio).
 */
export function OfferSignPagePreview({ page, logoDataUrl, label }: { page: SignPage; logoDataUrl: string | null; label: string }) {
  return <svg
    aria-label={label} className="block h-auto w-full rounded-sm border border-stone-300 bg-white shadow-sm" data-testid="offer-sign-page" role="img"
    viewBox={`0 0 ${String(OFFER_PAGE_MM.width)} ${String(OFFER_PAGE_MM.height)}`} xmlns="http://www.w3.org/2000/svg"
  >
    <style dangerouslySetInnerHTML={{ __html: FONT_FACE_CSS }} />
    <rect fill="#fff" height={OFFER_PAGE_MM.height} width={OFFER_PAGE_MM.width} x={0} y={0} />
    {page.rules.map((rule, index) => <line key={`rule-${String(index)}`} stroke="#000" strokeWidth={rule.widthMm} x1={rule.x1} x2={rule.x2} y1={rule.y1} y2={rule.y2} />)}
    {page.panels.map((panel, index) => <g key={`panel-${String(index)}`} transform={`translate(${String(panel.x)} ${String(panel.y)})`}>
      {panel.layout.rects.map((rect, rectIndex) => rect.fill
        ? <rect fill="#000" height={rect.height} key={rectIndex} width={rect.width} x={rect.x} y={rect.y} />
        : <rect fill="none" height={rect.height} key={rectIndex} stroke="#000" strokeWidth={rect.strokeMm} width={rect.width} x={rect.x} y={rect.y} />)}
      {logoDataUrl && panel.layout.logo
        ? <image data-testid="offer-sign-logo" height={panel.layout.logo.height} href={logoDataUrl} preserveAspectRatio={panel.layout.logo.align === "middle" ? "xMidYMid meet" : "xMinYMid meet"} width={panel.layout.logo.width} x={panel.layout.logo.x} y={panel.layout.logo.y} />
        : null}
      {panel.layout.texts.map((text, textIndex) => <text
        fill={text.inverse ? "#fff" : "#000"} fontFamily={`"${ARTWORK_DISPLAY_FONT_FAMILY}", Impact, "Arial Narrow", sans-serif`} fontSize={text.sizePt * MM_PER_PT}
        key={textIndex} textAnchor={text.anchor} x={text.x} y={text.y}
      >{text.text}</text>)}
    </g>)}
  </svg>;
}
