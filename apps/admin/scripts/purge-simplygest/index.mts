/**
 * Purga controlada de productos de almacén importados desde SimplyGest cuyo stock ORIGINAL era <= 0.
 *
 *   preview  (seguro, no escribe nada): lee el archivo de SimplyGest, arma la lista de candidatos con la columna CANTIDAD ORIGINAL
 *            (nunca el stock de Supabase), le pregunta a la base qué pasaría con cada uno y escribe un reporte CSV.
 *   apply    (hard delete real): repite el preview, exige que el conteo coincida con --confirm-count y la bandera
 *            --yes-delete-permanently, y recién ahí borra, de a tandas. Lo bloqueado por historia se informa y NO se toca.
 *
 * No hay pantalla ni botón en el Admin para esto: es una limpieza de datos de una sola pasada que corre una persona con cuenta
 * de administrador. Usa el cliente de Supabase con la sesión del administrador (RLS/permisos; nada de service_role).
 *
 * Variables de entorno (por ejemplo con --env-file=.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, PURGE_ADMIN_EMAIL, PURGE_ADMIN_PASSWORD
 *
 * Ejecución (desde apps/admin; Node >= 22.18 ejecuta TypeScript directamente):
 *   node --env-file=.env.local scripts/purge-simplygest/index.mts preview --file ..\simplygest.xlsx --quantity-column CANTIDAD
 *
 * Segundo modo, sin archivo: --zero-current-price. Los candidatos salen de la base: productos importados de SimplyGest cuyo precio VIGENTE
 * existente es $0 ("SIN PRECIO ($0)" en el Admin; un producto sin ninguna fila de precio NO es candidato). Mismas protecciones que el modo
 * por CANTIDAD (las clasifica el mismo clasificador SQL) y el mismo preview/apply:
 *   node --env-file=.env.local scripts/purge-simplygest/index.mts preview --zero-current-price
 *   node --env-file=.env.local scripts/purge-simplygest/index.mts apply --zero-current-price --confirm-count <DELETE_SAFE> --yes-delete-permanently
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  buildPurgeCandidates, decodeCsvBytes, detectTableNumberFormat, parseCsvText, suggestColumnMapping, tableFromRecords, validateColumnMapping,
  type CatalogColumnMapping, type CatalogImportField, type CellValue, type ImportTable, type PurgeCandidate
} from "../../../../packages/business-logic/src/catalog-import.ts";
import {
  chunkItems, describeReasons, parseArgs, reportCsv, summarize, zeroPriceApplyGuard, zeroPriceReportCsv,
  type PurgeArgs, type PurgePreviewItem, type ZeroPriceApplyResult, type ZeroPricePreview
} from "./core.mts";

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

async function loadTable(path: string): Promise<ImportTable> {
  const bytes = readFileSync(path);
  const extension = extname(path).toLowerCase();
  if (extension === ".xlsx") {
    const { readSheet } = await import("read-excel-file/universal");
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const sheet = await readSheet(buffer, 1);
    return tableFromRecords(sheet.map((row) => row.map((cell): CellValue => (cell instanceof Date ? cell.toISOString().slice(0, 10) : typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" ? cell : null))));
  }
  if (extension === ".xls") fail("Los archivos .xls no se pueden leer: guardalo como .xlsx o CSV.");
  return parseCsvText(decodeCsvBytes(new Uint8Array(bytes)));
}

function normalizeHeader(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

/** Mapeo = el que sugiere la importación + las columnas que se indiquen por nombre. La cantidad es el campo «stock» del mapeo. */
function buildMapping(table: ImportTable, columns: PurgeArgs["columns"]): CatalogColumnMapping {
  const mapping = suggestColumnMapping(table.headers);
  const overrides: [keyof PurgeArgs["columns"], CatalogImportField][] = [
    ["code", "code"], ["name", "name"], ["barcode", "barcode"], ["price", "price"], ["quantity", "stock"], ["saleType", "saleType"]
  ];
  for (const [option, field] of overrides) {
    const wanted = columns[option];
    if (!wanted) continue;
    const index = table.headers.findIndex((header) => normalizeHeader(header) === normalizeHeader(wanted));
    if (index < 0) fail(`No encuentro la columna «${wanted}» en el archivo. Columnas: ${table.headers.join(" | ")}`);
    mapping[field] = index;
  }
  return mapping;
}

