import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readImageInfo } from "./image-size";
import { parsePriceBoard, type PoultryPriceBoard } from "./poultry";
import {
  buildPoultryPriceListModel, fitLogo, formatListPrice, L, layoutPoultryPriceList, listTextWidth, localDate, PRICE_LIST_NO_PRICE, PRICE_LIST_WIDTH,
  priceListFilename, PriceListError, sanitizeListText, wrapListText, type PoultryPriceListModel
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

const REFERENCE = [
  product("1", "Pollo entero x 20 kg", "6599900"),
  product("2", "Pechuga entera x 15 kg", "7699900"),
  product("3", "Pata muslo x 15 kg", "4799900"),
  product("4", "Alitas x 15 kg", "4199900")
];

describe("modelo de la lista de precios de Pollos", () => {
  it("usa exclusivamente el precio vigente de la lista General, tal cual está registrado", () => {
    const model = buildPoultryPriceListModel(board(REFERENCE), "2026-11-17");
    expect(model.rows.map((row) => [row.name, row.priceCents])).toEqual([
      ["Alitas x 15 kg", 4199900n], ["Pata muslo x 15 kg", 4799900n], ["Pechuga entera x 15 kg", 7699900n], ["Pollo entero x 20 kg", 6599900n]
    ]);
    expect(model.rows.map((row) => formatListPrice(row.priceCents))).toEqual(["$41.999", "$47.999", "$76.999", "$65.999"]);
  });

  it("incluye todos los activos por cajón y excluye inactivos (quitados) y los productos por kg", () => {
    const model = buildPoultryPriceListModel(board([
      ...REFERENCE,
      product("5", "Menudos x 15 kg", "4949900", { active: false }),
      product("6", "Suprema por kg", "900000", { saleUnit: "WEIGHT", requiresWeight: true })
    ]), "2026-11-17");
    expect(model.rows).toHaveLength(4);
    expect(model.rows.some((row) => row.name.startsWith("Menudos") || row.name.startsWith("Suprema"))).toBe(false);
    expect(model.omittedByWeight).toBe(1);
  });

  it("un producto por cajón sin precio General no se omite: dice «Consultar» y se informa", () => {
    const model = buildPoultryPriceListModel(board([...REFERENCE, product("7", "Molida x 20 kg", null)]), "2026-11-17");
    expect(model.rows).toHaveLength(5);
    expect(model.missingPrice).toBe(1);
    expect(formatListPrice(model.rows.find((row) => row.name.startsWith("Molida"))?.priceCents ?? null)).toBe(PRICE_LIST_NO_PRICE);
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

function model(rows: number, longEvery = 0): PoultryPriceListModel {
  return {
    rows: Array.from({ length: rows }, (_, index) => ({
      name: longEvery && index % longEvery === 0 ? `Medallones de pollo rellenos con jamón, queso y verduras (premium) x 6 kg n.º ${String(index)}` : `Producto ${String(index)} x 15 kg`,
      priceCents: index % 7 === 3 ? null : BigInt(1_000_000 + index * 123_400)
    })),
    omittedByWeight: 0, missingPrice: 0, date: "2026-11-17"
  };
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
  });

  for (const count of [1, 4, 23, 60]) {
    it(`con ${String(count)} productos (y nombres largos) nada se corta ni se superpone`, () => {
      const sample = model(count, 3);
      const layout = layoutPoultryPriceList(sample);
      expect(layout.rows).toHaveLength(count);
      let previousBottom = layout.subRowY + L.subRowHeight;
      for (const row of layout.rows) {
        expect(row.y).toBeGreaterThanOrEqual(previousBottom);
        previousBottom = row.y + row.height;
        expect(row.lines.length * L.nameLine).toBeLessThanOrEqual(row.height);
        for (const line of row.lines) expect(listTextWidth(line, L.nameSize, "name")).toBeLessThanOrEqual(layout.nameColumnWidth);
        expect(listTextWidth(row.price, L.priceSize, "price")).toBeLessThanOrEqual(layout.priceColumnWidth);
      }
      layout.rows.forEach((row, index) => { expect(row.lines.join(" ")).toBe(sample.rows[index]?.name); });
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
    const { png, layout } = await renderPoultryPriceListPng(model(30, 5));
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
    const reference: PoultryPriceListModel = {
      rows: [
        ["Gallina x 20 kg.", 6199900n], ["Pollo entero x 20 kg. (7,8,9,10)", 6599900n], ["Pechuga entera x 15 kg", 7699900n],
        ["Filet de pechuga (PREMIUM) x 15 kg", 10799900n], ["Pata muslo x 15 kg (grandes)", 4799900n], ["Alitas x 15 kg", 4199900n],
        ["Molida x 15kg", 2499900n], ["Molida x 20kg", 3499900n], ["Menudos x 15 kg", 4949900n], ["Chorizos de pollo x 5 kg", 4299900n],
        ["Medallones de pollo con Jyq x 6 Kg", 5579900n], ["Medallones de pollo x 6 kg", 4999900n], ["Patitas rebozadas x 6 kg", 3899900n],
        ["Hamburguesas de pollo x 40un.", 3219900n], ["Hamburguesas de cerdo x40 un.", 4599900n], ["Hambur de Carne x 40un. (50% carne +50% cerdo)", 4599900n],
        ["Muslos rellenos (Jamón, queso y verduras) x 10 u.", 3999900n], ["Milanesas de Cerdo x 5kg", 3249900n], ["Milanesas de pollo x 5kg", 3149900n],
        ["Milanesas vacunas x 5kg", 6299900n], ["Chorizos de Cerdo x 5kg", 3499900n], ["Chorizos parrilleros vacunos x 5kg", 3849900n], ["Chorizos de pollo X 5KG", null]
      ].map(([name, priceCents]) => ({ name: name as string, priceCents: priceCents as bigint | null })),
      omittedByWeight: 0, missingPrice: 1, date: "2026-11-17"
    };
    for (const [name, sample] of [["reference", reference], ["few", model(3)], ["many", model(45, 4)]] as const) {
      writeFileSync(path.join(dir, `${name}.png`), (await renderPoultryPriceListPng(sample, images)).png);
      writeFileSync(path.join(dir, `${name}-plain.png`), (await renderPoultryPriceListPng(sample)).png);
    }
  }, 120_000);
});
