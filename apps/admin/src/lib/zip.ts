/**
 * Escritor de archivos ZIP mínimo (método «stored», sin compresión): las gráficas ya son PNG (comprimidos), así que comprimirlas de nuevo
 * sólo gasta tiempo. Sin dependencias, funciona en el navegador y en Node, con nombres UTF-8 (acentos y «ñ» se ven bien al abrirlo en
 * Windows, macOS y Linux). Límites del formato clásico (sin ZIP64): menos de 65.535 archivos y de 4 GB, de sobra para una carpeta de gráficas.
 */

export interface ZipEntry {
  /** Ruta dentro del ZIP, con «/» (p. ej. «Ofertas finde - 11-10-2026/Feed/pata-muslo.png»). */
  path: string;
  data: Uint8Array;
  /** Fecha de modificación que se guarda (por defecto, ahora). */
  modified?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Fecha y hora en el formato MS-DOS del ZIP (2 segundos de resolución; antes de 1980 se guarda 1980). */
export function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

const encoder = new TextEncoder();
const MAX_ENTRIES = 0xfffe;
const MAX_BYTES = 0xfffffff0;

/** Una ruta de ZIP válida: relativa, sin «..», sin barras invertidas ni caracteres de control. */
export function isSafeZipPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.endsWith("/")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Arma el ZIP con los archivos en el orden dado. Lanza si una ruta no es segura o se pasa de los límites. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new RangeError("Demasiados archivos para un ZIP");
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (!isSafeZipPath(entry.path)) throw new RangeError(`Ruta de ZIP inválida: ${entry.path}`);
    if (seen.has(entry.path)) throw new RangeError(`Ruta repetida en el ZIP: ${entry.path}`);
    seen.add(entry.path);
    const name = encoder.encode(entry.path);
    const size = entry.data.byteLength;
    const { date, time } = dosDateTime(entry.modified ?? new Date());
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // nombres en UTF-8
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    offset += local.length;
    if (offset > MAX_BYTES) throw new RangeError("El ZIP supera el tamaño máximo");
    locals.push(local);
    centrals.push(central);
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
