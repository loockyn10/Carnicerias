import { describe, expect, it } from "vitest";

import { chunkItems, describeReasons, parseArgs, reportCsv, summarize, type PurgePreviewItem } from "./core.mts";

const item = (overrides: Partial<PurgePreviewItem>): PurgePreviewItem => ({
  ordinal: 1, externalId: "A1", quantity: 0, fileName: "Yerba", productId: "p1", productName: "Yerba", sku: "A1", active: true,
  verdict: "DELETE", reasons: [], catalogRefs: {}, ...overrides
});

describe("purga: reporte y resumen", () => {
  it("resume borrables, bloqueados y sin acción", () => {
    expect(summarize([item({}), item({ verdict: "BLOCKED", reasons: ["HAS_SALES"] }), item({ verdict: "SKIP", reasons: ["NOT_LINKED"] }), item({})]))
      .toEqual({ total: 4, delete: 2, blocked: 1, skipped: 1 });
  });

  it("el CSV lleva código, nombre del archivo, CANTIDAD original, producto, resultado y motivo, con comillas escapadas", () => {
    const csv = reportCsv([item({ fileName: 'Té "verde", caja', quantity: "-3" }), item({ externalId: "B2", verdict: "BLOCKED", reasons: ["HAS_SALES", "ENABLED_IN_OTHER_BRANCH"] })]);
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("codigo,nombre_en_archivo,cantidad_original,producto_en_base,sku,resultado,motivo");
    expect(lines[1]).toBe('A1,"Té ""verde"", caja",-3,Yerba,A1,SE BORRARÍA,');
    expect(lines[2]).toContain("BLOQUEADO");
    expect(lines[2]).toContain("Tiene ventas; Está habilitado en otra sucursal");
  });

  it("agrega el resultado final cuando se aplicó", () => {
    const csv = reportCsv([item({})], new Map([["A1", "BORRADO"]]));
    expect(csv).toContain("resultado_final");
    expect(csv).toContain("BORRADO");
  });

  it("un motivo desconocido se muestra tal cual", () => {
    expect(describeReasons(["HAS_SALES", "ALGO_NUEVO"])).toBe("Tiene ventas; ALGO_NUEVO");
  });

  it("parte la lista en tandas", () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunkItems([1], 0)).toThrow(RangeError);
  });
});

describe("purga: argumentos", () => {
  it("preview es el valor seguro y no necesita confirmación", () => {
    const args = parseArgs(["preview", "--file", "simplygest.xlsx", "--quantity-column", "CANTIDAD"]);
    expect(args).toMatchObject({ command: "preview", file: "simplygest.xlsx", source: "simplygest", chunk: 500, confirmCount: null, yesDeletePermanently: false });
    expect(args.columns.quantity).toBe("CANTIDAD");
  });

  it("apply recibe el conteo del preview y la confirmación explícita", () => {
    const args = parseArgs(["apply", "--file", "a.csv", "--confirm-count", "2800", "--yes-delete-permanently"]);
    expect(args).toMatchObject({ command: "apply", confirmCount: 2800, yesDeletePermanently: true });
  });

  it.each([[[]], [["borrar", "--file", "a.csv"]], [["preview"]], [["preview", "--file", "a.csv", "--chunk", "5000"]], [["apply", "--file", "a.csv", "--confirm-count", "-1"]], [["preview", "--file", "a.csv", "suelto"]]])("rechaza %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});
