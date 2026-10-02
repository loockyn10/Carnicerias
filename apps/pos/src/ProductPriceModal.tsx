import { useState, type SyntheticEvent } from "react";

import { NO_PRICE_OFFLINE_MESSAGE, validateProductPrice } from "./lib/product-price";
import { useBrowserOnline } from "./lib/use-browser-online";

interface ProductPriceModalProps {
  productName: string;
  /** The Supabase session of this device is a cached offline one: the price cannot be saved. */
  sessionOffline: boolean;
  /** Saves the price and adds the product. Resolves to an error message, or null when done. */
  onSubmit: (priceCents: bigint) => Promise<string | null>;
  onCancel: () => void;
}

/**
 * "Producto sin precio" (POS de Central): un producto importado con precio 0 nunca se vende a $0. Al
 * tocarlo o escanearlo se pide el precio; al confirmar queda como precio vigente del producto (el
 * próximo escaneo ya vale eso) y el producto se agrega al ticket. Sin conexión el modal sólo avisa:
 * no hay precio pendiente local ni venta a $0.
 */
export function ProductPriceModal({ productName, sessionOffline, onSubmit, onCancel }: ProductPriceModalProps) {
  const browserOnline = useBrowserOnline();
  const online = browserOnline && !sessionOffline;
  const [price, setPrice] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !online) return;
    const validation = validateProductPrice(price);
    if (!validation.ok) { setFieldError(validation.error); return; }
    setFieldError(null);
    setSubmitError(null);
    setSubmitting(true);
    try {
      const failure = await onSubmit(validation.priceCents);
      if (failure) setSubmitError(failure);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "No se pudo guardar el precio");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="pos-modal-backdrop fixed inset-0 z-[55] grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="product-price-title">
      <form className="pos-modal-panel w-full max-w-lg rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl" onSubmit={(event) => void submit(event)} noValidate>
        <p className="text-sm font-bold uppercase tracking-wider text-rose-400">Producto sin precio</p>
        <h2 id="product-price-title" className="mt-1 text-3xl font-black" data-testid="product-price-name">{productName}</h2>

        {!online ? (
          <p className="mt-4 whitespace-pre-line rounded-2xl border border-amber-500/60 bg-amber-950/40 px-4 py-3 text-sm font-bold text-amber-200" role="alert" data-testid="product-price-offline">
            {NO_PRICE_OFFLINE_MESSAGE}
          </p>
        ) : null}

        <label className="mt-5 grid gap-2 text-sm font-bold text-stone-300">
          Precio de venta
          <span className="flex items-center gap-2">
            <span className="text-3xl font-black text-stone-400" aria-hidden="true">$</span>
            <input
              autoFocus
              className={`w-full rounded-2xl border bg-stone-950 px-4 py-3 text-3xl font-black outline-none focus:border-rose-500 disabled:opacity-40 ${fieldError ? "border-red-500" : "border-stone-600"}`}
              disabled={!online || submitting}
              inputMode="decimal"
              placeholder="0"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </span>
          {fieldError ? <span className="text-xs font-bold text-red-400">{fieldError}</span> : null}
        </label>

        {submitError ? <p className="mt-4 rounded-2xl border border-red-500/60 bg-red-950/40 px-4 py-3 text-sm font-bold text-red-200" role="alert">{submitError}</p> : null}

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800 disabled:opacity-40" type="button" disabled={submitting} onClick={onCancel}>Cancelar</button>
          <button className="rounded-xl bg-rose-600 px-4 py-3 font-black hover:bg-rose-500 disabled:opacity-50" type="submit" disabled={submitting || !online}>
            {submitting ? "Guardando…" : "Guardar precio y agregar"}
          </button>
        </div>
      </form>
    </div>
  );
}
