import { describe, expect, it } from "vitest";

import { buildSaleReceipt } from "./receipt";
import {
  columnsForPaperWidth, documentToText, formatReceiptDate, formatReceiptMoney, formatReceiptPercent, formatReceiptWeight,
  renderSaleReceipt, renderTestPage, wrapText, type PrintDocument
} from "./receipt-render";
import { item, packItem, promoItem, receiptSource, unitItem, weightItem } from "./receipt-fixtures";
import type { LocalSaleReceiptSource } from "./local-database";

const COLUMNS = 42;
const render = (source: LocalSaleReceiptSource, options: { reprint?: boolean; columns?: number } = {}): string[] =>
  renderSaleReceipt(buildSaleReceipt(source), { columns: options.columns ?? COLUMNS, businessName: "Carnicerías Fran", ...(options.reprint ? { reprint: true } : {}) }).lines.map((line) => line.text);
const doc = (source: LocalSaleReceiptSource, options: { reprint?: boolean; columns?: number } = {}): PrintDocument =>
  renderSaleReceipt(buildSaleReceipt(source), { columns: options.columns ?? COLUMNS, businessName: "Carnicerías Fran", ...(options.reprint ? { reprint: true } : {}) });
const right = (text: string, width = COLUMNS) => text.padStart(width);
const row = (left: string, amount: string, width = COLUMNS) => left + amount.padStart(width - left.length);
const RULE = "-".repeat(COLUMNS);
const center = (text: string, width = COLUMNS) => " ".repeat(Math.floor((width - Array.from(text).length) / 2)) + text;

/** Líneas del cuerpo: entre el primer y el segundo separador. */
function body(lines: string[]): string[] {
  const first = lines.indexOf(RULE);
  return lines.slice(first + 1, lines.indexOf(RULE, first + 1));
}

