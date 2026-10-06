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

export interface RoutedKey {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  /** The event target is a field where the user is typing on purpose (see `isEditableTarget`). */
  editableTarget: boolean;
  /** "Type to search" may take the focus now (main screen: no modal, no other field in use). */
  typeAheadAllowed: boolean;
}

export interface RoutedKeyResult {
  buffer: ScanBuffer;
  scan: string | null;
  /** True when `buffer.chars` may be a person starting to type: the caller arms a `SCAN_MAX_KEY_GAP_MS` timer and,
   * if no further key arrives, hands `flushTypeAhead(buffer)` to the search box. Any other result cancels that timer. */
  pending: boolean;
}

/**
 * The single router for keys that land outside an input. A burst of printable keys is held back (never typed
 * anywhere) until it is known whether it is a scanner: a burst ended by a fast Enter is a scan; one that just stops
 * is a person typing, and `flushTypeAhead` gives the held text to the search box so no first letter is lost.
 */
export function routeKey(buffer: ScanBuffer, input: RoutedKey, now: number): RoutedKeyResult {
  if (input.ctrlKey || input.altKey || input.metaKey || input.repeat) return { buffer, scan: null, pending: false };
  if (input.editableTarget) return { buffer: emptyScanBuffer(), scan: null, pending: false };
  const result = feedScanKey(buffer, input.key, now);
  const pending = input.typeAheadAllowed && input.key.length === 1 && result.buffer.chars.trim() !== "";
  return { buffer: result.buffer, scan: result.scan, pending };
}

/** The text a person typed on the main screen (leading spaces dropped), or null when there is nothing to hand over. */
export function flushTypeAhead(buffer: ScanBuffer): { text: string | null; buffer: ScanBuffer } {
  const text = buffer.chars.replace(/^\s+/, "");
  return { text: text === "" ? null : text, buffer: emptyScanBuffer() };
}
