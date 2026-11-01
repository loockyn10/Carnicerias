import type { VacuumPrintKind } from "../../../../lib/vacuum";
import { getAdminContext } from "../../../../lib/admin";
import { getCurrentUser } from "../../../../lib/supabase/current-user";
import { createClient } from "../../../../lib/supabase/server";
import { executeVacuumPrint, parseVacuumPrintRequest, VacuumPrintError, type VacuumPrintDeps } from "../../../../lib/vacuum-print-run";

/**
 * Genera el PDF de las etiquetas térmicas de un paquete ya registrado (Informativa, Precio o ambas) y registra la impresión / reimpresión.
 *
 * El navegador sólo manda `{ packageId, kind }`: el contenido sale del snapshot guardado en la base, leído con la sesión del usuario (la organización,
 * la sucursal y el permiso los valida cada RPC). El PDF mide exactamente el papel de cada etiqueta y se imprime desde el navegador de la computadora
 * conectada a la impresora térmica: no hay impresión remota ni RAW.
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
  const parsed = parseVacuumPrintRequest(body);
  if (!parsed.ok) return fail(400, parsed.error);

  const deps: VacuumPrintDeps = {
    getPackage: async (packageId) => {
      const { data, error } = await supabase.rpc("get_vacuum_package", { p_package_id: packageId });
      if (error) throw new VacuumPrintError(error.code === "42501" ? 403 : 500, error.message);
      return data;
    },
    recordPrint: async (packageId, kind: VacuumPrintKind) => {
      const { error } = await supabase.rpc("record_vacuum_print", { p_package_id: packageId, p_kind: kind });
      if (error) throw new VacuumPrintError(error.code === "42501" ? 403 : 500, error.message);
    }
  };

  try {
    const result = await executeVacuumPrint(deps, parsed.value);
    return new Response(Buffer.from(result.pdf), {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${result.filename}"`,
        "X-Label-Pages": String(result.pageCount),
        "X-Label-Overflow": result.overflow.join(","),
        "Access-Control-Expose-Headers": "Content-Disposition, X-Label-Pages, X-Label-Overflow"
      }
    });
  } catch (error) {
    if (error instanceof VacuumPrintError) return fail(error.status, error.message);
    return fail(500, "No se pudo generar el PDF");
  }
}
