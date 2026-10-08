import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_PRINTER_SETTINGS, describePrintError, printTestPage, printerApi,
  type InstalledPrinter, type PrinterApi, type PrinterCodePage, type PrinterSettings
} from "./lib/printer";
import { RECEIPT_PAPER_WIDTH_MM } from "./lib/receipt-render";

interface PrinterSettingsModalProps {
  /** Lo guardado en esta computadora (null = todavía no se pudo leer). */
  settings: PrinterSettings | null;
  onSaved: (settings: PrinterSettings) => void;
  onClose: () => void;
  api?: PrinterApi;
  /** Sólo para pruebas: renderiza con esta lista de impresoras sin pedirla. */
  initialPrinters?: InstalledPrinter[];
}

type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "ok"; message: string } | { kind: "error"; message: string };

/**
 * "Impresora de tickets" de ESTA computadora (no de la organización): se elige una impresora instalada en
 * Windows, se imprime una prueba y se decide si imprime sola y si corta. Se guarda en SQLite local.
 */
export function PrinterSettingsModal({ settings, onSaved, onClose, api = printerApi, initialPrinters }: PrinterSettingsModalProps) {
  const [draft, setDraft] = useState<PrinterSettings>(settings ?? DEFAULT_PRINTER_SETTINGS);
  const [printers, setPrinters] = useState<InstalledPrinter[] | null>(initialPrinters ?? null);
  const [listError, setListError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (initialPrinters) return;
    let cancelled = false;
    api.listPrinters().then(
      (list) => { if (!cancelled) setPrinters(list); },
      (error: unknown) => { if (!cancelled) { setPrinters([]); setListError(describePrintError(error).message); } }
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const busy = status.kind === "busy";
  const selected = draft.enabled ? draft.printerName : null;
  const installedNames = new Set((printers ?? []).map((printer) => printer.name.toLowerCase()));
  // La lista pudo no cargar (otro sistema operativo): sin lista no se puede afirmar que falte.
  const missing = selected !== null && printers !== null && listError === null && !installedNames.has(selected.toLowerCase());
  const canTest = selected !== null && !missing && !busy;

  function choose(value: string) {
    setStatus({ kind: "idle" });
    setDraft((current) => value === ""
      ? { ...current, enabled: false, autoPrint: false }
      : { ...current, enabled: true, printerName: value });
  }

  async function test() {
    if (selected === null || missing) return;
    setStatus({ kind: "busy", label: "Imprimiendo prueba…" });
    const outcome = await printTestPage(draft, selected, api);
    setStatus(outcome.ok ? { kind: "ok", message: "Prueba enviada a la impresora." } : { kind: "error", message: outcome.message });
  }

  async function save() {
    if (missing) return;
    setStatus({ kind: "busy", label: "Guardando…" });
    try {
      const saved = await api.setSettings({ ...draft, paperWidthMm: RECEIPT_PAPER_WIDTH_MM, autoPrint: draft.enabled && draft.autoPrint });
      onSaved(saved);
      onClose();
    } catch (error) {
      setStatus({ kind: "error", message: typeof error === "string" ? error.replace(/^[A-Z_]+:\s*/, "") : "No se pudo guardar la configuración." });
    }
  }

  return (
    <div className="pos-modal-backdrop fixed inset-0 z-[65] grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="printer-settings-title">
      <section className="pos-modal-panel w-full max-w-md rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl">
        <p className="text-sm font-bold uppercase tracking-wider text-rose-400">Esta computadora</p>
        <h2 id="printer-settings-title" className="mt-1 text-3xl font-black">Impresora de tickets</h2>
        <p className="mt-1 text-xs font-bold text-stone-500">Papel térmico de 58 mm</p>

        <label className="mt-5 grid gap-2 text-sm font-bold text-stone-300">
          Impresora
          <select
            className="w-full rounded-2xl border border-stone-600 bg-stone-950 px-4 py-3 text-lg font-black outline-none focus:border-emerald-500 disabled:opacity-50"
            disabled={printers === null || busy}
            value={selected ?? ""}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">{printers === null ? "Buscando impresoras…" : "Sin impresora (desactivada)"}</option>
            {missing ? <option value={selected}>{selected} (no instalada)</option> : null}
            {(printers ?? []).map((printer) => <option key={printer.name} value={printer.name}>{printer.name}{printer.isDefault ? " (predeterminada de Windows)" : ""}</option>)}
          </select>
        </label>

        {missing ? (
          <p className="mt-3 rounded-2xl border border-red-500/60 bg-red-950/40 px-4 py-3 text-sm font-bold text-red-200" role="alert" data-testid="printer-missing">
            La impresora “{selected}” ya no está instalada en esta computadora. Elegí otra.
          </p>
        ) : null}
        {listError ? <p className="mt-3 rounded-2xl border border-amber-500/60 bg-amber-950/40 px-4 py-3 text-sm font-bold text-amber-200" role="alert" data-testid="printer-list-error">{listError}</p> : null}
        {printers !== null && printers.length === 0 && !listError ? (
          <p className="mt-3 text-xs font-bold text-amber-300" data-testid="printer-none-installed">No hay impresoras instaladas en Windows. Instalá el driver de la térmica y volvé a abrir esta pantalla.</p>
        ) : null}

        <button
          className="mt-4 w-full rounded-xl border border-stone-600 px-4 py-3 font-black hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40"
          type="button" disabled={!canTest} onClick={() => void test()}
        >
          Imprimir prueba
        </button>

        <label className="mt-5 flex items-center gap-3 text-sm font-bold text-stone-200">
          <input className="h-5 w-5 accent-emerald-500" type="checkbox" disabled={!draft.enabled} checked={draft.enabled && draft.autoPrint} onChange={(event) => setDraft({ ...draft, autoPrint: event.target.checked })} />
          Imprimir automáticamente al completar una venta
        </label>
        <label className="mt-3 flex items-center gap-3 text-sm font-bold text-stone-200">
          <input className="h-5 w-5 accent-emerald-500" type="checkbox" checked={draft.autoCut} onChange={(event) => setDraft({ ...draft, autoCut: event.target.checked })} />
          Cortar papel automáticamente
        </label>

        <details className="mt-4 text-sm text-stone-300">
          <summary className="cursor-pointer font-bold text-stone-400">Opciones avanzadas</summary>
          <label className="mt-3 grid gap-1 font-bold">
            Juego de caracteres
            <select className="rounded-xl border border-stone-600 bg-stone-950 px-3 py-2 outline-none focus:border-emerald-500" value={draft.codePage} onChange={(event) => setDraft({ ...draft, codePage: event.target.value as PrinterCodePage })}>
              <option value="CP858">CP858 (Epson y compatibles)</option>
              <option value="WPC1252">Windows-1252 (si las tildes salen mal)</option>
            </select>
            <span className="text-xs font-normal text-stone-500">Si en la prueba “ñ á é í ó ú” salen distintas, probá el otro juego.</span>
          </label>
        </details>

        {status.kind !== "idle" ? (
          <p
            className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-bold ${status.kind === "error" ? "border-red-500/60 bg-red-950/40 text-red-200" : status.kind === "ok" ? "border-emerald-500/60 bg-emerald-950/40 text-emerald-200" : "border-stone-600 text-stone-300"}`}
            role={status.kind === "error" ? "alert" : "status"} data-testid="printer-status"
          >
            {status.kind === "busy" ? status.label : status.message}
          </p>
        ) : null}

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" type="button" onClick={onClose}>Cancelar</button>
          <button className="rounded-xl bg-emerald-600 px-4 py-3 font-black hover:bg-emerald-500 disabled:opacity-50" type="button" disabled={busy || missing} onClick={() => void save()}>Guardar</button>
        </div>
      </section>
    </div>
  );
}
