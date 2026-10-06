import { describe, expect, it, vi } from "vitest";

import { resetSearchForNextProduct } from "./search-focus";

describe("resetSearchForNextProduct", () => {
  it("limpia la búsqueda y enfoca el input después de que React cerró el modal", () => {
    const calls: string[] = [];
    let deferred: (() => void) | null = null;
    resetSearchForNextProduct(
      () => calls.push("clear"),
      () => ({ focus: () => calls.push("focus") }),
      (callback) => { deferred = callback; }
    );
    expect(calls).toEqual(["clear"]); // el foco espera al commit
    (deferred as (() => void) | null)?.();
    expect(calls).toEqual(["clear", "focus"]);
  });

  it("no falla si el buscador no está montado", () => {
    const clear = vi.fn();
    expect(() => resetSearchForNextProduct(clear, () => null, (callback) => callback())).not.toThrow();
    expect(clear).toHaveBeenCalled();
  });
});
