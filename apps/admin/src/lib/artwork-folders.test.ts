import { describe, expect, it } from "vitest";

import {
  assignFilenames, dateStamp, endsSoon, expiryText, folderFormatsLabel, folderItemsLabel, isGeneratable, parseFolderFacts, parseFolders, reviewFolder,
  sanitizeFolderName, slugify, zipEntryPath, zipFilename
} from "./artwork-folders";
import { must } from "./test-support/must";
import { FOLDER_ID, itemId, packPromotion, promotionId, rawFolderFacts, rawItem, thresholdPromotion, weekendFolder } from "./test-support/folder-fixtures";

const NOW = new Date("2026-10-11T15:00:00Z");

describe("parseFolders: carpetas guardadas (sólo referencias)", () => {
  const raw = [
    {
      id: FOLDER_ID, name: "Ofertas finde", generateFeed: true, generateStory: false, usedByDisplays: 2,
      items: [
        { itemId: itemId(1), kind: "PROMOTION", id: promotionId(1), name: "Pata muslo", sku: "P1", unitType: "WEIGHT" },
        { itemId: itemId(2), kind: "PRODUCT", id: "c5000000-0000-4000-8000-000000000002", name: "Nalga", sku: null, unitType: "WEIGHT" },
        { kind: "PROMOTION" }
      ]
    },
    { id: "sin-nombre" },
    "basura"
  ];

  it("lee nombre, formatos, elementos en orden y en cuántas pantallas se usa; descarta lo roto", () => {
    const folders = parseFolders(raw);
    expect(folders).toHaveLength(1);
    const folder = must(folders[0]);
    expect(folder).toMatchObject({ name: "Ofertas finde", generateFeed: true, generateStory: false, usedByDisplays: 2 });
    expect(folder.items.map((item) => `${item.kind}:${item.name ?? ""}`)).toEqual(["PROMOTION:Pata muslo", "PRODUCT:Nalga"]);
  });

  it("no hay ningún precio, descuento ni foto en lo que se lee: sólo referencias", () => {
    const text = JSON.stringify(parseFolders(raw));
    expect(text).not.toMatch(/price|cents|discount|photo|storage/i);
  });

  it("textos de la tarjeta: «Feed + Story» y «8 elementos»", () => {
    expect(folderFormatsLabel({ generateFeed: true, generateStory: true })).toBe("Feed + Story");
    expect(folderFormatsLabel({ generateFeed: true, generateStory: false })).toBe("Feed");
    expect(folderFormatsLabel({ generateFeed: false, generateStory: true })).toBe("Story");
    expect(folderItemsLabel(1)).toBe("1 elemento");
    expect(folderItemsLabel(8)).toBe("8 elementos");
  });

  it("algo que no es una lista no rompe", () => {
    expect(parseFolders(null)).toEqual([]);
    expect(parseFolders({})).toEqual([]);
  });
});

