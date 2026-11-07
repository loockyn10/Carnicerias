import { readVacuumEan13, type EanSchemeConfig } from "@carnicerias/business-logic";

import type { VacuumPackageForSale } from "./ticket-pricing";

/**
 * Reconocimiento de los EAN-13 de importe variable de Envasados al escanear (LOCAL: sólo el estado de Envasados ya sincronizado en SQLite, sin llamadas a
 * la red, igual que el escaneo del catálogo). Pura: sin React, SQLite ni DOM.
 *
 * Qué hace: valida estructura y dígito verificador, detecta si el código cumple el esquema configurado, extrae PLU e importe, y busca entre los paquetes
 * DISPONIBLES de la sucursal los que tienen ese EAN. Qué NO hace: calcular el importe (lo trae el paquete) ni decidir nada sobre códigos que no son de
 * Envasados (esos siguen el camino de siempre). Un código reservado por el esquema NUNCA termina en el alta rápida de productos.
 */

export interface LocalVacuumStateLike {
  scheme: { scheme: "PRICE_EMBEDDED" | "WEIGHT_EMBEDDED"; prefix: string; pluDigits: number; valueDigits: number; valueStep: number } | null;
  plus: readonly { productId: string; plu: string }[];
  packages: readonly {
    packageId: string; productId: string; productName: string; ean13: string; weightGrams: number;
    chargeCents: string; lot: string; packedOn: string; expiresOn: string;
  }[];
}

export interface VacuumCandidate extends VacuumPackageForSale {
  packedOn: string;
  expiresOn: string;
}

export type VacuumScanOutcome =
  /** No es un código de Envasados (o no hay esquema configurado): se interpreta como siempre. */
  | { kind: "NOT_VACUUM" }
  /** Cumple el esquema pero el PLU no corresponde a ningún corte habilitado ni hay un paquete con ese código. */
  | { kind: "UNKNOWN_PLU"; code: string; plu: string }
  /** Cumple el esquema y el corte existe, pero esta caja no tiene un paquete disponible con ese código. */
  | { kind: "NO_PACKAGE"; code: string; productId: string | null; amountCents: bigint | null; alreadyInTicket: boolean }
  /** Un paquete (o varios indistinguibles: mismo peso → FIFO, el más antiguo). */
  | { kind: "PACKAGE"; package: VacuumCandidate; sameCodeCount: number }
  /** Varios paquetes con el mismo código pero de PESOS distintos: el cajero elige cuál (más antiguo primero). */
  | { kind: "CHOOSE"; candidates: VacuumCandidate[] };

/** El esquema configurado en el servidor, o null si Envasados todavía no tiene uno. */
export function vacuumSchemeOf(state: LocalVacuumStateLike | null): EanSchemeConfig | null {
  return state?.scheme ? { ...state.scheme } : null;
}

/** El orden FIFO: el más antiguo primero (fecha de elaboración, después lote y id para un orden estable). */
export function compareFifo(left: { packedOn: string; lot: string; packageId: string }, right: { packedOn: string; lot: string; packageId: string }): number {
  return left.packedOn.localeCompare(right.packedOn) || left.lot.localeCompare(right.lot) || left.packageId.localeCompare(right.packageId);
}

function toCandidate(row: LocalVacuumStateLike["packages"][number]): VacuumCandidate {
  return {
    packageId: row.packageId, productId: row.productId, productName: row.productName, ean13: row.ean13, weightGrams: row.weightGrams,
    chargeCents: BigInt(row.chargeCents), lot: row.lot, packedOn: row.packedOn, expiresOn: row.expiresOn
  };
}

/**
 * `packageIdsInTicket`: los paquetes que ya están en el ticket actual (no se ofrecen dos veces; un escaneo repetido del mismo código toma el siguiente
 * paquete indistinguible, o avisa si no queda otro).
 */
export function resolveVacuumScan(state: LocalVacuumStateLike | null, rawCode: string, packageIdsInTicket: ReadonlySet<string> = new Set()): VacuumScanOutcome {
  const scheme = vacuumSchemeOf(state);
  if (!state || !scheme) return { kind: "NOT_VACUUM" };
  const code = rawCode.trim();
  const reading = readVacuumEan13(scheme, code);
  if (reading.kind === "NOT_VACUUM") return { kind: "NOT_VACUUM" };

  const sameCode = state.packages.filter((row) => row.ean13 === code);
  const candidates = sameCode.filter((row) => !packageIdsInTicket.has(row.packageId)).map(toCandidate).sort(compareFifo);
  if (candidates.length === 0) {
    const productId = state.plus.find((row) => /^\d+$/.test(row.plu) && BigInt(row.plu).toString() === reading.pluNumber)?.productId ?? sameCode[0]?.productId ?? null;
    if (productId === null) return { kind: "UNKNOWN_PLU", code, plu: reading.plu };
    return { kind: "NO_PACKAGE", code, productId, amountCents: reading.amountCents, alreadyInTicket: sameCode.length > 0 };
  }
  const weights = new Set(candidates.map((candidate) => candidate.weightGrams));
  const [oldest] = candidates;
  if (oldest && weights.size === 1) return { kind: "PACKAGE", package: oldest, sameCodeCount: candidates.length };
  return { kind: "CHOOSE", candidates };
}

/** Texto corto para distinguir paquetes del mismo código en el selector: peso, lote y fecha de elaboración. */
export function describeVacuumCandidate(candidate: VacuumCandidate): { weight: string; lot: string; packedOn: string } {
  const [year, month, day] = candidate.packedOn.split("-");
  const kilos = (candidate.weightGrams / 1000).toFixed(3).replace(".", ",");
  return { weight: `${kilos} kg`, lot: candidate.lot, packedOn: year && month && day ? `${day}/${month}/${year}` : candidate.packedOn };
}
