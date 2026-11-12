import { describe, expect, it } from "vitest";

import { VACUUM_PACKAGE_STATUS_LABELS, VACUUM_PACKAGE_STATUSES, VACUUM_CONFLICT_REASON_LABELS, parseVacuumPackage } from "../vacuum";
import {
  buildRemito, daysUntil, formatPct, groupItemsByProduct, nextRestockDate, overallRotation, reconciliationDifferences, REMITO_DISCLAIMER, returnGate, suggestReplenishment, topReturns, topSold
} from "./logic";
import {
  parseAvailableSummary, parseDeliveriesPage, parseDelivery, parseDistributionClients, parseDistributionStats, parseReconciliation, parseReferenceDelivery, parseReturnsPage,
  type Delivery, type DeliveryItem, type Reconciliation, type StatsProduct
} from "./model";

const item = (overrides: Partial<DeliveryItem> = {}): DeliveryItem => ({
  itemId: "i1", packageId: "p1", logisticCode: "7K3M9QX4S", productId: "vacio", productName: "Vacío", weightGrams: 750, unitCents: 1_125_000n, lot: "CEN-261107-0001",
  packedOn: "2026-11-07", expiresOn: "2026-11-14", ean13: "2000120112506", outcome: "PENDING", soldOn: null, ...overrides
});

const delivery = (overrides: Partial<Delivery> = {}): Delivery => ({
  id: "d1", number: 7, numberLabel: "E-000007", status: "CONFIRMED", deliveryDate: "2026-11-09", commercialMode: "CONSIGNMENT", referenceDeliveryId: null, notes: null,
  originBranchId: "b1", originBranchName: "Central", site: { id: "s1", name: "Sol Centro", address: "Av. 1 123", city: "La Plata", phone: null, contactName: null },
  client: { id: "c1", tradeName: "Supermercado Sol", legalName: "Sol S.A.", taxId: "20123456786" },
  recipient: { clientTradeName: "Supermercado Sol (al confirmar)", clientLegalName: "Sol S.A.", taxId: "20123456786", siteName: "Sol Centro", address: "Av. 1 123", city: "La Plata", phone: null, contactName: "Marta" },
  packageCount: 3, totalGrams: 1_850, totalCents: 2_475_000n, createdBy: "Fran", createdAt: "2026-11-08T12:00:00Z", confirmedBy: "Fran", confirmedAt: "2026-11-09T09:00:00Z", cancelReason: null,
  items: [item(), item({ itemId: "i2", packageId: "p2", logisticCode: "AAAAAAAA0", weightGrams: 500, unitCents: 750_000n, lot: "CEN-261107-0002", expiresOn: "2026-11-12" }),
    item({ itemId: "i3", packageId: "p3", productId: "asado", productName: "Asado", weightGrams: 600, unitCents: 600_000n, lot: "CEN-261107-0003" })],
  stockShortfalls: [], alreadyConfirmed: false, ...overrides
});

