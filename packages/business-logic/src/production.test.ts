import { describe, expect, it } from "vitest";
import {
  allocateProductionCost,
  assertOutputsHavePrices,
  calculateAverageCostPerKgCents,
  calculateGrossMarginCents,
  calculateInputCostCents,
  calculateMarginOverSalesBps,
  calculateProducedWeightGrams,
  calculateProfitabilityOverCostBps,
  calculateWasteGrams,
  calculateWastePercentageBps,
  calculateYieldBps,
  buildProductionBatchSummary
} from "./production";

describe("production batch input cost", () => {
  it("computes the total cost of a media res de cerdo", () => {
    // 20 kg at $4.200/kg -> $84.000
    expect(calculateInputCostCents(420_000n, 20_000)).toBe(8_400_000n);
  });
});

describe("yield and waste", () => {
  it("computes waste, yield and its complement for a normal batch", () => {
    const producedWeightGrams = calculateProducedWeightGrams([
      { productId: "costilla", outputWeightGrams: 5_050 },
      { productId: "vacio", outputWeightGrams: 1_870 },
      { productId: "bondiola", outputWeightGrams: 3_120 },
      { productId: "cabeza", outputWeightGrams: 1_940 },
      { productId: "paleta", outputWeightGrams: 4_080 },
      { productId: "recortes", outputWeightGrams: 2_710 }
    ]);
    expect(producedWeightGrams).toBe(18_770);
    expect(calculateWasteGrams(20_000, producedWeightGrams)).toBe(1_230);
    const yieldBps = calculateYieldBps(20_000, producedWeightGrams);
    expect(yieldBps).toBe(9_385n); // 93.85%
    expect(calculateWastePercentageBps(yieldBps)).toBe(615n); // 6.15%, complements yield exactly
  });

  it("has zero waste and 100% yield when outputs equal the input", () => {
    const producedWeightGrams = calculateProducedWeightGrams([{ productId: "a", outputWeightGrams: 20_000 }]);
    expect(calculateWasteGrams(20_000, producedWeightGrams)).toBe(0);
    expect(calculateYieldBps(20_000, producedWeightGrams)).toBe(10_000n);
    expect(calculateWastePercentageBps(10_000n)).toBe(0n);
  });

  it("rejects outputs that exceed the input weight", () => {
    const producedWeightGrams = calculateProducedWeightGrams([{ productId: "a", outputWeightGrams: 20_001 }]);
    expect(() => calculateWasteGrams(20_000, producedWeightGrams)).toThrow(RangeError);
  });

  it("rejects an output line with zero or negative weight", () => {
    expect(() => calculateProducedWeightGrams([{ productId: "a", outputWeightGrams: 0 }])).toThrow(RangeError);
  });

  it("returns null yield/waste for a batch with no recorded input weight", () => {
    expect(calculateYieldBps(0, 0)).toBeNull();
    expect(calculateWastePercentageBps(null)).toBeNull();
  });
});

describe("average cost per sellable kilogram", () => {
  it("matches the spec example exactly", () => {
    // $84.000 / 18,77 kg ~= $4.475,23/kg
    expect(calculateAverageCostPerKgCents(8_400_000n, 18_770)).toBe(447_523n);
  });

  it("is null when there are no outputs yet (division by zero)", () => {
    expect(calculateAverageCostPerKgCents(8_400_000n, 0)).toBeNull();
  });
});

describe("missing price validation", () => {
  it("blocks finalizing when a product has no current price", () => {
    expect(() =>
      assertOutputsHavePrices([
        { productName: "Vacío", salePricePerKgCents: 1_000_000n },
        { productName: "Cabeza", salePricePerKgCents: null }
      ])
    ).toThrow(/Cabeza/);
  });

  it("blocks finalizing when a product's current price is zero", () => {
    expect(() => assertOutputsHavePrices([{ productName: "Recortes", salePricePerKgCents: 0n }])).toThrow(/Recortes/);
  });

  it("passes when every output has a positive price", () => {
    expect(() =>
      assertOutputsHavePrices([{ productName: "Vacío", salePricePerKgCents: 1_000_000n }])
    ).not.toThrow();
  });
});

