"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { packageCommercialTotalCents, formatIsoDate, moneyText } from "../lib/vacuum";
import { categoryOptions, FAVORITES_FILTER, formatKg, visibleProducts, type StationProduct, type StationSummary } from "../lib/vacuum-station/data";
import { describeStation, type StationAction, type StationTone } from "../lib/vacuum-station/describe";
import type { StationState } from "../lib/vacuum-station/machine";
import { VacuumStationSettings } from "./vacuum-station-settings";
import { useVacuumStation, type UseVacuumStationProps, type VacuumStationModel } from "./use-vacuum-station";

const TONE_CLASSES: Record<StationTone, string> = {
  ok: "border-emerald-300 bg-emerald-50 text-emerald-900",
  working: "border-amber-300 bg-amber-50 text-amber-900",
  warn: "border-amber-400 bg-amber-100 text-amber-950",
  wait: "border-violet-300 bg-violet-50 text-violet-900",
  error: "border-red-300 bg-red-50 text-red-900"
};

const DOT_CLASSES: Record<StationTone, string> = {
  ok: "bg-emerald-500", working: "bg-amber-500 animate-pulse", warn: "bg-amber-500", wait: "bg-violet-500", error: "bg-red-500"
};

const button = "rounded-xl px-4 py-3 text-base font-black disabled:opacity-50";
const secondary = `${button} border border-stone-300 bg-white hover:bg-stone-50`;

/**
 * Estación de producción de Envasados: una sola pantalla para trabajar horas seguidas. Se elige el corte una vez y después sólo se apoya y se retira:
 * la estación detecta el peso estable, registra el paquete (el mismo `create_vacuum_package` del formulario manual), imprime las dos etiquetas y espera
 * el retiro antes de aceptar el siguiente. La decisión vive en `lib/vacuum-station` (máquina de estados probada); esta pantalla sólo la muestra.
 */
