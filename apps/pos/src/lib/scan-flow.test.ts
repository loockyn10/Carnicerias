import { describe, expect, it, vi } from "vitest";

import { buildBarcodeIndex } from "./catalog";
import { concludeVacuumLookup, decideScan, offlineVacuumBlock, type ScanContext, type VacuumCodeStatus } from "./scan-flow";
import { emptyScanBuffer, feedScanKey } from "./scanner";
import { buildVacuumPackageLine } from "./ticket-pricing";
import type { LocalVacuumStateLike } from "./vacuum-scan";

const SCHEME = { scheme: "PRICE_EMBEDDED", prefix: "20", pluDigits: 4, valueDigits: 6, valueStep: 100 } as const;
const EAN = "2000120112506"; // Vacío, PLU 12, 0,750 kg, $11.250
const money = (cents: bigint) => `$${(Number(cents) / 100).toFixed(0)}`;

interface TestProduct { productId: string; unitType: "WEIGHT" | "UNIT"; barcodes: string[] }
const coke: TestProduct = { productId: "coke", unitType: "UNIT", barcodes: ["7790895000010"] };

function pkg(id: string, overrides: Partial<LocalVacuumStateLike["packages"][number]> = {}): LocalVacuumStateLike["packages"][number] {
  return { packageId: id, productId: "vacio", productName: "Vacío", ean13: EAN, weightGrams: 750, chargeCents: "1125000", lot: `L-${id}`, packedOn: "2026-11-01", expiresOn: "2026-11-15", ...overrides };
}
function state(packages: LocalVacuumStateLike["packages"], overrides: Partial<LocalVacuumStateLike> = {}): LocalVacuumStateLike {
  return { appliedAt: "2026-11-12T10:00:00Z", scheme: SCHEME, plus: [{ productId: "vacio", plu: "12" }], packages, ...overrides };
}
function context(vacuumState: LocalVacuumStateLike | null, overrides: Partial<ScanContext<TestProduct>> = {}): ScanContext<TestProduct> {
  return { barcodeIndex: buildBarcodeIndex([coke]), stock: null, vacuumSupported: true, vacuumState, packageIdsInTicket: new Set(), ...overrides };
}
/** El lector tipea el código en ráfaga y termina con Enter: lo que `routeKey` entrega al manejador de escaneo. */
function scannedWithEnter(code: string): string | null {
  let buffer = emptyScanBuffer();
  let now = 1_000;
  for (const key of code) { buffer = feedScanKey(buffer, key, now).buffer; now += 5; }
  return feedScanKey(buffer, "Enter", now + 5).scan;
}

