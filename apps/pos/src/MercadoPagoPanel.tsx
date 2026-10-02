import { useCallback, useEffect, useRef, useState } from "react";

import { describePaymentState, formatCurrency, type MercadoPagoOutcome, type PaymentVerificationStatus } from "@carnicerias/business-logic";

import {
  cancelMercadoPagoOrder,
  createMercadoPagoOrder,
  fetchMercadoPagoStatus,
  type MercadoPagoContext
} from "./lib/mercadopago";
import {
  deriveLocalVerification,
  isPastExpiry,
  MERCADOPAGO_POLL_INTERVAL_MS,
  type MercadoPagoActionResult,
  type MercadoPagoOrderState
} from "./lib/mercadopago-state";

interface MercadoPagoPanelProps {
  sale: { saleId: string; totalCents: bigint };
  context: MercadoPagoContext;
  /** La sesión de Supabase es la offline en caché: no hay JWT real para llamar al backend. */
  sessionOffline: boolean;
  /** Cierra el panel. NO cancela el cobro: si sigue esperando, la venta queda en "MP pendientes". */
  onClose: () => void;
  /** Cada vez que el servidor informa un estado distinto, para reflejarlo en el caché local. */
  onVerification: (saleId: string, status: PaymentVerificationStatus) => void;
  /** El cobro TERMINÓ (pagado, sin acreditación o con algo que revisar): el padre avisa y refresca stock/sync. */
  onSettled: (saleId: string, outcome: Exclude<MercadoPagoOutcome, "WAITING">, title: string) => void;
}

function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

const TONE_CLASSES = {
  waiting: "border-sky-500 bg-sky-950 text-sky-100",
  success: "border-emerald-500 bg-emerald-950 text-emerald-100",
  warning: "border-amber-500 bg-amber-950 text-amber-100",
  error: "border-red-500 bg-red-950 text-red-100"
} as const;

/** Tras un pago confirmado el panel se cierra solo; tras un cobro vencido da unos segundos para leerlo. */
const AUTO_CLOSE_PAID_MS = 3_500;
const AUTO_CLOSE_NOT_PAID_MS = 4_500;

/**
 * Cobro con Mercado Pago de una venta YA registrada. Sólo muestra "Pago confirmado" cuando el
 * backend lo confirmó (acreditación consultada a Mercado Pago); mientras tanto "Esperando pago…".
 * Cerrar el panel mientras se espera NO cancela nada (queda en "MP pendientes"); "Cancelar cobro"
 * termina el cobro: si Mercado Pago confirma que no hubo acreditación la venta queda anulada y el
 * panel se cierra solo (ya no hay nada pendiente). Un cobro vencido o cancelado es terminal: no se
 * ofrece "generar cobro nuevo".
 */