describe("renderSaleReceipt — formato", () => {
  it("is explicitly a NON-fiscal receipt and shows header, date in Argentina time, ticket id and operator", () => {
    const lines = render(receiptSource([unitItem()]));
    expect(lines.slice(0, 9)).toEqual([
      center("CARNICERÍAS FRAN"),
      center("CENTRAL"),
      "",
      center("COMPROBANTE NO FISCAL"),
      "",
      "04/10/2026  18:43",
      "Ticket: A8F4K2D1",
      "Atendió: Juan",
      RULE
    ]);
    expect(lines.at(-1)).toBe(center("Gracias por su compra"));
    expect(lines.join("\n")).not.toMatch(/CAE|ARCA|Factura|factura/);
  });

  it("UNIT simple: name, quantity x price and the amount aligned to the right", () => {
    expect(body(render(receiptSource([unitItem()])))).toEqual(["Coca Cola", "2 x $2.500", right("$5.000")]);
  });

  it("WEIGHT: kg with three decimals and the per-kg price", () => {
    expect(body(render(receiptSource([weightItem()])))).toEqual(["Vacio", "1,250 kg x $12.000/kg", right("$15.000")]);
  });

  it("Pack 25 %: 1 pack x 8 u, the real percentage and the discount, then the total of the line", () => {
    expect(body(render(receiptSource([packItem(2500)])))).toEqual([
      "Leche Entera", "1 pack x 8 u", row("Pack 25% OFF", "-$2.000"), right("$6.000")
    ]);
  });

  it("Pack 20 %: its own percentage", () => {
    expect(body(render(receiptSource([packItem(2000)])))).toEqual([
      "Leche Entera", "1 pack x 8 u", row("Pack 20% OFF", "-$1.600"), right("$6.400")
    ]);
  });

  it("two packs show both the pack count and the real units", () => {
    expect(body(render(receiptSource([packItem(2500, 2)])))).toEqual([
      "Leche Entera", "2 packs x 8 u = 16 u", row("Pack 25% OFF", "-$4.000"), right("$12.000")
    ]);
  });

  it("branch promotion 15 % from 3 units: list price, the discount and the discounted total", () => {
    expect(body(render(receiptSource([promoItem()])))).toEqual([
      "Coca Cola", "4 x $1.000", row("15% OFF desde 3", "-$600"), right("$3.400")
    ]);
  });

  it("a manual price prints the price actually charged and does not announce the modification to the customer", () => {
    const manual = item({ productName: "Coca Cola", quantityUnits: 1, originalPriceCents: "1200000", chargedPriceCents: "1000000", subtotalCents: "1000000", manualPriceApplied: true, manualUnitPriceCents: "1000000" });
    const lines = render(receiptSource([manual]));
    expect(body(lines)).toEqual(["Coca Cola", "1 x $10.000", right("$10.000")]);
    expect(lines.join("\n")).not.toMatch(/MODIFICADO|manual|\$12\.000/i);
  });

  it("a manual WEIGHT price is per kg", () => {
    const manual = weightItem({ chargedPriceCents: "1100000", subtotalCents: "1375000", manualPriceApplied: true, manualUnitPriceCents: "1100000" });
    expect(body(render(receiptSource([manual])))).toEqual(["Vacio", "1,250 kg x $11.000/kg", right("$13.750")]);
  });

  it("a WEIGHT promotion keeps its percentage and a fixed pack total keeps its list price and the saving", () => {
    const percentage = weightItem({ chargedPriceCents: "1080000", subtotalCents: "1350000", promotionDiscountCents: "150000", discountType: "PERCENTAGE", discountValue: 1000 });
    expect(body(render(receiptSource([percentage])))).toEqual(["Vacio", "1,250 kg x $12.000/kg", row("Promo 10% OFF", "-$1.500"), right("$13.500")]);
    const fixedTotal = weightItem({ chargedPriceCents: "1440000", subtotalCents: "1800000", promotionDiscountCents: "1200000", promotionMode: "PACK_FIXED_TOTAL", weightGrams: 2500, originalPriceCents: "1200000" });
    expect(body(render(receiptSource([fixedTotal])))).toEqual(["Vacio", "2,500 kg x $12.000/kg", row("Promo pack", "-$12.000"), right("$18.000")]);
  });

  it("a card surcharge on a plain line is inside the printed price; on a discounted line it is an explicit row", () => {
    const plain = unitItem({ chargedPriceCents: "275000", subtotalCents: "550000", cardSurchargeCents: "50000" });
    expect(body(render(receiptSource([plain], { payment: { method: "DEBIT", provider: null, verificationStatus: "NOT_REQUIRED" } })))).toEqual(["Coca Cola", "2 x $2.750", right("$5.500")]);
    const discounted = promoItem({ chargedPriceCents: "93500", subtotalCents: "374000", cardSurchargeCents: "34000" });
    expect(body(render(receiptSource([discounted])))).toEqual(["Coca Cola", "4 x $1.000", row("15% OFF desde 3", "-$600"), row("Recargo tarjeta", "+$340"), right("$3.740")]);
  });

  it("the general discount is shown apart at the end with the real percentage (also with decimals)", () => {
    const five = render(receiptSource([packItem(2500), promoItem(), weightItem()], { ticketDiscountBps: 500, ticketDiscountCents: "122000" }));
    const start = five.indexOf(row("Subtotal", "$24.400"));
    expect(start).toBeGreaterThan(0);
    expect(five.slice(start, start + 5)).toEqual([row("Subtotal", "$24.400"), row("Desc. general 5%", "-$1.220"), RULE, row("TOTAL", "$23.180", COLUMNS / 2), ""]);
    const decimal = render(receiptSource([unitItem({ quantityUnits: 8, subtotalCents: "2000000", chargedPriceCents: "250000" })], { ticketDiscountBps: 750, ticketDiscountCents: "150000" }));
    expect(decimal).toContain(row("Subtotal", "$20.000"));
    expect(decimal).toContain(row("Desc. general 7,5%", "-$1.500"));
    expect(decimal).toContain(row("TOTAL", "$18.500", COLUMNS / 2));
  });

  it("without a general discount there is no Subtotal / Desc. general block", () => {
    const text = render(receiptSource([unitItem()])).join("\n");
    expect(text).not.toContain("Subtotal");
    expect(text).not.toContain("Desc. general");
  });

  it("the TOTAL is double-size (and fits half the columns); the rest is normal or bold", () => {
    const total = doc(receiptSource([unitItem()])).lines.find((line) => line.text.startsWith("TOTAL"));
    expect(total).toEqual({ text: row("TOTAL", "$5.000", COLUMNS / 2), style: "double" });
    expect(Array.from(total?.text ?? "").length).toBeLessThanOrEqual(COLUMNS / 2);
  });

  it("matches the agreed example ticket line by line", () => {
    const source = receiptSource([packItem(2500), promoItem(), weightItem()], { ticketDiscountBps: 500, ticketDiscountCents: "122000" });
    expect(render(source)).toEqual([
      center("CARNICERÍAS FRAN"),
      center("CENTRAL"),
      "",
      center("COMPROBANTE NO FISCAL"),
      "",
      "04/10/2026  18:43",
      "Ticket: A8F4K2D1",
      "Atendió: Juan",
      RULE,
      "Leche Entera",
      "1 pack x 8 u",
      "Pack 25% OFF                       -$2.000",
      "                                    $6.000",
      "",
      "Coca Cola",
      "4 x $1.000",
      "15% OFF desde 3                      -$600",
      "                                    $3.400",
      "",
      "Vacio",
      "1,250 kg x $12.000/kg",
      "                                   $15.000",
      RULE,
      "Subtotal                           $24.400",
      "Desc. general 5%                   -$1.220",
      RULE,
      row("TOTAL", "$23.180", COLUMNS / 2),
      "",
      "Pago: Efectivo",
      "",
      RULE,
      center("Gracias por su compra")
    ]);
  });
});

