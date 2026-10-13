import sharp from "sharp";

/**
 * Logo monocromático para imprimir en blanco y negro (D-087). El archivo original NO se toca: se lee de Storage, se convierte en memoria a
 * un PNG de sólo negro y blanco y se descarta. Pasos: transparencia sobre blanco → escala de grises → contraste (normalización) → umbral
 * automático de Otsu (el punto que mejor separa las zonas claras de las oscuras del propio logo). Un logo a color queda «negro sobre blanco»
 * conservando sus formas y letras; los colores claros (amarillo, blanco) pasan a blanco y los oscuros o saturados (rojo, verde) a negro.
 * Sólo servidor (sharp).
 */

/** Lado máximo del PNG resultante (px): sobra para una impresión de 30 mm a 600 dpi y mantiene el archivo chico. */
export const MONO_LOGO_MAX_PX = 720;

export interface MonoLogo {
  png: Uint8Array;
  width: number;
  height: number;
  /** Fracción de píxeles negros (0..1), útil para detectar un logo que quedó casi todo negro o todo blanco. */
  inkShare: number;
}

/** Umbral de Otsu sobre un histograma de 256 niveles: el valor que maximiza la varianza entre clases. */
export function otsuThreshold(histogram: readonly number[]): number {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 128;
  let weighted = 0;
  histogram.forEach((count, level) => { weighted += level * count; });
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let best = 128;
  let bestVariance = -1;
  for (let level = 0; level < 256; level += 1) {
    backgroundWeight += histogram[level] ?? 0;
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += level * (histogram[level] ?? 0);
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (weighted - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) { bestVariance = variance; best = level; }
  }
  return best;
}

export async function toMonochromeLogo(bytes: Uint8Array): Promise<MonoLogo> {
  const prepared = sharp(bytes, { limitInputPixels: 40_000_000 })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({ width: MONO_LOGO_MAX_PX, height: MONO_LOGO_MAX_PX, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .normalise();
  const { data, info } = await prepared.raw().toBuffer({ resolveWithObject: true });
  const histogram = new Array<number>(256).fill(0);
  for (const value of data) histogram[value] = (histogram[value] ?? 0) + 1;
  const threshold = otsuThreshold(histogram);
  const output = Buffer.alloc(data.length);
  let ink = 0;
  for (let index = 0; index < data.length; index += 1) {
    const black = (data[index] ?? 255) <= threshold;
    output[index] = black ? 0 : 255;
    if (black) ink += 1;
  }
  const png = await sharp(output, { raw: { width: info.width, height: info.height, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer();
  return { png: new Uint8Array(png), width: info.width, height: info.height, inkShare: data.length ? ink / data.length : 0 };
}