describe("parseFolderFacts: lo VIGENTE de cada elemento", () => {
  const facts = must(parseFolderFacts(weekendFolder(NOW), NOW));
  const by = (name: string) => must(facts.items.find((item) => item.name === name));

  it("lee la carpeta, la sucursal y los siete elementos en orden", () => {
    expect(facts).toMatchObject({ name: "Ofertas finde", branchName: "Central", generateFeed: true, generateStory: true });
    expect(facts.items.map((item) => item.name)).toEqual(["Pata muslo", "Costilla de cerdo", "Coca Cola", "Matambre", "Chorizo vencido", "Bife desactivado", "Nalga vacuna"]);
  });

  it("arma la oferta de hoy con el MOTOR de pricing (nunca un precio escrito a mano)", () => {
    expect(by("Pata muslo").summary).toBe("$ 9.000 / kg · desde 2 kg");
    expect(by("Costilla de cerdo").summary).toBe("$ 14.000 · por 2 kg");
    expect(by("Coca Cola").summary).toBe("$ 5.400 · pack 3 unidades");
    expect(by("Matambre").summary).toBe("$ 11.000 / kg · desde 1 kg");
    expect(by("Nalga vacuna").summary).toBe("$ 17.900 / kg");
    expect(by("Pata muslo").offer?.mechanic).toBe("DESDE 2 KG");
    expect(by("Pata muslo").offer?.savings).toBe("10% OFF");
  });

  it("un producto sin promoción se anuncia con su precio vigente (nunca con una promoción inventada)", () => {
    const nalga = by("Nalga vacuna");
    expect(nalga.kind).toBe("PRODUCT");
    expect(nalga.offer?.promo).toBe(false);
    expect(nalga.offer?.mechanic).toBeNull();
  });

  it("estados: vigente, vencida, inactiva", () => {
    expect(facts.items.map((item) => item.state)).toEqual(["READY", "READY", "READY", "READY", "EXPIRED", "INACTIVE", "READY"]);
    expect(by("Chorizo vencido").offer).toBeNull();
    expect(by("Bife desactivado").summary).toBeNull();
    expect(isGeneratable(by("Pata muslo"))).toBe(true);
    expect(isGeneratable(by("Chorizo vencido"))).toBe(false);
    expect(isGeneratable(by("Bife desactivado"))).toBe(false);
  });

  it("los demás motivos: otra sucursal, sin precio, todavía no empezó, producto inactivo", () => {
    const state = (reason: string, extra: Record<string, unknown> = {}) => must(parseFolderFacts(rawFolderFacts([rawItem({ n: 1, name: "X", reason, ...extra })]), NOW)).items[0]?.state;
    expect(state("NOT_IN_BRANCH")).toBe("NOT_IN_BRANCH");
    expect(state("NO_PRICE")).toBe("NO_PRICE");
    expect(state("INACTIVE")).toBe("INACTIVE");
    expect(state("PROMO_UPCOMING", { promotion: thresholdPromotion(1, { status: "UPCOMING" }) })).toBe("UPCOMING");
  });

  it("una oferta vigente cuyo precio el motor no puede armar se trata como sin precio (nunca $0)", () => {
    const item = must(must(parseFolderFacts(rawFolderFacts([rawItem({ n: 1, name: "X", listPriceCents: 0 })]), NOW)).items[0]);
    expect(item.state).toBe("NO_PRICE");
    expect(item.offer).toBeNull();
  });

  it("fotos: la que no tiene se marca (se genera igual con el reemplazo)", () => {
    expect(by("Pata muslo").hasPhoto).toBe(true);
    expect(by("Matambre").hasPhoto).toBe(false);
    expect(by("Pata muslo").photo?.hasAlpha).toBe(true);
  });

  it("vence hoy o mañana: avisa antes de generar", () => {
    expect(by("Costilla de cerdo").expiresSoon).toBe(true);
    expect(by("Pata muslo").expiresSoon).toBe(false);
    expect(by("Chorizo vencido").expiresSoon).toBe(false);
    expect(endsSoon("2026-10-12T02:00:00Z", NOW)).toBe(true);
    expect(endsSoon("2026-10-20T02:00:00Z", NOW)).toBe(false);
    expect(endsSoon("2026-10-10T02:00:00Z", NOW)).toBe(false);
    expect(endsSoon(null, NOW)).toBe(false);
    expect(endsSoon("no-es-fecha", NOW)).toBe(false);
  });

  it("los hechos de un servidor que no devuelve una carpeta se leen como «no existe»", () => {
    expect(parseFolderFacts(null)).toBeNull();
    expect(parseFolderFacts({ items: [] })).toBeNull();
  });
});

describe("reviewFolder: ✓ y ⚠ antes de generar", () => {
  it("cuenta lo que se genera, lo que no y lo que hay que mirar", () => {
    const review = reviewFolder(must(parseFolderFacts(weekendFolder(NOW), NOW)));
    expect(review).toMatchObject({ total: 7, ready: 5, withoutPhoto: 1, expiringSoon: 1 });
    expect(review.skipped).toMatchObject({ EXPIRED: 1, INACTIVE: 1, UPCOMING: 0, NOT_IN_BRANCH: 0, NO_PRICE: 0 });
    const texts = review.lines.map((line) => line.text);
    expect(texts).toContain("Precios vigentes");
    expect(texts.some((text) => text.includes("1 producto sin foto"))).toBe(true);
    expect(texts.some((text) => text.includes("1 promoción vence hoy o mañana"))).toBe(true);
    expect(texts.some((text) => text.includes("1 promoción vencida"))).toBe(true);
    expect(texts.some((text) => text.includes("1 elemento inactivo"))).toBe(true);
    expect(review.lines.find((line) => line.text === "Fotos completas")).toBeUndefined();
  });

  it("con todo en orden dice «Fotos completas» y «Precios vigentes» y nada más", () => {
    const review = reviewFolder(must(parseFolderFacts(rawFolderFacts([rawItem({ n: 1, name: "A" }), rawItem({ n: 2, name: "B" })]), NOW)));
    expect(review.lines).toEqual([{ tone: "ok", text: "Fotos completas" }, { tone: "ok", text: "Precios vigentes" }]);
  });

  it("sin nada vigente no hay líneas verdes", () => {
    const review = reviewFolder(must(parseFolderFacts(rawFolderFacts([rawItem({ n: 1, name: "A", reason: "NO_PRICE" })]), NOW)));
    expect(review.ready).toBe(0);
    expect(review.lines.every((line) => line.tone === "warn")).toBe(true);
  });
});

