/**
 * Envío de la cola de operaciones pendientes (ventas y eventos de turno) a Supabase.
 *
 * Lógica pura (sin red ni SQLite: todo entra por `PushDeps`), para poder probar la política:
 *
 *   - Un evento que el servidor rechaza por una razón PROPIA (no de conexión ni de sesión técnica) queda
 *     FAILED con su espera creciente y NO frena a los demás: una venta legítima nunca espera detrás de
 *     otro evento «envenenado».
 *   - Los eventos de un mismo agregado (p. ej. entrada y salida de un turno) conservan su orden: si uno
 *     falló en este ciclo, los siguientes del mismo agregado esperan al próximo ciclo.
 *   - Un error de conexión o de sesión técnica (JWT vencido/irrenovable, sin Internet) corta el ciclo
 *     completo: no tiene sentido seguir y NO es culpa del evento. El evento queda para el próximo ciclo.
 *   - Tras cada arranque de la aplicación el primer ciclo ignora la espera de los eventos fallidos, para
 *     que lo que quedó trabado antes de una actualización se reintente de inmediato.
 *   - Nunca se borra nada: la idempotencia (event id) la garantiza el servidor, así que reintentar es seguro.
 */
import { OUTBOX_MAX_DELAY_MS } from "@carnicerias/sync";

import type { AuthFailureKind } from "./session-recovery";

export interface PushableEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
}

export interface PushErrorLike {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

export interface PushDeps<E extends PushableEvent> {
  markSyncing(eventId: string, attemptedAt: string): Promise<void>;
  /** Llama a la RPC que corresponde al evento. Resuelve con el error de Supabase (o lo lanza si falló el fetch). */
  push(event: E): Promise<{ error: PushErrorLike | null }>;
  markFailed(eventId: string, diagnostic: string, nextAttemptAt: string): Promise<void>;
  markSynced(eventId: string, syncedAt: string): Promise<void>;
  describeError(error: PushErrorLike): string;
  classifyError(error: unknown): AuthFailureKind;
  nextAttemptAt(attempts: number): string;
  now(): Date;
  onProgress?(current: number, total: number): void;
}

export interface PushResult {
  succeeded: number;
  failed: number;
  /** Eventos no intentados en este ciclo por orden dentro de su agregado. */
  deferred: number;
  /** Error de conexión/sesión que cortó el ciclo (el resto de la cola queda intacta). */
  abortedBy: Error | null;
  /** Primer rechazo propio del servidor, para mostrarlo; no detuvo el ciclo. */
  firstFailure: Error | null;
}

/** Hasta cuándo se considera «vencida» la espera de un evento: el primer ciclo tras arrancar ignora las esperas. */
export function outboxDueCutoff(now: Date, firstCycleAfterStart: boolean): string {
  return new Date(now.getTime() + (firstCycleAfterStart ? OUTBOX_MAX_DELAY_MS : 0)).toISOString();
}

export async function pushOutbox<E extends PushableEvent>(due: readonly E[], deps: PushDeps<E>): Promise<PushResult> {
  const result: PushResult = { succeeded: 0, failed: 0, deferred: 0, abortedBy: null, firstFailure: null };
  const blockedAggregates = new Set<string>();

  for (const [index, event] of due.entries()) {
    const aggregateKey = `${event.aggregateType}:${event.aggregateId}`;
    if (blockedAggregates.has(aggregateKey)) {
      result.deferred += 1;
      continue;
    }
    deps.onProgress?.(index + 1, due.length);
    await deps.markSyncing(event.id, deps.now().toISOString());

    let error: PushErrorLike | null;
    let thrown: unknown = null;
    try {
      ({ error } = await deps.push(event));
    } catch (caught) {
      thrown = caught;
      error = { message: caught instanceof Error ? caught.message : typeof caught === "string" ? caught : "Error de red" };
    }

    if (!error) {
      await deps.markSynced(event.id, deps.now().toISOString());
      result.succeeded += 1;
      continue;
    }

    const diagnostic = deps.describeError(error);
    await deps.markFailed(event.id, diagnostic, deps.nextAttemptAt(event.attempts + 1));
    result.failed += 1;

    if (deps.classifyError(thrown ?? error) !== "other") {
      // Conexión o sesión técnica: el problema no es del evento; se corta el ciclo.
      result.abortedBy = thrown instanceof Error ? thrown : Object.assign(new Error(diagnostic), { code: error.code });
      return result;
    }
    result.firstFailure ??= new Error(diagnostic);
    blockedAggregates.add(aggregateKey);
  }
  return result;
}
