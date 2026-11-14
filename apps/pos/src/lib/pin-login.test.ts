/* Supabase/PostgREST rechazan con objetos planos ({ code, message }), no con Error: así se simulan. */
/* eslint-disable @typescript-eslint/prefer-promise-reject-errors */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authenticateOperatorPin, ONLINE_PIN_TIMEOUT_MS } from "./pin-login";

interface Operator { profileId: string; operatorToken: string }
interface Verified { profileId: string }

const operator: Operator = { profileId: "employee", operatorToken: "cached-grant" };
const jwtExpired = { code: "PGRST303", message: "JWT expired", details: null, hint: null };

function setup(overrides: Partial<Parameters<typeof authenticateOperatorPin<Operator, Verified>>[0]> = {}) {
  const verifyOnline = vi.fn(() => Promise.resolve({ ok: true, profileId: "employee" }));
  const cacheVerified = vi.fn(() => Promise.resolve(operator));
  const verifyLocal = vi.fn(() => Promise.resolve(operator));
  const deps = { online: true, verifyOnline, cacheVerified, verifyLocal, ...overrides };
  return { deps, verifyOnline, cacheVerified, verifyLocal };
}

describe("authenticateOperatorPin", () => {
  it("validates with the server and caches the grant when the session is healthy", async () => {
    const { deps, verifyLocal, cacheVerified } = setup();

    const result = await authenticateOperatorPin(deps);

    expect(result).toEqual({ operator, via: "server", fallbackReason: null });
    expect(cacheVerified).toHaveBeenCalledOnce();
    expect(verifyLocal).not.toHaveBeenCalled();
  });

  it("uses only the local verifier when the box is offline (existing secure offline login)", async () => {
    const { deps, verifyOnline, verifyLocal } = setup({ online: false });

    const result = await authenticateOperatorPin(deps);

    expect(result).toEqual({ operator, via: "local", fallbackReason: null });
    expect(verifyOnline).not.toHaveBeenCalled();
    expect(verifyLocal).toHaveBeenCalledOnce();
  });

  it("never bypasses the server's verdict: a wrong/revoked PIN (ok:false) is not retried locally", async () => {
    const { deps, verifyLocal, cacheVerified } = setup({ verifyOnline: () => Promise.resolve({ ok: false, message: "PIN incorrecto", profileId: "employee" }) });

    await expect(authenticateOperatorPin(deps)).rejects.toThrow("PIN incorrecto");
    expect(verifyLocal).not.toHaveBeenCalled();
    expect(cacheVerified).not.toHaveBeenCalled();
  });

  it("does not fall back for business errors such as permission denied", async () => {
    const { deps, verifyLocal } = setup({ verifyOnline: () => Promise.reject({ code: "42501", message: "permission denied" }) });

    await expect(authenticateOperatorPin(deps)).rejects.toEqual({ code: "42501", message: "permission denied" });
    expect(verifyLocal).not.toHaveBeenCalled();
  });

  it("JWT expired that could not be renewed: the employee enters with the cached local authorization", async () => {
    const { deps, verifyLocal, cacheVerified } = setup({ verifyOnline: () => Promise.reject(jwtExpired) });

    const result = await authenticateOperatorPin(deps);

    expect(result).toEqual({ operator, via: "local", fallbackReason: "jwt-expired" });
    expect(verifyLocal).toHaveBeenCalledOnce();
    expect(cacheVerified).not.toHaveBeenCalled();
  });

  it("no connection with Supabase while the browser reports online: local authorization too", async () => {
    const { deps } = setup({ verifyOnline: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(await authenticateOperatorPin(deps)).toMatchObject({ via: "local", fallbackReason: "connectivity" });
  });

  it("dead session (revoked refresh token): local authorization as well", async () => {
    const { deps } = setup({ verifyOnline: () => Promise.reject({ code: "refresh_token_not_found", message: "x" }) });
    expect(await authenticateOperatorPin(deps)).toMatchObject({ via: "local", fallbackReason: "session-invalid" });
  });

  it("keeps the local lockout/PIN check: a wrong PIN in the fallback is rejected with the local message", async () => {
    const { deps } = setup({
      verifyOnline: () => Promise.reject(jwtExpired),
      verifyLocal: () => Promise.reject("PIN incorrecto. Intentos restantes: 3")
    });

    await expect(authenticateOperatorPin(deps)).rejects.toBe("PIN incorrecto. Intentos restantes: 3");
  });

  it("no cached grant (never validated online / grant expired): no access, with the real cause instead of 'JWT expired'", async () => {
    const { deps } = setup({
      verifyOnline: () => Promise.reject(jwtExpired),
      verifyLocal: () => Promise.reject("Este empleado debe validar su PIN online nuevamente")
    });

    await expect(authenticateOperatorPin(deps)).rejects.toThrow(/venció y no se pudo renovar.*no tiene una validación reciente/);
  });

  describe("hung connection", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("does not leave the cashier waiting on supabase-js' refresh backoff: times out and uses the local authorization", async () => {
      const { deps, verifyLocal } = setup({ verifyOnline: () => new Promise<never>(() => undefined) });

      const pending = authenticateOperatorPin(deps);
      await vi.advanceTimersByTimeAsync(ONLINE_PIN_TIMEOUT_MS + 1);

      await expect(pending).resolves.toMatchObject({ via: "local", fallbackReason: "connectivity" });
      expect(verifyLocal).toHaveBeenCalledOnce();
    });
  });
});
