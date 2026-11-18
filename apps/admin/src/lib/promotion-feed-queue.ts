/**
 * «Descargar promociones Feed» (D-103), lado celular: la COLA que pide una imagen por vez al servidor, la baja a la galería y registra lo
 * que ya empezó a descargarse. Pura (sin React ni DOM): la red, el guardado y las esperas se inyectan, así se prueba sin navegador.
 *
 * Por qué así (Chrome en Android, el POCO de Fran):
 *   - una imagen por pedido y PNG binario (sin ZIP ni base64): cada respuesta es directamente el archivo que se guarda;
 *   - de a `concurrency` (2) generaciones en paralelo y cada una espera a que SU imagen se haya guardado antes de pedir otra: nunca hay más de
 *     dos PNG en memoria esperando, y el servidor no recibe 94 pedidos juntos;
 *   - las descargas salen de a una con una pausa (`saveGapMs`): Chrome ignora descargas disparadas en el mismo instante;
 *   - se registra en tandas de `recordEvery` (10) y al final: si la página se cierra a mitad de camino, lo no registrado sigue pendiente;
 *   - un error de una imagen no frena las demás (un reintento si fue de red o del servidor); una sesión vencida frena todo.
 * El navegador no confirma que el archivo quedó en la galería: «enviada» = la descarga se inició. Por eso existe «Repetir la última tanda».
 */

export const PROMOTION_FEED_ENDPOINT = "/api/promotions/feed";

export interface FeedJob {
  promotionId: string;
  name: string;
}

export interface FeedList {
  batchId: string | null;
  items: FeedJob[];
  skipped: { name: string; reason: string }[];
}

export interface RecordEntry {
  promotionId: string;
  signature: string;
  summary: string | null;
}

export type RenderOutcome =
  | { ok: true; file: File; entry: RecordEntry }
  /** `retry`: vale la pena un reintento (red o 5xx). `fatal`: no tiene sentido seguir (sesión vencida, sin permiso). */
  | { ok: false; error: string; retry: boolean; fatal: boolean };

export type FeedFetch = (input: string, init: RequestInit) => Promise<Response>;

function post(fetchImpl: FeedFetch, body: unknown): Promise<Response> {
  return fetchImpl(PROMOTION_FEED_ENDPOINT, {
    method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { error?: unknown };
    return typeof data.error === "string" && data.error ? data.error : fallback;
  } catch {
    return fallback;
  }
}

/** Qué descargar: las pendientes de hoy (`pending`) o las de la última tanda (`last`), resueltas por el servidor en este momento. */
export async function listFeed(fetchImpl: FeedFetch, mode: "pending" | "last"): Promise<FeedList | { error: string }> {
  let response: Response;
  try {
    response = await post(fetchImpl, { action: "list", mode });
  } catch {
    return { error: "Sin conexión: probá de nuevo." };
  }
  if (!response.ok) return { error: await errorMessage(response, "No se pudieron leer las promociones.") };
  const data = await response.json() as Partial<FeedList>;
  return { batchId: typeof data.batchId === "string" ? data.batchId : null, items: Array.isArray(data.items) ? data.items : [], skipped: Array.isArray(data.skipped) ? data.skipped : [] };
}

export function feedFilenameFrom(disposition: string | null, job: FeedJob): string {
  const match = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? `Promo-Feed_${job.promotionId.slice(0, 8)}.png`;
}

/** Una imagen: el PNG y la firma de lo que dibujó el servidor (la que se registra si la descarga arranca). */
export async function renderFeed(fetchImpl: FeedFetch, job: FeedJob): Promise<RenderOutcome> {
  let response: Response;
  try {
    response = await post(fetchImpl, { action: "render", promotionId: job.promotionId });
  } catch {
    return { ok: false, error: "Sin conexión", retry: true, fatal: false };
  }
  if (!response.ok) {
    const error = await errorMessage(response, "No se pudo generar la imagen");
    return { ok: false, error, retry: response.status >= 500, fatal: response.status === 401 || response.status === 403 };
  }
  const signature = response.headers.get("X-Feed-Signature") ?? "";
  if (!/^[0-9a-f]{64}$/.test(signature)) return { ok: false, error: "Respuesta inesperada del servidor", retry: true, fatal: false };
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    return { ok: false, error: "Se cortó la descarga", retry: true, fatal: false };
  }
  if (blob.size === 0) return { ok: false, error: "La imagen llegó vacía", retry: true, fatal: false };
  let summary: string | null = null;
  try {
    summary = decodeURIComponent(response.headers.get("X-Feed-Summary") ?? "") || null;
  } catch {
    summary = null;
  }
  const file = new File([blob], feedFilenameFrom(response.headers.get("Content-Disposition"), job), { type: "image/png" });
  return { ok: true, file, entry: { promotionId: job.promotionId, signature, summary } };
}

