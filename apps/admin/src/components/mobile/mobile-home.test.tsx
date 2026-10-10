import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MOBILE_TASKS } from "../../lib/mobile-nav";
import { MobileHome } from "./mobile-home";

// «Más opciones» importa la acción de cerrar sesión (next/cache + Supabase): acá sólo importa el render.
vi.mock("../../app/admin/actions", () => ({ logout: () => Promise.resolve() }));

describe("Inicio del celular", () => {
  const html = renderToStaticMarkup(<MobileHome organizationName="SUPER OFERTAS" />);

  it("muestra el nombre del negocio y UNA pregunta", () => {
    expect(html).toContain("SUPER OFERTAS");
    expect(html).toContain("¿Qué querés hacer?");
  });

  it("muestra EXACTAMENTE las 4 tareas, cada una con ícono, título y frase, como link a su pantalla", () => {
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)];
    expect(links).toHaveLength(4);
    expect(links.map((link) => link[1]?.replaceAll("&amp;", "&"))).toEqual(MOBILE_TASKS.map((task) => task.href));
    for (const task of MOBILE_TASKS) {
      expect(html).toContain(task.title);
      expect(html).toContain(task.description);
      expect(html).toContain(task.icon);
    }
    expect(html).toContain("Ver sucursales");
    expect(html).toContain("Qué llevar");
    expect(html).toContain("Stock rápido");
    expect(html).toContain("Nuevo producto");
  });

  it("las tarjetas son grandes y tocables con una mano (alto mínimo, ancho completo)", () => {
    const cards = [...html.matchAll(/<a [^>]*class="([^"]+)"/g)];
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card[1]).toContain("min-h-28");
      expect(card[1]).toContain("flex");
    }
  });

  it("sólo se ve en el celular: el escritorio conserva su panel", () => {
    const root = /<div class="([^"]+)" data-testid="mobile-home"/.exec(html);
    expect(root?.[1]).toContain("lg:hidden");
  });

  it("no mete una grilla de accesos: lo demás está detrás de «Más opciones»", () => {
    expect(html).toContain("Más opciones");
    expect(html).not.toContain("Desposte");
    expect(html).not.toContain("Empleados");
    expect(html).not.toContain("Configuración");
  });
});
