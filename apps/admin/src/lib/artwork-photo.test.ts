import { describe, expect, it } from "vitest";

import {
  buildPhotoPath, extensionFor, fitWithin, formatBytes, isAcceptedInputType, isValidPhotoPath, MAX_PHOTO_BYTES, MAX_PHOTO_SIDE, planPhoto, PHOTO_TYPE_ERROR
} from "./artwork-photo";

const ORG = "c2000000-0000-4000-8000-000000000001";
const OTHER_ORG = "c2000000-0000-4000-8000-000000000002";
const PRODUCT = "c5000000-0000-4000-8000-000000000001";
const FILE = "c6000000-0000-4000-8000-000000000001";

describe("planPhoto — validación de la foto elegida", () => {
  it("rechaza lo que no es JPG, PNG o WebP", () => {
    for (const type of ["image/gif", "image/svg+xml", "application/pdf", "text/html", ""]) {
      expect(planPhoto({ type, size: 1_000, width: 100, height: 100 })).toEqual({ action: "reject", error: PHOTO_TYPE_ERROR });
    }
    expect(isAcceptedInputType("image/webp")).toBe(true);
    expect(isAcceptedInputType("image/gif")).toBe(false);
  });

  it("rechaza un archivo vacío", () => {
    expect(planPhoto({ type: "image/png", size: 0, width: 10, height: 10 }).action).toBe("reject");
  });

  it("sube tal cual un JPG o PNG razonable", () => {
    expect(planPhoto({ type: "image/jpeg", size: 800_000, width: 1600, height: 1200 })).toEqual({ action: "keep", type: "image/jpeg" });
    expect(planPhoto({ type: "image/png", size: MAX_PHOTO_BYTES, width: MAX_PHOTO_SIDE, height: 900 })).toEqual({ action: "keep", type: "image/png" });
  });

  it("convierte WebP a PNG (el renderizador de PNG no lee WebP)", () => {
    expect(planPhoto({ type: "image/webp", size: 90_000, width: 800, height: 600 })).toEqual({ action: "reencode", type: "image/png", width: 800, height: 600 });
  });

  it("reduce una foto de más de 2.400 px o de más de 5 MB conservando el tipo y la proporción", () => {
    expect(planPhoto({ type: "image/jpeg", size: 3_000_000, width: 4800, height: 3200 })).toEqual({ action: "reencode", type: "image/jpeg", width: 2400, height: 1600 });
    expect(planPhoto({ type: "image/jpeg", size: 7_000_000, width: 2000, height: 1500 })).toEqual({ action: "reencode", type: "image/jpeg", width: 2000, height: 1500 });
  });

  it("fitWithin nunca agranda", () => {
    expect(fitWithin(800, 600, 2400)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(6000, 3000, 2400)).toEqual({ width: 2400, height: 1200 });
    expect(fitWithin(3000, 6000, 2400)).toEqual({ width: 1200, height: 2400 });
  });
});

describe("rutas de Storage", () => {
  it("<organización>/<producto>/<uuid>.<ext>", () => {
    expect(buildPhotoPath(ORG, PRODUCT, FILE, "image/png")).toBe(`${ORG}/${PRODUCT}/${FILE}.png`);
    expect(buildPhotoPath(ORG.toUpperCase(), PRODUCT, FILE, "image/jpeg")).toBe(`${ORG}/${PRODUCT}/${FILE}.jpg`);
    expect(extensionFor("image/jpeg")).toBe("jpg");
  });

  it("sólo vale la ruta de ESTA organización y de ESTE producto", () => {
    const path = `${ORG}/${PRODUCT}/${FILE}.png`;
    expect(isValidPhotoPath(path, ORG, PRODUCT)).toBe(true);
    expect(isValidPhotoPath(path, OTHER_ORG, PRODUCT)).toBe(false);
    expect(isValidPhotoPath(path, ORG, "c5000000-0000-4000-8000-0000000000ff")).toBe(false);
    expect(isValidPhotoPath(`${OTHER_ORG}/${PRODUCT}/${FILE}.png`, ORG, PRODUCT)).toBe(false);
  });

  it("rechaza rutas manipuladas", () => {
    for (const bad of ["", "../x", `${ORG}/${PRODUCT}/${FILE}.webp`, `${ORG}/${PRODUCT}/${FILE}.png/../../x`, `${ORG}/${PRODUCT}/x.png`, null, 5]) {
      expect(isValidPhotoPath(bad, ORG, PRODUCT)).toBe(false);
    }
  });
});

describe("formatBytes", () => {
  it("KB y MB legibles", () => {
    expect(formatBytes(120_000)).toBe("117 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5,0 MB");
  });
});
