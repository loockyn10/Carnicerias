import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MAX_UNIT_QUANTITY, parseQuantityDraft, UnitQuantityFields } from "./UnitQuantityFields";

function render(props: { quantity?: number | null }) {
  return renderToStaticMarkup(<UnitQuantityFields quantity={props.quantity === undefined ? 1 : props.quantity} onQuantityChange={() => undefined} />);
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
  it("sólo trae la cantidad: el Pack ya no tiene recuadro propio (va con los demás descuentos, ver QuantityTierList)", () => {
    const html = render({});
    expect(html).toContain("Cantidad de unidades");
    expect(html).not.toContain("pack-status");
    expect(html).not.toContain("Pack");
    expect(html).not.toContain('type="checkbox"');
  });

  it("con el campo vacío el input queda vacío (no '1') y '−' está deshabilitado", () => {
    const html = render({ quantity: null });
    expect(html).toMatch(/<input[^>]*value=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>−<\/button>/);
  });

  it("'−' con cantidad 1 está deshabilitado y con 2 no", () => {
    expect(render({ quantity: 1 })).toMatch(/<button[^>]*disabled=""[^>]*>−<\/button>/);
    expect(render({ quantity: 2 })).not.toMatch(/<button[^>]*disabled=""[^>]*>−<\/button>/);
  });
});
