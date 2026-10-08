import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { slideToArtworkModel } from "./artwork";
import { renderArtworkPng, resolveArtwork } from "./artwork-export";
import { ARTWORK_FORMATS } from "./artwork-tokens";
import { TV_LAYOUTS } from "./artwork-tv-layouts";
import { readImageInfo } from "./image-size";
import { renderSampleLogo, fixtureDeps } from "./test-support/artwork-deps";
import { BRANCH_ID, COLLAGE_IDS } from "./test-support/artwork-fixtures";
import { slideOffer } from "./test-support/signage-fixtures";

/**
 * Validación visual de la cartelería de TV (D-076): cuatro diapositivas 16:9 con la misma identidad que las piezas y una disposición
 * distinta cada una (la posición rota A, B, C, D). Siempre comprueba el tamaño exacto del PNG; con `ARTWORK_SAMPLES_DIR=<carpeta>`
 * deja los archivos para mirarlos. El logo es de MUESTRA (sintético); el real lo sube el usuario desde «Configurar identidad».
 */

const OUT = process.env.ARTWORK_SAMPLES_DIR;

const SLIDES = [
  { name: "tv-slide-1-bondiola", productId: COLLAGE_IDS.bondiola },
  { name: "tv-slide-2-choricito", productId: COLLAGE_IDS.choricito },
  { name: "tv-slide-3-vacio", productId: COLLAGE_IDS.vacio },
  { name: "tv-slide-4-milanesas-promo", productId: COLLAGE_IDS.milaPollo }
] as const;

describe("diapositivas de TV: muestras 1920 × 1080", () => {
  it("cuatro productos, cuatro disposiciones distintas, PNG del tamaño exacto", async () => {
    const logoBytes = await renderSampleLogo();
    const { deps } = fixtureDeps({ logoBytes });
    const pngs: Uint8Array[] = [];
    for (const [index, slide] of SLIDES.entries()) {
      const { model } = await resolveArtwork(deps, { template: "HERO", productIds: [slide.productId], branchId: BRANCH_ID, headline: "OFERTA" });
      const png = await renderArtworkPng({ ...model, branding: { ...model.branding, contact: null } }, "tv", index);
      const info = readImageInfo(png);
      expect(info && { width: info.width, height: info.height }).toEqual({ width: ARTWORK_FORMATS.tv.width, height: ARTWORK_FORMATS.tv.height });
      pngs.push(png);
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, `${slide.name}.png`), png);
      }
    }
    // Cada diapositiva se dibuja distinto (producto y disposición): no hay dos PNG idénticos.
    expect(new Set(pngs.map((png) => Buffer.from(png).toString("base64"))).size).toBe(SLIDES.length);
    expect(TV_LAYOUTS).toHaveLength(SLIDES.length);
  }, 60_000);

  it("la misma oferta cambia de disposición con la posición (no con el contenido)", async () => {
    const logoBytes = await renderSampleLogo();
    const { deps } = fixtureDeps({ logoBytes });
    const { model } = await resolveArtwork(deps, { template: "HERO", productIds: [COLLAGE_IDS.bondiola], branchId: BRANCH_ID, headline: "OFERTA" });
    const first = Buffer.from(await renderArtworkPng(model, "tv", 0)).toString("base64");
    const second = Buffer.from(await renderArtworkPng(model, "tv", 1)).toString("base64");
    const fifth = Buffer.from(await renderArtworkPng(model, "tv", 4)).toString("base64");
    expect(second).not.toBe(first);
    expect(fifth).toBe(first);
  }, 60_000);

  it("el modelo del televisor y el de Piezas son el mismo tipo de dato", () => {
    const model = slideToArtworkModel({ branding: { businessName: "X", logo: null, contact: { phone: "1", address: null, city: null }, colors: { green: "#0B8A2F", yellow: "#FFD400", red: "#D8201B" } } }, slideOffer("a", "Bondiola", "10.650"));
    expect(model.type).toBe("HERO");
    expect(model.items).toHaveLength(1);
    expect(model.branding.contact).toBeNull();
  });
});
