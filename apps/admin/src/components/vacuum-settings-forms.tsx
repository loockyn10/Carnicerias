"use client";

import { useRouter } from "next/navigation";
import { useActionState, useMemo, useRef, useState, useTransition } from "react";

import { saveVacuumDefaultShelfLifeAction, saveVacuumEanSchemeAction, saveVacuumProductOverridesAction, saveVacuumSettingsAction, setVacuumProductEnabledAction, type VacuumFormState } from "../app/admin/vacuum/actions";
import { shelfLifeSummary, type VacuumConfigRow, type VacuumSettings } from "../lib/vacuum";
import { buildEan13, EAN_SCHEME_LABELS, EAN_SCHEMES, validateEanSchemeConfig, type EanScheme } from "../lib/vacuum-ean";
import { VACUUM_LABEL_DEFAULTS } from "../lib/vacuum-label-spec";
import { fieldInput, fieldLabel, FormModal, optionalHint } from "./form-modal";

function Feedback({ state }: { state: VacuumFormState }) {
  return <>
    {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{state.error}</p> : null}
    {state.successToken ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">Guardado.</p> : null}
  </>;
}

const mmText = (value: number | null) => (value === null ? "" : String(value).replace(".", ","));

/** Datos del establecimiento, textos de la etiqueta informativa y medidas del papel. Todo opcional y configurable: el sistema no afirma cumplimiento regulatorio. */
export function VacuumEstablishmentForm({ settings }: { settings: VacuumSettings }) {
  const [state, action, pending] = useActionState(saveVacuumSettingsAction, {} as VacuumFormState);
  return <form action={action} className="grid content-start gap-3 rounded-xl bg-white p-5 shadow-sm" data-testid="vacuum-establishment-form">
    <div><h2 className="text-lg font-black">Etiqueta informativa y papel</h2>
      <p className="mt-1 text-sm text-stone-600">Lo que cargues acá se imprime en la etiqueta informativa. Cargá sólo los datos y textos que tu establecimiento necesita: el sistema no agrega leyendas legales ni sanitarias por su cuenta.</p></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={fieldLabel}>Nombre comercial <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={settings.businessName ?? ""} maxLength={120} name="business_name" /></label>
      <label className={fieldLabel}>Domicilio <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={settings.address ?? ""} maxLength={240} name="address" /></label>
    </div>
    <label className={fieldLabel}>Información del establecimiento <span className={optionalHint}>opcional · se imprime tal cual</span><input className={fieldInput} defaultValue={settings.establishmentInfo ?? ""} maxLength={300} name="establishment_info" /></label>
    <label className={fieldLabel}>Texto de conservación por defecto <span className={optionalHint}>opcional · cada corte puede tener el suyo</span><textarea className={fieldInput} defaultValue={settings.defaultConservationText ?? ""} maxLength={600} name="default_conservation_text" rows={2} /></label>
    <label className={fieldLabel}>Otro texto <span className={optionalHint}>opcional · para lo que necesites imprimir más adelante</span><textarea className={fieldInput} defaultValue={settings.extraText ?? ""} maxLength={600} name="extra_text" rows={2} /></label>
    <fieldset className="grid gap-3 rounded-lg border border-stone-200 p-3 sm:grid-cols-3">
      <legend className="px-1 text-sm font-bold">Medidas de la etiqueta (mm)</legend>
      <label className={fieldLabel}>Ancho<input className={fieldInput} defaultValue={mmText(settings.labelWidthMm)} inputMode="decimal" name="label_width_mm" placeholder={String(VACUUM_LABEL_DEFAULTS.widthMm)} /></label>
      <label className={fieldLabel}>Alto informativa<input className={fieldInput} defaultValue={mmText(settings.infoHeightMm)} inputMode="decimal" name="info_height_mm" placeholder={String(VACUUM_LABEL_DEFAULTS.infoHeightMm)} /></label>
      <label className={fieldLabel}>Alto precio<input className={fieldInput} defaultValue={mmText(settings.priceHeightMm)} inputMode="decimal" name="price_height_mm" placeholder={String(VACUUM_LABEL_DEFAULTS.priceHeightMm)} /></label>
      <p className="text-xs text-stone-500 sm:col-span-3">Vacío = medida por defecto ({VACUUM_LABEL_DEFAULTS.widthMm} × {VACUUM_LABEL_DEFAULTS.infoHeightMm} mm). Para pasar a 55 × 50, poné 50 en el alto. Los paquetes ya envasados se reimprimen con las medidas que tenían.</p>
    </fieldset>
    <Feedback state={state} />
    <div className="flex justify-end"><button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : "Guardar"}</button></div>
  </form>;
}

const SAMPLE = { plu: "7", priceCents: 1_805_250n, weightGrams: 1245 };

