import { describe, expect, it } from "vitest";

import { isManualTransferOffered, isSessionDegraded, parseBranchConfigResponse, resolveMercadoPagoAvailability } from "./mercadopago-availability";
import { readManualTransferAllowed, readMercadoPagoEnabled, writeMercadoPagoEnabled } from "./mercadopago-capability";
import { resolveStartupUser, type StartupRuntime } from "./startup-session";

const BRANCH = "22222222-2222-4222-8222-222222222222";
const DEVICE = "a1b24d64-6214-46f5-a3ea-053a1a462bdb";
const NOW = Date.parse("2026-10-02T12:00:00Z");

const base = {
  desktop: true, hasDevice: true, hasUser: true, sessionOffline: false, browserOnline: true, knownEnabled: true as boolean | null, lookupFailed: false
};

describe("parseBranchConfigResponse — errors are never swallowed", () => {
  it("reads enabled true/false", () => {
    expect(parseBranchConfigResponse({ branchId: BRANCH, enabled: true, qrMode: "static", manualTransferAllowed: false }, null, BRANCH)).toEqual({ status: "ok", enabled: true, manualTransferAllowed: false });
    expect(parseBranchConfigResponse({ branchId: BRANCH, enabled: false, manualTransferAllowed: true }, null, BRANCH)).toEqual({ status: "ok", enabled: false, manualTransferAllowed: true });
  });
  it("a server that does not report the transfer policy keeps manual transfer allowed", () => {
    expect(parseBranchConfigResponse({ branchId: BRANCH, enabled: true }, null, BRANCH)).toEqual({ status: "ok", enabled: true, manualTransferAllowed: true });
    expect(parseBranchConfigResponse({ branchId: BRANCH, enabled: true, manualTransferAllowed: "no" }, null, BRANCH)).toMatchObject({ manualTransferAllowed: true });
  });
  it("keeps the PostgREST error code and message", () => {
    expect(parseBranchConfigResponse(null, { code: "42501", message: "Device is not authorized" }, BRANCH)).toEqual({ status: "error", code: "42501", message: "Device is not authorized" });
    expect(parseBranchConfigResponse(null, { message: "boom" }, BRANCH)).toEqual({ status: "error", code: "ERROR", message: "boom" });
  });
  it("treats a malformed or foreign-branch answer as an error, never as enabled", () => {
    for (const bad of [null, undefined, {}, { enabled: "true" }, []]) {
      expect(parseBranchConfigResponse(bad, null, BRANCH)).toMatchObject({ status: "error", code: "BAD_RESPONSE" });
    }
    expect(parseBranchConfigResponse({ branchId: "other-branch", enabled: true }, null, BRANCH)).toMatchObject({ status: "error", code: "BRANCH_MISMATCH" });
  });
});

describe("resolveMercadoPagoAvailability", () => {
  it("Avenida online with a real session: visible and usable", () => {
    expect(resolveMercadoPagoAvailability(base)).toMatchObject({ visible: true, usable: true, reason: null });
  });
  it("Central (not enabled): never visible", () => {
    expect(resolveMercadoPagoAvailability({ ...base, knownEnabled: false })).toMatchObject({ visible: false, usable: false, reason: "NOT_ENABLED" });
  });
  it("never visible outside the desktop POS", () => {
    expect(resolveMercadoPagoAvailability({ ...base, desktop: false })).toMatchObject({ visible: false, reason: "NOT_DESKTOP" });
  });
  it("really offline: visible if known, but disabled", () => {
    expect(resolveMercadoPagoAvailability({ ...base, browserOnline: false })).toMatchObject({ visible: true, usable: false, reason: "OFFLINE" });
  });
  it("offline and never checked: not shown (nothing is invented)", () => {
    expect(resolveMercadoPagoAvailability({ ...base, browserOnline: false, knownEnabled: null })).toMatchObject({ visible: false, usable: false, reason: "OFFLINE" });
  });
  it("a failed lookup is reported as such, not as 'not enabled'", () => {
    expect(resolveMercadoPagoAvailability({ ...base, knownEnabled: null, lookupFailed: true })).toMatchObject({ visible: false, reason: "LOOKUP_FAILED" });
    expect(resolveMercadoPagoAvailability({ ...base, knownEnabled: null })).toMatchObject({ visible: false, reason: "NOT_CHECKED_YET" });
  });
  it("without a device or a user there is nothing to ask", () => {
    expect(resolveMercadoPagoAvailability({ ...base, hasDevice: false })).toMatchObject({ reason: "NO_DEVICE", usable: false });
    expect(resolveMercadoPagoAvailability({ ...base, hasUser: false })).toMatchObject({ reason: "NO_USER", usable: false });
  });
});

