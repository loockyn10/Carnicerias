import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readImageInfo } from "./image-size";
import { parsePriceBoard, type PoultryPriceBoard } from "./poultry";
import {
  buildPoultryPriceListModel, fitLogo, formatListPrice, L, layoutPoultryPriceList, listTextWidth, localDate, PRICE_LIST_NO_PRICE, PRICE_LIST_SECTIONS, PRICE_LIST_WIDTH,
  priceListFilename, PriceListError, priceListProductCount, sanitizeListText, wrapListText, type PoultryPriceListModel, type PriceListRow
} from "./poultry-price-list";
import { executePoultryPriceList, imageDataUrl, renderPoultryPriceListPng, type PriceListDeps } from "./poultry-price-list-png";
import { makePng } from "./test-support/artwork-fixtures";

const pngFixture = (width: number, height: number) => makePng(width, height, () => [200, 40, 40, 255]);

const GENERAL = "list-general";
const MAYORISTA = "list-mayorista";

function product(id: string, name: string, general: string | null, extra: Record<string, unknown> = {}) {
  const prices: Record<string, { cents: string; since: string }> = { [MAYORISTA]: { cents: "1", since: "2026-11-01T00:00:00Z" } };
  if (general !== null) prices[GENERAL] = { cents: general, since: "2026-11-01T00:00:00Z" };
  return { id, catalogProductId: `c-${id}`, sku: null, name, saleUnit: "UNIT", requiresWeight: false, referenceWeightGrams: null, active: true, costCents: "100", costSince: null, prices, ...extra };
}

function board(products: unknown[]): PoultryPriceBoard {
  return parsePriceBoard({
    lists: [
      { id: MAYORISTA, name: "Mayorista", isDefault: false, active: true, customerCount: 2 },
      { id: GENERAL, name: "General", isDefault: true, active: true, customerCount: 0 }
    ],
    products
  });
}

const rowsOf = (model: Pick<PoultryPriceListModel, "sections">) => model.sections.flatMap((section) => section.rows);

const REFERENCE = [
  product("1", "Pollo entero x 20 kg", "6599900"),
  product("2", "Pechuga entera x 15 kg", "7699900"),
  product("3", "Pata muslo x 15 kg", "4799900"),
  product("4", "Alitas x 15 kg", "4199900")
];

