export const SCALE_KINDS = ["MANUAL", "SIMULATED", "KRETZ_NOVEL_ECO_2"] as const;
export type ScaleKind = (typeof SCALE_KINDS)[number];

export const SCALE_CONNECTION_STATES = ["DISCONNECTED", "CONNECTING", "CONNECTED", "ERROR"] as const;
export type ScaleConnectionState = (typeof SCALE_CONNECTION_STATES)[number];

export interface ScaleReading {
  grams: number;
  receivedAt: string;
}

/**
 * The KRETZ Novel Eco 2 manual documents ~2 transmissions per second while
 * the net weight is stable, so a reading a few seconds old already means
 * either the scale stopped transmitting or was disconnected. Chosen to be
 * comfortably longer than one transmission cycle without letting a
 * previous customer's weight linger on screen.
 */
export const SCALE_READING_TTL_MS = 4_000;

/**
 * A reading is only usable for a new sale line while the scale is actively
 * `CONNECTED` and the reading arrived within the TTL. This is what keeps a
 * stale reading (from before a disconnect, or simply old) from being
 * reused for the next customer.
 */
export function isScaleReadingFresh(
  connectionState: ScaleConnectionState,
  reading: ScaleReading | null,
  now: number,
  ttlMs: number = SCALE_READING_TTL_MS
): boolean {
  if (connectionState !== "CONNECTED" || reading === null) return false;
  const receivedAtMs = new Date(reading.receivedAt).getTime();
  if (!Number.isFinite(receivedAtMs)) return false;
  const age = now - receivedAtMs;
  return age >= 0 && age <= ttlMs;
}

/**
 * Auto-confirm state machine for a WEIGHT sale line (see
 * `docs/SCALE_INTEGRATION.md`, "auto-confirmación"). Deliberately does not
 * depend on any wall-clock polling ("now"): the only timestamps it compares
 * are the scale readings' own `receivedAt`, driven entirely by the
 * `scale://update` event stream. An earlier design compared readings
 * against a separately-`setInterval`-ticked clock, which raced the
 * event-driven readings and made the "reading is usable" check flip
 * true/false on almost every new sample (visible as ~2 Hz UI flicker,
 * roughly the scale's own transmission rate) — comparing readings only to
 * each other removes that race by construction.
 */
export type WeightStabilityStatus = "WAITING" | "STABILIZING" | "STABLE";

export interface WeightStabilityState {
  status: WeightStabilityStatus;
  grams: number | null;
  /** Timestamp (ms) of the earliest reading in the current stable run. */
  anchorAtMs: number | null;
}

/** Target ~500-700 ms of continuous stability before auto-confirming. */
export const WEIGHT_STABILITY_WINDOW_MS = 600;
/** A few grams of jitter is normal on a mechanical scale; not a redesign knob. */
export const WEIGHT_STABILITY_TOLERANCE_GRAMS = 3;

export function initialWeightStabilityState(): WeightStabilityState {
  return { status: "WAITING", grams: null, anchorAtMs: null };
}

export type WeightStabilityEvent =
  | { type: "READING"; grams: number; receivedAtMs: number; openedAtMs: number }
  | { type: "DISCONNECTED" }
  | { type: "CLOSED" };

/**
 * Pure reducer: feed one event, get the next state. Once `status` reaches
 * `"STABLE"` the state is latched — every later event (including more
 * readings) is a no-op returning the exact same object — until a `CLOSED`
 * event resets it for the next modal open. This is what guarantees a line
 * auto-confirms at most once per modal session without any extra
 * "already confirmed" flag: the caller can safely re-dispatch every
 * incoming reading and only needs to act the first time `status` becomes
 * `"STABLE"`.
 */
export function advanceWeightStability(
  state: WeightStabilityState,
  event: WeightStabilityEvent,
  options: { windowMs?: number; toleranceGrams?: number } = {}
): WeightStabilityState {
  if (state.status === "STABLE") return state;
  if (event.type === "CLOSED") return initialWeightStabilityState();
  if (event.type === "DISCONNECTED") return initialWeightStabilityState();

  // A reading timestamped at/before the modal's own open time is either a
  // stale leftover from before this customer or a clock artifact; never
  // lets it seed or extend a stable run.
  if (event.receivedAtMs <= event.openedAtMs) return state;
  // An empty platform (0 g) or a malformed sample never counts as progress.
  if (!Number.isFinite(event.grams) || event.grams <= 0) return initialWeightStabilityState();

  const windowMs = options.windowMs ?? WEIGHT_STABILITY_WINDOW_MS;
  const toleranceGrams = options.toleranceGrams ?? WEIGHT_STABILITY_TOLERANCE_GRAMS;

  if (state.grams === null || Math.abs(event.grams - state.grams) > toleranceGrams) {
    // Outside tolerance of the current run's anchor: start a fresh run
    // rather than comparing only to the immediately previous reading, so a
    // slow drift can't sneak past tolerance one small step at a time.
    return { status: "STABILIZING", grams: event.grams, anchorAtMs: event.receivedAtMs };
  }

  const elapsed = event.receivedAtMs - (state.anchorAtMs ?? event.receivedAtMs);
  if (elapsed >= windowMs) {
    return { status: "STABLE", grams: event.grams, anchorAtMs: state.anchorAtMs };
  }
  return { status: "STABILIZING", grams: event.grams, anchorAtMs: state.anchorAtMs };
}
