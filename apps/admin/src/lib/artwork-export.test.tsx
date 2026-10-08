import { describe, expect, it, vi } from "vitest";

import {
  ArtworkExportError, executeArtworkExport, parseArtworkExportRequest, photoToDataUrl, renderArtworkPng, resolveArtwork,
  type ArtworkExportDeps, type ArtworkExportRequest
} from "./artwork-export";
import { ARTWORK_FORMATS } from "./artwork-tokens";
import { BRANCH_ID, PRODUCT_IDS, SAMPLE_FACTS, makeMeatPhoto, sampleJpegBytes, samplePhotoBytes } from "./test-support/artwork-fixtures";

type Key = keyof typeof SAMPLE_FACTS;

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const isPng = (bytes: Uint8Array) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

function depsFor(key: Key, overrides: Partial<ArtworkExportDeps> = {}, factsOverride: Record<string, unknown> = {}) {
  const getFacts = vi.fn(() => Promise.resolve({ ...SAMPLE_FACTS[key], ...factsOverride }));
  const readPhoto = vi.fn((path: string) => {
    const bytes = samplePhotoBytes(path);
    return Promise.resolve(bytes ? { bytes } : null);
  });
  return { deps: { getFacts, readPhoto, ...overrides } satisfies ArtworkExportDeps, getFacts, readPhoto };
}

const request = (key: Key, format: "feed" | "story", headline = "OFERTA"): ArtworkExportRequest => ({
  productId: PRODUCT_IDS[key], branchId: BRANCH_ID, headline, format
});

describe("parseArtworkExportRequest — el navegador sólo manda ids, titular y formato", () => {
  const good = { productId: PRODUCT_IDS.nalga, branchId: BRANCH_ID, headline: "x mayor", format: "feed" };

  it("acepta el pedido válido y normaliza el titular", () => {
    const parsed = parseArtworkExportRequest(good);
    expect(parsed).toEqual({ ok: true, value: { productId: PRODUCT_IDS.nalga, branchId: BRANCH_ID, headline: "X MAYOR", format: "feed" } });
  });

  it("IGNORA cualquier precio, nombre o imagen que mande el cliente (no llegan al pedido resuelto)", () => {
    const parsed = parseArtworkExportRequest({
      ...good, price: 1, priceCents: 100, regularPrice: "$ 1", promotionalPrice: "$ 1", productName: "GRATIS", imageUrl: "https://evil.test/x.png", unitType: "UNIT"
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.keys(parsed.value).sort()).toEqual(["branchId", "format", "headline", "productId"]);
  });

  it("sin sucursal = precio general; sin titular = OFERTA", () => {
    const parsed = parseArtworkExportRequest({ productId: PRODUCT_IDS.nalga, format: "story" });
    expect(parsed).toEqual({ ok: true, value: { productId: PRODUCT_IDS.nalga, branchId: null, headline: "OFERTA", format: "story" } });
  });

  it("rechaza ids inválidos, TV (no exportable en este sprint) y formatos desconocidos", () => {
    expect(parseArtworkExportRequest(null).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, productId: "x" }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, branchId: "x" }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, format: "tv" }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, format: "png" }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, headline: 5 }).ok).toBe(false);
  });
});

describe("executeArtworkExport — dimensiones exactas", () => {
  it("Feed: 1080 × 1350", async () => {
    const { deps } = depsFor("nalga");
    const result = await executeArtworkExport(deps, request("nalga", "feed"));
    expect(isPng(result.png)).toBe(true);
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1350 });
    expect({ width: result.width, height: result.height }).toEqual({ width: 1080, height: 1350 });
    expect(result.filename).toBe("super-ofertas-feed-nalga-vacuna.png");
  }, 30_000);

  it("Story: 1080 × 1920", async () => {
    const { deps } = depsFor("nalga");
    const result = await executeArtworkExport(deps, request("nalga", "story"));
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1920 });
    expect(ARTWORK_FORMATS.story).toMatchObject({ width: 1080, height: 1920 });
  }, 30_000);

  it("es determinista: la misma pieza produce exactamente los mismos bytes", async () => {
    const { deps } = depsFor("mayo");
    const a = await executeArtworkExport(deps, request("mayo", "feed", "X MAYOR"));
    const b = await executeArtworkExport(deps, request("mayo", "feed", "X MAYOR"));
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
  }, 30_000);

  it("el titular cambia la imagen", async () => {
    const { deps } = depsFor("nalga");
    const a = await executeArtworkExport(deps, request("nalga", "feed", "OFERTA"));
    const b = await executeArtworkExport(deps, request("nalga", "feed", "IMPERDIBLE"));
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(false);
    expect(b.snapshot.headline).toBe("IMPERDIBLE");
  }, 30_000);
});

