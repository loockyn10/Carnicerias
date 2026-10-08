import { INTER_700_WIDTHS, INTER_900_WIDTHS, type GlyphWidths } from "./artwork-metrics";

/**
 * Medición y ajuste de texto de la cartelería (D-074). El preview (DOM) y el PNG (Satori) usan la MISMA fuente embebida (Inter) y
 * este módulo decide tamaños y saltos de línea con sus anchos reales: así nada se corta ni se desborda y el resultado no depende del
 * motor que lo dibuja (cada línea se renderiza explícita y sin ajuste automático de renglones).
 */

export type ArtworkWeight = 700 | 900;

const WIDTHS: Record<ArtworkWeight, GlyphWidths> = { 700: INTER_700_WIDTHS, 900: INTER_900_WIDTHS };

/** Margen de seguridad sobre el ancho medido (kerning y redondeos de cada motor de texto). */
const SAFETY = 1.035;

/** ¿La fuente embebida tiene el glifo de este carácter? */
export function hasGlyph(character: string): boolean {
  const code = character.codePointAt(0);
  return code !== undefined && INTER_900_WIDTHS[code] !== undefined;
}

/** Deja sólo los caracteres que la fuente puede dibujar (nunca un cuadradito de «glifo faltante»). Colapsa espacios. */
export function sanitizeGlyphs(text: string): string {
  let out = "";
  for (const character of text.normalize("NFC")) {
    if (character === "\n" || character === "\t") out += " ";
    else if (hasGlyph(character)) out += character;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Ancho en px de `text` a `sizePx` (sin saltos de línea). */
export function textWidth(text: string, sizePx: number, weight: ArtworkWeight = 900): number {
  const table = WIDTHS[weight];
  let thousandths = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    thousandths += table[code] ?? 700;
  }
  return (thousandths / 1000) * sizePx * SAFETY;
}

/** Parte `text` en renglones de a lo sumo `maxWidth` px (por palabras). Una palabra que no entra sola se parte por letras. */
export function wrapLines(text: string, sizePx: number, maxWidth: number, weight: ArtworkWeight = 900): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  const push = () => { if (current) lines.push(current); current = ""; };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, sizePx, weight) <= maxWidth) { current = candidate; continue; }
    push();
    if (textWidth(word, sizePx, weight) <= maxWidth) { current = word; continue; }
    // Palabra más ancha que la caja: se parte por letras (último recurso; el ajuste de tamaño casi siempre lo evita).
    let chunk = "";
    for (const character of word) {
      if (chunk && textWidth(chunk + character, sizePx, weight) > maxWidth) { lines.push(chunk); chunk = ""; }
      chunk += character;
    }
    current = chunk;
  }
  push();
  return lines;
}

export interface FittedText {
  size: number;
  lines: string[];
  /** true si ni siquiera el tamaño mínimo entra en `maxLines` (se recorta el último renglón con «...»). */
  truncated: boolean;
}

/** El tamaño más grande (de `maxSize` a `minSize`, de a 2 px) con el que `text` entra en `maxLines` renglones de `maxWidth` px. */
export function fitText(options: {
  text: string; maxWidth: number; maxLines: number; maxSize: number; minSize: number; weight?: ArtworkWeight;
  /** Alto máximo del bloque (renglones × tamaño × interlineado). Sin tope = sólo cuenta `maxLines`. */
  maxHeight?: number; lineHeight?: number;
}): FittedText {
  const lineHeight = options.lineHeight ?? 1.02;
  const maxHeight = options.maxHeight ?? Number.POSITIVE_INFINITY;
  const weight = options.weight ?? 900;
  const text = options.text;
  for (let size = options.maxSize; size >= options.minSize; size -= 2) {
    const lines = wrapLines(text, size, options.maxWidth, weight);
    const widest = Math.max(0, ...lines.map((line) => textWidth(line, size, weight)));
    if (lines.length <= options.maxLines && widest <= options.maxWidth && lines.length * size * lineHeight <= maxHeight) return { size, lines, truncated: false };
  }
  const size = options.minSize;
  const lines = wrapLines(text, size, options.maxWidth, weight);
  if (lines.length <= options.maxLines) return { size, lines, truncated: false };
  const kept = lines.slice(0, options.maxLines);
  let last = kept[kept.length - 1] ?? "";
  while (last.length > 1 && textWidth(`${last}...`, size, weight) > options.maxWidth) last = last.slice(0, -1).trimEnd();
  kept[kept.length - 1] = `${last}...`;
  return { size, lines: kept, truncated: true };
}
