import { beforeEach, describe, expect, it, vi } from "vitest";

import { isMediaId, isValidImage, mediaVersion, readSignageMedia, signageMediaUrls } from "./signage-media";

const SLIDE = "0b1d6c1e-0000-4000-8000-000000000001";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
const payload = {
  status: "ACTIVE", organizationName: "X",
  logo: { storagePath: "org/branding/c2.png", contentType: "image/png", width: 10, height: 10 },
  slides: [
    { slideId: SLIDE, name: "A", photo: { storagePath: "org/prod/c1.jpg", contentType: "image/jpeg" } },
    { slideId: "0b1d6c1e-0000-4000-8000-000000000002", name: "B", photo: null }
  ]
};

describe("imágenes de la cartelería de TV", () => {
  it("valida el id (uuid de una diapositiva o «logo») y los bytes reales contra el tipo", () => {
    expect(isMediaId(SLIDE)).toBe(true);
    expect(isMediaId("logo")).toBe(true);
    expect(isMediaId("../etc/passwd")).toBe(false);
    expect(isMediaId("org/prod/c1.jpg")).toBe(false);
    expect(isValidImage(PNG, "image/png")).toBe(true);
    expect(isValidImage(JPG, "image/jpeg")).toBe(true);
    expect(isValidImage(PNG, "image/jpeg")).toBe(false);
    expect(isValidImage(new Uint8Array(), "image/png")).toBe(false);
    expect(isValidImage(new Uint8Array(6 * 1024 * 1024).fill(0xff), "image/jpeg")).toBe(false);
  });

  it("las URL llevan la versión del archivo (cambia con cada foto nueva) y apuntan al endpoint de la superficie", () => {
    const urls = signageMediaUrls("/api/tv/tok");
    expect(urls.photoUrl(SLIDE, { storagePath: "org/prod/c6000000-0000-4000-8000-000000000001.png", contentType: "image/png" }))
      .toBe(`/api/tv/tok/media/${SLIDE}?v=c6000000-0000-4000-8000-000000000001`);
    expect(urls.logoUrl({ storagePath: "org/branding/abc.jpg", contentType: "image/jpeg" })).toBe("/api/tv/tok/media/logo?v=abc");
    expect(mediaVersion("a/b/<script>.png")).toMatch(/^[0-9a-f-]*$/);
  });

  describe("readSignageMedia", () => {
    const download = vi.fn<(bucket: string, path: string) => Promise<Uint8Array | null>>();
    beforeEach(() => { download.mockReset(); });

    it("lee la ruta DE LA PRESENTACIÓN (nunca una que mande el navegador) del bucket privado", async () => {
      download.mockResolvedValue(JPG);
      const result = await readSignageMedia(payload, SLIDE, download);
      expect(result).toEqual({ kind: "ok", bytes: JPG, contentType: "image/jpeg" });
      expect(download).toHaveBeenCalledWith("product-artwork", "org/prod/c1.jpg");
    });

    it("el logo sale del nivel superior de la presentación", async () => {
      download.mockResolvedValue(PNG);
      expect((await readSignageMedia(payload, "logo", download)).kind).toBe("ok");
      expect(download).toHaveBeenCalledWith("product-artwork", "org/branding/c2.png");
    });

    it("un id que no es de la presentación, sin foto o mal formado: 404 sin tocar Storage", async () => {
      expect((await readSignageMedia(payload, "0b1d6c1e-0000-4000-8000-0000000000ff", download)).kind).toBe("not_found");
      expect((await readSignageMedia(payload, "0b1d6c1e-0000-4000-8000-000000000002", download)).kind).toBe("not_found");
      expect((await readSignageMedia(payload, "org/prod/c1.jpg", download)).kind).toBe("not_found");
      expect((await readSignageMedia(null, SLIDE, download)).kind).toBe("not_found");
      expect(download).not.toHaveBeenCalled();
    });

    it("bytes que no son del tipo registrado (o un archivo roto): no se sirven", async () => {
      download.mockResolvedValue(PNG);
      expect((await readSignageMedia(payload, SLIDE, download)).kind).toBe("not_found");
      download.mockResolvedValue(new Uint8Array([1, 2, 3]));
      expect((await readSignageMedia(payload, SLIDE, download)).kind).toBe("not_found");
    });

    it("una falla de Storage (null o excepción) es transitoria: el televisor reintenta y conserva lo que tiene", async () => {
      download.mockResolvedValue(null);
      expect((await readSignageMedia(payload, SLIDE, download)).kind).toBe("error");
      download.mockRejectedValue(new Error("red"));
      expect((await readSignageMedia(payload, SLIDE, download)).kind).toBe("error");
    });
  });
});
