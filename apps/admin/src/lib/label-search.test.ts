import { describe, expect, it } from "vitest";

import { matchesLabelSearch } from "./label-search";

const aceite = { name: "Aceite Cañuelas", sku: "ACE-900", barcodes: ["7791234567890"] };

describe("búsqueda de etiquetas", () => {
  it("encuentra cualquier etiqueta por nombre, SKU o código de barras", () => {
    expect(matchesLabelSearch(aceite, "aceite")).toBe(true);
    expect(matchesLabelSearch(aceite, "canuelas")).toBe(true);
    expect(matchesLabelSearch(aceite, "ace-900")).toBe(true);
    expect(matchesLabelSearch(aceite, "345678")).toBe(true);
  });

  it("una búsqueda vacía conserva los productos actualizados y los repetidos", () => {
    expect(matchesLabelSearch({ ...aceite, barcodes: [] }, "")).toBe(true);
  });
});
