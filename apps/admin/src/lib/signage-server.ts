import { createClient } from "@supabase/supabase-js";

import type { Database } from "@carnicerias/database";

import { buildSignageView, isWellFormedToken, type SignageView } from "./signage";
import type { SignageLoadResult } from "./signage-player";
import { getSupabasePublicEnv } from "./supabase/env";

/**
 * Lectura PÚBLICA de la cartelería (sin login). Usa la clave pública (anon) y SIN sesión: aunque el navegador del televisor tuviera
 * cookies del Admin, esta ruta nunca las usa. La única puerta es la RPC `get_signage_display(token)`, que valida el token por hash y
 * devuelve exclusivamente los hechos comerciales de SU pantalla; el precio «llevando N» se calcula acá con el motor de pricing.
 */
export async function loadPublicSignage(token: string): Promise<SignageLoadResult> {
  if (!isWellFormedToken(token)) return { kind: "not_found" };
  try {
    const { url, publishableKey } = getSupabasePublicEnv();
    const supabase = createClient<Database>(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { data, error } = await supabase.rpc("get_signage_display", { p_token: token });
    if (error) return { kind: "error" };
    if (data === null) return { kind: "not_found" };
    const view: SignageView | null = buildSignageView(data);
    return view ? { kind: "ok", view } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}
