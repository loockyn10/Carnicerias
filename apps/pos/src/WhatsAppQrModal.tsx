import { useCallback, useEffect, useRef, useState } from "react";

import { QrCode } from "./QrCode";
import { useBrowserOnline } from "./lib/use-browser-online";
import { qrStateFromOutcome, WHATSAPP_QR_OFFLINE_MESSAGE, type WhatsAppClaimOutcome, type WhatsAppQrState } from "./lib/whatsapp-claim-state";

interface WhatsAppQrModalProps {
  /** Número corto de la venta (encabezado). */
  saleLabel: string;
  /** La sesión de Supabase es la offline en caché: no hay JWT real para llamar al backend. */
  sessionOffline: boolean;
  /** Pide un claim al backend (nuevo token en cada llamada). El resultado siempre lo decide el servidor. */
  requestClaim: () => Promise<WhatsAppClaimOutcome>;
  onClose: () => void;
  /** Sólo para pruebas: renderiza un estado dado sin pedir nada al backend. */
  initialState?: WhatsAppQrState;
}

/**
 * "Recibí tu ticket por WhatsApp": un QR y nada más. El cliente lo escanea, WhatsApp se abre con el mensaje
 * prearmado y el backend le responde con el ticket. No se pide ni se escribe ningún teléfono. Sin Internet no
 * se genera un claim nuevo (no hay cola offline para esto).
 */
export function WhatsAppQrModal({ saleLabel, sessionOffline, requestClaim, onClose, initialState }: WhatsAppQrModalProps) {
  const browserOnline = useBrowserOnline();
  const online = browserOnline && !sessionOffline;
  const [state, setState] = useState<WhatsAppQrState>(initialState ?? { phase: "loading" });
  const inFlight = useRef(false);
  const requestRef = useRef(requestClaim);
  requestRef.current = requestClaim;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ phase: "loading" });
    try {
      setState(qrStateFromOutcome(online ? await requestRef.current() : { kind: "offline" }));
    } catch {
      setState({ phase: "error", message: "No se pudo contactar al servidor.", canRetry: true });
    } finally {
      inFlight.current = false;
    }
  }, [online]);

  useEffect(() => {
    if (!initialState) void load();
    // Un claim por apertura del modal; reintentar es explícito.
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="pos-modal-backdrop fixed inset-0 z-[65] grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="whatsapp-qr-title">
      <section className="pos-modal-panel w-full max-w-md rounded-3xl border border-stone-700 bg-stone-900 p-6 text-center shadow-2xl">
        <p className="text-sm font-bold uppercase tracking-wider text-emerald-400">Ticket #{saleLabel}</p>
        <h2 id="whatsapp-qr-title" className="mt-1 text-3xl font-black">Recibí tu ticket por WhatsApp</h2>

        {state.phase === "loading" ? (
          <p className="my-12 text-lg font-bold text-stone-300" role="status" data-testid="whatsapp-qr-loading">Generando código…</p>
        ) : state.phase === "ready" ? (
          <>
            <div className="mx-auto mt-5 w-fit rounded-2xl bg-white p-2" data-testid="whatsapp-qr">
              <QrCode value={state.link} label="Código QR para recibir el ticket por WhatsApp" />
            </div>
            <p className="mt-4 text-base font-bold text-stone-200">Escaneá el código y enviá el mensaje que aparecerá en WhatsApp.</p>
            {state.previouslyDelivered ? (
              <p className="mt-3 rounded-xl border border-amber-500/60 bg-amber-950/40 px-3 py-2 text-xs font-bold text-amber-200" data-testid="whatsapp-qr-previous">
                Ya se entregó un ticket de esta venta. Este código genera otra entrega.
              </p>
            ) : null}
          </>
        ) : (
          <div className="mt-5 rounded-2xl border border-red-500/60 bg-red-950/40 px-4 py-4" role="alert" data-testid="whatsapp-qr-error">
            <p className="text-lg font-black text-red-200">{state.message === WHATSAPP_QR_OFFLINE_MESSAGE ? WHATSAPP_QR_OFFLINE_MESSAGE : "No se pudo generar el código"}</p>
            {state.message !== WHATSAPP_QR_OFFLINE_MESSAGE ? <p className="mt-1 text-sm font-bold text-red-300">{state.message}</p> : null}
          </div>
        )}

        <div className={`mt-6 grid gap-3 ${state.phase === "error" && state.canRetry ? "grid-cols-2" : ""}`}>
          <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" type="button" onClick={onClose}>Cerrar</button>
          {state.phase === "error" && state.canRetry ? (
            <button className="rounded-xl bg-emerald-600 px-4 py-3 font-black hover:bg-emerald-500 disabled:opacity-50" type="button" disabled={!online} onClick={() => void load()}>Reintentar</button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
