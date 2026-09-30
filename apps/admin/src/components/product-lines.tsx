"use client";

import { stockUnitLabel } from "@carnicerias/business-logic";
import { useState } from "react";

import type { ProductOption } from "../app/admin/actions";
import { ProductPicker } from "./product-picker";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export interface ProductLine { productId: string; productName: string; sku: string | null; unitType: "WEIGHT" | "UNIT"; quantity: string }

interface Row { key: string; product: ProductOption | null; quantity: string }

function newRow(line?: ProductLine): Row {
  return {
    key: crypto.randomUUID(),
    product: line ? { id: line.productId, name: line.productName, sku: line.sku, unitType: line.unitType, barcodes: [] } : null,
    quantity: line?.quantity ?? ""
  };
}

/** Quantity placeholder/hint for the chosen product: kilograms for a weighed product, whole units for a counted one. */
export function quantityHint(product: ProductOption | null): { label: string; placeholder: string; inputMode: "decimal" | "numeric" } {
  if (!product) return { label: "Cantidad", placeholder: "—", inputMode: "decimal" };
  return product.unitType === "WEIGHT"
    ? { label: "Peso (kg)", placeholder: "0,000", inputMode: "decimal" }
    : { label: "Unidades", placeholder: "0", inputMode: "numeric" };
}

/**
 * One or more "product + quantity" lines. The quantity field adapts to the product that was
 * picked (kg for WEIGHT, whole units for UNIT); the server converts it again from the product real
 * unit type, so this is presentation only. Submits repeated `product_id` / `quantity` fields.
 */
export function ProductLines({ branchId = null, initialLines = [], single = false, productFieldName = "product_id", quantityFieldName = "quantity" }: {
  branchId?: string | null;
  initialLines?: ProductLine[];
  single?: boolean;
  productFieldName?: string;
  quantityFieldName?: string;
}) {
  const [rows, setRows] = useState<Row[]>(() => (initialLines.length ? initialLines.map((line) => newRow(line)) : [newRow()]));
  const update = (key: string, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return <div className="grid gap-2">
    {rows.map((row) => {
      const hint = quantityHint(row.product);
      return <div className="grid gap-2 sm:grid-cols-[1fr_9rem_auto] sm:items-end" key={row.key}>
        <div className="grid gap-1 text-xs font-medium text-stone-500">Producto
          <ProductPicker branchId={branchId} initial={row.product} name={productFieldName} onChange={(product) => update(row.key, { product })} />
        </div>
        <label className="grid gap-1 text-xs font-medium text-stone-500">{hint.label}
          <span className="flex items-center gap-1"><input className={`${input} w-full`} inputMode={hint.inputMode} name={quantityFieldName} onChange={(event) => update(row.key, { quantity: event.target.value })} placeholder={hint.placeholder} type="text" value={row.quantity} />{row.product ? <span className="text-xs text-stone-500">{stockUnitLabel(row.product.unitType)}</span> : null}</span>
        </label>
        {single ? null : <button className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-bold text-stone-500 disabled:opacity-40" disabled={rows.length <= 1} onClick={() => setRows((current) => (current.length > 1 ? current.filter((candidate) => candidate.key !== row.key) : current))} type="button">Quitar</button>}
      </div>;
    })}
    {single ? null : <button className="mt-1 w-fit rounded-lg border border-dashed border-stone-300 px-3 py-2 text-sm font-bold text-stone-600 hover:bg-stone-50" onClick={() => setRows((current) => [...current, newRow()])} type="button">+ Agregar línea</button>}
  </div>;
}
