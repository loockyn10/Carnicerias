import { describe, expect, it } from "vitest";

import { ANTON_WIDTHS } from "./artwork-display-metrics";
import { antonOutlines, outlineWidthPt } from "./offer-sign-glyphs";

describe("contornos de Anton", () => {
  const font = antonOutlines();

  it("lee los avances reales y coinciden con la tabla de medidas del sistema", () => {
    for (const char of ["O", "F", "6", "$", ".", "Á", "Ñ", "/", " "]) {
      const code = char.codePointAt(0) ?? 0;
      const advance = font.glyphFor(code)?.advance ?? 0;
      expect(Math.abs((advance / font.unitsPerEm) * 1000 - (ANTON_WIDTHS[code] ?? 0))).toBeLessThan(1.5);
    }
  });

  it("trae contornos para letras, dígitos y vocales con tilde (glifos compuestos)", () => {
    for (const char of ["O", "8", "Á", "Ñ", "Ü"]) expect(font.glyphFor(char.codePointAt(0) ?? 0)?.contours.length).toBeGreaterThan(0);
    expect(font.glyphFor("Á".codePointAt(0) ?? 0)?.contours.length).toBeGreaterThan(font.glyphFor("A".codePointAt(0) ?? 0)?.contours.length ?? 0);
  });

  it("un carácter fuera de la fuente no tiene glifo", () => {
    expect(font.glyphFor(0x4e2d)).toBeNull();
  });

  it("mide el texto con los avances reales", () => {
    expect(outlineWidthPt(font, "OFERTA", 100)).toBeGreaterThan(250);
  });
});
