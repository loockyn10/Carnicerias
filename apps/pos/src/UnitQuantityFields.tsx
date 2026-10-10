import { useEffect, useRef, useState } from "react";
import { formatCurrency, packDiscountLabel } from "@carnicerias/business-logic";

import { PACK_PALETTE } from "./lib/discount-chips";

/** Tope de la cantidad que se puede tipear (evita enteros absurdos que rompan el cálculo). */
export const MAX_UNIT_QUANTITY = 99_999;

/**
 * Lo que tipea el operador → la cantidad válida o `null` (vacío / 0 = todavía no hay cantidad, estado transitorio mientras reemplaza el
 * número). `draft` es el texto a mostrar: sólo dígitos, sin ceros a la izquierda ("08" → "8"). Una cantidad por encima del tope se ignora
 * (`reject`): el campo conserva lo que tenía.
 */
export function parseQuantityDraft(raw: string): { draft: string; quantity: number | null; reject: boolean } {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits === "") return { draft: "", quantity: null, reject: false };
  const parsed = Number(digits);
  if (parsed > MAX_UNIT_QUANTITY) return { draft: "", quantity: null, reject: true };
  return parsed > 0 ? { draft: String(parsed), quantity: parsed, reject: false } : { draft: "0", quantity: null, reject: false };
}

interface UnitQuantityFieldsProps {
  /** Cantidad de unidades; `null` mientras el campo está vacío (se está reemplazando el número). */
  quantity: number | null;
  onQuantityChange: (quantity: number | null) => void;
  /** Unidades reales de la línea resultante (incluye lo que ya había en el ticket del mismo producto); sólo para explicar el Pack. */
  lineUnits: number;
  /**
   * Pack del producto: unidades por pack, SU porcentaje de descuento y el precio por unidad que deja (calculado por el motor de pricing);
   * null = sin pack. `applied` lo decide el motor según las unidades: el operador no elige nada.
   */
  pack: { packSizeUnits: number; packDiscountBps: number; unitPriceCents: bigint | null; applied: boolean; packCount: number } | null;
}

/**
 * Cantidad de un producto UNIT, la misma para agregar desde la grilla/buscador y para modificar una línea ya agregada
 * (un único componente). La cantidad son siempre unidades; el Pack se aplica solo cuando las unidades lo alcanzan (ver `autoPackSale`)
 * y acá sólo se informa ("Pack aplicado" / "Pack disponible desde N unidades") con el precio por unidad que resulta.
 * El campo guarda un borrador de texto: puede quedar vacío mientras se escribe otro número, y al salir vacío vuelve a 1.
 */
export function UnitQuantityFields({ quantity, onQuantityChange, lineUnits, pack }: UnitQuantityFieldsProps) {
  const [draft, setDraft] = useState(quantity === null ? "" : String(quantity));
  const justFocused = useRef(false);
  // Un cambio de cantidad que no vino del tipeo (+/−, reabrir el modal) se refleja en el campo; el vacío transitorio no se pisa.
  useEffect(() => {
    if (quantity !== null) setDraft((current) => (parseQuantityDraft(current).quantity === quantity ? current : String(quantity)));
  }, [quantity]);
  const restoreIfEmpty = () => {
    if (quantity === null) {
      setDraft("1");
      onQuantityChange(1);
    }
  };
  return (
    <>
      {/* UNIT: cantidad entera con [-] [+] + input manual — nunca balanza ni gramos. */}
      <label className="mt-6 grid gap-2 text-sm font-bold text-stone-300">
        Cantidad de unidades
        <div className="flex items-center gap-3">
          <button
            className="h-14 w-14 rounded-2xl border border-stone-600 bg-stone-950 text-2xl font-black hover:bg-stone-800 disabled:opacity-40"
            disabled={quantity === null || quantity <= 1}
            onClick={() => quantity !== null && onQuantityChange(Math.max(1, quantity - 1))}
            type="button"
          >
            −
          </button>
          <input
            autoFocus
            className="w-full rounded-2xl border border-stone-600 bg-stone-950 px-4 py-4 text-center text-4xl font-black outline-none focus:border-rose-500"
            inputMode="numeric"
            onBlur={restoreIfEmpty}
            onChange={(event) => {
              const next = parseQuantityDraft(event.target.value);
              if (next.reject) return;
              setDraft(next.draft);
              onQuantityChange(next.quantity);
            }}
            onFocus={(event) => { justFocused.current = true; event.currentTarget.select(); }}
            onMouseUp={(event) => { if (justFocused.current) event.preventDefault(); justFocused.current = false; }}
            value={draft}
          />
          <button
            className="h-14 w-14 rounded-2xl border border-stone-600 bg-stone-950 text-2xl font-black hover:bg-stone-800"
            onClick={() => onQuantityChange(Math.min(MAX_UNIT_QUANTITY, (quantity ?? 0) + 1))}
            type="button"
          >
            +
          </button>
        </div>
      </label>
      {pack ? <PackStatus lineUnits={lineUnits} pack={pack} /> : null}
    </>
  );
}

function PackStatus({ lineUnits, pack }: { lineUnits: number; pack: NonNullable<UnitQuantityFieldsProps["pack"]> }) {
  const discountLabel = packDiscountLabel(pack.packDiscountBps);
  const perUnit = pack.unitPriceCents === null ? null : <>{" · "}<strong>{formatCurrency(pack.unitPriceCents)}/u</strong></>;
  if (pack.applied) {
    return (
      <div className={`mt-3 rounded-2xl border px-4 py-3 text-sm font-bold ${PACK_PALETTE.panel}`} data-discount-variant={PACK_PALETTE.variant} data-testid="pack-status">
        <p className={`text-xs font-black uppercase tracking-wide ${PACK_PALETTE.text}`}>✓ Pack aplicado automáticamente</p>
        <p className="mt-1" data-testid="pack-units">
          {pack.packCount === 1 ? `${String(pack.packSizeUnits)} unidades` : `${String(pack.packCount)} packs × ${String(pack.packSizeUnits)} u = ${String(lineUnits)} unidades`} · {discountLabel}{perUnit}
        </p>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-2xl border border-stone-600 bg-stone-950/60 px-4 py-3 text-sm font-bold text-stone-300" data-discount-variant={PACK_PALETTE.variant} data-testid="pack-status">
      <p className={`text-xs font-black uppercase tracking-wide ${PACK_PALETTE.text}`}>Pack disponible desde {String(pack.packSizeUnits)} unidades</p>
      <p className="mt-1">{discountLabel}{perUnit}</p>
      {lineUnits > pack.packSizeUnits && lineUnits % pack.packSizeUnits !== 0
        ? <p className="mt-1 text-xs font-bold text-stone-400" data-testid="pack-multiples">Se aplica en múltiplos de {String(pack.packSizeUnits)} unidades.</p>
        : null}
    </div>
  );
}
