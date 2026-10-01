"use client";

import { formatCurrency } from "@carnicerias/business-logic";
import { useMemo, useState } from "react";

import type { CurrentCommercialValues } from "../app/admin/imports/actions";
import type { ImportPreview, ImportRowAction, PreviewedRow } from "../lib/imports/runner";
import { normalizeSearchText } from "../lib/text-search";

type Filter = "ALL" | ImportRowAction;
const PAGE_SIZE = 50;

const RESULT_LABEL: Record<ImportRowAction, { text: string; style: string }> = {
  CREATE: { text: "NUEVO", style: "bg-emerald-100 text-emerald-800" },
  UPDATE: { text: "ACTUALIZAR", style: "bg-sky-100 text-sky-800" },
  IGNORE: { text: "SIN CAMBIOS", style: "bg-stone-200 text-stone-700" },
  ERROR: { text: "ERROR", style: "bg-red-100 text-red-800" }
};

const money = (cents: number) => formatCurrency(BigInt(cents));

function PriceCell({ entry, current, kind }: { entry: PreviewedRow; current: CurrentCommercialValues; kind: "price" | "cost" }) {
  const next = kind === "price" ? entry.row.display.priceCents : entry.row.display.costCents;
  const text = kind === "price" ? entry.row.display.priceText : entry.row.display.costText;
  if (next === null) return <span className={text !== "" && kind === "price" ? "text-red-700" : "text-stone-400"}>{text !== "" ? text : "—"}</span>;
  const known = entry.internalId ? current[entry.internalId] : undefined;
  const now = known ? known[kind === "price" ? 0 : 1] : null;
  if (entry.action === "UPDATE" && now !== null && now !== next) {
    return <span><span className="text-stone-400 line-through">{money(now)}</span> → <strong>{money(next)}</strong></span>;
  }
  if (entry.action === "IGNORE" && now !== null && now !== next) {
    return <span>{money(next)}<span className="block text-[11px] text-amber-700" title="El archivo no cambió desde la última importación, así que no se pisa lo que hay en el sistema.">hoy en sistema {money(now)}</span></span>;
  }
  return <span>{money(next)}</span>;
}