describe("modelo de la lista de precios de Pollos", () => {
  it("usa exclusivamente el precio vigente de la lista General, tal cual está registrado", () => {
    const model = buildPoultryPriceListModel(board(REFERENCE), "2026-11-17");
    expect(rowsOf(model).map((row) => [row.name, row.priceCents])).toEqual([
      ["Alitas x 15 kg", 4199900n], ["Pata muslo x 15 kg", 4799900n], ["Pechuga entera x 15 kg", 7699900n], ["Pollo entero x 20 kg", 6599900n]
    ]);
    expect(rowsOf(model).map((row) => formatListPrice(row.priceCents))).toEqual(["$41.999", "$47.999", "$76.999", "$65.999"]);
  });

  it("incluye todos los activos por cajón y excluye inactivos (quitados) y los productos por kg", () => {
    const model = buildPoultryPriceListModel(board([
      ...REFERENCE,
      product("5", "Menudos x 15 kg", "4949900", { active: false }),
      product("6", "Suprema por kg", "900000", { saleUnit: "WEIGHT", requiresWeight: true })
    ]), "2026-11-17");
    expect(rowsOf(model)).toHaveLength(4);
    expect(rowsOf(model).some((row) => row.name.startsWith("Menudos") || row.name.startsWith("Suprema"))).toBe(false);
    expect(model.omittedByWeight).toBe(1);
  });

  it("un producto por cajón sin precio General no se omite: dice «Consultar» y se informa", () => {
    const model = buildPoultryPriceListModel(board([...REFERENCE, product("7", "Molida x 20 kg", null)]), "2026-11-17");
    expect(rowsOf(model)).toHaveLength(5);
    expect(model.missingPrice).toBe(1);
    expect(formatListPrice(rowsOf(model).find((row) => row.name.startsWith("Molida"))?.priceCents ?? null)).toBe(PRICE_LIST_NO_PRICE);
  });

  it("arma la sección POLLO y debajo CONGELADOS, cada una en el orden configurado (numérico, desempata el nombre)", () => {
    const model = buildPoultryPriceListModel(board([
      product("c2", "Medallones x 6 kg", "5579900", { category: "CONGELADOS", sortOrder: 2 }),
      product("p10", "Pechuga entera x 15 kg", "7699900", { category: "POLLO", sortOrder: 10 }),
      product("c1", "Patitas rebozadas x 6 kg", "3899900", { category: "CONGELADOS", sortOrder: 1 }),
      product("p2", "Pollo entero x 20 kg", "6599900", { category: "POLLO", sortOrder: 2 }),
      product("p9", "Pata muslo x 15 kg", "4799900", { category: "POLLO", sortOrder: 9 }),
      product("p2b", "Gallina x 20 kg", "6199900", { category: "POLLO", sortOrder: 2 }),
      product("cw", "Suprema congelada por kg", "900000", { category: "CONGELADOS", sortOrder: 0, saleUnit: "WEIGHT" }),
      product("cx", "Milanesas x 5 kg", "3149900", { category: "CONGELADOS", sortOrder: 0, active: false })
    ]), "2026-11-17");
    expect(model.sections.map((section) => [section.title, section.rows.map((row) => row.name)])).toEqual([
      ["POLLO", ["Gallina x 20 kg", "Pollo entero x 20 kg", "Pata muslo x 15 kg", "Pechuga entera x 15 kg"]],
      ["CONGELADOS", ["Patitas rebozadas x 6 kg", "Medallones x 6 kg"]]
    ]);
    expect(rowsOf(model).map((row) => formatListPrice(row.priceCents))).toEqual(["$61.999", "$65.999", "$47.999", "$76.999", "$38.999", "$55.799"]);
    expect(priceListProductCount(model)).toBe(6);
  });

  it("una categoría sin productos activos por cajón no aparece (ni su encabezado)", () => {
    const onlyFrozen = buildPoultryPriceListModel(board([product("c1", "Medallones x 6 kg", "5579900", { category: "CONGELADOS", sortOrder: 1 })]), "2026-11-17");
    expect(onlyFrozen.sections.map((section) => section.title)).toEqual(["CONGELADOS"]);
    const layout = layoutPoultryPriceList(onlyFrozen);
    expect(layout.pillTitle).toBe("CONGELADOS");
    expect(layout.headings).toEqual([]);
    const onlyChicken = buildPoultryPriceListModel(board(REFERENCE), "2026-11-17");
    expect(onlyChicken.sections.map((section) => section.title)).toEqual(["POLLO"]);
    expect(layoutPoultryPriceList(onlyChicken).headings).toEqual([]);
  });

  it("incluye TODOS los productos activos, sin límite de 10 ni paginación", () => {
    const many = Array.from({ length: 37 }, (_, index) => product(`x${String(index)}`, `Producto ${String(index)} x 5 kg`, String(1_000_000 + index),
      { category: index % 3 === 0 ? "CONGELADOS" : "POLLO", sortOrder: 37 - index }));
    const model = buildPoultryPriceListModel(board(many), "2026-11-17");
    expect(priceListProductCount(model)).toBe(37);
    expect(model.sections.map((section) => section.rows.length)).toEqual([24, 13]);
    expect(layoutPoultryPriceList(model).rows).toHaveLength(37);
  });

  it("formatea en pesos sin redondear los centavos registrados", () => {
    expect(formatListPrice(10799900n)).toBe("$107.999");
    expect(formatListPrice(4249950n)).toBe("$42.499,50");
  });

  it("quita sólo los caracteres que la fuente no puede dibujar", () => {
    expect(sanitizeListText("Muslos  rellenos (jamón) ✓\nx 10 u.")).toBe("Muslos rellenos (jamón) x 10 u.");
  });

  it("falla con un mensaje claro si no existe la lista General", () => {
    expect(() => buildPoultryPriceListModel(parsePriceBoard({ lists: [], products: [] }), "2026-11-17")).toThrow(PriceListError);
  });

  it("nombra el archivo con la fecha local de la organización", () => {
    expect(priceListFilename("2026-11-17")).toBe("Carnicerias_Fran_Lista_Pollos_2026-11-17.png");
    // 02:30 UTC del 18 = todavía 17 en Buenos Aires.
    expect(localDate(new Date("2026-11-18T02:30:00Z"), "America/Argentina/Buenos_Aires")).toBe("2026-11-17");
  });
});

