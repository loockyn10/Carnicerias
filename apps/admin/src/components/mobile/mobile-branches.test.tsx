import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { resolveSalesRange } from "../../lib/date-range";
import type { BranchCardData } from "../../lib/mobile-branches";
import { MobileBranches } from "./mobile-branches";

const TZ = "America/Argentina/Buenos_Aires";
const NOW = new Date("2026-10-10T15:00:00Z");
const card = (over: Partial<BranchCardData>): BranchCardData => ({
  id: "avenida-id", name: "Avenida", isProduction: false, revenueCents: 32_540_000, grams: 42_500, units: 0, tickets: 31,
  profitCents: 8_730_000, marginBps: 2_683, missingCostItems: 0, alerts: 2, outOfStock: 1, ...over
});

describe("«Ver sucursales» del celular", () => {
  const today = resolveSalesRange({ preset: "today" }, TZ, NOW);
  const html = renderToStaticMarkup(<MobileBranches cards={[card({}), card({ id: "janssen-id", name: "Janssen", revenueCents: 1_800_000, grams: 20_000, alerts: 0, outOfStock: 0, profitCents: null, marginBps: null })]} range={today} />);

  it("una tarjeta por sucursal con ventas, kg, ganancia, margen y alertas", () => {
    expect(html).toContain("Avenida");
    expect(html).toContain("$ 325.400");
    expect(html).toContain("42,500 kg");
    expect(html).toContain("$ 87.300");
    expect(html).toContain("26,83 %");
    expect(html).toContain("⚠ 2 alertas");
    expect(html).toContain("✓ Sin alertas");
  });

  it("sin ganancia calculable muestra «—», nunca un número inventado", () => {
    expect(html.slice(html.indexOf("Janssen"))).toContain("—");
  });

  it("período: 4 botones y «Otro período», que recién ahí muestra Desde / Hasta", () => {
    for (const key of ["today", "yesterday", "7d", "30d"]) expect(html).toContain(`href="/admin/branches?preset=${key}"`);
    for (const label of ["Hoy", "Ayer", "7 días", "30 días"]) expect(html).toContain(`>${label}</a>`);
    expect(html).toContain("Otro período");
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Mostrando: <strong");
  });

  it("con un período a medida el selector secundario queda abierto", () => {
    const custom = resolveSalesRange({ from: "2026-10-01", to: "2026-10-07" }, TZ, NOW);
    expect(renderToStaticMarkup(<MobileBranches cards={[card({})]} range={custom} />)).toMatch(/<details[^>]*\sopen/);
  });

  it("«Ver detalle» es una navegación completa a la sucursal (no el modal de escritorio) y conserva el período", () => {
    const link = /<a [^>]*href="(\/admin\/branches\/avenida-id[^"]*)"[^>]*>Ver detalle<\/a>/.exec(html);
    expect(link?.[1]?.replaceAll("&amp;", "&")).toBe("/admin/branches/avenida-id?from=2026-10-10&to=2026-10-10");
  });

  it("avisa cuando hay ventas sin costo y marca el depósito", () => {
    const warned = renderToStaticMarkup(<MobileBranches cards={[card({ missingCostItems: 3 }), card({ id: "c", name: "Central", isProduction: true })]} range={today} />);
    expect(warned).toContain("sin costo cargado");
    expect(warned).toContain("Depósito");
  });

  it("sólo se ve en el celular", () => {
    expect(/<div class="([^"]+)" data-testid="mobile-branches"/.exec(html)?.[1]).toContain("lg:hidden");
  });
});
