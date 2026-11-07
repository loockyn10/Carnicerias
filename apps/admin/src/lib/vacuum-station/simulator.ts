import type { ScaleLinkStatus, ScaleSource, ScaleSourceEvent, ScaleSourceListener } from "./scale-source";

/**
 * SIMULADOR DE BALANZA para desarrollo y pruebas automatizadas: reproduce lecturas inestables, estabilización, retiro del paquete y desconexiones sin
 * hardware. Cumple la misma interfaz que la balanza real (`ScaleSource`), de modo que la estación no sabe la diferencia.
 *
 * NO es un modo de producción: la pantalla sólo lo ofrece si `isSimulatorAllowed()` (compilación de desarrollo o variable explícita), nunca por un
 * parámetro de la URL en producción. Las pruebas lo usan con un reloj propio (`now`) y sin timers: cada lectura la emite quien lo maneja.
 */

export interface SimulatorOptions {
  now(): number;
  /** Transmisión continua propia (setInterval) con el peso actual cada `intervalMs`. Las pruebas la dejan apagada y mandan las lecturas a mano. */
  intervalMs?: number;
}

/** Perfil de la balanza simulada: qué informa cada lectura. */
export interface SimulatedProfile {
  /** El protocolo informa estabilidad (`true`/`false`) o no (`null`, como el KRETZ). */
  reportsStability: boolean;
}

export class SimulatedScale implements ScaleSource {
  status: ScaleLinkStatus = "DISCONNECTED";
  private readonly listeners = new Set<ScaleSourceListener>();
  private grams = 0;
  private unstable = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: SimulatorOptions, private readonly profile: SimulatedProfile = { reportsStability: false }) {}

  subscribe(listener: ScaleSourceListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: ScaleSourceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private setStatus(status: ScaleLinkStatus, message: string | null = null): void {
    this.status = status;
    this.emit({ type: "status", status, message, atMs: this.options.now() });
  }

  /** Conecta (equivale a elegir el puerto). */
  connect(): void {
    this.setStatus("CONNECTED");
    const every = this.options.intervalMs ?? 0;
    if (every > 0 && this.timer === null) this.timer = setInterval(() => { this.tick(); }, every);
  }

  disconnect(): Promise<void> {
    this.stopTimer();
    this.setStatus("DISCONNECTED");
    return Promise.resolve();
  }

  /** Se corta el cable: la estación lo ve como un error de conexión, no como una desconexión pedida. */
  dropConnection(message = "Balanza desconectada (simulación)"): void {
    this.stopTimer();
    this.setStatus("ERROR", message);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Una lectura con el peso actual (lo que transmitiría la balanza en este instante). */
  tick(): void {
    if (this.status !== "CONNECTED") return;
    this.sendReading(this.grams, this.profile.reportsStability ? !this.unstable : null);
  }

  /** Una lectura arbitraria: sirve para reproducir ruido, picos o valores inválidos. */
  sendReading(grams: number, stable: boolean | null = null): void {
    if (this.status !== "CONNECTED") return;
    this.emit({ type: "sample", grams, stable, atMs: this.options.now() });
  }

  /** Apoya un paquete: el peso real cambia a `grams` y se marca estable (si el protocolo lo informa). */
  place(grams: number): void {
    this.grams = grams;
    this.unstable = false;
  }

  /** El paquete se está moviendo o apoyando: la balanza informa inestable (si el protocolo lo informa) con este peso. */
  wobble(grams: number): void {
    this.grams = grams;
    this.unstable = true;
  }

  /** Retira el paquete: la balanza vuelve a cero. */
  remove(): void {
    this.grams = 0;
    this.unstable = false;
  }

  get currentGrams(): number {
    return this.grams;
  }
}

/**
 * ¿Se puede ofrecer el simulador en esta compilación? Sólo en desarrollo, o si quien despliega lo habilita a propósito con
 * `NEXT_PUBLIC_VACUUM_SCALE_SIMULATOR=1`. Es una constante de compilación: en producción normal el código del simulador ni se carga.
 */
export function isSimulatorAllowed(env: { nodeEnv: string | undefined; flag: string | undefined } = { nodeEnv: process.env.NODE_ENV, flag: process.env.NEXT_PUBLIC_VACUUM_SCALE_SIMULATOR }): boolean {
  return env.nodeEnv !== "production" || env.flag === "1";
}
