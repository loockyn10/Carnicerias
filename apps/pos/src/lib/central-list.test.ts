import { describe, expect, it } from "vitest";

import { catalogViewMode, centralRowCode, centralUnitLabel, computeVisibleWindow } from "./central-list";

describe("catalogViewMode", () => {
  it("Central (centralPos) uses the compact LIST", () => {
    expect(catalogViewMode(true)).toBe("LIST");
  });

  it("every other branch keeps the card GRID", () => {
    expect(catalogViewMode(false)).toBe("GRID");
  });
});

describe("computeVisibleWindow", () => {
  const base = { rowHeight: 56, overscan: 8 };

  it("mounts only the visible rows plus overscan out of thousands", () => {
    const window = computeVisibleWindow({ ...base, scrollTop: 0, viewportHeight: 560, total: 3000 });
    expect(window.start).toBe(0);
    expect(window.end).toBe(10 + 1 + 8);
  });

  it("follows the scroll position and keeps the overscan on both sides", () => {
    const window = computeVisibleWindow({ ...base, scrollTop: 56 * 1000, viewportHeight: 560, total: 3000 });
    expect(window.start).toBe(992);
    expect(window.end).toBe(1019);
  });

  it("never goes past the end of the list", () => {
    const window = computeVisibleWindow({ ...base, scrollTop: 56 * 2995, viewportHeight: 560, total: 3000 });
    expect(window.end).toBe(3000);
    expect(window.start).toBeLessThan(3000);
  });

  it("a short list is rendered whole", () => {
    expect(computeVisibleWindow({ ...base, scrollTop: 0, viewportHeight: 560, total: 5 })).toEqual({ start: 0, end: 5 });
  });

  it("an empty list renders nothing", () => {
    expect(computeVisibleWindow({ ...base, scrollTop: 0, viewportHeight: 560, total: 0 })).toEqual({ start: 0, end: 0 });
  });

  it("a stale scrollTop past the (now shorter) list still yields a valid range", () => {
    const window = computeVisibleWindow({ ...base, scrollTop: 56 * 900, viewportHeight: 560, total: 20 });
    expect(window.start).toBeLessThanOrEqual(19);
    expect(window.end).toBe(20);
  });
});

describe("row labels", () => {
  it("shows SKU and the first barcode, without repeating the same code", () => {
    expect(centralRowCode({ productSku: "VAC-VACIO", barcodes: [] })).toBe("VAC-VACIO");
    expect(centralRowCode({ productSku: null, barcodes: ["7790272001029", "7790272009999"] })).toBe("7790272001029");
    expect(centralRowCode({ productSku: "A1", barcodes: ["7790"] })).toBe("A1 · 7790");
    expect(centralRowCode({ productSku: "7790", barcodes: ["7790"] })).toBe("7790");
    expect(centralRowCode({ productSku: null, barcodes: [] })).toBeNull();
  });

  it("labels the sale type", () => {
    expect(centralUnitLabel("UNIT")).toBe("UNIDAD");
    expect(centralUnitLabel("WEIGHT")).toBe("KG");
  });
});
