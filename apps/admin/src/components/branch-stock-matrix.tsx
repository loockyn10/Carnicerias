"use client";

import { formatWeight } from "@carnicerias/business-logic";
import { useMemo, useState } from "react";

import { StatusBadge } from "./admin-ui";
import { filterBranchStockRows, type BranchStockRow } from "../lib/branch-stock";
import type { StockPriority } from "../lib/multibranch";

export interface BranchStockMatrixBranch {
  id: string;
  name: string;
  lastSeenAt: string | null;
}

export interface BranchStockMatrixCategory {
  id: string;
  name: string;
}

export type BranchStockMatrixRow = BranchStockRow;

const badgeTone: Record<StockPriority, "critical" | "warning" | "success" | "neutral"> = {
  "CRÍTICO": "critical",
  "ALTO": "warning",
  "DISPONIBLE": "success",
  "INACTIVO": "neutral"
};

function formatQuantity(value: number, unitType: "WEIGHT" | "UNIT") {
  return unitType === "WEIGHT"
    ? formatWeight(value)
    : `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(value)} ${value === 1 ? "unidad" : "unidades"}`;
}

function formatRelativeTime(iso: string, now: number) {
  const diffMs = now - new Date(iso).getTime();
  if (diffMs < 0) return "recién";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "hace instantes";
  if (minutes < 60) return `hace ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${String(hours)} h`;
  const days = Math.floor(hours / 24);
  return `hace ${String(days)} d`;
}

export function BranchStockMatrix({
  branches,
  categories,
  rows
}: {
  branches: BranchStockMatrixBranch[];
  categories: BranchStockMatrixCategory[];
  rows: BranchStockMatrixRow[];
}) {
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [detail, setDetail] = useState<BranchStockMatrixRow | null>(null);
  const now = Date.now();

  const filtered = useMemo(
    () => filterBranchStockRows(rows, { search, categoryId }),
    [rows, search, categoryId]
  );

  if (!branches.length) {
    return (
      <div className="mt-7 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-900">
        No hay sucursales activas registradas todavía.
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="mt-7 rounded-2xl border bg-white p-8 text-center text-stone-500">
        Todavía no hay productos activos con stock para comparar.
      </div>
    );
  }

  return (
    <div className="mt-7">
      <div className="flex flex-wrap items-center gap-3">
        <input
          aria-label="Buscar producto"
          className="min-w-64 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar por nombre o SKU…"
          value={search}
        />
        {categories.length ? (
          <select
            aria-label="Filtrar por categoría"
            className="rounded-lg border border-stone-300 bg-white px-3 py-2"
            onChange={(event) => setCategoryId(event.target.value)}
            value={categoryId}
          >
            <option value="">Todas las categorías</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full min-w-max text-left text-sm">
          <thead className="border-b border-stone-100 bg-stone-50 text-stone-500">
            <tr>
              <th className="sticky left-0 z-10 min-w-56 bg-stone-50 p-3">Producto</th>
              {branches.map((branch) => (
                <th className="min-w-32 p-3" key={branch.id}>
                  <span className="block">{branch.name}</span>
                  {branch.lastSeenAt ? (
                    <span className="mt-0.5 block text-[11px] font-normal normal-case text-stone-400">
                      Última sync: {formatRelativeTime(branch.lastSeenAt, now)}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr className="border-b border-stone-100 last:border-0" key={row.productId}>
                <td className="sticky left-0 z-10 bg-white p-3">
                  <button
                    className="text-left font-bold text-rose-900 hover:underline"
                    onClick={() => setDetail(row)}
                    type="button"
                  >
                    {row.productName}
                  </button>
                  {row.sku ? <span className="ml-2 text-xs text-stone-400">{row.sku}</span> : null}
                </td>
                {branches.map((branch) => {
                  const cell = row.cells[branch.id];
                  if (!cell) return <td className="p-3 text-stone-400" key={branch.id}>—</td>;
                  return (
                    <td className="p-3" key={branch.id}>
                      {cell.rank === 0 ? (
                        <span className="font-bold text-red-700">Sin stock</span>
                      ) : (
                        <span className={cell.rank === 1 ? "font-semibold text-amber-700" : ""}>
                          {formatQuantity(cell.current, row.unitType)}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length ? (
          <p className="p-8 text-center text-stone-500">
            No se encontraron productos para &ldquo;{search}&rdquo;.
          </p>
        ) : null}
      </div>

      {detail ? (
        <div
          aria-labelledby="branch-stock-detail-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-stone-950/55 p-4"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null); }}
          role="dialog"
        >
          <section className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-xl font-black" id="branch-stock-detail-title">{detail.productName}</h2>
              <button className="text-sm font-semibold text-stone-500 hover:text-stone-900" onClick={() => setDetail(null)} type="button">Cerrar</button>
            </div>
            <ul className="mt-4 space-y-2">
              {branches
                .flatMap((branch) => {
                  const cell = detail.cells[branch.id];
                  return cell ? [{ branch, cell }] : [];
                })
                .sort((a, b) => b.cell.current - a.cell.current)
                .map(({ branch, cell }) => (
                  <li className="flex items-center justify-between gap-3 rounded-xl bg-stone-50 p-3" key={branch.id}>
                    <span className="font-semibold">{branch.name}</span>
                    <span className="flex items-center gap-2">
                      <span className={cell.rank === 0 ? "font-bold text-red-700" : "font-bold"}>
                        {cell.rank === 0 ? "SIN STOCK" : formatQuantity(cell.current, detail.unitType)}
                      </span>
                      <StatusBadge tone={badgeTone[cell.label]}>{cell.label}</StatusBadge>
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  );
}