/** `rows` productos; los últimos `frozen` van a una segunda sección CONGELADOS. */
function model(rows: number, longEvery = 0, frozen = 0): PoultryPriceListModel {
  const all: PriceListRow[] = Array.from({ length: rows }, (_, index) => ({
    name: longEvery && index % longEvery === 0 ? `Medallones de pollo rellenos con jamón, queso y verduras (premium) x 6 kg n.º ${String(index)}` : `Producto ${String(index)} x 15 kg`,
    priceCents: index % 7 === 3 ? null : BigInt(1_000_000 + index * 123_400)
  }));
  const chicken = all.slice(0, rows - frozen);
  const sections = [
    { category: "POLLO" as const, title: PRICE_LIST_SECTIONS.POLLO, rows: chicken },
    { category: "CONGELADOS" as const, title: PRICE_LIST_SECTIONS.CONGELADOS, rows: all.slice(rows - frozen) }
  ].filter((section) => section.rows.length > 0);
  return { sections, omittedByWeight: 0, missingPrice: 0, date: "2026-11-17" };
}

describe("diagramación de la lista (proporciones de la referencia)", () => {
  it("ancho 1080, franja chica, tabla angosta con fondo visible a ambos lados y pie bajo", () => {
    const layout = layoutPoultryPriceList(model(23));
    expect(layout.width).toBe(PRICE_LIST_WIDTH);
    expect(L.headerHeight / layout.width).toBeLessThan(0.1);
    expect(layout.card.x).toBeGreaterThan(200);
    expect(PRICE_LIST_WIDTH - (layout.card.x + layout.card.width)).toBeGreaterThan(200);
    expect(L.footerHeight / layout.width).toBeLessThan(0.08);
    // Con 23 productos (los de la referencia) el alto es parecido al de la referencia escalada (1009 × 1,08 ≈ 1090).
    expect(layout.height).toBeGreaterThan(980);
    expect(layout.height).toBeLessThan(1180);
  });

  it("los renglones son compactos y no se estiran con pocos productos", () => {
    const few = layoutPoultryPriceList(model(3));
    expect(few.rows.every((row) => row.height === L.rowMinHeight)).toBe(true);
    const many = layoutPoultryPriceList(model(40));
    expect(many.height - few.height).toBe(37 * L.rowMinHeight);
    // La segunda sección sólo suma su encabezado: las filas no cambian de alto.
    const split = layoutPoultryPriceList(model(40, 0, 15));
    expect(split.height - many.height).toBe(L.sectionHeadGap + L.sectionHeadHeight);
    expect(split.rows.every((row) => row.height === L.rowMinHeight)).toBe(true);
  });

  for (const [count, frozen] of [[1, 0], [4, 0], [4, 2], [23, 13], [60, 25], [120, 70]] as const) {
    it(`con ${String(count)} productos (${String(frozen)} congelados, nombres largos) nada se corta ni se superpone`, () => {
      const sample = model(count, 3, frozen);
      const layout = layoutPoultryPriceList(sample);
      expect(layout.rows).toHaveLength(count);
      expect(layout.headings.map((heading) => heading.title)).toEqual(frozen > 0 && frozen < count ? ["CONGELADOS"] : []);
      const blocks = [...layout.rows.map((row) => ({ ...row, heading: false })), ...layout.headings.map((heading) => ({ ...heading, lines: [], price: "", heading: true }))]
        .sort((a, b) => a.y - b.y);
      let previousBottom = layout.subRowY + L.subRowHeight;
      for (const block of blocks) {
        expect(block.y).toBeGreaterThanOrEqual(previousBottom);
        previousBottom = block.y + block.height;
        if (block.heading) continue;
        expect(block.lines.length * L.nameLine).toBeLessThanOrEqual(block.height);
        for (const line of block.lines) expect(listTextWidth(line, L.nameSize, "name")).toBeLessThanOrEqual(layout.nameColumnWidth);
        expect(listTextWidth(block.price, L.priceSize, "price")).toBeLessThanOrEqual(layout.priceColumnWidth);
      }
      // El encabezado CONGELADOS queda justo después de la última fila de POLLO y antes de la primera congelada.
      const heading = layout.headings[0];
      if (heading) {
        expect(heading.y).toBeGreaterThanOrEqual((layout.rows[count - frozen - 1]?.y ?? 0) + (layout.rows[count - frozen - 1]?.height ?? 0));
        expect(heading.y + heading.height).toBeLessThanOrEqual(layout.rows[count - frozen]?.y ?? 0);
      }
      layout.rows.forEach((row, index) => { expect(row.lines.join(" ")).toBe(rowsOf(sample)[index]?.name); });
      expect(layout.card.y + previousBottom).toBeLessThanOrEqual(layout.footerTop);
      expect(layout.footerTop + L.footerHeight).toBe(layout.height);
      expect(layout.nameColumnWidth + L.columnGap + layout.priceColumnWidth).toBe(layout.innerWidth);
    });
  }

  it("un nombre larguísimo usa varios renglones en vez de achicarse o recortarse", () => {
    const layout = layoutPoultryPriceList(model(4, 1));
    expect(layout.rows[0]?.lines.length).toBeGreaterThan(1);
    expect(layout.rows[0]?.height).toBeGreaterThan(L.rowMinHeight);
  });

  it("una palabra sin espacios más ancha que la columna se parte por letras", () => {
    const lines = wrapListText("X".repeat(80), L.nameSize, 200);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("X".repeat(80));
  });

  it("el logo entra en su caja sin deformarse", () => {
    expect(fitLogo(2000, 500)).toEqual({ width: L.logoMaxWidth, height: Math.round(500 * (L.logoMaxWidth / 2000)) });
    expect(fitLogo(600, 600)).toEqual({ width: L.logoMaxHeight, height: L.logoMaxHeight });
  });
});