async function signInAsAdmin(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const email = process.env.PURGE_ADMIN_EMAIL;
  const password = process.env.PURGE_ADMIN_PASSWORD;
  if (!url || !key || !email || !password) fail("Faltan variables de entorno: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, PURGE_ADMIN_EMAIL y PURGE_ADMIN_PASSWORD.");
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await supabase.auth.signInWithPassword({ email, password });
  if (signedIn.error) fail(`No se pudo iniciar sesión como administrador: ${signedIn.error.message}`);
  return supabase;
}

/** Modo --zero-current-price: preview siempre (también antes de aplicar) y apply con el conteo exacto de DELETE_SAFE. */
async function runZeroCurrentPrice(args: PurgeArgs) {
  const supabase = await signInAsAdmin();
  const previewed = await supabase.rpc("preview_import_zero_price_purge", { p_source_system: args.source });
  if (previewed.error) fail(`La base rechazó el preview: ${previewed.error.message}`);
  const preview = previewed.data as ZeroPricePreview;
  const { summary } = preview;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = args.out ?? `purga-precio-cero-${args.command}-${stamp}.csv`;

  console.log(`Modo: precio vigente $0 | origen: ${preview.sourceSystem} | sucursal productiva: ${preview.branchName ?? preview.branchId}`);
  console.log(`\nPREVIEW — ${String(summary.total)} candidatos con precio vigente $0: ${String(summary.deleteSafe)} DELETE_SAFE | ${String(summary.blocked)} BLOCKED | ${String(summary.notImported)} no importados (sin vínculo con ${preview.sourceSystem})`);
  const reasons = Object.entries(preview.blockedByReason).sort((a, b) => b[1] - a[1]);
  if (reasons.length) {
    console.log("\nMotivos (un producto puede tener más de uno):");
    for (const [reason, count] of reasons) console.log(`  ${String(count).padStart(5)}  ${describeReasons([reason])}  [${reason}]`);
  }
  const line = (item: ZeroPricePreview["items"][number]) => `  ${(item.sku ?? "—").padEnd(16)} ${item.productName.slice(0, 44).padEnd(44)} ${item.active ? "activo  " : "inactivo"} ${item.reasons.join(",")}`;
  const safe = preview.items.filter((item) => item.verdict === "DELETE_SAFE");
  const blocked = preview.items.filter((item) => item.verdict === "BLOCKED");
  console.log("\nDELETE_SAFE (sku, nombre):");
  for (const item of safe.slice(0, 25)) console.log(line(item));
  if (safe.length > 25) console.log(`  … y ${String(safe.length - 25)} más (ver el reporte)`);
  console.log("\nBLOCKED (no se tocan; sku, nombre, motivo):");
  for (const item of blocked.slice(0, 100)) console.log(line(item));
  if (blocked.length > 100) console.log(`  … y ${String(blocked.length - 100)} más (ver el reporte)`);
  const notImported = preview.items.filter((item) => item.reasons.includes("NOT_IMPORTED_FROM_SOURCE"));
  console.log(`\nProductos con precio $0 que NO son importados de ${preview.sourceSystem}: ${String(notImported.length)}`);
  for (const item of notImported) console.log(line(item));

  if (args.command === "preview") {
    writeFileSync(reportPath, zeroPriceReportCsv(preview.items), "utf8");
    console.log(`\nReporte completo: ${reportPath}\nNo se borró nada. Para borrar: apply --zero-current-price --confirm-count ${String(summary.deleteSafe)} --yes-delete-permanently`);
    return;
  }

  const refusal = zeroPriceApplyGuard(args, summary.deleteSafe);
  if (refusal) fail(refusal);
  const outcome = new Map<string, string>();
  let deleted = 0;
  let remaining = summary.deleteSafe;
  while (remaining > 0) {
    // Una transacción por llamada; sin --batch-size es una única llamada con todos los DELETE_SAFE.
    const applied = await supabase.rpc("purge_import_zero_price_products", { p_source_system: args.source, p_expected_delete_count: remaining, p_batch_size: args.batchSize });
    if (applied.error) {
      writeFileSync(reportPath, zeroPriceReportCsv(preview.items, outcome), "utf8");
      fail(`La purga se detuvo: ${applied.error.message}\nBorrados hasta acá: ${String(deleted)}. Cada llamada es atómica y repetirla es seguro (volver a correr el preview). Reporte parcial: ${reportPath}`);
    }
    const result = applied.data as ZeroPriceApplyResult;
    for (const entry of result.deleted) outcome.set(entry.productId, "BORRADO");
    for (const entry of result.blocked) outcome.set(entry.productId, `NO BORRADO: ${entry.reasons.join(",")}`);
    deleted += result.summary.deleted;
    console.log(`  llamada: ${String(result.summary.deleted)} borrados, ${String(result.summary.remainingDeletable)} pendientes`);
    if (args.batchSize === null || result.summary.deleted === 0) break;
    remaining = result.summary.remainingDeletable;
  }
  writeFileSync(reportPath, zeroPriceReportCsv(preview.items, outcome), "utf8");
  const notDeleted = summary.deleteSafe - deleted;
  console.log(`\nLISTO — borrados: ${String(deleted)} | bloqueados (no se tocaron): ${String(summary.blocked)}\nReporte final: ${reportPath}`);
  if (notDeleted > 0) console.log(`Atención: ${String(notDeleted)} productos DELETE_SAFE no se borraron (ver el reporte); volver a correr el preview.`);
}

