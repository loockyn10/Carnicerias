import { describe, expect, it } from "vitest";

import { feedFilename, feedPriceSignature, isPending, parsePromotionFeedState, pendingPromotions, skippedPromotions, type PromotionFeedState } from "./promotion-feed";
import { itemId, packPromotion, photoOf, rawItem, thresholdPromotion } from "./test-support/folder-fixtures";
import { must } from "./test-support/must";

const NOW = new Date("2026-11-18T15:00:00Z");
type Raw = Record<string, unknown>;

/** Una promoción tal como la entrega `get_promotion_feed_state` (n = posición; precio de lista y pack configurables). */
function promo(n: number, options: { name?: string; listPriceCents?: number; packPriceCents?: string; reason?: string | null; extra?: Raw; promotion?: Raw; downloaded?: Raw | null } = {}): Raw {
  return {
    ...rawItem({
      n, name: options.name ?? `Producto ${String(n)}`, listPriceCents: options.listPriceCents ?? 1_000_000, reason: options.reason ?? null,
      promotion: options.promotion ?? packPromotion(n, { packPriceCents: options.packPriceCents ?? "1400000" }), extra: options.extra ?? {}
    }),
    downloaded: options.downloaded ?? null
  };
}

function rawState(items: Raw[], lastBatch: Raw | null = null): Raw {
  return { branchId: "c3000000-0000-4000-8000-000000000001", branchName: "Central", items, lastBatch };
}

function parse(raw: Raw): PromotionFeedState {
  return must(parsePromotionFeedState(raw, NOW));
}

/** Lo que el celular registró al descargar: la firma de cada pieza de hoy. */
function downloadedAs(state: PromotionFeedState): Map<string, Raw> {
  return new Map(state.items.map((item) => [item.promotionId, { signature: item.signature, summary: item.summary, at: "2026-11-18T12:00:00Z", batchId: "b0000000-0000-4000-8000-000000000001" }]));
}

const BATCH = "b0000000-0000-4000-8000-000000000001";

