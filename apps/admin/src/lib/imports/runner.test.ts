import { mapCatalogRows, normalizeImportText, parseCsvText, suggestColumnMapping, tableFromRecords, type MappedCatalogRow } from "@carnicerias/business-logic";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  cancelPreview,
  ImportApplyError,
  runApply,
  runPreview,
  type CreateImportBatchInput,
  type ImportApplyResult,
  type ImportBatchTotals,
  type ImportGateway,
  type ImportRowAction,
  type ImportServerRow,
  type ImportStageRow,
  type PreviewSupplier
} from "./runner";

function fixtureRows(name: string, importStock = true): MappedCatalogRow[] {
  const text = readFileSync(fileURLToPath(new URL(`../../../../../supabase/fixtures/imports/${name}`, import.meta.url)), "utf8");
  const table = parseCsvText(text);
  return mapCatalogRows(table, suggestColumnMapping(table.headers), { numberFormat: "AR", importStock }).rows;
}

/** An in-memory stand-in for the database: classifies rows the way a first import would. */
class FakeGateway implements ImportGateway {
  readonly calls: string[] = [];
  readonly batches = new Map<string, { input: CreateImportBatchInput; rows: ImportStageRow[]; status: string }>();
  failApplyOnBatch: number | null = null;
  failStage = false;
  stockVerdict: (row: ImportStageRow) => { action: ImportRowAction; reason: string | null } = () => ({ action: "CREATE", reason: "OPENING_BALANCE" });
  // What the "database" already holds: applied product codes (a repeat is UNCHANGED) and suppliers.
  readonly importedIds = new Set<string>();
  readonly knownSuppliers = new Set<string>();
  private next = 0;

  createBatch(input: CreateImportBatchInput) {
    const batchId = `batch-${String(this.next++)}`;
    this.batches.set(batchId, { input, rows: [], status: "STAGING" });
    this.calls.push(`create:${input.entityType}`);
    return Promise.resolve({ batchId });
  }

  stageRows(batchId: string, rows: ImportStageRow[]) {
    if (this.failStage) return Promise.reject(new Error("boom while staging"));
    const batch = this.batches.get(batchId);
    if (!batch) return Promise.reject(new Error("unknown batch"));
    if (rows.length > 250) return Promise.reject(new Error("too many rows in one call"));
    batch.rows.push(...rows);
    if (batch.rows.length > 1000) return Promise.reject(new Error("more than 1000 rows in a batch"));
    this.calls.push(`stage:${String(rows.length)}`);
    return Promise.resolve();
  }

  private verdict(batchId: string, row: ImportStageRow): { action: ImportRowAction; reason: string | null; message: string | null } {
    const batch = this.batches.get(batchId);
    if (batch?.input.entityType === "stock_opening_balance") return { ...this.stockVerdict(row), message: null };
    if (typeof row.payload.invalidReason === "string") return { action: "ERROR", reason: "INVALID_ROW", message: row.payload.invalidReason };
    if (this.importedIds.has(row.externalId)) return { action: "IGNORE", reason: "UNCHANGED", message: null };
    return { action: "CREATE", reason: "NEW", message: null };
  }

  listSuppliers(batchId: string): Promise<PreviewSupplier[]> {
    const batch = this.batches.get(batchId);
    if (!batch) return Promise.reject(new Error("unknown batch"));
    this.calls.push(`suppliers:${batchId}`);
    const grouped = new Map<string, PreviewSupplier>();
    for (const row of batch.rows) {
      const name = typeof row.payload.supplierName === "string" ? row.payload.supplierName : null;
      if (name === null || this.verdict(batchId, row).action === "ERROR") continue;
      const key = normalizeImportText(name);
      const current = grouped.get(key);
      const code = typeof row.payload.supplierCode === "string" ? row.payload.supplierCode : null;
      grouped.set(key, current ? { ...current, rows: current.rows + 1 } : {
        key: `N:${key}`, supplierId: this.knownSuppliers.has(key) ? `sup:${key}` : null, name, code, rows: 1
      });
    }
    return Promise.resolve([...grouped.values()]);
  }

