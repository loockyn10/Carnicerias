import { formatBasisPointsPercent } from "@carnicerias/business-logic";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

interface ProductPackFieldsProps {
  /** Unidades por pack vigentes (null = sin pack). */
  packSizeUnits: number | null;
  /** Descuento de pack GLOBAL de la organización en basis points (null = todavía sin configurar). */
  globalPackDiscountBps: number | null;
  /** Descuento propio que este producto conserva de antes (sólo se muestra mientras no haya descuento global). */
  currentPackDiscountBps: number | null;
}

/**
 * Configuración del pack de un producto por unidad: SÓLO las unidades por pack. El porcentaje de descuento ya no es del producto:
 * sale siempre de «Productos → Precios → Configuración de precios → Dto por pack» (D-068), por eso acá no hay ningún campo de
 * descuento (ni oculto). Sólo se muestra para productos `UNIT`.
 */
export function ProductPackFields({ packSizeUnits, globalPackDiscountBps, currentPackDiscountBps }: ProductPackFieldsProps) {
  return (
    <fieldset className="grid gap-3 rounded-lg bg-stone-50 p-3" data-testid="pack-config-fields">
      <legend className="px-1 text-sm font-bold">Pack</legend>
      <label className="grid max-w-xs gap-1 text-sm font-medium" data-testid="pack-size-field">
        Unidades por pack
        <input className={input} defaultValue={packSizeUnits ?? ""} inputMode="numeric" max="10000" min="2" name="pack_size_units" placeholder="Sin pack" step="1" type="number" />
      </label>
      <p className="text-xs text-stone-500" data-testid="pack-discount-note">
        {globalPackDiscountBps !== null
          ? (globalPackDiscountBps === 0
            ? "El descuento del pack es global y hoy es 0 %: el pack carga N unidades reales pero sin descuento (se cambia en Productos → Precios → Configuración de precios)."
            : `El descuento del pack es global: ${formatBasisPointsPercent(globalPackDiscountBps)}% OFF (se cambia en Productos → Precios → Configuración de precios).`)
          : currentPackDiscountBps !== null
            ? `Descuento actual de este pack: ${formatBasisPointsPercent(currentPackDiscountBps)}% OFF. Configurá el «Dto por pack» global en Productos → Precios para unificarlo.`
            : "El descuento del pack sale de la configuración global (Productos → Precios → Configuración de precios)."}
        {" "}En el POS, «Pack» carga esa cantidad de unidades reales y les aplica ese descuento. No es una promoción ni tiene precio propio; vacío = sin pack. Las ventas ya hechas conservan el pack con el que se vendieron.
      </p>
    </fieldset>
  );
}
