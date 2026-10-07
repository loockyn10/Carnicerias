"use client";

import { stockUnitLabel } from "@carnicerias/business-logic";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createSignageDisplayAction, regenerateSignageTokenAction, saveSignageDisplayAction } from "../app/admin/products/signage/actions";
import {
  clampSlideSeconds, MAX_SIGNAGE_SLIDES, MAX_SLIDE_SECONDS, MIN_SLIDE_SECONDS, moveItem, UNAVAILABLE_LABELS, type EditorDisplay, type EditorSlide
} from "../lib/signage";
import { ProductPicker } from "./product-picker";
import { SignageLinkPanel } from "./signage-link-panel";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const primaryButton = "rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50";
const smallButton = "rounded-md border border-stone-300 px-2 py-1 text-sm font-bold disabled:opacity-30";

export interface BranchOption { id: string; name: string; active: boolean }

function BranchSelect({ branches, value, onChange, id }: { branches: BranchOption[]; value: string; onChange: (value: string) => void; id: string }) {
  return <select className={`${input} w-full`} id={id} onChange={(event) => { onChange(event.target.value); }} value={value}>
    <option value="">Sin sucursal (precio global)</option>
    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.active ? "" : " (inactiva)"}</option>)}
  </select>;
}

/** Alta de una pantalla: nombre + sucursal cuyo precio y promoción muestra. Al crearla muestra el enlace UNA vez. */
export function SignageCreateForm({ branches, firstScreen }: { branches: BranchOption[]; firstScreen: boolean }) {
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ displayId: string; token: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await createSignageDisplayAction({ name, branchId: branchId || null });
      if (result.error || !result.displayId || !result.token) { setError(result.error ?? "No se pudo crear la pantalla"); return; }
      setCreated({ displayId: result.displayId, token: result.token });
      setName("");
      router.refresh();
    });
  }

  return <div className="rounded-xl bg-white p-5 shadow-sm" data-testid="signage-create">
    <h2 className="text-lg font-black">{firstScreen ? "Crear la primera pantalla" : "Nueva pantalla"}</h2>
    <p className="mt-1 text-sm text-stone-600">Cada pantalla es un televisor con su propio enlace. La sucursal define qué precio y promoción muestra (los mismos que el POS de esa sucursal).</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-bold" htmlFor="signage-new-name">Nombre
        <input className={`${input} font-normal`} id="signage-new-name" maxLength={80} onChange={(event) => { setName(event.target.value); }} placeholder="TV Despensa Central" value={name} />
      </label>
      <label className="grid gap-1 text-sm font-bold" htmlFor="signage-new-branch">Sucursal
        <BranchSelect branches={branches} id="signage-new-branch" onChange={setBranchId} value={branchId} />
      </label>
    </div>
    <button className={`${primaryButton} mt-4`} disabled={pending || !name.trim()} onClick={submit} type="button">{pending ? "Creando…" : "Crear pantalla"}</button>
    {error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
    {created ? <>
      <SignageLinkPanel onDismiss={() => { setCreated(null); }} token={created.token} />
      <a className="mt-3 inline-block text-sm font-bold text-rose-800 hover:underline" href={`/admin/products/signage?display=${created.displayId}`}>Ir a configurar la pantalla →</a>
    </> : null}
  </div>;
}

/** Estado local de las filas del editor, separado de la vista para poder probar las operaciones sin React. */
export function addSlide(slides: readonly EditorSlide[], slide: EditorSlide): { slides: EditorSlide[]; error: string | null } {
  if (slides.some((existing) => existing.productId === slide.productId)) return { slides: [...slides], error: "Ese producto ya está en la presentación" };
  if (slides.length >= MAX_SIGNAGE_SLIDES) return { slides: [...slides], error: `Una pantalla admite hasta ${String(MAX_SIGNAGE_SLIDES)} ofertas` };
  return { slides: [...slides, slide], error: null };
}

