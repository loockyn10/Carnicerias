/**
 * ESPECIFICACIÓN ÚNICA de las dos etiquetas térmicas del envasado al vacío (informativa y de precio). La consumen, sin copiar ningún número:
 *   - `vacuum-label-layout.ts`  (geometría: dónde va cada texto y cada barra)
 *   - `vacuum-label-preview.tsx` (preview en pantalla: SVG con viewBox en milímetros, proporciones reales)
 *   - `vacuum-label-pdf.ts`  (PDF: una página del tamaño exacto de la etiqueta por cada etiqueta)
 * Medidas en milímetros, tipografía en puntos.
 *
 * Las medidas de papel NO están fijas en el código de los templates: estas constantes son los valores por defecto y la organización puede
 * sobrescribirlos (Envasados → Configuración). Para pasar de 58 × 40 a 58 × 50 se cambia un número acá o en Configuración, sin tocar los templates.
 * El papel es angosto (~58 mm) y la zona imprimible suele ser menor (≈ 48 mm): por eso el margen lateral por defecto es de 4,5 mm.
 */

export interface VacuumLabelDims {
  widthMm: number;
  infoHeightMm: number;
  priceHeightMm: number;
}

/** Valores por defecto (sólo se usan cuando la organización no configuró medidas). */
export const VACUUM_LABEL_DEFAULTS: VacuumLabelDims = { widthMm: 58, infoHeightMm: 40, priceHeightMm: 40 };

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
  barcode: { heightMm: 9, quietZoneMm: 1.5, digitsGapMm: 0.6 },
  /** Aviso cuando no hay esquema EAN configurado. */
  notice: { pt: 7, style: "bold" }
} as const;

/** Separaciones entre bloques (mm). */
export const VACUUM_GAPS_MM = { section: 1.4, line: 0.6 } as const;
