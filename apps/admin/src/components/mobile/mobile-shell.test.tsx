import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminSidebar } from "../admin-sidebar";
import { MobileBottomNav, MobileTopBar } from "./mobile-shell";

const state = { pathname: "/admin", view: null as string | null };
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.view ? { view: state.view } : {})
}));
vi.mock("../../app/admin/actions", () => ({ logout: () => Promise.resolve() }));

beforeEach(() => { state.pathname = "/admin"; state.view = null; });

const current = (html: string) => [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>/g)].map((match) => /href="([^"]+)"/.exec(match[0])?.[1]?.replaceAll("&amp;", "&"));

describe("barra superior del celular", () => {
  it("siempre tiene «Volver», un título claro e «Inicio»", () => {
    state.pathname = "/admin/stock";
    const html = renderToStaticMarkup(<MobileTopBar />);
    expect(html).toContain('aria-label="Volver"');
    expect(html).toContain('href="/admin"');
    expect(html).toContain("Stock rápido");
    expect(html).toContain('aria-label="Ir al Inicio"');
  });

  it("el detalle de una sucursal vuelve a Sucursales (destino fijo)", () => {
    state.pathname = "/admin/branches/d3000000-0000-4000-8000-000000000002";
    const html = renderToStaticMarkup(<MobileTopBar />);
    const back = /<a [^>]*aria-label="Volver"[^>]*>/.exec(html)?.[0] ?? "";
    expect(back).toContain('href="/admin/branches"');
  });

  it("no aparece en el Inicio (el Inicio ya es el menú) y no se ve en escritorio", () => {
    expect(renderToStaticMarkup(<MobileTopBar />)).toBe("");
    state.pathname = "/admin/branches";
    expect(renderToStaticMarkup(<MobileTopBar />)).toContain("lg:hidden");
  });

  it("los botones táctiles miden al menos 44 px", () => {
    state.pathname = "/admin/branches";
    expect(renderToStaticMarkup(<MobileTopBar />)).toContain("size-11");
  });
});

describe("barra inferior del celular", () => {
  it("Inicio · Sucursales · Qué llevar · Stock · Más, con la pantalla actual marcada", () => {
    state.pathname = "/admin/stock";
    const html = renderToStaticMarkup(<MobileBottomNav />);
    for (const label of ["Inicio", "Sucursales", "Qué llevar", "Stock", "Más"]) expect(html).toContain(label);
    expect(current(html)).toEqual(["/admin/stock"]);
  });

  it("«Qué llevar» se marca con ?view=carry y no marca «Sucursales»", () => {
    state.pathname = "/admin/branches";
    state.view = "carry";
    expect(current(renderToStaticMarkup(<MobileBottomNav />))).toEqual(["/admin/branches?view=carry"]);
  });

  it("queda fija abajo, respeta el área segura y no se muestra en el Inicio ni en escritorio", () => {
    state.pathname = "/admin/branches";
    const html = renderToStaticMarkup(<MobileBottomNav />);
    expect(html).toContain("fixed inset-x-0 bottom-0");
    expect(html).toContain("env(safe-area-inset-bottom)");
    expect(html).toContain("lg:hidden");
    expect(html).toContain("min-h-14");
    state.pathname = "/admin";
    expect(renderToStaticMarkup(<MobileBottomNav />)).toBe("");
  });
});

describe("el escritorio conserva su navegación", () => {
  it("el sidebar sigue con todas sus secciones y sólo se ve desde lg", () => {
    state.pathname = "/admin/sales";
    const html = renderToStaticMarkup(<AdminSidebar />);
    for (const label of ["Inicio", "Sucursales", "Ventas", "Stock", "Desposte", "Distribución", "Productos", "Empleados", "Configuración"]) expect(html).toContain(label);
    expect(html).toContain("hidden w-60");
    expect(html).toContain("lg:flex");
  });
});
