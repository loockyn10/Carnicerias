import { describe, expect, it } from "vitest";

import {
  buildApplyItems, countPreview, deserializePending, describeChange, failureText, getChange, groupPendingByBranch, itemsSignature, newRequestKey, parseChangeQuantity,
  parseQuickOutcome, pendingTotal, productsText, reconcilePending, removeChange, removeProblem, RequestKeyBook, savedSummary, serializePending, signedChangeQuantity,
  SingleFlight, upsertChange, type PendingChanges, type QuickChange
} from "./quick-stock";

const AVENIDA = "d3000000-0000-4000-8000-000000000002";
const JANSSEN = "d3000000-0000-4000-8000-000000000003";
const PATA = "d5000000-0000-4000-8000-000000000001";
const MOLIDA = "d5000000-0000-4000-8000-000000000011";
const COCA = "d5000000-0000-4000-8000-000000000013";

const change = (over: Partial<QuickChange> = {}): QuickChange => ({ branchId: AVENIDA, productId: PATA, productName: "Pata muslo", unitType: "WEIGHT", mode: "ADD", raw: "15", ...over });

describe("cantidades que escribe el usuario", () => {
  it("WEIGHT: kg con coma o punto y hasta 3 decimales, siempre positivo", () => {
    expect(parseChangeQuantity("15", "WEIGHT")).toEqual({ ok: true, quantity: 15_000 });
    expect(parseChangeQuantity("3,5", "WEIGHT")).toEqual({ ok: true, quantity: 3_500 });
    expect(parseChangeQuantity("0.250", "WEIGHT")).toEqual({ ok: true, quantity: 250 });
    expect(parseChangeQuantity("0", "WEIGHT").ok).toBe(false);
    expect(parseChangeQuantity("-3", "WEIGHT").ok).toBe(false);
    expect(parseChangeQuantity("1,2345", "WEIGHT").ok).toBe(false);
    expect(parseChangeQuantity("", "WEIGHT").ok).toBe(false);
  });

  it("UNIT: sólo unidades enteras", () => {
    expect(parseChangeQuantity("12", "UNIT")).toEqual({ ok: true, quantity: 12 });
    expect(parseChangeQuantity("1,5", "UNIT").ok).toBe(false);
    expect(parseChangeQuantity("0", "UNIT").ok).toBe(false);
  });

  it("el usuario NO escribe el signo: lo pone el botón Agregar / Quitar", () => {
    expect(signedChangeQuantity(change({ mode: "ADD", raw: "15" }))).toBe(15_000);
    expect(signedChangeQuantity(change({ mode: "REMOVE", raw: "3,5" }))).toBe(-3_500);
    expect(signedChangeQuantity(change({ mode: "ADD", raw: "12", unitType: "UNIT" }))).toBe(12);
    expect(signedChangeQuantity(change({ mode: "REMOVE", raw: "5", unitType: "UNIT" }))).toBe(-5);
    expect(signedChangeQuantity(change({ raw: "abc" }))).toBeNull();
  });

  it("describe el cambio con el signo y la unidad correctos", () => {
    expect(describeChange(change({ mode: "ADD", raw: "15" }))).toBe("+15,000 kg");
    expect(describeChange(change({ mode: "REMOVE", raw: "2" }))).toBe("-2,000 kg");
    expect(describeChange(change({ mode: "ADD", raw: "12", unitType: "UNIT" }))).toBe("+12 u");
    expect(describeChange(change({ raw: "x" }))).toBe("—");
  });

  it("no deja quitar más de lo que hay (y sugiere el Conteo)", () => {
    expect(removeProblem(16_600, 3_500, "WEIGHT")).toBeNull();
    expect(removeProblem(16_600, 16_600, "WEIGHT")).toBeNull();
    expect(removeProblem(3_000, 3_500, "WEIGHT")).toContain("Hay sólo 3,000 kg");
    expect(removeProblem(0, 1, "UNIT")).toContain("Conteo");
    expect(removeProblem(-4, 1, "UNIT")).toContain("Conteo");
  });
});

