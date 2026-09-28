import { describe, expect, it } from "vitest";

import {
  advanceWeightStability,
  initialWeightStabilityState,
  isScaleReadingFresh,
  SCALE_READING_TTL_MS,
  WEIGHT_STABILITY_WINDOW_MS,
  type ScaleReading
} from "./scale";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");

function readingAgo(ms: number): ScaleReading {
  return { grams: 1_250, receivedAt: new Date(NOW - ms).toISOString() };
}

describe("isScaleReadingFresh", () => {
  it("accepts a connected reading well within the TTL", () => {
    expect(isScaleReadingFresh("CONNECTED", readingAgo(500), NOW)).toBe(true);
  });

  it("accepts a reading exactly at the TTL boundary", () => {
    expect(isScaleReadingFresh("CONNECTED", readingAgo(SCALE_READING_TTL_MS), NOW)).toBe(true);
  });

  it("rejects a reading older than the TTL (stale)", () => {
    expect(isScaleReadingFresh("CONNECTED", readingAgo(SCALE_READING_TTL_MS + 1), NOW)).toBe(false);
  });

  it("rejects a fresh-looking reading once disconnected", () => {
    expect(isScaleReadingFresh("DISCONNECTED", readingAgo(100), NOW)).toBe(false);
  });

  it("rejects a fresh-looking reading while in error state", () => {
    expect(isScaleReadingFresh("ERROR", readingAgo(100), NOW)).toBe(false);
  });

  it("rejects a fresh-looking reading while still connecting", () => {
    expect(isScaleReadingFresh("CONNECTING", readingAgo(100), NOW)).toBe(false);
  });

  it("rejects a missing reading", () => {
    expect(isScaleReadingFresh("CONNECTED", null, NOW)).toBe(false);
  });

  it("rejects an unparseable timestamp instead of throwing", () => {
    expect(isScaleReadingFresh("CONNECTED", { grams: 100, receivedAt: "not-a-date" }, NOW)).toBe(false);
  });

  it("does not resurrect a previous customer's reading after a reconnect with no new data", () => {
    // Same object a caller might still be holding onto from before a
    // disconnect; only the connection state here proves it is stale.
    const leftoverReading = readingAgo(200);
    expect(isScaleReadingFresh("DISCONNECTED", leftoverReading, NOW)).toBe(false);
  });
});

describe("advanceWeightStability", () => {
  const OPENED_AT = NOW;

  function reading(grams: number, atMs: number) {
    return { type: "READING" as const, grams, receivedAtMs: atMs, openedAtMs: OPENED_AT };
  }

  it("never auto-confirms 0 g, even if it repeats for a long time", () => {
    let state = initialWeightStabilityState();
    for (let i = 1; i <= 5; i++) {
      state = advanceWeightStability(state, reading(0, OPENED_AT + i * 200));
    }
    expect(state.status).not.toBe("STABLE");
  });

  it("never stabilizes while the weight keeps changing beyond tolerance", () => {
    let state = initialWeightStabilityState();
    const samples = [210, 365, 480, 520, 590];
    samples.forEach((grams, index) => {
      state = advanceWeightStability(state, reading(grams, OPENED_AT + (index + 1) * 200));
    });
    expect(state.status).toBe("STABILIZING");
  });

  it("410 -> 409 -> 410 (within tolerance) does not confirm prematurely", () => {
    let state = initialWeightStabilityState();
    state = advanceWeightStability(state, reading(410, OPENED_AT + 100));
    state = advanceWeightStability(state, reading(409, OPENED_AT + 200));
    state = advanceWeightStability(state, reading(410, OPENED_AT + 300));
    // Only 200ms elapsed since the anchor; well under the ~600ms window.
    expect(state.status).toBe("STABILIZING");
    expect(state.grams).toBe(410);
  });

  it("confirms once the weight holds within tolerance for the required window", () => {
    let state = initialWeightStabilityState();
    state = advanceWeightStability(state, reading(410, OPENED_AT + 100));
    state = advanceWeightStability(state, reading(410, OPENED_AT + 350));
    expect(state.status).toBe("STABILIZING");
    state = advanceWeightStability(state, reading(410, OPENED_AT + 100 + WEIGHT_STABILITY_WINDOW_MS));
    expect(state.status).toBe("STABLE");
    expect(state.grams).toBe(410);
  });

  it("confirms exactly once: further readings after STABLE never change the state", () => {
    let state = initialWeightStabilityState();
    state = advanceWeightStability(state, reading(410, OPENED_AT + 100));
    state = advanceWeightStability(state, reading(410, OPENED_AT + 100 + WEIGHT_STABILITY_WINDOW_MS));
    expect(state.status).toBe("STABLE");
    const stableState = state;
    const afterMoreReadings = advanceWeightStability(
      advanceWeightStability(state, reading(0, OPENED_AT + 5_000)),
      reading(999, OPENED_AT + 6_000)
    );
    expect(afterMoreReadings).toBe(stableState); // same object: a true no-op, not just an equal value.
  });

  it("closing the modal cancels a pending (not yet stable) confirmation", () => {
    let state = initialWeightStabilityState();
    state = advanceWeightStability(state, reading(410, OPENED_AT + 100));
    expect(state.status).toBe("STABILIZING");
    state = advanceWeightStability(state, { type: "CLOSED" });
    expect(state).toEqual(initialWeightStabilityState());
  });

  it("a disconnect mid-stabilization does not confirm and requires a fresh full window after reconnecting", () => {
    let state = initialWeightStabilityState();
    state = advanceWeightStability(state, reading(410, OPENED_AT + 100));
    state = advanceWeightStability(state, reading(410, OPENED_AT + 500));
    expect(state.status).toBe("STABILIZING");
    state = advanceWeightStability(state, { type: "DISCONNECTED" });
    expect(state.status).toBe("WAITING");
    // Reconnect and immediately resume readings just past the old window:
    // must NOT jump straight to STABLE off the pre-disconnect progress.
    state = advanceWeightStability(state, reading(410, OPENED_AT + 100 + WEIGHT_STABILITY_WINDOW_MS + 50));
    expect(state.status).toBe("STABILIZING");
  });

  it("ignores a reading timestamped at or before the modal's own open time", () => {
    const state = initialWeightStabilityState();
    const next = advanceWeightStability(state, reading(410, OPENED_AT));
    expect(next).toBe(state);
    const alsoIgnored = advanceWeightStability(state, reading(410, OPENED_AT - 50));
    expect(alsoIgnored).toBe(state);
  });
});
