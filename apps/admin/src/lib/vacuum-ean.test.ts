import { describe, expect, it } from "vitest";

import {
  buildEan13, decodeEan13Modules, ean13CheckDigit, ean13Modules, isValidEan13, modulesToRuns, validateEanSchemeConfig, type EanSchemeConfig
} from "./vacuum-ean";

const PRICE: EanSchemeConfig = { scheme: "PRICE_EMBEDDED", prefix: "2", pluDigits: 4, valueDigits: 7, valueStep: 1 };
const WEIGHT: EanSchemeConfig = { scheme: "WEIGHT_EMBEDDED", prefix: "20", pluDigits: 5, valueDigits: 5, valueStep: 1 };
const PESOS: EanSchemeConfig = { scheme: "PRICE_EMBEDDED", prefix: "2", pluDigits: 6, valueDigits: 5, valueStep: 100 };

describe("EAN-13: dígito verificador", () => {
  it("coincide con códigos reales conocidos", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1); // 4006381333931
    expect(ean13CheckDigit("590123412345")).toBe(7); // 5901234123457
    expect(ean13CheckDigit("200071805250")).toBe(4);
  });

  it("usa 0 cuando la suma es múltiplo de 10", () => {
    expect(ean13CheckDigit("200000701000")).toBe(0);
  });

  it("valida y rechaza", () => {
    expect(isValidEan13("2000718052504")).toBe(true);
    expect(isValidEan13("2000718052505")).toBe(false);
    expect(isValidEan13("200071805250")).toBe(false);
    expect(isValidEan13("20007180525A4")).toBe(false);
    expect(isValidEan13("")).toBe(false);
    expect(isValidEan13("20007180525044")).toBe(false);
  });

  it("exige 12 dígitos para calcular", () => {
    expect(() => ean13CheckDigit("1234")).toThrow(RangeError);
  });
});

describe("EAN-13: armado según el esquema configurado (mismos vectores que vacuum_packaging.test.sql)", () => {
  it("embebe el precio en centavos", () => {
    expect(buildEan13(PRICE, { plu: "7", priceCents: 1_805_250n, weightGrams: 1245 })).toEqual({ ok: true, ean13: "2000718052504" });
  });

  it("embebe el peso en gramos", () => {
    expect(buildEan13(WEIGHT, { plu: "7", priceCents: 1_805_250n, weightGrams: 1245 })).toEqual({ ok: true, ean13: "2000007012455" });
  });

  it("embebe el precio en pesos con half-up ($18.052,50 → 18053)", () => {
    expect(buildEan13(PESOS, { plu: "7", priceCents: 1_805_250n, weightGrams: 1245 })).toEqual({ ok: true, ean13: "2000007180536" });
    expect(buildEan13(PESOS, { plu: "7", priceCents: 1_805_249n, weightGrams: 1245 })).toMatchObject({ ok: true });
  });

  it("siempre produce un EAN-13 válido de 13 dígitos", () => {
    for (const config of [PRICE, WEIGHT, PESOS]) {
      const result = buildEan13(config, { plu: "123", priceCents: 98_765n, weightGrams: 4321 });
      expect(result.ok).toBe(true);
      if (result.ok) { expect(result.ean13).toHaveLength(13); expect(isValidEan13(result.ean13)).toBe(true); }
    }
  });

  it("no inventa un formato: sin esquema configurado lo informa", () => {
    expect(buildEan13(null, { plu: "7", priceCents: 1n, weightGrams: 1 })).toMatchObject({ ok: false, reason: "NOT_CONFIGURED" });
  });

  it("rechaza PLU faltante, no numérico o demasiado largo", () => {
    expect(buildEan13(PRICE, { plu: null, priceCents: 1n, weightGrams: 1 })).toMatchObject({ ok: false, reason: "PLU_MISSING" });
    expect(buildEan13(PRICE, { plu: "AB", priceCents: 1n, weightGrams: 1 })).toMatchObject({ ok: false, reason: "PLU_MISSING" });
    expect(buildEan13(PRICE, { plu: "12345", priceCents: 1n, weightGrams: 1 })).toMatchObject({ ok: false, reason: "PLU_TOO_LONG" });
  });

  it("rechaza (no trunca) un valor que no entra en los dígitos", () => {
    expect(buildEan13(PRICE, { plu: "7", priceCents: 123_456_789n, weightGrams: 1 })).toMatchObject({ ok: false, reason: "VALUE_OVERFLOW" });
    expect(buildEan13(WEIGHT, { plu: "7", priceCents: 1n, weightGrams: 123_456 })).toMatchObject({ ok: false, reason: "VALUE_OVERFLOW" });
  });

  it("rechaza un esquema que no suma 12 dígitos", () => {
    expect(buildEan13({ ...PRICE, valueDigits: 6 }, { plu: "7", priceCents: 1n, weightGrams: 1 })).toMatchObject({ ok: false, reason: "INVALID_SCHEME" });
  });
});

