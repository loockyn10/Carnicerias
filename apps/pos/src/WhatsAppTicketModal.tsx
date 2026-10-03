import { useEffect, useReducer, useRef, type SyntheticEvent } from "react";

import { normalizePhone } from "@carnicerias/business-logic";

import { useBrowserOnline } from "./lib/use-browser-online";
import {
  initialTicketSendState,
  ticketSendReducer,
  WHATSAPP_ALREADY_SENT_MESSAGE,
  WHATSAPP_ERROR_TITLE,
  WHATSAPP_OFFLINE_MESSAGE,
  WHATSAPP_RESEND_QUESTION,
  WHATSAPP_SENT_MESSAGE,
  type TicketSendState,
  type WhatsAppSendOutcome
} from "./lib/whatsapp-ticket-state";

interface WhatsAppTicketModalProps {
  /** Número corto de la venta (para el encabezado). */
  saleLabel: string;
  /** Esta venta ya tuvo un envío (visto en esta sesión): se pide confirmación antes de tipear. */
  previouslySent: boolean;
  /** La sesión de Supabase es la offline en caché: no hay JWT real para llamar al backend. */
  sessionOffline: boolean;
  /** Pide al backend el envío. El resultado siempre lo decide el servidor. */
  send: (phone: string, resend: boolean) => Promise<WhatsAppSendOutcome>;
  /** El backend confirmó el envío (para marcar la venta como enviada en pantalla). */
  onSent: () => void;
  onClose: () => void;
  /** Sólo para pruebas: renderiza un estado dado sin interacción. */
  initialState?: TicketSendState;
}

/**
 * "Enviar ticket por WhatsApp": un teléfono y listo. Sin conexión no se puede (no hay cola offline para
 * esto). Un ticket ya enviado pide confirmación; un error ofrece Reintentar con el mismo número.
 */
