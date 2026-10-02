import { useState, type SyntheticEvent } from "react";

import { validateQuickProduct, type QuickProductFieldErrors } from "./lib/quick-product";
import { useBrowserOnline } from "./lib/use-browser-online";

interface QuickProductModalProps {
  /** Barcode just scanned (already normalized): shown as information, never asked. */
  code: string;
  /** The Supabase session of this device is a cached offline one: nothing can be created. */
  sessionOffline: boolean;
  /** Creates the product and adds it to the ticket. Resolves to an error message, or null when done. */
  onSubmit: (input: { name: string; priceCents: bigint; costCents: bigint | null }) => Promise<string | null>;
  onCancel: () => void;
}

/**
 * Alta rápida de producto desde el scanner (POS de Central): sólo nombre, costo opcional y precio.
 * El resto (categoría Almacen, UNIT, sólo Central, activo, barcode) lo fija el servidor. Sin
 * conexión el modal abre igual pero avisa que el alta la necesita (no hay cola offline de altas).
 */
export function QuickProductModal({ code, sessionOffline, onSubmit, onCancel }: QuickProductModalProps) {
  const browserOnline = useBrowserOnline();
  const online = browserOnline && !sessionOffline;
  const [name, setName] = useState("");
  const [cost, setCost] = useState("");
  const [price, setPrice] = useState("");
  const [errors, setErrors] = useState<QuickProductFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !online) return;
    const validation = validateQuickProduct({ name, cost, price });
    if (!validation.ok) { setErrors(validation.errors); return; }
    setErrors({});
    setSubmitError(null);
    setSubmitting(true);
    try {
      const failure = await onSubmit({ name: validation.name, priceCents: validation.priceCents, costCents: validation.costCents });
      if (failure) setSubmitError(failure);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "No se pudo crear el producto");
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass = (invalid: boolean) =>
    `w-full rounded-2xl border bg-stone-950 px-4 py-3 text-2xl font-black outline-none focus:border-rose-500 ${invalid ? "border-red-500" : "border-stone-600"}`;

  return (
    <div className="pos-modal-backdrop fixed inset-0 z-[55] grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="quick-product-title">
      <form className="pos-modal-panel w-full max-w-lg rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl" onSubmit={(event) => void submit(event)} noValidate>
        <p className="text-sm font-bold uppercase tracking-wider text-rose-400">Producto no encontrado</p>
        <h2 id="quick-product-title" className="mt-1 text-3xl font-black">Nuevo producto</h2>
        <p className="mt-3 text-sm font-bold text-stone-400">Código</p>
        <p className="text-2xl font-black tracking-wider text-stone-100" data-testid="quick-product-code">{code}</p>

        {!online ? (
          <p className="mt-4 rounded-2xl border border-amber-500/60 bg-amber-950/40 px-4 py-3 text-sm font-bold text-amber-200" role="alert">
            Sin conexión: para dar de alta un producto nuevo se necesita Internet. Volvé a escanear cuando se reconecte.
          </p>
        ) : null}

        <label className="mt-5 grid gap-2 text-sm font-bold text-stone-300">
          Nombre
          <input autoFocus className={fieldClass(Boolean(errors.name))} maxLength={120} placeholder="Coca Cola 2.25 L" value={name} onChange={(event) => setName(event.target.value)} />
          {errors.name ? <span className="text-xs font-bold text-red-400">{errors.name}</span> : null}
        </label>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="grid gap-2 text-sm font-bold text-stone-300">
            <span>Costo <small className="font-normal text-stone-500">opcional</small></span>
            <input className={fieldClass(Boolean(errors.cost))} inputMode="decimal" placeholder="$" value={cost} onChange={(event) => setCost(event.target.value)} />
            {errors.cost ? <span className="text-xs font-bold text-red-400">{errors.cost}</span> : null}
          </label>
          <label className="grid gap-2 text-sm font-bold text-stone-300">
            Precio de venta
            <input className={fieldClass(Boolean(errors.price))} inputMode="decimal" placeholder="$" value={price} onChange={(event) => setPrice(event.target.value)} />
            {errors.price ? <span className="text-xs font-bold text-red-400">{errors.price}</span> : null}
          </label>
        </div>

        {submitError ? <p className="mt-4 rounded-2xl border border-red-500/60 bg-red-950/40 px-4 py-3 text-sm font-bold text-red-200" role="alert">{submitError}</p> : null}

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800 disabled:opacity-40" type="button" disabled={submitting} onClick={onCancel}>Cancelar</button>
          <button className="rounded-xl bg-rose-600 px-4 py-3 font-black hover:bg-rose-500 disabled:opacity-50" type="submit" disabled={submitting || !online}>
            {submitting ? "Creando…" : "Crear y agregar"}
          </button>
        </div>
      </form>
    </div>
  );
}
