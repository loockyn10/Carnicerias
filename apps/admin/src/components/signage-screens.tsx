"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createSignageDisplayAction, regenerateSignageTokenAction, saveSignageSourceAction } from "../app/admin/products/signage/actions";
import type { FolderSummary } from "../lib/artwork-folders";
import { clampSlideSeconds, MAX_SLIDE_SECONDS, MIN_SLIDE_SECONDS } from "../lib/signage";
import { displayNotes, playableLabel, sourceLabel, type DisplayOverview } from "../lib/signage-overview";
import { OverlayDialog } from "./overlay-dialog";
import { SignageLinkPanel } from "./signage-link-panel";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const primaryButton = "rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white hover:bg-rose-900 disabled:opacity-50";
const secondaryButton = "rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-bold text-stone-700 hover:bg-stone-50 disabled:opacity-50";

export interface BranchOption { id: string; name: string; active: boolean }

function BranchSelect({ branches, value, onChange, id }: { branches: BranchOption[]; value: string; onChange: (value: string) => void; id: string }) {
  return <select className={`${input} w-full`} id={id} onChange={(event) => { onChange(event.target.value); }} value={value}>
    <option value="">Sin sucursal (precio global)</option>
    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.active ? "" : " (inactiva)"}</option>)}
  </select>;
}

/** Alta de una pantalla: nombre + sucursal. Por defecto reproduce todas las promociones activas que le aplican (nada que cargar a mano). */
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
    <p className="mt-1 text-sm text-stone-600">Cada pantalla es un televisor con su propio enlace. Sola reproduce todas las promociones activas que le aplican a su sucursal: no hay nada que cargar.</p>
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
    {created ? <SignageLinkPanel onDismiss={() => { setCreated(null); }} token={created.token} /> : null}
  </div>;
}

/**
 * Configurar una pantalla (D-086): nombre, sucursal, duración, activa y la FUENTE de contenido. Por defecto, «todas las promociones
 * activas»; o una carpeta. Nada de cargar slides: el precio, la vigencia y la foto salen siempre de Promociones y de Productos.
 */
