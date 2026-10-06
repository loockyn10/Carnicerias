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

  it("UNIT no muestra precio/kg final", () => {
    const html = render(buildUnitTicketLine({ productId: "c", productName: "Coca", pricePerKgCents: 120_000n }, 2, "u", null, "CASH", 0n));
    expect(html).not.toContain("final");
  });

  it("WEIGHT con precio manual conserva el bloque manual sin repetir el precio", () => {
    const html = render(applyManualPrice(weight([]), 900_000n));
    expect(html).toContain("Precio manual");
    expect(html).not.toContain("final");
  });
});
