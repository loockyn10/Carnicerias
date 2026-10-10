import { describe, expect, it } from "vitest";

import { adminNavGroups } from "./admin-nav";
import { activeMobileTab, isMobileHome, mobileScreen, MOBILE_MORE_LINKS, MOBILE_TABS, MOBILE_TASKS } from "./mobile-nav";

describe("Inicio del celular: sólo 4 tareas, con las palabras del negocio", () => {
  it("son exactamente las 4 tareas pedidas, cada una con ícono, título y UNA frase", () => {
    expect(MOBILE_TASKS.map((task) => task.title)).toEqual(["Ver sucursales", "Qué llevar", "Stock rápido", "Nuevo producto"]);
    for (const task of MOBILE_TASKS) {
      expect(task.icon).not.toBe("");
      expect(task.description).not.toMatch(/[.\n]$/);
      expect(task.description.length).toBeLessThan(50);
    }
  });

  it("no crea rutas nuevas: todas viven en pantallas que ya existen del Admin", () => {
    for (const task of MOBILE_TASKS) {
      expect(task.href).toMatch(/^\/admin(\/|\?|$)/);
      expect(task.href).not.toMatch(/\/(m|mobile|mobile-admin)(\/|\?|$)/);
    }
    const knownPrefixes = adminNavGroups.flatMap((group) => group.links.flatMap((link) => link.match));
    for (const task of MOBILE_TASKS) {
      const path = task.href.split("?")[0] ?? "";
      expect(knownPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))).toBe(true);
    }
  });

  it("no usa vocabulario técnico", () => {
    const text = [...MOBILE_TASKS.flatMap((task) => [task.title, task.description]), ...MOBILE_TABS.map((tab) => tab.label), ...MOBILE_MORE_LINKS.map((link) => link.label)].join(" ").toLowerCase();
    for (const forbidden of ["stock adjustment", "movement", "ledger", "reconciliation", "carry plan", "movimiento"]) expect(text).not.toContain(forbidden);
  });
});

describe("navegación inferior", () => {
  it("Inicio, Sucursales, Qué llevar y Stock (más «Más», que abre las pantallas completas)", () => {
    expect(MOBILE_TABS.map((tab) => tab.label)).toEqual(["Inicio", "Sucursales", "Qué llevar", "Stock"]);
  });

  it("marca la pestaña correcta según la pantalla", () => {
    expect(activeMobileTab("/admin", null)).toBe("home");
    expect(activeMobileTab("/admin/branches", null)).toBe("branches");
    expect(activeMobileTab("/admin/branches", "carry")).toBe("carry");
    expect(activeMobileTab("/admin/branches/abc", null)).toBe("branches");
    expect(activeMobileTab("/admin/stock", null)).toBe("stock");
    expect(activeMobileTab("/admin/sales", null)).toBeNull();
    expect(activeMobileTab("/admin/products", "new")).toBeNull();
  });

  it("el Inicio no lleva barra (ya es el menú); todo lo demás sí", () => {
    expect(isMobileHome("/admin")).toBe(true);
    expect(isMobileHome("/admin/stock")).toBe(false);
    expect(isMobileHome("/admin/branches")).toBe(false);
  });
});

describe("volver y título claro en cada pantalla", () => {
  it("las 4 tareas tienen su título del negocio y vuelven al Inicio", () => {
    expect(mobileScreen("/admin/branches", null)).toEqual({ title: "Sucursales", backHref: "/admin" });
    expect(mobileScreen("/admin/branches", "carry")).toEqual({ title: "Qué llevar", backHref: "/admin" });
    expect(mobileScreen("/admin/stock", null)).toEqual({ title: "Stock rápido", backHref: "/admin" });
    expect(mobileScreen("/admin/products", "new")).toEqual({ title: "Nuevo producto", backHref: "/admin" });
  });

  it("el detalle de una sucursal vuelve a la lista de sucursales (no a donde se haya estado antes)", () => {
    expect(mobileScreen("/admin/branches/d3000000-0000-4000-8000-000000000002", null)).toEqual({ title: "Sucursal", backHref: "/admin/branches" });
  });

  it("una pantalla de escritorio (desde «Más») tiene su título y vuelve al Inicio", () => {
    expect(mobileScreen("/admin/sales", null)).toEqual({ title: "Ventas", backHref: "/admin" });
    expect(mobileScreen("/admin/products", null)).toEqual({ title: "Productos", backHref: "/admin" });
    expect(mobileScreen("/admin/transfers", null)).toEqual({ title: "Distribución", backHref: "/admin" });
  });

  it("«Más» sólo lista pantallas que existen", () => {
    const known = new Set(adminNavGroups.flatMap((group) => group.links.flatMap((link) => link.match)));
    for (const link of MOBILE_MORE_LINKS) {
      const path = link.href;
      expect([...known].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))).toBe(true);
    }
  });
});
