import type { BranchUnitPromotion } from "@carnicerias/business-logic";
import { describe, expect, it } from "vitest";

import { discountPalette, PACK_PALETTE, TIER_PALETTES, tierPalette, tierPositionByMinimumUnits } from "./discount-chips";
import { appliedTierMinimumUnits, unitPromotionChips, unitPromotionLabel } from "./ticket-pricing";

const tier = (id: string, minimumUnits: number, discountBps: number): BranchUnitPromotion => ({ id, minimumUnits, discountBps });
// AZUCAR JL 1KG: lista $1.650/u; 3 u → 15 % ($1.402,50/u), 5 u → 20 % ($1.320/u).
const T3 = tier("t3", 3, 1_500);
const T5 = tier("t5", 5, 2_000);
const SUGAR = 165_000n;

describe("paleta de descuentos del POS", () => {
  it("los escalones toman su color por POSICIÓN, no por la cantidad mínima", () => {
    expect(tierPositionByMinimumUnits([T3, T5], 3)).toBe(0);
    expect(tierPositionByMinimumUnits([T3, T5], 5)).toBe(1);
    // Con otra configuración (2, 4, 6, 10) el color lo sigue dando la posición.
    const other = [tier("a", 10, 3_000), tier("b", 2, 500), tier("c", 6, 2_000), tier("d", 4, 1_000)];
    expect([2, 4, 6, 10].map((units) => tierPositionByMinimumUnits(other, units))).toEqual([0, 1, 2, 3]);
  });

  it("3 u, 5 u y Pack son tres variantes distintas", () => {
    const variants = [tierPalette(0), tierPalette(1), PACK_PALETTE].map((palette) => palette.variant);
    expect(new Set(variants).size).toBe(3);
    expect(tierPalette(0).chip).not.toBe(tierPalette(1).chip);
    expect(tierPalette(1).chip).not.toBe(PACK_PALETTE.chip);
    expect(tierPalette(0).chip).toContain("amber");
    expect(tierPalette(1).chip).toContain("emerald");
    expect(PACK_PALETTE.chip).toContain("sky");
  });

  it("el Pack nunca comparte color con un escalón y dos escalones consecutivos nunca se parecen (también al volver a empezar)", () => {
    for (const palette of TIER_PALETTES) expect(palette.chip).not.toBe(PACK_PALETTE.chip);
    for (let index = 0; index < TIER_PALETTES.length * 2; index += 1) {
      expect(tierPalette(index).chip).not.toBe(tierPalette(index + 1).chip);
    }
    expect(tierPalette(TIER_PALETTES.length).variant).toBe(tierPalette(0).variant);
  });

  it("ninguna variante es roja/rosa (el rojo es el del precio y de los errores)", () => {
    for (const palette of [...TIER_PALETTES, PACK_PALETTE]) expect(palette.chip).not.toMatch(/red|rose|pink|fuchsia/);
  });

  it("una posición inválida no rompe (usa la primera) y discountPalette respeta el tipo", () => {
    expect(tierPalette(-1).variant).toBe("tier-1");
    expect(tierPalette(Number.NaN).variant).toBe("tier-1");
    expect(discountPalette("PACK", 3).variant).toBe("pack");
    expect(discountPalette("PROMO", 1).variant).toBe("tier-2");
    expect(discountPalette("PROMO").variant).toBe("tier-1");
  });
});

describe("unitPromotionChips (un chip por escalón)", () => {
  it("AZUCAR JL: dos chips independientes, con su posición y su texto", () => {
    const chips = unitPromotionChips(SUGAR, [T5, T3]);
    expect(chips.map((chip) => [chip.tierIndex, chip.minimumUnits])).toEqual([[0, 3], [1, 5]]);
    expect(chips[0]?.label).toBe("$ 1.402,50/u desde 3 u");
    expect(chips[1]?.label).toBe("$ 1.320/u desde 5 u");
    // El texto unido de siempre (compatibilidad con quien lo use como una sola línea) no cambió.
    expect(unitPromotionLabel(SUGAR, [T3, T5])).toBe("$ 1.402,50/u desde 3 u · $ 1.320/u desde 5 u");
  });

  it("sólo 3 u → un chip; sin escalones o sin precio → ninguno", () => {
    expect(unitPromotionChips(SUGAR, [T3]).map((chip) => chip.tierIndex)).toEqual([0]);
    expect(unitPromotionChips(SUGAR, [])).toEqual([]);
    expect(unitPromotionChips(SUGAR, null)).toEqual([]);
    expect(unitPromotionChips(0n, [T3, T5])).toEqual([]);
  });

  it("un escalón que no se muestra (lo tapa un pack del producto) NO corre el color de los demás", () => {
    const packRule = { id: "p", productId: "x", branchId: null, packQuantityUnits: 4, packPriceCents: 400_000 } as never;
    const chips = unitPromotionChips(SUGAR, [T3, T5], packRule);
    // El pack de 4 u tapa el escalón de 3 u; el de 5 u sigue siendo el 2.º (verde), no pasa a ámbar.
    expect(chips.map((chip) => [chip.tierIndex, chip.minimumUnits])).toEqual([[0, 3]]);
  });

  it("más de dos escalones: 2, 3, 5 y 10 → cuatro posiciones distintas", () => {
    const tiers = [tier("a", 2, 1_000), tier("b", 3, 1_500), tier("c", 5, 2_000), tier("d", 10, 2_500)];
    const chips = unitPromotionChips(SUGAR, tiers);
    expect(chips.map((chip) => chip.tierIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(chips.map((chip) => tierPalette(chip.tierIndex).variant)).size).toBe(4);
  });
});

describe("appliedTierMinimumUnits (qué escalón resalta el diálogo)", () => {
  it("devuelve el mayor escalón alcanzado", () => {
    expect(appliedTierMinimumUnits(SUGAR, 2, null, [T3, T5])).toBeNull();
    expect(appliedTierMinimumUnits(SUGAR, 3, null, [T3, T5])).toBe(3);
    expect(appliedTierMinimumUnits(SUGAR, 4, null, [T3, T5])).toBe(3);
    expect(appliedTierMinimumUnits(SUGAR, 5, null, [T3, T5])).toBe(5);
    expect(appliedTierMinimumUnits(SUGAR, 9, null, [T3, T5])).toBe(5);
  });

  it("una línea vendida como Pack no tiene escalón aplicado", () => {
    const packSale = { packCount: 1, packSizeUnits: 10, packDiscountBps: 2_500, packConfigId: "cfg" };
    expect(appliedTierMinimumUnits(SUGAR, 10, null, [T3, T5], packSale)).toBeNull();
  });

  it("sin escalones o con cantidad inválida → null", () => {
    expect(appliedTierMinimumUnits(SUGAR, 5, null, [])).toBeNull();
    expect(appliedTierMinimumUnits(SUGAR, 0, null, [T3])).toBeNull();
  });
});
