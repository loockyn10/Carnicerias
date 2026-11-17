import { describe, expect, it } from "vitest";

import { buildPriceListImagePath, isValidPriceListImagePath, parsePriceListSettings } from "./poultry-price-list-images";

const ORG = "f2000000-0000-4000-8000-000000000001";
const FILE = "b0000000-0000-4000-8000-000000000001";

describe("imágenes de la lista de precios", () => {
  it("lee la configuración de la RPC", () => {
    const settings = parsePriceListSettings({
      configured: true, logoSource: "BUTCHER", logoUsed: "ARTWORK",
      logo: { storagePath: `${ORG}/branding/x.png`, contentType: "image/png", widthPx: 800, heightPx: 200 },
      background: null,
      options: { ARTWORK: { storagePath: `${ORG}/branding/x.png`, contentType: "image/png", widthPx: 800, heightPx: 200 }, BUTCHER: null, CUSTOM: null }
    });
    expect(settings).toMatchObject({ configured: true, logoSource: "BUTCHER", logoUsed: "ARTWORK", background: null });
    expect(settings.logo?.widthPx).toBe(800);
    expect(settings.options.BUTCHER).toBeNull();
  });

  it("sin datos no inventa un logo", () => {
    expect(parsePriceListSettings(null)).toMatchObject({ logoSource: "ARTWORK", logoUsed: null, logo: null, background: null });
  });

  it("la ruta vive en la carpeta de la lista de ESA organización", () => {
    const path = buildPriceListImagePath(ORG, FILE, "image/jpeg");
    expect(path).toBe(`${ORG}/poultry-price-list/${FILE}.jpg`);
    expect(isValidPriceListImagePath(path, ORG)).toBe(true);
    expect(isValidPriceListImagePath(path, "f2000000-0000-4000-8000-000000000002")).toBe(false);
    expect(isValidPriceListImagePath(`${ORG}/branding/${FILE}.png`, ORG)).toBe(false);
    expect(isValidPriceListImagePath(`${ORG}/poultry-price-list/../${FILE}.png`, ORG)).toBe(false);
  });
});
