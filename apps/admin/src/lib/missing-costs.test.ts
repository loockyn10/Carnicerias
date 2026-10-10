import { describe, expect, it } from "vitest";

import {
  costUnitSuffix, defaultAlsoSetCurrentCost, describeOutcome, formatCostPerMeasure, lineCostCents, linesLabel, parseCompleteOutcome, parseMissingCosts,
  productCostTotalCents, type MissingCostProduct
} from "./missing-costs";

const line = (quantity: number, id = "l1") => ({ lineId: id, saleId: "s1", soldAt: "2026-10-09T13:32:00Z", quantity, revenueCents: 1_000_000 });
const rawProduct = {
  productId: "p1", productName: "Pata muslo", unitType: "WEIGHT", quantity: 5_600, lineCount: 2, revenueCents: 2_800_000,
  currentCostCents: 380_000, currentPriceCents: 500_000, marginBps: 4_000, repricesOnCostChange: true,
  lines: [{ lineId: "l1", saleId: "s1", soldAt: "2026-10-09T13:32:00Z", quantity: 2_500, revenueCents: 1_250_000 }, { lineId: "l2", saleId: "s2", soldAt: "2026-10-09T16:41:00Z", quantity: 3_100, revenueCents: 1_550_000 }]
};
const rawReport = { canRepair: true, timezone: "America/Argentina/Buenos_Aires", totalLines: 2, totalRevenueCents: 2_800_000, truncated: false, products: [rawProduct] };

describe("parseMissingCosts", () => {
  it("reads the server response into typed products and lines", () => {
    const report = parseMissingCosts(rawReport);
    expect(report.canRepair).toBe(true);
    expect(report.totalLines).toBe(2);
    expect(report.products[0]).toMatchObject({ productName: "Pata muslo", unitType: "WEIGHT", quantity: 5_600, lineCount: 2, currentCostCents: 380_000, repricesOnCostChange: true });
    expect(report.products[0]?.lines.map((entry) => entry.quantity)).toEqual([2_500, 3_100]);
  });

  it("keeps price data null for a user who cannot see it", () => {
    const report = parseMissingCosts({ ...rawReport, canRepair: false, products: [{ ...rawProduct, currentCostCents: null, currentPriceCents: null, marginBps: null, repricesOnCostChange: false }] });
    expect(report.products[0]).toMatchObject({ currentCostCents: null, currentPriceCents: null, marginBps: null, repricesOnCostChange: false });
  });

  it.each([
    ["a non-object", null],
    ["a missing list", { ...rawReport, products: undefined }],
    ["an unknown unit", { ...rawReport, products: [{ ...rawProduct, unitType: "LITER" }] }],
    ["a fractional quantity", { ...rawReport, products: [{ ...rawProduct, quantity: 1.5 }] }],
    ["a string amount", { ...rawReport, totalRevenueCents: "100" }]
  ])("fails loudly on %s", (_label, value) => {
    expect(() => parseMissingCosts(value)).toThrow("Respuesta inesperada");
  });
});

describe("parseCompleteOutcome", () => {
  it("reads the repair result", () => {
    expect(parseCompleteOutcome({ repairedLines: 3, skippedLines: 1, repairedRevenueCents: 500, unitCostCents: 380_000, currentCostSaved: true, currentCostUnchanged: false, priceOutcome: "REPRICED" }))
      .toEqual({ repairedLines: 3, skippedLines: 1, repairedRevenueCents: 500, unitCostCents: 380_000, currentCostSaved: true, currentCostUnchanged: false, priceOutcome: "REPRICED" });
  });
  it("maps a missing price outcome to null (the current cost was not touched)", () => {
    expect(parseCompleteOutcome({ repairedLines: 1, skippedLines: 0, repairedRevenueCents: 1, unitCostCents: 1, currentCostSaved: false, currentCostUnchanged: false, priceOutcome: null }).priceOutcome).toBeNull();
  });
});

describe("exact line cost (same rule as app_private.sale_item_cost_cents)", () => {
  it("WEIGHT: $3.800/kg x 2,500 kg = $9.500", () => {
    expect(lineCostCents("WEIGHT", 380_000, 2_500)).toBe(950_000);
  });
  it("UNIT: $2.000/u x 3 u = $6.000", () => {
    expect(lineCostCents("UNIT", 200_000, 3)).toBe(600_000);
  });
  it("WEIGHT rounds half up in integer arithmetic, never through floats", () => {
    // 1 cent/kg x 500 g = 0,5 cent -> 1 ; x 499 g = 0,499 cent -> 0
    expect(lineCostCents("WEIGHT", 1, 500)).toBe(1);
    expect(lineCostCents("WEIGHT", 1, 499)).toBe(0);
    // a value where a float product would drift: 3,333.33 $/kg x 3,001 kg
    expect(lineCostCents("WEIGHT", 333_333, 3_001)).toBe(1_000_332);
  });
  it("sums each line rounded on its own, like the server does per line", () => {
    const product = { unitType: "WEIGHT" as const, lines: [line(2_500, "a"), line(3_100, "b")] };
    expect(productCostTotalCents(product, 380_000)).toBe(950_000 + 1_178_000);
    const odd = { unitType: "WEIGHT" as const, lines: [line(1, "a"), line(1, "b")] };
    expect(productCostTotalCents(odd, 500)).toBe(2); // 500 x 1 g / 1000 = 0,5 cent -> 1 per line, not 1 for the pair
  });
});

describe("presentation helpers", () => {
  it("uses the right unit for the cost", () => {
    expect(costUnitSuffix("WEIGHT")).toBe("/kg");
    expect(costUnitSuffix("UNIT")).toBe("/u");
    expect(formatCostPerMeasure(380_000, "WEIGHT")).toBe("$ 3.800/kg");
    expect(formatCostPerMeasure(200_000, "UNIT")).toBe("$ 2.000/u");
  });

  it("pluralizes lines", () => {
    expect(linesLabel(1)).toBe("1 línea");
    expect(linesLabel(11)).toBe("11 líneas");
  });

  it("only pre-ticks «also save as current cost» when it cannot change the sale price", () => {
    const base: Pick<MissingCostProduct, "repricesOnCostChange"> = { repricesOnCostChange: false };
    expect(defaultAlsoSetCurrentCost(base)).toBe(true);
    expect(defaultAlsoSetCurrentCost({ repricesOnCostChange: true })).toBe(false);
  });

  it("describes what happened without hiding skipped lines or a price change", () => {
    const outcome = { repairedLines: 2, skippedLines: 1, repairedRevenueCents: 0, unitCostCents: 380_000, currentCostSaved: true, currentCostUnchanged: false, priceOutcome: "REPRICED" };
    const text = describeOutcome("Pata muslo", "WEIGHT", outcome);
    expect(text).toContain("2 líneas completadas con $ 3.800/kg");
    expect(text).toContain("1 línea ya no estaba sin costo y no se tocó");
    expect(text).toContain("precio de venta recalculado");
    expect(describeOutcome("Pata muslo", "WEIGHT", { ...outcome, currentCostSaved: false, priceOutcome: null })).not.toContain("costo actual guardado");
    expect(describeOutcome("Coca", "UNIT", { ...outcome, repairedLines: 0, skippedLines: 0, currentCostSaved: false, priceOutcome: null })).toContain("no había líneas para completar");
  });
});
