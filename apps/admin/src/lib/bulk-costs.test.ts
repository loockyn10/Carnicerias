import { describe, expect, it } from "vitest";

import {
  centsToField, changedBulkItems, costAfterEdit, displayedMarginBps, hasBlockingErrors, isRequestKey, marginChange, parseBulkItems, parseCostCents,
  parseMarginBps, parseReceivedQuantity, priceChange, priceEditable, rowFieldErrors, ruleAfterEdit, toReceiptRpcItems, type BulkEditRowRef
} from "./bulk-costs";

// Configuración real de Fran: margen global 40 %; SÓLO Cerdo está en «Categorías excluidas del margen automático». Vaca y Pollo son mercadería
// comprada (costo + margen). Ninguna prueba depende de los NOMBRES de las categorías: el dato es `excludedCategory` (la configuración).
const base = { unitType: "UNIT" as const, currentPriceCents: 562_500, excludedCategory: false, organizationMarginBps: 4_000 };
const global40: BulkEditRowRef = { ...base, id: "g", currentCostCents: 350_000, customMarginBps: null, globalMarginBps: 4_000 };
const own5: BulkEditRowRef = { ...base, id: "p", currentCostCents: 450_000, customMarginBps: 500, globalMarginBps: null };
// Categoría excluida, sin margen propio: precio manual (Cerdo). Con y sin costo.
const manual: BulkEditRowRef = { ...base, id: "m", unitType: "WEIGHT", currentCostCents: 900_000, currentPriceCents: 1_065_000, excludedCategory: true, customMarginBps: null, globalMarginBps: null };
const manualNoCost: BulkEditRowRef = { ...manual, id: "mn", currentCostCents: null };
// Vaca y Pollo: NO excluidas → margen global, precio automático.
const vaca: BulkEditRowRef = { ...base, id: "v", unitType: "WEIGHT", currentCostCents: 900_000, currentPriceCents: 1_500_000, globalMarginBps: 4_000, customMarginBps: null };
const pollo: BulkEditRowRef = { ...base, id: "pl", unitType: "WEIGHT", currentCostCents: 400_000, currentPriceCents: 665_000, globalMarginBps: 4_000, customMarginBps: null };
const rows = [global40, own5, manual];

describe("margen mostrado vs. override persistido", () => {
  it("global 40% se muestra como 40 pero no crea override", () => {
    expect(displayedMarginBps(global40)).toBe(4_000);
    expect(changedBulkItems(rows, {})).toEqual([]);
    // Tocar el campo sin cambiar el valor (escribir 40 o 40,00) tampoco guarda nada.
    expect(changedBulkItems(rows, { g: { margin: "40" } })).toEqual([]);
    expect(changedBulkItems(rows, { g: { margin: "40,00" } })).toEqual([]);
  });

  it("editar 40 → 30 crea margen propio 30%", () => {
    expect(changedBulkItems(rows, { g: { margin: "30" } })).toEqual([{ productId: "g", marginBps: 3_000 }]);
  });

  it("margen propio 5% se muestra como 5 y el mismo valor no cambia nada", () => {
    expect(displayedMarginBps(own5)).toBe(500);
    expect(changedBulkItems(rows, { p: { margin: "5" } })).toEqual([]);
    expect(changedBulkItems(rows, { p: { margin: "5,5" } })).toEqual([{ productId: "p", marginBps: 550 }]);
  });

  it("categoría excluida sin margen propio: no muestra margen (precio manual); escribir 25 crea margen propio 25%", () => {
    expect(displayedMarginBps(manual)).toBeNull();
    expect(changedBulkItems(rows, { m: { margin: "25" } })).toEqual([{ productId: "m", marginBps: 2_500 }]);
  });
});

