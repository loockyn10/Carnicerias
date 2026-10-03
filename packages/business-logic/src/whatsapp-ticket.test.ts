import { describe, expect, it } from "vitest";

import {
  buildTemplateParameters,
  buildTicketModel,
  evaluateTicketEligibility,
  formatKilograms,
  formatMoney,
  maskPhone,
  MAX_ITEMS_PARAMETER_LENGTH,
  normalizePhone,
  parseTicketSource,
  renderTicketText,
  sanitizeTemplateParameter,
  TICKET_TEMPLATE_PARAMETER_COUNT,
  type TicketSource
} from "./whatsapp-ticket";

const SALE_ID = "f7000000-0000-4000-8000-000000000001";

function source(over: Partial<TicketSource> = {}): TicketSource {
  return {
    saleId: SALE_ID,
    status: "COMPLETED",
    completedAt: "2026-10-02T17:35:00Z", // 14:35 en Buenos Aires
    totalCents: 1_250_000 + 400_000,
    ticketDiscountBps: 0,
    ticketDiscountCents: 0,
    organizationName: "Carnicerías Fran",
    branchName: "Avenida",
    timezone: "America/Argentina/Buenos_Aires",
    items: [
      { name: "Vacío", weightGrams: 1250, quantityUnits: null, unitPriceCents: 1_000_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 1_250_000, promotionMode: null, manualPriceApplied: false },
      { name: "Hamburguesa", weightGrams: null, quantityUnits: 4, unitPriceCents: 100_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 400_000, promotionMode: null, manualPriceApplied: false }
    ],
    payments: [{ method: "CASH", provider: null, verificationStatus: "NOT_REQUIRED", amountCents: 1_650_000 }],
    ...over
  };
}

describe("normalizePhone — Argentina", () => {
  const e164 = (input: string) => {
    const result = normalizePhone(input);
    return result.ok ? result.e164 : `ERR:${result.code}`;
  };

  it("accepts the canonical +54 9 format with spaces and dashes", () => {
    expect(e164("+54 9 3496 123456")).toBe("+5493496123456");
    expect(e164("+54-9-3496-12-3456")).toBe("+5493496123456");
    expect(e164("+54 9 11 4567-8901")).toBe("+5491145678901");
    expect(e164("(+54) 9 341 1234567")).toBe("+5493411234567");
  });

  it("accepts the same numbers with no plus, with 549/54 prefixes or as a bare national number", () => {
    expect(e164("5493496123456")).toBe("+5493496123456");
    expect(e164("543496123456")).toBe("+5493496123456"); // sin el 9: se agrega
    expect(e164("3496123456")).toBe("+5493496123456");
    expect(e164("93496123456")).toBe("+5493496123456");
    expect(e164("+54 3496 123456")).toBe("+5493496123456");
  });

  it("handles the legacy 0 + area + 15 + number form without guessing", () => {
    expect(e164("0 3496 15 123456")).toBe("+5493496123456");
    expect(e164("03496-15-123456")).toBe("+5493496123456");
    expect(e164("011 15 4567 8901")).toBe("+5491145678901");
    expect(e164("0341 15 1234567")).toBe("+5493411234567");
  });

  it("returns the wa id (digits only) and a readable display", () => {
    const result = normalizePhone("+54 9 3496 123456");
    expect(result).toMatchObject({ ok: true, waId: "5493496123456", display: "+54 9 3496 123456" });
  });

  it("rejects an empty value or a non-string", () => {
    expect(e164("")).toBe("ERR:EMPTY");
    expect(e164("   ")).toBe("ERR:EMPTY");
    expect(normalizePhone(undefined)).toMatchObject({ ok: false, code: "EMPTY" });
    expect(normalizePhone(3496123456)).toMatchObject({ ok: false, code: "EMPTY" });
  });

  it("rejects invalid characters (letters, a misplaced plus)", () => {
    expect(e164("3496-abc-123")).toBe("ERR:INVALID_CHARACTERS");
    expect(e164("3496+123456")).toBe("ERR:INVALID_CHARACTERS");
    expect(e164("wa.me/5493496123456")).toBe("ERR:INVALID_CHARACTERS");
  });

  it("never completes an incomplete number", () => {
    expect(e164("+54 9 3496 1234")).toBe("ERR:TOO_SHORT");
    expect(e164("3496 12345")).toBe("ERR:TOO_SHORT");
    expect(e164("3496 1234")).toBe("ERR:MISSING_AREA_CODE");
    expect(e164("123456")).toBe("ERR:MISSING_AREA_CODE");
    expect(e164("4567-8901")).toBe("ERR:MISSING_AREA_CODE");
    expect(e164("15 4567 8901")).toBe("ERR:MISSING_AREA_CODE");
  });

  it("rejects numbers with extra digits and implausible area codes", () => {
    expect(e164("+54 9 3496 12345678")).toBe("ERR:TOO_LONG");
    expect(e164("0000000000")).toBe("ERR:INVALID_AREA_CODE");
    expect(e164("+54 9 7777 123456")).toBe("ERR:INVALID_AREA_CODE");
  });

  it("does not invent a number when a 12-digit value has no valid area code + 15 split", () => {
    expect(e164("99 15 12345678")).toBe("ERR:INVALID_AREA_CODE");
    expect(e164("3496 12 123456")).toBe("ERR:INVALID_AREA_CODE");
  });
});

