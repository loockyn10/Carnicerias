import { describe, expect, it } from "vitest";

import {
  ArtworkExportError, executeArtworkExport, parseArtworkExportRequest, photoToDataUrl, renderArtworkPng, resolveArtwork, resolveBranding,
  type ArtworkExportRequest
} from "./artwork-export";
import { ARTWORK_FORMATS } from "./artwork-tokens";
import { readImageInfo } from "./image-size";
import { fixtureDeps } from "./test-support/artwork-deps";
import {
  BRANCH_AVENIDA_ID, BRANCH_ID, COLLAGE_IDS, LOGO_PATH, MILANESA_SET, POLLO_SET, PRODUCT_IDS, makeMeatPhoto, sampleJpegBytes
} from "./test-support/artwork-fixtures";

type Key = keyof typeof PRODUCT_IDS;

function pngSize(png: Uint8Array): { width: number; height: number } {
  const info = readImageInfo(png);
  if (!info) throw new Error("PNG inválido");
  return { width: info.width, height: info.height };
}

const isPng = (bytes: Uint8Array) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

const hero = (key: Key, format: "feed" | "story", headline = "OFERTA"): ArtworkExportRequest => ({
  template: "HERO", productIds: [PRODUCT_IDS[key]], branchId: BRANCH_ID, headline, format
});

const collage = (ids: readonly string[], format: "feed" | "story", headline = "OFERTAS"): ArtworkExportRequest => ({
  template: "COLLAGE", productIds: [...ids], branchId: BRANCH_ID, headline, format
});

const polloIds = POLLO_SET.map((key) => COLLAGE_IDS[key]);
const milanesaIds = MILANESA_SET.map((key) => COLLAGE_IDS[key]);

describe("parseArtworkExportRequest — el navegador sólo manda ids, plantilla, titular y formato", () => {
  const good = { productId: PRODUCT_IDS.nalga, branchId: BRANCH_ID, headline: "x mayor", format: "feed" };

  it("protagonista (compatible con el pedido anterior): acepta productId y normaliza el titular", () => {
    expect(parseArtworkExportRequest(good)).toEqual({
      ok: true, value: { template: "HERO", productIds: [PRODUCT_IDS.nalga], branchId: BRANCH_ID, headline: "X MAYOR", format: "feed" }
    });
    expect(parseArtworkExportRequest({ ...good, template: "HERO", productId: undefined, productIds: [PRODUCT_IDS.nalga] })).toMatchObject({ ok: true });
  });

  it("collage: de 2 a 5 productos, en el orden dado", () => {
    for (const n of [2, 3, 4, 5]) {
      const parsed = parseArtworkExportRequest({ template: "COLLAGE", productIds: polloIds.slice(0, n), branchId: BRANCH_ID, headline: "ofertas de pollo", format: "story" });
      expect(parsed).toEqual({ ok: true, value: { template: "COLLAGE", productIds: polloIds.slice(0, n), branchId: BRANCH_ID, headline: "OFERTAS DE POLLO", format: "story" } });
    }
  });

  it("collage: 1 producto, 6 productos, repetidos o ids inválidos se rechazan", () => {
    const base = { template: "COLLAGE", branchId: BRANCH_ID, headline: "OFERTAS", format: "feed" };
    expect(parseArtworkExportRequest({ ...base, productIds: polloIds.slice(0, 1) }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...base, productIds: [...polloIds, COLLAGE_IDS.milaCerdo] }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...base, productIds: [polloIds[0], polloIds[0]] }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...base, productIds: [polloIds[0], "x"] }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...base }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...base, productIds: "x" }).ok).toBe(false);
  });

  it("el protagonista lleva un solo producto", () => {
    expect(parseArtworkExportRequest({ template: "HERO", productIds: polloIds.slice(0, 2), branchId: null, format: "feed" }).ok).toBe(false);
    expect(parseArtworkExportRequest({ template: "HERO", branchId: null, format: "feed" }).ok).toBe(false);
  });

  it("IGNORA cualquier precio, nombre, imagen, logo o contacto que mande el cliente (no llegan al pedido resuelto)", () => {
    const parsed = parseArtworkExportRequest({
      ...good, price: 1, priceCents: 100, regularPrice: "$ 1", promotionalPrice: "$ 1", productName: "GRATIS", imageUrl: "https://evil.test/x.png", unitType: "UNIT",
      logo: "https://evil.test/logo.png", logoUrl: "data:image/png;base64,AAAA", phone: "0800-EVIL", address: "Calle Falsa 123", city: "Springfield", contact: { phone: "1" },
      items: [{ productName: "GRATIS", price: 1 }]
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.keys(parsed.value).sort()).toEqual(["branchId", "format", "headline", "productIds", "template"]);
  });

  it("sin sucursal = precio general; sin titular = OFERTA (protagonista) / OFERTAS (collage)", () => {
    expect(parseArtworkExportRequest({ productId: PRODUCT_IDS.nalga, format: "story" })).toEqual({
      ok: true, value: { template: "HERO", productIds: [PRODUCT_IDS.nalga], branchId: null, headline: "OFERTA", format: "story" }
    });
    expect(parseArtworkExportRequest({ template: "COLLAGE", productIds: polloIds.slice(0, 2), format: "feed" })).toMatchObject({ ok: true, value: { headline: "OFERTAS", branchId: null } });
  });

  it("rechaza plantillas, ids inválidos, TV (no exportable) y formatos desconocidos", () => {
    expect(parseArtworkExportRequest(null).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, template: "GRID" }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, productId: "x" }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, branchId: "x" }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, format: "tv" }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, format: "png" }).ok).toBe(false);
    expect(parseArtworkExportRequest({ ...good, headline: 5 }).ok).toBe(false);
  });
});