describe("nombres de archivo y de carpeta", () => {
  it("slugify: minúsculas, sin acentos ni símbolos, nunca vacío", () => {
    expect(slugify("Pata Muslo")).toBe("pata-muslo");
    expect(slugify("Milanesas de Pollo ¡Súper! 1,2 kg")).toBe("milanesas-de-pollo-super-1-2-kg");
    expect(slugify("   ")).toBe("pieza");
    expect(slugify("???")).toBe("pieza");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(60);
  });

  it("sanitizeFolderName: conserva mayúsculas y espacios, saca lo que Windows y el ZIP no admiten", () => {
    expect(sanitizeFolderName("Ofertas finde")).toBe("Ofertas finde");
    expect(sanitizeFolderName("Carne/Pollo: ¿hoy?")).toBe("Carne Pollo ¿hoy");
    expect(sanitizeFolderName("..oculta..")).toBe("oculta");
    expect(sanitizeFolderName("***")).toBe("Carpeta");
  });

  it("dateStamp: día-mes-año con ceros", () => {
    expect(dateStamp(new Date(2026, 9, 11))).toBe("11-10-2026");
    expect(dateStamp(new Date(2026, 0, 5))).toBe("05-01-2026");
  });

  it("assignFilenames: nombres únicos dentro de un formato (dos «pata muslo» no se pisan)", () => {
    const names = assignFilenames([{ itemId: "a", name: "Pata muslo" }, { itemId: "b", name: "Costilla" }, { itemId: "c", name: "Pata Muslo" }]);
    expect([...names.values()]).toEqual(["pata-muslo.png", "costilla.png", "pata-muslo-2.png"]);
  });

  it("la ruta del ZIP: «Ofertas finde - 11-10-2026/Feed/pata-muslo.png»", () => {
    const date = new Date(2026, 9, 11);
    expect(zipEntryPath("Ofertas finde", date, "feed", "pata-muslo.png")).toBe("Ofertas finde - 11-10-2026/Feed/pata-muslo.png");
    expect(zipEntryPath("Ofertas finde", date, "story", "costilla.png")).toBe("Ofertas finde - 11-10-2026/Story/costilla.png");
    expect(zipFilename("Ofertas finde", date)).toBe("Ofertas finde - 11-10-2026.zip");
  });

  it("expiryText: hoy, mañana o la fecha", () => {
    const now = new Date(2026, 9, 11, 10, 0, 0);
    expect(expiryText(new Date(2026, 9, 11, 23, 0, 0).toISOString(), now)).toBe("Vence hoy");
    expect(expiryText(new Date(2026, 9, 12, 9, 0, 0).toISOString(), now)).toBe("Vence mañana");
    expect(expiryText(new Date(2026, 9, 20, 9, 0, 0).toISOString(), now)).toBe("Vence el 20/10/2026");
  });
});

describe("pack con precio total y umbral: mismas reglas del motor en la carpeta", () => {
  it("el cambio de precio de una promoción se refleja al volver a leer (nada queda copiado en la carpeta)", () => {
    const read = (price: string) => must(must(parseFolderFacts(rawFolderFacts([rawItem({ n: 1, name: "Pata muslo", promotion: packPromotion(1, { packPriceCents: price }) })]), NOW)).items[0]).summary;
    expect(read("1400000")).toBe("$ 14.000 · por 2 kg");
    expect(read("1500000")).toBe("$ 15.000 · por 2 kg");
  });
});
