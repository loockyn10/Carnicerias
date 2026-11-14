/**
 * Recuperación de la sesión técnica de Supabase (lógica pura, sin importar el cliente).
 *
 * Por qué existe: supabase-js decide si el access token vive todavía comparando `expires_at` (fecha
 * ABSOLUTA del servidor) con el reloj de la PC. Si ese reloj está atrasado, o la sesión quedó vieja
 * mientras no había Internet, el cliente sigue mandando un JWT que PostgREST ya rechaza
 * (`PGRST303 JWT expired`) y nada en el POS reaccionaba: ni renovaba ni dejaba entrar con la
 * autorización local. Acá viven:
 *
 *   - la clasificación de errores (JWT vencido / sesión inválida / sin conexión / otro);
 *   - un `fetch` que, ante un 401 por JWT vencido en PostgREST, fuerza UNA renovación y reintenta
 *     la misma llamada UNA vez (las RPC del POS son idempotentes o de sólo lectura; un 401 de
 *     PostgREST se rechaza antes de ejecutar nada);
 *   - la renovación en un solo vuelo (single-flight) con enfriamiento tras un fallo;
 *   - la estimación del desfase del reloj de la PC contra el servidor.
 *
 * No toca SQLite, ni PIN, ni permisos: sólo decide cuándo reintentar con un token nuevo.
 */

export type AuthFailureKind = "jwt-expired" | "session-invalid" | "connectivity" | "other";

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
}

const CONNECTIVITY_MESSAGE = /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet|err_network|err_name_not_resolved|timed? ?out|econnreset|econnrefused|enotfound/i;
const SESSION_INVALID_CODES = new Set([
  "PGRST301", // JWT inválido (firma/formato)
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
  "bad_jwt"
]);
// PostgREST no pudo hablar con su base: el servidor no está disponible, no es un problema del token.
const CONNECTIVITY_CODES = new Set(["PGRST000", "PGRST001", "PGRST002"]);

function asErrorLike(error: unknown): ErrorLike | null {
  if (error instanceof Error) return error;
  if (error && typeof error === "object") return error;
  if (typeof error === "string") return { message: error };
  return null;
}

/** Clasifica un error de Supabase/PostgREST/fetch. Nunca mira PIN ni tokens: sólo code/name/message. */
export function classifyAuthFailure(error: unknown): AuthFailureKind {
  const record = asErrorLike(error);
  if (!record) return "other";
  const code = typeof record.code === "string" ? record.code : "";
  const name = typeof record.name === "string" ? record.name : "";
  const message = typeof record.message === "string" ? record.message : "";

  if (code === "PGRST303" || /jwt expired/i.test(message)) return "jwt-expired";
  if (SESSION_INVALID_CODES.has(code) || name === "AuthSessionMissingError" || /auth session missing|invalid refresh token|refresh token not found|refresh_token_not_found|\binvalid jwt\b/i.test(message)) return "session-invalid";
  if (CONNECTIVITY_CODES.has(code) || name === "AuthRetryableFetchError" || CONNECTIVITY_MESSAGE.test(message)) return "connectivity";
  return "other";
}

/** Errores tras los cuales el empleado puede seguir con la autorización local (no son "PIN incorrecto"). */
export function isRecoverableWithLocalAuthorization(kind: AuthFailureKind): boolean {
  return kind !== "other";
}

/** Un 401 de PostgREST por JWT vencido: cuerpo `{"code":"PGRST303","message":"JWT expired"}`. */
export async function isJwtExpiredResponse(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body: unknown = await response.json();
    return classifyAuthFailure(body) === "jwt-expired";
  } catch {
    return false;
  }
}

// --- Desfase del reloj ----------------------------------------------------------------------

/** Mínimo desfase que consideramos "reloj mal puesto" (1 minuto). */
export const CLOCK_SKEW_WARNING_MS = 60_000;

interface SessionTimes { expires_at?: number | undefined; expires_in?: number | undefined }

/**
 * Para una sesión RECIÉN emitida por el servidor, `expires_at - expires_in` es la hora del
 * servidor en ese instante. Positivo = la PC está adelantada; negativo = atrasada.
 */
export function estimateClockSkewMs(session: SessionTimes, localNowMs: number): number | null {
  if (typeof session.expires_at !== "number" || typeof session.expires_in !== "number") return null;
  return localNowMs - (session.expires_at - session.expires_in) * 1000;
}

export function describeClockSkew(skewMs: number | null): string | null {
  if (skewMs === null || Math.abs(skewMs) < CLOCK_SKEW_WARNING_MS) return null;
  const minutes = Math.round(Math.abs(skewMs) / 60_000);
  return `el reloj de esta PC está ${String(minutes)} min ${skewMs < 0 ? "atrasado" : "adelantado"} respecto del servidor: corregí fecha y hora de Windows`;
}

// --- Renovación single-flight -----------------------------------------------------------------

export interface RefreshedSession {
  access_token: string;
  expires_at?: number | undefined;
  expires_in?: number | undefined;
}

