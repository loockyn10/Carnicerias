import { describe, expect, it } from "vitest";

import { chunkItems, describeReasons, parseArgs, reportCsv, summarize, zeroPriceApplyGuard, zeroPriceReportCsv, type PurgePreviewItem, type ZeroPricePreviewItem } from "./core.mts";

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

describe("purga por precio vigente $0 (--zero-current-price)", () => {
  const zeroItem = (overrides: Partial<ZeroPricePreviewItem>): ZeroPricePreviewItem => ({
    ordinal: 1, externalId: "Z1", productId: "p1", productName: "Yerba", sku: "Z1", active: true, verdict: "DELETE_SAFE", reasons: [], catalogRefs: {}, ...overrides
  });

  it("no pide archivo y deja el modo por archivo intacto", () => {
    expect(parseArgs(["preview", "--zero-current-price"])).toMatchObject({ command: "preview", mode: "zero-current-price", file: null, source: "simplygest", batchSize: null, confirmCount: null, yesDeletePermanently: false });
    expect(parseArgs(["preview", "--file", "a.csv"])).toMatchObject({ mode: "quantity-file", file: "a.csv", batchSize: null });
  });

  it("apply recibe el conteo y la confirmación explícita, y opcionalmente una tanda", () => {
    expect(parseArgs(["apply", "--zero-current-price", "--confirm-count", "946", "--yes-delete-permanently", "--batch-size", "300"]))
      .toMatchObject({ command: "apply", mode: "zero-current-price", confirmCount: 946, yesDeletePermanently: true, batchSize: 300 });
  });

  it.each([
    [["preview", "--zero-current-price", "--file", "a.csv"]],
    [["preview", "--zero-current-price", "--quantity-column", "CANTIDAD"]],
    [["preview", "--zero-current-price", "--chunk", "100"]],
    [["preview", "--zero-current-price", "--batch-size", "0"]],
    [["preview", "--zero-current-price", "--batch-size", "x"]],
    [["preview", "--file", "a.csv", "--batch-size", "10"]]
  ])("rechaza %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it("el apply exige la bandera explícita y el conteo EXACTO de DELETE_SAFE", () => {
    expect(zeroPriceApplyGuard({ confirmCount: 946, yesDeletePermanently: true }, 946)).toBeNull();
    expect(zeroPriceApplyGuard({ confirmCount: 946, yesDeletePermanently: false }, 946)).toContain("--yes-delete-permanently");
    expect(zeroPriceApplyGuard({ confirmCount: null, yesDeletePermanently: true }, 946)).toContain("--confirm-count 946");
    expect(zeroPriceApplyGuard({ confirmCount: 900, yesDeletePermanently: true }, 946)).toContain("no coincide");
    expect(zeroPriceApplyGuard({ confirmCount: 0, yesDeletePermanently: true }, 0)).toBeNull();
  });

  it("describe los motivos propios del modo y el CSV lleva sku, código, producto, resultado y motivo", () => {
    expect(describeReasons(["HAS_POSITIVE_CURRENT_PRICE", "NOT_IMPORTED_FROM_SOURCE"])).toContain("otro precio vigente mayor a 0");
    const csv = zeroPriceReportCsv([zeroItem({}), zeroItem({ productId: "p2", sku: "M2", externalId: null, productName: 'Morcilla "manual"', active: false, verdict: "BLOCKED", reasons: ["NOT_IMPORTED_FROM_SOURCE"] })]);
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("sku,codigo_externo,producto,activo,resultado,motivo");
    expect(lines[1]).toBe("Z1,Z1,Yerba,si,SE BORRARÍA,");
    expect(lines[2]).toContain('"Morcilla ""manual"""');
    expect(lines[2]).toContain("BLOQUEADO");
    expect(lines[2]).toContain("no se toca");
  });

  it("agrega el resultado final por producto cuando se aplicó", () => {
    const csv = zeroPriceReportCsv([zeroItem({}), zeroItem({ productId: "p2", sku: "Z2" })], new Map([["p1", "BORRADO"]]));
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toMatch(/,resultado_final$/);
    expect(lines[1]).toMatch(/,BORRADO$/);
    expect(lines[2]).toMatch(/,$/);
  });
});
