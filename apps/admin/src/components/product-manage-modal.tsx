"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";

import { manageProductAction, type ProductManageState } from "../app/admin/actions";
import { bpsToPercentField } from "../lib/product-margin";
import { ProductMarginField, type MarginMode } from "./product-margin-field";
import { ProductPricingFields } from "./product-pricing-fields";
import { ProductCategoryField } from "./product-category-field";
import { ProductPackFields } from "./product-pack-fields";
import { SupplierSelect, type SupplierOption } from "./supplier-select";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

interface ProductManageModalProps {
  product: {
    id: string; categoryId: string | null; name: string; slug: string;
    sku: string | null; unitType: "WEIGHT" | "UNIT"; active: boolean;
    inventoryRole: "RAW_MATERIAL" | "SELLABLE" | "BOTH"; hasUnitTypeHistory: boolean;
    barcodes: string[]; branchIds: string[];
    /** Proveedor principal actual (null = sin proveedor). */
    primarySupplierId: string | null;
    /** Unidades por pack (sólo productos por unidad; null = sin pack). */
    packSizeUnits: number | null;
    /** Descuento del pack que el producto tiene HOY guardado (basis points; null sii no hay pack). Sólo informativo: el descuento sale de la configuración global. */
    packDiscountBps: number | null;
  };
  price: { cents: number } | null;
  promotion: { id: string; label: string } | null;
  categories: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  costCents: number | null;
  suppliers: SupplierOption[];
  /** Descuento de pack global de la organización en basis points (null = todavía sin configurar). */
  globalPackDiscountBps: number | null;
  /** ¿Hay un margen global configurado? Con margen, guardar un costo nuevo recalcula el precio de venta. */
  marginConfigured: boolean;
  /** Categorías excluidas del margen automático (D-069): sus productos tienen precio manual aunque haya costo y margen. */
  excludedCategoryIds?: string[];
  /** Margen global de la organización en basis points (null = sin configurar): sólo para mostrar «Margen actual». */
  globalMarginBps?: number | null;
  /** Margen personalizado del producto en basis points (null = usa la configuración general) (D-070). */
  customMarginBps?: number | null;
}

