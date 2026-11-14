import { OUTBOX_MAX_DELAY_MS, nextAttemptAt } from "@carnicerias/sync";
import { describe, expect, it } from "vitest";

import { outboxDueCutoff, pushOutbox, type PushDeps, type PushErrorLike, type PushableEvent } from "./outbox-push";
import { classifyAuthFailure } from "./session-recovery";

interface TestEvent extends PushableEvent {
  kind: "SALE" | "SHIFT";
  /** Hora local en la que se hizo la operación (la venta offline puede tener días). */
  occurredAt: Date;
  /** Token del operador que viajó en la venta (vencido o no: al servidor nuevo no le importa). */
  operatorToken: string;
  status: "PENDING" | "SYNCING" | "FAILED" | "SYNCED";
  nextAttempt: Date;
  lastError: string | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-20T12:00:00Z");

function sale(id: string, hoursAgo: number, token = "token-viejo"): TestEvent {
  return { id, aggregateType: "SALE", aggregateId: `sale-${id}`, attempts: 0, kind: "SALE", occurredAt: new Date(NOW.getTime() - hoursAgo * HOUR), operatorToken: token, status: "PENDING", nextAttempt: new Date(0), lastError: null };
}
function shiftEvent(id: string, shiftId: string): TestEvent {
  return { id, aggregateType: "SHIFT", aggregateId: shiftId, attempts: 0, kind: "SHIFT", occurredAt: NOW, operatorToken: "t", status: "PENDING", nextAttempt: new Date(0), lastError: null };
}

/** Cola en memoria con la misma semántica que SQLite (espera creciente, SYNCED no vuelve a enviarse). */
class MemoryOutbox {
  constructor(readonly events: TestEvent[]) {}
  due(cutoff: string): TestEvent[] {
    return this.events.filter((event) => event.status !== "SYNCED" && event.nextAttempt.getTime() <= new Date(cutoff).getTime());
  }
  get pending(): number { return this.events.filter((event) => event.status !== "SYNCED").length; }
  byId(id: string): TestEvent { const found = this.events.find((event) => event.id === id); if (!found) throw new Error(id); return found; }
}

/** Servidor simulado. `legacyTokenExpiry` reproduce la regla vieja: el token venció a las 168 h de emitido. */
class FakeServer {
  readonly sales = new Map<string, number>();
  legacyTokenExpiry = false;
  failWith: ((event: TestEvent) => PushErrorLike | null) | null = null;
  calls: string[] = [];
  push(event: TestEvent): { error: PushErrorLike | null } {
    this.calls.push(event.id);
    const injected = this.failWith?.(event) ?? null;
    if (injected) return { error: injected };
    if (this.legacyTokenExpiry && event.operatorToken === "token-vencido") {
      return { error: { code: "42501", message: "POS operator authorization is invalid, expired, or revoked" } };
    }
    // Idempotente por event id: reintentar no duplica la venta.
    this.sales.set(event.id, (this.sales.get(event.id) ?? 0) + 1);
    return { error: null };
  }
}

function depsFor(outbox: MemoryOutbox, server: FakeServer, clock: { now: Date }): PushDeps<TestEvent> {
  return {
    markSyncing: (id) => { const event = outbox.byId(id); event.status = "SYNCING"; event.attempts += 1; return Promise.resolve(); },
    markSynced: (id) => { outbox.byId(id).status = "SYNCED"; return Promise.resolve(); },
    markFailed: (id, diagnostic, retryAt) => { const event = outbox.byId(id); event.status = "FAILED"; event.lastError = diagnostic; event.nextAttempt = new Date(retryAt); return Promise.resolve(); },
    push: (event) => Promise.resolve(server.push(event)),
    describeError: (error) => [error.code ? `[${error.code}]` : null, error.message].filter(Boolean).join(" · "),
    classifyError: classifyAuthFailure,
    nextAttemptAt: (attempts) => nextAttemptAt(attempts, clock.now),
    now: () => clock.now
  };
}

describe("cola de pendientes: un evento trabado no frena al resto", () => {
  it("el rechazo de un evento no bloquea las ventas legítimas que están detrás", async () => {
    const outbox = new MemoryOutbox([sale("a", 5), sale("b", 4), sale("c", 3)]);
    const server = new FakeServer();
    server.failWith = (event) => (event.id === "a" ? { code: "42501", message: "POS operator authorization is invalid, expired, or revoked" } : null);
    const result = await pushOutbox(outbox.due(NOW.toISOString()), depsFor(outbox, server, { now: NOW }));

    expect(result).toMatchObject({ succeeded: 2, failed: 1, abortedBy: null });
    expect(result.firstFailure?.message).toContain("[42501]");
    expect(outbox.byId("b").status).toBe("SYNCED");
    expect(outbox.byId("c").status).toBe("SYNCED");
    expect(outbox.byId("a").status).toBe("FAILED");
    expect(outbox.pending).toBe(1);
  });

  it("dos eventos trabados no se bloquean entre sí y siguen en la cola, sin perderse", async () => {
    const outbox = new MemoryOutbox([sale("a", 5), sale("b", 4)]);
    const server = new FakeServer();
    server.failWith = () => ({ code: "42501", message: "POS operator authorization is invalid, expired, or revoked" });
    const result = await pushOutbox(outbox.due(NOW.toISOString()), depsFor(outbox, server, { now: NOW }));
    expect(result.failed).toBe(2);
    expect(server.calls).toEqual(["a", "b"]);
    expect(outbox.pending).toBe(2);
    expect(outbox.byId("a").nextAttempt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("un error de conexión o de sesión técnica corta el ciclo y deja el resto intacto", async () => {
    const outbox = new MemoryOutbox([sale("a", 3), sale("b", 2), sale("c", 1)]);
    const server = new FakeServer();
    server.failWith = (event) => (event.id === "a" ? { code: "PGRST303", message: "JWT expired" } : null);
    const result = await pushOutbox(outbox.due(NOW.toISOString()), depsFor(outbox, server, { now: NOW }));
    expect(result.abortedBy).not.toBeNull();
    expect(server.calls).toEqual(["a"]);
    expect(outbox.byId("b").status).toBe("PENDING");
    expect(outbox.byId("c").status).toBe("PENDING");
    expect(outbox.pending).toBe(3);
  });

  it("una excepción de red (fetch caído) también corta el ciclo sin perder el evento", async () => {
    const outbox = new MemoryOutbox([sale("a", 3), sale("b", 2)]);
    const server = new FakeServer();
    const deps = depsFor(outbox, server, { now: NOW });
    deps.push = () => Promise.reject(new TypeError("Failed to fetch"));
    const result = await pushOutbox(outbox.due(NOW.toISOString()), deps);
    expect(result.abortedBy).toBeInstanceOf(TypeError);
    expect(outbox.byId("a").status).toBe("FAILED");
    expect(outbox.byId("b").status).toBe("PENDING");
    expect(outbox.pending).toBe(2);
  });

  it("los eventos de un mismo turno conservan el orden: si la entrada falla, la salida espera; otras ventas siguen", async () => {
    const outbox = new MemoryOutbox([shiftEvent("in", "turno-1"), shiftEvent("out", "turno-1"), sale("v", 1)]);
    const server = new FakeServer();
    server.failWith = (event) => (event.id === "in" ? { code: "P0001", message: "boom" } : null);
    const result = await pushOutbox(outbox.due(NOW.toISOString()), depsFor(outbox, server, { now: NOW }));
    expect(server.calls).toEqual(["in", "v"]);
    expect(result).toMatchObject({ succeeded: 1, failed: 1, deferred: 1 });
    expect(outbox.byId("out").status).toBe("PENDING");
  });
});

describe("ventas hechas offline horas o días antes", () => {
  it("sincronizan aunque el token del operador original haya vencido o el empleado ya haya salido", async () => {
    // Tres ventas de hace 2 h, 1 día y 5 días; el token de la última ya venció y nadie tiene sesión abierta.
    const outbox = new MemoryOutbox([sale("v1", 2, "token-vigente"), sale("v2", 24, "token-vigente"), sale("v3", 5 * 24, "token-vencido")]);
    const server = new FakeServer(); // servidor nuevo: identifica por dispositivo + organización, sin vencimiento
    const result = await pushOutbox(outbox.due(NOW.toISOString()), depsFor(outbox, server, { now: NOW }));
    expect(result).toMatchObject({ succeeded: 3, failed: 0, abortedBy: null, firstFailure: null });
    expect(outbox.pending).toBe(0);
    expect([...server.sales.values()]).toEqual([1, 1, 1]);
  });

  it("recuperación de los pendientes ya trabados: tras corregir el servidor se sincronizan solos, sin duplicar", async () => {
    // Estado actual de la caja: dos ventas con 42501 por token vencido, más una venta nueva detrás.
    const outbox = new MemoryOutbox([sale("p1", 30, "token-vencido"), sale("p2", 29, "token-vencido"), sale("ok", 1, "token-vigente")]);
    const server = new FakeServer();
    server.legacyTokenExpiry = true;
    const clock = { now: NOW };

    const first = await pushOutbox(outbox.due(NOW.toISOString()), depsFor(outbox, server, clock));
    expect(first).toMatchObject({ succeeded: 1, failed: 2 });
    expect(outbox.pending).toBe(2); // «Online · 2 pendientes»

    // Se aplica la migración y se reinicia la caja: el primer ciclo ignora la espera de los fallidos.
    server.legacyTokenExpiry = false;
    const cutoff = outboxDueCutoff(clock.now, true);
    expect(outbox.due(NOW.toISOString())).toHaveLength(0); // sin el arranque, seguirían esperando su backoff
    expect(outbox.due(cutoff)).toHaveLength(2);
    const second = await pushOutbox(outbox.due(cutoff), depsFor(outbox, server, clock));
    expect(second).toMatchObject({ succeeded: 2, failed: 0 });
    expect(outbox.pending).toBe(0);
    // Ninguna venta se perdió ni se duplicó: exactamente una vez cada una.
    expect([...server.sales.entries()].sort()).toEqual([["ok", 1], ["p1", 1], ["p2", 1]]);
  });

  it("sin reiniciar, los pendientes se reintentan solos al vencer su espera (máximo 5 minutos)", async () => {
    const outbox = new MemoryOutbox([sale("p1", 30, "token-vencido")]);
    const server = new FakeServer();
    server.legacyTokenExpiry = true;
    const clock = { now: NOW };
    await pushOutbox(outbox.due(clock.now.toISOString()), depsFor(outbox, server, clock));
    server.legacyTokenExpiry = false;

    clock.now = new Date(NOW.getTime() + 1_000);
    expect(outbox.due(clock.now.toISOString())).toHaveLength(0);
    clock.now = new Date(NOW.getTime() + OUTBOX_MAX_DELAY_MS + 1_000);
    const retry = await pushOutbox(outbox.due(clock.now.toISOString()), depsFor(outbox, server, clock));
    expect(retry.succeeded).toBe(1);
    expect(outbox.pending).toBe(0);
  });

  it("una venta de hace días con el reloj de la caja atrasado respecto del emisor del token ya no se rechaza", async () => {
    // Antes: occurred_at < issued_at - 5 min => 42501 para siempre. Ahora el momento de la venta no se compara con el token.
    const outbox = new MemoryOutbox([sale("atrasada", 7 * 24 + 1, "token-vencido")]);
    const server = new FakeServer();
    const result = await pushOutbox(outbox.due(NOW.toISOString()), depsFor(outbox, server, { now: NOW }));
    expect(result.succeeded).toBe(1);
    expect(DAY).toBe(24 * HOUR);
  });
});

describe("primer ciclo tras arrancar", () => {
  it("ignora la espera de los fallidos sólo una vez", () => {
    const first = new Date(outboxDueCutoff(NOW, true)).getTime();
    const later = new Date(outboxDueCutoff(NOW, false)).getTime();
    expect(first - later).toBe(OUTBOX_MAX_DELAY_MS);
    expect(later).toBe(NOW.getTime());
  });
});
