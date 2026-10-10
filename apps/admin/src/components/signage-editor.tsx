"use client";

import { stockUnitLabel } from "@carnicerias/business-logic";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createSignageDisplayAction, regenerateSignageTokenAction, saveSignageDisplayAction } from "../app/admin/products/signage/actions";
import {
  clampSlideSeconds, EDITOR_UNAVAILABLE_LABELS, MAX_SLIDE_SECONDS, MIN_SLIDE_SECONDS, moveItem, type EditorDisplay, type EditorEntry
} from "../lib/signage";
import { addEntry, addPromotions, entriesToInput, entryFromGroup, entryFromProduct, entryKey, summarizeEntries } from "../lib/signage-entries";
import type { PromotionCatalog } from "../lib/signage-promotions";
import { ProductPicker } from "./product-picker";
import { SignageLinkPanel } from "./signage-link-panel";
import { PromotionGroupsModal, PromotionPickerModal } from "./signage-promotions";

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

const KIND_LABELS: Record<EditorEntry["kind"], string> = { PRODUCT: "Producto", PROMOTION: "Promoción", GROUP: "Grupo" };

function EntryRow({ entry, index, total, onMove, onRemove, onEditGroup }: {
  entry: EditorEntry; index: number; total: number; onMove: (delta: -1 | 1) => void; onRemove: () => void; onEditGroup: () => void;
}) {
  const reason = entry.unavailable;
  return <li className="flex flex-wrap items-start gap-3 px-3 py-2" data-kind={entry.kind}>
    <span className="w-6 pt-0.5 text-right text-sm font-black text-stone-400">{index + 1}</span>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-bold">
        <span className="mr-2 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-bold text-stone-600">{KIND_LABELS[entry.kind]}</span>{entry.name}
        {entry.sku ? <span className="ml-2 text-xs font-normal text-stone-500">{entry.sku}</span> : null}
        {entry.unitType ? <span className="ml-2 text-xs font-normal text-stone-500">{stockUnitLabel(entry.unitType)}</span> : null}
        {entry.kind === "PROMOTION" && !entry.hasPhoto && !reason ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">⚠ Sin foto</span> : null}
      </p>
      {entry.kind === "GROUP" ? <>
        <p className="text-xs text-stone-500">{entry.children.length} {entry.children.length === 1 ? "promoción" : "promociones"} del grupo: rotan en este orden. El precio y la vigencia se toman de cada promoción.</p>
        <ul className="mt-1 space-y-0.5 border-l-2 border-stone-200 pl-3" data-testid="group-children">
          {entry.children.map((child) => <li className="text-xs" key={child.promotionId}>
            <span className="font-bold">{child.name}</span>{" "}
            {child.unavailable ? <span className="font-bold text-amber-700">· {EDITOR_UNAVAILABLE_LABELS[child.unavailable]}</span>
              : <span className="text-stone-500">· {child.summary ?? "El precio se toma del sistema al publicar"}</span>}
            {!child.hasPhoto && !child.unavailable ? <span className="ml-1 font-bold text-amber-800">⚠ Sin foto</span> : null}
          </li>)}
          {!entry.children.length ? <li className="text-xs text-stone-500">El grupo no tiene promociones que esta pantalla pueda mostrar.</li> : null}
        </ul>
        <button className="mt-1 text-xs font-bold text-rose-800 hover:underline" onClick={onEditGroup} type="button">Editar grupo</button>
      </> : reason ? <p className="text-xs font-bold text-amber-700">{EDITOR_UNAVAILABLE_LABELS[reason]}</p>
        : <p className="text-xs text-stone-500">{entry.summary ?? "El precio se toma del sistema al publicar"}</p>}
    </div>
    <div className="flex gap-1">
      <button aria-label={`Subir ${entry.name}`} className={smallButton} disabled={index === 0} onClick={() => onMove(-1)} type="button">↑</button>
      <button aria-label={`Bajar ${entry.name}`} className={smallButton} disabled={index === total - 1} onClick={() => onMove(1)} type="button">↓</button>
      <button aria-label={`Quitar ${entry.name}`} className={`${smallButton} text-red-700`} onClick={onRemove} type="button">Quitar</button>
    </div>
  </li>;
}

export function SignageEditor({ display, branches, catalog = { promotions: [], groups: [] } }: { display: EditorDisplay; branches: BranchOption[]; catalog?: PromotionCatalog }) {
  const router = useRouter();
  const [name, setName] = useState(display.name);
  const [branchId, setBranchId] = useState(display.branchId ?? "");
  const [seconds, setSeconds] = useState(String(display.slideDurationSeconds));
  const [enabled, setEnabled] = useState(display.enabled);
  const [entries, setEntries] = useState<EditorEntry[]>(display.entries);
  // Tras publicar, el servidor devuelve las entradas con sus precios y motivos actualizados: se re-sincronizan sin remontar el editor
  // (así el aviso «Publicado» no se pierde).
  const serverEntries = JSON.stringify(display.entries);
  const [syncedEntries, setSyncedEntries] = useState(serverEntries);
  if (syncedEntries !== serverEntries) {
    setSyncedEntries(serverEntries);
    setEntries(display.entries);
  }
  const [pickerKey, setPickerKey] = useState(0);
  const [promotionPicker, setPromotionPicker] = useState(false);
  const [groupsModal, setGroupsModal] = useState<{ groupId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const secondsNumber = Number(seconds);
  const secondsValid = Number.isInteger(secondsNumber) && secondsNumber >= MIN_SLIDE_SECONDS && secondsNumber <= MAX_SLIDE_SECONDS;
  const { blocked, withoutPhoto } = summarizeEntries(entries);
  const present = new Set(entries.map(entryKey));
  const addedPromotionIds = new Set(entries.filter((entry) => entry.kind === "PROMOTION").map((entry) => entry.id));
  const groupsAvailable = catalog.groups.filter((group) => !present.has(entryKey({ kind: "GROUP", id: group.id })));

  function save() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await saveSignageDisplayAction({
        displayId: display.id, name, branchId: branchId || null, slideDurationSeconds: clampSlideSeconds(secondsNumber), enabled, entries: entriesToInput(entries)
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

  const remove = (index: number) => { setEntries(entries.filter((_, position) => position !== index)); setNotice(null); };

  return <section className="rounded-xl bg-white p-5 shadow-sm" data-testid="signage-editor">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-black">Pantalla: {display.name}</h2>
        <p className="mt-1 text-sm text-stone-600">Los precios y promociones se toman solos del sistema: acá sólo se eligen productos, promociones y grupos.</p>
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

    <h3 className="mt-6 text-base font-black">Ofertas publicadas ({entries.length})</h3>
    <div className="mt-2 grid max-w-3xl gap-2">
      <ProductPicker
        branchId={branchId || null}
        key={pickerKey}
        name="signage_add_product"
        onChange={(product) => {
          if (!product) return;
          const outcome = addEntry(entries, entryFromProduct(product));
          setEntries(outcome.entries);
          setError(outcome.error);
          setNotice(null);
          setPickerKey((key) => key + 1);
        }}
        placeholder="Agregar producto: nombre, SKU o código de barras…"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-bold text-rose-800" data-testid="signage-add-promotions" onClick={() => setPromotionPicker(true)} type="button">+ Agregar promociones</button>
        <label className="flex items-center gap-2 text-sm font-bold">
          <span className="sr-only">Agregar grupo</span>
          <select aria-label="Agregar grupo" className={input} data-testid="signage-add-group" onChange={(event) => {
            const group = catalog.groups.find((candidate) => candidate.id === event.target.value);
            if (!group) return;
            const outcome = addEntry(entries, entryFromGroup(group, catalog));
            setEntries(outcome.entries);
            setError(outcome.error);
            setNotice(null);
          }} value="">
            <option value="">Agregar grupo…</option>
            {groupsAvailable.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.promotionIds.length})</option>)}
          </select>
        </label>
        <button className="text-sm font-bold text-rose-800 hover:underline" onClick={() => setGroupsModal({ groupId: null })} type="button">Administrar grupos</button>
      </div>
    </div>
    {branchId ? <p className="mt-1 text-xs text-stone-500">Sólo se ofrecen productos y promociones que aplican a esa sucursal.</p> : <p className="mt-1 text-xs text-stone-500">Sin sucursal se ofrecen las promociones de todas las sucursales y se usa el precio global.</p>}

    <ol className="mt-3 divide-y divide-stone-100 rounded-lg border border-stone-200" data-testid="signage-slides">
      {entries.map((entry, index) => <EntryRow
        entry={entry} index={index} key={entryKey(entry)} onEditGroup={() => setGroupsModal({ groupId: entry.id })}
        onMove={(delta) => { setEntries(moveItem(entries, index, delta)); setNotice(null); }} onRemove={() => remove(index)} total={entries.length}
      />)}
      {!entries.length ? <li className="px-3 py-4 text-sm text-stone-500">Todavía no hay ofertas: el televisor muestra «Próximamente nuevas ofertas».</li> : null}
    </ol>
    {blocked ? <p className="mt-2 text-sm text-amber-700">{blocked} {blocked === 1 ? "oferta no se muestra" : "ofertas no se muestran"} en el TV por el motivo indicado.</p> : null}
    {withoutPhoto ? <p className="mt-1 text-sm text-amber-800" data-testid="signage-without-photo">⚠ {withoutPhoto} {withoutPhoto === 1 ? "promoción no tiene" : "promociones no tienen"} foto: se reproduce igual, con un reemplazo de la foto.</p> : null}

    <div className="mt-5 flex flex-wrap items-center gap-3">
      <button className={primaryButton} disabled={pending || !secondsValid || !name.trim()} onClick={save} type="button">{pending ? "Guardando…" : "Guardar y publicar"}</button>
      <span className="text-xs text-stone-500">«Abrir vista TV» muestra lo último que se publicó.</span>
    </div>
    {error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
    {notice ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{notice}</p> : null}
    {promotionPicker ? <PromotionPickerModal
      alreadyAdded={addedPromotionIds} branchId={branchId || null} displayName={name}
      onAdd={(options) => {
        const outcome = addPromotions(entries, options);
        setEntries(outcome.entries);
        setError(outcome.error);
        setNotice(null);
      }}
      onClose={() => setPromotionPicker(false)} onGroupSaved={() => router.refresh()}
    /> : null}
    {groupsModal ? <PromotionGroupsModal initialGroupId={groupsModal.groupId} onChanged={() => router.refresh()} onClose={() => setGroupsModal(null)} /> : null}
  </section>;
}
