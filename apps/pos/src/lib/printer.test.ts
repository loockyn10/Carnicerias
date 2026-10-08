import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalSaleReceiptSource } from "./local-database";
import {
  DEFAULT_PRINTER_SETTINGS, describePrintError, isPrinterReady, printSaleReceipt, printTestPage, shouldAutoPrint,
  type PrinterApi, type PrinterSettings, type PrintSaleDeps
} from "./printer";
import { documentToText, type PrintDocument } from "./receipt-render";
import { packItem, receiptSource, unitItem } from "./receipt-fixtures";

const READY: PrinterSettings = { ...DEFAULT_PRINTER_SETTINGS, enabled: true, printerName: "POS-80 Printer" };

function deps(source: LocalSaleReceiptSource | null, overrides: Partial<PrintSaleDeps> & { settings?: PrinterSettings } = {}) {
  const { settings, ...custom } = overrides;
  const printed: PrintDocument[] = [];
  const calls = { loadSource: 0, getSettings: 0 };
  const built: PrintSaleDeps = {
    loadSource: () => { calls.loadSource += 1; return Promise.resolve(source); },
    getSettings: () => { calls.getSettings += 1; return Promise.resolve(settings ?? READY); },
    print: (document) => { printed.push(document); return Promise.resolve(); },
    ...custom
  };
  return { built, printed, calls };
}

function only(documents: PrintDocument[]): PrintDocument {
  const [first] = documents;
  if (!first) throw new Error("nothing was printed");
  return first;
}

const mpSale = (verificationStatus: string) =>
  receiptSource([unitItem()], { payment: { method: "TRANSFER", provider: "MERCADOPAGO", verificationStatus } });

afterEach(() => { vi.unstubAllGlobals(); });

describe("printSaleReceipt", () => {
  it("prints a completed sale as a NON-fiscal receipt, exactly once", async () => {
    const { built, printed } = deps(receiptSource([unitItem()]));
    expect(await printSaleReceipt("a8f4k2d1", { reprint: false }, built)).toEqual({ ok: true });
    expect(printed).toHaveLength(1);
    const text = documentToText(only(printed));
    expect(text).toContain("COMPROBANTE NO FISCAL");
    expect(text).toContain("Coca Cola");
    expect(text).not.toContain("REIMPRESION");
  });

  it("a reprint adds the REIMPRESION banner", async () => {
    const { built, printed } = deps(receiptSource([unitItem()]));
    await printSaleReceipt("a8f4k2d1", { reprint: true }, built);
    expect(documentToText(only(printed)).startsWith("      *** REIMPRESION ***")).toBe(true);
  });

  it("works completely offline: only local data and the printer, no network at all", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", { onLine: false });
    const { built, printed } = deps(receiptSource([unitItem(), packItem(2500)]));
    expect(await printSaleReceipt("a8f4k2d1", { reprint: false }, built)).toEqual({ ok: true });
    expect(printed).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a Mercado Pago sale that is not CONFIRMED yet is never printed as a final ticket (and the printer is not even asked)", async () => {
    for (const status of ["PENDING", "ERROR", "CANCELLED", "EXPIRED", "MISMATCH", "REFUNDED"]) {
      const { built, printed, calls } = deps(mpSale(status));
      const outcome = await printSaleReceipt("a8f4k2d1", { reprint: false }, built);
      expect(outcome, status).toMatchObject({ ok: false, code: "NOT_PRINTABLE" });
      expect(printed, status).toHaveLength(0);
      expect(calls.getSettings, status).toBe(0);
    }
  });

  it("a confirmed Mercado Pago sale prints with the friendly payment label", async () => {
    const { built, printed } = deps(mpSale("CONFIRMED"));
    expect(await printSaleReceipt("a8f4k2d1", { reprint: false }, built)).toEqual({ ok: true });
    expect(documentToText(only(printed))).toContain("Pago: Mercado Pago");
  });

  it("a sale that is not COMPLETED (cancelled / pending payment) is refused, also as a reprint", async () => {
    for (const status of ["CANCELLED", "PENDING_PAYMENT"]) {
      const { built, printed } = deps(receiptSource([unitItem()], { status }));
      expect(await printSaleReceipt("a8f4k2d1", { reprint: true }, built), status).toMatchObject({ ok: false, code: "NOT_PRINTABLE" });
      expect(printed).toHaveLength(0);
    }
  });

  it("an unknown sale and a disabled printer are explained, never thrown", async () => {
    expect(await printSaleReceipt("x", { reprint: false }, deps(null).built)).toMatchObject({ ok: false, code: "SALE_NOT_FOUND" });
    const { built, printed } = deps(receiptSource([unitItem()]), { settings: DEFAULT_PRINTER_SETTINGS });
    expect(await printSaleReceipt("x", { reprint: false }, built)).toMatchObject({ ok: false, code: "DISABLED" });
    expect(printed).toHaveLength(0);
  });

  it("always renders at the 58 mm profile, even if this machine still has 80 mm saved from before", async () => {
    const { built, printed } = deps(receiptSource([unitItem()]), { settings: { ...READY, paperWidthMm: 80 } });
    await printSaleReceipt("x", { reprint: false }, built);
    expect(printed[0]?.lines.every((line) => Array.from(line.text).length <= 32)).toBe(true);
  });

  it("a printer failure is reported but never touches the sale: nothing is written, nothing is retried by itself", async () => {
    const source = receiptSource([unitItem()]);
    const before = structuredClone(source);
    const print = vi.fn().mockRejectedValue("PRINTER_NOT_FOUND: la impresora \"POS-80 Printer\" no está instalada en esta computadora.");
    const { built, calls } = deps(source, { print });
    const outcome = await printSaleReceipt("a8f4k2d1", { reprint: false }, built);
    expect(outcome).toEqual({ ok: false, code: "NOT_FOUND", message: "la impresora \"POS-80 Printer\" no está instalada en esta computadora." });
    expect(print).toHaveBeenCalledTimes(1);
    expect(calls.loadSource).toBe(1);
    expect(source).toEqual(before);
    // El cajero puede reintentar con la misma venta intacta.
    const retry = deps(source);
    expect(await printSaleReceipt("a8f4k2d1", { reprint: false }, retry.built)).toEqual({ ok: true });
  });

  it("any thrown value from the backend (even a raw Error) becomes a failed outcome", async () => {
    const outcome = await printSaleReceipt("x", { reprint: false }, deps(receiptSource([unitItem()]), { print: () => Promise.reject(new Error("boom")) }).built);
    expect(outcome).toEqual({ ok: false, code: "UNKNOWN", message: "No se pudo imprimir el ticket." });
    const loadFails = await printSaleReceipt("x", { reprint: false }, deps(null, { loadSource: () => Promise.reject(new Error("sqlite")) }).built);
    expect(loadFails).toMatchObject({ ok: false });
  });
});

