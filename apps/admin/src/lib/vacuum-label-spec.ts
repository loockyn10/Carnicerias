/**
 * ESPECIFICACIÓN ÚNICA de las dos etiquetas térmicas del envasado al vacío (informativa y de precio). La consumen, sin copiar ningún número:
 *   - `vacuum-label-layout.ts`  (geometría: dónde va cada texto y cada barra)
 *   - `vacuum-label-preview.tsx` (preview en pantalla: SVG con viewBox en milímetros, proporciones reales)
 *   - `vacuum-label-pdf.ts`  (PDF: una página del tamaño exacto de la etiqueta por cada etiqueta)
 * Medidas en milímetros, tipografía en puntos.
 *
 * Las medidas de papel NO están fijas en el código de los templates: estas constantes son los valores por defecto y la organización puede
 * sobrescribirlos (Envasados → Configuración). Para pasar de 55 × 44 a 55 × 50 se cambia un número acá o en Configuración, sin tocar los templates.
 * El papel es angosto (55–58 mm) y la zona imprimible de una térmica de 58 mm es de 48 mm (384 puntos): por eso el margen lateral por defecto es de 4,5 mm.
 */

export interface VacuumLabelDims {
  widthMm: number;
  infoHeightMm: number;
  priceHeightMm: number;
}

/** Valores por defecto (sólo se usan cuando la organización no configuró medidas): el rollo térmico actual de 55 × 44 mm. */
export const VACUUM_LABEL_DEFAULTS: VacuumLabelDims = { widthMm: 55, infoHeightMm: 44, priceHeightMm: 44 };

/** Límites aceptados por la base (check de organization_vacuum_settings). */
export const VACUUM_LABEL_LIMITS = {
  widthMm: { min: 30, max: 120 },
  infoHeightMm: { min: 20, max: 200 },
  priceHeightMm: { min: 20, max: 200 }
} as const;

export interface VacuumLabelDimOverrides {
  widthMm?: number | null | undefined;
  infoHeightMm?: number | null | undefined;
  priceHeightMm?: number | null | undefined;
}

/** Medidas efectivas: lo configurado por la organización (si es válido) o el valor por defecto. */
export function resolveVacuumLabelDims(overrides: VacuumLabelDimOverrides | null | undefined): VacuumLabelDims {
  const pick = (value: number | null | undefined, fallback: number, limits: { min: number; max: number }) =>
    typeof value === "number" && Number.isFinite(value) && value >= limits.min && value <= limits.max ? value : fallback;
  return {
    widthMm: pick(overrides?.widthMm, VACUUM_LABEL_DEFAULTS.widthMm, VACUUM_LABEL_LIMITS.widthMm),
    infoHeightMm: pick(overrides?.infoHeightMm, VACUUM_LABEL_DEFAULTS.infoHeightMm, VACUUM_LABEL_LIMITS.infoHeightMm),
    priceHeightMm: pick(overrides?.priceHeightMm, VACUUM_LABEL_DEFAULTS.priceHeightMm, VACUUM_LABEL_LIMITS.priceHeightMm)
  };
}

/** Márgenes internos (mm). */
export const VACUUM_LABEL_PAD = { xMm: 4.5, topMm: 2.2, bottomMm: 2 } as const;

export const MM_PER_PT = 25.4 / 72;
export const PT_PER_MM = 72 / 25.4;

/** Resolución de la impresora térmica (203 dpi) y tamaño de un punto en milímetros. */
export const THERMAL_DPI = 203;
export const THERMAL_DOT_MM = 25.4 / THERMAL_DPI;

/** Piso de la reducción global de tipografía cuando el contenido no entra en el alto; por debajo se marca `overflow`. */
export const VACUUM_MIN_FIT = 0.55;
export const VACUUM_FIT_STEP = 0.03;

