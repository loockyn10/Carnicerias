import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MAX_UNIT_QUANTITY, parseQuantityDraft, UnitQuantityFields } from "./UnitQuantityFields";

type Pack = NonNullable<Parameters<typeof UnitQuantityFields>[0]["pack"]>;
const PACK_10: Pack = { packSizeUnits: 10, packDiscountBps: 2_500, unitPriceCents: 123_750n, applied: false, packCount: 0 };

function render(props: { quantity?: number | null; lineUnits?: number; pack: Pack | null }) {
  return renderToStaticMarkup(
    <UnitQuantityFields quantity={props.quantity === undefined ? 1 : props.quantity} onQuantityChange={() => undefined} lineUnits={props.lineUnits ?? props.quantity ?? 0} pack={props.pack} />
  );
}

describe("parseQuantityDraft (borrador del input de cantidad)", () => {
  it("1 → borrar → '' es un estado válido y transitorio (sin cantidad), no se fuerza a 1", () => {
    expect(parseQuantityDraft("")).toEqual({ draft: "", quantity: null, reject: false });
  });

  it("'' → 8 → cantidad 8", () => {
    expect(parseQuantityDraft("8")).toEqual({ draft: "8", quantity: 8, reject: false });
  });

  it("nunca produce 0, negativos ni NaN: '0', '-3' y letras no son una cantidad", () => {
    expect(parseQuantityDraft("0").quantity).toBeNull();
    expect(parseQuantityDraft("00").quantity).toBeNull();
    expect(parseQuantityDraft("-3")).toMatchObject({ draft: "3", quantity: 3 });
    expect(parseQuantityDraft("abc")).toEqual({ draft: "", quantity: null, reject: false });
  });

  it("ceros a la izquierda se limpian ('08' → 8) y el tope se rechaza", () => {
    expect(parseQuantityDraft("08")).toMatchObject({ draft: "8", quantity: 8 });
    expect(parseQuantityDraft(String(MAX_UNIT_QUANTITY))).toMatchObject({ quantity: MAX_UNIT_QUANTITY });
    expect(parseQuantityDraft(String(MAX_UNIT_QUANTITY + 1)).reject).toBe(true);
  });
});

describe("UnitQuantityFields (modal de cantidad de un producto UNIT)", () => {
  it("un producto sin pack no muestra ninguna sección de Pack", () => {
    const html = render({ pack: null });
    expect(html).toContain("Cantidad de unidades");
    expect(html).not.toContain("pack-status");
  });

  it("ya no hay checkbox de Pack: es información, no una acción", () => {
    expect(render({ pack: PACK_10 })).not.toContain('type="checkbox"');
    expect(render({ pack: { ...PACK_10, applied: true, packCount: 1 }, quantity: 10 })).not.toContain('type="checkbox"');
  });

  it("antes de llegar: 'Pack disponible desde 10 unidades' con el % y el precio por unidad", () => {
    const html = render({ pack: PACK_10, quantity: 9 });
    expect(html).toContain("Pack disponible desde 10 unidades");
    expect(html).toContain("25% OFF");
    expect(html).toContain("$ 1.237,50/u");
    expect(html).not.toContain("Pack aplicado");
  });

  it("al alcanzarlo: 'Pack aplicado automáticamente' con las unidades, el % y el precio por unidad", () => {
    const html = render({ pack: { ...PACK_10, applied: true, packCount: 1 }, quantity: 10 });
    expect(html).toContain("Pack aplicado automáticamente");
    expect(html).toContain("10 unidades · 25% OFF");
    expect(html).toContain("$ 1.237,50/u");
    expect(html).not.toContain("Pack disponible");
  });

  it("varios packs: 20 unidades son 2 packs × 10", () => {
    const html = render({ pack: { ...PACK_10, applied: true, packCount: 2 }, quantity: 20, lineUnits: 20 });
    expect(html).toContain("2 packs × 10 u = 20 unidades");
  });

  it("más allá del pack pero fuera de un múltiplo (11, 19) avisa que se aplica en múltiplos, sin inventar otra regla", () => {
    expect(render({ pack: PACK_10, quantity: 11 })).toContain("Se aplica en múltiplos de 10 unidades");
    expect(render({ pack: PACK_10, quantity: 9 })).not.toContain("múltiplos");
    expect(render({ pack: PACK_10, quantity: 10, lineUnits: 10 })).not.toContain("múltiplos");
  });

  it("el porcentaje es el REAL de cada producto y con coma decimal", () => {
    expect(render({ pack: { ...PACK_10, packSizeUnits: 8, packDiscountBps: 1_250 } })).toContain("12,5% OFF");
    expect(render({ pack: PACK_10 })).not.toContain("20% OFF");
  });

  it("sin precio por unidad calculable muestra sólo el %", () => {
    const html = render({ pack: { ...PACK_10, unitPriceCents: null } });
    expect(html).toContain("25% OFF");
    expect(html).not.toContain("/u");
  });

  it("con el campo vacío el input queda vacío (no '1') y '−' está deshabilitado", () => {
    const html = render({ quantity: null, pack: null });
    expect(html).toMatch(/<input[^>]*value=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>−<\/button>/);
  });

  it("'−' con cantidad 1 está deshabilitado y con 2 no", () => {
    expect(render({ quantity: 1, pack: null })).toMatch(/<button[^>]*disabled=""[^>]*>−<\/button>/);
    expect(render({ quantity: 2, pack: null })).not.toMatch(/<button[^>]*disabled=""[^>]*>−<\/button>/);
  });
});
