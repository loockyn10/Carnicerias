import type { LabelLayout } from "../lib/label-layout";
import { LABEL_HEIGHT_MM, LABEL_WIDTH_MM, MM_PER_PT } from "../lib/label-spec";

const FONT_FAMILY = "Helvetica, Arial, 'Liberation Sans', sans-serif";

/**
 * Etiqueta de góndola de 60 × 40 mm (franja negra «SUPER OFERTAS», borde fino). Se dibuja a partir del MISMO layout que el PDF (`buildLabelLayout`, medidas de `label-spec.ts`):
 * un SVG con viewBox en milímetros, así que preview y papel coinciden. `scale` sólo agranda la vista; la relación 1,5 se conserva.
 * Una variante de un mismo componente: oferta «llevando N» (`PROMO`), precio unitario (`SIMPLE`), por kg (`WEIGHT`) o sin precio.
 *
 * Es puramente visual: recibe el layout ya resuelto (el servidor lo calcula y viaja serializado al navegador), así este componente no
 * arrastra las métricas de fuentes al bundle del cliente.
 */
export function ProductPriceLabel({ layout, scale = 1, fluid = false }: { layout: LabelLayout; scale?: number | undefined; fluid?: boolean | undefined }) {
  // `fluid`: ocupa el ancho disponible (hasta el tamaño ampliado `scale`) sin desbordar la columna; la relación 1,5 la conserva el viewBox.
  const size = fluid
    ? { style: { background: "#fff", display: "block", width: "100%", maxWidth: `${String(LABEL_WIDTH_MM * scale)}mm`, height: "auto" } }
    : { style: { background: "#fff", display: "block" }, width: `${String(LABEL_WIDTH_MM * scale)}mm`, height: `${String(LABEL_HEIGHT_MM * scale)}mm` };
  return (
    <svg
      aria-label="Etiqueta de góndola"
      data-label-height-mm={LABEL_HEIGHT_MM}
      data-label-variant={layout.variant}
      data-label-width-mm={LABEL_WIDTH_MM}
      data-testid="product-price-label"
      role="img"
      viewBox={`0 0 ${String(LABEL_WIDTH_MM)} ${String(LABEL_HEIGHT_MM)}`}
      xmlns="http://www.w3.org/2000/svg"
      {...size}
    >
      <rect fill="#fff" height={LABEL_HEIGHT_MM} width={LABEL_WIDTH_MM} x={0} y={0} />
      {layout.rects.map((rect) => (
        <rect
          data-label-part={rect.id} fill={rect.fill ? "#000" : "none"} height={rect.height} key={rect.id} stroke={rect.fill ? "none" : "#000"}
          strokeWidth={rect.strokeMm} width={rect.width} x={rect.x} y={rect.y}
        />
      ))}
      {layout.rules.map((rule) => <line data-label-part={rule.id} key={rule.id} stroke="#000" strokeWidth={rule.widthMm} x1={rule.x1} x2={rule.x2} y1={rule.y1} y2={rule.y2} />)}
      {layout.texts.map((text) => (
        <text
          data-label-part={text.id}
          fill={text.inverse ? "#fff" : "#000"}
          fontFamily={FONT_FAMILY}
          fontSize={Math.round(text.sizePt * MM_PER_PT * 1000) / 1000}
          fontStyle={text.style === "boldItalic" ? "italic" : "normal"}
          fontWeight={text.style === "regular" ? 400 : 700}
          key={text.id}
          style={{ fontKerning: "none", whiteSpace: "pre" }}
          textAnchor={text.anchor}
          x={text.x}
          y={text.y}
        >{text.text}</text>
      ))}
    </svg>
  );
}
