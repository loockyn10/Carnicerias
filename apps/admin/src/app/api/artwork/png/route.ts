import { getAdminContext } from "../../../../lib/admin";
import { ArtworkExportError, executeArtworkExport, parseArtworkExportRequest, type ArtworkExportDeps } from "../../../../lib/artwork-export";
import { ARTWORK_BUCKET } from "../../../../lib/artwork-photo";
import { createClient } from "../../../../lib/supabase/server";
import { getCurrentUser } from "../../../../lib/supabase/current-user";

/**
 * Descarga el PNG de la pieza «Producto protagonista» o «Collage» (D-074 / D-075): Feed 1080 × 1350 o Story 1080 × 1920.
 *
 * El navegador sólo manda `{ template, productIds, branchId, headline, format }`. Los productos, las fotos, el precio vigente de la
 * sucursal, la promoción, el logo y el contacto se resuelven acá contra la base con la sesión del usuario (la organización y el
 * permiso los valida cada RPC: `get_product_artwork`, `get_artwork_branding`): un precio enviado por el cliente se ignora.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function fail(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: NO_STORE });
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Pedido inválido");
  }
  const parsed = parseArtworkExportRequest(body);
  if (!parsed.ok) return fail(400, parsed.error);

  const deps: ArtworkExportDeps = {
    getFacts: async (productId, branchId) => {
      const { data, error } = await supabase.rpc("get_product_artwork", { p_product_id: productId, ...(branchId ? { p_branch_id: branchId } : {}) });
      if (error) throw new ArtworkExportError(error.code === "42501" ? 403 : 500, error.message);
      return data;
    },
    getBranding: async (branchId) => {
      const { data, error } = await supabase.rpc("get_artwork_branding", branchId ? { p_branch_id: branchId } : {});
      if (error) throw new ArtworkExportError(error.code === "42501" ? 403 : 500, error.message);
      return data;
    },
    readPhoto: async (storagePath) => {
      const { data, error } = await supabase.storage.from(ARTWORK_BUCKET).download(storagePath);
      if (error) return null;
      return { bytes: new Uint8Array(await data.arrayBuffer()) };
    }
  };

  try {
    const result = await executeArtworkExport(deps, parsed.value);
    return new Response(Buffer.from(result.png), {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "X-Artwork-Width": String(result.width),
        "X-Artwork-Height": String(result.height),
        "Access-Control-Expose-Headers": "Content-Disposition, X-Artwork-Width, X-Artwork-Height"
      }
    });
  } catch (error) {
    if (error instanceof ArtworkExportError) return fail(error.status, error.message);
    return fail(500, "No se pudo generar la imagen");
  }
}
