import { describe, expect, it } from "vitest";

import { collageLayout, contactRect, contentColumn, tileParts, verticalBounds, type CollageFormat, type Rect } from "./artwork-layout";
import { ARTWORK_FORMATS, BAND_WIDTH, STORY_SAFE } from "./artwork-tokens";

const FORMATS: CollageFormat[] = ["feed", "story"];
const COUNTS = [2, 3, 4, 5] as const;

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;
const inside = (inner: Rect, outer: Rect) => inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);
const overlaps = (a: Rect, b: Rect) => a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);

describe("collageLayout — distribución según la cantidad", () => {
  it("2 a 5 productos: una pieza por producto, ninguna fuera del área ni pisada con otra", () => {
    for (const format of FORMATS) {
      for (const count of COUNTS) {
        const layout = collageLayout(count, format);
        expect(layout.tiles).toHaveLength(count);
        layout.tiles.forEach((tile, index) => {
          expect(inside(tile.rect, layout.area), `${format} ${String(count)} #${String(index)} dentro del área`).toBe(true);
          layout.tiles.slice(index + 1).forEach((other) => { expect(overlaps(tile.rect, other.rect)).toBe(false); });
          expect(overlaps(tile.rect, layout.contact)).toBe(false);
          expect(overlaps(tile.rect, layout.headline)).toBe(false);
        });
      }
    }
  });

  it("no más de 5 ni menos de 2", () => {
    expect(() => collageLayout(1, "feed")).toThrow(RangeError);
    expect(() => collageLayout(6, "feed")).toThrow(RangeError);
    expect(() => collageLayout(2.5, "story")).toThrow(RangeError);
  });

  it("layouts específicos: 2 apilados, 3 = 2 + 1 grande, 4 = 2×2, 5 = 2 + 2 + 1 ancho", () => {
    for (const format of FORMATS) {
      const two = collageLayout(2, format).tiles;
      expect(two[0]?.rect.w).toBe(two[1]?.rect.w);
      expect((two[1]?.rect.y ?? 0) > (two[0]?.rect.y ?? 0)).toBe(true);

      const three = collageLayout(3, format).tiles;
      expect(three[0]?.rect.y).toBe(three[1]?.rect.y);
      expect((three[2]?.rect.w ?? 0)).toBeGreaterThan((three[0]?.rect.w ?? 0) * 1.9);
      expect((three[2]?.rect.h ?? 0)).toBeGreaterThan(three[0]?.rect.h ?? 0);

      const four = collageLayout(4, format).tiles;
      expect(new Set(four.map((tile) => tile.rect.y)).size).toBe(2);
      expect(new Set(four.map((tile) => tile.rect.x)).size).toBe(2);

      const five = collageLayout(5, format).tiles;
      expect(new Set(five.map((tile) => tile.rect.y)).size).toBe(3);
      expect(five[4]?.rect.w).toBe(collageLayout(5, format).area.w);
      expect(five[4]?.variant).toBe("side");
      expect(five.slice(0, 4).every((tile) => tile.variant === "stack")).toBe(true);
    }
  });

  it("el orden de las piezas es el de lectura: izquierda a derecha, arriba a abajo", () => {
    for (const format of FORMATS) {
      for (const count of COUNTS) {
        const tiles = collageLayout(count, format).tiles;
        tiles.slice(1).forEach((tile, index) => {
          const previous = tiles[index]?.rect;
          if (!previous) return;
          expect(tile.rect.y > previous.y || (tile.rect.y === previous.y && tile.rect.x > previous.x)).toBe(true);
        });
      }
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
  it("todo queda dentro del mosaico y la pastilla se superpone sólo al borde de la foto", () => {
    for (const format of FORMATS) {
      for (const count of COUNTS) {
        for (const hasCondition of [false, true]) {
          for (const tile of collageLayout(count, format).tiles) {
            const parts = tileParts(tile, hasCondition);
            for (const rect of [parts.name, parts.photo, parts.price]) expect(inside(rect, tile.rect), `${format} ${String(count)} ${tile.variant}`).toBe(true);
            expect(parts.photo.h).toBeGreaterThan(60);
            expect(parts.price.h).toBeGreaterThanOrEqual(60);
            expect(parts.nameMaxLines).toBeGreaterThanOrEqual(2);
            if (tile.variant === "stack") expect(bottom(parts.name)).toBeLessThanOrEqual(parts.photo.y);
          }
        }
      }
    }
  });

  it("con promoción la pastilla es más alta (lleva la condición debajo del precio)", () => {
    const tile = collageLayout(4, "feed").tiles[0];
    if (!tile) throw new Error("sin mosaico");
    expect(tileParts(tile, true).price.h).toBeGreaterThan(tileParts(tile, false).price.h);
  });
});
