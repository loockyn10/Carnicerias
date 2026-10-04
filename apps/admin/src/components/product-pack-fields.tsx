import { formatBasisPointsPercent } from "@carnicerias/business-logic";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

interface ProductPackFieldsProps {
  /** Unidades por pack vigentes (null = sin pack). */
  packSizeUnits: number | null;
  /** Descuento del pack vigente en basis points (null sii no hay pack). */
  packDiscountBps: number | null;
}

/**
 * Configuración del pack de un producto por unidad: unidades por pack y descuento del pack, SIEMPRE juntos (las dos cosas o
 * ninguna). Cada producto tiene su propio porcentaje (Leche A 20 %, Leche B 25 %...). Sólo se muestra para productos `UNIT`.
 */
export function ProductPackFields({ packSizeUnits, packDiscountBps }: ProductPackFieldsProps) {
  return (
    <fieldset className="grid gap-3 rounded-lg bg-stone-50 p-3" data-testid="pack-config-fields">
      <legend className="px-1 text-sm font-bold">Pack</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium" data-testid="pack-size-field">
          Unidades por pack
          <input className={input} defaultValue={packSizeUnits ?? ""} inputMode="numeric" max="10000" min="2" name="pack_size_units" placeholder="Sin pack" step="1" type="number" />
        </label>
        <label className="grid gap-1 text-sm font-medium" data-testid="pack-discount-field">
          Descuento del pack (%)
          <input className={input} defaultValue={packDiscountBps != null ? String(packDiscountBps / 100) : ""} inputMode="decimal" max="99.99" min="0.01" name="pack_discount_percent" placeholder="Ej.: 20" step="0.01" type="number" />
        </label>
      </div>
      <p className="text-xs text-stone-500">
        Opcional; las dos cosas juntas o ninguna. Ejemplo: leche, 8 unidades, 25%{packDiscountBps != null ? ` (hoy: ${formatBasisPointsPercent(packDiscountBps)}% OFF)` : ""}.
        En el POS, «Pack» carga esa cantidad de unidades reales y les aplica el descuento de ESTE producto. No es una promoción ni tiene precio propio;
        vacío = sin pack. Las ventas ya hechas conservan el pack con el que se vendieron.
      </p>
    </fieldset>
  );
}
