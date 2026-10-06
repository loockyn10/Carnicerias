import type { BranchUnitPromotion } from "@carnicerias/business-logic";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TicketLineDetail } from "./TicketLineDetail";
import { applyManualPrice, buildUnitTicketLine, buildWeightTicketLine, type DiscountRule } from "./lib/ticket-pricing";

const molida = { productId: "molida", productName: "MOLIDA VACUNA", pricePerKgCents: 1_100_000n };
const promo: DiscountRule = {
  id: "thr", productId: "molida", branchId: null, promotionMode: "THRESHOLD", minimumGrams: 2_000, discountType: "FIXED_PRICE_PER_KG",
  discountValue: "800000", packQuantityGrams: null, packQuantityUnits: null, packPriceCents: null
};
const render = (line: Parameters<typeof TicketLineDetail>[0]["line"]) => renderToStaticMarkup(<TicketLineDetail line={line} />);
const weight = (discounts: DiscountRule[]) => buildWeightTicketLine(molida, 2_000, "w", false, null, discounts, "b", "CASH", 0n);

describe("TicketLineDetail", () => {
  it("WEIGHT con descuento: precio lista · precio/kg final en verde, sin la línea 'Descuento'", () => {
    const html = render(weight([promo]));
    expect(html).toContain("2,000 kg × $ 11.000/kg");
    expect(html).toMatch(/text-emerald-400[^>]*data-testid="final-price-per-kg">\$ 8\.000\/kg final</);
    expect(html).not.toContain("Descuento");
  });

  it("WEIGHT sin descuento no duplica el precio", () => {
    const html = render(weight([]));
    expect(html).toContain("2,000 kg × $ 11.000/kg");
    expect(html).not.toContain("final");
  });

  it("UNIT sin promoción no muestra precio final ni duplica el precio", () => {
    const html = render(buildUnitTicketLine({ productId: "c", productName: "Coca", pricePerKgCents: 120_000n }, 2, "u", null, "CASH", 0n));
    expect(html).toContain("2 u · $ 1.200/u");
    expect(html).not.toContain("final");
  });

  it("WEIGHT con precio manual conserva el bloque manual sin repetir el precio", () => {
    const html = render(applyManualPrice(weight([]), 900_000n));
    expect(html).toContain("Precio manual");
    expect(html).not.toContain("final");
  });

  describe("UNIT", () => {
    const yerba = { productId: "yerba", productName: 'YERBA "AGUANTADORA" X KG', pricePerKgCents: 540_000n };
    const FROM_3_15: BranchUnitPromotion = { id: "promo", minimumUnits: 3, discountBps: 1_500 };
    const unit = (units: number, promotion: BranchUnitPromotion | null = FROM_3_15, method: Parameters<typeof buildUnitTicketLine>[4] = "CASH") =>
      buildUnitTicketLine(yerba, units, "u", null, method, 1_000n, { branchPromotion: promotion });

    it("3 u con 15 % desde 3: '3 u × $5.400/u · $4.590/u final' en verde, sin 'Desde 3 u', '15% OFF' ni 'Descuento'", () => {
      const line = unit(3);
      expect(line.subtotalCents).toBe(1_377_000n); // el total que se cobra no cambia
      const html = render(line);
      expect(html).toContain("3 u × $ 5.400/u");
      expect(html).toMatch(/text-emerald-400[^>]*data-testid="final-price-per-kg">\$ 4\.590\/u final</);
      expect(html).not.toContain("Desde 3 u");
      expect(html).not.toContain("15% OFF");
      expect(html).not.toContain("Descuento");
      expect(html).not.toContain("2.430");
    });

    it("debajo del mínimo: '2 u · $5.400/u' sin precio final", () => {
      const html = render(unit(2));
      expect(html).toContain("2 u · $ 5.400/u");
      expect(html).not.toContain("final");
    });

    it("sin promoción: '1 u · $5.400/u' sin precio final duplicado", () => {
      const html = render(unit(1, null));
      expect(html).toContain("1 u · $ 5.400/u");
      expect(html).not.toContain("final");
    });

    it("precio manual conserva el bloque manual y no repite el precio", () => {
      const html = render(applyManualPrice(unit(3), 400_000n));
      expect(html).toContain("Precio manual");
      expect(html).toContain("3 u × ");
      expect(html).not.toContain("final");
      expect(html).not.toContain("Descuento");
    });

    it("con Tarjeta el precio final incluye el recargo (lo que realmente se cobra)", () => {
      expect(render(unit(3, FROM_3_15, "DEBIT"))).toContain("$ 5.049/u final");
    });

    it("Pack UNIT: conserva su cantidad y etiqueta de pack, agrega el precio final y no muestra 'Descuento'", () => {
      const line = buildUnitTicketLine({ productId: "leche", productName: "Leche", pricePerKgCents: 100_000n }, 8, "p", null, "CASH", 0n, {
        packSale: { packCount: 1, packSizeUnits: 8, packDiscountBps: 2_000, packConfigId: "cfg" }
      });
      const html = render(line);
      expect(html).toContain("1 pack × 8 u = 8 unidades · $ 1.000/u");
      expect(html).toContain("$ 800/u final");
      expect(html).toContain("Pack 20% OFF");
      expect(html).not.toContain("Descuento");
    });
  });
});
