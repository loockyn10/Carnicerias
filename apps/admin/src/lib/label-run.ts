import { buildLabelLayout, type LabelLayout } from "./label-layout";
import { renderLabelSheetPdf } from "./label-pdf";
import { sheetPageCount, expandCopies } from "./label-sheet";
import { MAX_LABEL_COPIES, MAX_LABELS_PER_RUN, MAX_PRODUCTS_PER_RUN } from "./label-spec";
import { formatRunStamp } from "./label-stamp";
import { UNAVAILABLE_TEXT, parseLabelBranchGroups, parseLabelGroupFacts, resolveLabelItem, type LabelGroupFacts } from "./label-group";
import { isUuid } from "./uuid";
import { conditionText, type ProductLabelData } from "./product-label";

/**
 * Generación del PDF de etiquetas (D-073), lado servidor:
 *   1. valida el pedido (sólo ids de producto y copias: el navegador NO envía precios, nombres ni promociones);
 *   2. vuelve a leer el grupo en la base (precio vigente de SU sucursal + regla «llevando N») y arma las etiquetas con el motor de pricing;
 *   3. dibuja el PDF;
 *   4. registra la generación con EXACTAMENTE los valores que se dibujaron (snapshot);
 *   5. recién entonces devuelve el archivo (si el registro falla no se entrega nada: no puede haber etiquetas impresas sin historial).
 * La lectura y el registro se inyectan (`LabelRunDeps`): la ruta HTTP los conecta a Supabase y las pruebas a un doble.
 */

export class LabelRunError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LabelRunError";
    this.status = status;
  }
}

export interface LabelRunRequest {
  groupId: string;
  items: { productId: string; copies: number }[];
}

export interface LabelBranchRunRequest {
  branchId: string;
  items: { groupId: string; productId: string; copies: number }[];
}

/** Cantidad de copias válida: entero entre 1 y 99. */
export function isValidCopies(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_LABEL_COPIES;
}

/** Valida el cuerpo del pedido. Cualquier otro campo (precio, nombre…) se IGNORA: el servidor no confía en el navegador. */
export function parseLabelRunRequest(body: unknown): { ok: true; value: LabelRunRequest } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Pedido inválido" };
  const record = body as Record<string, unknown>;
  if (!isUuid(record.groupId)) return { ok: false, error: "Grupo inválido" };
  if (!Array.isArray(record.items) || record.items.length === 0) return { ok: false, error: "Seleccioná al menos una etiqueta" };
  if (record.items.length > MAX_PRODUCTS_PER_RUN) return { ok: false, error: `Hasta ${String(MAX_PRODUCTS_PER_RUN)} productos por generación` };
  const items: LabelRunRequest["items"] = [];
  const seen = new Set<string>();
  let labels = 0;
  for (const raw of record.items as unknown[]) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "Producto inválido" };
    const { productId, copies } = raw as Record<string, unknown>;
    if (!isUuid(productId)) return { ok: false, error: "Producto inválido" };
    if (!isValidCopies(copies)) return { ok: false, error: `La cantidad de copias tiene que ser un entero entre 1 y ${String(MAX_LABEL_COPIES)}` };
    const key = productId.toLowerCase();
    if (seen.has(key)) return { ok: false, error: "Hay productos repetidos en la selección" };
    seen.add(key);
    labels += copies;
    items.push({ productId: key, copies });
  }
  if (labels > MAX_LABELS_PER_RUN) return { ok: false, error: `Hasta ${String(MAX_LABELS_PER_RUN)} etiquetas por generación (son ${String(labels)})` };
  return { ok: true, value: { groupId: record.groupId.toLowerCase(), items } };
}

