"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SectionTab { label: string; href: string }

/**
 * Subsección de una misma área principal (Ventas, Stock, Productos, Empleados).
 * `active` es opcional: si se omite, la pestaña activa se calcula comparando
 * el pathname actual contra la parte de ruta de cada tab (ignorando query
 * string). Pasar `active` explícitamente cuando dos tabs comparten pathname
 * y sólo se distinguen por query (ver /admin/products?tab=pricing).
 */
export function SectionTabs({ tabs, active }: { tabs: SectionTab[]; active?: string }) {
  const pathname = usePathname();
  return <nav aria-label="Subsecciones" className="mt-6 flex flex-wrap gap-1 border-b border-stone-200">
    {tabs.map((tab) => {
      const isActive = active !== undefined ? tab.href === active : pathname === tab.href.split("?")[0];
      return <Link className={`border-b-2 px-4 py-3 text-sm font-bold ${isActive ? "border-rose-800 text-rose-800" : "border-transparent text-stone-600 hover:text-stone-950"}`} href={tab.href} key={tab.href}>{tab.label}</Link>;
    })}
  </nav>;
}
