"use client";

import Link from "next/link";

type Tab = "summary" | "stock" | "sales" | "operation";

export function BranchTabs({ branchId, active }: { branchId: string; active: Tab }) {
  const tabs: [Tab, string][] = [["summary", "Resumen"], ["stock", "Stock"], ["sales", "Ventas"], ["operation", "Operación"]];
  return <nav aria-label="Secciones de sucursal" className="mt-6 flex gap-1 border-b border-stone-200">{tabs.map(([key, label]) => <Link className={`border-b-2 px-4 py-3 text-sm font-bold ${active === key ? "border-rose-800 text-rose-800" : "border-transparent text-stone-600 hover:text-stone-950"}`} href={`/admin/branches/${branchId}${key === "summary" ? "" : `?tab=${key}`}`} key={key} replace>{label}</Link>)}</nav>;
}
