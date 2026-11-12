import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regresión del error de producción «Attempted to call shelfLifeSummary() from the server but shelfLifeSummary is on the client»: una función
 * exportada desde un módulo "use client" NO se puede invocar desde un Server Component (sólo renderizarlo como componente o pasarlo como prop). El build
 * y las pruebas con jsdom/vitest no lo detectan (no hay frontera cliente/servidor), así que se revisa el código fuente: ninguna página ni layout del
 * servidor llama a algo importado de un módulo cliente.
 */
const SRC = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const isClientModule = (source: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* siguiente */ }
  }
  return null;
}

/** Nombres (con su alias local) que un archivo importa de `specifier`, sin los `type`. */
export function importedValueNames(source: string): { specifier: string; local: string }[] {
  const result: { specifier: string; local: string }[] = [];
  for (const match of source.matchAll(/import\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = match[1] ?? "";
    const specifier = match[2] ?? "";
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
    for (const part of named.split(",")) {
      const item = part.trim();
      if (!item || item.startsWith("type ")) continue;
      result.push({ specifier, local: (item.split(/\s+as\s+/).pop() ?? item).trim() });
    }
  }
  return result;
}

/** Llamadas `nombre(` a funciones importadas de módulos "use client" desde un archivo de servidor. */
export function clientFunctionCalls(file: string): string[] {
  const source = readFileSync(file, "utf8");
  if (isClientModule(source)) return [];
  const offenders: string[] = [];
  for (const { specifier, local } of importedValueNames(source)) {
    const target = resolveImport(file, specifier);
    if (!target || !isClientModule(readFileSync(target, "utf8"))) continue;
    if (new RegExp(String.raw`(?<![<.\w])${local}\s*\(`).test(source)) offenders.push(`${path.relative(SRC, file)} llama a ${local}() importada de ${path.relative(SRC, target)}`);
  }
  return offenders;
}

describe("frontera servidor/cliente de Next.js", () => {
  it("ninguna página, layout ni ruta del servidor llama a una función exportada por un módulo \"use client\"", () => {
    const serverFiles = walk(path.join(SRC, "app")).filter((file) => /(?:^|\/)(?:page|layout|template|default)\.tsx$/.test(file.split(path.sep).join("/")));
    expect(serverFiles.length).toBeGreaterThan(20);
    expect(serverFiles.flatMap(clientFunctionCalls)).toEqual([]);
  });

  it("el detector reconoce el caso que rompió producción", () => {
    const sample = [
      "import { shelfLifeSummary, Boton } from \"../components/vacuum-settings-forms\";",
      "export default function Page() { return <Boton label={shelfLifeSummary(row).text} />; }"
    ].join("\n");
    expect(importedValueNames(sample)).toEqual([{ specifier: "../components/vacuum-settings-forms", local: "shelfLifeSummary" }, { specifier: "../components/vacuum-settings-forms", local: "Boton" }]);
  });

  it("la configuración de Envasados no depende de funciones del módulo cliente", () => {
    expect(clientFunctionCalls(path.join(SRC, "app/admin/vacuum/settings/page.tsx"))).toEqual([]);
  });

  it("el módulo de formularios sigue siendo un módulo de cliente (si dejara de serlo, el chequeo de arriba no protegería nada)", () => {
    expect(isClientModule(readFileSync(path.join(SRC, "components/vacuum-settings-forms.tsx"), "utf8"))).toBe(true);
  });
});
