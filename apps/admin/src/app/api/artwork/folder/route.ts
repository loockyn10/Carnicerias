import { getAdminContext } from "../../../../lib/admin";
import { ArtworkExportError } from "../../../../lib/artwork-export";
import { pieceToLine, prepareFolderGeneration, parseFolderGenerationRequest, renderFolderPieces, type FolderGenerationDeps, type FolderStreamLine, type PreparedFolderGeneration } from "../../../../lib/artwork-folder-export";
import { ARTWORK_BUCKET } from "../../../../lib/artwork-photo";
import { getCurrentUser } from "../../../../lib/supabase/current-user";
import { createClient } from "../../../../lib/supabase/server";

/**
 * «Generar todo actualizado» de una carpeta (D-086): dibuja en el servidor las piezas Feed/Story de un LOTE de elementos (hasta 6) con el
 * precio, la promoción y la foto VIGENTES en este momento. El Admin reparte la carpeta en lotes y los pide de a dos: así 30 piezas no
 * bloquean la pantalla ni un único pedido gigante, y un lote que falle no se lleva puestos a los demás.
 *
 * El navegador sólo manda `{ folderId, branchId, itemIds, formats, headline }`; la organización y el permiso los valida cada RPC.
 * La respuesta es un STREAM (NDJSON): una línea por pieza apenas se dibuja —con su estado OK / SKIPPED / ERROR y su PNG en base64— y una
 * línea final de cierre; un precio o un nombre enviado por el cliente se ignora. Si el lote entero no se puede resolver, responde JSON con el estado HTTP.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

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
  const parsed = parseFolderGenerationRequest(body);
  if (!parsed.ok) return fail(400, parsed.error);

  const deps: FolderGenerationDeps = {
    getFolderFacts: async (folderId, branchId, itemIds) => {
      const { data, error } = await supabase.rpc("get_signage_folder_facts", { p_folder_id: folderId, p_item_ids: itemIds, ...(branchId ? { p_branch_id: branchId } : {}) });
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

  // 1) Todo lo del lote se resuelve ANTES de empezar a responder: si la carpeta no existe o la identidad no se lee, el estado HTTP lo dice.
  let prepared: PreparedFolderGeneration;
  try {
    prepared = await prepareFolderGeneration(deps, parsed.value);
  } catch (error) {
    if (error instanceof ArtworkExportError) return fail(error.status, error.message);
    return fail(500, "No se pudieron generar las piezas");
  }

  // 2) Las piezas salen de a una en cuanto están dibujadas (NDJSON): ninguna respuesta junta todos los PNG (hay un tope de tamaño por
  //    respuesta en el hosting) y el Admin muestra el avance pieza por pieza. Un error en una pieza viaja en ELLA; las demás siguen.
  const encoder = new TextEncoder();
  const generation = parsed.value;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (line: FolderStreamLine) => { if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)); };
      try {
        await renderFolderPieces(prepared, generation, (piece) => { write(pieceToLine(piece)); });
        write({ type: "done", folderName: prepared.facts.name });
      } catch {
        write({ type: "error", message: "No se pudieron generar las piezas" });
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() { cancelled = true; }
  });
  return new Response(stream, { status: 200, headers: { ...NO_STORE, "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" } });
}