/**
 * Esquema del EAN-13: prefijo + PLU + valor embebido (precio o peso) + dígito verificador. NO hay un formato por defecto: la caja del supermercado
 * interpreta el código con SU esquema y hay que configurarlo de acuerdo con él. Mientras no esté configurado no se pueden registrar paquetes.
 */
export function VacuumEanSchemeForm({ config }: { config: VacuumSettings["ean"] }) {
  const [state, action, pending] = useActionState(saveVacuumEanSchemeAction, {} as VacuumFormState);
  const [scheme, setScheme] = useState<EanScheme | "">(config?.scheme ?? "");
  const [prefix, setPrefix] = useState(config?.prefix ?? "");
  const [pluDigits, setPluDigits] = useState(String(config?.pluDigits ?? ""));
  const [valueDigits, setValueDigits] = useState(String(config?.valueDigits ?? ""));
  const [valueStep, setValueStep] = useState(String(config?.valueStep ?? 1));

  const preview = useMemo(() => {
    if (scheme === "") return null;
    const parsed = { prefix, pluDigits: Number.parseInt(pluDigits, 10), valueDigits: Number.parseInt(valueDigits, 10), valueStep: Number.parseInt(valueStep || "1", 10) };
    const problem = validateEanSchemeConfig(parsed);
    if (problem) return { problem, example: null };
    const built = buildEan13({ scheme, ...parsed }, SAMPLE);
    return { problem: null, example: built.ok ? built.ean13 : built.message };
  }, [scheme, prefix, pluDigits, valueDigits, valueStep]);
  const total = (prefix.length || 0) + (Number.parseInt(pluDigits, 10) || 0) + (Number.parseInt(valueDigits, 10) || 0);

  return <form action={action} className="grid content-start gap-3 rounded-xl bg-white p-5 shadow-sm" data-testid="vacuum-ean-form">
    <div><h2 className="text-lg font-black">Esquema del código EAN-13</h2>
      <p className="mt-1 text-sm text-stone-600">Cómo se arma el código de cada paquete para que lo lea la caja del supermercado. El esquema lo define el sistema que lo va a leer: confirmá con ellos el prefijo, los dígitos del PLU y si leen precio o peso.</p></div>
    {config ? null : <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="alert">Falta configurar el esquema: hasta entonces no se pueden registrar ni imprimir paquetes.</p>}
    <label className={fieldLabel}>Qué valor lleva el código
      <select className={fieldInput} name="scheme" onChange={(event) => { setScheme(event.target.value as EanScheme | ""); }} value={scheme}>
        <option value="">Sin configurar</option>
        {EAN_SCHEMES.map((key) => <option key={key} value={key}>{EAN_SCHEME_LABELS[key]}</option>)}
      </select>
    </label>
    {scheme !== "" ? <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={fieldLabel}>Prefijo interno<input className={fieldInput} inputMode="numeric" maxLength={6} name="prefix" onChange={(event) => { setPrefix(event.target.value); }} placeholder="2" value={prefix} /></label>
        <label className={fieldLabel}>Dígitos del PLU<input className={fieldInput} inputMode="numeric" name="plu_digits" onChange={(event) => { setPluDigits(event.target.value); }} placeholder="4" value={pluDigits} /></label>
        <label className={fieldLabel}>Dígitos del valor<input className={fieldInput} inputMode="numeric" name="value_digits" onChange={(event) => { setValueDigits(event.target.value); }} placeholder="7" value={valueDigits} /></label>
        <label className={fieldLabel}>Divisor del valor<input className={fieldInput} inputMode="numeric" name="value_step" onChange={(event) => { setValueStep(event.target.value); }} value={valueStep} />
          <span className={optionalHint}>{scheme === "PRICE_EMBEDDED" ? "1 = centavos · 100 = pesos enteros" : "1 = gramos · 10 = decagramos"}</span></label>
      </div>
      <p className="text-sm text-stone-600" data-testid="ean-digit-count">Prefijo + PLU + valor = <strong className={total === 12 ? "text-emerald-700" : "text-amber-700"}>{total} de 12</strong> dígitos (el 13.º es el dígito verificador).</p>
      {preview ? <p className="rounded-lg bg-stone-50 p-3 text-sm" data-testid="ean-example">
        {preview.problem ? <span className="text-amber-800">{preview.problem}</span> : <>Ejemplo con PLU 7, $18.052,50 y 1,245 kg: <strong className="font-mono">{preview.example}</strong></>}
      </p> : null}
    </> : null}
    <Feedback state={state} />
    <div className="flex justify-end"><button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : "Guardar esquema"}</button></div>
  </form>;
}

