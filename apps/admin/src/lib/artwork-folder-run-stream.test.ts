import { describe, expect, it, vi } from "vitest";

import { runFolderGeneration, type FetchJson, type RunProgress } from "./artwork-folder-run";

/** Respuesta en streaming (NDJSON) del servidor: una línea por pieza, con el corte de bytes que se pida (para probar líneas partidas). */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const b64 = Buffer.from(PNG).toString("base64");
const id = (n: number) => `f2000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const items = (count: number) => Array.from({ length: count }, (_, i) => ({ itemId: id(i + 1), name: `Producto ${String(i + 1)}` }));
interface Body { itemIds: string[]; formats: ("feed" | "story")[] }

const pieceLine = (itemId: string, format: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "piece", piece: { itemId, productName: "P", format, status: "OK", message: null, warnings: [], summary: "$ 1", pngBase64: b64, ...extra }
});

function ndjson(lines: string[], options: { bytesPerChunk?: number; failAfterChunks?: number } = {}) {
  const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  const size = options.bytesPerChunk ?? bytes.length;
  let offset = 0;
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfterChunks !== undefined && chunks >= options.failAfterChunks) { controller.error(new TypeError("network error")); return; }
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
      chunks += 1;
    }
  });
  return { status: 200, ok: true, headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "application/x-ndjson; charset=utf-8" : null }, body, json: () => Promise.reject(new Error("stream")) };
}

const serverOf = (respond: (body: Body, call: number) => ReturnType<typeof ndjson>) => {
  let calls = 0;
  return vi.fn<FetchJson>((_url, init) => Promise.resolve(respond(JSON.parse(init.body) as Body, ++calls)));
};
const allPieces = (body: Body) => body.itemIds.flatMap((itemId) => body.formats.map((format) => pieceLine(itemId, format)));

describe("respuesta en streaming (NDJSON): las piezas llegan de a una", () => {
  it("avance pieza por pieza («8 / 20») y resultado completo", async () => {
    const fetchJson = serverOf((body) => ndjson([...allPieces(body), JSON.stringify({ type: "done", folderName: "Ofertas finde" })]));
    const progress: RunProgress[] = [];
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(4), formats: ["feed", "story"], chunkSize: 2, concurrency: 1, onProgress: (p) => progress.push({ ...p }) });
    expect(result.generated).toBe(8);
    expect(progress.map((p) => p.done)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(progress.every((p) => p.total === 8)).toBe(true);
  });

  it("una línea partida entre dos trozos de red se reconstruye (los bytes pueden cortarse en cualquier lado)", async () => {
    const fetchJson = serverOf((body) => ndjson(allPieces(body), { bytesPerChunk: 7 }));
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(3), formats: ["feed"] });
    expect(result.generated).toBe(3);
    expect(result.pieces.every((piece) => piece.png?.length === PNG.length)).toBe(true);
  });

  it("un error en una pieza viaja en ELLA y las demás siguen", async () => {
    const fetchJson = serverOf((body) => ndjson([
      pieceLine(body.itemIds[0] ?? "", "feed"),
      JSON.stringify({ type: "piece", piece: { itemId: body.itemIds[1], productName: "P2", format: "feed", status: "ERROR", message: "No se pudo leer la foto", warnings: [], summary: null, pngBase64: null } }),
      pieceLine(body.itemIds[2] ?? "", "feed")
    ]));
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(3), formats: ["feed"] });
    expect(result).toMatchObject({ generated: 2, needsReview: 1, retryItemIds: [id(2)] });
    expect(result.pieces.find((piece) => piece.itemId === id(2))?.message).toBe("No se pudo leer la foto");
  });

  it("si el stream se corta a la mitad se conserva lo que llegó y lo que falta queda en error (sin repetir el lote)", async () => {
    const fetchJson = serverOf((body) => ndjson(allPieces(body), { bytesPerChunk: 400, failAfterChunks: 1 }));
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(3), formats: ["feed", "story"] });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(result.generated + result.needsReview).toBe(6);
    expect(result.generated).toBeGreaterThanOrEqual(1);
    expect(result.needsReview).toBeGreaterThanOrEqual(1);
    expect(result.pieces.filter((piece) => piece.status === "ERROR").every((piece) => /conexión|llegó/.test(piece.message ?? ""))).toBe(true);
  });

  it("una línea de error del servidor explica por qué faltan las demás piezas", async () => {
    const fetchJson = serverOf((body) => ndjson([pieceLine(body.itemIds[0] ?? "", "feed"), JSON.stringify({ type: "error", message: "No se pudieron generar las piezas" })]));
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(2), formats: ["feed"] });
    expect(result.generated).toBe(1);
    expect(result.pieces.find((piece) => piece.itemId === id(2))).toMatchObject({ status: "ERROR", message: "No se pudieron generar las piezas" });
  });

  it("líneas rotas o de otro lote se ignoran y no aparece una pieza dos veces", async () => {
    const fetchJson = serverOf((body) => ndjson(["no soy json", pieceLine("otro-id", "feed"), pieceLine(body.itemIds[0] ?? "", "feed"), pieceLine(body.itemIds[0] ?? "", "feed")]));
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(1), formats: ["feed"] });
    expect(result.pieces).toHaveLength(1);
    expect(result.generated).toBe(1);
  });

  it("un error antes del stream (carpeta inexistente) se informa por pieza y no se reintenta", async () => {
    const fetchJson = vi.fn<FetchJson>(() => Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({ error: "La carpeta no existe" }) }));
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(2), formats: ["feed"] });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(result.pieces.every((piece) => piece.message === "La carpeta no existe")).toBe(true);
  });
});
