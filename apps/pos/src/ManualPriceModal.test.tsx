import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ManualPriceModal } from "./ManualPriceModal";

const preview = (priceCents: bigint) => ({ subtotalCents: priceCents * 3n, adjustmentCents: (priceCents - 1_200_000n) * 3n });

function render(current: bigint | null, unitLabel: "kg" | "u" = "u") {
  return renderToStaticMarkup(
    <ManualPriceModal
      productName="Coca Cola 2.25 L" unitLabel={unitLabel} quantityLabel="3 u" normalPriceCents={1_200_000n}
      currentManualPriceCents={current} preview={preview} onApply={() => undefined} onRestore={() => undefined} onCancel={() => undefined}
    />
  );
}

describe("ManualPriceModal", () => {
  it("línea con precio normal: muestra el precio normal, el campo vacío y no ofrece restaurar", () => {
    const html = render(null);
    expect(html).toContain("Editar precio");
    expect(html).toContain("Coca Cola 2.25 L");
    expect(html).toMatch(/Precio normal: <strong>\$\s?12\.000(,00)?<\/strong> \/ u/);
    expect(html).toContain("Precio por unidad para esta venta");
    expect(html).toContain("Aplicar precio");
    expect(html).not.toContain("Usar precio normal");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(html).toContain("no cambia el precio del producto");
  });

  it("línea con precio manual: precarga el precio, muestra el ajuste y ofrece 'Usar precio normal'", () => {
    const html = render(1_000_000n);
    expect(html).toContain('value="10000"');
    expect(html).toContain("Usar precio normal");
    expect(html).toContain("Ajuste manual: -");
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("una línea por peso pide el precio por kg", () => {
    expect(render(null, "kg")).toContain("Precio por kg para esta venta");
  });
});
