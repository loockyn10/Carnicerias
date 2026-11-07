"use client";

import { SCALE_PROTOCOL_LABELS, SCALE_PROTOCOLS, SERIAL_BAUD_RATES, type ScaleProtocol } from "@carnicerias/business-logic";
import { useState } from "react";

import { LABEL_ROTATIONS, normalizeTuning, STATION_TUNING_LIMITS, type LabelRotation, type StationPrintKind } from "../lib/vacuum-station/config";
import type { StationTuning } from "../lib/vacuum-station/machine";
import type { VacuumStationModel } from "./use-vacuum-station";

const field = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const label = "grid gap-1 text-sm font-bold";

/**
 * Configuración de dispositivos de ESTA estación (balanza, estabilidad, impresión). Se guarda en este navegador, separada de la configuración comercial
 * de Envasados (esquema EAN, medidas de etiqueta, cortes). La impresión automática sólo se puede activar después de una prueba aprobada.
 */
export function VacuumStationSettings({ model, branches, onClose }: { model: VacuumStationModel; branches: { id: string; name: string }[]; onClose: () => void }) {
  const { config, updateConfig } = model;
  const [testBusy, setTestBusy] = useState(false);

  return <div aria-labelledby="station-settings-title" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/50 p-4" role="dialog">
    <div className="grid w-full max-w-3xl gap-6 rounded-2xl bg-white p-6 shadow-2xl" data-testid="station-settings">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-2xl font-black" id="station-settings-title">Dispositivos de la estación</h2>
        <button aria-label="Cerrar" className="rounded-lg px-3 py-1 text-2xl leading-none hover:bg-stone-100" onClick={onClose} type="button">×</button>
      </div>
      <p className="-mt-3 text-sm text-stone-600">Estos ajustes valen sólo para esta computadora y quedan guardados en este navegador. Los precios, los vencimientos, el código EAN-13 y las medidas de las etiquetas se configuran en Envasados → Configuración.</p>

      <section className="grid gap-3" data-testid="settings-production">
        <h3 className="text-lg font-black">Sucursal</h3>
        <label className={label}>Los paquetes se registran en
          <select className={`${field} font-normal`} onChange={(event) => { model.setBranch(event.target.value); }} value={model.branchId}>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </label>
      </section>

      <section className="grid gap-3" data-testid="settings-scale">
        <h3 className="text-lg font-black">Balanza</h3>
        {model.support !== null && !model.support.supported ? <p className="rounded-lg bg-red-50 p-3 text-sm font-bold text-red-900">{model.support.reason}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          {model.link.status === "CONNECTED"
            ? <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold" onClick={() => { void model.disconnectScale(); }} type="button">Desconectar</button>
            : <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={!model.support?.supported} onClick={() => { void model.connectScale(); }} type="button">Elegir puerto y conectar</button>}
          <span className="text-sm" data-testid="scale-status">{model.link.status === "CONNECTED" ? "Conectada" : model.link.status === "CONNECTING" ? "Conectando…" : model.link.status === "ERROR" ? "Error de conexión" : "Desconectada"}</span>
          {config.scale.port ? <span className="text-xs text-stone-500">Puerto recordado: USB {config.scale.port.usbVendorId.toString(16)}:{config.scale.port.usbProductId.toString(16)}</span> : null}
        </div>
        {model.link.message ? <p className="text-xs text-red-700">{model.link.message}</p> : null}
        {model.link.lastFrameError ? <p className="text-xs text-stone-500">Última trama descartada: {model.link.lastFrameError}</p> : null}
        <p className="text-xs text-stone-500">El navegador siempre pide elegir el puerto COM la primera vez. Después, la estación vuelve a conectarse sola con el puerto autorizado si el navegador lo permite; si no, usá «Elegir puerto y conectar».</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className={`${label} sm:col-span-2`}>Protocolo
            <select className={`${field} font-normal`} onChange={(event) => { updateConfig((current) => ({ ...current, scale: { ...current.scale, protocol: event.target.value as ScaleProtocol } })); }} value={config.scale.protocol}>
              {SCALE_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{SCALE_PROTOCOL_LABELS[protocol]}</option>)}
            </select>
          </label>
          <label className={label}>Velocidad (baudios)
            <select className={`${field} font-normal`} onChange={(event) => { updateConfig((current) => ({ ...current, scale: { ...current.scale, params: { ...current.scale.params, baudRate: Number(event.target.value) } } })); }} value={config.scale.params.baudRate}>
              {SERIAL_BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
            </select>
          </label>
          <label className={label}>Bits de datos
            <select className={`${field} font-normal`} onChange={(event) => { updateConfig((current) => ({ ...current, scale: { ...current.scale, params: { ...current.scale.params, dataBits: event.target.value === "7" ? 7 : 8 } } })); }} value={config.scale.params.dataBits}>
              <option value={8}>8</option><option value={7}>7</option>
            </select>
          </label>
          <label className={label}>Paridad
            <select className={`${field} font-normal`} onChange={(event) => { updateConfig((current) => ({ ...current, scale: { ...current.scale, params: { ...current.scale.params, parity: event.target.value === "even" || event.target.value === "odd" ? event.target.value : "none" } } })); }} value={config.scale.params.parity}>
              <option value="none">Ninguna</option><option value="even">Par</option><option value="odd">Impar</option>
            </select>
          </label>
          <label className={label}>Bits de parada
            <select className={`${field} font-normal`} onChange={(event) => { updateConfig((current) => ({ ...current, scale: { ...current.scale, params: { ...current.scale.params, stopBits: event.target.value === "1" ? 1 : 2 } } })); }} value={config.scale.params.stopBits}>
              <option value={2}>2</option><option value={1}>1</option>
            </select>
          </label>
        </div>
        <p className="text-xs text-stone-500">KRETZ Novel Eco 2 (el modelo del POS): 9600 baudios, 8 bits, sin paridad, 2 bits de parada. Cambiar estos valores requiere volver a conectar.</p>
        <label className="flex items-center gap-2 text-sm"><input checked={config.scale.autoReconnect} onChange={(event) => { updateConfig((current) => ({ ...current, scale: { ...current.scale, autoReconnect: event.target.checked } })); }} type="checkbox" /> Reconectar sola cuando se corte el cable o se apague la balanza</label>
      </section>

      <section className="grid gap-3" data-testid="settings-tuning">
        <h3 className="text-lg font-black">Estabilidad del peso</h3>
        <p className="text-xs text-stone-500">Si la balanza informa estabilidad, manda esa señal; si no, se usan lecturas seguidas dentro de la tolerancia durante el tiempo indicado.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(STATION_TUNING_LIMITS) as (keyof StationTuning)[]).map((key) => {
            const limits = STATION_TUNING_LIMITS[key];
            return <label className={label} key={key}>{limits.label} <span className="text-xs font-normal text-stone-500">({String(limits.min)}–{String(limits.max)} {limits.unit})</span>
              <input className={`${field} font-normal`} data-testid={`tuning-${key}`} inputMode="numeric" max={limits.max} min={limits.min} onChange={(event) => { updateConfig((current) => ({ ...current, tuning: normalizeTuning({ ...current.tuning, [key]: event.target.value }) })); }} type="number" value={config.tuning[key]} />
            </label>;
          })}
        </div>
      </section>

      <section className="grid gap-3" data-testid="settings-print">
        <h3 className="text-lg font-black">Impresión de etiquetas</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>Etiquetas que se imprimen por paquete
            <select className={`${field} font-normal`} onChange={(event) => { updateConfig((current) => ({ ...current, print: { ...current.print, kind: event.target.value as StationPrintKind } })); }} value={config.print.kind}>
              <option value="BOTH">Ambas (informativa y precio)</option><option value="INFO">Sólo informativa</option><option value="PRICE">Sólo precio</option>
            </select>
          </label>
          <label className={label}>Giro del contenido
            <select className={`${field} font-normal`} data-testid="rotation" onChange={(event) => { model.changeRotation(Number(event.target.value) as LabelRotation); }} value={config.print.rotation}>
              {LABEL_ROTATIONS.map((rotation) => <option key={rotation} value={rotation}>{rotation}°{rotation === 0 ? " (sin girar)" : ""}</option>)}
            </select>
          </label>
        </div>
        <p className="text-xs text-stone-500">Medidas actuales de la etiqueta (se cambian en Envasados → Configuración): {model.dims.widthMm} × {model.dims.infoHeightMm} mm informativa · {model.dims.widthMm} × {model.dims.priceHeightMm} mm precio. Cambiar el giro obliga a repetir la prueba.</p>

        <div className="grid gap-3 rounded-xl border border-stone-200 bg-stone-50 p-4">
          <p className="text-sm font-bold">Prueba de impresión <span className="font-normal text-stone-500">(no registra ningún paquete)</span></p>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" data-testid="print-test" disabled={testBusy} onClick={() => { setTestBusy(true); void model.printTest(config.print.kind).finally(() => { setTestBusy(false); }); }} type="button">{testBusy ? "Enviando…" : "Imprimir etiqueta de prueba"}</button>
            {model.testOutcome?.ok ? <button className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white" data-testid="approve-test" onClick={model.approveTest} type="button">La etiqueta salió bien</button> : null}
          </div>
          {model.testOutcome ? <p className={`text-sm ${model.testOutcome.ok ? "text-stone-700" : "font-bold text-red-700"}`} role="status">{model.testOutcome.ok
            ? "Prueba enviada al navegador. Mirá el papel: el borde tiene que verse completo, la flecha hacia ARRIBA, la regla de 10 mm tiene que medir 10 mm y el papel no tiene que avanzar de más. Si todo está bien, confirmá."
            : model.testOutcome.error}</p> : null}
          {model.testOutcome?.dialogShown ? <p className="text-sm font-bold text-amber-800">El navegador abrió el diálogo de impresión: no es una impresión silenciosa.</p> : null}
          <p className="text-sm" data-testid="print-test-status">{model.printTestCurrent && model.config.print.testPassedAt ? `Última prueba aprobada: ${new Date(model.config.print.testPassedAt).toLocaleString("es-AR")}` : "Todavía no hay una prueba aprobada para estas medidas y este giro."}</p>
        </div>

        <label className="flex items-start gap-2 text-sm"><input checked={model.autoPrintOn} data-testid="auto-print" disabled={config.print.testPassedSignature === null} onChange={(event) => { model.changeAutoPrint(event.target.checked); }} type="checkbox" />
          <span><strong>Imprimir las etiquetas automáticamente al registrar cada paquete.</strong><br /><span className="text-xs text-stone-500">Se habilita sólo después de aprobar la prueba de impresión. Si cambiás las medidas o el giro, hay que repetirla.</span></span></label>

        <details className="rounded-xl border border-stone-200 p-4 text-sm">
          <summary className="cursor-pointer font-bold">Cómo imprimir sin que aparezca el diálogo de Windows</summary>
          <div className="mt-3 grid gap-2 text-stone-700">
            <p>Una página web no puede imprimir en silencio por sí sola: el navegador siempre muestra el diálogo, salvo que se lo abra en <strong>modo de impresión silenciosa</strong>. Para la computadora de producción:</p>
            <ol className="list-decimal pl-5">
              <li>En Windows, dejá la impresora térmica como <strong>impresora predeterminada</strong> y su papel configurado con el tamaño exacto de la etiqueta ({model.dims.widthMm} × {model.dims.infoHeightMm} mm).</li>
              <li>Creá un acceso directo de Chrome (o Edge) y agregá al final del destino, después de <code>chrome.exe&quot;</code>: <code className="break-all">--kiosk-printing --app=https://TU-DOMINIO/admin/vacuum/station</code></li>
              <li>Abrí la estación siempre con ese acceso directo. Con esa opción el navegador manda el trabajo directo a la impresora predeterminada, sin diálogo.</li>
              <li>Hacé la prueba de impresión y confirmá que salió bien. Recién ahí se habilita la impresión automática.</li>
            </ol>
            <p className="text-xs text-stone-500">Limitaciones: el navegador no informa si la etiqueta salió físicamente (sólo que el trabajo se envió) ni se entera de falta de papel; por eso existe el botón «Reimprimir». Elegir otra impresora o ajustar el papel sigue requiriendo el diálogo de Windows (abrir Chrome sin esa opción).</p>
          </div>
        </details>
      </section>

      {model.simulator !== null || model.simulatorAllowed ? <SimulatorPanel model={model} /> : null}

      <div className="flex justify-end"><button className="rounded-xl bg-stone-900 px-6 py-3 text-base font-black text-white" onClick={onClose} type="button">Listo</button></div>
    </div>
  </div>;
}

