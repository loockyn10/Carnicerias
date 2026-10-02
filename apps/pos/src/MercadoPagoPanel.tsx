import { useCallback, useEffect, useRef, useState } from "react";

import { describePaymentState, formatCurrency, type PaymentVerificationStatus } from "@carnicerias/business-logic";

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
  /** Cierra el panel. NO cancela el cobro: la venta queda pendiente de acreditación. */
  onClose: () => void;
  /** Cada vez que el servidor informa un estado distinto, para reflejarlo en el caché local. */
  onVerification: (saleId: string, status: PaymentVerificationStatus) => void;
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

/**
 * Cobro con Mercado Pago de una venta YA registrada. Sólo muestra "Pago confirmado" cuando el
 * backend lo confirmó (acreditación consultada a Mercado Pago); mientras tanto "Esperando pago…",
 * "Pago pendiente" o el estado final (vencido/cancelado/error). Cerrar el panel no cancela nada.
 */
export function MercadoPagoPanel({ sale, context, sessionOffline, onClose, onVerification }: MercadoPagoPanelProps) {
  const browserOnline = useBrowserOnline();
  const online = browserOnline && !sessionOffline;
  const [order, setOrder] = useState<MercadoPagoOrderState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const autoStarted = useRef(false);
  const lastReported = useRef<PaymentVerificationStatus | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Primitivos (no el objeto `context`): callbacks estables aunque el padre re-renderice.
  const { deviceId, operatorProfileId, operatorToken } = context;

  const apply = useCallback((result: MercadoPagoActionResult) => {
    if (result.order) setOrder(result.order);
    setFailure(result.ok ? null : result.message);
    if (result.order) {
      const verification = deriveLocalVerification(result.order);
      if (lastReported.current !== verification) {
        lastReported.current = verification;
        onVerification(sale.saleId, verification);
      }
    }
  }, [onVerification, sale.saleId]);

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
    if (!order && !autoStarted.current) {
      autoStarted.current = true;
      void start(false);
    }
  }, [online, order, start]);

  const view = describePaymentState({
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

  // Pago confirmado: cierre automático.
  const confirmed = view.tone === "success";
  useEffect(() => {
    if (!confirmed) return;
    const timer = window.setTimeout(() => { onCloseRef.current(); }, 3_500);
    return () => window.clearTimeout(timer);
  }, [confirmed]);

  const expiredButUnconfirmed = view.polling && isPastExpiry(order, now);

  return (
    <div className="pos-modal-backdrop fixed inset-0 z-[70] grid place-items-center bg-black/85 p-4" role="dialog" aria-modal="true" aria-labelledby="mp-title">
      <section className="pos-modal-panel w-full max-w-md rounded-3xl border border-stone-700 bg-stone-900 p-7 text-center shadow-2xl">
        <p className="text-sm font-bold uppercase tracking-wider text-sky-400">Mercado Pago · Venta #{sale.saleId.slice(0, 8)}</p>
        <p className="mt-3 text-5xl font-black text-rose-400" aria-label="Total a cobrar">{formatCurrency(sale.totalCents)}</p>

        <div className={`mt-6 rounded-2xl border-2 p-5 ${TONE_CLASSES[view.tone]}`} role="status" aria-live="polite">
          <h2 className="text-2xl font-black" id="mp-title">{view.title}</h2>
          <p className="mt-2 text-sm">{expiredButUnconfirmed ? "El tiempo del cobro terminó; verificando con Mercado Pago…" : view.detail}</p>
        </div>

        {failure && !confirmed ? <p className="mt-4 rounded-xl bg-red-950 p-3 text-sm text-red-200">{failure}</p> : null}
        {!online && !confirmed ? <p className="mt-4 text-sm text-amber-300">Sin conexión. La venta quedó registrada; el pago se verificará al reconectar.</p> : null}

        <div className="mt-6 grid gap-3">
          {view.canRetry && online ? (
            <button className="rounded-xl bg-sky-600 px-5 py-3 font-black hover:bg-sky-500 disabled:opacity-50" disabled={busy} onClick={() => void start(true)}>
              {order ? "Generar cobro nuevo" : "Generar cobro"}
            </button>
          ) : null}
          {view.canCancel ? (
            <button className="rounded-xl border border-stone-600 px-5 py-3 font-bold hover:bg-stone-800 disabled:opacity-50" disabled={busy || !online} onClick={() => void run(() => cancelMercadoPagoOrder(deviceId, sale.saleId))}>
              Cancelar cobro
            </button>
          ) : null}
          <button className="rounded-xl border border-stone-700 px-5 py-3 font-bold text-stone-300 hover:bg-stone-800" onClick={onClose}>
            {confirmed ? "Listo" : "Cerrar (el cobro queda pendiente)"}
          </button>
        </div>
        {!confirmed ? <p className="mt-4 text-xs text-stone-500">La venta ya está registrada. Si el pago no se acredita, el administrador la verá como “sin acreditación”.</p> : null}
      </section>
    </div>
  );
}
