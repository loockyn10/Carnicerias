import { useEffect, useRef } from "react";

import { scheduleToastDismiss } from "./lib/toast-timer";
import type { WhatsAppAvailability } from "./lib/whatsapp-ticket-state";

/**
 * Estado de la impresión del ticket de esta venta. `null` en el padre = la función no existe en esta caja
 * (otra sucursal, o no es el POS de escritorio): el aviso queda sin controles de impresión.
 */
export type PostSalePrintView =
  | { phase: "unconfigured" }
  | { phase: "ready" }
  | { phase: "printing" }
  | { phase: "done" }
  | { phase: "error"; message: string };

interface PostSaleToastProps {
  /** Identidad del aviso (el objeto de la venta): un aviso nuevo reinicia los 5 segundos. */
  notification: unknown;
  /** Número corto de la venta recién completada. */
  saleLabel: string;
  /** Total ya formateado, si se conoce. */
  totalLabel: string | null;
  availability: WhatsAppAvailability;
  print: PostSalePrintView | null;
  onDismiss: () => void;
  onSendTicket: () => void;
  onPrint: () => void;
  onConfigurePrinter: () => void;
}

/** Mientras se imprime, o si la impresión falló, el aviso espera: el operador necesita ver el resultado y reintentar. */
export function shouldAutoDismiss(print: PostSalePrintView | null): boolean {
  return print?.phase !== "printing" && print?.phase !== "error";
}

/**
 * Confirmación NO modal y temporal de una venta completada: flota sobre la interfaz (no empuja el catálogo ni el
 * ticket), se va sola a los 5 segundos y se cierra al instante con la ×. Cerrarlo no afecta la venta ni su ticket:
 * se puede reimprimir después desde «Ventas recientes». Un error de impresión NUNCA cambia el estado de la venta,
 * sólo ofrece reintentar.
 */
export function PostSaleToast({ notification, saleLabel, totalLabel, availability, print, onDismiss, onSendTicket, onPrint, onConfigurePrinter }: PostSaleToastProps) {
  const failed = print?.phase === "error";
  const autoDismiss = shouldAutoDismiss(print);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // El cleanup cancela el temporizador cuando llega otro aviso, cambia el estado de impresión o se desmonta.
  useEffect(() => {
    if (!autoDismiss) return;
    return scheduleToastDismiss(() => onDismissRef.current());
  }, [notification, autoDismiss]);

  const secondaryButton = "rounded-lg border border-emerald-500 px-3 py-1.5 text-sm font-black text-emerald-100 hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="pos-sale-toast" role="status" data-testid="post-sale-toast">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-black leading-5 text-emerald-200">Venta completada ✓</p>
          <p className="text-xs font-bold text-emerald-300/80">#{saleLabel}{totalLabel ? ` · Total ${totalLabel}` : ""}</p>
        </div>
        <button
          aria-label="Cerrar aviso"
          className="-mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xl font-black leading-none text-emerald-200 hover:bg-emerald-900"
          title="Cerrar"
          type="button"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      {failed ? (
        <p className="mt-1 text-xs font-bold text-amber-300" data-testid="post-sale-print-error">
          Venta completada, pero no se pudo imprimir el ticket.
          <span className="block font-normal text-amber-200/80">{print.message}</span>
        </p>
      ) : null}
      {print?.phase === "done" ? <p className="mt-1 text-xs font-bold text-emerald-300" data-testid="post-sale-print-done">Ticket enviado a la impresora.</p> : null}
      {print !== null || availability.visible ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {print?.phase === "unconfigured" ? (
            <button className="rounded-lg border border-stone-500 px-3 py-1.5 text-sm font-black text-stone-200 hover:bg-stone-800" type="button" onClick={onConfigurePrinter}>Configurar impresora</button>
          ) : print !== null ? (
            <button
              className={`rounded-lg px-3 py-1.5 text-sm font-black disabled:cursor-not-allowed disabled:opacity-50 ${failed ? "bg-amber-500 text-stone-950 hover:bg-amber-400" : "border border-emerald-500 text-emerald-100 hover:bg-emerald-900"}`}
              type="button"
              disabled={print.phase === "printing"}
              onClick={onPrint}
            >
              {print.phase === "printing" ? "Imprimiendo…" : failed ? "Reintentar impresión" : "Imprimir ticket"}
            </button>
          ) : null}
          {availability.visible ? (
            <button className={secondaryButton} type="button" disabled={!availability.usable} onClick={onSendTicket}>Ticket por WhatsApp</button>
          ) : null}
        </div>
      ) : null}
      {availability.visible && !availability.usable ? <p className="mt-1 text-xs font-bold text-amber-300" data-testid="post-sale-offline">{availability.message}</p> : null}
    </div>
  );
}
