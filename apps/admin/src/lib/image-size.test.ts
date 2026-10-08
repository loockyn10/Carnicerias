import { describe, expect, it } from "vitest";

import { readImageInfo } from "./image-size";
import { makeLogoPng, makeMeatPhoto, sampleJpegBytes } from "./test-support/artwork-fixtures";

describe("readImageInfo", () => {
  it("PNG: tipo y medidas reales de la cabecera", () => {
    expect(readImageInfo(makeLogoPng())).toEqual({ type: "image/png", width: 480, height: 120 });
    expect(readImageInfo(makeMeatPhoto())).toEqual({ type: "image/png", width: 800, height: 560 });
  });

  it("JPEG: tipo y medidas del marcador SOF", () => {
    expect(readImageInfo(sampleJpegBytes())).toEqual({ type: "image/jpeg", width: 320, height: 200 });
  });

  it("lo que no es PNG/JPEG (HTML, GIF, vacío, PNG truncado) no se entiende", () => {
    expect(readImageInfo(new TextEncoder().encode("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(readImageInfo(new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000"))).toBeNull();
    expect(readImageInfo(new Uint8Array(0))).toBeNull();
    expect(readImageInfo(makeLogoPng().slice(0, 12))).toBeNull();
    expect(readImageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});
