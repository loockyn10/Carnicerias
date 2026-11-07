// Regenera packages/database/src/database.types.ts con `supabase gen types` SIN poder dejarlo roto.
//
// El script anterior (`supabase gen types typescript --local > packages/database/src/database.types.ts`) abre el archivo para escribir ANTES de
// correr el comando: si Supabase falla (sin Docker/base local, proyecto sin esquema `public`, error de red) el archivo queda vacío o con otra
// cosa, y todo el tipado de la base se rompe (`Database` pasa a `any` y aparecen errores como «string | number | symbol» en los `rpc`). Además, en
// PowerShell `>` escribe UTF-16, que TypeScript no lee. Acá se captura la salida, se valida que sea un esquema completo y recién entonces se
// reemplaza el archivo (en UTF-8). Si algo no cuadra, el archivo vigente no se toca.
//
// Uso: `pnpm db:types` (base local) · `pnpm db:types -- --linked` (proyecto vinculado, sólo lectura).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "packages/database/src/database.types.ts");
const extra = process.argv.slice(2).filter((arg) => arg !== "--");
const args = ["exec", "supabase", "gen", "types", "typescript", ...(extra.length > 0 ? extra : ["--local"])];

const result = spawnSync("pnpm", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });
if (result.error || result.status !== 0) {
  console.error(result.stderr || String(result.error));
  console.error("\nNo se pudieron generar los tipos: database.types.ts NO se modificó.");
  process.exit(1);
}

const stripBom = (value) => (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value);
const output = stripBom(result.stdout);
const required = ["export type Json", "public: {", "Tables: {", "Functions: {", "export const Constants"];
const missing = required.filter((fragment) => !output.includes(fragment));
if (missing.length > 0) {
  console.error(`La salida de supabase no es un esquema completo (falta: ${missing.join(", ")}). Primeras líneas:\n${output.split("\n").slice(0, 12).join("\n")}`);
  console.error("\ndatabase.types.ts NO se modificó. ¿La base local tiene las migraciones aplicadas (supabase db reset) o el proyecto expone el esquema public?");
  process.exit(1);
}

const functions = (text) => (text.match(/^ {6}[a-z_0-9]+: \{\s*Args:/gm) ?? []).length;
const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
const before = functions(current);
const after = functions(output);
if (before > 0 && after < before) {
  console.error(`La salida tiene menos RPC que el archivo vigente (${String(after)} contra ${String(before)}): es una base sin todas las migraciones. database.types.ts NO se modificó.`);
  process.exit(1);
}

fs.writeFileSync(target, output, "utf8");
console.log(`database.types.ts actualizado: ${String(after)} RPC (antes ${String(before)}).`);
