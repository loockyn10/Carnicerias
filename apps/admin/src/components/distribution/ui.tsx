import type { ReactNode } from "react";

import { DELIVERY_STATUS_LABELS, ITEM_OUTCOME_LABELS, RETURN_STATUS_LABELS, type DeliveryStatus, type ItemOutcome, type ReturnStatus } from "../../lib/distribution/model";

/** Piezas visuales compartidas de Distribución (mismos colores y bordes que el resto del Admin). */

export const inputClass = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
export const primaryButton = "rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white hover:bg-rose-900 disabled:opacity-50";
export const secondaryButton = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold hover:bg-stone-50 disabled:opacity-50";

export function Kpi({ label, value, hint, tone = "confirmed", testId }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "confirmed" | "estimate" | "neutral"; testId?: string }) {
  const border = tone === "estimate" ? "border-dashed border-amber-400 bg-amber-50" : "border-stone-200 bg-white";
  return <div className={`rounded-xl border p-4 shadow-sm ${border}`} data-tone={tone} data-testid={testId}>
    <p className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}{tone === "estimate" ? <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] text-amber-900">ESTIMADO</span> : null}</p>
    <p className="mt-1 text-3xl font-black tabular-nums">{value}</p>
    {hint ? <p className="mt-1 text-xs text-stone-500">{hint}</p> : null}
  </div>;
}

const DELIVERY_TONES: Record<DeliveryStatus, string> = { DRAFT: "bg-stone-200 text-stone-800", CONFIRMED: "bg-emerald-100 text-emerald-900", CANCELLED: "bg-red-100 text-red-900" };
export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${DELIVERY_TONES[status]}`}>{DELIVERY_STATUS_LABELS[status]}</span>;
}

const OUTCOME_TONES: Record<ItemOutcome, string> = { PENDING: "bg-amber-100 text-amber-900", SOLD_FIRM: "bg-emerald-100 text-emerald-900", SOLD_REPORTED: "bg-emerald-100 text-emerald-900", RETURNED: "bg-violet-100 text-violet-900" };
export function OutcomeBadge({ outcome }: { outcome: ItemOutcome }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${OUTCOME_TONES[outcome]}`}>{ITEM_OUTCOME_LABELS[outcome]}</span>;
}

const RETURN_TONES: Record<ReturnStatus, string> = {
  PENDING_RECEIPT: "bg-amber-100 text-amber-900", IN_QUARANTINE: "bg-violet-100 text-violet-900", PENDING_INSPECTION: "bg-sky-100 text-sky-900",
  APPROVED: "bg-emerald-100 text-emerald-900", REJECTED: "bg-red-100 text-red-900", DISCARDED: "bg-stone-200 text-stone-800"
};
export function ReturnStatusBadge({ status }: { status: ReturnStatus }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${RETURN_TONES[status]}`}>{RETURN_STATUS_LABELS[status]}</span>;
}

export function Notice({ tone, children }: { tone: "error" | "warn" | "ok" | "info"; children: ReactNode }) {
  const classes = { error: "bg-red-50 text-red-800", warn: "bg-amber-50 text-amber-900", ok: "bg-emerald-50 text-emerald-800", info: "bg-sky-50 text-sky-900" }[tone];
  return <p className={`rounded-lg p-3 text-sm ${classes}`} role={tone === "error" ? "alert" : "status"}>{children}</p>;
}
