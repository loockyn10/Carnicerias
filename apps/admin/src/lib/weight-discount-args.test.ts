import { describe, expect, it } from "vitest";

import { buildSaveWeightDiscountArgs } from "./weight-discount-args";

const ALL_THIRTEEN_KEYS = [
  "p_id", "p_product_id", "p_branch_id", "p_active", "p_valid_from", "p_valid_until", "p_promotion_mode",
  "p_minimum_grams", "p_discount_type", "p_discount_value",
  "p_pack_quantity_grams", "p_pack_quantity_units", "p_pack_price_cents"
].sort();

function formData(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("buildSaveWeightDiscountArgs", () => {
  it("names all 13 save_weight_discount parameters for a PACK_FIXED_TOTAL (WEIGHT) promotion, with the legacy threshold trio explicitly null", () => {
    const args = buildSaveWeightDiscountArgs(formData({
      promotion_mode: "PACK_FIXED_TOTAL", pack_unit_type: "WEIGHT",
      product_id: "prod-1", pack_quantity_kg: "2", pack_price: "18000", valid_from: ""
    }));

    expect(Object.keys(args).sort()).toEqual(ALL_THIRTEEN_KEYS);
    expect(args.p_promotion_mode).toBe("PACK_FIXED_TOTAL");
    expect(args.p_minimum_grams).toBeNull();
    expect(args.p_discount_type).toBeNull();
    expect(args.p_discount_value).toBeNull();
    expect(args.p_pack_quantity_grams).toBe(2000);
    expect(args.p_pack_quantity_units).toBeNull();
    expect(args.p_pack_price_cents).toBe(1_800_000);
  });

  it("names all 13 save_weight_discount parameters for a PACK_FIXED_TOTAL (UNIT) promotion", () => {
    const args = buildSaveWeightDiscountArgs(formData({
      promotion_mode: "PACK_FIXED_TOTAL", pack_unit_type: "UNIT",
      product_id: "prod-2", pack_quantity_units: "40", pack_price: "28000", valid_from: ""
    }));

    expect(Object.keys(args).sort()).toEqual(ALL_THIRTEEN_KEYS);
    expect(args.p_pack_quantity_grams).toBeNull();
    expect(args.p_pack_quantity_units).toBe(40);
    expect(args.p_pack_price_cents).toBe(2_800_000);
  });

  it("names all 13 save_weight_discount parameters for a THRESHOLD promotion, with the pack trio explicitly null", () => {
    const args = buildSaveWeightDiscountArgs(formData({
      promotion_mode: "THRESHOLD", product_id: "prod-3",
      minimum_kg: "3", discount_type: "PERCENTAGE", discount_value: "10", valid_from: ""
    }));

    expect(Object.keys(args).sort()).toEqual(ALL_THIRTEEN_KEYS);
    expect(args.p_promotion_mode).toBe("THRESHOLD");
    expect(args.p_minimum_grams).toBe(3000);
    expect(args.p_discount_type).toBe("PERCENTAGE");
    expect(args.p_discount_value).toBe(1000);
    expect(args.p_pack_quantity_grams).toBeNull();
    expect(args.p_pack_quantity_units).toBeNull();
    expect(args.p_pack_price_cents).toBeNull();
  });

  it("defaults to THRESHOLD when promotion_mode is omitted, still naming all 13 parameters", () => {
    const args = buildSaveWeightDiscountArgs(formData({
      product_id: "prod-4", minimum_kg: "1", discount_type: "FIXED_PRICE_PER_KG", discount_value: "500", valid_from: ""
    }));

    expect(Object.keys(args).sort()).toEqual(ALL_THIRTEEN_KEYS);
    expect(args.p_promotion_mode).toBe("THRESHOLD");
  });
});
