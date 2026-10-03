import { describe, expect, it } from "vitest";

import { createOfflineSale, nextAttemptAt, retryDelayMs, shouldAttempt } from "./index";

const ids = Array.from({ length: 10 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);

describe("offline sale envelope", () => {
  it("declares Mercado Pago through payment.provider and leaves every other payload untouched", () => {
    const base = {
      organizationId: "org", branchId: "branch", profileId: "profile", deviceId: "device",
      createId: () => crypto.randomUUID(),
      ticket: [{ id: "line", productId: "product", productName: "Asado", weightGrams: 1000, pricePerKgCents: 10000n, subtotalCents: 10000n }]
    };
    const manual = createOfflineSale({ ...base, paymentMethod: "TRANSFER" });
    expect(manual.payment).not.toHaveProperty("provider");
    const cash = createOfflineSale({ ...base, paymentMethod: "CASH" });
    expect(JSON.stringify(cash.payment)).not.toContain("provider");
    const mercadopago = createOfflineSale({ ...base, paymentMethod: "TRANSFER", paymentProvider: "MERCADOPAGO" });
    expect(mercadopago.payment).toMatchObject({ method: "TRANSFER", provider: "MERCADOPAGO", amountCents: "10000" });
  });

  it("refuses a payment provider on any method other than TRANSFER", () => {
    expect(() => createOfflineSale({
      organizationId: "org", branchId: "branch", profileId: "profile", deviceId: "device", paymentMethod: "DEBIT", paymentProvider: "MERCADOPAGO",
      ticket: [{ id: "line", productId: "product", productName: "Asado", weightGrams: 1000, pricePerKgCents: 10000n, subtotalCents: 10000n }]
    })).toThrow("only valid on a TRANSFER");
  });

  it("keeps the verified operator grant with its immutable sale identity", () => {
    const payload = createOfflineSale({
      organizationId: "organization", branchId: "branch", profileId: "employee-laura", deviceId: "device",
      operatorToken: "opaque-device-grant", paymentMethod: "CASH", now: new Date("2026-09-13T12:00:00Z"),
      createId: (() => { let index = 0; return () => `id-${String(++index)}`; })(),
      ticket: [{ id: "line", productId: "product", productName: "Asado", weightGrams: 1000, pricePerKgCents: 10000n, subtotalCents: 10000n }]
    });
    expect(payload.profileId).toBe("employee-laura");
    expect(payload.operatorToken).toBe("opaque-device-grant");
  });
  it("assigns stable client ids and freezes price snapshots", () => {
    let index = 0;
    const payload = createOfflineSale({
      organizationId: "org",
      branchId: "branch",
      profileId: "profile",
      deviceId: "device",
      paymentMethod: "CASH",
      now: new Date("2026-09-10T12:00:00.000Z"),
      createId: () => {
        const id = ids[index++];
        if (!id) throw new Error("test id pool exhausted");
        return id;
      },
      ticket: [
        { id: "ticket-1", productId: "vacio", productName: "Vacío", weightGrams: 1250, pricePerKgCents: 1_200_000n, subtotalCents: 1_500_000n },
        { id: "ticket-2", productId: "asado", productName: "Asado", weightGrams: 800, pricePerKgCents: 1_000_000n, subtotalCents: 800_000n }
      ]
    });

    expect(payload.totalCents).toBe("2300000");
    expect(payload.totalWeightGrams).toBe("2050");
    expect(payload.items.map((item) => item.pricePerKgCents)).toEqual(["1200000", "1000000"]);
    expect(payload.items.map((item) => item.originalPricePerKgCents)).toEqual(["1200000", "1000000"]);
    expect(payload.items.map((item) => item.discountCents)).toEqual(["0", "0"]);
    expect(new Set([
      payload.eventId,
      payload.saleId,
      payload.payment.id,
      ...payload.items.map((item) => item.id),
      ...payload.stockMovements.map((movement) => movement.id)
    ]).size).toBe(7);
  });

  it("freezes a complete discounted item snapshot", () => {
    const payload = createOfflineSale({
      organizationId: "org", branchId: "branch", profileId: "profile", deviceId: "device",
      paymentMethod: "CASH", createId: () => crypto.randomUUID(),
      ticket: [{ id: "line", productId: "asado", productName: "Asado", weightGrams: 2_250,
        originalPricePerKgCents: 1_000_000n, pricePerKgCents: 800_000n,
        discountRuleId: "rule", discountType: "PERCENTAGE", discountValue: 2_000n,
        discountCents: 450_000n, subtotalCents: 1_800_000n }]
    });
    expect(payload.items[0]).toMatchObject({ originalPricePerKgCents: "1000000", pricePerKgCents: "800000", discountType: "PERCENTAGE", discountValue: "2000", discountCents: "450000", subtotalCents: "1800000" });
  });

  it("keeps cash and promotion discounts separated in the offline envelope", () => {
    const payload = createOfflineSale({
      organizationId: "org", branchId: "branch", profileId: "profile", deviceId: "device",
      paymentMethod: "CASH", createId: () => crypto.randomUUID(),
      ticket: [{ id: "line", productId: "asado", productName: "Asado", weightGrams: 1_000,
        originalPricePerKgCents: 1_444_444n, pricePerKgCents: 1_235_000n,
        discountRuleId: "rule", discountType: "PERCENTAGE", discountValue: 500n,
        discountCents: 209_444n, cashDiscountBps: 1_000n, cashDiscountCents: 144_444n,
        promotionDiscountCents: 65_000n, subtotalCents: 1_235_000n }]
    });
    expect(payload.items[0]).toMatchObject({ cashDiscountBps: "1000", cashDiscountCents: "144444", promotionDiscountCents: "65000", discountCents: "209444" });
  });

  it("freezes a card surcharge snapshot separately from any discount (D-044)", () => {
    const payload = createOfflineSale({
      organizationId: "org", branchId: "branch", profileId: "profile", deviceId: "device",
      paymentMethod: "DEBIT", createId: () => crypto.randomUUID(),
      ticket: [{ id: "line", productId: "asado", productName: "Asado", weightGrams: 1_000,
        originalPricePerKgCents: 1_000_000n, pricePerKgCents: 1_100_000n,
        cashDiscountBps: 1_000n, cashDiscountCents: 0n, cardSurchargeCents: 100_000n,
        promotionDiscountCents: 0n, discountCents: 0n, subtotalCents: 1_100_000n }]
    });
    expect(payload.items[0]).toMatchObject({ cardSurchargeCents: "100000", cashDiscountCents: "0", discountCents: "0" });
  });

  it("defaults cardSurchargeCents to 0 when the line doesn't set it (CASH/TRANSFER/OTHER)", () => {
    const payload = createOfflineSale({
      organizationId: "org", branchId: "branch", profileId: "profile", deviceId: "device",
      paymentMethod: "CASH", createId: () => crypto.randomUUID(),
      ticket: [{ id: "line", productId: "asado", productName: "Asado", weightGrams: 1_000, pricePerKgCents: 1_000_000n, subtotalCents: 1_000_000n }]
    });
    expect(payload.items[0]).toMatchObject({ cardSurchargeCents: "0" });
  });

  it("sends a UNIT line with quantityUnits and no weightGrams key at all, and no weight in its stock movement", () => {
    const payload = createOfflineSale({
      organizationId: "org", branchId: "branch", profileId: "profile", deviceId: "device",
      paymentMethod: "CASH", createId: () => crypto.randomUUID(),
      // Hamburguesa: 3 x $800 = $2.400, sin balanza ni gramos involucrados.
      ticket: [{ id: "line", productId: "hamburguesa", productName: "Hamburguesa", weightGrams: 0, quantityUnits: 3,
        pricePerKgCents: 800n, subtotalCents: 2_400n }]
    });
    expect(payload.items[0]).toMatchObject({ quantityUnits: 3, subtotalCents: "2400" });
    expect(payload.items[0]).not.toHaveProperty("weightGrams");
    expect(payload.stockMovements[0]?.quantityGrams).toBe("-3");
    expect(payload.totalWeightGrams).toBe("0");
  });

  it("mixes a WEIGHT and a UNIT line in the same sale without either contaminating the other's total", () => {
    const payload = createOfflineSale({
      organizationId: "org", branchId: "branch", profileId: "profile", deviceId: "device",
      paymentMethod: "CASH", createId: () => crypto.randomUUID(),
      ticket: [
        { id: "weight-line", productId: "vacio", productName: "Vacío", weightGrams: 1_000, pricePerKgCents: 10_000n, subtotalCents: 10_000n },
        { id: "unit-line", productId: "hamburguesa", productName: "Hamburguesa", weightGrams: 0, quantityUnits: 3, pricePerKgCents: 800n, subtotalCents: 2_400n }
      ]
    });
    expect(payload.totalCents).toBe("12400");
    expect(payload.totalWeightGrams).toBe("1000");
    expect(payload.items[0]).toHaveProperty("weightGrams", 1_000);
    expect(payload.items[1]).not.toHaveProperty("weightGrams");
    expect(payload.items[1]).toHaveProperty("quantityUnits", 3);
  });
});

describe("flexible pricing in the offline envelope (D-061)", () => {
  const base = { organizationId: "org", branchId: "branch", profileId: "profile", deviceId: "device", createId: () => crypto.randomUUID() };
  // Coca Cola de $12.000 vendida a $10.000 (precio manual) y un asado normal de $14.000.
  const manualUnit = {
    id: "manual", productId: "coca", productName: "Coca Cola 2.25 L", weightGrams: 0, quantityUnits: 1,
    originalPricePerKgCents: 1_200_000n, pricePerKgCents: 1_000_000n, discountCents: 0n, cashDiscountBps: 0n, cashDiscountCents: 0n,
    cardSurchargeCents: 0n, promotionDiscountCents: 0n, subtotalCents: 1_000_000n,
    manualPriceApplied: true, manualUnitPriceCents: 1_000_000n, manualAdjustmentCents: -200_000n
  };
  const normalWeight = { id: "normal", productId: "asado", productName: "Asado", weightGrams: 1_000, pricePerKgCents: 1_400_000n, originalPricePerKgCents: 1_400_000n, subtotalCents: 1_400_000n };

  it("a manual line keeps its original price, manual price and adjustment as an auditable snapshot", () => {
    const payload = createOfflineSale({ ...base, paymentMethod: "CASH", ticket: [manualUnit] });
    expect(payload.items[0]).toMatchObject({
      manualPriceApplied: true, manualUnitPriceCents: "1000000", manualAdjustmentCents: "-200000",
      originalPricePerKgCents: "1200000", pricePerKgCents: "1000000", promotionDiscountCents: "0", cardSurchargeCents: "0", subtotalCents: "1000000"
    });
    expect(payload.totalCents).toBe("1000000");
  });

  it("a sale without manual lines or discount keeps exactly its previous payload shape", () => {
    const payload = createOfflineSale({ ...base, paymentMethod: "CASH", ticket: [normalWeight] });
    expect(payload.items[0]).not.toHaveProperty("manualPriceApplied");
    expect(payload.items[0]).not.toHaveProperty("manualUnitPriceCents");
    expect(payload).not.toHaveProperty("ticketDiscountBps");
    expect(payload).not.toHaveProperty("ticketDiscountCents");
    expect(payload).not.toHaveProperty("subtotalCents");
  });

  it("the ticket discount is frozen next to the real total and the payment amount (5% of $24.000)", () => {
    const payload = createOfflineSale({
      ...base, paymentMethod: "CASH", ticketDiscount: { bps: 500n, cents: 120_000n },
      ticket: [{ ...manualUnit, subtotalCents: 1_000_000n }, { ...normalWeight, subtotalCents: 1_400_000n }]
    });
    expect(payload).toMatchObject({ subtotalCents: "2400000", ticketDiscountBps: "500", ticketDiscountCents: "120000", totalCents: "2280000" });
    expect(payload.payment.amountCents).toBe("2280000");
  });

  it("a 0% discount adds no keys, and a percentage that rounds to zero cents still records the percentage", () => {
    const none = createOfflineSale({ ...base, paymentMethod: "CASH", ticketDiscount: { bps: 0n, cents: 0n }, ticket: [normalWeight] });
    expect(none).not.toHaveProperty("ticketDiscountBps");
    const tiny = createOfflineSale({ ...base, paymentMethod: "CASH", ticketDiscount: { bps: 500n, cents: 0n }, ticket: [{ ...normalWeight, weightGrams: 1, pricePerKgCents: 9_000n, subtotalCents: 9n }] });
    expect(tiny).toMatchObject({ ticketDiscountBps: "500", ticketDiscountCents: "0", totalCents: "9" });
  });

  it("refuses an inconsistent discount or a ticket left at $0", () => {
    expect(() => createOfflineSale({ ...base, paymentMethod: "CASH", ticketDiscount: { bps: 500n, cents: 2_000_000n }, ticket: [normalWeight] })).toThrow("discount is invalid");
    expect(() => createOfflineSale({ ...base, paymentMethod: "CASH", ticketDiscount: { bps: 10_001n, cents: 1n }, ticket: [normalWeight] })).toThrow("discount is invalid");
    expect(() => createOfflineSale({ ...base, paymentMethod: "CASH", ticketDiscount: { bps: 0n, cents: 5n }, ticket: [normalWeight] })).toThrow("discount is invalid");
    expect(() => createOfflineSale({ ...base, paymentMethod: "CASH", ticketDiscount: { bps: 10_000n, cents: 1_400_000n }, ticket: [normalWeight] })).toThrow("greater than zero");
  });

  it("the manual snapshot survives a JSON round trip through the outbox (offline then sync)", () => {
    const payload = createOfflineSale({ ...base, paymentMethod: "DEBIT", ticketDiscount: { bps: 1_250n, cents: 300_000n }, ticket: [manualUnit, { ...normalWeight, cardSurchargeCents: 0n }] });
    const restored = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(restored.items[0]).toMatchObject({ manualPriceApplied: true, manualUnitPriceCents: "1000000", originalPricePerKgCents: "1200000" });
    expect(restored).toMatchObject({ ticketDiscountBps: "1250", ticketDiscountCents: "300000", subtotalCents: "2400000", totalCents: "2100000" });
  });
});

describe("outbox retry", () => {
  it("uses capped exponential backoff", () => {
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(4)).toBe(16_000);
    expect(retryDelayMs(99)).toBe(300_000);
    expect(nextAttemptAt(2, new Date("2026-09-10T00:00:00.000Z"))).toBe("2026-09-10T00:00:04.000Z");
  });

  it("only retries due non-synced events", () => {
    const base = {
      id: "event",
      aggregateType: "SALE" as const,
      aggregateId: "sale",
      operation: "UPSERT" as const,
      payload: {} as never,
      attempts: 1,
      createdAt: "2026-09-10T00:00:00.000Z",
      lastAttemptAt: null,
      nextAttemptAt: "2026-09-10T00:00:02.000Z",
      lastError: null
    };
    expect(shouldAttempt({ ...base, status: "FAILED" }, new Date("2026-09-10T00:00:03.000Z"))).toBe(true);
    expect(shouldAttempt({ ...base, status: "FAILED" }, new Date("2026-09-10T00:00:01.000Z"))).toBe(false);
    expect(shouldAttempt({ ...base, status: "SYNCED" }, new Date("2026-09-10T00:00:03.000Z"))).toBe(false);
  });
});