describe("volver al comportamiento por defecto", () => {
  it("«Usar global» / «Usar precio manual» elimina el override (margen null)", () => {
    expect(changedBulkItems(rows, { p: { reset: true } })).toEqual([{ productId: "p", marginBps: null }]);
    const ownExcluded: BulkEditRowRef = { ...base, id: "x", currentCostCents: 800_000, customMarginBps: 2_500, globalMarginBps: null, excludedCategory: true };
    expect(changedBulkItems([ownExcluded], { x: { reset: true } })).toEqual([{ productId: "x", marginBps: null }]);
  });

  it("reset gana sobre un margen escrito y no hace nada en una fila sin override", () => {
    expect(marginChange(own5, { margin: "12", reset: true })).toBeNull();
    expect(changedBulkItems(rows, { g: { reset: true } })).toEqual([]);
  });
});

describe("costo, margen o ambos", () => {
  it("sólo costo", () => {
    expect(changedBulkItems(rows, { g: { cost: "4000" } })).toEqual([{ productId: "g", costCents: 400_000 }]);
  });

  it("sólo margen", () => {
    expect(changedBulkItems(rows, { p: { margin: "10" } })).toEqual([{ productId: "p", marginBps: 1_000 }]);
  });

  it("costo + margen en una sola entrada (el servidor forma UNA vigencia de precio)", () => {
    expect(changedBulkItems(rows, { p: { cost: "5000", margin: "10" } })).toEqual([{ productId: "p", costCents: 500_000, marginBps: 1_000 }]);
  });

  it("costo igual al vigente, vacío o inválido no cuenta; margen vacío o inválido tampoco", () => {
    expect(changedBulkItems(rows, { g: { cost: "3500", margin: "" }, p: { cost: "abc", margin: "0" }, m: { cost: "", margin: "100" } })).toEqual([]);
  });

  it("filas sin cambios no se envían, aunque haya otras modificadas", () => {
    expect(changedBulkItems(rows, { g: { cost: "3500" }, p: { cost: "4600" } }).map((item) => item.productId)).toEqual(["p"]);
  });

  it("costo + reset: el costo viaja junto al margen null", () => {
    expect(changedBulkItems(rows, { p: { cost: "4600", reset: true } })).toEqual([{ productId: "p", costCents: 460_000, marginBps: null }]);
  });

  it("el ejemplo de almacén: costo 3.000 → 3.500, margen 40 → 35 y cantidad 24, todo en UNA fila", () => {
    const aceite: BulkEditRowRef = { ...base, id: "a", currentCostCents: 300_000, customMarginBps: null, globalMarginBps: 4_000 };
    expect(changedBulkItems([aceite], { a: { cost: "3500", margin: "35", quantity: "24" } })).toEqual([{ productId: "a", costCents: 350_000, marginBps: 3_500, quantity: "24" }]);
  });
});