describe("renderSaleReceipt — medio de pago", () => {
  const pay = (method: string, provider: string | null = null) =>
    render(receiptSource([unitItem()], { payment: { method, provider, verificationStatus: provider ? "CONFIRMED" : "NOT_REQUIRED" } })).find((line) => line.startsWith("Pago:"));

  it("uses friendly labels and never the internal names", () => {
    expect(pay("CASH")).toBe("Pago: Efectivo");
    expect(pay("DEBIT")).toBe("Pago: Tarjeta de débito");
    expect(pay("CREDIT")).toBe("Pago: Tarjeta de crédito");
    expect(pay("TRANSFER")).toBe("Pago: Transferencia");
    expect(pay("OTHER")).toBe("Pago: Otro");
    expect(pay("ALGO_NUEVO")).toBe("Pago: Otro");
  });

  it("a confirmed Mercado Pago sale (TRANSFER + provider) says Mercado Pago, not TRANSFER or MERCADOPAGO", () => {
    const lines = render(receiptSource([unitItem()], { payment: { method: "TRANSFER", provider: "MERCADOPAGO", verificationStatus: "CONFIRMED" } }));
    expect(lines).toContain("Pago: Mercado Pago");
    expect(lines.join("\n")).not.toMatch(/TRANSFER|MERCADOPAGO/);
  });
});

describe("renderSaleReceipt — reimpresión", () => {
  it("a reprint shows REIMPRESION at the very top and the original does not", () => {
    const source = receiptSource([unitItem()]);
    expect(render(source, { reprint: true }).slice(0, 2)).toEqual([center("*** REIMPRESION ***"), ""]);
    expect(render(source).join("\n")).not.toContain("REIMPRESION");
    expect(render(source, { reprint: true }).slice(2)).toEqual(render(source));
  });

  it("a historical sale keeps the Pack, price and promotion it was sold with (only snapshots are read)", () => {
    // Venta vieja: pack de 8 al 20 %, lista $1.000. Hoy el producto puede valer más, tener otro pack o llamarse distinto:
    // el recibo sólo conoce lo que la venta guardó.
    const old = receiptSource([packItem(2000, 1, { productName: "Leche Entera (nombre de entonces)" })], { branchName: "Avenida", operatorName: "Ana" });
    const lines = render(old, { reprint: true });
    expect(lines).toContain("Leche Entera (nombre de entonces)");
    expect(lines).toContain("1 pack x 8 u");
    expect(lines).toContain(row("Pack 20% OFF", "-$1.600"));
    expect(lines).toContain(center("AVENIDA"));
    expect(lines).toContain("Atendió: Ana");
    expect(render(old, { reprint: true })).toEqual(lines);
  });
});

