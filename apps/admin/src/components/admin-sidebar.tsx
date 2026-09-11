"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const groups = [
  { label: "Principal", links: [["⌂", "Inicio", "/admin"]] },
  { label: "Operación", links: [["⌁", "Sucursales", "/admin"], ["↗", "Ventas", "/admin/sales"], ["□", "Stock", "/admin/stock"], ["⇧", "Reposición", "/admin/replenishment"]] },
  { label: "Comercial", links: [["◇", "Productos", "/admin/catalog#products"], ["%", "Promociones", "/admin/catalog#discounts"], ["◌", "Avisos", "/admin/catalog#announcements"]] },
  { label: "Gestión", links: [["♙", "Empleados", "/admin/employees"], ["▣", "Dispositivos", "/admin/devices"], ["◷", "Auditoría", "/admin/audit"]] }
] as const;

function active(pathname: string, href: string, label: string) {
  if (href === "/admin") return label === "Inicio" ? pathname === "/admin" : pathname.startsWith("/admin/branches");
  return pathname.startsWith(href.split("#")[0] ?? "");
}

export function AdminSidebar() {
  const pathname = usePathname();
  return <aside className="hidden w-60 shrink-0 border-r border-stone-200 bg-[#fbfaf8] lg:flex lg:flex-col"><div className="border-b border-stone-200 px-6 py-6"><p className="text-lg font-black tracking-tight text-stone-800">Carnicerías</p><p className="mt-1 text-xs font-medium text-stone-500">Administración</p></div><nav className="flex-1 space-y-6 px-3 py-5">{groups.map((group) => <section key={group.label}><p className="px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-stone-400">{group.label}</p><div className="mt-2 space-y-1">{group.links.map(([icon, label, href]) => <Link className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold ${active(pathname, href, label) ? "bg-rose-50 text-rose-900" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"}`} href={href} key={label}><span className="grid size-5 place-items-center text-base">{icon}</span>{label}</Link>)}</div></section>)}</nav></aside>;
}
