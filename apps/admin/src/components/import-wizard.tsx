"use client";

import {
  detectTableNumberFormat,
  mapCatalogRows,
  normalizeImportText,
  suggestColumnMapping,
  type CatalogColumnMapping
} from "@carnicerias/business-logic";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { loadCurrentCommercialValuesAction, type CurrentCommercialValues } from "../app/admin/imports/actions";
import { loadImportFile, MAX_IMPORT_FILE_ROWS, type LoadedImportFile } from "../lib/imports/read-file";
import {
  cancelPreview,
  describeError,
  ImportApplyError,
  IMPORT_SOURCE_SYSTEM,
  runApply,
  runPreview,
  type ImportApplyOutcome,
  type ImportLinkKey,
  type ImportPreview
} from "../lib/imports/runner";
import { serverImportGateway } from "../lib/imports/server-gateway";
import { importSourceLabel } from "../lib/imports/history";
import { ImportMappingStep, type ImportOptionsState } from "./import-mapping-step";
import { ImportPreviewStep } from "./import-preview-step";

type Stage = "pick" | "mapping" | "analyzing" | "preview" | "applying" | "done";

interface Progress { message: string; done: number | null; total: number | null }

export interface ImportDestinationView {
  name: string;
  code: string;
}

const EMPTY_MAPPING: CatalogColumnMapping = { code: null, name: null, barcode: null, category: null, saleType: null, price: null, cost: null, supplier: null, supplierCode: null, stock: null };

/**
 * The SimplyGest stock is NOT trusted (Central does not keep reliable stock, many products read 0 while on
 * the shelf), so this screen never imports it: no stock column is offered or suggested and no OPENING_BALANCE
 * is ever written from here. The engine's opening-balance batches stay available for a future physical count.
 */
const IMPORT_STOCK = false;

function ProgressBar({ progress }: { progress: Progress }) {
  const ratio = progress.done !== null && progress.total ? Math.min(1, progress.done / progress.total) : null;
  return <div aria-live="polite" className="mt-4">
    <p className="text-sm font-bold text-stone-700">{progress.message}{progress.done !== null && progress.total ? ` · ${progress.done.toLocaleString("es-AR")} de ${progress.total.toLocaleString("es-AR")}` : "…"}</p>
    <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-200"><div className={`h-full rounded-full bg-rose-800 ${ratio === null ? "w-1/3 animate-pulse" : ""}`} style={ratio === null ? undefined : { width: `${String(Math.round(ratio * 100))}%` }} /></div>
  </div>;
}

function Stat({ label, value, tone = "text-stone-900" }: { label: string; value: number; tone?: string }) {
  return <div className="rounded-xl border border-stone-200 px-4 py-3"><p className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}</p><p className={`mt-1 text-2xl font-black ${tone}`}>{value.toLocaleString("es-AR")}</p></div>;
}

