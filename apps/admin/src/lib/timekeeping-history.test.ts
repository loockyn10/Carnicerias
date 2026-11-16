import { describe, expect, it } from "vitest";

import { SHIFT_HISTORY_STATE_LABEL, canVoidShift, shiftHistoryState } from "./timekeeping-history";

describe("historial de fichajes: se puede anular cualquiera que no esté anulado", () => {
  it("cerrado, en curso y a revisar ofrecen anular (también el que ya figura en la rentabilidad)", () => {
    for (const status of ["CLOSED", "OPEN", "REQUIRES_REVIEW"]) {
      expect(canVoidShift({ status })).toBe(true);
      expect(canVoidShift({ status, voidedAt: null })).toBe(true);
    }
  });

  it("uno ya anulado no vuelve a ofrecerlo, sea cual sea su estado original", () => {
    for (const status of ["CLOSED", "OPEN", "REQUIRES_REVIEW"]) {
      expect(canVoidShift({ status, voidedAt: "2026-11-16T10:00:00Z" })).toBe(false);
      expect(shiftHistoryState({ status, voidedAt: "2026-11-16T10:00:00Z" })).toBe("VOIDED");
    }
  });

  it("cada estado tiene su rótulo en el historial", () => {
    expect(shiftHistoryState({ status: "OPEN" })).toBe("OPEN");
    expect(shiftHistoryState({ status: "REQUIRES_REVIEW" })).toBe("REQUIRES_REVIEW");
    expect(shiftHistoryState({ status: "CLOSED" })).toBe("CLOSED");
    expect(SHIFT_HISTORY_STATE_LABEL.REQUIRES_REVIEW).toContain("A revisar");
  });
});
