"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import { deleteSignageGroupAction, loadPromotionCatalogAction, saveSignageGroupAction } from "../app/admin/products/signage/actions";
import { moveItem } from "../lib/signage";
import {
  countWithoutPhoto, filterByStatus, groupItemNote, PROMOTION_STATUS_LABELS, statusCounts, validityText,
  type PromotionCatalog, type PromotionGroup, type PromotionOption, type PromotionStatus
} from "../lib/signage-promotions";
import { OverlayDialog } from "./overlay-dialog";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const primary = "rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white hover:bg-rose-900 disabled:opacity-50";
const link = "text-sm font-bold text-rose-800 hover:underline disabled:opacity-50";
const smallButton = "rounded-md border border-stone-300 px-2 py-1 text-sm font-bold disabled:opacity-30";

const STATUS_ORDER: PromotionStatus[] = ["ACTIVE", "UPCOMING", "EXPIRED"];
const STATUS_TAB_LABELS: Record<PromotionStatus, string> = { ACTIVE: "Activas", UPCOMING: "Próximas", EXPIRED: "Vencidas" };

/** Una promoción se puede elegir si no está vencida y su producto se puede mostrar (las próximas sí: empiezan a rotar solas el día que arrancan). */
export function isSelectable(option: PromotionOption): boolean {
  return option.status !== "EXPIRED" && option.unavailable === null;
}

function PhotoWarning({ hasPhoto }: { hasPhoto: boolean }) {
  return hasPhoto ? null : <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800" title="Se muestra igual, con un reemplazo de la foto">⚠ Sin foto</span>;
}

/** Lista de promociones con pestañas por vigencia (por defecto las activas) y casillas para elegir. */
export function PromotionChooser({ options, selected, onToggle, disabledIds = new Set<string>() }: {
  options: readonly PromotionOption[]; selected: ReadonlySet<string>; onToggle: (option: PromotionOption) => void; disabledIds?: ReadonlySet<string>;
}) {
  const [status, setStatus] = useState<PromotionStatus>("ACTIVE");
  const counts = statusCounts(options);
  const shown = filterByStatus(options, status);
  return <div>
    <div className="flex flex-wrap gap-2" role="tablist">
      {STATUS_ORDER.map((key) => <button aria-selected={status === key} className={`rounded-full px-3 py-1.5 text-sm font-bold ${status === key ? "bg-rose-800 text-white" : "border bg-white hover:border-rose-300"}`} key={key} onClick={() => setStatus(key)} role="tab" type="button">
        {STATUS_TAB_LABELS[key]} ({counts[key]})</button>)}
    </div>
    {status === "EXPIRED" ? <p className="mt-2 text-xs text-stone-500">Las promociones vencidas no se reproducen: se muestran sólo para consulta.</p> : null}
    <ul className="mt-2 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white" data-testid="promotion-chooser">
      {shown.map((option) => {
        const selectable = isSelectable(option) && !disabledIds.has(option.promotionId);
        const note = disabledIds.has(option.promotionId) ? "Ya está en la lista" : option.unavailable === "INACTIVE" ? "Producto inactivo" : option.unavailable === "NO_PRICE" ? "Sin precio vigente" : null;
        return <li className={`flex items-start gap-3 px-3 py-2 ${selectable ? "" : "opacity-60"}`} key={option.promotionId}>
          <input aria-label={`Elegir ${option.productName}`} checked={selected.has(option.promotionId)} className="mt-1" disabled={!selectable} onChange={() => onToggle(option)} type="checkbox" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">{option.productName}<PhotoWarning hasPhoto={option.hasPhoto} /></p>
            <p className="text-sm text-stone-700">{option.summary}</p>
            <p className="text-xs text-stone-500">{PROMOTION_STATUS_LABELS[option.status]} · {validityText(option)} · {option.branchName ?? "Todas las sucursales"}{note ? ` · ${note}` : ""}</p>
          </div>
        </li>;
      })}
      {!shown.length ? <li className="px-3 py-4 text-sm text-stone-500">{status === "ACTIVE" ? "No hay promociones activas para esta pantalla. Se cargan en Promociones." : "No hay promociones en esta pestaña."}</li> : null}
    </ul>
  </div>;
}

/**
 * «Elegir promociones» (D-084): las promociones ya cargadas en Promociones que le aplican a la pantalla (su sucursal, su vigencia). Se eligen una
 * por una o se guarda la selección como GRUPO para reutilizarla en otras pantallas. No se vuelve a escribir ningún nombre, precio ni foto.
 */