/** Registra lo que ya empezó a descargarse. true = quedó registrado. */
export async function recordFeed(fetchImpl: FeedFetch, batchId: string, entries: RecordEntry[]): Promise<boolean> {
  try {
    const response = await post(fetchImpl, { action: "record", batchId, items: entries });
    return response.ok;
  } catch {
    return false;
  }
}

export interface FeedProgress {
  total: number;
  /** Generadas o fallidas (avance de la cola). */
  done: number;
  /** Descargas iniciadas. */
  saved: number;
  failed: number;
}

export interface FeedQueueDeps {
  render: (job: FeedJob) => Promise<RenderOutcome>;
  save: (file: File) => void;
  record: (entries: RecordEntry[]) => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
  onProgress?: (progress: FeedProgress) => void;
}

export interface FeedQueueOptions {
  concurrency?: number;
  recordEvery?: number;
  saveGapMs?: number;
  retryDelayMs?: number;
}

export interface FeedQueueResult {
  total: number;
  saved: number;
  failed: { name: string; error: string }[];
  recorded: number;
  /** Descargas iniciadas que no se pudieron registrar: siguen pendientes (se vuelven a ofrecer). */
  unrecorded: number;
  /** La cola se frenó (sesión vencida o sin permiso): lo que no se pidió sigue pendiente. */
  stopped: string | null;
}

export async function runFeedQueue(jobs: readonly FeedJob[], deps: FeedQueueDeps, options: FeedQueueOptions = {}): Promise<FeedQueueResult> {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const recordEvery = Math.max(1, options.recordEvery ?? 10);
  const saveGapMs = options.saveGapMs ?? 600;
  const retryDelayMs = options.retryDelayMs ?? 1500;
  const queue = [...jobs];
  const result: FeedQueueResult = { total: jobs.length, saved: 0, failed: [], recorded: 0, unrecorded: 0, stopped: null };
  let done = 0;
  let buffer: RecordEntry[] = [];
  // Guardado y registro de a uno, en el orden en que llegan las imágenes.
  let chain: Promise<void> = Promise.resolve();
  const progress = () => { deps.onProgress?.({ total: result.total, done, saved: result.saved, failed: result.failed.length }); };

  const flush = async () => {
    if (!buffer.length) return;
    const entries = buffer;
    buffer = [];
    const ok = await deps.record(entries) || await deps.record(entries);
    if (ok) result.recorded += entries.length;
    else result.unrecorded += entries.length;
  };

  const worker = async () => {
    for (let job = queue.shift(); job !== undefined && result.stopped === null; job = queue.shift()) {
      let outcome = await deps.render(job);
      if (!outcome.ok && outcome.retry && !outcome.fatal) {
        await deps.wait(retryDelayMs);
        outcome = await deps.render(job);
      }
      if (!outcome.ok) {
        if (outcome.fatal) result.stopped = outcome.error;
        result.failed.push({ name: job.name, error: outcome.error });
        done += 1;
        progress();
        continue;
      }
      const ready = outcome;
      const saved = chain.then(async () => {
        deps.save(ready.file);
        result.saved += 1;
        done += 1;
        buffer.push(ready.entry);
        progress();
        if (buffer.length >= recordEvery) await flush();
        await deps.wait(saveGapMs);
      });
      chain = saved;
      // Este trabajador no pide otra imagen hasta que la suya se guardó: memoria acotada a `concurrency` PNG.
      await saved;
    }
  };

  progress();
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, jobs.length)) }, worker));
  await chain;
  await flush();
  return result;
}
