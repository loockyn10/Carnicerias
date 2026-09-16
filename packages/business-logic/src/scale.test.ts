import { describe, expect, it } from "vitest";

import { isScaleReadingFresh, SCALE_READING_TTL_MS, type ScaleReading } from "./scale";

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
