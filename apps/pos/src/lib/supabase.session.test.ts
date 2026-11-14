/**
 * Integración con el cliente REAL de supabase-js (el de `./supabase`, ya cableado con la recuperación)
 * contra un servidor Supabase simulado: reproduce el `PGRST303 JWT expired` del PIN con el reloj de la PC
 * atrasado (el cliente cree vigente un token que el servidor ya venció) y verifica la renovación.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- type del módulo importado dinámicamente tras resetModules
type SupabaseModule = typeof import("./supabase");

const NOW_S = () => Math.floor(Date.now() / 1000);

interface FakeServer {
  calls: { rpc: number; refresh: number };
  validTokens: Set<string>;
  refreshMode: "ok" | "revoked";
  /** Segundos que el reloj del servidor va por delante del de la PC. */
  aheadSeconds: number;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function createFakeServer(): FakeServer {
  let counter = 0;
  const server: FakeServer = {
    calls: { rpc: 0, refresh: 0 },
    validTokens: new Set(),
    refreshMode: "ok",
    aheadSeconds: 0,
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      const session = (token: string) => ({
        access_token: token, refresh_token: `refresh-${String(counter)}`, token_type: "bearer", expires_in: 3600, expires_at: NOW_S() + server.aheadSeconds + 3600,
        user: { id: "device-user", email: "pos@example.test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" }
      });
      if (url.includes("/auth/v1/token?grant_type=password")) {
        // El servidor emite el token A, pero el reloj de la PC está atrasado: localmente "vive" 1 h, en el servidor ya venció.
        counter += 1;
        return Promise.resolve(jsonResponse(200, session("token-A")));
      }
      if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
        server.calls.refresh += 1;
        if (server.refreshMode === "revoked") {
          return Promise.resolve(jsonResponse(400, { code: "refresh_token_not_found", error_code: "refresh_token_not_found", error: "invalid_grant", error_description: "Invalid Refresh Token: Refresh Token Not Found", msg: "Invalid Refresh Token: Refresh Token Not Found" }));
        }
        counter += 1;
        const token = `token-B${String(counter)}`;
        server.validTokens.add(token);
        return Promise.resolve(jsonResponse(200, session(token)));
      }
      if (url.includes("/rest/v1/rpc/verify_pos_operator_pin")) {
        server.calls.rpc += 1;
        const bearer = headers.get("authorization")?.replace("Bearer ", "") ?? "";
        if (!server.validTokens.has(bearer)) return Promise.resolve(jsonResponse(401, { code: "PGRST303", details: null, hint: null, message: "JWT expired" }));
        return Promise.resolve(jsonResponse(200, { ok: true, profileId: "employee" }));
      }
      return Promise.reject(new Error(`unexpected request ${url}`));
    }
  };
  return server;
}

describe("POS Supabase client: expired JWT recovery", () => {
  let server: FakeServer;
  let mod: SupabaseModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    server = createFakeServer();
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => server.fetch(input, init));
    mod = await import("./supabase");
    const { error } = await mod.supabase.auth.signInWithPassword({ email: "pos@example.test", password: "x" });
    expect(error).toBeNull();
  });

  afterEach(async () => {
    await mod.supabase.auth.stopAutoRefresh();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const pinRpc = () => mod.supabase.rpc("verify_pos_operator_pin", { p_device_id: "d", p_profile_id: "p", p_pin: "1234" });

  it("reproduces the failure without recovery: the stored token is rejected by the server although the local clock believes it valid", async () => {
    const { data: stored } = await mod.supabase.auth.getSession();
    expect(stored.session?.access_token).toBe("token-A");
    expect(server.validTokens.has("token-A")).toBe(false);
  });

  it("renews the session and replays the PIN verification transparently (no PGRST303 reaches the screen)", async () => {
    const { data, error } = await pinRpc();

    expect(error).toBeNull();
    expect(data).toEqual({ ok: true, profileId: "employee" });
    expect(server.calls.refresh).toBe(1);
    expect(server.calls.rpc).toBe(2); // rechazada una vez, repetida una vez con el token nuevo
    expect((await mod.supabase.auth.getSession()).data.session?.access_token).toMatch(/^token-B/);
  });

  it("renews only once for simultaneous calls (PIN + shift + heartbeat) and later calls reuse the new token", async () => {
    const results = await Promise.all([pinRpc(), pinRpc(), pinRpc()]);

    expect(results.every((result) => result.error === null)).toBe(true);
    expect(server.calls.refresh).toBe(1);

    const rpcBefore = server.calls.rpc;
    await pinRpc();
    expect(server.calls.rpc).toBe(rpcBefore + 1); // sin 401 ni reintento
    expect(server.calls.refresh).toBe(1);
  });

  it("when the refresh token was revoked the original PGRST303 is surfaced (the PIN screen then uses local authorization)", async () => {
    server.refreshMode = "revoked";

    const { data, error } = await pinRpc();

    expect(data).toBeNull();
    expect(error?.code).toBe("PGRST303");
    expect(server.calls.rpc).toBe(1);
    const { classifyAuthFailure } = await import("./session-recovery");
    expect(classifyAuthFailure(error)).toBe("jwt-expired");
  });

  it("exposes the PC clock skew learnt from the server so the diagnostics can name the real cause", async () => {
    server.aheadSeconds = 600; // el reloj de la PC está 10 min atrasado respecto del servidor

    await mod.supabase.auth.signInWithPassword({ email: "pos@example.test", password: "x" });

    const skew = mod.getClockSkewMs();
    expect(skew).not.toBeNull();
    expect(Math.abs((skew ?? 0) + 600_000)).toBeLessThan(5_000);
  });
});