const isPng = (bytes: Uint8Array) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
const LOGO_PATH = "org/poultry-price-list/logo.png";
const BG_PATH = "org/poultry-price-list/bg.png";

function deps(overrides: Partial<PriceListDeps> = {}): PriceListDeps {
  return {
    getBoard: () => Promise.resolve({ lists: [{ id: GENERAL, name: "General", isDefault: true, active: true }], products: REFERENCE }),
    getSettings: () => Promise.resolve({ logoSource: "CUSTOM", logoUsed: "CUSTOM", logo: { storagePath: LOGO_PATH, contentType: "image/png", widthPx: 40, heightPx: 10 }, background: { storagePath: BG_PATH, contentType: "image/png", widthPx: 30, heightPx: 20 }, options: {} }),
    readImage: (storagePath) => Promise.resolve(storagePath === LOGO_PATH ? pngFixture(40, 10) : storagePath === BG_PATH ? pngFixture(30, 20) : null),
    timeZone: "America/Argentina/Buenos_Aires",
    now: () => new Date("2026-11-17T15:00:00Z"),
    ...overrides
  };
}

describe("PNG de la lista", () => {
  it("dibuja un PNG con el alto calculado", async () => {
    const { png, layout } = await renderPoultryPriceListPng(model(30, 5, 12));
    expect(isPng(png)).toBe(true);
    expect(readImageInfo(png)).toMatchObject({ width: 1080, height: layout.height });
  }, 60_000);

  it("arma la lista desde el tablero con el logo y el fondo configurados", async () => {
    const result = await executePoultryPriceList(deps());
    expect(result.filename).toBe("Carnicerias_Fran_Lista_Pollos_2026-11-17.png");
    expect(result.products).toBe(4);
    expect(result.hasLogo).toBe(true);
    expect(isPng(result.png)).toBe(true);
  }, 60_000);

  it("sin logo configurado igual genera la lista y lo informa (no inventa un logo)", async () => {
    const result = await executePoultryPriceList(deps({ getSettings: () => Promise.resolve({ logo: null, background: null, options: {} }) }));
    expect(result.hasLogo).toBe(false);
  }, 60_000);

  it("si el logo configurado no se puede leer, falla con un mensaje claro en vez de salir sin él", async () => {
    await expect(executePoultryPriceList(deps({ readImage: () => Promise.resolve(null) }))).rejects.toThrow(/logo/);
  });

  it("sólo acepta bytes PNG/JPG reales como imagen", () => {
    expect(imageDataUrl(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(imageDataUrl(pngFixture(12, 8))).toMatchObject({ widthPx: 12, heightPx: 8 });
  });

  it("sin productos activos por cajón no genera una imagen vacía", async () => {
    await expect(executePoultryPriceList(deps({
      getBoard: () => Promise.resolve({ lists: [{ id: GENERAL, name: "General", isDefault: true, active: true }], products: [product("9", "Suprema", "1", { saleUnit: "WEIGHT" })] })
    }))).rejects.toThrow(/por cajón/);
  });

  // Muestras visuales: PRICE_LIST_SAMPLES_DIR=<carpeta> [PRICE_LIST_SAMPLE_LOGO=<png>] [PRICE_LIST_SAMPLE_BG=<jpg>] npx vitest run src/lib/poultry-price-list.test.tsx
  const samplesDir = process.env.PRICE_LIST_SAMPLES_DIR;
  it.skipIf(!samplesDir)("escribe muestras", async () => {
    const dir = samplesDir ?? "";
    mkdirSync(dir, { recursive: true });
    const read = (file: string | undefined) => (file ? imageDataUrl(new Uint8Array(readFileSync(file))) : null);
    const logo = read(process.env.PRICE_LIST_SAMPLE_LOGO);
    const bg = read(process.env.PRICE_LIST_SAMPLE_BG);
    const images = { logo, background: bg ? { src: bg.src } : null };
    const referenceRows: PriceListRow[] = [
        ["Gallina x 20 kg.", 6199900n], ["Pollo entero x 20 kg. (7,8,9,10)", 6599900n], ["Pechuga entera x 15 kg", 7699900n],
        ["Filet de pechuga (PREMIUM) x 15 kg", 10799900n], ["Pata muslo x 15 kg (grandes)", 4799900n], ["Alitas x 15 kg", 4199900n],
        ["Molida x 15kg", 2499900n], ["Molida x 20kg", 3499900n], ["Menudos x 15 kg", 4949900n], ["Chorizos de pollo x 5 kg", 4299900n],
        ["Medallones de pollo con Jyq x 6 Kg", 5579900n], ["Medallones de pollo x 6 kg", 4999900n], ["Patitas rebozadas x 6 kg", 3899900n],
        ["Hamburguesas de pollo x 40un.", 3219900n], ["Hamburguesas de cerdo x40 un.", 4599900n], ["Hambur de Carne x 40un. (50% carne +50% cerdo)", 4599900n],
        ["Muslos rellenos (Jamón, queso y verduras) x 10 u.", 3999900n], ["Milanesas de Cerdo x 5kg", 3249900n], ["Milanesas de pollo x 5kg", 3149900n],
        ["Milanesas vacunas x 5kg", 6299900n], ["Chorizos de Cerdo x 5kg", 3499900n], ["Chorizos parrilleros vacunos x 5kg", 3849900n], ["Chorizos de pollo X 5KG", null]
      ].map(([name, priceCents]) => ({ name: name as string, priceCents: priceCents as bigint | null }));
    // Como la referencia: 10 de POLLO y 13 CONGELADOS.
    const reference: PoultryPriceListModel = {
      sections: [
        { category: "POLLO", title: PRICE_LIST_SECTIONS.POLLO, rows: referenceRows.slice(0, 10) },
        { category: "CONGELADOS", title: PRICE_LIST_SECTIONS.CONGELADOS, rows: referenceRows.slice(10) }
      ],
      omittedByWeight: 0, missingPrice: 1, date: "2026-11-17"
    };
    const frozenOnly: PoultryPriceListModel = { ...reference, sections: [{ category: "CONGELADOS", title: PRICE_LIST_SECTIONS.CONGELADOS, rows: referenceRows.slice(10, 13) }] };
    for (const [name, sample] of [["reference", reference], ["few", model(3)], ["frozen-only", frozenOnly], ["many", model(45, 4, 20)]] as const) {
      writeFileSync(path.join(dir, `${name}.png`), (await renderPoultryPriceListPng(sample, images)).png);
      writeFileSync(path.join(dir, `${name}-plain.png`), (await renderPoultryPriceListPng(sample)).png);
    }
  }, 120_000);
});
