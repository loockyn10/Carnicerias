export interface AdminNavLink { icon: string; label: string; href: string; match: readonly string[]; exact?: boolean }
export interface AdminNavGroup { label: string; links: AdminNavLink[] }

/**
 * Única fuente de verdad de la navegación principal del Admin: la usan tanto
 * el sidebar de escritorio como la barra compacta mobile, para no mantener
 * dos listas de links/reglas de "activo" en paralelo.
 */
export const adminNavGroups: AdminNavGroup[] = [
  { label: "Principal", links: [
    { icon: "⌂", label: "Inicio", href: "/admin", match: ["/admin"], exact: true },
    { icon: "⌁", label: "Sucursales", href: "/admin/branches", match: ["/admin/branches"] }
  ] },
  { label: "Operación", links: [
    { icon: "↗", label: "Ventas", href: "/admin/sales", match: ["/admin/sales", "/admin/settlements", "/admin/analytics"] },
    { icon: "□", label: "Stock", href: "/admin/stock", match: ["/admin/stock", "/admin/branch-stock", "/admin/replenishment"] },
    { icon: "✂", label: "Desposte", href: "/admin/production", match: ["/admin/production"] },
    { icon: "⇄", label: "Distribución", href: "/admin/transfers", match: ["/admin/transfers"] }
  ] },
  { label: "Gestión", links: [
    { icon: "◇", label: "Productos", href: "/admin/products", match: ["/admin/products", "/admin/promotions"] },
    { icon: "♙", label: "Empleados", href: "/admin/employees", match: ["/admin/employees", "/admin/timekeeping"] }
  ] },
  { label: "Sistema", links: [
    { icon: "⚙", label: "Configuración", href: "/admin/settings", match: ["/admin/settings", "/admin/devices", "/admin/announcements", "/admin/audit"] }
  ] }
];

export function isAdminNavLinkActive(pathname: string, link: AdminNavLink) {
  if (link.exact) return pathname === link.href;
  return link.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
