import { resolveScan, type BarcodeProductLike, type BranchStock, type ScanOutcome } from "./catalog";
import { resolveVacuumScan, type LocalVacuumStateLike, type VacuumCandidate, type VacuumScanOutcome } from "./vacuum-scan";

/**
 * Qué hacer con un código escaneado, de punta a punta: catálogo → Envasados → código desconocido. Pura (sin React, SQLite ni red: lo que necesita de
 * afuera llega por parámetro), para poder probar el recorrido completo «lector → carrito».
 *
 * Regla central: un código que ES o PUEDE SER de Envasados nunca termina en `UNKNOWN_CODE` (el camino que en Central abre el alta rápida de
 * productos). Sólo llega ahí un código que con certeza no es de Envasados: no cumple el esquema sincronizado, o la organización no tiene esquema.
 * Los códigos del catálogo se resuelven primero y exactamente como siempre.
 */

export interface ScanContext<P extends BarcodeProductLike> {
  barcodeIndex: ReadonlyMap<string, P>;
  stock: BranchStock;
  /** Esta caja puede vender paquetes envasados (POS de escritorio con sucursal). En el POS web de desarrollo es false y nada cambia. */
  vacuumSupported: boolean;
  vacuumState: LocalVacuumStateLike | null;
  packageIdsInTicket: ReadonlySet<string>;
}

/** Un escaneo de Envasados que sólo se puede concluir consultando al servidor (o explicando que no se pudo). */
export type PendingVacuumScan =
  /** La caja nunca sincronizó Envasados: no sabe si un código de 13 dígitos es un paquete. */
  | { kind: "STATE_MISSING"; code: string }
  | Extract<VacuumScanOutcome, { kind: "NO_PACKAGE" | "UNKNOWN_PLU" }>;

export type ScanDecision<P extends BarcodeProductLike> =
  /** Código vacío: nada que hacer. */
  | { kind: "IGNORE" }
  /** Producto del catálogo de la sucursal: el flujo tradicional, sin cambios. */
  | { kind: "CATALOG"; outcome: Exclude<ScanOutcome<P>, { kind: "NOT_FOUND" }> }
  | { kind: "VACUUM_PACKAGE"; package: VacuumCandidate }
  | { kind: "VACUUM_CHOOSE"; candidates: VacuumCandidate[] }
  /** Código de Envasados que no se puede vender: se muestra `message` y NUNCA se abre el alta rápida. */
  | { kind: "VACUUM_BLOCKED"; reason: VacuumBlockReason; message: string }
  /** Falta consultar al servidor: con conexión `concludeVacuumLookup`, sin conexión `offlineVacuumBlock`. */
  | { kind: "VACUUM_LOOKUP"; pending: PendingVacuumScan }
  /** Con certeza no es de Envasados ni del catálogo: «no encontrado» (y en Central, el alta rápida). */
  | { kind: "UNKNOWN_CODE"; code: string };

export type VacuumBlockReason =
  | "INVALID_CHECK_DIGIT" | "INVALID_AMOUNT" | "ALL_IN_TICKET" | "NOT_SYNCED" | "UNKNOWN_PLU" | "UNKNOWN_PACKAGE"
  | "SOLD" | "RESERVED" | "DISPATCHED" | "OTHER_BRANCH" | "VOIDED" | "EXPIRED" | "UNAVAILABLE";

/** Respuesta de `get_pos_vacuum_code_status`. */
export interface VacuumCodeStatus {
  status: string;
  here?: boolean | null;
  branchName?: string | null;
  expiresOn?: string | null;
}

export type FormatAmount = (cents: bigint) => string;

export interface VacuumBlocked { kind: "VACUUM_BLOCKED"; reason: VacuumBlockReason; message: string }
const blocked = (reason: VacuumBlockReason, message: string): VacuumBlocked => ({ kind: "VACUUM_BLOCKED", reason, message });

