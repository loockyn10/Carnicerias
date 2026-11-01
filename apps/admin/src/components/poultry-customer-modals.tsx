"use client";

import { formatCurrency } from "@carnicerias/business-logic";

import { savePoultryCustomerAction, savePoultryCustomerPricesAction } from "../app/admin/poultry/actions";
import { pesosInput, POULTRY_SALE_UNIT_LABELS, PRICE_SOURCE_LABELS, type PoultryCustomerDetail, type PoultryPriceList } from "../lib/poultry";
import { fieldInput, fieldLabel, FormModal, optionalHint } from "./form-modal";

export interface CustomerFormValue {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  taxId: string | null;
  notes: string | null;
  active: boolean;
  priceListId: string | null;
}

/** Alta / edición de un cliente de Pollos. Sólo el nombre es obligatorio; la lista de precios define sus precios por defecto. */
export function PoultryCustomerModal({ customer, lists }: { customer?: CustomerFormValue; lists: PoultryPriceList[] }) {
  return <FormModal
    action={savePoultryCustomerAction}
    description="Sólo el nombre es obligatorio."
    submitLabel={customer ? "Guardar cambios" : "Crear cliente"}
    title={customer ? `Editar cliente — ${customer.name}` : "Nuevo cliente"}
    triggerClassName={customer ? "rounded-lg border px-3 py-2 text-sm font-bold" : "rounded-lg bg-rose-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-900"}
    triggerLabel={customer ? "Editar" : "+ Nuevo cliente"}
  >
    {customer ? <input name="customer_id" type="hidden" value={customer.id} /> : null}
    <label className={fieldLabel}>Nombre / razón social<input autoFocus className={fieldInput} defaultValue={customer?.name ?? ""} maxLength={160} name="name" required /></label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={fieldLabel}>Teléfono / WhatsApp <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={customer?.phone ?? ""} inputMode="tel" maxLength={60} name="phone" /></label>
      <label className={fieldLabel}>DNI / CUIT <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={customer?.taxId ?? ""} maxLength={40} name="tax_id" /></label>
    </div>
    <label className={fieldLabel}>Dirección <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={customer?.address ?? ""} maxLength={240} name="address" /></label>
    <label className={fieldLabel}>Lista de precios
      <select className={fieldInput} defaultValue={customer?.priceListId ?? ""} name="price_list_id">
        <option value="">General (por defecto)</option>
        {lists.filter((list) => list.active && !list.isDefault).map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
      </select>
    </label>
    <label className={fieldLabel}>Notas <span className={optionalHint}>opcional</span><textarea className={fieldInput} defaultValue={customer?.notes ?? ""} maxLength={1000} name="notes" rows={3} /></label>
    <label className="flex items-center gap-2 text-sm"><input defaultChecked={customer?.active ?? true} name="active" type="checkbox" /> Cliente activo</label>
  </FormModal>;
}

/** Precios específicos del cliente: un valor lo fija (pisa su lista), vacío lo quita. */
export function PoultryCustomerPricesModal({ detail }: { detail: PoultryCustomerDetail }) {
  const products = detail.prices.filter((price) => price.active);
  return <FormModal
    action={savePoultryCustomerPricesAction}
    description="Un precio acá pisa el de la lista del cliente. Vacío = usa su lista. Los pedidos ya tomados no cambian."
    submitLabel="Guardar precios"
    title={`Precios de ${detail.customer.name}`}
    triggerLabel="Precios del cliente"
    wide
  >
    <input name="customer_id" type="hidden" value={detail.customer.id} />
    {products.length === 0 ? <p className="text-sm text-stone-500">No hay productos activos.</p> : <div className="grid gap-2">
      {products.map((price) => (
        <div className="grid items-center gap-2 sm:grid-cols-[1fr_9rem_12rem]" key={price.productId}>
          <span className="text-sm font-semibold">{price.productName} <span className="text-xs font-normal text-stone-500">{POULTRY_SALE_UNIT_LABELS[price.saleUnit].toLowerCase()}</span></span>
          <span className="text-xs text-stone-500">{price.effectiveCents !== null ? `${formatCurrency(price.effectiveCents)} · ${PRICE_SOURCE_LABELS[price.source ?? ""] ?? "—"}` : "Sin precio"}</span>
          <input aria-label={`Precio especial de ${price.productName}`} className={fieldInput} defaultValue={pesosInput(price.specialCents)} inputMode="decimal" name={`price_${price.productId}`} placeholder="Precio especial ($)" />
          {price.specialCents !== null ? <input name="had" type="hidden" value={price.productId} /> : null}
        </div>
      ))}
    </div>}
    <label className={fieldLabel}>Vigente desde <span className={optionalHint}>opcional · vacío = ahora</span><input className={fieldInput} name="effective_from" type="datetime-local" /></label>
  </FormModal>;
}
