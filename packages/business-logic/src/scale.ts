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