describe("conteo físico: el usuario no hace cuentas", () => {
  it("el caso real: el sistema dice 16,6 kg y se contaron 4,2 → ajuste de -12,400 kg", () => {
    const preview = countPreview("4,2", "WEIGHT", 16_600);
    expect(preview).toEqual({ state: "ok", physicalQuantity: 4_200, difference: -12_400, matches: false, message: "Se registrará un ajuste de -12,400 kg" });
  });

  it("diferencia positiva, cero válido, coincidencia y entradas inválidas", () => {
    expect(countPreview("20", "WEIGHT", 16_600)).toMatchObject({ state: "ok", difference: 3_400, message: "Se registrará un ajuste de +3,400 kg" });
    expect(countPreview("0", "WEIGHT", 16_600)).toMatchObject({ state: "ok", physicalQuantity: 0, difference: -16_600 });
    expect(countPreview("16,6", "WEIGHT", 16_600)).toMatchObject({ state: "ok", matches: true, difference: 0 });
    expect(countPreview("11", "UNIT", 8)).toMatchObject({ state: "ok", difference: 3, message: "Se registrará un ajuste de +3 u" });
    expect(countPreview("", "WEIGHT", 100)).toEqual({ state: "empty" });
    expect(countPreview("1,5", "UNIT", 8)).toMatchObject({ state: "invalid" });
    expect(countPreview("-1", "WEIGHT", 8)).toMatchObject({ state: "invalid" });
  });
});

describe("cambios pendientes", () => {
  it("un producto tiene UN cambio por sucursal: el último reemplaza al anterior", () => {
    let pending: PendingChanges = {};
    pending = upsertChange(pending, change({ mode: "ADD", raw: "15" }));
    pending = upsertChange(pending, change({ mode: "REMOVE", raw: "3" }));
    expect(pendingTotal(pending)).toBe(1);
    expect(getChange(pending, AVENIDA, PATA)).toMatchObject({ mode: "REMOVE", raw: "3" });
  });

  it("cambiar de sucursal NO pierde lo cargado: cada sucursal conserva lo suyo", () => {
    let pending: PendingChanges = {};
    pending = upsertChange(pending, change({ productId: PATA }));
    pending = upsertChange(pending, change({ productId: MOLIDA, productName: "Molida", raw: "8" }));
    pending = upsertChange(pending, change({ branchId: JANSSEN, productId: PATA, raw: "6" }));
    expect(pendingTotal(pending)).toBe(3);
    expect(getChange(pending, AVENIDA, PATA)?.raw).toBe("15");
    expect(getChange(pending, JANSSEN, PATA)?.raw).toBe("6");
  });

  it("quitar un cambio vacía la sucursal si era el último y no toca el resto", () => {
    let pending = upsertChange(upsertChange({}, change()), change({ branchId: JANSSEN }));
    pending = removeChange(pending, AVENIDA, PATA);
    expect(Object.keys(pending)).toEqual([JANSSEN]);
    expect(removeChange(pending, AVENIDA, PATA)).toBe(pending);
    expect(removeChange(pending, JANSSEN, PATA)).toEqual({});
  });

  it("agrupa por sucursal en el orden pedido y ordena los productos por nombre", () => {
    let pending: PendingChanges = {};
    pending = upsertChange(pending, change({ branchId: JANSSEN, productId: MOLIDA, productName: "Molida" }));
    pending = upsertChange(pending, change({ productId: COCA, productName: "Coca", unitType: "UNIT" }));
    pending = upsertChange(pending, change({ productId: PATA, productName: "Pata muslo" }));
    const groups = groupPendingByBranch(pending, [AVENIDA, JANSSEN]);
    expect(groups.map((group) => group.branchId)).toEqual([AVENIDA, JANSSEN]);
    expect(groups[0]?.changes.map((item) => item.productName)).toEqual(["Coca", "Pata muslo"]);
    // Una sucursal que ya no está en la lista no se pierde: va al final.
    expect(groupPendingByBranch(pending, [AVENIDA]).map((group) => group.branchId)).toEqual([AVENIDA, JANSSEN]);
  });

  it("textos de cantidad de productos", () => {
    expect(productsText(1)).toBe("1 producto");
    expect(productsText(4)).toBe("4 productos");
    expect(savedSummary({ applied: 1 })).toBe("1 producto modificado");
    expect(savedSummary({ applied: 4 })).toBe("4 productos modificados");
  });
});