describe("lectura de las RPC de Distribución", () => {
  it("una entrega con importes en texto se lee como bigint", () => {
    const parsed = parseDelivery({
      id: "d1", number: 1, numberLabel: "E-000001", status: "CONFIRMED", deliveryDate: "2026-11-09", commercialMode: "WHOLESALE", originBranchId: "b", originBranchName: "Central",
      site: { id: "s", name: "Sol" }, client: { id: "c", tradeName: "Sol" }, packageCount: 2, totalGrams: "1250", totalCents: "1875000", recipient: { siteName: "Sol", clientTradeName: "Sol" },
      items: [{ itemId: "i", packageId: "p", logisticCode: "7K3M9QX4S", productId: "v", productName: "Vacío", weightGrams: 750, unitCents: "1125000", lot: "L", packedOn: "2026-11-07", expiresOn: "2026-11-14", ean13: "2000120112506", outcome: "SOLD_FIRM" }],
      stockShortfalls: [{ productId: "v", productName: "Vacío", stockGrams: "-750" }]
    });
    expect(parsed).toMatchObject({ commercialMode: "WHOLESALE", totalGrams: 1250, totalCents: 1_875_000n });
    expect(parsed?.items[0]).toMatchObject({ unitCents: 1_125_000n, outcome: "SOLD_FIRM" });
    expect(parsed?.stockShortfalls[0]?.stockGrams).toBe(-750);
  });

  it("valores desconocidos caen en el caso más conservador y una respuesta vacía no rompe", () => {
    expect(parseDelivery(null)).toBeNull();
    expect(parseDelivery({ id: "x", status: "???", commercialMode: "???", items: [{ outcome: "???" }] })).toMatchObject({ status: "DRAFT", commercialMode: "CONSIGNMENT" });
    expect(parseDelivery({ id: "x", items: [{ outcome: "???" }] })?.items[0]?.outcome).toBe("PENDING");
    expect(parseDistributionClients(undefined)).toEqual([]);
    expect(parseDeliveriesPage(null)).toEqual({ total: 0, rows: [] });
    expect(parseReturnsPage({})).toEqual({ total: 0, rows: [] });
    expect(parseReferenceDelivery({})).toBeNull();
    expect(parseReconciliation({})).toBeNull();
    expect(parseAvailableSummary(null)).toEqual([]);
  });

  it("clientes con sus establecimientos, modalidad efectiva y última entrega", () => {
    const [client] = parseDistributionClients([{
      id: "c", tradeName: "Sol", legalName: null, taxId: "20123456786", commercialMode: "CONSIGNMENT", notes: null, active: true,
      sites: [{ id: "s", name: "Sol Centro", restockWeekday: 1, commercialMode: null, effectiveMode: "CONSIGNMENT", active: true, lastDelivery: { id: "d", numberLabel: "E-000001", deliveryDate: "2026-11-02", packageCount: 40 }, draftId: null },
        { id: "s2", name: "Sol Norte", restockWeekday: null, commercialMode: "WHOLESALE", effectiveMode: "WHOLESALE", active: false, lastDelivery: null, draftId: "dd" }]
    }]);
    expect(client?.sites).toHaveLength(2);
    expect(client?.sites[0]).toMatchObject({ restockWeekday: 1, commercialMode: null, lastDelivery: { packageCount: 40 } });
    expect(client?.sites[1]).toMatchObject({ commercialMode: "WHOLESALE", draftId: "dd", active: false, lastDelivery: null });
  });

  it("las estadísticas separan lo confirmado de lo estimado", () => {
    const stats = parseDistributionStats({
      from: "2026-10-14", to: "2026-11-12", activeClients: 2, activeSites: 3, deliveries: 4, delivered: { packages: 40, grams: "30000", cents: "45000000" },
      confirmed: { packages: 20, firmPackages: 5, identifiedPackages: 15, grams: "15000", cents: "22000000" }, estimated: { packages: 6, cents: "9000000" },
      returned: { packages: 10, grams: "7000" }, pending: { packages: 4 }, products: [{ productId: "v", productName: "Vacío", delivered: 40, soldConfirmed: 20, soldEstimated: 6, returned: 10, rotationConfirmedPct: 50, returnPct: "25.0" }], sites: []
    });
    expect(stats.confirmed.cents).toBe(22_000_000n);
    expect(stats.estimated.cents).toBe(9_000_000n);
    expect(stats.products[0]?.returnPct).toBe(25);
    expect(stats.products[0]?.rotationWithEstimatePct).toBeNull();
  });
});

