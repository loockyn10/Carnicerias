import { describe, expect, it, vi } from "vitest";

import { ArtworkExportError } from "./artwork-export";
import {
  executeFolderGeneration, MAX_ITEMS_PER_REQUEST, parseFolderGenerationRequest, pieceToLine, prepareFolderGeneration, renderFolderPieces,
  type FolderGenerationDeps, type FolderGenerationRequest, type GeneratedPiece
} from "./artwork-folder-export";
import { ARTWORK_FORMATS } from "./artwork-tokens";
import { readImageInfo } from "./image-size";
import { renderSampleLogo } from "./test-support/artwork-deps";
import { brandingPayload, makeMeatPhoto } from "./test-support/artwork-fixtures";
import { FOLDER_BRANCH, FOLDER_ID, itemId, packPromotion, rawFolderFacts, rawItem, weekendFolder } from "./test-support/folder-fixtures";
import { must } from "./test-support/must";

const NOW = new Date("2026-10-11T15:00:00Z");

async function depsFor(raw: unknown, overrides: Partial<FolderGenerationDeps> = {}) {
  const logo = await renderSampleLogo();
  const photo = makeMeatPhoto("transparent");
  const getFolderFacts = vi.fn<FolderGenerationDeps["getFolderFacts"]>(() => Promise.resolve(raw));
  const getBranding = vi.fn(() => Promise.resolve(brandingPayload("central")));
  const readPhoto = vi.fn((path: string) => Promise.resolve({ bytes: path.includes("/branding/") ? logo : photo }));
  const deps: FolderGenerationDeps = { getFolderFacts, getBranding, readPhoto, ...overrides };
  return { deps, getFolderFacts, getBranding, readPhoto };
}

const request = (overrides: Partial<FolderGenerationRequest> = {}): FolderGenerationRequest => ({
  folderId: FOLDER_ID, branchId: FOLDER_BRANCH, itemIds: [itemId(1), itemId(2), itemId(3), itemId(4), itemId(5), itemId(6)], formats: ["feed", "story"], headline: "OFERTA", ...overrides
});

describe("parseFolderGenerationRequest: sólo ids, formatos y titular", () => {
  const base = { folderId: FOLDER_ID, branchId: FOLDER_BRANCH, itemIds: [itemId(1), itemId(2)], formats: ["feed", "story"], headline: "x mayor" };

  it("acepta un pedido válido y normaliza el titular", () => {
    const parsed = parseFolderGenerationRequest(base);
    expect(parsed).toEqual({ ok: true, value: { folderId: FOLDER_ID, branchId: FOLDER_BRANCH, itemIds: [itemId(1), itemId(2)], formats: ["feed", "story"], headline: "X MAYOR" } });
  });

  it("ignora cualquier precio, nombre, imagen o promoción que mande el navegador", () => {
    const parsed = parseFolderGenerationRequest({ ...base, priceCents: 1, productName: "Gratis", imageUrl: "http://x", promotion: { packPriceCents: 1 }, logo: "x" });
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/Gratis|http|packPriceCents|logo/);
  });

  it("rechaza lo inválido: carpeta, sucursal, elementos, formatos, repetidos y lotes enormes", () => {
    const error = (patch: Record<string, unknown>) => { const result = parseFolderGenerationRequest({ ...base, ...patch }); return result.ok ? null : result.error; };
    expect(error({ folderId: "x" })).toBe("Carpeta inválida");
    expect(error({ branchId: "x" })).toBe("Sucursal inválida");
    expect(error({ itemIds: [] })).toMatch(/1 a/);
    expect(error({ itemIds: Array.from({ length: MAX_ITEMS_PER_REQUEST + 1 }, (_, i) => itemId(i + 1)) })).toMatch(/1 a/);
    expect(error({ itemIds: ["x"] })).toBe("Elemento inválido");
    expect(error({ itemIds: [itemId(1), itemId(1)] })).toBe("Elemento repetido");
    expect(error({ formats: ["tv"] })).toMatch(/Feed o Story/);
    expect(error({ formats: [] })).toMatch(/Feed o Story/);
    expect(error({ headline: 5 })).toBe("Titular inválido");
    expect(parseFolderGenerationRequest(null)).toEqual({ ok: false, error: "Pedido inválido" });
  });

  it("sin sucursal es válido (precio general); el titular vacío cae en «OFERTA»", () => {
    const parsed = must(parseFolderGenerationRequest({ ...base, branchId: null, headline: "  " }) as { ok: true; value: FolderGenerationRequest }).value;
    expect(parsed.branchId).toBeNull();
    expect(parsed.headline).toBe("OFERTA");
  });
});

