import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// El ticket vive inline en App.tsx (depende de Supabase/Tauri y no se puede montar en un test), así que la
// guarda es textual: el título y la fila de peso total ya no existen, y el resto del ticket sigue presente.
const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("columna del ticket (sin título ni peso total)", () => {
  it("no renderiza 'Ticket actual' ni 'Peso total'", () => {
    expect(source).not.toContain("Ticket actual");
    expect(source).not.toContain("Peso total");
  });

  it("conserva Cancelar, líneas, subtotal, promos, descuento, TOTAL y Confirmar venta", () => {
    for (const text of ["Cancelar", "Modificar cantidad", "Modificar peso", "Editar precio", "Eliminar", "Subtotal/lista", "Promos y packs", "Importe descuento", "TOTAL", "Confirmar venta"]) {
      expect(source).toContain(text);
    }
  });
});