describe("REGRESSION: online but without a technical session (tauri dev / lost session)", () => {
  // Reproduces the reported bug: the POS had Internet, the device was ACTIVE in SQLite, but the
  // webview had no persisted Supabase session, so the POS silently ran on the cached authorization.
  const runtime: StartupRuntime = { profileId: "profile", userEmail: "caja@example.test", deviceStatus: "ACTIVE", authorizationExpiresAt: "2099-01-01T00:00:00Z" };

  it("starts as an OFFLINE user although there is Internet, and that is detected", () => {
    const user = resolveStartupUser({ browserOnline: true, session: null, runtime, nowMs: NOW });
    expect(user).toEqual({ id: "profile", email: "caja@example.test", offline: true });
    expect(isSessionDegraded({ desktop: true, sessionOffline: user?.offline ?? false, browserOnline: true })).toBe(true);
  });

  it("explains why the button is missing instead of failing silently", () => {
    const user = resolveStartupUser({ browserOnline: true, session: null, runtime, nowMs: NOW });
    const never = resolveMercadoPagoAvailability({ ...base, sessionOffline: user?.offline ?? false, knownEnabled: null });
    // Even if the branch was never checked, the actionable reason is the missing online session.
    expect(never).toMatchObject({ visible: false, usable: false, reason: "SESSION_NOT_ONLINE" });
    const known = resolveMercadoPagoAvailability({ ...base, sessionOffline: user?.offline ?? false, knownEnabled: true });
    // Once the branch is known to have Mercado Pago the button stays visible but disabled, with the reason.
    expect(known).toMatchObject({ visible: true, usable: false, reason: "SESSION_NOT_ONLINE" });
    expect(known.explanation).toContain("sesión técnica");
  });

  it("recovers once the device is reconnected with a real session", () => {
    const user = resolveStartupUser({ browserOnline: true, session: { id: "profile", email: "caja@example.test" }, runtime, nowMs: NOW });
    expect(user).toEqual({ id: "profile", email: "caja@example.test", offline: false });
    expect(isSessionDegraded({ desktop: true, sessionOffline: user?.offline ?? false, browserOnline: true })).toBe(false);
    expect(resolveMercadoPagoAvailability({ ...base, sessionOffline: false })).toMatchObject({ visible: true, usable: true });
  });
});

describe("resolveStartupUser", () => {
  const runtime: StartupRuntime = { profileId: "p", userEmail: "e@x.test", deviceStatus: "ACTIVE", authorizationExpiresAt: "2026-10-03T00:00:00Z" };
  it("uses the real session when online", () => {
    expect(resolveStartupUser({ browserOnline: true, session: { id: "s", email: undefined }, runtime: null, nowMs: NOW })).toEqual({ id: "s", email: "s", offline: false });
  });
  it("ignores a session while the browser is offline and falls back to the cached authorization", () => {
    expect(resolveStartupUser({ browserOnline: false, session: { id: "s", email: "s@x.test" }, runtime, nowMs: NOW })).toMatchObject({ id: "p", offline: true });
  });
  it("needs a valid, unexpired authorization of an ACTIVE device to fall back", () => {
    expect(resolveStartupUser({ browserOnline: false, session: null, runtime: { ...runtime, authorizationExpiresAt: "2026-10-01T00:00:00Z" }, nowMs: NOW })).toBeNull();
    expect(resolveStartupUser({ browserOnline: false, session: null, runtime: { ...runtime, deviceStatus: "UNREGISTERED" }, nowMs: NOW })).toBeNull();
    expect(resolveStartupUser({ browserOnline: false, session: null, runtime: { ...runtime, profileId: null }, nowMs: NOW })).toBeNull();
    expect(resolveStartupUser({ browserOnline: false, session: null, runtime: null, nowMs: NOW })).toBeNull();
  });
});

describe("isSessionDegraded", () => {
  it("only when desktop + cached session + Internet", () => {
    expect(isSessionDegraded({ desktop: true, sessionOffline: true, browserOnline: true })).toBe(true);
    expect(isSessionDegraded({ desktop: true, sessionOffline: true, browserOnline: false })).toBe(false);
    expect(isSessionDegraded({ desktop: true, sessionOffline: false, browserOnline: true })).toBe(false);
    expect(isSessionDegraded({ desktop: false, sessionOffline: true, browserOnline: true })).toBe(false);
  });
});

