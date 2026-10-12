"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { folderFormatsLabel, folderItemsLabel, type FolderSummary } from "../lib/artwork-folders";
import { ArtworkFolderEditor } from "./artwork-folder-editor";
import { ArtworkFolderPanel } from "./artwork-folder-panel";
import { ArtworkWorkspace, type ArtworkBranchOption } from "./artwork-workspace";

const primary = "rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white hover:bg-rose-900 disabled:opacity-50";

/**
 * Cartelería → Gráficas (D-086): arriba las CARPETAS (cada una es una selección de promociones con sus formatos; «Abrir» muestra el estado de
 * hoy y «Generar todo actualizado» arma todas las gráficas de una vez); abajo, la pieza individual de siempre (D-074 / D-075) para un
 * producto o un collage sueltos. No hay una pantalla nueva: es la misma pestaña.
 */
export function ArtworkHome({ folders, branches, defaultBranchId, initialFolderId = null }: {
  folders: FolderSummary[];
  branches: ArtworkBranchOption[];
  defaultBranchId: string;
  initialFolderId?: string | null;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(initialFolderId && folders.some((folder) => folder.id === initialFolderId) ? initialFolderId : null);
  const [editing, setEditing] = useState<{ folder: FolderSummary | null } | null>(null);
  const open = folders.find((folder) => folder.id === openId) ?? null;

  return <div data-testid="artwork-home">
    {open ? <ArtworkFolderPanel
      branches={branches} defaultBranchId={defaultBranchId} folder={open} key={open.id}
      onBack={() => { setOpenId(null); }}
      onDeleted={() => { setOpenId(null); router.refresh(); }}
      onEdit={() => { setEditing({ folder: open }); }}
    /> : <section className="mt-6" data-testid="folders">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black">Carpetas</h2>
          <p className="mt-1 text-sm text-stone-600">Una carpeta guarda qué promociones publicás juntas. Con un solo botón se generan todas las gráficas con los precios de hoy.</p>
        </div>
        <button className={primary} data-testid="new-folder" onClick={() => { setEditing({ folder: null }); }} type="button">+ Nueva carpeta</button>
      </div>
      {folders.length ? <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {folders.map((folder) => <li className="grid content-start gap-1 rounded-xl bg-white p-4 shadow-sm" data-testid="folder-card" key={folder.id}>
          <h3 className="text-lg font-black">{folder.name}</h3>
          <p className="text-sm text-stone-600">{folderItemsLabel(folder.items.length)}</p>
          <p className="text-sm text-stone-600">{folderFormatsLabel(folder)}</p>
          {folder.usedByDisplays > 0 ? <p className="text-xs font-bold text-emerald-800">En {folder.usedByDisplays} {folder.usedByDisplays === 1 ? "pantalla de TV" : "pantallas de TV"}</p> : null}
          <button className={`${primary} mt-3 justify-self-start`} onClick={() => { setOpenId(folder.id); }} type="button">Abrir</button>
        </li>)}
      </ul> : <p className="mt-4 rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-stone-500" data-testid="folders-empty">
        Todavía no hay carpetas. Creá una con las promociones de la semana y generá todas sus gráficas con un botón.
      </p>}
    </section>}

    <details className="group mt-8 rounded-xl border border-stone-200 bg-white p-4 open:shadow-sm" data-testid="single-piece">
      <summary className="cursor-pointer text-base font-black text-stone-800">Crear una pieza individual <span className="text-sm font-normal text-stone-500">(un producto o un collage)</span></summary>
      <p className="mt-2 text-sm text-stone-600">Elegí un producto y se arma solo su pieza, con el precio y la promoción vigentes del sistema. Descargá Feed o Story en PNG.</p>
      <ArtworkWorkspace branches={branches} defaultBranchId={defaultBranchId} />
    </details>

    {editing ? <ArtworkFolderEditor
      folder={editing.folder} key={editing.folder?.id ?? "new"} onClose={() => { setEditing(null); }}
      onSaved={(folderId) => { setEditing(null); router.refresh(); if (folderId) setOpenId(folderId); }}
    /> : null}
  </div>;
}
