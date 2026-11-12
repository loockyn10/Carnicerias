import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../../app/admin/vacuum/distribution/actions", () => ({
  addDeliveryByQuantityAction: vi.fn(), addDeliveryPackageByCodeAction: vi.fn(), addDeliveryPackagesAction: vi.fn(), cancelDeliveryAction: vi.fn(), confirmDeliveryAction: vi.fn(),
  createDeliveryAction: vi.fn(), getAvailableSummaryAction: vi.fn(), getSiteReferenceAction: vi.fn(), listDistributablePackagesAction: vi.fn(), removeDeliveryPackagesAction: vi.fn(),
  closeReconciliationAction: vi.fn(), registerReturnsAction: vi.fn(), reportDeliverySalesAction: vi.fn(), reportDeliverySalesByCodesAction: vi.fn(), reportQuantitySalesAction: vi.fn(),
  decideReturnAction: vi.fn(), receiveReturnsAction: vi.fn(), startReturnInspectionAction: vi.fn()
}));
vi.mock("../../lib/vacuum-print-client", () => ({ printPackageLabels: vi.fn() }));

import { buildRemito } from "../../lib/distribution/logic";
import type { Delivery, Reconciliation, ReturnRow } from "../../lib/distribution/model";
import { NewDeliveryWorkspace } from "./new-delivery-workspace";
import { ReconciliationPanel } from "./reconciliation-panel";
import { RemitoDocument } from "./remito-document";
import { ReturnsBoard } from "./returns-board";
import { DeliveryStatusBadge, Kpi, OutcomeBadge, ReturnStatusBadge } from "./ui";

const delivery = (overrides: Partial<Delivery> = {}): Delivery => ({
  id: "d1", number: 7, numberLabel: "E-000007", status: "CONFIRMED", deliveryDate: "2026-11-09", commercialMode: "CONSIGNMENT", referenceDeliveryId: null, notes: "Dejar en cámara",
  originBranchId: "b1", originBranchName: "Central", site: { id: "s1", name: "Sol Centro", address: "Av. 1 123", city: "La Plata", phone: "221 555", contactName: "Marta" },
  client: { id: "c1", tradeName: "Supermercado Sol", legalName: "Sol S.A.", taxId: "20123456786" },
  recipient: { clientTradeName: "Supermercado Sol", clientLegalName: "Sol S.A.", taxId: "20123456786", siteName: "Sol Centro", address: "Av. 1 123", city: "La Plata", phone: "221 555", contactName: "Marta" },
  packageCount: 2, totalGrams: 1_250, totalCents: 1_875_000n, createdBy: "Fran", createdAt: "2026-11-08T12:00:00Z", confirmedBy: "Fran", confirmedAt: "2026-11-09T12:00:00Z", cancelReason: null,
  items: [
    { itemId: "i1", packageId: "p1", logisticCode: "7K3M9QX4S", productId: "v", productName: "Vacío de cerdo", weightGrams: 750, unitCents: 1_125_000n, lot: "CEN-261107-0001", packedOn: "2026-11-07", expiresOn: "2026-11-14", ean13: "2000120112506", outcome: "PENDING", soldOn: null },
    { itemId: "i2", packageId: "p2", logisticCode: "ABCDEFGH0", productId: "v", productName: "Vacío de cerdo", weightGrams: 500, unitCents: 750_000n, lot: "CEN-261107-0002", packedOn: "2026-11-07", expiresOn: "2026-11-14", ean13: "2000120075008", outcome: "PENDING", soldOn: null }
  ],
  stockShortfalls: [], alreadyConfirmed: false, ...overrides
});