/** Vencimiento general de la organización: lo usan todos los cortes que no tengan uno propio. Nunca cambia el vencimiento de un paquete ya registrado. */
export function VacuumDefaultShelfLifeForm({ days }: { days: number }) {
  const [state, action, pending] = useActionState(saveVacuumDefaultShelfLifeAction, {} as VacuumFormState);
  return <form action={action} className="grid content-start gap-3 rounded-xl bg-white p-5 shadow-sm" data-testid="vacuum-default-shelf-life-form">
    <div><h2 className="text-lg font-black">Días de vencimiento predeterminados</h2>
      <p className="mt-1 text-sm text-stone-600">Se usa para todos los cortes que no tengan un vencimiento propio. Si lo cambiás, los paquetes ya envasados conservan el vencimiento con el que se registraron. Es un parámetro operativo tuyo, no una validación sanitaria de vida útil.</p></div>
    <label className={fieldLabel}>Días<input className={fieldInput} defaultValue={days} inputMode="numeric" key={days} name="default_shelf_life_days" /></label>
    <Feedback state={state} />
    <div className="flex justify-end"><button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : "Guardar"}</button></div>
  </form>;
}

/**
 * Habilitar / deshabilitar un corte en un solo clic, sin formularios. El PLU lo asigna el sistema al habilitar (y se conserva al deshabilitar).
 * Mientras la operación está en curso el botón queda bloqueado: los clics repetidos no mandan pedidos duplicados.
 */
export function VacuumCutToggle({ productId, enabled }: { productId: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const inFlight = useRef(false);
  const click = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const result = await setVacuumProductEnabledAction(productId, !enabled);
        if (result.ok) router.refresh(); else setError(result.error);
      } finally { inFlight.current = false; }
    });
  };
  return <span className="inline-flex flex-col items-end gap-1">
    <button
      aria-busy={pending}
      className={`inline-flex min-w-36 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-bold text-white disabled:opacity-60 ${enabled ? "bg-red-700 hover:bg-red-800" : "bg-emerald-700 hover:bg-emerald-800"}`}
      data-testid={enabled ? "vacuum-disable" : "vacuum-enable"}
      disabled={pending}
      onClick={click}
      type="button"
    >{pending ? "Guardando…" : enabled ? "✕ Deshabilitar" : "✓ Habilitar"}</button>
    {error ? <span className="max-w-56 text-right text-xs text-red-700" role="alert">{error}</span> : null}
  </span>;
}

/** Configuración individual de un corte: vencimiento general o propio y texto de conservación. El PLU no se edita acá. */
export function VacuumProductConfigModal({ row, defaultShelfLifeDays }: { row: VacuumConfigRow; defaultShelfLifeDays: number }) {
  const [mode, setMode] = useState<"general" | "custom">(row.customShelfLifeDays === null ? "general" : "custom");
  return <FormModal
    action={saveVacuumProductOverridesAction}
    description="Elegí si este corte usa el vencimiento general o uno propio. El PLU lo administra el sistema."
    submitLabel="Guardar"
    title={`Envasado — ${row.name}`}
    triggerLabel="⚙ Configurar"
  >
    <input name="product_id" type="hidden" value={row.productId} />
    <p className="rounded-lg bg-stone-50 p-3 text-sm" data-testid="effective-shelf-life">Vencimiento efectivo hoy: <strong>{shelfLifeSummary({ shelfLifeDays: mode === "custom" ? (Number.parseInt(row.customShelfLifeDays === null ? "" : String(row.customShelfLifeDays), 10) || defaultShelfLifeDays) : defaultShelfLifeDays, customShelfLifeDays: null }).text}</strong> · {row.customShelfLifeDays === null ? "General" : "Personalizado"} guardado{row.plu ? <> · PLU <span className="font-mono">{row.plu}</span></> : null}</p>
    <fieldset className="grid gap-2">
      <legend className="text-sm font-bold">Vencimiento</legend>
      <label className="flex items-center gap-2 text-sm"><input checked={mode === "general"} name="shelf_mode" onChange={() => { setMode("general"); }} type="radio" value="general" /> Usar el general ({defaultShelfLifeDays} días)</label>
      <label className="flex items-center gap-2 text-sm"><input checked={mode === "custom"} name="shelf_mode" onChange={() => { setMode("custom"); }} type="radio" value="custom" /> Personalizado</label>
      {mode === "custom" ? <label className={fieldLabel}>Días propios<input className={fieldInput} defaultValue={row.customShelfLifeDays ?? ""} inputMode="numeric" name="shelf_life_days" /></label> : null}
    </fieldset>
    <label className={fieldLabel}>Texto de conservación <span className={optionalHint}>opcional · si falta se usa el general</span><textarea className={fieldInput} defaultValue={row.conservationText ?? ""} maxLength={600} name="conservation_text" rows={3} /></label>
  </FormModal>;
}