export function MercadoPagoPanel({ sale, context, sessionOffline, onClose, onVerification, onSettled }: MercadoPagoPanelProps) {
  const browserOnline = useBrowserOnline();
  const online = browserOnline && !sessionOffline;
  const [order, setOrder] = useState<MercadoPagoOrderState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // El servidor ya no admite un cobro para esta venta (está anulada): es un final "sin acreditación".
  const [notPayable, setNotPayable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const autoStarted = useRef(false);
  const lastReported = useRef<PaymentVerificationStatus | null>(null);
  const settledOutcome = useRef<MercadoPagoOutcome | null>(null);
  const cancelRequested = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const onVerificationRef = useRef(onVerification);
  onVerificationRef.current = onVerification;
  // Primitivos (no el objeto `context`): callbacks estables aunque el padre re-renderice.
  const { deviceId, operatorProfileId, operatorToken } = context;

  const report = useCallback((verification: PaymentVerificationStatus) => {
    if (lastReported.current === verification) return;
    lastReported.current = verification;
    onVerificationRef.current(sale.saleId, verification);
  }, [sale.saleId]);

  const apply = useCallback((result: MercadoPagoActionResult) => {
    if (result.order) setOrder(result.order);
    setFailure(result.ok ? null : result.message);
    if (!result.ok && result.code === "SALE_NOT_PAYABLE") {
      // La venta ya está anulada en el servidor: terminó sin acreditación.
      setNotPayable(true);
      report("CANCELLED");
      return;
    }
    if (result.order) report(deriveLocalVerification(result.order));
  }, [report]);

  // Una sola operación a la vez (poll / alta / reintento / cancelación).
  const run = useCallback(async (action: () => Promise<MercadoPagoActionResult>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      apply(await action());
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [apply]);

  const amountCents = Number(sale.totalCents);
  const start = useCallback(
    (retry: boolean) => run(() => createMercadoPagoOrder({ deviceId, operatorProfileId, operatorToken }, sale.saleId, amountCents, retry)),
    [run, deviceId, operatorProfileId, operatorToken, sale.saleId, amountCents]
  );

  // Al abrir (y al recuperar conexión sin orden): UN alta automática idempotente, que devuelve la
  // existente si ya hay una. Si falla, el reintento es explícito (botón), nunca un bucle.
  useEffect(() => {
    if (!online) { autoStarted.current = false; return; }
    if (!order && !autoStarted.current && !notPayable) {
      autoStarted.current = true;
      void start(false);
    }
  }, [online, order, notPayable, start]);

  const view = notPayable
    ? describePaymentState({ status: null, verification: "CANCELLED", online })
    : describePaymentState({
        status: order?.status ?? null,
        verification: order?.amountMismatch ? "MISMATCH" : order?.verificationStatus ?? null,
        online
      });

  // Consulta periódica mientras se espera. Un REQUESTING se re-intenta con el MISMO alta (misma idempotency key).
  useEffect(() => {
    if (!online || !view.polling || !order) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (order.status === "REQUESTING") void start(false);
      else void run(() => fetchMercadoPagoStatus(deviceId, sale.saleId));
    }, MERCADOPAGO_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [online, view.polling, order, start, run, deviceId, sale.saleId]);

  // El cobro terminó: se avisa UNA vez y el panel se cierra solo (inmediato tras una cancelación
  // voluntaria; con unos segundos para leerlo si venció o si ya estaba anulada). Un monto distinto o
  // una devolución quedan a la vista hasta que el cajero toque "Listo".
  const outcome = view.outcome;
  useEffect(() => {
    if (outcome === "WAITING") return;
    if (settledOutcome.current !== outcome) {
      settledOutcome.current = outcome;
      onSettledRef.current(sale.saleId, outcome, view.title);
    }
    if (outcome === "NEEDS_ATTENTION") return;
    const delay = outcome === "PAID" ? AUTO_CLOSE_PAID_MS : cancelRequested.current ? 0 : AUTO_CLOSE_NOT_PAID_MS;
    const timer = window.setTimeout(() => { onCloseRef.current(); }, delay);
    return () => window.clearTimeout(timer);
  }, [outcome, sale.saleId, view.title]);

  async function cancelCharge() {
    cancelRequested.current = true;
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await cancelMercadoPagoOrder(deviceId, sale.saleId);
      apply(result);
      const after = describePaymentState({
        status: result.order?.status ?? null,
        verification: result.order?.amountMismatch ? "MISMATCH" : result.order?.verificationStatus ?? null,
        online: true
      });
      if (result.ok && after.outcome === "WAITING") {
        // Mercado Pago no confirmó la cancelación (y tampoco el pago): no se anula nada a ciegas.
        cancelRequested.current = false;
        setFailure("Mercado Pago no confirmó la cancelación. Probá de nuevo en unos segundos.");
      } else if (!result.ok) {
        cancelRequested.current = false;
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const expiredButUnconfirmed = view.polling && isPastExpiry(order, now);
  const finished = outcome !== "WAITING";

  return (
    <div className="pos-modal-backdrop fixed inset-0 z-[70] grid place-items-center bg-black/85 p-4" role="dialog" aria-modal="true" aria-labelledby="mp-title">
      <section className="pos-modal-panel w-full max-w-md rounded-3xl border border-stone-700 bg-stone-900 p-7 text-center shadow-2xl">
        <p className="text-sm font-bold uppercase tracking-wider text-sky-400">Mercado Pago · Venta #{sale.saleId.slice(0, 8)}</p>
        <p className="mt-3 text-5xl font-black text-rose-400" aria-label="Total a cobrar">{formatCurrency(sale.totalCents)}</p>

        <div className={`mt-6 rounded-2xl border-2 p-5 ${TONE_CLASSES[view.tone]}`} role="status" aria-live="polite">
          <h2 className="text-2xl font-black" id="mp-title">{view.title}</h2>
          <p className="mt-2 text-sm">{expiredButUnconfirmed ? "El tiempo del cobro terminó; verificando con Mercado Pago…" : view.detail}</p>
        </div>

        {failure && outcome !== "PAID" && outcome !== "NOT_PAID" ? <p className="mt-4 rounded-xl bg-red-950 p-3 text-sm text-red-200">{failure}</p> : null}
        {!online && !finished ? <p className="mt-4 text-sm text-amber-300">Sin conexión. La venta quedó registrada; el pago se verificará al reconectar.</p> : null}

        <div className="mt-6 grid gap-3">
          {view.canRetry && online ? (
            <button className="rounded-xl bg-sky-600 px-5 py-3 font-black hover:bg-sky-500 disabled:opacity-50" disabled={busy} onClick={() => void start(true)}>
              {order ? "Generar cobro nuevo" : "Generar cobro"}
            </button>
          ) : null}
          {view.canCancel ? (
            <button className="rounded-xl border border-stone-600 px-5 py-3 font-bold hover:bg-stone-800 disabled:opacity-50" disabled={busy || !online} onClick={() => void cancelCharge()}>
              {view.cancelLabel}
            </button>
          ) : null}
          <button className="rounded-xl border border-stone-700 px-5 py-3 font-bold text-stone-300 hover:bg-stone-800" onClick={onClose}>
            {finished ? "Listo" : "Cerrar y continuar luego"}
          </button>
        </div>
        {!finished ? <p className="mt-4 text-xs text-stone-500">La venta ya está registrada, pero no cuenta como cobrada hasta que Mercado Pago acredite el pago. Si cerrás, la retomás desde “MP pendientes”.</p> : null}
      </section>
    </div>
  );
}