describe("executeArtworkExport — el servidor resuelve los datos económicos", () => {
  it("pide a la base producto + sucursal y toma el precio de ahí (UNIT con promoción)", async () => {
    const { deps, getFacts } = depsFor("mayo");
    const result = await executeArtworkExport(deps, request("mayo", "feed"), () => new Date("2026-10-08T12:00:00Z"));
    expect(getFacts).toHaveBeenCalledWith(PRODUCT_IDS.mayo, BRANCH_ID);
    expect(result.snapshot).toEqual({
      generatedAt: "2026-10-08T12:00:00.000Z", productId: PRODUCT_IDS.mayo, branchId: BRANCH_ID, format: "feed", headline: "OFERTA",
      productName: "MAYONESA HELLMANNS 250GR", heroPriceCents: "174250", regularPriceCents: "205000", promotionalPriceCents: "174250",
      promotionCondition: "LLEVANDO 3 UNIDADES", hasPhoto: true
    });
  }, 30_000);

  it("UNIT sin promoción: sólo el precio vigente (sin condición ni precio promocional)", async () => {
    const { deps } = depsFor("sinFoto");
    const result = await executeArtworkExport(deps, request("sinFoto", "story"));
    expect(result.snapshot).toMatchObject({ heroPriceCents: "245000", regularPriceCents: "245000", promotionalPriceCents: null, promotionCondition: null, hasPhoto: false });
  }, 30_000);

  it("WEIGHT: precio por kilo vigente de la sucursal", async () => {
    const { deps } = depsFor("nalga");
    const result = await executeArtworkExport(deps, request("nalga", "feed"));
    expect(result.snapshot).toMatchObject({ heroPriceCents: "1790000", promotionalPriceCents: null, productName: "NALGA VACUNA" });
  }, 30_000);

  it("un precio enviado por el cliente no llega a la imagen: gana el de la base", async () => {
    const parsed = parseArtworkExportRequest({ productId: PRODUCT_IDS.nalga, branchId: BRANCH_ID, headline: "OFERTA", format: "feed", priceCents: 1, price: "$ 1" });
    if (!parsed.ok) throw new Error("pedido inválido");
    const { deps } = depsFor("nalga");
    const result = await executeArtworkExport(deps, parsed.value);
    expect(result.snapshot.heroPriceCents).toBe("1790000");
  }, 30_000);

  it("sin sucursal pide el precio general", async () => {
    const { deps, getFacts } = depsFor("nalga");
    await executeArtworkExport(deps, { ...request("nalga", "feed"), branchId: null });
    expect(getFacts).toHaveBeenCalledWith(PRODUCT_IDS.nalga, null);
  }, 30_000);
});

