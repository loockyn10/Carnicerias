import { formatCurrency, packDiscountLabel, quantityTierLabel, type BranchUnitPromotion } from "@carnicerias/business-logic";

import { DiscountChip } from "./DiscountChip";
import { PACK_PALETTE, tierPalette, tierPositionByMinimumUnits, type DiscountPalette } from "./lib/discount-chips";
import { promotedUnitPriceCents } from "./lib/ticket-pricing";

/** El Pack del producto en el diálogo de cantidad: sólo lo que hace falta para mostrarlo (el motor de pricing decide si se aplica). */
export interface QuantityPackRow {
  packSizeUnits: number;
  packDiscountBps: number;
  /** Precio por unidad que deja el Pack (calculado por el motor de pricing); null si no se puede calcular. */
  unitPriceCents: bigint | null;
  /** El motor está vendiendo esta línea como Pack. */
  applied: boolean;
  /** Unidades reales de la línea (para «Pack aplicado · 8u»). */
  lineUnits: number;
}

/**
 * Los descuentos por cantidad del producto en el diálogo de cantidad, TODOS con el mismo patrón: una fila por descuento con su chip de color
 * (por posición: 1.º amarillo, 2.º verde, ...) y a la derecha el precio por unidad. El Pack va al final, con la variante azul, y se muestra
 * igual que los escalones: «Pack desde 8u: 25% OFF» mientras no aplica y «Pack aplicado · 8u · 25% OFF» cuando el motor lo aplica. La fila
 * del descuento que se está aplicando se resalta. Sólo presentación: `appliedMinimumUnits` lo decide `appliedTierMinimumUnits` y `pack.applied`
 * el motor de pricing; este componente no calcula descuentos.
 */
export function QuantityTierList({ tiers, listPriceCents, appliedMinimumUnits, pack = null }: {
  tiers: readonly BranchUnitPromotion[];
  listPriceCents: bigint;
  appliedMinimumUnits: number | null;
  pack?: QuantityPackRow | null;
}) {
  if (tiers.length === 0 && !pack) return null;
  return (
    <ul className="mt-3 space-y-1.5 text-sm font-bold" data-testid="quantity-tiers">
      {[...tiers].sort((left, right) => left.minimumUnits - right.minimumUnits).map((tier) => {
        const palette = tierPalette(tierPositionByMinimumUnits(tiers, tier.minimumUnits));
        const applied = tier.minimumUnits === appliedMinimumUnits;
        return (
          <DiscountRow applied={applied} key={tier.id} palette={palette} unitPriceCents={promotedUnitPriceCents(listPriceCents, tier)}>
            {quantityTierLabel(tier)}
          </DiscountRow>
        );
      })}
      {pack ? (
        <DiscountRow applied={pack.applied} palette={PACK_PALETTE} testId="pack-status" unitPriceCents={pack.unitPriceCents}>
          {pack.applied
            ? `Pack aplicado · ${String(pack.lineUnits)}u · ${packDiscountLabel(pack.packDiscountBps)}`
            : `Pack desde ${String(pack.packSizeUnits)}u: ${packDiscountLabel(pack.packDiscountBps)}`}
        </DiscountRow>
      ) : null}
      {pack && !pack.applied && pack.lineUnits > pack.packSizeUnits && pack.lineUnits % pack.packSizeUnits !== 0
        ? <li className="px-2 text-xs font-bold text-stone-400" data-testid="pack-multiples">El Pack se aplica en múltiplos de {String(pack.packSizeUnits)} unidades.</li>
        : null}
    </ul>
  );
}

/** Una fila de descuento: chip a la izquierda (igual para escalones y Pack, sólo cambia el color) y el precio por unidad efectivo a la derecha. */
function DiscountRow({ palette, applied, unitPriceCents, testId, children }: {
  palette: DiscountPalette;
  applied: boolean;
  unitPriceCents: bigint | null;
  testId?: string;
  children: string;
}) {
  return (
    <li
      className={`flex items-center justify-between gap-x-3 rounded-xl border px-2 py-1 ${applied ? palette.panel : "border-transparent text-stone-300"}`}
      data-applied={applied ? "true" : undefined}
      data-discount-variant={palette.variant}
      data-testid={testId}
    >
      <DiscountChip palette={palette} size="md">{children}</DiscountChip>
      {unitPriceCents === null ? null : <span className={`whitespace-nowrap ${palette.text}`}>{formatCurrency(unitPriceCents)}/u</span>}
    </li>
  );
}