function fromVacuumOutcome(outcome: Exclude<VacuumScanOutcome, { kind: "NOT_VACUUM" }>): Exclude<ScanDecision<never>, { kind: "IGNORE" | "CATALOG" | "UNKNOWN_CODE" }> {
  switch (outcome.kind) {
    case "PACKAGE": return { kind: "VACUUM_PACKAGE", package: outcome.package };
    case "CHOOSE": return { kind: "VACUUM_CHOOSE", candidates: outcome.candidates };
    case "INVALID_CHECK_DIGIT":
      return blocked("INVALID_CHECK_DIGIT", "Etiqueta de Envasados mal leída (el dígito verificador no coincide). Volvé a escanearla.");
    case "INVALID_AMOUNT":
      return blocked("INVALID_AMOUNT", `Código de Envasados con importe inválido (PLU ${outcome.plu}). No se puede vender con esa etiqueta.`);
    case "NO_PACKAGE":
      if (outcome.alreadyInTicket) return blocked("ALL_IN_TICKET", "Ya cargaste todos los paquetes con ese código");
      return { kind: "VACUUM_LOOKUP", pending: outcome };
    case "UNKNOWN_PLU": return { kind: "VACUUM_LOOKUP", pending: outcome };
  }
}

const neverSynced = (state: LocalVacuumStateLike | null) => state === null || (state.appliedAt ?? null) === null;

/** Decisión LOCAL e inmediata (sin red): lo que alcanza para todo escaneo normal. */
export function decideScan<P extends BarcodeProductLike>(context: ScanContext<P>, rawCode: string): ScanDecision<P> {
  const catalog = resolveScan(context.barcodeIndex, context.stock, rawCode);
  if (!catalog) return { kind: "IGNORE" };
  if (catalog.kind !== "NOT_FOUND") return { kind: "CATALOG", outcome: catalog };
  const code = catalog.code;
  if (!context.vacuumSupported) return { kind: "UNKNOWN_CODE", code };
  const vacuum = resolveVacuumScan(context.vacuumState, code, context.packageIdsInTicket);
  if (vacuum.kind !== "NOT_VACUUM") return fromVacuumOutcome(vacuum);
  // Sin estado de Envasados la caja no conoce el esquema: un código de 13 dígitos PUEDE ser un paquete. No se da de alta nada hasta saberlo.
  if (neverSynced(context.vacuumState) && /^\d{13}$/.test(code)) return { kind: "VACUUM_LOOKUP", pending: { kind: "STATE_MISSING", code } };
  return { kind: "UNKNOWN_CODE", code };
}

/** Sin conexión (o sin sesión en línea) no se puede consultar: se explica, sin abrir el alta rápida. */
export function offlineVacuumBlock(pending: PendingVacuumScan, formatAmount: FormatAmount, detail?: string | null): VacuumBlocked {
  const why = detail ? ` (${detail})` : "";
  if (pending.kind === "STATE_MISSING") {
    return blocked("NOT_SYNCED", `Esta caja todavía no sincronizó Envasados y no puede saber si ese código es un paquete${why}. Conectala a Internet y volvé a escanear.`);
  }
  if (pending.kind === "UNKNOWN_PLU") {
    return blocked("UNKNOWN_PLU", `Código de Envasados con un PLU que esta caja no conoce (${pending.plu})${why}. Conectala a Internet y volvé a escanear.`);
  }
  const amount = pending.amountCents !== null ? ` de ${formatAmount(pending.amountCents)}` : "";
  return blocked("UNAVAILABLE", `Paquete envasado${amount} no disponible en esta caja${why}: puede estar vendido, en otra sucursal o sin sincronizar. Conectala a Internet y volvé a escanear.`);
}

