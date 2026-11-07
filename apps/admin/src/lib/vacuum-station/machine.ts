/**
 * Máquina de estados de la ESTACIÓN DE PRODUCCIÓN de envasado. Es un reductor PURO: recibe un evento (con su marca de tiempo) y devuelve el estado
 * nuevo y los EFECTOS que hay que ejecutar (registrar el paquete, imprimir). No hace I/O, no lee relojes y no genera ids al azar (la clave de
 * idempotencia entra por `newKey`): por eso se prueba sin balanza, sin red y sin impresora, y por eso cada transición es explícita.
 *
 * Qué garantiza (cada punto tiene su prueba):
 *  - UN ciclo de pesado = UN registro. Al capturar el peso se levanta `needsZero`: hasta ver el retorno ESTABLE a cero no se puede capturar otro, aunque
 *    el paquete se quede apoyado horas, la balanza se desconecte y vuelva, se cambie de producto, se pause/reanude o se reintente algo.
 *  - Las operaciones asíncronas devuelven su resultado con el número de ciclo: un resultado de un ciclo que ya no está vigente se ignora.
 *  - Registrar e imprimir son operaciones separadas: si el paquete quedó registrado y la impresión falla, NO se registra otro; se pausa y se puede
 *    reintentar SÓLO la impresión.
 *  - Un registro con resultado incierto se reintenta con la MISMA clave: el servidor devuelve el paquete que ya existe en vez de crear otro.
 *  - La estabilidad prioriza la señal de la balanza cuando existe (`stable === false` nunca estabiliza) y, si no, usa lecturas consecutivas dentro de
 *    una tolerancia durante `stableMs`. Un hueco largo entre lecturas reinicia la cuenta: sin evidencia continua no hay estabilidad.
 */

export type StationStatus = "WAITING_PACKAGE" | "DETECTING" | "STABILIZING" | "REGISTERING" | "PRINTING" | "WAITING_REMOVAL" | "PAUSED";

export type PauseReason = "MANUAL" | "SCALE_DISCONNECTED" | "OFFLINE" | "REGISTER_FAILED" | "PRINT_FAILED";

/** Por qué hay que esperar el retorno a cero antes de aceptar otro paquete. */
export type RemovalReason = "PROCESSED" | "PRODUCT_CHANGED" | "STARTUP" | "RECONNECTED" | "PAUSED_WITH_WEIGHT";

export interface StationTuning {
  /** Tiempo con el peso estable antes de registrar (ms). */
  stableMs: number;
  /** Variación máxima (g) entre lecturas para considerarlas «el mismo peso». */
  toleranceGrams: number;
  /** Peso neto mínimo (g) para registrar. Por debajo de esto sólo se detecta. */
  minWeightGrams: number;
  /** Se considera «cero» una lectura dentro de ± esta tolerancia (g). */
  zeroToleranceGrams: number;
  /** Tiempo con la balanza en cero antes de dar por retirado el paquete (ms). */
  zeroHoldMs: number;
  /** Si pasa más que esto entre dos lecturas se pierde la continuidad (ms). */
  maxGapMs: number;
  /** Tara manual (g) que se descuenta del peso estable (bandeja, bolsa). */
  tareGrams: number;
}

export const DEFAULT_STATION_TUNING: StationTuning = {
  stableMs: 800,
  toleranceGrams: 5,
  minWeightGrams: 50,
  zeroToleranceGrams: 10,
  zeroHoldMs: 500,
  maxGapMs: 2_000,
  tareGrams: 0
};

/** Por encima de esto una lectura es un error de la balanza (el servidor admite hasta 99,999 kg por paquete). */
export const MAX_STATION_GRAMS = 99_999;

export interface StationOptions {
  tuning: StationTuning;
  /** Imprimir las etiquetas solas al registrar (sólo si la estación pasó la prueba de impresión). */
  autoPrint: boolean;
}

export interface StationCapture {
  cycle: number;
  productId: string;
  /** Peso neto (descontada la tara): lo que se registra. */
  grams: number;
  /** Peso leído de la balanza (para saber si el MISMO paquete sigue apoyado al reintentar). */
  rawGrams: number;
  requestKey: string;
  attempt: number;
}

export interface StationPackageRef {
  cycle: number;
  packageId: string;
  printed: boolean;
}