describe("executeFolderGeneration: «Generar todo actualizado» con los datos de hoy", () => {
  it("genera Feed y Story de cada elemento vigente, del tamaño exacto, y NO genera lo vencido ni lo inactivo (vuelven con el motivo)", async () => {
    const { deps } = await depsFor(weekendFolder(NOW));
    const { pieces, folderName } = await executeFolderGeneration(deps, request(), () => NOW);
    expect(folderName).toBe("Ofertas finde");
    expect(pieces).toHaveLength(12);
    const ok = pieces.filter((piece) => piece.status === "OK");
    expect(ok).toHaveLength(8);
    for (const piece of ok) {
      const spec = ARTWORK_FORMATS[piece.format];
      const png = must(piece.png);
      expect(readImageInfo(png)).toMatchObject({ width: spec.width, height: spec.height });
    }
    const skipped = pieces.filter((piece) => piece.status === "SKIPPED");
    expect(skipped.map((piece) => `${piece.productName}:${piece.message ?? ""}`)).toEqual([
      "Chorizo vencido:Promoción vencida", "Chorizo vencido:Promoción vencida", "Bife desactivado:Inactiva", "Bife desactivado:Inactiva"
    ]);
    expect(skipped.every((piece) => piece.png === null)).toBe(true);
  }, 60_000);

  it("una sola lectura por lote: la carpeta, la identidad y cada foto se piden UNA vez (nada de una consulta por promoción)", async () => {
    const { deps, getFolderFacts, getBranding, readPhoto } = await depsFor(weekendFolder(NOW));
    await executeFolderGeneration(deps, request(), () => NOW);
    expect(getFolderFacts).toHaveBeenCalledTimes(1);
    expect(getFolderFacts.mock.calls[0]).toEqual([FOLDER_ID, FOLDER_BRANCH, request().itemIds]);
    expect(getBranding).toHaveBeenCalledTimes(1);
    // 3 fotos distintas de los elementos vigentes pedidos (Matambre no tiene) + el logo.
    expect(readPhoto).toHaveBeenCalledTimes(1 + 3);
  }, 60_000);

  it("avisos por pieza: sin foto y vence pronto; el resumen dice lo que se dibujó", async () => {
    const { deps } = await depsFor(weekendFolder(NOW));
    const { pieces } = await executeFolderGeneration(deps, request(), () => NOW);
    const by = (name: string, format: "feed" | "story") => must(pieces.find((piece) => piece.productName === name && piece.format === format));
    expect(by("Matambre", "feed").warnings).toContain("NO_PHOTO");
    expect(by("Costilla de cerdo", "story").warnings).toContain("EXPIRES_SOON");
    expect(by("Pata muslo", "feed").warnings).toEqual([]);
    expect(by("Pata muslo", "feed").summary).toBe("$ 9.000 / kg · desde 2 kg");
    expect(by("Matambre", "feed").png).not.toBeNull();
  }, 60_000);

  it("un cambio de precio de la promoción sale en la pieza nueva sin tocar la carpeta (otro precio => otros píxeles)", async () => {
    const make = async (price: string) => {
      const raw = rawFolderFacts([rawItem({ n: 1, name: "Costilla de cerdo", listPriceCents: 800_000, promotion: packPromotion(2, { packPriceCents: price }) })]);
      const { deps } = await depsFor(raw);
      const { pieces } = await executeFolderGeneration(deps, request({ itemIds: [itemId(1)], formats: ["feed"] }), () => NOW);
      return { piece: must(pieces[0]), png: Buffer.from(must(pieces[0]?.png)).toString("base64") };
    };
    const before = await make("1400000");
    const after = await make("1500000");
    expect(before.piece.summary).toBe("$ 14.000 · por 2 kg");
    expect(after.piece.summary).toBe("$ 15.000 · por 2 kg");
    expect(after.png).not.toBe(before.png);
  }, 30_000);

  it("un error en UNA pieza no pierde las otras: la foto ilegible de un producto sólo afecta a ese producto", async () => {
    const raw = weekendFolder(NOW);
    const photo = makeMeatPhoto("transparent");
    const logo = await renderSampleLogo();
    const { deps } = await depsFor(raw, {
      readPhoto: vi.fn((path: string) => Promise.resolve(path.includes("/branding/") ? { bytes: logo } : path.includes("c5000000-0000-4000-8000-000000000002") ? null : { bytes: photo }))
    });
    const { pieces } = await executeFolderGeneration(deps, request({ formats: ["feed"] }), () => NOW);
    const costilla = must(pieces.find((piece) => piece.productName === "Costilla de cerdo"));
    expect(costilla).toMatchObject({ status: "ERROR", png: null });
    expect(costilla.message).toMatch(/foto/);
    expect(pieces.filter((piece) => piece.status === "OK").map((piece) => piece.productName)).toEqual(["Pata muslo", "Coca Cola", "Matambre"]);
  });

  it("bytes que no son PNG/JPEG: la pieza falla con un mensaje, las demás salen", async () => {
    const logo = await renderSampleLogo();
    const { deps } = await depsFor(weekendFolder(NOW), {
      readPhoto: vi.fn((path: string) => Promise.resolve({ bytes: path.includes("/branding/") ? logo : new TextEncoder().encode("<html>no soy una foto</html>") }))
    });
    const { pieces } = await executeFolderGeneration(deps, request({ formats: ["feed"], itemIds: [itemId(1), itemId(4)] }), () => NOW);
    expect(pieces.find((piece) => piece.productName === "Pata muslo")).toMatchObject({ status: "ERROR" });
    // Matambre no tiene foto: se dibuja con el reemplazo, sin leer nada.
    expect(pieces.find((piece) => piece.productName === "Matambre")).toMatchObject({ status: "OK" });
  });

  it("la composición rota con la posición del elemento en la carpeta (estable): la misma entrada da los mismos bytes", async () => {
    const run = async () => {
      const { deps } = await depsFor(weekendFolder(NOW));
      const { pieces } = await executeFolderGeneration(deps, request({ itemIds: [itemId(1), itemId(2)], formats: ["feed"] }), () => NOW);
      return pieces.map((piece) => Buffer.from(must(piece.png)).toString("base64"));
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(first[0]).not.toBe(first[1]);
  }, 60_000);

  it("la carpeta que no existe (u otra organización) corta el lote entero con 404; la identidad ilegible, con 502", async () => {
    const missing = await depsFor(null);
    await expect(executeFolderGeneration(missing.deps, request(), () => NOW)).rejects.toMatchObject({ status: 404 });
    const noLogo = await depsFor(weekendFolder(NOW), { readPhoto: vi.fn(() => Promise.resolve(null)) });
    await expect(executeFolderGeneration(noLogo.deps, request(), () => NOW)).rejects.toBeInstanceOf(ArtworkExportError);
  });

  it("sólo se generan los elementos pedidos del lote", async () => {
    const { deps } = await depsFor(weekendFolder(NOW));
    const { pieces } = await executeFolderGeneration(deps, request({ itemIds: [itemId(7)], formats: ["story"] }), () => NOW);
    expect(pieces.map((piece) => `${piece.productName}:${piece.format}`)).toEqual(["Nalga vacuna:story"]);
    expect(pieces[0]?.summary).toBe("$ 17.900 / kg");
  });

  it("un solo formato genera sólo ese formato", async () => {
    const { deps } = await depsFor(weekendFolder(NOW));
    const { pieces } = await executeFolderGeneration(deps, request({ itemIds: [itemId(1)], formats: ["feed"] }), () => NOW);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.format).toBe("feed");
  });
});

