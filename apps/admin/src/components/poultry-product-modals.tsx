"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { addPoultryProductAction, savePoultryProductSettingsAction, searchPoultryCandidatesAction, type PoultryFormState } from "../app/admin/poultry/actions";
import type { ProductCreateProps } from "../lib/product-create-props";
import { parseCandidates, POULTRY_SALE_UNIT_LABELS, type PoultryCandidate, type PoultryProductRow, type PoultrySaleUnit } from "../lib/poultry";
import { fieldInput, fieldLabel, FormModal, optionalHint } from "./form-modal";
import { ProductCreateModal } from "./product-create-modal";

interface Selected { productId: string; name: string; sku: string | null; unitType: PoultrySaleUnit }

function SaleFields({ saleUnit, onSaleUnit, referenceKg, requiresWeight }: { saleUnit: PoultrySaleUnit; onSaleUnit: (value: PoultrySaleUnit) => void; referenceKg: string; requiresWeight: boolean }) {
  return <>
    <label className={fieldLabel}>Modalidad de venta
      <select className={fieldInput} name="sale_unit" onChange={(event) => { onSaleUnit(event.target.value as PoultrySaleUnit); }} value={saleUnit}>
        <option value="UNIT">{POULTRY_SALE_UNIT_LABELS.UNIT}</option><option value="WEIGHT">{POULTRY_SALE_UNIT_LABELS.WEIGHT}</option>
      </select>
      <span className={optionalHint}>{saleUnit === "UNIT" ? "Costo y precio por cajón." : "Costo y precio por kilo: hace falta el peso real para valorizar."}</span>
    </label>
    <label className={fieldLabel}>Peso de referencia del cajón (kg) <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={referenceKg} inputMode="decimal" name="reference_weight_kg" placeholder="20" /></label>
    {saleUnit === "UNIT" ? <label className="flex items-center gap-2 text-sm"><input defaultChecked={requiresWeight} name="requires_weight" type="checkbox" /> Hay que pesar el cajón antes de entregar</label> : null}
  </>;
}

/**
 * Pollos → Precios → «+ Agregar producto»: busca en el catálogo GENERAL (server-side por nombre, SKU o código de barras), elige la modalidad (por cajón / por
 * kg) y lo asocia. No crea ni copia el producto. «Crear producto nuevo» abre el MISMO alta de Productos y, al terminar, deja el producto elegido.
 */
