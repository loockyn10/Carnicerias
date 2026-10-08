import { createClient } from "@supabase/supabase-js";

import type { Database } from "@carnicerias/database";

import { buildSignageView, isWellFormedToken, type SignageView } from "./signage";
import { readSignageMedia, signageMediaUrls, type SignageMediaResult } from "./signage-media";
import type { SignageLoadResult } from "./signage-player";
import { getSupabasePublicEnv } from "./supabase/env";

/**
 * Lectura PÚBLICA de la cartelería (sin login). Usa la clave pública (anon) y SIN sesión: aunque el navegador del televisor tuviera
 * cookies del Admin, esta ruta nunca las usa. La única puerta es la RPC `get_signage_display(token)`, que valida el token por hash y
 * devuelve exclusivamente los hechos comerciales de SU pantalla; el precio «llevando N» se calcula acá con el motor de pricing.
 * Las imágenes (foto del producto y logo) se sirven por `/api/tv/<token>/media/<id>` (D-076): ver `signage-media.ts`.
 */
function publicClient() {
  const { url, publishableKey } = getSupabasePublicEnv();
  return createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

type PublicPayload = { kind: "ok"; payload: unknown } | { kind: "not_found" } | { kind: "error" };

async function loadPayload(supabase: ReturnType<typeof publicClient>, token: string): Promise<PublicPayload> {
  const { data, error } = await supabase.rpc("get_signage_display", { p_token: token });
  if (error) return { kind: "error" };
  if (data === null) return { kind: "not_found" };
  return { kind: "ok", payload: data };
}

export async function loadPublicSignage(token: string): Promise<SignageLoadResult> {
  if (!isWellFormedToken(token)) return { kind: "not_found" };
  try {
    const loaded = await loadPayload(publicClient(), token);
    if (loaded.kind !== "ok") return loaded;
    const view: SignageView | null = buildSignageView(loaded.payload, signageMediaUrls(`/api/tv/${token}`));
    return view ? { kind: "ok", view } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** Imagen `id` (id de una diapositiva o `logo`) de la pantalla de ESE token: la ruta se saca de la presentación publicada, nunca del pedido. */
export async function loadPublicSignageMedia(token: string, id: string): Promise<SignageMediaResult> {
  if (!isWellFormedToken(token)) return { kind: "not_found" };
  try {
    const supabase = publicClient();
    const loaded = await loadPayload(supabase, token);
    if (loaded.kind !== "ok") return loaded;
    return await readSignageMedia(loaded.payload, id, async (bucket, storagePath) => {
      const { data, error } = await supabase.storage.from(bucket).download(storagePath);
      return error ? null : new Uint8Array(await data.arrayBuffer());
    });
  } catch {
    return { kind: "error" };
  }
}
