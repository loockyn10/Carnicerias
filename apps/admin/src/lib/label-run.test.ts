import { describe, expect, it } from "vitest";

import { executeLabelRun, LabelRunError, parseLabelRunRequest, prepareLabelRun, snapshotItems, type LabelRunDeps } from "./label-run";
import { parseLabelGroupFacts } from "./label-group";
import { formatRunStamp } from "./label-stamp";
import { inspectPdf } from "./test-support/pdf-inspect";
import { must } from "./test-support/must";

const GROUP = "99999999-9999-4999-8999-999999999999";
const MAYO = "11111111-1111-4111-8111-111111111111";
const ACEITE = "22222222-2222-4222-8222-222222222222";
const YERBA = "33333333-3333-4333-8333-333333333333";
const MOLIDA = "44444444-4444-4444-8444-444444444444";
const SIN_PRECIO = "55555555-5555-4555-8555-555555555555";
const AJENO = "66666666-6666-4666-8666-666666666666";
const RUN = "77777777-7777-4777-8777-777777777777";

function payload(overrides: { active?: boolean; mayoPrice?: string } = {}) {
  const item = (productId: string, position: number, name: string, price: string | null, extra: Record<string, unknown> = {}) => ({
    productId, position, name, sku: null, unitType: "UNIT", available: price !== null, unavailableReason: price === null ? "NO_PRICE" : null, listPriceCents: price,
    bulkMinimumUnits: 3, bulkDiscountBps: 1_500, last: null, ...extra
  });
  return {
    groupId: GROUP, name: "Góndolas Despensa Central", branchId: "b1", branchName: "Central", active: overrides.active ?? true,
    items: [
      item(MAYO, 0, "Mayonesa Hellmann's 250gr", overrides.mayoPrice ?? "205000"),
      item(ACEITE, 1, "Aceite Cañuelas 900ml", "625000", { bulkMinimumUnits: null, bulkDiscountBps: null }),
      item(YERBA, 2, "Yerba Aguantadora 1kg", "410000"),
      item(MOLIDA, 3, "Molida vacuna", "1100000", { unitType: "WEIGHT", bulkMinimumUnits: null, bulkDiscountBps: null }),
      item(SIN_PRECIO, 4, "Sin precio", null)
    ]
  };
}

function deps(group: unknown = payload(), recorded: unknown = { runId: RUN }) {
  const calls: { getGroup: string[]; recordRun: { groupId: string; items: Record<string, unknown>[] }[] } = { getGroup: [], recordRun: [] };
  const value: LabelRunDeps = {
    getGroup: (groupId) => { calls.getGroup.push(groupId); return Promise.resolve(group); },
    recordRun: (groupId, items) => {
      calls.recordRun.push({ groupId, items });
      if (recorded instanceof Error) return Promise.reject(recorded);
      return Promise.resolve(recorded);
    }
  };
  return { value, calls };
}
const request = (items: { productId: string; copies: number }[]) => ({ groupId: GROUP, items });
const context = { timeZone: "America/Argentina/Buenos_Aires", now: new Date("2026-10-07T18:42:00Z") };

describe("pedido de generación", () => {
  it("acepta sólo ids y copias; ignora cualquier precio, nombre o promoción que mande el navegador", () => {
    const parsed = parseLabelRunRequest({
      groupId: GROUP.toUpperCase(), items: [{ productId: MAYO, copies: 2, price: 1, priceCents: 1, name: "GRATIS", promo: true, listPriceCents: 1 }], priceCents: 5
    });
    expect(parsed).toEqual({ ok: true, value: { groupId: GROUP, items: [{ productId: MAYO, copies: 2 }] } });
  });

  it("valida copias (entero 1..99), ids, repetidos, vacío y el tope de etiquetas", () => {
    const bad = (body: unknown) => parseLabelRunRequest(body).ok;
    expect(bad(null)).toBe(false);
    expect(bad({ groupId: "x", items: [] })).toBe(false);
    expect(bad({ groupId: GROUP, items: [] })).toBe(false);
    expect(bad({ groupId: GROUP, items: [{ productId: "no-uuid", copies: 1 }] })).toBe(false);
    for (const copies of [0, -1, 1.5, 100, "2", null, Number.NaN]) expect(bad({ groupId: GROUP, items: [{ productId: MAYO, copies }] }), String(copies)).toBe(false);
    for (const copies of [1, 2, 99]) expect(bad({ groupId: GROUP, items: [{ productId: MAYO, copies }] }), String(copies)).toBe(true);
    expect(bad({ groupId: GROUP, items: [{ productId: MAYO, copies: 1 }, { productId: MAYO.toUpperCase(), copies: 1 }] })).toBe(false);
    const six = ["a", "b", "c", "d", "e", "f"].map((c) => ({ productId: `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`, copies: 99 }));
    expect(bad({ groupId: GROUP, items: six })).toBe(false);
  });
});

