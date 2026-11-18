import { describe, expect, it, vi } from "vitest";

import {
  feedFilenameFrom, listFeed, PROMOTION_FEED_ENDPOINT, recordFeed, renderFeed, runFeedQueue, type FeedJob, type FeedQueueDeps, type RecordEntry, type RenderOutcome
} from "./promotion-feed-queue";

const sig = (char: string) => char.repeat(64);
const jobs = (count: number): FeedJob[] => Array.from({ length: count }, (_, index) => ({ promotionId: `p-${String(index + 1)}`, name: `Promo ${String(index + 1)}` }));
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function okRender(job: FeedJob, signature = sig("a")): RenderOutcome {
  return { ok: true, file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], `Promo-Feed_${job.promotionId}.png`, { type: "image/png" }), entry: { promotionId: job.promotionId, signature, summary: "$ 1" } };
}

function harness(render: FeedQueueDeps["render"] = (job) => Promise.resolve(okRender(job)), record: FeedQueueDeps["record"] = () => Promise.resolve(true)) {
  const saved: File[] = [];
  const recorded: RecordEntry[][] = [];
  const deps: FeedQueueDeps = {
    render,
    save: (file) => { saved.push(file); },
    record: vi.fn(async (entries: RecordEntry[]) => { const ok = await record(entries); if (ok) recorded.push(entries); return ok; }),
    wait: () => tick()
  };
  return { deps, saved, recorded };
}

describe("cola de descargas Feed", () => {
  it("94 imágenes: una descarga PNG por promoción (sin ZIP), registradas en tandas de 10 y al final", async () => {
    const { deps, saved, recorded } = harness();
    const result = await runFeedQueue(jobs(94), deps);
    expect(result).toMatchObject({ total: 94, saved: 94, recorded: 94, unrecorded: 0, failed: [], stopped: null });
    expect(saved).toHaveLength(94);
    expect(saved.every((file) => file.type === "image/png" && file.name.endsWith(".png"))).toBe(true);
    expect(saved.some((file) => /zip/i.test(file.name) || /zip/i.test(file.type))).toBe(false);
    expect(recorded.map((entries) => entries.length)).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10, 4]);
    expect(new Set(recorded.flat().map((entry) => entry.promotionId)).size).toBe(94);
  });

  it("nunca hay más de 2 imágenes generándose o esperando ser guardadas (memoria y servidor acotados)", async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps } = harness(async (job) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      return okRender(job);
    });
    const save = deps.save;
    deps.save = (file) => { inFlight -= 1; save(file); };
    await runFeedQueue(jobs(30), deps);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("las descargas salen de a una con una pausa entre cada una", async () => {
    const events: string[] = [];
    const { deps } = harness();
    deps.save = (file) => { events.push(`save:${file.name}`); };
    deps.wait = (ms) => { events.push(`wait:${String(ms)}`); return tick(); };
    await runFeedQueue(jobs(3), deps, { saveGapMs: 600 });
    expect(events.filter((event) => event.startsWith("save")).length).toBe(3);
    // Después de cada descarga, la pausa (nunca dos descargas seguidas sin pausa).
    for (let index = 0; index < events.length; index += 1) if (events[index]?.startsWith("save")) expect(events[index + 1]).toBe("wait:600");
  });

  it("una imagen que falla no se registra y no frena a las demás; un error de red se reintenta una vez", async () => {
    const attempts = new Map<string, number>();
    const { deps, saved, recorded } = harness((job) => {
      const count = (attempts.get(job.promotionId) ?? 0) + 1;
      attempts.set(job.promotionId, count);
      if (job.promotionId === "p-2") return Promise.resolve({ ok: false, error: "Sin precio vigente", retry: false, fatal: false });
      if (job.promotionId === "p-3" && count === 1) return Promise.resolve({ ok: false, error: "Sin conexión", retry: true, fatal: false });
      return Promise.resolve(okRender(job));
    });
    const result = await runFeedQueue(jobs(5), deps);
    expect(result.failed).toEqual([{ name: "Promo 2", error: "Sin precio vigente" }]);
    expect(result.saved).toBe(4);
    expect(attempts.get("p-2")).toBe(1);
    expect(attempts.get("p-3")).toBe(2);
    expect(saved.map((file) => file.name)).not.toContain("Promo-Feed_p-2.png");
    expect(recorded.flat().map((entry) => entry.promotionId).sort()).toEqual(["p-1", "p-3", "p-4", "p-5"]);
  });

  it("sesión vencida: la cola se frena y lo que falta no se pide ni se registra", async () => {
    const render = vi.fn((job: FeedJob) => Promise.resolve<RenderOutcome>(job.promotionId === "p-3"
      ? { ok: false, error: "Tu sesión venció", retry: false, fatal: true } : okRender(job)));
    const { deps } = harness(render);
    const result = await runFeedQueue(jobs(10), deps, { concurrency: 1 });
    expect(result.stopped).toBe("Tu sesión venció");
    expect(render).toHaveBeenCalledTimes(3);
    expect(result.recorded).toBe(2);
  });

  it("precios que cambian mientras se genera: se registra la firma de lo que dibujó el servidor, no la de la lista inicial", async () => {
    const { deps, recorded } = harness((job) => Promise.resolve(okRender(job, job.promotionId === "p-2" ? sig("b") : sig("a"))));
    await runFeedQueue(jobs(3), deps);
    expect(recorded.flat().find((entry) => entry.promotionId === "p-2")?.signature).toBe(sig("b"));
  });

  it("si el registro falla dos veces, las imágenes ya bajadas quedan como NO registradas (vuelven a ser pendientes)", async () => {
    const { deps } = harness(undefined, () => Promise.resolve(false));
    const result = await runFeedQueue(jobs(12), deps);
    expect(result).toMatchObject({ saved: 12, recorded: 0, unrecorded: 12 });
    expect(deps.record).toHaveBeenCalledTimes(4);
  });
});