describe("executeArtworkExport — dimensiones exactas", () => {
  it("Feed protagonista: 1080 × 1350", async () => {
    const { deps } = fixtureDeps();
    const result = await executeArtworkExport(deps, hero("nalga", "feed"));
    expect(isPng(result.png)).toBe(true);
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1350 });
    expect({ width: result.width, height: result.height }).toEqual({ width: 1080, height: 1350 });
    expect(result.filename).toBe("super-ofertas-feed-nalga-vacuna.png");
  }, 30_000);

  it("Story protagonista: 1080 × 1920", async () => {
    const { deps } = fixtureDeps();
    const result = await executeArtworkExport(deps, hero("nalga", "story"));
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1920 });
    expect(ARTWORK_FORMATS.story).toMatchObject({ width: 1080, height: 1920 });
  }, 30_000);

  it.each([2, 3, 4, 5])("Feed collage de %s productos: 1080 × 1350", async (n) => {
    const { deps } = fixtureDeps();
    const result = await executeArtworkExport(deps, collage(polloIds.slice(0, n), "feed", "OFERTAS DE POLLO"));
    expect(isPng(result.png)).toBe(true);
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1350 });
    expect(result.filename).toBe("super-ofertas-collage-feed-ofertas-de-pollo.png");
  }, 30_000);

  it.each([2, 3, 4, 5])("Story collage de %s productos: 1080 × 1920", async (n) => {
    const { deps } = fixtureDeps();
    const result = await executeArtworkExport(deps, collage(polloIds.slice(0, n), "story"));
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1920 });
    expect(result.snapshot.items).toHaveLength(n);
  }, 30_000);

  it("es determinista: la misma pieza produce exactamente los mismos bytes (protagonista y collage)", async () => {
    const { deps } = fixtureDeps();
    const a = await executeArtworkExport(deps, hero("mayo", "feed", "X MAYOR"));
    const b = await executeArtworkExport(deps, hero("mayo", "feed", "X MAYOR"));
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    const c = await executeArtworkExport(deps, collage(milanesaIds, "feed", "X MAYOR"));
    const d = await executeArtworkExport(deps, collage(milanesaIds, "feed", "X MAYOR"));
    expect(Buffer.from(c.png).equals(Buffer.from(d.png))).toBe(true);
  }, 30_000);

  it("el titular y el orden de los productos cambian la imagen", async () => {
    const { deps } = fixtureDeps();
    const a = await executeArtworkExport(deps, hero("nalga", "feed", "OFERTA"));
    const b = await executeArtworkExport(deps, hero("nalga", "feed", "IMPERDIBLE"));
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(false);
    expect(b.snapshot.headline).toBe("IMPERDIBLE");
    const c = await executeArtworkExport(deps, collage(polloIds.slice(0, 3), "feed"));
    const d = await executeArtworkExport(deps, collage([...polloIds.slice(0, 3)].reverse(), "feed"));
    expect(Buffer.from(c.png).equals(Buffer.from(d.png))).toBe(false);
  }, 30_000);
});

