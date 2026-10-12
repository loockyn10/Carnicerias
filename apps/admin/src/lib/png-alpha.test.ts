import { describe, expect, it } from "vitest";

import { analyzePngAlpha } from "./png-alpha";
import { makeJarPhoto, makeMeatPhoto, makePng } from "./test-support/artwork-fixtures";

describe("analyzePngAlpha: ¿el recorte tiene fondo transparente de verdad?", () => {
  it("un recorte sobre fondo transparente sí", () => {
    expect(analyzePngAlpha(makeMeatPhoto("transparent"))).toBe(true);
  });

  it("la misma foto sobre blanco (lo que sale de un JPG con fondo) no", () => {
    expect(analyzePngAlpha(makeMeatPhoto("white"))).toBe(false);
    expect(analyzePngAlpha(makeJarPhoto())).toBe(false);
  });

  it("un PNG RGBA todo opaco (muchos editores guardan así) no cuenta como transparente", () => {
    expect(analyzePngAlpha(makePng(64, 64, () => [200, 30, 30, 255]))).toBe(false);
  });

  it("un recorte con muy poca transparencia (bordes suavizados) no cambia el diseño: se trata como opaco", () => {
    const almostOpaque = makePng(100, 100, (x, y) => x === 0 && y < 50 ? [0, 0, 0, 0] : [200, 30, 30, 255]);
    expect(analyzePngAlpha(almostOpaque)).toBe(false);
  });

  it("lo que no se puede analizar devuelve null (la pieza lo trata como opaco)", () => {
    expect(analyzePngAlpha(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(analyzePngAlpha(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    const broken = new Uint8Array(makeMeatPhoto("transparent"));
    broken.fill(0, 60, 200);
    expect(analyzePngAlpha(broken)).toBeNull();
  });
});
