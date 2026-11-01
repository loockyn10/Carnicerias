import { MM_PER_PT } from "../lib/vacuum-label-spec";
import type { VacuumLabelLayout } from "../lib/vacuum-label-layout";

const FONT_FAMILY = "Helvetica, Arial, 'Liberation Sans', sans-serif";

/**
 * Vista previa de UNA etiqueta térmica (informativa o de precio): un SVG con viewBox en milímetros construido desde el MISMO layout que el PDF
 * (`vacuum-label-layout.ts`), así que las proporciones y las posiciones son las reales del papel. `scale` sólo agranda la vista (1 = tamaño real
 * en pantalla a 96 dpi aprox.). Es puramente visual: recibe el layout ya resuelto.
 */
export function VacuumLabelPreview({ layout, scale = 2.4, title }: { layout: VacuumLabelLayout; scale?: number; title: string }) {
  return (
    <figure className="grid gap-1">
      <div className="w-fit max-w-full rounded border border-stone-300 bg-white p-1 shadow-sm">
        <svg
          aria-label={title}
          data-label-height-mm={layout.heightMm}
          data-label-kind={layout.kind}
          data-label-overflow={layout.overflow ? "true" : "false"}
          data-label-width-mm={layout.widthMm}
          data-testid={`vacuum-label-${layout.kind.toLowerCase()}`}
          role="img"
          style={{ background: "#fff", display: "block", width: "100%", maxWidth: `${String(layout.widthMm * scale)}mm`, height: "auto" }}
          viewBox={`0 0 ${String(layout.widthMm)} ${String(layout.heightMm)}`}
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect fill="#fff" height={layout.heightMm} width={layout.widthMm} x={0} y={0} />
          {layout.rects.map((rect) => (
            <rect
              data-label-part={rect.id} fill={rect.fill ? "#000" : "none"} height={rect.height} key={rect.id} stroke={rect.fill ? "none" : "#000"}
              strokeDasharray={rect.fill ? undefined : "1 0.8"} strokeWidth={rect.strokeMm} width={rect.width} x={rect.x} y={rect.y}
            />
          ))}
          {layout.rules.map((rule) => <line data-label-part={rule.id} key={rule.id} stroke="#000" strokeWidth={rule.widthMm} x1={rule.x1} x2={rule.x2} y1={rule.y1} y2={rule.y2} />)}
          {layout.bars.map((bar, index) => <rect data-label-part="bar" fill="#000" height={bar.height} key={`bar-${String(index)}`} width={bar.width} x={bar.x} y={bar.y} />)}
          {layout.texts.map((text) => (
            <text
              data-label-part={text.id}
              fill="#000"
              fontFamily={FONT_FAMILY}
              fontSize={Math.round(text.sizePt * MM_PER_PT * 1000) / 1000}
              fontWeight={text.style === "regular" ? 400 : 700}
              key={text.id}
              style={{ fontKerning: "none", whiteSpace: "pre" }}
              textAnchor={text.anchor}
              x={text.x}
              y={text.y}
            >{text.text}</text>
          ))}
        </svg>
      </div>
      <figcaption className="text-xs text-stone-500">
        {title} · {String(layout.widthMm)} × {String(layout.heightMm)} mm
        {layout.overflow ? <strong className="ml-2 text-amber-700">El texto no entra: aumentá el alto en Configuración</strong> : null}
      </figcaption>
    </figure>
  );
}
