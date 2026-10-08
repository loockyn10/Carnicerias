/**
 * Impresión directa del ticket desde el POS de escritorio. Une el recibo (`receipt.ts`), el renderer
 * (`receipt-render.ts`) y los comandos Tauri de impresión (`src-tauri/src/printer`). Todo el camino es LOCAL:
 * snapshots de SQLite -> ESC/POS -> spooler de Windows. No hay request a Supabase ni `navigator.onLine`, así que
 * imprime igual sin Internet. Un error de impresión NUNCA toca la venta: acá no hay ninguna escritura a la base.
 */

import { invoke } from "@tauri-apps/api/core";

import { isDesktopRuntime, localDatabase, type LocalSaleReceiptSource } from "./local-database";
import { buildSaleReceipt, receiptPrintability } from "./receipt";
import { RECEIPT_PAPER_WIDTH_MM, renderSaleReceipt, renderTestPage, type PrintDocument } from "./receipt-render";

export type PrinterCodePage = "CP858" | "WPC1252";

/** Configuración local de la impresora de ESTA computadora (nunca en Supabase). Espejo de `PrinterSettings` en Rust. */
export interface PrinterSettings {
  enabled: boolean;
  printerName: string | null;
  paperWidthMm: number;
  autoPrint: boolean;
  autoCut: boolean;
  codePage: PrinterCodePage;
  businessName: string;
}

export interface InstalledPrinter { name: string; isDefault: boolean }
export interface PrintTarget { printerName: string; autoCut: boolean; codePage: PrinterCodePage }

export const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
  enabled: false, printerName: null, paperWidthMm: RECEIPT_PAPER_WIDTH_MM, autoPrint: false, autoCut: true, codePage: "CP858", businessName: "Carnicerías Fran"
};

function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktopRuntime()) return Promise.reject(new Error("PRINTER_UNSUPPORTED: la impresión directa sólo existe en el POS de escritorio."));
  return invoke<T>(command, args);
}

/** Comandos Tauri de impresión. Inyectable para probar sin Tauri ni impresora. */
export interface PrinterApi {
  listPrinters: () => Promise<InstalledPrinter[]>;
  getSettings: () => Promise<PrinterSettings>;
  setSettings: (settings: PrinterSettings) => Promise<PrinterSettings>;
  print: (document: PrintDocument, target?: PrintTarget) => Promise<void>;
}

export const printerApi: PrinterApi = {
  listPrinters: () => desktopInvoke<InstalledPrinter[]>("list_printers"),
  getSettings: () => desktopInvoke<PrinterSettings>("get_printer_settings"),
  setSettings: (settings) => desktopInvoke<PrinterSettings>("set_printer_settings", { settings }),
  print: async (document, target) => { await desktopInvoke<null>("print_document", { document, target: target ?? null }); }
};

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export type PrintFailureCode = "DISABLED" | "NOT_CONFIGURED" | "NOT_FOUND" | "UNSUPPORTED" | "PRINT_FAILED" | "NOT_PRINTABLE" | "SALE_NOT_FOUND" | "UNKNOWN";
export type PrintOutcome = { ok: true } | { ok: false; code: PrintFailureCode; message: string };

const CODE_BY_PREFIX: Record<string, PrintFailureCode> = {
  PRINTER_DISABLED: "DISABLED",
  PRINTER_NOT_CONFIGURED: "NOT_CONFIGURED",
  PRINTER_NOT_FOUND: "NOT_FOUND",
  PRINTER_UNSUPPORTED: "UNSUPPORTED",
  PRINT_FAILED: "PRINT_FAILED"
};

/** Tauri rechaza con el string crudo del `Result<_, String>` de Rust ("CODIGO: mensaje en español"). */
export function describePrintError(error: unknown): { code: PrintFailureCode; message: string } {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const match = /^([A-Z_]+):\s*(.*)$/s.exec(raw.trim());
  const code = match?.[1] ? CODE_BY_PREFIX[match[1]] : undefined;
  if (code && match?.[2]) {
    return {
      code,
      message: code === "PRINT_FAILED" ? `No se pudo imprimir el ticket: ${match[2]}` : match[2]
    };
  }
  return { code: "UNKNOWN", message: "No se pudo imprimir el ticket." };
}

// ---------------------------------------------------------------------------
// Imprimir una venta
// ---------------------------------------------------------------------------

export interface PrintSaleDeps {
  loadSource: (saleId: string) => Promise<LocalSaleReceiptSource | null>;
  getSettings: () => Promise<PrinterSettings>;
  print: (document: PrintDocument) => Promise<void>;
}

const defaultDeps: PrintSaleDeps = {
  loadSource: (saleId) => localDatabase.saleReceiptSource(saleId),
  getSettings: () => printerApi.getSettings(),
  print: (document) => printerApi.print(document)
};

/**
 * Imprime (o reimprime) el ticket de una venta ya registrada. NO lanza: devuelve el resultado, y un fallo de
 * impresión no cambia nada de la venta (ni la reintenta a ciegas: el cajero decide con "Reintentar impresión").
 * Una venta que no es un ticket final (pendiente de Mercado Pago, anulada) se rechaza antes de tocar la impresora.
 */
export async function printSaleReceipt(saleId: string, options: { reprint: boolean }, deps: PrintSaleDeps = defaultDeps): Promise<PrintOutcome> {
  try {
    const source = await deps.loadSource(saleId);
    if (!source) return { ok: false, code: "SALE_NOT_FOUND", message: "No se encontró la venta en esta caja." };
    const printability = receiptPrintability({ status: source.status, provider: source.payment?.provider ?? null, verificationStatus: source.payment?.verificationStatus ?? null });
    if (!printability.printable) return { ok: false, code: "NOT_PRINTABLE", message: printability.message };
    const settings = await deps.getSettings();
    if (!settings.enabled) return { ok: false, code: "DISABLED", message: "La impresora de tickets no está habilitada en esta caja." };
    const document = renderSaleReceipt(buildSaleReceipt(source), {
      reprint: options.reprint
    });
    await deps.print(document);
    return { ok: true };
  } catch (error) {
    const { code, message } = describePrintError(error);
    return { ok: false, code, message };
  }
}

/** Hoja de prueba con lo que está en la pantalla de configuración (guardado o no). */
export async function printTestPage(settings: PrinterSettings, printerName: string, api: PrinterApi = printerApi, now: Date = new Date()): Promise<PrintOutcome> {
  try {
    const document = renderTestPage({ printerName, now });
    await api.print(document, { printerName, autoCut: settings.autoCut, codePage: settings.codePage });
    return { ok: true };
  } catch (error) {
    const { code, message } = describePrintError(error);
    return { ok: false, code, message };
  }
}

/** La impresora está lista para imprimir tickets en esta caja. */
export function isPrinterReady(settings: PrinterSettings | null): settings is PrinterSettings & { printerName: string } {
  return settings !== null && settings.enabled && settings.printerName !== null && settings.printerName !== "";
}

/** Impresión automática al completar la venta: sólo si está pedida, la impresora está lista y esa venta no se imprimió ya. */
export function shouldAutoPrint(input: { settings: PrinterSettings | null; visible: boolean; saleId: string; alreadyPrinted: ReadonlySet<string> }): boolean {
  return input.visible && isPrinterReady(input.settings) && input.settings.autoPrint && !input.alreadyPrinted.has(input.saleId);
}
