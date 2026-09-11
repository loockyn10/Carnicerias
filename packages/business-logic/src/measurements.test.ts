import { describe, expect, it } from "vitest";

import {
  formatCurrency,
  formatWeight,
  parseWeightToGrams,
  priceForWeight,
  sumMoney
} from "./measurements";
import { applyWeightDiscount } from "./measurements";

describe("priceForWeight", () => {
  it("calculates the acceptance-example subtotal exactly", () => {
    expect(priceForWeight(1_200_000n, 1_250)).toBe(1_500_000n);
  });

  it("rounds fractions of a cent deterministically", () => {
    expect(priceForWeight(1n, 500)).toBe(1n);
  });

  it("rejects negative and fractional gram quantities", () => {
    expect(() => priceForWeight(1_000n, -1)).toThrow(RangeError);
    expect(() => priceForWeight(1_000n, 1.5)).toThrow(RangeError);
  });
});

describe("formatters", () => {
  it("shows grams as kilograms with three decimals", () => {
    expect(formatWeight(1_250)).toBe("1,250 kg");
  });

  it("formats integer cents as Argentine pesos", () => {
    expect(formatCurrency(1_250_050n)).toBe("$ 12.500,50");
  });
});

describe("parseWeightToGrams", () => {
  it("accepts the Argentine decimal separator", () => {
    expect(parseWeightToGrams("1,250")).toBe(1_250);
    expect(parseWeightToGrams("0,800")).toBe(800);
  });

  it("accepts whole kilograms and dot-separated input", () => {
    expect(parseWeightToGrams("2")).toBe(2_000);
    expect(parseWeightToGrams("0.075")).toBe(75);
  });

  it("rejects zero, negatives and precision below one gram", () => {
    expect(() => parseWeightToGrams("0")).toThrow(RangeError);
    expect(() => parseWeightToGrams("-1")).toThrow(RangeError);
    expect(() => parseWeightToGrams("1,0005")).toThrow(RangeError);
  });
});

describe("ticket totals", () => {
  it("matches the complete acceptance ticket without floating point", () => {
    const vacio = priceForWeight(1_200_000n, parseWeightToGrams("1,250"));
    const asado = priceForWeight(1_000_000n, parseWeightToGrams("0,800"));

    expect(vacio).toBe(1_500_000n);
    expect(asado).toBe(800_000n);
    expect(sumMoney([vacio, asado])).toBe(2_300_000n);
  });
});

describe("weight discounts", () => {
  it("applies a 20% rule inclusively from 2 kg", () => {
    const rules = [{ id: "two", minimumGrams: 2_000, discountType: "PERCENTAGE" as const, discountValue: 2_000n }];
    expect(applyWeightDiscount(1_000_000n, 1_999, rules).subtotalCents).toBe(1_999_000n);
    expect(applyWeightDiscount(1_000_000n, 2_000, rules).subtotalCents).toBe(1_600_000n);
    expect(applyWeightDiscount(1_000_000n, 2_500, rules).subtotalCents).toBe(2_000_000n);
  });

  it("uses the highest applicable threshold without floating point", () => {
    const result = applyWeightDiscount(1_000_000n, 5_400, [
      { id: "three", minimumGrams: 3_000, discountType: "PERCENTAGE", discountValue: 500n },
      { id: "five", minimumGrams: 5_000, discountType: "PERCENTAGE", discountValue: 1_000n }
    ]);
    expect(result.ruleId).toBe("five");
    expect(result.finalPricePerKgCents).toBe(900_000n);
    expect(result.subtotalCents).toBe(4_860_000n);
  });

  it("supports promotional fixed prices", () => {
    const result = applyWeightDiscount(1_200_000n, 3_500, [
      { id: "fixed", minimumGrams: 3_000, discountType: "FIXED_PRICE_PER_KG", discountValue: 1_090_000n }
    ]);
    expect(result.finalPricePerKgCents).toBe(1_090_000n);
    expect(result.discountCents).toBe(385_000n);
  });
});
