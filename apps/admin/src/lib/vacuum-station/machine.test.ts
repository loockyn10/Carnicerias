import { describe, expect, it } from "vitest";

import type { StationEventInput } from "./controller";
import {
  advanceStation, DEFAULT_STATION_TUNING, initialStationState, type StationEffect, type StationOptions, type StationState
} from "./machine";

/** Pequeño banco de pruebas: acumula los efectos que pidió la máquina y lleva el reloj. */
class Bench {
  state: StationState;
  effects: StationEffect[] = [];
  now = 0;
  private keys = 0;
  constructor(public options: StationOptions = { tuning: DEFAULT_STATION_TUNING, autoPrint: true }) {
    this.state = initialStationState();
  }

  send(event: StationEventInput): this {
    const atMs = event.atMs ?? this.now;
    this.now = atMs;
    const step = advanceStation(this.state, { ...event, atMs }, this.options, () => { this.keys += 1; return `key-${String(this.keys)}`; });
    this.state = step.state;
    this.effects.push(...step.effects);
    return this;
  }

  /** Lecturas cada `everyMs` durante `forMs`, más un tick por lectura (como la pantalla real). */
  weigh(grams: number, forMs: number, opts: { everyMs?: number; stable?: boolean | null } = {}): this {
    const everyMs = opts.everyMs ?? 500;
    const end = this.now + forMs;
    for (let at = this.now; at <= end; at += everyMs) {
      this.send({ type: "SAMPLE", grams, stable: opts.stable ?? null, atMs: at });
    }
    this.now = end;
    return this.send({ type: "TICK", atMs: end });
  }

  advance(ms: number): this {
    return this.send({ type: "TICK", atMs: this.now + ms });
  }

  registers(): StationEffect[] { return this.effects.filter((effect) => effect.type === "REGISTER"); }
  prints(): StationEffect[] { return this.effects.filter((effect) => effect.type === "PRINT"); }

  /** Estación lista para trabajar: balanza conectada, en cero y con el vacío de cerdo seleccionado. */
  static ready(options?: StationOptions): Bench {
    const bench = new Bench(options);
    bench.send({ type: "READY", ready: true }).send({ type: "PRODUCT_SELECTED", productId: "vacio-cerdo" }).send({ type: "SCALE_CONNECTION", connected: true });
    bench.weigh(0, 1_000);
    return bench;
  }
}

/** Coloca un paquete de `grams` (con un peso que sube hasta estabilizarse) y lo deja apoyado. */
function place(bench: Bench, grams: number, restMs = 1_500) {
  bench.weigh(450, 0).weigh(780, 500).weigh(grams, restMs);
}

describe("arranque y conexión", () => {
  it("empieza pausada y sin balanza", () => {
    const state = initialStationState();
    expect(state.status).toBe("PAUSED");
    expect(state.pauseReason).toBe("SCALE_DISCONNECTED");
  });

  it("al conectar espera el cero antes de aceptar un paquete (no sabe qué hay sobre la balanza)", () => {
    const bench = new Bench();
    bench.send({ type: "READY", ready: true }).send({ type: "PRODUCT_SELECTED", productId: "p" }).send({ type: "SCALE_CONNECTION", connected: true });
    expect(bench.state.status).toBe("WAITING_REMOVAL");
    place(bench, 825, 3_000);
    expect(bench.registers()).toHaveLength(0);
  });

  it("con un cero sostenido queda esperando paquete", () => {
    const bench = Bench.ready();
    expect(bench.state.status).toBe("WAITING_PACKAGE");
    expect(bench.state.needsZero).toBe(false);
  });
});