describe("Cantidad = lo RECIBIDO en la entrega", () => {
  it("vacía (o sólo espacios) no genera ningún movimiento ni ninguna fila", () => {
    expect(changedBulkItems(rows, { g: { quantity: "" }, p: { quantity: "   " } })).toEqual([]);
  });

  it("UNIT: 12 viaja como 12 unidades", () => {
    expect(changedBulkItems([global40], { g: { quantity: "12" } })).toEqual([{ productId: "g", quantity: "12" }]);
    expect(parseReceivedQuantity("12", "UNIT")).toEqual({ ok: true, ledger: 12 });
  });

  it("UNIT: 12,5 se rechaza (entero positivo): no viaja y bloquea el guardado", () => {
    expect(parseReceivedQuantity("12,5", "UNIT").ok).toBe(false);
    expect(parseReceivedQuantity("0", "UNIT").ok).toBe(false);
    expect(parseReceivedQuantity("-3", "UNIT").ok).toBe(false);
    expect(changedBulkItems([global40], { g: { quantity: "12,5" } })).toEqual([]);
    expect(rowFieldErrors(global40, { quantity: "12,5" }).quantity).toMatch(/entera/);
    expect(hasBlockingErrors([global40], { g: { quantity: "12,5" } })).toBe(true);
  });

  it("WEIGHT: kg con hasta 3 decimales → gramos enteros (12,500 kg = 12500 g; 15,5 kg = 15500 g)", () => {
    expect(parseReceivedQuantity("12,500", "WEIGHT")).toEqual({ ok: true, ledger: 12_500 });
    expect(parseReceivedQuantity("15.5", "WEIGHT")).toEqual({ ok: true, ledger: 15_500 });
    expect(parseReceivedQuantity("0,001", "WEIGHT")).toEqual({ ok: true, ledger: 1 });
    expect(parseReceivedQuantity("12,5001", "WEIGHT").ok).toBe(false);
    expect(parseReceivedQuantity("0", "WEIGHT").ok).toBe(false);
    expect(changedBulkItems([manual], { m: { quantity: "15,500" } })).toEqual([{ productId: "m", quantity: "15,500" }]);
  });

  it("una fila sin errores no bloquea; un costo o precio inválido sí", () => {
    expect(hasBlockingErrors(rows, { g: { quantity: "5", cost: "3600" } })).toBe(false);
    expect(hasBlockingErrors(rows, { g: { cost: "abc" } })).toBe(true);
    expect(rowFieldErrors(global40, { cost: "3.500" }).cost).toBeDefined();
    expect(rowFieldErrors(global40, { margin: "100" }).margin).toBeDefined();
  });
});

describe("precio MANUAL: sólo donde el precio no se forma desde costo + margen", () => {
  it("categoría excluida (Cerdo) sin margen propio: el precio es editable aunque tenga costo", () => {
    expect(ruleAfterEdit(manual, undefined).kind).toBe("MANUAL");
    expect(priceEditable(manual, undefined)).toBe(true);
    expect(changedBulkItems([manual], { m: { price: "10900" } })).toEqual([{ productId: "m", priceCents: 1_090_000 }]);
  });

  it("producto manual SIN costo: no exige costo y puede cambiar el precio", () => {
    expect(priceEditable(manualNoCost, undefined)).toBe(true);
    expect(changedBulkItems([manualNoCost], { mn: { price: "17900" } })).toEqual([{ productId: "mn", priceCents: 1_790_000 }]);
  });

  it("precio sin modificar, vacío o igual al vigente no genera cambio", () => {
    expect(priceChange(manual, { price: "10650" })).toBeUndefined();
    expect(priceChange(manual, { price: "10650,00" })).toBeUndefined();
    expect(priceChange(manual, { price: "" })).toBeUndefined();
    expect(priceChange(manual, { price: "abc" })).toBeUndefined();
    expect(changedBulkItems([manual], { m: { price: "10650" } })).toEqual([]);
  });

  it("precio + cantidad recibida de un producto manual en la misma fila (12,500 kg)", () => {
    expect(changedBulkItems([manual], { m: { price: "10900", quantity: "12,500" } })).toEqual([{ productId: "m", priceCents: 1_090_000, quantity: "12,500" }]);
  });

  it("Cerdo con costo escrito sigue siendo manual: el costo se guarda y el precio sigue editable", () => {
    expect(priceEditable(manual, { cost: "9500" })).toBe(true);
    expect(changedBulkItems([manual], { m: { cost: "9500", price: "11000" } })).toEqual([{ productId: "m", costCents: 950_000, priceCents: 1_100_000 }]);
  });

  it("Cerdo con margen propio vuelve a ser AUTOMÁTICO: el precio ya no es editable y uno escrito se descarta", () => {
    expect(ruleAfterEdit(manual, { margin: "30" })).toEqual({ kind: "CUSTOM", bps: 3_000 });
    expect(priceEditable(manual, { margin: "30" })).toBe(false);
    expect(changedBulkItems([manual], { m: { margin: "30", price: "11000" } })).toEqual([{ productId: "m", marginBps: 3_000 }]);
    const ownPork: BulkEditRowRef = { ...manual, id: "op", customMarginBps: 3_000 };
    expect(priceEditable(ownPork, undefined)).toBe(false);
    expect(changedBulkItems([ownPork], { op: { price: "11000" } })).toEqual([]);
  });

  it("Cerdo con margen propio SIN costo: no se puede derivar, el precio sigue siendo manual (igual que el servidor)", () => {
    const ownPorkNoCost: BulkEditRowRef = { ...manual, id: "opn", currentCostCents: null, customMarginBps: 3_000 };
    expect(priceEditable(ownPorkNoCost, undefined)).toBe(true);
    expect(priceEditable(ownPorkNoCost, { cost: "5000" })).toBe(false);
  });

  it("quitar el margen propio de Cerdo («Usar precio manual») lo devuelve a precio manual editable", () => {
    const ownPork: BulkEditRowRef = { ...manual, id: "op", customMarginBps: 3_000 };
    expect(ruleAfterEdit(ownPork, { reset: true }).kind).toBe("MANUAL");
    expect(priceEditable(ownPork, { reset: true })).toBe(true);
    expect(changedBulkItems([ownPork], { op: { reset: true, price: "11000" } })).toEqual([{ productId: "op", marginBps: null, priceCents: 1_100_000 }]);
  });
});

