import { describe, expect, it } from "vitest";

import { parsePesosToCents, settlementDifference } from "./settlements";

describe("settlement cash difference", () => {
  it("keeps exact integer cents for negative, positive and zero differences", () => {
    expect(settlementDifference(84_000_000, 83_200_000)).toBe(-800_000);
    expect(settlementDifference(84_000_000, 84_500_000)).toBe(500_000);
    expect(settlementDifference(84_000_000, 84_000_000)).toBe(0);
  });

  it("parses received pesos without floating point arithmetic", () => {
    expect(parsePesosToCents("832000")).toBe(83_200_000);
    expect(parsePesosToCents("832000,50")).toBe(83_200_050);
  });
});