describe("executeArtworkExport — el servidor resuelve los datos económicos", () => {
  it("pide a la base producto + sucursal y toma el precio de ahí (UNIT con promoción)", async () => {
    const { deps, getFacts } = fixtureDeps();
    const result = await executeArtworkExport(deps, hero("mayo", "feed"), () => new Date("2026-10-08T12:00:00Z"));
    expect(getFacts).toHaveBeenCalledWith(PRODUCT_IDS.mayo, BRANCH_ID);
    expect(result.snapshot).toEqual({
      generatedAt: "2026-10-08T12:00:00.000Z", template: "HERO", branchId: BRANCH_ID, format: "feed", headline: "OFERTA",
      items: [{
        productId: PRODUCT_IDS.mayo, productName: "MAYONESA HELLMANNS 250GR", heroPriceCents: "174250", regularPriceCents: "205000",
        promotionalPriceCents: "174250", promotionCondition: "LLEVANDO 3 UNIDADES", hasPhoto: true
      }],
      hasLogo: true,
      contact: { phone: "3496-448808", address: "GÜEMES 2180", city: "ESPERANZA, SANTA FE" }
    });
  }, 30_000);

  it("UNIT sin promoción: sólo el precio vigente (sin condición ni precio promocional)", async () => {
    const { deps } = fixtureDeps();
    const result = await executeArtworkExport(deps, hero("sinFoto", "story"));
    expect(result.snapshot.items[0]).toMatchObject({ heroPriceCents: "245000", regularPriceCents: "245000", promotionalPriceCents: null, promotionCondition: null, hasPhoto: false });
  }, 30_000);

  it("WEIGHT: precio por kilo vigente de la sucursal", async () => {
    const { deps } = fixtureDeps();
    const result = await executeArtworkExport(deps, hero("nalga", "feed"));
    expect(result.snapshot.items[0]).toMatchObject({ heroPriceCents: "1790000", promotionalPriceCents: null, productName: "NALGA VACUNA" });
  }, 30_000);

  it("collage: cada producto se resuelve contra la base (precio, promoción, WEIGHT y UNIT) en el orden pedido", async () => {
    const { deps, getFacts } = fixtureDeps();
    const ids = [COLLAGE_IDS.milaPollo, PRODUCT_IDS.nalga, COLLAGE_IDS.milaCerdo];
    const result = await executeArtworkExport(deps, collage(ids, "feed", "X MAYOR"));
    expect(getFacts.mock.calls.map((call) => call[0])).toEqual(ids);
    for (const call of getFacts.mock.calls) expect(call[1]).toBe(BRANCH_ID);
    expect(result.snapshot.template).toBe("COLLAGE");
    expect(result.snapshot.items.map((item) => item.productId)).toEqual(ids);
    expect(result.snapshot.items.map((item) => item.heroPriceCents)).toEqual(["2834910", "1790000", "3149900"]);
    expect(result.snapshot.items[0]).toMatchObject({ promotionalPriceCents: "2834910", regularPriceCents: "3149900", promotionCondition: "LLEVANDO 3 UNIDADES" });
    expect(result.snapshot.items[1]).toMatchObject({ promotionalPriceCents: null, heroPriceCents: "1790000" });
    expect(result.snapshot.items[2]).toMatchObject({ promotionalPriceCents: null, promotionCondition: null });
  }, 30_000);

  it("un precio enviado por el cliente no llega a la imagen: gana el de la base", async () => {
    const parsed = parseArtworkExportRequest({ productId: PRODUCT_IDS.nalga, branchId: BRANCH_ID, headline: "OFERTA", format: "feed", priceCents: 1, price: "$ 1", items: [{ priceCents: 1 }] });
    if (!parsed.ok) throw new Error("pedido inválido");
    const { deps } = fixtureDeps();
    const result = await executeArtworkExport(deps, parsed.value);
    expect(result.snapshot.items[0]?.heroPriceCents).toBe("1790000");
  }, 30_000);

  it("sin sucursal pide el precio general", async () => {
    const { deps, getFacts, getBranding } = fixtureDeps({ branch: null });
    await executeArtworkExport(deps, { ...hero("nalga", "feed"), branchId: null });
    expect(getFacts).toHaveBeenCalledWith(PRODUCT_IDS.nalga, null);
    expect(getBranding).toHaveBeenCalledWith(null);
  }, 30_000);
});

