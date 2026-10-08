import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renderArtworkPng, resolveArtwork } from "./artwork-export";
import { ARTWORK_FORMATS, ARTWORK_FORMAT_ORDER, type ArtworkFormat, type ArtworkTemplate } from "./artwork-tokens";
import { readImageInfo } from "./image-size";
import { renderSampleLogo, fixtureDeps } from "./test-support/artwork-deps";
import { BRANCH_ID, COLLAGE_IDS, MILANESA_SET, POLLO_SET, PRODUCT_IDS } from "./test-support/artwork-fixtures";

/**
 * Validación visual del sprint (D-074 / D-075): las piezas de muestra en todos los formatos. Siempre comprueba que el PNG tenga las
 * dimensiones exactas; con `ARTWORK_SAMPLES_DIR=<carpeta>` además deja los archivos para mirarlos. Usa un logo de MUESTRA
 * (sintético): el real lo sube el usuario desde «Configurar identidad».
 */

const OUT = process.env.ARTWORK_SAMPLES_DIR;

interface Sample {
  name: string;
  template: ArtworkTemplate;
  productIds: string[];
  headline: string;
  formats: readonly ArtworkFormat[];
}

const pollo = POLLO_SET.map((key) => COLLAGE_IDS[key]);
const milanesas = MILANESA_SET.map((key) => COLLAGE_IDS[key]);

const SAMPLES: Sample[] = [
  // A) Nalga vacuna: protagonista (por peso, PNG transparente)
  { name: "A-nalga-hero", template: "HERO", productIds: [PRODUCT_IDS.nalga], headline: "OFERTA", formats: ARTWORK_FORMAT_ORDER },
  { name: "A2-mayo-hero-promo", template: "HERO", productIds: [PRODUCT_IDS.mayo], headline: "X MAYOR", formats: ["feed", "story"] },
  { name: "A3-sinfoto-hero", template: "HERO", productIds: [PRODUCT_IDS.sinFoto], headline: "OFERTA", formats: ["feed", "story"] },
  { name: "A4-largo-hero", template: "HERO", productIds: [PRODUCT_IDS.largo], headline: "IMPERDIBLE", formats: ["feed", "story"] },
  // B) 5 productos de pollo
  { name: "B-pollo-5", template: "COLLAGE", productIds: pollo, headline: "OFERTAS DE POLLO", formats: ["feed", "story"] },
  // C) 3 cajas de milanesas «X MAYOR» (una con promoción «llevando 3»)
  { name: "C-milanesas-3", template: "COLLAGE", productIds: milanesas, headline: "X MAYOR", formats: ["feed", "story"] },
  // 2 y 4 productos, mezclando por peso y por unidad
  { name: "E-2-productos", template: "COLLAGE", productIds: [PRODUCT_IDS.nalga, COLLAGE_IDS.pataMuslo], headline: "OFERTAS", formats: ["feed", "story"] },
  { name: "F-4-productos", template: "COLLAGE", productIds: [COLLAGE_IDS.milaCerdo, COLLAGE_IDS.milaVacuna, PRODUCT_IDS.nalga, PRODUCT_IDS.largo], headline: "IMPERDIBLE", formats: ["feed", "story"] },
  // Un producto sin foto dentro de un collage + nombre largo
  { name: "G-5-sin-foto-y-largo", template: "COLLAGE", productIds: [COLLAGE_IDS.pataMuslo, PRODUCT_IDS.sinFoto, PRODUCT_IDS.largo, COLLAGE_IDS.filet, COLLAGE_IDS.polloEntero], headline: "OFERTAS", formats: ["feed", "story"] }
];

function pngSize(png: Uint8Array): { width: number; height: number } {
  const info = readImageInfo(png);
  if (!info) throw new Error("PNG inválido");
  return { width: info.width, height: info.height };
}

describe("muestras de las piezas (protagonista y collage)", () => {
  for (const sample of SAMPLES) {
    for (const format of sample.formats) {
      it(`${sample.name} en ${format}`, async () => {
        const logoBytes = await renderSampleLogo();
        const { deps } = fixtureDeps({ logoBytes, factsOverrides: { [PRODUCT_IDS.sinFoto]: {} } });
        const { model } = await resolveArtwork(deps, { template: sample.template, productIds: sample.productIds, branchId: BRANCH_ID, headline: sample.headline });
        const png = await renderArtworkPng(model, format);
        const spec = ARTWORK_FORMATS[format];
        expect(pngSize(png)).toEqual({ width: spec.width, height: spec.height });
        if (OUT) {
          fs.mkdirSync(OUT, { recursive: true });
          fs.writeFileSync(path.join(OUT, `${sample.name}-${format}.png`), png);
        }
      }, 30_000);
    }
  }
});