describe("persistencia local", () => {
  it("guarda y recupera los cambios", () => {
    const pending = upsertChange(upsertChange({}, change()), change({ branchId: JANSSEN, productId: COCA, unitType: "UNIT", raw: "12" }));
    expect(deserializePending(serializePending(pending))).toEqual(pending);
  });

  it("descarta lo corrupto o inválido sin romper", () => {
    expect(deserializePending(null)).toEqual({});
    expect(deserializePending("")).toEqual({});
    expect(deserializePending("{no es json")).toEqual({});
    expect(deserializePending("[]")).toEqual({});
    expect(deserializePending("42")).toEqual({});
    const valid = change();
    const mixed = JSON.stringify({
      [AVENIDA]: { [PATA]: valid, [MOLIDA]: { ...valid, productId: MOLIDA, raw: "abc" }, "otro": { ...valid, productId: PATA } },
      "no-es-uuid": { x: 1 }, [JANSSEN]: null
    });
    expect(deserializePending(mixed)).toEqual({ [AVENIDA]: { [PATA]: valid } });
  });
});

describe("pedido al servidor", () => {
  it("las líneas salen en un orden estable (sucursal, producto): el mismo pedido da la misma huella", () => {
    const a = upsertChange(upsertChange(upsertChange({}, change({ productId: MOLIDA })), change({ branchId: JANSSEN })), change({ productId: PATA }));
    const b = upsertChange(upsertChange(upsertChange({}, change({ productId: PATA })), change({ branchId: JANSSEN })), change({ productId: MOLIDA }));
    expect(itemsSignature(buildApplyItems(a))).toBe(itemsSignature(buildApplyItems(b)));
    expect(buildApplyItems(a).map((item) => `${item.branchId.slice(-2)}/${item.productId.slice(-2)}`)).toEqual(["02/01", "02/11", "03/01"]);
  });

  it("no manda signos ni cantidades ya convertidas: el servidor las interpreta con el tipo real del producto", () => {
    const items = buildApplyItems(upsertChange({}, change({ mode: "REMOVE", raw: " 3,5 " })));
    expect(items).toEqual([{ branchId: AVENIDA, productId: PATA, mode: "REMOVE", raw: "3,5" }]);
  });

  it("la clave de idempotencia se conserva mientras el pedido no cambie y se renueva cuando cambia o el servidor respondió", () => {
    const book = new RequestKeyBook();
    let counter = 0;
    const generate = () => `key-${String(++counter)}`;
    expect(book.keyFor("A", generate)).toBe("key-1");
    expect(book.keyFor("A", generate)).toBe("key-1"); // reintento tras un corte: la MISMA clave, no duplica
    expect(book.keyFor("B", generate)).toBe("key-2"); // otro pedido: otra clave
    book.clear();
    expect(book.keyFor("B", generate)).toBe("key-3"); // el servidor ya respondió: un pedido igual se evalúa de nuevo
  });

  it("genera claves con forma de UUID v4", () => {
    const key = newRequestKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newRequestKey()).not.toBe(key);
  });
});

describe("doble toque", () => {
  it("SingleFlight: mientras hay un guardado en curso, los demás toques no hacen nada (no se duplica el ingreso)", async () => {
    const flight = new SingleFlight();
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = flight.run(async () => { calls += 1; await gate; return "guardado"; });
    const second = flight.run(() => { calls += 1; return Promise.resolve("duplicado"); });
    const third = flight.run(() => { calls += 1; return Promise.resolve("duplicado"); });
    expect(await second).toEqual({ ran: false });
    expect(await third).toEqual({ ran: false });
    release();
    expect(await first).toEqual({ ran: true, value: "guardado" });
    expect(calls).toBe(1);
  });

  it("SingleFlight: cuando termina (aunque falle) se puede volver a guardar", async () => {
    const flight = new SingleFlight();
    await expect(flight.run(() => Promise.reject(new Error("sin red")))).rejects.toThrow("sin red");
    expect(await flight.run(() => Promise.resolve(1))).toEqual({ ran: true, value: 1 });
  });
});

