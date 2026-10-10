import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QuantityTiersField, rowsFromTiers, serializeTierRows, tierRowsError, type TierEditorRow } from "./quantity-tiers-field";

const tiers = [{ minimumUnits: 5, discountBps: 2_000 }, { minimumUnits: 3, discountBps: 1_500 }];

describe("editor de escalones del descuento por cantidad", () => {
  it("arma las filas ordenadas por cantidad y con el porcentaje legible (coma decimal)", () => {
    const rows = rowsFromTiers([...tiers, { minimumUnits: 8, discountBps: 2_250 }]);
    expect(rows.map((row) => [row.units, row.percent, row.editing])).toEqual([["3", "15", false], ["5", "20", false], ["8", "22,5", false]]);
  });

  it("serializa sólo lo escrito (el servidor vuelve a parsear y validar)", () => {
    expect(JSON.parse(serializeTierRows(rowsFromTiers(tiers)))).toEqual([{ units: "3", percent: "15" }, { units: "5", percent: "20" }]);
    expect(serializeTierRows([])).toBe("[]");
  });

  it("valida con la misma regla del servidor: cantidades repetidas, porcentaje fuera de rango, descuento que no crece", () => {
    const row = (units: string, percent: string): TierEditorRow => ({ key: units + percent, units, percent, editing: false });
    expect(tierRowsError(rowsFromTiers(tiers))).toBeNull();
    expect(tierRowsError([])).toBeNull();
    expect(tierRowsError([row("3", "15"), row("3", "20")])).toContain("misma cantidad");
    expect(tierRowsError([row("3", "100")])).toContain("porcentaje");
    expect(tierRowsError([row("1", "10")])).toContain("cantidad");
    expect(tierRowsError([row("3", "20"), row("5", "10")])).toContain("más descuento");
  });

  it("muestra cada escalón con Editar y Eliminar, y «+ Agregar escalón»", () => {
    const html = renderToStaticMarkup(<QuantityTiersField onChange={() => undefined} rows={rowsFromTiers(tiers)} />);
    expect(html).toContain("3 unidades");
    expect(html).toContain("15 %");
    expect(html).toContain("5 unidades");
    expect(html).toContain("20 %");
    expect(html).toContain("Editar");
    expect(html).toContain("Eliminar");
    expect(html).toContain("+ Agregar escalón");
    expect(html).not.toContain("data-testid=\"quantity-tiers-error\"");
  });

  it("una fila en edición muestra la cantidad y el porcentaje como campos", () => {
    const rows: TierEditorRow[] = [{ key: "n", units: "", percent: "", editing: true }];
    const html = renderToStaticMarkup(<QuantityTiersField onChange={() => undefined} rows={rows} />);
    expect(html).toContain('aria-label="Cantidad mínima"');
    expect(html).toContain('aria-label="Descuento"');
    expect(html).toContain("Listo");
  });

  it("sin escalones lo dice y deja agregar uno", () => {
    const html = renderToStaticMarkup(<QuantityTiersField onChange={() => undefined} rows={[]} />);
    expect(html).toContain("Sin descuentos por cantidad");
    expect(html).toContain("+ Agregar escalón");
  });

  it("un conjunto inválido muestra el error en pantalla", () => {
    const html = renderToStaticMarkup(<QuantityTiersField onChange={() => undefined} rows={[{ key: "a", units: "3", percent: "15", editing: false }, { key: "b", units: "3", percent: "20", editing: false }]} />);
    expect(html).toContain("quantity-tiers-error");
    expect(html).toContain("misma cantidad");
  });
});