export interface SessionRefresherDeps {
  /** `supabase.auth.refreshSession()`: ignora la hora local y pide un token nuevo con el refresh token guardado. */
  refresh: () => Promise<{ data: { session: RefreshedSession | null }; error: unknown }>;
  nowMs?: () => number;
  /** Tras un fallo no se vuelve a pedir durante este tiempo (evita una tormenta de /token con la caja sin Internet). */
  failureCooldownMs?: number;
}

export interface SessionRefresher {
  /**
   * Devuelve un access token distinto de `rejectedToken`: el ya renovado por otro pedido, o uno nuevo.
   * `null` si no se pudo (sin sesión, sin Internet o refresh token revocado).
   */
  refreshAccessToken: (rejectedToken: string | null) => Promise<string | null>;
  /** Registra una sesión recién emitida (SIGNED_IN / TOKEN_REFRESHED) para conocer el token vigente y el desfase del reloj. */
  noteSession: (session: RefreshedSession) => void;
  clockSkewMs: () => number | null;
  lastFailure: () => AuthFailureKind | null;
}

export const DEFAULT_REFRESH_FAILURE_COOLDOWN_MS = 15_000;

export function createSessionRefresher(deps: SessionRefresherDeps): SessionRefresher {
  const nowMs = deps.nowMs ?? Date.now;
  const cooldownMs = deps.failureCooldownMs ?? DEFAULT_REFRESH_FAILURE_COOLDOWN_MS;
  let inFlight: Promise<string | null> | null = null;
  let currentToken: string | null = null;
  let skewMs: number | null = null;
  let failure: { at: number; kind: AuthFailureKind } | null = null;

  function noteSession(session: RefreshedSession): void {
    currentToken = session.access_token;
    const estimate = estimateClockSkewMs(session, nowMs());
    if (estimate !== null) skewMs = estimate;
  }

  async function runRefresh(): Promise<string | null> {
    try {
      const { data, error } = await deps.refresh();
      if (error || !data.session) {
        failure = { at: nowMs(), kind: error ? classifyAuthFailure(error) : "session-invalid" };
        return null;
      }
      failure = null;
      noteSession(data.session);
      return data.session.access_token;
    } catch (error) {
      failure = { at: nowMs(), kind: classifyAuthFailure(error) };
      return null;
    }
  }

  return {
    refreshAccessToken(rejectedToken) {
      // Otro pedido ya renovó mientras éste viajaba: basta reintentar con el token vigente.
      if (currentToken && rejectedToken && currentToken !== rejectedToken) return Promise.resolve(currentToken);
      if (inFlight) return inFlight;
      if (failure && nowMs() - failure.at < cooldownMs) return Promise.resolve(null);
      inFlight = runRefresh().finally(() => { inFlight = null; });
      return inFlight;
    },
    noteSession,
    clockSkewMs: () => skewMs,
    lastFailure: () => failure?.kind ?? null
  };
}

// --- fetch con recuperación -------------------------------------------------------------------

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
export type FetchLike = (input: FetchInput, init?: FetchInit) => Promise<Response>;

function urlOf(input: FetchInput): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return null; // Request: el cuerpo ya no es reutilizable, no se reintenta.
}

/**
 * Envuelve el `fetch` de supabase-js. Sólo actúa sobre PostgREST (`/rest/v1/`): un 401 `PGRST303`
 * dispara una renovación forzada y UN reintento con el token nuevo. Si no se puede renovar devuelve
 * la respuesta original, para que el llamador vea el error real y use la autorización local.
 */
export function createSessionRecoveringFetch(options: {
  baseFetch: FetchLike;
  refreshAccessToken: (rejectedToken: string | null) => Promise<string | null>;
}): FetchLike {
  return async (input, init) => {
    const response = await options.baseFetch(input, init);
    if (response.status !== 401) return response;
    const url = urlOf(input);
    if (!url?.includes("/rest/v1/")) return response;
    if (!(await isJwtExpiredResponse(response.clone()))) return response;

    const headers = new Headers(init?.headers);
    const rejected = headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    const fresh = await options.refreshAccessToken(rejected);
    if (!fresh) return response;

    headers.set("Authorization", `Bearer ${fresh}`);
    return options.baseFetch(input, { ...init, headers });
  };
}

// --- Recuperar la sesión en línea tras un corte ----------------------------------------------------

export interface SessionAuthLike {
  getSession: () => Promise<{ data: { session: { user: { id: string; email?: string | undefined } } | null }; error: unknown }>;
}

export type OnlineRecovery =
  | { status: "online"; user: { id: string; email: string } }
  | { status: "unreachable" }
  | { status: "no-session" };

/**
 * ¿Se puede volver a la sesión en línea? `getSession()` renueva sola si el token venció y hay Internet;
 * si no hay red devuelve error de conectividad y la sesión guardada se conserva para el próximo intento.
 */
export async function recoverOnlineSession(auth: SessionAuthLike): Promise<OnlineRecovery> {
  try {
    const { data, error } = await auth.getSession();
    if (data.session) return { status: "online", user: { id: data.session.user.id, email: data.session.user.email ?? data.session.user.id } };
    if (error && classifyAuthFailure(error) === "connectivity") return { status: "unreachable" };
    return { status: "no-session" };
  } catch (error) {
    return classifyAuthFailure(error) === "connectivity" ? { status: "unreachable" } : { status: "no-session" };
  }
}