/** Pedido global: el par grupo + producto es la identidad de una etiqueta física. */
export function parseLabelBranchRunRequest(body: unknown): { ok: true; value: LabelBranchRunRequest } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Pedido inválido" };
  const record = body as Record<string, unknown>;
  if (!isUuid(record.branchId)) return { ok: false, error: "Sucursal inválida" };
  if (!Array.isArray(record.items) || record.items.length === 0) return { ok: false, error: "Seleccioná al menos una etiqueta" };
  if (record.items.length > MAX_PRODUCTS_PER_RUN) return { ok: false, error: `Hasta ${String(MAX_PRODUCTS_PER_RUN)} productos por generación` };
  const items: LabelBranchRunRequest["items"] = [];
  const seen = new Set<string>();
  let labels = 0;
  for (const raw of record.items) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "Etiqueta inválida" };
    const { groupId, productId, copies } = raw as Record<string, unknown>;
    if (!isUuid(groupId) || !isUuid(productId)) return { ok: false, error: "Etiqueta inválida" };
    if (!isValidCopies(copies)) return { ok: false, error: `La cantidad de copias tiene que ser un entero entre 1 y ${String(MAX_LABEL_COPIES)}` };
    const key = `${groupId.toLowerCase()}:${productId.toLowerCase()}`;
    if (seen.has(key)) return { ok: false, error: "Hay etiquetas repetidas en la selección" };
    seen.add(key); labels += copies;
    items.push({ groupId: groupId.toLowerCase(), productId: productId.toLowerCase(), copies });
  }
  if (labels > MAX_LABELS_PER_RUN) return { ok: false, error: `Hasta ${String(MAX_LABELS_PER_RUN)} etiquetas por generación (son ${String(labels)})` };
  return { ok: true, value: { branchId: record.branchId.toLowerCase(), items } };
}

export interface PreparedLabel {
  productId: string;
  copies: number;
  unitType: "UNIT" | "WEIGHT";
  label: ProductLabelData;
  layout: LabelLayout;
}

/**
 * Etiquetas a imprimir, resueltas con los hechos de la base (nunca con datos del navegador). El orden es el del GRUPO, no el de los clics.
 * Un producto que no es del grupo, o que hoy no se puede imprimir (inactivo, fuera de la sucursal, sin precio), rechaza TODO el pedido.
 */
export function prepareLabelRun(facts: LabelGroupFacts, request: LabelRunRequest): PreparedLabel[] {
  if (!facts.active) throw new LabelRunError(409, "El grupo está archivado");
  const copiesById = new Map(request.items.map((item) => [item.productId, item.copies]));
  const byId = new Map(facts.items.map((item) => [item.productId.toLowerCase(), item]));
  const missing = request.items.filter((item) => !byId.has(item.productId));
  if (missing.length) throw new LabelRunError(422, "Hay productos que no pertenecen al grupo");

  const prepared: PreparedLabel[] = [];
  const blocked: string[] = [];
  for (const item of facts.items) {
    const copies = copiesById.get(item.productId.toLowerCase());
    if (copies === undefined) continue;
    const resolution = resolveLabelItem(item);
    if (!resolution.printable) {
      blocked.push(`${item.name} (${item.unavailableReason ? UNAVAILABLE_TEXT[item.unavailableReason] : "sin precio vigente"})`);
      continue;
    }
    prepared.push({ productId: item.productId, copies, unitType: item.unitType, label: resolution.label, layout: buildLabelLayout(resolution.label) });
  }
  if (blocked.length) throw new LabelRunError(422, `No se pueden imprimir: ${blocked.join("; ")}`);
  return prepared;
}

/** Cuerpo del registro (`record_label_print_run`): exactamente lo dibujado en el PDF. */
export function snapshotItems(prepared: readonly PreparedLabel[]): Record<string, unknown>[] {
  return prepared.map(({ productId, copies, unitType, label }) => {
    const values = label.values;
    if (!values) throw new LabelRunError(500, "Etiqueta sin valores");
    return {
      productId, copies, displayedName: values.displayedName, unitType, variant: label.variant,
      listPriceCents: Number(values.listPriceCents),
      promoPriceCents: values.promoPriceCents === null ? null : Number(values.promoPriceCents),
      promoMinimumUnits: values.promoMinimumUnits, promoDiscountBps: values.promoDiscountBps, conditionText: conditionText(label)
    };
  });
}

export interface LabelRunDeps {
  /** `get_label_group`: JSON crudo del grupo (null = no existe o es de otra organización). */
  getGroup: (groupId: string) => Promise<unknown>;
  /** `record_label_print_run`: JSON crudo con `runId`. */
  recordRun: (groupId: string, items: Record<string, unknown>[]) => Promise<unknown>;
}

export interface LabelBranchRunDeps {
  getGroups: (branchId: string) => Promise<unknown>;
  recordRuns: (branchId: string, items: Record<string, unknown>[]) => Promise<unknown>;
}