describe("preparación de entregas", () => {
  it("agrupa los paquetes por producto con kilos, valor, lotes y el vencimiento más próximo", () => {
    const lines = groupItemsByProduct(delivery().items);
    expect(lines.map((line) => line.productName)).toEqual(["Asado", "Vacío"]);
    expect(lines[1]).toMatchObject({ packages: 2, grams: 1250, cents: 1_875_000n, nextExpiry: "2026-11-12" });
    expect(lines[1]?.lots).toEqual(["CEN-261107-0001", "CEN-261107-0002"]);
  });

  it("la reposición propone las cantidades de la entrega anterior acotadas a lo disponible (nunca crea nada sola)", () => {
    const reference = parseReferenceDelivery({
      id: "d", numberLabel: "E-000001", deliveryDate: "2026-11-02", packageCount: 40,
      products: [{ productId: "v", productName: "Vacío", quantity: 25, grams: "20000" }, { productId: "a", productName: "Asado", quantity: 15, grams: "9000" }, { productId: "p", productName: "Peceto", quantity: 4, grams: "3000" }]
    });
    const suggestions = suggestReplenishment(reference, [{ productId: "v", productName: "Vacío", packages: 30, grams: 24000, nextExpiry: null }, { productId: "a", productName: "Asado", packages: 10, grams: 6000, nextExpiry: null }]);
    expect(suggestions.map((entry) => [entry.productName, entry.quantity, entry.missing])).toEqual([["Vacío", 25, 0], ["Asado", 10, 5], ["Peceto", 0, 4]]);
  });

  it("sin entrega anterior no hay propuesta", () => {
    expect(suggestReplenishment(null, [])).toEqual([]);
  });

  it("el día habitual de reposición: próximo lunes desde un jueves, y hoy mismo si ya es lunes", () => {
    expect(nextRestockDate(1, "2026-11-12")).toBe("2026-11-16");
    expect(nextRestockDate(1, "2026-11-16")).toBe("2026-11-16");
    expect(nextRestockDate(7, "2026-11-12")).toBe("2026-11-15");
    expect(nextRestockDate(null, "2026-11-12")).toBeNull();
    expect(nextRestockDate(9, "2026-11-12")).toBeNull();
  });

  it("días hasta el vencimiento", () => {
    expect(daysUntil("2026-11-14", "2026-11-12")).toBe(2);
    expect(daysUntil("2026-11-11", "2026-11-12")).toBe(-1);
  });
});

describe("remito operativo", () => {
  it("es un documento operativo y lo dice: no es un remito ni una factura fiscal", () => {
    const remito = buildRemito(delivery());
    expect(remito.disclaimer).toBe(REMITO_DISCLAIMER);
    expect(remito.disclaimer).toContain("NO es un remito ni una factura fiscal");
    expect(remito.title).toBe("REMITO OPERATIVO DE ENTREGA");
  });

  it("identifica la entrega, el establecimiento, los productos, los kilos y los lotes", () => {
    const remito = buildRemito(delivery());
    expect(remito).toMatchObject({ numberLabel: "E-000007", statusLabel: "Despachada", deliveryDate: "09/11/2026", originBranchName: "Central", commercialModeLabel: "Consignación", isDraft: false });
    expect(remito.lines).toEqual([
      { productName: "Asado", packages: 1, kilograms: "0,600 kg", value: "$6.000", lots: "CEN-261107-0003" },
      { productName: "Vacío", packages: 2, kilograms: "1,250 kg", value: "$18.750", lots: "CEN-261107-0001, CEN-261107-0002" }
    ]);
    expect(remito.totals).toEqual({ packages: 3, kilograms: "1,850 kg", value: "$24.750" });
    expect(remito.packages[0]).toMatchObject({ code: "7K3M9QX4S", lot: "CEN-261107-0001", expiresOn: "14/11/2026" });
  });

  it("usa los datos del destinatario congelados al confirmar y muestra el CUIT con guiones", () => {
    const remito = buildRemito(delivery());
    expect(remito.recipient.name).toBe("Supermercado Sol (al confirmar)");
    expect(remito.recipient.taxId).toBe("20-12345678-6");
    expect(remito.recipient.contactName).toBe("Marta");
  });

  it("un borrador se marca como tal (no es un remito de nada despachado)", () => {
    const remito = buildRemito(delivery({ status: "DRAFT", recipient: null, confirmedAt: null, confirmedBy: null }));
    expect(remito.isDraft).toBe(true);
    expect(remito.statusLabel).toContain("Borrador");
    expect(remito.recipient.name).toBe("Supermercado Sol");
  });
});