describe("describePrintError", () => {
  it("maps the stable Rust codes and keeps their Spanish text", () => {
    expect(describePrintError("PRINTER_DISABLED: la impresora de tickets no está habilitada en esta caja.")).toEqual({ code: "DISABLED", message: "la impresora de tickets no está habilitada en esta caja." });
    expect(describePrintError("PRINTER_NOT_CONFIGURED: todavía no se eligió una impresora.")).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(describePrintError("PRINTER_UNSUPPORTED: no disponible.")).toMatchObject({ code: "UNSUPPORTED" });
    expect(describePrintError("PRINT_FAILED: cola detenida")).toEqual({ code: "PRINT_FAILED", message: "No se pudo imprimir el ticket: cola detenida" });
  });

  it("anything else is a generic message", () => {
    expect(describePrintError(undefined)).toEqual({ code: "UNKNOWN", message: "No se pudo imprimir el ticket." });
    expect(describePrintError("fallo raro")).toMatchObject({ code: "UNKNOWN" });
  });
});

describe("impresión automática", () => {
  const some = new Set<string>();
  it("only when requested, the printer is ready, it is visible here and that sale was not printed yet", () => {
    const settings = { ...READY, autoPrint: true };
    expect(shouldAutoPrint({ settings, visible: true, saleId: "s1", alreadyPrinted: some })).toBe(true);
    expect(shouldAutoPrint({ settings: { ...settings, autoPrint: false }, visible: true, saleId: "s1", alreadyPrinted: some })).toBe(false);
    expect(shouldAutoPrint({ settings: { ...settings, enabled: false }, visible: true, saleId: "s1", alreadyPrinted: some })).toBe(false);
    expect(shouldAutoPrint({ settings: { ...settings, printerName: null }, visible: true, saleId: "s1", alreadyPrinted: some })).toBe(false);
    expect(shouldAutoPrint({ settings, visible: false, saleId: "s1", alreadyPrinted: some })).toBe(false);
    expect(shouldAutoPrint({ settings: null, visible: true, saleId: "s1", alreadyPrinted: some })).toBe(false);
  });

  it("prints exactly once per sale however many times the confirmation is announced", () => {
    const settings = { ...READY, autoPrint: true };
    const printed = new Set<string>();
    let prints = 0;
    for (const saleId of ["mp-1", "mp-1", "mp-1", "cash-2"]) {
      if (shouldAutoPrint({ settings, visible: true, saleId, alreadyPrinted: printed })) { printed.add(saleId); prints += 1; }
    }
    expect(prints).toBe(2);
  });

  it("isPrinterReady needs the switch on and a printer chosen", () => {
    expect(isPrinterReady(READY)).toBe(true);
    expect(isPrinterReady(DEFAULT_PRINTER_SETTINGS)).toBe(false);
    expect(isPrinterReady({ ...READY, printerName: "" })).toBe(false);
    expect(isPrinterReady(null)).toBe(false);
  });
});

describe("printTestPage", () => {
  const api = (print: PrinterApi["print"]): PrinterApi => ({ listPrinters: () => Promise.resolve([]), getSettings: () => Promise.resolve(READY), setSettings: (settings) => Promise.resolve(settings), print });

  it("prints the test page on the selected printer with the on-screen cut and code page options", async () => {
    const print = vi.fn().mockResolvedValue(undefined);
    const outcome = await printTestPage({ ...READY, autoCut: false, codePage: "WPC1252" }, "Otra", api(print), new Date("2026-10-04T15:34:00Z"));
    expect(outcome).toEqual({ ok: true });
    const [document, target] = print.mock.calls[0] as [PrintDocument, unknown];
    expect(target).toEqual({ printerName: "Otra", autoCut: false, codePage: "WPC1252" });
    expect(documentToText(document)).toContain("Impresora: Otra");
  });

  it("reports a missing printer so another one can be chosen", async () => {
    const outcome = await printTestPage(READY, "Vieja", api(vi.fn().mockRejectedValue("PRINTER_NOT_FOUND: la impresora \"Vieja\" no está instalada en esta computadora.")));
    expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
