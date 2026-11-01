import { describe, expect, it } from "vitest";

import {
  formatMargin, isOpenStatus, lineAmountCents, marginBps, nextStatuses, orderRpcItems, parseCustomerDetail, parseCustomersPage, parseOrderDetail, parseOrderInput,
  parseKgInput, parseOrdersPage, parsePesosInput, parsePriceBoard, pesosInput, parsePriceHistory, parseProfitability, parseResolvedPrices, parseSummary, profitCents, POULTRY_STATUS_LABELS, POULTRY_STATUSES
} from "./poultry";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("estados de pedido", () => {
  it("tiene los cinco estados con su etiqueta", () => {
    expect(POULTRY_STATUSES).toEqual(["PENDING", "PREPARING", "READY", "DELIVERED", "CANCELLED"]);
    expect(POULTRY_STATUS_LABELS).toEqual({ PENDING: "Pendiente", PREPARING: "Preparando", READY: "Listo", DELIVERED: "Entregado", CANCELLED: "Cancelado" });
  });

  it("avanza hacia adelante o cancela; los estados finales no se reabren", () => {
    expect(nextStatuses("PENDING")).toEqual(["PREPARING", "READY", "DELIVERED", "CANCELLED"]);
    expect(nextStatuses("READY")).toEqual(["DELIVERED", "CANCELLED"]);
    expect(nextStatuses("DELIVERED")).toEqual([]);
    expect(nextStatuses("CANCELLED")).toEqual([]);
    expect(isOpenStatus("PREPARING")).toBe(true);
    expect(isOpenStatus("DELIVERED")).toBe(false);
  });
});

describe("importes de línea (mismos vectores que poultry_module.test.sql)", () => {
  it("por cajón: precio × cajones", () => {
    expect(lineAmountCents("UNIT", 4_600_000n, 5, null)).toBe(23_000_000n);
  });

  it("por kg: precio × peso real, half-up en centavos", () => {
    expect(lineAmountCents("WEIGHT", 200_000n, 2, 30_500)).toBe(6_100_000n);
    expect(lineAmountCents("WEIGHT", 33_333n, 1, 1245)).toBe(41_500n);
  });

  it("por kg sin peso real todavía no se puede valorizar", () => {
    expect(lineAmountCents("WEIGHT", 200_000n, 2, null)).toBeNull();
  });
});

describe("rentabilidad", () => {
  it("ganancia bruta = facturación − costo histórico", () => {
    expect(profitCents(29_100_000n, 25_575_000n)).toBe(3_525_000n);
  });

  it("margen bruto sobre la facturación (puntos básicos)", () => {
    expect(marginBps(29_100_000n, 25_575_000n)).toBe(1211);
    expect(marginBps(33_600_000n, 30_075_000n)).toBe(1049);
    expect(marginBps(4_500_000n, 4_500_000n)).toBe(0);
    expect(marginBps(1_000n, 1_500n)).toBe(-5000);
    expect(marginBps(0n, 0n)).toBeNull();
  });

  it("formatea el margen en castellano", () => {
    expect(formatMargin(1211)).toBe("12,1 %");
    expect(formatMargin(null)).toBe("—");
    expect(formatMargin(-500)).toBe("-5,0 %");
  });
});

