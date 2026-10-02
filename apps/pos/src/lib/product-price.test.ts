import { describe, expect, it } from "vitest";

import { isPriceMissing, NO_PRICE_OFFLINE_MESSAGE, parseSetPriceResult, resolveProductRequest, validateProductPrice } from "./product-price";

const row = (overrides: Record<string, unknown> = {}) => ({
  organizationId: "org", branchId: "central", branchName: "Central", categoryId: "cat", categoryName: "Almacen",
  categoryColorHex: null, categorySortOrder: 0, categoryIds: ["cat"], productId: "galletitas", productName: "GALLETITAS X",
  productSku: null, unitType: "UNIT", pricePerKgCents: "180000", barcodes: ["7791234000001"], ...overrides
});

describe("a product without price", () => {
  it("price 0 means sin precio; any positive price is sellable", () => {
    expect(isPriceMissing({ pricePerKgCents: 0n })).toBe(true);
    expect(isPriceMissing({ pricePerKgCents: 1n })).toBe(false);
    expect(isPriceMissing({ pricePerKgCents: 350000n })).toBe(false);
  });

  it("is never added to the ticket at $0, whether it came from a scan, a tap or a search: online asks for the price", () => {
    expect(resolveProductRequest({ pricePerKgCents: 0n }, true)).toBe("ASK_PRICE");
  });

  it("offline blocks only the price setting: the product is not sold at $0 and nothing is queued", () => {
    expect(resolveProductRequest({ pricePerKgCents: 0n }, false)).toBe("NO_PRICE_OFFLINE");
  });

  it("a product that has a price is untouched by this rule, online or offline (offline sale stays normal)", () => {
    expect(resolveProductRequest({ pricePerKgCents: 350000n }, true)).toBe("ADD");
    expect(resolveProductRequest({ pricePerKgCents: 350000n }, false)).toBe("ADD");
  });

  it("the offline notice is the agreed text", () => {
    expect(NO_PRICE_OFFLINE_MESSAGE).toBe("Este producto no tiene precio.\nNecesitás conexión para establecerlo.");
  });
});

describe("validateProductPrice", () => {
  it("accepts a positive amount in the usual Argentine spellings", () => {
    expect(validateProductPrice("1800")).toEqual({ ok: true, priceCents: 180000n });
    expect(validateProductPrice("$ 1.800,50")).toEqual({ ok: true, priceCents: 180050n });
    expect(validateProductPrice("1800.5")).toEqual({ ok: true, priceCents: 180050n });
  });

  it("rejects zero, empty, negative and malformed prices (the price must be > 0)", () => {
    expect(validateProductPrice("")).toEqual({ ok: false, error: "Escribí el precio de venta" });
    expect(validateProductPrice("0")).toEqual({ ok: false, error: "El precio tiene que ser mayor a cero" });
    expect(validateProductPrice("0,00")).toEqual({ ok: false, error: "El precio tiene que ser mayor a cero" });
    expect(validateProductPrice("-5")).toEqual({ ok: false, error: "Precio inválido" });
    expect(validateProductPrice("abc")).toEqual({ ok: false, error: "Precio inválido" });
    expect(validateProductPrice("1,2,3")).toEqual({ ok: false, error: "Precio inválido" });
  });

  it("rejects an absurd amount (a stray zero typed at the counter)", () => {
    expect(validateProductPrice("9999999999999")).toEqual({ ok: false, error: "Precio inválido" });
  });
});

describe("parseSetPriceResult", () => {
  it("reads the new price and the catalog row of the product", () => {
    const result = parseSetPriceResult({ status: "SET", priceCents: "180000", product: row() });
    expect(result.status).toBe("SET");
    expect(result.priceCents).toBe(180000n);
    expect(result.product).toMatchObject({ productId: "galletitas", pricePerKgCents: "180000", unitType: "UNIT" });
  });

  it("an idempotent retry is reported as UNCHANGED", () => {
    expect(parseSetPriceResult({ status: "UNCHANGED", priceCents: "180000", product: row() }).status).toBe("UNCHANGED");
  });

  it("refuses an answer it does not understand instead of guessing", () => {
    expect(() => parseSetPriceResult(null)).toThrow("Respuesta inválida");
    expect(() => parseSetPriceResult({ status: "MAYBE", priceCents: "1", product: row() })).toThrow("status");
    expect(() => parseSetPriceResult({ status: "SET", priceCents: "0", product: row() })).toThrow("precio");
    expect(() => parseSetPriceResult({ status: "SET", priceCents: 180000, product: row() })).toThrow("precio");
    expect(() => parseSetPriceResult({ status: "SET", priceCents: "180000", product: { productId: "x" } })).toThrow("Respuesta inválida");
  });
});
