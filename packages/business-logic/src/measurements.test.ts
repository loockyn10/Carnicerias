import { describe, expect, it } from "vitest";

import { formatCurrency, formatWeight, priceForWeight } from "./measurements";

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
    expect(formatCurrency(1_250_050n)).toContain("12.500,5");
  });
});