export function VacuumStation(props: UseVacuumStationProps) {
  const model = useVacuumStation(props);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [reprintMessage, setReprintMessage] = useState<string | null>(null);
  const { state } = model.snapshot;

  const view = describeStation(state, { productName: model.product?.name ?? null, readinessProblem: model.readiness.problems[0] ?? null });
  const visible = useMemo(() => visibleProducts(model.products, { query, category }, model.config.favorites), [model.products, query, category, model.config.favorites]);
  const categories = useMemo(() => categoryOptions(model.products), [model.products]);

  const grams = state.grams;
  const net = grams === null ? null : Math.max(0, grams - model.config.tuning.tareGrams);
  const pricePerKg = model.product?.pricePerKgCents ?? null;
  const preview = pricePerKg !== null && net !== null && net >= model.config.tuning.minWeightGrams && model.readiness.ready
    ? packageCommercialTotalCents(pricePerKg, net, props.settings.ean) : null;
  const stabilityProgress = state.anchor !== null && (state.status === "STABILIZING" || state.status === "DETECTING")
    ? Math.min(1, Math.max(0, (Math.max(state.lastSampleAtMs ?? 0, state.anchor.sinceMs) - state.anchor.sinceMs) / model.config.tuning.stableMs)) : 0;
  const scaleOk = model.link.status === "CONNECTED";
  const paused = state.status === "PAUSED";

  async function reprint(kind: "BOTH" | "INFO" | "PRICE" | null) {
    setReprintMessage("Enviando a imprimir…");
    const result = await model.reprint(kind);
    setReprintMessage(result.ok ? "Etiquetas enviadas a imprimir." : result.error);
  }

  function run(action: StationAction) {
    if (action === "RESUME") model.resume();
    else if (action === "RETRY") model.retry();
    else model.skipPrint();
  }

  return <div className="grid gap-5" data-testid="vacuum-station">
    {model.support !== null && !model.support.supported ? <p className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm font-bold text-red-900" role="alert" data-testid="serial-unsupported">{model.support.reason}</p> : null}
    {!props.settings.ean ? <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900" role="alert">Falta configurar el esquema EAN-13: sin él no se pueden registrar paquetes. <Link className="font-bold underline" href="/admin/vacuum/settings">Configurar ahora</Link></p> : null}
    {!model.autoPrintOn ? <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900" data-testid="autoprint-off">La impresión automática está apagada: los paquetes se registran pero las etiquetas no salen solas (usá «Reimprimir»). Para activarla hacé la prueba de impresión en <button className="font-bold underline" onClick={() => { setSettingsOpen(true); }} type="button">Dispositivos</button>.</p> : null}
    {model.printNotice.dialogShown ? <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900" role="alert" data-testid="print-dialog-warning">El navegador abrió el diálogo de impresión: la impresión NO es automática. Para imprimir sin diálogo hay que abrir Chrome/Edge en modo de impresión silenciosa (ver «Dispositivos»).</p> : null}
    {!model.configSaved ? <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">El navegador no dejó guardar la configuración de la estación: se pierde al cerrar esta pestaña.</p> : null}

    <section aria-live="polite" className={`grid gap-4 rounded-2xl border-2 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center ${TONE_CLASSES[view.tone]}`} data-station-status={state.status} data-testid="station-status">
      <div className="flex items-center gap-4">
        <span aria-hidden className={`h-5 w-5 shrink-0 rounded-full ${DOT_CLASSES[view.tone]}`} />
        <div><p className="text-3xl font-black leading-tight" data-testid="station-title">{view.title}</p>{view.detail ? <p className="mt-0.5 text-sm" data-testid="station-detail">{view.detail}</p> : null}</div>
      </div>
      {view.actions.length > 0 ? <div className="flex flex-wrap gap-2">
        {view.actions.map((action) => <button className={`${button} ${action === "SKIP_PRINT" ? "border border-red-300 bg-white text-red-900" : "bg-red-800 text-white hover:bg-red-900"}`} key={action} onClick={() => { run(action); }} type="button">
          {action === "RESUME" ? "Reanudar" : action === "RETRY" ? (state.pauseReason === "PRINT_FAILED" ? "Reintentar impresión" : "Reintentar registro") : "Continuar sin imprimir"}
        </button>)}
      </div> : null}
    </section>

    <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="grid content-start gap-5">
        <section className="rounded-2xl bg-stone-900 p-5 text-white" data-testid="weight-panel">
          <p className="text-xs font-bold uppercase tracking-wider text-stone-400">Peso de la balanza</p>
          <p className={`mt-1 text-7xl font-black tabular-nums ${scaleOk ? "" : "text-stone-500"}`} data-testid="weight-readout">{grams !== null && grams >= 0 ? formatKg(grams) : "— kg"}</p>
          <div aria-hidden className="mt-3 h-2 overflow-hidden rounded-full bg-stone-700"><div className="h-full rounded-full bg-emerald-400 transition-[width] duration-150" style={{ width: `${String(Math.round(stabilityProgress * 100))}%` }} /></div>
          <p className="mt-2 text-sm text-stone-300">{weightCaption(state, scaleOk, model.config.tuning.tareGrams, net)}</p>
          {preview !== null ? <p className="mt-3 text-4xl font-black text-emerald-300" data-testid="price-preview">{moneyText(preview)}</p> : null}
        </section>

        <section className="rounded-2xl bg-white p-5 shadow-sm" data-testid="selected-product">
          <p className="text-xs font-bold uppercase tracking-wider text-stone-500">Producto seleccionado</p>
          {model.product ? <>
            <p className="mt-1 text-2xl font-black" data-testid="selected-cut">{model.product.name}</p>
            <p className="text-lg font-bold text-rose-800" data-testid="price-per-kg">{model.product.pricePerKgCents !== null ? `${moneyText(model.product.pricePerKgCents)} / kg` : "sin precio vigente"}</p>
            <p className="text-xs text-stone-500">{model.product.plu ? `PLU ${model.product.plu}` : "sin PLU"}{model.product.categoryName ? ` · ${model.product.categoryName}` : ""}</p>
            <ProductionParams model={model} product={model.product} />
          </> : <p className="mt-1 text-lg text-stone-500">Todavía no elegiste ningún corte.</p>}
        </section>

        <LastPackage model={model} onReprint={(kind) => { void reprint(kind); }} message={reprintMessage} />
        <Summary summary={model.summary} />
      </div>

      <div className="grid content-start gap-5">
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2" data-testid="station-controls">
            <button className={`${button} ${paused ? "bg-emerald-700 text-white hover:bg-emerald-800" : "bg-stone-900 text-white hover:bg-stone-800"}`} data-testid="pause-toggle" disabled={paused && state.pauseReason === "SCALE_DISCONNECTED"} onClick={paused ? model.resume : model.pause} type="button">{paused ? "▶ Reanudar" : "⏸ Pausar"}</button>
            {scaleOk
              ? <button className={secondary} onClick={() => { void model.disconnectScale(); }} type="button">Desconectar balanza</button>
              : <button className={`${button} bg-rose-800 text-white hover:bg-rose-900`} data-testid="connect-scale" onClick={() => { void model.connectScale(); }} type="button">Conectar balanza</button>}
            <button className={secondary} onClick={() => { void model.printTest(model.config.print.kind).then(() => { setSettingsOpen(true); }); }} type="button">Imprimir prueba</button>
            <button className={secondary} disabled={model.snapshot.lastPackage === null} onClick={() => { void reprint(null); }} type="button">Reimprimir último</button>
            <button className={`${secondary} ml-auto`} onClick={() => { setSettingsOpen(true); }} type="button">⚙ Dispositivos</button>
          </div>
          <ul className="mt-3 flex flex-wrap gap-2 text-xs font-bold" data-testid="station-indicators">
            <Chip ok={scaleOk} label={scaleOk ? "Balanza conectada" : model.link.status === "CONNECTING" ? "Conectando balanza…" : "Balanza desconectada"} />
            <Chip ok={state.online} label={state.online ? "Servidor conectado" : "Sin conexión"} />
            <Chip ok={model.autoPrintOn} label={model.autoPrintOn ? "Impresión automática" : "Impresión manual"} />
          </ul>
          {model.link.message && !scaleOk ? <p className="mt-2 text-xs text-red-700" role="status">{model.link.message}</p> : null}
        </section>

        <section className="rounded-2xl bg-white p-4 shadow-sm" data-testid="product-picker">
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Buscar corte" autoComplete="off" className="min-w-0 flex-1 rounded-xl border border-stone-300 px-4 py-3 text-base" onChange={(event) => { setQuery(event.target.value); }} placeholder="Buscar por nombre, SKU o PLU…" value={query} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2" data-testid="category-filters" role="group" aria-label="Categorías">
            <FilterChip active={category === null} label="Todos" onClick={() => { setCategory(null); }} />
            <FilterChip active={category === FAVORITES_FILTER} label="★ Favoritos" onClick={() => { setCategory(FAVORITES_FILTER); }} />
            {categories.map((entry) => <FilterChip active={category === entry.id} key={entry.id} label={`${entry.name} (${String(entry.count)})`} onClick={() => { setCategory(entry.id); }} />)}
          </div>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" data-testid="cut-buttons">
            {visible.map((entry) => <ProductButton favorite={model.config.favorites.includes(entry.productId)} key={entry.productId} onFavorite={() => { model.toggleFavorite(entry.productId); }} onSelect={() => { model.selectProduct(entry.productId); }} product={entry} selected={entry.productId === model.product?.productId} />)}
          </ul>
          {visible.length === 0 ? <p className="mt-4 rounded-xl bg-stone-50 p-6 text-center text-sm text-stone-500">{model.products.length === 0 ? "No hay cortes habilitados para envasar. " : "Ningún corte coincide. "}<Link className="font-bold text-rose-800 underline" href="/admin/vacuum/settings">Habilitar cortes</Link></p> : null}
        </section>
      </div>
    </div>

    {settingsOpen ? <VacuumStationSettings branches={props.branches} model={model} onClose={() => { setSettingsOpen(false); }} /> : null}
  </div>;
}

function weightCaption(state: StationState, scaleOk: boolean, tare: number, net: number | null): string {
  if (!scaleOk) return "Sin lectura: conectá la balanza.";
  const base = state.status === "WAITING_REMOVAL" ? "Retirar paquete" : state.status === "WAITING_PACKAGE" ? "Esperando paquete" : state.status === "REGISTERING" ? "Peso estable · registrando" : state.status === "PRINTING" ? "Imprimiendo" : state.moving ? "Peso inestable" : state.status === "STABILIZING" ? "Estabilizando" : state.status === "DETECTING" ? "Paquete detectado" : "Pausado";
  return tare > 0 && net !== null ? `${base} · neto ${formatKg(net)} (tara ${formatKg(tare)})` : base;
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return <li className={`rounded-full px-3 py-1 ${ok ? "bg-emerald-100 text-emerald-900" : "bg-red-100 text-red-900"}`}>{ok ? "●" : "○"} {label}</li>;
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button aria-pressed={active} className={`rounded-full border px-4 py-2 text-sm font-bold ${active ? "border-rose-800 bg-rose-800 text-white" : "border-stone-300 bg-white hover:bg-stone-50"}`} onClick={onClick} type="button">{label}</button>;
}

function ProductButton({ product, selected, favorite, onSelect, onFavorite }: { product: StationProduct; selected: boolean; favorite: boolean; onSelect: () => void; onFavorite: () => void }) {
  const warning = product.pricePerKgCents === null ? "sin precio" : product.shelfLifeDays === null ? "sin vida útil" : null;
  return <li className="relative">
    <button aria-pressed={selected} className={`flex min-h-24 w-full flex-col justify-between rounded-2xl border-2 p-4 text-left ${selected ? "border-rose-800 bg-rose-800 text-white shadow-lg" : "border-stone-200 bg-white hover:border-rose-400"}`} data-selected={selected ? "true" : "false"} data-testid="cut-button" onClick={onSelect} type="button">
      <span className="pr-8 text-lg font-black leading-tight">{product.name}</span>
      <span className={`text-sm font-bold ${selected ? "text-rose-100" : "text-stone-600"}`}>{product.pricePerKgCents !== null ? `${moneyText(product.pricePerKgCents)}/kg` : "—"}{warning ? <span className={`ml-2 text-xs ${selected ? "text-amber-200" : "text-amber-700"}`}>⚠ {warning}</span> : null}</span>
    </button>
    <button aria-label={favorite ? `Quitar ${product.name} de favoritos` : `Marcar ${product.name} como favorito`} aria-pressed={favorite} className={`absolute right-2 top-2 rounded-lg px-2 py-1 text-xl leading-none ${favorite ? "text-amber-400" : selected ? "text-rose-200" : "text-stone-300 hover:text-amber-400"}`} onClick={onFavorite} type="button">★</button>
  </li>;
}

function ProductionParams({ model, product }: { model: VacuumStationModel; product: StationProduct }) {
  const packedOn = model.params.packedOn ?? model.today;
  return <div className="mt-4 grid gap-3 border-t border-stone-200 pt-4 text-sm" data-testid="production-params">
    <label className="grid gap-1 font-bold">Elaboración
      <span className="flex items-center gap-2">
        <input className="rounded-lg border border-stone-300 px-3 py-2 font-normal" onChange={(event) => { model.setPackedOn(event.target.value === "" ? null : event.target.value); }} type="date" value={packedOn} />
        {model.params.packedOn !== null ? <button className="text-xs font-bold text-rose-800 underline" onClick={() => { model.setPackedOn(null); }} type="button">usar hoy</button> : <span className="text-xs font-normal text-stone-500">hoy (automática)</span>}
      </span>
    </label>
    {product.shelfLifeDays !== null
      ? <p>Vence: <strong data-testid="expiry-line">{model.readiness.expiresOn ? formatIsoDate(model.readiness.expiresOn) : "—"}</strong> <span className="text-xs text-stone-500">({String(product.shelfLifeDays)} días de vida útil configurada)</span></p>
      : <label className="grid gap-1 font-bold">Vencimiento <span className="text-xs font-normal text-amber-700">Este corte no tiene vida útil configurada: cargalo a mano.</span>
        <input className="rounded-lg border border-amber-400 px-3 py-2 font-normal" data-testid="manual-expiry" onChange={(event) => { model.setExpiryFor(product.productId, event.target.value); }} type="date" value={model.params.expiryByProduct[product.productId] ?? ""} />
      </label>}
    <p className="text-xs text-stone-500">Lote: automático (sucursal, día y número) · Sucursal: <strong>{model.branchName}</strong></p>
  </div>;
}

function LastPackage({ model, onReprint, message }: { model: VacuumStationModel; onReprint: (kind: "BOTH" | "INFO" | "PRICE" | null) => void; message: string | null }) {
  const last = model.snapshot.lastPackage;
  const printed = model.snapshot.lastPrinted;
  const failed = model.snapshot.state.pauseReason === "PRINT_FAILED";
  return <section className="rounded-2xl bg-white p-5 shadow-sm" data-testid="last-package">
    <p className="text-xs font-bold uppercase tracking-wider text-stone-500">Último paquete</p>
    {last ? <>
      <p className="mt-1 text-xl font-black">{last.payload.productName}</p>
      <p className="text-lg"><strong>{formatKg(last.payload.weightGrams)}</strong> · <strong className="text-rose-800">{moneyText(last.payload.totalCents)}</strong></p>
      <p className="text-xs text-stone-500">{new Date(last.payload.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: model.timezone })} · lote {last.payload.lot}</p>
      <p className="mt-2 flex flex-wrap gap-2 text-xs font-bold"><span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-900">✓ Registrado</span>
        <span className={`rounded-full px-3 py-1 ${failed ? "bg-red-100 text-red-900" : printed ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{failed ? "✕ Impresión fallida" : printed ? "✓ Etiquetas enviadas" : "Etiquetas sin imprimir"}</span></p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="rounded-lg bg-stone-900 px-3 py-2 text-sm font-bold text-white" onClick={() => { onReprint(null); }} type="button">Reimprimir</button>
        <button className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-bold" onClick={() => { onReprint("INFO"); }} type="button">Sólo informativa</button>
        <button className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-bold" onClick={() => { onReprint("PRICE"); }} type="button">Sólo precio</button>
      </div>
      {message ? <p className="mt-2 text-xs text-stone-600" role="status">{message}</p> : null}
    </> : <p className="mt-1 text-stone-500">Todavía no se registró ningún paquete en esta sesión.</p>}
  </section>;
}

function Summary({ summary }: { summary: StationSummary }) {
  return <section className="rounded-2xl bg-white p-5 shadow-sm" data-testid="station-summary">
    <p className="text-xs font-bold uppercase tracking-wider text-stone-500">Producción de hoy</p>
    <div className="mt-2 grid grid-cols-2 gap-3">
      <div><p className="text-4xl font-black tabular-nums" data-testid="summary-packages">{summary.packages}</p><p className="text-xs text-stone-500">paquetes registrados</p></div>
      <div><p className="text-4xl font-black tabular-nums" data-testid="summary-kg">{formatKg(summary.grams).replace(" kg", "")}</p><p className="text-xs text-stone-500">kilogramos envasados</p></div>
    </div>
    <p className="mt-3 text-xs text-stone-500">Último corte: <strong>{summary.lastProductName ?? "—"}</strong></p>
  </section>;
}
