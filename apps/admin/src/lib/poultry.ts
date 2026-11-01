import { priceForWeight } from "@carnicerias/business-logic";

import { isIsoDate } from "./date-range";
import { isUuid } from "./uuid";
import { asArray, asRecord, bool, cents, centsOrNull, int, intOrNull, str, strOrNull } from "./rpc-json";

/**
 * Dominio del módulo POLLOS del Admin: tipos, lectura de las RPC (migración 202611010092), estados de pedido y cálculo de rentabilidad.
 * Las cifras históricas (precio al crear, costo al entregar) las congela el servidor; acá sólo se muestran y se recalcula lo que el formulario
 * necesita en pantalla. Los importes viajan como centavos (bigint) y nunca pasan por coma flotante.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Estados y unidades
// ---------------------------------------------------------------------------------------------------------------------

export const POULTRY_STATUSES = ["PENDING", "PREPARING", "READY", "DELIVERED", "CANCELLED"] as const;
export type PoultryOrderStatus = (typeof POULTRY_STATUSES)[number];

export const POULTRY_STATUS_LABELS: Record<PoultryOrderStatus, string> = {
  PENDING: "Pendiente", PREPARING: "Preparando", READY: "Listo", DELIVERED: "Entregado", CANCELLED: "Cancelado"
};

export const POULTRY_STATUS_TONES: Record<PoultryOrderStatus, "neutral" | "warning" | "success" | "critical"> = {
  PENDING: "warning", PREPARING: "warning", READY: "success", DELIVERED: "neutral", CANCELLED: "critical"
};

export function isPoultryStatus(value: unknown): value is PoultryOrderStatus {
  return typeof value === "string" && (POULTRY_STATUSES as readonly string[]).includes(value);
}

export function isOpenStatus(status: PoultryOrderStatus): boolean {
  return status === "PENDING" || status === "PREPARING" || status === "READY";
}

/** Estados a los que se puede pasar desde `status` (hacia adelante, o cancelar). Los estados finales no se reabren. */
export function nextStatuses(status: PoultryOrderStatus): PoultryOrderStatus[] {
  switch (status) {
    case "PENDING": return ["PREPARING", "READY", "DELIVERED", "CANCELLED"];
    case "PREPARING": return ["READY", "DELIVERED", "CANCELLED"];
    case "READY": return ["DELIVERED", "CANCELLED"];
    default: return [];
  }
}

export const POULTRY_ACTION_LABELS: Record<PoultryOrderStatus, string> = {
  PENDING: "Volver a pendiente", PREPARING: "Preparar", READY: "Marcar listo", DELIVERED: "Entregar", CANCELLED: "Cancelar pedido"
};

export type PoultrySaleUnit = "UNIT" | "WEIGHT";

export const POULTRY_SALE_UNIT_LABELS: Record<PoultrySaleUnit, string> = { UNIT: "Por cajón", WEIGHT: "Por kg" };

function saleUnit(value: unknown): PoultrySaleUnit {
  return value === "WEIGHT" ? "WEIGHT" : "UNIT";
}

export const PAYMENT_METHODS = ["CASH", "TRANSFER", "DEBIT", "CREDIT", "OTHER"] as const;
export type PoultryPaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PoultryPaymentMethod, string> = {
  CASH: "Efectivo", TRANSFER: "Transferencia", DEBIT: "Débito", CREDIT: "Crédito", OTHER: "Otro"
};

export function isPaymentMethod(value: unknown): value is PoultryPaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export const PRICE_SOURCE_LABELS: Record<string, string> = {
  CUSTOMER: "Precio del cliente", LIST: "Lista del cliente", DEFAULT: "Lista General", MANUAL: "Manual"
};

// ---------------------------------------------------------------------------------------------------------------------
// Importes y rentabilidad
// ---------------------------------------------------------------------------------------------------------------------

/** Importe de una línea: por cajón = precio × cajones; por kg = precio × gramos / 1000 (half-up, igual que el POS). null si falta el peso real. */
export function lineAmountCents(unit: PoultrySaleUnit, unitPriceCents: bigint, boxes: number, grams: number | null): bigint | null {
  if (unit === "UNIT") return unitPriceCents * BigInt(boxes);
  if (grams === null) return null;
  return priceForWeight(unitPriceCents, grams);
}

export function profitCents(revenueCents: bigint, costCents: bigint): bigint {
  return revenueCents - costCents;
}

