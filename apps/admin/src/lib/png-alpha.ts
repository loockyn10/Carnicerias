import { inflateSync } from "node:zlib";

/**
 * ¿Un PNG tiene fondo TRANSPARENTE de verdad? (D-086). Que el archivo tenga canal alfa no alcanza (muchos editores guardan RGBA con todo
 * opaco): se decodifica y se mide cuántos píxeles son (casi) transparentes. Un recorte de producto sobre fondo transparente deja varios
 * puntos porcentuales del lienzo vacíos; una foto con fondo propio, ninguno. Sólo servidor (usa zlib de Node).
 *
 * Soporta PNG sin entrelazado de 8 y 16 bits en escala de grises con alfa, RGBA y paleta con `tRNS`. Cualquier otra cosa devuelve `null`
 * («no se pudo analizar»): la pieza lo trata como opaco, que es el comportamiento de siempre.
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Un píxel cuenta como transparente por debajo de este alfa (de 255). */
const TRANSPARENT_BELOW = 16;
/** Fracción mínima del lienzo transparente para considerar la foto un recorte. */
export const TRANSPARENT_SHARE = 0.02;
const MAX_PIXELS = 16_000_000;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function analyzePngAlpha(bytes: Uint8Array): boolean | null {
  if (bytes.length < 33 || !PNG_MAGIC.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let paletteTransparency: number[] | null = null;
  const data: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = body[8] ?? 0;
      colorType = body[9] ?? -1;
      interlace = body[12] ?? 0;
    } else if (type === "tRNS") paletteTransparency = Array.from(body);
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS || interlace !== 0 || !data.length) return null;

  const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (channels === 0) return null;
  // Sin canal alfa ni tabla de transparencia el PNG es opaco (salvo un color-clave `tRNS` en gris/RGB, que no se usa en fotos de producto).
  if (colorType !== 6 && colorType !== 4 && !(colorType === 3 && paletteTransparency)) return false;
  if (colorType === 3 && depth !== 8) return null;
  if ((colorType === 6 || colorType === 4) && depth !== 8 && depth !== 16) return null;

  const bytesPerPixel = (channels * depth) / 8;
  const stride = width * bytesPerPixel;
  let raw: Uint8Array;
  try {
    const joined = new Uint8Array(data.reduce((sum, part) => sum + part.length, 0));
    let cursor = 0;
    for (const part of data) { joined.set(part, cursor); cursor += part.length; }
    raw = inflateSync(joined);
  } catch {
    return null;
  }
  if (raw.length < (stride + 1) * height) return null;

  const row = new Uint8Array(stride);
  const prior = new Uint8Array(stride);
  let transparent = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= bytesPerPixel ? (row[i - bytesPerPixel] ?? 0) : 0;
      const up = prior[i] ?? 0;
      const upLeft = i >= bytesPerPixel ? (prior[i - bytesPerPixel] ?? 0) : 0;
      const value = line[i] ?? 0;
      let result: number;
      if (filter === 0) result = value;
      else if (filter === 1) result = value + left;
      else if (filter === 2) result = value + up;
      else if (filter === 3) result = value + ((left + up) >> 1);
      else if (filter === 4) result = value + paeth(left, up, upLeft);
      else return null;
      row[i] = result & 0xff;
    }
    for (let x = 0; x < width; x++) {
      let alpha: number;
      if (colorType === 6) alpha = row[x * bytesPerPixel + (depth === 8 ? 3 : 6)] ?? 255;
      else if (colorType === 4) alpha = row[x * bytesPerPixel + (depth === 8 ? 1 : 2)] ?? 255;
      else alpha = paletteTransparency?.[row[x] ?? 0] ?? 255;
      if (alpha < TRANSPARENT_BELOW) transparent += 1;
    }
    prior.set(row);
  }
  return transparent / (width * height) >= TRANSPARENT_SHARE;
}