describe("conciliación: diferencias detectadas", () => {
  const base = (overrides: Partial<Reconciliation> = {}): Reconciliation => ({
    delivery: delivery(), products: [], totals: { delivered: 0, soldFirm: 0, soldIdentified: 0, soldInferred: 0, returned: 0, returnPending: 0, pending: 0 }, packages: [], quantityReports: [],
    closure: { closedAt: null, closedBy: null, note: null, pendingAtClose: null }, ...overrides
  });
  const product = (overrides: Partial<Reconciliation["products"][number]>): Reconciliation["products"][number] => ({
    productId: "v", productName: "Vacío", delivered: 10, soldFirm: 0, soldIdentified: 0, soldInferred: 0, returned: 0, returnPending: 0, pending: 0, overReported: false, estimatedInferredCents: 0n, ...overrides
  });

  it("sin diferencias cuando todo está explicado", () => {
    expect(reconciliationDifferences(base({ products: [product({})] }))).toEqual([]);
  });

  it("paquetes sin vender ni devolver", () => {
    expect(reconciliationDifferences(base({ products: [product({ pending: 3 })] }))).toEqual([{ kind: "UNEXPLAINED", productName: "Vacío", quantity: 3, message: "3 Vacío sin vender ni devolver" }]);
  });

  it("informes de más", () => {
    expect(reconciliationDifferences(base({ products: [product({ pending: -2, overReported: true })] }))[0]).toMatchObject({ kind: "OVER_REPORTED", quantity: 2 });
  });

  it("paquetes vencidos que siguen en el supermercado (sin devolución en curso)", () => {
    const pkg = { packageId: "p", logisticCode: null, productId: "v", productName: "Vacío", weightGrams: 500, lot: "L", expiresOn: "2026-11-01", expired: true, unitCents: 1n, outcome: "PENDING" as const, soldOn: null, returnId: null, returnStatus: null };
    const differences = reconciliationDifferences(base({ products: [product({})], packages: [pkg, { ...pkg, packageId: "q", returnId: "r", returnStatus: "PENDING_RECEIPT" }] }));
    expect(differences).toEqual([{ kind: "EXPIRED_AT_SUPERMARKET", productName: "Vacío", quantity: 1, message: "1 Vacío vencido en el supermercado" }]);
  });
});

describe("devoluciones: qué se puede hacer", () => {
  const row = { status: "IN_QUARANTINE" as const, expiresOn: "2026-11-20", packagingState: "INTACT" as const, conservationVerified: true };

  it("un paquete intacto, verificado y vigente se puede aprobar", () => {
    expect(returnGate(row, "2026-11-12")).toEqual({ canReceive: false, canStartInspection: true, canDecide: true, approveBlockers: [] });
  });

  it("nunca se aprueba vencido, con el envase dañado o sin conservación verificada", () => {
    expect(returnGate({ ...row, expiresOn: "2026-11-11" }, "2026-11-12").approveBlockers).toEqual(["El paquete está vencido"]);
    expect(returnGate({ ...row, packagingState: "VACUUM_LOST" }, "2026-11-12").approveBlockers).toEqual(["El envase no está intacto"]);
    expect(returnGate({ ...row, packagingState: null }, "2026-11-12").approveBlockers).toEqual(["Falta informar el estado del envase"]);
    expect(returnGate({ ...row, conservationVerified: false }, "2026-11-12").approveBlockers).toEqual(["Las condiciones de conservación no están verificadas"]);
    expect(returnGate({ ...row, conservationVerified: null }, "2026-11-12").approveBlockers).toHaveLength(1);
  });

  it("un paquete aún no recibido sólo se puede recibir; uno ya decidido no admite nada", () => {
    expect(returnGate({ ...row, status: "PENDING_RECEIPT" }, "2026-11-12")).toMatchObject({ canReceive: true, canDecide: false });
    expect(returnGate({ ...row, status: "APPROVED" }, "2026-11-12")).toMatchObject({ canReceive: false, canDecide: false });
    expect(returnGate({ ...row, status: "DISCARDED" }, "2026-11-12").canDecide).toBe(false);
  });

  it("un paquete rechazado todavía se puede descartar", () => {
    expect(returnGate({ ...row, status: "REJECTED" }, "2026-11-12").canDecide).toBe(true);
  });
});

