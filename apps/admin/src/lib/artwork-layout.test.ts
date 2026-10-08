import { describe, expect, it } from "vitest";

import { COLLAGE_LAYOUTS, COLLAGE_PRICE_SCALE } from "./artwork-collage-slots";
import { collageLayout, contactRect, contentColumn, tileParts, verticalBounds, type CollageFormat, type Rect } from "./artwork-layout";
import { ARTWORK_FORMATS, BAND_WIDTH, STORY_SAFE } from "./artwork-tokens";

const FORMATS: CollageFormat[] = ["feed", "story"];
const COUNTS = [2, 3, 4, 5] as const;

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;
const inside = (inner: Rect, outer: Rect) => inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);
const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
const overlaps = (a: Rect, b: Rect) => overlapArea(a, b) > 0;
const center = (r: Rect) => r.x + r.w / 2;

/** Collage anterior (grilla 2 × 2, etc.): foto en px² por pieza y alto de la pastilla de precio, para medir la mejora. */
const LEGACY_PHOTO_AREA: Record<CollageFormat, Record<(typeof COUNTS)[number], number[]>> = {
  feed: { 2: [250_222, 250_222], 3: [103_664, 103_664, 312_564], 4: [138_358, 138_358, 138_358, 138_358], 5: [82_346, 82_346, 82_346, 82_346, 133_200] },
  story: { 2: [250_222, 250_222], 3: [109_098, 109_098, 331_352], 4: [145_046, 145_046, 145_046, 145_046], 5: [86_944, 86_944, 86_944, 86_944, 138_528] }
};
const LEGACY_BADGE_H: Record<CollageFormat, Record<(typeof COUNTS)[number], number[]>> = {
  feed: { 2: [133, 133], 3: [106, 106, 150], 4: [133, 133, 133, 133], 5: [90, 90, 90, 90, 112] },
  story: { 2: [138, 138], 3: [110, 110, 150], 4: [138, 138, 138, 138], 5: [93, 93, 93, 93, 118] }
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const photoAreas = (count: (typeof COUNTS)[number], format: CollageFormat) => {
  const layout = collageLayout(count, format);
  return layout.tiles.map((tile) => { const photo = tileParts(tile, false, layout.area).photo; return photo.w * photo.h; });
};

describe("collageLayout — composición asimétrica por cantidad", () => {
  it("2 a 5 productos: una pieza por producto, todo dentro del área y sin pisar titular ni contacto", () => {
    for (const format of FORMATS) {
      for (const count of COUNTS) {
        const layout = collageLayout(count, format);
        expect(layout.tiles).toHaveLength(count);
        for (const tile of layout.tiles) {
          for (const hasCondition of [false, true]) {
            const parts = tileParts(tile, hasCondition, layout.area);
            for (const rect of [parts.name, parts.photo, parts.price]) {
              expect(inside(rect, layout.area), `${format} ${String(count)} dentro del área`).toBe(true);
              expect(overlaps(rect, layout.contact)).toBe(false);
              expect(overlaps(rect, layout.headline)).toBe(false);
            }
          }
        }
      }
    }
  });

  it("no más de 5 ni menos de 2", () => {
    expect(() => collageLayout(1, "feed")).toThrow(RangeError);
    expect(() => collageLayout(6, "feed")).toThrow(RangeError);
    expect(() => collageLayout(2.5, "story")).toThrow(RangeError);
  });

  it("nombres y precios nunca se pisan entre sí ni con otro nombre; las fotos sólo se rozan en una franja angosta", () => {
    for (const format of FORMATS) {
      for (const count of COUNTS) {
        const layout = collageLayout(count, format);
        const parts = layout.tiles.map((tile) => tileParts(tile, true, layout.area));
        parts.forEach((a, i) => {
          parts.forEach((b, j) => {
            if (i === j) return;
            const label = `${format} ${String(count)} (${String(i)},${String(j)})`;
            expect(overlaps(a.name, b.name), `${label} nombres`).toBe(false);
            expect(overlaps(a.name, b.price), `${label} nombre/precio`).toBe(false);
            expect(overlaps(a.price, b.price), `${label} precios`).toBe(false);
            if (j > i) expect(overlapArea(a.photo, b.photo), `${label} fotos`).toBeLessThan(0.08 * Math.min(a.photo.w * a.photo.h, b.photo.w * b.photo.h));
          });
        });
      }
    }
  });

  it("no es una grilla: con 3, 4 o 5 productos ninguno comparte el mismo Y y las alturas varían", () => {
    for (const format of FORMATS) {
      for (const count of [3, 4, 5] as const) {
        const tiles = collageLayout(count, format).tiles;
        expect(new Set(tiles.map((tile) => tile.rect.y)).size, `${format} ${String(count)}: todos con Y distinto`).toBe(count);
        expect(new Set(tiles.map((tile) => tile.rect.h)).size).toBeGreaterThan(1);
      }
    }
  });

  it("alternancia izquierda/derecha: la lectura va en zig-zag (cada pieza cae del lado opuesto a la anterior)", () => {
    for (const format of FORMATS) {
      for (const count of [3, 4, 5] as const) {
        const layout = collageLayout(count, format);
        const middle = center(layout.area);
        const sides = layout.tiles.map((tile) => (center(tile.rect) < middle ? "L" : "R"));
        sides.slice(1).forEach((side, index) => { expect(side, `${format} ${String(count)} #${String(index + 1)}`).not.toBe(sides[index]); });
      }
      // Con 2 productos: una diagonal.
      const [a, b] = collageLayout(2, format).tiles;
      if (!a || !b) throw new Error("sin piezas");
      expect(Math.sign(center(a.rect) - center(b.rect))).not.toBe(0);
      expect(b.rect.y).toBeGreaterThan(a.rect.y);
    }
  });

  it("el recorrido baja pieza a pieza; con 5 productos se intercalan chicos y grandes (3 + 2)", () => {
    for (const format of FORMATS) {
      for (const count of COUNTS) {
        const ys = collageLayout(count, format).tiles.map((tile) => tile.rect.y);
        ys.slice(1).forEach((y, index) => { expect(y).toBeGreaterThan(ys[index] ?? 0); });
      }
      const five = collageLayout(5, format).tiles;
      expect(five[1]?.rect.h).toBeGreaterThan(five[0]?.rect.h ?? 0);
      expect(five[3]?.rect.h).toBeGreaterThan(five[2]?.rect.h ?? 0);
    }
  });

  it("hay aire entre el titular y el primer nombre (la pieza no arranca como una tabla)", () => {
    for (const format of FORMATS) {
      for (const count of COUNTS) {
        const layout = collageLayout(count, format);
        const first = layout.tiles[0];
        if (!first) throw new Error("sin pieza");
        expect(first.name.y - bottom(layout.headline)).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it("las fotos son mayores que en el collage anterior: la mayor de cada pieza y el promedio con 5 productos", () => {
    for (const format of FORMATS) {
      for (const count of COUNTS) {
        const areas = photoAreas(count, format);
        const legacy = LEGACY_PHOTO_AREA[format][count];
        // Con 3 productos el collage anterior tenía uno enorme a todo el ancho: ahí se compara el promedio.
        if (count !== 3) expect(Math.max(...areas), `${format} ${String(count)} máxima`).toBeGreaterThan(Math.max(...legacy) * 1.0);
        if (count === 5) expect(sum(areas) / count, `${format} 5 promedio`).toBeGreaterThanOrEqual((sum(legacy) / count) * 1.1);
        if (count === 4) expect(sum(areas) / count, `${format} 4 promedio`).toBeGreaterThanOrEqual((sum(legacy) / count) * 0.97);
      }
    }
    // Feed 4: la foto mayor crece al menos 15 %.
    expect(Math.max(...photoAreas(4, "feed"))).toBeGreaterThanOrEqual(138_358 * 1.15);
  });

  it("la pastilla de precio usa la escala reducida (80–85 % del collage anterior)", () => {
    expect(COLLAGE_PRICE_SCALE).toBeGreaterThanOrEqual(0.8);
    expect(COLLAGE_PRICE_SCALE).toBeLessThanOrEqual(0.85);
    for (const format of FORMATS) {
      for (const count of COUNTS) {
        const legacy = LEGACY_BADGE_H[format][count];
        const heights = COLLAGE_LAYOUTS[format][count].map((slot) => slot.badgeH);
        // En promedio la pastilla mide entre 80 y 90 % de la anterior y ninguna supera la mayor de antes.
        const ratio = sum(heights) / sum(legacy);
        expect(ratio, `${format} ${String(count)}`).toBeLessThanOrEqual(0.9);
        expect(ratio).toBeGreaterThanOrEqual(0.78);
        heights.forEach((height) => { expect(height).toBeLessThanOrEqual(Math.max(...legacy)); });
      }
    }
  });

  it("Feed y Story usan layouts propios (no se reutilizan las coordenadas) y Story arranca por el lado opuesto", () => {
    for (const count of COUNTS) {
      expect(COLLAGE_LAYOUTS.feed[count]).not.toEqual(COLLAGE_LAYOUTS.story[count]);
      expect(collageLayout(count, "feed").tiles.map((tile) => tile.slot)).toEqual(COLLAGE_LAYOUTS.feed[count]);
      expect(collageLayout(count, "story").tiles.map((tile) => tile.slot)).toEqual(COLLAGE_LAYOUTS.story[count]);
    }
    for (const count of [3, 4, 5] as const) {
      const startsLeft = (format: CollageFormat) => {
        const layout = collageLayout(count, format);
        const tile = layout.tiles[0];
        return tile ? center(tile.rect) < center(layout.area) : false;
      };
      expect(startsLeft("story")).not.toBe(startsLeft("feed"));
    }
  });

  it("preview y PNG comparten la configuración: la misma función, determinística", () => {
    for (const format of FORMATS) {
      for (const count of COUNTS) expect(collageLayout(count, format)).toEqual(collageLayout(count, format));
    }
  });
});

describe("zonas seguras y márgenes", () => {
  it("todo cabe dentro del lienzo y a la derecha de la franja verde", () => {
    for (const format of FORMATS) {
      const spec = ARTWORK_FORMATS[format];
      const column = contentColumn(format);
      expect(column.x).toBeGreaterThan(BAND_WIDTH[format]);
      expect(column.x + column.w).toBeLessThanOrEqual(spec.width);
      for (const count of COUNTS) {
        const layout = collageLayout(count, format);
        expect(inside(layout.contact, { x: 0, y: 0, w: spec.width, h: spec.height })).toBe(true);
        expect(inside(layout.headline, { x: 0, y: 0, w: spec.width, h: spec.height })).toBe(true);
      }
    }
  });

  it("Story: titular, mosaicos y contacto quedan entre la zona segura superior e inferior", () => {
    const { height } = ARTWORK_FORMATS.story;
    for (const count of COUNTS) {
      const layout = collageLayout(count, "story");
      expect(layout.headline.y).toBeGreaterThanOrEqual(STORY_SAFE.top);
      expect(bottom(layout.contact)).toBeLessThanOrEqual(height - STORY_SAFE.bottom);
      for (const tile of layout.tiles) {
        expect(tile.rect.y).toBeGreaterThanOrEqual(STORY_SAFE.top);
        expect(bottom(tile.rect)).toBeLessThanOrEqual(height - STORY_SAFE.bottom);
      }
    }
    expect(verticalBounds("story")).toEqual({ top: STORY_SAFE.top, bottom: height - STORY_SAFE.bottom });
  });

  it("el contacto va abajo a la izquierda de la columna de contenido", () => {
    for (const format of FORMATS) {
      const contact = contactRect(format);
      expect(contact.x).toBe(contentColumn(format).x);
      expect(bottom(contact)).toBe(verticalBounds(format).bottom);
    }
  });
});

describe("tileParts — nombre, foto y precio dentro de cada pieza", () => {
  it("nombre arriba de la foto (2 renglones) y la pastilla se superpone sólo al borde inferior de la foto", () => {
    for (const format of FORMATS) {
      for (const count of COUNTS) {
        const layout = collageLayout(count, format);
        for (const hasCondition of [false, true]) {
          for (const tile of layout.tiles) {
            const parts = tileParts(tile, hasCondition, layout.area);
            expect(bottom(parts.name)).toBeLessThanOrEqual(parts.photo.y);
            expect(parts.nameMaxLines).toBe(2);
            expect(parts.photo.h).toBeGreaterThan(60);
            expect(parts.price.h).toBeGreaterThanOrEqual(60);
            expect(parts.photo.y + parts.photo.h).toBeGreaterThan(parts.price.y);
            expect(parts.photo.y + parts.photo.h).toBeLessThanOrEqual(bottom(parts.price));
          }
        }
      }
    }
  });

  it("con promoción la pastilla es más alta (lleva la condición debajo del precio)", () => {
    const layout = collageLayout(4, "feed");
    const tile = layout.tiles[0];
    if (!tile) throw new Error("sin mosaico");
    expect(tileParts(tile, true, layout.area).price.h).toBeGreaterThan(tileParts(tile, false, layout.area).price.h);
  });

  it("la pastilla se ancla hacia el borde exterior de su foto según el slot", () => {
    const layout = collageLayout(4, "feed");
    layout.tiles.forEach((tile) => {
      const parts = tileParts(tile, false, layout.area);
      if (tile.slot.pricePlacement === "end") expect(right(parts.price)).toBe(right(tile.rect));
      if (tile.slot.pricePlacement === "start") expect(parts.price.x).toBe(tile.rect.x);
      expect(parts.priceAlign).toBe(tile.slot.pricePlacement);
    });
  });
});
