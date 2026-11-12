import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const rpc = vi.fn((name: string) => {
  if (name === "get_vacuum_settings") {
    return Promise.resolve({ data: { businessName: "Fran", defaultShelfLifeDays: 12, ean: { configured: true, scheme: "PRICE_EMBEDDED", prefix: "20", pluDigits: 4, valueDigits: 6, valueStep: 100 } }, error: null });
  }
  return Promise.resolve({
    data: {
      total: 3, defaultShelfLifeDays: 12,
      rows: [
        { productId: "a", name: "Vacío de cerdo", sku: "VCE", enabled: true, shelfLifeDays: 12, customShelfLifeDays: null, plu: "1", conservationText: null },
        { productId: "b", name: "Carne picada", sku: "PIC", enabled: true, shelfLifeDays: 2, customShelfLifeDays: 2, plu: "2", conservationText: null },
        { productId: "c", name: "Bondiola", sku: "BON", enabled: false, shelfLifeDays: 12, customShelfLifeDays: null, plu: null, conservationText: null }
      ]
    }, error: null
  });
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/admin/vacuum/settings", useSearchParams: () => new URLSearchParams() }));
vi.mock("../../../../lib/admin", () => ({ requireAdminContext: () => Promise.resolve({}) }));
vi.mock("../../../../lib/supabase/server", () => ({ createClient: () => Promise.resolve({ rpc }) }));
vi.mock("../actions", () => ({
  saveVacuumDefaultShelfLifeAction: vi.fn(), saveVacuumEanSchemeAction: vi.fn(), saveVacuumProductOverridesAction: vi.fn(),
  saveVacuumSettingsAction: vi.fn(), setVacuumProductEnabledAction: vi.fn()
}));

describe("/admin/vacuum/settings: renderizado real de la página", () => {
  it("se resuelve como Server Component y se renderiza completa con vencimientos generales y personalizados", async () => {
    const { default: Page } = await import("./page");
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Días de vencimiento predeterminados");
    expect(html).toContain("12 días");
    expect(html).toContain("Vacío de cerdo");
    expect(html).toContain("Carne picada");
    expect(html).toContain("2 días");
    expect(html).toContain("General");
    expect(html).toContain("Personalizado");
    expect(html).toContain("✕ Deshabilitar");
    expect(html).toContain("✓ Habilitar");
    expect(html).toContain("⚙ Configurar");
    expect(html).not.toContain("rounded-lg bg-red-50");
  });
});