describe("detección de estabilidad", () => {
  it("registra UNA vez el peso estable: 0,450 → 0,780 → 0,825 kg", () => {
    const bench = Bench.ready();
    bench.weigh(450, 0).weigh(780, 500);
    expect(bench.registers()).toHaveLength(0);
    bench.weigh(825, 1_500);
    expect(bench.registers()).toEqual([{ type: "REGISTER", cycle: 1, productId: "vacio-cerdo", grams: 825, requestKey: "key-1", attempt: 1 }]);
    expect(bench.state.status).toBe("REGISTERING");
  });

  it("pasa por detectar y estabilizar antes de registrar", () => {
    const bench = Bench.ready();
    bench.send({ type: "SAMPLE", grams: 600, stable: null, atMs: 2_000 });
    expect(bench.state.status).toBe("DETECTING");
    bench.send({ type: "SAMPLE", grams: 601, stable: null, atMs: 2_500 });
    expect(bench.state.status).toBe("STABILIZING");
    bench.advance(300);
    expect(bench.state.status).toBe("REGISTERING");
  });

  it("el tick completa la ventana sin esperar otra lectura", () => {
    const bench = Bench.ready();
    bench.send({ type: "SAMPLE", grams: 700, stable: null, atMs: 2_000 }).send({ type: "SAMPLE", grams: 700, stable: null, atMs: 2_500 });
    expect(bench.registers()).toHaveLength(0);
    bench.send({ type: "TICK", atMs: 2_799 });
    expect(bench.registers()).toHaveLength(0);
    bench.send({ type: "TICK", atMs: 2_800 });
    expect(bench.registers()).toHaveLength(1);
  });

  it("un peso que sigue cambiando fuera de la tolerancia nunca se registra", () => {
    const bench = Bench.ready();
    for (let index = 0; index < 40; index += 1) bench.send({ type: "SAMPLE", grams: 500 + index * 20, stable: null, atMs: 2_000 + index * 200 });
    expect(bench.registers()).toHaveLength(0);
    expect(bench.state.status).toBe("STABILIZING");
    expect(bench.state.moving).toBe(true);
  });

  it("la deriva lenta no se cuela: se compara contra el primer valor, no contra la lectura anterior", () => {
    const bench = Bench.ready();
    for (let index = 0; index < 20; index += 1) bench.send({ type: "SAMPLE", grams: 700 + index * 2, stable: null, atMs: 2_000 + index * 200 });
    expect(bench.registers()).toHaveLength(0);
  });

  it("dentro de la tolerancia (± 5 g) se considera el mismo peso", () => {
    const bench = Bench.ready();
    bench.send({ type: "SAMPLE", grams: 700, stable: null, atMs: 2_000 }).send({ type: "SAMPLE", grams: 705, stable: null, atMs: 2_400 }).send({ type: "SAMPLE", grams: 698, stable: null, atMs: 2_800 });
    expect(bench.registers()).toHaveLength(1);
  });

  it("la señal de la balanza manda: «inestable» nunca estabiliza aunque el número no cambie", () => {
    const bench = Bench.ready();
    bench.weigh(700, 5_000, { everyMs: 200, stable: false });
    expect(bench.registers()).toHaveLength(0);
    expect(bench.state.moving).toBe(true);
  });

  it("con señal «estable» registra al cumplirse la ventana", () => {
    const bench = Bench.ready();
    bench.weigh(700, 1_200, { everyMs: 200, stable: true });
    expect(bench.registers()).toHaveLength(1);
  });

  it("una lectura inestable en medio reinicia la cuenta", () => {
    const bench = Bench.ready();
    bench.send({ type: "SAMPLE", grams: 700, stable: true, atMs: 2_000 }).send({ type: "SAMPLE", grams: 700, stable: false, atMs: 2_400 }).send({ type: "SAMPLE", grams: 700, stable: true, atMs: 2_800 });
    bench.send({ type: "TICK", atMs: 3_000 });
    expect(bench.registers()).toHaveLength(0);
    bench.send({ type: "SAMPLE", grams: 700, stable: true, atMs: 3_300 }).send({ type: "TICK", atMs: 3_700 });
    expect(bench.registers()).toHaveLength(1);
  });

  it("un hueco largo entre lecturas rompe la continuidad", () => {
    const bench = Bench.ready();
    bench.send({ type: "SAMPLE", grams: 700, stable: null, atMs: 2_000 }).send({ type: "SAMPLE", grams: 700, stable: null, atMs: 5_000 });
    expect(bench.registers()).toHaveLength(0);
    expect(bench.state.anchor?.samples).toBe(1);
  });

  it("sin lecturas nuevas el tick no registra con datos viejos", () => {
    const bench = Bench.ready();
    bench.send({ type: "SAMPLE", grams: 700, stable: null, atMs: 2_000 }).send({ type: "SAMPLE", grams: 700, stable: null, atMs: 2_300 });
    bench.send({ type: "TICK", atMs: 9_000 });
    expect(bench.registers()).toHaveLength(0);
  });

  it("no registra por debajo del peso mínimo", () => {
    const bench = Bench.ready();
    bench.weigh(40, 5_000);
    expect(bench.registers()).toHaveLength(0);
    expect(bench.state.status).toBe("DETECTING");
  });

  it("no registra pesos inválidos: NaN, negativos o fuera de rango", () => {
    const bench = Bench.ready();
    bench.weigh(Number.NaN, 3_000).weigh(-500, 3_000).weigh(250_000, 3_000);
    expect(bench.registers()).toHaveLength(0);
  });

  it("una lectura inválida en medio de una tanda estable corta la estabilidad", () => {
    const bench = Bench.ready();
    bench.send({ type: "SAMPLE", grams: 700, stable: null, atMs: 2_000 }).send({ type: "SAMPLE", grams: Number.NaN, stable: null, atMs: 2_300 }).send({ type: "SAMPLE", grams: 700, stable: null, atMs: 2_600 });
    bench.send({ type: "TICK", atMs: 2_900 });
    expect(bench.registers()).toHaveLength(0);
  });

  it("descuenta la tara configurada", () => {
    const bench = Bench.ready({ tuning: { ...DEFAULT_STATION_TUNING, tareGrams: 75 }, autoPrint: true });
    place(bench, 900);
    expect(bench.registers()).toMatchObject([{ grams: 825 }]);
  });

  it("con tara, un peso que no supera el mínimo neto no se registra", () => {
    const bench = Bench.ready({ tuning: { ...DEFAULT_STATION_TUNING, tareGrams: 75 }, autoPrint: true });
    place(bench, 110, 3_000);
    expect(bench.registers()).toHaveLength(0);
  });

  it("no registra mientras el producto no esté listo y lo hace en cuanto lo está si el peso sigue estable (una sola vez)", () => {
    const bench = new Bench();
    bench.send({ type: "PRODUCT_SELECTED", productId: "p" }).send({ type: "SCALE_CONNECTION", connected: true });
    bench.weigh(0, 1_000);
    place(bench, 800, 2_000);
    expect(bench.registers()).toHaveLength(0);
    expect(bench.state.status).toBe("STABILIZING");
    bench.send({ type: "READY", ready: true });
    expect(bench.registers()).toHaveLength(1);
    bench.weigh(800, 5_000);
    expect(bench.registers()).toHaveLength(1);
  });
});