function ConfigureDialog({ display, folders, branches, onClose }: { display: DisplayOverview; folders: FolderSummary[]; branches: BranchOption[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(display.name);
  const [branchId, setBranchId] = useState(display.branchId ?? "");
  const [seconds, setSeconds] = useState(String(display.slideDurationSeconds));
  const [enabled, setEnabled] = useState(display.enabled);
  const [source, setSource] = useState<"ALL_PROMOTIONS" | "FOLDER">(display.contentSource === "FOLDER" ? "FOLDER" : "ALL_PROMOTIONS");
  const [folderId, setFolderId] = useState(display.folderId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const secondsNumber = Number(seconds);
  const secondsValid = Number.isInteger(secondsNumber) && secondsNumber >= MIN_SLIDE_SECONDS && secondsNumber <= MAX_SLIDE_SECONDS;
  const folderValid = source === "ALL_PROMOTIONS" || folderId !== "";
  const valid = name.trim() !== "" && secondsValid && folderValid;

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveSignageSourceAction({
        displayId: display.id, name, branchId: branchId || null, slideDurationSeconds: clampSlideSeconds(secondsNumber), enabled,
        source, folderId: source === "FOLDER" ? folderId : null
      });
      if (result.error) { setError(result.error); return; }
      router.refresh();
      onClose();
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

  return <OverlayDialog onClose={onClose} subtitle="Qué reproduce este televisor" tall title={`Configurar ${display.name}`}>
    <div className="mt-4 space-y-5" data-testid="signage-configure">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-bold sm:col-span-2" htmlFor="signage-name">Nombre
          <input className={`${input} font-normal`} id="signage-name" maxLength={80} onChange={(event) => { setName(event.target.value); }} value={name} />
        </label>
        <label className="grid gap-1 text-sm font-bold" htmlFor="signage-branch">Sucursal (precios y promociones)
          <BranchSelect branches={branches} id="signage-branch" onChange={setBranchId} value={branchId} />
        </label>
        <label className="grid gap-1 text-sm font-bold" htmlFor="signage-seconds">Duración por slide (segundos)
          <input aria-invalid={!secondsValid} className={`${input} font-normal`} id="signage-seconds" inputMode="numeric" max={MAX_SLIDE_SECONDS} min={MIN_SLIDE_SECONDS} onChange={(event) => { setSeconds(event.target.value); }} type="number" value={seconds} />
          <span className={`text-xs font-normal ${secondsValid ? "text-stone-500" : "text-red-700"}`}>Entre {MIN_SLIDE_SECONDS} y {MAX_SLIDE_SECONDS}</span>
        </label>
      </div>

      <fieldset className="grid gap-2 rounded-xl bg-white p-4 shadow-sm">
        <legend className="px-1 text-sm font-black">Fuente de contenido</legend>
        <label className="flex items-start gap-3 text-sm">
          <input checked={source === "ALL_PROMOTIONS"} className="mt-1" name="signage-source" onChange={() => { setSource("ALL_PROMOTIONS"); }} type="radio" value="ALL_PROMOTIONS" />
          <span><strong>Todas las promociones activas</strong><span className="block text-stone-600">Reproduce solo las promociones vigentes que le aplican a esta sucursal. Una promoción nueva aparece sola; una vencida o desactivada deja de verse.</span></span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input checked={source === "FOLDER"} className="mt-1" name="signage-source" onChange={() => { setSource("FOLDER"); }} type="radio" value="FOLDER" />
          <span className="min-w-0 flex-1"><strong>Usar una carpeta</strong><span className="block text-stone-600">Reproduce lo vigente de una carpeta de Gráficas (la misma selección que usás para Instagram).</span>
            {source === "FOLDER" ? <select aria-label="Carpeta" className={`${input} mt-2 w-full`} data-testid="signage-folder" onChange={(event) => { setFolderId(event.target.value); }} value={folderId}>
              <option value="">Elegí una carpeta…</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name} ({folder.items.length})</option>)}
            </select> : null}
            {source === "FOLDER" && !folders.length ? <span className="mt-1 block text-xs font-bold text-amber-800">Todavía no hay carpetas: creá una en Cartelería → Gráficas.</span> : null}
          </span>
        </label>
        {display.contentSource === "MANUAL" ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Esta pantalla usa una lista armada a mano ({display.legacyEntries}). Al guardar con cualquiera de estas dos fuentes, esa lista se descarta.</p> : null}
      </fieldset>

      <label className="flex items-center gap-2 text-sm font-bold">
        <input checked={enabled} onChange={(event) => { setEnabled(event.target.checked); }} type="checkbox" />
        Pantalla activa <span className="font-normal text-stone-500">(desactivada, el televisor muestra el cartel de espera)</span>
      </label>

      <div className="rounded-xl border border-stone-200 bg-white p-4 text-sm">
        <p className="font-bold">Enlace del televisor</p>
        <p className="mt-1 text-stone-600" data-testid="signage-link-note">
          <span className="font-mono">/tv/••••••••</span> — por seguridad sólo se muestra completo al crearlo o regenerarlo.
          {display.tokenRotatedAt ? ` Generado el ${new Date(display.tokenRotatedAt).toLocaleString("es-AR")}.` : ""}
        </p>
        <button className={`${secondaryButton} mt-3 text-rose-800`} disabled={pending} onClick={regenerate} type="button">Regenerar enlace</button>
        {freshToken ? <SignageLinkPanel onDismiss={() => { setFreshToken(null); }} token={freshToken} /> : null}
      </div>

      {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button className={primaryButton} data-testid="signage-save" disabled={pending || !valid} onClick={save} type="button">{pending ? "Guardando…" : "Guardar"}</button>
        <button className="text-sm font-bold text-stone-600 hover:underline" disabled={pending} onClick={onClose} type="button">Cancelar</button>
        <span className="text-xs text-stone-500">El televisor toma los cambios solo, en menos de 30 segundos.</span>
      </div>
    </div>
  </OverlayDialog>;
}

function DisplayCard({ display, onConfigure }: { display: DisplayOverview; onConfigure: () => void }) {
  const notes = displayNotes(display);
  return <li className="grid content-start gap-2 rounded-xl bg-white p-4 shadow-sm" data-testid="signage-card">
    <div className="flex items-start justify-between gap-2">
      <h3 className="text-lg font-black uppercase leading-tight">{display.name}</h3>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${display.enabled ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600"}`}>{display.enabled ? "Activa" : "Desactivada"}</span>
    </div>
    <p className="text-sm text-stone-500">{display.branchName ?? "Sin sucursal (precio global)"}</p>
    <p className="text-base font-black" data-testid="signage-playable">{playableLabel(display)}</p>
    <p className="text-sm text-stone-600"><span className="font-bold">Fuente:</span> {sourceLabel(display)}</p>
    {notes.length ? <ul className="grid gap-1 text-xs font-bold text-amber-800">{notes.map((note) => <li key={note.text}>{note.text}</li>)}</ul> : null}
    <div className="mt-2 flex flex-wrap gap-2">
      <button className={primaryButton} data-testid="signage-configure-open" onClick={onConfigure} type="button">Configurar</button>
      <a className={secondaryButton} data-testid="signage-open-preview" href={`/tv-preview/${display.id}`} rel="noopener" target="_blank">Abrir vista TV</a>
    </div>
  </li>;
}

/**
 * Pantallas de TV (D-086): una tarjeta por televisor con su fuente, cuántas promociones reproduce hoy y qué mirar. No hay slides que armar: las
 * promociones activas aplicables a la sucursal aparecen solas, o las de una carpeta.
 */
export function SignageScreens({ displays, folders, branches }: { displays: DisplayOverview[]; folders: FolderSummary[]; branches: BranchOption[] }) {
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(displays.length === 0);
  const target = displays.find((display) => display.id === configuring) ?? null;
  return <div className="mt-5 grid gap-6" data-testid="signage-screens">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-stone-600">Un televisor abre su enlace y rota las promociones vigentes con el precio de hoy. Se actualiza solo.</p>
      {displays.length ? <button className={secondaryButton} onClick={() => { setShowCreate((value) => !value); }} type="button">{showCreate ? "Cerrar" : "+ Nueva pantalla"}</button> : null}
    </div>
    {displays.length ? <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {displays.map((display) => <DisplayCard display={display} key={display.id} onConfigure={() => { setConfiguring(display.id); }} />)}
    </ul> : null}
    {showCreate ? <SignageCreateForm branches={branches} firstScreen={displays.length === 0} /> : null}
    {target ? <ConfigureDialog branches={branches} display={target} folders={folders} key={target.id} onClose={() => { setConfiguring(null); }} /> : null}
  </div>;
}
