import { describe, expect, it } from "vitest";

import { initialPlayerState, isSlideLive, playerReducer, pruneExpired, visibleSlideCount } from "./signage-player";
import { signageView, slideOffer } from "./test-support/signage-fixtures";

describe("vigencia en el televisor: una promoción vencida no sigue en pantalla aunque se corte Internet (D-086)", () => {
  const NOW = Date.parse("2026-10-15T12:00:00Z");
  const expiring = (key: string, validUntil: string | null) => slideOffer(key, `Producto ${key}`, "1.000", { validUntil });

  it("isSlideLive: sin fin o con fecha futura sigue; con fecha pasada, no; una fecha ilegible se conserva", () => {
    expect(isSlideLive({ validUntil: null }, NOW)).toBe(true);
    expect(isSlideLive({ validUntil: "2026-10-16T00:00:00Z" }, NOW)).toBe(true);
    expect(isSlideLive({ validUntil: "2026-10-15T12:00:00Z" }, NOW)).toBe(false);
    expect(isSlideLive({ validUntil: "2026-10-14T00:00:00Z" }, NOW)).toBe(false);
    expect(isSlideLive({ validUntil: "nunca" }, NOW)).toBe(true);
  });

  it("al rotar retira la que venció y sigue con las demás (sin conexión, sin esperar a la próxima consulta)", () => {
    let state = initialPlayerState(signageView([expiring("a", null), expiring("b", "2026-10-15T11:59:00Z"), expiring("c", "2026-10-20T00:00:00Z")]));
    const seen: string[] = [];
    for (let step = 0; step < 4; step++) {
      state = playerReducer(state, { type: "ADVANCE", now: NOW });
      seen.push(state.view?.slides[state.index]?.key ?? "?");
    }
    expect(seen).toEqual(["c", "a", "c", "a"]);
    expect(state.view?.slides.map((slide) => slide.key)).toEqual(["a", "c"]);
  });

  it("un fallo de consulta también retira lo vencido y marca la pantalla como desactualizada", () => {
    const state = playerReducer(
      initialPlayerState(signageView([expiring("a", "2026-10-15T11:00:00Z"), expiring("b", null)])),
      { type: "REFRESHED", result: { kind: "error" }, now: NOW }
    );
    expect(state.stale).toBe(true);
    expect(state.view?.slides.map((slide) => slide.key)).toEqual(["b"]);
  });

  it("si vencen todas, la pantalla queda en espera (sin ofertas) y no muestra una promoción vencida", () => {
    const state = pruneExpired(initialPlayerState(signageView([expiring("a", "2026-10-01T00:00:00Z")])), NOW);
    expect(visibleSlideCount(state)).toBe(0);
  });

  it("la oferta que se está mostrando sigue en pantalla si no venció aunque otra sí", () => {
    const state = pruneExpired({ ...initialPlayerState(signageView([expiring("a", "2026-10-01T00:00:00Z"), expiring("b", null), expiring("c", null)])), index: 2 }, NOW);
    expect(state.view?.slides[state.index]?.key).toBe("c");
  });

  it("sin reloj (acciones sin now) no toca nada: el comportamiento anterior se conserva", () => {
    const base = initialPlayerState(signageView([expiring("a", "2026-10-01T00:00:00Z")]));
    expect(playerReducer(base, { type: "ADVANCE" })).toBe(base);
  });
});
