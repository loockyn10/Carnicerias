import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { hasActivePoultryProducts, parseCandidates, parsePriceBoard } from "../lib/poultry";
import { ADD_POULTRY_PRODUCT_HREF, PoultryEmptyState, PoultryNoProductsNotice } from "./poultry-empty-state";
import { PoultryAddProductModal, PoultryProductSettingsModal } from "./poultry-product-modals";

vi.mock("../app/admin/poultry/actions", () => ({
  addPoultryProductAction: () => Promise.resolve({}),
  savePoultryProductSettingsAction: () => Promise.resolve({}),
  searchPoultryCandidatesAction: () => Promise.resolve({ data: [] })
}));
vi.mock("../app/admin/actions", () => ({ createProductModalAction: () => Promise.resolve({}) }));

const createProps = { categories: [], branches: [], suppliers: [], marginBps: null, excludedCategoryIds: [], productionBranchId: null };
const product = { id: "p1", catalogProductId: "c1", sku: "CAJ", name: "Cajón pollo entero", saleUnit: "UNIT" as const, requiresWeight: false, referenceWeightGrams: 20_000, active: true, costCents: null, costSince: null, prices: {} };

describe("productos de Pollos (lectura)", () => {
  it("el tablero trae el producto del catálogo y su SKU", () => {
    const board = parsePriceBoard({ lists: [], products: [{ id: "p1", catalogProductId: "c1", sku: "CAJ", name: "Cajón", saleUnit: "WEIGHT", active: true, prices: {} }] });
    expect(board.products[0]).toMatchObject({ catalogProductId: "c1", sku: "CAJ", saleUnit: "WEIGHT" });
  });

  it("lee los candidatos del catálogo con sus marcas", () => {
    const rows = parseCandidates([
      { productId: "a", name: "Cajón pollo entero", sku: "CAJ", unitType: "UNIT", alreadyAdded: true, removedFromPoultry: false },
      { productId: "b", name: "Pata muslo", sku: null, unitType: "WEIGHT", alreadyAdded: false, removedFromPoultry: true },
      { name: "sin id" }
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.alreadyAdded).toBe(true);
    expect(rows[1]).toMatchObject({ unitType: "WEIGHT", removedFromPoultry: true });
  });

  it("detecta si hay productos activos (los quitados no cuentan para pedir)", () => {
    expect(hasActivePoultryProducts([])).toBe(false);
    expect(hasActivePoultryProducts([{ active: false }])).toBe(false);
    expect(hasActivePoultryProducts([{ active: false }, { active: true }])).toBe(true);
  });
});

describe("estado vacío y aviso de Nuevo pedido", () => {
  it("el Resumen explica qué falta y ofrece Agregar producto", () => {
    const html = renderToStaticMarkup(<PoultryEmptyState />);
    expect(html).toContain("Todavía no hay productos de Pollos configurados");
    expect(html).toContain("Agregá el primer producto para comenzar a cargar precios y pedidos.");
    expect(html).toContain(`href="${ADD_POULTRY_PRODUCT_HREF}"`);
    expect(html).toContain("Agregar producto");
  });

  it("Nuevo pedido sin productos muestra el mensaje y la acción", () => {
    const html = renderToStaticMarkup(<PoultryNoProductsNotice />);
    expect(html).toContain("No hay productos de Pollos configurados.");
    expect(html).toContain(`href="${ADD_POULTRY_PRODUCT_HREF}"`);
  });
});

describe("Agregar producto", () => {
  it("cerrado sólo muestra el botón", () => {
    const html = renderToStaticMarkup(<PoultryAddProductModal createProps={createProps} />);
    expect(html).toContain("+ Agregar producto");
    expect(html).not.toContain("Buscar producto");
  });

  it("abierto busca en el catálogo general y ofrece crear uno con el alta de Productos", () => {
    const html = renderToStaticMarkup(<PoultryAddProductModal createProps={createProps} defaultOpen />);
    expect(html).toContain("Buscar producto");
    expect(html).toContain("catálogo general");
    expect(html).toContain("+ Crear producto nuevo");
    expect(html).not.toContain('name="name"');
  });

  it("la configuración de Pollos habla en «por cajón» / «por kg» y permite quitarlo sin borrar", () => {
    const html = renderToStaticMarkup(<PoultryProductSettingsModal product={product} />);
    expect(html).toContain("Configurar");
    const open = renderToStaticMarkup(<PoultryProductSettingsModal product={{ ...product, saleUnit: "WEIGHT" }} />);
    expect(open).not.toContain("Por cajón</option>");
  });
});
