import { describe, expect, it } from "vitest";

import { sampleProduct, sampleSettings } from "./test-support/vacuum-fixtures";
import {
  buildPackageDraft, defaultExpiry, formatIsoDate, moneyText, packageTotalCents, parsePackageWeight, parseVacuumConfigPage,
  parseVacuumPackage, parseVacuumPackagesPage, parseVacuumProducts, parseVacuumSettings, vacuumDims, weightText
} from "./vacuum";

describe("fechas", () => {
  it("formatea fechas calendario", () => {
    expect(formatIsoDate("2026-11-01")).toBe("01/11/2026");
    expect(formatIsoDate("basura")).toBe("basura");
  });
});

describe("vida útil configurable → vencimiento", () => {
  it("elaboración 01/11 con vida útil 7 días vence el 08/11", () => {
    expect(defaultExpiry("2026-11-01", 7)).toBe("2026-11-08");
  });

  it("no hay una vida útil universal: sin configurar no se calcula nada", () => {
    expect(defaultExpiry("2026-11-01", null)).toBeNull();
  });

  it("depende de lo configurado por producto", () => {
    expect(defaultExpiry("2026-11-01", 3)).toBe("2026-11-04");
    expect(defaultExpiry("2026-11-01", 21)).toBe("2026-11-22");
  });
});

describe("peso × precio/kg", () => {
  it("1,245 kg × $14.500/kg = $18.052,50 (half-up en centavos, como el POS)", () => {
    expect(packageTotalCents(1_450_000n, 1245)).toBe(1_805_250n);
    expect(moneyText(1_805_250n)).toBe("$18.052,50");
  });

  it("redondea half-up al centavo", () => {
    expect(packageTotalCents(1_234_567n, 1001)).toBe(1_235_802n);
    expect(packageTotalCents(1_000n, 1)).toBe(1n); // 0,5 centavos → 1
    expect(packageTotalCents(999n, 1)).toBe(1n);
  });

  it("interpreta el peso con coma o punto y lo limita", () => {
    expect(parsePackageWeight("1,245")).toEqual({ ok: true, grams: 1245 });
    expect(parsePackageWeight("1.245")).toEqual({ ok: true, grams: 1245 });
    expect(parsePackageWeight("0,5")).toEqual({ ok: true, grams: 500 });
    expect(parsePackageWeight("")).toMatchObject({ ok: false });
    expect(parsePackageWeight("abc")).toMatchObject({ ok: false });
    expect(parsePackageWeight("1,2345")).toMatchObject({ ok: false });
    expect(parsePackageWeight("0")).toMatchObject({ ok: false });
    expect(parsePackageWeight("100")).toMatchObject({ ok: false });
    expect(weightText(1245)).toBe("1,245 kg");
  });
});

describe("borrador del formulario (preview inmediato)", () => {
  const base = { product: sampleProduct(), weightText: "1,245", packedOn: "2026-11-01", expiresOn: "2026-11-08", settings: sampleSettings() };

  it("calcula importe y EAN-13 válido", () => {
    const draft = buildPackageDraft(base);
    expect(draft.problems).toEqual([]);
    expect(draft.weightGrams).toBe(1245);
    expect(draft.totalCents).toBe(1_805_250n);
    expect(draft.ean).toEqual({ ok: true, ean13: "2000718052504" });
  });

  it("cambiar el peso actualiza importe y EAN", () => {
    const draft = buildPackageDraft({ ...base, weightText: "0,800" });
    expect(draft.totalCents).toBe(1_160_000n);
    expect(draft.ean?.ok).toBe(true);
    expect(draft.ean?.ok && draft.ean.ean13).not.toBe("2000718052504");
  });

  it("con el esquema en pesos (divisor 100) el importe impreso, el embebido y el cobrado son el MISMO importe comercial", () => {
    const pesos = sampleSettings({ ean: { scheme: "PRICE_EMBEDDED", prefix: "20", pluDigits: 4, valueDigits: 6, valueStep: 100 } });
    const draft = buildPackageDraft({ ...base, settings: pesos, product: sampleProduct({ plu: "12", pricePerKgCents: 1_500_000n }), weightText: "0,750" });
    expect(draft.totalCents).toBe(1_125_000n);
    expect(draft.ean).toEqual({ ok: true, ean13: "2000120112506" });
    const rounded = buildPackageDraft({ ...base, settings: pesos, weightText: "1,245" });
    expect(rounded.computedTotalCents).toBe(1_805_250n);
    expect(rounded.totalCents).toBe(1_805_300n);
    expect(rounded.warnings.some((warning) => warning.includes("redondea a pesos enteros"))).toBe(true);
    expect(rounded.ean?.ok && rounded.ean.ean13).toBe("2000070180532");
  });

  it("sin esquema EAN configurado lo informa y no inventa un código", () => {
    const draft = buildPackageDraft({ ...base, settings: sampleSettings({ ean: null }) });
    expect(draft.ean).toMatchObject({ ok: false, reason: "NOT_CONFIGURED" });
    expect(draft.problems).toContain("Falta configurar el esquema EAN-13 de envasados");
  });

  it("pide el corte, el peso y un precio vigente", () => {
    expect(buildPackageDraft({ ...base, product: null, weightText: "" }).problems).toEqual(expect.arrayContaining(["Elegí el corte", "Ingresá el peso"]));
    expect(buildPackageDraft({ ...base, product: sampleProduct({ pricePerKgCents: null }) }).problems).toContain("El corte no tiene un precio vigente en esta sucursal");
    expect(buildPackageDraft({ ...base, weightText: "abc" }).problems.some((problem) => problem.includes("Peso en kg"))).toBe(true);
  });

  it("rechaza un vencimiento anterior a la elaboración", () => {
    expect(buildPackageDraft({ ...base, expiresOn: "2026-10-31" }).problems).toContain("El vencimiento no puede ser anterior a la elaboración");
  });

  it("rechaza un PLU que no entra o falta", () => {
    expect(buildPackageDraft({ ...base, product: sampleProduct({ plu: null }) }).problems.some((problem) => problem.includes("PLU"))).toBe(true);
    expect(buildPackageDraft({ ...base, product: sampleProduct({ plu: "123456" }) }).problems.some((problem) => problem.includes("no entra"))).toBe(true);
  });

  it("avisa (sin bloquear) cuando el corte no tiene vida útil", () => {
    const draft = buildPackageDraft({ ...base, product: sampleProduct({ shelfLifeDays: null }) });
    expect(draft.warnings).toContain("El corte no tiene vida útil configurada: revisá el vencimiento");
    expect(draft.problems).toEqual([]);
  });
});

