import { describe, expect, it, vi } from "vitest";

import type { LocalShift } from "./local-database";
import { loadOperatorShift, type OperatorShiftDeps } from "./operator-shift";

const SHIFT: LocalShift = { shiftId: "s1", employeeId: "fran", clockInAt: "2026-11-16T08:00:00Z", clockOutAt: null, clockInSource: "ONLINE", clockOutSource: null, status: "OPEN" };

function deps(overrides: Partial<OperatorShiftDeps> = {}) {
  const calls = { currentShift: vi.fn(() => Promise.resolve<LocalShift | null>(null)), applyServerShift: vi.fn(() => Promise.resolve()), clearReconciledShift: vi.fn(() => Promise.resolve()), remoteShift: vi.fn(() => Promise.resolve<{ data: unknown; error: Error | null }>({ data: null, error: null })) };
  const value: OperatorShiftDeps = { centralHint: false, timekeepingDisabled: () => Promise.resolve(false), canQueryRemote: true, ...calls, ...overrides };
  return { value, calls };
}

describe("turno del operador al ingresar (D-098)", () => {
  it("Central (la UI lo sabe): entrar es sólo el PIN; no se consulta ningún turno ni SQLite ni el servidor", async () => {
    const { value, calls } = deps({ centralHint: true });
    expect(await loadOperatorShift("fran", value)).toEqual({ timekeeping: false, shift: null });
    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  });

  it("Central (lo dice SQLite aunque la UI todavía no): tampoco se consulta nada, con o sin Internet", async () => {
    for (const canQueryRemote of [true, false]) {
      const { value, calls } = deps({ timekeepingDisabled: () => Promise.resolve(true), canQueryRemote });
      expect(await loadOperatorShift("fran", value)).toEqual({ timekeeping: false, shift: null });
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
    }
  });

  it("Central: ingresos repetidos (Fran, otro empleado, Fran) nunca fallan ni piden entrada, aunque el servidor tenga un turno viejo", async () => {
    const { value, calls } = deps({ timekeepingDisabled: () => Promise.resolve(true), remoteShift: vi.fn(() => Promise.reject(new Error("No hay un turno activo para marcar salida"))) });
    for (const employee of ["fran", "maria", "fran", "fran"]) {
      expect(await loadOperatorShift(employee, value)).toEqual({ timekeeping: false, shift: null });
    }
    expect(calls.applyServerShift).not.toHaveBeenCalled();
  });

  it("las demás sucursales conservan el fichaje: turno local, turno del servidor o ninguno (entonces se exige marcar entrada)", async () => {
    const offline = deps({ canQueryRemote: false });
    offline.calls.currentShift.mockResolvedValueOnce(SHIFT);
    expect(await loadOperatorShift("fran", offline.value)).toEqual({ timekeeping: true, shift: SHIFT });
    expect(offline.calls.remoteShift).not.toHaveBeenCalled();

    const none = deps();
    expect(await loadOperatorShift("fran", none.value)).toEqual({ timekeeping: true, shift: null });
    expect(none.calls.clearReconciledShift).toHaveBeenCalledWith("fran");

    const remote = deps({ remoteShift: vi.fn(() => Promise.resolve({ data: { shiftId: "s1", clockInAt: SHIFT.clockInAt, clockOutAt: null, clockInSource: "ONLINE", clockOutSource: null, status: "OPEN" }, error: null })) });
    expect(await loadOperatorShift("fran", remote.value)).toEqual({ timekeeping: true, shift: SHIFT });
    expect(remote.calls.applyServerShift).toHaveBeenCalledWith(SHIFT);
  });

  it("un error del servidor en una sucursal con fichaje se propaga (como antes)", async () => {
    const { value } = deps({ remoteShift: vi.fn(() => Promise.resolve({ data: null, error: new Error("boom") })) });
    await expect(loadOperatorShift("fran", value)).rejects.toThrow("boom");
  });

  it("con la sesión técnica vencida o sin servidor (error tolerable) manda el turno local: no se reconcilia ni se borra nada", async () => {
    const { value, calls } = deps({ remoteShift: vi.fn(() => Promise.resolve({ data: null, error: new Error("JWT expired") })), tolerateRemoteError: (error) => error.message === "JWT expired" });
    calls.currentShift.mockResolvedValue(SHIFT);
    expect(await loadOperatorShift("fran", value)).toEqual({ timekeeping: true, shift: SHIFT });
    expect(calls.clearReconciledShift).not.toHaveBeenCalled();
    expect(calls.applyServerShift).not.toHaveBeenCalled();
  });
});
