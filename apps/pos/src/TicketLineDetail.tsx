import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import type { TicketLine } from "@carnicerias/types";

import { describeUnitLine, finalPricePerKgCents } from "./lib/ticket-pricing";

/** Montos y badges de una card del ticket (se muestra sólo cuando el método de pago permite ver importes). */
export function TicketLineDetail({ line }: { line: TicketLine }) {
  const isUnit = line.quantityUnits != null;
  const finalPerKg = finalPricePerKgCents(line);
  const finalLabel = finalPerKg === null ? null : (
    <>
      {" · "}
      <strong className="font-bold text-emerald-400" data-testid="final-price-per-kg">{formatCurrency(finalPerKg)}/kg final</strong>
    </>
  );
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
          {isUnit
            ? `${describeUnitLine(line).quantityLabel} · ${formatCurrency(line.originalPricePerKgCents ?? line.pricePerKgCents)}/u`
            : `${formatWeight(line.weightGrams)} × ${formatCurrency(line.originalPricePerKgCents ?? line.pricePerKgCents)}/kg`}
          {finalLabel}
        </p>
      )}
      {isUnit && !line.manualPriceApplied && describeUnitLine(line).badge ? <p className="mt-1 text-xs font-bold text-emerald-400" data-testid="unit-discount-badge">{describeUnitLine(line).badge}</p> : null}
      {line.promotionMode === "PACK_FIXED_TOTAL" ? <p className="mt-1 text-xs font-bold text-amber-300">Promo pack</p> : null}
      {/* En WEIGHT el ahorro ya se lee en el precio/kg final; el detalle por línea sólo se conserva para UNIT. */}
      {isUnit && (line.discountCents ?? 0n) > 0n ? <p className="mt-1 text-xs font-bold text-emerald-400">Descuento: -{formatCurrency(line.discountCents ?? 0n)}</p> : null}
    </>
  );
}
