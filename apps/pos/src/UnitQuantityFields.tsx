import { PACK_DISCOUNT_BPS } from "@carnicerias/business-logic";

interface UnitQuantityFieldsProps {
  /** Cantidad que tipea el operador: unidades, o packs si `packMode` está activo. */
  quantity: number;
  onQuantityChange: (quantity: number) => void;
  /** Unidades por pack del producto; null = sin pack (entonces no se ofrece la opción Pack). */
  packSizeUnits: number | null;
  packMode: boolean;
  onPackModeChange: (packMode: boolean) => void;
}

/**
 * Cantidad de un producto UNIT, la misma para agregar desde la grilla/buscador y para modificar una línea ya agregada
 * (un único componente). Si el producto tiene `pack_size_units`, ofrece "Pack · N unidades · 20% OFF": con Pack la
 * cantidad son packs y la línea se carga con N × tamaño unidades REALES, todas con 20 % de descuento. El escaneo nunca
 * activa el Pack: agrega 1 unidad normal y recién al editar la cantidad aparece esta opción.
 */
export function UnitQuantityFields({ quantity, onQuantityChange, packSizeUnits, packMode, onPackModeChange }: UnitQuantityFieldsProps) {
  const packEnabled = packSizeUnits != null;
  const inPackMode = packEnabled && packMode;
  const discountLabel = String(PACK_DISCOUNT_BPS / 100) + "% OFF";
  return (
    <>
      {/* UNIT: cantidad entera con [-] [+] + input manual — nunca balanza ni gramos. */}
      <label className="mt-6 grid gap-2 text-sm font-bold text-stone-300">
        {inPackMode ? "Cantidad de packs" : "Cantidad de unidades"}
        <div className="flex items-center gap-3">
          <button
            className="h-14 w-14 rounded-2xl border border-stone-600 bg-stone-950 text-2xl font-black hover:bg-stone-800 disabled:opacity-40"
            disabled={quantity <= 1}
            onClick={() => onQuantityChange(Math.max(1, quantity - 1))}
            type="button"
          >
            −
          </button>
          <input
            autoFocus
            className="w-full rounded-2xl border border-stone-600 bg-stone-950 px-4 py-4 text-center text-4xl font-black outline-none focus:border-rose-500"
            inputMode="numeric"
            onChange={(event) => {
              const parsed = Number(event.target.value.replace(/[^0-9]/g, ""));
              onQuantityChange(Number.isFinite(parsed) && parsed > 0 ? parsed : 1);
            }}
            value={quantity}
          />
          <button
            className="h-14 w-14 rounded-2xl border border-stone-600 bg-stone-950 text-2xl font-black hover:bg-stone-800"
            onClick={() => onQuantityChange(quantity + 1)}
            type="button"
          >
            +
          </button>
        </div>
      </label>
      {packEnabled ? (
        <>
          <label className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-emerald-500/60 bg-emerald-950/40 px-4 py-3 text-sm font-bold text-emerald-200" data-testid="pack-toggle">
            <span>Pack · {String(packSizeUnits)} unidades · {discountLabel}</span>
            <input checked={packMode} onChange={(event) => onPackModeChange(event.target.checked)} type="checkbox" />
          </label>
          {inPackMode ? (
            <p className="mt-2 text-sm font-bold text-emerald-300" data-testid="pack-units">
              {String(quantity)} pack{quantity === 1 ? "" : "s"} × {String(packSizeUnits)} u = {String(quantity * packSizeUnits)} unidades reales · {discountLabel}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