describe("un ciclo de pesado = un registro", () => {
  it("un paquete apoyado varios minutos no genera más registros ni impresiones", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "PRINT_OK", cycle: 1 });
    expect(bench.state.status).toBe("WAITING_REMOVAL");
    bench.weigh(825, 10 * 60 * 1_000, { everyMs: 500 });
    expect(bench.registers()).toHaveLength(1);
    expect(bench.prints()).toHaveLength(1);
    expect(bench.state.status).toBe("WAITING_REMOVAL");
  });

  it("al retirarlo (cero sostenido) queda listo y el siguiente paquete usa otra clave", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "PRINT_OK", cycle: 1 });
    bench.weigh(0, 1_000);
    expect(bench.state.status).toBe("WAITING_PACKAGE");
    place(bench, 640);
    expect(bench.registers()).toMatchObject([{ cycle: 1, grams: 825, requestKey: "key-1" }, { cycle: 2, grams: 640, requestKey: "key-2" }]);
  });

  it("un cero fugaz (menos que el tiempo de retiro) no libera el ciclo", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "PRINT_OK", cycle: 1 });
    bench.send({ type: "SAMPLE", grams: 0, stable: null, atMs: bench.now + 100 }).send({ type: "SAMPLE", grams: 825, stable: null, atMs: bench.now + 300 });
    bench.weigh(825, 3_000);
    expect(bench.registers()).toHaveLength(1);
  });

  it("si se retira el paquete mientras imprime, al terminar la impresión queda listo para el siguiente", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" });
    expect(bench.state.status).toBe("PRINTING");
    bench.weigh(0, 1_000);
    bench.send({ type: "PRINT_OK", cycle: 1 });
    expect(bench.state.status).toBe("WAITING_PACKAGE");
  });

  it("si ya apoyó el siguiente mientras imprimía, lo registra al terminar sin pedir retirarlo", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" });
    bench.weigh(0, 1_000);
    place(bench, 640);
    expect(bench.registers()).toHaveLength(1);
    bench.send({ type: "PRINT_OK", cycle: 1 });
    expect(bench.registers()).toHaveLength(2);
  });

  it("ignora resultados de ciclos que no están vigentes y resultados repetidos", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 7, packageId: "otro" });
    expect(bench.state.status).toBe("REGISTERING");
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" });
    expect(bench.prints()).toHaveLength(1);
    bench.send({ type: "PRINT_OK", cycle: 1 }).send({ type: "PRINT_OK", cycle: 1 }).send({ type: "PRINT_FAILED", cycle: 1, error: "tarde" });
    expect(bench.state.status).toBe("WAITING_REMOVAL");
    expect(bench.state.pauseReason).toBeNull();
  });

  it("sin impresión automática registra pero no imprime y espera el retiro", () => {
    const bench = Bench.ready({ tuning: DEFAULT_STATION_TUNING, autoPrint: false });
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" });
    expect(bench.prints()).toHaveLength(0);
    expect(bench.state.status).toBe("WAITING_REMOVAL");
    expect(bench.state.package).toEqual({ cycle: 1, packageId: "pkg-1", printed: false });
  });
});