export interface LabelRunResult {
  pdf: Uint8Array;
  filename: string;
  runId: string;
  labelCount: number;
  productCount: number;
  pageCount: number;
}

function slug(name: string): string {
  const ascii = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (ascii || "grupo").slice(0, 40).replace(/-+$/g, "");
}

export async function executeLabelRun(deps: LabelRunDeps, request: LabelRunRequest, context: { timeZone: string; now?: Date }): Promise<LabelRunResult> {
  const facts = parseLabelGroupFacts(await deps.getGroup(request.groupId));
  if (!facts) throw new LabelRunError(404, "El grupo no existe");
  const prepared = prepareLabelRun(facts, request);

  const now = context.now ?? new Date();
  const stamp = formatRunStamp(now, context.timeZone);
  const layouts = expandCopies(prepared.map((entry) => ({ item: entry.layout, copies: entry.copies })));
  const pdf = await renderLabelSheetPdf(layouts, { title: `Etiquetas - ${facts.name}`, header: `${facts.name}  -  ${stamp.display}`, createdAt: now });

  // Se registra lo que se dibujó (mismo `prepared`) ANTES de entregar el archivo.
  let recorded: unknown;
  try {
    recorded = await deps.recordRun(facts.groupId, snapshotItems(prepared));
  } catch (error) {
    throw new LabelRunError(500, `No se pudo registrar la generación: ${error instanceof Error ? error.message : "error desconocido"}`);
  }
  const runId = typeof recorded === "object" && recorded !== null ? (recorded as Record<string, unknown>).runId : null;
  if (!isUuid(runId)) throw new LabelRunError(500, "No se pudo registrar la generación");

  return {
    pdf, runId, filename: `etiquetas-${slug(facts.name)}-${stamp.file}.pdf`,
    labelCount: layouts.length, productCount: prepared.length, pageCount: sheetPageCount(layouts.length)
  };
}

/** Genera un único PDF con grupos de una misma sucursal y registra cada grupo de forma atómica. */
export async function executeLabelBranchRun(deps: LabelBranchRunDeps, request: LabelBranchRunRequest, context: { timeZone: string; now?: Date }): Promise<LabelRunResult> {
  const groups = parseLabelBranchGroups(await deps.getGroups(request.branchId));
  if (!groups.length) throw new LabelRunError(404, "No hay grupos activos para esta sucursal");
  const byId = new Map(groups.map((group) => [group.groupId.toLowerCase(), group]));
  const byGroup = new Map<string, { productId: string; copies: number }[]>();
  for (const item of request.items) {
    const values = byGroup.get(item.groupId) ?? [];
    values.push({ productId: item.productId, copies: item.copies });
    byGroup.set(item.groupId, values);
  }

  const prepared = [] as (PreparedLabel & { groupId: string })[];
  for (const [groupId, items] of byGroup) {
    const group = byId.get(groupId);
    if (!group) throw new LabelRunError(422, "Hay grupos que no pertenecen a esta sucursal");
    prepared.push(...prepareLabelRun(group, { groupId: group.groupId, items }).map((entry) => ({ ...entry, groupId: group.groupId })));
  }
  const now = context.now ?? new Date();
  const stamp = formatRunStamp(now, context.timeZone);
  const layouts = expandCopies(prepared.map((entry) => ({ item: entry.layout, copies: entry.copies })));
  const pdf = await renderLabelSheetPdf(layouts, { title: "Etiquetas de góndola", header: `Etiquetas de góndola  -  ${stamp.display}`, createdAt: now });
  let recorded: unknown;
  try {
    recorded = await deps.recordRuns(request.branchId, prepared.flatMap((entry) => snapshotItems([entry]).map((item) => ({ groupId: entry.groupId, ...item }))));
  } catch (error) {
    throw new LabelRunError(500, `No se pudo registrar la generación: ${error instanceof Error ? error.message : "error desconocido"}`);
  }
  if (typeof recorded !== "object" || recorded === null || !Array.isArray((recorded as Record<string, unknown>).runs)) throw new LabelRunError(500, "No se pudo registrar la generación");
  return { pdf, runId: "multiple", filename: `etiquetas-gondola-${stamp.file}.pdf`, labelCount: layouts.length, productCount: prepared.length, pageCount: sheetPageCount(layouts.length) };
}