export function ImportWizard({ destination, destinationProblem, existingCategoryNames }: {
  destination: ImportDestinationView | null;
  destinationProblem: string | null;
  existingCategoryNames: string[];
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("pick");
  const [file, setFile] = useState<LoadedImportFile | null>(null);
  const [mapping, setMapping] = useState<CatalogColumnMapping>(EMPTY_MAPPING);
  const [options, setOptions] = useState<ImportOptionsState>({ numberFormat: "AR", linkBy: { barcode: true, sku: true } });
  const [progress, setProgress] = useState<Progress>({ message: "", done: null, total: null });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [current, setCurrent] = useState<CurrentCommercialValues>({});
  const [outcome, setOutcome] = useState<ImportApplyOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partialNote, setPartialNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // An apply in flight must not be interrupted by closing the tab by accident.
  useEffect(() => {
    if (stage !== "applying") return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", guard);
    return () => { window.removeEventListener("beforeunload", guard); };
  }, [stage]);

  const reportProgress = (message: string, done?: number, total?: number) => setProgress({ message, done: done ?? null, total: total ?? null });

  async function abandonPreview() {
    if (preview) await cancelPreview(serverImportGateway, preview);
    setPreview(null);
    setCurrent({});
  }

  async function onFileChosen(chosen: File | undefined) {
    if (!chosen) return;
    setError(null);
    setBusy(true);
    try {
      const loaded = await loadImportFile(chosen);
      // Never suggest a stock column: a "stock"/"existencia" header would otherwise be picked up automatically.
      const suggested: CatalogColumnMapping = { ...suggestColumnMapping(loaded.table.headers), stock: null };
      setFile(loaded);
      setMapping(suggested);
      setOptions({ numberFormat: detectTableNumberFormat(loaded.table, suggested), linkBy: { barcode: true, sku: true } });
      setStage("mapping");
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function analyze() {
    if (!file) return;
    setError(null);
    setBusy(true);
    setStage("analyzing");
    reportProgress("Leyendo el archivo");
    try {
      await abandonPreview();
      const mapped = mapCatalogRows(file.table, mapping, { numberFormat: options.numberFormat, importStock: IMPORT_STOCK });
      const linkBy = (Object.keys(options.linkBy) as ImportLinkKey[]).filter((key) => options.linkBy[key]);
      const result = await runPreview(serverImportGateway, mapped.rows, {
        runId: crypto.randomUUID(), fileName: file.fileName, fileSha256: file.sha256, linkBy
      }, reportProgress);
      // Current prices/costs of the products the file refers to (nice-to-have: "$4.500 → $4.800").
      const ids = [...new Set(result.rows.map((entry) => entry.internalId).filter((id): id is string => id !== null))];
      if (ids.length > 0) {
        reportProgress("Comparando con los precios actuales");
        const values = await loadCurrentCommercialValuesAction(ids);
        setCurrent(values.ok ? values.data : {});
      } else {
        setCurrent({});
      }
      setPreview(result);
      setStage("preview");
    } catch (reason) {
      setError(describeError(reason));
      setStage("mapping");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(skipErrors: boolean) {
    if (!preview) return;
    setError(null);
    setPartialNote(null);
    setBusy(true);
    setStage("applying");
    reportProgress("Importando");
    try {
      const result = await runApply(serverImportGateway, preview, { skipErrors, importStock: IMPORT_STOCK }, reportProgress);
      setOutcome(result);
      setStage("done");
      router.refresh();
    } catch (reason) {
      setError(describeError(reason));
      if (reason instanceof ImportApplyError) {
        const { products } = reason.partial;
        setPartialNote(reason.stage === "stock"
          ? `Los productos ya se importaron (${String(products.created)} nuevos, ${String(products.updated)} actualizados). Falló la carga del stock: volvé a importar el mismo archivo para reintentarla; lo ya importado figurará como “sin cambios”.`
          : `Se alcanzaron a importar ${String(reason.partial.batchesApplied)} de ${String(preview.batches.length)} lotes (${String(products.created)} nuevos, ${String(products.updated)} actualizados). Volvé a cargar el mismo archivo: lo ya importado figurará como “sin cambios” y se continúa desde donde quedó, sin duplicar nada.`);
      }
      setPreview(null);
      setStage("mapping");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function cancelAll() {
    setBusy(true);
    try { await abandonPreview(); } finally { setBusy(false); }
    setFile(null);
    setStage("pick");
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setOutcome(null);
    setError(null);
    setPartialNote(null);
    setStage("pick");
  }

  const known = new Set(existingCategoryNames.map(normalizeImportText));
  const newCategories: string[] = [];
  if (preview) {
    const seen = new Set<string>();
    for (const entry of preview.rows) {
      const name = entry.row.display.category;
      if (entry.action === "ERROR" || name === "") continue;
      const key = normalizeImportText(name);
      if (!known.has(key) && !seen.has(key)) { seen.add(key); newCategories.push(name); }
    }
  }

  return <div>
    <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="text-xl font-black">Importar productos</h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-stone-50 px-4 py-3"><dt className="text-xs font-bold uppercase tracking-wider text-stone-500">Origen</dt><dd className="mt-1 font-black">{importSourceLabel(IMPORT_SOURCE_SYSTEM)}</dd></div>
        <div className="rounded-lg bg-stone-50 px-4 py-3"><dt className="text-xs font-bold uppercase tracking-wider text-stone-500">Sucursal destino</dt><dd className="mt-1 font-black">{destination ? destination.name.toUpperCase() : "—"}</dd><dd className="mt-0.5 text-xs text-stone-500">Los productos nuevos se habilitan sólo acá. Avenida y Janssen no se modifican.</dd></div>
      </dl>

      {destination === null ? <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{destinationProblem ?? "No se pudo determinar la sucursal destino."}</p> : null}

      {stage === "pick" && destination !== null ? <div className="mt-5">
        <input accept=".csv,.tsv,.txt,.xlsx" className="sr-only" id="import-file" onChange={(event) => { void onFileChosen(event.target.files?.[0]); }} ref={fileInput} type="file" />
        <label className={`inline-flex cursor-pointer rounded-lg bg-rose-800 px-5 py-2.5 text-sm font-bold text-white hover:bg-rose-900 ${busy ? "pointer-events-none opacity-60" : ""}`} htmlFor="import-file">{busy ? "Leyendo…" : "Seleccionar archivo"}</label>
        <p className="mt-2 text-xs text-stone-500">CSV o Excel (.xlsx), hasta {MAX_IMPORT_FILE_ROWS.toLocaleString("es-AR")} filas. Los encabezados pueden llamarse como quieras: en el próximo paso indicás qué es cada columna. Si tu archivo es .xls, guardalo antes como .xlsx o CSV.</p>
      </div> : null}

      {error ? <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm font-medium text-red-800" role="alert">{error}</p> : null}
      {partialNote ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{partialNote}</p> : null}
    </section>

    {stage === "mapping" && file ? <ImportMappingStep
      busy={busy}
      fileSummary={`${file.fileName} · ${file.table.rows.length.toLocaleString("es-AR")} filas · ${file.format === "xlsx" ? "Excel" : "CSV"}`}
      mapping={mapping}
      onAnalyze={() => { void analyze(); }}
      onChooseAnother={() => { void cancelAll(); }}
      onMappingChange={setMapping}
      onOptionsChange={setOptions}
      options={options}
      table={file.table}
    /> : null}

    {stage === "analyzing" || stage === "applying" ? <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="text-xl font-black">{stage === "analyzing" ? "Analizando el archivo" : "Importando"}</h2>
      <p className="mt-1 text-sm text-stone-600">{stage === "analyzing" ? "Se compara cada fila con lo que ya existe. Todavía no se escribe nada." : "No cierres esta pestaña hasta que termine."}</p>
      <ProgressBar progress={progress} />
    </section> : null}

    {stage === "preview" && preview && destination ? <ImportPreviewStep
      busy={busy}
      current={current}
      destinationName={destination.name}
      newCategories={newCategories}
      onBack={() => { void abandonPreview().then(() => { setStage("mapping"); }); }}
      onCancel={() => { void cancelAll(); }}
      onConfirm={(skipErrors) => { void confirm(skipErrors); }}
      preview={preview}
    /> : null}

    {stage === "done" && outcome ? <section className="mt-6 rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm">
      <h2 className="text-xl font-black text-emerald-800">Importación completada</h2>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Nuevos" tone="text-emerald-700" value={outcome.products.created} />
        <Stat label="Actualizados" tone="text-sky-700" value={outcome.products.updated} />
        <Stat label="Sin cambios" value={outcome.products.ignored} />
        <Stat label="Omitidos por error" tone={outcome.products.skippedErrors > 0 ? "text-red-700" : "text-stone-400"} value={outcome.products.skippedErrors} />
      </div>
      {preview && (preview.totals.suppliersNew > 0 || preview.totals.suppliersReused > 0) ? <p className="mt-4 text-sm text-stone-700">🏷️ Proveedores: <strong>{preview.totals.suppliersNew.toLocaleString("es-AR")}</strong> nuevo{preview.totals.suppliersNew === 1 ? "" : "s"} · <strong>{preview.totals.suppliersReused.toLocaleString("es-AR")}</strong> ya existente{preview.totals.suppliersReused === 1 ? "" : "s"} (reutilizado{preview.totals.suppliersReused === 1 ? "" : "s"}).</p> : null}
      <p className="mt-2 text-sm text-stone-600">📦 No se importó stock: los productos empiezan sin movimientos. {destination?.name ?? "Central"} no depende del stock para mostrar ni vender.</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <button className="rounded-lg bg-rose-800 px-5 py-2.5 text-sm font-bold text-white hover:bg-rose-900" onClick={reset} type="button">Importar otro archivo</button>
        <a className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-bold text-stone-700 hover:bg-stone-50" href="#historial">Ver historial</a>
      </div>
    </section> : null}
  </div>;
}
