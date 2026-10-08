import { describe, expect, it } from "vitest";

import { fitText, hasGlyph, sanitizeGlyphs, textWidth, wrapLines } from "./artwork-text";

describe("textWidth", () => {
  it("crece con el tamaño y con el texto; Black es más ancho que Bold", () => {
    expect(textWidth("OFERTA", 100)).toBeGreaterThan(textWidth("OFERTA", 50));
    expect(textWidth("OFERTAS", 100)).toBeGreaterThan(textWidth("OFERTA", 100));
    expect(textWidth("OFERTA", 100, 900)).toBeGreaterThan(textWidth("OFERTA", 100, 700));
    expect(textWidth("", 100)).toBe(0);
  });

  it("usa anchos reales de la fuente (una W es más ancha que una I)", () => {
    expect(textWidth("WWWW", 80)).toBeGreaterThan(textWidth("IIII", 80) * 2);
  });
});

describe("sanitizeGlyphs", () => {
  it("conserva acentos, ñ y signos del español; descarta lo que la fuente no dibuja", () => {
    expect(sanitizeGlyphs("Cañuelas ¡Ñandú! ½ kg")).toBe("Cañuelas ¡Ñandú! ½ kg");
    expect(sanitizeGlyphs("Pollo 😀 “fresco” …")).toBe("Pollo fresco");
    expect(hasGlyph("Ñ")).toBe(true);
    expect(hasGlyph("😀")).toBe(false);
  });

  it("colapsa espacios y saltos de línea", () => {
    expect(sanitizeGlyphs("  Nalga \n\t vacuna  ")).toBe("Nalga vacuna");
  });
});

describe("wrapLines", () => {
  it("no parte lo que entra", () => {
    expect(wrapLines("NALGA VACUNA", 60, 2_000)).toEqual(["NALGA VACUNA"]);
  });

  it("parte por palabras y ningún renglón supera el ancho", () => {
    const lines = wrapLines("HAMBURGUESA DE CARNE VACUNA CONGELADA PREMIUM", 80, 700);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 80)).toBeLessThanOrEqual(700);
    expect(lines.join(" ")).toBe("HAMBURGUESA DE CARNE VACUNA CONGELADA PREMIUM");
  });

  it("«X 3 KG», «X 2» y «250 GR» no se separan: ni la X ni el número quedan solos al final de un renglón", () => {
    // Con este ancho, una partición por palabras dejaría «PECHUGA ENTERA X» arriba y «3 KG» abajo.
    const width = textWidth("PECHUGA ENTERA X", 60) + 4;
    expect(wrapLines("PECHUGA ENTERA X 3 KG", 60, width)).toEqual(["PECHUGA ENTERA", "X 3 KG"]);
    expect(wrapLines("FILET DE PECHUGA X 2 KG", 60, textWidth("FILET DE PECHUGA X", 60) + 4)).toEqual(["FILET DE PECHUGA", "X 2 KG"]);
    expect(wrapLines("MAYONESA HELLMANNS 250 GR", 60, textWidth("MAYONESA HELLMANNS 250", 60) + 4)).toEqual(["MAYONESA HELLMANNS", "250 GR"]);
  });

  it("si el grupo entero no entra en la caja se vuelve a separar (nunca desborda)", () => {
    const lines = wrapLines("X 3 KG", 100, textWidth("X 3", 100) + 2);
    for (const line of lines) expect(textWidth(line, 100)).toBeLessThanOrEqual(textWidth("X 3", 100) + 2);
    expect(lines.join(" ")).toBe("X 3 KG");
  });

  it("una palabra más ancha que la caja se parte por letras (nunca desborda)", () => {
    const lines = wrapLines("ELECTROENCEFALOGRAFISTA", 100, 400);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 100)).toBeLessThanOrEqual(400);
    expect(lines.join("")).toBe("ELECTROENCEFALOGRAFISTA");
  });
});

describe("fitText", () => {
  it("usa el tamaño máximo cuando el texto entra", () => {
    const fitted = fitText({ text: "NALGA", maxWidth: 880, maxLines: 2, maxSize: 84, minSize: 40 });
    expect(fitted.size).toBe(84);
    expect(fitted.lines).toEqual(["NALGA"]);
    expect(fitted.truncated).toBe(false);
  });

  it("achica el texto largo hasta que entre en los renglones permitidos, sin recortar", () => {
    const text = "HAMBURGUESA DE CARNE VACUNA CONGELADA PREMIUM X 12 UNIDADES CAJA 1,2 KG";
    const fitted = fitText({ text, maxWidth: 880, maxLines: 3, maxSize: 84, minSize: 40 });
    expect(fitted.truncated).toBe(false);
    expect(fitted.lines.length).toBeLessThanOrEqual(3);
    expect(fitted.size).toBeLessThan(84);
    expect(fitted.lines.join(" ")).toBe(text);
    for (const line of fitted.lines) expect(textWidth(line, fitted.size)).toBeLessThanOrEqual(880);
  });

  it("respeta el alto máximo del bloque", () => {
    const text = "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH";
    const free = fitText({ text, maxWidth: 600, maxLines: 6, maxSize: 120, minSize: 20 });
    const limited = fitText({ text, maxWidth: 600, maxLines: 6, maxSize: 120, minSize: 20, maxHeight: 200 });
    expect(limited.lines.length * limited.size * 1.02).toBeLessThanOrEqual(200);
    expect(limited.size).toBeLessThanOrEqual(free.size);
  });

  it("si ni el tamaño mínimo entra, corta con «...» (y lo marca)", () => {
    const text = "PALABRA ".repeat(60).trim();
    const fitted = fitText({ text, maxWidth: 400, maxLines: 2, maxSize: 60, minSize: 40 });
    expect(fitted.truncated).toBe(true);
    expect(fitted.lines).toHaveLength(2);
    expect(fitted.lines[1]?.endsWith("...")).toBe(true);
    for (const line of fitted.lines) expect(textWidth(line, fitted.size)).toBeLessThanOrEqual(400);
  });
});
