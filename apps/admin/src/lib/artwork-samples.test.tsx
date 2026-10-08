import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildOfferArtworkModel, parseArtworkFacts } from "./artwork";
import { photoToDataUrl, renderArtworkPng } from "./artwork-export";
import { ARTWORK_FORMATS, ARTWORK_FORMAT_ORDER } from "./artwork-tokens";
import { SAMPLE_FACTS, samplePhotoBytes } from "./test-support/artwork-fixtures";

/**
 * Validación visual del sprint (D-074): los cinco casos en los tres formatos. Siempre comprueba que el PNG tenga las dimensiones
 * exactas; con `ARTWORK_SAMPLES_DIR=<carpeta>` además deja los archivos para mirarlos.
 */

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function modelFor(key: keyof typeof SAMPLE_FACTS, headline = "OFERTA") {
  const facts = parseArtworkFacts(SAMPLE_FACTS[key]);
  if (!facts) throw new Error("hechos inválidos");
  let imageUrl: string | null = null;
  if (facts.photo) {
    const bytes = samplePhotoBytes(facts.photo.storagePath);
    if (bytes) imageUrl = photoToDataUrl(facts.photo, bytes);
  }
  const model = buildOfferArtworkModel(facts, { headline, imageUrl });
  if (!model) throw new Error("sin modelo");
  return model;
}

const OUT = process.env.ARTWORK_SAMPLES_DIR;

describe("muestras de la pieza «Producto protagonista»", () => {
  for (const key of Object.keys(SAMPLE_FACTS) as (keyof typeof SAMPLE_FACTS)[]) {
    for (const format of ARTWORK_FORMAT_ORDER) {
      it(`${key} en ${format}`, async () => {
        const model = modelFor(key, key === "mayo" ? "X MAYOR" : "OFERTA");
        const png = await renderArtworkPng(model, format);
        const spec = ARTWORK_FORMATS[format];
        expect(pngSize(png)).toEqual({ width: spec.width, height: spec.height });
        if (OUT) {
          fs.mkdirSync(OUT, { recursive: true });
          fs.writeFileSync(path.join(OUT, `${key}-${format}.png`), png);
        }
      }, 30_000);
    }
  }
});
