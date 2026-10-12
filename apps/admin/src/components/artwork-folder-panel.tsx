"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { deleteFolderAction, ensurePhotoAlphaAction, loadFolderFactsAction } from "../app/admin/products/artwork/folder-actions";
import {
  expiryText, FOLDER_STATE_LABELS, folderFormatsLabel, folderItemsLabel, isGeneratable, parseFolderFacts, reviewFolder, zipFilename,
  type FolderFacts, type FolderItemFacts, type FolderSummary
} from "../lib/artwork-folders";
import {
  buildRunZip, looseFilename, mergeRetry, pieceFilenames, pieceKey, runFolderGeneration, type FetchJson, type RunFormat, type RunPiece, type RunProgress, type RunResult
} from "../lib/artwork-folder-run";
import type { ArtworkBranchOption } from "./artwork-workspace";

const primary = "rounded-lg bg-rose-800 px-5 py-3 text-base font-black text-white hover:bg-rose-900 disabled:opacity-50 max-sm:w-full";
const secondary = "rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-bold text-stone-700 hover:bg-stone-50 disabled:opacity-50";
const chipWarn = "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800";

type FactsState =
  | { status: "loading" }
  | { status: "ready"; facts: FolderFacts; thumbnails: Record<string, string> }
  | { status: "error"; message: string };

type RunState =
  | { status: "idle" }
  | { status: "running"; progress: RunProgress; formats: RunFormat[] }
  | { status: "done"; result: RunResult; folderName: string; formats: RunFormat[]; finishedAt: Date };

const fetchJson: FetchJson = (url, init) => fetch(url, init);

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
}

function pngBlob(bytes: Uint8Array): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}

function ItemRow({ item, thumbnail, included, onToggle, now }: { item: FolderItemFacts; thumbnail: string | null; included: boolean; onToggle: () => void; now: Date }) {
  const generatable = isGeneratable(item);
  return <li className={`flex items-start gap-3 px-3 py-2.5 ${generatable ? "" : "bg-stone-50"}`} data-state={item.state} data-testid="folder-item">
    <input aria-label={`Incluir ${item.name}`} checked={generatable && included} className="mt-5" disabled={!generatable} onChange={onToggle} type="checkbox" />
    <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-stone-200 bg-white">
      {thumbnail ? <img alt="" className="size-full object-contain" height={56} src={thumbnail} width={56} /> : <span className="text-[10px] font-bold text-stone-400">Sin foto</span>}
    </div>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-bold">{item.name}{item.kind === "PRODUCT" ? <span className="ml-2 text-xs font-normal text-stone-500">sin promoción</span> : null}</p>
      <p className={`text-sm ${generatable ? "text-stone-700" : "text-stone-400 line-through"}`}>{generatable ? item.summary : item.facts ? "Precio no disponible hoy" : FOLDER_STATE_LABELS[item.state]}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {!generatable ? <span className={chipWarn}>⚠ {FOLDER_STATE_LABELS[item.state]}</span> : null}
        {generatable && !item.hasPhoto ? <span className={chipWarn}>⚠ Sin foto</span> : null}
        {generatable && item.expiresSoon && item.validUntil ? <span className={chipWarn}>{expiryText(item.validUntil, now)}</span> : null}
        {!generatable ? <span className="text-xs text-stone-500">No se genera; la carpeta conserva la referencia.</span> : null}
      </div>
    </div>
  </li>;
}

