import type { Json } from "@carnicerias/database";

import { getAdminContext } from "../../../../lib/admin";
import { executeLabelRun, LabelRunError, parseLabelRunRequest, type LabelRunDeps } from "../../../../lib/label-run";
import { createClient } from "../../../../lib/supabase/server";
import { getCurrentUser } from "../../../../lib/supabase/current-user";

/**
 * Genera el PDF A4 de etiquetas de un grupo (D-073) y registra la generación.
 *
 * El navegador sólo manda `{ groupId, items: [{ productId, copies }] }`: los precios, las promociones y los nombres se resuelven acá,
 * contra la base, con la sesión del usuario (la organización, el permiso `catalog.write` y la sucursal del grupo los valida cada RPC).
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
  const parsed = parseLabelRunRequest(body);
  if (!parsed.ok) return fail(400, parsed.error);

  const deps: LabelRunDeps = {
    getGroup: async (groupId) => {
      const { data, error } = await supabase.rpc("get_label_group", { p_group_id: groupId });
      if (error) throw new LabelRunError(error.code === "42501" ? 403 : 500, error.message);
      return data;
    },
    recordRun: async (groupId, items) => {
      const { data, error } = await supabase.rpc("record_label_print_run", { p_group_id: groupId, p_items: items as Json });
      if (error) throw new Error(error.message);
      return data;
    }
  };

  try {
    const result = await executeLabelRun(deps, parsed.value, { timeZone: context.timezone });
    return new Response(Buffer.from(result.pdf), {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "X-Label-Run-Id": result.runId,
        "X-Label-Count": String(result.labelCount),
        "X-Label-Pages": String(result.pageCount),
        "Access-Control-Expose-Headers": "Content-Disposition, X-Label-Run-Id, X-Label-Count, X-Label-Pages"
      }
    });
  } catch (error) {
    if (error instanceof LabelRunError) return fail(error.status, error.message);
    return fail(500, "No se pudo generar el PDF");
  }
}