/** Margen bruto en puntos básicos sobre la facturación (ganancia ÷ facturación), redondeado half-away como el servidor. null sin facturación. */
export function marginBps(revenueCents: bigint, costCents: bigint): number | null {
  if (revenueCents <= 0n) return null;
  const profit = revenueCents - costCents;
  const half = revenueCents / 2n;
  const scaled = profit * 10_000n;
  return Number((scaled >= 0n ? scaled + half : scaled - half) / revenueCents);
}

/** «12,1 %» (o «—» si no hay margen que mostrar). */
export function formatMargin(bps: number | null): string {
  if (bps === null) return "—";
  return `${(bps / 100).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

export function formatKg(grams: number): string {
  return `${(grams / 1000).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 3 })} kg`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tipos y lectura de RPC
// ---------------------------------------------------------------------------------------------------------------------

export interface PoultryPriceList { id: string; name: string; notes: string | null; isDefault: boolean; active: boolean; customerCount: number }

export interface PoultryProductRow {
  id: string;
  name: string;
  saleUnit: PoultrySaleUnit;
  requiresWeight: boolean;
  referenceWeightGrams: number | null;
  active: boolean;
  costCents: bigint | null;
  costSince: string | null;
  /** Precio vigente por lista (clave = id de lista). */
  prices: Record<string, { cents: bigint; since: string }>;
}

export interface PoultryPriceBoard { lists: PoultryPriceList[]; products: PoultryProductRow[] }

export function parsePriceBoard(value: unknown): PoultryPriceBoard {
  const record = asRecord(value);
  return {
    lists: asArray(record.lists).map((entry) => {
      const list = asRecord(entry);
      return { id: str(list.id), name: str(list.name), notes: strOrNull(list.notes), isDefault: bool(list.isDefault), active: bool(list.active), customerCount: int(list.customerCount) };
    }),
    products: asArray(record.products).map((entry) => {
      const row = asRecord(entry);
      const prices: PoultryProductRow["prices"] = {};
      for (const [listId, price] of Object.entries(asRecord(row.prices))) {
        const parsed = asRecord(price);
        prices[listId] = { cents: cents(parsed.cents), since: str(parsed.since) };
      }
      return {
        id: str(row.id), name: str(row.name), saleUnit: saleUnit(row.saleUnit), requiresWeight: bool(row.requiresWeight),
        referenceWeightGrams: intOrNull(row.referenceWeightGrams), active: bool(row.active), costCents: centsOrNull(row.costCents),
        costSince: strOrNull(row.costSince), prices
      };
    })
  };
}

export interface PoultryPriceHistory {
  costs: { cents: bigint; from: string; to: string | null }[];
  listPrices: { listId: string; listName: string; cents: bigint; from: string; to: string | null }[];
  customerPrices: { customerId: string; customerName: string; cents: bigint; from: string; to: string | null }[];
}

export function parsePriceHistory(value: unknown): PoultryPriceHistory {
  const record = asRecord(value);
  const range = (row: Record<string, unknown>) => ({ cents: cents(row.cents), from: str(row.from), to: strOrNull(row.to) });
  return {
    costs: asArray(record.costs).map((entry) => range(asRecord(entry))),
    listPrices: asArray(record.listPrices).map((entry) => { const row = asRecord(entry); return { listId: str(row.listId), listName: str(row.listName), ...range(row) }; }),
    customerPrices: asArray(record.customerPrices).map((entry) => { const row = asRecord(entry); return { customerId: str(row.customerId), customerName: str(row.customerName), ...range(row) }; })
  };
}

export interface PoultryCustomerRow {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  taxId: string | null;
  notes: string | null;
  active: boolean;
  priceListId: string | null;
  priceListName: string | null;
  ordersCount: number;
  boxes: number;
  revenueCents: bigint;
  profitCents: bigint;
  lastOrderOn: string | null;
}

export function parseCustomersPage(value: unknown): { total: number; rows: PoultryCustomerRow[] } {
  const record = asRecord(value);
  return {
    total: int(record.total),
    rows: asArray(record.rows).map((entry) => {
      const row = asRecord(entry);
      return {
        id: str(row.id), name: str(row.name), phone: strOrNull(row.phone), address: strOrNull(row.address), taxId: strOrNull(row.taxId),
        notes: strOrNull(row.notes), active: bool(row.active), priceListId: strOrNull(row.priceListId), priceListName: strOrNull(row.priceListName),
        ordersCount: int(row.ordersCount), boxes: int(row.boxes), revenueCents: cents(row.revenueCents), profitCents: cents(row.profitCents), lastOrderOn: strOrNull(row.lastOrderOn)
      };
    })
  };
}

export interface PoultryTotals {
  orders: number;
  boxes: number;
  weightGrams: number;
  revenueCents: bigint;
  costCents: bigint;
  profitCents: bigint;
  marginBps: number | null;
}

function parseTotals(value: unknown): PoultryTotals {
  const record = asRecord(value);
  return {
    orders: int(record.orders), boxes: int(record.boxes), weightGrams: int(record.weightGrams), revenueCents: cents(record.revenueCents),
    costCents: cents(record.costCents), profitCents: cents(record.profitCents), marginBps: intOrNull(record.marginBps)
  };
}

export interface PoultryCustomerDetail {
  customer: { id: string; name: string; phone: string | null; address: string | null; taxId: string | null; notes: string | null; active: boolean; priceListId: string | null; priceListName: string | null };
  totals: PoultryTotals;
  recentOrders: { id: string; orderNumber: number; status: PoultryOrderStatus; orderedOn: string; deliveryOn: string | null; revenueCents: bigint; costCents: bigint | null; boxes: number }[];
  prices: { productId: string; productName: string; saleUnit: PoultrySaleUnit; active: boolean; specialCents: bigint | null; effectiveCents: bigint | null; source: string | null }[];
}

export function parseCustomerDetail(value: unknown): PoultryCustomerDetail | null {
  const record = asRecord(value);
  const customer = asRecord(record.customer);
  if (str(customer.id) === "") return null;
  return {
    customer: {
      id: str(customer.id), name: str(customer.name), phone: strOrNull(customer.phone), address: strOrNull(customer.address), taxId: strOrNull(customer.taxId),
      notes: strOrNull(customer.notes), active: bool(customer.active), priceListId: strOrNull(customer.priceListId), priceListName: strOrNull(customer.priceListName)
    },
    totals: parseTotals(record.totals),
    recentOrders: asArray(record.recentOrders).map((entry) => {
      const row = asRecord(entry);
      return {
        id: str(row.id), orderNumber: int(row.orderNumber), status: isPoultryStatus(row.status) ? row.status : "PENDING", orderedOn: str(row.orderedOn),
        deliveryOn: strOrNull(row.deliveryOn), revenueCents: cents(row.revenueCents), costCents: centsOrNull(row.costCents), boxes: int(row.boxes)
      };
    }),
    prices: asArray(record.prices).map((entry) => {
      const row = asRecord(entry);
      return {
        productId: str(row.productId), productName: str(row.productName), saleUnit: saleUnit(row.saleUnit), active: bool(row.active),
        specialCents: centsOrNull(row.specialCents), effectiveCents: centsOrNull(row.effectiveCents), source: strOrNull(row.source)
      };
    })
  };
}

export interface PoultryOrderRow {
  id: string;
  orderNumber: number;
  branchId: string;
  branchName: string;
  customerId: string;
  customerName: string;
  status: PoultryOrderStatus;
  orderedOn: string;
  deliveryOn: string | null;
  paymentMethod: PoultryPaymentMethod | null;
  revenueCents: bigint;
  costCents: bigint | null;
  boxes: number;
  weightGrams: number | null;
  pendingWeight: boolean;
  summary: string;
}

export function parseOrdersPage(value: unknown): { total: number; rows: PoultryOrderRow[] } {
  const record = asRecord(value);
  return {
    total: int(record.total),
    rows: asArray(record.rows).map((entry) => {
      const row = asRecord(entry);
      return {
        id: str(row.id), orderNumber: int(row.orderNumber), branchId: str(row.branchId), branchName: str(row.branchName), customerId: str(row.customerId),
        customerName: str(row.customerName), status: isPoultryStatus(row.status) ? row.status : "PENDING", orderedOn: str(row.orderedOn),
        deliveryOn: strOrNull(row.deliveryOn), paymentMethod: isPaymentMethod(row.paymentMethod) ? row.paymentMethod : null, revenueCents: cents(row.revenueCents),
        costCents: centsOrNull(row.costCents), boxes: int(row.boxes), weightGrams: intOrNull(row.weightGrams), pendingWeight: bool(row.pendingWeight), summary: str(row.summary)
      };
    })
  };
}

export interface PoultryOrderItem {
  id: string;
  productId: string;
  name: string;
  saleUnit: PoultrySaleUnit;
  boxes: number;
  actualWeightGrams: number | null;
  unitPriceCents: bigint;
  priceSource: string;
  lineRevenueCents: bigint | null;
  costCentsSnapshot: bigint | null;
  lineCostCents: bigint | null;
  notes: string | null;
}

export interface PoultryOrderDetail {
  id: string;
  orderNumber: number;
  branchId: string;
  branchName: string;
  customerId: string;
  customerName: string;
  status: PoultryOrderStatus;
  orderedOn: string;
  deliveryOn: string | null;
  paymentMethod: PoultryPaymentMethod | null;
  notes: string | null;
  revenueCents: bigint;
  costCents: bigint | null;
  deliveredAt: string | null;
  items: PoultryOrderItem[];
}

export function parseOrderDetail(value: unknown): PoultryOrderDetail | null {
  const record = asRecord(value);
  if (str(record.id) === "") return null;
  return {
    id: str(record.id), orderNumber: int(record.orderNumber), branchId: str(record.branchId), branchName: str(record.branchName), customerId: str(record.customerId),
    customerName: str(record.customerName), status: isPoultryStatus(record.status) ? record.status : "PENDING", orderedOn: str(record.orderedOn),
    deliveryOn: strOrNull(record.deliveryOn), paymentMethod: isPaymentMethod(record.paymentMethod) ? record.paymentMethod : null, notes: strOrNull(record.notes),
    revenueCents: cents(record.revenueCents), costCents: centsOrNull(record.costCents), deliveredAt: strOrNull(record.deliveredAt),
    items: asArray(record.items).map((entry) => {
      const row = asRecord(entry);
      return {
        id: str(row.id), productId: str(row.productId), name: str(row.name), saleUnit: saleUnit(row.saleUnit), boxes: int(row.boxes),
        actualWeightGrams: intOrNull(row.actualWeightGrams), unitPriceCents: cents(row.unitPriceCents), priceSource: str(row.priceSource),
        lineRevenueCents: centsOrNull(row.lineRevenueCents), costCentsSnapshot: centsOrNull(row.costCentsSnapshot), lineCostCents: centsOrNull(row.lineCostCents),
        notes: strOrNull(row.notes)
      };
    })
  };
}

export interface PoultrySummary {
  today: string;
  open: { pending: number; preparing: number; ready: number; open: number; dueToday: number; upcoming: number; overdue: number; noDate: number };
  sold: PoultryTotals;
  topCustomers: { customerId: string; name: string; orders: number; revenueCents: bigint; profitCents: bigint }[];
  topProducts: { productId: string; name: string; boxes: number; weightGrams: number | null; revenueCents: bigint; profitCents: bigint }[];
}

export function parseSummary(value: unknown): PoultrySummary {
  const record = asRecord(value);
  const open = asRecord(record.open);
  return {
    today: str(record.today),
    open: {
      pending: int(open.pending), preparing: int(open.preparing), ready: int(open.ready), open: int(open.open), dueToday: int(open.dueToday),
      upcoming: int(open.upcoming), overdue: int(open.overdue), noDate: int(open.noDate)
    },
    sold: parseTotals(record.sold),
    topCustomers: asArray(record.topCustomers).map((entry) => {
      const row = asRecord(entry);
      return { customerId: str(row.customerId), name: str(row.name), orders: int(row.orders), revenueCents: cents(row.revenueCents), profitCents: cents(row.profitCents) };
    }),
    topProducts: asArray(record.topProducts).map((entry) => {
      const row = asRecord(entry);
      return { productId: str(row.productId), name: str(row.name), boxes: int(row.boxes), weightGrams: intOrNull(row.weightGrams), revenueCents: cents(row.revenueCents), profitCents: cents(row.profitCents) };
    })
  };
}

export const PROFITABILITY_GROUPS = ["product", "customer", "order", "day", "month"] as const;
export type ProfitabilityGroup = (typeof PROFITABILITY_GROUPS)[number];
export const PROFITABILITY_GROUP_LABELS: Record<ProfitabilityGroup, string> = {
  product: "Producto", customer: "Cliente", order: "Pedido", day: "Día", month: "Mes"
};

export function isProfitabilityGroup(value: unknown): value is ProfitabilityGroup {
  return typeof value === "string" && (PROFITABILITY_GROUPS as readonly string[]).includes(value);
}

export interface PoultryProfitability {
  totals: PoultryTotals;
  total: number;
  groupBy: ProfitabilityGroup;
  rows: { key: string; label: string; orders: number; boxes: number; weightGrams: number | null; revenueCents: bigint; costCents: bigint; profitCents: bigint; marginBps: number | null }[];
}

export function parseProfitability(value: unknown): PoultryProfitability {
  const record = asRecord(value);
  return {
    totals: parseTotals(record.totals), total: int(record.total), groupBy: isProfitabilityGroup(record.groupBy) ? record.groupBy : "product",
    rows: asArray(record.rows).map((entry) => {
      const row = asRecord(entry);
      return {
        key: str(row.key), label: str(row.label), orders: int(row.orders), boxes: int(row.boxes), weightGrams: intOrNull(row.weightGrams),
        revenueCents: cents(row.revenueCents), costCents: cents(row.costCents), profitCents: cents(row.profitCents), marginBps: intOrNull(row.marginBps)
      };
    })
  };
}

export interface ResolvedPrice {
  productId: string;
  name: string;
  saleUnit: PoultrySaleUnit;
  requiresWeight: boolean;
  referenceWeightGrams: number | null;
  priceCents: bigint | null;
  source: string | null;
}

export function parseResolvedPrices(value: unknown): ResolvedPrice[] {
  return asArray(value).map((entry) => {
    const row = asRecord(entry);
    return {
      productId: str(row.productId), name: str(row.name), saleUnit: saleUnit(row.saleUnit), requiresWeight: bool(row.requiresWeight),
      referenceWeightGrams: intOrNull(row.referenceWeightGrams), priceCents: centsOrNull(row.priceCents), source: strOrNull(row.source)
    };
  }).filter((price) => price.productId !== "");
}

// ---------------------------------------------------------------------------------------------------------------------
// Entrada del formulario de pedido (la valida el servidor otra vez; esto da el mensaje en castellano antes de ir a la base)
// ---------------------------------------------------------------------------------------------------------------------

export interface OrderItemInput {
  itemId: string | null;
  productId: string;
  boxes: number;
  actualWeightGrams: number | null;
  /** Precio manual (por cajón o por kg) en centavos; null = que el servidor lo resuelva con las listas. */
  unitPriceCents: number | null;
  notes: string | null;
}

export interface OrderInput {
  orderId: string | null;
  requestKey: string | null;
  branchId: string;
  customerId: string;
  orderedOn: string;
  deliveryOn: string | null;
  paymentMethod: PoultryPaymentMethod | null;
  notes: string | null;
  items: OrderItemInput[];
}

export type OrderInputParse = { ok: true; value: OrderInput } | { ok: false; error: string };

function wholeNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Interpreta el JSON del formulario de pedido. Los precios llegan en centavos (el cliente ya convirtió los pesos). */
export function parseOrderInput(raw: unknown): OrderInputParse {
  const record = asRecord(raw);
  const orderId = strOrNull(record.orderId);
  if (orderId !== null && !isUuid(orderId)) return { ok: false, error: "Pedido inválido" };
  const requestKey = strOrNull(record.requestKey);
  if (requestKey !== null && !isUuid(requestKey)) return { ok: false, error: "Pedido inválido" };
  const branchId = str(record.branchId);
  if (orderId === null && !isUuid(branchId)) return { ok: false, error: "Elegí la sucursal" };
  const customerId = str(record.customerId);
  if (!isUuid(customerId)) return { ok: false, error: "Elegí el cliente" };
  const orderedOn = str(record.orderedOn);
  if (!isIsoDate(orderedOn)) return { ok: false, error: "La fecha del pedido es inválida" };
  const deliveryOn = strOrNull(record.deliveryOn);
  if (deliveryOn !== null && !isIsoDate(deliveryOn)) return { ok: false, error: "La fecha de entrega es inválida" };
  if (deliveryOn !== null && deliveryOn < orderedOn) return { ok: false, error: "La entrega no puede ser anterior al pedido" };
  const method = strOrNull(record.paymentMethod);
  if (method !== null && !isPaymentMethod(method)) return { ok: false, error: "Forma de pago inválida" };

  const rawItems = asArray(record.items);
  if (rawItems.length === 0) return { ok: false, error: "Agregá al menos un producto" };
  if (rawItems.length > 100) return { ok: false, error: "Un pedido admite hasta 100 líneas" };
  const items: OrderItemInput[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of rawItems.entries()) {
    const row = asRecord(entry);
    const productId = str(row.productId);
    const label = `Línea ${String(index + 1)}`;
    if (!isUuid(productId)) return { ok: false, error: `${label}: elegí el producto` };
    if (seen.has(productId)) return { ok: false, error: `${label}: el producto está repetido` };
    seen.add(productId);
    const boxes = wholeNumber(row.boxes);
    if (boxes === null || boxes <= 0 || boxes > 100_000) return { ok: false, error: `${label}: cantidad de cajones inválida` };
    const grams = row.actualWeightGrams === null || row.actualWeightGrams === undefined || row.actualWeightGrams === "" ? null : wholeNumber(row.actualWeightGrams);
    if (grams !== null && grams <= 0) return { ok: false, error: `${label}: peso real inválido` };
    if (row.actualWeightGrams !== null && row.actualWeightGrams !== undefined && row.actualWeightGrams !== "" && grams === null) return { ok: false, error: `${label}: peso real inválido` };
    const price = row.unitPriceCents === null || row.unitPriceCents === undefined || row.unitPriceCents === "" ? null : wholeNumber(row.unitPriceCents);
    if (price !== null && price <= 0) return { ok: false, error: `${label}: precio inválido` };
    if (row.unitPriceCents !== null && row.unitPriceCents !== undefined && row.unitPriceCents !== "" && price === null) return { ok: false, error: `${label}: precio inválido` };
    const itemId = strOrNull(row.itemId);
    if (itemId !== null && !isUuid(itemId)) return { ok: false, error: `${label}: línea inválida` };
    const notes = strOrNull(row.notes);
    items.push({ itemId, productId, boxes, actualWeightGrams: grams, unitPriceCents: price, notes: notes && notes.length > 300 ? notes.slice(0, 300) : notes });
  }
  const notes = strOrNull(record.notes);
  if (notes !== null && notes.length > 1000) return { ok: false, error: "Las observaciones son demasiado largas" };
  return { ok: true, value: { orderId, requestKey, branchId, customerId, orderedOn, deliveryOn, paymentMethod: method, notes, items } };
}

/** Argumentos de `save_poultry_order` para una entrada ya validada. */
export function orderRpcItems(items: readonly OrderItemInput[]): Record<string, unknown>[] {
  return items.map((item) => ({
    ...(item.itemId ? { itemId: item.itemId } : {}), productId: item.productId, boxes: item.boxes,
    ...(item.actualWeightGrams !== null ? { actualWeightGrams: item.actualWeightGrams } : {}),
    ...(item.unitPriceCents !== null ? { unitPriceCents: item.unitPriceCents } : {}),
    ...(item.notes ? { notes: item.notes } : {})
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Texto de importes y pesos para los campos de formulario
// ---------------------------------------------------------------------------------------------------------------------

/** Centavos → texto de pesos para un campo editable («4800000» → «48000»; «4800050» → «48000,50»). */
export function pesosInput(centsValue: bigint | null): string {
  if (centsValue === null) return "";
  const fraction = centsValue % 100n;
  const whole = (centsValue / 100n).toString();
  return fraction === 0n ? whole : `${whole},${fraction.toString().padStart(2, "0")}`;
}

/**
 * Texto de pesos → centavos; null si está vacío o es inválido. Acepta «48000», «48000,50», «48000.50» y con miles «48.000» / «48.000,50»
 * (con coma, los puntos son miles; sin coma, un punto seguido de exactamente 3 dígitos es de miles y de 1-2 dígitos es decimal).
 */
export function parsePesosInput(input: string): bigint | null {
  const raw = input.trim();
  let normalized: string;
  if (raw.includes(",")) normalized = raw.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) normalized = raw.replace(/\./g, "");
  else normalized = raw;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const centsValue = BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return centsValue > 0n ? centsValue : null;
}

/** Kilos escritos por el operador («30,5», «30.500») → gramos; null si está vacío o es inválido. */
export function parseKgInput(input: string): number | null {
  const match = /^(\d+)(?:[,.](\d{1,3}))?$/.exec(input.trim());
  if (!match) return null;
  const grams = Number(BigInt(match[1] ?? "0") * 1000n + BigInt((match[2] ?? "").padEnd(3, "0")));
  return grams > 0 && Number.isSafeInteger(grams) ? grams : null;
}
