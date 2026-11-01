import { isUuid } from "./uuid";
import { isVacuumPrintKind, parseVacuumPackage, type VacuumPrintKind } from "./vacuum";
import { renderVacuumLabelsPdf, vacuumLabelFilename, VacuumLabelError } from "./vacuum-label-pdf";

/**
 * Impresión / reimpresión de las etiquetas de un paquete ya registrado. El navegador sólo manda `{ packageId, kind }`: los datos de la etiqueta
 * salen del SNAPSHOT guardado (nunca de precios o textos actuales) y la organización, la sucursal y el permiso los valida la RPC con la sesión del
 * usuario. Se genera el PDF primero y recién después se registra la impresión: si el PDF falla no queda una impresión fantasma.
 */

export class VacuumPrintError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface VacuumPrintRequest {
  packageId: string;
  kind: VacuumPrintKind;
}

export type VacuumPrintRequestParse = { ok: true; value: VacuumPrintRequest } | { ok: false; error: string };

export function parseVacuumPrintRequest(body: unknown): VacuumPrintRequestParse {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Pedido inválido" };
  const record = body as Record<string, unknown>;
  if (typeof record.packageId !== "string" || !isUuid(record.packageId)) return { ok: false, error: "Paquete inválido" };
  if (!isVacuumPrintKind(record.kind)) return { ok: false, error: "Tipo de etiqueta inválido" };
  return { ok: true, value: { packageId: record.packageId, kind: record.kind } };
}

export interface VacuumPrintDeps {
  getPackage: (packageId: string) => Promise<unknown>;
  recordPrint: (packageId: string, kind: VacuumPrintKind) => Promise<void>;
}

export interface VacuumPrintResult {
  pdf: Uint8Array;
  filename: string;
  pageCount: number;
  overflow: string[];
}

export async function executeVacuumPrint(deps: VacuumPrintDeps, request: VacuumPrintRequest): Promise<VacuumPrintResult> {
  const pkg = parseVacuumPackage(await deps.getPackage(request.packageId));
  if (!pkg) throw new VacuumPrintError(404, "No se encontró el paquete");
  let rendered;
  try {
    rendered = await renderVacuumLabelsPdf(pkg, request.kind);
  } catch (error) {
    if (error instanceof VacuumLabelError) throw new VacuumPrintError(422, error.message);
    throw error;
  }
  await deps.recordPrint(pkg.id, request.kind);
  return { pdf: rendered.pdf, filename: vacuumLabelFilename(pkg, request.kind), pageCount: rendered.pageCount, overflow: rendered.overflow };
}