describe("estado de la descarga Feed", () => {
  it("lee las promociones con la firma de hoy, lo descargado y la última tanda", () => {
    const state = parse(rawState([
      promo(1, { downloaded: { signature: "a".repeat(64), summary: "$ 14.000 · por 2 kg", at: "2026-11-17T10:00:00Z", batchId: BATCH } }),
      promo(2, { reason: "PROMO_EXPIRED", promotion: packPromotion(2, { status: "EXPIRED" }) })
    ], { batchId: BATCH, at: "2026-11-17T10:00:00Z", count: 1 }));
    expect(state.branchName).toBe("Central");
    expect(state.lastBatch).toEqual({ batchId: BATCH, at: "2026-11-17T10:00:00Z", count: 1 });
    const [first, second] = state.items;
    expect(first?.promotionId).toBe(itemId(1));
    expect(first?.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.downloaded?.signature).toBe("a".repeat(64));
    expect(second?.signature).toBeNull();
    expect(parsePromotionFeedState(null)).toBeNull();
    expect(parsePromotionFeedState({ items: "x" })).toBeNull();
  });

  it("1) primera descarga: las 94 promociones activas están pendientes", () => {
    const state = parse(rawState(Array.from({ length: 94 }, (_, index) => promo(index + 1))));
    expect(pendingPromotions(state)).toHaveLength(94);
  });

  it("2) sin modificaciones: ninguna pendiente", () => {
    const items = Array.from({ length: 94 }, (_, index) => promo(index + 1));
    const done = downloadedAs(parse(rawState(items)));
    const again = parse(rawState(items.map((item) => ({ ...item, downloaded: done.get(String(item.entryId)) }))));
    expect(pendingPromotions(again)).toHaveLength(0);
  });

  it("3) cambian 10 precios: 10 pendientes, exactamente esas", () => {
    const items = Array.from({ length: 94 }, (_, index) => promo(index + 1));
    const done = downloadedAs(parse(rawState(items)));
    const changed = new Set([3, 7, 11, 20, 33, 41, 58, 60, 77, 94]);
    const today = Array.from({ length: 94 }, (_, index) => {
      const n = index + 1;
      return promo(n, { packPriceCents: changed.has(n) ? "1350000" : "1400000", downloaded: must(done.get(itemId(n))) });
    });
    const pending = pendingPromotions(parse(rawState(today)));
    expect(pending.map((item) => item.position)).toEqual([...changed]);
  });

  it("4) cambian 5 precios y se crean 2 promociones: 7 pendientes", () => {
    const items = Array.from({ length: 94 }, (_, index) => promo(index + 1));
    const done = downloadedAs(parse(rawState(items)));
    const today = [
      ...Array.from({ length: 94 }, (_, index) => promo(index + 1, { packPriceCents: index < 5 ? "1300000" : "1400000", downloaded: must(done.get(itemId(index + 1))) })),
      promo(95), promo(96)
    ];
    expect(pendingPromotions(parse(rawState(today)))).toHaveLength(7);
  });

  it("5) cambia el precio del PRODUCTO de la promoción (precio normal y porcentaje): pendiente", () => {
    const pack = promo(1, { listPriceCents: 1_000_000 });
    const percent = promo(2, { listPriceCents: 1_000_000, promotion: thresholdPromotion(2) });
    const done = downloadedAs(parse(rawState([pack, percent])));
    const today = parse(rawState([
      promo(1, { listPriceCents: 1_050_000, downloaded: must(done.get(itemId(1))) }),
      promo(2, { listPriceCents: 1_050_000, promotion: thresholdPromotion(2), downloaded: must(done.get(itemId(2))) })
    ]));
    // El pack muestra «precio normal» de esa cantidad; el 10 % baja el precio por kilo: las dos piezas cambian.
    expect(pendingPromotions(today).map((item) => item.position)).toEqual([1, 2]);
  });

  it("no se vuelve pendiente por datos que NO cambian los importes: nombre, foto, vigencia, SKU, orden", () => {
    const before = promo(1);
    const done = downloadedAs(parse(rawState([before])));
    const after = promo(1, {
      name: "Otro nombre", extra: { sku: "OTRO", photo: photoOf(9, false), position: 40 },
      promotion: packPromotion(1, { validUntil: "2026-12-31T00:00:00Z", validFrom: "2026-11-01T00:00:00Z" }), downloaded: must(done.get(itemId(1)))
    });
    expect(pendingPromotions(parse(rawState([after])))).toHaveLength(0);
  });

  it("la condición de la promoción también cuenta (desde 2 kg → desde 3 kg), aunque el precio no cambie", () => {
    const done = downloadedAs(parse(rawState([promo(1, { promotion: thresholdPromotion(1) })])));
    const after = promo(1, { promotion: thresholdPromotion(1, { minimumGrams: 3000 }), downloaded: must(done.get(itemId(1))) });
    expect(pendingPromotions(parse(rawState([after])))).toHaveLength(1);
  });

  it("lo que hoy no se puede generar no queda pendiente y se informa con su motivo", () => {
    const state = parse(rawState([
      promo(1),
      promo(2, { reason: "NO_PRICE" }),
      promo(3, { reason: "NOT_IN_BRANCH" }),
      promo(4, { listPriceCents: 0 })
    ]));
    expect(pendingPromotions(state).map((item) => item.position)).toEqual([1]);
    expect(skippedPromotions(state)).toEqual([
      { name: "Producto 2", reason: "Sin precio vigente" }, { name: "Producto 3", reason: "No aplica a esta sucursal" }, { name: "Producto 4", reason: "Sin precio vigente" }
    ]);
  });

  it("la firma es estable (misma pieza, misma firma) y cambia con lo dibujado", () => {
    const one = must(parse(rawState([promo(1)])).items[0]);
    const same = must(parse(rawState([promo(1)])).items[0]);
    const other = must(parse(rawState([promo(1, { packPriceCents: "1399900" })])).items[0]);
    expect(feedPriceSignature(one)).toBe(feedPriceSignature(same));
    expect(feedPriceSignature(one)).not.toBe(feedPriceSignature(other));
    expect(isPending({ signature: one.signature, downloaded: { signature: must(one.signature), summary: null, at: null, batchId: BATCH } })).toBe(false);
    expect(isPending({ signature: null, downloaded: null })).toBe(false);
  });

  it("nombre de archivo PNG reconocible y único por promoción", () => {
    expect(feedFilename({ name: "Pata Muslo «oferta»", promotionId: "96000000-0000-4000-8000-000000000001" }, "2026-11-18"))
      .toBe("Promo-Feed_pata-muslo-oferta_2026-11-18_000001.png");
  });
});
