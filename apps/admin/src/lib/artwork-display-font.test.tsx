import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FONT_FACE_CSS } from "../components/artwork/artwork-preview";
import { Headline, NameBlock } from "../components/artwork/artwork-parts";
import { ANTON_WIDTHS } from "./artwork-display-metrics";
import { ARTWORK_DISPLAY_FONT_400_BASE64, ARTWORK_DISPLAY_FONT_FAMILY } from "./artwork-display-font-data";
import { INTER_900_WIDTHS } from "./artwork-metrics";
import { fitText, textWidth } from "./artwork-text";

describe("fuente de títulos promocionales («OFERTA»)", () => {
  it("está embebida en el repositorio (WOFF real en base64) y declarada para el preview/TV", () => {
    expect(Buffer.from(ARTWORK_DISPLAY_FONT_400_BASE64, "base64").subarray(0, 4).toString("latin1")).toBe("wOFF");
    expect(FONT_FACE_CSS).toContain(`font-family:"${ARTWORK_DISPLAY_FONT_FAMILY}"`);
    expect(FONT_FACE_CSS).toContain(ARTWORK_DISPLAY_FONT_400_BASE64.slice(0, 40));
  });

  it("mide todos los caracteres que la pieza puede imprimir (nunca un glifo sin ancho)", () => {
    for (const code of Object.keys(INTER_900_WIDTHS)) expect(ANTON_WIDTHS[Number(code)], `U+${Number(code).toString(16)}`).toBeGreaterThan(0);
  });

  it("es condensada: «OFERTA» ocupa mucho menos ancho que en la sans, y el ajuste usa sus anchos", () => {
    expect(textWidth("OFERTA", 100, 400)).toBeLessThan(textWidth("OFERTA", 100, 900) * 0.7);
    const fitted = fitText({ text: "OFERTA", maxWidth: 600, maxLines: 1, maxSize: 400, minSize: 44, weight: 400 });
    expect(textWidth(fitted.lines[0] ?? "", fitted.size, 400)).toBeLessThanOrEqual(600);
    expect(fitted.lines).toEqual(["OFERTA"]);
  });

  it("sólo el titular usa la fuente de títulos: el nombre del producto sigue en la sans", () => {
    const rect = { x: 0, y: 0, w: 700, h: 160 };
    const headline = renderToStaticMarkup(<Headline color="#D8201B" maxSize={110} rect={rect} text="OFERTA" />);
    expect(headline).toContain(ARTWORK_DISPLAY_FONT_FAMILY);
    expect(headline).toContain("font-weight:400");
    const item = { productName: "Choricito de cerdo", unitLabel: "X KG" } as Parameters<typeof NameBlock>[0]["item"];
    const name = renderToStaticMarkup(<NameBlock item={item} maxLines={2} maxSize={80} minSize={40} rect={{ x: 0, y: 0, w: 800, h: 200 }} />);
    expect(name).not.toContain(ARTWORK_DISPLAY_FONT_FAMILY);
  });
});