describe("normalizePhone — international numbers", () => {
  it("accepts an explicit international number with a valid E.164 length", () => {
    expect(normalizePhone("+595 981 123456")).toMatchObject({ ok: true, e164: "+595981123456", waId: "595981123456" });
    expect(normalizePhone("00 1 415 555 2671")).toMatchObject({ ok: true, e164: "+14155552671" });
  });

  it("rejects too short or too long international numbers", () => {
    expect(normalizePhone("+595 123")).toMatchObject({ ok: false, code: "TOO_SHORT" });
    expect(normalizePhone("+1234567890123456")).toMatchObject({ ok: false, code: "TOO_LONG" });
  });
});

describe("maskPhone", () => {
  it("shows only the country prefix and the last four digits", () => {
    expect(maskPhone("+5493496123456")).toBe("+54*******3456");
  });
});

describe("formatting", () => {
  it("formats money es-AR without decimals unless there are cents", () => {
    expect(formatMoney(1_000_000)).toBe("$10.000");
    expect(formatMoney(1_234_550)).toBe("$12.345,50");
    expect(formatMoney(5)).toBe("$0,05");
    expect(formatMoney(100_000_000)).toBe("$1.000.000");
  });

  it("formats weight in kg with three decimals", () => {
    expect(formatKilograms(1250)).toBe("1,250 kg");
    expect(formatKilograms(350)).toBe("0,350 kg");
    expect(formatKilograms(12_005)).toBe("12,005 kg");
  });
});

describe("evaluateTicketEligibility", () => {
  it("allows a COMPLETED sale", () => {
    expect(evaluateTicketEligibility(source())).toEqual({ ok: true });
  });

  it("blocks PENDING_PAYMENT, CANCELLED, REFUNDED and DRAFT", () => {
    for (const status of ["PENDING_PAYMENT", "CANCELLED", "REFUNDED", "DRAFT"]) {
      expect(evaluateTicketEligibility(source({ status }))).toEqual({ ok: false, code: "SALE_NOT_COMPLETED" });
    }
  });

  it("blocks a Mercado Pago payment the backend has not confirmed, even if the sale looks COMPLETED", () => {
    const pending = source({ payments: [{ method: "TRANSFER", provider: "MERCADOPAGO", verificationStatus: "PENDING", amountCents: 1_650_000 }] });
    expect(evaluateTicketEligibility(pending)).toEqual({ ok: false, code: "PAYMENT_NOT_CONFIRMED" });
    const confirmed = source({ payments: [{ method: "TRANSFER", provider: "MERCADOPAGO", verificationStatus: "CONFIRMED", amountCents: 1_650_000 }] });
    expect(evaluateTicketEligibility(confirmed)).toEqual({ ok: true });
  });

  it("blocks an empty sale and lines that do not add up to the server total", () => {
    expect(evaluateTicketEligibility(source({ items: [], totalCents: 0 }))).toEqual({ ok: false, code: "EMPTY_SALE" });
    expect(evaluateTicketEligibility(source({ totalCents: 1_650_001 }))).toEqual({ ok: false, code: "TOTAL_MISMATCH" });
  });
});

describe("parseTicketSource", () => {
  const raw = () => JSON.parse(JSON.stringify(source())) as Record<string, unknown>;

  it("round-trips a valid server payload", () => {
    expect(parseTicketSource(raw())).toEqual(source());
  });

  it("drops every field outside the allow-list (cost, supplier, margin, stock, employee)", () => {
    const polluted = raw();
    (polluted.items as Record<string, unknown>[])[0] = {
      ...(polluted.items as Record<string, unknown>[])[0],
      costCentsSnapshot: 650_000, supplier: "Frigorífico Sur", marginBps: 5000, stockGrams: 99_000, employee: "Ana"
    };
    polluted.operatorName = "Ana";
    const parsed = JSON.stringify(parseTicketSource(polluted));
    expect(parsed).not.toMatch(/cost|supplier|Frigor|margin|stock|employee|Ana|operator/i);
  });

  it("rejects malformed payloads", () => {
    expect(parseTicketSource(null)).toBeNull();
    expect(parseTicketSource({})).toBeNull();
    const bothQuantities = raw();
    (bothQuantities.items as Record<string, unknown>[])[0] = { ...(bothQuantities.items as Record<string, unknown>[])[0], quantityUnits: 2 };
    expect(parseTicketSource(bothQuantities)).toBeNull();
    const negative = raw();
    negative.totalCents = -1;
    expect(parseTicketSource(negative)).toBeNull();
  });
});

