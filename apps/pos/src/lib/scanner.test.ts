import { describe, expect, it } from "vitest";

import { emptyScanBuffer, feedScanKey, flushTypeAhead, isEditableTarget, routeKey, SCAN_MAX_KEY_GAP_MS, type ScanBuffer } from "./scanner";

function type(keys: string, startAt: number, gapMs: number, from: ScanBuffer = emptyScanBuffer()) {
  let buffer = from;
  let now = startAt;
  for (const key of Array.from(keys)) {
    buffer = feedScanKey(buffer, key, now).buffer;
    now += gapMs;
  }
  return { buffer, endsAt: now };
}

describe("feedScanKey", () => {
  it("recognizes a burst of characters ended by Enter as one scan", () => {
    const burst = type("7790895000010", 1_000, 10);
    expect(feedScanKey(burst.buffer, "Enter", burst.endsAt).scan).toBe("7790895000010");
  });

  it("does not treat human-speed typing as a scan", () => {
    const slow = type("7790895000010", 1_000, SCAN_MAX_KEY_GAP_MS + 120);
    expect(feedScanKey(slow.buffer, "Enter", slow.endsAt).scan).toBeNull();
  });

  it("ignores a burst that is too short (noise)", () => {
    const burst = type("12", 1_000, 5);
    expect(feedScanKey(burst.buffer, "Enter", burst.endsAt).scan).toBeNull();
  });

  it("does not fire on an Enter that comes long after the last character", () => {
    const burst = type("7790895000010", 1_000, 5);
    expect(feedScanKey(burst.buffer, "Enter", burst.endsAt + 2_000).scan).toBeNull();
  });

  it("keeps the burst alive across modifier keys (Shift for upper-case letters)", () => {
    const first = type("AB", 1_000, 5);
    const shifted = feedScanKey(first.buffer, "Shift", first.endsAt).buffer;
    const rest = type("C12", first.endsAt + 5, 5, shifted);
    expect(feedScanKey(rest.buffer, "Enter", rest.endsAt).scan).toBe("ABC12");
  });

  it("two consecutive scans are independent", () => {
    const first = type("7790895000010", 1_000, 5);
    const done = feedScanKey(first.buffer, "Enter", first.endsAt);
    expect(done.scan).toBe("7790895000010");
    const second = type("7791111111111", first.endsAt + 500, 5, done.buffer);
    expect(feedScanKey(second.buffer, "Enter", second.endsAt).scan).toBe("7791111111111");
  });

  it("stray human keys before a scan do not leak into it", () => {
    const stray = type("xy", 1_000, 5);
    const burst = type("7790895000010", stray.endsAt + 2_000, 5, stray.buffer);
    expect(feedScanKey(burst.buffer, "Enter", burst.endsAt).scan).toBe("7790895000010");
  });
});

describe("isEditableTarget", () => {
  it("is true for inputs/textareas/selects and false for buttons or nothing", () => {
    expect(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "textarea" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("routeKey (scanner vs. escribir para buscar)", () => {
  const base = { ctrlKey: false, altKey: false, metaKey: false, repeat: false, editableTarget: false, typeAheadAllowed: true };
  function press(keys: string[], startAt: number, gapMs: number, extra: Partial<typeof base> = {}) {
    let buffer = emptyScanBuffer();
    let now = startAt;
    let last = { buffer, scan: null as string | null, pending: false };
    for (const key of keys) {
      last = routeKey(buffer, { ...base, ...extra, key }, now);
      buffer = last.buffer;
      now += gapMs;
    }
    return last;
  }

  it("un barcode (ráfaga + Enter rápido) es un scan y nunca queda pendiente para el buscador", () => {
    const result = press([...Array.from("7790895000010"), "Enter"], 1_000, 10);
    expect(result.scan).toBe("7790895000010");
    expect(result.pending).toBe(false);
  });

  it("mientras la ráfaga sigue está pendiente, sin escribirse en ningún lado", () => {
    const result = press(Array.from("779089"), 1_000, 10);
    expect(result.scan).toBeNull();
    expect(result.pending).toBe(true);
  });

  it("una persona escribiendo 'moli' queda pendiente y flushTypeAhead entrega el texto completo (no se pierde la primera letra)", () => {
    const result = press(Array.from("moli"), 1_000, 40);
    expect(result.pending).toBe(true);
    const flushed = flushTypeAhead(result.buffer);
    expect(flushed.text).toBe("moli");
    expect(flushed.buffer).toEqual(emptyScanBuffer());
  });

  it("no hay type-ahead si la pantalla no lo permite (modal abierto)", () => {
    expect(press(Array.from("moli"), 1_000, 40, { typeAheadAllowed: false }).pending).toBe(false);
  });

  it("escribir dentro de otro input no roba foco ni deja nada retenido", () => {
    const result = press(Array.from("moli"), 1_000, 40, { editableTarget: true });
    expect(result).toEqual({ buffer: emptyScanBuffer(), scan: null, pending: false });
  });

  it("Escape, Tab, Enter, F-keys, flechas, Shift y Backspace no inician una búsqueda", () => {
    for (const key of ["Escape", "Tab", "Enter", "F5", "ArrowDown", "Shift", "Backspace"]) {
      expect(press([key], 1_000, 10).pending).toBe(false);
    }
  });

  it("atajos con Ctrl/Alt/Meta y teclas repetidas se ignoran", () => {
    expect(press(["a"], 1_000, 10, { ctrlKey: true }).pending).toBe(false);
    expect(press(["a"], 1_000, 10, { altKey: true }).pending).toBe(false);
    expect(press(["a"], 1_000, 10, { metaKey: true }).pending).toBe(false);
    expect(press(["a"], 1_000, 10, { repeat: true }).pending).toBe(false);
  });

  it("un espacio solo no abre el buscador y los espacios iniciales se descartan", () => {
    expect(press([" "], 1_000, 10).pending).toBe(false);
    expect(flushTypeAhead({ chars: "  vacio", lastKeyAt: 1 }).text).toBe("vacio");
    expect(flushTypeAhead({ chars: "  ", lastKeyAt: 1 }).text).toBeNull();
  });
});
