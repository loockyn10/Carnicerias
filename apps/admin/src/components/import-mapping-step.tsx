"use client";

import {
  CATALOG_FIELD_LABELS,
  CATALOG_IMPORT_FIELDS,
  validateColumnMapping,
  type CatalogColumnMapping,
  type CatalogImportField,
  type ImportTable,
  type NumberFormat
} from "@carnicerias/business-logic";

import type { ImportLinkKey } from "../lib/imports/runner";

const REQUIRED: Record<CatalogImportField, string | null> = {
  code: "Código o código de barras: al menos uno",
  name: "Obligatorio",
  barcode: "Código o código de barras: al menos uno",
  category: "Sin categoría → Almacen",
  saleType: "Opcional · UNIT o WEIGHT (sin columna: todo por UNIDAD)",
  price: "Obligatorio · 0 = sin precio (se pide en la caja)",
  cost: "Opcional",
  supplier: "Opcional · producto sin proveedor si va vacío",
  supplierCode: "Opcional · identifica al proveedor al reimportar",
  stock: "No se importa"
};

/** What each field becomes in SimplyGest-speak: "CODIGO → SKU". */
const TARGET_LABEL: Record<CatalogImportField, string> = {
  code: "SKU",
  name: "Nombre",
  barcode: "Barcode",
  category: "Categoría",
  saleType: "Forma de venta",
  price: "Precio",
  cost: "Costo",
  supplier: "Proveedor",
  supplierCode: "Código de proveedor",
  stock: "Stock inicial"
};

/** The SimplyGest stock is never imported from this screen (it is not trusted): the field is not offered. */
const OFFERED_FIELDS = CATALOG_IMPORT_FIELDS.filter((field) => field !== "stock");

const select = "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

function samples(table: ImportTable, column: number | null): string {
  if (column === null) return "—";
  const values: string[] = [];
  for (const row of table.rows) {
    const cell = row.cells[column];
    if (cell === null || cell === undefined || String(cell).trim() === "") continue;
    values.push(String(cell).trim());
    if (values.length === 3) break;
  }
  return values.length > 0 ? values.join(" · ") : "(vacía)";
}

export interface ImportOptionsState {
  numberFormat: NumberFormat;
  linkBy: Record<ImportLinkKey, boolean>;
}

