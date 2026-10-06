import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST_SALE_TOAST_MS, scheduleToastDismiss } from "./toast-timer";

describe("scheduleToastDismiss", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("dismisses after exactly 5 seconds", () => {
    const dismiss = vi.fn();
    scheduleToastDismiss(dismiss);
    vi.advanceTimersByTime(POST_SALE_TOAST_MS - 1);
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(POST_SALE_TOAST_MS).toBe(5_000);
  });

  it("cancelling (× pressed, unmount) never fires the dismissal", () => {
    const dismiss = vi.fn();
    const cancel = scheduleToastDismiss(dismiss);
    vi.advanceTimersByTime(2_000);
    cancel();
    vi.advanceTimersByTime(10_000);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("a new notification replaces the old timer: no stale timer is left behind", () => {
    const first = vi.fn();
    const second = vi.fn();
    const cancelFirst = scheduleToastDismiss(first);
    vi.advanceTimersByTime(3_000);
    cancelFirst(); // what the effect cleanup does when the notification changes
    scheduleToastDismiss(second);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(4_999); // 7,999 ms since the first one: it must not have fired
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
