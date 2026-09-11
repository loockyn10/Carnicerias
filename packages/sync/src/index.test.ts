import { describe, expect, it } from "vitest";

import { createOfflineSale, nextAttemptAt, retryDelayMs, shouldAttempt } from "./index";

const ids = Array.from({ length: 10 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);

describe("offline sale envelope", () => {
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