describe("EAN-13: configuración", () => {
  it("valida la suma de 12 dígitos y los rangos", () => {
    expect(validateEanSchemeConfig(PRICE)).toBeNull();
    expect(validateEanSchemeConfig({ ...PRICE, valueDigits: 6 })).toContain("sumar 12");
    expect(validateEanSchemeConfig({ ...PRICE, prefix: "" })).toContain("prefijo");
    expect(validateEanSchemeConfig({ ...PRICE, prefix: "ab" })).toContain("prefijo");
    expect(validateEanSchemeConfig({ ...PRICE, valueStep: 0 })).toContain("divisor");
    expect(validateEanSchemeConfig({ prefix: "2", pluDigits: 9, valueDigits: 2, valueStep: 1 })).toContain("PLU");
  });
});

describe("EAN-13: barras", () => {
  it("tiene 95 módulos con guardas de inicio, centro y fin", () => {
    const modules = ean13Modules("2000718052504");
    expect(modules).toHaveLength(95);
    expect(modules.slice(0, 3)).toBe("101");
    expect(modules.slice(45, 50)).toBe("01010");
    expect(modules.slice(92)).toBe("101");
    expect(modules).toMatch(/^[01]+$/);
  });

  it("decodifica de vuelta al mismo número (verifica las tablas L, G, R y la paridad del primer dígito)", () => {
    for (const ean of ["2000718052504", "4006381333931", "5901234123457", "2000007012455", "0000000000000", "9780201379624", "8412345678905"]) {
      if (!isValidEan13(ean)) continue;
      expect(decodeEan13Modules(ean13Modules(ean))).toBe(ean);
    }
    // Cada primer dígito 0-9 (paridad distinta) con su verificador.
    for (let first = 0; first <= 9; first += 1) {
      const first12 = `${String(first)}12345678901`;
      const ean = first12 + String(ean13CheckDigit(first12));
      expect(decodeEan13Modules(ean13Modules(ean))).toBe(ean);
    }
  });

  it("coincide con las barras publicadas del EAN-13 5901234123457", () => {
    // Tablas del estándar escritas a mano (independientes de la derivación del código): paridad del 5 = L G G L L G.
    const left = "0001011" + "0100111" + "0110011" + "0010011" + "0111101" + "0011101"; // 9(L) 0(G) 1(G) 2(L) 3(L) 4(G)
    const right = "1100110" + "1101100" + "1000010" + "1011100" + "1001110" + "1000100"; // 1 2 3 4 5 7 (R)
    expect(ean13Modules("5901234123457")).toBe("101" + left + "01010" + right + "101");
  });

  it("se niega a dibujar un EAN inválido", () => {
    expect(() => ean13Modules("2000718052505")).toThrow(RangeError);
    expect(() => decodeEan13Modules("1".repeat(95))).toThrow(RangeError);
  });

  it("agrupa los módulos en barras sin perder ni agregar ancho", () => {
    const modules = ean13Modules("2000718052504");
    const runs = modulesToRuns(modules);
    const blackModules = Array.from(modules).filter((bit) => bit === "1").length;
    expect(runs.reduce((total, run) => total + run.width, 0)).toBe(blackModules);
    expect(runs[0]).toEqual({ start: 0, width: 1 });
    for (const run of runs) expect(modules.slice(run.start, run.start + run.width)).toBe("1".repeat(run.width));
  });
});