describe("streaming: las piezas salen de a una y el lote se resuelve antes de empezar", () => {
  it("prepareFolderGeneration falla ANTES de enviar nada (la ruta puede contestar 404) y renderFolderPieces entrega cada pieza apenas está lista", async () => {
    const missing = await depsFor(null);
    await expect(prepareFolderGeneration(missing.deps, request(), () => NOW)).rejects.toMatchObject({ status: 404 });

    const { deps } = await depsFor(weekendFolder(NOW));
    const prepared = await prepareFolderGeneration(deps, request({ itemIds: [itemId(1), itemId(4)], formats: ["feed", "story"] }), () => NOW);
    expect(prepared.items.map((item) => item.name)).toEqual(["Pata muslo", "Matambre"]);
    const order: string[] = [];
    const delivered: GeneratedPiece[] = [];
    await renderFolderPieces(prepared, request({ itemIds: [itemId(1), itemId(4)], formats: ["feed", "story"] }), (piece) => { order.push(`${piece.productName}:${piece.format}`); delivered.push(piece); });
    expect(order).toEqual(["Pata muslo:feed", "Pata muslo:story", "Matambre:feed", "Matambre:story"]);
    expect(delivered.every((piece) => piece.status === "OK")).toBe(true);
  }, 60_000);

  it("cada línea del stream lleva la pieza con su PNG en base64 (nunca bytes crudos) y se puede volver a leer", async () => {
    const { deps } = await depsFor(weekendFolder(NOW));
    const { pieces } = await executeFolderGeneration(deps, request({ itemIds: [itemId(7)], formats: ["feed"] }), () => NOW);
    const line = pieceToLine(must(pieces[0]));
    expect(line.type).toBe("piece");
    const parsed = JSON.parse(JSON.stringify(line)) as { piece: { pngBase64: string; productName: string } };
    expect(parsed.piece.productName).toBe("Nalga vacuna");
    expect(Buffer.from(parsed.piece.pngBase64, "base64").subarray(1, 4).toString()).toBe("PNG");
    const skipped = pieceToLine({ ...must(pieces[0]), status: "SKIPPED", png: null, message: "Promoción vencida" });
    expect(skipped).toMatchObject({ type: "piece", piece: { status: "SKIPPED", pngBase64: null } });
  }, 30_000);
});
