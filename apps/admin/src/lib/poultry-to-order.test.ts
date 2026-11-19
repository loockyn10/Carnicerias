import { describe, expect, it } from "vitest";

import {
  defaultToOrderDate, linesForView, listToOrderDates, parseToOrder, resolveToOrderSelection, summarizeToOrder, type ToOrderLine
} from "./poultry-to-order";

const TODAY = "2026-11-19";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function line(partial: Partial<ToOrderLine> & Pick<ToOrderLine, "productId" | "name" | "boxes">): ToOrderLine {
  return { category: "POLLO", sortOrder: 1, deliveryOn: null, orders: 1, ...partial };
}

const ENTERO = { productId: U(1), name: "Pollo entero", sortOrder: 1 };
const GALLINA = { productId: U(2), name: "Gallina", sortOrder: 2 };
const MEDALLONES = { productId: U(3), name: "Medallones", sortOrder: 1, category: "CONGELADOS" as const };

describe("agrupación (el ejemplo del pedido)", () => {
  // Juan 3 + Pedro 5 de pollo entero, María 2 de gallina: el servidor ya las entrega sumadas por producto y fecha.
  const lines = [line({ ...ENTERO, boxes: 8, orders: 2 }), line({ ...GALLINA, boxes: 2 })];

  it("suma los pedidos de cada producto y el total general", () => {
    const summary = summarizeToOrder(lines, "all");
    expect(summary.sections).toHaveLength(1);
    expect(summary.sections[0]?.rows.map((row) => [row.name, row.boxes])).toEqual([["Pollo entero", 8], ["Gallina", 2]]);
    expect(summary.totalBoxes).toBe(10);
  });

  it("un mismo producto en varias fechas se suma una sola vez por producto en el total general", () => {
    const summary = summarizeToOrder([
      line({ ...ENTERO, boxes: 3 }), line({ ...ENTERO, boxes: 5, deliveryOn: "2026-11-20", orders: 2 }), line({ ...ENTERO, boxes: 4, deliveryOn: "2026-11-10" })
    ], "all");
    expect(summary.sections[0]?.rows).toHaveLength(1);
    expect(summary.sections[0]?.rows[0]).toMatchObject({ name: "Pollo entero", boxes: 12, orders: 4 });
    expect(summary.totalBoxes).toBe(12);
  });

  it("ignora renglones sin cajones y no inventa productos", () => {
    const summary = summarizeToOrder([line({ ...ENTERO, boxes: 0 }), line({ ...GALLINA, boxes: -2 })], "all");
    expect(summary.sections).toEqual([]);
    expect(summary.totalBoxes).toBe(0);
    expect(summarizeToOrder([], "none")).toEqual({ sections: [], totalBoxes: 0 });
  });
});

describe("fechas de entrega", () => {
  const lines = [
    line({ ...ENTERO, boxes: 5 }), // sin fecha
    line({ ...GALLINA, boxes: 4, deliveryOn: "2026-11-16" }), // vencida y todavía abierta
    line({ ...ENTERO, boxes: 1, deliveryOn: TODAY }),
    line({ ...ENTERO, boxes: 6, deliveryOn: "2026-11-20" }),
    line({ ...MEDALLONES, boxes: 2, deliveryOn: "2026-11-20" })
  ];

  it("«Sin fecha» sólo agrupa pedidos sin fecha: nunca los asigna a hoy", () => {
    const none = summarizeToOrder(lines, "none");
    expect(none.totalBoxes).toBe(5);
    expect(none.sections.flatMap((section) => section.rows.map((row) => row.name))).toEqual(["Pollo entero"]);
    expect(linesForView(lines, "date", TODAY).map((entry) => entry.boxes)).toEqual([1]);
  });

  it("«Por fecha» muestra sólo esa fecha, separada por categoría", () => {
    const day = summarizeToOrder(lines, "date", "2026-11-20");
    expect(day.totalBoxes).toBe(8);
    expect(day.sections.map((section) => [section.category, section.boxes])).toEqual([["POLLO", 6], ["CONGELADOS", 2]]);
    expect(summarizeToOrder(lines, "date", "2026-12-31")).toEqual({ sections: [], totalBoxes: 0 });
    expect(summarizeToOrder(lines, "date", null).totalBoxes).toBe(0);
  });

  it("«Total general» incluye sin fecha, vencidos, hoy y futuros", () => {
    expect(summarizeToOrder(lines, "all").totalBoxes).toBe(18);
  });

  it("las fechas vencidas con pedidos abiertos aparecen marcadas y se siguen contando", () => {
    const dates = listToOrderDates(lines, TODAY);
    expect(dates).toEqual([
      { date: "2026-11-16", boxes: 4, overdue: true },
      { date: TODAY, boxes: 1, overdue: false },
      { date: "2026-11-20", boxes: 8, overdue: false }
    ]);
    expect(summarizeToOrder(lines, "date", "2026-11-16").totalBoxes).toBe(4);
  });

  it("la lista de fechas no incluye los pedidos sin fecha ni los renglones vacíos", () => {
    expect(listToOrderDates([line({ ...ENTERO, boxes: 5 }), line({ ...GALLINA, boxes: 0, deliveryOn: "2026-11-22" })], TODAY)).toEqual([]);
  });

  it("elige la fecha de arranque: la de hoy o la próxima, si no la última vencida, si no hoy", () => {
    const dates = listToOrderDates(lines, TODAY);
    expect(defaultToOrderDate(dates, TODAY)).toBe(TODAY);
    expect(defaultToOrderDate(dates.filter((entry) => entry.date !== TODAY), TODAY)).toBe("2026-11-20");
    expect(defaultToOrderDate(dates.filter((entry) => entry.overdue), TODAY)).toBe("2026-11-16");
    expect(defaultToOrderDate([], TODAY)).toBe(TODAY);
  });
});