export function PromotionPickerModal({ branchId, displayName, alreadyAdded, onAdd, onClose, onGroupSaved }: {
  branchId: string | null; displayName: string; alreadyAdded: ReadonlySet<string>; onAdd: (options: PromotionOption[]) => void; onClose: () => void; onGroupSaved: () => void;
}) {
  const [catalog, setCatalog] = useState<PromotionCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [groupName, setGroupName] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const result = await loadPromotionCatalogAction(branchId, true);
      if (!result.ok) { setError(result.error); return; }
      setCatalog(result.catalog);
    });
  }, [branchId]);

  const byId = useMemo(() => new Map((catalog?.promotions ?? []).map((option) => [option.promotionId, option])), [catalog]);
  const chosen = selected.flatMap((id) => { const option = byId.get(id); return option ? [option] : []; });
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = (option: PromotionOption) => setSelected((current) => current.includes(option.promotionId) ? current.filter((id) => id !== option.promotionId) : [...current, option.promotionId]);
  const missingPhotos = countWithoutPhoto(chosen, selectedSet);

  const saveGroup = () => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await saveSignageGroupAction({ groupId: null, name: groupName, promotionIds: selected });
      if (result.error) { setError(result.error); return; }
      setNotice(`Grupo «${groupName.trim()}» guardado. Ya podés agregarlo a cualquier pantalla desde «Agregar grupo».`);
      setGroupName("");
      onGroupSaved();
    });
  };

  return <OverlayDialog onClose={onClose} subtitle={`Pantalla: ${displayName}`} title="Elegir promociones" wide>
    <div className="mt-4 space-y-4">
      <p className="text-sm text-stone-600">Son las promociones cargadas en Promociones que le aplican a esta pantalla. El precio y la foto se toman de ahí: si cambian, la TV muestra lo nuevo.</p>
      {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
      {notice ? <p className="rounded-lg bg-emerald-50 p-3 text-sm font-bold text-emerald-800" role="status">✓ {notice}</p> : null}
      {!catalog && !error ? <p className="text-sm text-stone-500" role="status">Cargando promociones…</p> : null}
      {catalog ? <PromotionChooser disabledIds={alreadyAdded} onToggle={toggle} options={catalog.promotions} selected={selectedSet} /> : null}
      {catalog ? <div className="space-y-3 rounded-xl bg-white p-4 shadow-sm">
        <p className="text-sm font-bold">{selected.length} {selected.length === 1 ? "promoción elegida" : "promociones elegidas"}</p>
        {missingPhotos > 0 ? <p className="text-xs font-bold text-amber-800">⚠ {missingPhotos} {missingPhotos === 1 ? "no tiene" : "no tienen"} foto: se reproduce igual con un reemplazo; conviene cargarla en Piezas.</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <button className={primary} disabled={pending || !chosen.length} onClick={() => { onAdd(chosen); onClose(); }} type="button">Agregar a la pantalla</button>
          <span className="text-sm text-stone-500">o</span>
          <input aria-label="Nombre del grupo" className={`${input} min-w-52 flex-1`} maxLength={80} onChange={(event) => setGroupName(event.target.value)} placeholder="Nombre del grupo (ej. Ofertas fin de semana)" value={groupName} />
          <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold disabled:opacity-50" disabled={pending || !chosen.length || !groupName.trim()} onClick={saveGroup} type="button">Guardar como grupo</button>
        </div>
      </div> : null}
    </div>
  </OverlayDialog>;
}

type GroupMode = { kind: "list" } | { kind: "edit"; groupId: string | null };

/**
 * «Grupos de promociones»: crear, renombrar, editar (agregar, quitar y ordenar promociones) y eliminar. Un grupo es sólo una selección ordenada:
 * no copia precios ni fotos (la TV toma siempre la promoción vigente) y no se puede eliminar mientras alguna pantalla lo use.
 */
export function PromotionGroupsModal({ initialGroupId = null, onClose, onChanged }: { initialGroupId?: string | null; onClose: () => void; onChanged: () => void }) {
  const [catalog, setCatalog] = useState<PromotionCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<GroupMode>(initialGroupId ? { kind: "edit", groupId: initialGroupId } : { kind: "list" });
  const [name, setName] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const reload = useCallback(async () => {
    const result = await loadPromotionCatalogAction(null, false);
    if (!result.ok) { setError(result.error); return null; }
    setError(null);
    setCatalog(result.catalog);
    return result.catalog;
  }, []);

  useEffect(() => {
    startTransition(async () => {
      const loaded = await reload();
      const group = initialGroupId ? loaded?.groups.find((candidate) => candidate.id === initialGroupId) : undefined;
      if (group) { setName(group.name); setIds(group.promotionIds); }
    });
  }, [reload, initialGroupId]);

  const byId = useMemo(() => new Map((catalog?.promotions ?? []).map((option) => [option.promotionId, option])), [catalog]);
  const idSet = useMemo(() => new Set(ids), [ids]);

  const startEdit = (group: PromotionGroup | null) => {
    setNotice(null);
    setError(null);
    setName(group?.name ?? "");
    setIds(group?.promotionIds ?? []);
    setMode({ kind: "edit", groupId: group?.id ?? null });
  };
  const toggle = (option: PromotionOption) => setIds((current) => current.includes(option.promotionId) ? current.filter((id) => id !== option.promotionId) : [...current, option.promotionId]);

  const save = () => {
    if (mode.kind !== "edit") return;
    setError(null);
    startTransition(async () => {
      const result = await saveSignageGroupAction({ groupId: mode.groupId, name, promotionIds: ids });
      if (result.error) { setError(result.error); return; }
      setNotice(`Grupo «${name.trim()}» guardado.`);
      setMode({ kind: "list" });
      await reload();
      onChanged();
    });
  };

  const remove = (group: PromotionGroup) => {
    if (!window.confirm(`¿Eliminar el grupo «${group.name}»? Las promociones no se borran.`)) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await deleteSignageGroupAction(group.id);
      if (result.error) { setError(result.error); return; }
      setNotice(`Grupo «${group.name}» eliminado.`);
      await reload();
      onChanged();
    });
  };

  return <OverlayDialog onClose={onClose} subtitle="Selecciones reutilizables para las pantallas" title="Grupos de promociones" wide>
    <div className="mt-4 space-y-4">
      {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
      {notice ? <p className="rounded-lg bg-emerald-50 p-3 text-sm font-bold text-emerald-800" role="status">✓ {notice}</p> : null}
      {!catalog && !error ? <p className="text-sm text-stone-500" role="status">Cargando…</p> : null}
      {catalog && mode.kind === "list" ? <>
        <ul className="divide-y divide-stone-100 rounded-xl bg-white shadow-sm" data-testid="signage-groups">
          {catalog.groups.map((group) => <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={group.id}>
            <div className="min-w-0"><p className="font-bold">{group.name}</p>
              <p className="text-xs text-stone-500">{group.promotionIds.length} {group.promotionIds.length === 1 ? "promoción" : "promociones"} · {group.usedByDisplays === 0 ? "Sin usar en pantallas" : `En ${String(group.usedByDisplays)} ${group.usedByDisplays === 1 ? "pantalla" : "pantallas"}`}</p></div>
            <div className="flex gap-4"><button className={link} disabled={pending} onClick={() => startEdit(group)} type="button">Editar</button>
              <button className={`${link} text-red-700`} disabled={pending} onClick={() => remove(group)} type="button">Eliminar</button></div>
          </li>)}
          {!catalog.groups.length ? <li className="px-4 py-4 text-sm text-stone-500">Todavía no hay grupos. Creá uno con las promociones que querés reproducir juntas.</li> : null}
        </ul>
        <button className={primary} disabled={pending} onClick={() => startEdit(null)} type="button">+ Nuevo grupo</button>
      </> : null}
      {catalog && mode.kind === "edit" ? <div className="space-y-4">
        <label className="grid gap-1 text-sm font-bold">Nombre del grupo
          <input className={`${input} font-normal`} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Ofertas fin de semana" value={name} /></label>
        <div>
          <p className="text-sm font-bold">En este grupo ({ids.length}) — rotan en este orden</p>
          <ol className="mt-2 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white" data-testid="group-items">
            {ids.map((id, index) => {
              const option = byId.get(id);
              const note = groupItemNote(option);
              return <li className="flex flex-wrap items-center gap-3 px-3 py-2" key={id}>
                <span className="w-6 text-right text-sm font-black text-stone-400">{index + 1}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{option?.productName ?? "Promoción"}{option ? <PhotoWarning hasPhoto={option.hasPhoto} /> : null}</p>
                  <p className="text-xs text-stone-500">{option?.summary ?? ""}</p>{note ? <p className="text-xs font-bold text-amber-700">{note}</p> : null}</div>
                <div className="flex gap-1">
                  <button aria-label={`Subir ${option?.productName ?? "promoción"}`} className={smallButton} disabled={index === 0} onClick={() => setIds(moveItem(ids, index, -1))} type="button">↑</button>
                  <button aria-label={`Bajar ${option?.productName ?? "promoción"}`} className={smallButton} disabled={index === ids.length - 1} onClick={() => setIds(moveItem(ids, index, 1))} type="button">↓</button>
                  <button aria-label={`Quitar ${option?.productName ?? "promoción"}`} className={`${smallButton} text-red-700`} onClick={() => setIds(ids.filter((_, position) => position !== index))} type="button">Quitar</button>
                </div>
              </li>;
            })}
            {!ids.length ? <li className="px-3 py-4 text-sm text-stone-500">Elegí al menos una promoción de la lista de abajo.</li> : null}
          </ol>
        </div>
        <div>
          <p className="mb-2 text-sm font-bold">Agregar promociones</p>
          <PromotionChooser onToggle={toggle} options={catalog.promotions} selected={idSet} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button className={primary} disabled={pending || !name.trim() || !ids.length} onClick={save} type="button">{pending ? "Guardando…" : "Guardar grupo"}</button>
          <button className={link} disabled={pending} onClick={() => { setMode({ kind: "list" }); setError(null); }} type="button">Volver a la lista</button>
        </div>
      </div> : null}
    </div>
  </OverlayDialog>;
}
