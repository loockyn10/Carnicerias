import { describe, expect, it } from "vitest";

import { emptyScanBuffer, feedScanKey, isEditableTarget, SCAN_MAX_KEY_GAP_MS, type ScanBuffer } from "./scanner";

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
