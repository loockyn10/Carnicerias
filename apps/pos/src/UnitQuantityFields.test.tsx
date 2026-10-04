import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UnitQuantityFields } from "./UnitQuantityFields";

function render(props: { quantity?: number; pack: { packSizeUnits: number; packDiscountBps: number } | null; packMode?: boolean }) {
  return renderToStaticMarkup(
    <UnitQuantityFields
      quantity={props.quantity ?? 1} onQuantityChange={() => undefined} pack={props.pack}
      packMode={props.packMode ?? false} onPackModeChange={() => undefined}
    />
  );
}

describe("UnitQuantityFields (modal de cantidad de un producto UNIT)", () => {
  it("un producto sin pack no muestra la opción Pack", () => {
    const html = render({ pack: null });
    expect(html).toContain("Cantidad de unidades");
    expect(html).not.toContain("pack-toggle");
    expect(html).not.toContain("Pack ·");
  });

  it("un producto sin pack ignora el modo Pack aunque venga activado de una línea vieja", () => {
    const html = render({ pack: null, packMode: true });
    expect(html).toContain("Cantidad de unidades");
    expect(html).not.toContain("pack-units");
  });

  it("con pack ofrece 'Pack · 8 unidades · 20% OFF', sin activar, y la cantidad son unidades", () => {
    const html = render({ pack: { packSizeUnits: 8, packDiscountBps: 2_000 } });
    expect(html).toContain("Pack · 8 unidades · 20% OFF");
    expect(html).toContain("Cantidad de unidades");
    expect(html).not.toContain("pack-units");
    expect(html).not.toMatch(/<input[^>]*checked[^>]*type="checkbox"/);
  });

  it("en modo Pack la cantidad son packs y muestra las unidades reales con el 20% antes de agregar", () => {
    const one = render({ pack: { packSizeUnits: 8, packDiscountBps: 2_000 }, packMode: true, quantity: 1 });
    expect(one).toContain("Cantidad de packs");
    expect(one).toContain("1 pack × 8 u = 8 unidades reales · 20% OFF");
    const two = render({ pack: { packSizeUnits: 8, packDiscountBps: 2_000 }, packMode: true, quantity: 2 });
    expect(two).toContain("2 packs × 8 u = 16 unidades reales · 20% OFF");
  });

  it("muestra el porcentaje REAL de cada producto, no un 20% fijo", () => {
    expect(render({ pack: { packSizeUnits: 8, packDiscountBps: 2_500 } })).toContain("Pack · 8 unidades · 25% OFF");
    expect(render({ pack: { packSizeUnits: 12, packDiscountBps: 1_500 } })).toContain("Pack · 12 unidades · 15% OFF");
    expect(render({ pack: { packSizeUnits: 8, packDiscountBps: 2_500 } })).not.toContain("20% OFF");
    const inPack = render({ pack: { packSizeUnits: 8, packDiscountBps: 2_500 }, packMode: true, quantity: 2 });
    expect(inPack).toContain("2 packs × 8 u = 16 unidades reales · 25% OFF");
  });

  it("un porcentaje decimal se muestra con coma (12,5% OFF)", () => {
    expect(render({ pack: { packSizeUnits: 6, packDiscountBps: 1_250 } })).toContain("Pack · 6 unidades · 12,5% OFF");
  });
});
