import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Resolves the signed-in user, telling "no valid session" apart from "could not check".
 *
 * Only a confirmed absence (no cookie, or the auth server rejected the token) returns null, which is
 * the one case callers may send to /login. A network failure or a 5xx from Supabase Auth (for example
 * Windows just booted and the network is not up yet) throws instead, so a perfectly valid persisted
 * session is never mistaken for a logged-out one; the error boundary offers "Reintentar".
 */
export async function getCurrentUser(supabase: SupabaseClient): Promise<User | null> {
  const { data, error } = await supabase.auth.getUser();
  if (data.user) return data.user;
  if (error) {
    const status = (error as { status?: number }).status;
    const transient = error.name === "AuthRetryableFetchError" || status === undefined || status === 0 || status >= 500;
    // AuthSessionMissingError has no status: it is the "no cookie" case, not a failure.
    if (transient && error.name !== "AuthSessionMissingError") throw new Error("No se pudo verificar la sesión. Revisá la conexión y reintentá.");
  }
  return null;
}
