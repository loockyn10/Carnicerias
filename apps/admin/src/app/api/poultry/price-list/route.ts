import { getAdminContext } from "../../../../lib/admin";
import { ARTWORK_BUCKET } from "../../../../lib/artwork-photo";
import { PriceListError } from "../../../../lib/poultry-price-list";
import { executePoultryPriceList } from "../../../../lib/poultry-price-list-png";
import { createClient } from "../../../../lib/supabase/server";
import { getCurrentUser } from "../../../../lib/supabase/current-user";

/**
 * Pollos → «Lista de precios» (D-100): devuelve el PNG con TODOS los productos activos por cajón y su precio vigente de la lista General.
 * El navegador no manda nada: productos y precios se leen acá con la sesión del usuario (`get_poultry_price_board` valida `poultry.read` y la
 * organización), y el logo y el fondo configurados se descargan del bucket privado (`get_poultry_price_list_settings`). Responde el archivo como adjunto y, en encabezados, cuántos productos entraron y cuántos se informan aparte.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function fail(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

export async function POST() {
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

  try {
    const result = await executePoultryPriceList({
      timeZone: context.timezone,
      getBoard: async () => {
        const { data, error } = await supabase.rpc("get_poultry_price_board");
        if (error) throw new PriceListError(error.code === "42501" ? 403 : 500, error.message);
        return data;
      },
      getSettings: async () => {
        const { data, error } = await supabase.rpc("get_poultry_price_list_settings");
        if (error) throw new PriceListError(error.code === "42501" ? 403 : 500, error.message);
        return data;
      },
      readImage: async (storagePath) => {
        const { data, error } = await supabase.storage.from(ARTWORK_BUCKET).download(storagePath);
        if (error) return null;
        return new Uint8Array(await data.arrayBuffer());
      }
    });
    return new Response(Buffer.from(result.png), {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "X-Price-List-Products": String(result.products),
        "X-Price-List-Omitted-Weight": String(result.omittedByWeight),
        "X-Price-List-Missing-Price": String(result.missingPrice),
        "X-Price-List-Missing-Logo": result.hasLogo ? "0" : "1",
        "Access-Control-Expose-Headers": "Content-Disposition, X-Price-List-Products, X-Price-List-Omitted-Weight, X-Price-List-Missing-Price, X-Price-List-Missing-Logo"
      }
    });
  } catch (error) {
    if (error instanceof PriceListError) return fail(error.status, error.message);
    return fail(500, "No se pudo generar la lista de precios");
  }
}
