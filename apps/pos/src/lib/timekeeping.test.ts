import { describe, expect, it } from "vitest";

import {
  TIMEKEEPING_MAX_AGE_MS,
  clockInRequiredAfterLogin,
  operatorExitMode,
  parseTimekeepingCapability,
  readTimekeepingEnabled,
  shouldRefreshTimekeeping,
  writeTimekeepingEnabled
} from "./timekeeping";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }
  };
}

describe("fichaje por sucursal: lo recordado", () => {
  it("sin dato recordado la sucursal lleva fichaje (comportamiento histórico)", () => {
    expect(readTimekeepingEnabled("central", memoryStorage())).toBe(true);
    expect(readTimekeepingEnabled(null, memoryStorage())).toBe(true);
    expect(readTimekeepingEnabled("central", null)).toBe(true);
  });

  it("Central (fichaje apagado) lo recuerda y las demás sucursales siguen con fichaje", () => {
    const storage = memoryStorage();
    writeTimekeepingEnabled("central", false, storage);
    expect(readTimekeepingEnabled("central", storage)).toBe(false);
    // La memoria es de UNA sucursal: otra caja/sucursal nunca hereda el apagado.
    expect(readTimekeepingEnabled("avenida", storage)).toBe(true);
    writeTimekeepingEnabled("avenida", true, storage);
    expect(readTimekeepingEnabled("avenida", storage)).toBe(true);
  });

  it("un dato corrupto o ilegible nunca apaga el fichaje", () => {
    expect(readTimekeepingEnabled("central", memoryStorage({ "pos.timekeepingEnabled": "{no es json" }))).toBe(true);
    expect(readTimekeepingEnabled("central", memoryStorage({ "pos.timekeepingEnabled": JSON.stringify({ branchId: "central", enabled: "no" }) }))).toBe(true);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readTimekeepingEnabled("central", blocked)).toBe(true);
    expect(() => writeTimekeepingEnabled("central", false, blocked)).not.toThrow();
  });

  it("la capacidad se vuelve a consultar cuando falta o venció, no en cada sync", () => {
    const storage = memoryStorage();
    expect(shouldRefreshTimekeeping("central", storage, 1_000)).toBe(true);
    writeTimekeepingEnabled("central", false, storage, 1_000);
    expect(shouldRefreshTimekeeping("central", storage, 1_000 + TIMEKEEPING_MAX_AGE_MS)).toBe(false);
    expect(shouldRefreshTimekeeping("central", storage, 1_001 + TIMEKEEPING_MAX_AGE_MS)).toBe(true);
    expect(shouldRefreshTimekeeping("avenida", storage, 2_000)).toBe(true);
    expect(shouldRefreshTimekeeping("central", null)).toBe(false);
  });

  it("un servidor anterior a la migración no informa el campo y no cambia nada", () => {
    expect(parseTimekeepingCapability(undefined)).toBeNull();
    expect(parseTimekeepingCapability("false")).toBeNull();
    expect(parseTimekeepingCapability(false)).toBe(false);
    expect(parseTimekeepingCapability(true)).toBe(true);
  });
});

describe("ingreso por PIN", () => {
  it("Central sin fichaje: ingresa y vende de inmediato, haya o no un turno viejo", () => {
    expect(clockInRequiredAfterLogin(false, false)).toBe(false);
    expect(clockInRequiredAfterLogin(false, true)).toBe(false);
  });

  it("sucursales con fichaje: sin turno exige marcar entrada; con turno vigente no", () => {
    expect(clockInRequiredAfterLogin(true, false)).toBe(true);
    expect(clockInRequiredAfterLogin(true, true)).toBe(false);
  });
});

describe("salir / cambiar de empleado / cerrar la ventana", () => {
  it("Central sólo suelta al operador: nunca registra una salida", () => {
    expect(operatorExitMode(false)).toBe("RELEASE_ONLY");
  });

  it("sucursales con fichaje conservan el cierre de turno", () => {
    expect(operatorExitMode(true)).toBe("CLOSE_SHIFT");
  });

  it("recorrido completo con Central apagada: PIN, venta, cambio de empleado y salir sin fichajes", () => {
    const storage = memoryStorage();
    writeTimekeepingEnabled("central", false, storage);
    const enabled = readTimekeepingEnabled("central", storage);
    const events: string[] = [];
    // PIN de empleado A
    if (clockInRequiredAfterLogin(enabled, false)) events.push("CLOCK_IN");
    // Salir (cambio de empleado) y PIN de empleado B
    if (operatorExitMode(enabled) === "CLOSE_SHIFT") events.push("CLOCK_OUT");
    if (clockInRequiredAfterLogin(enabled, false)) events.push("CLOCK_IN");
    // Cierre de la ventana
    if (operatorExitMode(enabled) === "CLOSE_SHIFT") events.push("CLOCK_OUT");
    expect(events).toEqual([]);
  });

  it("el mismo recorrido en otra sucursal conserva entrada y salida", () => {
    const storage = memoryStorage();
    writeTimekeepingEnabled("central", false, storage);
    const enabled = readTimekeepingEnabled("avenida", storage);
    const events: string[] = [];
    if (clockInRequiredAfterLogin(enabled, false)) events.push("CLOCK_IN");
    if (operatorExitMode(enabled) === "CLOSE_SHIFT") events.push("CLOCK_OUT");
    expect(events).toEqual(["CLOCK_IN", "CLOCK_OUT"]);
  });
});