describe("estadísticas: rankings y rotación", () => {
  const stat = (overrides: Partial<StatsProduct>): StatsProduct => ({
    productId: "x", productName: "X", categoryName: null, delivered: 10, grams: 1, deliveredCents: 1n, soldConfirmed: 0, soldConfirmedCents: 0n, soldEstimated: 0, soldEstimatedCents: 0n, returned: 0, pending: 0,
    rotationConfirmedPct: null, rotationWithEstimatePct: null, returnPct: null, ...overrides
  });

  it("cortes más vendidos: confirmado + estimado, sin los que no vendieron", () => {
    const ranking = topSold([stat({ productName: "A", soldConfirmed: 2 }), stat({ productName: "B", soldConfirmed: 5, soldEstimated: 1 }), stat({ productName: "C" }), stat({ productName: "D", soldEstimated: 4 })]);
    expect(ranking.map((entry) => entry.productName)).toEqual(["B", "D", "A"]);
  });

  it("cortes con más devoluciones: exige un mínimo de paquetes para que 1 de 1 no engañe", () => {
    const ranking = topReturns([stat({ productName: "A", delivered: 1, returned: 1, returnPct: 100 }), stat({ productName: "B", delivered: 10, returned: 4, returnPct: 40 }), stat({ productName: "C", delivered: 8, returned: 1, returnPct: 12.5 }), stat({ productName: "D", delivered: 20, returned: 0, returnPct: 0 })]);
    expect(ranking.map((entry) => entry.productName)).toEqual(["B", "C"]);
  });

  it("rotación general: confirmada y, aparte, con la estimación", () => {
    const stats = parseDistributionStats({ delivered: { packages: 40 }, confirmed: { packages: 20 }, estimated: { packages: 6 } });
    expect(overallRotation(stats)).toEqual({ confirmedPct: 50, withEstimatePct: 65 });
    expect(overallRotation(parseDistributionStats({}))).toEqual({ confirmedPct: null, withEstimatePct: null });
  });

  it("porcentajes con coma y guion cuando no hay dato", () => {
    expect(formatPct(42.9)).toBe("42,9 %");
    expect(formatPct(null)).toBe("—");
  });
});

describe("compatibilidad con Envasados y el POS", () => {
  it("el paquete lee su código logístico (null en registros viejos)", () => {
    expect(parseVacuumPackage({ id: "p", logisticCode: "7K3M9QX4S" })?.logisticCode).toBe("7K3M9QX4S");
    expect(parseVacuumPackage({ id: "p" })?.logisticCode).toBeNull();
  });

  it("los estados nuevos del paquete tienen texto y ninguno se confunde con «Disponible»", () => {
    for (const status of VACUUM_PACKAGE_STATUSES) expect(VACUUM_PACKAGE_STATUS_LABELS[status]).not.toBe("");
    expect(VACUUM_PACKAGE_STATUS_LABELS.DISPATCHED).toContain("supermercado");
    expect(VACUUM_PACKAGE_STATUS_LABELS.QUARANTINE).toContain("cuarentena");
    expect(new Set(VACUUM_PACKAGE_STATUSES.map((status) => VACUUM_PACKAGE_STATUS_LABELS[status])).size).toBe(VACUUM_PACKAGE_STATUSES.length);
  });

  it("el conflicto DISTRIBUTED del POS tiene explicación", () => {
    expect(VACUUM_CONFLICT_REASON_LABELS.DISTRIBUTED).toContain("despachado");
  });
});
