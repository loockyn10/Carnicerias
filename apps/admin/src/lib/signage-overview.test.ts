import { describe, expect, it } from "vitest";

import { displayNotes, parseDisplaysOverview, playableLabel, sourceLabel, type DisplayOverview } from "./signage-overview";
import { must } from "./test-support/must";

const raw = (overrides: Record<string, unknown> = {}) => ({
  id: "d1", name: "TV Central", enabled: true, branchId: "b1", branchName: "Central", slideDurationSeconds: 8, contentSource: "ALL_PROMOTIONS", folderId: null, folderName: null,
  tokenRotatedAt: "2026-10-10T12:00:00Z", legacyEntries: 0, playable: 12, blocked: 0, withoutPhoto: 0, ...overrides
});
const parse = (overrides: Record<string, unknown> = {}): DisplayOverview => must(parseDisplaysOverview([raw(overrides)])[0]);

describe("parseDisplaysOverview", () => {
  it("lee cada pantalla con su fuente y sus conteos de hoy; una fila rara se descarta", () => {
    const displays = parseDisplaysOverview([raw(), { id: "x" }, null, raw({ id: "d2", name: "TV Avenida", contentSource: "FOLDER", folderId: "f1", folderName: "Ofertas finde", playable: 7 })]);
    expect(displays.map((display) => display.name)).toEqual(["TV Central", "TV Avenida"]);
    expect(displays[1]).toMatchObject({ contentSource: "FOLDER", folderName: "Ofertas finde", playable: 7 });
  });

  it("una fuente desconocida cae en «todas las promociones activas» (el comportamiento por defecto)", () => {
    expect(parse({ contentSource: "RARA" }).contentSource).toBe("ALL_PROMOTIONS");
    expect(parse({ playable: "doce" }).playable).toBe(0);
    expect(parseDisplaysOverview("nada")).toEqual([]);
  });

  it("la duración se acota a lo permitido", () => {
    expect(parse({ slideDurationSeconds: 999 }).slideDurationSeconds).toBe(60);
    expect(parse({ slideDurationSeconds: 1 }).slideDurationSeconds).toBe(3);
  });
});

describe("textos de la tarjeta de cada pantalla", () => {
  it("fuente: «Todas las promociones activas» o «Carpeta · Ofertas finde»", () => {
    expect(sourceLabel(parse())).toBe("Todas las promociones activas");
    expect(sourceLabel(parse({ contentSource: "FOLDER", folderId: "f", folderName: "Ofertas finde" }))).toBe("Carpeta · Ofertas finde");
    expect(sourceLabel(parse({ contentSource: "MANUAL" }))).toMatch(/anterior/);
  });

  it("«12 promociones activas», «1 promoción activa» y el caso vacío", () => {
    expect(playableLabel(parse())).toBe("12 promociones activas");
    expect(playableLabel(parse({ playable: 1 }))).toBe("1 promoción activa");
    expect(playableLabel(parse({ playable: 0 }))).toBe("Sin promociones activas para reproducir");
    expect(playableLabel(parse({ playable: 3, contentSource: "FOLDER", folderId: "f", folderName: "X" }))).toBe("3 ofertas vigentes");
    expect(playableLabel(parse({ playable: 0, contentSource: "FOLDER", folderId: "f", folderName: "X" }))).toMatch(/carpeta/);
  });

  it("avisos: sin foto, bloqueadas, desactivada, sin ofertas y lista anterior", () => {
    expect(displayNotes(parse())).toEqual([]);
    const texts = (overrides: Record<string, unknown>) => displayNotes(parse(overrides)).map((note) => note.text).join(" | ");
    expect(texts({ withoutPhoto: 2 })).toMatch(/Sin foto: 2 se reproducen con un reemplazo/);
    expect(texts({ withoutPhoto: 1 })).toMatch(/Sin foto: 1 se reproduce con un reemplazo/);
    expect(texts({ blocked: 3 })).toMatch(/3 ofertas no se reproducen hoy/);
    expect(texts({ enabled: false })).toMatch(/desactivada/);
    expect(texts({ playable: 0 })).toMatch(/Próximamente nuevas ofertas/);
    expect(texts({ contentSource: "MANUAL", legacyEntries: 4 })).toMatch(/armada a mano \(4\)/);
  });
});
