import { describe, expect, it } from "vitest";

import type { Rect } from "./artwork-layout";
import { TV_AREA, TV_LAYOUTS, TV_NORMAL_LINE_HEIGHT, tvLayoutFor } from "./artwork-tv-layouts";
import { ARTWORK_FORMATS, BAND_WIDTH } from "./artwork-tokens";

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;
const inside = (inner: Rect, outer: Rect) => inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);
const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
const canvas: Rect = { x: 0, y: 0, w: ARTWORK_FORMATS.tv.width, h: ARTWORK_FORMATS.tv.height };

describe("TV_LAYOUTS — cuatro disposiciones 16:9", () => {
  it("hay cuatro, con ids distintos: foto izquierda, derecha, central y diagonal", () => {
    expect(TV_LAYOUTS.map((layout) => layout.id)).toEqual(["PHOTO_LEFT", "PHOTO_RIGHT", "PHOTO_CENTER", "DIAGONAL"]);
  });

  it("todo cae dentro del lienzo de 1920 × 1080, a la derecha de la franja verde y con la línea «precio normal» incluida", () => {
    for (const layout of TV_LAYOUTS) {
      for (const rect of [layout.photo, layout.headline, layout.name, layout.price]) {
        expect(inside(rect, canvas), layout.id).toBe(true);
        expect(rect.x, layout.id).toBeGreaterThanOrEqual(BAND_WIDTH.tv);
      }
      expect(bottom(layout.price) + 8 + TV_NORMAL_LINE_HEIGHT, layout.id).toBeLessThanOrEqual(canvas.h);
    }
  });

  it("la foto es la protagonista: ocupa entre 40 % y 55 % del área útil", () => {
    for (const layout of TV_LAYOUTS) {
      const share = (layout.photo.w * layout.photo.h) / (TV_AREA.w * TV_AREA.h);
      expect(share, layout.id).toBeGreaterThanOrEqual(0.4);
      expect(share, layout.id).toBeLessThanOrEqual(0.55);
    }
  });

  it("titular, nombre y precio no se pisan entre sí ni tapan la foto (la pastilla sólo la roza en la diagonal)", () => {
    for (const layout of TV_LAYOUTS) {
      expect(overlapArea(layout.headline, layout.name), layout.id).toBe(0);
      expect(overlapArea(layout.name, layout.price), layout.id).toBe(0);
      expect(overlapArea(layout.headline, layout.price), layout.id).toBe(0);
      expect(overlapArea(layout.headline, layout.photo), layout.id).toBe(0);
      expect(overlapArea(layout.name, layout.photo), layout.id).toBe(0);
      const touch = overlapArea(layout.price, layout.photo);
      if (layout.id === "DIAGONAL") expect(touch).toBeGreaterThan(0);
      else expect(touch, layout.id).toBe(0);
    }
  });

  it("las disposiciones son realmente distintas: la foto cambia de lugar", () => {
    const centers = TV_LAYOUTS.map((layout) => `${String(Math.round((layout.photo.x + layout.photo.w / 2) / 100))}-${String(Math.round((layout.photo.y + layout.photo.h / 2) / 100))}`);
    expect(new Set(centers).size).toBe(4);
    const [left, rightSide] = TV_LAYOUTS;
    expect(left && rightSide && left.photo.x < rightSide.photo.x).toBe(true);
    expect(left && left.name.x > left.photo.x + left.photo.w - 1).toBe(true);
    expect(rightSide && right(rightSide.name) <= rightSide.photo.x).toBe(true);
  });
});

describe("tvLayoutFor — asignación automática por posición", () => {
  it("la diapositiva n usa la variante n % 4: A, B, C, D, A…", () => {
    const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => tvLayoutFor(index).id);
    expect(ids).toEqual(["PHOTO_LEFT", "PHOTO_RIGHT", "PHOTO_CENTER", "DIAGONAL", "PHOTO_LEFT", "PHOTO_RIGHT", "PHOTO_CENTER", "DIAGONAL", "PHOTO_LEFT"]);
  });

  it("es determinística y tolera valores raros sin romper", () => {
    expect(tvLayoutFor(2)).toBe(tvLayoutFor(2));
    expect(tvLayoutFor(-1).id).toBe("DIAGONAL");
    expect(tvLayoutFor(Number.NaN).id).toBe("PHOTO_LEFT");
    expect(tvLayoutFor(2.9).id).toBe("PHOTO_CENTER");
  });
});
