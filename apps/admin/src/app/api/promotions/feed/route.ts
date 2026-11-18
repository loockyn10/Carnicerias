import { randomUUID } from "node:crypto";

import { getAdminContext } from "../../../../lib/admin";
import { ArtworkExportError } from "../../../../lib/artwork-export";
import { ARTWORK_BUCKET } from "../../../../lib/artwork-photo";
import { localDateString } from "../../../../lib/date-range";
import { feedFilename, parsePromotionFeedState, pendingPromotions, skippedPromotions, type PromotionFeedState } from "../../../../lib/promotion-feed";
import { promotionFeedImageCache } from "../../../../lib/promotion-feed-image-cache";
import { renderPromotionFeed } from "../../../../lib/promotion-feed-render";
import { streamBytes } from "../../../../lib/stream-bytes";
import { getCurrentUser } from "../../../../lib/supabase/current-user";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";

/**
 * «Descargar promociones Feed» (D-103). Un solo punto de entrada, tres acciones, todo bajo demanda (nada se pide al abrir el Inicio):
 *   - `list`   { mode: "pending" | "last" } → las promociones a descargar (pendientes de HOY, o las de la última tanda) y la tanda a usar;
 *   - `render` { promotionId }              → el PNG Feed de ESA promoción con el precio de este momento (una imagen por pedido, binaria y en
 *                                             streaming: sin base64 ni ZIP) y la firma de lo dibujado en `X-Feed-Signature`;
 *   - `record` { batchId, items }           → registra lo que el celular YA empezó a descargar (firma y resumen que devolvió `render`).
 * Sesión + rol administrador; la organización y el permiso los valida cada RPC (`products.read` para leer, `catalog.write` para registrar).
 * Nunca se guarda el PNG: se dibuja, se envía y se olvida. El logo y las fotos (rutas inmutables) se guardan en memoria de la instancia.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const MAX_RECORD_ITEMS = 100;

function fail(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

function rpcStatus(code: string | undefined): number {
  return code === "42501" ? 403 : code === "22023" ? 400 : 500;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  let user;
  try {
    user = await getCurrentUser(supabase);
  } catch (error) {
    return fail(503, error instanceof Error ? error.message : "No se pudo verificar la sesión");
  }
  if (!user) return fail(401, "Tu sesión venció: volvé a iniciar sesión");
  const context = await getAdminContext();
  if (!context) return fail(403, "Esta operación requiere el rol administrador");

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail(400, "Pedido inválido");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, "Pedido inválido");
  }

  const readState = async (args: { p_promotion_ids?: string[]; p_last_batch?: boolean }): Promise<PromotionFeedState> => {
    const { data, error } = await supabase.rpc("get_promotion_feed_state", args);
    if (error) throw new ArtworkExportError(rpcStatus(error.code), error.message);
    const state = parsePromotionFeedState(data);
    if (!state) throw new ArtworkExportError(500, "No se pudieron leer las promociones");
    return state;
  };

  try {
    if (body.action === "list") {
      const last = body.mode === "last";
      const state = await readState(last ? { p_last_batch: true } : {});
      const items = last ? state.items.filter((item) => item.signature !== null) : pendingPromotions(state);
      return Response.json({
        // Repetir la última tanda la sigue registrando en ESA tanda; una descarga nueva abre otra.
        batchId: last ? state.lastBatch?.batchId ?? null : randomUUID(),
        branchName: state.branchName,
        items: items.map((item) => ({ promotionId: item.promotionId, name: item.name })),
        skipped: skippedPromotions(state)
      }, { headers: NO_STORE });
    }

    if (body.action === "render") {
      if (!isUuid(body.promotionId)) return fail(400, "Promoción inválida");
      const state = await readState({ p_promotion_ids: [body.promotionId.toLowerCase()] });
      const item = state.items[0];
      if (!item) return fail(404, "La promoción ya no existe");
      const rendered = await renderPromotionFeed({
        getBranding: async (branchId) => {
          const { data, error } = await supabase.rpc("get_artwork_branding", branchId ? { p_branch_id: branchId } : {});
          if (error) throw new ArtworkExportError(rpcStatus(error.code), error.message);
          return data;
        },
        readPhoto: async (storagePath) => {
          const bytes = await promotionFeedImageCache.read(storagePath, async () => {
            const { data, error } = await supabase.storage.from(ARTWORK_BUCKET).download(storagePath);
            return error ? null : new Uint8Array(await data.arrayBuffer());
          });
          return bytes ? { bytes } : null;
        }
      }, item, { id: state.branchId, name: state.branchName });
      return new Response(streamBytes(rendered.png), {
        status: 200,
        headers: {
          ...NO_STORE,
          "Content-Type": "image/png",
          "Content-Disposition": `attachment; filename="${feedFilename(item, localDateString(context.timezone))}"`,
          "X-Feed-Promotion": item.promotionId,
          "X-Feed-Signature": rendered.signature,
          "X-Feed-Summary": encodeURIComponent(rendered.summary ?? ""),
          "Access-Control-Expose-Headers": "Content-Disposition, X-Feed-Promotion, X-Feed-Signature, X-Feed-Summary"
        }
      });
    }

    if (body.action === "record") {
      if (!isUuid(body.batchId)) return fail(400, "Tanda inválida");
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_RECORD_ITEMS) return fail(400, "Pedido inválido");
      const items: { promotionId: string; signature: string; summary: string | null }[] = [];
      for (const entry of body.items as unknown[]) {
        const record = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : {};
        if (!isUuid(record.promotionId) || typeof record.signature !== "string" || !/^[0-9a-f]{64}$/.test(record.signature)) return fail(400, "Registro inválido");
        items.push({
          promotionId: record.promotionId.toLowerCase(), signature: record.signature,
          summary: typeof record.summary === "string" && record.summary.trim() !== "" ? record.summary.trim().slice(0, 200) : null
        });
      }
      const { data, error } = await supabase.rpc("record_promotion_feed_downloads", { p_batch_id: body.batchId.toLowerCase(), p_items: items });
      if (error) return fail(rpcStatus(error.code), error.code === "22023" ? "Registro inválido" : error.message);
      return Response.json({ recorded: data }, { headers: NO_STORE });
    }

    return fail(400, "Acción inválida");
  } catch (error) {
    if (error instanceof ArtworkExportError) return fail(error.status, error.message);
    return fail(500, "No se pudo generar la imagen");
  }
}
