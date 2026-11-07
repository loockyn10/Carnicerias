import { describe, expect, it } from "vitest";

import { buildEan13, isValidEan13, readVacuumEan13, vacuumCommercialTotalCents, type EanSchemeConfig } from "./vacuum-ean";

/** Esquema inicial de Envasados: precio embebido, prefijo 20, PLU 4, valor 6, divisor 100 (pesos enteros). */
const FRAN: EanSchemeConfig = { scheme: "PRICE_EMBEDDED", prefix: "20", pluDigits: 4, valueDigits: 6, valueStep: 100 };
const WEIGHT: EanSchemeConfig = { scheme: "WEIGHT_EMBEDDED", prefix: "20", pluDigits: 5, valueDigits: 5, valueStep: 1 };

describe("Envasados EAN-13: armado y lectura del esquema inicial", () => {
  it("arma el ejemplo del pedido: Vacío PLU 0012, $11.250 → 2000120112506", () => {
    const built = buildEan13(FRAN, { plu: "12", priceCents: 1_125_000n, weightGrams: 750 });
    expect(built).toEqual({ ok: true, ean13: "2000120112506" });
  });

  it("lo que se arma se lee de vuelta: mismo PLU, mismo importe", () => {
    const reading = readVacuumEan13(FRAN, "2000120112506");
    expect(reading).toEqual({ kind: "VACUUM", plu: "0012", pluNumber: "12", value: 11_250n, amountCents: 1_125_000n, weightGrams: null });
  });

  it("ida y vuelta para varios importes y PLU", () => {
    for (const [plu, cents] of [["1", 100n], ["9999", 99_999_900n], ["42", 499_500n], ["7", 1_805_300n]] as const) {
      const built = buildEan13(FRAN, { plu, priceCents: cents, weightGrams: 1 });
      expect(built.ok).toBe(true);
      if (!built.ok) continue;
      const reading = readVacuumEan13(FRAN, built.ean13);
      expect(reading.kind).toBe("VACUUM");
      if (reading.kind === "VACUUM") {
        expect(reading.amountCents).toBe(cents);
        expect(reading.pluNumber).toBe(String(Number(plu)));
      }
    }
  });

  it("el importe embebido es el MISMO que se cobra: el importe comercial redondeado a pesos", () => {
    const raw = 1_805_250n; // 1,245 kg × $14.500 = $18.052,50
    const commercial = vacuumCommercialTotalCents(FRAN, raw);
    expect(commercial).toBe(1_805_300n);
    const built = buildEan13(FRAN, { plu: "12", priceCents: commercial, weightGrams: 1245 });
    expect(built.ok).toBe(true);
    if (built.ok) expect(readVacuumEan13(FRAN, built.ean13)).toMatchObject({ kind: "VACUUM", amountCents: commercial });
  });

  it("redondea half-up a pesos y respeta el divisor 1 y los esquemas de peso", () => {
    expect(vacuumCommercialTotalCents(FRAN, 4_950n)).toBe(5_000n);
    expect(vacuumCommercialTotalCents(FRAN, 4_949n)).toBe(4_900n);
    expect(vacuumCommercialTotalCents({ scheme: "PRICE_EMBEDDED", valueStep: 1 }, 1_805_250n)).toBe(1_805_250n);
    expect(vacuumCommercialTotalCents({ scheme: "WEIGHT_EMBEDDED", valueStep: 100 }, 1_805_250n)).toBe(1_805_250n);
    expect(vacuumCommercialTotalCents(null, 1_805_250n)).toBe(1_805_250n);
  });

  it("un esquema de peso se lee como gramos", () => {
    const built = buildEan13(WEIGHT, { plu: "7", priceCents: 1n, weightGrams: 1245 });
    expect(built.ok).toBe(true);
    if (built.ok) expect(readVacuumEan13(WEIGHT, built.ean13)).toMatchObject({ kind: "VACUUM", weightGrams: 1245n, amountCents: null });
  });
});

describe("Envasados EAN-13: lo que NO es de Envasados se interpreta como siempre", () => {
  it("rechaza un dígito verificador incorrecto", () => {
    expect(isValidEan13("2000120112507")).toBe(false);
    expect(readVacuumEan13(FRAN, "2000120112507")).toEqual({ kind: "NOT_VACUUM" });
  });

  it("rechaza largos distintos de 13 y caracteres no numéricos", () => {
    expect(readVacuumEan13(FRAN, "200012011250")).toEqual({ kind: "NOT_VACUUM" });
    expect(readVacuumEan13(FRAN, "20001201125060")).toEqual({ kind: "NOT_VACUUM" });
    expect(readVacuumEan13(FRAN, "20001201125A6")).toEqual({ kind: "NOT_VACUUM" });
    expect(readVacuumEan13(FRAN, "")).toEqual({ kind: "NOT_VACUUM" });
  });

  it("un EAN comercial (otro prefijo) no es de Envasados", () => {
    expect(readVacuumEan13(FRAN, "7790895000010")).toEqual({ kind: "NOT_VACUUM" });
    expect(readVacuumEan13(FRAN, "4006381333931")).toEqual({ kind: "NOT_VACUUM" });
  });

  it("un código interno alfanumérico o un SKU tampoco", () => {
    expect(readVacuumEan13(FRAN, "ABC-2000001")).toEqual({ kind: "NOT_VACUUM" });
    expect(readVacuumEan13(FRAN, "VAC")).toEqual({ kind: "NOT_VACUUM" });
  });

  it("sin esquema configurado nada es de Envasados (ni siquiera con el prefijo 20)", () => {
    expect(readVacuumEan13(null, "2000120112506")).toEqual({ kind: "NOT_VACUUM" });
  });

  it("un esquema inválido no lee nada", () => {
    expect(readVacuumEan13({ ...FRAN, valueDigits: 5 }, "2000120112506")).toEqual({ kind: "NOT_VACUUM" });
  });

  it("el esquema es configurable: otro prefijo y otros dígitos cambian la lectura sin tocar el código", () => {
    const other: EanSchemeConfig = { scheme: "PRICE_EMBEDDED", prefix: "29", pluDigits: 5, valueDigits: 5, valueStep: 10 };
    const built = buildEan13(other, { plu: "31", priceCents: 12_340n, weightGrams: 1 });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.ean13.startsWith("2900031")).toBe(true);
      expect(readVacuumEan13(other, built.ean13)).toMatchObject({ kind: "VACUUM", pluNumber: "31", amountCents: 12_340n });
      expect(readVacuumEan13(FRAN, built.ean13)).toEqual({ kind: "NOT_VACUUM" });
    }
  });
});
