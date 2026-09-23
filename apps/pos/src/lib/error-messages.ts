/**
 * Tauri v2's `invoke()` rejects Rust `Result<T, String>` commands with the raw
 * string, not an `Error` instance (see @tauri-apps/api/core `invoke`, which just
 * forwards `window.__TAURI_INTERNALS__.invoke`'s rejection as-is). Callers that
 * only check `error instanceof Error` silently drop that message.
 *
 * Supabase/Postgrest errors and some browser/runtime rejections instead arrive
 * as plain objects (`{ message }`, `{ error }`, `{ details }`, `{ code, message }`)
 * rather than strings or `Error` instances, so those shapes are handled too.
 */
export function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "error", "details"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return fallback;
}

// Looks like a JWT (Supabase access/anon/service tokens, operator tokens) or a
// Supabase publishable/secret key — redacted defensively even though callers
// only ever pass message/code/details/hint, never PIN or token fields directly.
const SENSITIVE_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+\b/g;

function redact(value: string): string {
  return value.replace(SENSITIVE_PATTERN, "[REDACTED]");
}

export interface CaughtValueDiagnostics {
  type: string;
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}

/**
 * Sanitized diagnostic view of a caught value, for temporary UI/console display
 * while tracking down what a given failure actually rejects with. Only reads a
 * fixed allowlist of fields (message/error/details/code/hint) — never dumps the
 * full object — so it cannot surface an operator token, anon key or PIN even if
 * those happened to be present on the thrown value.
 */
// exactOptionalPropertyTypes forbids assigning `undefined` to an optional field
// directly — only omitted keys count as "absent" — so optional fields are added
// conditionally via spread instead of via an object literal with undefined values.
function withDefined<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, string>>;
}

export function describeCaughtValue(error: unknown): CaughtValueDiagnostics {
  if (error instanceof Error) {
    const record = error as unknown as Record<string, unknown>;
    return {
      type: error.name || "Error",
      ...withDefined("message", redact(error.message)),
      ...withDefined("code", typeof record.code === "string" ? record.code : undefined),
      ...withDefined("details", typeof record.details === "string" ? redact(record.details) : undefined),
      ...withDefined("hint", typeof record.hint === "string" ? redact(record.hint) : undefined)
    };
  }
  if (typeof error === "string") {
    return { type: "string", ...withDefined("message", error.trim().length > 0 ? redact(error) : undefined) };
  }
  if (error === null) return { type: "null" };
  if (error === undefined) return { type: "undefined" };
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const pick = (key: string): string | undefined => {
      const value = record[key];
      return typeof value === "string" && value.trim().length > 0 ? redact(value) : undefined;
    };
    return {
      type: Array.isArray(error) ? "array" : "object",
      ...withDefined("message", pick("message") ?? pick("error")),
      ...withDefined("code", pick("code")),
      ...withDefined("details", pick("details")),
      ...withDefined("hint", pick("hint"))
    };
  }
  return { type: typeof error };
}

export function formatDiagnostics(diagnostics: CaughtValueDiagnostics): string {
  const parts = [`tipo=${diagnostics.type}`];
  if (diagnostics.code) parts.push(`code=${diagnostics.code}`);
  if (diagnostics.message) parts.push(`message="${diagnostics.message}"`);
  if (diagnostics.details) parts.push(`details="${diagnostics.details}"`);
  if (diagnostics.hint) parts.push(`hint="${diagnostics.hint}"`);
  return parts.join(" ");
}
