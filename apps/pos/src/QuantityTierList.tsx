import { formatCurrency, quantityTierLabel, type BranchUnitPromotion } from "@carnicerias/business-logic";

import { DiscountChip } from "./DiscountChip";
import { tierPalette, tierPositionByMinimumUnits } from "./lib/discount-chips";
import { promotedUnitPriceCents } from "./lib/ticket-pricing";

/**
 * Los escalones por cantidad de la sucursal en el diálogo de cantidad de un producto UNIT: una fila por escalón, con el MISMO color que su
 * chip en la lista (por posición) y su precio por unidad. El que el motor está aplicando a la línea se resalta con «✓ Aplicado». Sólo
 * presentación: `appliedMinimumUnits` lo decide `appliedTierMinimumUnits` (el motor de pricing), este componente no calcula descuentos.
 */
export function QuantityTierList({ tiers, listPriceCents, appliedMinimumUnits }: { tiers: readonly BranchUnitPromotion[]; listPriceCents: bigint; appliedMinimumUnits: number | null }) {
  return (
    <ul className="mt-3 space-y-1.5 text-sm font-bold" data-testid="quantity-tiers">
      {[...tiers].sort((left, right) => left.minimumUnits - right.minimumUnits).map((tier) => {
        const palette = tierPalette(tierPositionByMinimumUnits(tiers, tier.minimumUnits));
        const unitPrice = promotedUnitPriceCents(listPriceCents, tier);
        const applied = tier.minimumUnits === appliedMinimumUnits;
        return (
          <li
            className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-2 py-1 ${applied ? palette.panel : "border-transparent text-stone-300"}`}
            data-applied={applied ? "true" : undefined}
            data-discount-variant={palette.variant}
            key={tier.id}
          >
            <DiscountChip palette={palette} size="md">{quantityTierLabel(tier)}</DiscountChip>
            {unitPrice === null ? null : <span className={palette.text}>{formatCurrency(unitPrice)}/u</span>}
            {applied ? <span className="text-xs font-black uppercase tracking-wide">✓ Aplicado</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
