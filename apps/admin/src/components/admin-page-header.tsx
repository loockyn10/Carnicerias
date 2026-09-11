"use client";

import { usePathname } from "next/navigation";

const headers: Record<string, { title: string; description: string }> = {
  "/admin": { title: "Situación general", description: "Resumen operativo de hoy." },
  "/admin/branches": { title: "Sucursales", description: "Estado comercial y alertas de cada local." },
  "/admin/branches/compare": { title: "Comparar sucursales", description: "Ventas, descuentos, mermas y estado de stock." },
  "/admin/sales": { title: "Ventas", description: "Historial y seguimiento de ventas." },
  "/admin/stock": { title: "Stock por sucursal", description: "Inventario, compras, mermas y ajustes." },
  "/admin/replenishment": { title: "Qué hay que reponer", description: "Consolidado para organizar compras y reposición." },
  "/admin/products": { title: "Productos", description: "Catálogo y precios vigentes." },
  "/admin/promotions": { title: "Promociones", description: "Descuentos y reglas comerciales." },
  "/admin/announcements": { title: "Avisos", description: "Comunicación con las sucursales." },
  "/admin/employees": { title: "Empleados", description: "Accesos y miembros de la organización." },
  "/admin/devices": { title: "Dispositivos POS", description: "Terminales autorizadas para operar." },
  "/admin/audit": { title: "Auditoría", description: "Trazabilidad de los últimos eventos." },
  "/admin/attention": { title: "Centro de atención", description: "Problemas y movimientos relevantes por prioridad." }
};

export function AdminPageHeader() {
  const pathname = usePathname();
  const header = headers[pathname] ?? (pathname.startsWith("/admin/branches/")
    ? { title: "Sucursal", description: "Panel operativo de la sucursal." }
    : { title: "Administración", description: "" });

  return <div className="min-w-0"><h1 className="truncate text-lg font-black tracking-tight sm:text-xl">{header.title}</h1>{header.description ? <p className="hidden truncate text-sm text-stone-500 sm:block">{header.description}</p> : null}</div>;
}