function PieceCard({ piece, previewUrl, filename }: { piece: RunPiece; previewUrl: string | null; filename: string | null }) {
  const ok = piece.status === "OK" && piece.png;
  return <li className="grid gap-2 rounded-xl border border-stone-200 bg-white p-2" data-status={piece.status} data-testid="run-piece">
    <div className="grid aspect-[4/5] place-items-center overflow-hidden rounded-lg bg-stone-100">
      {ok && previewUrl ? <img alt={`${piece.productName} ${piece.format}`} className="h-full w-full object-contain" src={previewUrl} /> : <span className="px-2 text-center text-xs font-bold text-amber-800">{piece.status === "SKIPPED" ? "No se generó" : "Falló"}</span>}
    </div>
    <div className="min-w-0">
      <p className="truncate text-xs font-bold">{piece.productName} · {piece.format === "feed" ? "Feed" : "Story"}</p>
      {ok ? <p className="truncate text-xs text-stone-500">{piece.summary}</p> : <p className="text-xs text-amber-800">{piece.message}</p>}
      {ok && piece.warnings.includes("NO_PHOTO") ? <p className="text-xs font-bold text-amber-800">⚠ Sin foto</p> : null}
    </div>
    {ok && filename ? <button className="text-left text-xs font-bold text-rose-800 hover:underline" onClick={() => { if (piece.png) downloadBlob(pngBlob(piece.png), looseFilename(filename, piece.format)); }} type="button">Descargar PNG</button> : null}
  </li>;
}

/**
 * Una carpeta abierta (D-086): el estado de HOY de lo que contiene (precios y promociones vigentes, fotos, vencimientos) y el botón
 * «Generar todo actualizado», que arma todas las gráficas Feed/Story en el servidor con los datos de este momento. Sin confirmar una por
 * una; al terminar, «Descargar todo» entrega un ZIP ordenado por formato.
 */
