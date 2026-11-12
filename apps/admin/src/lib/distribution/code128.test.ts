import { describe, expect, it } from "vitest";

import { CODE128_PATTERNS, code128BValue, code128Checksum, code128ModuleCount, code128Modules, decodeCode128BModules } from "./code128";

const bars = (widths: string) => Array.from(widths).filter((_, index) => index % 2 === 0).reduce((sum, width) => sum + Number(width), 0);

describe("tabla de Code 128", () => {
  it("tiene los 106 símbolos de datos e inicio, todos distintos", () => {
    expect(CODE128_PATTERNS).toHaveLength(106);
    expect(new Set(CODE128_PATTERNS).size).toBe(106);
  });

  it("cada símbolo son 6 elementos que suman 11 módulos, con un ancho total de barras par (propiedad del estándar)", () => {
    for (const widths of CODE128_PATTERNS) {
      expect(widths).toMatch(/^[1-4]{6}$/);
      expect(Array.from(widths).reduce((sum, width) => sum + Number(width), 0)).toBe(11);
      expect(bars(widths) % 2).toBe(0);
    }
  });

  it("coincide con vectores conocidos: espacio, inicio B y parada", () => {
    expect(code128Modules(" ").slice(11, 22)).toBe("11011001100");
    expect(code128Modules("A").slice(0, 11)).toBe("11010010000");
    expect(code128Modules("A").endsWith("1100011101011")).toBe(true);
  });
});

describe("armado y lectura", () => {
  it("el dígito de control es el módulo 103 con el inicio B", () => {
    expect(code128Checksum([code128BValue("A")])).toBe((104 + 33) % 103);
    expect(code128Checksum([33, 34])).toBe((104 + 33 + 68) % 103);
  });

  it("un código logístico de 9 caracteres ocupa 134 módulos", () => {
    expect(code128Modules("7K3M9QX4S")).toHaveLength(134);
    expect(code128ModuleCount(9)).toBe(134);
    expect(code128Modules("7K3M9QX4S").startsWith("1")).toBe(true);
    expect(code128Modules("7K3M9QX4S").endsWith("1")).toBe(true);
  });

  it("se decodifica de vuelta al mismo texto", () => {
    for (const text of ["7K3M9QX4S", "0000000000", "ZZZZZZZZZ", "A", "FRAN-123 abc~"]) expect(decodeCode128BModules(code128Modules(text))).toBe(text);
  });

  it("rechaza un símbolo alterado (el control lo detecta)", () => {
    const modules = code128Modules("7K3M9QX4S");
    const tampered = `${modules.slice(0, 11 * 3)}${modules.slice(11 * 3, 11 * 4).split("").reverse().join("")}${modules.slice(11 * 4)}`;
    expect(() => decodeCode128BModules(tampered)).toThrow();
  });

  it("rechaza texto vacío o caracteres fuera de ASCII imprimible", () => {
    expect(() => code128Modules("")).toThrow(RangeError);
    expect(() => code128Modules("ñ")).toThrow(RangeError);
    expect(() => code128BValue("\n")).toThrow(RangeError);
  });
});