describe("executeArtworkExport — logo y contacto salen del servidor", () => {
  it("pide la identidad de ESA sucursal y lee el logo de Storage por la ruta registrada", async () => {
    const { deps, getBranding, readPhoto } = fixtureDeps();
    const result = await executeArtworkExport(deps, hero("nalga", "feed"));
    expect(getBranding).toHaveBeenCalledWith(BRANCH_ID);
    expect(readPhoto).toHaveBeenCalledWith(LOGO_PATH);
    expect(result.snapshot.hasLogo).toBe(true);
    expect(result.snapshot.contact).toEqual({ phone: "3496-448808", address: "GÜEMES 2180", city: "ESPERANZA, SANTA FE" });
  }, 30_000);

  it("el contacto corresponde a la sucursal elegida: Avenida no muestra nada de Central", async () => {
    const { deps, getBranding } = fixtureDeps({ branch: "avenida" });
    const result = await executeArtworkExport(deps, { ...collage(polloIds.slice(0, 2), "feed"), branchId: BRANCH_AVENIDA_ID });
    expect(getBranding).toHaveBeenCalledWith(BRANCH_AVENIDA_ID);
    expect(result.snapshot.contact).toEqual({ phone: "0342 455-5555", address: "AV. LIBERTAD 100", city: "SANTA FE, SANTA FE" });
    expect(JSON.stringify(result.snapshot)).not.toMatch(/3496|GÜEMES|ESPERANZA/);
  }, 30_000);

  it("sin logo cargado: se exporta igual (respaldo con el nombre) y el snapshot lo refleja", async () => {
    const { deps, readPhoto } = fixtureDeps({ logo: false });
    const result = await executeArtworkExport(deps, hero("nalga", "story"));
    expect(result.snapshot.hasLogo).toBe(false);
    expect(readPhoto).not.toHaveBeenCalledWith(LOGO_PATH);
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1920 });
  }, 30_000);

  it("el logo registrado pero ilegible en Storage => 502 (no se entrega una pieza sin el logo que tiene la organización)", async () => {
    const { deps } = fixtureDeps();
    const failing = { ...deps, readPhoto: (path: string) => (path === LOGO_PATH ? Promise.resolve(null) : deps.readPhoto(path)) };
    await expect(executeArtworkExport(failing, hero("nalga", "feed"))).rejects.toMatchObject({ name: "ArtworkExportError", status: 502 });
  });

  it("bytes que no son un PNG/JPG (HTML marcado como PNG) => 422", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const { deps } = fixtureDeps({ logoBytes: html });
    await expect(executeArtworkExport(deps, hero("nalga", "feed"))).rejects.toMatchObject({ status: 422 });
  });

  it("las medidas del logo salen de sus bytes reales, no de lo registrado", async () => {
    const { deps } = fixtureDeps();
    const lying = { ...deps, getBranding: () => Promise.resolve({ organizationName: "AW Org", branch: null, logo: { storagePath: LOGO_PATH, contentType: "image/png", sizeBytes: 9, width: 50, height: 5000 } }) };
    const branding = await resolveBranding(lying, null);
    expect(branding.logo).toMatchObject({ width: 480, height: 120 });
  });

  it("la identidad de una sucursal de otra organización no se sirve (la RPC responde 42501 => 403)", async () => {
    const { deps } = fixtureDeps();
    const denied = { ...deps, getBranding: () => Promise.reject(new ArtworkExportError(403, "Branch not found")) };
    await expect(executeArtworkExport(denied, hero("nalga", "feed"))).rejects.toMatchObject({ status: 403 });
  });

  it("una respuesta de identidad que no se entiende => 500", async () => {
    const { deps } = fixtureDeps();
    await expect(resolveBranding({ ...deps, getBranding: () => Promise.resolve("x") }, null)).rejects.toMatchObject({ status: 500 });
  });
});

describe("executeArtworkExport — foto", () => {
  it("sin foto usa el panel de reemplazo y no pide la foto a Storage", async () => {
    const { deps, readPhoto } = fixtureDeps();
    const result = await executeArtworkExport(deps, hero("sinFoto", "feed"));
    expect(readPhoto.mock.calls.map((call) => call[0])).toEqual([LOGO_PATH]);
    expect(result.snapshot.items[0]?.hasPhoto).toBe(false);
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1350 });
  }, 30_000);

  it("collage con un producto sin foto: se exporta con el panel de reemplazo en ese lugar", async () => {
    const { deps } = fixtureDeps();
    const result = await executeArtworkExport(deps, collage([COLLAGE_IDS.pataMuslo, PRODUCT_IDS.sinFoto, COLLAGE_IDS.filet], "feed"));
    expect(result.snapshot.items.map((item) => item.hasPhoto)).toEqual([true, false, true]);
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1350 });
  }, 30_000);

  it("con foto la lee de Storage por su ruta", async () => {
    const { deps, readPhoto } = fixtureDeps();
    await executeArtworkExport(deps, hero("nalga", "feed"));
    expect(readPhoto).toHaveBeenCalledWith(expect.stringContaining(`${PRODUCT_IDS.nalga}/`));
  }, 30_000);

  it("el objeto no se puede leer => 502 (no se entrega una pieza sin la foto que tiene registrada)", async () => {
    const { deps } = fixtureDeps();
    const failing = { ...deps, readPhoto: (path: string) => (path.includes(PRODUCT_IDS.nalga) ? Promise.resolve(null) : deps.readPhoto(path)) };
    await expect(executeArtworkExport(failing, hero("nalga", "feed"))).rejects.toMatchObject({ name: "ArtworkExportError", status: 502 });
  });

  it("bytes que no son del tipo registrado (p. ej. HTML marcado como PNG) => 422", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const { deps } = fixtureDeps();
    const bad = { ...deps, readPhoto: (path: string) => (path.includes(PRODUCT_IDS.nalga) ? Promise.resolve({ bytes: html }) : deps.readPhoto(path)) };
    await expect(executeArtworkExport(bad, hero("nalga", "feed"))).rejects.toMatchObject({ status: 422 });
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
    const { deps } = fixtureDeps({ factsOverrides: { [PRODUCT_IDS.pollo]: { photo: { storagePath: `${PRODUCT_IDS.pollo}/x.jpg`, contentType: "image/jpeg", sizeBytes: jpeg.byteLength } } } });
    const withJpeg = { ...deps, readPhoto: (path: string) => (path.endsWith("x.jpg") ? Promise.resolve({ bytes: jpeg }) : deps.readPhoto(path)) };
    const result = await executeArtworkExport(withJpeg, hero("pollo", "feed"));
    expect(pngSize(result.png)).toEqual({ width: 1080, height: 1350 });
    expect(result.snapshot.items[0]?.hasPhoto).toBe(true);
  }, 30_000);
});

