import { describe, expect, it } from "vitest";

import {
  deactivateConfirmationText, deactivateSuccessText, effectiveSelection, MAX_BULK_DEACTIVATE, normalizeProductIds, selectedCountLabel, toggleAllSelectable, toggleSelected
} from "./product-selection";

const A = "d5000000-0000-4000-8000-000000000001";
const B = "d5000000-0000-4000-8000-000000000002";
const C = "d5000000-0000-4000-8000-000000000003";

describe("normalizeProductIds", () => {
  it("acepta uuids, los pasa a minúsculas y quita duplicados", () => {
    expect(normalizeProductIds([A, B, A.toUpperCase()])).toEqual([A, B]);
  });
  it("rechaza vacío, no-arrays, no-uuids y valores no string", () => {
    expect(normalizeProductIds([])).toBeNull();
    expect(normalizeProductIds(null)).toBeNull();
    expect(normalizeProductIds("x")).toBeNull();
    expect(normalizeProductIds([A, "no-es-uuid"])).toBeNull();
    expect(normalizeProductIds([A, 7])).toBeNull();
    expect(normalizeProductIds([A, null])).toBeNull();
  });
  it("respeta el tope por llamada", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `d5000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(normalizeProductIds(many(MAX_BULK_DEACTIVATE))).toHaveLength(MAX_BULK_DEACTIVATE);
    expect(normalizeProductIds(many(MAX_BULK_DEACTIVATE + 1))).toBeNull();
  });
});

describe("selección", () => {
  it("toggleSelected marca y desmarca sin mutar el Set original", () => {
    const empty = new Set<string>();
    const one = toggleSelected(empty, A);
    expect([...one]).toEqual([A]);
    expect(empty.size).toBe(0);
    expect(toggleSelected(one, A).size).toBe(0);
  });
  it("toggleAllSelectable marca todos los visibles y, si ya están todos, los desmarca", () => {
    expect([...toggleAllSelectable(new Set(), [A, B, C])].sort()).toEqual([A, B, C]);
    expect([...toggleAllSelectable(new Set([A]), [A, B, C])].sort()).toEqual([A, B, C]);
    expect(toggleAllSelectable(new Set([A, B, C]), [A, B, C]).size).toBe(0);
    expect(toggleAllSelectable(new Set(), []).size).toBe(0);
  });
  it("effectiveSelection ignora lo que ya no está visible/seleccionable", () => {
    expect(effectiveSelection(new Set([A, B, "otro"]), [A, C])).toEqual([A]);
  });
});

describe("textos", () => {
  it("usa el texto de confirmación pedido (plural) y una variante singular", () => {
    expect(deactivateConfirmationText(3)).toBe("Vas a desactivar 3 productos. Dejarán de estar disponibles para la venta, pero conservarán su historial de ventas, precios y movimientos.");
    expect(deactivateConfirmationText(1)).toBe("Vas a desactivar 1 producto. Dejará de estar disponible para la venta, pero conservará su historial de ventas, precios y movimientos.");
  });
  it("contador y resultado", () => {
    expect(selectedCountLabel(1)).toBe("1 producto seleccionado");
    expect(selectedCountLabel(12)).toBe("12 productos seleccionados");
    expect(deactivateSuccessText(2, 0)).toBe("Se desactivaron 2 productos.");
    expect(deactivateSuccessText(1, 1)).toBe("Se desactivó 1 producto. 1 producto ya estaba inactivo.");
    expect(deactivateSuccessText(0, 2)).toBe("2 productos ya estaban inactivos.");
  });
});