export function SignageEditor({ display, branches }: { display: EditorDisplay; branches: BranchOption[] }) {
  const router = useRouter();
  const [name, setName] = useState(display.name);
  const [branchId, setBranchId] = useState(display.branchId ?? "");
  const [seconds, setSeconds] = useState(String(display.slideDurationSeconds));
  const [enabled, setEnabled] = useState(display.enabled);
  const [slides, setSlides] = useState<EditorSlide[]>(display.slides);
  // Tras publicar, el servidor devuelve los productos con sus precios y motivos actualizados: se re-sincronizan sin remontar el editor
  // (así el aviso «Publicado» no se pierde).
  const serverSlides = JSON.stringify(display.slides);
  const [syncedSlides, setSyncedSlides] = useState(serverSlides);
  if (syncedSlides !== serverSlides) {
    setSyncedSlides(serverSlides);
    setSlides(display.slides);
  }
  const [pickerKey, setPickerKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const secondsNumber = Number(seconds);
  const secondsValid = Number.isInteger(secondsNumber) && secondsNumber >= MIN_SLIDE_SECONDS && secondsNumber <= MAX_SLIDE_SECONDS;
  const blocked = slides.filter((slide) => slide.unavailable !== null).length;

  function save() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await saveSignageDisplayAction({
        displayId: display.id, name, branchId: branchId || null, slideDurationSeconds: clampSlideSeconds(secondsNumber), enabled,
        productIds: slides.map((slide) => slide.productId)
      });
      if (result.error) { setError(result.error); return; }
      setNotice("Publicado. El televisor toma los cambios solo, en menos de 30 segundos.");
      router.refresh();
    });
  }

  function regenerate() {
    if (!window.confirm("¿Regenerar el enlace? El enlace actual deja de funcionar y hay que cargar el nuevo en el televisor.")) return;
    setError(null);
    startTransition(async () => {
      const result = await regenerateSignageTokenAction(display.id);
      if (result.error || !result.token) { setError(result.error ?? "No se pudo regenerar el enlace"); return; }
      setFreshToken(result.token);
      router.refresh();
    });
  }

  return <section className="rounded-xl bg-white p-5 shadow-sm" data-testid="signage-editor">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-black">Pantalla: {display.name}</h2>
        <p className="mt-1 text-sm text-stone-600">Los precios y promociones se toman solos del sistema: acá sólo se eligen los productos.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <a className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-bold" data-testid="signage-open-preview" href={`/tv-preview/${display.id}`} rel="noopener" target="_blank">Abrir vista TV</a>
        <button className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-bold text-rose-800 disabled:opacity-50" disabled={pending} onClick={regenerate} type="button">Regenerar enlace</button>
      </div>
    </div>
    <p className="mt-3 text-sm text-stone-500" data-testid="signage-link-note">
      Enlace del televisor: <span className="font-mono">/tv/••••••••</span> — por seguridad sólo se muestra completo al crearlo o regenerarlo.
      {display.tokenRotatedAt ? ` Generado el ${new Date(display.tokenRotatedAt).toLocaleString("es-AR")}.` : ""}
    </p>
    {freshToken ? <SignageLinkPanel onDismiss={() => { setFreshToken(null); }} token={freshToken} /> : null}

    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="grid gap-1 text-sm font-bold sm:col-span-2" htmlFor="signage-name">Nombre
        <input className={`${input} font-normal`} id="signage-name" maxLength={80} onChange={(event) => { setName(event.target.value); }} value={name} />
      </label>
      <label className="grid gap-1 text-sm font-bold" htmlFor="signage-branch">Sucursal (precios y promoción)
        <BranchSelect branches={branches} id="signage-branch" onChange={setBranchId} value={branchId} />
      </label>
      <label className="grid gap-1 text-sm font-bold" htmlFor="signage-seconds">Duración por slide (segundos)
        <input aria-invalid={!secondsValid} className={`${input} font-normal`} id="signage-seconds" inputMode="numeric" max={MAX_SLIDE_SECONDS} min={MIN_SLIDE_SECONDS} onChange={(event) => { setSeconds(event.target.value); }} type="number" value={seconds} />
        <span className={`text-xs font-normal ${secondsValid ? "text-stone-500" : "text-red-700"}`}>Entre {MIN_SLIDE_SECONDS} y {MAX_SLIDE_SECONDS}</span>
      </label>
    </div>
    <label className="mt-3 flex items-center gap-2 text-sm font-bold">
      <input checked={enabled} onChange={(event) => { setEnabled(event.target.checked); }} type="checkbox" />
      Pantalla activa <span className="font-normal text-stone-500">(desactivada, el televisor muestra el cartel de espera)</span>
    </label>

    <h3 className="mt-6 text-base font-black">Ofertas publicadas ({slides.length})</h3>
    <div className="mt-2 max-w-xl">
      <ProductPicker
        branchId={branchId || null}
        key={pickerKey}
        name="signage_add_product"
        onChange={(product) => {
          if (!product) return;
          const outcome = addSlide(slides, { productId: product.id, name: product.name, sku: product.sku, unitType: product.unitType, summary: null, unavailable: null });
          setSlides(outcome.slides);
          setError(outcome.error);
          setNotice(null);
          setPickerKey((key) => key + 1);
        }}
        placeholder="Agregar producto: nombre, SKU o código de barras…"
      />
    </div>
    {branchId ? <p className="mt-1 text-xs text-stone-500">Sólo se ofrecen productos que vende esa sucursal.</p> : null}

    <ol className="mt-3 divide-y divide-stone-100 rounded-lg border border-stone-200" data-testid="signage-slides">
      {slides.map((slide, index) => <li className="flex flex-wrap items-center gap-3 px-3 py-2" key={slide.productId}>
        <span className="w-6 text-right text-sm font-black text-stone-400">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{slide.name}{slide.sku ? <span className="ml-2 text-xs font-normal text-stone-500">{slide.sku}</span> : null}<span className="ml-2 text-xs font-normal text-stone-500">{stockUnitLabel(slide.unitType)}</span></p>
          {slide.unavailable ? <p className="text-xs font-bold text-amber-700">{UNAVAILABLE_LABELS[slide.unavailable]}</p>
            : <p className="text-xs text-stone-500">{slide.summary ?? "El precio se toma del sistema al publicar"}</p>}
        </div>
        <div className="flex gap-1">
          <button aria-label={`Subir ${slide.name}`} className={smallButton} disabled={index === 0} onClick={() => { setSlides(moveItem(slides, index, -1)); setNotice(null); }} type="button">↑</button>
          <button aria-label={`Bajar ${slide.name}`} className={smallButton} disabled={index === slides.length - 1} onClick={() => { setSlides(moveItem(slides, index, 1)); setNotice(null); }} type="button">↓</button>
          <button aria-label={`Quitar ${slide.name}`} className={`${smallButton} text-red-700`} onClick={() => { setSlides(slides.filter((_, position) => position !== index)); setNotice(null); }} type="button">Quitar</button>
        </div>
      </li>)}
      {!slides.length ? <li className="px-3 py-4 text-sm text-stone-500">Todavía no hay ofertas: el televisor muestra «Próximamente nuevas ofertas».</li> : null}
    </ol>
    {blocked ? <p className="mt-2 text-sm text-amber-700">{blocked} {blocked === 1 ? "oferta no se muestra" : "ofertas no se muestran"} en el TV por el motivo indicado.</p> : null}

    <div className="mt-5 flex flex-wrap items-center gap-3">
      <button className={primaryButton} disabled={pending || !secondsValid || !name.trim()} onClick={save} type="button">{pending ? "Guardando…" : "Guardar y publicar"}</button>
      <span className="text-xs text-stone-500">«Abrir vista TV» muestra lo último que se publicó.</span>
    </div>
    {error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
    {notice ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{notice}</p> : null}
  </section>;
}
