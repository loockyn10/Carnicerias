import { Encodings, Font, FontNames } from "@pdf-lib/standard-fonts";

/**
 * Tipografía de la etiqueta de góndola: Helvetica estándar (las 14 fuentes base de PDF: no se incrusta nada, el PDF pesa unos pocos KB y se
 * imprime igual en cualquier equipo). Este módulo es la ÚNICA fuente de medidas de texto: el layout (`label-layout.ts`) mide con las
 * métricas oficiales de Helvetica, el PDF dibuja con esas mismas fuentes y el preview en pantalla usa Helvetica/Arial (idénticas en ancho),
 * así los tres coinciden.
 */

export type LabelFontStyle = "regular" | "bold" | "boldItalic";

const FONT_NAMES = {
  regular: FontNames.Helvetica,
  bold: FontNames.HelveticaBold,
  boldItalic: FontNames.HelveticaBoldOblique
} as const;

const cache = new Map<LabelFontStyle, Font>();

function fontFor(style: LabelFontStyle): Font {
  let font = cache.get(style);
  if (!font) {
    font = Font.load(FONT_NAMES[style]);
    cache.set(style, font);
  }
  return font;
}

/** Altura de las mayúsculas y los dígitos, en «em» (718/1000 en Helvetica): fija dónde cae la línea base de cada texto. */
export function capHeightEm(style: LabelFontStyle): number {
  const capHeight = fontFor(style).CapHeight;
  return (typeof capHeight === "number" ? capHeight : 718) / 1_000;
}

/**
 * Ancho en puntos de `text` a `sizePt`, sumando el ancho de cada glifo (sin kerning: el PDF no lo aplica al dibujar, así que medir con
 * kerning daría un ancho que el papel no tiene). `text` tiene que venir de `toLabelText`.
 */
export function textWidthPt(text: string, sizePt: number, style: LabelFontStyle): number {
  const font = fontFor(style);
  let units = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(codePoint)) throw new RangeError(`Carácter no imprimible en la etiqueta: U+${codePoint.toString(16)}`);
    units += font.getWidthOfGlyph(Encodings.WinAnsi.encodeUnicodeCodePoint(codePoint).name) ?? 0;
  }
  return (units * sizePt) / 1_000;
}

/** Espacios en blanco (tabulaciones, saltos de línea, NBSP) → un espacio común. */
const WHITESPACE = /[\s\u00a0\u2007\u202f]+/g;
/** Marcas combinantes que deja `normalize("NFD")` (tildes, diéresis…). */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Deja un texto dibujable con las fuentes estándar del PDF (codificación WinAnsi ≈ Latin-1): conserva ñ, tildes, ¿¡, comillas, «€»…; un
 * carácter fuera de ese juego se reemplaza por su letra base (ğ → g) y, si no la tiene (emoji, ideogramas), se descarta. Así NUNCA falla
 * la generación por un nombre de producto raro, y el preview muestra exactamente lo que va a imprimirse.
 */
export function toLabelText(input: string): string {
  let output = "";
  for (const char of input.normalize("NFC").replace(WHITESPACE, " ")) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 && Encodings.WinAnsi.canEncodeUnicodeCodePoint(codePoint)) {
      output += char;
      continue;
    }
    for (const base of char.normalize("NFD").replace(COMBINING_MARKS, "")) {
      const baseCodePoint = base.codePointAt(0) ?? 0;
      if (baseCodePoint >= 0x20 && Encodings.WinAnsi.canEncodeUnicodeCodePoint(baseCodePoint)) output += base;
    }
  }
  return output.replace(/ {2,}/g, " ").trim();
}
