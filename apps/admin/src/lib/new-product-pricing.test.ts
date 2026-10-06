import { describe, expect, it } from "vitest";

import { newProductPricingState, resolveNewProductPricing } from "./new-product-pricing";

describe("newProductPricingState (alta de producto: costo + margen → precio)", () => {
  it("costo $10.000 con margen 30 %: el precio sale solo ($14.285,71) y no hace falta escribirlo", () => {
    const state = newProductPricingState({ marginBps: 3_000, costRaw: "10000", priceRaw: "" });
    expect(state.priceRequired).toBe(false);
    expect(state.derivedPriceCents).toBe(1_428_571);
    expect(state.message).toContain("margen de 30%");
    expect(state.message).toContain("$ 14.285,71");
  });

  it("acepta coma decimal en el costo y usa la misma fórmula (35 %: $10.000 → $15.384,62)", () => {
    expect(newProductPricingState({ marginBps: 3_500, costRaw: "10000,00", priceRaw: "" }).derivedPriceCents).toBe(1_538_462);
  });

  it("con costo + margen un precio escrito a mano NO gana: se ignora y el mensaje lo dice", () => {
    const state = newProductPricingState({ marginBps: 3_000, costRaw: "10000", priceRaw: "15000" });
    expect(state.priceRequired).toBe(false);
    expect(state.derivedPriceCents).toBe(1_428_571);
    expect(state.message).toContain("se ignora");
  });

  it("sin margen configurado hace falta el precio manual y dice por qué", () => {
    const withCost = newProductPricingState({ marginBps: null, costRaw: "10000", priceRaw: "" });
    expect(withCost).toMatchObject({ priceRequired: true, derivedPriceCents: null });
    expect(withCost.message).toContain("todavía no hay un margen configurado");
    expect(newProductPricingState({ marginBps: null, costRaw: "", priceRaw: "" }).message).toContain("no hay costo cargado ni un margen configurado");
  });

  it("con margen pero sin costo (o con un costo inválido o 0) hace falta el precio manual", () => {
    for (const costRaw of ["", "0", "abc", "-5"]) {
      const state = newProductPricingState({ marginBps: 3_000, costRaw, priceRaw: "" });
      expect(state.priceRequired, costRaw).toBe(true);
      expect(state.message).toContain("cargá un costo");
    }
  });

  it("un producto inactivo no forma precio desde el costo", () => {
    const state = newProductPricingState({ marginBps: 3_000, costRaw: "10000", priceRaw: "", active: false });
    expect(state.priceRequired).toBe(true);
    expect(state.message).toContain("inactivo");
  });
});

describe("resolveNewProductPricing (lo que hace la acción de alta antes de crear nada)", () => {
  const base = { sellable: true, active: true, marginBps: 3_000 as number | null, costRaw: "", priceRaw: "" };

  it("una materia prima pura no tiene precio de venta", () => {
    expect(resolveNewProductPricing({ ...base, sellable: false })).toBe("NONE");
  });

  it("precio escrito → MANUAL sólo como fallback: sin costo o sin margen", () => {
    expect(resolveNewProductPricing({ ...base, priceRaw: "1500" })).toBe("MANUAL");
    expect(resolveNewProductPricing({ ...base, marginBps: null, priceRaw: "1500" })).toBe("MANUAL");
    expect(resolveNewProductPricing({ ...base, marginBps: null, costRaw: "1000", priceRaw: "1500" })).toBe("MANUAL");
    expect(resolveNewProductPricing({ ...base, costRaw: "1000", priceRaw: "1500", active: false })).toBe("MANUAL");
  });

  it("con costo y margen → DERIVED, escriban o no un precio (el manual no gana)", () => {
    expect(resolveNewProductPricing({ ...base, costRaw: "10000" })).toBe("DERIVED");
    expect(resolveNewProductPricing({ ...base, costRaw: "10000", priceRaw: "99999" })).toBe("DERIVED");
  });

  it("sin precio y sin forma de calcularlo → error con el motivo (nada se crea)", () => {
    expect(() => resolveNewProductPricing({ ...base })).toThrow(/cargá un costo/);
    expect(() => resolveNewProductPricing({ ...base, marginBps: null, costRaw: "10000" })).toThrow(/margen configurado/);
    expect(() => resolveNewProductPricing({ ...base, costRaw: "10000", active: false })).toThrow(/inactivo/);
  });
});