export interface StationState {
  status: StationStatus;
  pauseReason: PauseReason | null;
  removalReason: RemovalReason | null;
  /** Último error mostrado al operario (registro o impresión). */
  error: string | null;
  cycle: number;
  productId: string | null;
  /** Hay un producto listo para envasar (con precio, vencimiento y esquema EAN). Lo informa quien arma la pantalla. */
  ready: boolean;
  scaleConnected: boolean;
  online: boolean;
  /** Última lectura válida (g, sin tara) y cuándo llegó. */
  grams: number | null;
  lastSampleAtMs: number | null;
  /** Última señal de estabilidad de la balanza (null = el protocolo no la informa). */
  scaleStable: boolean | null;
  /** El peso está cambiando (la última lectura se salió de la tolerancia o la balanza dice inestable). */
  moving: boolean;
  anchor: { grams: number; sinceMs: number; samples: number } | null;
  zeroSinceMs: number | null;
  /** No se acepta un paquete nuevo hasta ver el retorno estable a cero. */
  needsZero: boolean;
  capture: StationCapture | null;
  /** Paquete registrado del último ciclo (para reintentar SÓLO su impresión). */
  package: StationPackageRef | null;
}

export type StationEvent =
  | { type: "SAMPLE"; grams: number; stable: boolean | null; atMs: number }
  | { type: "TICK"; atMs: number }
  | { type: "SCALE_CONNECTION"; connected: boolean; atMs: number }
  | { type: "ONLINE"; online: boolean; atMs: number }
  | { type: "PRODUCT_SELECTED"; productId: string | null; atMs: number }
  | { type: "READY"; ready: boolean; atMs: number }
  | { type: "PAUSE"; atMs: number }
  | { type: "RESUME"; atMs: number }
  | { type: "RETRY"; atMs: number }
  | { type: "SKIP_PRINT"; atMs: number }
  | { type: "REGISTER_OK"; cycle: number; packageId: string; atMs: number }
  | { type: "REGISTER_FAILED"; cycle: number; error: string; atMs: number }
  | { type: "PRINT_OK"; cycle: number; atMs: number }
  | { type: "PRINT_FAILED"; cycle: number; error: string; atMs: number };

export type StationEffect =
  | { type: "REGISTER"; cycle: number; productId: string; grams: number; requestKey: string; attempt: number }
  | { type: "PRINT"; cycle: number; packageId: string };

export interface StationStep {
  state: StationState;
  effects: StationEffect[];
}

export function initialStationState(options: { online?: boolean } = {}): StationState {
  return {
    status: "PAUSED", pauseReason: "SCALE_DISCONNECTED", removalReason: "STARTUP", error: null, cycle: 0, productId: null, ready: false,
    scaleConnected: false, online: options.online ?? true, grams: null, lastSampleAtMs: null, scaleStable: null, moving: false, anchor: null,
    zeroSinceMs: null, needsZero: true, capture: null, package: null
  };
}

/** Estados en los que la estación está pesando (no hay nada en vuelo ni pausado). */
export function isArmedStatus(status: StationStatus): boolean {
  return status === "WAITING_PACKAGE" || status === "DETECTING" || status === "STABILIZING";
}

function connectivityBlock(state: Pick<StationState, "scaleConnected" | "online">): PauseReason | null {
  if (!state.scaleConnected) return "SCALE_DISCONNECTED";
  if (!state.online) return "OFFLINE";
  return null;
}

function weightPresent(state: StationState, tuning: StationTuning): boolean {
  // Sin lectura no se sabe: se asume que hay algo apoyado (el camino seguro).
  return state.grams === null || Math.abs(state.grams) > tuning.zeroToleranceGrams;
}

/** El estado con el que se vuelve a pesar después de una pausa o un cierre de ciclo. */
function armedStatus(state: StationState): StationStatus {
  if (state.needsZero) return "WAITING_REMOVAL";
  return "WAITING_PACKAGE";
}

function recent(state: StationState, atMs: number, tuning: StationTuning): boolean {
  return state.lastSampleAtMs !== null && atMs - state.lastSampleAtMs >= 0 && atMs - state.lastSampleAtMs <= tuning.maxGapMs;
}

