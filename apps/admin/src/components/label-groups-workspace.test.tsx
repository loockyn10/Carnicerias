import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { buildLabelGroupView, parseLabelGroupFacts } from "../lib/label-group";
import { LabelGroupsWorkspace, type LabelRunDetail, type LabelRunRow } from "./label-groups-workspace";
import { must } from "../lib/test-support/must";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => <a href={href}>{children as string}</a> }));
vi.mock("../app/admin/products/labels/actions", () => ({
  saveLabelGroupAction: () => Promise.resolve({}), setLabelGroupProductsAction: () => Promise.resolve({}), searchLabelProductsAction: () => Promise.resolve({ options: [] })
}));

const GROUP = "99999999-9999-4999-8999-999999999999";
const printed = (list: string, promo: string) => ({
  runId: "r1", generatedAt: "2026-10-06T13:15:00.000Z", displayedName: "MAYONESA HELLMANN'S", variant: "PROMO", copies: 2,
  listPriceCents: list, promoPriceCents: promo, promoMinimumUnits: 3, promoDiscountBps: 1_500
});
const payload = {
  groupId: GROUP, name: "Góndolas Despensa Central", branchId: "b1", branchName: "Central", active: true,
  items: [
    { productId: "p1", position: 0, name: "Mayonesa Hellmann's", sku: "MAY-1", unitType: "UNIT", available: true, unavailableReason: null, listPriceCents: "225000", bulkMinimumUnits: 3, bulkDiscountBps: 1_500, last: printed("203500", "172975") },
    { productId: "p2", position: 1, name: "Aceite Cañuelas", sku: null, unitType: "UNIT", available: true, unavailableReason: null, listPriceCents: "625000", bulkMinimumUnits: null, bulkDiscountBps: null,
      last: { ...printed("625000", "0"), displayedName: "ACEITE CAÑUELAS", variant: "SIMPLE", promoPriceCents: null, promoMinimumUnits: null, promoDiscountBps: null } },
    { productId: "p3", position: 2, name: "Producto sin precio", sku: null, unitType: "UNIT", available: false, unavailableReason: "NO_PRICE", listPriceCents: null, bulkMinimumUnits: null, bulkDiscountBps: null, last: null }
  ]
};
const facts = parseLabelGroupFacts(payload);
if (!facts) throw new Error("grupo de prueba inválido");
const group = buildLabelGroupView(facts, "America/Argentina/Buenos_Aires");
const groups = [{ groupId: GROUP, name: "Góndolas Despensa Central", branchName: "Central", itemCount: 3 }];
const branches = [{ id: "b1", name: "Central", active: true }];
const runs: LabelRunRow[] = [
  { id: "run2", groupId: GROUP, groupName: "Góndolas Despensa Central", whenText: "07/10/2026 15:42", labelCount: 18, productCount: 9 },
  { id: "run1", groupId: GROUP, groupName: "Góndolas Despensa Central", whenText: "06/10/2026 10:15", labelCount: 12, productCount: 12 }
];
const detail: LabelRunDetail = { run: must(runs[0]), items: [{ productName: "MAYONESA HELLMANN'S", copies: 2, text: "$ 1.729,75 (3+ u) · normal $ 2.035", condition: "POR 3 UNIDADES - Descuento 15%" }] };

const html = renderToStaticMarkup(<LabelGroupsWorkspace branches={branches} group={group} groups={groups} runDetail={detail} runs={runs} />);

describe("pantalla de etiquetas: grupos, selección y PDF", () => {
  it("muestra el grupo elegido con su sucursal y los botones de grupo", () => {
    expect(html).toContain("Góndolas Despensa Central · Central (3)");
    expect(html).toContain("Nuevo grupo");
    expect(html).toContain("Editar grupo");
    expect(html).toContain("Precios y promoción de Central.");
  });

  it("lista los productos del grupo con su estado frente a la última impresión", () => {
    expect(html).toContain("Productos del grupo (3)");
    expect(html).toMatch(/data-freshness="CHANGED"[^>]*>Precio cambió/);
    expect(html).toMatch(/data-freshness="UPDATED"[^>]*>Actualizada/);
    expect(html).toContain("Sin precio vigente");
    // lo impreso vs lo de hoy
    expect(html).toContain("Impresa: $ 1.729,75 (3+ u) · normal $ 2.035 (06/10/2026 10:15)");
    expect(html).toContain("Hoy: $ 1.912,50 (3+ u) · normal $ 2.250");
  });

  it("acciones del grupo: seleccionar todos, seleccionar precios cambiados (con la cantidad), generar PDF y copias por producto", () => {
    expect(html).toContain("Seleccionar todos");
    expect(html).toContain("Seleccionar precios cambiados (1)");
    expect(html).toContain("Generar PDF");
    expect(html).toContain('aria-label="Copias de Mayonesa Hellmann&#x27;s"');
    expect(html).toContain('value="1"');
    expect(html).toMatch(/aria-label="Seleccionar Producto sin precio"[^>]*disabled/);
    // sin nada tildado: 0 etiquetas y el botón de generar deshabilitado
    expect(html).toMatch(/data-testid="label-generate"[^>]*disabled/);
    expect(html).toContain("<strong>0</strong> etiquetas · 0 hojas A4 (21 por hoja)");
  });

  it("vista previa: la etiqueta de 70 × 50 mm del primer producto, en el diseño nuevo", () => {
    expect(html).toContain('data-testid="product-price-label"');
    expect(html).toContain("max-width:192mm");
    expect(html).toContain('viewBox="0 0 60 40"');
    expect(html).toContain("OFERTA!!!");
    expect(html).toContain("POR 3 UNIDADES");
    expect(html).toContain("Tamaño: 60 × 40 mm");
  });

  it("historial: últimas generaciones con fecha, grupo y cantidad, y el detalle de lo impreso", () => {
    expect(html).toContain("Últimas generaciones");
    expect(html).toContain("07/10/2026 15:42");
    expect(html).toContain("18 etiquetas");
    expect(html).toContain("12 etiquetas");
    expect(html).toContain('href="/admin/products/labels?group=99999999-9999-4999-8999-999999999999&amp;run=run2"');
    expect(html).toContain("Ver detalle");
    expect(html).toContain("$ 1.729,75 (3+ u) · normal $ 2.035");
    expect(html).toContain("POR 3 UNIDADES - Descuento 15%");
    expect(html).toContain("es historial: no es el precio vigente".replace("es", "Es"));
  });

  it("sin grupos: invita a crear el primero y no muestra la lista de productos", () => {
    const empty = renderToStaticMarkup(<LabelGroupsWorkspace branches={branches} group={null} groups={[]} runDetail={null} runs={[]} />);
    expect(empty).toContain("Todavía no hay grupos");
    expect(empty).toContain("Nuevo grupo");
    expect(empty).toContain('data-testid="label-group-form"');
    expect(empty).not.toContain("Productos del grupo");
    expect(empty).toContain("Todavía no se generó ningún PDF.");
  });

  it("no hay ningún campo para tipear precios ni costos", () => {
    expect(html).not.toMatch(/name="price|placeholder="Precio|costo|margen/i);
  });
});
