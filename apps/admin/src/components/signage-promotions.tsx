"use client";

import { useState } from "react";

import { filterByStatus, PROMOTION_STATUS_LABELS, statusCounts, validityText, type PromotionOption, type PromotionStatus } from "../lib/signage-promotions";

const STATUS_ORDER: PromotionStatus[] = ["ACTIVE", "UPCOMING", "EXPIRED"];
const STATUS_TAB_LABELS: Record<PromotionStatus, string> = { ACTIVE: "Activas", UPCOMING: "Próximas", EXPIRED: "Vencidas" };

/** Una promoción se puede elegir si no está vencida y su producto se puede mostrar (las próximas sí: empiezan a rotar solas el día que arrancan). */
export function isSelectable(option: PromotionOption): boolean {
  return option.status !== "EXPIRED" && option.unavailable === null;
}

function PhotoWarning({ hasPhoto }: { hasPhoto: boolean }) {
  return hasPhoto ? null : <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800" title="Se muestra igual, con un reemplazo de la foto">⚠ Sin foto</span>;
}

/** Lista de promociones con pestañas por vigencia (por defecto las activas) y casillas para elegir. */
export function PromotionChooser({ options, selected, onToggle, disabledIds = new Set<string>() }: {
  options: readonly PromotionOption[]; selected: ReadonlySet<string>; onToggle: (option: PromotionOption) => void; disabledIds?: ReadonlySet<string>;
}) {
  const [status, setStatus] = useState<PromotionStatus>("ACTIVE");
  const counts = statusCounts(options);
  const shown = filterByStatus(options, status);
  return <div>
    <div className="flex flex-wrap gap-2" role="tablist">
      {STATUS_ORDER.map((key) => <button aria-selected={status === key} className={`rounded-full px-3 py-1.5 text-sm font-bold ${status === key ? "bg-rose-800 text-white" : "border bg-white hover:border-rose-300"}`} key={key} onClick={() => setStatus(key)} role="tab" type="button">
        {STATUS_TAB_LABELS[key]} ({counts[key]})</button>)}
    </div>
    {status === "EXPIRED" ? <p className="mt-2 text-xs text-stone-500">Las promociones vencidas no se reproducen: se muestran sólo para consulta.</p> : null}
    <ul className="mt-2 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white" data-testid="promotion-chooser">
      {shown.map((option) => {
        const selectable = isSelectable(option) && !disabledIds.has(option.promotionId);
        const note = disabledIds.has(option.promotionId) ? "Ya está en la lista" : option.unavailable === "INACTIVE" ? "Producto inactivo" : option.unavailable === "NO_PRICE" ? "Sin precio vigente" : null;
        return <li className={`flex items-start gap-3 px-3 py-2 ${selectable ? "" : "opacity-60"}`} key={option.promotionId}>
          <input aria-label={`Elegir ${option.productName}`} checked={selected.has(option.promotionId)} className="mt-1" disabled={!selectable} onChange={() => onToggle(option)} type="checkbox" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">{option.productName}<PhotoWarning hasPhoto={option.hasPhoto} /></p>
            <p className="text-sm text-stone-700">{option.summary}</p>
            <p className="text-xs text-stone-500">{PROMOTION_STATUS_LABELS[option.status]} · {validityText(option)} · {option.branchName ?? "Todas las sucursales"}{note ? ` · ${note}` : ""}</p>
          </div>
        </li>;
      })}
      {!shown.length ? <li className="px-3 py-4 text-sm text-stone-500">{status === "ACTIVE" ? "No hay promociones activas para esta pantalla. Se cargan en Promociones." : "No hay promociones en esta pestaña."}</li> : null}
    </ul>
  </div>;
}