/** Tipografía de la etiqueta INFORMATIVA (pt). */
export const VACUUM_INFO_TYPE = {
  name: { maxPt: 11, minPt: 7, maxLines: 2, style: "bold", lineHeightEm: 1.12 },
  caption: { pt: 5.5, style: "regular" },
  value: { pt: 9.5, style: "bold" },
  body: { pt: 6.5, style: "regular", lineHeightEm: 1.15, maxLines: 4 },
  footerTitle: { pt: 6.5, style: "bold" },
  footer: { pt: 6, style: "regular", lineHeightEm: 1.12, maxLines: 2 }
} as const;

/** Tipografía y barras de la etiqueta de PRECIO (pt / mm). El precio final es SIEMPRE el elemento más grande. */
export const VACUUM_PRICE_TYPE = {
  name: { maxPt: 11, minPt: 7, maxLines: 2, style: "bold", lineHeightEm: 1.1 },
  price: { maxPt: 34, minPt: 14, style: "bold" },
  weight: { pt: 12, style: "bold" },
  perKg: { pt: 9.5, style: "bold" },
  digits: { pt: 7, style: "regular" },
  /**
   * Fechas de elaboración y vencimiento, en una sola fila («ELAB: DD/MM/AAAA» a la izquierda, «VENCE: DD/MM/AAAA» a la derecha). Son datos obligatorios: la
   * tipografía NO sigue la reducción global de la etiqueta (se achica sólo hasta `minPt`, que sigue siendo legible a 203 dpi); si no entran en una fila
   * se apilan en dos, nunca se recortan.
   */
  dates: { maxPt: 8, minPt: 6, style: "bold", minGapMm: 2 },
  /**
   * El EAN-13 no se achica con el resto de la etiqueta: su alto sólo baja hasta `minHeightScale` del diseño y crece hasta `maxHeightMm` con el alto que sobra. El módulo se ajusta a puntos enteros de la
   * térmica (203 dpi, ver `THERMAL_DOT_MM`) para que ninguna barra salga de 3 y 4 puntos alternados.
   */
  barcode: { heightMm: 9, maxHeightMm: 11, minHeightScale: 0.9, quietZoneMm: 1.5, digitsGapMm: 0.6 },
  /** Aviso cuando no hay esquema EAN configurado. */
  notice: { pt: 7, style: "bold" }
} as const;

/** Separaciones entre bloques (mm). */
export const VACUUM_GAPS_MM = { section: 1.4, line: 0.6 } as const;

/**
 * Identificador LOGÍSTICO en la etiqueta informativa (Code 128 B de 9 caracteres = 134 módulos). Módulo de 0,25 mm (= 2 puntos a 203 dpi: barras nítidas en una
 * térmica) y 6 mm de alto. Sólo se dibuja si entra reduciendo la tipografía de la etiqueta a lo sumo un 8 % (`minFit` 0,92) y sin recortar nada (medido: en 55 × 44 mm hace falta reducirla un 12 %, así que NO se dibuja; desde unos 50 mm de alto entra sin reducir): si no entra, la
 * informativa queda como era y se imprime la etiqueta logística aparte. El EAN-13 comercial (etiqueta de precio) no se toca.
 */
export const VACUUM_LOGISTIC = { moduleMm: 0.25, barHeightMm: 6, textPt: 6, gapMm: 1, minFit: 0.92 } as const;

/** Etiqueta LOGÍSTICA adicional (mismo papel que la informativa): el código más grande, para escanearlo de lejos o con lectores económicos. */
export const VACUUM_LOGISTIC_TYPE = {
  title: { pt: 5.5, style: "bold" },
  name: { maxPt: 10, minPt: 7, maxLines: 2, style: "bold", lineHeightEm: 1.1 },
  barcode: { moduleMm: 0.3, barHeightMm: 11 },
  code: { maxPt: 13, minPt: 8, style: "bold" },
  detail: { pt: 7, style: "regular", lineHeightEm: 1.2 },
  footer: { pt: 5.5, style: "regular" }
} as const;