async function main() {
  let args: PurgeArgs;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  if (args.mode === "zero-current-price") { await runZeroCurrentPrice(args); return; }
  if (!args.file) fail("Falta --file <archivo de SimplyGest con la columna CANTIDAD>.");

  const table = await loadTable(args.file);
  const mapping = buildMapping(table, args.columns);
  if (mapping.stock === null) fail(`No encuentro la columna de cantidad. Indicala con --quantity-column <nombre>. Columnas: ${table.headers.join(" | ")}`);
  const problems = validateColumnMapping(mapping);
  if (problems.length) fail(`El mapeo de columnas no alcanza para identificar los productos igual que la importación:\n  - ${problems.join("\n  - ")}\nIndicá las columnas con --code-column, --name-column, --price-column.`);
  const names = (field: CatalogImportField) => (mapping[field] === null ? "—" : table.headers[mapping[field] as number]);
  console.log(`Archivo: ${basename(args.file)} (${String(table.rows.length)} filas)`);
  console.log(`Columnas → código: ${names("code")} | nombre: ${names("name")} | código de barras: ${names("barcode")} | precio: ${names("price")} | CANTIDAD original: ${names("stock")}`);

  const built = buildPurgeCandidates(table, mapping, { numberFormat: detectTableNumberFormat(table, mapping) });
  console.log(`\nFilas importables: ${String(built.totalRows - built.notImportedRows)} | candidatas (CANTIDAD <= 0): ${String(built.candidates.length)} | con CANTIDAD > 0 (nunca se tocan): ${String(built.positiveRows)}`);
  console.log(`Sin CANTIDAD legible (no son candidatas): ${String(built.emptyQuantityRows + built.unreadableQuantityRows)} | filas que la importación había rechazado: ${String(built.notImportedRows)}`);
  if (!built.candidates.length) { console.log("\nNo hay candidatos."); return; }

  const supabase = await signInAsAdmin();

  const payload = (candidates: PurgeCandidate[]) => candidates.map((candidate) => ({ externalId: candidate.externalId, quantity: candidate.quantity, name: candidate.name }));
  const fileNames = new Map(built.candidates.map((candidate) => [candidate.externalId, candidate]));

  // 1) Preview (siempre, también antes de aplicar): qué haría la base con cada candidato.
  const previewItems: PurgePreviewItem[] = [];
  for (const batch of chunkItems(built.candidates, args.chunk)) {
    const { data, error } = await supabase.rpc("preview_import_product_purge", { p_source_system: args.source, p_candidates: payload(batch) });
    if (error) fail(`La base rechazó el preview: ${error.message}`);
    previewItems.push(...((data as { items: PurgePreviewItem[] }).items));
  }
  const summary = summarize(previewItems);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = args.out ?? `purga-${args.command}-${stamp}.csv`;

  console.log(`\nPREVIEW — ${String(summary.total)} candidatos: ${String(summary.delete)} se borrarían | ${String(summary.blocked)} bloqueados por historia/uso | ${String(summary.skipped)} sin acción`);
  const show = (verdict: PurgePreviewItem["verdict"], limit: number) => {
    const rows = previewItems.filter((item) => item.verdict === verdict);
    for (const item of rows.slice(0, limit)) {
      console.log(`  ${item.externalId.padEnd(16)} ${(item.productName ?? fileNames.get(item.externalId)?.name ?? "").slice(0, 44).padEnd(44)} CANTIDAD ${String(item.quantity).padStart(6)}  ${item.reasons.join(",")}`);
    }
    if (rows.length > limit) console.log(`  … y ${String(rows.length - limit)} más (ver el reporte)`);
  };
  console.log("\nSe borrarían (código, nombre, CANTIDAD original):"); show("DELETE", 25);
  console.log("\nBLOQUEADOS (no se tocan):"); show("BLOCKED", 50);

  if (args.command === "preview") {
    writeFileSync(reportPath, reportCsv(previewItems), "utf8");
    console.log(`\nReporte completo: ${reportPath}\nNo se borró nada. Para borrar: apply --confirm-count ${String(summary.delete)} --yes-delete-permanently`);
    return;
  }

  // 2) Apply: sólo con el conteo exacto del preview y la confirmación explícita.
  if (!args.yesDeletePermanently) fail("Falta --yes-delete-permanently: este comando BORRA productos de la base (hard delete).");
  if (args.confirmCount !== summary.delete) fail(`--confirm-count (${String(args.confirmCount)}) no coincide con los productos que se borrarían ahora (${String(summary.delete)}). Revisá el preview y volvé a confirmar.`);
  const outcome = new Map<string, string>();
  let deleted = 0;
  let blocked = 0;
  for (const batch of chunkItems(built.candidates, args.chunk)) {
    const expected = previewItems.filter((item) => item.verdict === "DELETE" && batch.some((candidate) => candidate.externalId === item.externalId)).length;
    const { data, error } = await supabase.rpc("purge_import_products", { p_source_system: args.source, p_candidates: payload(batch), p_expected_delete_count: expected });
    if (error) {
      writeFileSync(reportPath, reportCsv(previewItems, outcome), "utf8");
      fail(`La purga se detuvo: ${error.message}\nYa borrado hasta acá: ${String(deleted)}. Es seguro volver a correr el preview y el apply (lo ya borrado figura como sin acción). Reporte parcial: ${reportPath}`);
    }
    const result = data as { deleted: { externalId: string }[]; blocked: { externalId: string; reasons: string[] }[] };
    for (const entry of result.deleted) { outcome.set(entry.externalId, "BORRADO"); deleted += 1; }
    for (const entry of result.blocked) { outcome.set(entry.externalId, `NO BORRADO: ${entry.reasons.join(",")}`); blocked += 1; }
    console.log(`  tanda: ${String(result.deleted.length)} borrados, ${String(result.blocked.length)} bloqueados`);
  }
  writeFileSync(reportPath, reportCsv(previewItems, outcome), "utf8");
  console.log(`\nLISTO — borrados: ${String(deleted)} | bloqueados (no se tocaron): ${String(blocked)}\nReporte final: ${reportPath}`);
}

await main();
