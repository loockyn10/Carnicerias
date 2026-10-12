import { describe, expect, it, vi } from "vitest";

import {
  base64ToBytes, buildRunZip, buildRunZipEntries, looseFilename, mergeRetry, pieceFilenames, planBatches, runFolderGeneration, summarizeRun,
  type FetchJson, type RunPiece, type RunProgress
} from "./artwork-folder-run";
import { must } from "./test-support/must";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const id = (n: number) => `f2000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const items = (count: number) => Array.from({ length: count }, (_, i) => ({ itemId: id(i + 1), name: `Producto ${String(i + 1)}` }));

interface Body { folderId: string; branchId: string | null; itemIds: string[]; formats: ("feed" | "story")[] }

/** Servidor falso: responde cada pedido con una pieza OK por elemento y formato (o lo que pida `behave`). */
function server(behave: (body: Body, call: number) => { status: number; body: unknown } | "throw" = (body) => ({
  status: 200,
  body: { folderName: "Ofertas finde", pieces: body.itemIds.flatMap((itemId) => body.formats.map((format) => ({
    itemId, productName: `Producto ${String(Number(itemId.slice(-12)))}`, format, status: "OK", message: null, warnings: [], summary: "$ 1.000", pngBase64: b64(PNG)
  }))) }
})) {
  let calls = 0;
  const seen: Body[] = [];
  const fetchJson = vi.fn<FetchJson>((_url, init) => {
    const body = JSON.parse(init.body) as Body;
    seen.push(body);
    const outcome = behave(body, ++calls);
    if (outcome === "throw") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ status: outcome.status, ok: outcome.status >= 200 && outcome.status < 300, json: () => Promise.resolve(outcome.body) });
  });
  return { fetchJson, seen, calls: () => calls };
}

describe("planBatches", () => {
  it("reparte en lotes del tamaño pedido, sin perder ni repetir", () => {
    expect(planBatches([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(planBatches([], 3)).toEqual([]);
    expect(planBatches([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe("runFolderGeneration: lotes, progreso y errores parciales", () => {
  it("20 elementos × 2 formatos = 40 piezas, en lotes de 3 y con avance 0 → 40 piezas", async () => {
    const { fetchJson, seen } = server();
    const progress: RunProgress[] = [];
    const result = await runFolderGeneration({ fetchJson, folderId: "folder", branchId: "branch", items: items(20), formats: ["feed", "story"], onProgress: (p) => progress.push({ ...p }) });
    expect(result.generated).toBe(40);
    expect(result.needsReview).toBe(0);
    expect(seen).toHaveLength(7);
    expect(seen.every((body) => body.itemIds.length <= 3 && body.folderId === "folder" && body.branchId === "branch")).toBe(true);
    expect(progress[0]).toEqual({ done: 0, total: 40 });
    expect(progress.at(-1)).toEqual({ done: 40, total: 40 });
    expect(progress.map((p) => p.done)).toEqual([...progress.map((p) => p.done)].sort((a, b) => a - b));
  });

  it("el navegador sólo manda ids, formatos y sucursal (ningún precio ni nombre)", async () => {
    const { fetchJson, seen } = server();
    await runFolderGeneration({ fetchJson, folderId: "folder", branchId: null, items: items(2), formats: ["feed"], headline: "X MAYOR" });
    expect(Object.keys(must(seen[0])).sort()).toEqual(["branchId", "folderId", "formats", "headline", "itemIds"]);
  });

  it("de a pocos a la vez: nunca más pedidos en vuelo que la concurrencia", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchJson: FetchJson = (_url, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const body = JSON.parse(init.body) as Body;
      return new Promise((resolve) => setTimeout(() => {
        inFlight -= 1;
        resolve({ status: 200, ok: true, json: () => Promise.resolve({ pieces: body.itemIds.map((itemId) => ({ itemId, productName: "P", format: "feed", status: "OK", message: null, warnings: [], summary: null, pngBase64: b64(PNG) })) }) });
      }, 5));
    };
    await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(12), formats: ["feed"], concurrency: 2 });
    expect(peak).toBe(2);
  });

  it("si un lote falla (5xx) no se pierden los otros: sus piezas quedan en error y se puede reintentar sólo esas", async () => {
    const { fetchJson } = server((body) => body.itemIds.includes(id(4)) ? { status: 500, body: { error: "boom" } } : defaultOk(body));
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(9), formats: ["feed"], concurrency: 1 });
    expect(result.generated).toBe(6);
    expect(result.needsReview).toBe(3);
    expect([...result.retryItemIds].sort()).toEqual([id(4), id(5), id(6)]);
    expect(result.pieces.filter((piece) => piece.status === "ERROR").every((piece) => piece.message === "boom")).toBe(true);
  });

  it("un error 5xx se reintenta una vez y si la segunda sale bien, no hay error", async () => {
    let first = true;
    const { fetchJson, calls } = server((body, call) => {
      if (call === 1 && first) { first = false; return { status: 503, body: { error: "ocupado" } }; }
      return defaultOk(body);
    });
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(2), formats: ["feed"] });
    expect(result.generated).toBe(2);
    expect(calls()).toBe(2);
  });

  it("un error del pedido (4xx) no se reintenta y se explica", async () => {
    const { fetchJson, calls } = server(() => ({ status: 404, body: { error: "La carpeta no existe" } }));
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(2), formats: ["feed", "story"] });
    expect(calls()).toBe(1);
    expect(result.generated).toBe(0);
    expect(result.pieces).toHaveLength(4);
    expect(result.pieces.every((piece) => piece.status === "ERROR" && piece.message === "La carpeta no existe")).toBe(true);
  });

  it("sin conexión: cada lote queda en error con un mensaje claro (no se cuelga ni lanza)", async () => {
    const { fetchJson } = server(() => "throw");
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(3), formats: ["feed"] });
    expect(result.generated).toBe(0);
    expect(must(result.pieces[0]).message).toMatch(/conectar/);
  });

  it("una respuesta rara o incompleta se marca como error de esa pieza (nunca se pierde en silencio)", async () => {
    const { fetchJson } = server((body) => ({
      status: 200,
      body: { pieces: [
        { itemId: body.itemIds[0], productName: "A", format: "feed", status: "OK", warnings: [], pngBase64: b64(PNG) },
        { itemId: "otro-que-no-pedi", productName: "B", format: "feed", status: "OK", pngBase64: b64(PNG) },
        { itemId: body.itemIds[1], productName: "C", format: "feed", status: "OK" }
      ] }
    }));
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(2), formats: ["feed"] });
    expect(result.generated).toBe(1);
    expect(result.pieces).toHaveLength(2);
    expect(result.pieces.find((piece) => piece.itemId === id(2))).toMatchObject({ status: "ERROR", message: "La pieza no llegó completa. Probá de nuevo." });
  });

  it("lo que no está vigente (vencida, inactiva…) se informa como «no generada» y cuenta para revisar, sin pedirlo al servidor", async () => {
    const { fetchJson, seen } = server();
    const result = await runFolderGeneration({
      fetchJson, folderId: "f", branchId: null, items: items(2), formats: ["feed", "story"],
      skipped: [{ itemId: id(9), name: "Chorizo vencido", message: "Promoción vencida" }]
    });
    expect(seen.flatMap((body) => body.itemIds)).not.toContain(id(9));
    expect(result.generated).toBe(4);
    expect(result.needsReview).toBe(2);
    expect(result.pieces.filter((piece) => piece.status === "SKIPPED").map((piece) => `${piece.productName}:${piece.message ?? ""}`)).toEqual(["Chorizo vencido:Promoción vencida", "Chorizo vencido:Promoción vencida"]);
    expect(result.retryItemIds).toEqual([]);
  });

  it("las piezas vuelven en el orden de la carpeta, Feed antes que Story", async () => {
    const { fetchJson } = server();
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(4), formats: ["story", "feed"], concurrency: 2 });
    expect(result.pieces.map((piece) => `${piece.itemId.slice(-1)}${piece.format[0] ?? ""}`)).toEqual(["1f", "1s", "2f", "2s", "3f", "3s", "4f", "4s"]);
  });

  it("las piezas sin foto se cuentan aparte (se generaron con el reemplazo)", async () => {
    const { fetchJson } = server((body) => ({
      status: 200,
      body: { pieces: body.itemIds.map((itemId) => ({ itemId, productName: "P", format: "feed", status: "OK", message: null, warnings: ["NO_PHOTO"], summary: "$ 1", pngBase64: b64(PNG) })) }
    }));
    const result = await runFolderGeneration({ fetchJson, folderId: "f", branchId: null, items: items(2), formats: ["feed"] });
    expect(result).toMatchObject({ generated: 2, withoutPhoto: 2, needsReview: 0 });
  });
});

function defaultOk(body: Body) {
  return {
    status: 200,
    body: { pieces: body.itemIds.flatMap((itemId) => body.formats.map((format) => ({ itemId, productName: `Producto ${String(Number(itemId.slice(-12)))}`, format, status: "OK", message: null, warnings: [], summary: null, pngBase64: b64(PNG) }))) }
  };
}

describe("ZIP de lo generado", () => {
  const piece = (n: number, name: string, format: "feed" | "story", status: RunPiece["status"] = "OK"): RunPiece => ({
    itemId: id(n), productName: name, format, status, message: null, warnings: [], summary: null, png: status === "OK" ? PNG : null
  });

  it("«Ofertas finde - 11-10-2026/Feed/pata-muslo.png» y Story aparte, sólo con las piezas OK", () => {
    const date = new Date(2026, 9, 11, 12, 0, 0);
    const entries = buildRunZipEntries("Ofertas finde", date, [
      piece(1, "Pata Muslo", "feed"), piece(1, "Pata Muslo", "story"), piece(2, "Costilla", "feed"), piece(2, "Costilla", "story", "ERROR"), piece(3, "Chorizo", "feed", "SKIPPED")
    ]);
    expect(entries.map((entry) => entry.path)).toEqual([
      "Ofertas finde - 11-10-2026/Feed/pata-muslo.png", "Ofertas finde - 11-10-2026/Feed/costilla.png", "Ofertas finde - 11-10-2026/Story/pata-muslo.png"
    ]);
  });

  it("dos productos con el mismo nombre no se pisan dentro del mismo formato", () => {
    const names = pieceFilenames([piece(1, "Pata muslo", "feed"), piece(2, "Pata muslo", "feed"), piece(1, "Pata muslo", "story")]);
    expect(names.get(`${id(1)}:feed`)).toBe("pata-muslo.png");
    expect(names.get(`${id(2)}:feed`)).toBe("pata-muslo-2.png");
    expect(names.get(`${id(1)}:story`)).toBe("pata-muslo.png");
    expect(looseFilename("pata-muslo.png", "story")).toBe("pata-muslo-story.png");
  });

  it("buildRunZip devuelve un ZIP válido con todo; null si no hay nada que descargar", () => {
    const zip = must(buildRunZip("Ofertas finde", new Date(2026, 9, 11), [piece(1, "A", "feed"), piece(2, "B", "story")]));
    expect(Array.from(zip.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(buildRunZip("X", new Date(), [piece(1, "A", "feed", "ERROR")])).toBeNull();
  });

  it("base64ToBytes devuelve los mismos bytes", () => {
    expect(Array.from(base64ToBytes(b64(PNG)))).toEqual(Array.from(PNG));
  });
});

describe("reintentar los que fallaron", () => {
  it("conserva las piezas buenas y reemplaza sólo las de los elementos reintentados", () => {
    const base = (n: number, status: RunPiece["status"]): RunPiece => ({ itemId: id(n), productName: `P${String(n)}`, format: "feed", status, message: status === "OK" ? null : "falló", warnings: [], summary: null, png: status === "OK" ? PNG : null });
    const first = summarizeRun([base(1, "OK"), base(2, "ERROR"), base(3, "OK"), base(4, "ERROR")], [id(1), id(2), id(3), id(4)]);
    expect(first).toMatchObject({ generated: 2, needsReview: 2 });
    const merged = mergeRetry(first.pieces, new Set(first.retryItemIds), [base(2, "OK"), base(4, "ERROR")], [id(1), id(2), id(3), id(4)]);
    expect(merged.generated).toBe(3);
    expect(merged.retryItemIds).toEqual([id(4)]);
    expect(merged.pieces).toHaveLength(4);
  });
});