  previewBatch(batchId: string) {
    const batch = this.batches.get(batchId);
    if (!batch) return Promise.reject(new Error("unknown batch"));
    batch.status = "READY";
    const totals: ImportBatchTotals = { totalRows: batch.rows.length, create: 0, update: 0, ignore: 0, error: 0 };
    for (const row of batch.rows) {
      const { action } = this.verdict(batchId, row);
      if (action === "CREATE") totals.create += 1;
      else if (action === "ERROR") totals.error += 1;
      else if (action === "IGNORE") totals.ignore += 1;
      else totals.update += 1;
    }
    this.calls.push(`preview:${batch.input.entityType}`);
    return Promise.resolve({ summary: totals, sameFileAlreadyApplied: false });
  }

  listRows(batchId: string) {
    const batch = this.batches.get(batchId);
    if (!batch) return Promise.reject(new Error("unknown batch"));
    return Promise.resolve(batch.rows.map<ImportServerRow>((row) => {
      const verdict = this.verdict(batchId, row);
      return { rowNumber: row.rowNumber, action: verdict.action, reasonCode: verdict.reason, message: verdict.message, internalId: null };
    }));
  }

  applyBatch(batchId: string, skipErrors: boolean): Promise<ImportApplyResult> {
    const batch = this.batches.get(batchId);
    if (!batch) return Promise.reject(new Error("unknown batch"));
    const index = Number(batchId.split("-")[1]);
    this.calls.push(`apply:${batch.input.entityType}:skip=${String(skipErrors)}`);
    if (this.failApplyOnBatch === index) return Promise.reject(new Error("apply exploded"));
    const verdicts = batch.rows.map((row) => this.verdict(batchId, row).action);
    const errors = verdicts.filter((action) => action === "ERROR").length;
    if (errors > 0 && !skipErrors) return Promise.reject(new Error("batch has errors"));
    batch.status = "APPLIED";
    if (batch.input.entityType === "product") {
      for (const row of batch.rows) {
        if (this.verdict(batchId, row).action !== "CREATE") continue;
        this.importedIds.add(row.externalId);
        if (typeof row.payload.supplierName === "string") this.knownSuppliers.add(normalizeImportText(row.payload.supplierName));
      }
    }
    return Promise.resolve({
      created: verdicts.filter((action) => action === "CREATE").length, updated: 0,
      ignored: verdicts.filter((action) => action === "IGNORE").length, skippedErrors: errors
    });
  }

  cancelBatch(batchId: string) {
    const batch = this.batches.get(batchId);
    if (batch) batch.status = "CANCELLED";
    this.calls.push("cancel");
    return Promise.resolve();
  }
}

const META = { runId: "11111111-1111-4111-8111-111111111111", fileName: "catalogo.csv", fileSha256: "a".repeat(64), linkBy: ["barcode" as const, "sku" as const] };

