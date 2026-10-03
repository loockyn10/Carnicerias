import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UnitQuantityFields } from "./UnitQuantityFields";

function render(props: { quantity?: number; packSizeUnits: number | null; packMode?: boolean }) {
  return renderToStaticMarkup(
    <UnitQuantityFields
      quantity={props.quantity ?? 1} onQuantityChange={() => undefined} packSizeUnits={props.packSizeUnits}
      packMode={props.packMode ?? false} onPackModeChange={() => undefined}
    />
  );
}

describe("UnitQuantityFields (modal de cantidad de un producto UNIT)", () => {
  it("un producto sin pack no muestra la opción Pack", () => {
    const html = render({ packSizeUnits: null });
    expect(html).toContain("Cantidad de unidades");
    expect(html).not.toContain("pack-toggle");
    expect(html).not.toContain("Pack ·");
  });

  it("un producto sin pack ignora el modo Pack aunque venga activado de una línea vieja", () => {
    const html = render({ packSizeUnits: null, packMode: true });
    expect(html).toContain("Cantidad de unidades");
    expect(html).not.toContain("pack-units");
  });

  it("con pack ofrece 'Pack · 8 unidades · 20% OFF', sin activar, y la cantidad son unidades", () => {
    const html = render({ packSizeUnits: 8 });
    expect(html).toContain("Pack · 8 unidades · 20% OFF");
    expect(html).toContain("Cantidad de unidades");
    expect(html).not.toContain("pack-units");
    expect(html).not.toMatch(/<input[^>]*checked[^>]*type="checkbox"/);
  });

  it("en modo Pack la cantidad son packs y muestra las unidades reales con el 20% antes de agregar", () => {
    const one = render({ packSizeUnits: 8, packMode: true, quantity: 1 });
    expect(one).toContain("Cantidad de packs");
    expect(one).toContain("1 pack × 8 u = 8 unidades reales · 20% OFF");
    const two = render({ packSizeUnits: 8, packMode: true, quantity: 2 });
    expect(two).toContain("2 packs × 8 u = 16 unidades reales · 20% OFF");
  });
});
