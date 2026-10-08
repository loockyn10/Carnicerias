import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// El ticket y el encabezado viven inline en App.tsx (depende de Supabase/Tauri y no se puede montar en un test), así que
// estas guardas son textuales sobre el fuente y el CSS.
const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

describe("columna del ticket (sin título ni peso total)", () => {
  it("no renderiza 'Ticket actual' ni 'Peso total'", () => {
    expect(source).not.toContain("Ticket actual");
    expect(source).not.toContain("Peso total");
  });

  it("conserva Cancelar, líneas, subtotal, promos, TOTAL y Confirmar venta", () => {
    for (const text of ["Cancelar", "Modificar cantidad", "Modificar peso", "Editar precio", "Eliminar", "Subtotal/lista", "Promos y packs", "Descuento por pago", "Recargo tarjeta", "Ajuste manual", "TOTAL", "Confirmar venta"]) {
      expect(source).toContain(text);
    }
  });
});

describe("descuento general manual eliminado del POS", () => {
  it("no hay input ni estado de descuento general en el ticket", () => {
    for (const text of ["ticket-discount-input", "ticketDiscountInput", "ticketDiscountBps", "ticketDiscountParse", "Importe descuento", "sanitizeDiscountInput", "parseDiscountPercent", "Descuento sobre el total"]) {
      expect(source).not.toContain(text);
    }
  });

  it("toda venta nueva sale con descuento general 0: se calcula con 0 bps y nunca se manda `ticketDiscount`", () => {
    expect(source).toContain("summarizeTicket(ticket, 0n)");
    expect(source).not.toContain("ticketDiscount:");
    expect(source).not.toContain("ticketDiscount ");
  });
});

describe("aviso de venta completada (toast)", () => {
  it("ya no hay barra de 'Nueva venta': el toast se cierra con la × y el onDismiss sólo oculta el aviso", () => {
    expect(source).not.toContain("PostSaleBar");
    expect(source).not.toContain("onNewSale");
    expect(source).toContain("onDismiss={() => setPostSale(null)}");
  });

  it("la reimpresión de Ventas recientes sale de la venta guardada, no del aviso: sigue ahí aunque el aviso ya se haya ido", () => {
    expect(source).toContain("runPrint(sale.saleId, true)");
    expect(source).toContain("Reimprimir ticket");
  });

  it("el aviso flota (position: fixed) y no empuja el layout", () => {
    expect(css).toMatch(/\.pos-sale-toast\s*\{[^}]*position:\s*fixed/);
  });
});

describe("botón «+» (Nuevo producto) del encabezado", () => {
  it("sólo se muestra con la capacidad de Central (centralPos), nunca por nombre de sucursal", () => {
    const index = source.indexOf('title="Nuevo producto"');
    expect(index).toBeGreaterThan(0);
    expect(source.slice(Math.max(0, index - 200), index)).toMatch(/\{centralPos \? \(\s*<button/);
    expect(source).not.toMatch(/name\s*===\s*["']Central["']/i);
  });

  it("abre el mismo QuickProductModal de la alta por scan (código vacío = alta manual) y comparte tamaño con la campanita", () => {
    expect(source).toContain('onClick={() => setQuickCreateCode("")}');
    expect(source.match(/className=\{HEADER_ICON_BUTTON\}/g)).toHaveLength(2);
    expect(source.match(/<QuickProductModal/g)).toHaveLength(1);
  });
});

describe("ancho de la columna del ticket", () => {
  it("40% del ancho en pantalla estándar y en notebooks bajas (con tope)", () => {
    expect(source).toContain("lg:grid-cols-[minmax(0,1fr)_clamp(420px,40vw,640px)]");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) clamp(380px, 40vw, 600px)");
  });

  it("los artículos scrollean por dentro y el footer (pagos, subtotal, TOTAL, Confirmar) no se achica ni sale de pantalla", () => {
    expect(source).toMatch(/pos-ticket-items min-h-0 flex-1[^"]*overflow-y-auto/);
    expect(source).toMatch(/pos-ticket-footer[^"]*shrink-0/);
    expect(source).toMatch(/className="pos-ticket flex[^"]*lg:min-h-0[^"]*lg:overflow-hidden/);
  });
});

describe("impresión de tickets: capacidad de la computadora, no de la sucursal", () => {
  it("la visibilidad de la impresora (botón, auto-print y Reimprimir) depende sólo del escritorio, nunca de centralPos ni de production_branch_id", () => {
    expect(source).toMatch(/const printerVisible = desktop;/);
    expect(source).not.toMatch(/printerVisible\s*=[^;]*(centralPos|productionBranch|production_branch)/);
    const printing = source.slice(source.indexOf("const printerVisible"), source.indexOf("function postSalePrintView"));
    expect(printing).not.toMatch(/centralPos|production_branch|productionBranch/);
  });

  it("un fallo de impresión sólo actualiza el estado de impresión (la venta ya está confirmada)", () => {
    const run = source.slice(source.indexOf("const runPrint"), source.indexOf("const runPrint") + 600);
    expect(run).toContain("printSaleReceipt");
    expect(run).not.toMatch(/confirmSale|cancelSale|setPostSale\(null\)/);
  });
});
