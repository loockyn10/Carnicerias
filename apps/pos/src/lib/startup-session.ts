/**
 * Qué "usuario técnico" usa el POS al arrancar. Lógica pura (antes inline en App.tsx).
 *
 *   - Con Internet y una sesión de Supabase restaurada del almacenamiento del webview -> usuario EN LÍNEA.
 *   - Si no, y la autorización local sigue vigente en SQLite -> usuario `offline: true` (la caja vende
 *     con lo guardado; NO sincroniza ni puede llamar a Edge Functions/RPC con un JWT real).
 *   - Si no hay ninguna de las dos -> null (la caja necesita configuración).
 *
 * El segundo caso con Internet disponible es una caja "degradada" (ver `isSessionDegraded`): ocurre,
 * por ejemplo, con `tauri dev`, que sirve la app desde `http://localhost:1420` y por eso no ve la
 * sesión guardada por la app instalada (otro origen => otro localStorage), aunque comparte la SQLite.
 */
export interface StartupUser {
  id: string;
  email: string;
  offline: boolean;
}

export interface StartupRuntime {
  profileId: string | null;
  userEmail: string | null;
  deviceStatus: "UNREGISTERED" | "ACTIVE" | "DISABLED";
  authorizationExpiresAt: string | null;
}

export function resolveStartupUser(input: {
  browserOnline: boolean;
  session: { id: string; email: string | null | undefined } | null;
  runtime: StartupRuntime | null;
  nowMs: number;
}): StartupUser | null {
  const { browserOnline, session, runtime, nowMs } = input;
  if (browserOnline && session) return { id: session.id, email: session.email ?? session.id, offline: false };
  if (
    runtime?.profileId && runtime.userEmail && runtime.deviceStatus === "ACTIVE" &&
    runtime.authorizationExpiresAt && new Date(runtime.authorizationExpiresAt).getTime() > nowMs
  ) {
    // (condición idéntica a la que estaba inline en App.tsx; sólo se extrajo)
    return { id: runtime.profileId, email: runtime.userEmail, offline: true };
  }
  return null;
}
