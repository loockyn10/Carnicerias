import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildCollageArtworkModel, buildOfferArtworkModel, parseArtworkFacts, type CollageEntry, type OfferArtworkModel } from "./artwork";
import { renderArtworkPng, resolveBranding } from "./artwork-export";
import { HERO_VARIANTS, heroLayout } from "./artwork-hero-layouts";
import { ARTWORK_FORMATS } from "./artwork-tokens";
import { readImageInfo } from "./image-size";
import { renderProductArt, type ProductArtKind } from "./test-support/artwork-art";
import { fixtureDeps, renderSampleLogo } from "./test-support/artwork-deps";

/**
 * Validación visual de las composiciones del «Producto protagonista» (D-086): una matriz de casos (carne, almacén, producto alto, ancho,
 * recorte transparente, fondo blanco, sin foto, nombre largo, precio grande, llevando 3, pack) × Feed/Story × las 4 variantes. Siempre
 * comprueba el tamaño exacto del PNG; con `ARTWORK_SAMPLES_DIR=<carpeta>` deja los archivos para mirarlos y con `ARTWORK_CASES=a,b` limita
 * los casos. Las «fotos» son dibujos de muestra (no hay fotos reales en el repositorio); el logo, de muestra.
 */

const OUT = process.env.ARTWORK_SAMPLES_DIR;
// Sin carpeta de salida sólo se corre un caso (rápido: dibujar en Satori es CPU puro); con ARTWORK_SAMPLES_DIR se dibuja toda la matriz.
const ONLY = process.env.ARTWORK_CASES?.split(",").map((item) => item.trim()).filter(Boolean) ?? (OUT ? undefined : ["milanesas-llevando3"]);
const COLLAGE_COUNTS = OUT ? ([2, 3, 4, 5] as const) : ([3] as const);

const ORG = "c2000000-0000-4000-8000-000000000001";
const BRANCH = "c3000000-0000-4000-8000-000000000001";

interface Case {
  name: string;
  productName: string;
  unitType: "UNIT" | "WEIGHT";
  listPriceCents: number;
  art: ProductArtKind | null;
  background?: "transparent" | "white";
  extra?: Record<string, unknown>;
  headline?: string;
}

const CASES: Case[] = [
  { name: "nalga", productName: "Nalga vacuna", unitType: "WEIGHT", listPriceCents: 1_790_000, art: "bife" },
  { name: "pata-promo-kg", productName: "Pata muslo de pollo", unitType: "WEIGHT", listPriceCents: 1_200_000, art: "pollo", headline: "IMPERDIBLE",
    extra: { weightTiers: [{ id: "t1", minimumGrams: 2000, discountType: "PERCENTAGE", discountValue: "1000" }] } },
  { name: "milanesas-llevando3", productName: "Milanesas de pollo", unitType: "UNIT", listPriceCents: 3_149_900, art: "milanesas", headline: "X MAYOR", extra: { bulkMinimumUnits: 3, bulkDiscountBps: 1_500 } },
  { name: "aceite-alto", productName: "Aceite Cañuelas 900ml", unitType: "UNIT", listPriceCents: 245_000, art: "botella", extra: { bulkMinimumUnits: 3, bulkDiscountBps: 1_000 } },
  { name: "chorizos-ancho", productName: "Chorizos parrilleros", unitType: "WEIGHT", listPriceCents: 899_000, art: "bandeja" },
  { name: "pollo-fondo-blanco", productName: "Pata muslo de pollo", unitType: "WEIGHT", listPriceCents: 399_000, art: "pollo", background: "white" },
  { name: "sin-foto", productName: "Yerba mate Taragüi 1 kg", unitType: "UNIT", listPriceCents: 465_000, art: null },
  { name: "nombre-largo-pack", productName: "Hamburguesa de carne vacuna congelada premium x 12 unidades caja 1,2 kg", unitType: "UNIT", listPriceCents: 1_650_000, art: "pack",
    extra: { packSizeUnits: 10, packDiscountBps: 2_500 } },
  { name: "precio-grande", productName: "Lomo vacuno", unitType: "WEIGHT", listPriceCents: 12_899_900, art: "bife" }
];

function photoRef(productId: string, art: ProductArtKind | null, background: "transparent" | "white") {
  return art ? { storagePath: `${ORG}/${productId}/c6000000-0000-4000-8000-000000000001.png`, contentType: "image/png", sizeBytes: 100_000, hasAlpha: background === "transparent" } : null;
}

async function modelFor(item: Case, index: number): Promise<OfferArtworkModel> {
  const productId = `c5000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`;
  const background = item.background ?? "transparent";
  const facts = parseArtworkFacts({
    slideId: productId, productId, name: item.productName, unitType: item.unitType, available: true, unavailableReason: null,
    listPriceCents: String(item.listPriceCents), bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [], branchId: BRANCH, branchName: "Central",
    photo: photoRef(productId, item.art, background), ...item.extra
  });
  if (!facts) throw new Error("hechos inválidos");
  const bytes = item.art ? await renderProductArt(item.art, background) : null;
  const imageUrl = bytes ? `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` : null;
  const { deps } = fixtureDeps({ logoBytes: await renderSampleLogo() });
  const branding = await resolveBranding(deps, BRANCH);
  const model = buildOfferArtworkModel(facts, { headline: item.headline ?? "OFERTA", imageUrl, branding });
  if (!model) throw new Error("sin modelo");
  return model;
}

