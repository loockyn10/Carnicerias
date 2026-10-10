import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import type { TicketLine } from "@carnicerias/types";

import { PACK_PALETTE } from "./lib/discount-chips";
import { describeUnitLine, finalPricePerKgCents, finalPricePerUnitCents } from "./lib/ticket-pricing";

/** Montos y badges de una card del ticket (se muestra sólo cuando el método de pago permite ver importes). */
export function TicketLineDetail({ line }: { line: TicketLine }) {
  const isUnit = line.quantityUnits != null;
  // Mismo concepto para WEIGHT y UNIT: total real de la línea / cantidad real, sólo si difiere del precio base que ya se muestra.
  const finalPrice = isUnit ? finalPricePerUnitCents(line) : finalPricePerKgCents(line);
  const finalLabel = finalPrice === null ? null : (
    <>
      {" · "}
      <strong className="font-bold text-emerald-400" data-testid="final-price-per-kg">{formatCurrency(finalPrice)}/{isUnit ? "u" : "kg"} final</strong>
    </>
  );
  const unitLabel = isUnit ? describeUnitLine(line) : null;
  const unitBadge = !line.manualPriceApplied ? unitLabel?.badge : null;
  // "3 u × $5.400/u · $4.590/u final" / "1 u · $5.400/u". Una línea Pack ya trae su propia "×" ("1 pack × 8 u = 8 unidades").
  const unitSeparator = finalPrice !== null && line.packCount == null ? " × " : " · ";
  return (
    <>
      {line.manualPriceApplied ? (
        <>
          <p className="mt-1 text-sm text-stone-400" data-testid="manual-price-line">
            {isUnit ? `${String(line.quantityUnits)} u × ` : `${formatWeight(line.weightGrams)} × `}
            <span className="text-stone-500 line-through">{formatCurrency(line.originalPricePerKgCents ?? line.pricePerKgCents)}</span>
            {" → "}
            <strong className="text-amber-300">{formatCurrency(line.pricePerKgCents)}</strong>/{isUnit ? "u" : "kg"}
            {finalLabel}
          </p>
          <p className="mt-1 text-xs font-bold text-amber-300">Precio manual</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-stone-400">
          {unitLabel
            ? `${unitLabel.quantityLabel}${unitSeparator}${formatCurrency(line.originalPricePerKgCents ?? line.pricePerKgCents)}/u`
            : `${formatWeight(line.weightGrams)} × ${formatCurrency(line.originalPricePerKgCents ?? line.pricePerKgCents)}/kg`}
          {finalLabel}
        </p>
      )}
      {/* El ahorro de una promoción ya se lee en base → final: sin "Desde N u: X% OFF" ni "Descuento: -$X". Sólo el Pack conserva su etiqueta. */}
      {unitBadge ? <p className={`mt-1 text-xs font-bold ${PACK_PALETTE.text}`} data-testid="unit-discount-badge">{unitBadge}</p> : null}
      {line.promotionMode === "PACK_FIXED_TOTAL" ? <p className="mt-1 text-xs font-bold text-amber-300">Promo pack</p> : null}
    </>
  );
}