describe("resolveArtwork — productos que no se pueden publicar", () => {
  const req = (key: Key) => ({ template: "HERO" as const, productIds: [PRODUCT_IDS[key]], branchId: BRANCH_ID, headline: "OFERTA" });

  it("producto inexistente o de otra organización => 404", async () => {
    const { deps } = fixtureDeps();
    await expect(resolveArtwork({ ...deps, getFacts: () => Promise.resolve(null) }, req("nalga"))).rejects.toMatchObject({ status: 404 });
  });

  it.each([["INACTIVE"], ["NOT_IN_BRANCH"], ["NO_PRICE"]])("%s => 422 con un motivo claro (nunca una pieza a $0)", async (reason) => {
    const { deps } = fixtureDeps({ factsOverrides: { [PRODUCT_IDS.nalga]: { available: false, unavailableReason: reason } } });
    await expect(resolveArtwork(deps, req("nalga"))).rejects.toMatchObject({ status: 422 });
  });

  it("precio cero en la base => 422", async () => {
    const { deps } = fixtureDeps({ factsOverrides: { [PRODUCT_IDS.nalga]: { listPriceCents: "0" } } });
    await expect(resolveArtwork(deps, req("nalga"))).rejects.toMatchObject({ status: 422 });
  });

  it("collage: un producto no disponible impide exportar y el mensaje lo nombra", async () => {
    const { deps } = fixtureDeps({ factsOverrides: { [COLLAGE_IDS.filet]: { available: false, unavailableReason: "NOT_IN_BRANCH" } } });
    const attempt = executeArtworkExport(deps, collage(polloIds.slice(0, 3), "feed"));
    await expect(attempt).rejects.toMatchObject({ status: 422 });
    await expect(attempt).rejects.toThrow(/«Filet de pechuga x 2 kg» no se vende en esa sucursal/);
  });

  it("collage: un producto inexistente => 404", async () => {
    const { deps } = fixtureDeps();
    await expect(executeArtworkExport({ ...deps, getFacts: (id, branch) => (id === COLLAGE_IDS.pechuga ? Promise.resolve(null) : deps.getFacts(id, branch)) }, collage(polloIds.slice(0, 3), "feed"))).rejects.toMatchObject({ status: 404 });
  });
});

describe("renderArtworkPng", () => {
  it("dibuja también el TV del protagonista (sólo vista previa en el producto): 1920 × 1080", async () => {
    const { deps } = fixtureDeps();
    const { model } = await resolveArtwork(deps, { template: "HERO", productIds: [PRODUCT_IDS.nalga], branchId: BRANCH_ID, headline: "OFERTA" });
    expect(pngSize(await renderArtworkPng(model, "tv"))).toEqual({ width: 1920, height: 1080 });
  }, 30_000);

  it("el collage no tiene formato TV", async () => {
    const { deps } = fixtureDeps();
    const { model } = await resolveArtwork(deps, { template: "COLLAGE", productIds: polloIds.slice(0, 2), branchId: BRANCH_ID, headline: "OFERTAS" });
    await expect(renderArtworkPng(model, "tv")).rejects.toThrow(/TV/);
  });
});