describe("lectura de las RPC", () => {
  it("lee la configuración con y sin esquema EAN", () => {
    const settings = parseVacuumSettings({
      businessName: "Fran", address: null, labelWidthMm: 58, infoHeightMm: "50", priceHeightMm: null,
      ean: { configured: true, scheme: "PRICE_EMBEDDED", prefix: "2", pluDigits: 4, valueDigits: 7, valueStep: 1 }
    });
    expect(settings.businessName).toBe("Fran");
    expect(settings.infoHeightMm).toBe(50);
    expect(settings.ean).toEqual({ scheme: "PRICE_EMBEDDED", prefix: "2", pluDigits: 4, valueDigits: 7, valueStep: 1 });
    expect(parseVacuumSettings({ ean: { configured: false, scheme: null, valueStep: 1 } }).ean).toBeNull();
    expect(parseVacuumSettings(null).ean).toBeNull();
    // Un esquema guardado que no suma 12 se trata como no configurado: nunca se arma un EAN con él.
    expect(parseVacuumSettings({ ean: { scheme: "PRICE_EMBEDDED", prefix: "2", pluDigits: 4, valueDigits: 6, valueStep: 1 } }).ean).toBeNull();
  });

  it("calcula las medidas de etiqueta desde la configuración", () => {
    expect(vacuumDims(null)).toEqual({ widthMm: 58, infoHeightMm: 40, priceHeightMm: 40 });
    expect(vacuumDims({ labelWidthMm: 58, infoHeightMm: 50, priceHeightMm: null })).toEqual({ widthMm: 58, infoHeightMm: 50, priceHeightMm: 40 });
  });

  it("lee los cortes con precio nulo y en centavos como texto", () => {
    const products = parseVacuumProducts([
      { productId: "a", name: "Vacío", sku: "VAC", shelfLifeDays: 7, plu: "7", conservationText: null, pricePerKgCents: "1450000" },
      { productId: "b", name: "Lomo", sku: null, shelfLifeDays: null, plu: null, conservationText: null, pricePerKgCents: null },
      { name: "sin id" }
    ]);
    expect(products).toHaveLength(2);
    expect(products[0]?.pricePerKgCents).toBe(1_450_000n);
    expect(products[1]?.pricePerKgCents).toBeNull();
  });

  it("lee un paquete registrado y devuelve null si no hay", () => {
    expect(parseVacuumPackage(null)).toBeNull();
    const pkg = parseVacuumPackage({
      id: "p", branchId: "b", branchName: "Central", productId: "x", productName: "Vacío", productSku: null, weightGrams: 1245, pricePerKgCents: "1450000",
      totalCents: "1805250", packedOn: "2026-11-01", expiresOn: "2026-11-08", lot: "A1-1", ean13: "2000718052504", shelfLifeDays: 7, conservationText: "frío",
      label: { businessName: "Fran", labelWidthMm: 58 }, createdAt: "2026-11-01T00:00:00Z", createdBy: "Fran", printCount: 2
    });
    expect(pkg?.totalCents).toBe(1_805_250n);
    expect(pkg?.businessName).toBe("Fran");
    expect(pkg?.dims.widthMm).toBe(58);
    expect(pkg?.dims.infoHeightMm).toBeNull();
    expect(pkg?.printCount).toBe(2);
  });

  it("lee páginas de historial y de configuración", () => {
    const page = parseVacuumPackagesPage({ total: 1, rows: [{ id: "p", lot: "L", branchId: "b", branchName: "C", productId: "x", productName: "Vacío", weightGrams: 1, pricePerKgCents: "1", totalCents: "2", packedOn: "2026-11-01", expiresOn: "2026-11-02", ean13: "x", createdAt: "t", printCount: 0, lastPrintedAt: null }] });
    expect(page.total).toBe(1);
    expect(page.rows[0]?.totalCents).toBe(2n);
    expect(parseVacuumPackagesPage(undefined)).toEqual({ total: 0, rows: [] });
    const config = parseVacuumConfigPage({ total: 2, rows: [{ productId: "a", name: "Vacío", sku: null, enabled: true, shelfLifeDays: 7, plu: "7", conservationText: null }] });
    expect(config.rows[0]?.enabled).toBe(true);
  });
});