export function ImportMappingStep({
  table, fileSummary, mapping, options, busy, onMappingChange, onOptionsChange, onAnalyze, onChooseAnother
}: {
  table: ImportTable;
  fileSummary: string;
  mapping: CatalogColumnMapping;
  options: ImportOptionsState;
  busy: boolean;
  onMappingChange: (mapping: CatalogColumnMapping) => void;
  onOptionsChange: (options: ImportOptionsState) => void;
  onAnalyze: () => void;
  onChooseAnother: () => void;
}) {
  const problems = validateColumnMapping(mapping);

  return <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-stone-400">Paso 2 · Columnas</p>
        <h2 className="mt-1 text-xl font-black">Indicá qué es cada columna</h2>
        <p className="mt-1 text-sm text-stone-600">{fileSummary}. Sugerimos las columnas por su nombre; corregí lo que haga falta antes de continuar.</p>
      </div>
      <button className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-bold text-stone-700 hover:bg-stone-50" disabled={busy} onClick={onChooseAnother} type="button">Elegir otro archivo</button>
    </div>

    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="text-stone-500"><tr><th className="py-2 pr-3">Columna del archivo</th><th className="py-2 pr-3">Se importa como</th><th className="py-2 pr-3">Ejemplos</th></tr></thead>
        <tbody>
          {OFFERED_FIELDS.map((field) => <tr className="border-t border-stone-100 align-top" key={field}>
            <td className="py-2 pr-3">
              <select aria-label={`Columna para ${CATALOG_FIELD_LABELS[field]}`} className={select} disabled={busy}
                onChange={(event) => onMappingChange({ ...mapping, [field]: event.target.value === "" ? null : Number(event.target.value) })}
                value={mapping[field] === null ? "" : String(mapping[field])}>
                <option value="">— no importar —</option>
                {table.headers.map((header, index) => <option key={`${String(index)}-${header}`} value={String(index)}>{header}</option>)}
              </select>
            </td>
            <td className="py-2 pr-3"><span className="font-bold">{TARGET_LABEL[field]}</span><span className="block text-xs text-stone-500">{CATALOG_FIELD_LABELS[field]} · {REQUIRED[field]}</span></td>
            <td className="max-w-[18rem] truncate py-2 pr-3 text-stone-600" title={samples(table, mapping[field])}>{samples(table, mapping[field])}</td>
          </tr>)}
        </tbody>
      </table>
    </div>

    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-medium">Formato de los números
        <select className={select} disabled={busy} onChange={(event) => onOptionsChange({ ...options, numberFormat: event.target.value as NumberFormat })} value={options.numberFormat}>
          <option value="AR">Argentino — 1.234,56 (coma decimal)</option>
          <option value="INTL">Internacional — 1,234.56 (punto decimal)</option>
        </select>
        <span className="text-xs font-normal text-stone-500">Detectado automáticamente; si un precio sale mal en la vista previa, cambialo.</span>
      </label>
      <div className="rounded-lg border border-stone-200 p-3 text-sm">
        <strong>El stock no se importa</strong>
        <span className="block text-xs text-stone-500">El stock de SimplyGest no es confiable: los productos empiezan sin movimientos de stock y Central los muestra y vende igual. No hace falta una columna de stock.</span>
      </div>
    </div>

    {mapping.saleType === null ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Sin columna de <strong>forma de venta</strong>, todos los productos se importan <strong>por unidad</strong>. Si el archivo trae <code>UNIT</code>/<code>WEIGHT</code> (por unidad / por kg), elegí esa columna arriba.</p> : null}

    <details className="mt-3 rounded-lg border border-stone-200 p-3 text-sm">
      <summary className="cursor-pointer font-bold">Opciones avanzadas · productos que ya existen</summary>
      <p className="mt-2 text-xs text-stone-500">Un producto de la base que nunca se importó se vincula a la fila sólo si coincide sin ambigüedad. Si una fila coincide con más de un producto distinto, queda como error: nunca se elige uno al azar. Los productos vinculados se marcan en la vista previa.</p>
      <label className="mt-2 flex items-center gap-2"><input checked={options.linkBy.barcode} disabled={busy} onChange={(event) => onOptionsChange({ ...options, linkBy: { ...options.linkBy, barcode: event.target.checked } })} type="checkbox" />Vincular por código de barras</label>
      <label className="mt-1 flex items-center gap-2"><input checked={options.linkBy.sku} disabled={busy} onChange={(event) => onOptionsChange({ ...options, linkBy: { ...options.linkBy, sku: event.target.checked } })} type="checkbox" />Vincular por SKU</label>
    </details>

    <details className="mt-3 rounded-lg border border-stone-200 p-3 text-sm">
      <summary className="cursor-pointer font-bold">Primeras filas del archivo</summary>
      <div className="mt-2 overflow-x-auto"><table className="min-w-full text-left text-xs">
        <thead className="text-stone-500"><tr>{table.headers.map((header, index) => <th className="whitespace-nowrap py-1 pr-3" key={`${String(index)}-${header}`}>{header}</th>)}</tr></thead>
        <tbody>{table.rows.slice(0, 5).map((row) => <tr className="border-t border-stone-100" key={row.rowNumber}>{table.headers.map((header, index) => <td className="whitespace-nowrap py-1 pr-3" key={`${String(index)}-${header}`}>{String(row.cells[index] ?? "")}</td>)}</tr>)}</tbody>
      </table></div>
    </details>

    {problems.length > 0 ? <ul className="mt-4 list-disc space-y-1 rounded-lg bg-amber-50 p-3 pl-7 text-sm text-amber-900">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <button className="rounded-lg bg-rose-800 px-5 py-2.5 text-sm font-bold text-white hover:bg-rose-900 disabled:opacity-50" disabled={busy || problems.length > 0} onClick={onAnalyze} type="button">Revisar antes de importar</button>
      <span className="text-xs text-stone-500">No se escribe nada todavía: primero ves exactamente qué va a pasar con cada fila.</span>
    </div>
  </section>;
}
