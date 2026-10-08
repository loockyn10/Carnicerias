import { calculateBranchPromotionLinePricing, formatCurrency } from "@carnicerias/business-logic";
import { describe, expect, it } from "vitest";

import { toLabelText } from "./label-font";
import { buildProductLabel, conditionText, labelDisplayName, type BulkPromotionFact } from "./product-label";

const bulk: BulkPromotionFact = { minimumUnits: 3, discountBps: 1_500 };
const unit = (name: string, listPriceCents: bigint | null, promo: BulkPromotionFact | null = bulk) => buildProductLabel({ name, unitType: "UNIT", listPriceCents, bulk: promo });

describe("contenido de la etiqueta: variante UNIT con «llevando 3u»", () => {
  it("Bicarbonato: SUPER OFERTAS, nombre, LLEVANDO 3 UNIDADES, precio promocional y precio normal", () => {
    const label = unit("Bicarbonato Alicante x 50", 90_000n);
    expect(label.variant).toBe("PROMO");
    expect(label.headline).toBe("SUPER OFERTAS");
    expect(label.name).toBe("BICARBONATO ALICANTE X 50");
    expect(label.conditionLine).toBe("LLEVANDO 3 UNIDADES");
    expect(label.discountLine).toBe("Descuento 15%");
    expect(label.price).toBe("$ 765");
    expect(label.normalLabel).toBe("PRECIO NORMAL");
    expect(label.normalPrice).toBe("$ 900");
    expect(label.values).toMatchObject({ listPriceCents: "90000", promoPriceCents: "76500", promoMinimumUnits: 3, promoDiscountBps: 1_500 });
  });

  it("Mayonesa: el precio promocional sale del motor de pricing del POS, no de una cuenta propia de la etiqueta", () => {
    const label = unit("Mayonesa Hellmann's 250gr", 205_000n);
    const engine = calculateBranchPromotionLinePricing({
      listPriceCents: 205_000n, quantityUnits: 3, promotion: { id: "x", minimumUnits: 3, discountBps: 1_500 }, paymentMethod: "CASH", cashDiscountBps: 0n
    });
    expect(label.name).toBe("MAYONESA HELLMANN'S 250GR");
    expect(label.price).toBe(formatCurrency(engine?.cashPriceCents ?? -1n));
    expect(label.price).toBe("$ 1.742,50");
    expect(label.normalPrice).toBe("$ 2.050");
  });

  it("respeta la cantidad mínima y el porcentaje de la regla de la sucursal (no asume 3 / 15 %)", () => {
    const label = unit("Fideos", 100_000n, { minimumUnits: 6, discountBps: 1_250 });
    expect(label.conditionLine).toBe("LLEVANDO 6 UNIDADES");
    expect(label.discountLine).toBe("Descuento 12,5%");
    expect(label.price).toBe("$ 875");
  });

  it("centavos: muestra el valor real del motor y no redondea a $ 50", () => {
    expect(unit("A", 625_000n).price).toBe("$ 5.312,50");
    expect(unit("B", 588_889n, { minimumUnits: 3, discountBps: 1_000 }).price).toBe("$ 5.300");
  });

  it("el texto de la condición para el historial incluye mínimo y porcentaje", () => {
    expect(conditionText(unit("X", 90_000n))).toBe("POR 3 UNIDADES - Descuento 15%");
    expect(conditionText(unit("X", 90_000n, null))).toBeNull();
  });
});

describe("contenido de la etiqueta: sin promoción no inventa ofertas", () => {
  it("sin regla, o con regla de 0 %: variante simple con precio unitario", () => {
    for (const promo of [null, { minimumUnits: 3, discountBps: 0 }]) {
      const label = unit("Mayonesa Hellmann's 250gr", 205_000n, promo);
      expect(label.variant).toBe("SIMPLE");
      expect(label.headline).toBe("SUPER OFERTAS");
      expect(label.conditionLine).toBeNull();
      expect(label.discountLine).toBeNull();
      expect(label.normalLabel).toBeNull();
      expect(label.price).toBe("$ 2.050");
      expect(label.footLabel).toBe("PRECIO UNITARIO");
      expect(label.values?.promoPriceCents).toBeNull();
    }
  });

  it("una regla inválida del motor (mínimo < 2) cae al precio unitario, nunca a una oferta falsa", () => {
    const label = unit("Mayonesa", 205_000n, { minimumUnits: 1, discountBps: 1_500 });
    expect(label.variant).toBe("SIMPLE");
    expect(label.headline).toBe("SUPER OFERTAS");
  });
});

describe("contenido de la etiqueta: WEIGHT y sin precio", () => {
  it("WEIGHT: precio por kg, sin oferta (aunque el grupo tenga regla «llevando N» de unidades)", () => {
    const label = buildProductLabel({ name: "Molida vacuna", unitType: "WEIGHT", listPriceCents: 1_100_000n, bulk });
    expect(label.variant).toBe("WEIGHT");
    expect(label.price).toBe("$ 11.000");
    expect(label.priceSuffix).toBe("/kg");
    expect(label.headline).toBe("SUPER OFERTAS");
    expect(label.footLabel).toBe("PRECIO POR KILO");
    expect(label.values?.promoPriceCents).toBeNull();
  });

  it("sin precio vigente (null o 0): no es imprimible y no tiene valores", () => {
    for (const price of [null, 0n]) {
      const label = unit("Sin precio", price);
      expect(label.variant).toBe("NO_PRICE");
      expect(label.price).toBe("SIN PRECIO");
      expect(label.values).toBeNull();
      expect(label.headline).toBe("SUPER OFERTAS");
    }
  });
});

describe("nombre impreso", () => {
  it("va en mayúsculas y conserva ñ, tildes y signos", () => {
    expect(labelDisplayName("  Aceite Cañuelas \"girasol\" 1,5L  ")).toBe("ACEITE CAÑUELAS \"GIRASOL\" 1,5L");
    expect(labelDisplayName("ñandú café")).toBe("ÑANDÚ CAFÉ");
  });

  it("nunca produce un carácter que el PDF no pueda dibujar (emoji, ideogramas, letras fuera de Latin-1)", () => {
    expect(toLabelText("Café ☕ 品 Ğ")).toBe("Café G");
    expect(labelDisplayName("Ïŝ µg")).toBe("ÏS G");
    expect(labelDisplayName("   ")).toBe("");
  });
});
