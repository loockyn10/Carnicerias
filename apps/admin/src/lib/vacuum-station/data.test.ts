import { describe, expect, it } from "vitest";

import { packageCommercialTotalCents, packageTotalCents, parseCreatePackageInput } from "../vacuum";
import type { EanSchemeConfig } from "../vacuum-ean";
import { buildEan13 } from "../vacuum-ean";
import {
  categoryOptions, FAVORITES_FILTER, formatKg, parseStationProducts, parseStationSummary, productReadiness, visibleProducts, type StationProduct
} from "./data";

const scheme: EanSchemeConfig = { scheme: "PRICE_EMBEDDED", prefix: "20", pluDigits: 4, valueDigits: 6, valueStep: 100 };

const product = (overrides: Partial<StationProduct> = {}): StationProduct => ({
  productId: "p1", name: "Vacío de cerdo", sku: "VCE", shelfLifeDays: 14, plu: "12", conservationText: null, pricePerKgCents: 1_500_000n,
  categoryId: "c1", categoryName: "Cerdo", recentPackages: 0, ...overrides
});

describe("lectura de las RPC", () => {
  it("convierte la lista de cortes (importes como texto → bigint)", () => {
    const parsed = parseStationProducts([
      { productId: "p1", name: "Vacío", sku: "V", shelfLifeDays: 14, plu: "12", conservationText: null, pricePerKgCents: "1500000", categoryId: "c1", categoryName: "Cerdo", recentPackages: 3 },
      { productId: "p2", name: "Sin precio", sku: null, shelfLifeDays: null, plu: null, conservationText: null, pricePerKgCents: null, categoryId: null, categoryName: null, recentPackages: 0 }
    ]);
    expect(parsed[0]).toMatchObject({ productId: "p1", pricePerKgCents: 1_500_000n, categoryName: "Cerdo", recentPackages: 3, shelfLifeDays: 14 });
    expect(parsed[1]).toMatchObject({ pricePerKgCents: null, categoryId: null, shelfLifeDays: null });
  });

  it("tolera respuestas vacías o inválidas", () => {
    expect(parseStationProducts(null)).toEqual([]);
    expect(parseStationProducts([{ name: "sin id" }])).toEqual([]);
    expect(parseStationSummary(null)).toEqual({ packages: 0, grams: 0, lastProductName: null, lastAt: null });
  });

  it("lee el resumen del día", () => {
    expect(parseStationSummary({ date: "2026-11-07", packages: 12, grams: 9_350, lastProductName: "Vacío de cerdo", lastAt: "2026-11-07T15:00:00Z" })).toEqual({
      packages: 12, grams: 9_350, lastProductName: "Vacío de cerdo", lastAt: "2026-11-07T15:00:00Z"
    });
  });
});