function ResultCell({ entry }: { entry: PreviewedRow }) {
  const label = RESULT_LABEL[entry.action];
  const category = entry.row.display.category;
  return <div>
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-black ${label.style}`}>{label.text}</span>
    {entry.action === "ERROR" ? <p className="mt-1 max-w-md text-xs font-medium text-red-700">{entry.message ?? entry.reasonCode ?? "Fila inválida"}</p> : null}
    {entry.action === "UPDATE" && entry.reasonCode === "LINK_EXISTING" ? <p className="mt-1 text-xs font-bold text-amber-700">Se vincula con un producto que ya existe</p> : null}
    {entry.action === "UPDATE" && entry.reasonCode === "RELINK" ? <p className="mt-1 text-xs text-stone-500">Se vuelve a vincular</p> : null}
    {entry.action === "CREATE" ? <p className="mt-1 text-xs text-stone-500">{category !== "" ? `Categoría: ${category}` : "Categoría: Almacen"}</p> : null}
  </div>;
}

export function ImportPreviewStep({
  preview, importStock, newCategories, current, destinationName, busy, onConfirm, onBack, onCancel
}: {
  preview: ImportPreview;
  importStock: boolean;
  newCategories: string[];
  current: CurrentCommercialValues;
  destinationName: string;
  busy: boolean;
  onConfirm: (skipErrors: boolean) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const { totals } = preview;
  const [filter, setFilter] = useState<Filter>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [acceptSkip, setAcceptSkip] = useState(false);
  const [reviewedLinks, setReviewedLinks] = useState(false);

  const visible = useMemo(() => {
    const needle = normalizeSearchText(search);
    return preview.rows.filter((entry) => {
      if (filter !== "ALL" && entry.action !== filter) return false;
      if (needle === "") return true;
      const d = entry.row.display;
      return normalizeSearchText(`${d.name} ${d.sku} ${d.barcode} ${d.category} ${entry.message ?? ""}`).includes(needle);
    });
  }, [preview.rows, filter, search]);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const shown = visible.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const hasWork = totals.create + totals.update > 0 || (importStock && totals.stockRows > 0);
  const blockedByErrors = totals.error > 0 && !acceptSkip;
  const blockedByLinks = totals.linkedExisting > 0 && !reviewedLinks;
  const canConfirm = hasWork && !blockedByErrors && !blockedByLinks && !busy;

  const cards: { label: string; value: number; tone: string; filter: Filter }[] = [
    { label: "Total", value: totals.total, tone: "text-stone-900", filter: "ALL" },
    { label: "Nuevos", value: totals.create, tone: "text-emerald-700", filter: "CREATE" },
    { label: "Actualizaciones", value: totals.update, tone: "text-sky-700", filter: "UPDATE" },
    { label: "Sin cambios", value: totals.ignore, tone: "text-stone-600", filter: "IGNORE" },
    { label: "Errores", value: totals.error, tone: totals.error > 0 ? "text-red-700" : "text-stone-400", filter: "ERROR" }
  ];

  return <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-stone-400">Paso 3 · Vista previa</p>
    <h2 className="mt-1 text-xl font-black">Esto es lo que va a pasar</h2>
    <p className="mt-1 text-sm text-stone-600">Todavía no se escribió nada. Los productos nuevos quedan habilitados sólo en <strong>{destinationName}</strong>; Avenida y Janssen no se tocan.</p>

    {preview.sameFileAlreadyApplied ? <p className="mt-3 rounded-lg bg-sky-50 p-3 text-sm text-sky-900">Este mismo archivo ya se importó antes. Si no cambió nada, todo debería figurar como “sin cambios”.</p> : null}

    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
      {cards.map((card) => <button className={`rounded-xl border px-4 py-3 text-left ${filter === card.filter ? "border-rose-800 bg-rose-50" : "border-stone-200 bg-white hover:bg-stone-50"}`} key={card.label} onClick={() => { setFilter(card.filter); setPage(0); }} type="button">
        <p className="text-xs font-bold uppercase tracking-wider text-stone-500">{card.label}</p>
        <p className={`mt-1 text-2xl font-black ${card.tone}`}>{card.value.toLocaleString("es-AR")}</p>
      </button>)}
    </div>

    <ul className="mt-3 space-y-1 text-sm text-stone-600">
      {newCategories.length > 0 ? <li>📁 {newCategories.length === 1 ? "Se creará" : "Se crearán"} <strong>{newCategories.length}</strong> categoría{newCategories.length === 1 ? "" : "s"} nueva{newCategories.length === 1 ? "" : "s"}: {newCategories.slice(0, 8).join(", ")}{newCategories.length > 8 ? "…" : ""}</li> : null}
      {importStock ? <li>📦 Stock inicial en {destinationName}: <strong>{totals.stockRows.toLocaleString("es-AR")}</strong> producto{totals.stockRows === 1 ? "" : "s"} ({totals.stockUnits.toLocaleString("es-AR")} unidades). Un producto que ya tenga movimientos de stock en {destinationName} conserva el suyo: no se pisa.</li> : <li>📦 No se importa stock.</li>}
      {preview.batches.length > 1 ? <li>🗂️ El archivo es grande: se procesa en {preview.batches.length} lotes internos, pero se confirma de una sola vez.</li> : null}
    </ul>

    <div className="mt-4 flex flex-wrap items-end gap-3">
      <label className="grid min-w-[14rem] flex-1 gap-1 text-sm font-medium">Buscar
        <input className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm" onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Producto, SKU, código de barras, categoría o motivo…" type="search" value={search} />
      </label>
      <p className="pb-2 text-sm text-stone-500">{visible.length.toLocaleString("es-AR")} fila{visible.length === 1 ? "" : "s"}</p>
    </div>

    <div className="mt-3 overflow-hidden rounded-xl border border-stone-200">
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="sticky top-0 bg-stone-50 text-stone-500"><tr>
            <th className="p-3">Producto</th><th className="p-3">SKU</th><th className="p-3">Barcode</th><th className="p-3">Precio</th><th className="p-3">Costo</th><th className="p-3">Stock</th><th className="p-3">Resultado</th>
          </tr></thead>
          <tbody>
            {shown.map((entry) => <tr className="border-t border-stone-100 align-top" key={entry.row.rowNumber}>
              <td className="p-3"><span className="font-bold">{entry.row.display.name || "—"}</span><span className="block text-[11px] text-stone-400">fila {entry.row.rowNumber}</span></td>
              <td className="p-3 font-mono text-xs">{entry.row.display.sku || "—"}</td>
              <td className="p-3 font-mono text-xs">{entry.row.display.barcode || "—"}</td>
              <td className="whitespace-nowrap p-3"><PriceCell current={current} entry={entry} kind="price" /></td>
              <td className="whitespace-nowrap p-3"><PriceCell current={current} entry={entry} kind="cost" /></td>
              <td className="p-3">{importStock ? (entry.row.display.stockUnits !== null ? entry.row.display.stockUnits.toLocaleString("es-AR") : entry.row.display.stockText !== "" ? <span className="text-red-700">{entry.row.display.stockText}</span> : "—") : "—"}</td>
              <td className="p-3"><ResultCell entry={entry} /></td>
            </tr>)}
            {shown.length === 0 ? <tr><td className="p-6 text-center text-stone-500" colSpan={7}>No hay filas con ese filtro.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
    {pages > 1 ? <div className="mt-3 flex items-center justify-between text-sm">
      <button className="rounded-lg border border-stone-300 px-3 py-1.5 font-bold disabled:opacity-40" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} type="button">← Anterior</button>
      <span className="text-stone-500">Página {safePage + 1} de {pages}</span>
      <button className="rounded-lg border border-stone-300 px-3 py-1.5 font-bold disabled:opacity-40" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)} type="button">Siguiente →</button>
    </div> : null}

    <div className="mt-6 rounded-xl border border-stone-200 bg-stone-50 p-4">
      {totals.error > 0 ? <label className="flex items-start gap-2 text-sm"><input checked={acceptSkip} className="mt-1" onChange={(event) => setAcceptSkip(event.target.checked)} type="checkbox" /><span><strong>Hay {totals.error.toLocaleString("es-AR")} fila{totals.error === 1 ? "" : "s"} con error.</strong> No se pueden importar así: corregí el archivo y volvé a cargarlo, o marcá esta casilla para <strong>omitirlas</strong> e importar el resto.</span></label> : null}
      {totals.linkedExisting > 0 ? <label className="mt-2 flex items-start gap-2 text-sm"><input checked={reviewedLinks} className="mt-1" onChange={(event) => setReviewedLinks(event.target.checked)} type="checkbox" /><span><strong>{totals.linkedExisting.toLocaleString("es-AR")} fila{totals.linkedExisting === 1 ? "" : "s"} {totals.linkedExisting === 1 ? "se vincula con un producto que ya existía" : "se vinculan con productos que ya existían"}</strong> (coincide{totals.linkedExisting === 1 ? "" : "n"} por código de barras o SKU) y va{totals.linkedExisting === 1 ? "" : "n"} a actualizar su nombre/precio/costo. Revisé {totals.linkedExisting === 1 ? "esa fila" : "esas filas"} y es lo que quiero.</span></label> : null}
      {!hasWork ? <p className="text-sm font-bold text-stone-600">No hay cambios para importar: todo coincide con lo que ya está cargado.</p> : null}
      <div className={`flex flex-wrap items-center gap-3 ${totals.error > 0 || totals.linkedExisting > 0 || !hasWork ? "mt-4" : ""}`}>
        <button className="rounded-lg bg-rose-800 px-5 py-2.5 text-sm font-bold text-white hover:bg-rose-900 disabled:opacity-50" disabled={!canConfirm} onClick={() => onConfirm(totals.error > 0 && acceptSkip)} type="button">{busy ? "Importando…" : "Confirmar e importar"}</button>
        <button className="rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 hover:bg-stone-50" disabled={busy} onClick={onBack} type="button">Volver a las columnas</button>
        <button className="rounded-lg px-4 py-2.5 text-sm font-bold text-stone-600 hover:bg-stone-100" disabled={busy} onClick={onCancel} type="button">Cancelar importación</button>
      </div>
    </div>
  </section>;
}
