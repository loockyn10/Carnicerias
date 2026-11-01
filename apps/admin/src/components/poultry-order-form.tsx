"use client";

import { formatCurrency } from "@carnicerias/business-logic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolvePoultryPricesAction, savePoultryOrderAction } from "../app/admin/poultry/actions";
import {
  lineAmountCents, parseKgInput, parsePesosInput, parseResolvedPrices, pesosInput, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, POULTRY_SALE_UNIT_LABELS, PRICE_SOURCE_LABELS,
  type PoultryOrderDetail, type PoultryPaymentMethod, type ResolvedPrice
} from "../lib/poultry";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

interface Line {
  key: string;
  itemId: string | null;
  productId: string;
  boxes: string;
  weightKg: string;
  priceText: string;
  /** Precio con el que arrancó la línea (el resuelto por el servidor o el snapshot del pedido): si el operador no lo toca, no se manda. */
  baseCents: bigint | null;
  source: string | null;
}

export interface OrderFormProps {
  branches: { id: string; name: string }[];
  defaultBranchId: string;
  customers: { id: string; name: string }[];
  /** Precios que se le aplican hoy al cliente elegido al abrir (sin cliente: lista General). */
  initialPrices: ResolvedPrice[];
  today: string;
  order?: PoultryOrderDetail | null;
  /** Cliente preseleccionado (viene de «Nuevo pedido» en la ficha del cliente). */
  initialCustomerId?: string;
}

let lineCounter = 0;
const nextKey = () => { lineCounter += 1; return `line-${String(lineCounter)}`; };

function weightKgText(grams: number | null): string {
  return grams === null ? "" : String(grams / 1000).replace(".", ",");
}

/**
 * Carga de pedido pensada para ser muy rápida: cliente, fechas y botones de un clic por producto. Cada línea trae el precio que le corresponde al
 * cliente (precio propio → su lista → General), resuelto por el SERVIDOR; el operador sólo lo toca si quiere un precio manual. El precio y el costo
 * históricos los congela la base (precio al crear, costo al entregar).
 */