describe("remito operativo", () => {
  const html = renderToStaticMarkup(<RemitoDocument remito={buildRemito(delivery())} timezone="America/Argentina/Buenos_Aires" />);

  it("dice que NO es un remito fiscal, arriba y al pie", () => {
    expect(html).toContain('data-testid="remito-disclaimer"');
    expect(html.match(/NO es un remito ni una factura fiscal/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("trae el número de entrega, el establecimiento, los productos, los kilos y los lotes", () => {
    expect(html).toContain("E-000007");
    expect(html).toContain("Sol Centro");
    expect(html).toContain("CUIT 20-12345678-6");
    expect(html).toContain("Vacío de cerdo");
    expect(html).toContain("1,250 kg");
    expect(html).toContain("CEN-261107-0001, CEN-261107-0002");
    expect(html).toContain('data-testid="remito-total-packages">2<');
  });

  it("lista cada paquete con su identificador logístico, no con el EAN comercial", () => {
    expect(html).toContain("7K3M9QX4S");
    expect(html).toContain("ABCDEFGH0");
    expect(html).not.toContain("2000120112506");
  });

  it("deja lugar para las firmas de quien entrega y quien recibe", () => {
    expect(html).toContain("Entregó (Carnicerías Fran)");
    expect(html).toContain("Recibió (nombre, firma y aclaración)");
  });

  it("un borrador se marca claramente como no despachado", () => {
    const draft = renderToStaticMarkup(<RemitoDocument remito={buildRemito(delivery({ status: "DRAFT", recipient: null, confirmedAt: null, confirmedBy: null }))} timezone="UTC" />);
    expect(draft).toContain("todavía no fue despachada");
  });
});

const reconciliation = (mode: "CONSIGNMENT" | "WHOLESALE", overrides: Partial<Reconciliation> = {}): Reconciliation => ({
  delivery: delivery({ commercialMode: mode }),
  products: [{ productId: "v", productName: "Vacío de cerdo", delivered: 10, soldFirm: 0, soldIdentified: 3, soldInferred: 2, returned: 1, returnPending: 1, pending: 3, overReported: false, estimatedInferredCents: 1_500_000n }],
  totals: { delivered: 10, soldFirm: 0, soldIdentified: 3, soldInferred: 2, returned: 1, returnPending: 1, pending: 3 },
  packages: [{ packageId: "p1", logisticCode: "7K3M9QX4S", productId: "v", productName: "Vacío de cerdo", weightGrams: 750, lot: "L1", expiresOn: "2026-11-01", expired: true, unitCents: 1_125_000n, outcome: "PENDING", soldOn: null, returnId: null, returnStatus: null }],
  quantityReports: [], closure: { closedAt: null, closedBy: null, note: null, pendingAtClose: null }, ...overrides
});

describe("conciliación de una entrega", () => {
  it("separa lo identificado de lo informado por cantidad (estimado) y muestra los pendientes", () => {
    const html = renderToStaticMarkup(<ReconciliationPanel history={[]} reconciliation={reconciliation("CONSIGNMENT")} today="2026-11-12" />);
    expect(html).toContain("Vendidos identificados");
    expect(html).toContain("Vendidos por cantidad (estimado)");
    expect(html).toContain("Pendientes");
    expect(html).toContain('data-testid="differences"');
    expect(html).toContain("3 Vacío de corte sin vender ni devolver".replace("Vacío de corte", "Vacío de cerdo"));
    expect(html).toContain("vencido en el supermercado");
  });

  it("en consignación ofrece informar vendidos por código y por cantidad, y registrar devoluciones", () => {
    const html = renderToStaticMarkup(<ReconciliationPanel history={[]} reconciliation={reconciliation("CONSIGNMENT")} today="2026-11-12" />);
    expect(html).toContain("Informar paquetes vendidos (identificados)");
    expect(html).toContain("Informar ventas sólo por cantidad");
    expect(html).toContain("NO se marca ningún paquete como vendido");
    expect(html).toContain("cuarentena");
  });

  it("en una venta mayorista firme no hay nada que informar como vendido (ya está vendida) pero sí se pueden registrar devoluciones", () => {
    const html = renderToStaticMarkup(<ReconciliationPanel history={[]} reconciliation={reconciliation("WHOLESALE")} today="2026-11-12" />);
    expect(html).not.toContain("Informar paquetes vendidos (identificados)");
    expect(html).not.toContain("Informar ventas sólo por cantidad");
    expect(html).toContain('data-testid="register-returns"');
  });

  it("una conciliación cerrada ya no acepta informes pero muestra el cierre", () => {
    const html = renderToStaticMarkup(<ReconciliationPanel history={[]} reconciliation={reconciliation("CONSIGNMENT", { closure: { closedAt: "2026-11-12T10:00:00Z", closedBy: "Fran", note: "El supermercado no devolvió uno", pendingAtClose: 1 } })} today="2026-11-12" />);
    expect(html).toContain("Conciliación cerrada");
    expect(html).toContain("con 1 sin explicar");
    expect(html).not.toContain("Informar paquetes vendidos (identificados)");
    expect(html).not.toContain("Cerrar la conciliación");
  });

  it("un borrador no se concilia", () => {
    const html = renderToStaticMarkup(<ReconciliationPanel history={[]} reconciliation={reconciliation("CONSIGNMENT", { delivery: delivery({ status: "DRAFT" }) })} today="2026-11-12" />);
    expect(html).not.toContain('data-testid="reconciliation-actions"');
  });
});

const returnRow = (overrides: Partial<ReturnRow> = {}): ReturnRow => ({
  id: "r1", status: "IN_QUARANTINE", reason: "UNSOLD", reasonNote: null, returnedOn: "2026-11-10", creditRequired: false, packagingState: "INTACT", conservationVerified: true, conservationNote: "A 3 °C",
  packageId: "p1", logisticCode: "7K3M9QX4S", productName: "Vacío de cerdo", weightGrams: 750, lot: "CEN-1", packedOn: "2026-11-07", expiresOn: "2026-11-20", expired: false, unitCents: 1_125_000n,
  deliveryId: "d1", deliveryLabel: "E-000007", siteName: "Sol Centro", clientName: "Supermercado Sol", registeredAt: "2026-11-10T10:00:00Z", receivedAt: "2026-11-11T10:00:00Z", decidedAt: null, decidedBy: null, decisionReason: null,
  ...overrides
});
const board = (row: ReturnRow) => renderToStaticMarkup(<ReturnsBoard rows={[row]} today="2026-11-12" />);

describe("devoluciones", () => {
  it("un paquete aún no recibido ofrece recibirlo en cuarentena y nada más", () => {
    const html = board(returnRow({ status: "PENDING_RECEIPT", receivedAt: null, packagingState: null, conservationVerified: null }));
    expect(html).toContain('data-testid="receive-form"');
    expect(html).toContain("Recibir en cuarentena");
    expect(html).not.toContain('data-testid="decision-form"');
  });

  it("un paquete en cuarentena ofrece inspeccionar y decidir, con el motivo obligatorio", () => {
    const html = board(returnRow());
    expect(html).toContain('data-testid="decision-form"');
    expect(html).toContain("Iniciar inspección");
    expect(html).toContain("Motivo de la decisión");
    expect(html).toContain("Aprobar reingreso");
    expect(html).toContain("Descartar");
  });

  it("el reingreso queda bloqueado (botón deshabilitado y explicado) si está vencido, con el envase dañado o sin conservación verificada", () => {
    const expired = board(returnRow({ expired: true, expiresOn: "2026-11-01" }));
    expect(expired).toContain("El paquete está vencido");
    expect(expired).toMatch(/data-testid="approve"[^>]*disabled=""|disabled=""[^>]*data-testid="approve"/);
    expect(board(returnRow({ packagingState: "VACUUM_LOST" }))).toContain("El envase no está intacto");
    expect(board(returnRow({ conservationVerified: false }))).toContain("conservación no están verificadas");
  });

  it("un paquete ya aprobado, descartado o rechazado... muestra la decisión con quién, cuándo y por qué", () => {
    const html = board(returnRow({ status: "APPROVED", decidedAt: "2026-11-12T09:00:00Z", decidedBy: "Fran", decisionReason: "Inspección conforme" }));
    expect(html).toContain("Decisión de Fran");
    expect(html).toContain("Inspección conforme");
    expect(html).not.toContain('data-testid="decision-form"');
    expect(html).not.toContain('data-testid="receive-form"');
  });

  it("un rechazado sólo se puede descartar", () => {
    const html = board(returnRow({ status: "REJECTED", decidedAt: "2026-11-12T09:00:00Z", decidedBy: "Fran", decisionReason: "Sin cadena de frío" }));
    expect(html).toContain('data-testid="decision-form"');
    expect(html).not.toContain("Aprobar reingreso");
    expect(html).toContain("Descartar");
  });

  it("avisa cuando la devolución viene de una venta mayorista firme (pendiente de nota de crédito)", () => {
    expect(board(returnRow({ creditRequired: true }))).toContain("Pendiente de nota de crédito");
  });
});

describe("pantalla de nueva entrega", () => {
  const sites = [{ id: "s1", clientName: "Supermercado Sol", siteName: "Sol Centro", mode: "CONSIGNMENT" as const, restockWeekday: 1, draftId: null, lastDelivery: { id: "d0", numberLabel: "E-000001", deliveryDate: "2026-11-02", packageCount: 40 } }];

  it("empieza por elegir el supermercado y la fecha; no hay paquetes ni botón de confirmar antes de crear el borrador", () => {
    const html = renderToStaticMarkup(<NewDeliveryWorkspace initialDraft={null} initialSiteId={null} originBranch={{ id: "b1", name: "Central" }} sites={sites} today="2026-11-12" />);
    expect(html).toContain("1 · Supermercado y fecha");
    expect(html).toContain("Supermercado Sol · Sol Centro");
    expect(html).toContain("Crear borrador de entrega");
    expect(html).not.toContain('data-testid="add-packages"');
    expect(html).not.toContain('data-testid="start-confirm"');
  });

  it("un borrador permite agregar por código, por cantidad o de la lista, y revisar antes de confirmar", () => {
    const html = renderToStaticMarkup(<NewDeliveryWorkspace initialDraft={delivery({ status: "DRAFT", recipient: null, confirmedAt: null, confirmedBy: null })} initialSiteId={null} originBranch={{ id: "b1", name: "Central" }} sites={sites} today="2026-11-12" />);
    expect(html).toContain('data-testid="add-packages"');
    expect(html).toContain("Escanear el identificador logístico");
    expect(html).toContain("Por cantidad");
    expect(html).toContain("Elegir de la lista");
    expect(html).toContain('data-testid="review-lines"');
    expect(html).toContain('data-testid="start-confirm"');
    expect(html).toContain("Cancelar el borrador");
    expect(html).toContain("código de barras comercial (EAN-13) no identifica un paquete");
  });

  it("una entrega ya despachada no se puede seguir editando desde esta pantalla", () => {
    const html = renderToStaticMarkup(<NewDeliveryWorkspace initialDraft={delivery()} initialSiteId={null} originBranch={{ id: "b1", name: "Central" }} sites={sites} today="2026-11-12" />);
    expect(html).toContain("ya no es un borrador");
    expect(html).not.toContain('data-testid="add-packages"');
    expect(html).not.toContain('data-testid="start-confirm"');
  });

  it("sin sucursal de producción avisa en vez de permitir preparar entregas", () => {
    expect(renderToStaticMarkup(<NewDeliveryWorkspace initialDraft={null} initialSiteId={null} originBranch={null} sites={sites} today="2026-11-12" />)).toContain("no tiene una sucursal de producción");
  });
});

describe("piezas visuales", () => {
  it("el KPI estimado se distingue del confirmado", () => {
    const estimated = renderToStaticMarkup(<Kpi label="Vendidos (por cantidad)" tone="estimate" value={6} />);
    expect(estimated).toContain("ESTIMADO");
    expect(estimated).toContain('data-tone="estimate"');
    expect(renderToStaticMarkup(<Kpi label="Vendidos confirmados" value={20} />)).not.toContain("ESTIMADO");
  });

  it("las insignias usan los textos del dominio", () => {
    expect(renderToStaticMarkup(<DeliveryStatusBadge status="CONFIRMED" />)).toContain("Despachada");
    expect(renderToStaticMarkup(<OutcomeBadge outcome="SOLD_REPORTED" />)).toContain("Vendido (informado)");
    expect(renderToStaticMarkup(<ReturnStatusBadge status="IN_QUARANTINE" />)).toContain("Recibido en cuarentena");
  });
});
