"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { StatusBadge } from "./admin-ui";
import { normalizeSearchText } from "../lib/text-search";

export interface PromotionRow {
  id: string;
  productName: string;
  categoryName: string;
  branchLabel: string;
  active: boolean;
  displayLine: string;
}

/** Client-side search over an already-loaded list (no extra roundtrip — the whole set is small
 * enough to filter in the browser), matching the same accent/case-insensitive behavior as the
 * other Admin search boxes (Stock por sucursal, Precios). */
export function PromotionsList({ rows }: { rows: PromotionRow[] }) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const normalized = normalizeSearchText(search);
    if (!normalized) return rows;
    return rows.filter((row) => normalizeSearchText(`${row.productName} ${row.categoryName} ${row.displayLine}`).includes(normalized));
  }, [rows, search]);

  return <>
    <label className="mt-7 grid gap-1 text-sm font-medium">
      Buscar
      <input
        className="w-full max-w-sm rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Producto, categoría o promoción…"
        type="search"
        value={search}
      />
    </label>
    <section className="mt-3 divide-y rounded-xl bg-white shadow-sm">
      {filtered.map((row) => (
        <article className="flex flex-wrap items-center justify-between gap-4 p-4" key={row.id}>
          <div>
            <h2 className="font-bold">{row.productName}</h2>
            <p className="mt-1 text-sm text-stone-600">{row.displayLine} · {row.branchLabel}</p>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge tone={row.active ? "success" : "neutral"}>{row.active ? "Activa" : "Inactiva"}</StatusBadge>
            <Link className="rounded-lg border px-3 py-2 text-sm font-bold" href={`/admin/promotions?edit=${row.id}`}>Editar</Link>
          </div>
        </article>
      ))}
      {!filtered.length ? <p className="p-8 text-center text-stone-500">{rows.length ? "Ninguna promoción coincide con la búsqueda." : "Todavía no hay promociones."}</p> : null}
    </section>
  </>;
}
