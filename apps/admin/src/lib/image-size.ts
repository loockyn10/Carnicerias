/**
 * Medidas y tipo REAL de una imagen PNG o JPEG leyendo sólo su cabecera (sin decodificar). El servidor lo usa para registrar el logo
 * (lo que dice el navegador no cuenta) y los tests para comprobar las dimensiones de los PNG exportados.
 */

export interface ImageInfo {
  type: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
}

export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  if (startsWith(bytes, PNG_MAGIC)) {
    if (bytes.length < 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { type: "image/png", width, height } : null;
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xff) { offset += 1; continue; }
      // Marcadores sin longitud: SOI, EOI, RSTn, TEM.
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = view.getUint16(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        const height = view.getUint16(offset + 5);
        const width = view.getUint16(offset + 7);
        return width > 0 && height > 0 ? { type: "image/jpeg", width, height } : null;
      }
      offset += 2 + length;
    }
  }
  return null;
}