describe("preparar la generación: el servidor resuelve los precios", () => {
  const facts = () => {
    const parsed = parseLabelGroupFacts(payload());
    if (!parsed) throw new Error("grupo");
    return parsed;
  };

  it("arma las etiquetas con los hechos de la base (precio vigente + regla de la sucursal)", () => {
    const prepared = prepareLabelRun(facts(), request([{ productId: MAYO, copies: 1 }, { productId: ACEITE, copies: 1 }, { productId: MOLIDA, copies: 1 }]));
    expect(prepared.map((entry) => entry.label.variant)).toEqual(["PROMO", "SIMPLE", "WEIGHT"]);
    expect(prepared[0]?.label.price).toBe("$ 1.742,50");
    expect(prepared[1]?.label.price).toBe("$ 6.250");
    expect(prepared[2]?.label.price).toBe("$ 11.000");
  });

  it("el orden es el del GRUPO, no el de los clics ni el del pedido", () => {
    const prepared = prepareLabelRun(facts(), request([{ productId: YERBA, copies: 1 }, { productId: MAYO, copies: 1 }, { productId: ACEITE, copies: 1 }]));
    expect(prepared.map((entry) => entry.productId)).toEqual([MAYO, ACEITE, YERBA]);
  });

  it("rechaza un producto que no es del grupo (p. ej. de otra organización)", () => {
    expect(() => prepareLabelRun(facts(), request([{ productId: AJENO, copies: 1 }]))).toThrowError(expect.objectContaining({ status: 422 }) as Error);
  });

  it("rechaza un producto que hoy no se puede imprimir (sin precio) y lo nombra", () => {
    try {
      prepareLabelRun(facts(), request([{ productId: MAYO, copies: 1 }, { productId: SIN_PRECIO, copies: 1 }]));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LabelRunError);
      expect((error as LabelRunError).status).toBe(422);
      expect((error as LabelRunError).message).toContain("Sin precio");
    }
  });

  it("un grupo archivado no genera", () => {
    const archived = parseLabelGroupFacts(payload({ active: false }));
    expect(() => prepareLabelRun(must(archived), request([{ productId: MAYO, copies: 1 }]))).toThrowError(expect.objectContaining({ status: 409 }) as Error);
  });
});