export function ProductManageModal({ product, price, promotion, categories, branches, costCents, suppliers, globalPackDiscountBps, marginConfigured, excludedCategoryIds = [], globalMarginBps = null, customMarginBps = null }: ProductManageModalProps) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(manageProductAction, {} as ProductManageState);
  const formRef = useRef<HTMLFormElement>(null);
  const activeRef = useRef<HTMLInputElement>(null);
  const [categoryId, setCategoryId] = useState(product.categoryId ?? "");
  const [unitType, setUnitType] = useState(product.unitType);
  const [marginMode, setMarginMode] = useState<MarginMode>(customMarginBps !== null ? "custom" : "default");
  const [marginPercent, setMarginPercent] = useState(bpsToPercentField(customMarginBps));

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending) setOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  useEffect(() => {
    // With a warning (a branch stopped carrying a product that still has stock) the modal stays open so it gets read.
    if (!state.successToken || state.warning) return;
    setOpen(false);
  }, [state.successToken, state.warning]);

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
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-xl font-black" id={`manage-product-${product.id}`}>Administrar producto — {product.name}</h2><p className="mt-1 text-sm text-stone-600">Editá el producto y su precio de venta.</p></div><button aria-label="Cerrar" className="text-xl text-stone-500 hover:text-stone-900" disabled={pending} onClick={() => setOpen(false)} type="button">×</button></div>
        <form action={action} className="mt-5 grid gap-4" ref={formRef}>
          <input name="product_id" type="hidden" value={product.id} /><input name="slug" type="hidden" value={product.slug} />
          <input name="current_price_cents" type="hidden" value={price?.cents ?? ""} /><input name="current_cost_cents" type="hidden" value={costCents ?? ""} />
          <label className="grid gap-1 text-sm font-medium">Nombre<input className={input} defaultValue={product.name} name="name" required /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <ProductCategoryField categories={categories} onChange={setCategoryId} value={categoryId} />
            <label className="grid gap-1 text-sm font-medium">SKU<input className={input} defaultValue={product.sku ?? ""} name="sku" /></label>
          </div>
          <div className="rounded-lg bg-stone-50 p-3">
            <p className="text-sm font-bold">Se vende en</p>
            <p className="mt-1 text-xs text-stone-500">Sólo las sucursales marcadas ven este producto en su POS. Un producto habilitado sin stock sigue apareciendo, como "Sin stock".</p>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              {branches.map((branch) => (
                <label className="flex items-center gap-2" key={branch.id}><input defaultChecked={product.branchIds.includes(branch.id)} name="branch_ids" type="checkbox" value={branch.id} /> {branch.name}</label>
              ))}
            </div>
          </div>
          <label className="grid gap-1 text-sm font-medium">Códigos de barras
            <textarea className={input} defaultValue={product.barcodes.join("\n")} name="barcodes" placeholder="Uno por línea. Un producto puede tener varios." rows={2} />
          </label>
          <SupplierSelect currentSupplierId={product.primarySupplierId} suppliers={suppliers} />
          <label className="grid gap-1 text-sm font-medium">
            Forma de venta
            <select className={input} disabled={product.hasUnitTypeHistory} name="unit_type" onChange={(event) => setUnitType(event.target.value as "WEIGHT" | "UNIT")} value={unitType}>
              <option value="WEIGHT">Por kg</option>
              <option value="UNIT">Por unidad</option>
            </select>
            {product.hasUnitTypeHistory ? <span className="text-xs text-stone-500">No se puede cambiar: este producto ya tiene ventas, movimientos de stock, producción o promociones asociadas.</span> : null}
          </label>
          {/* Un <select> deshabilitado no viaja en el formulario: la forma de venta se manda igual para que el servidor sepa si es por unidad. */}
          {product.hasUnitTypeHistory ? <input name="unit_type" type="hidden" value={product.unitType} /> : null}
          <input name="current_pack_size_units" type="hidden" value={product.packSizeUnits ?? ""} />
          {unitType === "UNIT" ? <ProductPackFields currentPackDiscountBps={product.packDiscountBps} globalPackDiscountBps={globalPackDiscountBps} packSizeUnits={product.packSizeUnits} /> : null}
          <ProductMarginField currentCostCents={costCents} currentCustomMarginBps={customMarginBps} excludedCategory={excludedCategoryIds.includes(categoryId)} globalMarginBps={globalMarginBps} mode={marginMode} onModeChange={setMarginMode} onPercentChange={setMarginPercent} percent={marginPercent} unitType={unitType} />
          <ProductPricingFields currentCostCents={costCents} currentPriceCents={price?.cents ?? null} customMargin={marginMode === "custom" && marginPercent.trim() !== ""} excludedCategory={excludedCategoryIds.includes(categoryId)} marginConfigured={marginConfigured} unitType={unitType} />
          <div className="rounded-lg bg-stone-50 p-3">
            <p className="text-sm font-bold">Se usa como</p>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input defaultChecked={product.inventoryRole === "SELLABLE" || product.inventoryRole === "BOTH"} name="is_sellable" type="checkbox" /> Producto de venta</label>
              <label className="flex items-center gap-2"><input defaultChecked={product.inventoryRole === "RAW_MATERIAL" || product.inventoryRole === "BOTH"} name="is_raw_material" type="checkbox" /> Materia prima (insumo de desposte)</label>
            </div>
          </div>
          <div className="rounded-lg bg-stone-50 p-3"><p className="text-sm font-bold">Promoción</p><p className="mt-1 text-sm text-stone-600">{promotion?.label ?? "Sin promoción activa"}</p><Link className="mt-2 inline-block text-sm font-bold text-rose-800 hover:underline" href={promotionHref}>{promotion ? "Editar promoción" : "Crear promoción"}</Link></div>
          <label className="flex items-center gap-2 text-sm"><input defaultChecked={product.active} name="active" ref={activeRef} type="checkbox" /> Producto activo</label>
          {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
          {state.warning ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{state.warning}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><div>{product.active ? <button className="text-sm font-bold text-red-700 disabled:opacity-50" disabled={pending} onClick={deactivate} type="button">Desactivar producto</button> : null}</div><div className="flex gap-2"><button className="rounded-lg px-4 py-2 text-sm font-bold text-stone-600" disabled={pending} onClick={() => setOpen(false)} type="button">Cancelar</button><button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : "Guardar cambios"}</button></div></div>
        </form>
      </section>
    </div> : null}
  </>;
}
