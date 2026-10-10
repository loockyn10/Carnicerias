import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CentralProductList, type CentralRowBadge } from "./CentralProductList";
import type { CentralListProduct } from "./lib/central-list";
import { limitRowChips } from "./lib/discount-chips";
import { unitPromotionChips } from "./lib/ticket-pricing";
import { UnitQuantityFields } from "./UnitQuantityFields";

const sugar: CentralListProduct = { productId: "az", productName: "AZUCAR JL 1KG.", productSku: null, unitType: "UNIT", pricePerKgCents: 165_000n, barcodes: ["7790000000011"] };

function render(badges: readonly CentralRowBadge[]) {
  return renderToStaticMarkup(<CentralProductList products={[sugar]} onSelect={() => undefined} badgesFor={() => badges} accentFor={() => undefined} resetKey="ALL" />);
}

/** Los chips del markup como [variante, texto]. */
function chips(html: string): [string, string][] {
  return [...html.matchAll(/data-discount-variant="([^"]+)">([^<]*)</g)].map((match) => [match[1] ?? "", match[2] ?? ""]);
}

const T3 = { id: "t3", minimumUnits: 3, discountBps: 1_500 };
const T5 = { id: "t5", minimumUnits: 5, discountBps: 2_000 };
const PACK: CentralRowBadge = { kind: "PACK", label: "Pack 10 u · 25% OFF · $ 1.237,50/u" };
const tierBadges = (tiers = [T3, T5]): CentralRowBadge[] => unitPromotionChips(165_000n, tiers).map((chip) => ({ kind: "PROMO", label: chip.label, tier: chip.tierIndex }));

describe("lista Central: un chip por descuento, cada uno con su color", () => {
  it("AZUCAR JL 1KG: 3 u, 5 u y Pack son TRES chips con TRES variantes distintas, en ese orden", () => {
    const rendered = chips(render([...tierBadges(), PACK]));
    expect(rendered).toEqual([
      ["tier-1", "$ 1.402,50/u desde 3 u"],
      ["tier-2", "$ 1.320/u desde 5 u"],
      ["pack", "Pack 10 u · 25% OFF · $ 1.237,50/u"]
    ]);
  });

  it("los chips nunca se unen en un único texto («… desde 3 u · … desde 5 u»)", () => {
    expect(render([...tierBadges(), PACK])).not.toContain("desde 3 u · $");
  });

  it("tiers distintos usan clases de color distintas y el Pack ninguna de las de los tiers", () => {
    const html = render([...tierBadges(), PACK]);
    expect(html).toContain("bg-amber-950 text-amber-300");
    expect(html).toContain("bg-emerald-950 text-emerald-300");
    expect(html).toContain("bg-sky-950 text-sky-300");
  });

  it("sólo 3 u → un chip ámbar; 3 u + 5 u sin pack → ámbar y verde; sólo pack → azul; sin descuentos → ningún chip", () => {
    expect(chips(render(tierBadges([T3])))).toEqual([["tier-1", "$ 1.402,50/u desde 3 u"]]);
    expect(chips(render(tierBadges())).map(([variant]) => variant)).toEqual(["tier-1", "tier-2"]);
    expect(chips(render([PACK])).map(([variant]) => variant)).toEqual(["pack"]);
    expect(chips(render([]))).toEqual([]);
  });

  it("cuatro escalones (2, 3, 5, 10) + pack: no caben cinco chips en una fila de alto fijo; el Pack se conserva y el resto se agrupa en «+N»", () => {
    const four = tierBadges([{ id: "a", minimumUnits: 2, discountBps: 1_000 }, T3, T5, { id: "d", minimumUnits: 10, discountBps: 2_500 }]);
    const html = render([...four, PACK]);
    expect(chips(html).map(([variant]) => variant)).toEqual(["tier-1", "tier-2", "pack", "more"]);
    expect(html).toContain("Pack 10 u · 25% OFF");
    expect(html).toContain(">+2<");
    expect(html).toContain('title="$ 1.320/u desde 5 u · $ 1.237,50/u desde 10 u"');
  });

  it("hasta cuatro chips se muestran completos, sin «+N»", () => {
    const three = tierBadges([{ id: "a", minimumUnits: 2, discountBps: 1_000 }, T3, T5]);
    expect(chips(render([...three, PACK])).map(([variant]) => variant)).toEqual(["tier-1", "tier-2", "tier-3", "pack"]);
    expect(render([...three, PACK])).not.toContain("data-discount-variant=\"more\"");
  });

  it("limitRowChips: el Pack nunca se oculta y el orden se conserva", () => {
    const promo = (label: string): CentralRowBadge => ({ kind: "PROMO", label });
    const many = [promo("a"), promo("b"), promo("c"), promo("d"), promo("e"), { kind: "PACK", label: "pack" } as CentralRowBadge];
    const { shown, hidden } = limitRowChips(many);
    expect(shown.map((chip) => chip.label)).toEqual(["a", "b", "pack"]);
    expect(hidden.map((chip) => chip.label)).toEqual(["c", "d", "e"]);
    expect(limitRowChips(many.slice(0, 4)).hidden).toEqual([]);
    expect(limitRowChips([promo("a"), promo("b"), promo("c"), promo("d"), promo("e")]).shown.map((chip) => chip.label)).toEqual(["a", "b", "c"]);
  });

  it("la fila no crece: sigue siendo UNA fila de alto fijo y el texto de cada condición se lee entero (no sólo por color)", () => {
    const html = render([...tierBadges(), PACK]);
    expect(html.match(/pos-central-row/g)).toHaveLength(1);
    expect(html).toContain("desde 3 u");
    expect(html).toContain("desde 5 u");
    expect(html).toContain("Pack 10 u");
    expect(html).toContain("whitespace-nowrap");
  });

  it("un descuento de peso sin posición de escalón conserva su color ámbar de siempre", () => {
    expect(chips(render([{ kind: "PROMO", label: "15% OFF desde 2 kg" }]))).toEqual([["tier-1", "15% OFF desde 2 kg"]]);
  });
});

describe("diálogo de cantidad: el Pack conserva su identidad azul", () => {
  const pack = { packSizeUnits: 10, packDiscountBps: 2_500, unitPriceCents: 123_750n, applied: false, packCount: 0 };
  const dialog = (applied: boolean) => renderToStaticMarkup(
    <UnitQuantityFields quantity={10} onQuantityChange={() => undefined} lineUnits={10} pack={{ ...pack, applied, packCount: applied ? 1 : 0 }} />
  );

  it("Pack aplicado: azul (ya no verde, que ahora es el del 2.º escalón)", () => {
    const html = dialog(true);
    expect(html).toContain("border-sky-500/60");
    expect(html).toContain('data-discount-variant="pack"');
    expect(html).not.toContain("emerald");
  });

  it("Pack disponible: el título lleva el azul del Pack y sigue diciendo «desde 10 unidades»", () => {
    const html = dialog(false);
    expect(html).toContain("text-sky-300");
    expect(html).toContain("Pack disponible desde 10 unidades");
  });
});
