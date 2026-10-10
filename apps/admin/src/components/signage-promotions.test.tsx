import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../app/admin/products/signage/actions", () => ({
  loadPromotionCatalogAction: () => new Promise(() => undefined), saveSignageGroupAction: () => Promise.resolve({}), deleteSignageGroupAction: () => Promise.resolve({})
}));

import { slideToArtworkModel } from "../lib/artwork";
import { must } from "../lib/test-support/must";
import { buildOfferSlide, type PromotionFact, type SlideFacts } from "../lib/signage";
import { parsePromotionCatalog, type PromotionOption } from "../lib/signage-promotions";
import { signageView } from "../lib/test-support/signage-fixtures";
import { OfferArtwork } from "./artwork/offer-artwork";
import { isSelectable, PromotionChooser, PromotionGroupsModal, PromotionPickerModal } from "./signage-promotions";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const option = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  promotionId: UUID(id), productId: UUID(900 + id), productName: name, sku: null, unitType: "WEIGHT", branchId: null, branchName: null, mode: "THRESHOLD", status: "ACTIVE",
  validFrom: "2026-10-01T00:00:00Z", validUntil: null, listPriceCents: "1000000", hasPhoto: true, unavailableReason: null, minimumGrams: 2000, discountType: "PERCENTAGE",
  discountValue: "1000", packQuantityGrams: null, packQuantityUnits: null, packPriceCents: null, ...extra
});
const options = parsePromotionCatalog({
  promotions: [option(1, "Pata muslo"), option(2, "Costilla de cerdo", { hasPhoto: false, branchName: "Avenida" }), option(3, "Coca Cola", { status: "EXPIRED", validUntil: "2026-10-05T00:00:00Z" }), option(4, "Matambre", { status: "UPCOMING" }), option(5, "Chorizo", { unavailableReason: "INACTIVE" })],
  groups: []
}).promotions;

describe("PromotionChooser: elegir promociones ya cargadas (por defecto las activas)", () => {
  const html = renderToStaticMarkup(<PromotionChooser onToggle={() => undefined} options={options} selected={new Set([UUID(1)])} />);

  it("muestra las pestañas Activas / Próximas / Vencidas con su cantidad y arranca en Activas", () => {
    expect(html).toContain("Activas (3)");
    expect(html).toContain("Próximas (1)");
    expect(html).toContain("Vencidas (1)");
    expect(html).toMatch(/aria-selected="true"[^>]*>Activas/);
  });

  it("lista las activas con el precio promocional que verá el TV, la vigencia y la sucursal", () => {
    expect(html).toContain("Pata muslo");
    expect(html).toContain("$ 9.000 / kg · desde 2 kg");
    expect(html).toContain("Sin fecha de fin");
    expect(html).toContain("Avenida");
    expect(html).toContain("Todas las sucursales");
  });

  it("no muestra las vencidas ni las próximas en la pestaña por defecto", () => {
    expect(html).not.toContain("Coca Cola");
    expect(html).not.toContain("Matambre");
  });

  it("avisa «Sin foto» en la promoción que no la tiene, sin impedir elegirla", () => {
    expect(html).toContain("⚠ Sin foto");
    expect(html.match(/⚠ Sin foto/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Elegir Costilla de cerdo"[^>]*(?!disabled)/);
  });

  it("deja marcada la que ya estaba elegida y bloquea la de un producto inactivo", () => {
    expect(html).toMatch(/aria-label="Elegir Pata muslo"[^>]*checked/);
    expect(html).toMatch(/aria-label="Elegir Chorizo"[^>]*disabled/);
    expect(html).toContain("Producto inactivo");
  });

  it("isSelectable: las vencidas no se pueden elegir; las próximas sí (empiezan solas)", () => {
    const by = (name: string): PromotionOption => must(options.find((candidate) => candidate.productName === name));
    expect(isSelectable(by("Pata muslo"))).toBe(true);
    expect(isSelectable(by("Matambre"))).toBe(true);
    expect(isSelectable(by("Coca Cola"))).toBe(false);
    expect(isSelectable(by("Chorizo"))).toBe(false);
  });

  it("una promoción que la pantalla ya tiene aparece deshabilitada con el motivo", () => {
    const again = renderToStaticMarkup(<PromotionChooser disabledIds={new Set([UUID(1)])} onToggle={() => undefined} options={options} selected={new Set()} />);
    expect(again).toMatch(/aria-label="Elegir Pata muslo"[^>]*disabled/);
    expect(again).toContain("Ya está en la lista");
  });
});

describe("modales de promociones y grupos", () => {
  it("el selector abre como diálogo, dice para qué pantalla es y carga el catálogo antes de mostrar nada", () => {
    const html = renderToStaticMarkup(<PromotionPickerModal alreadyAdded={new Set()} branchId={null} displayName="TV Avenida" onAdd={() => undefined} onClose={() => undefined} onGroupSaved={() => undefined} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Elegir promociones");
    expect(html).toContain("Pantalla: TV Avenida");
    expect(html).toContain("Cargando promociones");
    expect(html).not.toContain("Guardar como grupo");
  });

  it("el administrador de grupos abre como diálogo y carga antes de mostrar la lista", () => {
    const html = renderToStaticMarkup(<PromotionGroupsModal onChanged={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Grupos de promociones");
    expect(html).toContain("Cargando");
  });
});

describe("renderer de TV: una promoción usa el diseño moderno existente (no el bordó viejo)", () => {
  const promotion = (fact: Partial<PromotionFact>): PromotionFact => ({
    promotionId: UUID(1), mode: "PACK_FIXED_TOTAL", status: "ACTIVE", minimumGrams: null, discountType: null, discountValue: null, packQuantityGrams: null, packQuantityUnits: 3, packPriceCents: 540_000n, ...fact
  });
  const facts: SlideFacts = { key: UUID(1), name: "Coca Cola 2,25 L", unitType: "UNIT", listPriceCents: 200_000n, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [], promotion: promotion({}) };
  const offer = buildOfferSlide(facts);
  const render = (imageUrl: string | null) => {
    const slide = { ...must(offer), imageUrl };
    return renderToStaticMarkup(<OfferArtwork format="tv" model={slideToArtworkModel(signageView([slide]), slide)} slideIndex={0} />);
  };

  it("muestra el precio promocional, «POR 3 UNIDADES» y el precio normal de las 3 unidades, con la franja verde y la pastilla amarilla", () => {
    const html = render(`/api/tv/TOKEN/media/${UUID(1)}?v=x`);
    const text = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("5.400");
    expect(text).toContain("POR 3 UNIDADES");
    expect(text).toContain("PRECIO NORMAL $ 6.000");
    expect(html).toContain('data-testid="artwork-tv"');
    expect(html.toLowerCase()).toContain("background:#ffffff");
    expect(html).not.toMatch(/gradient|#9f1239|#6b0b26/i);
  });

  it("con foto: la pide por la ruta del token; sin foto: dibuja el reemplazo y no rompe", () => {
    expect(render(`/api/tv/TOKEN/media/${UUID(1)}?v=x`)).toContain(`src="/api/tv/TOKEN/media/${UUID(1)}?v=x"`);
    const without = render(null);
    expect(without).toContain("<svg");
    expect(without).not.toContain("/api/tv/TOKEN/media/");
    expect(without).not.toMatch(/error|undefined|null/i);
  });
});