/** Aplica una lectura al seguimiento (ancla de estabilidad y cuenta de cero). No cambia el estado de la máquina. */
function track(state: StationState, sample: { grams: number; stable: boolean | null; atMs: number }, tuning: StationTuning): StationState {
  const { grams, stable, atMs } = sample;
  // Una lectura inválida (NaN, negativa fuera de tolerancia, fuera de rango) no cuenta como evidencia: corta la estabilidad y la cuenta de cero.
  if (!Number.isFinite(grams) || grams < -tuning.zeroToleranceGrams || grams > MAX_STATION_GRAMS) {
    return { ...state, grams: null, lastSampleAtMs: atMs, scaleStable: stable, moving: true, anchor: null, zeroSinceMs: null };
  }
  if (Math.abs(grams) <= tuning.zeroToleranceGrams) {
    return { ...state, grams, lastSampleAtMs: atMs, scaleStable: stable, moving: false, anchor: null, zeroSinceMs: state.zeroSinceMs ?? atMs };
  }
  const gap = state.lastSampleAtMs === null ? Number.POSITIVE_INFINITY : atMs - state.lastSampleAtMs;
  const anchor = state.anchor;
  const sameWeight = anchor !== null && gap <= tuning.maxGapMs && Math.abs(grams - anchor.grams) <= tuning.toleranceGrams && stable !== false;
  const next = sameWeight ? { grams: anchor.grams, sinceMs: anchor.sinceMs, samples: anchor.samples + 1 } : { grams, sinceMs: atMs, samples: 1 };
  return {
    ...state, grams, lastSampleAtMs: atMs, scaleStable: stable, zeroSinceMs: null, anchor: next,
    moving: stable === false || (!sameWeight && anchor !== null)
  };
}

/** Transiciones que dependen del TIEMPO (estabilidad cumplida, cero sostenido). Se evalúa con cada lectura y con cada tick. */
function settle(state: StationState, atMs: number, options: StationOptions, newKey: () => string): StationStep {
  const { tuning } = options;
  let current = state;

  // Retorno estable a cero: libera el ciclo.
  if (current.needsZero && current.zeroSinceMs !== null && recent(current, atMs, tuning) && atMs - current.zeroSinceMs >= tuning.zeroHoldMs) {
    current = { ...current, needsZero: false, removalReason: null, status: current.status === "WAITING_REMOVAL" ? "WAITING_PACKAGE" : current.status };
  }
  if (!isArmedStatus(current.status) || current.needsZero) return { state: current, effects: [] };

  if (current.zeroSinceMs !== null || current.anchor === null || current.grams === null) {
    return { state: { ...current, status: "WAITING_PACKAGE", moving: false }, effects: [] };
  }
  const net = current.grams - tuning.tareGrams;
  if (net < tuning.minWeightGrams) return { state: { ...current, status: "DETECTING" }, effects: [] };

  const { anchor } = current;
  const stableLongEnough = anchor.samples >= 2 && atMs - anchor.sinceMs >= tuning.stableMs && recent(current, atMs, tuning) && current.scaleStable !== false && !current.moving;
  if (!stableLongEnough) return { state: { ...current, status: anchor.samples < 2 && !current.moving ? "DETECTING" : "STABILIZING" }, effects: [] };
  if (!current.ready || current.productId === null || !current.scaleConnected || !current.online) return { state: { ...current, status: "STABILIZING" }, effects: [] };

  const capture: StationCapture = { cycle: current.cycle + 1, productId: current.productId, grams: net, rawGrams: current.grams, requestKey: newKey(), attempt: 1 };
  return {
    state: { ...current, status: "REGISTERING", cycle: capture.cycle, capture, needsZero: true, removalReason: "PROCESSED", error: null, anchor: null, package: null },
    effects: [{ type: "REGISTER", cycle: capture.cycle, productId: capture.productId, grams: capture.grams, requestKey: capture.requestKey, attempt: 1 }]
  };
}

function pausedWith(state: StationState, reason: PauseReason, tuning: StationTuning, error: string | null = state.error): StationState {
  return { ...state, status: "PAUSED", pauseReason: reason, error, anchor: null, needsZero: state.needsZero || weightPresent(state, tuning), removalReason: state.needsZero ? state.removalReason : weightPresent(state, tuning) ? "PAUSED_WITH_WEIGHT" : null };
}