describe("flujo de escaneo: del lector al carrito", () => {
  it("un EAN válido de Envasados llega al carrito con el peso real y el importe del código, sin alta rápida", () => {
    const decision = decideScan(context(state([pkg("a")])), EAN);
    expect(decision.kind).toBe("VACUUM_PACKAGE");
    if (decision.kind !== "VACUUM_PACKAGE") return;
    const line = buildVacuumPackageLine(decision.package, "line-1", "CASH", 0n);
    expect(line.weightGrams).toBe(750);
    expect(line.subtotalCents).toBe(1_125_000n);
    expect(line.vacuumPackageId).toBe("a");
  });

  it("con el sufijo Enter del lector el código completo se resuelve igual", () => {
    const code = scannedWithEnter(EAN);
    expect(code).toBe(EAN);
    expect(decideScan(context(state([pkg("a")])), code ?? "").kind).toBe("VACUUM_PACKAGE");
  });

  it("los productos tradicionales y sus códigos siguen su camino de siempre", () => {
    expect(decideScan(context(state([pkg("a")])), "7790895000010")).toMatchObject({ kind: "CATALOG", outcome: { kind: "ADD_UNIT" } });
    expect(decideScan(context(state([pkg("a")])), "7791234567895")).toEqual({ kind: "UNKNOWN_CODE", code: "7791234567895" });
    expect(decideScan(context(state([pkg("a")])), "ABC-123")).toEqual({ kind: "UNKNOWN_CODE", code: "ABC-123" });
  });

  it("un paquete registrado antes de instalar esta versión se reconoce si ya está en el estado sincronizado", () => {
    const old = pkg("viejo", { packedOn: "2026-10-01", expiresOn: "2026-10-15" });
    expect(decideScan(context(state([old])), EAN)).toMatchObject({ kind: "VACUUM_PACKAGE", package: { packageId: "viejo" } });
  });

  it("un paquete todavía no sincronizado: primero avisa que hay que consultar, nunca abre el alta rápida; sincroniza y entra al carrito", async () => {
    const before = decideScan(context(state([])), EAN);
    expect(before.kind).toBe("VACUUM_LOOKUP");
    if (before.kind !== "VACUUM_LOOKUP") return;
    const refresh = vi.fn(() => Promise.resolve(state([pkg("nuevo")])));
    const codeStatus = vi.fn(() => Promise.resolve<VacuumCodeStatus | null>(null));
    const after = await concludeVacuumLookup<TestProduct>(before.pending, { refresh, codeStatus, packageIdsInTicket: () => new Set(), today: "2026-11-12", formatAmount: money });
    expect(after).toMatchObject({ kind: "VACUUM_PACKAGE", package: { packageId: "nuevo" } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(codeStatus).not.toHaveBeenCalled();
  });

  it("una caja que nunca sincronizó Envasados no da de alta un código de 13 dígitos: pide sincronizar", async () => {
    const before = decideScan(context(null), EAN);
    expect(before).toMatchObject({ kind: "VACUUM_LOOKUP", pending: { kind: "STATE_MISSING" } });
    if (before.kind !== "VACUUM_LOOKUP") return;
    expect(offlineVacuumBlock(before.pending, money)).toMatchObject({ kind: "VACUUM_BLOCKED", reason: "NOT_SYNCED" });
    const failing = await concludeVacuumLookup<TestProduct>(before.pending, {
      refresh: () => Promise.reject(new Error("sin red")), codeStatus: () => Promise.resolve(null), packageIdsInTicket: () => new Set(), today: "2026-11-12", formatAmount: money
    });
    expect(failing).toMatchObject({ kind: "VACUUM_BLOCKED", reason: "NOT_SYNCED" });
    // Con la caja sin Envasados un código que NO tiene 13 dígitos no se confunde con un paquete.
    expect(decideScan(context(null), "ABC-123")).toEqual({ kind: "UNKNOWN_CODE", code: "ABC-123" });
  });

  it("sin conexión, con los paquetes ya sincronizados, se vende normalmente", () => {
    expect(decideScan(context(state([pkg("a"), pkg("b", { packedOn: "2026-11-02" })])), EAN)).toMatchObject({ kind: "VACUUM_PACKAGE", package: { packageId: "a" } });
  });

  it.each([
    ["SOLD", "SOLD"], ["RESERVED", "RESERVED"], ["DISPATCHED", "DISPATCHED"], ["VOIDED", "VOIDED"]
  ])("un paquete %s en el servidor muestra un mensaje específico y no abre el alta", async (status, reason) => {
    const before = decideScan(context(state([])), EAN);
    if (before.kind !== "VACUUM_LOOKUP") throw new Error("se esperaba una consulta");
    const decision = await concludeVacuumLookup<TestProduct>(before.pending, {
      refresh: () => Promise.resolve(state([])), codeStatus: () => Promise.resolve({ status }), packageIdsInTicket: () => new Set(), today: "2026-11-12", formatAmount: money
    });
    expect(decision).toMatchObject({ kind: "VACUUM_BLOCKED", reason });
  });

  it("un paquete de otra sucursal, un PLU desconocido y un código sin registrar se explican", async () => {
    const run = async (vacuum: LocalVacuumStateLike, status: VacuumCodeStatus) => {
      const before = decideScan(context(vacuum), EAN);
      if (before.kind !== "VACUUM_LOOKUP") throw new Error("se esperaba una consulta");
      return concludeVacuumLookup<TestProduct>(before.pending, { refresh: () => Promise.resolve(vacuum), codeStatus: () => Promise.resolve(status), packageIdsInTicket: () => new Set(), today: "2026-11-12", formatAmount: money });
    };
    expect(await run(state([]), { status: "AVAILABLE", here: false, branchName: "Central" })).toMatchObject({ reason: "OTHER_BRANCH", message: "Ese paquete envasado está en otra sucursal (Central)." });
    expect(await run(state([], { plus: [] }), { status: "UNKNOWN" })).toMatchObject({ reason: "UNKNOWN_PLU" });
    expect(await run(state([]), { status: "UNKNOWN" })).toMatchObject({ reason: "UNKNOWN_PACKAGE" });
  });

  it("dígito verificador incorrecto e importe cero se bloquean sin consultar ni dar de alta", () => {
    expect(decideScan(context(state([pkg("a")])), "2000120112507")).toMatchObject({ kind: "VACUUM_BLOCKED", reason: "INVALID_CHECK_DIGIT" });
    expect(decideScan(context(state([])), "2000120000001")).toMatchObject({ kind: "VACUUM_BLOCKED", reason: "INVALID_AMOUNT" });
  });

  it("todos los paquetes con ese código ya están en el ticket", () => {
    expect(decideScan(context(state([pkg("a")]), { packageIdsInTicket: new Set(["a"]) }), EAN)).toMatchObject({ kind: "VACUUM_BLOCKED", reason: "ALL_IN_TICKET" });
  });

  it("dos paquetes del mismo código con pesos distintos piden elegir", () => {
    expect(decideScan(context(state([pkg("a"), pkg("b", { weightGrams: 760 })])), EAN).kind).toBe("VACUUM_CHOOSE");
  });

  it("el POS web (sin escritorio) no cambia: un código desconocido sigue siendo desconocido", () => {
    expect(decideScan(context(null, { vacuumSupported: false }), EAN)).toEqual({ kind: "UNKNOWN_CODE", code: EAN });
  });

  it("el esquema es el sincronizado, no una constante: con otro prefijo ese mismo código ya no es de Envasados", () => {
    const other = state([pkg("a")], { scheme: { ...SCHEME, prefix: "29" } });
    expect(decideScan(context(other), EAN)).toEqual({ kind: "UNKNOWN_CODE", code: EAN });
  });
});
