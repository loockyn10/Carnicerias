// Regenerates supabase/fixtures/imports/simplygest-large.csv (deterministic, 1,500 data rows) used to
// exercise a catalog bigger than the engine's 1,000-row batch cap. Run: node scripts/generate-import-fixtures.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAMILIES = ["Bebidas", "Almacen", "Lácteos", "Limpieza", "Perfumería", "Golosinas", "Snacks", "Congelados", "Infusiones", "Aceites", "Conservas", "Galletitas"];

const header = "CODIGO;DESCRIPCION;BARRAS;FAMILIA;PRECIO;COSTO;STOCK";
const lines = [header];
const money = (cents) => {
  const whole = Math.floor(cents / 100);
  return `${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(cents % 100).padStart(2, "0")}`;
};
for (let i = 1; i <= 1500; i += 1) {
  const code = String(20000 + i);
  let barcode = String(7790000000000 + i * 7);
  const family = FAMILIES[i % FAMILIES.length];
  let price = money(50000 + i * 137);
  const cost = i % 5 === 0 ? "" : money(30000 + i * 90);
  const stock = String((i * 3) % 60);
  // Seeded problems: one missing price every 250 rows, and a barcode that repeats ACROSS the
  // 1,000-row batch boundary (row 5 and row 1305) — only a whole-file check can catch that one.
  if (i % 250 === 0) price = "";
  if (i === 1305) barcode = String(7790000000000 + 5 * 7);
  lines.push([code, `Producto de prueba ${String(i).padStart(4, "0")}`, barcode, family, price, cost, stock].join(";"));
}
writeFileSync(path.join(root, "supabase/fixtures/imports/simplygest-large.csv"), `${lines.join("\n")}\n`, "utf8");
console.log(`wrote ${String(lines.length - 1)} rows`);
