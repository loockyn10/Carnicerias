import type { StationPrintKind } from "./config";
import type { ScaleSource } from "./scale-source";
import {
  advanceStation, initialStationState, type StationEffect, type StationEvent, type StationOptions, type StationState
} from "./machine";

/**
 * Orquestador ASÍNCRONO de la estación. La máquina (`machine.ts`) decide; este controlador ejecuta los efectos (registrar el paquete, imprimir) y
 * devuelve sus resultados a la máquina con el número de ciclo, de modo que un resultado tardío de un ciclo viejo no puede tocar el actual.
 *
 * No conoce React, Supabase, Web Serial ni el navegador: recibe todo por `StationDeps`, así que las pruebas lo manejan con una balanza simulada y
 * dependencias falsas. Dos garantías propias:
 *  - cada efecto se ejecuta UNA vez (una clave `tipo:ciclo:intento` en vuelo no se vuelve a lanzar aunque llegue repetido);
 *  - un registro que falla por la RED se reintenta solo, con la MISMA clave de idempotencia (el servidor devuelve el paquete que ya existe en vez de
 *    crear otro); un error que contestó el servidor no se reintenta a ciegas: pausa y espera al operario.
 */

export type RegisterResult<P> =
  | { ok: true; packageId: string; payload: P }
  | { ok: false; error: string; /** true si el resultado es incierto (no hubo respuesta): se puede reintentar con la misma clave. */ transient: boolean };

export interface RegisterInput {
  productId: string;
  grams: number;
  requestKey: string;
  attempt: number;
}

export type PrintResult = { ok: true } | { ok: false; error: string };

export interface StationDeps<P> {
  now(): number;
  newKey(): string;
  /** Registra el paquete con las funciones existentes (RPC `create_vacuum_package`, idempotente por `requestKey`). */
  register(input: RegisterInput): Promise<RegisterResult<P>>;
  /** Manda las etiquetas del paquete ya registrado a la impresora. `kind` null = las que tenga elegidas la estación. */
  print(packageId: string, payload: P, kind: StationPrintKind | null): Promise<PrintResult>;
  /** Espera entre reintentos de red (inyectable para no esperar de verdad en las pruebas). */
  sleep(ms: number): Promise<void>;
}

export interface StationControllerConfig {
  /** Cada cuánto se evalúa el tiempo sin lectura nueva (ms). 0 = sin reloj propio (las pruebas mandan los ticks). */
  tickMs: number;
  /** Reintentos automáticos de un registro que falló por la red (además del primer intento). */
  networkRetries: number;
  retryDelayMs: number;
}

export const DEFAULT_CONTROLLER_CONFIG: StationControllerConfig = { tickMs: 100, networkRetries: 2, retryDelayMs: 1_000 };

type Listener<P> = (snapshot: StationSnapshot<P>) => void;

/** Un evento de la máquina sin su marca de tiempo (la pone el controlador con su reloj, salvo que la prueba la mande). */
export type StationEventInput = StationEvent extends infer E ? (E extends StationEvent ? Omit<E, "atMs"> & { atMs?: number } : never) : never;

export interface StationSnapshot<P> {
  state: StationState;
  /** Último paquete registrado (con su payload completo), para «Último paquete» y la reimpresión. */
  lastPackage: { id: string; payload: P; cycle: number } | null;
  /** Etiquetas del último paquete impresas (true) o pendientes (false). */
  lastPrinted: boolean;
}

function sameState(a: StationState, b: StationState): boolean {
  for (const key of Object.keys(a) as (keyof StationState)[]) {
    const left = a[key];
    const right = b[key];
    if (left === right) continue;
    if (typeof left === "object" && typeof right === "object" && left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right)) continue;
    return false;
  }
  return true;
}