describe("renderSaleReceipt — ancho y alineación", () => {
  const widthOf = (text: string) => Array.from(text).length;

  it("long names, long words, emoji and accents never exceed the width", () => {
    const long = "Hamburguesa de carne vacuna premium con queso cheddar y panceta ahumada edición especial 🥩🥩🥩";
    const nasty = "A".repeat(120);
    const source = receiptSource([unitItem({ productName: long }), unitItem({ productName: nasty }), weightItem({ productName: "Ñandú Ç ü 肉 🥩 \u0007 con\tcontroles" })], { operatorName: "María de los Ángeles Fernández Gutiérrez de la Vega" });
    for (const columns of [32, 42, 48]) {
      const document = doc(source, { columns });
      for (const line of document.lines) {
        const limit = line.style === "double" ? Math.floor(columns / 2) : columns;
        expect(widthOf(line.text), `${String(columns)}: "${line.text}"`).toBeLessThanOrEqual(limit);
        expect(line.text).not.toMatch(/\p{Cc}/u);
      }
    }
  });

  it("every amount row ends exactly at the right edge and quantities/money stay aligned in a long ticket", () => {
    const items = Array.from({ length: 25 }, (_, index) => unitItem({ productName: `Producto ${String(index)}`, quantityUnits: index + 1, subtotalCents: String((index + 1) * 123_456), chargedPriceCents: "123456" }));
    const lines = render(receiptSource(items, { ticketDiscountBps: 1000, ticketDiscountCents: "100000" }));
    const amountRows = lines.filter((line) => /\$[\d.]+(,\d\d)?$/.test(line) && !line.startsWith("TOTAL") && !line.includes(" x "));
    expect(amountRows.length).toBeGreaterThan(25);
    for (const line of amountRows) expect(widthOf(line), line).toBe(COLUMNS);
  });

  it("money uses dots for thousands and a comma only when there are cents", () => {
    expect(formatReceiptMoney(123_456_789n)).toBe("$1.234.567,89");
    expect(formatReceiptMoney(500_000n)).toBe("$5.000");
    expect(formatReceiptMoney(-60_000n)).toBe("-$600");
    expect(formatReceiptMoney(5n)).toBe("$0,05");
    expect(formatReceiptWeight(1250)).toBe("1,250 kg");
    expect(formatReceiptWeight(75)).toBe("0,075 kg");
    expect(formatReceiptPercent(2500)).toBe("25%");
    expect(formatReceiptPercent(750)).toBe("7,5%");
    expect(formatReceiptPercent(1234)).toBe("12,34%");
  });

  it("the date is always Argentina time and uses plain ASCII", () => {
    expect(formatReceiptDate("2026-10-04T21:43:00Z")).toBe("04/10/2026  18:43");
    expect(formatReceiptDate("2026-01-01T02:05:00Z")).toBe("31/12/2025  23:05");
    expect(formatReceiptDate("2026-10-04T21:43:00Z")).toMatch(/^[\x20-\x7E]+$/);
  });

  it("wrapText breaks by words, splits oversized words and never returns an empty list", () => {
    expect(wrapText("uno dos tres", 7)).toEqual(["uno dos", "tres"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("   ", 10)).toEqual([""]);
  });

  it("58 mm paper uses 32 columns and 80 mm uses 42", () => {
    expect(columnsForPaperWidth(58)).toBe(32);
    expect(columnsForPaperWidth(80)).toBe(42);
    expect(render(receiptSource([unitItem()]), { columns: 32 })).toContain("-".repeat(32));
  });
});

describe("renderTestPage", () => {
  it("prints the printer name, the time and the characters that usually break", () => {
    const text = documentToText(renderTestPage({ printerName: "POS-80 Printer", now: new Date("2026-10-04T15:34:00Z"), columns: COLUMNS }));
    expect(text).toContain("CARNICERIAS POS");
    expect(text).toContain("Prueba de impresion");
    expect(text).toContain("Impresora: POS-80 Printer");
    expect(text).toContain("04/10/2026  12:34");
    expect(text).toContain("ABC abc 123");
    expect(text).toContain("$ % ñ á é í ó ú");
    expect(text).toContain("Impresion correcta");
  });
});
