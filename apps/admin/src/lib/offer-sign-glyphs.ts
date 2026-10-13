import { inflateSync } from "node:zlib";

import { ARTWORK_DISPLAY_FONT_400_BASE64 } from "./artwork-display-font-data";

/**
 * Contornos vectoriales de Anton (la fuente de títulos de la cartelería, ya embebida en WOFF) para dibujar los carteles impresos A4 (D-087).
 * El PDF dibuja cada letra como una figura rellena: no depende de ninguna fuente instalada ni de Google Fonts, y el cartel se imprime igual
 * en cualquier equipo. Sólo servidor (usa zlib de Node). Lee únicamente lo necesario del WOFF: `head`, `maxp`, `cmap` (formato 4),
 * `hmtx`/`hhea`, `loca` y `glyf` (simples y compuestos, como las vocales con tilde).
 */

export interface GlyphOutline {
  /** Avance horizontal en unidades de la fuente. */
  advance: number;
  /** Contornos: cada punto es [x, y, enCurva] con el eje Y hacia ARRIBA (como en la fuente). */
  contours: [number, number, boolean][][];
}

export interface OutlineFont {
  unitsPerEm: number;
  /** Altura de las mayúsculas, en unidades de la fuente (medida sobre la «H»). */
  capHeight: number;
  glyphFor: (codePoint: number) => GlyphOutline | null;
}

interface Table { offset: number; length: number }

function readTables(bytes: Buffer): Map<string, Buffer> {
  if (bytes.toString("latin1", 0, 4) !== "wOFF") throw new Error("La fuente embebida no es WOFF");
  const count = bytes.readUInt16BE(12);
  const tables = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    const entry = 44 + index * 20;
    const offset = bytes.readUInt32BE(entry + 4);
    const compressed = bytes.readUInt32BE(entry + 8);
    const original = bytes.readUInt32BE(entry + 12);
    const raw = bytes.subarray(offset, offset + compressed);
    tables.set(bytes.toString("latin1", entry, entry + 4), compressed < original ? inflateSync(raw) : raw);
  }
  return tables;
}

function need(tables: Map<string, Buffer>, name: string): Buffer {
  const table = tables.get(name);
  if (!table) throw new Error(`Falta la tabla ${name} en la fuente`);
  return table;
}