describe("generar: PDF + registro", () => {
  it("devuelve un PDF A4 real y registra la generación con exactamente lo que se dibujó", async () => {
    const { value, calls } = deps();
    const result = await executeLabelRun(value, request([{ productId: MAYO, copies: 2 }, { productId: ACEITE, copies: 1 }]), context);
    expect(result).toMatchObject({ runId: RUN, labelCount: 3, productCount: 2, pageCount: 1, filename: "etiquetas-gondolas-despensa-central-20261007-1542.pdf" });

    // El PDF dibuja los precios que resolvió el servidor…
    const [page] = await inspectPdf(result.pdf);
    const texts = (page?.texts ?? []).map((entry) => entry.text);
    expect(texts.filter((entry) => entry === "$ 1.742,50")).toHaveLength(2);
    expect(texts).toContain("$ 6.250");
    // …y el snapshot registrado son esos mismos valores (centavos exactos).
    expect(calls.recordRun).toHaveLength(1);
    expect(calls.recordRun[0]?.groupId).toBe(GROUP);
    expect(calls.recordRun[0]?.items).toEqual([
      { productId: MAYO, copies: 2, displayedName: "MAYONESA HELLMANN'S 250GR", unitType: "UNIT", variant: "PROMO", listPriceCents: 205_000, promoPriceCents: 174_250, promoMinimumUnits: 3, promoDiscountBps: 1_500, conditionText: "POR 3 UNIDADES - Descuento 15%" },
      { productId: ACEITE, copies: 1, displayedName: "ACEITE CAÑUELAS 900ML", unitType: "UNIT", variant: "SIMPLE", listPriceCents: 625_000, promoPriceCents: null, promoMinimumUnits: null, promoDiscountBps: null, conditionText: null }
    ]);
  });

  it("el cliente no puede imponer un precio: si manda uno distinto, igual se imprime el que resuelve el servidor", async () => {
    const parsed = parseLabelRunRequest({ groupId: GROUP, items: [{ productId: MAYO, copies: 1, listPriceCents: 1, promoPriceCents: 1, price: "$ 1" }] });
    if (!parsed.ok) throw new Error(parsed.error);
    const { value, calls } = deps(payload({ mayoPrice: "225000" }));
    const result = await executeLabelRun(value, parsed.value, context);
    const [page] = await inspectPdf(result.pdf);
    expect((page?.texts ?? []).map((entry) => entry.text)).toContain("$ 1.912,50");
    expect(calls.recordRun[0]?.items[0]).toMatchObject({ listPriceCents: 225_000, promoPriceCents: 191_250 });
  });

  it("vuelve a leer el grupo en cada generación (nunca reutiliza precios de una pantalla vieja)", async () => {
    const { value, calls } = deps();
    await executeLabelRun(value, request([{ productId: MAYO, copies: 1 }]), context);
    await executeLabelRun(value, request([{ productId: MAYO, copies: 1 }]), context);
    expect(calls.getGroup).toEqual([GROUP, GROUP]);
  });

  it("copias: 22 etiquetas → 2 páginas; 43 → 3; el conteo registrado es de etiquetas físicas", async () => {
    const sixteen = deps();
    const r16 = await executeLabelRun(sixteen.value, request([{ productId: MAYO, copies: 12 }, { productId: ACEITE, copies: 10 }]), context);
    expect(r16).toMatchObject({ labelCount: 22, pageCount: 2 });
    expect(await inspectPdf(r16.pdf)).toHaveLength(2);
    const thirtySeven = deps();
    const r37 = await executeLabelRun(thirtySeven.value, request([{ productId: MAYO, copies: 25 }, { productId: ACEITE, copies: 18 }]), context);
    expect(r37).toMatchObject({ labelCount: 43, pageCount: 3 });
  });

  it("otra organización (la base devuelve NULL por RLS) → 404, sin PDF ni registro", async () => {
    const { value, calls } = deps(null);
    await expect(executeLabelRun(value, request([{ productId: MAYO, copies: 1 }]), context)).rejects.toMatchObject({ status: 404 });
    expect(calls.recordRun).toHaveLength(0);
  });

  it("si no se puede registrar la generación NO se entrega el archivo", async () => {
    const failing = deps(payload(), new Error("permission denied"));
    await expect(executeLabelRun(failing.value, request([{ productId: MAYO, copies: 1 }]), context)).rejects.toMatchObject({ status: 500 });
    const noRun = deps(payload(), { nope: true });
    await expect(executeLabelRun(noRun.value, request([{ productId: MAYO, copies: 1 }]), context)).rejects.toMatchObject({ status: 500 });
  });

  it("no expone costos ni márgenes: el snapshot sólo trae lo impreso", () => {
    const facts = parseLabelGroupFacts(payload());
    const prepared = prepareLabelRun(must(facts), request([{ productId: MAYO, copies: 1 }]));
    const json = JSON.stringify(snapshotItems(prepared));
    expect(json).not.toMatch(/cost|margin|stock|supplier/i);
    expect(Object.keys(snapshotItems(prepared)[0] ?? {}).sort()).toEqual([
      "conditionText", "copies", "displayedName", "listPriceCents", "productId", "promoDiscountBps", "promoMinimumUnits", "promoPriceCents", "unitType", "variant"
    ]);
  });
});

describe("fecha del historial", () => {
  it("usa la zona horaria de la organización", () => {
    const stamp = formatRunStamp(new Date("2026-10-07T18:42:00Z"), "America/Argentina/Buenos_Aires");
    expect(stamp).toEqual({ file: "20261007-1542", display: "07/10/2026 15:42" });
    expect(formatRunStamp(new Date("2026-10-07T02:30:00Z"), "America/Argentina/Buenos_Aires").display).toBe("06/10/2026 23:30");
  });
});
