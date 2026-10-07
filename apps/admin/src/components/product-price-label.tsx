import type { CSSProperties } from "react";

import { LABEL_HEIGHT_MM, LABEL_NOTE_SCALE, LABEL_PRICE_BASE_PT, LABEL_TITLE_SCALE, LABEL_UNIT_PRICE_SCALE, LABEL_WIDTH_MM, type ProductLabelData } from "../lib/product-label";

/**
 * Etiqueta de góndola de 70 × 50 mm. Se dibuja SIEMPRE en milímetros/puntos reales (apta para imprimir tal cual); el preview en
 * pantalla sólo la escala con `scale` conservando la relación 1,4. Tipografía: `--label-price-font-size` es la única base y el resto
 * son proporciones suyas (nombre 70 %, aclaración 30 %, precio unitario 40 %).
 */
export function ProductPriceLabel({ label, scale = 1 }: { label: ProductLabelData; scale?: number | undefined }) {
  const style = {
    width: `${String(LABEL_WIDTH_MM)}mm`,
    height: `${String(LABEL_HEIGHT_MM)}mm`,
    "--label-price-font-size": `${String(LABEL_PRICE_BASE_PT * label.priceFit)}pt`,
    "--label-title-scale": String(LABEL_TITLE_SCALE),
    "--label-note-scale": String(LABEL_NOTE_SCALE),
    "--label-unit-price-scale": String(LABEL_UNIT_PRICE_SCALE),
    "--label-title-fit": String(label.titleFit)
  } as CSSProperties;
  const box = (
    <div className="box-border flex flex-col items-center justify-center overflow-hidden bg-white px-[3mm] py-[2.5mm] text-center text-black" data-label-height-mm={LABEL_HEIGHT_MM} data-label-variant={label.variant} data-label-width-mm={LABEL_WIDTH_MM} data-testid="product-price-label" style={style}>
      <p className="w-full break-words font-bold" data-testid="label-title" style={{ fontSize: "calc(var(--label-price-font-size) * var(--label-title-scale) * var(--label-title-fit))", lineHeight: 1.1, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }}>{label.name}</p>
      <p className="whitespace-nowrap font-black leading-none" data-testid="label-price" style={{ fontSize: "var(--label-price-font-size)", marginTop: "2.2mm" }}>
        {label.price ?? "Sin precio"}
        {label.priceSuffix ? <span className="font-bold" style={{ fontSize: "calc(var(--label-price-font-size) * var(--label-unit-price-scale))" }}>{label.priceSuffix}</span> : null}
      </p>
      {label.note ? <p className="leading-tight" data-testid="label-note" style={{ fontSize: "calc(var(--label-price-font-size) * var(--label-note-scale))", marginTop: "1.2mm" }}>{label.note}</p> : null}
      {label.unitPrice ? <p className="font-medium leading-tight" data-testid="label-unit-price" style={{ fontSize: "calc(var(--label-price-font-size) * var(--label-unit-price-scale))", marginTop: "1.8mm" }}>{label.unitPrice}</p> : null}
    </div>
  );
  if (scale === 1) return box;
  // El contenedor ocupa el tamaño escalado (layout correcto) y la etiqueta real se transforma dentro.
  return <div style={{ width: `calc(${String(LABEL_WIDTH_MM)}mm * ${String(scale)})`, height: `calc(${String(LABEL_HEIGHT_MM)}mm * ${String(scale)})` }}>
    <div style={{ transform: `scale(${String(scale)})`, transformOrigin: "top left" }}>{box}</div>
  </div>;
}