describe("pedidos al servidor", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it("render: POST sin caché con la promoción; arma el archivo PNG con el nombre y la firma del servidor", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(png, { status: 200, headers: {
      "Content-Type": "image/png", "Content-Disposition": "attachment; filename=\"Promo-Feed_pata-muslo_2026-11-18_960000.png\"",
      "X-Feed-Signature": sig("c"), "X-Feed-Summary": encodeURIComponent("$ 14.000 · por 2 kg")
    } })));
    const outcome = await renderFeed(fetchImpl, { promotionId: "p-1", name: "Pata muslo" });
    expect(fetchImpl).toHaveBeenCalledWith(PROMOTION_FEED_ENDPOINT, expect.objectContaining({ method: "POST", cache: "no-store", credentials: "same-origin", body: JSON.stringify({ action: "render", promotionId: "p-1" }) }));
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.file.name).toBe("Promo-Feed_pata-muslo_2026-11-18_960000.png");
    expect(outcome.file.type).toBe("image/png");
    expect(outcome.entry).toEqual({ promotionId: "p-1", signature: sig("c"), summary: "$ 14.000 · por 2 kg" });
  });

  it("render: errores con o sin reintento, sesión vencida fatal, firma inválida o imagen vacía", async () => {
    const respond = (response: Response) => () => Promise.resolve(response);
    expect(await renderFeed(respond(Response.json({ error: "Pata muslo: Promoción vencida" }, { status: 409 })), { promotionId: "p", name: "x" }))
      .toEqual({ ok: false, error: "Pata muslo: Promoción vencida", retry: false, fatal: false });
    expect(await renderFeed(respond(Response.json({ error: "x" }, { status: 502 })), { promotionId: "p", name: "x" })).toMatchObject({ retry: true, fatal: false });
    expect(await renderFeed(respond(Response.json({ error: "Tu sesión venció" }, { status: 401 })), { promotionId: "p", name: "x" })).toMatchObject({ fatal: true });
    expect(await renderFeed(respond(new Response(png, { headers: { "X-Feed-Signature": "nope" } })), { promotionId: "p", name: "x" })).toMatchObject({ ok: false, retry: true });
    expect(await renderFeed(respond(new Response(new Uint8Array(), { headers: { "X-Feed-Signature": sig("d") } })), { promotionId: "p", name: "x" })).toMatchObject({ ok: false, error: "La imagen llegó vacía" });
    expect(await renderFeed(() => Promise.reject(new TypeError("offline")), { promotionId: "p", name: "x" })).toMatchObject({ ok: false, retry: true });
  });

  it("list y record: acciones, modo y errores legibles", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ batchId: "b", items: [{ promotionId: "p-1", name: "Pata" }], skipped: [] })));
    expect(await listFeed(fetchImpl, "last")).toEqual({ batchId: "b", items: [{ promotionId: "p-1", name: "Pata" }], skipped: [] });
    expect(fetchImpl).toHaveBeenCalledWith(PROMOTION_FEED_ENDPOINT, expect.objectContaining({ body: JSON.stringify({ action: "list", mode: "last" }) }));
    expect(await listFeed(() => Promise.resolve(Response.json({ error: "Esta operación requiere el rol administrador" }, { status: 403 })), "pending"))
      .toEqual({ error: "Esta operación requiere el rol administrador" });
    const recordFetch = vi.fn(() => Promise.resolve(Response.json({ recorded: 1 })));
    expect(await recordFeed(recordFetch, "b", [{ promotionId: "p-1", signature: sig("a"), summary: null }])).toBe(true);
    expect(recordFetch).toHaveBeenCalledWith(PROMOTION_FEED_ENDPOINT, expect.objectContaining({ body: JSON.stringify({ action: "record", batchId: "b", items: [{ promotionId: "p-1", signature: sig("a"), summary: null }] }) }));
    expect(await recordFeed(() => Promise.reject(new TypeError("offline")), "b", [])).toBe(false);
    expect(feedFilenameFrom(null, { promotionId: "96000000-0000", name: "x" })).toBe("Promo-Feed_96000000.png");
  });
});
