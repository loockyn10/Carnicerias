import { describe, expect, it } from "vitest";

import { compareWithLastPrint, describeValues, freshnessText, needsPrinting } from "./label-changes";
import { buildLabelGroupView, parseLabelGroupFacts } from "./label-group";
import { buildProductLabel, type LabelValues } from "./product-label";

const bulk = { minimumUnits: 3, discountBps: 1_500 };
const valuesOf = (list: bigint, promo: typeof bulk | null = bulk, name = "Mayonesa Hellmann's"): LabelValues => {
  const values = buildProductLabel({ name, unitType: "UNIT", listPriceCents: list, bulk: promo }).values;
  if (!values) throw new Error("sin valores");
  return values;
};

describe("detección de etiquetas desactualizadas", () => {
  const printed = valuesOf(203_500n);

  it("nunca impresa → NEW (pendiente)", () => {
    expect(compareWithLastPrint(printed, null)).toEqual({ status: "NEW", reasons: [] });
    expect(needsPrinting("NEW")).toBe(true);
  });

  it("mismo precio y misma promoción → UPDATED", () => {
    expect(compareWithLastPrint(valuesOf(203_500n), printed)).toEqual({ status: "UPDATED", reasons: [] });
    expect(needsPrinting("UPDATED")).toBe(false);
  });

  it("el precio de lista cambió → CHANGED (PRICE); también cambia el precio de oferta derivado", () => {
    const result = compareWithLastPrint(valuesOf(225_000n), printed);
    expect(result.status).toBe("CHANGED");
    expect(result.reasons).toEqual(["PRICE"]);
    expect(needsPrinting(result.status)).toBe(true);
  });

  it("la promoción cambió con el mismo precio de lista → CHANGED (PROMO)", () => {
    for (const promo of [{ minimumUnits: 3, discountBps: 2_000 }, { minimumUnits: 4, discountBps: 1_500 }, null]) {
      expect(compareWithLastPrint(valuesOf(203_500n, promo), printed)).toEqual({ status: "CHANGED", reasons: ["PROMO"] });
    }
  });

  it("apareció una promoción donde antes no había → CHANGED (PROMO)", () => {
    const sinPromo = valuesOf(203_500n, null);
    expect(compareWithLastPrint(printed, sinPromo)).toEqual({ status: "CHANGED", reasons: ["PROMO"] });
  });

  it("cambió el nombre impreso → CHANGED (NAME)", () => {
    expect(compareWithLastPrint(valuesOf(203_500n, bulk, "Mayonesa Hellmann's 500gr"), printed)).toEqual({ status: "CHANGED", reasons: ["NAME"] });
  });

  it("compara valores exactos, no textos: $ 0,01 de diferencia ya es un cambio", () => {
    expect(compareWithLastPrint(valuesOf(203_501n), printed).status).toBe("CHANGED");
  });

  it("textos del estado para la lista", () => {
    expect(freshnessText({ status: "NEW", reasons: [] })).toBe("Nunca impresa");
    expect(freshnessText({ status: "UPDATED", reasons: [] })).toBe("Actualizada");
    expect(freshnessText({ status: "CHANGED", reasons: ["PRICE"] })).toBe("Precio cambió");
    expect(freshnessText({ status: "CHANGED", reasons: ["PRICE", "PROMO"] })).toBe("Precio cambió · Promo cambió");
    expect(freshnessText({ status: "CHANGED", reasons: ["PROMO"] })).toBe("Promo cambió");
  });

  it("describe lo impreso en una línea, con el formato de moneda del sistema", () => {
    expect(describeValues(valuesOf(205_000n), "UNIT")).toBe("$ 1.742,50 (3+ u) · normal $ 2.050");
    expect(describeValues(valuesOf(205_000n, null), "UNIT")).toBe("$ 2.050");
    expect(describeValues({ ...valuesOf(1_100_000n, null), displayedName: "MOLIDA" }, "WEIGHT")).toBe("$ 11.000/kg");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Sobre los hechos de la base (grupo completo): el flujo «imprimir → cambia el precio → reimprimir sólo lo cambiado»
// ---------------------------------------------------------------------------------------------------------------------

const MAYO = "11111111-1111-4111-8111-111111111111";
const ACEITE = "22222222-2222-4222-8222-222222222222";
const YERBA = "33333333-3333-4333-8333-333333333333";

function snapshot(values: LabelValues, runId: string) {
  return {
    runId, generatedAt: "2026-10-07T18:42:00.000Z", displayedName: values.displayedName, variant: values.promoPriceCents ? "PROMO" : "SIMPLE", copies: 1,
    listPriceCents: values.listPriceCents, promoPriceCents: values.promoPriceCents, promoMinimumUnits: values.promoMinimumUnits, promoDiscountBps: values.promoDiscountBps
  };
}

function groupPayload(prices: { mayo: number; aceite: number; yerba: number }, last: Record<string, unknown>) {
  const item = (productId: string, position: number, name: string, price: number, extra: Record<string, unknown> = {}) => ({
    productId, position, name, sku: null, unitType: "UNIT", available: true, unavailableReason: null, listPriceCents: String(price),
    bulkMinimumUnits: 3, bulkDiscountBps: 1_500, last: last[productId] ?? null, ...extra
  });
  return {
    groupId: "99999999-9999-4999-8999-999999999999", name: "Góndolas Despensa Central", branchId: null, branchName: null, active: true,
    items: [item(MAYO, 0, "Mayonesa Hellmann's", prices.mayo), item(ACEITE, 1, "Aceite Cañuelas", prices.aceite), item(YERBA, 2, "Yerba Aguantadora", prices.yerba)]
  };
}

describe("grupo: estado de cada etiqueta frente a la última impresión", () => {
  const view = (payload: unknown) => {
    const facts = parseLabelGroupFacts(payload);
    if (!facts) throw new Error("grupo inválido");
    return buildLabelGroupView(facts, "America/Argentina/Buenos_Aires");
  };
  const statuses = (payload: unknown) => view(payload).items.map((item) => item.freshness);

  it("grupo recién armado: todo pendiente (NEW) y «Seleccionar precios cambiados» lo incluye", () => {
    const result = view(groupPayload({ mayo: 203_500, aceite: 245_000, yerba: 410_000 }, {}));
    expect(result.items.map((item) => item.freshness)).toEqual(["NEW", "NEW", "NEW"]);
    expect(result.items.every((item) => item.needsPrint)).toBe(true);
  });

  it("después de imprimir todo: todo ACTUALIZADA; cambia un precio: sólo ese queda CHANGED", () => {
    const run1 = {
      [MAYO]: snapshot(valuesOf(203_500n), "r1"), [ACEITE]: snapshot(valuesOf(245_000n, bulk, "Aceite Cañuelas"), "r1"), [YERBA]: snapshot(valuesOf(410_000n, bulk, "Yerba Aguantadora"), "r1")
    };
    expect(statuses(groupPayload({ mayo: 203_500, aceite: 245_000, yerba: 410_000 }, run1))).toEqual(["UPDATED", "UPDATED", "UPDATED"]);

    const after = view(groupPayload({ mayo: 225_000, aceite: 245_000, yerba: 410_000 }, run1));
    expect(after.items.map((item) => item.freshness)).toEqual(["CHANGED", "UPDATED", "UPDATED"]);
    expect(after.items.map((item) => item.needsPrint)).toEqual([true, false, false]);
    const mayo = after.items[0];
    expect(mayo?.freshnessText).toBe("Precio cambió");
    expect(mayo?.lastPrintedText).toBe("$ 1.729,75 (3+ u) · normal $ 2.035");
    expect(mayo?.currentText).toBe("$ 1.912,50 (3+ u) · normal $ 2.250");
  });

  it("la nueva impresión pasa a ser la referencia: reimprimir lo cambiado lo deja ACTUALIZADA", () => {
    const run1 = { [MAYO]: snapshot(valuesOf(203_500n), "r1"), [ACEITE]: snapshot(valuesOf(245_000n, bulk, "Aceite Cañuelas"), "r1"), [YERBA]: snapshot(valuesOf(410_000n, bulk, "Yerba Aguantadora"), "r1") };
    const run2 = { ...run1, [MAYO]: snapshot(valuesOf(225_000n), "r2") };
    expect(statuses(groupPayload({ mayo: 225_000, aceite: 245_000, yerba: 410_000 }, run1))).toEqual(["CHANGED", "UPDATED", "UPDATED"]);
    expect(statuses(groupPayload({ mayo: 225_000, aceite: 245_000, yerba: 410_000 }, run2))).toEqual(["UPDATED", "UPDATED", "UPDATED"]);
  });

  it("un producto que dejó de ser imprimible no tiene estado y no se selecciona", () => {
    const payload = groupPayload({ mayo: 203_500, aceite: 245_000, yerba: 410_000 }, {});
    (payload.items[1] as Record<string, unknown>).unavailableReason = "NO_PRICE";
    (payload.items[1] as Record<string, unknown>).available = false;
    (payload.items[2] as Record<string, unknown>).listPriceCents = null;
    (payload.items[2] as Record<string, unknown>).unavailableReason = "INACTIVE";
    const result = view(payload);
    expect(result.items.map((item) => item.printable)).toEqual([true, false, false]);
    expect(result.items[1]).toMatchObject({ freshness: null, needsPrint: false, unavailableText: "Sin precio vigente", currentText: null });
    expect(result.items[2]?.unavailableText).toBe("Producto inactivo o no vendible");
    expect(result.items[1]?.layout.variant).toBe("NO_PRICE");
  });

  it("es defensivo con el JSON de la base: un producto raro se descarta sin romper el grupo", () => {
    const payload = groupPayload({ mayo: 203_500, aceite: 245_000, yerba: 410_000 }, {});
    (payload.items as unknown[]).push({ productId: 7, name: "raro" }, null, "x");
    expect(parseLabelGroupFacts(payload)?.items).toHaveLength(3);
    expect(parseLabelGroupFacts(null)).toBeNull();
    expect(parseLabelGroupFacts({ groupId: "a" })).toBeNull();
  });
});