describe("buildTicketModel / renderTicketText", () => {
  it("renders business, branch, short id, date, lines, total and payment", () => {
    const text = renderTicketText(buildTicketModel(source()));
    expect(text).toContain("Carnicerías Fran");
    expect(text).toContain("Sucursal Avenida");
    expect(text).toContain("Ticket #f7000000 - 02/10/2026 14:35");
    expect(text).toContain("TOTAL $16.500");
    expect(text).toContain("Pago: Efectivo");
  });

  it("formats a WEIGHT line in kg with the price per kg and its subtotal", () => {
    const text = renderTicketText(buildTicketModel(source()));
    expect(text).toContain("Vacío 1,250 kg x $10.000/kg = $12.500");
  });

  it("formats a UNIT line in units with the price per unit and its subtotal", () => {
    const text = renderTicketText(buildTicketModel(source()));
    expect(text).toContain("Hamburguesa 4 u. x $1.000 c/u = $4.000");
    expect(text).not.toMatch(/Hamburguesa [^\n]*kg/);
  });

  it("shows promotions and the card surcharge on their lines and in the summary", () => {
    const withAdjustments = source({
      totalCents: 600_000 - 50_000 + 60_000,
      items: [{ name: "Hamburguesa", weightGrams: null, quantityUnits: 6, unitPriceCents: 100_000, promotionDiscountCents: 50_000, cardSurchargeCents: 60_000, subtotalCents: 610_000, promotionMode: "PACK_FIXED_TOTAL", manualPriceApplied: false }],
      payments: [{ method: "CREDIT", provider: null, verificationStatus: "NOT_REQUIRED", amountCents: 610_000 }]
    });
    const model = buildTicketModel(withAdjustments);
    const text = renderTicketText(model);
    expect(text).toContain("Hamburguesa 6 u. x $1.000 c/u = $6.100 (promo -$500, recargo tarjeta +$600)");
    expect(text).toContain("Promociones: -$500");
    expect(text).toContain("Recargo tarjeta: +$600");
    expect(model.totalCents).toBe(610_000);
    expect(text).toContain("TOTAL $6.100");
    expect(text).toContain("Pago: Tarjeta de crédito");
  });

  it("uses the server total, never a recomputed one", () => {
    const model = buildTicketModel(source());
    expect(model.totalCents).toBe(1_650_000);
    expect(model.lines.reduce((total, line) => total + line.subtotalCents, 0)).toBe(model.totalCents);
  });

  it("labels Mercado Pago as such (never as a manual transfer)", () => {
    const mp = source({ payments: [{ method: "TRANSFER", provider: "MERCADOPAGO", verificationStatus: "CONFIRMED", amountCents: 1_650_000 }] });
    expect(buildTicketModel(mp).paymentLabel).toBe("Mercado Pago");
  });

  it("never contains cost, supplier, margin, stock or employee wording", () => {
    const text = renderTicketText(buildTicketModel(source()));
    expect(text).not.toMatch(/costo|proveedor|margen|stock|empleado|cajer/i);
  });
});

describe("template parameters", () => {
  it("produces exactly the template's variables, each on a single clean line", () => {
    const parameters = buildTemplateParameters(buildTicketModel(source()));
    expect(parameters).toHaveLength(TICKET_TEMPLATE_PARAMETER_COUNT);
    expect(parameters[0]).toBe("Carnicerías Fran");
    expect(parameters[1]).toBe("Avenida");
    expect(parameters[2]).toBe("f7000000");
    expect(parameters[3]).toBe("02/10/2026 14:35");
    expect(parameters[4]).toBe("Vacío 1,250 kg x $10.000/kg = $12.500 | Hamburguesa 4 u. x $1.000 c/u = $4.000");
    expect(parameters[5]).toBe("$16.500");
    expect(parameters[6]).toBe("Efectivo");
    for (const parameter of parameters) {
      expect(parameter).not.toMatch(/[\n\r\t]/);
      expect(parameter).not.toMatch(/ {2,}/);
      expect(parameter.length).toBeGreaterThan(0);
    }
  });

  it("flattens newlines, tabs and runs of spaces (Meta error 132018) and never leaves a parameter empty", () => {
    expect(sanitizeTemplateParameter("Av.\nNorte\t  Centro")).toBe("Av. Norte Centro");
    expect(sanitizeTemplateParameter("   ")).toBe("-");
  });

  it("truncates a very long sale to a bounded detail with a 'y N más' tail", () => {
    const items = Array.from({ length: 60 }, (_, index) => ({
      name: `Producto de carnicería número ${String(index + 1)}`, weightGrams: 1000, quantityUnits: null,
      unitPriceCents: 1_000_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 1_000_000, promotionMode: null, manualPriceApplied: false
    }));
    const big = source({ items, totalCents: 60_000_000 });
    const detail = buildTemplateParameters(buildTicketModel(big))[4] ?? "";
    expect(detail.length).toBeLessThanOrEqual(MAX_ITEMS_PARAMETER_LENGTH);
    expect(detail).toMatch(/ \| y \d+ más$/);
    // El total siempre es el real, aunque el detalle se acote.
    expect(buildTemplateParameters(buildTicketModel(big))[5]).toBe("$600.000");
  });
});

