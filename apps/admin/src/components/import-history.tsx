import type { ImportRunStatus, ImportRunSummary } from "../lib/imports/history";
import { StatusBadge } from "./admin-ui";

const STATUS: Record<ImportRunStatus, { label: string; tone: "success" | "warning" | "neutral" | "critical" }> = {
  APPLIED: { label: "Aplicada", tone: "success" },
  PARTIAL: { label: "Parcial", tone: "warning" },
  PENDING: { label: "Sin confirmar", tone: "neutral" },
  CANCELLED: { label: "Cancelada", tone: "neutral" }
};

/** Previous imports, one line per logical import (a big file is several batches internally). */
export function ImportHistory({ runs, timezone }: { runs: ImportRunSummary[]; timezone: string }) {
  return <section className="mt-10" id="historial">
    <h2 className="text-xl font-black">Importaciones anteriores</h2>
    <p className="mt-1 text-sm text-stone-600">Qué se importó, cuándo y con qué resultado. Se conservan siempre; no se borran. Las vistas previas que cancelaste no se listan.</p>
    <div className="mt-4 overflow-x-auto rounded-xl border border-stone-200 bg-white">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-stone-50 text-stone-500"><tr>
          <th className="p-3">Fecha</th><th className="p-3">Archivo</th><th className="p-3">Origen</th>
          <th className="p-3 text-right">Filas</th><th className="p-3 text-right">Nuevos</th><th className="p-3 text-right">Actualizados</th><th className="p-3 text-right">Errores</th><th className="p-3">Estado</th>
        </tr></thead>
        <tbody>
          {runs.map((run) => <tr className="border-t border-stone-100 align-top" key={run.key}>
            <td className="whitespace-nowrap p-3">{new Date(run.createdAt).toLocaleString("es-AR", { timeZone: timezone, dateStyle: "short", timeStyle: "short" })}</td>
            <td className="p-3"><span className="font-bold">{run.fileName}</span>
              {run.stockLoaded !== null ? <span className="block text-xs text-stone-500">Stock inicial: {run.stockLoaded.toLocaleString("es-AR")} productos</span> : null}
              {run.batches > 1 ? <span className="block text-xs text-stone-400">{run.batches} lotes internos</span> : null}</td>
            <td className="p-3">{run.sourceLabel}</td>
            <td className="p-3 text-right">{run.rows.toLocaleString("es-AR")}</td>
            <td className="p-3 text-right">{run.created.toLocaleString("es-AR")}</td>
            <td className="p-3 text-right">{run.updated.toLocaleString("es-AR")}</td>
            <td className={`p-3 text-right ${run.errors > 0 ? "font-bold text-red-700" : ""}`}>{run.errors.toLocaleString("es-AR")}</td>
            <td className="p-3"><StatusBadge tone={STATUS[run.status].tone}>{STATUS[run.status].label}</StatusBadge></td>
          </tr>)}
          {runs.length === 0 ? <tr><td className="p-6 text-center text-stone-500" colSpan={8}>Todavía no se importó nada.</td></tr> : null}
        </tbody>
      </table>
    </div>
  </section>;
}
