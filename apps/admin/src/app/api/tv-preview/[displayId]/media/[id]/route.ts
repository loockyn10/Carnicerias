import { getAdminContext } from "../../../../../../lib/admin";
import { readSignageMedia } from "../../../../../../lib/signage-media";
import { createClient } from "../../../../../../lib/supabase/server";
import { isUuid } from "../../../../../../lib/uuid";

/**
 * Imagen de la vista previa de una pantalla en el Admin (D-076): como `/api/tv/<token>/media/<id>` pero identificada con la SESIÓN del
 * administrador (la RPC valida la organización y el permiso). La ruta de Storage se saca de la presentación, nunca del pedido.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store, max-age=0" };

export async function GET(_request: Request, { params }: { params: Promise<{ displayId: string; id: string }> }) {
  const { displayId, id } = await params;
  const context = await getAdminContext();
  if (!context || !isUuid(displayId)) return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_signage_display_admin", { p_display_id: displayId });
  if (error) return Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  const result = await readSignageMedia(data, id, async (bucket, storagePath) => {
    const download = await supabase.storage.from(bucket).download(storagePath);
    return download.error ? null : new Uint8Array(await download.data.arrayBuffer());
  });
  if (result.kind === "ok") return new Response(Buffer.from(result.bytes), { status: 200, headers: { ...HEADERS, "Content-Type": result.contentType } });
  return Response.json({ error: result.kind }, { status: result.kind === "not_found" ? 404 : 503, headers: HEADERS });
}
