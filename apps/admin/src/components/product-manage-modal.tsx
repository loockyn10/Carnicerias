"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

import { manageProductAction, type ProductManageState } from "../app/admin/actions";
import { ProductPricingFields } from "./product-pricing-fields";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

interface ProductManageModalProps {
  product: { id: string; categoryId: string | null; name: string; slug: string; sku: string | null; unitType: "WEIGHT" | "UNIT"; active: boolean };
  price: { cents: number } | null;
  promotion: { id: string; label: string } | null;
  categories: { id: string; name: string }[];
  pricing: { costCents: number; profitMarkupBps: number } | null;
  cashDiscountBps: number;
}

export function ProductManageModal({ product, price, promotion, categories, pricing, cashDiscountBps }: ProductManageModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(manageProductAction, {} as ProductManageState);
  const formRef = useRef<HTMLFormElement>(null);
  const activeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending) setOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  useEffect(() => {
    if (!state.successToken) return;
    setOpen(false);
    router.refresh();
  }, [router, state.successToken]);

  const promotionHref = promotion ? `/admin/promotions?edit=${promotion.id}` : `/admin/promotions?create=1&product=${product.id}`;

  const deactivate = () => {
    if (!window.confirm(`¿Desactivar ${product.name}?\nDejará de estar disponible para nuevas operaciones pero se conservará su historial.`)) return;
    if (activeRef.current) activeRef.current.checked = false;
    formRef.current?.requestSubmit();
  };

  return <>
    <button className="rounded-lg border px-3 py-2 text-sm font-bold" onClick={() => setOpen(true)} type="button">Administrar</button>
    {open ? <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target && !pending) setOpen(false); }}>
      <section aria-labelledby={`manage-product-${product.id}`} aria-modal="true" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 text-left shadow-xl" role="dialog">
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-xl font-black" id={`manage-product-${product.id}`}>Administrar producto — {product.name}</h2><p className="mt-1 text-sm text-stone-600">Editá el producto, su costo y margen.</p></div><button aria-label="Cerrar" className="text-xl text-stone-500 hover:text-stone-900" disabled={pending} onClick={() => setOpen(false)} type="button">×</button></div>
        <form action={action} className="mt-5 grid gap-4" ref={formRef}>
          <input name="product_id" type="hidden" value={product.id} /><input name="slug" type="hidden" value={product.slug} /><input name="unit_type" type="hidden" value={product.unitType} />
          <input name="current_cost_cents" type="hidden" value={pricing?.costCents ?? ""} /><input name="current_profit_markup_bps" type="hidden" value={pricing?.profitMarkupBps ?? ""} />
          <label className="grid gap-1 text-sm font-medium">Nombre<input className={input} defaultValue={product.name} name="name" required /></label>
          <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm font-medium">Categoría<select className={input} defaultValue={product.categoryId ?? ""} name="category_id" required>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label className="grid gap-1 text-sm font-medium">SKU<input className={input} defaultValue={product.sku ?? ""} name="sku" /></label></div>
          <ProductPricingFields cashDiscountBps={cashDiscountBps} costCents={pricing?.costCents ?? null} currentPriceCents={price?.cents ?? null} profitMarkupBps={pricing?.profitMarkupBps ?? null} unitType={product.unitType} />
          <div className="rounded-lg bg-stone-50 p-3"><p className="text-sm font-bold">Promoción</p><p className="mt-1 text-sm text-stone-600">{promotion?.label ?? "Sin promoción activa"}</p><Link className="mt-2 inline-block text-sm font-bold text-rose-800 hover:underline" href={promotionHref}>{promotion ? "Editar promoción" : "Crear promoción"}</Link></div>
          <label className="flex items-center gap-2 text-sm"><input defaultChecked={product.active} name="active" ref={activeRef} type="checkbox" /> Producto activo</label>
          {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><div>{product.active ? <button className="text-sm font-bold text-red-700 disabled:opacity-50" disabled={pending} onClick={deactivate} type="button">Desactivar producto</button> : null}</div><div className="flex gap-2"><button className="rounded-lg px-4 py-2 text-sm font-bold text-stone-600" disabled={pending} onClick={() => setOpen(false)} type="button">Cancelar</button><button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : "Guardar cambios"}</button></div></div>
        </form>
      </section>
    </div> : null}
  </>;
}