describe("relative sale value cost allocation", () => {
  it("matches the spec's media res example (value, participation, margins)", () => {
    // Vacío: 2 kg @ $10.000/kg = $20.000. A second output completes $139.000 of potential value.
    const outputs = [
      { productId: "vacio", outputWeightGrams: 2_000, salePricePerKgCents: 1_000_000n },
      { productId: "resto", outputWeightGrams: 2_000, salePricePerKgCents: 5_950_000n }
    ];
    const allocations = allocateProductionCost(8_400_000n, outputs);
    const [vacio, resto] = allocations;
    if (!vacio || !resto) throw new Error("expected both outputs to be allocated");

    expect(vacio.saleValueCents).toBe(2_000_000n); // $20.000
    expect(resto.saleValueCents).toBe(11_900_000n); // $119.000
    const totalSaleValue = vacio.saleValueCents + resto.saleValueCents;
    expect(totalSaleValue).toBe(13_900_000n); // $139.000

    expect(vacio.allocationBps).toBe(1_439n); // 14.39%
    expect(vacio.allocatedCostPerKgCents).toBe(604_317n); // ~$6.043/kg

    // Exact-sum invariant: allocated costs must add up to the batch cost, no leftover cents.
    expect(vacio.allocatedCostCents + resto.allocatedCostCents).toBe(8_400_000n);

    const grossMarginCents = calculateGrossMarginCents(totalSaleValue, 8_400_000n);
    expect(grossMarginCents).toBe(5_500_000n); // $55.000
    expect(calculateMarginOverSalesBps(grossMarginCents, totalSaleValue)).toBe(3_957n); // 39.57%
    expect(calculateProfitabilityOverCostBps(grossMarginCents, 8_400_000n)).toBe(6_548n); // 65.48%
  });

  it("distributes rounding remainders deterministically so the sum is always exact", () => {
    // 100 cents split three ways by equal sale value: 34/33/33, not 33.33 repeating.
    const outputs = [
      { productId: "a", outputWeightGrams: 1_000, salePricePerKgCents: 1_000n },
      { productId: "b", outputWeightGrams: 1_000, salePricePerKgCents: 1_000n },
      { productId: "c", outputWeightGrams: 1_000, salePricePerKgCents: 1_000n }
    ];
    const allocations = allocateProductionCost(100n, outputs);
    const sum = allocations.reduce((total, allocation) => total + allocation.allocatedCostCents, 0n);
    expect(sum).toBe(100n);
    expect(allocations.map((allocation) => allocation.allocatedCostCents).sort()).toEqual([33n, 33n, 34n]);
  });

  it("rejects allocation when every output price is zero", () => {
    const outputs = [{ productId: "a", outputWeightGrams: 1_000, salePricePerKgCents: 0n }];
    expect(() => allocateProductionCost(8_400_000n, outputs)).toThrow(RangeError);
  });

  it("rejects allocation with no outputs", () => {
    expect(() => allocateProductionCost(8_400_000n, [])).toThrow(RangeError);
  });
});

describe("buildProductionBatchSummary", () => {
  it("composes every figure for a normal batch", () => {
    const outputs = [
      { productId: "vacio", outputWeightGrams: 2_000 },
      { productId: "resto", outputWeightGrams: 2_000 }
    ];
    const summary = buildProductionBatchSummary({
      inputWeightGrams: 20_000,
      costTotalCents: 8_400_000n,
      outputs,
      outputSaleValuesCents: [2_000_000n, 11_900_000n]
    });
    expect(summary.producedWeightGrams).toBe(4_000);
    expect(summary.wasteGrams).toBe(16_000);
    expect(summary.yieldBps).toBe(2_000n); // 20%
    expect(summary.totalSaleValueCents).toBe(13_900_000n);
    expect(summary.grossMarginCents).toBe(5_500_000n);
    expect(summary.marginOverSalesBps).toBe(3_957n);
    expect(summary.profitabilityOverCostBps).toBe(6_548n);
  });

  it("never throws for an empty draft batch and reports nulls instead", () => {
    const summary = buildProductionBatchSummary({
      inputWeightGrams: 20_000,
      costTotalCents: 8_400_000n,
      outputs: [],
      outputSaleValuesCents: []
    });
    expect(summary.producedWeightGrams).toBe(0);
    expect(summary.wasteGrams).toBe(20_000);
    expect(summary.yieldBps).toBe(0n);
    expect(summary.averageCostPerKgCents).toBeNull();
    expect(summary.marginOverSalesBps).toBeNull();
  });

  it("handles a batch with no declared input weight without dividing by zero", () => {
    const summary = buildProductionBatchSummary({
      inputWeightGrams: 0,
      costTotalCents: 0n,
      outputs: [],
      outputSaleValuesCents: []
    });
    expect(summary.yieldBps).toBeNull();
    expect(summary.wastePercentageBps).toBeNull();
    expect(summary.averageCostPerKgCents).toBeNull();
    expect(summary.profitabilityOverCostBps).toBeNull();
  });
});