describe("cambio de producto", () => {
  it("con peso sobre la balanza espera el cero antes de registrar con el producto nuevo", () => {
    const bench = Bench.ready();
    bench.weigh(450, 0).weigh(700, 600);
    bench.send({ type: "PRODUCT_SELECTED", productId: "churrasco" });
    expect(bench.state.status).toBe("WAITING_REMOVAL");
    expect(bench.state.removalReason).toBe("PRODUCT_CHANGED");
    bench.weigh(700, 5_000);
    expect(bench.registers()).toHaveLength(0);
    bench.weigh(0, 1_000);
    place(bench, 700);
    expect(bench.registers()).toMatchObject([{ productId: "churrasco", grams: 700 }]);
  });

  it("con la balanza vacía sigue de inmediato con el producto nuevo", () => {
    const bench = Bench.ready();
    bench.send({ type: "PRODUCT_SELECTED", productId: "churrasco" });
    expect(bench.state.status).toBe("WAITING_PACKAGE");
    place(bench, 700);
    expect(bench.registers()).toMatchObject([{ productId: "churrasco" }]);
  });

  it("si cambia mientras registra, ese paquete conserva SU producto y el próximo usa el nuevo", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "PRODUCT_SELECTED", productId: "churrasco" });
    expect(bench.state.capture?.productId).toBe("vacio-cerdo");
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "PRINT_OK", cycle: 1 });
    bench.weigh(0, 1_000);
    place(bench, 600);
    expect(bench.registers()).toMatchObject([{ productId: "vacio-cerdo" }, { productId: "churrasco" }]);
  });

  it("elegir el mismo producto no cambia nada", () => {
    const bench = Bench.ready();
    const before = bench.state;
    bench.send({ type: "PRODUCT_SELECTED", productId: "vacio-cerdo" });
    expect(bench.state).toBe(before);
  });
});

describe("desconexión de la balanza", () => {
  it("pausa y, al volver, exige ver el cero antes de aceptar un paquete", () => {
    const bench = Bench.ready();
    bench.weigh(450, 0).weigh(700, 300);
    bench.send({ type: "SCALE_CONNECTION", connected: false });
    expect(bench.state).toMatchObject({ status: "PAUSED", pauseReason: "SCALE_DISCONNECTED" });
    bench.send({ type: "SCALE_CONNECTION", connected: true });
    expect(bench.state.status).toBe("WAITING_REMOVAL");
    bench.weigh(700, 5_000);
    expect(bench.registers()).toHaveLength(0);
    bench.weigh(0, 1_000);
    expect(bench.state.status).toBe("WAITING_PACKAGE");
  });

  it("con el paquete ya registrado, desconectar y reconectar con el paquete apoyado NO lo registra de nuevo", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "PRINT_OK", cycle: 1 });
    bench.send({ type: "SCALE_CONNECTION", connected: false }).send({ type: "SCALE_CONNECTION", connected: true });
    bench.weigh(825, 10_000);
    expect(bench.registers()).toHaveLength(1);
    expect(bench.prints()).toHaveLength(1);
  });

  it("si se desconecta mientras registra, la operación en vuelo termina y recién entonces pausa", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "SCALE_CONNECTION", connected: false });
    expect(bench.state.status).toBe("REGISTERING");
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" });
    expect(bench.prints()).toHaveLength(1);
    bench.send({ type: "PRINT_OK", cycle: 1 });
    expect(bench.state).toMatchObject({ status: "PAUSED", pauseReason: "SCALE_DISCONNECTED" });
    expect(bench.registers()).toHaveLength(1);
  });

  it("ignora un evento de conexión repetido", () => {
    const bench = Bench.ready();
    const before = bench.state;
    bench.send({ type: "SCALE_CONNECTION", connected: true });
    expect(bench.state).toBe(before);
  });
});

