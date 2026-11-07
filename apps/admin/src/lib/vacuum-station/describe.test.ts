import { describe, expect, it } from "vitest";

import { describeStation } from "./describe";
import { initialStationState, type StationState } from "./machine";

const state = (overrides: Partial<StationState>): StationState => ({ ...initialStationState(), ...overrides });
const ctx = { productName: "Vacío de cerdo", readinessProblem: null };

describe("qué muestra la estación", () => {
  it("esperando paquete con el corte listo", () => {
    expect(describeStation(state({ status: "WAITING_PACKAGE", pauseReason: null, needsZero: false }), ctx)).toMatchObject({ title: "Esperando paquete", tone: "ok", detail: "Corte: Vacío de cerdo" });
  });

  it("sin corte elegido pide elegirlo", () => {
    expect(describeStation(state({ status: "WAITING_PACKAGE", pauseReason: null }), { productName: null, readinessProblem: null }).title).toBe("Elegí el corte");
  });

  it("con el corte sin precio muestra el motivo", () => {
    const view = describeStation(state({ status: "WAITING_PACKAGE", pauseReason: null }), { productName: "X", readinessProblem: "El corte no tiene un precio vigente en esta sucursal" });
    expect(view).toMatchObject({ tone: "warn", detail: "El corte no tiene un precio vigente en esta sucursal" });
  });

  it("distingue peso inestable de estabilizando", () => {
    expect(describeStation(state({ status: "STABILIZING", pauseReason: null, moving: true }), ctx).title).toBe("Peso inestable");
    expect(describeStation(state({ status: "STABILIZING", pauseReason: null, moving: false }), ctx).title).toBe("Estabilizando");
  });

  it("registrando e imprimiendo", () => {
    expect(describeStation(state({ status: "REGISTERING", pauseReason: null }), ctx).title).toBe("Registrando…");
    expect(describeStation(state({ status: "PRINTING", pauseReason: null }), ctx).title).toBe("Imprimiendo etiquetas…");
  });

  it("esperando retiro con el motivo", () => {
    expect(describeStation(state({ status: "WAITING_REMOVAL", pauseReason: null, removalReason: "PROCESSED" }), ctx)).toMatchObject({ title: "Retirar paquete", tone: "wait" });
    expect(describeStation(state({ status: "WAITING_REMOVAL", pauseReason: null, removalReason: "PRODUCT_CHANGED" }), ctx).detail).toContain("corte nuevo");
  });

  it("balanza desconectada: no ofrece botones (se reanuda sola al volver)", () => {
    expect(describeStation(initialStationState(), ctx)).toMatchObject({ title: "Balanza desconectada", tone: "error", actions: [] });
  });

  it("pausa manual ofrece reanudar", () => {
    expect(describeStation(state({ status: "PAUSED", pauseReason: "MANUAL" }), ctx).actions).toEqual(["RESUME"]);
  });

  it("registro fallido ofrece reintentar y muestra el error", () => {
    expect(describeStation(state({ status: "PAUSED", pauseReason: "REGISTER_FAILED", error: "sin precio" }), ctx)).toMatchObject({ actions: ["RETRY"], detail: "sin precio" });
  });

  it("impresión fallida: aclara que el paquete quedó registrado y ofrece reintentar o seguir sin imprimir", () => {
    const view = describeStation(state({ status: "PAUSED", pauseReason: "PRINT_FAILED", error: "sin papel" }), ctx);
    expect(view.actions).toEqual(["RETRY", "SKIP_PRINT"]);
    expect(view.detail).toContain("SÍ quedó registrado");
  });

  it("sin conexión se puede reanudar a mano o esperar", () => {
    expect(describeStation(state({ status: "PAUSED", pauseReason: "OFFLINE" }), ctx)).toMatchObject({ title: "Sin conexión con el servidor", actions: ["RESUME"] });
  });
});