export class StationController<P> {
  private snapshot: StationSnapshot<P>;
  private readonly listeners = new Set<Listener<P>>();
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly deps: StationDeps<P>,
    private options: StationOptions,
    private readonly config: StationControllerConfig = DEFAULT_CONTROLLER_CONFIG,
    initial: StationState = initialStationState()
  ) {
    this.snapshot = { state: initial, lastPackage: null, lastPrinted: true };
  }

  getSnapshot = (): StationSnapshot<P> => this.snapshot;

  subscribe = (listener: Listener<P>): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Arranca el reloj que completa la ventana de estabilidad aunque no llegue otra lectura. */
  start(): void {
    if (this.timer !== null || this.config.tickMs <= 0) return;
    this.timer = setInterval(() => { this.dispatch({ type: "TICK" }); }, this.config.tickMs);
  }

  /** Detiene el reloj sin dar de baja el controlador (React puede montar y desmontar la pantalla dos veces en desarrollo). */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /** La impresión automática y el afinado pueden cambiar con la pantalla abierta: rige desde el próximo evento. */
  setOptions(options: StationOptions): void {
    this.options = options;
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  dispatch(event: StationEventInput): void {
    if (this.disposed) return;
    const atMs = event.atMs ?? this.deps.now();
    const step = advanceStation(this.snapshot.state, { ...event, atMs }, this.options, () => this.deps.newKey());
    const changed = !sameState(this.snapshot.state, step.state);
    if (changed) this.snapshot = { ...this.snapshot, state: step.state };
    for (const effect of step.effects) this.run(effect);
    if (changed) this.notify();
  }

  private run(effect: StationEffect): void {
    const key = effect.type === "REGISTER" ? `REGISTER:${String(effect.cycle)}:${String(effect.attempt)}` : `PRINT:${String(effect.cycle)}:${effect.packageId}:${String(this.printAttempts(effect.cycle))}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    if (effect.type === "REGISTER") void this.register(effect, key);
    else void this.print(effect, key);
  }

  private printAttempts(cycle: number): number {
    return this.printCounter.get(cycle) ?? 0;
  }

  private readonly printCounter = new Map<number, number>();

  private async register(effect: Extract<StationEffect, { type: "REGISTER" }>, key: string): Promise<void> {
    const input: RegisterInput = { productId: effect.productId, grams: effect.grams, requestKey: effect.requestKey, attempt: effect.attempt };
    let result: RegisterResult<P>;
    try {
      result = await this.registerWithNetworkRetries(input, effect.cycle);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : "No se pudo registrar el paquete", transient: true };
    }
    this.inFlight.delete(key);
    if (this.disposed) return;
    if (result.ok) {
      this.snapshot = { ...this.snapshot, lastPackage: { id: result.packageId, payload: result.payload, cycle: effect.cycle }, lastPrinted: false };
      this.notify();
      this.dispatch({ type: "REGISTER_OK", cycle: effect.cycle, packageId: result.packageId });
    } else {
      this.dispatch({ type: "REGISTER_FAILED", cycle: effect.cycle, error: result.error });
    }
  }

  private async registerWithNetworkRetries(input: RegisterInput, cycle: number): Promise<RegisterResult<P>> {
    let last: RegisterResult<P> = { ok: false, error: "No se pudo registrar el paquete", transient: true };
    for (let attempt = 0; attempt <= this.config.networkRetries; attempt += 1) {
      if (attempt > 0) {
        await this.deps.sleep(this.config.retryDelayMs * attempt);
        // Si mientras esperaba ya no es el ciclo vigente (o se pausó por falta de red), no se insiste a ciegas.
        const { state } = this.snapshot;
        if (this.disposed || state.capture?.cycle !== cycle || !state.online) return last;
      }
      try {
        last = await this.deps.register(input);
      } catch (error) {
        last = { ok: false, error: error instanceof Error ? error.message : "No se pudo registrar el paquete", transient: true };
      }
      if (last.ok || !last.transient) return last;
    }
    return last;
  }

  private async print(effect: Extract<StationEffect, { type: "PRINT" }>, key: string): Promise<void> {
    const payload = this.snapshot.lastPackage?.id === effect.packageId ? this.snapshot.lastPackage.payload : null;
    let result: PrintResult;
    if (payload === null) result = { ok: false, error: "No se encontró el paquete registrado para imprimir" };
    else {
      try {
        result = await this.deps.print(effect.packageId, payload, null);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : "No se pudo imprimir" };
      }
    }
    this.inFlight.delete(key);
    this.printCounter.set(effect.cycle, this.printAttempts(effect.cycle) + 1);
    if (this.disposed) return;
    if (result.ok) {
      this.snapshot = { ...this.snapshot, lastPrinted: true };
      this.notify();
      this.dispatch({ type: "PRINT_OK", cycle: effect.cycle });
    } else {
      this.dispatch({ type: "PRINT_FAILED", cycle: effect.cycle, error: result.error });
    }
  }

  /**
   * Reimpresión manual del último paquete (botón «Reimprimir»): NO pasa por la máquina ni registra nada. Devuelve el resultado para que la pantalla lo
   * muestre; no cambia el estado de la producción.
   */
  async reprintLast(kind: StationPrintKind | null = null): Promise<PrintResult> {
    const last = this.snapshot.lastPackage;
    if (last === null) return { ok: false, error: "Todavía no hay un paquete para reimprimir" };
    try {
      const result = await this.deps.print(last.id, last.payload, kind);
      if (result.ok && !this.disposed) {
        this.snapshot = { ...this.snapshot, lastPrinted: true };
        // Si la producción estaba pausada justamente por esa impresión, la reimpresión exitosa la resuelve.
        const { state } = this.snapshot;
        if (state.package?.packageId === last.id && !state.package.printed) this.dispatch({ type: "PRINT_OK", cycle: last.cycle });
        else this.notify();
      }
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "No se pudo imprimir" };
    }
  }
}

/** Conecta una fuente de peso (balanza real o simulada) con el controlador. Devuelve la función para desconectarlas. */
export function bindScale<P>(source: ScaleSource, controller: StationController<P>): () => void {
  return source.subscribe((event) => {
    if (event.type === "sample") controller.dispatch({ type: "SAMPLE", grams: event.grams, stable: event.stable, atMs: event.atMs });
    else if (event.type === "status") controller.dispatch({ type: "SCALE_CONNECTION", connected: event.status === "CONNECTED", atMs: event.atMs });
  });
}
