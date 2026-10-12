import { describe, expect, it } from "vitest";

import { burstPoints, organicBlobPath, organicPillPath, seedFromText } from "./artwork-shapes";

const numbers = (path: string) => (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe("formas orgánicas determinísticas", () => {
  it("la misma semilla da siempre la misma mancha (regenerar una pieza nunca la cambia) y otra semilla, otra forma", () => {
    expect(organicBlobPath(7)).toBe(organicBlobPath(7));
    expect(organicBlobPath(7)).not.toBe(organicBlobPath(8));
    expect(organicPillPath(3)).toBe(organicPillPath(3));
  });

  it("la mancha es un contorno cerrado y nunca se sale del lienzo 0..100", () => {
    for (const seed of [0, 1, 7, 99, 12345, 4294967295]) {
      const path = organicBlobPath(seed, { wobble: 0.3 });
      expect(path.startsWith("M")).toBe(true);
      expect(path.endsWith("Z")).toBe(true);
      const values = numbers(path);
      expect(Math.min(...values)).toBeGreaterThanOrEqual(-10);
      expect(Math.max(...values)).toBeLessThanOrEqual(110);
    }
  });

  it("la «squircle» del precio cubre las esquinas del texto: llega cerca de los cuatro bordes y se queda dentro", () => {
    const values = numbers(organicPillPath(5));
    const xs = values.filter((_, index) => index % 2 === 0);
    const ys = values.filter((_, index) => index % 2 === 1);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(100);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect(Math.min(...xs)).toBeLessThanOrEqual(4);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(96);
    // Más cuadrada = más cobertura de las esquinas que una elipse.
    const corner = (path: string) => { const v = numbers(path); return v.filter((_, i) => i % 2 === 0).map((x, i) => Math.min(x, 100 - x) + Math.min(v[i * 2 + 1] ?? 0, 100 - (v[i * 2 + 1] ?? 0))).reduce((a, b) => Math.min(a, b), 1000); };
    expect(corner(organicPillPath(5, { squareness: 6, jitter: 0 }))).toBeLessThan(corner(organicPillPath(5, { squareness: 2, jitter: 0 })));
  });

  it("el sello tiene el doble de vértices que puntas y entra en el lienzo", () => {
    const points = burstPoints(18, 0.88).split(" ");
    expect(points).toHaveLength(36);
    for (const point of points) {
      const [x, y] = point.split(",").map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
    expect(burstPoints(2).split(" ").length).toBe(16);
  });

  it("seedFromText es estable y distingue textos", () => {
    expect(seedFromText("feed-CENTER")).toBe(seedFromText("feed-CENTER"));
    expect(seedFromText("feed-CENTER")).not.toBe(seedFromText("story-CENTER"));
  });
});
