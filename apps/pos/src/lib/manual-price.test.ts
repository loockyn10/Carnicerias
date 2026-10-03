import { describe, expect, it } from "vitest";

import { centsToPriceInput, sanitizeDiscountInput, validateManualPrice } from "./manual-price";

describe("validateManualPrice", () => {
  it("acepta importes válidos en pesos", () => {
    expect(validateManualPrice("10000")).toEqual({ ok: true, priceCents: 1_000_000n });
    expect(validateManualPrice("10.000")).toEqual({ ok: true, priceCents: 1_000_000n });
    expect(validateManualPrice("$ 10.000,50")).toEqual({ ok: true, priceCents: 1_000_050n });
    expect(validateManualPrice("0,5")).toEqual({ ok: true, priceCents: 50n });
  });

  it("impide valores <= 0, vacíos, negativos y texto", () => {
    for (const bad of ["", "   ", "0", "0,00", "-1", "-1000", "abc", "10,555", "1e3"]) {
      expect(validateManualPrice(bad).ok, bad).toBe(false);
    }
    expect(validateManualPrice("0")).toEqual({ ok: false, error: "El precio tiene que ser mayor a cero" });
  });
});

describe("centsToPriceInput", () => {
  it("vuelve a mostrar el precio vigente listo para editar y que se vuelve a parsear igual", () => {
    expect(centsToPriceInput(1_000_000n)).toBe("10000");
    expect(centsToPriceInput(1_000_050n)).toBe("10000,50");
    expect(centsToPriceInput(5n)).toBe("0,05");
    for (const cents of [1n, 99n, 100n, 123_456n, 1_000_000n]) {
      expect(validateManualPrice(centsToPriceInput(cents))).toEqual({ ok: true, priceCents: cents });
    }
  });
});

describe("sanitizeDiscountInput", () => {
  it("permite tipear porcentajes con hasta 2 decimales y descarta el resto", () => {
    expect(sanitizeDiscountInput("12,5", "12")).toBe("12,5");
    expect(sanitizeDiscountInput("5.", "5")).toBe("5.");
    expect(sanitizeDiscountInput("", "5")).toBe("");
    expect(sanitizeDiscountInput("5,123", "5,12")).toBe("5,12");
    expect(sanitizeDiscountInput("abc", "5")).toBe("5");
    expect(sanitizeDiscountInput("-5", "")).toBe("");
    expect(sanitizeDiscountInput("1000", "100")).toBe("100");
  });
});