describe("runPreview", () => {
  it("stages a 1,500-row file as two batches of at most 1,000 rows, in calls of at most 250, and merges the verdicts in file order", async () => {
    const rows = fixtureRows("simplygest-large.csv");
    const gateway = new FakeGateway();
    const preview = await runPreview(gateway, rows, META);

    expect(preview.batches.map((batch) => batch.rowCount)).toEqual([1000, 500]);
    expect([...gateway.batches.values()].every((batch) => batch.rows.length <= 1000)).toBe(true);
    expect(preview.rows.map((entry) => entry.row.rowNumber)).toEqual(rows.map((row) => row.rowNumber));
    // 6 rows without a price + 1 barcode repeated across the batch boundary were rejected client-side.
    expect(preview.totals).toMatchObject({ total: 1500, create: 1493, error: 7, update: 0, ignore: 0 });
    expect(preview.rows.find((entry) => entry.row.rowNumber === 1306)?.message).toContain("ya aparece en la fila 6");
  });

  it("stages the rejected rows too, so the database records the whole file", async () => {
    const rows = fixtureRows("simplygest-sample.csv");
    const gateway = new FakeGateway();
    await runPreview(gateway, rows, META);
    const staged = [...gateway.batches.values()].flatMap((batch) => batch.rows);
    expect(staged).toHaveLength(14);
    expect(staged.filter((row) => typeof row.payload.invalidReason === "string")).toHaveLength(6);
    expect(staged.find((row) => row.externalId === "INVALID:11")?.payload.invalidReason).toBe("Falta el precio de venta");
  });

  it("every batch carries the same runId, file name and hash (one logical import)", async () => {
    const gateway = new FakeGateway();
    await runPreview(gateway, fixtureRows("simplygest-large.csv"), META);
    for (const batch of gateway.batches.values()) {
      expect(batch.input).toMatchObject({ runId: META.runId, fileName: "catalogo.csv", fileSha256: META.fileSha256 });
    }
  });

  it("cancels every batch it created if anything fails, and rethrows", async () => {
    const gateway = new FakeGateway();
    gateway.failStage = true;
    await expect(runPreview(gateway, fixtureRows("simplygest-sample.csv"), META)).rejects.toThrow("boom while staging");
    expect([...gateway.batches.values()].every((batch) => batch.status === "CANCELLED")).toBe(true);
  });

  it("counts stock rows only for rows that are not errors", async () => {
    const preview = await runPreview(new FakeGateway(), fixtureRows("simplygest-sample.csv"), META);
    // Valid rows with stock > 0: 1001 (24), 1002 (12), 1003 (40), 1005 (15), 1006 (18), 1012 (8), 1013 (6).
    // 1004 has stock 0 (no movement) and the fractional/negative ones are errors.
    expect(preview.totals.stockRows).toBe(7);
    expect(preview.totals.stockUnits).toBe(24 + 12 + 40 + 15 + 18 + 8 + 6);
  });
});