/** `cmap` formato 4 (BMP) → código Unicode a índice de glifo. */
function readCmap(cmap: Buffer): (codePoint: number) => number {
  const count = cmap.readUInt16BE(2);
  let subtable = -1;
  for (let index = 0; index < count; index += 1) {
    const platform = cmap.readUInt16BE(4 + index * 8);
    const encoding = cmap.readUInt16BE(6 + index * 8);
    const offset = cmap.readUInt32BE(8 + index * 8);
    if ((platform === 3 && encoding === 1) || platform === 0) { subtable = offset; if (platform === 3) break; }
  }
  if (subtable < 0 || cmap.readUInt16BE(subtable) !== 4) throw new Error("La fuente no trae un cmap formato 4");
  const segments = cmap.readUInt16BE(subtable + 6) / 2;
  const endCodes = subtable + 14;
  const startCodes = endCodes + segments * 2 + 2;
  const deltas = startCodes + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  return (codePoint) => {
    for (let segment = 0; segment < segments; segment += 1) {
      if (codePoint > cmap.readUInt16BE(endCodes + segment * 2)) continue;
      const start = cmap.readUInt16BE(startCodes + segment * 2);
      if (codePoint < start) return 0;
      const rangeOffset = cmap.readUInt16BE(rangeOffsets + segment * 2);
      const delta = cmap.readInt16BE(deltas + segment * 2);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const position = rangeOffsets + segment * 2 + rangeOffset + (codePoint - start) * 2;
      const glyph = cmap.readUInt16BE(position);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

type Point = [number, number, boolean];

function parseSimple(glyf: Buffer, start: number, contourCount: number): Point[][] {
  let cursor = start + 10;
  const ends: number[] = [];
  for (let index = 0; index < contourCount; index += 1) { ends.push(glyf.readUInt16BE(cursor)); cursor += 2; }
  const pointCount = (ends[ends.length - 1] ?? -1) + 1;
  cursor += 2 + glyf.readUInt16BE(cursor);
  const flags: number[] = [];
  while (flags.length < pointCount) {
    const flag = glyf.readUInt8(cursor);
    cursor += 1;
    flags.push(flag);
    if (flag & 0x08) {
      let repeat = glyf.readUInt8(cursor);
      cursor += 1;
      while (repeat > 0) { flags.push(flag); repeat -= 1; }
    }
  }
  const readCoordinates = (shortBit: number, sameBit: number): number[] => {
    const values: number[] = [];
    let current = 0;
    for (const flag of flags) {
      if (flag & shortBit) {
        const delta = glyf.readUInt8(cursor);
        cursor += 1;
        current += flag & sameBit ? delta : -delta;
      } else if (!(flag & sameBit)) {
        current += glyf.readInt16BE(cursor);
        cursor += 2;
      }
      values.push(current);
    }
    return values;
  };
  const xs = readCoordinates(0x02, 0x10);
  const ys = readCoordinates(0x04, 0x20);
  const contours: Point[][] = [];
  let first = 0;
  for (const end of ends) {
    const contour: Point[] = [];
    for (let index = first; index <= end; index += 1) contour.push([xs[index] ?? 0, ys[index] ?? 0, ((flags[index] ?? 0) & 0x01) === 1]);
    contours.push(contour);
    first = end + 1;
  }
  return contours;
}

export function loadOutlineFont(woff: Buffer): OutlineFont {
  const tables = readTables(woff);
  const head = need(tables, "head");
  const unitsPerEm = head.readUInt16BE(18);
  const longLoca = head.readInt16BE(50) === 1;
  const glyphCount = need(tables, "maxp").readUInt16BE(4);
  const hmetrics = need(tables, "hhea").readUInt16BE(34);
  const hmtx = need(tables, "hmtx");
  const loca = need(tables, "loca");
  const glyf = need(tables, "glyf");
  const lookup = readCmap(need(tables, "cmap"));

  const location = (glyph: number): Table | null => {
    if (glyph < 0 || glyph >= glyphCount) return null;
    const from = longLoca ? loca.readUInt32BE(glyph * 4) : loca.readUInt16BE(glyph * 2) * 2;
    const to = longLoca ? loca.readUInt32BE(glyph * 4 + 4) : loca.readUInt16BE(glyph * 2 + 2) * 2;
    return to > from ? { offset: from, length: to - from } : null;
  };
  const advanceOf = (glyph: number) => hmtx.readUInt16BE(Math.min(glyph, hmetrics - 1) * 4);

  const contoursOf = (glyph: number, depth = 0): Point[][] => {
    const where = location(glyph);
    if (!where || depth > 4) return [];
    const count = glyf.readInt16BE(where.offset);
    if (count >= 0) return parseSimple(glyf, where.offset, count);
    // Compuesto: suma componentes con su desplazamiento (y escala si la trae).
    const result: Point[][] = [];
    let cursor = where.offset + 10;
    for (;;) {
      const flags = glyf.readUInt16BE(cursor);
      const component = glyf.readUInt16BE(cursor + 2);
      cursor += 4;
      let dx = 0;
      let dy = 0;
      if (flags & 0x01) { dx = glyf.readInt16BE(cursor); dy = glyf.readInt16BE(cursor + 2); cursor += 4; }
      else { dx = glyf.readInt8(cursor); dy = glyf.readInt8(cursor + 1); cursor += 2; }
      if (!(flags & 0x02)) { dx = 0; dy = 0; }
      let a = 1; let b = 0; let c = 0; let d = 1;
      if (flags & 0x08) { a = d = glyf.readInt16BE(cursor) / 16384; cursor += 2; }
      else if (flags & 0x40) { a = glyf.readInt16BE(cursor) / 16384; d = glyf.readInt16BE(cursor + 2) / 16384; cursor += 4; }
      else if (flags & 0x80) {
        a = glyf.readInt16BE(cursor) / 16384; b = glyf.readInt16BE(cursor + 2) / 16384;
        c = glyf.readInt16BE(cursor + 4) / 16384; d = glyf.readInt16BE(cursor + 6) / 16384; cursor += 8;
      }
      for (const contour of contoursOf(component, depth + 1)) {
        result.push(contour.map(([x, y, on]): Point => [Math.round(a * x + c * y + dx), Math.round(b * x + d * y + dy), on]));
      }
      if (!(flags & 0x20)) break;
    }
    return result;
  };

  const cache = new Map<number, GlyphOutline | null>();
  const glyphFor = (codePoint: number): GlyphOutline | null => {
    const cached = cache.get(codePoint);
    if (cached !== undefined) return cached;
    const glyph = lookup(codePoint);
    const outline = glyph === 0 && codePoint !== 0x20 ? null : { advance: advanceOf(glyph), contours: contoursOf(glyph) };
    cache.set(codePoint, outline);
    return outline;
  };

  const heights = (glyphFor(0x48)?.contours ?? []).flat().map((point) => point[1]);
  return { unitsPerEm, capHeight: heights.length ? Math.max(...heights) : Math.round(unitsPerEm * 0.7), glyphFor };
}

let anton: OutlineFont | null = null;

/** Anton Regular, leída una sola vez del WOFF embebido. */
export function antonOutlines(): OutlineFont {
  anton ??= loadOutlineFont(Buffer.from(ARTWORK_DISPLAY_FONT_400_BASE64, "base64"));
  return anton;
}

/** Ancho exacto (pt) de `text` a `sizePt` con los avances reales de la fuente (sin kerning, como se dibuja). */
export function outlineWidthPt(font: OutlineFont, text: string, sizePt: number): number {
  let units = 0;
  for (const char of text) units += font.glyphFor(char.codePointAt(0) ?? 0x20)?.advance ?? 0;
  return (units * sizePt) / font.unitsPerEm;
}
