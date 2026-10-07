import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfferSlideData, SignageView } from "./signage";
import {
  fetchSignageView, initialPlayerState, nextPollDelay, nextSlideIndex, playerReducer, SIGNAGE_POLL_MS, SIGNAGE_RETRY_MS, visibleSlideCount, type FetchLike
} from "./signage-player";

const offer = (key: string, whole = "1.000"): OfferSlideData => ({
  key, variant: "REGULAR", name: `Producto ${key}`, price: { whole, cents: null }, priceSuffix: null, condition: "PRECIO UNITARIO", secondary: null, promo: false, nameFit: 1
});
const view = (keys: string[], overrides: Partial<SignageView> = {}): SignageView => ({
  status: "ACTIVE", slideDurationSeconds: 8, organizationName: "Despensa", slides: keys.map((key) => offer(key)), ...overrides
});

describe("slideshow: bucle infinito", () => {
  it("después de la última oferta vuelve a la primera, indefinidamente", () => {
    let state = initialPlayerState(view(["a", "b", "c"]));
    const seen: string[] = [];
    for (let step = 0; step < 7; step++) {
      seen.push(state.view?.slides[state.index]?.key ?? "?");
      state = playerReducer(state, { type: "ADVANCE" });
    }
    expect(seen).toEqual(["a", "b", "c", "a", "b", "c", "a"]);
  });

  it("nextSlideIndex da la vuelta y tolera listas vacías", () => {
    expect(nextSlideIndex(0, 3)).toBe(1);
    expect(nextSlideIndex(2, 3)).toBe(0);
    expect(nextSlideIndex(0, 1)).toBe(0);
    expect(nextSlideIndex(5, 0)).toBe(0);
  });

  it("con una sola oferta o ninguna no hay nada que rotar", () => {
    const one = initialPlayerState(view(["a"]));
    expect(playerReducer(one, { type: "ADVANCE" })).toBe(one);
    const none = initialPlayerState(view([]));
    expect(playerReducer(none, { type: "ADVANCE" })).toBe(none);
    expect(playerReducer(initialPlayerState(null), { type: "ADVANCE" }).index).toBe(0);
  });
});

describe("estado vacío", () => {
  it("sin datos, sin ofertas o desactivada: cero slides visibles (pantalla de espera)", () => {
    expect(visibleSlideCount(initialPlayerState(null))).toBe(0);
    expect(visibleSlideCount(initialPlayerState(view([])))).toBe(0);
    expect(visibleSlideCount(initialPlayerState(view([], { status: "DISABLED" })))).toBe(0);
  });

  it("al publicarse la primera oferta, la pantalla de espera pasa a mostrarla sola", () => {
    const waiting = initialPlayerState(view([]));
    const next = playerReducer(waiting, { type: "REFRESHED", result: { kind: "ok", view: view(["a"]) } });
    expect(visibleSlideCount(next)).toBe(1);
    expect(next.view?.slides[0]?.key).toBe("a");
  });
});

describe("polling: conserva el último estado válido ante un error", () => {
  it("un fallo de red NO borra las ofertas que ya estaban en memoria", () => {
    const state = initialPlayerState(view(["a", "b"]));
    const failed = playerReducer(state, { type: "REFRESHED", result: { kind: "error" } });
    expect(failed.view).toBe(state.view);
    expect(failed.revoked).toBe(false);
    expect(failed.stale).toBe(true);
    expect(visibleSlideCount(failed)).toBe(2);
    // y se sigue rotando mientras no hay conexión
    expect(playerReducer(failed, { type: "ADVANCE" }).index).toBe(1);
  });

  it("varios fallos seguidos no cambian nada más; el primer éxito lo recupera", () => {
    let state = initialPlayerState(view(["a"]));
    state = playerReducer(state, { type: "REFRESHED", result: { kind: "error" } });
    const again = playerReducer(state, { type: "REFRESHED", result: { kind: "error" } });
    expect(again).toBe(state);
    const recovered = playerReducer(again, { type: "REFRESHED", result: { kind: "ok", view: view(["a", "b"]) } });
    expect(recovered.stale).toBe(false);
    expect(visibleSlideCount(recovered)).toBe(2);
  });

  it("si nunca hubo datos y falla, sigue en espera (nunca un error)", () => {
    const state = playerReducer(initialPlayerState(null), { type: "REFRESHED", result: { kind: "error" } });
    expect(state.view).toBeNull();
    expect(visibleSlideCount(state)).toBe(0);
    expect(state.revoked).toBe(false);
  });

  it("una consulta sin cambios no genera un estado nuevo (no re-renderiza)", () => {
    const state = initialPlayerState(view(["a", "b"]));
    expect(playerReducer(state, { type: "REFRESHED", result: { kind: "ok", view: view(["a", "b"]) } })).toBe(state);
  });

  it("reintenta antes tras un fallo y con el ritmo normal tras un éxito", () => {
    expect(nextPollDelay("ok")).toBe(SIGNAGE_POLL_MS);
    expect(nextPollDelay("error")).toBe(SIGNAGE_RETRY_MS);
    expect(SIGNAGE_POLL_MS).toBe(30_000);
    expect(SIGNAGE_RETRY_MS).toBeLessThan(SIGNAGE_POLL_MS);
  });
});

