import { describe, expect, it } from "vitest";

import { describeMovementReference, groupAuditMovements, movementTypeLabel, quickSummary, INBOUND_TYPES } from "../stock-audit";

/** El ledger de stock es UNO solo: los movimientos de distribución se muestran y suman con los de siempre, y la fórmula del stock sigue cerrando. */
const total = (type: string, quantity: number, count = 1): Parameters<typeof groupAuditMovements>[0][number] => ({ type, count, quantity });

describe("movimientos de distribución en la auditoría de stock", () => {
  it("tienen etiqueta propia", () => {
    expect(movementTypeLabel("DISTRIBUTION_OUT")).toBe("Entrega a supermercado");
    expect(movementTypeLabel("DISTRIBUTION_RETURN")).toBe("Reingreso de paquete devuelto");
  });

  it("aparecen como grupos propios (no como «otros movimientos») sólo cuando hubo", () => {
    const rows = groupAuditMovements([total("DISTRIBUTION_OUT", -9_000, 4), total("DISTRIBUTION_RETURN", 1_100, 2)]);
    expect(rows.find((row) => row.key === "DISTRIBUTION_OUT")).toMatchObject({ label: "Entregas a supermercados", sign: "−", quantity: -9_000, count: 4 });
    expect(rows.find((row) => row.key === "DISTRIBUTION_RETURN")).toMatchObject({ sign: "+", quantity: 1_100 });
    expect(rows.some((row) => row.label.startsWith("Otros movimientos"))).toBe(false);
    expect(groupAuditMovements([]).some((row) => row.key === "DISTRIBUTION_OUT")).toBe(false);
  });

  it("el reingreso es una entrada real de mercadería y la entrega una salida: la fórmula cierra", () => {
    expect(INBOUND_TYPES).toContain("DISTRIBUTION_RETURN");
    const summary = quickSummary([total("PURCHASE", 20_000), total("SALE", -3_000), total("DISTRIBUTION_OUT", -9_000), total("DISTRIBUTION_RETURN", 1_100)]);
    expect(summary).toMatchObject({ entered: 21_100, sold: 3_000, otherOutflows: 9_000 });
    // apertura 0 + entró 21.100 − vendido 3.000 − merma 0 + ajustes 0 − otras salidas 9.000 = 9.100 = suma del ledger.
    expect(0 + summary.entered - summary.sold - summary.waste + summary.adjustments - summary.otherOutflows).toBe(20_000 - 3_000 - 9_000 + 1_100);
  });

  it("la referencia del movimiento es el motivo guardado (entrega o devolución)", () => {
    const base = { saleId: null, counterpartBranchName: null } as unknown as Parameters<typeof describeMovementReference>[0];
    expect(describeMovementReference({ ...base, type: "DISTRIBUTION_OUT", reason: "Entrega E-000003 a Sol - Centro" })).toBe("Entrega E-000003 a Sol - Centro");
    expect(describeMovementReference({ ...base, type: "DISTRIBUTION_RETURN", reason: null })).toBe("Distribución a supermercados");
  });
});