// D-061: venta de Central con precio manual y descuento general del ticket.
describe("ticket de una venta con precio manual y descuento general (D-061)", () => {
  // Coca Cola de $12.000 vendida a $10.000 (precio manual) + Fanta de $14.000, 5% general: $24.000 - $1.200 = $22.800.
  const discounted = (over: Partial<TicketSource> = {}): TicketSource => source({
    totalCents: 2_280_000, ticketDiscountBps: 500, ticketDiscountCents: 120_000,
    items: [
      { name: "Coca Cola 2.25 L", weightGrams: null, quantityUnits: 1, unitPriceCents: 1_000_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 1_000_000, promotionMode: null, manualPriceApplied: true },
      { name: "Fanta 2.25 L", weightGrams: null, quantityUnits: 1, unitPriceCents: 1_400_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 1_400_000, promotionMode: null, manualPriceApplied: false }
    ],
    payments: [{ method: "CASH", provider: null, verificationStatus: "NOT_REQUIRED", amountCents: 2_280_000 }],
    ...over
  });

  it("is eligible when the lines minus the ticket discount equal the real total", () => {
    expect(evaluateTicketEligibility(discounted())).toEqual({ ok: true });
  });

  it("is never sent when the discount does not reconcile with the real total", () => {
    expect(evaluateTicketEligibility(discounted({ ticketDiscountCents: 0 }))).toEqual({ ok: false, code: "TOTAL_MISMATCH" });
    expect(evaluateTicketEligibility(discounted({ ticketDiscountCents: 130_000 }))).toEqual({ ok: false, code: "TOTAL_MISMATCH" });
    expect(evaluateTicketEligibility(discounted({ totalCents: 2_400_000 }))).toEqual({ ok: false, code: "TOTAL_MISMATCH" });
  });

  it("parses the discount and the manual flag, and a server that predates them reads as no discount / not manual", () => {
    const raw = JSON.parse(JSON.stringify(discounted())) as Record<string, unknown>;
    expect(parseTicketSource(raw)).toEqual(discounted());
    const legacy = JSON.parse(JSON.stringify(source())) as Record<string, unknown>;
    delete legacy.ticketDiscountBps;
    delete legacy.ticketDiscountCents;
    for (const item of legacy.items as Record<string, unknown>[]) delete item.manualPriceApplied;
    expect(parseTicketSource(legacy)).toEqual(source());
    expect(parseTicketSource({ ...raw, ticketDiscountCents: -1 })).toBeNull();
  });

  it("shows the manual price and the general discount in the readable ticket", () => {
    const text = renderTicketText(buildTicketModel(discounted()));
    expect(text).toContain("Coca Cola 2.25 L 1 u. x $10.000 c/u = $10.000 (precio manual)");
    expect(text).toContain("Descuento general (5%): -$1.200");
    expect(text).toContain("TOTAL $22.800");
    expect(text.indexOf("Descuento general")).toBeLessThan(text.indexOf("TOTAL"));
    expect(text).not.toContain("Fanta 2.25 L 1 u. x $14.000 c/u = $14.000 (");
  });

  it("formats decimal percentages and omits the row when there is no discount", () => {
    expect(renderTicketText(buildTicketModel(discounted({ ticketDiscountBps: 1_250, ticketDiscountCents: 300_000, totalCents: 2_100_000 })))).toContain("Descuento general (12,5%): -$3.000");
    expect(renderTicketText(buildTicketModel(discounted({ ticketDiscountBps: 725, ticketDiscountCents: 174_000, totalCents: 2_226_000 })))).toContain("Descuento general (7,25%): -$1.740");
    expect(renderTicketText(buildTicketModel(source()))).not.toContain("Descuento general");
  });

  it("the template detail parameter carries the discount too", () => {
    const parameters = buildTemplateParameters(buildTicketModel(discounted()));
    expect(parameters[4]).toContain("Descuento general (5%): -$1.200");
    expect(parameters[5]).toBe("$22.800");
  });
});