describe("conexión con el servidor", () => {
  it("sin Internet pausa y no registra aunque haya un paquete estable", () => {
    const bench = Bench.ready();
    bench.send({ type: "ONLINE", online: false });
    expect(bench.state).toMatchObject({ status: "PAUSED", pauseReason: "OFFLINE" });
    place(bench, 825, 3_000);
    expect(bench.registers()).toHaveLength(0);
  });

  it("al volver Internet reanuda sola; un paquete que esperó apoyado (nunca se registró) se registra una sola vez", () => {
    const bench = Bench.ready();
    bench.send({ type: "ONLINE", online: false });
    place(bench, 825, 3_000);
    expect(bench.registers()).toHaveLength(0);
    bench.send({ type: "ONLINE", online: true });
    expect(bench.registers()).toHaveLength(0); // la estabilidad se vuelve a medir con lecturas nuevas
    bench.weigh(825, 1_500);
    expect(bench.registers()).toHaveLength(1);
    bench.weigh(825, 5_000);
    expect(bench.registers()).toHaveLength(1);
  });

  it("si la caída de Internet llegó con un paquete ya procesado esperando el retiro, sigue exigiendo el cero", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "PRINT_OK", cycle: 1 });
    bench.send({ type: "ONLINE", online: false }).send({ type: "ONLINE", online: true });
    expect(bench.state.status).toBe("WAITING_REMOVAL");
    bench.weigh(825, 5_000);
    expect(bench.registers()).toHaveLength(1);
  });

  it("un registro que falla por falta de conexión se reintenta con la MISMA clave al volver Internet", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "ONLINE", online: false });
    bench.send({ type: "REGISTER_FAILED", cycle: 1, error: "Failed to fetch" });
    expect(bench.state).toMatchObject({ status: "PAUSED", pauseReason: "OFFLINE" });
    bench.weigh(825, 500);
    bench.send({ type: "ONLINE", online: true });
    expect(bench.state.status).toBe("REGISTERING");
    expect(bench.registers()).toMatchObject([{ cycle: 1, requestKey: "key-1", attempt: 1 }, { cycle: 1, requestKey: "key-1", attempt: 2 }]);
  });

  it("no pausa por una caída de Internet cuando ya no hay nada pendiente salvo esperar el cero", () => {
    const bench = Bench.ready();
    bench.send({ type: "ONLINE", online: false }).send({ type: "ONLINE", online: true });
    expect(bench.state.status).toBe("WAITING_PACKAGE");
  });
});

describe("fallos de registro", () => {
  it("pausa mostrando el error y no registra otro paquete", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_FAILED", cycle: 1, error: "El corte no tiene un precio vigente" });
    expect(bench.state).toMatchObject({ status: "PAUSED", pauseReason: "REGISTER_FAILED", error: "El corte no tiene un precio vigente" });
    bench.weigh(0, 1_000);
    place(bench, 640, 3_000);
    expect(bench.registers()).toHaveLength(1);
  });

  it("«reintentar» con el mismo paquete apoyado reutiliza la clave de idempotencia", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_FAILED", cycle: 1, error: "boom" });
    bench.weigh(826, 600);
    bench.send({ type: "RETRY" });
    expect(bench.state.status).toBe("REGISTERING");
    expect(bench.registers().at(-1)).toMatchObject({ requestKey: "key-1", grams: 825, attempt: 2 });
  });

  it("si el paquete ya no está (otro peso), el reintento se descarta y no se registra un peso que ya no existe", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_FAILED", cycle: 1, error: "boom" });
    bench.weigh(0, 1_000);
    bench.send({ type: "RETRY" });
    expect(bench.state.status).toBe("WAITING_PACKAGE");
    expect(bench.registers()).toHaveLength(1);
  });

  it("si lo que está ahora es otro peso, no reintenta con el anterior", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_FAILED", cycle: 1, error: "boom" });
    bench.weigh(1_400, 1_000);
    bench.send({ type: "RETRY" });
    expect(bench.registers()).toHaveLength(1);
    expect(bench.state.status).toBe("WAITING_REMOVAL");
  });
});