describe("¿está listo el corte para envasar solo?", () => {
  const today = "2026-11-07";
  const params = { packedOn: null, expiryByProduct: {} };

  it("listo: precio, PLU, esquema EAN y vida útil → vencimiento calculado con la configuración existente", () => {
    const result = productReadiness(product(), params, today, scheme);
    expect(result).toEqual({ ready: true, problems: [], expiresOn: "2026-11-21", expiresOnToSend: null });
  });

  it("usa la fecha de elaboración elegida, no la de hoy", () => {
    expect(productReadiness(product(), { packedOn: "2026-11-10", expiryByProduct: {} }, today, scheme).expiresOn).toBe("2026-11-24");
  });

  it("sin producto no hay nada que registrar", () => {
    expect(productReadiness(null, params, today, scheme).ready).toBe(false);
  });

  it("sin precio vigente no está listo", () => {
    const result = productReadiness(product({ pricePerKgCents: null }), params, today, scheme);
    expect(result.ready).toBe(false);
    expect(result.problems.join(" ")).toContain("precio vigente");
  });

  it("sin esquema EAN-13 configurado no está listo", () => {
    expect(productReadiness(product(), params, today, null).problems.join(" ")).toContain("EAN-13");
  });

  it("sin PLU no está listo (el esquema lo necesita)", () => {
    const result = productReadiness(product({ plu: null }), params, today, scheme);
    expect(result.ready).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("sin vida útil NO inventa el vencimiento: pide cargarlo", () => {
    const result = productReadiness(product({ shelfLifeDays: null }), params, today, scheme);
    expect(result).toMatchObject({ ready: false, expiresOn: null });
    expect(result.problems.join(" ")).toContain("vida útil");
  });

  it("sin vida útil pero con vencimiento cargado a mano queda listo y lo manda al servidor", () => {
    const result = productReadiness(product({ shelfLifeDays: null }), { packedOn: null, expiryByProduct: { p1: "2026-12-01" } }, today, scheme);
    expect(result).toEqual({ ready: true, problems: [], expiresOn: "2026-12-01", expiresOnToSend: "2026-12-01" });
  });

  it("un vencimiento a mano anterior a la elaboración no sirve", () => {
    const result = productReadiness(product({ shelfLifeDays: null }), { packedOn: null, expiryByProduct: { p1: "2026-11-01" } }, today, scheme);
    expect(result.ready).toBe(false);
  });

  it("una fecha de elaboración inválida no está lista", () => {
    expect(productReadiness(product(), { packedOn: "mañana", expiryByProduct: {} }, today, scheme).ready).toBe(false);
  });
});

describe("selección de cortes", () => {
  const products = [
    product({ productId: "a", name: "Asado", categoryId: "vac", categoryName: "Vacuno", recentPackages: 1, sku: "ASA", plu: "20" }),
    product({ productId: "b", name: "Bondiola", categoryId: "cer", categoryName: "Cerdo", recentPackages: 9, sku: "BON", plu: "21" }),
    product({ productId: "c", name: "Churrasco de cerdo", categoryId: "cer", categoryName: "Cerdo", recentPackages: 0, sku: "CHC", plu: "22" }),
    product({ productId: "d", name: "Vacío de cerdo", categoryId: "cer", categoryName: "Cerdo", recentPackages: 9, sku: "VCE", plu: "12" }),
    product({ productId: "e", name: "Peceto", categoryId: null, categoryName: null, recentPackages: 0, sku: null, plu: null })
  ];
  const all = { query: "", category: null };

  it("ordena: favoritos, luego los más usados y por último alfabético", () => {
    expect(visibleProducts(products, all, ["c"]).map((entry) => entry.productId)).toEqual(["c", "b", "d", "a", "e"]);
  });

  it("filtra por categoría", () => {
    expect(visibleProducts(products, { query: "", category: "cer" }, []).map((entry) => entry.productId)).toEqual(["b", "d", "c"]);
  });

  it("filtra por favoritos", () => {
    expect(visibleProducts(products, { query: "", category: FAVORITES_FILTER }, ["a", "e"]).map((entry) => entry.productId)).toEqual(["a", "e"]);
  });

  it("busca por nombre, SKU, PLU o categoría, sin distinguir mayúsculas ni tildes", () => {
    expect(visibleProducts(products, { query: "VACIO", category: null }, []).map((entry) => entry.productId)).toEqual(["d"]);
    expect(visibleProducts(products, { query: "vce", category: null }, []).map((entry) => entry.productId)).toEqual(["d"]);
    expect(visibleProducts(products, { query: "22", category: null }, []).map((entry) => entry.productId)).toEqual(["c"]);
    expect(visibleProducts(products, { query: "vacuno", category: null }, []).map((entry) => entry.productId)).toEqual(["a"]);
  });

  it("lista las categorías con su cantidad de cortes", () => {
    expect(categoryOptions(products)).toEqual([{ id: "cer", name: "Cerdo", count: 3 }, { id: "vac", name: "Vacuno", count: 1 }]);
  });

  it("no modifica la lista original", () => {
    const before = products.map((entry) => entry.productId);
    visibleProducts(products, all, ["c"]);
    expect(products.map((entry) => entry.productId)).toEqual(before);
  });
});

describe("importe y EAN que ve el operario: los mismos del módulo manual", () => {
  it("0,750 kg a $15.000/kg = $11.250 y el EAN de ejemplo 2000120112506", () => {
    const total = packageCommercialTotalCents(1_500_000n, 750, scheme);
    expect(total).toBe(1_125_000n);
    const ean = buildEan13(scheme, { plu: "12", priceCents: total, weightGrams: 750 });
    expect(ean).toMatchObject({ ok: true, ean13: "2000120112506" });
  });

  it("redondea al peso entero como el servidor (importe comercial único)", () => {
    expect(packageTotalCents(1_445_000n, 825)).toBe(1_192_125n);
    expect(packageCommercialTotalCents(1_445_000n, 825, scheme)).toBe(1_192_100n);
  });

  it("la entrada del registro es la misma que valida el formulario manual", () => {
    const parsed = parseCreatePackageInput({
      branchId: "e3000000-0000-4000-8000-000000000001", productId: "e6000000-0000-4000-8000-000000000001", weightGrams: 825, packedOn: "2026-11-07", expiresOn: null, lot: null,
      requestKey: "e8000000-0000-4000-8000-000000000001"
    });
    expect(parsed.ok).toBe(true);
  });

  it("formatea el peso con tres decimales fijos", () => {
    expect(formatKg(825)).toBe("0,825 kg");
    expect(formatKg(0)).toBe("0,000 kg");
    expect(formatKg(12_300)).toBe("12,300 kg");
    expect(formatKg(-5)).toBe("0,000 kg");
  });
});
