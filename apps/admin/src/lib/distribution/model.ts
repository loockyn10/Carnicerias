import { asArray, asRecord, bool, cents, int, intOrNull, str, strOrNull } from "../rpc-json";

/**
 * Distribución a supermercados: tipos y lectura de las RPC de las migraciones 202611120097 y 202611120098. Cada pantalla parsea UNA vez acá y trabaja con tipos
 * fuertes: los importes en centavos llegan como texto (bigint) y nunca se convierten a número de coma flotante.
 */

export const COMMERCIAL_MODES = ["WHOLESALE", "CONSIGNMENT"] as const;
export type CommercialMode = (typeof COMMERCIAL_MODES)[number];
export const COMMERCIAL_MODE_LABELS: Record<CommercialMode, string> = { WHOLESALE: "Venta mayorista", CONSIGNMENT: "Consignación" };
export const COMMERCIAL_MODE_HINTS: Record<CommercialMode, string> = {
  WHOLESALE: "Venta firme: la operación comercial ocurre al entregar.",
  CONSIGNMENT: "Despachar no es vender: se vende cuando el supermercado lo informa."
};

function mode(value: unknown): CommercialMode {
  return value === "WHOLESALE" ? "WHOLESALE" : "CONSIGNMENT";
}

export const WEEKDAY_LABELS = ["", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"] as const;

export interface DistributionSite {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  contactName: string | null;
  notes: string | null;
  restockWeekday: number | null;
  commercialMode: CommercialMode | null;
  effectiveMode: CommercialMode;
  active: boolean;
  lastDelivery: { id: string; numberLabel: string; deliveryDate: string; packageCount: number } | null;
  draftId: string | null;
}

export interface DistributionClient {
  id: string;
  tradeName: string;
  legalName: string | null;
  taxId: string | null;
  commercialMode: CommercialMode;
  notes: string | null;
  active: boolean;
  sites: DistributionSite[];
}

export function parseDistributionClients(value: unknown): DistributionClient[] {
  return asArray(value).map((entry) => {
    const record = asRecord(entry);
    return {
      id: str(record.id), tradeName: str(record.tradeName), legalName: strOrNull(record.legalName), taxId: strOrNull(record.taxId), commercialMode: mode(record.commercialMode),
      notes: strOrNull(record.notes), active: bool(record.active),
      sites: asArray(record.sites).map((siteEntry) => {
        const site = asRecord(siteEntry);
        const last = asRecord(site.lastDelivery);
        return {
          id: str(site.id), name: str(site.name), address: strOrNull(site.address), city: strOrNull(site.city), phone: strOrNull(site.phone), contactName: strOrNull(site.contactName),
          notes: strOrNull(site.notes), restockWeekday: intOrNull(site.restockWeekday), commercialMode: site.commercialMode === null || site.commercialMode === undefined ? null : mode(site.commercialMode),
          effectiveMode: mode(site.effectiveMode), active: bool(site.active),
          lastDelivery: str(last.id) === "" ? null : { id: str(last.id), numberLabel: str(last.numberLabel), deliveryDate: str(last.deliveryDate), packageCount: int(last.packageCount) },
          draftId: strOrNull(site.draftId)
        };
      })
    };
  }).filter((client) => client.id !== "");
}

// ---------------------------------------------------------------------------------------------------------------------
// Entregas
// ---------------------------------------------------------------------------------------------------------------------

export const DELIVERY_STATUSES = ["DRAFT", "CONFIRMED", "CANCELLED"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = { DRAFT: "Borrador", CONFIRMED: "Despachada", CANCELLED: "Cancelada" };

export const ITEM_OUTCOMES = ["PENDING", "SOLD_FIRM", "SOLD_REPORTED", "RETURNED"] as const;
export type ItemOutcome = (typeof ITEM_OUTCOMES)[number];
export const ITEM_OUTCOME_LABELS: Record<ItemOutcome, string> = {
  PENDING: "En el supermercado", SOLD_FIRM: "Vendido (mayorista firme)", SOLD_REPORTED: "Vendido (informado)", RETURNED: "Devuelto"
};

function deliveryStatus(value: unknown): DeliveryStatus {
  return (DELIVERY_STATUSES as readonly unknown[]).includes(value) ? (value as DeliveryStatus) : "DRAFT";
}
function outcome(value: unknown): ItemOutcome {
  return (ITEM_OUTCOMES as readonly unknown[]).includes(value) ? (value as ItemOutcome) : "PENDING";
}

export interface DeliveryItem {
  itemId: string;
  packageId: string;
  logisticCode: string | null;
  productId: string;
  productName: string;
  weightGrams: number;
  unitCents: bigint;
  lot: string;
  packedOn: string;
  expiresOn: string;
  ean13: string;
  outcome: ItemOutcome;
  soldOn: string | null;
}

export interface Delivery {
  id: string;
  number: number;
  numberLabel: string;
  status: DeliveryStatus;
  deliveryDate: string;
  commercialMode: CommercialMode;
  referenceDeliveryId: string | null;
  notes: string | null;
  originBranchId: string;
  originBranchName: string;
  site: { id: string; name: string; address: string | null; city: string | null; phone: string | null; contactName: string | null };
  client: { id: string; tradeName: string; legalName: string | null; taxId: string | null };
  /** Datos del destinatario congelados al confirmar (null en un borrador). */
  recipient: { clientTradeName: string; clientLegalName: string | null; taxId: string | null; siteName: string; address: string | null; city: string | null; phone: string | null; contactName: string | null } | null;
  packageCount: number;
  totalGrams: number;
  totalCents: bigint;
  createdBy: string | null;
  createdAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  cancelReason: string | null;
  items: DeliveryItem[];
  /** Sólo en la respuesta de la confirmación: productos que quedaron con stock negativo en la sucursal de origen. */
  stockShortfalls: { productId: string; productName: string; stockGrams: number }[];
  alreadyConfirmed: boolean;
}

export function parseDelivery(value: unknown): Delivery | null {
  const record = asRecord(value);
  if (str(record.id) === "") return null;
  const site = asRecord(record.site);
  const client = asRecord(record.client);
  const recipient = record.recipient === null || record.recipient === undefined ? null : asRecord(record.recipient);
  return {
    id: str(record.id), number: int(record.number), numberLabel: str(record.numberLabel), status: deliveryStatus(record.status), deliveryDate: str(record.deliveryDate),
    commercialMode: mode(record.commercialMode), referenceDeliveryId: strOrNull(record.referenceDeliveryId), notes: strOrNull(record.notes),
    originBranchId: str(record.originBranchId), originBranchName: str(record.originBranchName),
    site: { id: str(site.id), name: str(site.name), address: strOrNull(site.address), city: strOrNull(site.city), phone: strOrNull(site.phone), contactName: strOrNull(site.contactName) },
    client: { id: str(client.id), tradeName: str(client.tradeName), legalName: strOrNull(client.legalName), taxId: strOrNull(client.taxId) },
    recipient: recipient === null ? null : {
      clientTradeName: str(recipient.clientTradeName), clientLegalName: strOrNull(recipient.clientLegalName), taxId: strOrNull(recipient.taxId), siteName: str(recipient.siteName),
      address: strOrNull(recipient.address), city: strOrNull(recipient.city), phone: strOrNull(recipient.phone), contactName: strOrNull(recipient.contactName)
    },
    packageCount: int(record.packageCount), totalGrams: int(record.totalGrams), totalCents: cents(record.totalCents),
    createdBy: strOrNull(record.createdBy), createdAt: str(record.createdAt), confirmedBy: strOrNull(record.confirmedBy), confirmedAt: strOrNull(record.confirmedAt), cancelReason: strOrNull(record.cancelReason),
    items: asArray(record.items).map((entry) => {
      const item = asRecord(entry);
      return {
        itemId: str(item.itemId), packageId: str(item.packageId), logisticCode: strOrNull(item.logisticCode), productId: str(item.productId), productName: str(item.productName),
        weightGrams: int(item.weightGrams), unitCents: cents(item.unitCents), lot: str(item.lot), packedOn: str(item.packedOn), expiresOn: str(item.expiresOn), ean13: str(item.ean13),
        outcome: outcome(item.outcome), soldOn: strOrNull(item.soldOn)
      };
    }),
    stockShortfalls: asArray(record.stockShortfalls).map((entry) => {
      const row = asRecord(entry);
      return { productId: str(row.productId), productName: str(row.productName), stockGrams: int(row.stockGrams) };
    }),
    alreadyConfirmed: bool(record.alreadyConfirmed)
  };
}

export interface DeliveryRow {
  id: string;
  numberLabel: string;
  status: DeliveryStatus;
  deliveryDate: string;
  commercialMode: CommercialMode;
  siteId: string;
  siteName: string;
  clientId: string;
  clientName: string;
  packageCount: number;
  totalGrams: number;
  totalCents: bigint;
  pendingCount: number;
  soldCount: number;
  returnedCount: number;
}

export function parseDeliveriesPage(value: unknown): { total: number; rows: DeliveryRow[] } {
  const record = asRecord(value);
  return {
    total: int(record.total),
    rows: asArray(record.rows).map((entry) => {
      const row = asRecord(entry);
      return {
        id: str(row.id), numberLabel: str(row.numberLabel), status: deliveryStatus(row.status), deliveryDate: str(row.deliveryDate), commercialMode: mode(row.commercialMode),
        siteId: str(row.siteId), siteName: str(row.siteName), clientId: str(row.clientId), clientName: str(row.clientName), packageCount: int(row.packageCount),
        totalGrams: int(row.totalGrams), totalCents: cents(row.totalCents), pendingCount: int(row.pendingCount), soldCount: int(row.soldCount), returnedCount: int(row.returnedCount)
      };
    })
  };
}

export interface AvailableProduct {
  productId: string;
  productName: string;
  packages: number;
  grams: number;
  nextExpiry: string | null;
}

export function parseAvailableSummary(value: unknown): AvailableProduct[] {
  return asArray(value).map((entry) => {
    const row = asRecord(entry);
    return { productId: str(row.productId), productName: str(row.productName), packages: int(row.packages), grams: int(row.grams), nextExpiry: strOrNull(row.nextExpiry) };
  });
}

export interface DistributablePackage {
  packageId: string;
  logisticCode: string | null;
  productId: string;
  productName: string;
  weightGrams: number;
  lot: string;
  packedOn: string;
  expiresOn: string;
  totalCents: bigint;
  ean13: string;
}

export function parseDistributablePage(value: unknown): { total: number; rows: DistributablePackage[] } {
  const record = asRecord(value);
  return {
    total: int(record.total),
    rows: asArray(record.rows).map((entry) => {
      const row = asRecord(entry);
      return {
        packageId: str(row.packageId), logisticCode: strOrNull(row.logisticCode), productId: str(row.productId), productName: str(row.productName), weightGrams: int(row.weightGrams),
        lot: str(row.lot), packedOn: str(row.packedOn), expiresOn: str(row.expiresOn), totalCents: cents(row.totalCents), ean13: str(row.ean13)
      };
    })
  };
}

export interface ReferenceDelivery {
  id: string;
  numberLabel: string;
  deliveryDate: string;
  packageCount: number;
  products: { productId: string; productName: string; quantity: number; grams: number }[];
}

export function parseReferenceDelivery(value: unknown): ReferenceDelivery | null {
  const record = asRecord(value);
  if (str(record.id) === "") return null;
  return {
    id: str(record.id), numberLabel: str(record.numberLabel), deliveryDate: str(record.deliveryDate), packageCount: int(record.packageCount),
    products: asArray(record.products).map((entry) => {
      const row = asRecord(entry);
      return { productId: str(row.productId), productName: str(row.productName), quantity: int(row.quantity), grams: int(row.grams) };
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Conciliación y devoluciones
// ---------------------------------------------------------------------------------------------------------------------

export interface ReconciliationProduct {
  productId: string;
  productName: string;
  delivered: number;
  soldFirm: number;
  soldIdentified: number;
  soldInferred: number;
  returned: number;
  returnPending: number;
  pending: number;
  overReported: boolean;
  estimatedInferredCents: bigint;
}

export interface ReconciliationPackage {
  packageId: string;
  logisticCode: string | null;
  productId: string;
  productName: string;
  weightGrams: number;
  lot: string;
  expiresOn: string;
  expired: boolean;
  unitCents: bigint;
  outcome: ItemOutcome;
  soldOn: string | null;
  returnId: string | null;
  returnStatus: ReturnStatus | null;
}

export interface Reconciliation {
  delivery: Delivery;
  products: ReconciliationProduct[];
  totals: { delivered: number; soldFirm: number; soldIdentified: number; soldInferred: number; returned: number; returnPending: number; pending: number };
  packages: ReconciliationPackage[];
  quantityReports: { id: string; productId: string; productName: string; quantity: number; reportedOn: string; note: string | null }[];
  closure: { closedAt: string | null; closedBy: string | null; note: string | null; pendingAtClose: number | null };
}

export const RETURN_STATUSES = ["PENDING_RECEIPT", "IN_QUARANTINE", "PENDING_INSPECTION", "APPROVED", "REJECTED", "DISCARDED"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  PENDING_RECEIPT: "Pendiente de recepción", IN_QUARANTINE: "Recibido en cuarentena", PENDING_INSPECTION: "Pendiente de inspección",
  APPROVED: "Aprobado para reingreso", REJECTED: "Rechazado", DISCARDED: "Descartado"
};

export const RETURN_REASONS = ["UNSOLD", "NEAR_EXPIRY", "DAMAGED", "CLIENT_REQUEST", "OTHER"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  UNSOLD: "No se vendió", NEAR_EXPIRY: "Próximo a vencer", DAMAGED: "Envase dañado", CLIENT_REQUEST: "Pedido del supermercado", OTHER: "Otro motivo"
};

export const PACKAGING_STATES = ["INTACT", "VACUUM_LOST", "DAMAGED", "OPEN"] as const;
export type PackagingState = (typeof PACKAGING_STATES)[number];
export const PACKAGING_STATE_LABELS: Record<PackagingState, string> = { INTACT: "Intacto", VACUUM_LOST: "Perdió el vacío", DAMAGED: "Dañado", OPEN: "Abierto" };

function returnStatus(value: unknown): ReturnStatus {
  return (RETURN_STATUSES as readonly unknown[]).includes(value) ? (value as ReturnStatus) : "PENDING_RECEIPT";
}
function returnStatusOrNull(value: unknown): ReturnStatus | null {
  return (RETURN_STATUSES as readonly unknown[]).includes(value) ? (value as ReturnStatus) : null;
}
function packaging(value: unknown): PackagingState | null {
  return (PACKAGING_STATES as readonly unknown[]).includes(value) ? (value as PackagingState) : null;
}
function reason(value: unknown): ReturnReason {
  return (RETURN_REASONS as readonly unknown[]).includes(value) ? (value as ReturnReason) : "OTHER";
}

export function parseReconciliation(value: unknown): Reconciliation | null {
  const record = asRecord(value);
  const delivery = parseDelivery(record.delivery);
  if (!delivery) return null;
  const totals = asRecord(record.totals);
  const closure = asRecord(record.closure);
  return {
    delivery,
    products: asArray(record.products).map((entry) => {
      const row = asRecord(entry);
      return {
        productId: str(row.productId), productName: str(row.productName), delivered: int(row.delivered), soldFirm: int(row.soldFirm), soldIdentified: int(row.soldIdentified),
        soldInferred: int(row.soldInferred), returned: int(row.returned), returnPending: int(row.returnPending), pending: int(row.pending), overReported: bool(row.overReported),
        estimatedInferredCents: cents(row.estimatedInferredCents)
      };
    }),
    totals: {
      delivered: int(totals.delivered), soldFirm: int(totals.soldFirm), soldIdentified: int(totals.soldIdentified), soldInferred: int(totals.soldInferred), returned: int(totals.returned),
      returnPending: int(totals.returnPending), pending: int(totals.pending)
    },
    packages: asArray(record.packages).map((entry) => {
      const row = asRecord(entry);
      return {
        packageId: str(row.packageId), logisticCode: strOrNull(row.logisticCode), productId: str(row.productId), productName: str(row.productName), weightGrams: int(row.weightGrams), lot: str(row.lot),
        expiresOn: str(row.expiresOn), expired: bool(row.expired), unitCents: cents(row.unitCents), outcome: outcome(row.outcome), soldOn: strOrNull(row.soldOn),
        returnId: strOrNull(row.returnId), returnStatus: returnStatusOrNull(row.returnStatus)
      };
    }),
    quantityReports: asArray(record.quantityReports).map((entry) => {
      const row = asRecord(entry);
      return { id: str(row.id), productId: str(row.productId), productName: str(row.productName), quantity: int(row.quantity), reportedOn: str(row.reportedOn), note: strOrNull(row.note) };
    }),
    closure: { closedAt: strOrNull(closure.closedAt), closedBy: strOrNull(closure.closedBy), note: strOrNull(closure.note), pendingAtClose: intOrNull(closure.pendingAtClose) }
  };
}

export interface ReturnRow {
  id: string;
  status: ReturnStatus;
  reason: ReturnReason;
  reasonNote: string | null;
  returnedOn: string;
  creditRequired: boolean;
  packagingState: PackagingState | null;
  conservationVerified: boolean | null;
  conservationNote: string | null;
  packageId: string;
  logisticCode: string | null;
  productName: string;
  weightGrams: number;
  lot: string;
  packedOn: string;
  expiresOn: string;
  expired: boolean;
  unitCents: bigint;
  deliveryId: string;
  deliveryLabel: string;
  siteName: string;
  clientName: string;
  registeredAt: string;
  receivedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

export function parseReturnsPage(value: unknown): { total: number; rows: ReturnRow[] } {
  const record = asRecord(value);
  return {
    total: int(record.total),
    rows: asArray(record.rows).map((entry) => {
      const row = asRecord(entry);
      return {
        id: str(row.id), status: returnStatus(row.status), reason: reason(row.reason), reasonNote: strOrNull(row.reasonNote), returnedOn: str(row.returnedOn), creditRequired: bool(row.creditRequired),
        packagingState: packaging(row.packagingState), conservationVerified: row.conservationVerified === true ? true : row.conservationVerified === false ? false : null,
        conservationNote: strOrNull(row.conservationNote), packageId: str(row.packageId), logisticCode: strOrNull(row.logisticCode), productName: str(row.productName), weightGrams: int(row.weightGrams),
        lot: str(row.lot), packedOn: str(row.packedOn), expiresOn: str(row.expiresOn), expired: bool(row.expired), unitCents: cents(row.unitCents), deliveryId: str(row.deliveryId),
        deliveryLabel: str(row.deliveryLabel), siteName: str(row.siteName), clientName: str(row.clientName), registeredAt: str(row.registeredAt), receivedAt: strOrNull(row.receivedAt),
        decidedAt: strOrNull(row.decidedAt), decidedBy: strOrNull(row.decidedBy), decisionReason: strOrNull(row.decisionReason)
      };
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Estadísticas
// ---------------------------------------------------------------------------------------------------------------------

export interface StatsProduct {
  productId: string;
  productName: string;
  categoryName: string | null;
  delivered: number;
  grams: number;
  deliveredCents: bigint;
  soldConfirmed: number;
  soldConfirmedCents: bigint;
  soldEstimated: number;
  soldEstimatedCents: bigint;
  returned: number;
  pending: number;
  rotationConfirmedPct: number | null;
  rotationWithEstimatePct: number | null;
  returnPct: number | null;
}

export interface StatsSite {
  siteId: string;
  siteName: string;
  clientName: string;
  deliveries: number;
  delivered: number;
  deliveredCents: bigint;
  soldConfirmed: number;
  soldEstimated: number;
  returned: number;
  pending: number;
  rotationConfirmedPct: number | null;
  rotationWithEstimatePct: number | null;
}

export interface DistributionStats {
  from: string;
  to: string;
  activeClients: number;
  activeSites: number;
  deliveries: number;
  delivered: { packages: number; grams: number; cents: bigint };
  confirmed: { packages: number; firmPackages: number; identifiedPackages: number; grams: number; cents: bigint };
  estimated: { packages: number; cents: bigint };
  returned: { packages: number; grams: number };
  pending: { packages: number };
  products: StatsProduct[];
  sites: StatsSite[];
}

function pct(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function parseDistributionStats(value: unknown): DistributionStats {
  const record = asRecord(value);
  const delivered = asRecord(record.delivered);
  const confirmed = asRecord(record.confirmed);
  const estimated = asRecord(record.estimated);
  const returned = asRecord(record.returned);
  const pending = asRecord(record.pending);
  return {
    from: str(record.from), to: str(record.to), activeClients: int(record.activeClients), activeSites: int(record.activeSites), deliveries: int(record.deliveries),
    delivered: { packages: int(delivered.packages), grams: int(delivered.grams), cents: cents(delivered.cents) },
    confirmed: { packages: int(confirmed.packages), firmPackages: int(confirmed.firmPackages), identifiedPackages: int(confirmed.identifiedPackages), grams: int(confirmed.grams), cents: cents(confirmed.cents) },
    estimated: { packages: int(estimated.packages), cents: cents(estimated.cents) },
    returned: { packages: int(returned.packages), grams: int(returned.grams) },
    pending: { packages: int(pending.packages) },
    products: asArray(record.products).map((entry) => {
      const row = asRecord(entry);
      return {
        productId: str(row.productId), productName: str(row.productName), categoryName: strOrNull(row.categoryName), delivered: int(row.delivered), grams: int(row.grams), deliveredCents: cents(row.deliveredCents),
        soldConfirmed: int(row.soldConfirmed), soldConfirmedCents: cents(row.soldConfirmedCents), soldEstimated: int(row.soldEstimated), soldEstimatedCents: cents(row.soldEstimatedCents),
        returned: int(row.returned), pending: int(row.pending), rotationConfirmedPct: pct(row.rotationConfirmedPct), rotationWithEstimatePct: pct(row.rotationWithEstimatePct), returnPct: pct(row.returnPct)
      };
    }),
    sites: asArray(record.sites).map((entry) => {
      const row = asRecord(entry);
      return {
        siteId: str(row.siteId), siteName: str(row.siteName), clientName: str(row.clientName), deliveries: int(row.deliveries), delivered: int(row.delivered), deliveredCents: cents(row.deliveredCents),
        soldConfirmed: int(row.soldConfirmed), soldEstimated: int(row.soldEstimated), returned: int(row.returned), pending: int(row.pending),
        rotationConfirmedPct: pct(row.rotationConfirmedPct), rotationWithEstimatePct: pct(row.rotationWithEstimatePct)
      };
    })
  };
}

export interface ReplenishmentRow {
  id: string;
  numberLabel: string;
  deliveryDate: string;
  commercialMode: CommercialMode;
  delivered: number;
  soldConfirmed: number;
  soldInferred: number;
  returned: number;
  pending: number;
  returnPending: number;
  totalCents: bigint;
  closedAt: string | null;
}

export function parseReplenishmentHistory(value: unknown): ReplenishmentRow[] {
  return asArray(value).map((entry) => {
    const row = asRecord(entry);
    return {
      id: str(row.id), numberLabel: str(row.numberLabel), deliveryDate: str(row.deliveryDate), commercialMode: mode(row.commercialMode), delivered: int(row.delivered),
      soldConfirmed: int(row.soldConfirmed), soldInferred: int(row.soldInferred), returned: int(row.returned), pending: int(row.pending), returnPending: int(row.returnPending),
      totalCents: cents(row.totalCents), closedAt: strOrNull(row.closedAt)
    };
  });
}