describe("runApply", () => {
  it("refuses to apply a preview with errors unless the operator chose to skip them", async () => {
    const gateway = new FakeGateway();
    const preview = await runPreview(gateway, fixtureRows("simplygest-sample.csv"), META);
    await expect(runApply(gateway, preview, { skipErrors: false, importStock: false })).rejects.toThrow("filas con error");
    expect(gateway.calls.some((call) => call.startsWith("apply"))).toBe(false);
  });

  it("applies the product batches in order, then loads the stock as separate batches", async () => {
    const gateway = new FakeGateway();
    const preview = await runPreview(gateway, fixtureRows("simplygest-large.csv"), META);
    const outcome = await runApply(gateway, preview, { skipErrors: true, importStock: true });

    const order = gateway.calls.filter((call) => call.startsWith("apply") || call.startsWith("create"));
    expect(order.slice(0, 2)).toEqual(["create:product", "create:product"]);
    const applies = order.filter((call) => call.startsWith("apply"));
    expect(applies[0]).toBe("apply:product:skip=true");
    expect(applies[1]).toBe("apply:product:skip=true");
    expect(applies.slice(2).every((call) => call.startsWith("apply:stock_opening_balance"))).toBe(true);
    expect(outcome.products).toMatchObject({ created: 1493, skippedErrors: 7 });
    expect(outcome.stock?.requested).toBeGreaterThan(1000); // → split in two stock batches
    expect([...gateway.batches.values()].filter((batch) => batch.input.entityType === "stock_opening_balance")).toHaveLength(2);
  });

  it("does not touch stock when “Importar stock actual” is off", async () => {
    const gateway = new FakeGateway();
    const preview = await runPreview(gateway, fixtureRows("simplygest-sample.csv", false), META);
    const outcome = await runApply(gateway, preview, { skipErrors: true, importStock: false });
    expect(outcome.stock).toBeNull();
    expect([...gateway.batches.values()].some((batch) => batch.input.entityType === "stock_opening_balance")).toBe(false);
  });

  it("never sends stock for rows that were errors, and sends the product's external id with whole units", async () => {
    const gateway = new FakeGateway();
    const preview = await runPreview(gateway, fixtureRows("simplygest-sample.csv"), META);
    await runApply(gateway, preview, { skipErrors: true, importStock: true });
    const stock = [...gateway.batches.values()].filter((batch) => batch.input.entityType === "stock_opening_balance").flatMap((batch) => batch.rows);
    expect(stock.map((row) => [row.externalId, row.payload])).toEqual([
      ["1001", { quantityUnits: 24 }], ["1002", { quantityUnits: 12 }], ["1003", { quantityUnits: 40 }],
      ["1005", { quantityUnits: 15 }], ["1006", { quantityUnits: 18 }], ["1012", { quantityUnits: 8 }],
      ["1013", { quantityUnits: 6 }]
    ]);
  });

  it("reports what the stock stage ignored or rejected without failing the products", async () => {
    const gateway = new FakeGateway();
    gateway.stockVerdict = (row) => row.externalId === "1003" ? { action: "IGNORE", reason: "ALREADY_HAS_STOCK_HISTORY" } : { action: "CREATE", reason: "OPENING_BALANCE" };
    const preview = await runPreview(gateway, fixtureRows("simplygest-sample.csv"), META);
    const outcome = await runApply(gateway, preview, { skipErrors: true, importStock: true });
    expect(outcome.stock).toMatchObject({ requested: 7, ignored: 1, byReason: { ALREADY_HAS_STOCK_HISTORY: 1 } });
  });

  it("a failing product batch stops the run and reports what was already written", async () => {
    const gateway = new FakeGateway();
    const preview = await runPreview(gateway, fixtureRows("simplygest-large.csv"), META);
    gateway.failApplyOnBatch = 1;
    const failure = await runApply(gateway, preview, { skipErrors: true, importStock: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ImportApplyError);
    const error = failure as ImportApplyError;
    expect(error.stage).toBe("products");
    expect(error.partial.batchesApplied).toBe(1);
    expect(error.partial.products.created).toBeGreaterThan(900);
    expect([...gateway.batches.values()].some((batch) => batch.input.entityType === "stock_opening_balance")).toBe(false);
  });
});

describe("proveedores, tipo_venta y precio 0 en el flujo completo", () => {
  const HEADERS = ["codigo", "barcode", "nombre", "categoria", "tipo_venta", "precio_venta", "costo", "proveedor", "proveedor_codigo"];
  const FILE = [
    ["1001", "7790895000010", "Coca Cola 2.25 L", "Bebidas", "UNIT", "3500", "2500", "Coca-Cola FEMSA", "P1"],
    ["1002", "", "Vacío importado", "Carnes", "WEIGHT", "12000", "", "", ""],
    ["1003", "7791234000001", "GALLETITAS X", "Almacen", "UNIT", "0", "", "Distribuidora X", ""],
    ["1004", "", "Pepsi", "Bebidas", "UNIT", "3000", "", "coca-cola femsa", ""],
    ["1005", "", "Roto", "Almacen", "CAJA", "100", "", "Distribuidora Z", ""],
    ["1006", "", "Negativo", "Almacen", "UNIT", "-5", "", "Distribuidora Z", ""]
  ];
  const rows = () => {
    const table = tableFromRecords([HEADERS, ...FILE]);
    return mapCatalogRows(table, suggestColumnMapping(table.headers), { numberFormat: "AR", importStock: false }).rows;
  };

  it("stages UNIT, WEIGHT, the zero price and the suppliers exactly as the mapper produced them", async () => {
    const gateway = new FakeGateway();
    await runPreview(gateway, rows(), META);
    const staged = [...gateway.batches.values()].flatMap((batch) => batch.rows);
    expect(staged.find((row) => row.externalId === "1002")?.payload).toMatchObject({ unitType: "WEIGHT", priceCents: 1200000 });
    expect(staged.find((row) => row.externalId === "1003")?.payload).toMatchObject({ unitType: "UNIT", priceCents: 0, supplierName: "Distribuidora X" });
    expect(staged.find((row) => row.externalId === "1001")?.payload).toMatchObject({ supplierName: "Coca-Cola FEMSA", supplierCode: "P1" });
  });

  it("the preview audits the suppliers: each distinct one once, errors excluded, new vs reused", async () => {
    const gateway = new FakeGateway();
    gateway.knownSuppliers.add(normalizeImportText("Distribuidora X"));
    const preview = await runPreview(gateway, rows(), META);
    expect(preview.totals).toMatchObject({ create: 4, error: 2, suppliersNew: 1, suppliersReused: 1 });
    expect(preview.suppliers.map((entry) => [entry.name, entry.supplierId !== null, entry.rows])).toEqual([
      ["Coca-Cola FEMSA", false, 2], // rows 1001 and 1004 (same supplier, different spelling)
      ["Distribuidora X", true, 1]
      // "Distribuidora Z" only appears on the two rejected rows: it is NOT created
    ]);
  });

  it("a supplier new in two different batches is counted once", async () => {
    const gateway = new FakeGateway();
    const big = Array.from({ length: 1100 }, (_, index) => ["C" + String(index), "", "Producto " + String(index), "Almacen", "UNIT", "100", "", "Mismo Proveedor", ""]);
    const table = tableFromRecords([HEADERS, ...big]);
    const mapped = mapCatalogRows(table, suggestColumnMapping(table.headers), { numberFormat: "AR", importStock: false }).rows;
    const preview = await runPreview(gateway, mapped, META);
    expect(preview.batches).toHaveLength(2);
    expect(preview.totals).toMatchObject({ suppliersNew: 1, suppliersReused: 0 });
    expect(preview.suppliers).toMatchObject([{ name: "Mismo Proveedor", rows: 1100 }]);
  });

  it("importing the same file twice: the second run creates nothing and reuses every supplier", async () => {
    const gateway = new FakeGateway();
    const first = await runPreview(gateway, rows(), META);
    expect(first.totals).toMatchObject({ create: 4, suppliersNew: 2, suppliersReused: 0 });
    await runApply(gateway, first, { skipErrors: true, importStock: false });

    const second = await runPreview(gateway, rows(), META);
    expect(second.totals).toMatchObject({ create: 0, update: 0, ignore: 4, error: 2, suppliersNew: 0, suppliersReused: 2 });
    const again = await runApply(gateway, second, { skipErrors: true, importStock: false });
    expect(again.products).toMatchObject({ created: 0, updated: 0, ignored: 4 });
    expect(gateway.knownSuppliers.size).toBe(2);
  });

  it("never loads stock for a file whose mapping has no stock column (the final SimplyGest CSV)", async () => {
    const gateway = new FakeGateway();
    const preview = await runPreview(gateway, rows(), META);
    expect(preview.totals).toMatchObject({ stockRows: 0, stockUnits: 0 });
    const outcome = await runApply(gateway, preview, { skipErrors: true, importStock: false });
    expect(outcome.stock).toBeNull();
    expect([...gateway.batches.values()].some((batch) => batch.input.entityType === "stock_opening_balance")).toBe(false);
  });
});

describe("cancelPreview", () => {
  it("cancels every batch of an abandoned preview", async () => {
    const gateway = new FakeGateway();
    const preview = await runPreview(gateway, fixtureRows("simplygest-large.csv"), META);
    await cancelPreview(gateway, preview);
    expect([...gateway.batches.values()].every((batch) => batch.status === "CANCELLED")).toBe(true);
  });
});
