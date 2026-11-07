import { describe, expect, it } from "vitest";

import { buildVacuumPackageLine, isVacuumPackageLine, repriceTicketLine } from "./ticket-pricing";
import { compareFifo, describeVacuumCandidate, resolveVacuumScan, vacuumSchemeOf, type LocalVacuumStateLike } from "./vacuum-scan";

const SCHEME = { scheme: "PRICE_EMBEDDED", prefix: "20", pluDigits: 4, valueDigits: 6, valueStep: 100 } as const;
const EAN = "2000120112506"; // Vacío, PLU 0012, $11.250

function pkg(id: string, overrides: Partial<LocalVacuumStateLike["packages"][number]> = {}): LocalVacuumStateLike["packages"][number] {
  return { packageId: id, productId: "vacio", productName: "Vacío", ean13: EAN, weightGrams: 750, chargeCents: "1125000", lot: `L-${id}`, packedOn: "2026-11-01", expiresOn: "2026-11-08", ...overrides };
}
function stateOf(packages: LocalVacuumStateLike["packages"], overrides: Partial<LocalVacuumStateLike> = {}): LocalVacuumStateLike {
  return { scheme: SCHEME, plus: [{ productId: "vacio", plu: "12" }], packages, ...overrides };
}

describe("escaneo de Envasados: reconocimiento", () => {
  it("un código del esquema con un paquete disponible devuelve ese paquete con su importe final", () => {
    const outcome = resolveVacuumScan(stateOf([pkg("a")]), EAN);
    expect(outcome.kind).toBe("PACKAGE");
    if (outcome.kind === "PACKAGE") {
      expect(outcome.package.packageId).toBe("a");
      expect(outcome.package.chargeCents).toBe(1_125_000n);
      expect(outcome.package.weightGrams).toBe(750);
    }
  });

  it("los códigos de barras tradicionales no son de Envasados", () => {
    const state = stateOf([pkg("a")]);
    expect(resolveVacuumScan(state, "7790895000010").kind).toBe("NOT_VACUUM");
    expect(resolveVacuumScan(state, "4006381333931").kind).toBe("NOT_VACUUM");
    expect(resolveVacuumScan(state, "ABC-123").kind).toBe("NOT_VACUUM");
    expect(resolveVacuumScan(state, "").kind).toBe("NOT_VACUUM");
  });

  it("un dígito verificador incorrecto no se trata como Envasados", () => {
    expect(resolveVacuumScan(stateOf([pkg("a")]), "2000120112507").kind).toBe("NOT_VACUUM");
  });

  it("sin esquema configurado o sin estado nada es de Envasados", () => {
    expect(resolveVacuumScan(stateOf([pkg("a")], { scheme: null }), EAN).kind).toBe("NOT_VACUUM");
    expect(resolveVacuumScan(null, EAN).kind).toBe("NOT_VACUUM");
  });

  it("el esquema viene del servidor (configurable): otro prefijo lee otro código", () => {
    const other = stateOf([pkg("a")], { scheme: { scheme: "PRICE_EMBEDDED", prefix: "29", pluDigits: 4, valueDigits: 6, valueStep: 100 } });
    expect(resolveVacuumScan(other, EAN).kind).toBe("NOT_VACUUM");
    expect(vacuumSchemeOf(other)?.prefix).toBe("29");
  });

  it("un código reservado sin paquete disponible NO se pierde en el alta rápida: avisa que no hay paquete", () => {
    const outcome = resolveVacuumScan(stateOf([]), EAN);
    expect(outcome).toMatchObject({ kind: "NO_PACKAGE", productId: "vacio", amountCents: 1_125_000n, alreadyInTicket: false });
  });

  it("un código reservado con un PLU desconocido tampoco crea un producto", () => {
    expect(resolveVacuumScan(stateOf([], { plus: [] }), EAN)).toMatchObject({ kind: "UNKNOWN_PLU", plu: "0012" });
  });

  it("el PLU se compara por su valor numérico (0012 = 12)", () => {
    expect(resolveVacuumScan(stateOf([], { plus: [{ productId: "vacio", plu: "0012" }] }), EAN)).toMatchObject({ kind: "NO_PACKAGE", productId: "vacio" });
  });
});

