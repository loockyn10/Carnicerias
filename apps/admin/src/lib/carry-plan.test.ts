import { describe, expect, it } from "vitest";

import { carryKey, carryTotals, groupCarryPlan, initialCarryInputs, resolveCarryQuantity, type CarryPlanRow } from "./carry-plan";

const row = (overrides: Partial<CarryPlanRow>): CarryPlanRow => ({
  branchId: "av", branchName: "Avenida", productId: "p", productName: "Producto", unitType: "WEIGHT",
  soldQuantity: 0, currentQuantity: 0, suggestedQuantity: 0, ...overrides
});

const molida = row({ productId: "molida", productName: "Molida", soldQuantity: 18_000, currentQuantity: 4_000, suggestedQuantity: 14_000 });
const vacio = row({ productId: "vacio", productName: "Vacío", soldQuantity: 9_000, currentQuantity: 1_000, suggestedQuantity: 8_000 });
const matambre = row({ productId: "matambre", productName: "Matambre", soldQuantity: 3_000, currentQuantity: 4_000, suggestedQuantity: 0 });
const hamburguesa = row({ productId: "ham", productName: "Hamburguesa", unitType: "UNIT", soldQuantity: 30, currentQuantity: 10, suggestedQuantity: 20 });
const janssenMolida = row({ branchId: "ja", branchName: "Janssen", productId: "molida", productName: "Molida", soldQuantity: 9_000, currentQuantity: -2_000, suggestedQuantity: 9_000 });

describe("groupCarryPlan", () => {
  it("hides products that need nothing by default and counts them", () => {
    const [avenida] = groupCarryPlan([molida, vacio, matambre], { showAll: false });
    expect(avenida?.rows.map((r) => r.productName)).toEqual(["Molida", "Vacío"]);
    expect(avenida?.hiddenCount).toBe(1);
  });

  it("shows everything on request, in the server's order", () => {
    const [avenida] = groupCarryPlan([molida, vacio, matambre], { showAll: true });
    expect(avenida?.rows.map((r) => r.productName)).toEqual(["Molida", "Vacío", "Matambre"]);
    expect(avenida?.hiddenCount).toBe(0);
  });

  it("keeps one group per branch, in first-seen order", () => {
    const groups = groupCarryPlan([molida, janssenMolida, vacio], { showAll: false });
    expect(groups.map((g) => g.branchName)).toEqual(["Avenida", "Janssen"]);
    expect(groups[0]?.rows).toHaveLength(2);
    expect(groups[1]?.rows).toHaveLength(1);
  });

  it("a branch with nothing to carry still produces a (empty) group so the screen can say so", () => {
    const [group] = groupCarryPlan([matambre], { showAll: false });
    expect(group).toMatchObject({ branchName: "Avenida", rows: [], hiddenCount: 1 });
  });
});

describe("A llevar ahora (editable quantity)", () => {
  it("starts equal to the suggestion: kg with comma for weighed products, whole units for counted ones", () => {
    const inputs = initialCarryInputs([molida, hamburguesa]);
    expect(inputs[carryKey(molida)]).toBe("14");
    expect(inputs[carryKey(hamburguesa)]).toBe("20");
    expect(initialCarryInputs([row({ productId: "x", suggestedQuantity: 2_500 })])["av:x"]).toBe("2,5");
  });

  it("converts kilograms to exact grams (comma or dot, up to 3 decimals)", () => {
    expect(resolveCarryQuantity("10", "WEIGHT").quantity).toBe(10_000);
    expect(resolveCarryQuantity("10,000", "WEIGHT").quantity).toBe(10_000);
    expect(resolveCarryQuantity("2.5", "WEIGHT").quantity).toBe(2_500);
    expect(resolveCarryQuantity("0,001", "WEIGHT").quantity).toBe(1);
    // 0.1 + 0.2 style float traps never reach grams: it is string arithmetic.
    expect(resolveCarryQuantity("0,3", "WEIGHT").quantity).toBe(300);
    expect(resolveCarryQuantity("1,005", "WEIGHT").quantity).toBe(1_005);
  });

  it("units must be whole numbers", () => {
    expect(resolveCarryQuantity("20", "UNIT").quantity).toBe(20);
    expect(resolveCarryQuantity("2,5", "UNIT")).toMatchObject({ quantity: null });
    expect(resolveCarryQuantity("2,5", "UNIT").error).toBeTruthy();
  });

  it("rejects negatives, garbage, empty and more than 3 decimals of kg", () => {
    for (const bad of ["-1", "-0,5", "abc", "", "1,2345", "1e3", "1.000.000"]) {
      expect(resolveCarryQuantity(bad, "WEIGHT").quantity).toBeNull();
    }
    expect(resolveCarryQuantity("-3", "UNIT").quantity).toBeNull();
  });

  it("accepts zero: 'I am not taking any of this'", () => {
    expect(resolveCarryQuantity("0", "WEIGHT").quantity).toBe(0);
    expect(resolveCarryQuantity("0", "UNIT").quantity).toBe(0);
  });

  it("totals kilograms and units separately and counts invalid fields without including them", () => {
    const inputs = { ...initialCarryInputs([molida, vacio, hamburguesa]), [carryKey(vacio)]: "3,5" };
    expect(carryTotals([molida, vacio, hamburguesa], inputs)).toEqual({ grams: 17_500, units: 20, invalid: 0 });
    expect(carryTotals([molida, vacio, hamburguesa], { ...inputs, [carryKey(molida)]: "-4" })).toEqual({ grams: 3_500, units: 20, invalid: 1 });
  });
});
