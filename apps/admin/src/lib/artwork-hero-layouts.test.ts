import { describe, expect, it } from "vitest";

import { HERO_VARIANTS, heroLayout, isHeroVariant, pickHeroVariant, type HeroLayout, type HeroVariantId } from "./artwork-hero-layouts";
import type { Rect } from "./artwork-layout";
import { ARTWORK_FORMATS, STORY_SAFE } from "./artwork-tokens";

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;
const area = (r: Rect) => r.w * r.h;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));

/** Caja de la foto de la composición ANTERIOR (D-074/D-075), medida en las muestras viejas: la base para «15–30 % más presencia». */
const OLD_PHOTO_AREA = { feed: 854 * 512, story: 854 * 523 } as const;

describe("pickHeroVariant: la composición se elige sin azar", () => {
  it("la configurada manda sobre todo lo demás", () => {
    expect(pickHeroVariant({ explicit: "PRICE_FIRST", index: 0, seed: "x" })).toBe("PRICE_FIRST");
  });

  it("en una serie (carpeta) rota A, B, C, D, A… por la posición", () => {
    const ids = [0, 1, 2, 3, 4, 5].map((index) => pickHeroVariant({ index }));
    expect(ids).toEqual(["CENTER", "PHOTO_LEFT", "PHOTO_RIGHT", "PRICE_FIRST", "CENTER", "PHOTO_LEFT"]);
    expect(pickHeroVariant({ index: -1 })).toBe("PRICE_FIRST");
  });

  it("sin posición ni configuración, la deriva del producto: siempre la misma para ese producto, y alcanza las cuatro", () => {
    expect(pickHeroVariant({ seed: "prod-1" })).toBe(pickHeroVariant({ seed: "prod-1" }));
    const seen = new Set(Array.from({ length: 60 }, (_, index) => pickHeroVariant({ seed: `producto-${String(index)}` })));
    expect(seen.size).toBe(4);
  });

  it("una variante inválida se ignora", () => {
    expect(isHeroVariant("CENTER")).toBe(true);
    expect(isHeroVariant("OTRA")).toBe(false);
    expect(pickHeroVariant({ explicit: "OTRA" as HeroVariantId, index: 1 })).toBe("PHOTO_LEFT");
  });
});

describe("heroLayout: geometría de cada composición", () => {
  const cases = (["feed", "story"] as const).flatMap((format) => HERO_VARIANTS.flatMap((variant) => [true, false].map((promo) => ({ format, variant, promo }))));

  it.each(cases)("$format · $variant · promo=$promo: todo entra en el lienzo", ({ format, variant, promo }) => {
    const layout = heroLayout(format, variant, { promo, mechanic: promo });
    const spec = ARTWORK_FORMATS[format];
    for (const [name, rect] of Object.entries({ headline: layout.headline, name: layout.name, photo: layout.photo, price: layout.price, contact: layout.contact, mechanic: layout.mechanic, sticker: layout.sticker, normal: layout.normal })) {
      expect(rect.x, name).toBeGreaterThanOrEqual(0);
      expect(rect.y, name).toBeGreaterThanOrEqual(0);
      expect(right(rect), name).toBeLessThanOrEqual(spec.width);
      expect(bottom(rect), name).toBeLessThanOrEqual(spec.height);
    }
  });

  it.each(cases)("$format · $variant · promo=$promo: el titular y el nombre no se pisan ni tapan la foto; el precio no tapa el contacto", ({ format, variant, promo }) => {
    const layout: HeroLayout = heroLayout(format, variant, { promo, mechanic: promo });
    expect(overlap(layout.headline, layout.name)).toBe(0);
    expect(overlap(layout.headline, layout.photo)).toBe(0);
    expect(overlap(layout.name, layout.photo)).toBe(0);
    expect(overlap(layout.price, layout.contact)).toBe(0);
    expect(overlap(layout.normal, layout.contact)).toBe(0);
    expect(overlap(layout.headline, layout.price)).toBe(0);
  });

  it("Story respeta las zonas seguras: nada importante arriba de 250 px ni abajo de 340 px", () => {
    for (const variant of HERO_VARIANTS) {
      const layout = heroLayout("story", variant, { promo: true, mechanic: true });
      const limit = ARTWORK_FORMATS.story.height - STORY_SAFE.bottom;
      for (const rect of [layout.headline, layout.name, layout.photo, layout.price, layout.contact, layout.normal]) {
        expect(rect.y, variant).toBeGreaterThanOrEqual(STORY_SAFE.top - 8);
        expect(bottom(rect), variant).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("la foto gana presencia: entre 15 % y 45 % más que la composición anterior (hasta 30 % de objetivo) en cada composición con promoción", () => {
    for (const format of ["feed", "story"] as const) {
      for (const variant of HERO_VARIANTS) {
        const gain = area(heroLayout(format, variant, { promo: true, mechanic: true }).photo) / OLD_PHOTO_AREA[format] - 1;
        expect(gain, `${format} ${variant}`).toBeGreaterThanOrEqual(0.15);
      }
    }
    // La composición central (la más parecida a la anterior) queda en el rango pedido: 15–45 %.
    for (const format of ["feed", "story"] as const) {
      const gain = area(heroLayout(format, "CENTER", { promo: true, mechanic: true }).photo) / OLD_PHOTO_AREA[format] - 1;
      expect(gain).toBeLessThanOrEqual(0.45);
    }
  });

  it("las cuatro composiciones son realmente distintas (foto y precio cambian de lugar)", () => {
    for (const format of ["feed", "story"] as const) {
      const signature = HERO_VARIANTS.map((variant) => {
        const layout = heroLayout(format, variant, { promo: true, mechanic: true });
        return `${String(layout.photo.x)}:${String(layout.photo.y)}:${layout.priceAlign}:${layout.headlineAlign}:${String(layout.price.y)}`;
      });
      expect(new Set(signature).size).toBe(4);
    }
  });

  it("PHOTO_LEFT pone la foto a la izquierda y el precio a la derecha; PHOTO_RIGHT, al revés", () => {
    const left = heroLayout("feed", "PHOTO_LEFT", { promo: true, mechanic: true });
    const rightSide = heroLayout("feed", "PHOTO_RIGHT", { promo: true, mechanic: true });
    expect(left.photo.x).toBeLessThan(rightSide.photo.x);
    expect(left.priceAlign).toBe("end");
    expect(rightSide.priceAlign).toBe("start");
  });

  it("PRICE_FIRST pone el precio arriba de la foto", () => {
    const layout = heroLayout("feed", "PRICE_FIRST", { promo: true, mechanic: true });
    expect(layout.price.y).toBeLessThan(layout.photo.y);
  });

  it("es una función pura: la misma entrada da la misma geometría", () => {
    expect(heroLayout("feed", "CENTER", { promo: true, mechanic: true })).toEqual(heroLayout("feed", "CENTER", { promo: true, mechanic: true }));
  });
});
