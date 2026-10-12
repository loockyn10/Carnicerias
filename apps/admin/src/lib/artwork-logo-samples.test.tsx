import fs from "node:fs";
import path from "node:path";

import { ImageResponse } from "next/og";
import { describe, expect, it } from "vitest";

import { buildOfferArtworkModel, parseArtworkFacts, type OfferArtworkModel } from "./artwork";
import { renderArtworkPng, resolveBranding } from "./artwork-export";
import { ARTWORK_FONT_900_BASE64, ARTWORK_FONT_FAMILY } from "./artwork-font-data";
import { HERO_VARIANTS } from "./artwork-hero-layouts";
import { ARTWORK_FORMATS, type ArtworkFormat } from "./artwork-tokens";
import { readImageInfo } from "./image-size";
import { renderProductArt } from "./test-support/artwork-art";
import { fixtureDeps, renderSampleLogo } from "./test-support/artwork-deps";

/**
 * Validación visual del pulido de identidad (tamaño del logo + tipografía de «OFERTA»). Siempre dibuja un caso y comprueba el tamaño
 * exacto del PNG; con `ARTWORK_SAMPLES_DIR=<carpeta>` deja la matriz de muestras (logo vertical / apaisado / cuadrado × 100-160 % ×
 * Feed / Story / TV y las cuatro composiciones) para mirarlas. El logo es de muestra, no el real del negocio.
 */

const OUT = process.env.ARTWORK_SAMPLES_DIR;
const ORG = "c2000000-0000-4000-8000-000000000001";
const BRANCH = "c3000000-0000-4000-8000-000000000001";
const PRODUCT = "c5000000-0000-4000-8000-000000000201";

function fontBuffer(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

type LogoShape = "vertical" | "apaisado" | "cuadrado";

/** Logos de muestra: «SUPER OFERTAS» apilado (vertical), en una línea (apaisado) y en un sello (cuadrado). */
async function sampleLogo(shape: LogoShape): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  if (shape === "apaisado") {
    const bytes = await renderSampleLogo();
    const info = readImageInfo(bytes);
    return { bytes, width: info?.width ?? 1260, height: info?.height ?? 200 };
  }
  const fonts = [{ name: ARTWORK_FONT_FAMILY, data: fontBuffer(ARTWORK_FONT_900_BASE64), weight: 900 as const, style: "normal" as const }];
  const block = (text: string, color: string, size: number) => <div style={{ display: "flex", fontSize: size, fontWeight: 900, color, lineHeight: 1 }}>{text}</div>;
  const [width, height] = shape === "vertical" ? [440, 760] : [560, 560];
  const response = new ImageResponse(
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width, height, fontFamily: ARTWORK_FONT_FAMILY }}>
      <div style={{ display: "flex", width: 150, height: 150, background: "#D8201B", borderRadius: 30, marginBottom: 28 }} />
      {block("SUPER", "#FFFFFF", shape === "vertical" ? 130 : 150)}
      {block("OFERTAS", "#FFD400", shape === "vertical" ? 96 : 110)}
    </div>,
    { width, height, fonts }
  );
  return { bytes: new Uint8Array(await response.arrayBuffer()), width, height };
}

/** Choricito de cerdo, «DESDE 2 KG», $6.500 el kilo con precio normal debajo: la pieza real de referencia. */
async function choricito(shape: LogoShape, scalePercent: number): Promise<OfferArtworkModel> {
  const facts = parseArtworkFacts({
    slideId: PRODUCT, productId: PRODUCT, name: "Choricito de cerdo", unitType: "WEIGHT", available: true, unavailableReason: null, listPriceCents: "780000",
    bulkMinimumUnits: null, bulkDiscountBps: null, branchId: BRANCH, branchName: "Central",
    weightTiers: [{ id: "t1", minimumGrams: 2000, discountType: "FIXED_PRICE_PER_KG", discountValue: "650000" }],
    photo: { storagePath: `${ORG}/${PRODUCT}/c6000000-0000-4000-8000-000000000001.png`, contentType: "image/png", sizeBytes: 100_000, hasAlpha: true }
  });
  if (!facts) throw new Error("hechos inválidos");
  const art = await renderProductArt("bandeja", "transparent");
  const logo = await sampleLogo(shape);
  const { deps } = fixtureDeps({ logoBytes: logo.bytes });
  const resolved = await resolveBranding(deps, BRANCH);
  const branding = resolved.logo ? { ...resolved, logo: { ...resolved.logo, width: logo.width, height: logo.height, scalePercent } } : resolved;
  const model = buildOfferArtworkModel(facts, { headline: "OFERTA", imageUrl: `data:image/png;base64,${Buffer.from(art).toString("base64")}`, branding });
  if (!model) throw new Error("sin modelo");
  return model;
}

async function save(name: string, model: OfferArtworkModel, format: ArtworkFormat, slideIndex?: number, variant?: (typeof HERO_VARIANTS)[number] | null) {
  const png = await renderArtworkPng(model, format, slideIndex, variant);
  const info = readImageInfo(png);
  expect(info).toMatchObject({ width: ARTWORK_FORMATS[format].width, height: ARTWORK_FORMATS[format].height });
  if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), png); }
}

describe("muestras de identidad: tamaño del logo y «OFERTA»", () => {
  it("Feed, Story y TV al 100 % con el logo vertical (siempre)", async () => {
    const model = await choricito("vertical", 100);
    for (const format of ["feed", "story", "tv"] as const) await save(`logo-vertical-${format}-100.png`, model, format);
  }, 60_000);

  it.runIf(OUT !== undefined)("matriz: forma del logo × 100/120/140/160 × formatos, y las cuatro composiciones", async () => {
    for (const shape of ["vertical", "apaisado", "cuadrado"] as const) {
      for (const scale of [100, 120, 140, 160]) {
        const model = await choricito(shape, scale);
        for (const format of ["feed", "story", "tv"] as const) await save(`logo-${shape}-${format}-${String(scale)}.png`, model, format);
      }
    }
    const model = await choricito("vertical", 120);
    for (const variant of HERO_VARIANTS) {
      await save(`oferta-feed-${variant.toLowerCase()}.png`, model, "feed", undefined, variant);
      await save(`oferta-story-${variant.toLowerCase()}.png`, model, "story", undefined, variant);
    }
    for (const index of [0, 1, 2, 3]) await save(`oferta-tv-${String(index)}.png`, model, "tv", index);
  }, 600_000);
});