export function PoultryOrderForm({ branches, defaultBranchId, customers, initialPrices, today, order = null, initialCustomerId = "" }: OrderFormProps) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(order?.customerId ?? initialCustomerId);
  const [branchId, setBranchId] = useState(order?.branchId ?? defaultBranchId);
  const [orderedOn, setOrderedOn] = useState(order?.orderedOn ?? today);
  const [deliveryOn, setDeliveryOn] = useState(order?.deliveryOn ?? "");
  const [paymentMethod, setPaymentMethod] = useState<PoultryPaymentMethod | "">(order?.paymentMethod ?? "");
  const [notes, setNotes] = useState(order?.notes ?? "");
  const [prices, setPrices] = useState<ResolvedPrice[]>(initialPrices);
  const [lines, setLines] = useState<Line[]>(() => order
    ? order.items.map((item) => ({ key: nextKey(), itemId: item.id, productId: item.productId, boxes: String(item.boxes), weightKg: weightKgText(item.actualWeightGrams), priceText: pesosInput(item.unitPriceCents), baseCents: item.unitPriceCents, source: item.priceSource }))
    : []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requestKey = useRef(typeof crypto !== "undefined" ? crypto.randomUUID() : "");
  const firstRender = useRef(true);

  const priceFor = useMemo(() => new Map(prices.map((price) => [price.productId, price])), [prices]);

  // Al cambiar de cliente se vuelven a pedir los precios al servidor y se actualizan las líneas que no tienen precio manual ni son de un pedido ya guardado.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    let cancelled = false;
    void resolvePoultryPricesAction(customerId || null).then((result) => {
      if (cancelled) return;
      if ("error" in result) { setError(result.error); return; }
      const resolved = parseResolvedPrices(result.data);
      setPrices(resolved);
      const byProduct = new Map(resolved.map((price) => [price.productId, price]));
      setLines((current) => current.map((line) => {
        const wasManual = line.baseCents === null ? line.priceText.trim() !== "" : parsePesosInput(line.priceText) !== line.baseCents;
        if (wasManual) return line;
        const price = byProduct.get(line.productId);
        return { ...line, priceText: pesosInput(price?.priceCents ?? null), baseCents: price?.priceCents ?? null, source: price?.source ?? null };
      }));
    });
    return () => { cancelled = true; };
  }, [customerId]);

  function addProduct(productId: string) {
    setLines((current) => {
      const existing = current.find((line) => line.productId === productId);
      if (existing) return current.map((line) => line.key === existing.key ? { ...line, boxes: String((Number.parseInt(line.boxes, 10) || 0) + 1) } : line);
      const price = priceFor.get(productId);
      return [...current, { key: nextKey(), itemId: null, productId, boxes: "1", weightKg: "", priceText: pesosInput(price?.priceCents ?? null), baseCents: price?.priceCents ?? null, source: price?.source ?? null }];
    });
  }

  function patch(key: string, change: Partial<Line>) {
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...change } : line));
  }

  const computed = lines.map((line) => {
    const price = priceFor.get(line.productId);
    const unit = price?.saleUnit ?? "UNIT";
    const boxes = Number.parseInt(line.boxes, 10);
    const grams = parseKgInput(line.weightKg);
    const cents = parsePesosInput(line.priceText);
    const amount = cents !== null && Number.isFinite(boxes) && boxes > 0 ? lineAmountCents(unit, cents, boxes, grams) : null;
    const manual = cents !== null && cents !== line.baseCents;
    return { line, price, unit, boxes, grams, cents, amount, manual };
  });
  const total = computed.reduce((sum, row) => sum + (row.amount ?? 0n), 0n);
  const missingWeight = computed.filter((row) => row.unit === "WEIGHT" && row.grams === null).length;

  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!customerId) { setError("Elegí el cliente"); return; }
    setSaving(true);
    try {
      const result = await savePoultryOrderAction({
        orderId: order?.id ?? null, requestKey: order ? null : requestKey.current, branchId, customerId, orderedOn, deliveryOn: deliveryOn || null,
        paymentMethod: paymentMethod || null, notes: notes.trim() || null,
        items: computed.map((row) => ({
          itemId: row.line.itemId, productId: row.line.productId, boxes: row.boxes, actualWeightGrams: row.grams,
          // Sólo se manda el precio cuando el operador lo cambió (manual): si no, el servidor resuelve o conserva el snapshot.
          unitPriceCents: row.manual && row.cents !== null ? Number(row.cents) : null
        }))
      });
      if (!result.ok) { setError(result.error); return; }
      router.push(`/admin/poultry/orders?order=${result.orderId}&saved=${String(result.orderNumber)}`);
      router.refresh();
    } catch {
      setError("No se pudo guardar el pedido. Revisá la conexión y reintentá.");
    } finally {
      setSaving(false);
    }
  }

  const active = prices;
  return <form className="grid gap-5" onSubmit={(event) => { void submit(event); }}>
    <section className="grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-4">
      <label className="grid gap-1 text-sm font-bold md:col-span-2">Cliente
        <select autoFocus className={`${input} font-normal`} onChange={(event) => { setCustomerId(event.target.value); }} required value={customerId}>
          <option value="">Elegí un cliente…</option>
          {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Fecha del pedido<input className={`${input} font-normal`} onChange={(event) => { setOrderedOn(event.target.value); }} required type="date" value={orderedOn} /></label>
      <label className="grid gap-1 text-sm font-bold">Fecha de entrega<input className={`${input} font-normal`} min={orderedOn} onChange={(event) => { setDeliveryOn(event.target.value); }} type="date" value={deliveryOn} /></label>
      <label className="grid gap-1 text-sm font-bold">Sucursal
        <select className={`${input} font-normal`} disabled={Boolean(order)} onChange={(event) => { setBranchId(event.target.value); }} value={branchId}>
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Forma de pago <span className="text-xs font-normal text-stone-500">opcional</span>
        <select className={`${input} font-normal`} onChange={(event) => { setPaymentMethod(event.target.value as PoultryPaymentMethod | ""); }} value={paymentMethod}>
          <option value="">Sin definir</option>
          {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-bold md:col-span-2">Observaciones <span className="text-xs font-normal text-stone-500">opcional</span><input className={`${input} font-normal`} maxLength={1000} onChange={(event) => { setNotes(event.target.value); }} value={notes} /></label>
    </section>

    <section className="rounded-xl bg-white p-4 shadow-sm">
      <h2 className="text-lg font-black">Productos</h2>
      <p className="mt-1 text-sm text-stone-600">Un clic agrega el producto (otro clic suma un cajón). El precio sale de la lista del cliente.</p>
      <div className="mt-3 flex flex-wrap gap-2" data-testid="quick-products">
        {active.length === 0 ? <p className="text-sm text-stone-500">No hay productos activos: cargalos en Precios.</p> : null}
        {active.map((price) => <button className="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-bold hover:border-rose-400 hover:bg-rose-50 disabled:opacity-50" disabled={price.priceCents === null && !lines.some((line) => line.productId === price.productId)} key={price.productId} onClick={() => { addProduct(price.productId); }} title={price.priceCents === null ? "Sin precio para este cliente: se puede cargar uno manual" : undefined} type="button">
          + {price.name}{price.priceCents === null ? " (sin precio)" : ""}
        </button>)}
      </div>

      {computed.length === 0 ? <p className="mt-4 text-sm text-stone-500">Todavía no agregaste productos.</p> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm">
        <thead className="border-b border-stone-200 text-stone-500"><tr><th className="py-2 pr-3">Producto</th><th className="py-2 pr-3">Cajones</th><th className="py-2 pr-3">Peso real (kg)</th><th className="py-2 pr-3">Precio ($)</th><th className="py-2 pr-3 text-right">Importe</th><th /></tr></thead>
        <tbody>{computed.map((row) => (
          <tr className="border-b border-stone-100 align-top" key={row.line.key}>
            <td className="py-2 pr-3"><strong>{row.price?.name ?? "Producto"}</strong><span className="block text-xs text-stone-500">{POULTRY_SALE_UNIT_LABELS[row.unit]}{row.price?.referenceWeightGrams ? ` · ref. ${String(row.price.referenceWeightGrams / 1000)} kg` : ""}</span></td>
            <td className="py-2 pr-3"><input aria-label="Cajones" className={`${input} w-20`} inputMode="numeric" min={1} onChange={(event) => { patch(row.line.key, { boxes: event.target.value }); }} type="number" value={row.line.boxes} /></td>
            <td className="py-2 pr-3"><input aria-label="Peso real en kg" className={`${input} w-28`} inputMode="decimal" onChange={(event) => { patch(row.line.key, { weightKg: event.target.value }); }} placeholder={row.unit === "WEIGHT" ? "Obligatorio" : "Opcional"} value={row.line.weightKg} /></td>
            <td className="py-2 pr-3"><input aria-label="Precio" className={`${input} w-32`} inputMode="decimal" onChange={(event) => { patch(row.line.key, { priceText: event.target.value }); }} value={row.line.priceText} />
              <span className="mt-1 block text-xs text-stone-500">{row.manual ? "Manual" : (PRICE_SOURCE_LABELS[row.line.source ?? ""] ?? "Sin precio")}{row.unit === "WEIGHT" ? " · por kg" : " · por cajón"}</span></td>
            <td className="py-2 pr-3 text-right font-bold">{row.amount !== null ? formatCurrency(row.amount) : <span className="text-xs font-normal text-amber-700">{row.unit === "WEIGHT" && row.grams === null ? "falta el peso" : "—"}</span>}</td>
            <td className="py-2 text-right"><button aria-label="Quitar" className="text-lg text-stone-400 hover:text-red-700" onClick={() => { setLines((current) => current.filter((line) => line.key !== row.line.key)); }} type="button">×</button></td>
          </tr>
        ))}</tbody>
      </table></div>}
    </section>

    {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-sm">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-stone-500">Total estimado</p>
        <p className="text-2xl font-black text-rose-800" data-testid="order-total">{formatCurrency(total)}</p>
        {missingWeight > 0 ? <p className="text-xs text-amber-700">{missingWeight} línea{missingWeight === 1 ? "" : "s"} por kg sin peso: se valorizan cuando se pesen.</p> : null}
      </div>
      <div className="flex gap-2">
        <button className="rounded-lg px-4 py-2 text-sm font-bold text-stone-600" onClick={() => { router.push(order ? `/admin/poultry/orders?order=${order.id}` : "/admin/poultry/orders"); }} type="button">Cancelar</button>
        <button className="rounded-lg bg-rose-800 px-6 py-2.5 text-sm font-bold text-white hover:bg-rose-900 disabled:opacity-60" disabled={saving || lines.length === 0}>{saving ? "Guardando…" : order ? "Guardar cambios" : "Crear pedido"}</button>
      </div>
    </div>
  </form>;
}