describe("actualización automática sin recargar", () => {
  it("cambió la duración: se aplica en la próxima consulta", () => {
    const state = initialPlayerState(view(["a", "b"]));
    const next = playerReducer(state, { type: "REFRESHED", result: { kind: "ok", view: view(["a", "b"], { slideDurationSeconds: 20 }) } });
    expect(next.view?.slideDurationSeconds).toBe(20);
  });

  it("cambió el orden: sigue en la oferta que estaba mostrando, en su nueva posición", () => {
    let state = initialPlayerState(view(["a", "b", "c"]));
    state = playerReducer(state, { type: "ADVANCE" }); // mostrando "b"
    const next = playerReducer(state, { type: "REFRESHED", result: { kind: "ok", view: view(["c", "b", "a"]) } });
    expect(next.view?.slides[next.index]?.key).toBe("b");
    expect(next.index).toBe(1);
  });

  it("se quitó la oferta visible: no se pierde el avance ni se sale de rango", () => {
    let state = initialPlayerState(view(["a", "b", "c"]));
    state = playerReducer(playerReducer(state, { type: "ADVANCE" }), { type: "ADVANCE" }); // "c"
    const next = playerReducer(state, { type: "REFRESHED", result: { kind: "ok", view: view(["a", "b"]) } });
    expect(next.index).toBe(1);
    expect(next.view?.slides[next.index]).toBeDefined();
    expect(playerReducer(next, { type: "REFRESHED", result: { kind: "ok", view: view([]) } }).index).toBe(0);
  });

  it("cambió un precio: la oferta nueva reemplaza a la vieja", () => {
    const state = initialPlayerState({ ...view(["a"]), slides: [offer("a", "1.000")] });
    const next = playerReducer(state, { type: "REFRESHED", result: { kind: "ok", view: { ...view(["a"]), slides: [offer("a", "1.250")] } } });
    expect(next.view?.slides[0]?.price.whole).toBe("1.250");
  });

  it("enlace regenerado (404 definitivo): se retira la presentación y se muestra un cartel neutro", () => {
    const state = initialPlayerState(view(["a", "b"]));
    const revoked = playerReducer(state, { type: "REFRESHED", result: { kind: "not_found" } });
    expect(revoked.revoked).toBe(true);
    expect(revoked.view).toBeNull();
    expect(visibleSlideCount(revoked)).toBe(0);
  });
});

describe("fetchSignageView (cliente del televisor)", () => {
  afterEach(() => { vi.useRealTimers(); });
  const body = (slides: unknown[] = [{ key: "a", name: "A", condition: "PRECIO UNITARIO", price: { whole: "1.000", cents: null } }]) =>
    ({ status: "ACTIVE", slideDurationSeconds: 8, organizationName: "Despensa", slides });
  const respond = (status: number, json: unknown): FetchLike => () => Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(json) });

  it("200 con una presentación válida", async () => {
    const result = await fetchSignageView("/api/tv/x", respond(200, body()));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.view.slides).toHaveLength(1);
  });

  it("404 es definitivo (enlace inexistente o regenerado)", async () => {
    expect((await fetchSignageView("/api/tv/x", respond(404, { error: "not_found" }))).kind).toBe("not_found");
  });

  it("5xx, red caída, JSON inválido y forma inesperada son fallos transitorios (nunca lanza)", async () => {
    expect((await fetchSignageView("/api/tv/x", respond(503, {}))).kind).toBe("error");
    expect((await fetchSignageView("/api/tv/x", () => Promise.reject(new TypeError("Failed to fetch")))).kind).toBe("error");
    expect((await fetchSignageView("/api/tv/x", () => Promise.resolve({ status: 200, ok: true, json: () => Promise.reject(new SyntaxError("bad json")) }))).kind).toBe("error");
    expect((await fetchSignageView("/api/tv/x", respond(200, "hola"))).kind).toBe("error");
    expect((await fetchSignageView("/api/tv/x", respond(200, { status: "ACTIVE" }))).kind).toBe("error");
  });

  it("descarta los slides con forma inválida y corrige una duración fuera de rango", async () => {
    const result = await fetchSignageView("/api/tv/x", respond(200, { ...body([null, { key: 3 }, { key: "ok", name: "Ok", condition: "X", price: { whole: "5", cents: null } }]), slideDurationSeconds: 0 }));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.view.slides.map((slide) => slide.key)).toEqual(["ok"]);
      expect(result.view.slideDurationSeconds).toBe(3);
    }
  });

  it("una pantalla desactivada llega sin slides", async () => {
    const result = await fetchSignageView("/api/tv/x", respond(200, { ...body(), status: "DISABLED" }));
    expect(result.kind === "ok" && result.view.slides).toEqual([]);
  });

  it("un pedido colgado se corta por timeout y cuenta como fallo", async () => {
    vi.useFakeTimers();
    const hung: FetchLike = (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { reject(new DOMException("aborted", "AbortError")); }); });
    const pending = fetchSignageView("/api/tv/x", hung, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).kind).toBe("error");
  });

  it("pide siempre sin caché", async () => {
    const spy = vi.fn<FetchLike>(respond(200, body()));
    await fetchSignageView("/api/tv/x", spy);
    expect(spy.mock.calls[0]?.[1]?.cache).toBe("no-store");
  });
});
