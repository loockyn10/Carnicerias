"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type Dispatch, type SetStateAction, type SyntheticEvent } from "react";

import { saveLabelGroupAction, searchLabelProductsAction, setLabelGroupProductsAction, type LabelProductOption } from "../app/admin/products/labels/actions";
import type { LabelGroupItemView, LabelGroupView } from "../lib/label-group";
import { buildRunSelection, labelSelectionKey, sheetsFor } from "../lib/label-selection";
import { matchesLabelSearch } from "../lib/label-search";
import { LABEL_HEIGHT_MM, LABEL_WIDTH_MM, LABELS_PER_SHEET, MAX_LABEL_COPIES, MAX_LABELS_PER_RUN } from "../lib/label-spec";
import { ProductPriceLabel } from "./product-price-label";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const primaryButton = "rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50";
const secondaryButton = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold disabled:opacity-40";
const PREVIEW_SCALE = 3.2;

export interface BranchOption { id: string; name: string; active: boolean }
export interface LabelGroupSummary { groupId: string; name: string; branchId: string | null; branchName: string | null; itemCount: number }
export interface LabelRunRow { id: string; groupId: string; groupName: string; whenText: string; labelCount: number; productCount: number }
export interface LabelRunDetail { run: LabelRunRow; items: { productName: string; copies: number; text: string; condition: string | null }[] }

const number = (value: number) => value.toLocaleString("es-AR");

// ---------------------------------------------------------------------------------------------------------------------
// Grupo: elegir / crear / editar
// ---------------------------------------------------------------------------------------------------------------------

