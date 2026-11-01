"use client";

import { formatCurrency } from "@carnicerias/business-logic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { setPoultryOrderStatusAction, setPoultryOrderWeightsAction } from "../app/admin/poultry/actions";
import { formatIsoDate } from "../lib/date-range";
import {
  formatKg, formatMargin, isOpenStatus, marginBps, nextStatuses, PAYMENT_METHOD_LABELS, POULTRY_ACTION_LABELS, POULTRY_SALE_UNIT_LABELS, POULTRY_STATUS_LABELS, POULTRY_STATUS_TONES,
  PRICE_SOURCE_LABELS, type PoultryOrderDetail, type PoultryOrderStatus
} from "../lib/poultry";
import { StatusBadge } from "./admin-ui";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

/**
 * Detalle de un pedido: líneas con el precio snapshot con el que se tomó, peso real editable mientras está abierto, costo histórico una vez
 * entregado y los botones de estado. Cambiar a ENTREGADO congela el costo vigente en ese momento (lo hace la base, no esta pantalla).
 */
export function PoultryOrderPanel({ order }: { order: PoultryOrderDetail }) {
  const router = useRouter();
  const open = isOpenStatus(order.status);
  const [weights, setWeights] = useState<Record<string, string>>(() => Object.fromEntries(order.items.map((item) => [item.id, item.actualWeightGrams === null ? "" : String(item.actualWeightGrams / 1000).replace(".", ",")])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function changeStatus(status: PoultryOrderStatus) {
    const warning = status === "CANCELLED" ? "¿Cancelar el pedido? Ya no se podrá reabrir." : status === "DELIVERED" ? "¿Marcar como entregado? Se congela el costo vigente de hoy para la rentabilidad." : null;
    if (warning && !window.confirm(warning)) return;
    setBusy(true); setError(null); setNotice(null);
    const result = await setPoultryOrderStatusAction(order.id, status);
    setBusy(false);
    if (result.error) { setError(result.error); return; }
    router.refresh();
  }

  async function saveWeights() {
    setBusy(true); setError(null); setNotice(null);
    const result = await setPoultryOrderWeightsAction(order.id, order.items.filter((item) => item.saleUnit === "WEIGHT" || (weights[item.id] ?? "") !== "" || item.actualWeightGrams !== null).map((item) => ({ itemId: item.id, kg: weights[item.id] ?? "" })));
    setBusy(false);
    if (result.error) { setError(result.error); return; }
    setNotice("Pesos guardados");
    router.refresh();
  }

  const profit = order.costCents !== null ? order.revenueCents - order.costCents : null;
  return <section className="rounded-xl bg-white p-5 shadow-sm" data-testid="poultry-order-panel">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-black">Pedido #{order.orderNumber} — {order.customerName}</h2>
        <p className="mt-1 text-sm text-stone-600">
          {order.branchName} · pedido {formatIsoDate(order.orderedOn)}{order.deliveryOn ? ` · entrega ${formatIsoDate(order.deliveryOn)}` : " · sin fecha de entrega"}
          {order.paymentMethod ? ` · ${PAYMENT_METHOD_LABELS[order.paymentMethod]}` : ""}
        </p>
        {order.notes ? <p className="mt-1 text-sm text-stone-500">{order.notes}</p> : null}
      </div>
      <StatusBadge tone={POULTRY_STATUS_TONES[order.status]}>{POULTRY_STATUS_LABELS[order.status]}</StatusBadge>
    </div>

    <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm">
      <thead className="border-b border-stone-200 text-stone-500"><tr><th className="py-2 pr-3">Producto</th><th className="py-2 pr-3">Cajones</th><th className="py-2 pr-3">Peso real</th><th className="py-2 pr-3">Precio</th><th className="py-2 pr-3 text-right">Importe</th>{order.status === "DELIVERED" ? <><th className="py-2 pr-3 text-right">Costo</th><th className="py-2 text-right">Ganancia</th></> : null}</tr></thead>
      <tbody>{order.items.map((item) => (
        <tr className="border-b border-stone-100 align-top" key={item.id}>
          <td className="py-2 pr-3"><strong>{item.name}</strong><span className="block text-xs text-stone-500">{POULTRY_SALE_UNIT_LABELS[item.saleUnit]}</span></td>
          <td className="py-2 pr-3">{item.boxes}</td>
          <td className="py-2 pr-3">{open ? <input aria-label={`Peso real de ${item.name} (kg)`} className={`${input} w-28`} inputMode="decimal" onChange={(event) => { setWeights((current) => ({ ...current, [item.id]: event.target.value })); }} placeholder={item.saleUnit === "WEIGHT" ? "kg (obligatorio)" : "kg"} value={weights[item.id] ?? ""} /> : item.actualWeightGrams !== null ? formatKg(item.actualWeightGrams) : "—"}</td>
          <td className="py-2 pr-3">{formatCurrency(item.unitPriceCents)}<span className="block text-xs text-stone-500">{PRICE_SOURCE_LABELS[item.priceSource] ?? item.priceSource}{item.saleUnit === "WEIGHT" ? " · por kg" : ""}</span></td>
          <td className="py-2 pr-3 text-right font-bold">{item.lineRevenueCents !== null ? formatCurrency(item.lineRevenueCents) : <span className="text-xs font-normal text-amber-700">falta el peso</span>}</td>
          {order.status === "DELIVERED" ? <>
            <td className="py-2 pr-3 text-right">{item.lineCostCents !== null ? formatCurrency(item.lineCostCents) : "—"}<span className="block text-xs text-stone-500">{item.costCentsSnapshot !== null ? `${formatCurrency(item.costCentsSnapshot)}${item.saleUnit === "WEIGHT" ? "/kg" : "/cajón"}` : ""}</span></td>
            <td className="py-2 text-right">{item.lineRevenueCents !== null && item.lineCostCents !== null ? formatCurrency(item.lineRevenueCents - item.lineCostCents) : "—"}</td>
          </> : null}
        </tr>
      ))}</tbody>
    </table></div>

    <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <div><dt className="text-xs font-bold uppercase text-stone-500">Facturación</dt><dd className="text-lg font-black text-rose-800">{formatCurrency(order.revenueCents)}</dd></div>
        {order.costCents !== null && profit !== null ? <>
          <div><dt className="text-xs font-bold uppercase text-stone-500">Costo histórico</dt><dd className="text-lg font-black">{formatCurrency(order.costCents)}</dd></div>
          <div><dt className="text-xs font-bold uppercase text-stone-500">Ganancia bruta</dt><dd className="text-lg font-black">{formatCurrency(profit)}</dd></div>
          <div><dt className="text-xs font-bold uppercase text-stone-500">Margen</dt><dd className="text-lg font-black">{formatMargin(marginBps(order.revenueCents, order.costCents))}</dd></div>
        </> : null}
      </dl>
      {open ? <div className="flex flex-wrap items-center gap-2">
        <button className="rounded-lg border px-4 py-2 text-sm font-bold disabled:opacity-50" disabled={busy} onClick={() => { void saveWeights(); }} type="button">Guardar pesos</button>
        <Link className="rounded-lg border px-4 py-2 text-sm font-bold" href={`/admin/poultry/orders?edit=${order.id}`}>Editar pedido</Link>
        {nextStatuses(order.status).map((status) => (
          <button className={`rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50 ${status === "CANCELLED" ? "border border-red-300 text-red-700" : status === "DELIVERED" ? "bg-rose-800 text-white" : "border"}`} disabled={busy} key={status} onClick={() => { void changeStatus(status); }} type="button">{POULTRY_ACTION_LABELS[status]}</button>
        ))}
      </div> : null}
    </div>
    {order.status === "DELIVERED" ? <p className="mt-3 text-xs text-stone-500">Entregado: el precio de cada línea (al crear) y su costo (al entregar) quedan congelados; cambios posteriores de precios o costos no alteran este pedido.</p> : null}
    {error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
    {notice ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{notice}</p> : null}
  </section>;
}
