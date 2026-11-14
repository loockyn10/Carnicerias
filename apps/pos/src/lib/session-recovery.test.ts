import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLOCK_SKEW_WARNING_MS,
  classifyAuthFailure,
  createSessionRecoveringFetch,
  createSessionRefresher,
  describeClockSkew,
  estimateClockSkewMs,
  recoverOnlineSession,
  type FetchLike,
  type RefreshedSession
} from "./session-recovery";

const jwtExpiredBody = { code: "PGRST303", details: null, hint: null, message: "JWT expired" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("classifyAuthFailure", () => {
  it("recognizes PostgREST's expired JWT (the PGRST303 reported by the PIN diagnostics)", () => {
    expect(classifyAuthFailure(jwtExpiredBody)).toBe("jwt-expired");
    expect(classifyAuthFailure({ message: "JWT expired" })).toBe("jwt-expired");
    expect(classifyAuthFailure(new Error("[PGRST303] JWT expired"))).toBe("jwt-expired");
  });

  it("recognizes a dead session (revoked/used refresh token, missing session, invalid JWT)", () => {
    expect(classifyAuthFailure({ code: "refresh_token_not_found", message: "x" })).toBe("session-invalid");
    expect(classifyAuthFailure({ code: "refresh_token_already_used", message: "x" })).toBe("session-invalid");
    expect(classifyAuthFailure({ name: "AuthSessionMissingError", message: "Auth session missing!" })).toBe("session-invalid");
    expect(classifyAuthFailure({ code: "PGRST301", message: "JWSError JWSInvalidSignature" })).toBe("session-invalid");
  });

  it("recognizes connectivity failures from fetch, supabase auth and PostgREST", () => {
    expect(classifyAuthFailure(new TypeError("Failed to fetch"))).toBe("connectivity");
    expect(classifyAuthFailure({ name: "AuthRetryableFetchError", message: "x", status: 0 })).toBe("connectivity");
    expect(classifyAuthFailure({ code: "", message: "TypeError: Failed to fetch" })).toBe("connectivity");
    expect(classifyAuthFailure({ code: "PGRST002", message: "Could not query the database for the schema cache" })).toBe("connectivity");
    expect(classifyAuthFailure(new Error("Tiempo de espera agotado (timed out)"))).toBe("connectivity");
  });

  it("never treats business rejections as infrastructure failures", () => {
    expect(classifyAuthFailure({ code: "42501", message: "permission denied" })).toBe("other");
    expect(classifyAuthFailure({ code: "P0001", message: "PIN incorrecto" })).toBe("other");
    expect(classifyAuthFailure(null)).toBe("other");
    expect(classifyAuthFailure(undefined)).toBe("other");
    expect(classifyAuthFailure(42)).toBe("other");
  });
});

describe("clock skew estimation", () => {
  it("derives the server time from a freshly issued session", () => {
    const localNowMs = Date.parse("2026-11-14T12:00:00Z");
    const serverNowMs = Date.parse("2026-11-14T12:30:00Z"); // la PC está 30 min atrasada
    const session = { expires_in: 3600, expires_at: serverNowMs / 1000 + 3600 };
    expect(estimateClockSkewMs(session, localNowMs)).toBe(-30 * 60_000);
  });

  it("returns null without the server timestamps and only warns from one minute", () => {
    expect(estimateClockSkewMs({ expires_in: 3600 }, 0)).toBeNull();
    expect(describeClockSkew(null)).toBeNull();
    expect(describeClockSkew(CLOCK_SKEW_WARNING_MS - 1)).toBeNull();
    expect(describeClockSkew(-30 * 60_000)).toContain("30 min atrasado");
    expect(describeClockSkew(5 * 60_000)).toContain("5 min adelantado");
  });
});

describe("createSessionRefresher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const fresh = (token: string): RefreshedSession => ({ access_token: token, expires_in: 3600, expires_at: Date.now() / 1000 + 3600 });

  it("shares one refresh between concurrent rejected requests", async () => {
    const refresh = vi.fn(() => Promise.resolve({ data: { session: fresh("new") }, error: null }));
    const refresher = createSessionRefresher({ refresh });

    const tokens = await Promise.all([refresher.refreshAccessToken("old"), refresher.refreshAccessToken("old"), refresher.refreshAccessToken("old")]);

    expect(tokens).toEqual(["new", "new", "new"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not rotate the refresh token again when the rejected token was already replaced", async () => {
    const refresh = vi.fn(() => Promise.resolve({ data: { session: fresh("new") }, error: null }));
    const refresher = createSessionRefresher({ refresh });
    await refresher.refreshAccessToken("old");

    await expect(refresher.refreshAccessToken("old")).resolves.toBe("new");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("backs off after a failure (no /token storm while the box has no Internet) and retries after the cooldown", async () => {
    const refresh = vi.fn()
      .mockResolvedValueOnce({ data: { session: null }, error: { name: "AuthRetryableFetchError", message: "Failed to fetch" } })
      .mockResolvedValueOnce({ data: { session: fresh("back-online") }, error: null });
    const refresher = createSessionRefresher({ refresh, failureCooldownMs: 15_000 });

    await expect(refresher.refreshAccessToken("old")).resolves.toBeNull();
    expect(refresher.lastFailure()).toBe("connectivity");
    await expect(refresher.refreshAccessToken("old")).resolves.toBeNull();
    expect(refresh).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(15_001);
    await expect(refresher.refreshAccessToken("old")).resolves.toBe("back-online");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresher.lastFailure()).toBeNull();
  });

  it("reports a revoked session as null instead of throwing, and survives a rejecting refresh", async () => {
    const revoked = createSessionRefresher({ refresh: () => Promise.resolve({ data: { session: null }, error: { code: "refresh_token_not_found", message: "x" } }) });
    await expect(revoked.refreshAccessToken("old")).resolves.toBeNull();
    expect(revoked.lastFailure()).toBe("session-invalid");

    const exploding = createSessionRefresher({ refresh: () => Promise.reject(new TypeError("Failed to fetch")) });
    await expect(exploding.refreshAccessToken("old")).resolves.toBeNull();
    expect(exploding.lastFailure()).toBe("connectivity");
  });

  it("learns the clock skew from every issued session", () => {
    const localNow = Date.now();
    const refresher = createSessionRefresher({ refresh: () => Promise.resolve({ data: { session: null }, error: null }) });
    expect(refresher.clockSkewMs()).toBeNull();
    refresher.noteSession({ access_token: "t", expires_in: 3600, expires_at: localNow / 1000 + 3600 + 600 });
    expect(refresher.clockSkewMs()).toBe(-600_000);
  });
});

describe("createSessionRecoveringFetch", () => {
  const restUrl = "https://project.supabase.co/rest/v1/rpc/verify_pos_operator_pin";

  function call(baseFetch: FetchLike, refreshAccessToken: (token: string | null) => Promise<string | null>, url = restUrl, token = "old") {
    const recovering = createSessionRecoveringFetch({ baseFetch, refreshAccessToken });
    return recovering(url, { method: "POST", body: "{\"p_pin\":\"1234\"}", headers: new Headers({ authorization: `Bearer ${token}`, apikey: "key" }) });
  }

  it("passes successful responses through untouched", async () => {
    const baseFetch = vi.fn<FetchLike>(() => Promise.resolve(json(200, { ok: true })));
    const refresh = vi.fn(() => Promise.resolve("new"));

    const response = await call(baseFetch, refresh);

    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renews and replays the same request once, with the new bearer, when PostgREST says JWT expired", async () => {
    const baseFetch = vi.fn<FetchLike>()
      .mockResolvedValueOnce(json(401, jwtExpiredBody))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const refresh = vi.fn(() => Promise.resolve("new"));

    const response = await call(baseFetch, refresh);

    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledWith("old");
    expect(baseFetch).toHaveBeenCalledTimes(2);
    const replay = baseFetch.mock.calls.at(1);
    expect(replay?.[0]).toBe(restUrl);
    const replayInit = replay?.[1];
    expect(new Headers(replayInit?.headers).get("authorization")).toBe("Bearer new");
    expect(new Headers(replayInit?.headers).get("apikey")).toBe("key");
    expect(replayInit?.body).toBe("{\"p_pin\":\"1234\"}");
  });

  it("gives the original JWT-expired answer back when the session cannot be renewed (so callers can use local authorization)", async () => {
    const baseFetch = vi.fn<FetchLike>(() => Promise.resolve(json(401, jwtExpiredBody)));

    const response = await call(baseFetch, () => Promise.resolve(null));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(jwtExpiredBody);
    expect(baseFetch).toHaveBeenCalledOnce();
  });

  it("replays at most once even if the server still answers 401", async () => {
    const baseFetch = vi.fn<FetchLike>(() => Promise.resolve(json(401, jwtExpiredBody)));
    const refresh = vi.fn(() => Promise.resolve("new"));

    const response = await call(baseFetch, refresh);

    expect(response.status).toBe(401);
    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not touch other 401s, other statuses, non-PostgREST URLs or network errors", async () => {
    const refresh = vi.fn(() => Promise.resolve("new"));

    const otherUnauthorized = vi.fn<FetchLike>(() => Promise.resolve(json(401, { code: "42501", message: "permission denied" })));
    expect((await call(otherUnauthorized, refresh)).status).toBe(401);

    const serverError = vi.fn<FetchLike>(() => Promise.resolve(json(500, { message: "boom" })));
    expect((await call(serverError, refresh)).status).toBe(500);

    const authEndpoint = vi.fn<FetchLike>(() => Promise.resolve(json(401, jwtExpiredBody)));
    expect((await call(authEndpoint, refresh, "https://project.supabase.co/auth/v1/token?grant_type=refresh_token")).status).toBe(401);

    const offline = vi.fn<FetchLike>(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(call(offline, refresh)).rejects.toThrow("Failed to fetch");

    expect(refresh).not.toHaveBeenCalled();
    expect(otherUnauthorized).toHaveBeenCalledOnce();
  });
});

describe("recoverOnlineSession (reconnection)", () => {
  const session = { user: { id: "device-user", email: "pos@example.test" } };

  it("returns the technical user once getSession can renew the stored session", async () => {
    const result = await recoverOnlineSession({ getSession: () => Promise.resolve({ data: { session }, error: null }) });
    expect(result).toEqual({ status: "online", user: { id: "device-user", email: "pos@example.test" } });
  });

  it("stays unreachable (and keeps trying later) while Supabase cannot be reached", async () => {
    const retryable = { name: "AuthRetryableFetchError", message: "Failed to fetch" };
    expect(await recoverOnlineSession({ getSession: () => Promise.resolve({ data: { session: null }, error: retryable }) })).toEqual({ status: "unreachable" });
    expect(await recoverOnlineSession({ getSession: () => Promise.reject(new TypeError("Failed to fetch")) })).toEqual({ status: "unreachable" });
  });

  it("reports no-session when nothing is stored or the refresh token was revoked", async () => {
    expect(await recoverOnlineSession({ getSession: () => Promise.resolve({ data: { session: null }, error: null }) })).toEqual({ status: "no-session" });
    expect(await recoverOnlineSession({ getSession: () => Promise.resolve({ data: { session: null }, error: { code: "refresh_token_not_found", message: "x" } }) })).toEqual({ status: "no-session" });
  });
});
