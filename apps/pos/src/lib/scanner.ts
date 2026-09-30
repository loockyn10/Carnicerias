/**
 * USB/HID barcode scanners behave as a keyboard: they type the code in a burst (a few ms between
 * keys) and finish with Enter. A person typing is far slower. `feedScanKey` tells them apart purely
 * by inter-key timing, so nothing is captured from normal typing and no scanner configuration is
 * required. Pure (no DOM, no timers): the caller passes the event time.
 */

/** Max gap between two keys of the same scan. Scanners are typically <= 30 ms/key; 80 ms leaves
 * headroom for slow USB hubs without letting human typing look like a scan. */
export const SCAN_MAX_KEY_GAP_MS = 80;
/** Shortest code treated as a scan (shorter bursts are noise: a double keypress, etc.). */
export const SCAN_MIN_LENGTH = 3;
export const SCAN_MAX_LENGTH = 64;

export interface ScanBuffer {
  chars: string;
  lastKeyAt: number | null;
}

export function emptyScanBuffer(): ScanBuffer {
  return { chars: "", lastKeyAt: null };
}

export interface ScanKeyResult {
  buffer: ScanBuffer;
  /** The completed scan, present only on the Enter that ends a valid burst. */
  scan: string | null;
}

export function feedScanKey(buffer: ScanBuffer, key: string, now: number): ScanKeyResult {
  if (key === "Enter") {
    const fast = buffer.lastKeyAt !== null && now - buffer.lastKeyAt <= SCAN_MAX_KEY_GAP_MS;
    const valid = buffer.chars.length >= SCAN_MIN_LENGTH && buffer.chars.length <= SCAN_MAX_LENGTH && fast;
    return { buffer: emptyScanBuffer(), scan: valid ? buffer.chars : null };
  }
  if (key.length !== 1) return { buffer, scan: null }; // Shift, Control, arrows... do not break a burst
  const continuing = buffer.lastKeyAt !== null && now - buffer.lastKeyAt <= SCAN_MAX_KEY_GAP_MS;
  const chars = (continuing ? buffer.chars : "") + key;
  return { buffer: { chars: chars.slice(-(SCAN_MAX_LENGTH + 1)), lastKeyAt: now }, scan: null };
}

/** True when the keyboard event target is somewhere the user is typing on purpose. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!element?.tagName) return false;
  const tag = element.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable === true;
}