describe("resultado del servidor", () => {
  const response = {
    requested: 4, applied: 2, unchanged: 1, failed: 1, replayed: false,
    items: [
      { branchId: AVENIDA, productId: PATA, mode: "ADD", ok: true, unchanged: false, before: 16_600, after: 31_600, difference: 15_000 },
      { branchId: AVENIDA, productId: MOLIDA, mode: "COUNT", ok: true, unchanged: true, before: 8_000, after: 8_000, difference: 0 },
      { branchId: AVENIDA, productId: COCA, mode: "REMOVE", ok: false, code: "INSUFFICIENT_STOCK", current: 15 },
      { branchId: JANSSEN, productId: PATA, mode: "ADD", ok: true, unchanged: false, before: 4_000, after: 10_000, difference: 6_000 }
    ]
  };

  it("lee las líneas y cuenta aplicadas / sin cambio / fallidas", () => {
    const outcome = parseQuickOutcome(response);
    expect(outcome).toMatchObject({ applied: 2, unchanged: 1, failed: 1, replayed: false });
    expect(outcome?.items).toHaveLength(4);
  });

  it("una respuesta rara no rompe la pantalla", () => {
    expect(parseQuickOutcome(null)).toBeNull();
    expect(parseQuickOutcome("x")).toBeNull();
    expect(parseQuickOutcome({})).toBeNull();
    expect(parseQuickOutcome({ items: [null, 3, { branchId: 1 }] })).toMatchObject({ applied: 0, failed: 0, items: [] });
    expect(parseQuickOutcome({ replayed: true, items: [] })?.replayed).toBe(true);
  });

  it("explica cada fallo en palabras del negocio, con la unidad del producto", () => {
    const outcome = parseQuickOutcome(response);
    const failure = outcome?.items.find((item) => !item.ok);
    if (!failure) throw new Error("expected a failed item");
    expect(failureText(failure, "UNIT")).toBe("Hay sólo 15 u: no se puede quitar tanto.");
    expect(failureText({ ok: false, branchId: AVENIDA, productId: PATA, mode: "COUNT", code: "STOCK_CHANGED", current: 5, message: null }, "WEIGHT")).toContain("Volvé a contar");
    expect(failureText({ ok: false, branchId: AVENIDA, productId: PATA, mode: "ADD", code: "NOT_IN_BRANCH", current: null, message: null }, "WEIGHT")).toContain("no se vende en esta sucursal");
    expect(failureText({ ok: false, branchId: AVENIDA, productId: PATA, mode: "ADD", code: "FAILED", current: null, message: "boom" }, "WEIGHT")).toBe("No se pudo guardar. Probá de nuevo.");
  });

  it("limpia los pendientes guardados y conserva los que fallaron (nada se pierde en silencio)", () => {
    let pending: PendingChanges = {};
    pending = upsertChange(pending, change({ productId: PATA }));
    pending = upsertChange(pending, change({ productId: MOLIDA, productName: "Molida", mode: "ADD" }));
    pending = upsertChange(pending, change({ productId: COCA, productName: "Coca", unitType: "UNIT", mode: "REMOVE", raw: "16" }));
    pending = upsertChange(pending, change({ branchId: JANSSEN, productId: PATA }));
    const outcome = parseQuickOutcome(response);
    if (!outcome) throw new Error("outcome");
    const rest = reconcilePending(pending, outcome);
    expect(Object.keys(rest[AVENIDA] ?? {}).sort()).toEqual([COCA]);
    expect(rest[JANSSEN]).toBeUndefined();
    expect(pendingTotal(rest)).toBe(1);
  });
});