describe("lectura de las RPC", () => {
  it("lee el tablero de precios con costo y precio por lista", () => {
    const board = parsePriceBoard({
      lists: [{ id: "g", name: "General", notes: null, isDefault: true, active: true, customerCount: 2 }],
      products: [{
        id: "p", name: "Cajón pollo entero", saleUnit: "UNIT", requiresWeight: false, referenceWeightGrams: 20000, active: true, costCents: "4200000",
        costSince: "2026-11-01T00:00:00Z", prices: { g: { cents: "4800000", since: "2026-11-01T00:00:00Z" } }
      }, { id: "q", name: "Sin costo", saleUnit: "WEIGHT", requiresWeight: true, referenceWeightGrams: null, active: true, costCents: null, costSince: null, prices: {} }]
    });
    expect(board.lists[0]?.isDefault).toBe(true);
    expect(board.products[0]?.costCents).toBe(4_200_000n);
    expect(board.products[0]?.prices.g?.cents).toBe(4_800_000n);
    expect(board.products[1]?.costCents).toBeNull();
    expect(board.products[1]?.saleUnit).toBe("WEIGHT");
  });

  it("lee historia de costos y precios", () => {
    const history = parsePriceHistory({
      costs: [{ cents: "4500000", from: "t2", to: null }, { cents: "4200000", from: "t1", to: "t2" }],
      listPrices: [{ listId: "g", listName: "General", cents: "4800000", from: "t1", to: null }], customerPrices: []
    });
    expect(history.costs).toHaveLength(2);
    expect(history.costs[1]?.to).toBe("t2");
    expect(history.listPrices[0]?.listName).toBe("General");
  });

  it("lee clientes con sus totales", () => {
    const page = parseCustomersPage({ total: 1, rows: [{ id: "c", name: "Supermercado X", phone: null, address: null, taxId: null, notes: null, active: true, priceListId: null, priceListName: null, ordersCount: 2, boxes: 8, revenueCents: "33600000", profitCents: "3525000", lastOrderOn: "2026-11-03" }] });
    expect(page.total).toBe(1);
    expect(page.rows[0]?.revenueCents).toBe(33_600_000n);
    expect(page.rows[0]?.boxes).toBe(8);
    expect(parseCustomersPage(null)).toEqual({ total: 0, rows: [] });
  });

  it("lee la ficha del cliente y devuelve null si no existe", () => {
    expect(parseCustomerDetail(null)).toBeNull();
    const detail = parseCustomerDetail({
      customer: { id: "c", name: "Rotisería Y", active: true },
      totals: { orders: 1, boxes: 1, weightGrams: 0, revenueCents: "4500000", costCents: "4500000", profitCents: "0", marginBps: 0 },
      recentOrders: [{ id: "o", orderNumber: 2, status: "DELIVERED", orderedOn: "2026-11-01", deliveryOn: null, revenueCents: "4500000", costCents: "4500000", boxes: 1 }],
      prices: [{ productId: "p", productName: "Cajón", saleUnit: "UNIT", active: true, specialCents: "4500000", effectiveCents: "4500000", source: "CUSTOMER" }]
    });
    expect(detail?.totals.marginBps).toBe(0);
    expect(detail?.recentOrders[0]?.status).toBe("DELIVERED");
    expect(detail?.prices[0]?.source).toBe("CUSTOMER");
  });

  it("lee pedidos y el detalle con sus snapshots", () => {
    const page = parseOrdersPage({ total: 1, rows: [{ id: "o", orderNumber: 1, branchId: "b", branchName: "Central", customerId: "c", customerName: "X", status: "READY", orderedOn: "2026-11-01", deliveryOn: "2026-11-03", paymentMethod: "TRANSFER", revenueCents: "23000000", costCents: null, boxes: 7, weightGrams: null, pendingWeight: true, summary: "5 × Cajón" }] });
    expect(page.rows[0]?.paymentMethod).toBe("TRANSFER");
    expect(page.rows[0]?.costCents).toBeNull();
    expect(page.rows[0]?.pendingWeight).toBe(true);
    const detail = parseOrderDetail({
      id: "o", orderNumber: 1, status: "DELIVERED", orderedOn: "2026-11-01", revenueCents: "29100000", costCents: "25575000",
      items: [{ id: "i", productId: "p", name: "Cajón", saleUnit: "UNIT", boxes: 5, actualWeightGrams: null, unitPriceCents: "4600000", priceSource: "LIST", lineRevenueCents: "23000000", costCentsSnapshot: "4200000", lineCostCents: "21000000", notes: null }]
    });
    expect(detail?.items[0]?.costCentsSnapshot).toBe(4_200_000n);
    expect(detail?.items[0]?.priceSource).toBe("LIST");
    expect(parseOrderDetail(null)).toBeNull();
  });

  it("lee el resumen del dashboard", () => {
    const summary = parseSummary({
      today: "2026-11-01", open: { pending: 2, preparing: 1, ready: 0, open: 3, dueToday: 1, upcoming: 1, overdue: 0, noDate: 0 },
      sold: { orders: 2, revenueCents: "33600000", costCents: "30075000", profitCents: "3525000", marginBps: 1049, boxes: 8, weightGrams: 30500 },
      topCustomers: [{ customerId: "c", name: "X", orders: 1, revenueCents: "1", profitCents: "0" }],
      topProducts: [{ productId: "p", name: "Cajón", boxes: 6, weightGrams: null, revenueCents: "27500000", profitCents: "2000000" }]
    });
    expect(summary.open.open).toBe(3);
    expect(summary.sold.marginBps).toBe(1049);
    expect(summary.topProducts[0]?.weightGrams).toBeNull();
  });

  it("lee la rentabilidad agrupada", () => {
    const result = parseProfitability({
      totals: { orders: 2, boxes: 8, weightGrams: 30500, revenueCents: "33600000", costCents: "30075000", profitCents: "3525000", marginBps: 1049 },
      total: 1, groupBy: "customer", rows: [{ key: "c", label: "X", orders: 1, boxes: 1, weightGrams: null, revenueCents: "1", costCents: "1", profitCents: "0", marginBps: 0 }]
    });
    expect(result.groupBy).toBe("customer");
    expect(result.rows[0]?.marginBps).toBe(0);
    expect(parseProfitability({ groupBy: "otro" }).groupBy).toBe("product");
  });

  it("lee los precios resueltos para un cliente", () => {
    const prices = parseResolvedPrices([{ productId: "p", name: "Cajón", saleUnit: "UNIT", requiresWeight: false, referenceWeightGrams: null, priceCents: "4600000", source: "LIST" }, { productId: "q", name: "Sin precio", saleUnit: "UNIT", priceCents: null, source: null }]);
    expect(prices[0]?.priceCents).toBe(4_600_000n);
    expect(prices[1]?.priceCents).toBeNull();
  });
});

