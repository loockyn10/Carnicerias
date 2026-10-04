import type { WhatsAppAvailability } from "./lib/whatsapp-ticket-state";

/**
 * Estado de la impresión del ticket de esta venta. `null` en el padre = la función no existe en esta caja
 * (otra sucursal, o no es el POS de escritorio): la barra queda como siempre.
 */
export type PostSalePrintView =
  | { phase: "unconfigured" }
  | { phase: "ready" }
  | { phase: "printing" }
  | { phase: "done" }
  | { phase: "error"; message: string };

interface PostSaleBarProps {
  /** Número corto de la venta recién completada. */
  saleLabel: string;
  /** Total ya formateado, si se conoce. */
  totalLabel: string | null;
  availability: WhatsAppAvailability;
  print: PostSalePrintView | null;
  onNewSale: () => void;
  onSendTicket: () => void;
  onPrint: () => void;
  onConfigurePrinter: () => void;
}

/**
 * Confirmación NO modal de una venta completada: vender sigue siendo rápido (en cuanto se agrega el
 * próximo producto la barra desaparece sola). El ticket impreso y el de WhatsApp son opcionales: un error de
 * impresión NUNCA cambia el estado de la venta, sólo ofrece reintentar.
 */
export function PostSaleBar({ saleLabel, totalLabel, availability, print, onNewSale, onSendTicket, onPrint, onConfigurePrinter }: PostSaleBarProps) {
  const failed = print?.phase === "error";
  return (
    <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-600/60 bg-emerald-950/50 px-4 py-3 lg:mx-5" role="status" data-testid="post-sale-bar">
      <div>
        <p className="text-lg font-black text-emerald-200">Venta completada ✓</p>
        <p className="text-xs font-bold text-emerald-300/80">#{saleLabel}{totalLabel ? ` · Total ${totalLabel}` : ""}</p>
        {failed ? (
          <p className="mt-1 text-xs font-bold text-amber-300" data-testid="post-sale-print-error">
            Venta completada, pero no se pudo imprimir el ticket.
            <span className="block font-normal text-amber-200/80">{print.message}</span>
          </p>
        ) : null}
        {print?.phase === "done" ? <p className="mt-1 text-xs font-bold text-emerald-300" data-testid="post-sale-print-done">Ticket enviado a la impresora.</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {print?.phase === "unconfigured" ? (
          <button className="rounded-xl border border-stone-500 px-4 py-2 font-black text-stone-200 hover:bg-stone-800" type="button" onClick={onConfigurePrinter}>Configurar impresora</button>
        ) : print !== null ? (
          <button
            className={`rounded-xl px-4 py-2 font-black disabled:cursor-not-allowed disabled:opacity-50 ${failed ? "bg-amber-500 text-stone-950 hover:bg-amber-400" : "border border-emerald-500 text-emerald-100 hover:bg-emerald-900"}`}
            type="button"
            disabled={print.phase === "printing"}
            onClick={onPrint}
          >
            {print.phase === "printing" ? "Imprimiendo…" : failed ? "Reintentar impresión" : "Imprimir ticket"}
          </button>
        ) : null}
        <button className="rounded-xl bg-emerald-600 px-4 py-2 font-black hover:bg-emerald-500" type="button" onClick={onNewSale}>Nueva venta</button>
        {availability.visible ? (
          <div className="grid justify-items-end gap-1">
            <button
              className="rounded-xl border border-emerald-500 px-4 py-2 font-black text-emerald-100 hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              disabled={!availability.usable}
              onClick={onSendTicket}
            >
              Ticket por WhatsApp
            </button>
            {!availability.usable ? <span className="text-xs font-bold text-amber-300" data-testid="post-sale-offline">{availability.message}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
