import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Guarda contra una regeneración rota de `database.types.ts` (archivo vacío, sin esquema `public`, en UTF-16…). Si esto falla, el deploy se cae en la
 * validación de tipos con errores lejanos y confusos (por ejemplo «string | number | symbol» en los `rpc`): acá se ve la causa de una vez.
 */
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "database.types.ts");
const text = fs.readFileSync(file);
const stripBom = (value: string) => (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value);

describe("database.types.ts (esquema generado)", () => {
  const source = stripBom(text.toString("utf8"));

  it("es texto UTF-8 y no está vacío", () => {
    expect(text.length).toBeGreaterThan(50_000);
    expect(text.subarray(0, 2).toString("hex")).not.toBe("fffe");
  });

  it("exporta Json, Database y Constants", () => {
    expect(source).toContain("export type Json");
    expect(source).toContain("export type Database");
    expect(source).toContain("export const Constants");
  });

  it("trae el esquema public completo: tablas, funciones y enums", () => {
    expect(source).toContain("public: {");
    expect(source).toContain("Tables: {");
    expect(source).toContain("Functions: {");
    expect(source).toContain("Enums: {");
  });

  it("incluye las RPC de Envasados, incluidas las de la estación de producción", () => {
    for (const name of [
      "create_vacuum_package", "search_vacuum_products", "get_vacuum_package", "record_vacuum_print", "get_pos_vacuum_state",
      "list_vacuum_station_products", "get_vacuum_station_summary"
    ]) {
      expect(source, name).toMatch(new RegExp(`^ {6}${name}: \\{\\s*Args:`, "m"));
    }
  });

  it("tiene una cantidad razonable de RPC (no un esquema parcial)", () => {
    expect((source.match(/^ {6}[a-z_0-9]+: \{\s*Args:/gm) ?? []).length).toBeGreaterThan(100);
  });
});
