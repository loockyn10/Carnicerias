import { describe, expect, it } from "vitest";

import { bindScale, StationController, type PrintResult, type RegisterInput, type RegisterResult, type StationDeps } from "./controller";
import { DEFAULT_STATION_TUNING } from "./machine";
import { SimulatedScale } from "./simulator";

interface FakePackage { id: string; grams: number; productId: string }

/** «Servidor» de mentira con la misma semántica de idempotencia que `create_vacuum_package`: la misma clave devuelve el MISMO paquete. */
class FakeServer {
  readonly byKey = new Map<string, FakePackage>();
  calls: RegisterInput[] = [];
  /** Respuestas programadas para los próximos intentos (se consumen en orden). */
  script: (("ok" | "network" | "reject"))[] = [];
  rejectMessage = "El corte no tiene un precio vigente";

  register = (input: RegisterInput): Promise<RegisterResult<FakePackage>> => {
    this.calls.push(input);
    const next = this.script.shift() ?? "ok";
    if (next === "network") return Promise.reject(new Error("Failed to fetch"));
    if (next === "reject") return Promise.resolve({ ok: false, error: this.rejectMessage, transient: false });
    const existing = this.byKey.get(input.requestKey);
    if (existing) return Promise.resolve({ ok: true, packageId: existing.id, payload: existing });
    const created = { id: `pkg-${String(this.byKey.size + 1)}`, grams: input.grams, productId: input.productId };
    this.byKey.set(input.requestKey, created);
    return Promise.resolve({ ok: true, packageId: created.id, payload: created });
  };
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function setup(options: { autoPrint?: boolean } = {}) {
  const clock = { t: 0 };
  const server = new FakeServer();
  const printed: string[] = [];
  let printResults: PrintResult[] = [];
  let printThrows = false;
  let keys = 0;
  const deps: StationDeps<FakePackage> = {
    now: () => clock.t,
    newKey: () => { keys += 1; return `key-${String(keys)}`; },
    register: server.register,
    print: (packageId) => {
      printed.push(packageId);
      if (printThrows) return Promise.reject(new Error("USB printer offline"));
      return Promise.resolve(printResults.shift() ?? { ok: true });
    },
    sleep: () => Promise.resolve()
  };
  const controller = new StationController<FakePackage>(deps, { tuning: DEFAULT_STATION_TUNING, autoPrint: options.autoPrint ?? true }, { tickMs: 0, networkRetries: 2, retryDelayMs: 1 });
  const scale = new SimulatedScale({ now: () => clock.t });
  const unbind = bindScale(scale, controller);

  /** Avanza el reloj en pasos de 500 ms (la cadencia real de la balanza), mandando una lectura y un tick por paso. */
  async function run(grams: number, ms: number, stable: boolean | null = null) {
    for (let elapsed = 0; elapsed < ms; elapsed += 500) {
      clock.t += 500;
      scale.sendReading(grams, stable);
      controller.dispatch({ type: "TICK" });
      await flush();
    }
  }
  async function placePackage(grams: number, restMs = 2_000) {
    await run(450, 500);
    await run(780, 500);
    await run(grams, restMs);
  }
  async function start() {
    controller.dispatch({ type: "READY", ready: true });
    controller.dispatch({ type: "PRODUCT_SELECTED", productId: "vacio-cerdo" });
    scale.connect();
    await run(0, 1_000);
  }
  return {
    clock, server, printed, controller, scale, run, placePackage, start, unbind,
    setPrintResults: (results: PrintResult[]) => { printResults = results; },
    setPrintThrows: (value: boolean) => { printThrows = value; },
    status: () => controller.getSnapshot().state.status
  };
}

describe("estación con balanza simulada: registro e impresión automáticos", () => {
  it("coloca → estabiliza → registra → imprime → retira → siguiente, sin intervención", async () => {
    const t = setup();
    await t.start();
    expect(t.status()).toBe("WAITING_PACKAGE");

    await t.placePackage(825);
    expect(t.server.calls).toHaveLength(1);
    expect(t.server.calls[0]).toMatchObject({ productId: "vacio-cerdo", grams: 825, attempt: 1 });
    expect(t.printed).toEqual(["pkg-1"]);
    expect(t.status()).toBe("WAITING_REMOVAL");
    expect(t.controller.getSnapshot().lastPackage).toMatchObject({ id: "pkg-1", payload: { grams: 825 } });

    await t.run(0, 1_000);
    expect(t.status()).toBe("WAITING_PACKAGE");
    await t.placePackage(640);
    expect(t.server.calls).toHaveLength(2);
    expect(t.server.calls[1]?.requestKey).not.toBe(t.server.calls[0]?.requestKey);
    expect(t.printed).toEqual(["pkg-1", "pkg-2"]);
  });

  it("un paquete apoyado 10 minutos con la lectura vibrando dentro de la tolerancia genera UN solo registro y UNA impresión", async () => {
    const t = setup();
    await t.start();
    await t.placePackage(825);
    for (let minute = 0; minute < 10; minute += 1) {
      await t.run(826, 30_000);
      await t.run(823, 30_000);
    }
    expect(t.server.calls).toHaveLength(1);
    expect(t.printed).toHaveLength(1);
  });

  it("cambio de producto con peso encima: el paquete actual no se registra con el producto nuevo", async () => {
    const t = setup();
    await t.start();
    await t.run(450, 500);
    await t.run(700, 500);
    t.controller.dispatch({ type: "PRODUCT_SELECTED", productId: "churrasco" });
    await t.run(700, 5_000);
    expect(t.server.calls).toHaveLength(0);
    await t.run(0, 1_000);
    await t.placePackage(700);
    expect(t.server.calls).toMatchObject([{ productId: "churrasco", grams: 700 }]);
  });

  it("sin impresión automática registra pero no imprime", async () => {
    const t = setup({ autoPrint: false });
    await t.start();
    await t.placePackage(825);
    expect(t.server.calls).toHaveLength(1);
    expect(t.printed).toHaveLength(0);
    expect(t.controller.getSnapshot().lastPrinted).toBe(false);
  });
});

describe("errores de conexión y reintentos", () => {
  it("un fallo de red se reintenta solo con la MISMA clave y no duplica el paquete ni la impresión", async () => {
    const t = setup();
    t.server.script = ["network", "network", "ok"];
    await t.start();
    await t.placePackage(825);
    expect(t.server.calls.map((call) => call.requestKey)).toEqual(["key-1", "key-1", "key-1"]);
    expect(t.server.byKey.size).toBe(1);
    expect(t.printed).toEqual(["pkg-1"]);
    expect(t.status()).toBe("WAITING_REMOVAL");
  });

  it("si la red no vuelve pausa SIN imprimir etiquetas de un paquete que no quedó registrado", async () => {
    const t = setup();
    t.server.script = ["network", "network", "network"];
    await t.start();
    await t.placePackage(825);
    expect(t.status()).toBe("PAUSED");
    expect(t.controller.getSnapshot().state.pauseReason).toBe("REGISTER_FAILED");
    expect(t.printed).toHaveLength(0);
    expect(t.controller.getSnapshot().lastPackage).toBeNull();
  });

  it("al reanudar con el mismo paquete apoyado reintenta con la misma clave: un solo paquete en el servidor", async () => {
    const t = setup();
    t.server.script = ["network", "network", "network", "ok"];
    await t.start();
    await t.placePackage(825);
    expect(t.status()).toBe("PAUSED");
    t.controller.dispatch({ type: "RETRY" });
    await flush();
    expect(t.server.byKey.size).toBe(1);
    expect(new Set(t.server.calls.map((call) => call.requestKey))).toEqual(new Set(["key-1"]));
    expect(t.printed).toEqual(["pkg-1"]);
  });

  it("un error que contesta el servidor no se reintenta a ciegas: pausa y muestra el motivo", async () => {
    const t = setup();
    t.server.script = ["reject"];
    await t.start();
    await t.placePackage(825);
    expect(t.server.calls).toHaveLength(1);
    expect(t.controller.getSnapshot().state).toMatchObject({ status: "PAUSED", pauseReason: "REGISTER_FAILED", error: "El corte no tiene un precio vigente" });
    expect(t.printed).toHaveLength(0);
  });

  it("sin Internet pausa y no registra; al volver reanuda y registra una sola vez", async () => {
    const t = setup();
    await t.start();
    t.controller.dispatch({ type: "ONLINE", online: false });
    await t.placePackage(825);
    expect(t.server.calls).toHaveLength(0);
    expect(t.controller.getSnapshot().state.pauseReason).toBe("OFFLINE");
    t.controller.dispatch({ type: "ONLINE", online: true });
    await t.run(825, 2_000);
    expect(t.server.calls).toHaveLength(1);
    expect(t.printed).toHaveLength(1);
  });

  it("la caída de Internet en pleno registro se resuelve al volver con la misma clave (resultado incierto reconciliado)", async () => {
    const t = setup();
    t.server.script = ["network"];
    await t.start();
    await t.run(450, 500);
    await t.run(780, 500);
    t.controller.dispatch({ type: "ONLINE", online: false });
    await t.run(825, 2_000);
    t.controller.dispatch({ type: "ONLINE", online: true });
    await t.run(825, 1_000);
    expect(t.server.byKey.size).toBeLessThanOrEqual(1);
    expect(new Set(t.server.calls.map((call) => call.requestKey)).size).toBeLessThanOrEqual(1);
    expect(t.printed.length).toBeLessThanOrEqual(1);
  });
});

describe("fallos de impresión y reimpresión", () => {
  it("si la impresión falla el paquete queda registrado, se pausa y no se genera otro", async () => {
    const t = setup();
    t.setPrintResults([{ ok: false, error: "La impresora no responde" }]);
    await t.start();
    await t.placePackage(825);
    expect(t.controller.getSnapshot().state).toMatchObject({ status: "PAUSED", pauseReason: "PRINT_FAILED", error: "La impresora no responde" });
    await t.run(0, 1_000);
    await t.placePackage(640, 3_000);
    expect(t.server.calls).toHaveLength(1);
    expect(t.status()).toBe("PAUSED");
  });

  it("reimprimir las mismas etiquetas resuelve la pausa sin registrar otro paquete", async () => {
    const t = setup();
    t.setPrintResults([{ ok: false, error: "sin papel" }]);
    await t.start();
    await t.placePackage(825);
    const result = await t.controller.reprintLast();
    expect(result).toEqual({ ok: true });
    expect(t.printed).toEqual(["pkg-1", "pkg-1"]);
    expect(t.server.calls).toHaveLength(1);
    expect(t.controller.getSnapshot().state.status).not.toBe("PAUSED");
    expect(t.controller.getSnapshot().lastPrinted).toBe(true);
  });

  it("«reintentar» tras un fallo de impresión reimprime el mismo paquete", async () => {
    const t = setup();
    t.setPrintResults([{ ok: false, error: "sin papel" }]);
    await t.start();
    await t.placePackage(825);
    t.controller.dispatch({ type: "RETRY" });
    await flush();
    expect(t.printed).toEqual(["pkg-1", "pkg-1"]);
    expect(t.server.calls).toHaveLength(1);
    expect(t.status()).toBe("WAITING_REMOVAL");
  });

  it("reimprimir el último paquete en cualquier momento no registra ni cambia el estado", async () => {
    const t = setup();
    await t.start();
    await t.placePackage(825);
    const before = t.controller.getSnapshot().state;
    await t.controller.reprintLast();
    expect(t.server.calls).toHaveLength(1);
    expect(t.controller.getSnapshot().state.status).toBe(before.status);
    expect(t.printed).toEqual(["pkg-1", "pkg-1"]);
  });

  it("sin paquete previo no hay nada que reimprimir", async () => {
    const t = setup();
    expect(await t.controller.reprintLast()).toEqual({ ok: false, error: "Todavía no hay un paquete para reimprimir" });
  });

  it("una impresora que lanza una excepción cuenta como fallo, no rompe la estación", async () => {
    const t = setup();
    t.setPrintThrows(true);
    await t.start();
    await t.placePackage(825);
    expect(t.controller.getSnapshot().state).toMatchObject({ status: "PAUSED", pauseReason: "PRINT_FAILED", error: "USB printer offline" });
    expect(t.server.calls).toHaveLength(1);
  });
});

describe("desconexión de la balanza simulada", () => {
  it("se corta el cable a mitad de estabilizar: pausa, y al volver no registra hasta ver el cero", async () => {
    const t = setup();
    await t.start();
    await t.run(450, 500);
    t.scale.dropConnection();
    await flush();
    expect(t.controller.getSnapshot().state).toMatchObject({ status: "PAUSED", pauseReason: "SCALE_DISCONNECTED" });
    t.scale.connect();
    await t.run(700, 5_000);
    expect(t.server.calls).toHaveLength(0);
    await t.run(0, 1_000);
    await t.placePackage(700);
    expect(t.server.calls).toHaveLength(1);
  });

  it("desconectar y reconectar con el paquete ya procesado apoyado no genera un segundo registro", async () => {
    const t = setup();
    await t.start();
    await t.placePackage(825);
    t.scale.dropConnection();
    t.scale.connect();
    await t.run(825, 20_000);
    expect(t.server.calls).toHaveLength(1);
    expect(t.printed).toHaveLength(1);
  });

  it("con la señal de estabilidad de la balanza: inestable no registra, estable sí", async () => {
    const t = setup();
    await t.start();
    await t.run(700, 5_000, false);
    expect(t.server.calls).toHaveLength(0);
    await t.run(700, 2_000, true);
    expect(t.server.calls).toHaveLength(1);
  });
});

describe("pausa y reanudación", () => {
  it("pausar detiene el registro automático y reanudar lo retoma", async () => {
    const t = setup();
    await t.start();
    t.controller.dispatch({ type: "PAUSE" });
    await t.placePackage(825, 3_000);
    expect(t.server.calls).toHaveLength(0);
    await t.run(0, 1_000);
    t.controller.dispatch({ type: "RESUME" });
    expect(t.status()).toBe("WAITING_PACKAGE");
    await t.placePackage(640);
    expect(t.server.calls).toHaveLength(1);
  });

  it("después de dispose() ya no reacciona", async () => {
    const t = setup();
    await t.start();
    t.controller.dispose();
    await t.placePackage(825);
    expect(t.server.calls).toHaveLength(0);
  });
});
