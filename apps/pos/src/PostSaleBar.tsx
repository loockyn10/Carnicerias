import type { WhatsAppAvailability } from "./lib/whatsapp-ticket-state";

interface PostSaleBarProps {
  /** Número corto de la venta recién completada. */
  saleLabel: string;
  /** Total ya formateado, si se conoce. */
  totalLabel: string | null;
  availability: WhatsAppAvailability;
  onNewSale: () => void;
  onSendTicket: () => void;
}

/**
 * Confirmación NO modal de una venta completada: vender sigue siendo rápido (en cuanto se agrega el
 * próximo producto la barra desaparece sola). El ticket por WhatsApp es opcional: abre un QR que el cliente escanea.
 */
export function PostSaleBar({ saleLabel, totalLabel, availability, onNewSale, onSendTicket }: PostSaleBarProps) {
  return (
    <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-600/60 bg-emerald-950/50 px-4 py-3 lg:mx-5" role="status" data-testid="post-sale-bar">
      <div>
        <p className="text-lg font-black text-emerald-200">Venta completada</p>
        <p className="text-xs font-bold text-emerald-300/80">#{saleLabel}{totalLabel ? ` · ${totalLabel}` : ""}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