/** Sale de una pausa: reintenta lo que quedó a medias (registro o impresión) o vuelve a pesar. */
function leavePause(state: StationState, atMs: number, options: StationOptions, newKey: () => string): StationStep {
  const { tuning } = options;
  const block = connectivityBlock(state);
  if (block !== null) return { state: { ...state, status: "PAUSED", pauseReason: block }, effects: [] };

  if (state.capture !== null) {
    // Registro pendiente: sólo se reintenta si el MISMO paquete sigue en la balanza; si no, se descarta (nunca se imprime un peso que ya no está).
    const sameParcel = state.grams !== null && Math.abs(state.grams - state.capture.rawGrams) <= tuning.toleranceGrams && state.zeroSinceMs === null;
    if (sameParcel) {
      const attempt = state.capture.attempt + 1;
      const capture = { ...state.capture, attempt };
      return {
        state: { ...state, status: "REGISTERING", pauseReason: null, capture, error: null },
        effects: [{ type: "REGISTER", cycle: capture.cycle, productId: capture.productId, grams: capture.grams, requestKey: capture.requestKey, attempt }]
      };
    }
    const discarded: StationState = { ...state, capture: null, error: null, pauseReason: null, needsZero: true, status: "WAITING_REMOVAL", anchor: null };
    return settle(discarded, atMs, options, newKey);
  }
  if (state.package !== null && !state.package.printed && options.autoPrint) {
    return { state: { ...state, status: "PRINTING", pauseReason: null, error: null }, effects: [{ type: "PRINT", cycle: state.package.cycle, packageId: state.package.packageId }] };
  }
  const resumed: StationState = { ...state, status: armedStatus(state), pauseReason: null, error: null, anchor: null };
  return settle(resumed, atMs, options, newKey);
}

export function advanceStation(state: StationState, event: StationEvent, options: StationOptions, newKey: () => string): StationStep {
  const { tuning } = options;
  switch (event.type) {
    case "SAMPLE": {
      const tracked = track(state, event, tuning);
      return settle(tracked, event.atMs, options, newKey);
    }
    case "TICK":
      return settle(state, event.atMs, options, newKey);

    case "SCALE_CONNECTION": {
      if (event.connected === state.scaleConnected) return { state, effects: [] };
      if (event.connected) {
        // Al (re)conectar no se sabe qué hay sobre la balanza: se exige ver el cero antes de aceptar un paquete.
        const base: StationState = { ...state, scaleConnected: true, grams: null, lastSampleAtMs: null, anchor: null, zeroSinceMs: null, needsZero: true, removalReason: "RECONNECTED" };
        if (base.status === "PAUSED" && (base.pauseReason === "SCALE_DISCONNECTED" || base.pauseReason === "OFFLINE")) return leavePause(base, event.atMs, options, newKey);
        return { state: base, effects: [] };
      }
      const lost: StationState = { ...state, scaleConnected: false, grams: null, lastSampleAtMs: null, anchor: null, zeroSinceMs: null, moving: false };
      if (isArmedStatus(lost.status)) return { state: { ...lost, status: "PAUSED", pauseReason: "SCALE_DISCONNECTED", needsZero: state.needsZero || weightPresent(state, tuning) }, effects: [] };
      if (lost.status === "WAITING_REMOVAL") return { state: { ...lost, status: "PAUSED", pauseReason: "SCALE_DISCONNECTED", needsZero: true }, effects: [] };
      // REGISTERING / PRINTING / PAUSED: la operación en vuelo termina sola y al volver el resultado se pausa.
      return { state: lost, effects: [] };
    }

    case "ONLINE": {
      if (event.online === state.online) return { state, effects: [] };
      if (event.online) {
        const back: StationState = { ...state, online: true };
        if (back.status === "PAUSED" && (back.pauseReason === "OFFLINE" || back.pauseReason === "SCALE_DISCONNECTED")) return leavePause(back, event.atMs, options, newKey);
        return { state: back, effects: [] };
      }
      const offline: StationState = { ...state, online: false };
      if (isArmedStatus(offline.status) || offline.status === "WAITING_REMOVAL") return { state: pausedWith(offline, "OFFLINE", tuning), effects: [] };
      return { state: offline, effects: [] };
    }

    case "PRODUCT_SELECTED": {
      if (event.productId === state.productId) return { state, effects: [] };
      // Cambiar de producto con peso sobre la balanza: el paquete que está ahí NO se registra con el producto nuevo. Hay que verlo volver a cero.
      const withWeight = weightPresent(state, tuning);
      const changed: StationState = { ...state, productId: event.productId, anchor: null, error: state.status === "PAUSED" ? state.error : null };
      if (!withWeight) return settle(changed, event.atMs, options, newKey);
      const guarded: StationState = { ...changed, needsZero: true, removalReason: state.needsZero ? state.removalReason : "PRODUCT_CHANGED" };
      return { state: isArmedStatus(guarded.status) ? { ...guarded, status: "WAITING_REMOVAL", moving: false } : guarded, effects: [] };
    }

    case "READY": {
      if (event.ready === state.ready) return { state, effects: [] };
      return settle({ ...state, ready: event.ready }, event.atMs, options, newKey);
    }

    case "PAUSE": {
      if (state.status === "PAUSED") return { state: { ...state, pauseReason: state.pauseReason ?? "MANUAL" }, effects: [] };
      if (state.status === "REGISTERING" || state.status === "PRINTING") return { state: { ...state, status: "PAUSED", pauseReason: "MANUAL" }, effects: [] };
      return { state: pausedWith(state, "MANUAL", tuning, null), effects: [] };
    }

    case "RESUME":
    case "RETRY": {
      if (state.status !== "PAUSED") return { state, effects: [] };
      return leavePause(state, event.atMs, options, newKey);
    }

    case "SKIP_PRINT": {
      // «Continuar sin imprimir»: el paquete queda registrado (se reimprime desde el historial) y la producción sigue.
      if (state.status !== "PAUSED" || state.package === null || state.package.printed) return { state, effects: [] };
      return leavePause({ ...state, package: null, capture: null }, event.atMs, options, newKey);
    }

    case "REGISTER_OK": {
      if (state.capture?.cycle !== event.cycle) return { state, effects: [] };
      const reference: StationPackageRef = { cycle: event.cycle, packageId: event.packageId, printed: false };
      const registered: StationState = { ...state, capture: null, package: reference, error: null };
      if (registered.status !== "REGISTERING") return { state: registered, effects: [] }; // pausado mientras tanto: se imprime al reanudar
      if (!options.autoPrint) return finishCycle(registered, event.atMs, options, newKey);
      return { state: { ...registered, status: "PRINTING" }, effects: [{ type: "PRINT", cycle: event.cycle, packageId: event.packageId }] };
    }

    case "REGISTER_FAILED": {
      if (state.capture?.cycle !== event.cycle) return { state, effects: [] };
      if (state.status !== "REGISTERING") return { state: { ...state, error: event.error }, effects: [] };
      const reason = connectivityBlock(state) ?? "REGISTER_FAILED";
      return { state: { ...state, status: "PAUSED", pauseReason: reason, error: event.error }, effects: [] };
    }

    case "PRINT_OK": {
      if (state.package?.cycle !== event.cycle || state.package.printed) return { state, effects: [] };
      const printed: StationState = { ...state, package: { ...state.package, printed: true }, error: null };
      // Una reimpresión que sale bien también resuelve la pausa causada por el fallo de impresión.
      if (printed.status !== "PRINTING" && !(printed.status === "PAUSED" && printed.pauseReason === "PRINT_FAILED")) return { state: printed, effects: [] };
      return finishCycle({ ...printed, error: null }, event.atMs, options, newKey);
    }

    case "PRINT_FAILED": {
      if (state.package?.cycle !== event.cycle || state.package.printed) return { state, effects: [] };
      if (state.status !== "PRINTING") return { state: { ...state, error: event.error }, effects: [] };
      return { state: { ...state, status: "PAUSED", pauseReason: "PRINT_FAILED", error: event.error }, effects: [] };
    }
  }
}

