import { getAdminContext } from "../../../../lib/admin";
import { createOfferSignDeps } from "../../../../lib/offer-sign-supabase";
import { executeOfferSignRun, OfferSignError, parseOfferSignRequest } from "../../../../lib/offer-sign-run";
import { createClient } from "../../../../lib/supabase/server";
import { getCurrentUser } from "../../../../lib/supabase/current-user";

/**
 * Genera el PDF A4 apaisado de carteles de ofertas (D-087): tira de 3 por hoja o cartel grande de 1 por hoja.
 *
 * El navegador sólo manda `{ branchId, format, promotionIds }`: promociones, precios, condiciones y logo se resuelven acá contra la base con la
 * sesión del usuario (la organización y el permiso los valida cada RPC). No se guarda nada.
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
  const parsed = parseOfferSignRequest(body);
  if (!parsed.ok) return fail(400, parsed.error);

  try {
    const result = await executeOfferSignRun(createOfferSignDeps(supabase), parsed.value, { timeZone: context.timezone });
    return new Response(Buffer.from(result.pdf), {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "X-Sign-Count": String(result.signCount),
        "X-Sign-Pages": String(result.pageCount),
        "Access-Control-Expose-Headers": "Content-Disposition, X-Sign-Count, X-Sign-Pages"
      }
    });
  } catch (error) {
    if (error instanceof OfferSignError) return fail(error.status, error.message);
    return fail(500, "No se pudo generar el PDF");
  }
}