export function ArtworkFolderPanel({ folder, branches, defaultBranchId, onBack, onEdit, onDeleted }: {
  folder: FolderSummary;
  branches: ArtworkBranchOption[];
  defaultBranchId: string;
  onBack: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [factsState, setFactsState] = useState<FactsState>({ status: "loading" });
  const [feed, setFeed] = useState(folder.generateFeed);
  const [story, setStory] = useState(folder.generateStory);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [healed, setHealed] = useState(0);
  const loadRequest = useRef(0);
  const now = useMemo(() => new Date(), [factsState]);

  // Estado de HOY de la carpeta para la sucursal elegida (una sola consulta; nada queda guardado en el navegador).
  useEffect(() => {
    const requestId = ++loadRequest.current;
    setFactsState({ status: "loading" });
    void loadFolderFactsAction(folder.id, branchId || null).then((result) => {
      if (loadRequest.current !== requestId) return;
      if (result.kind === "ok") {
        const facts = parseFolderFacts(result.raw, new Date(result.loadedAt));
        setFactsState(facts ? { status: "ready", facts, thumbnails: result.thumbnails } : { status: "error", message: "La carpeta ya no existe" });
      } else setFactsState({ status: "error", message: result.kind === "error" ? result.message : "La carpeta ya no existe" });
    }).catch(() => { if (loadRequest.current === requestId) setFactsState({ status: "error", message: "No se pudo leer la carpeta" }); });
  }, [folder.id, branchId, healed]);

  // Las fotos PNG todavía sin analizar (subidas antes de este dato) se completan una vez, en segundo plano: así el recorte se aprovecha.
  const unanalyzed = factsState.status === "ready"
    ? factsState.facts.items.flatMap((item) => item.photo?.contentType === "image/png" && (item.photo.hasAlpha === null || item.photo.hasAlpha === undefined) ? [{ productId: item.productId, storagePath: item.photo.storagePath }] : [])
    : [];
  const unanalyzedKey = unanalyzed.map((photo) => photo.storagePath).join("|");
  useEffect(() => {
    if (!unanalyzed.length) return;
    let cancelled = false;
    void ensurePhotoAlphaAction(unanalyzed).then((outcome) => { if (!cancelled && Object.keys(outcome.result).length) setHealed((value) => value + 1); });
    return () => { cancelled = true; };
  }, [unanalyzedKey]);

  const facts = factsState.status === "ready" ? factsState.facts : null;
  const review = facts ? reviewFolder(facts) : null;
  const formats: RunFormat[] = [...(feed ? ["feed" as const] : []), ...(story ? ["story" as const] : [])];
  const selected = facts ? facts.items.filter((item) => isGeneratable(item) && !excluded.has(item.itemId)) : [];
  const running = run.status === "running";
  const canGenerate = factsState.status === "ready" && selected.length > 0 && formats.length > 0 && !running;

  // Vistas previas de lo generado (URLs locales que se liberan al cambiar o salir).
  const previews = useMemo(() => {
    if (run.status !== "done") return new Map<string, string>();
    return new Map(run.result.pieces.flatMap((piece) => piece.png ? [[`${piece.itemId}:${piece.format}`, URL.createObjectURL(pngBlob(piece.png))] as const] : []));
  }, [run]);
  useEffect(() => () => { for (const url of previews.values()) URL.revokeObjectURL(url); }, [previews]);

  async function generate(onlyItems?: ReadonlySet<string>) {
    if (!facts) return;
    setActionError(null);
    const ready = facts.items.filter((item) => isGeneratable(item) && !excluded.has(item.itemId) && (!onlyItems || onlyItems.has(item.itemId)));
    const skipped = facts.items.filter((item) => !isGeneratable(item)).map((item) => ({ itemId: item.itemId, name: item.name, message: FOLDER_STATE_LABELS[item.state] }));
    setRun({ status: "running", progress: { done: 0, total: ready.length * formats.length }, formats });
    const result = await runFolderGeneration({
      fetchJson, folderId: folder.id, branchId: branchId || null, items: ready.map((item) => ({ itemId: item.itemId, name: item.name })), skipped, formats,
      onProgress: (progress) => { setRun({ status: "running", progress, formats }); }
    });
    // «Reintentar los que fallaron»: lo que ya estaba bien se conserva y sólo se reemplazan las piezas de los elementos reintentados.
    const previous = onlyItems && run.status === "done" ? run.result.pieces : null;
    const merged = previous && onlyItems ? mergeRetry(previous, onlyItems, result.pieces, facts.items.map((item) => item.itemId)) : result;
    setRun({ status: "done", result: merged, folderName: facts.name, formats, finishedAt: new Date() });
  }

  function downloadAll() {
    if (run.status !== "done") return;
    const zip = buildRunZip(run.folderName, run.finishedAt, run.result.pieces);
    if (!zip) { setActionError("No hay piezas generadas para descargar."); return; }
    downloadBlob(new Blob([new Uint8Array(zip)], { type: "application/zip" }), zipFilename(run.folderName, run.finishedAt));
  }

  async function remove() {
    if (!window.confirm(`¿Eliminar la carpeta «${folder.name}»? Las promociones y los productos no se borran.`)) return;
    const outcome = await deleteFolderAction(folder.id);
    if (outcome.error) { setActionError(outcome.error); return; }
    onDeleted();
  }

  const filenames = run.status === "done" ? pieceFilenames(run.result.pieces) : null;

  return <section className="mt-5 grid gap-5" data-testid="folder-panel">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <button className="text-sm font-bold text-rose-800 hover:underline" onClick={onBack} type="button">← Carpetas</button>
        <h2 className="mt-1 text-2xl font-black">{folder.name}</h2>
        <p className="text-sm text-stone-600">{folderItemsLabel(facts?.items.length ?? folder.items.length)} · {folderFormatsLabel({ generateFeed: feed, generateStory: story })}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={secondary} onClick={onEdit} type="button">Editar carpeta</button>
        <button className={`${secondary} text-red-700`} onClick={() => { void remove(); }} type="button">Eliminar</button>
      </div>
    </div>

    <div className="grid gap-4 rounded-xl bg-white p-4 shadow-sm md:grid-cols-[1fr_auto] md:items-end">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-bold" htmlFor="folder-branch">Sucursal (precios, promociones y contacto)
          <select className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-normal" id="folder-branch" onChange={(event) => { setBranchId(event.target.value); setRun({ status: "idle" }); }} value={branchId}>
            <option value="">Precio general (sin sucursal)</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.active ? "" : " (inactiva)"}</option>)}
          </select>
        </label>
        <fieldset className="grid gap-1 text-sm font-bold">
          <legend className="mb-1">Formatos</legend>
          <div className="flex gap-5 font-normal">
            <label className="flex items-center gap-2"><input checked={feed} disabled={running} onChange={(event) => { setFeed(event.target.checked); }} type="checkbox" /> Feed 1080×1350</label>
            <label className="flex items-center gap-2"><input checked={story} disabled={running} onChange={(event) => { setStory(event.target.checked); }} type="checkbox" /> Story 1080×1920</label>
          </div>
        </fieldset>
      </div>
      <button className={primary} data-testid="generate-all" disabled={!canGenerate} onClick={() => { void generate(); }} type="button">
        {running ? `Generando… ${String(run.progress.done)} / ${String(run.progress.total)}` : "Generar todo actualizado"}
      </button>
    </div>

    {factsState.status === "loading" ? <p className="rounded-xl bg-white p-6 text-center text-stone-500" role="status">Revisando precios, promociones y fotos de hoy…</p> : null}
    {factsState.status === "error" ? <p className="rounded-lg bg-red-50 p-4 text-red-800" role="alert">{factsState.message}</p> : null}
    {actionError ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{actionError}</p> : null}

    {review && facts ? <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <aside className="grid content-start gap-2 rounded-xl bg-white p-4 shadow-sm" data-testid="folder-review">
        <p className="text-sm font-black">Estado de hoy</p>
        <p className="text-sm text-stone-600">{review.ready} de {review.total} se generan{formats.length ? ` · ${String(selected.length * formats.length)} piezas` : ""}</p>
        <ul className="grid gap-1 text-sm">
          {review.lines.map((line) => <li className={line.tone === "ok" ? "text-emerald-800" : "font-bold text-amber-800"} key={line.text}>{line.tone === "ok" ? "✓" : "⚠"} {line.text}</li>)}
          {!review.lines.length ? <li className="text-stone-500">Nada vigente para generar.</li> : null}
        </ul>
      </aside>
      <ol className="divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white" data-testid="folder-items">
        {facts.items.map((item) => <ItemRow
          included={!excluded.has(item.itemId)} item={item} key={item.itemId} now={now}
          onToggle={() => { setExcluded((current) => { const next = new Set(current); if (next.has(item.itemId)) next.delete(item.itemId); else next.add(item.itemId); return next; }); }}
          thumbnail={item.photo ? (factsState.status === "ready" ? factsState.thumbnails[item.photo.storagePath] ?? null : null) : null}
        />)}
      </ol>
    </div> : null}

    {run.status === "running" ? <div aria-label="Progreso" className="grid gap-2 rounded-xl bg-white p-4 shadow-sm" role="status">
      <p className="text-sm font-bold">Generando… {run.progress.done} / {run.progress.total}</p>
      <div className="h-2 overflow-hidden rounded-full bg-stone-200"><div className="h-full bg-rose-800 transition-all" style={{ width: `${String(run.progress.total ? Math.round((run.progress.done / run.progress.total) * 100) : 0)}%` }} /></div>
    </div> : null}

    {run.status === "done" ? <div className="grid gap-4 rounded-xl bg-white p-4 shadow-sm" data-testid="run-result">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className="text-base font-black text-emerald-800">✓ {run.result.generated} {run.result.generated === 1 ? "generada" : "generadas"}</p>
        {run.result.needsReview > 0 ? <p className="text-base font-black text-amber-800">⚠ {run.result.needsReview} {run.result.needsReview === 1 ? "requiere revisión" : "requieren revisión"}</p> : null}
        {run.result.withoutPhoto > 0 ? <p className="text-sm font-bold text-amber-800">{run.result.withoutPhoto} sin foto (panel de reemplazo)</p> : null}
      </div>
      <div className="flex flex-wrap gap-3">
        <button className={primary} data-testid="download-all" disabled={run.result.generated === 0} onClick={downloadAll} type="button">Descargar todo (ZIP)</button>
        {run.result.retryItemIds.length > 0 ? <button className={secondary} onClick={() => { void generate(new Set(run.result.retryItemIds)); }} type="button">Reintentar los que fallaron</button> : null}
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {run.result.pieces.map((piece) => <PieceCard filename={filenames?.get(pieceKey(piece)) ?? null} key={pieceKey(piece)} piece={piece} previewUrl={previews.get(pieceKey(piece)) ?? null} />)}
      </ul>
    </div> : null}
  </section>;
}
