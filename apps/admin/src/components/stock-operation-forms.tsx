"use client";

import { useActionState, useState } from "react";

import {
  recordAdjustmentFormAction, recordPurchaseFormAction, recordWasteFormAction, setStockPolicyFormAction,
  type ProductOption, type StockOperationState
} from "../app/admin/actions";
import { ProductLines, quantityHint } from "./product-lines";
import { ProductPicker } from "./product-picker";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";
const submit = "rounded-lg bg-rose-800 px-4 py-2 font-bold text-white disabled:opacity-60";
interface Branch { id: string; name: string }

const reasonLabels: Record<string, string> = { DISCARD: "Descarte", EXPIRY: "Vencimiento", TRIMMING: "Recorte", DETERIORATION: "Deterioro", INVENTORY_DIFFERENCE: "Diferencia de inventario", OTHER: "Otro" };

function BranchSelect({ branches, value, onChange }: { branches: Branch[]; value: string; onChange: (id: string) => void }) {
  return <select className={input} name="branch_id" onChange={(event) => onChange(event.target.value)} required value={value}>
    <option value="">Sucursal</option>
    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
  </select>;
}

function Feedback({ state, success }: { state: StockOperationState; success: string }) {
  return <>
    {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
    {state.successToken ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{success}</p> : null}
  </>;
}

/** Mínimo y objetivo: in kg for a weighed product, in units for a counted one. */
export function StockPolicyForm({ branches }: { branches: Branch[] }) {
  const [state, action, pending] = useActionState(setStockPolicyFormAction, {} as StockOperationState);
  const [branchId, setBranchId] = useState("");
  const [product, setProduct] = useState<ProductOption | null>(null);
  const hint = quantityHint(product);
  return <form action={action} className="mt-4 grid gap-3" key={state.successToken ?? "policy"}>
    <BranchSelect branches={branches} onChange={(id) => { setBranchId(id); setProduct(null); }} value={branchId} />
    <ProductPicker branchId={branchId || null} key={branchId} name="product_id" onChange={setProduct} />
    <div className="grid grid-cols-2 gap-3">
      <label className="grid gap-1 text-xs font-medium text-stone-500">Mínimo {product ? `(${product.unitType === "WEIGHT" ? "kg" : "u"})` : ""}<input className={input} inputMode={hint.inputMode} name="minimum" placeholder={hint.placeholder} required type="text" /></label>
      <label className="grid gap-1 text-xs font-medium text-stone-500">Objetivo {product ? `(${product.unitType === "WEIGHT" ? "kg" : "u"})` : ""}<input className={input} inputMode={hint.inputMode} name="target" placeholder={hint.placeholder} required type="text" /></label>
    </div>
    <Feedback state={state} success="Mínimo y objetivo guardados." />
    <button className={submit} disabled={pending}>{pending ? "Guardando…" : "Guardar"}</button>
  </form>;
}

/** Compra / recepción: one or more products, each in its own unit. */
export function PurchaseForm({ branches }: { branches: Branch[] }) {
  const [state, action, pending] = useActionState(recordPurchaseFormAction, {} as StockOperationState);
  const [branchId, setBranchId] = useState("");
  return <form action={action} className="mt-4 grid gap-3" key={state.successToken ?? "purchase"}>
    <BranchSelect branches={branches} onChange={setBranchId} value={branchId} />
    <ProductLines branchId={branchId || null} key={branchId} />
    <input className={input} name="supplier" placeholder="Proveedor (opcional)" />
    <input className={input} name="note" placeholder="Nota (opcional)" />
    <Feedback state={state} success="Compra registrada." />
    <button className={submit} disabled={pending}>{pending ? "Guardando…" : "Registrar compra"}</button>
  </form>;
}

export function WasteForm({ branches }: { branches: Branch[] }) {
  const [state, action, pending] = useActionState(recordWasteFormAction, {} as StockOperationState);
  const [branchId, setBranchId] = useState("");
  return <form action={action} className="mt-4 grid gap-3" key={state.successToken ?? "waste"}>
    <BranchSelect branches={branches} onChange={setBranchId} value={branchId} />
    <ProductLines branchId={branchId || null} key={branchId} single />
    <select className={input} name="waste_reason" required>{Object.entries(reasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    <input className={input} name="note" placeholder="Nota (opcional)" />
    <Feedback state={state} success="Merma registrada." />
    <button className={submit} disabled={pending}>{pending ? "Guardando…" : "Registrar merma"}</button>
  </form>;
}

/** Inventario físico / ajuste: the typed figure is the physical count in the product own unit. */
export function StockAdjustmentForm({ branches }: { branches: Branch[] }) {
  const [state, action, pending] = useActionState(recordAdjustmentFormAction, {} as StockOperationState);
  const [branchId, setBranchId] = useState("");
  const [product, setProduct] = useState<ProductOption | null>(null);
  const hint = quantityHint(product);
  return <form action={action} className="mt-4 grid gap-3" key={state.successToken ?? "adjustment"}>
    <BranchSelect branches={branches} onChange={(id) => { setBranchId(id); setProduct(null); }} value={branchId} />
    <ProductPicker branchId={branchId || null} key={branchId} name="product_id" onChange={setProduct} />
    <label className="grid gap-1 text-xs font-medium text-stone-500">Stock físico {product ? `(${product.unitType === "WEIGHT" ? "kg" : "unidades"})` : ""}<input className={input} inputMode={hint.inputMode} name="physical" placeholder={hint.placeholder} required type="text" /></label>
    <input className={input} name="note" placeholder="Motivo / observación" required />
    <Feedback state={state} success="Ajuste registrado correctamente." />
    <button className={submit} disabled={pending}>{pending ? "Guardando…" : "Registrar ajuste"}</button>
  </form>;
}