describe("remembered capability (per device + branch)", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } };
  }
  it("round-trips for the same device and branch", () => {
    const storage = fakeStorage();
    expect(readMercadoPagoEnabled(DEVICE, BRANCH, storage)).toBeNull();
    writeMercadoPagoEnabled(DEVICE, BRANCH, true, true, storage);
    expect(readMercadoPagoEnabled(DEVICE, BRANCH, storage)).toBe(true);
    writeMercadoPagoEnabled(DEVICE, BRANCH, false, true, storage);
    expect(readMercadoPagoEnabled(DEVICE, BRANCH, storage)).toBe(false);
  });
  it("never leaks to another branch (Central) or another device", () => {
    const storage = fakeStorage();
    writeMercadoPagoEnabled(DEVICE, BRANCH, true, false, storage);
    expect(readMercadoPagoEnabled(DEVICE, "central-branch", storage)).toBeNull();
    expect(readManualTransferAllowed(DEVICE, "central-branch", storage)).toBeNull();
    expect(readMercadoPagoEnabled("other-device", BRANCH, storage)).toBeNull();
    expect(readManualTransferAllowed("other-device", BRANCH, storage)).toBeNull();
    expect(readMercadoPagoEnabled(null, BRANCH, storage)).toBeNull();
    expect(readMercadoPagoEnabled(DEVICE, null, storage)).toBeNull();
  });
  it("survives corrupt or blocked storage", () => {
    expect(readMercadoPagoEnabled(DEVICE, BRANCH, fakeStorage({ "pos.mercadopago.enabled": "{not json" }))).toBeNull();
    expect(readMercadoPagoEnabled(DEVICE, BRANCH, fakeStorage({ "pos.mercadopago.enabled": JSON.stringify({ deviceId: DEVICE, branchId: BRANCH, enabled: "yes" }) }))).toBeNull();
    expect(readMercadoPagoEnabled(DEVICE, BRANCH, null)).toBeNull();
    expect(() => writeMercadoPagoEnabled(DEVICE, BRANCH, true, true, { getItem: () => null, setItem: () => { throw new Error("quota"); } })).not.toThrow();
    expect(() => writeMercadoPagoEnabled(DEVICE, BRANCH, true, true, null)).not.toThrow();
  });
});

describe("manual transfer in a branch that requires Mercado Pago (no hardcoded branch)", () => {
  function fakeStorage() {
    const data: Record<string, string> = {};
    return { getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } };
  }

  it("Avenida-like branch (Mercado Pago enabled + required): the 'Transferencia' button is not offered", () => {
    expect(isManualTransferOffered({ mercadoPagoEnabled: true, manualTransferAllowed: false })).toBe(false);
  });
  it("Central-like branch (no Mercado Pago): the 'Transferencia' button stays", () => {
    expect(isManualTransferOffered({ mercadoPagoEnabled: false, manualTransferAllowed: true })).toBe(true);
    expect(isManualTransferOffered({ mercadoPagoEnabled: false, manualTransferAllowed: false })).toBe(true);
  });
  it("Mercado Pago enabled but the rule relaxed (e.g. Mercado Pago is down): manual transfer is offered", () => {
    expect(isManualTransferOffered({ mercadoPagoEnabled: true, manualTransferAllowed: true })).toBe(true);
  });
  it("never learned (first start offline): nothing is invented, the usual buttons stay", () => {
    expect(isManualTransferOffered({ mercadoPagoEnabled: null, manualTransferAllowed: null })).toBe(true);
    expect(isManualTransferOffered({ mercadoPagoEnabled: true, manualTransferAllowed: null })).toBe(true);
  });
  it("any other branch enabled tomorrow gets the same rule from its configuration alone", () => {
    const storage = fakeStorage();
    writeMercadoPagoEnabled(DEVICE, "janssen-branch", true, false, storage);
    expect(isManualTransferOffered({
      mercadoPagoEnabled: readMercadoPagoEnabled(DEVICE, "janssen-branch", storage),
      manualTransferAllowed: readManualTransferAllowed(DEVICE, "janssen-branch", storage)
    })).toBe(false);
  });
  it("the remembered policy survives a restart without Internet and never leaks to another branch", () => {
    const storage = fakeStorage();
    writeMercadoPagoEnabled(DEVICE, BRANCH, true, false, storage);
    expect(readManualTransferAllowed(DEVICE, BRANCH, storage)).toBe(false);
    expect(readManualTransferAllowed(DEVICE, "central-branch", storage)).toBeNull();
  });
});