/** Controles del simulador de balanza: SÓLO desarrollo/pruebas (el servidor decide `simulatorAllowed`; en producción normal este panel no existe). */
function SimulatorPanel({ model }: { model: VacuumStationModel }) {
  const sim = model.simulator;
  const [grams, setGrams] = useState("825");
  return <section className="grid gap-3 rounded-xl border-2 border-dashed border-amber-400 bg-amber-50 p-4" data-testid="settings-simulator">
    <h3 className="text-lg font-black text-amber-900">Simulador de balanza (sólo desarrollo)</h3>
    {sim === null
      ? <button className="w-fit rounded-lg bg-amber-600 px-4 py-2 text-sm font-bold text-white" onClick={() => { void model.enableSimulator(); }} type="button">Usar balanza simulada</button>
      : <div className="grid gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm font-bold">Peso (g)<input className={`${field} w-28 font-normal`} inputMode="numeric" onChange={(event) => { setGrams(event.target.value); }} value={grams} /></label>
          <button className="rounded-lg bg-stone-900 px-3 py-2 text-sm font-bold text-white" onClick={() => { sim.wobble(450); window.setTimeout(() => { sim.wobble(Number(grams) * 0.9); }, 600); window.setTimeout(() => { sim.place(Number(grams)); }, 1_200); }} type="button">Apoyar paquete (con inestabilidad)</button>
          <button className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold" onClick={() => { sim.place(Number(grams)); }} type="button">Apoyar directo</button>
          <button className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold" onClick={() => { sim.remove(); }} type="button">Retirar</button>
          <button className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-bold text-red-800" onClick={() => { sim.dropConnection(); }} type="button">Cortar cable</button>
          <button className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold" onClick={() => { sim.connect(); }} type="button">Reconectar</button>
        </div>
        <button className="w-fit text-xs font-bold text-amber-900 underline" onClick={() => { void model.disableSimulator(); }} type="button">Dejar de usar el simulador (recarga la página)</button>
      </div>}
  </section>;
}
