import { createSupabaseClient } from "@carnicerias/database";

import { createSessionRecoveringFetch, createSessionRefresher } from "./session-recovery";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY in apps/pos/.env.local"
  );
}

// Ante un `PGRST303 JWT expired` en PostgREST se fuerza una renovación (que ignora el reloj local) y se
// reintenta UNA vez la misma llamada. Ver ./session-recovery para el motivo y los límites.
const sessionRefresher = createSessionRefresher({
  refresh: () => supabase.auth.refreshSession()
});

export const supabase = createSupabaseClient({
  url,
  anonKey: publishableKey,
  fetch: createSessionRecoveringFetch({
    baseFetch: (input, init) => globalThis.fetch(input, init),
    refreshAccessToken: sessionRefresher.refreshAccessToken
  })
});

// Cada sesión recién emitida enseña qué token está vigente y cuánto difiere el reloj de la PC del servidor.
// (El callback sólo anota datos: no puede llamar a `supabase.auth.*` desde acá.)
supabase.auth.onAuthStateChange((event, session) => {
  if (session && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) sessionRefresher.noteSession(session);
});

/** Desfase estimado del reloj de la PC contra Supabase en ms (null si aún no se emitió ninguna sesión). */
export function getClockSkewMs(): number | null {
  return sessionRefresher.clockSkewMs();
}