/**
 * Cierra el ciclo: a esperar el retiro (o pausar si mientras tanto se perdió la balanza o Internet). `needsZero` NO se vuelve a levantar acá: si el
 * operario ya retiró el paquete mientras se imprimía (cero sostenido) la estación queda lista para el siguiente sin pedirle nada.
 */
function finishCycle(state: StationState, atMs: number, options: StationOptions, newKey: () => string): StationStep {
  const block = connectivityBlock(state);
  const removalReason = state.needsZero ? "PROCESSED" : null;
  if (block !== null) return { state: { ...state, status: "PAUSED", pauseReason: block, removalReason }, effects: [] };
  return settle({ ...state, status: state.needsZero ? "WAITING_REMOVAL" : "WAITING_PACKAGE", removalReason, pauseReason: null }, atMs, options, newKey);
}

/** Texto corto de cada estado para la pantalla. */
export const STATION_STATUS_LABELS: Record<StationStatus, string> = {
  WAITING_PACKAGE: "Esperando paquete",
  DETECTING: "Paquete detectado",
  STABILIZING: "Estabilizando",
  REGISTERING: "Registrando",
  PRINTING: "Imprimiendo",
  WAITING_REMOVAL: "Retirar paquete",
  PAUSED: "Pausado"
};

export const STATION_PAUSE_LABELS: Record<PauseReason, string> = {
  MANUAL: "Pausado por el operario",
  SCALE_DISCONNECTED: "Balanza desconectada",
  OFFLINE: "Sin conexión con el servidor",
  REGISTER_FAILED: "No se pudo registrar el paquete",
  PRINT_FAILED: "No se pudo imprimir"
};