function GroupForm({ group, branches, onClose }: { group: LabelGroupView | null; branches: BranchOption[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(group?.name ?? "");
  const [branchId, setBranchId] = useState(group?.branchId ?? "");
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await saveLabelGroupAction({ groupId: group?.groupId ?? null, name, branchId: branchId || null, active: !archived });
      if (result.error || !result.groupId) { setError(result.error ?? "No se pudo guardar el grupo"); return; }
      onClose();
      if (archived) router.push("/admin/products/labels");
      else if (!group) router.push(`/admin/products/labels?group=${result.groupId}`);
      else router.refresh();
    });
  }

  return <form className="mt-4 grid gap-3 rounded-lg border border-stone-200 bg-stone-50 p-4" data-testid="label-group-form" onSubmit={submit}>
    <h3 className="text-base font-black">{group ? "Editar grupo" : "Nuevo grupo"}</h3>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-bold" htmlFor="label-group-name">Nombre
        <input className={`${input} font-normal`} id="label-group-name" maxLength={80} onChange={(event) => { setName(event.target.value); }} placeholder="Góndolas Despensa Central" value={name} />
      </label>
      <label className="grid gap-1 text-sm font-bold" htmlFor="label-group-branch">Sucursal (precio y promoción)
        <select className={`${input} font-normal`} id="label-group-branch" onChange={(event) => { setBranchId(event.target.value); }} value={branchId}>
          <option value="">Sin sucursal (precio global)</option>
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.active ? "" : " (inactiva)"}</option>)}
        </select>
      </label>
    </div>
    <p className="text-xs text-stone-500">La etiqueta lleva el mismo precio y la misma promoción «llevando 3u» que el POS de esa sucursal.</p>
    {group ? <label className="flex items-center gap-2 text-sm font-bold">
      <input checked={archived} onChange={(event) => { setArchived(event.target.checked); }} type="checkbox" />
      Archivar este grupo <span className="font-normal text-stone-500">(deja de aparecer; el historial se conserva)</span>
    </label> : null}
    <div className="flex flex-wrap items-center gap-2">
      <button className={primaryButton} disabled={pending || !name.trim()} type="submit">{pending ? "Guardando…" : "Guardar"}</button>
      <button className={secondaryButton} disabled={pending} onClick={onClose} type="button">Cancelar</button>
    </div>
    {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
  </form>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Agregar productos en lote
// ---------------------------------------------------------------------------------------------------------------------

function AddProducts({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<LabelProductOption[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const addable = (options ?? []).filter((option) => !option.inGroup);

  function search(event: SyntheticEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await searchLabelProductsAction({ groupId, query });
      if (result.error || !result.options) { setError(result.error ?? "No se pudo buscar"); return; }
      setOptions(result.options);
      setChosen(new Set());
    });
  }

  function add() {
    setError(null);
    startTransition(async () => {
      const ids = [...chosen];
      const result = await setLabelGroupProductsAction({ groupId, add: ids, remove: [] });
      if (result.error) { setError(result.error); return; }
      setNotice(`Se agregaron ${number(result.added ?? 0)} productos al grupo.`);
      setChosen(new Set());
      setOptions((current) => current?.map((option) => (ids.includes(option.productId) ? { ...option, inGroup: true } : option)) ?? null);
      router.refresh();
    });
  }

  return <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4" data-testid="label-add-products">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-base font-black">Agregar productos al grupo</h3>
      <button className="text-sm font-bold text-stone-500 hover:underline" onClick={onClose} type="button">Cerrar</button>
    </div>
    <form className="mt-3 flex gap-2" onSubmit={search}>
      <input aria-label="Buscar productos" className={`${input} min-w-0 flex-1`} onChange={(event) => { setQuery(event.target.value); }} placeholder="Nombre, SKU o código de barras…" value={query} />
      <button className={secondaryButton} disabled={pending} type="submit">Buscar</button>
    </form>
    {options ? <>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <button className="font-bold text-rose-800 hover:underline disabled:opacity-40" disabled={!addable.length} onClick={() => { setChosen(new Set(addable.map((option) => option.productId))); }} type="button">Seleccionar todos los resultados ({addable.length})</button>
        <button className="font-bold text-stone-600 hover:underline disabled:opacity-40" disabled={!chosen.size} onClick={() => { setChosen(new Set()); }} type="button">Limpiar</button>
      </div>
      <ul className="mt-2 max-h-72 divide-y divide-stone-100 overflow-y-auto rounded-lg border border-stone-200 bg-white" data-testid="label-search-results">
        {options.map((option) => <li className="flex items-center gap-3 px-3 py-2 text-sm" key={option.productId}>
          <input
            aria-label={`Agregar ${option.name}`} checked={option.inGroup || chosen.has(option.productId)} disabled={option.inGroup}
            onChange={(event) => { setChosen((current) => { const next = new Set(current); if (event.target.checked) next.add(option.productId); else next.delete(option.productId); return next; }); }}
            type="checkbox"
          />
          <span className="min-w-0 flex-1 truncate">{option.name}{option.sku ? <span className="ml-2 text-xs text-stone-500">{option.sku}</span> : null}<span className="ml-2 text-xs text-stone-500">{option.unitType === "WEIGHT" ? "por kg" : "por unidad"}</span></span>
          {option.inGroup ? <span className="text-xs font-bold text-stone-500">Ya está en el grupo</span> : null}
        </li>)}
        {!options.length ? <li className="px-3 py-3 text-sm text-stone-500">No hay productos para esa búsqueda.</li> : null}
      </ul>
      <button className={`${primaryButton} mt-3`} disabled={pending || !chosen.size} onClick={add} type="button">{pending ? "Agregando…" : `Agregar ${number(chosen.size)} al grupo`}</button>
    </> : null}
    {error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
    {notice ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{notice}</p> : null}
  </div>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Productos del grupo + vista previa + generar PDF
// ---------------------------------------------------------------------------------------------------------------------

function StatusChip({ item }: { item: LabelGroupItemView }) {
  if (!item.printable) return <span className="rounded-full bg-stone-200 px-2 py-0.5 text-xs font-bold text-stone-700">{item.unavailableText ?? "No imprimible"}</span>;
  const tone = item.freshness === "UPDATED" ? "bg-emerald-100 text-emerald-800" : item.freshness === "CHANGED" ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${tone}`} data-freshness={item.freshness ?? ""}>{item.freshnessText}</span>;
}

function filenameFrom(disposition: string | null): string {
  const match = disposition ? /filename="?([^";]+)"?/i.exec(disposition) : null;
  return match?.[1] ?? "etiquetas.pdf";
}

type WorkspaceItem = LabelGroupItemView & { groupId: string; groupName: string };
const ITEMS_PER_PAGE = 100;

function GroupItems({ group, branchGroups, branchId, allMode, selected, setSelected, copies, setCopies }: {
  group: LabelGroupView; branchGroups: LabelGroupView[]; selected: Set<string>; setSelected: Dispatch<SetStateAction<Set<string>>>;
  copies: Record<string, string>; setCopies: Dispatch<SetStateAction<Record<string, string>>>;
  branchId: string | null; allMode: boolean;
}) {
  const router = useRouter();
  const sourceGroups = allMode ? branchGroups : [group];
  const items: WorkspaceItem[] = sourceGroups.flatMap((entry) => entry.items.map((item) => ({ ...item, groupId: entry.groupId, groupName: entry.name })));
  const [previewId, setPreviewId] = useState<string | null>(items[0] ? labelSelectionKey(items[0].groupId, items[0].productId) : null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [generating, setGenerating] = useState(false);

  // Lo tildado que ya no es del grupo (se quitó) no cuenta.
  const active = useMemo(() => new Set(group.items.filter((item) => selected.has(labelSelectionKey(group.groupId, item.productId))).map((item) => item.productId)), [group.groupId, group.items, selected]);
  const currentCopies = useMemo(() => Object.fromEntries(items.map((item) => [item.productId, copies[labelSelectionKey(group.groupId, item.productId)] ?? "1"])), [copies, group.groupId, items]);
  const currentRun = buildRunSelection(group.items, active, currentCopies);
  const selectionGroups = (allMode || group.branchId) && branchGroups.length ? branchGroups : [group];
  const globalRuns = selectionGroups.map((entry) => ({ group: entry, run: buildRunSelection(entry.items, new Set(entry.items.filter((item) => selected.has(labelSelectionKey(entry.groupId, item.productId))).map((item) => item.productId)), Object.fromEntries(entry.items.map((item) => [item.productId, copies[labelSelectionKey(entry.groupId, item.productId)] ?? "1"]))) }));
  const run = {
    items: globalRuns.flatMap(({ group: entry, run: groupRun }) => groupRun.items.map((item) => ({ ...item, groupId: entry.groupId }))),
    labelCount: globalRuns.reduce((total, entry) => total + entry.run.labelCount, 0),
    invalidCopies: globalRuns.flatMap((entry) => entry.run.invalidCopies),
    overLimit: globalRuns.some((entry) => entry.run.overLimit) || globalRuns.reduce((total, entry) => total + entry.run.labelCount, 0) > MAX_LABELS_PER_RUN
  };
  const sheets = sheetsFor(run.labelCount);
  const filteredItems = useMemo(() => items.filter((item) => matchesLabelSearch(item, query)), [items, query]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / ITEMS_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedItems = filteredItems.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE);
  const changedCount = filteredItems.filter((item) => item.printable && item.needsPrint).length;
  const globalChanged = selectionGroups.flatMap((entry) => entry.items.filter((item) => item.printable && item.needsPrint).map((item) => ({ groupId: entry.groupId, productId: item.productId })));
  const selectedGroupCount = new Set(run.items.map((item) => item.groupId)).size;
  const shouldUseBranchRun = Boolean(branchId && (allMode || (group.branchId && run.items.some((item) => item.groupId !== group.groupId))));
  const previewItem = items.find((item) => labelSelectionKey(item.groupId, item.productId) === previewId) ?? items[0] ?? null;
  const canGenerate = !generating && run.items.length > 0 && !run.invalidCopies.length && !run.overLimit;

  function toggle(groupId: string, productId: string, checked: boolean) {
    const key = labelSelectionKey(groupId, productId);
    setSelected((current) => { const next = new Set(current); if (checked) next.add(key); else next.delete(key); return next; });
    setNotice(null);
  }

  function removeSelected() {
    const ids = [...active];
    if (!ids.length) return;
    if (!window.confirm(`¿Quitar ${number(ids.length)} ${ids.length === 1 ? "producto" : "productos"} del grupo? El historial de impresión se conserva.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await setLabelGroupProductsAction({ groupId: group.groupId, add: [], remove: ids });
      if (result.error) { setError(result.error); return; }
      setSelected((current) => { const next = new Set(current); ids.forEach((id) => { next.delete(labelSelectionKey(group.groupId, id)); }); return next; });
      setNotice(`Se quitaron ${number(result.removed ?? 0)} productos del grupo.`);
      router.refresh();
    });
  }

  async function generate() {
    setError(null);
    setNotice(null);
    setGenerating(true);
    try {
      const response = await fetch("/api/labels/pdf", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(shouldUseBranchRun ? { branchId, items: run.items } : { groupId: group.groupId, items: currentRun.items })
      });
      if (!response.ok || !response.headers.get("Content-Type")?.includes("application/pdf")) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "No se pudo generar el PDF");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(response.headers.get("Content-Disposition"));
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
      const pages = Number(response.headers.get("X-Label-Pages") ?? sheets);
      setNotice(`PDF generado: ${number(run.labelCount)} ${run.labelCount === 1 ? "etiqueta" : "etiquetas"} en ${number(pages)} ${pages === 1 ? "hoja" : "hojas"} A4. Imprimilo al 100 % (tamaño real) y cortá por las guías.`);
      setSelected(new Set());
      router.refresh();
    } catch {
      setError("No se pudo generar el PDF. Revisá la conexión y reintentá.");
    } finally {
      setGenerating(false);
    }
  }

  return <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_28rem]">
    <section className="min-w-0 rounded-xl bg-white p-5 shadow-sm" data-testid="label-group-items">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black">{allMode ? `Todos los grupos (${number(items.length)})` : `Productos del grupo (${number(items.length)})`}</h2>
          <p className="mt-1 text-sm text-stone-600">{allMode ? "Mostrando las etiquetas físicas de todos los grupos de esta sucursal." : group.branchName ? `Precios y promoción de ${group.branchName}.` : "Precios globales de la organización."} El estado compara con la última etiqueta impresa de cada producto en su grupo.</p>
        </div>
        {!allMode ? <button className={secondaryButton} onClick={() => { setShowAdd((open) => !open); }} type="button">+ Agregar productos</button> : null}
      </div>
      {showAdd && !allMode ? <AddProducts groupId={group.groupId} onClose={() => { setShowAdd(false); }} /> : null}

      <label className="mt-4 grid gap-1 text-sm font-bold" htmlFor="label-product-search">Buscar producto
        <input aria-label="Buscar producto" className={`${input} font-normal`} id="label-product-search" onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Buscar producto…" value={query} />
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className={secondaryButton} disabled={!filteredItems.length} onClick={() => { setSelected((current) => new Set([...current, ...filteredItems.filter((item) => item.printable).map((item) => labelSelectionKey(item.groupId, item.productId))])); setNotice(null); }} type="button">Seleccionar todos</button>
        <button className={secondaryButton} disabled={!changedCount} onClick={() => { setSelected((current) => new Set([...current, ...filteredItems.filter((item) => item.printable && item.needsPrint).map((item) => labelSelectionKey(item.groupId, item.productId))])); setNotice(null); }} type="button" title="Los que cambiaron de precio o promoción desde la última impresión y los que nunca se imprimieron">Seleccionar precios cambiados ({changedCount})</button>
        {!allMode && group.branchId ? <button className={secondaryButton} disabled={!globalChanged.length} onClick={() => { setSelected(new Set(globalChanged.map((item) => labelSelectionKey(item.groupId, item.productId)))); setNotice(null); }} type="button">Seleccionar cambios de todos los grupos ({number(globalChanged.length)})</button> : null}
        <button className={secondaryButton} disabled={!selected.size} onClick={() => { setSelected(new Set()); }} type="button">Limpiar</button>
        {!allMode ? <button className={`${secondaryButton} text-red-700`} disabled={!active.size || pending} onClick={removeSelected} type="button">Quitar del grupo</button> : null}
      </div>

      <ul className="mt-3 divide-y divide-stone-100 rounded-lg border border-stone-200" data-testid="label-items">
        {pagedItems.map((item) => <li className={`flex flex-wrap items-center gap-3 px-3 py-2 ${labelSelectionKey(item.groupId, item.productId) === labelSelectionKey(previewItem?.groupId ?? "", previewItem?.productId ?? "") ? "bg-rose-50" : ""}`} data-printable={item.printable} key={labelSelectionKey(item.groupId, item.productId)}>
          <input aria-label={`Seleccionar ${item.name} de ${item.groupName}`} checked={selected.has(labelSelectionKey(item.groupId, item.productId))} disabled={!item.printable} onChange={(event) => { toggle(item.groupId, item.productId, event.target.checked); }} type="checkbox" />
          <button className="min-w-0 flex-1 text-left" onClick={() => { setPreviewId(labelSelectionKey(item.groupId, item.productId)); }} type="button">
            <span className="block truncate text-sm font-bold">{item.name}{item.sku ? <span className="ml-2 text-xs font-normal text-stone-500">{item.sku}</span> : null}<span className="ml-2 text-xs font-normal text-stone-500">{item.unitType === "WEIGHT" ? "por kg" : "por unidad"}</span></span>
            <span className="block text-xs text-stone-500">
              {item.printable ? <>Hoy: {item.currentText}</> : item.unavailableText}
              {item.lastPrintedText ? <> · Impresa: {item.lastPrintedText}{item.lastPrintedAtText ? ` (${item.lastPrintedAtText})` : ""}</> : null}
              {allMode ? <> · Grupo: {item.groupName}</> : null}
            </span>
          </button>
          <StatusChip item={item} />
          <label className="flex items-center gap-1 text-xs font-bold text-stone-600">copias
            <input
              aria-label={`Copias de ${item.name} de ${item.groupName}`} className={`${input} w-16 px-2 py-1 text-center font-normal`} disabled={!item.printable} inputMode="numeric"
              max={MAX_LABEL_COPIES} min={1} onChange={(event) => { setCopies((current) => ({ ...current, [labelSelectionKey(item.groupId, item.productId)]: event.target.value })); setNotice(null); }}
              type="number" value={copies[labelSelectionKey(item.groupId, item.productId)] ?? "1"}
            />
          </label>
        </li>)}
        {!filteredItems.length ? <li className="px-3 py-4 text-sm text-stone-500">No hay etiquetas para esta búsqueda.</li> : null}
      </ul>
      {filteredItems.length > ITEMS_PER_PAGE ? <div className="mt-3 flex items-center justify-between text-sm"><span>{number(currentPage * ITEMS_PER_PAGE + 1)}–{number(Math.min((currentPage + 1) * ITEMS_PER_PAGE, filteredItems.length))} de {number(filteredItems.length)}</span><span className="flex gap-2"><button className={secondaryButton} disabled={currentPage === 0} onClick={() => { setPage((value) => Math.max(0, value - 1)); }} type="button">Anterior</button><button className={secondaryButton} disabled={currentPage >= pageCount - 1} onClick={() => { setPage((value) => Math.min(pageCount - 1, value + 1)); }} type="button">Siguiente</button></span></div> : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-stone-600" data-testid="label-run-summary">
          <strong>{number(run.labelCount)}</strong> {run.labelCount === 1 ? "etiqueta" : "etiquetas"}{selectedGroupCount > 1 ? <> · {number(selectedGroupCount)} grupos</> : null} · {number(sheets)} {sheets === 1 ? "hoja" : "hojas"} A4 ({LABELS_PER_SHEET} por hoja)
          {run.invalidCopies.length ? <span className="ml-2 font-bold text-amber-700">Revisá las copias: entero de 1 a {MAX_LABEL_COPIES}.</span> : null}
          {run.overLimit ? <span className="ml-2 font-bold text-amber-700">Máximo {number(MAX_LABELS_PER_RUN)} etiquetas por PDF.</span> : null}
        </p>
        <button className={primaryButton} data-testid="label-generate" disabled={!canGenerate} onClick={() => { void generate(); }} type="button">{generating ? "Generando…" : "Generar PDF"}</button>
      </div>
      {error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
      {notice ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{notice}</p> : null}
    </section>

    <section className="min-w-0 self-start rounded-xl bg-white p-5 shadow-sm" data-testid="label-preview">
      <h2 className="text-lg font-black">Vista previa</h2>
      {previewItem ? <>
        <p className="mt-1 truncate text-sm text-stone-600">{previewItem.name}</p>
        <div className="mt-3 border border-stone-300 shadow-sm" data-testid="label-preview-frame"><ProductPriceLabel fluid layout={previewItem.layout} scale={PREVIEW_SCALE} /></div>
        <p className="mt-2 text-sm font-bold text-stone-700">Tamaño: {LABEL_WIDTH_MM} × {LABEL_HEIGHT_MM} mm <span className="font-normal text-stone-500">(vista ampliada; el PDF usa este mismo diseño)</span></p>
        {!previewItem.printable ? <p className="mt-2 text-sm text-amber-700">Este producto no se puede imprimir hoy: {previewItem.unavailableText?.toLowerCase()}.</p> : null}
      </> : <p className="mt-3 text-sm text-stone-500">Agregá productos al grupo para ver su etiqueta.</p>}
    </section>
  </div>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------------------------------------------------

function History({ runs, detail }: { runs: LabelRunRow[]; detail: LabelRunDetail | null }) {
  return <section className="rounded-xl bg-white p-5 shadow-sm" data-testid="label-history">
    <h2 className="text-lg font-black">Últimas generaciones</h2>
    <p className="mt-1 text-sm text-stone-600">Qué se imprimió y con qué precios. Es historial: no es el precio vigente.</p>
    <ul className="mt-3 divide-y divide-stone-100 rounded-lg border border-stone-200">
      {runs.map((row) => <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" key={row.id}>
        <span><strong>{row.whenText}</strong> · {row.groupName} · {number(row.labelCount)} {row.labelCount === 1 ? "etiqueta" : "etiquetas"} <span className="text-xs text-stone-500">({number(row.productCount)} {row.productCount === 1 ? "producto" : "productos"})</span></span>
        <Link className="font-bold text-rose-800 hover:underline" href={`/admin/products/labels?group=${row.groupId}&run=${row.id}`}>Ver detalle</Link>
      </li>)}
      {!runs.length ? <li className="px-3 py-4 text-sm text-stone-500">Todavía no se generó ningún PDF.</li> : null}
    </ul>
    {detail ? <div className="mt-4" data-testid="label-run-detail">
      <h3 className="text-base font-black">Detalle: {detail.run.whenText} · {detail.run.groupName}</h3>
      <table className="mt-2 w-full text-left text-sm">
        <thead className="text-xs uppercase text-stone-500"><tr><th className="py-1 pr-3">Producto</th><th className="py-1 pr-3">Copias</th><th className="py-1 pr-3">Precio impreso</th><th className="py-1">Condición</th></tr></thead>
        <tbody className="divide-y divide-stone-100">
          {detail.items.map((row, index) => <tr key={`${row.productName}-${String(index)}`}><td className="py-1 pr-3 font-bold">{row.productName}</td><td className="py-1 pr-3">{row.copies}</td><td className="py-1 pr-3">{row.text}</td><td className="py-1 text-stone-600">{row.condition ?? "—"}</td></tr>)}
        </tbody>
      </table>
    </div> : null}
  </section>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------------------------------------------------

export function LabelGroupsWorkspace({ groups, group, branchGroups, branchId, allMode, branches, runs, runDetail }: {
  groups: LabelGroupSummary[]; group: LabelGroupView | null; branchGroups: LabelGroupView[]; branchId: string | null; allMode: boolean; branches: BranchOption[]; runs: LabelRunRow[]; runDetail: LabelRunDetail | null;
}) {
  const router = useRouter();
  const [form, setForm] = useState<"create" | "edit" | null>(groups.length ? null : "create");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copies, setCopies] = useState<Record<string, string>>({});

  return <div className="mt-6 grid gap-6">
    <section className="rounded-xl bg-white p-5 shadow-sm" data-testid="label-group-bar">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm font-bold" htmlFor="label-branch-select">Sucursal
          <select className={`${input} min-w-52 font-normal`} id="label-branch-select" onChange={(event) => { router.push(`/admin/products/labels?group=all&branch=${event.target.value}`); }} value={branchId ?? ""}>
            {!branches.length ? <option value="">Todavía no hay sucursales</option> : null}
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.active ? "" : " (inactiva)"}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-bold" htmlFor="label-group-select">Grupo
          <select
            className={`${input} min-w-64 font-normal`} disabled={!groups.length} id="label-group-select" onChange={(event) => { router.push(event.target.value === "all" ? `/admin/products/labels?group=all&branch=${branchId ?? ""}` : `/admin/products/labels?group=${event.target.value}`); }}
            value={allMode ? "all" : group?.groupId ?? ""}
          >
            {!groups.length ? <option value="">Todavía no hay grupos</option> : null}
            {branchId ? <option value="all">TODOS</option> : null}
            {groups.map((summary) => <option key={summary.groupId} value={summary.groupId}>{summary.name}{summary.branchName ? ` · ${summary.branchName}` : " · Precio global"} ({summary.itemCount})</option>)}
          </select>
        </label>
        <button className={secondaryButton} onClick={() => { setForm("create"); }} type="button">Nuevo grupo</button>
        <button className={secondaryButton} disabled={!group || allMode} onClick={() => { setForm("edit"); }} type="button">Editar grupo</button>
      </div>
      {!groups.length ? <p className="mt-3 text-sm text-stone-600">Un grupo es el conjunto de productos que tienen etiqueta física en una góndola (por ejemplo «Góndolas Despensa Central»). Se arma una vez y queda guardado.</p> : null}
      {form ? <GroupForm branches={branches} group={form === "edit" ? group : null} key={form === "edit" ? (group?.groupId ?? "edit") : "create"} onClose={() => { setForm(null); }} /> : null}
    </section>
    {group ? <GroupItems allMode={allMode} branchGroups={branchGroups} branchId={branchId} copies={copies} group={group} selected={selected} setCopies={setCopies} setSelected={setSelected} /> : null}
    <History detail={runDetail} runs={runs} />
  </div>;
}
