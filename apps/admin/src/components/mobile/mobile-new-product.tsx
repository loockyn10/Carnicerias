"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";

import { createProductModalAction, type ProductModalState } from "../../app/admin/actions";
import { defaultNewProductBranchIds } from "../../lib/new-product-branches";
import { newProductPricingState } from "../../lib/new-product-pricing";
import { Notice, primaryButton, secondaryButton, StickyFooter, textInput } from "./mobile-ui";
import { MOBILE_HOME } from "../../lib/mobile-nav";

interface Props {
  categories: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  /** Margen global en basis points (null = sin configurar). */
  marginBps: number | null;
  /** Categorías excluidas del margen automático (D-069): el precio de sus productos es manual. */
  excludedCategoryIds: string[];
  /** Sucursal productiva: la única que arranca marcada en «Se vende en». */
  productionBranchId: string | null;
}

/**
 * «Nuevo producto» del celular: sólo lo esencial (nombre, código, categoría, forma de venta, costo/precio y dónde se vende). Es el MISMO alta que el escritorio
 * (`createProductModalAction` → `create_product_with_pricing`, costo con margen automático o precio manual según `newProductPricingState`): el celular no tiene
 * su propia lógica de precios. Al terminar no manda a una ficha de 40 campos: ofrece «Crear otro» o «Volver al inicio».
 */
export function MobileNewProduct(props: Props) {
  const [round, setRound] = useState(0);
  return <NewProductForm key={round} {...props} onAnother={() => { setRound((current) => current + 1); }} />;
}

function NewProductForm({ categories, branches, marginBps, excludedCategoryIds, productionBranchId, onAnother }: Props & { onAnother: () => void }) {
  const [state, action, pending] = useActionState(createProductModalAction, {} as ProductModalState);
  const [unitType, setUnitType] = useState<"WEIGHT" | "UNIT">("WEIGHT");
  const [categoryId, setCategoryId] = useState("");
  const [cost, setCost] = useState("");
  const [price, setPrice] = useState("");
  const [createdName, setCreatedName] = useState("");
  const defaultBranchIds = defaultNewProductBranchIds(branches, productionBranchId);
  // La sucursal productiva primero (es la que arranca marcada); después el resto por nombre.
  const orderedBranches = [...branches].sort((a, b) => Number(b.id === productionBranchId) - Number(a.id === productionBranchId) || a.name.localeCompare(b.name, "es"));
  const pricing = newProductPricingState({ marginBps, costRaw: cost, priceRaw: price, excludedCategory: excludedCategoryIds.includes(categoryId) });

  if (state.success) {
    return <div className="mobile-screen mx-auto w-full max-w-md px-4 pb-6 pt-8 text-center lg:hidden" data-testid="mobile-new-product-done">
      <div className="rounded-2xl bg-emerald-50 p-6"><p className="text-3xl font-black text-emerald-900">✓ Producto creado</p>{createdName ? <p className="mt-2 text-xl font-bold text-emerald-900">{createdName}</p> : null}</div>
      <div className="mt-6 grid gap-3"><button className={primaryButton} onClick={onAnother} type="button">Crear otro</button><Link className={secondaryButton} href={MOBILE_HOME} prefetch={false}>Volver al inicio</Link></div>
    </div>;
  }

  const label = "grid gap-1.5 text-base font-bold text-stone-800";
  const segment = (active: boolean) => `min-h-14 rounded-xl border text-lg font-black ${active ? "border-emerald-700 bg-emerald-700 text-white" : "border-stone-300 bg-white text-stone-700 active:bg-stone-100"}`;
  return <form className="mobile-screen mx-auto w-full max-w-md px-4 pb-4 pt-4 lg:hidden" data-testid="mobile-new-product" onSubmit={(event) => {
    // Sin `action={…}`: React 19 vaciaría los campos al terminar la acción, aunque haya fallado, y habría que volver a escribir todo.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = data.get("name");
    setCreatedName(typeof name === "string" ? name.trim() : "");
    startTransition(() => { action(data); });
  }}>
    <div className="grid gap-5">
      <label className={label}>Nombre<input autoComplete="off" className={textInput} name="name" required /></label>
      <label className={label}>Código de barras<input autoComplete="off" className={textInput} inputMode="numeric" name="barcodes" placeholder="Escribilo o pegalo (opcional)" /></label>
      <label className={label}>Categoría
        <select className={textInput} name="category_id" onChange={(event) => { setCategoryId(event.target.value); }} required value={categoryId}>
          <option value="">Elegí una categoría</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </label>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-base font-bold text-stone-800">Forma de venta</legend>
        <input name="unit_type" type="hidden" value={unitType} />
        <div className="grid grid-cols-2 gap-3">
          <button aria-pressed={unitType === "UNIT"} className={segment(unitType === "UNIT")} onClick={() => { setUnitType("UNIT"); }} type="button">Unidad</button>
          <button aria-pressed={unitType === "WEIGHT"} className={segment(unitType === "WEIGHT")} onClick={() => { setUnitType("WEIGHT"); }} type="button">Kg</button>
        </div>
      </fieldset>
      <label className={label}>Costo {unitType === "WEIGHT" ? "por kg" : "por unidad"} (opcional)
        <input autoComplete="off" className={textInput} inputMode="decimal" name="direct_cost" onChange={(event) => { setCost(event.target.value); }} placeholder="$ 0,00" value={cost} />
      </label>
      {pricing.priceRequired
        ? <div className="grid gap-2" data-testid="price-manual">
          <label className={label}>Precio de venta {unitType === "WEIGHT" ? "por kg" : "por unidad"}
            <input autoComplete="off" className={textInput} inputMode="decimal" name="price" onChange={(event) => { setPrice(event.target.value); }} placeholder="$ 0,00" required value={price} />
          </label>
          <Notice tone="warn">{pricing.message}</Notice>
        </div>
        : <div data-testid="price-derived"><Notice tone="ok">{pricing.message}</Notice></div>}
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-base font-bold text-stone-800">Se vende en</legend>
        {orderedBranches.map((branch) => <label className="flex min-h-12 items-center gap-3 rounded-xl border border-stone-300 bg-white px-4 text-lg" key={branch.id}>
          <input className="size-6 accent-emerald-700" defaultChecked={defaultBranchIds.includes(branch.id)} name="branch_ids" type="checkbox" value={branch.id} />{branch.name}
        </label>)}
        {productionBranchId === null ? <p className="text-sm text-stone-500">Marcá en qué sucursales se vende.</p> : null}
      </fieldset>
      <input name="is_sellable" type="hidden" value="on" /><input name="active" type="hidden" value="on" /><input name="slug" type="hidden" value="" />
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
    </div>
    <StickyFooter><button className={primaryButton} disabled={pending} type="submit">{pending ? "Creando…" : "Crear producto"}</button></StickyFooter>
  </form>;
}
