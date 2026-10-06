import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PostSaleToast, shouldAutoDismiss, type PostSalePrintView } from "./PostSaleToast";
import { PrinterSettingsModal } from "./PrinterSettingsModal";
import { DEFAULT_PRINTER_SETTINGS, type InstalledPrinter, type PrinterSettings } from "./lib/printer";

const PRINTERS: InstalledPrinter[] = [{ name: "Microsoft Print to PDF", isDefault: true }, { name: "POS-80 Printer", isDefault: false }];

function modal(settings: PrinterSettings | null, printers: InstalledPrinter[] = PRINTERS) {
  return renderToStaticMarkup(<PrinterSettingsModal settings={settings} initialPrinters={printers} onSaved={() => undefined} onClose={() => undefined} />);
}

describe("PrinterSettingsModal", () => {
  it("shows the agreed screen: printer list, test button, auto print, auto cut and Guardar", () => {
    const html = modal(DEFAULT_PRINTER_SETTINGS);
    expect(html).toContain("Impresora de tickets");
    expect(html).toContain("POS-80 Printer");
    expect(html).toContain("Microsoft Print to PDF (predeterminada de Windows)");
    expect(html).toContain("Sin impresora (desactivada)");
    expect(html).toContain("Imprimir prueba");
    expect(html).toContain("Imprimir automáticamente al completar una venta");
    expect(html).toContain("Cortar papel automáticamente");
    expect(html).toContain("Guardar");
    expect(html).not.toContain("printer-missing");
  });

  it("without a chosen printer the test button is disabled and auto print cannot be turned on", () => {
    const html = modal(DEFAULT_PRINTER_SETTINGS);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Imprimir prueba/);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""[^>]*\/>Imprimir automáticamente|<input[^>]*disabled=""[^>]*type="checkbox"[^>]*\/>Imprimir automáticamente/);
  });

  it("a configured, installed printer is selected and testable", () => {
    const html = modal({ ...DEFAULT_PRINTER_SETTINGS, enabled: true, printerName: "POS-80 Printer", autoPrint: true });
    expect(html).toContain('<option value="POS-80 Printer" selected="">');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Imprimir prueba/);
    expect(html).not.toContain("printer-missing");
  });

  it("a configured printer that is no longer installed is flagged, blocks Guardar and the test, and lets the cashier pick another", () => {
    const html = modal({ ...DEFAULT_PRINTER_SETTINGS, enabled: true, printerName: "Impresora vieja" });
    expect(html).toContain("printer-missing");
    expect(html).toContain("ya no está instalada");
    expect(html).toContain("Impresora vieja (no instalada)");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Imprimir prueba/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Guardar/);
    expect(html).toContain("POS-80 Printer");
  });

  it("with no printers installed at all it says so", () => {
    expect(modal(DEFAULT_PRINTER_SETTINGS, [])).toContain("No hay impresoras instaladas");
  });

  it("offers the code page and ticket name as advanced options", () => {
    const html = modal(DEFAULT_PRINTER_SETTINGS);
    expect(html).toContain("Opciones avanzadas");
    expect(html).toContain("Windows-1252");
    expect(html).toContain("Carnicerías Fran");
  });
});

describe("PostSaleToast — impresión", () => {
  const base = { notification: {}, saleLabel: "a8f4k2d1", totalLabel: "$ 23.180", availability: { visible: false } as const, onDismiss: () => undefined, onSendTicket: () => undefined, onPrint: () => undefined, onConfigurePrinter: () => undefined };
  const render = (print: PostSalePrintView | null) => renderToStaticMarkup(<PostSaleToast {...base} print={print} />);

  it("shows 'Venta completada ✓', the total, Imprimir ticket and the × — no 'Nueva venta' block", () => {
    const html = render({ phase: "ready" });
    expect(html).toContain("Venta completada ✓");
    expect(html).toContain("Total $ 23.180");
    expect(html).toContain("Imprimir ticket");
    expect(html).toContain('aria-label="Cerrar aviso"');
    expect(html).not.toContain("Nueva venta");
  });

  it("where printing does not exist (other branches / browser) the toast has no print control", () => {
    const html = render(null);
    expect(html).not.toContain("Imprimir");
    expect(html).not.toContain("impresora");
    expect(html).toContain('aria-label="Cerrar aviso"');
  });

  it("a print failure keeps the sale completed, explains it and offers Reintentar impresión", () => {
    const html = render({ phase: "error", message: "la impresora no está instalada." });
    expect(html).toContain("Venta completada ✓");
    expect(html).toContain("Venta completada, pero no se pudo imprimir el ticket.");
    expect(html).toContain("la impresora no está instalada.");
    expect(html).toContain("Reintentar impresión");
  });

  it("while printing the button is disabled; afterwards it confirms", () => {
    expect(render({ phase: "printing" })).toMatch(/<button[^>]*disabled=""[^>]*>Imprimiendo…/);
    expect(render({ phase: "done" })).toContain("Ticket enviado a la impresora.");
  });

  it("without a configured printer it offers to configure it (never a silent failure)", () => {
    const html = render({ phase: "unconfigured" });
    expect(html).toContain("Configurar impresora");
    expect(html).not.toContain("Imprimir ticket");
  });
});

describe("shouldAutoDismiss", () => {
  it("the toast leaves by itself except while printing or after a print error (the operator must see it)", () => {
    for (const print of [null, { phase: "ready" }, { phase: "done" }, { phase: "unconfigured" }] as (PostSalePrintView | null)[]) expect(shouldAutoDismiss(print)).toBe(true);
    expect(shouldAutoDismiss({ phase: "printing" })).toBe(false);
    expect(shouldAutoDismiss({ phase: "error", message: "x" })).toBe(false);
  });
});
