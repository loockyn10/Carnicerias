/**
 * Identidad del build que está corriendo. Todos los instaladores del POS se llaman igual («0.1.0»), así que la única forma de saber si una caja
 * tiene el código nuevo es esta marca (fecha de compilación + commit), que Vite inyecta al compilar y que se ve en el panel de diagnóstico.
 */
export interface BuildInfo {
  version: string;
  /** Fecha y hora de compilación (ISO) o null en desarrollo. */
  builtAt: string | null;
  /** Commit corto de git; termina en «+» si había cambios sin commitear. null si no se pudo leer. */
  commit: string | null;
  label: string;
}

export function describeBuild(version: string, builtAt: string | null, commit: string | null): BuildInfo {
  const when = builtAt ? builtAt.slice(0, 16).replace("T", " ") : "desarrollo";
  return { version, builtAt, commit, label: `${version} · build ${when}${commit ? ` · ${commit}` : ""}` };
}

export const BUILD_INFO: BuildInfo = typeof __POS_BUILD__ === "undefined"
  ? describeBuild("dev", null, null)
  : describeBuild(__POS_BUILD__.version, __POS_BUILD__.builtAt, __POS_BUILD__.commit);
