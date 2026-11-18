import { getAdminContext } from "../../../../lib/admin";
import { ARTWORK_BUCKET } from "../../../../lib/artwork-photo";
import { PriceListError } from "../../../../lib/poultry-price-list";
import { priceListImageCache } from "../../../../lib/poultry-price-list-image-cache";
import { executePoultryPriceList, streamBytes } from "../../../../lib/poultry-price-list-png";
import { createClient } from "../../../../lib/supabase/server";
import { getCurrentUser } from "../../../../lib/supabase/current-user";

/**
 * Pollos → «Lista de precios» (D-100): devuelve el PNG con TODOS los productos activos por cajón y su precio vigente de la lista General.
 * El navegador no manda nada: productos y precios se leen acá con la sesión del usuario (`get_poultry_price_board` valida `poultry.read` y la
 * organización), y el logo y el fondo configurados se descargan del bucket privado (`get_poultry_price_list_settings`). Responde el archivo como adjunto y, en encabezados, cuántos productos entraron y cuántos se informan aparte.
 *
 * Lo usan el botón de Pollos del Admin y el del Inicio del celular (D-102): un solo generador. Por descarga: 2 RPC (tablero y configuración
 * de imágenes, siempre frescas) y, sólo si esta instancia no las tiene en memoria, la lectura del logo y del fondo (`priceListImageCache`).
 * La respuesta sale en streaming: el límite de 4,5 MB de Vercel no aplica a respuestas en streaming y una lista larga con foto puede pasarlo.
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
      readImage: (storagePath) => priceListImageCache.read(storagePath, async () => {
        const { data, error } = await supabase.storage.from(ARTWORK_BUCKET).download(storagePath);
        if (error) return null;
        return new Uint8Array(await data.arrayBuffer());
      })
    });
    return new Response(streamBytes(result.png), {
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
