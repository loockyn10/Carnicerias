import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { calculateBranchPromotionLinePricing, formatCurrency } from "@carnicerias/business-logic";
import { describe, expect, it } from "vitest";

import { ProductPriceLabel } from "../components/product-price-label";
import { buildProductLabel, labelFontSizesPt, LABEL_HEIGHT_MM, LABEL_WIDTH_MM, titleFitFor } from "./product-label";

const mayonesa = { name: "MAYONESA HELMANS 250gr", unitType: "UNIT" as const, listPriceCents: 203_500, unitBulkDiscountBps: 1_500 };
const render = (input: Parameters<typeof buildProductLabel>[0], scale?: number) => renderToStaticMarkup(<ProductPriceLabel label={buildProductLabel(input)} scale={scale} />);

describe("etiqueta de góndola 70 × 50 mm", () => {
  it("modela el tamaño físico en milímetros (relación 1,4) y no en px", () => {
    expect([LABEL_WIDTH_MM, LABEL_HEIGHT_MM]).toEqual([70, 50]);
    expect(LABEL_WIDTH_MM / LABEL_HEIGHT_MM).toBeCloseTo(1.4);
    const html = render(mayonesa);
    expect(html).toContain("width:70mm;height:50mm");
    expect(html).toContain('data-label-width-mm="70"');
    expect(html).toContain('data-label-height-mm="50"');
    expect(html).toContain("--label-price-font-size:28pt");
    expect(html).not.toMatch(/font-size:\s*[\d.]+px/);
  });

  it("el preview escalado conserva la relación de aspecto", () => {
    const html = render(mayonesa, 3);
    expect(html).toContain("width:calc(70mm * 3);height:calc(50mm * 3)");
  });

  it("jerarquía: nombre 70 %, aclaración 30 %, precio unitario 40 % del precio (28 pt → 19,6 / 8,4 / 11,2)", () => {
    const sizes = labelFontSizesPt();
    expect(sizes.price).toBe(28);
    expect(sizes.title).toBeCloseTo(19.6);
    expect(sizes.note).toBeCloseTo(8.4);
    expect(sizes.unitPrice).toBeCloseTo(11.2);
    const html = render(mayonesa);
    expect(html).toContain("--label-title-scale:0.7");
    expect(html).toContain("--label-note-scale:0.3");
    expect(html).toContain("--label-unit-price-scale:0.4");
    expect(html).toContain("calc(var(--label-price-font-size) * var(--label-title-scale)");
    expect(html).toContain("calc(var(--label-price-font-size) * var(--label-note-scale))");
    expect(labelFontSizesPt(20).title).toBeCloseTo(14);
  });

  it("promo UNIT: el precio principal es el efectivo «llevando 3» del motor del POS, con el formato de moneda del sistema", () => {
    const label = buildProductLabel(mayonesa);
    const engine = calculateBranchPromotionLinePricing({ listPriceCents: 203_500n, quantityUnits: 3, promotion: { id: "x", minimumUnits: 3, discountBps: 1_500 }, paymentMethod: "CASH", cashDiscountBps: 0n });
    expect(label.variant).toBe("BULK");
    expect(label.price).toBe(formatCurrency(engine?.cashPriceCents ?? -1n));
    expect(label.price).toBe("$ 1.729,75");
  });

  it("muestra «llevando 3 unidades», el precio unitario normal y nunca un «% OFF»", () => {
    const html = render(mayonesa);
    expect(html).toContain("llevando 3 unidades");
    expect(html).toContain("Precio unitario: $ 2.035");
    expect(html).toContain("MAYONESA HELMANS 250gr");
    expect(html).not.toMatch(/OFF|15\s?%/);
  });

  it("producto sin promo (0 % o sin configurar): precio normal y sin condición inventada", () => {
    for (const unitBulkDiscountBps of [0, null]) {
      const label = buildProductLabel({ ...mayonesa, unitBulkDiscountBps });
      expect(label.variant).toBe("REGULAR");
      expect(label.price).toBe("$ 2.035");
      expect(label.note).toBeNull();
      const html = render({ ...mayonesa, unitBulkDiscountBps });
      expect(html).not.toContain("llevando");
      expect(html).toContain("Precio unitario");
      expect(html).not.toContain('data-testid="label-note"');
    }
  });

  it("nombre largo: máximo 2 líneas y fuente reducida, sin desbordar", () => {
    expect(titleFitFor("YERBA \"AGUANTADORA\" X KG")).toBe(1);
    const long = "ACEITE DE GIRASOL \"NANOSOL\" X 900ML";
    const fit = titleFitFor(long);
    expect(fit).toBeLessThan(1);
    expect(fit).toBeGreaterThanOrEqual(0.6);
    expect(titleFitFor("X".repeat(300))).toBe(0.6);
    const html = render({ ...mayonesa, name: long });
    expect(html).toContain("-webkit-line-clamp:2");
    expect(html).toContain("overflow:hidden");
    expect(html).toContain(`--label-title-fit:${String(fit)}`);
    expect(html).toContain("overflow-hidden");
  });

  it("WEIGHT: fallback «$ 11.000/kg» sin promo ni «llevando»", () => {
    const html = render({ name: "MOLIDA VACUNA", unitType: "WEIGHT", listPriceCents: 1_100_000, unitBulkDiscountBps: 1_500 });
    expect(html).toContain("MOLIDA VACUNA");
    expect(html).toContain("$ 11.000");
    expect(html).toContain("/kg");
    expect(html).not.toContain("llevando");
    expect(html).not.toContain("Precio unitario");
  });

  it("sin precio vigente no inventa uno", () => {
    for (const listPriceCents of [null, 0]) {
      const label = buildProductLabel({ ...mayonesa, listPriceCents });
      expect(label.variant).toBe("NO_PRICE");
      expect(label.price).toBeNull();
      expect(render({ ...mayonesa, listPriceCents })).toContain("Sin precio");
    }
  });

  it("un precio muy largo achica toda la tipografía proporcionalmente", () => {
    const html = render({ ...mayonesa, listPriceCents: 123_456_789_00, unitBulkDiscountBps: null });
    expect(html).not.toContain("--label-price-font-size:28pt");
    expect(html).toContain("--label-title-scale:0.7");
  });

  it("reutiliza el pricing existente: sin fórmula de descuento propia en el módulo", () => {
    const source = readFileSync(new URL("./product-label.ts", import.meta.url), "utf8");
    expect(source).toContain("calculateBranchPromotionLinePricing");
    expect(source).toContain("formatCurrency");
    expect(source).not.toMatch(/10_?000/);
    expect(source).not.toMatch(/divideRoundHalfUp|Math\.round\([^)]*bps/i);
  });
});