describe("formulario de pedido", () => {
  const valid = {
    branchId: U(1), customerId: U(2), orderedOn: "2026-11-01", deliveryOn: "2026-11-03", paymentMethod: "TRANSFER", notes: "Entregar temprano",
    items: [{ productId: U(3), boxes: 5 }, { productId: U(4), boxes: "2", actualWeightGrams: "30500", unitPriceCents: 200_000 }]
  };

  it("acepta un pedido válido (cliente, fechas, items, forma de pago)", () => {
    const result = parseOrderInput(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toEqual([
        { itemId: null, productId: U(3), boxes: 5, actualWeightGrams: null, unitPriceCents: null, notes: null },
        { itemId: null, productId: U(4), boxes: 2, actualWeightGrams: 30500, unitPriceCents: 200_000, notes: null }
      ]);
      expect(result.value.paymentMethod).toBe("TRANSFER");
    }
  });

  it("rechaza lo que falta o es inválido, con un mensaje en castellano", () => {
    const error = (patch: Record<string, unknown>) => { const result = parseOrderInput({ ...valid, ...patch }); return result.ok ? null : result.error; };
    expect(error({ customerId: "x" })).toBe("Elegí el cliente");
    expect(error({ branchId: "" })).toBe("Elegí la sucursal");
    expect(error({ orderedOn: "2026-13-01" })).toBe("La fecha del pedido es inválida");
    expect(error({ deliveryOn: "2026-10-01" })).toBe("La entrega no puede ser anterior al pedido");
    expect(error({ paymentMethod: "BITCOIN" })).toBe("Forma de pago inválida");
    expect(error({ items: [] })).toBe("Agregá al menos un producto");
    expect(error({ items: [{ productId: U(3), boxes: 0 }] })).toContain("cantidad de cajones inválida");
    expect(error({ items: [{ productId: U(3), boxes: 1 }, { productId: U(3), boxes: 1 }] })).toContain("repetido");
    expect(error({ items: [{ productId: U(3), boxes: 1, actualWeightGrams: "abc" }] })).toContain("peso real inválido");
    expect(error({ items: [{ productId: U(3), boxes: 1, unitPriceCents: -5 }] })).toContain("precio inválido");
    expect(error({ items: [{ productId: "no", boxes: 1 }] })).toContain("elegí el producto");
  });

  it("al editar no hace falta la sucursal (la del pedido no cambia)", () => {
    expect(parseOrderInput({ ...valid, orderId: U(9), branchId: "" }).ok).toBe(true);
    expect(parseOrderInput({ ...valid, orderId: "nope" })).toMatchObject({ ok: false });
  });

  it("arma los items de la RPC sin campos vacíos", () => {
    const parsed = parseOrderInput(valid);
    if (!parsed.ok) throw new Error("expected ok");
    expect(orderRpcItems(parsed.value.items)).toEqual([
      { productId: U(3), boxes: 5 },
      { productId: U(4), boxes: 2, actualWeightGrams: 30500, unitPriceCents: 200_000 }
    ]);
  });
});

describe("campos de importe y peso", () => {
  it("convierte centavos a texto de pesos y de vuelta", () => {
    expect(pesosInput(4_800_000n)).toBe("48000");
    expect(pesosInput(4_800_050n)).toBe("48000,50");
    expect(pesosInput(5n)).toBe("0,05");
    expect(pesosInput(null)).toBe("");
    expect(parsePesosInput("48000")).toBe(4_800_000n);
    expect(parsePesosInput("48000,50")).toBe(4_800_050n);
    expect(parsePesosInput("48000.5")).toBe(4_800_050n);
    expect(parsePesosInput("48.000")).toBe(4_800_000n);
    expect(parsePesosInput("48.000,50")).toBe(4_800_050n);
  });

  it("rechaza importes vacíos, en cero o inválidos", () => {
    for (const bad of ["", "0", "0,00", "abc", "12,345", "-5", "1,2,3"]) expect(parsePesosInput(bad)).toBeNull();
  });

  it("convierte kilos a gramos con coma o punto", () => {
    expect(parseKgInput("30,5")).toBe(30_500);
    expect(parseKgInput("30.500")).toBe(30_500);
    expect(parseKgInput("0,001")).toBe(1);
    expect(parseKgInput("")).toBeNull();
    expect(parseKgInput("0")).toBeNull();
    expect(parseKgInput("1,2345")).toBeNull();
  });
});