describe("fallos de impresión", () => {
  it("el paquete queda registrado, se pausa y NO se genera otro registro", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "PRINT_FAILED", cycle: 1, error: "La impresora no responde" });
    expect(bench.state).toMatchObject({ status: "PAUSED", pauseReason: "PRINT_FAILED", error: "La impresora no responde" });
    bench.weigh(0, 1_000);
    place(bench, 640, 3_000);
    expect(bench.registers()).toHaveLength(1);
    expect(bench.state.status).toBe("PAUSED");
  });

  it("reintentar reimprime las MISMAS etiquetas del mismo paquete, sin registrar", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "PRINT_FAILED", cycle: 1, error: "x" });
    bench.send({ type: "RETRY" });
    expect(bench.state.status).toBe("PRINTING");
    expect(bench.prints()).toEqual([{ type: "PRINT", cycle: 1, packageId: "pkg-1" }, { type: "PRINT", cycle: 1, packageId: "pkg-1" }]);
    expect(bench.registers()).toHaveLength(1);
    bench.send({ type: "PRINT_OK", cycle: 1 });
    expect(bench.state.status).toBe("WAITING_REMOVAL");
  });

  it("«continuar sin imprimir» sigue produciendo sin reimprimir ni duplicar el paquete", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "PRINT_FAILED", cycle: 1, error: "x" });
    bench.send({ type: "SKIP_PRINT" });
    expect(bench.state.status).toBe("WAITING_REMOVAL");
    expect(bench.prints()).toHaveLength(1);
    expect(bench.state.package).toBeNull();
    bench.weigh(0, 1_000);
    place(bench, 640);
    expect(bench.registers()).toHaveLength(2);
  });

  it("si la impresión falla con la balanza ya sin paquete, tras reintentar queda lista", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" }).send({ type: "PRINT_FAILED", cycle: 1, error: "x" });
    bench.weigh(0, 1_000);
    bench.send({ type: "RETRY" }).send({ type: "PRINT_OK", cycle: 1 });
    expect(bench.state.status).toBe("WAITING_PACKAGE");
  });
});

describe("pausa y reanudación", () => {
  it("pausar con un paquete a medio estabilizar y reanudar no lo registra: hay que ver el cero", () => {
    const bench = Bench.ready();
    bench.weigh(450, 0).weigh(700, 300);
    bench.send({ type: "PAUSE" });
    expect(bench.state).toMatchObject({ status: "PAUSED", pauseReason: "MANUAL", needsZero: true });
    bench.weigh(700, 5_000);
    expect(bench.registers()).toHaveLength(0);
    bench.send({ type: "RESUME" });
    expect(bench.state.status).toBe("WAITING_REMOVAL");
    bench.weigh(700, 3_000);
    expect(bench.registers()).toHaveLength(0);
    bench.weigh(0, 1_000);
    place(bench, 700);
    expect(bench.registers()).toHaveLength(1);
  });

  it("pausar con la balanza vacía y reanudar sigue de inmediato", () => {
    const bench = Bench.ready();
    bench.send({ type: "PAUSE" }).send({ type: "RESUME" });
    expect(bench.state.status).toBe("WAITING_PACKAGE");
    place(bench, 700);
    expect(bench.registers()).toHaveLength(1);
  });

  it("pausar mientras registra no pierde el paquete: se imprime al reanudar", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "PAUSE" });
    expect(bench.state.status).toBe("PAUSED");
    bench.send({ type: "REGISTER_OK", cycle: 1, packageId: "pkg-1" });
    expect(bench.prints()).toHaveLength(0);
    bench.send({ type: "RESUME" });
    expect(bench.prints()).toEqual([{ type: "PRINT", cycle: 1, packageId: "pkg-1" }]);
    expect(bench.registers()).toHaveLength(1);
  });

  it("pausar mientras registra y reanudar antes de que responda el servidor reintenta con la misma clave", () => {
    const bench = Bench.ready();
    place(bench, 825);
    bench.send({ type: "PAUSE" }).send({ type: "RESUME" });
    expect(bench.registers().map((effect) => effect.type === "REGISTER" && effect.requestKey)).toEqual(["key-1", "key-1"]);
  });

  it("reanudar sin balanza o sin Internet sigue pausado con el motivo real", () => {
    const bench = Bench.ready();
    bench.send({ type: "PAUSE" }).send({ type: "SCALE_CONNECTION", connected: false }).send({ type: "RESUME" });
    expect(bench.state).toMatchObject({ status: "PAUSED", pauseReason: "SCALE_DISCONNECTED" });
  });

  it("RESUME fuera de pausa no hace nada", () => {
    const bench = Bench.ready();
    const before = bench.state;
    bench.send({ type: "RESUME" });
    expect(bench.state).toBe(before);
  });
});