/** Collage de 2 a 5 productos con las mismas ilustraciones de muestra (recortes, fondo blanco, alto, ancho, promoción, nombre largo). */
async function collageFor(count: 2 | 3 | 4 | 5): Promise<OfferArtworkModel> {
  const names = ["nalga", "milanesas-llevando3", "aceite-alto", "chorizos-ancho", "nombre-largo-pack"] as const;
  const picked = names.slice(0, count).map((name) => CASES.findIndex((item) => item.name === name));
  const { deps } = fixtureDeps({ logoBytes: await renderSampleLogo() });
  const branding = await resolveBranding(deps, BRANCH);
  const entries: CollageEntry[] = [];
  for (const index of picked) {
    const item = CASES[index];
    if (!item) throw new Error("caso");
    const only = (await modelFor(item, index)).items[0];
    if (!only) throw new Error("sin ítem");
    const { imageUrl, ...base } = only;
    entries.push({ facts: { productId: only.productId, productName: only.productName, available: true, unavailableReason: null, item: base, branch: { name: "Central" }, photo: null, branchId: BRANCH }, imageUrl });
  }
  const built = buildCollageArtworkModel(entries, { headline: "OFERTAS", branding });
  if (!built.ok) throw new Error(built.message);
  return built.model;
}

describe("collage de 2 a 5 productos: muestras", () => {
  for (const count of COLLAGE_COUNTS) {
    for (const format of ["feed", "story"] as const) {
      it(`collage de ${String(count)} en ${format}`, async () => {
        const model = await collageFor(count);
        const png = await renderArtworkPng(model, format);
        const spec = ARTWORK_FORMATS[format];
        expect(readImageInfo(png)).toMatchObject({ width: spec.width, height: spec.height });
        if (OUT) {
          fs.mkdirSync(OUT, { recursive: true });
          fs.writeFileSync(path.join(OUT, `collage-${String(count)}-${format}.png`), png);
        }
      }, 60_000);
    }
  }
});

describe("composiciones del protagonista: muestras", () => {
  for (const [index, item] of CASES.entries()) {
    if (ONLY && !ONLY.includes(item.name)) continue;
    for (const format of ["feed", "story", "tv"] as const) {
      it(`${item.name} en ${format}: las 4 composiciones, PNG del tamaño exacto`, async () => {
        const model = await modelFor(item, index);
        const seen = new Set<string>();
        for (const [position, variant] of HERO_VARIANTS.entries()) {
          // En TV la composición la elige la posición de la diapositiva (A, B, C, D); en Feed y Story, la variante.
          const png = format === "tv" ? await renderArtworkPng(model, format, position) : await renderArtworkPng(model, format, undefined, variant);
          const info = readImageInfo(png);
          const spec = ARTWORK_FORMATS[format];
          expect(info && { width: info.width, height: info.height }).toEqual({ width: spec.width, height: spec.height });
          seen.add(Buffer.from(png).toString("base64"));
          if (OUT) {
            fs.mkdirSync(OUT, { recursive: true });
            fs.writeFileSync(path.join(OUT, `hero-${item.name}-${format}-${format === "tv" ? String(position) : variant}.png`), png);
          }
        }
        expect(seen.size).toBe(HERO_VARIANTS.length);
      }, 60_000);
    }
  }

  it("las variantes no cambian entre generaciones (misma entrada, mismos bytes)", async () => {
    const item = CASES[2];
    if (!item) throw new Error("caso");
    const model = await modelFor(item, 2);
    const first = Buffer.from(await renderArtworkPng(model, "feed", undefined, "PHOTO_LEFT")).toString("base64");
    const second = Buffer.from(await renderArtworkPng(model, "feed", undefined, "PHOTO_LEFT")).toString("base64");
    expect(second).toBe(first);
  }, 60_000);

  it("la geometría de cada variante entra en el lienzo (y Story respeta las zonas seguras)", () => {
    for (const format of ["feed", "story"] as const) {
      for (const variant of HERO_VARIANTS) {
        for (const promo of [true, false]) {
          const layout = heroLayout(format, variant, { promo, mechanic: promo });
          const spec = ARTWORK_FORMATS[format];
          for (const rect of [layout.headline, layout.name, layout.photo, layout.price, layout.contact]) {
            expect(rect.x).toBeGreaterThanOrEqual(0);
            expect(rect.y).toBeGreaterThanOrEqual(0);
            expect(rect.x + rect.w).toBeLessThanOrEqual(spec.width);
            expect(rect.y + rect.h).toBeLessThanOrEqual(spec.height);
          }
        }
      }
    }
  });
});
