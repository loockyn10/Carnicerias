"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";

import { saveWeightDiscountFormAction, type PromotionFormState } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export interface PromotionValue {
  id: string;
  productId: string;
  branchId: string | null;
  promotionMode: "THRESHOLD" | "PACK_FIXED_TOTAL";
  minimumGrams: number | null;
  discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue: number | null;
  packQuantityGrams: number | null;
  packQuantityUnits: number | null;
  packPriceCents: number | null;
  active: boolean;
  validFrom: string;
  validUntil: string | null;
}

function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function PromotionModal({ trigger, initialOpen = false, initialProductId = "", promotion, products, branches }: {
  trigger?: string;
  initialOpen?: boolean;
  initialProductId?: string;
  promotion?: PromotionValue;
  products: { id: string; name: string; active: boolean; unitType: "WEIGHT" | "UNIT" }[];
  branches: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(initialOpen);
  const [state, action, pending] = useActionState(saveWeightDiscountFormAction, {} as PromotionFormState);
  const formRef = useRef<HTMLFormElement>(null);
  const activeRef = useRef<HTMLInputElement>(null);
  const [productId, setProductId] = useState(promotion?.productId ?? initialProductId);
  const [mode, setMode] = useState<"THRESHOLD" | "PACK_FIXED_TOTAL">(promotion?.promotionMode ?? "THRESHOLD");

  const selectedProduct = useMemo(() => products.find((product) => product.id === productId), [products, productId]);
  // "Desde cierta cantidad" sigue existiendo sólo para WEIGHT (comportamiento sin cambios); "Pack
  // a precio total" es la modalidad nueva y funciona para WEIGHT o UNIT.
  const thresholdAvailable = !selectedProduct || selectedProduct.unitType === "WEIGHT";
  const packUnitType = selectedProduct?.unitType ?? "WEIGHT";

  const close = () => {
    if (pending) return;
    setOpen(false);
    if (initialOpen) router.replace("/admin/promotions");
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!state.successToken) return;
    setOpen(false);
    router.replace("/admin/promotions");
  }, [router, state.successToken]);

  useEffect(() => {
    if (!thresholdAvailable && mode === "THRESHOLD") setMode("PACK_FIXED_TOTAL");
  }, [thresholdAvailable, mode]);

  const retire = () => {
    if (!promotion || !window.confirm("¿Retirar esta promoción? Se conservará su historial, pero dejará de aplicarse.")) return;
    if (activeRef.current) activeRef.current.checked = false;
    formRef.current?.requestSubmit();
  };

  const discountValue = promotion?.discountValue != null ? promotion.discountValue / 100 : "";
  const packQuantity = promotion?.packQuantityGrams != null ? promotion.packQuantityGrams / 1000 : promotion?.packQuantityUnits ?? "";
  const packPrice = promotion?.packPriceCents != null ? promotion.packPriceCents / 100 : "";
  return <>
    {trigger ? <button className={promotion ? "rounded-lg border px-3 py-2 text-sm font-bold" : "rounded-lg bg-rose-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-900"} onClick={() => setOpen(true)} type="button">{trigger}</button> : null}
    {open ? <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section aria-modal="true" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl" role="dialog"><div className="flex items-center justify-between gap-3"><h2 className="text-xl font-black">{promotion ? "Editar promoción" : "Nueva promoción"}</h2><button aria-label="Cerrar" className="text-xl text-stone-500 hover:text-stone-900" disabled={pending} onClick={close} type="button">×</button></div>
      <form action={action} className="mt-5 grid gap-3" ref={formRef}>
        <input name="discount_id" type="hidden" value={promotion?.id ?? ""} />
        <input name="promotion_mode" type="hidden" value={mode} />
        <input name="pack_unit_type" type="hidden" value={packUnitType} />
        <label className="grid gap-1 text-sm font-medium">Producto<select className={input} name="product_id" onChange={(event) => setProductId(event.target.value)} required value={productId}><option value="">Producto</option>{products.filter((product) => product.active || product.id === promotion?.productId).map((product) => <option key={product.id} value={product.id}>{product.name} ({product.unitType === "WEIGHT" ? "kg" : "unidad"})</option>)}</select></label>
        <label className="grid gap-1 text-sm font-medium">Ámbito<select className={input} defaultValue={promotion?.branchId ?? ""} name="branch_id"><option value="">Todas las sucursales</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>

        <fieldset className="grid gap-2 rounded-lg border border-stone-200 p-3">
          <legend className="px-1 text-sm font-bold">Modalidad</legend>
          <label className="flex items-center gap-2 text-sm"><input checked={mode === "THRESHOLD"} disabled={!thresholdAvailable} onChange={() => setMode("THRESHOLD")} type="radio" /> Desde cierta cantidad {thresholdAvailable ? "" : "(sólo productos por kg)"}</label>
          <label className="flex items-center gap-2 text-sm"><input checked={mode === "PACK_FIXED_TOTAL"} onChange={() => setMode("PACK_FIXED_TOTAL")} type="radio" /> Pack a precio total</label>
        </fieldset>

        {mode === "THRESHOLD" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="grid gap-1 text-sm font-medium">Desde kg<input className={input} defaultValue={promotion?.minimumGrams != null ? promotion.minimumGrams / 1000 : ""} min="0.001" name="minimum_kg" required step="0.001" type="number" /></label>
            <label className="grid gap-1 text-sm font-medium">Tipo<select className={input} defaultValue={promotion?.discountType ?? "PERCENTAGE"} name="discount_type"><option value="PERCENTAGE">Porcentaje</option><option value="FIXED_PRICE_PER_KG">Precio por kg</option></select></label>
            <label className="grid gap-1 text-sm font-medium">Valor<input className={input} defaultValue={discountValue} min="0.01" name="discount_value" required step="0.01" type="number" /></label>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-medium">
              Cantidad del pack {packUnitType === "WEIGHT" ? "(kg)" : "(unidades)"}
              <input className={input} defaultValue={packQuantity} min={packUnitType === "WEIGHT" ? "0.001" : "1"} name={packUnitType === "WEIGHT" ? "pack_quantity_kg" : "pack_quantity_units"} required step={packUnitType === "WEIGHT" ? "0.001" : "1"} type="number" />
            </label>
            <label className="grid gap-1 text-sm font-medium">Precio total del pack<input className={input} defaultValue={packPrice} min="0.01" name="pack_price" required step="0.01" type="number" /></label>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm font-medium">Inicio<input className={input} defaultValue={localDateTime(promotion?.validFrom ?? null)} name="valid_from" type="datetime-local" /></label><label className="grid gap-1 text-sm font-medium">Fin<input className={input} defaultValue={localDateTime(promotion?.validUntil ?? null)} name="valid_until" type="datetime-local" /></label></div>
        <label className="flex items-center gap-2 text-sm"><input defaultChecked={promotion?.active ?? true} name="active" ref={activeRef} type="checkbox" /> Promoción activa</label>
        {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><div>{promotion?.active ? <button className="text-sm font-bold text-red-700 disabled:opacity-50" disabled={pending} onClick={retire} type="button">Retirar promoción</button> : null}</div><div className="flex gap-2"><button className="rounded-lg px-4 py-2 text-sm font-bold text-stone-600" disabled={pending} onClick={close} type="button">Cancelar</button><button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : "Guardar cambios"}</button></div></div>
      </form>
    </section></div> : null}
  </>;
}
