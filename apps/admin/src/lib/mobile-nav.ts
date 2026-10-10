import { adminPageHeader } from "./admin-page-titles";

/**
 * Navegación del celular (debajo de `lg`, 1024 px): la misma app y las mismas rutas del Admin, con otra presentación. No hay rutas nuevas:
 * cada pantalla simple vive en una ruta existente y se elige con `?view=` (sólo el celular lo mira; el escritorio lo ignora).
 *
 *   /admin                    Inicio: las 4 tareas
 *   /admin/branches           Ver sucursales (rendimiento)      /admin/branches?view=carry   Qué llevar
 *   /admin/stock              Stock rápido                      /admin/products?view=new     Nuevo producto
 */

export const MOBILE_HOME = "/admin";
export const MOBILE_BRANCHES = "/admin/branches";
export const MOBILE_CARRY = "/admin/branches?view=carry";
export const MOBILE_STOCK = "/admin/stock";
export const MOBILE_NEW_PRODUCT = "/admin/products?view=new";

/** Las cuatro tareas de la pantalla de Inicio, con las palabras del negocio. */
export const MOBILE_TASKS = [
  { key: "branches", icon: "📊", title: "Ver sucursales", description: "Ventas, ganancia y rendimiento", href: MOBILE_BRANCHES, tone: "bg-sky-100" },
  { key: "carry", icon: "🚚", title: "Qué llevar", description: "Preparar mercadería para cada sucursal", href: MOBILE_CARRY, tone: "bg-amber-100" },
  { key: "stock", icon: "📦", title: "Stock rápido", description: "Agregar, quitar o contar mercadería", href: MOBILE_STOCK, tone: "bg-emerald-100" },
  { key: "newProduct", icon: "➕", title: "Nuevo producto", description: "Crear un producto rápidamente", href: MOBILE_NEW_PRODUCT, tone: "bg-violet-100" }
] as const;

export interface MobileTab { key: "home" | "branches" | "carry" | "stock"; icon: string; label: string; href: string }

/** Barra inferior: las mismas palabras que el Inicio (más «Más», que abre las pantallas de escritorio). */
export const MOBILE_TABS: readonly MobileTab[] = [
  { key: "home", icon: "🏠", label: "Inicio", href: MOBILE_HOME },
  { key: "branches", icon: "📊", label: "Sucursales", href: MOBILE_BRANCHES },
  { key: "carry", icon: "🚚", label: "Qué llevar", href: MOBILE_CARRY },
  { key: "stock", icon: "📦", label: "Stock", href: MOBILE_STOCK }
];

/** Pantallas completas del escritorio, a las que se llega desde «Más». Pueden verse apretadas en el celular. */
export const MOBILE_MORE_LINKS = [
  { label: "Ventas", description: "Historial y rendiciones", href: "/admin/sales" },
  { label: "Reposición", description: "Qué hay que comprar", href: "/admin/replenishment" },
  { label: "Stock por sucursal", description: "Un producto en todas las sucursales", href: "/admin/branch-stock" },
  { label: "Productos y precios", description: "Catálogo completo", href: "/admin/products" },
  { label: "Desposte", description: "Transformar y registrar rendimiento", href: "/admin/production" },
  { label: "Distribución", description: "Mover stock entre sucursales", href: "/admin/transfers" },
  { label: "Empleados y horas", description: "Accesos y fichajes", href: "/admin/employees" },
  { label: "Configuración", description: "Dispositivos, avisos, proveedores", href: "/admin/settings" }
] as const;

export function isMobileHome(pathname: string): boolean {
  return pathname === "/admin";
}

/** Qué pestaña de la barra inferior corresponde a la pantalla actual (`null` = ninguna: es una pantalla de «Más»). */
export function activeMobileTab(pathname: string, view: string | null): MobileTab["key"] | null {
  if (pathname === "/admin") return "home";
  if (pathname === "/admin/branches") return view === "carry" ? "carry" : "branches";
  if (pathname.startsWith("/admin/branches/")) return "branches";
  if (pathname === "/admin/stock") return "stock";
  return null;
}

export interface MobileScreen { title: string; backHref: string }

/** Título claro y a dónde vuelve «‹» desde cada pantalla (siempre un destino fijo: no depende del historial del navegador). */
export function mobileScreen(pathname: string, view: string | null): MobileScreen {
  if (pathname === "/admin/branches") return view === "carry" ? { title: "Qué llevar", backHref: MOBILE_HOME } : { title: "Sucursales", backHref: MOBILE_HOME };
  if (pathname === "/admin/stock") return { title: "Stock rápido", backHref: MOBILE_HOME };
  if (pathname === "/admin/products" && view === "new") return { title: "Nuevo producto", backHref: MOBILE_HOME };
  if (pathname.startsWith("/admin/branches/")) {
    return { title: adminPageHeader(pathname).title, backHref: MOBILE_BRANCHES };
  }
  return { title: adminPageHeader(pathname).title, backHref: MOBILE_HOME };
}
