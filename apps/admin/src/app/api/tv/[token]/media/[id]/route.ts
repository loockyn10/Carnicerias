import { loadPublicSignageMedia } from "../../../../../../lib/signage-server";

/**
 * Imagen de una diapositiva del televisor (foto comercial o logo) de SU token (D-076). Sólo lectura, sin login: el servidor valida
 * el token, saca la ruta de la presentación publicada y devuelve los bytes (el bucket sigue privado). La URL lleva `?v=<archivo>`,
 * que cambia con cada foto nueva: el televisor la guarda en caché sin quedar con una imagen vieja.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  const result = await loadPublicSignageMedia(token, id);
  if (result.kind === "ok") {
    return new Response(Buffer.from(result.bytes), {
      status: 200,
      headers: { ...HEADERS, "Content-Type": result.contentType, "Cache-Control": "private, max-age=31536000, immutable" }
    });
  }
  const status = result.kind === "not_found" ? 404 : 503;
  return Response.json({ error: result.kind === "not_found" ? "not_found" : "unavailable" }, { status, headers: { ...HEADERS, "Cache-Control": "no-store, max-age=0" } });
}