export function PoultryAddProductModal({ createProps, defaultOpen = false, label = "+ Agregar producto", className }: { createProps: ProductCreateProps; defaultOpen?: boolean; label?: string; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<PoultryCandidate[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [saleUnit, setSaleUnit] = useState<PoultrySaleUnit>("UNIT");
  const [state, formAction, pending] = useActionState(addPoultryProductAction, {} as PoultryFormState);
  const sequence = useRef(0);

  useEffect(() => { if (state.successToken) { setOpen(false); setSelected(null); setQuery(""); } }, [state.successToken]);
  useEffect(() => {
    if (!open || selected) return;
    const current = ++sequence.current;
    const timer = window.setTimeout(() => {
      void searchPoultryCandidatesAction(query).then((result) => {
        if (current !== sequence.current) return;
        if ("error" in result) { setSearchError(result.error); return; }
        setSearchError(null);
        setCandidates(parseCandidates(result.data));
      });
    }, query === "" ? 0 : 200);
    return () => { window.clearTimeout(timer); };
  }, [open, query, selected]);

  function pick(candidate: Selected) {
    setSelected(candidate);
    setSaleUnit(candidate.unitType);
  }

  return <>
    <button className={className ?? "rounded-lg bg-rose-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-900"} onClick={() => { setOpen(true); }} type="button">{label}</button>
    {open ? <div className="fixed inset-0 z-40 grid place-items-center bg-stone-950/30 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target && !pending) setOpen(false); }}>
      <section aria-modal="true" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 text-left shadow-xl" data-testid="poultry-add-product" role="dialog">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-xl font-black">Agregar producto a Pollos</h2><p className="mt-1 text-sm text-stone-600">Elegí un producto del catálogo general. Se asocia a Pollos: no se crea otro.</p></div>
          <button aria-label="Cerrar" className="text-xl text-stone-500 hover:text-stone-900" disabled={pending} onClick={() => { setOpen(false); }} type="button">×</button>
        </div>

        {selected ? <form action={formAction} className="mt-5 grid gap-3">
          <input name="product_id" type="hidden" value={selected.productId} />
          <div className="rounded-lg bg-stone-50 p-3"><p className="text-xs font-bold uppercase tracking-wider text-stone-500">Producto</p><p className="text-lg font-black">{selected.name}</p>{selected.sku ? <p className="text-xs text-stone-500">SKU {selected.sku}</p> : null}</div>
          <SaleFields onSaleUnit={setSaleUnit} referenceKg="" requiresWeight={false} saleUnit={saleUnit} />
          {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{state.error}</p> : null}
          <div className="mt-2 flex justify-between gap-2">
            <button className="rounded-lg px-4 py-2 text-sm font-bold text-stone-600" disabled={pending} onClick={() => { setSelected(null); }} type="button">← Elegir otro</button>
            <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Agregando…" : "Agregar a Pollos"}</button>
          </div>
        </form> : <div className="mt-5 grid gap-3">
          <label className="grid gap-1 text-sm font-bold" htmlFor="poultry-candidate-search">Buscar producto
            <input autoComplete="off" autoFocus className={`${fieldInput} font-normal`} id="poultry-candidate-search" onChange={(event) => { setQuery(event.target.value); }} placeholder="Nombre, SKU o código de barras… (ej. cajón pollo)" value={query} />
          </label>
          <ul className="grid max-h-72 gap-1 overflow-y-auto" data-testid="poultry-candidates">
            {candidates.map((candidate) => <li key={candidate.productId}>
              <button className="flex w-full items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2 text-left text-sm hover:border-rose-400 hover:bg-rose-50 disabled:cursor-not-allowed disabled:bg-stone-50 disabled:opacity-60" disabled={candidate.alreadyAdded} onClick={() => { pick(candidate); }} type="button">
                <span><strong>{candidate.name}</strong>{candidate.sku ? <span className="ml-2 text-xs text-stone-500">{candidate.sku}</span> : null}</span>
                <span className="text-xs font-bold text-stone-600">{candidate.alreadyAdded ? "Ya agregado" : candidate.removedFromPoultry ? "Quitado: se reactiva" : "Agregar"}</span>
              </button>
            </li>)}
            {candidates.length === 0 && !searchError ? <li className="rounded-lg bg-stone-50 p-3 text-sm text-stone-500">{query ? "Ningún producto coincide." : "No hay productos en el catálogo."}</li> : null}
          </ul>
          {searchError ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{searchError}</p> : null}
          <div className="flex items-center justify-between gap-2 border-t border-stone-200 pt-3">
            <span className="text-sm text-stone-600">¿No existe en el catálogo?</span>
            <ProductCreateModal {...createProps} onCreated={(product) => { pick({ productId: product.id, name: product.name, sku: null, unitType: "UNIT" }); }} triggerClassName="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-700 hover:bg-stone-50" triggerLabel="+ Crear producto nuevo" />
          </div>
        </div>}
      </section>
    </div> : null}
  </>;
}

/** Configuración de Pollos de un producto ya asociado: modalidad, peso de referencia y activo / quitar de Pollos (desactivación lógica, sin borrar historia). */
export function PoultryProductSettingsModal({ product }: { product: PoultryProductRow }) {
  const [saleUnit, setSaleUnit] = useState<PoultrySaleUnit>(product.saleUnit);
  return <FormModal
    action={savePoultryProductSettingsAction}
    description="Sólo la configuración de Pollos. El nombre, el SKU y los códigos se editan en Productos."
    submitLabel="Guardar"
    title={`Pollos — ${product.name}`}
    triggerLabel="Configurar"
  >
    <input name="poultry_product_id" type="hidden" value={product.id} />
    <SaleFields onSaleUnit={setSaleUnit} referenceKg={product.referenceWeightGrams ? String(product.referenceWeightGrams / 1000).replace(".", ",") : ""} requiresWeight={product.requiresWeight} saleUnit={saleUnit} />
    <label className="flex items-center gap-2 text-sm"><input defaultChecked={product.active} name="active" type="checkbox" /> Activo en Pollos <span className={optionalHint}>(desmarcalo para quitarlo de Pollos: los pedidos históricos se conservan)</span></label>
    <p className="text-xs text-stone-500">La modalidad no se puede cambiar cuando el producto ya tiene costos, precios o pedidos.</p>
  </FormModal>;
}
