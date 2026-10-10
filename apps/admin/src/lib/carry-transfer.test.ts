import { describe, expect, it } from "vitest";

import { buildTransferHref, parseTransferPrefill } from "./carry-transfer";

const CENTRAL = "d3000000-0000-4000-8000-000000000001";
const AVENIDA = "d3000000-0000-4000-8000-000000000002";
const PATA = "d5000000-0000-4000-8000-000000000001";
const COCA = "d5000000-0000-4000-8000-000000000013";

describe("«Qué llevar» → Distribución", () => {
  it("el link lleva origen, destino y las cantidades crudas (gramos / unidades)", () => {
    const href = buildTransferHref({ sourceBranchId: CENTRAL, destinationBranchId: AVENIDA, items: [{ productId: PATA, quantity: 12_500 }, { productId: COCA, quantity: 28 }] });
    expect(href.startsWith("/admin/transfers?")).toBe(true);
    const url = new URL(href, "http://x");
    expect(url.searchParams.get("from")).toBe(CENTRAL);
    expect(url.searchParams.get("to")).toBe(AVENIDA);
    expect(url.searchParams.get("items")).toBe(`${PATA}:12500,${COCA}:28`);
  });

  it("sin sucursal productiva configurada no inventa el origen", () => {
    const href = buildTransferHref({ sourceBranchId: null, destinationBranchId: AVENIDA, items: [{ productId: PATA, quantity: 1 }] });
    expect(new URL(href, "http://x").searchParams.has("from")).toBe(false);
  });

  it("lo que se arma se lee de vuelta igual", () => {
    const href = buildTransferHref({ sourceBranchId: CENTRAL, destinationBranchId: AVENIDA, items: [{ productId: PATA, quantity: 12_500 }, { productId: COCA, quantity: 28 }] });
    const params = new URL(href, "http://x").searchParams;
    expect(parseTransferPrefill({ from: params.get("from") ?? undefined, to: params.get("to") ?? undefined, items: params.get("items") ?? undefined })).toEqual({
      sourceBranchId: CENTRAL, destinationBranchId: AVENIDA, items: [{ productId: PATA, quantity: 12_500 }, { productId: COCA, quantity: 28 }]
    });
  });

  it("descarta ids inválidos, cantidades que no son enteros positivos y duplicados (nunca lanza)", () => {
    const parsed = parseTransferPrefill({
      from: "no-uuid", to: AVENIDA,
      items: [`${PATA}:12500`, `${PATA}:99`, `${COCA}:0`, `${COCA}:-4`, `${COCA}:1.5`, `${COCA}:abc`, "no-uuid:3", COCA, "", `${COCA}:7`].join(",")
    });
    expect(parsed).toEqual({ sourceBranchId: null, destinationBranchId: AVENIDA, items: [{ productId: PATA, quantity: 12_500 }, { productId: COCA, quantity: 7 }] });
    expect(parseTransferPrefill({})).toEqual({ sourceBranchId: null, destinationBranchId: null, items: [] });
  });

  it("limita la cantidad de líneas", () => {
    const many = Array.from({ length: 300 }, (_, index) => `d5000000-0000-4000-8000-${String(index).padStart(12, "0")}:1`).join(",");
    expect(parseTransferPrefill({ items: many }).items).toHaveLength(100);
  });
});
