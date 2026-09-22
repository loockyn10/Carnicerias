"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { adminNavGroups, isAdminNavLinkActive } from "../lib/admin-nav";

export function AdminSidebar() {
  const pathname = usePathname();
  return <aside className="hidden w-60 shrink-0 border-r border-stone-200 bg-[#fbfaf8] lg:flex lg:flex-col"><div className="flex h-20 items-center border-b border-stone-200 px-6"><div><p className="text-lg font-black tracking-tight text-stone-800">Carnicerías</p><p className="mt-1 text-xs font-medium text-stone-500">Administración</p></div></div><nav className="flex-1 space-y-6 px-3 py-5">{adminNavGroups.map((group) => <section key={group.label}><p className="px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-stone-400">{group.label}</p><div className="mt-2 space-y-1">{group.links.map((link) => <Link className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold ${isAdminNavLinkActive(pathname, link) ? "bg-rose-50 text-rose-900" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"}`} href={link.href} key={link.label} prefetch={false}><span className="grid size-5 place-items-center text-base">{link.icon}</span>{link.label}</Link>)}</div></section>)}</nav></aside>;
}

/** Barra compacta y horizontalmente scrolleable para <lg, misma fuente de datos que el sidebar. */
export function AdminMobileNav() {
  const pathname = usePathname();
  return <nav aria-label="Navegación" className="flex gap-1.5 overflow-x-auto border-b border-stone-200 bg-[#fbfaf8] px-4 py-2 lg:hidden">{adminNavGroups.map((group, groupIndex) => group.links.map((link, linkIndex) => <Link className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold ${groupIndex > 0 && linkIndex === 0 ? "ml-1 border-l border-stone-200 pl-3" : ""} ${isAdminNavLinkActive(pathname, link) ? "bg-rose-50 text-rose-900" : "text-stone-600 hover:bg-stone-100"}`} href={link.href} key={link.label} prefetch={false}><span className="text-sm">{link.icon}</span>{link.label}</Link>))}</nav>;
}
