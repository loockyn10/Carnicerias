import { describe, expect, it } from "vitest";

import { formatStockQuantity, parseStockQuantityInput, stockQuantityToInput, stockUnitLabel } from "./stock-quantity";

describe("formatStockQuantity", () => {
  it("shows a WEIGHT quantity as kilograms and a UNIT quantity as whole units", () => {
    expect(formatStockQuantity(8_000, "WEIGHT")).toBe("8,000 kg");
    expect(formatStockQuantity(24, "UNIT")).toBe("24 u");
  });

  it("never shows a unit count as kilograms (24 units is not 0,024 kg)", () => {
    expect(formatStockQuantity(24, "UNIT")).not.toContain("kg");
  });

  it("keeps negative stock visible for both kinds", () => {
    expect(formatStockQuantity(-1_500, "WEIGHT")).toBe("-1,500 kg");
    expect(formatStockQuantity(-3, "UNIT")).toBe("-3 u");
  });

  it("rejects fractional ledger values", () => {
    expect(() => formatStockQuantity(1.5, "UNIT")).toThrow(RangeError);
  });
});

describe("parseStockQuantityInput", () => {
  it("WEIGHT: kilograms (comma or dot) become integer grams", () => {
    expect(parseStockQuantityInput("2,5", "WEIGHT")).toBe(2_500);
    expect(parseStockQuantityInput("0.001", "WEIGHT")).toBe(1);
    expect(parseStockQuantityInput("12", "WEIGHT")).toBe(12_000);
  });

  it("UNIT: whole numbers are units, never scaled by 1000", () => {
    expect(parseStockQuantityInput("24", "UNIT")).toBe(24);
  });

  it("UNIT: decimals are rejected (no half bottles)", () => {
    expect(() => parseStockQuantityInput("2,5", "UNIT")).toThrow(RangeError);
    expect(() => parseStockQuantityInput("2.5", "UNIT")).toThrow(RangeError);
  });

  it("WEIGHT: more than three decimals and garbage are rejected", () => {
    expect(() => parseStockQuantityInput("1,2345", "WEIGHT")).toThrow(RangeError);
    expect(() => parseStockQuantityInput("abc", "WEIGHT")).toThrow(RangeError);
    expect(() => parseStockQuantityInput("-1", "UNIT")).toThrow(RangeError);
  });

  it("zero is only accepted when explicitly allowed (a physical count of nothing)", () => {
    expect(() => parseStockQuantityInput("0", "UNIT")).toThrow(RangeError);
    expect(parseStockQuantityInput("0", "UNIT", { allowZero: true })).toBe(0);
    expect(parseStockQuantityInput("0", "WEIGHT", { allowZero: true })).toBe(0);
  });
});

describe("stockQuantityToInput / stockUnitLabel", () => {
  it("round-trips what a form field shows", () => {
    expect(stockQuantityToInput(2_500, "WEIGHT")).toBe("2,5");
    expect(stockQuantityToInput(3_000, "WEIGHT")).toBe("3");
    expect(stockQuantityToInput(24, "UNIT")).toBe("24");
    expect(parseStockQuantityInput(stockQuantityToInput(2_500, "WEIGHT"), "WEIGHT")).toBe(2_500);
  });

  it("labels the unit", () => {
    expect(stockUnitLabel("WEIGHT")).toBe("kg");
    expect(stockUnitLabel("UNIT")).toBe("u");
  });
});