describe("Vaca y Pollo son automáticos (costo + margen), no manuales", () => {
  it("el precio no es editable y escribir uno se ignora", () => {
    expect(priceEditable(vaca, undefined)).toBe(false);
    expect(priceEditable(pollo, undefined)).toBe(false);
    expect(changedBulkItems([vaca, pollo], { v: { price: "20000" }, pl: { price: "9000" } })).toEqual([]);
  });

  it("costo nuevo viaja y el servidor recalcula con el margen efectivo; la cantidad se suma sin tocar el pricing", () => {
    expect(changedBulkItems([vaca, pollo], { v: { cost: "10000" }, pl: { cost: "5000" } })).toEqual([
      { productId: "v", costCents: 1_000_000 }, { productId: "pl", costCents: 500_000 }
    ]);
    expect(changedBulkItems([vaca, pollo], { v: { quantity: "20,5" }, pl: { quantity: "8" } })).toEqual([
      { productId: "v", quantity: "20,5" }, { productId: "pl", quantity: "8" }
    ]);
    // «cantidad» sola no toca costo, margen ni precio.
    const [vacaItem] = changedBulkItems([vaca], { v: { quantity: "2,5" } });
    expect(vacaItem).toEqual({ productId: "v", quantity: "2,5" });
  });

  it("sin margen global configurado ni propio el precio es manual para cualquiera (aviso en pantalla)", () => {
    const noMargin: BulkEditRowRef = { ...vaca, id: "nm", organizationMarginBps: null, globalMarginBps: null };
    expect(ruleAfterEdit(noMargin, undefined).kind).toBe("NONE");
    expect(priceEditable(noMargin, undefined)).toBe(true);
  });

  it("un producto automático SIN costo no puede derivar su precio: editable; en cuanto se escribe un costo deja de serlo", () => {
    const noCost: BulkEditRowRef = { ...global40, id: "nc", currentCostCents: null };
    expect(priceEditable(noCost, undefined)).toBe(true);
    expect(priceEditable(noCost, { cost: "4000" })).toBe(false);
    expect(costAfterEdit(noCost, { cost: "4000" })).toBe(400_000);
    expect(changedBulkItems([noCost], { nc: { cost: "4000", price: "9000" } })).toEqual([{ productId: "nc", costCents: 400_000 }]);
  });
});

