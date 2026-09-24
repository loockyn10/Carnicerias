import { describe, expect, it } from "vitest";

import { promotionLabel, type PromotionLabelRow } from "./promotion-label";

function threshold(overrides: Partial<PromotionLabelRow> = {}): PromotionLabelRow {
  return {
    promotion_mode: "THRESHOLD", minimum_grams: 2000, discount_type: "PERCENTAGE", discount_value: 1000,
    pack_quantity_grams: null, pack_quantity_units: null, pack_price_cents: null,
    ...overrides
  };
}

function pack(overrides: Partial<PromotionLabelRow> = {}): PromotionLabelRow {
  return {
    promotion_mode: "PACK_FIXED_TOTAL", minimum_grams: null, discount_type: null, discount_value: null,
    pack_quantity_grams: null, pack_quantity_units: null, pack_price_cents: 2_800_000,
    ...overrides
  };
}

describe("promotionLabel", () => {
  it("formats a PERCENTAGE threshold promotion", () => {
    const label = promotionLabel(threshold());
    expect(label).toContain("10%");
    expect(label).toContain("desde 2 kg");
  });

  it("formats a FIXED_PRICE_PER_KG threshold promotion", () => {
    expect(promotionLabel(threshold({ discount_type: "FIXED_PRICE_PER_KG", discount_value: 900000, minimum_grams: 3000 }))).toContain("desde 3 kg");
  });

  it("formats a PACK_FIXED_TOTAL/WEIGHT promotion without crashing (the reported bug: discount_value is genuinely null here)", () => {
    const row = pack({ pack_quantity_grams: 2000, pack_price_cents: 1_800_000 });
    expect(() => promotionLabel(row)).not.toThrow();
    expect(promotionLabel(row)).toContain("2 kg por");
  });

  it("formats a PACK_FIXED_TOTAL/UNIT promotion (e.g. Hamburguesa 40u/$28.000)", () => {
    const row = pack({ pack_quantity_units: 40, pack_price_cents: 2_800_000 });
    expect(promotionLabel(row)).toContain("40 u por");
  });

  it("returns null instead of fabricating a $0/0kg value when a THRESHOLD row is unexpectedly missing a field", () => {
    expect(promotionLabel(threshold({ discount_value: null }))).toBeNull();
    expect(promotionLabel(threshold({ minimum_grams: null }))).toBeNull();
  });

  it("returns null instead of fabricating a $0/0kg value when a PACK row is unexpectedly missing a field", () => {
    expect(promotionLabel(pack({ pack_price_cents: null }))).toBeNull();
    expect(promotionLabel(pack())).toBeNull(); // no quantity in either grams or units
  });
});
