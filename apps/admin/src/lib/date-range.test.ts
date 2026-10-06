import { describe, expect, it } from "vitest";

import { comparisonLabel, formatIsoDate, formatLocalDateTime, isIsoDate, localDateString, periodLabel, rangeDays, rangeQuery, resolveSalesRange, shiftIsoDate } from "./date-range";

const BA = "America/Argentina/Buenos_Aires";
// 2026-10-07 01:30 UTC = 2026-10-06 22:30 en Buenos Aires: en UTC ya es "mañana", en la organización todavía es el 6.
const LATE_EVENING_UTC = new Date("2026-10-07T01:30:00Z");

describe("localDateString", () => {
  it("uses the organization's calendar day, not the UTC day", () => {
    expect(localDateString(BA, LATE_EVENING_UTC)).toBe("2026-10-06");
    expect(localDateString("UTC", LATE_EVENING_UTC)).toBe("2026-10-07");
    expect(localDateString("Asia/Tokyo", LATE_EVENING_UTC)).toBe("2026-10-07");
  });

  it("flips to the next day exactly at local midnight", () => {
    expect(localDateString(BA, new Date("2026-10-06T02:59:59Z"))).toBe("2026-10-05");
    expect(localDateString(BA, new Date("2026-10-06T03:00:00Z"))).toBe("2026-10-06");
  });
});

describe("resolveSalesRange presets (organization timezone)", () => {
  it("Hoy is the org-local day even when UTC is already tomorrow", () => {
    expect(resolveSalesRange({ preset: "today" }, BA, LATE_EVENING_UTC)).toEqual({ from: "2026-10-06", to: "2026-10-06", preset: "today" });
  });

  it("Ayer is the org-local day before, not the UTC day before", () => {
    expect(resolveSalesRange({ preset: "yesterday" }, BA, LATE_EVENING_UTC)).toEqual({ from: "2026-10-05", to: "2026-10-05", preset: "yesterday" });
  });

  it("7 días and 30 días end today and include it", () => {
    expect(resolveSalesRange({ preset: "7d" }, BA, LATE_EVENING_UTC)).toEqual({ from: "2026-09-30", to: "2026-10-06", preset: "7d" });
    expect(rangeDays("2026-09-30", "2026-10-06")).toBe(7);
    expect(resolveSalesRange({ preset: "30d" }, BA, LATE_EVENING_UTC)).toEqual({ from: "2026-09-07", to: "2026-10-06", preset: "30d" });
    expect(rangeDays("2026-09-07", "2026-10-06")).toBe(30);
  });

  it("no parameters means today", () => {
    expect(resolveSalesRange({}, BA, LATE_EVENING_UTC)).toEqual({ from: "2026-10-06", to: "2026-10-06", preset: "today" });
  });

  it("a preset wins over stale Desde/Hasta values submitted by the same form", () => {
    expect(resolveSalesRange({ preset: "yesterday", from: "2026-01-01", to: "2026-01-31" }, BA, LATE_EVENING_UTC).from).toBe("2026-10-05");
  });
});

describe("resolveSalesRange custom ranges", () => {
  it("accepts any period", () => {
    expect(resolveSalesRange({ from: "2026-08-01", to: "2026-08-15" }, BA, LATE_EVENING_UTC)).toEqual({ from: "2026-08-01", to: "2026-08-15", preset: "custom" });
  });

  it("a custom range that equals a preset is recognised as that preset", () => {
    expect(resolveSalesRange({ from: "2026-10-06", to: "2026-10-06" }, BA, LATE_EVENING_UTC).preset).toBe("today");
    expect(resolveSalesRange({ from: "2026-09-30", to: "2026-10-06" }, BA, LATE_EVENING_UTC).preset).toBe("7d");
  });

  it("a single day is a valid range", () => {
    expect(resolveSalesRange({ from: "2026-02-28", to: "2026-02-28" }, BA, LATE_EVENING_UTC)).toMatchObject({ from: "2026-02-28", to: "2026-02-28", preset: "custom" });
  });

  it("falls back to today with a message for an invalid request", () => {
    for (const input of [
      { from: "2026-10-05" },
      { to: "2026-10-05" },
      { from: "05/10/2026", to: "06/10/2026" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-10-06", to: "2026-10-05" },
      { from: "2025-01-01", to: "2026-10-06" },
      { preset: "year" }
    ]) {
      const range = resolveSalesRange(input, BA, LATE_EVENING_UTC);
      expect(range).toMatchObject({ from: "2026-10-06", to: "2026-10-06", preset: "today" });
      expect(range.error).toBeTruthy();
    }
  });

  it("accepts exactly 366 days and rejects 367", () => {
    expect(resolveSalesRange({ from: "2025-10-06", to: "2026-10-06" }, BA, LATE_EVENING_UTC).error).toBeUndefined();
    expect(resolveSalesRange({ from: "2025-10-05", to: "2026-10-06" }, BA, LATE_EVENING_UTC).error).toBeTruthy();
  });
});

describe("date helpers", () => {
  it("validates real calendar dates", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("26-02-01")).toBe(false);
  });

  it("shifts across month and year boundaries", () => {
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftIsoDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftIsoDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("formats dd/mm/aaaa", () => {
    expect(formatIsoDate("2026-10-06")).toBe("06/10/2026");
  });

  it("labels the period and what it is compared against", () => {
    const today = resolveSalesRange({ preset: "today" }, BA, LATE_EVENING_UTC);
    const week = resolveSalesRange({ preset: "7d" }, BA, LATE_EVENING_UTC);
    const custom = resolveSalesRange({ from: "2026-08-01", to: "2026-08-15" }, BA, LATE_EVENING_UTC);
    const oneDay = resolveSalesRange({ from: "2026-08-01", to: "2026-08-01" }, BA, LATE_EVENING_UTC);
    expect(periodLabel(today)).toBe("hoy");
    expect(periodLabel(week)).toBe("7 días");
    expect(periodLabel(custom)).toBe("01/08/2026 – 15/08/2026");
    expect(periodLabel(oneDay)).toBe("01/08/2026");
    expect(comparisonLabel(today)).toBe("ayer");
    expect(comparisonLabel(resolveSalesRange({ preset: "yesterday" }, BA, LATE_EVENING_UTC))).toBe("anteayer");
    expect(comparisonLabel(oneDay)).toBe("día anterior");
    expect(comparisonLabel(week)).toBe("período anterior");
  });

  it("formats an instant in the organization timezone, 24 h", () => {
    expect(formatLocalDateTime("2026-10-06T17:30:00Z", BA)).toBe("06/10/2026 14:30");
    expect(formatLocalDateTime("2026-10-07T02:59:00Z", BA)).toBe("06/10/2026 23:59");
    expect(formatLocalDateTime("2026-10-06T03:00:00Z", BA)).toBe("06/10/2026 00:00");
  });

  it("keeps the range in a link", () => {
    expect(rangeQuery({ from: "2026-08-01", to: "2026-08-15", preset: "custom" })).toBe("from=2026-08-01&to=2026-08-15");
  });
});
