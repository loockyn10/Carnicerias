import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CentralProductList, CentralProductRow, type CentralRowBadge } from "./CentralProductList";
import type { CentralListProduct } from "./lib/central-list";

function product(overrides: Partial<CentralListProduct> = {}): CentralListProduct {
  return { productId: "p1", productName: "ACEITE NATURA 1.5 L", productSku: null, unitType: "UNIT", pricePerKgCents: 450_000n, barcodes: ["7790272001029"], ...overrides };
}

function renderList(products: CentralListProduct[], badgesFor: (p: CentralListProduct) => readonly CentralRowBadge[] = () => []) {
  return renderToStaticMarkup(
    <CentralProductList products={products} onSelect={() => undefined} badgesFor={badgesFor} accentFor={() => undefined} resetKey="ALL" />
  );
}

describe("CentralProductList rows", () => {
  it("UNIT: name, price, UNIDAD and the barcode as secondary text", () => {
    const html = renderList([product()]);
    expect(html).toContain("ACEITE NATURA 1.5 L");
    expect(html).toContain("4.500");
    expect(html).toContain("UNIDAD");
    expect(html).toContain("7790272001029");
    expect(html).not.toContain("/kg");
  });

  it("WEIGHT: price per kg and KG type, secondary text is the SKU", () => {
    const html = renderList([product({ productId: "p2", productName: "VACÍO", unitType: "WEIGHT", pricePerKgCents: 1_250_000n, productSku: "VAC-VACIO", barcodes: [] })]);
    expect(html).toContain("VACÍO");
    expect(html).toContain("12.500");
    expect(html).toContain("/kg");
    expect(html).toContain(">KG<");
    expect(html).toContain("VAC-VACIO");
  });

  it("without price it says SIN PRECIO and never renders $0", () => {
    const html = renderList([product({ pricePerKgCents: 0n })]);
    expect(html).toContain("SIN PRECIO");
    expect(html).not.toContain("$0");
    expect(html).not.toContain("$ 0");
  });

  it("shows Pack and Promo badges next to the code", () => {
    const html = renderList([product()], () => [
      { kind: "PACK", label: "Pack 6 u · 10% OFF" },
      { kind: "PROMO", label: "15% OFF desde 2 kg" }
    ]);
    expect(html).toContain("Pack 6 u · 10% OFF");
    expect(html).toContain("15% OFF desde 2 kg");
  });

  it("UNIT con promoción: el precio unitario promocional va como badge compacto (misma fila, mismo lenguaje que el de WEIGHT)", () => {
    const html = renderList([product({ unitType: "UNIT", pricePerKgCents: 540_000n })], () => [{ kind: "PROMO", label: "$ 4.590/u desde 3 u" }]);
    expect(html).toContain("$ 5.400");
    expect(html).toContain("$ 4.590/u desde 3 u");
    expect(html).toContain("bg-amber-950");
    expect(html.match(/pos-central-row/g)).toHaveLength(1);
    expect(html).not.toContain("15%");
  });

  it("WEIGHT conserva su badge de precio/kg promocional", () => {
    const html = renderList([product({ unitType: "WEIGHT", pricePerKgCents: 1_100_000n })], () => [{ kind: "PROMO", label: "$ 9.000/kg desde 2,000 kg" }]);
    expect(html).toContain("$ 9.000/kg desde 2,000 kg");
  });

  it("no badges when the product has none", () => {
    expect(renderList([product()])).not.toContain("OFF");
  });
});

describe("CentralProductList windowing", () => {
  it("with thousands of products only a small window of rows is mounted", () => {
    const many = Array.from({ length: 3000 }, (_, index) => product({ productId: `p${String(index)}`, productName: `PRODUCTO ${String(index)}` }));
    const html = renderList(many);
    const rows = html.match(/pos-central-row/g)?.length ?? 0;
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(40);
    expect(html).toContain("PRODUCTO 0<");
    expect(html).not.toContain("PRODUCTO 2999<");
    // El espaciador inferior conserva la altura total del scroll (3000 filas de 56 px menos las montadas).
    expect(html).toContain(`padding-bottom:${String((3000 - rows) * 56)}px`);
  });
});

describe("CentralProductRow selection", () => {
  // La fila no decide nada: entrega el producto tal cual a `onSelect` (App.openWeight: balanza, cantidad, precio manual).
  function click(p: CentralListProduct) {
    const onSelect = vi.fn();
    const element = CentralProductRow({ product: p, accent: undefined, badges: [], onSelect }) as ReactElement<{ onClick: () => void }>;
    element.props.onClick();
    return onSelect;
  }

  it.each([
    ["UNIT", product({ unitType: "UNIT" })],
    ["WEIGHT", product({ productId: "p2", unitType: "WEIGHT" })],
    ["sin precio", product({ productId: "p3", pricePerKgCents: 0n })]
  ])("%s: tapping the row requests exactly that product once", (_name, p) => {
    const onSelect = click(p);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("the whole row is a single button (clickable anywhere)", () => {
    const element = CentralProductRow({ product: product(), accent: undefined, badges: [], onSelect: () => undefined }) as ReactElement<{ type?: string }>;
    expect(element.type).toBe("button");
    expect(element.props.type).toBe("button");
  });
});
