import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  filterPoultryByCategory, filterPoultryProducts, hasActivePoultryProducts, parseCandidates, parsePriceBoard, parseSortOrderInput, sortPoultryProducts
} from "../lib/poultry";
import { ADD_POULTRY_PRODUCT_HREF, PoultryEmptyState, PoultryNoProductsNotice } from "./poultry-empty-state";
import { priceListNotes, PoultryPriceListButton } from "./poultry-price-list-button";
import { PoultryPriceListImagesPanel } from "./poultry-price-list-images-panel";
import { PoultryAddProductModal, PoultryDeleteProductModal, PoultryProductSettingsModal } from "./poultry-product-modals";
import { PoultryProductsBoard } from "./poultry-products-board";

vi.mock("../app/admin/poultry/actions", () => ({
  addPoultryProductAction: () => Promise.resolve({}),
  savePoultryProductSettingsAction: () => Promise.resolve({}),
  deletePoultryProductAction: () => Promise.resolve({}),
  savePoultryPricesAction: () => Promise.resolve({}),
  savePoultryPriceListAction: () => Promise.resolve({}),
  getPoultryPriceHistoryAction: () => Promise.resolve({ data: {} }),
  searchPoultryCandidatesAction: () => Promise.resolve({ data: [] }),
  setPoultryProductSortOrderAction: () => Promise.resolve({ ok: true, sortOrder: 1 })
}));
vi.mock("../app/admin/actions", () => ({ createProductModalAction: () => Promise.resolve({}) }));
vi.mock("../app/admin/poultry/price-list/actions", () => ({
  createPriceListUploadPathAction: () => Promise.resolve({}),
  registerPriceListImageAction: () => Promise.resolve({}),
  setPriceListLogoSourceAction: () => Promise.resolve({}),
  removePriceListBackgroundAction: () => Promise.resolve({})
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const createProps = { categories: [], branches: [], suppliers: [], marginBps: null, excludedCategoryIds: [], productionBranchId: null };
const product = { id: "p1", catalogProductId: "c1", sku: "CAJ", name: "Cajón pollo entero", saleUnit: "UNIT" as const, requiresWeight: false, referenceWeightGrams: 20_000, active: true, category: "POLLO" as const, sortOrder: 1, costCents: null, costSince: null, prices: {} };

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

describe("buscador de productos", () => {
  const rows = [{ name: "Pollo entero x 20 kg" }, { name: "Pechuga entera x 15 kg" }, { name: "Muslos rellenos (JAMÓN y queso)" }, { name: "Alitas x 15 kg" }];
  const names = (query: string) => filterPoultryProducts(rows, query).map((row) => row.name);

  it("vacío (o sólo espacios) muestra todos", () => {
    expect(names("")).toHaveLength(4);
    expect(names("   ")).toHaveLength(4);
  });

  it("ignora mayúsculas, minúsculas y acentos", () => {
    expect(names("POLLO")).toEqual(["Pollo entero x 20 kg"]);
    expect(names("jamon")).toEqual(["Muslos rellenos (JAMÓN y queso)"]);
    expect(names("Pechúga")).toEqual(["Pechuga entera x 15 kg"]);
  });

  it("todas las palabras tienen que aparecer, en cualquier orden", () => {
    expect(names("entero pollo")).toEqual(["Pollo entero x 20 kg"]);
    expect(names("15 kg")).toEqual(["Pechuga entera x 15 kg", "Alitas x 15 kg"]);
    expect(names("pollo pechuga")).toEqual([]);
  });

  it("la tabla trae el buscador y una acción Eliminar por producto", () => {
    const board = parsePriceBoard({
      lists: [{ id: "g", name: "General", isDefault: true, active: true }],
      products: [{ id: "p1", name: "Pollo entero x 20 kg", saleUnit: "UNIT", active: true, prices: { g: { cents: "6599900", since: "2026-11-01" } } }, { id: "p2", name: "Alitas x 15 kg", saleUnit: "UNIT", active: true, prices: {} }]
    });
    const html = renderToStaticMarkup(<PoultryProductsBoard lists={board.lists} products={board.products} timeZone="UTC" />);
    expect(html).toContain('data-testid="poultry-product-search"');
    expect(html.match(/data-testid="poultry-product-row"/g)).toHaveLength(2);
    expect(html.match(/>Eliminar</g)).toHaveLength(2);
    expect(html).not.toContain("poultry-search-empty");
  });

  it("sin productos no muestra el buscador sino el estado vacío", () => {
    const html = renderToStaticMarkup(<PoultryProductsBoard lists={[]} products={[]} timeZone="UTC" />);
    expect(html).not.toContain("poultry-product-search");
    expect(html).toContain("Todavía no hay productos de Pollos");
  });
});

describe("orden y categorías", () => {
  const row = (id: string, name: string, category: string, sortOrder: number) => ({ id, name, saleUnit: "UNIT", active: true, category, sortOrder, prices: {} });

  it("el tablero trae la categoría y el número de orden (una categoría desconocida cae en Pollo)", () => {
    const board = parsePriceBoard({ lists: [], products: [row("a", "Medallones", "CONGELADOS", 3), { id: "b", name: "Viejo", saleUnit: "UNIT", active: true, category: "OTRA", prices: {} }] });
    expect(board.products[0]).toMatchObject({ category: "CONGELADOS", sortOrder: 3 });
    expect(board.products[1]?.category).toBe("POLLO");
  });

  it("ordena por categoría (Pollo primero), número (numérico, no alfabético), nombre e id", () => {
    const board = parsePriceBoard({ lists: [], products: [
      row("c1", "Medallones", "CONGELADOS", 1), row("p10", "Pechuga", "POLLO", 10), row("p2", "Pata muslo", "POLLO", 2),
      row("p2b", "Alitas", "POLLO", 2), row("z", "Alitas", "POLLO", 2), row("c0", "Hamburguesas", "CONGELADOS", 1)
    ] });
    expect(sortPoultryProducts(board.products).map((product) => product.id)).toEqual(["p2b", "z", "p2", "p10", "c0", "c1"]);
  });

  it("el número de orden acepta sólo enteros positivos", () => {
    expect(parseSortOrderInput("3")).toBe(3);
    expect(parseSortOrderInput(" 12 ")).toBe(12);
    expect(parseSortOrderInput("99999")).toBe(99999);
    for (const invalid of ["", "0", "-1", "1.5", "1,5", "1e3", "abc", "100000", "+4"]) expect(parseSortOrderInput(invalid)).toBeNull();
  });

  it("el filtro de categoría se combina con el buscador", () => {
    const products = parsePriceBoard({ lists: [], products: [row("a", "Chorizos de pollo", "POLLO", 1), row("b", "Chorizos de cerdo", "CONGELADOS", 1), row("c", "Alitas", "POLLO", 2)] }).products;
    expect(filterPoultryByCategory(products, "ALL")).toHaveLength(3);
    expect(filterPoultryProducts(filterPoultryByCategory(products, "POLLO"), "chorizos").map((product) => product.id)).toEqual(["a"]);
    expect(filterPoultryProducts(filterPoultryByCategory(products, "CONGELADOS"), "chorizos").map((product) => product.id)).toEqual(["b"]);
    expect(filterPoultryProducts(filterPoultryByCategory(products, "CONGELADOS"), "alitas")).toEqual([]);
  });

  it("la tabla muestra Orden editable, la categoría y el filtro Todos / Pollo / Congelados, en el orden configurado", () => {
    const board = parsePriceBoard({ lists: [], products: [row("c", "Medallones", "CONGELADOS", 1), row("b", "Pechuga", "POLLO", 10), row("a", "Pata muslo", "POLLO", 9)] });
    const html = renderToStaticMarkup(<PoultryProductsBoard lists={board.lists} products={board.products} timeZone="UTC" />);
    expect(html).toContain(">Orden</th>");
    expect(html).toContain(">Categoría</th>");
    expect([...html.matchAll(/data-testid="poultry-sort-order"[^>]*value="(\d+)"/g)].map((match) => match[1])).toEqual(["9", "10", "1"]);
    expect([...html.matchAll(/data-testid="poultry-product-category">([^<]+)</g)].map((match) => match[1])).toEqual(["Pollo", "Pollo", "Congelados"]);
    expect(html).toContain('data-testid="poultry-category-filter-all"');
    expect(html).toMatch(/Pollo <span[^>]*>\(2\)/);
    expect(html).toMatch(/Congelados <span[^>]*>\(1\)/);
  });
});

describe("Eliminar producto", () => {
  it("cerrado sólo muestra el botón; la confirmación aparece recién al tocarlo", () => {
    const html = renderToStaticMarkup(<PoultryDeleteProductModal product={product} />);
    expect(html).toContain(">Eliminar<");
    expect(html).not.toContain("role=\"dialog\"");
  });
});

describe("Lista de precios", () => {
  it("es un único botón, sin pasos intermedios", () => {
    const html = renderToStaticMarkup(<PoultryPriceListButton />);
    expect(html).toContain("Lista de precios");
    expect(html).not.toContain("role=\"dialog\"");
  });

  it("avisa lo que no entra con precio por cajón", () => {
    expect(priceListNotes(0, 0)).toEqual([]);
    expect(priceListNotes(1, 0)[0]).toContain("1 producto se vende por kg");
    expect(priceListNotes(2, 3)).toHaveLength(2);
    expect(priceListNotes(0, 3)[0]).toContain("«Consultar»");
    expect(priceListNotes(0, 0, true)[0]).toContain("sin logo");
  });
});

describe("Imágenes de la lista", () => {
  const image = { url: "https://example.test/x.png", widthPx: 800, heightPx: 200 };

  it("ofrece primero los logos ya cargados y marca el que está en uso", () => {
    const html = renderToStaticMarkup(<PoultryPriceListImagesPanel background={null} logoUsed="ARTWORK" logos={{ ARTWORK: image, BUTCHER: image }} />);
    expect(html).toContain('data-testid="price-list-logo-artwork"');
    expect(html).toContain('data-testid="price-list-logo-butcher"');
    expect(html).toContain("En uso");
    expect(html.match(/>Usar este</g)).toHaveLength(1);
    expect(html).toContain("Subir otro logo");
    expect(html).toContain('data-testid="price-list-no-background"');
    expect(html).not.toContain("Quitar foto");
  });

  it("sin ningún logo en la aplicación pide subirlo", () => {
    const html = renderToStaticMarkup(<PoultryPriceListImagesPanel background={image} logoUsed={null} logos={{}} />);
    expect(html).toContain('data-testid="price-list-no-logo"');
    expect(html).toContain("Reemplazar foto");
    expect(html).toContain("Quitar foto");
  });
});
