import { describe, expect, it } from "vitest";

import { buildZip, crc32, dosDateTime, isSafeZipPath } from "./zip";

/** Lector mínimo del directorio central (sólo para verificar lo que escribe `buildZip`). */
function readZip(zip: Uint8Array): { name: string; data: Uint8Array; crc: number; flags: number; method: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    // El encabezado local repite nombre y datos.
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(local + 26, true);
    expect(new TextDecoder().decode(zip.subarray(local + 30, local + 30 + localNameLength))).toBe(name);
    const data = zip.subarray(local + 30 + localNameLength, local + 30 + localNameLength + size);
    entries.push({ name, data, crc, flags, method });
    offset += 46 + nameLength;
  }
  return entries;
}

describe("buildZip", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

  it("crc32 coincide con el valor conocido de «123456789»", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("guarda cada archivo sin comprimir, con su CRC, en el orden dado y con nombres UTF-8", () => {
    const zip = buildZip([
      { path: "Ofertas finde - 11-10-2026/Feed/pata-muslo.png", data: png },
      { path: "Ofertas finde - 11-10-2026/Story/ñandú-ñoquis.png", data: new Uint8Array([9, 8, 7]) }
    ]);
    const entries = readZip(zip);
    expect(entries.map((entry) => entry.name)).toEqual(["Ofertas finde - 11-10-2026/Feed/pata-muslo.png", "Ofertas finde - 11-10-2026/Story/ñandú-ñoquis.png"]);
    expect(Array.from(entries[0]?.data ?? [])).toEqual(Array.from(png));
    expect(entries[0]?.crc).toBe(crc32(png));
    expect(entries.every((entry) => entry.method === 0 && (entry.flags & 0x0800) === 0x0800)).toBe(true);
  });

  it("un ZIP vacío es válido (sólo el cierre)", () => {
    expect(buildZip([])).toHaveLength(22);
  });

  it("rechaza rutas inseguras o repetidas (nada de «..», barras invertidas ni rutas absolutas)", () => {
    for (const path of ["../fuera.png", "/abs.png", "a\\b.png", "a//b.png", "carpeta/", "", "a/./b.png"]) {
      expect(isSafeZipPath(path), path).toBe(false);
      expect(() => buildZip([{ path, data: png }])).toThrow(RangeError);
    }
    expect(() => buildZip([{ path: "a.png", data: png }, { path: "a.png", data: png }])).toThrow(/repetida/);
    expect(isSafeZipPath("Ofertas finde - 11-10-2026/Feed/a.png")).toBe(true);
  });

  it("fecha MS-DOS: año desde 1980, mes y día", () => {
    const { date, time } = dosDateTime(new Date(2026, 9, 11, 14, 30, 10));
    expect(date).toBe(((2026 - 1980) << 9) | (10 << 5) | 11);
    expect(time).toBe((14 << 11) | (30 << 5) | 5);
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });
});