describe("modificaciones: los totales siguen a los pedidos (cada consulta recalcula)", () => {
  const before = [line({ ...ENTERO, boxes: 8, orders: 2 }), line({ ...GALLINA, boxes: 2 })];

  it("editar la cantidad de un pedido cambia el total, no se acumula", () => {
    const after = [line({ ...ENTERO, boxes: 5, orders: 2 }), line({ ...GALLINA, boxes: 2 })];
    expect(summarizeToOrder(before, "all").totalBoxes).toBe(10);
    expect(summarizeToOrder(after, "all").totalBoxes).toBe(7);
  });

  it("cambiar la fecha de entrega mueve los cajones de grupo y deja intacto el total general", () => {
    const moved = [line({ ...ENTERO, boxes: 5 }), line({ ...ENTERO, boxes: 3, deliveryOn: "2026-11-25" }), line({ ...GALLINA, boxes: 2 })];
    expect(summarizeToOrder(moved, "none").totalBoxes).toBe(7);
    expect(summarizeToOrder(moved, "date", "2026-11-25").totalBoxes).toBe(3);
    expect(summarizeToOrder(moved, "all").totalBoxes).toBe(summarizeToOrder(before, "all").totalBoxes);
  });

  it("un pedido cancelado o entregado ya no llega del servidor: su producto desaparece de la tabla", () => {
    const after = [line({ ...ENTERO, boxes: 8, orders: 2 })];
    const summary = summarizeToOrder(after, "all");
    expect(summary.sections[0]?.rows.map((row) => row.name)).toEqual(["Pollo entero"]);
    expect(summary.totalBoxes).toBe(8);
  });
});

describe("orden y categorías", () => {
  it("ordena por categoría (Pollo primero), número de orden del catálogo, nombre e id", () => {
    const summary = summarizeToOrder([
      line({ productId: U(9), name: "Zeta", boxes: 1, sortOrder: 5 }),
      line({ productId: U(8), name: "Alfa", boxes: 1, sortOrder: 5 }),
      line({ productId: U(7), name: "Primero", boxes: 1, sortOrder: 1 }),
      line({ ...MEDALLONES, boxes: 4, sortOrder: 1 }),
      line({ productId: U(6), name: "Hamburguesas", boxes: 3, sortOrder: 2, category: "CONGELADOS" })
    ], "all");
    expect(summary.sections.map((section) => section.category)).toEqual(["POLLO", "CONGELADOS"]);
    expect(summary.sections.map((section) => section.rows.map((row) => row.name))).toEqual([["Primero", "Alfa", "Zeta"], ["Medallones", "Hamburguesas"]]);
    expect(summary.sections.map((section) => section.label)).toEqual(["Pollo", "Congelados"]);
    expect(summary.totalBoxes).toBe(10);
  });

  it("sólo hay secciones de categorías con cajones", () => {
    expect(summarizeToOrder([line({ ...MEDALLONES, boxes: 2 })], "all").sections.map((section) => section.category)).toEqual(["CONGELADOS"]);
  });
});

describe("selección de la URL", () => {
  const dates = listToOrderDates([line({ ...ENTERO, boxes: 1, deliveryOn: "2026-11-20" })], TODAY);

  it("abre el total general por defecto y con una vista inválida", () => {
    expect(resolveToOrderSelection("", "", dates, TODAY)).toEqual({ view: "all", date: "2026-11-20" });
    expect(resolveToOrderSelection("otra", "x", dates, TODAY).view).toBe("all");
  });

  it("respeta la vista y una fecha válida; ignora una fecha imposible", () => {
    expect(resolveToOrderSelection("none", "", dates, TODAY).view).toBe("none");
    expect(resolveToOrderSelection("date", "2026-11-22", dates, TODAY)).toEqual({ view: "date", date: "2026-11-22" });
    expect(resolveToOrderSelection("date", "2026-02-31", dates, TODAY).date).toBe("2026-11-20");
  });
});

describe("lectura de la RPC", () => {
  it("convierte el JSON del servidor y tolera datos incompletos", () => {
    const parsed = parseToOrder({
      today: TODAY,
      lines: [
        { productId: U(1), name: "Pollo entero", category: "POLLO", sortOrder: 1, deliveryOn: null, boxes: 8, orders: 2 },
        { productId: U(3), name: "Medallones", category: "CONGELADOS", sortOrder: 2, deliveryOn: "2026-11-20", boxes: 2, orders: 1 },
        { productId: U(4), name: "Raro", category: "OTRA", deliveryOn: "no-es-fecha", boxes: 1 }
      ]
    });
    expect(parsed.today).toBe(TODAY);
    expect(parsed.lines[0]).toEqual({ productId: U(1), name: "Pollo entero", category: "POLLO", sortOrder: 1, deliveryOn: null, boxes: 8, orders: 2 });
    expect(parsed.lines[1]?.deliveryOn).toBe("2026-11-20");
    expect(parsed.lines[2]).toMatchObject({ category: "POLLO", deliveryOn: null, boxes: 1, orders: 0 });
    expect(parseToOrder(null)).toEqual({ today: "", lines: [] });
    expect(parseToOrder({ lines: "mal" }).lines).toEqual([]);
  });
});