describe("parseo del importe y del margen", () => {
  it("importes con coma o punto decimal (hasta 2 decimales); el punto de miles se rechaza en vez de malinterpretarse", () => {
    expect(["3500", "3500,5", "3500.50", "10650"].map(parseCostCents)).toEqual([350_000, 350_050, 350_050, 1_065_000]);
    expect(["3.500", "", "abc", "0", "-5", "3500,555"].map(parseCostCents)).toEqual([null, null, null, null, null, null]);
    expect(centsToField(1_065_000)).toBe("10650");
    expect(centsToField(350_050)).toBe("3500.5");
  });

  it("margen: acepta 5, 5,5, 20, 30,25 y los pasa a basis points enteros", () => {
    expect(["5", "5,5", "20", "30,25", "30.25"].map(parseMarginBps)).toEqual([500, 550, 2_000, 3_025, 3_025]);
  });

  it("margen: rechaza 0, 100, vacío y texto", () => {
    expect(["0", "100", "", "abc", "-5", "5,555"].map(parseMarginBps)).toEqual([null, null, null, null, null, null]);
  });
});

describe("parseBulkItems (el servidor no confía en el cliente)", () => {
  it("acepta costo, margen, margen null, precio, cantidad y combinaciones", () => {
    expect(parseBulkItems([
      { productId: "a", costCents: 100 }, { productId: "b", marginBps: null }, { productId: "c", costCents: 5, marginBps: 2_500 },
      { productId: "d", priceCents: 1_090_000 }, { productId: "e", quantity: "12,500" }, { productId: "f", costCents: 1, priceCents: 2, quantity: "3" }
    ])).toHaveLength(6);
  });

  it("rechaza costo/precio no entero o no positivo, margen fuera de rango, cantidad vacía o no texto, duplicados y entradas vacías", () => {
    expect(() => parseBulkItems([{ productId: "a", costCents: 1.5 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", costCents: 0 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", marginBps: 10_000 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", marginBps: 0 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", priceCents: 0 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", priceCents: "100" }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", quantity: "" }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", quantity: 12 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", costCents: 1 }, { productId: "a", costCents: 2 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a" }])).toThrow();
    expect(() => parseBulkItems("x")).toThrow();
    expect(() => parseBulkItems(Array.from({ length: 501 }, (_, index) => ({ productId: `p${String(index)}`, costCents: 1 })))).toThrow();
  });
});

describe("toReceiptRpcItems: la cantidad se convierte con el tipo de venta de la BASE, no el del cliente", () => {
  const products = new Map([
    ["unit", { name: "Aceite", unitType: "UNIT" as const }],
    ["kg", { name: "Bondiola de cerdo", unitType: "WEIGHT" as const }]
  ]);

  it("UNIT 12 → +12 unidades; WEIGHT 12,500 kg → 12500 gramos", () => {
    expect(toReceiptRpcItems([{ productId: "unit", quantity: "12" }, { productId: "kg", quantity: "12,500" }], products)).toEqual([
      { productId: "unit", receivedQuantity: 12 }, { productId: "kg", receivedQuantity: 12_500 }
    ]);
  });

  it("UNIT 12,5 se rechaza con el nombre del producto; una cantidad en un producto desconocido también", () => {
    expect(() => toReceiptRpcItems([{ productId: "unit", quantity: "12,5" }], products)).toThrow(/^Aceite: /);
    expect(() => toReceiptRpcItems([{ productId: "ghost", quantity: "1" }], products)).toThrow();
  });

  it("copia costo, margen (incluido null), precio y NO inventa una cantidad cuando falta", () => {
    expect(toReceiptRpcItems([{ productId: "unit", costCents: 350_000, marginBps: null, priceCents: 5 }], products)).toEqual([
      { productId: "unit", costCents: 350_000, marginBps: null, priceCents: 5 }
    ]);
    expect(toReceiptRpcItems([{ productId: "unit", costCents: 1 }], products)[0]).not.toHaveProperty("receivedQuantity");
  });
});

describe("clave de idempotencia", () => {
  it("sólo se aceptan UUID", () => {
    expect(isRequestKey("c0000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isRequestKey("not-a-uuid")).toBe(false);
    expect(isRequestKey("")).toBe(false);
    expect(isRequestKey(undefined)).toBe(false);
  });
});