describe("executeArtworkExport — foto", () => {
  it("sin foto usa el panel de reemplazo y no pide nada a Storage", async () => {
    const { deps, readPhoto } = depsFor("sinFoto");
    const result = await executeArtworkExport(deps, request("sinFoto", "feed"));
    expect(readPhoto).not.toHaveBeenCalled();
    expect(result.snapshot.hasPhoto).toBe(false);
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1350 });
  }, 30_000);

  it("con foto la lee de Storage por su ruta", async () => {
    const { deps, readPhoto } = depsFor("nalga");
    await executeArtworkExport(deps, request("nalga", "feed"));
    expect(readPhoto).toHaveBeenCalledWith(expect.stringContaining(`${PRODUCT_IDS.nalga}/`));
  }, 30_000);

  it("el objeto no se puede leer => 502 (no se entrega una pieza sin la foto que tiene registrada)", async () => {
    const { deps } = depsFor("nalga", { readPhoto: () => Promise.resolve(null) });
    await expect(executeArtworkExport(deps, request("nalga", "feed"))).rejects.toMatchObject({ name: "ArtworkExportError", status: 502 });
  });

  it("bytes que no son del tipo registrado (p. ej. HTML marcado como PNG) => 422", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const { deps } = depsFor("nalga", { readPhoto: () => Promise.resolve({ bytes: html }) });
    await expect(executeArtworkExport(deps, request("nalga", "feed"))).rejects.toMatchObject({ status: 422 });
  });

  it("photoToDataUrl exige coincidencia entre bytes y tipo, y un peso razonable", () => {
    const png = makeMeatPhoto();
    expect(photoToDataUrl({ storagePath: "a", contentType: "image/png" }, png).startsWith("data:image/png;base64,")).toBe(true);
    expect(() => photoToDataUrl({ storagePath: "a", contentType: "image/jpeg" }, png)).toThrow(ArtworkExportError);
    expect(() => photoToDataUrl({ storagePath: "a", contentType: "image/png" }, new Uint8Array(0))).toThrow(ArtworkExportError);
    expect(() => photoToDataUrl({ storagePath: "a", contentType: "image/png" }, new Uint8Array(6 * 1024 * 1024))).toThrow(ArtworkExportError);
  });

  it("acepta un JPG real (fondo blanco) y lo dibuja", async () => {
    const jpeg = sampleJpegBytes();
    expect(photoToDataUrl({ storagePath: "a", contentType: "image/jpeg" }, jpeg).startsWith("data:image/jpeg;base64,")).toBe(true);
    const { deps } = depsFor("pollo", { readPhoto: () => Promise.resolve({ bytes: jpeg }) }, { photo: { storagePath: `${PRODUCT_IDS.pollo}/x.jpg`, contentType: "image/jpeg", sizeBytes: jpeg.byteLength } });
    const result = await executeArtworkExport(deps, request("pollo", "feed"));
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1350 });
    expect(result.snapshot.hasPhoto).toBe(true);
  }, 30_000);
});

describe("resolveArtwork — productos que no se pueden publicar", () => {
  it("producto inexistente o de otra organización => 404", async () => {
    const { deps } = depsFor("nalga", { getFacts: () => Promise.resolve(null) });
    await expect(resolveArtwork(deps, { productId: PRODUCT_IDS.nalga, branchId: null, headline: "OFERTA" })).rejects.toMatchObject({ status: 404 });
  });

  it.each([["INACTIVE"], ["NOT_IN_BRANCH"], ["NO_PRICE"]])("%s => 422 con un motivo claro (nunca una pieza a $0)", async (reason) => {
    const { deps } = depsFor("nalga", {}, { available: false, unavailableReason: reason });
    await expect(resolveArtwork(deps, { productId: PRODUCT_IDS.nalga, branchId: BRANCH_ID, headline: "OFERTA" })).rejects.toMatchObject({ status: 422 });
  });

  it("precio cero en la base => 422", async () => {
    const { deps } = depsFor("nalga", {}, { listPriceCents: "0" });
    await expect(resolveArtwork(deps, { productId: PRODUCT_IDS.nalga, branchId: BRANCH_ID, headline: "OFERTA" })).rejects.toMatchObject({ status: 422 });
  });
});

describe("renderArtworkPng", () => {
  it("dibuja también el TV (sólo vista previa en el producto): 1920 × 1080", async () => {
    const { deps } = depsFor("nalga");
    const { model } = await resolveArtwork(deps, { productId: PRODUCT_IDS.nalga, branchId: BRANCH_ID, headline: "OFERTA" });
    expect(pngSize(await renderArtworkPng(model, "tv"))).toEqual({ width: 1920, height: 1080 });
  }, 30_000);
});