function statusBlock(pending: Exclude<PendingVacuumScan, { kind: "STATE_MISSING" }>, status: VacuumCodeStatus | null, today: string, formatAmount: FormatAmount): VacuumBlocked {
  if (status === null) {
    if (pending.kind === "UNKNOWN_PLU") return blocked("UNKNOWN_PLU", `Código de Envasados con un PLU desconocido (${pending.plu}): ningún corte habilitado lo usa.`);
    const amount = pending.amountCents !== null ? ` de ${formatAmount(pending.amountCents)}` : "";
    return blocked("UNAVAILABLE", `Paquete envasado${amount} no disponible en esta sucursal (vendido, reservado o en otra sucursal).`);
  }
  switch (status.status) {
    case "UNKNOWN":
      return pending.kind === "UNKNOWN_PLU"
        ? blocked("UNKNOWN_PLU", `Código de Envasados con un PLU desconocido (${pending.plu}): no hay ningún paquete registrado con esa etiqueta.`)
        : blocked("UNKNOWN_PACKAGE", "No hay ningún paquete registrado con esa etiqueta de Envasados.");
    case "SOLD": case "SOLD_EXTERNAL": return blocked("SOLD", "Ese paquete envasado ya fue vendido.");
    case "RESERVED": return blocked("RESERVED", "Ese paquete envasado está reservado para una entrega y no se puede vender en la caja.");
    case "DISPATCHED": return blocked("DISPATCHED", "Ese paquete envasado ya fue despachado a un cliente.");
    case "VOIDED": case "DISCARDED": return blocked("VOIDED", "Ese paquete envasado fue anulado y no se puede vender.");
    case "QUARANTINE": return blocked("VOIDED", "Ese paquete envasado está en revisión por una devolución y no se puede vender.");
    case "AVAILABLE":
      if (status.here === false) return blocked("OTHER_BRANCH", `Ese paquete envasado está en otra sucursal${status.branchName ? ` (${status.branchName})` : ""}.`);
      if (status.expiresOn && status.expiresOn < today) return blocked("EXPIRED", "Ese paquete envasado está vencido y ya no se ofrece en la caja.");
      return blocked("UNAVAILABLE", "El paquete figura disponible pero esta caja no lo pudo cargar. Tocá «Sincronizar ahora» y volvé a escanear.");
    default: return blocked("UNAVAILABLE", "Ese paquete envasado no está disponible para la venta.");
  }
}

export interface VacuumLookupDeps {
  /** Baja el estado de Envasados del servidor, lo guarda y lo devuelve. Rechaza con el motivo si no se pudo. */
  refresh: () => Promise<LocalVacuumStateLike | null>;
  /** Estado del paquete en el servidor; null si no se pudo consultar (la explicación queda genérica). */
  codeStatus: (code: string) => Promise<VacuumCodeStatus | null>;
  packageIdsInTicket: () => ReadonlySet<string>;
  /** Fecha de hoy `AAAA-MM-DD` (para decir «vencido»). */
  today: string;
  formatAmount: FormatAmount;
}

/**
 * Concluye un escaneo de Envasados que localmente no alcanzó: sincroniza Envasados en el momento y vuelve a resolver (el paquete recién envasado
 * entra al carrito sin esperar al próximo ciclo de sync); si sigue sin poder venderse, explica por qué.
 */
export async function concludeVacuumLookup<P extends BarcodeProductLike>(pending: PendingVacuumScan, deps: VacuumLookupDeps): Promise<ScanDecision<P>> {
  let state: LocalVacuumStateLike | null;
  try {
    state = await deps.refresh();
  } catch (error) {
    return offlineVacuumBlock(pending, deps.formatAmount, error instanceof Error ? error.message : String(error));
  }
  if (neverSynced(state)) return offlineVacuumBlock(pending, deps.formatAmount);
  const outcome = resolveVacuumScan(state, pending.code, deps.packageIdsInTicket());
  // Con el esquema ya sincronizado se sabe con certeza que no es de Envasados: sigue el camino de un código desconocido.
  if (outcome.kind === "NOT_VACUUM") return { kind: "UNKNOWN_CODE", code: pending.code };
  if (outcome.kind !== "NO_PACKAGE" && outcome.kind !== "UNKNOWN_PLU") return fromVacuumOutcome(outcome);
  if (outcome.kind === "NO_PACKAGE" && outcome.alreadyInTicket) return fromVacuumOutcome(outcome);
  let status: VacuumCodeStatus | null = null;
  try { status = await deps.codeStatus(pending.code); } catch { status = null; }
  return statusBlock(outcome, status, deps.today, deps.formatAmount);
}