describe("escaneo de Envasados: códigos repetidos", () => {
  it("Caso A: mismo código y mismo peso → el paquete disponible más antiguo (FIFO)", () => {
    const outcome = resolveVacuumScan(stateOf([
      pkg("nuevo", { packedOn: "2026-11-03" }), pkg("viejo", { packedOn: "2026-11-01" }), pkg("medio", { packedOn: "2026-11-02" })
    ]), EAN);
    expect(outcome.kind).toBe("PACKAGE");
    if (outcome.kind === "PACKAGE") { expect(outcome.package.packageId).toBe("viejo"); expect(outcome.sameCodeCount).toBe(3); }
  });

  it("el empate de fecha se resuelve por lote y id, siempre igual", () => {
    expect([pkg("b", { lot: "L2" }), pkg("a", { lot: "L1" })].sort(compareFifo).map((row) => row.packageId)).toEqual(["a", "b"]);
  });

  it("Caso B: mismo código con pesos distintos → el cajero elige, con peso, lote y fecha", () => {
    const outcome = resolveVacuumScan(stateOf([
      pkg("a", { weightGrams: 750, packedOn: "2026-11-02" }), pkg("b", { weightGrams: 748, packedOn: "2026-11-01" }), pkg("c", { weightGrams: 750, packedOn: "2026-11-03" })
    ]), EAN);
    expect(outcome.kind).toBe("CHOOSE");
    if (outcome.kind === "CHOOSE") {
      expect(outcome.candidates.map((candidate) => candidate.packageId)).toEqual(["b", "a", "c"]);
      expect(describeVacuumCandidate(outcome.candidates[0] as never)).toEqual({ weight: "0,748 kg", lot: "L-b", packedOn: "01/11/2026" });
    }
  });

  it("un paquete que ya está en el ticket no se ofrece otra vez: se toma el siguiente o se avisa", () => {
    const state = stateOf([pkg("a", { packedOn: "2026-11-01" }), pkg("b", { packedOn: "2026-11-02" })]);
    const second = resolveVacuumScan(state, EAN, new Set(["a"]));
    expect(second.kind === "PACKAGE" && second.package.packageId).toBe("b");
    const none = resolveVacuumScan(state, EAN, new Set(["a", "b"]));
    expect(none).toMatchObject({ kind: "NO_PACKAGE", alreadyInTicket: true });
  });
});

describe("línea PACKAGE en el ticket", () => {
  const candidate = { packageId: "a", productId: "vacio", productName: "Vacío", ean13: EAN, weightGrams: 750, chargeCents: 1_125_000n, lot: "L-a" };
  const context = (paymentMethod: "CASH" | "DEBIT") => ({ paymentMethod, discounts: [], cashDiscountBps: 1000n, branchId: "branch" });

  it("se cobra el importe del paquete, no precio/kg × peso", () => {
    const line = buildVacuumPackageLine(candidate, "line-1", "CASH", 1000n);
    expect(isVacuumPackageLine(line)).toBe(true);
    expect(line.subtotalCents).toBe(1_125_000n);
    expect(line.weightGrams).toBe(750);
    expect(line.vacuumPackageTotalCents).toBe(1_125_000n);
    expect(line.vacuumEan13).toBe(EAN);
    expect(line.promotionMode).toBeNull();
    expect(line.discountCents).toBe(0n);
  });

  it("al elegir tarjeta suma el recargo sobre el importe fijo y al volver a efectivo lo quita", () => {
    const cash = buildVacuumPackageLine(candidate, "line-1", "CASH", 1000n);
    const card = repriceTicketLine(cash, context("DEBIT"));
    expect(card.subtotalCents).toBe(1_237_500n);
    expect(card.cardSurchargeCents).toBe(112_500n);
    expect(card.vacuumPackageTotalCents).toBe(1_125_000n);
    const back = repriceTicketLine(card, context("CASH"));
    expect(back.subtotalCents).toBe(1_125_000n);
    expect(back.cardSurchargeCents).toBe(0n);
  });

  it("repreciar nunca recalcula con el precio/kg de la línea", () => {
    const line = { ...buildVacuumPackageLine(candidate, "line-1", "CASH", 0n), pricePerKgCents: 1n, originalPricePerKgCents: 1n };
    expect(repriceTicketLine(line, context("CASH")).subtotalCents).toBe(1_125_000n);
  });
});