export function WhatsAppTicketModal({ saleLabel, previouslySent, sessionOffline, send, onSent, onClose, initialState }: WhatsAppTicketModalProps) {
  const browserOnline = useBrowserOnline();
  const online = browserOnline && !sessionOffline;
  const [state, dispatch] = useReducer(ticketSendReducer, initialState ?? initialTicketSendState(previouslySent));
  const inFlight = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !inFlight.current) onCloseRef.current(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function submit(event?: SyntheticEvent) {
    event?.preventDefault();
    if (inFlight.current || state.phase === "sending") return;
    const phone = normalizePhone(state.phone);
    if (!phone.ok) { dispatch({ type: "invalid", message: phone.message }); return; }
    if (!online) { dispatch({ type: "outcome", outcome: { kind: "offline" } }); return; }
    inFlight.current = true;
    dispatch({ type: "sending" });
    try {
      const outcome = await send(state.phone, state.resend);
      dispatch({ type: "outcome", outcome });
      if (outcome.kind === "sent") onSent();
    } catch {
      dispatch({ type: "outcome", outcome: { kind: "error", message: "No se pudo contactar al servidor.", canRetry: true } });
    } finally {
      inFlight.current = false;
    }
  }

  const sending = state.phase === "sending";
  const editing = state.phase === "editing" || sending;

  return (
    <div className="pos-modal-backdrop fixed inset-0 z-[65] grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="whatsapp-ticket-title">
      <form className="pos-modal-panel w-full max-w-md rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl" onSubmit={(event) => void submit(event)} noValidate>
        <p className="text-sm font-bold uppercase tracking-wider text-emerald-400">Ticket #{saleLabel}</p>
        <h2 id="whatsapp-ticket-title" className="mt-1 text-3xl font-black">Enviar ticket por WhatsApp</h2>

        {state.phase === "sent" ? (
          <>
            <p className="mt-5 rounded-2xl border border-emerald-500/60 bg-emerald-950/40 px-4 py-4 text-lg font-black text-emerald-200" role="status" data-testid="whatsapp-sent">
              {WHATSAPP_SENT_MESSAGE}
              {state.phoneMasked ? <span className="mt-1 block text-sm font-bold text-emerald-300/80">{state.phoneMasked}</span> : null}
            </p>
            <div className="mt-6 grid">
              <button className="rounded-xl bg-emerald-600 px-4 py-3 font-black hover:bg-emerald-500" type="button" onClick={onClose}>Listo</button>
            </div>
          </>
        ) : state.phase === "confirm_resend" ? (
          <>
            <p className="mt-5 rounded-2xl border border-amber-500/60 bg-amber-950/40 px-4 py-4 text-base font-bold text-amber-100" role="alert" data-testid="whatsapp-confirm-resend">
              {WHATSAPP_ALREADY_SENT_MESSAGE}<br />{WHATSAPP_RESEND_QUESTION}
              {state.phoneMasked ? <span className="mt-1 block text-sm font-bold text-amber-200/80">Enviado a {state.phoneMasked}</span> : null}
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" type="button" onClick={onClose}>No reenviar</button>
              <button className="rounded-xl bg-emerald-600 px-4 py-3 font-black hover:bg-emerald-500" type="button" onClick={() => dispatch({ type: "confirmResend" })}>Reenviar</button>
            </div>
          </>
        ) : state.phase === "error" ? (
          <>
            <div className="mt-5 rounded-2xl border border-red-500/60 bg-red-950/40 px-4 py-4" role="alert" data-testid="whatsapp-error">
              <p className="text-lg font-black text-red-200">{state.errorMessage === WHATSAPP_OFFLINE_MESSAGE ? WHATSAPP_OFFLINE_MESSAGE : WHATSAPP_ERROR_TITLE}</p>
              {state.errorMessage && state.errorMessage !== WHATSAPP_OFFLINE_MESSAGE ? <p className="mt-1 text-sm font-bold text-red-300">{state.errorMessage}</p> : null}
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" type="button" onClick={onClose}>Cerrar</button>
              {state.canRetry ? (
                <button className="rounded-xl bg-emerald-600 px-4 py-3 font-black hover:bg-emerald-500 disabled:opacity-50" type="button" disabled={!online} onClick={() => void submit()}>Reintentar</button>
              ) : (
                <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" type="button" onClick={() => dispatch({ type: "backToEdit" })}>Cambiar número</button>
              )}
            </div>
          </>
        ) : (
          <>
            {!online ? (
              <p className="mt-4 rounded-2xl border border-amber-500/60 bg-amber-950/40 px-4 py-3 text-sm font-bold text-amber-200" role="alert" data-testid="whatsapp-offline">
                {WHATSAPP_OFFLINE_MESSAGE}
              </p>
            ) : null}
            <label className="mt-5 grid gap-2 text-sm font-bold text-stone-300">
              Teléfono
              <input
                autoFocus
                className={`w-full rounded-2xl border bg-stone-950 px-4 py-3 text-2xl font-black outline-none focus:border-emerald-500 disabled:opacity-40 ${state.fieldError ? "border-red-500" : "border-stone-600"}`}
                disabled={sending}
                inputMode="tel"
                autoComplete="off"
                placeholder="+54 9 3496 …"
                value={state.phone}
                onChange={(event) => dispatch({ type: "edit", phone: event.target.value })}
              />
              {state.fieldError ? <span className="text-xs font-bold text-red-400" data-testid="whatsapp-field-error">{state.fieldError}</span> : <span className="text-xs font-normal text-stone-500">Con código de área, ej. +54 9 3496 123456</span>}
            </label>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800 disabled:opacity-40" type="button" disabled={sending} onClick={onClose}>Cancelar</button>
              <button className="rounded-xl bg-emerald-600 px-4 py-3 font-black hover:bg-emerald-500 disabled:opacity-50" type="submit" disabled={sending || !online || !editing}>
                {sending ? "Enviando..." : "Enviar"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
