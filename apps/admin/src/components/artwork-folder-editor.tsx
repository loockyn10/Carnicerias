"use client";

import { stockUnitLabel } from "@carnicerias/business-logic";
import { useEffect, useMemo, useState, useTransition } from "react";

import { saveFolderAction } from "../app/admin/products/artwork/folder-actions";
import { loadPromotionCatalogAction } from "../app/admin/products/signage/actions";
import type { ProductOption } from "../app/admin/actions";
import { folderItemsLabel, type FolderItemKind, type FolderSummary } from "../lib/artwork-folders";
import { moveItem } from "../lib/signage";
import { PROMOTION_STATUS_LABELS, validityText, type PromotionCatalog, type PromotionOption } from "../lib/signage-promotions";
import { OverlayDialog } from "./overlay-dialog";
import { ProductPicker } from "./product-picker";
import { PromotionChooser } from "./signage-promotions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const primary = "rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white hover:bg-rose-900 disabled:opacity-50";
const link = "text-sm font-bold text-rose-800 hover:underline disabled:opacity-50";
const smallButton = "rounded-md border border-stone-300 px-2 py-1 text-sm font-bold disabled:opacity-30";

export const MAX_FOLDER_ITEMS = 100;

interface EditorItem {
  kind: FolderItemKind;
  id: string;
  name: string | null;
  sku: string | null;
  unitType: "UNIT" | "WEIGHT" | null;
}

const itemKey = (item: Pick<EditorItem, "kind" | "id">) => `${item.kind}:${item.id}`;

function fromFolder(folder: FolderSummary | null): EditorItem[] {
  return (folder?.items ?? []).map((item) => ({ kind: item.kind, id: item.id, name: item.name, sku: item.sku, unitType: item.unitType }));
}

/**
 * Crear / editar una CARPETA (D-086): nombre, formatos (Feed y Story) y su contenido, que son promociones ya cargadas en Promociones (o un
 * producto sin promoción). La carpeta guarda SÓLO referencias: no se escribe ni se copia ningún precio, descuento, nombre ni foto. Se
 * agrega, se quita y se ordena; «Guardar carpeta» lo hace en una sola transacción.
 */
export function ArtworkFolderEditor({ folder, onClose, onSaved }: { folder: FolderSummary | null; onClose: () => void; onSaved: (folderId: string) => void }) {
  const [name, setName] = useState(folder?.name ?? "");
  const [items, setItems] = useState<EditorItem[]>(() => fromFolder(folder));
  const [generateFeed, setGenerateFeed] = useState(folder?.generateFeed ?? true);
  const [generateStory, setGenerateStory] = useState(folder?.generateStory ?? true);
  const [catalog, setCatalog] = useState<PromotionCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void loadPromotionCatalogAction(null, false).then((result) => {
      if (cancelled) return;
      if (result.ok) setCatalog(result.catalog);
      else setCatalogError(result.error);
    });
    return () => { cancelled = true; };
  }, []);

  const promotions = useMemo(() => new Map((catalog?.promotions ?? []).map((option) => [option.promotionId, option])), [catalog]);
  const selectedPromotionIds = useMemo(() => new Set(items.filter((item) => item.kind === "PROMOTION").map((item) => item.id)), [items]);
  const valid = name.trim() !== "" && items.length >= 1 && (generateFeed || generateStory);

  function togglePromotion(option: PromotionOption) {
    setNotice(null);
    setItems((current) => {
      if (current.some((item) => item.kind === "PROMOTION" && item.id === option.promotionId)) return current.filter((item) => !(item.kind === "PROMOTION" && item.id === option.promotionId));
      if (current.length >= MAX_FOLDER_ITEMS) { setError(`Una carpeta admite hasta ${String(MAX_FOLDER_ITEMS)} elementos`); return current; }
      setError(null);
      return [...current, { kind: "PROMOTION", id: option.promotionId, name: option.productName, sku: option.sku, unitType: option.unitType }];
    });
  }

  function addProduct(product: ProductOption | null) {
    if (!product) return;
    setPickerKey((key) => key + 1);
    setNotice(null);
    if (items.some((item) => item.kind === "PRODUCT" && item.id === product.id)) { setError(`«${product.name}» ya está en la carpeta`); return; }
    if (items.length >= MAX_FOLDER_ITEMS) { setError(`Una carpeta admite hasta ${String(MAX_FOLDER_ITEMS)} elementos`); return; }
    setError(null);
    setItems((current) => [...current, { kind: "PRODUCT", id: product.id, name: product.name, sku: product.sku, unitType: product.unitType }]);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveFolderAction({
        folderId: folder?.id ?? null, name, generateFeed, generateStory, items: items.map((item) => ({ kind: item.kind, id: item.id }))
      });
      if (result.error) { setError(result.error); return; }
      onSaved(result.folderId ?? folder?.id ?? "");
    });
  }

  return <OverlayDialog onClose={onClose} subtitle={folder ? "Editar carpeta" : "Elegí qué promociones o productos van"} title={folder ? folder.name : "Nueva carpeta"} wide>
    <div className="mt-4 space-y-5" data-testid="folder-editor">
      <p className="rounded-lg bg-white p-3 text-sm text-stone-600 shadow-sm">
        La carpeta guarda <strong>qué</strong> promociones entran, no sus precios: cada vez que generás las gráficas se toma el precio, la promoción y la foto de hoy.
      </p>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <label className="grid gap-1 text-sm font-bold" htmlFor="folder-name">Nombre
          <input autoFocus className={`${input} font-normal`} id="folder-name" maxLength={80} onChange={(event) => { setName(event.target.value); }} placeholder="Ofertas finde" value={name} />
        </label>
        <fieldset className="grid gap-1 text-sm font-bold">
          <legend className="mb-1">Formatos</legend>
          <div className="flex gap-4 font-normal">
            <label className="flex items-center gap-2"><input checked={generateFeed} onChange={(event) => { setGenerateFeed(event.target.checked); }} type="checkbox" /> Feed</label>
            <label className="flex items-center gap-2"><input checked={generateStory} onChange={(event) => { setGenerateStory(event.target.checked); }} type="checkbox" /> Story</label>
          </div>
        </fieldset>
      </div>

      <div>
        <p className="text-sm font-bold">En la carpeta ({folderItemsLabel(items.length)}) — se generan en este orden</p>
        <ol className="mt-2 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white" data-testid="folder-items">
          {items.map((item, index) => {
            const option = item.kind === "PROMOTION" ? promotions.get(item.id) : undefined;
            const title = option?.productName ?? item.name ?? (item.kind === "PROMOTION" ? "Promoción" : "Producto");
            return <li className="flex flex-wrap items-center gap-3 px-3 py-2" data-kind={item.kind} key={itemKey(item)}>
              <span className="w-6 text-right text-sm font-black text-stone-400">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">
                  <span className="mr-2 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-bold text-stone-600">{item.kind === "PROMOTION" ? "Promoción" : "Producto"}</span>{title}
                  {item.sku ? <span className="ml-2 text-xs font-normal text-stone-500">{item.sku}</span> : null}
                  {item.unitType ? <span className="ml-2 text-xs font-normal text-stone-500">{stockUnitLabel(item.unitType)}</span> : null}
                </p>
                {option ? <p className="text-xs text-stone-500">{option.summary} · {PROMOTION_STATUS_LABELS[option.status]} · {validityText(option)}</p>
                  : item.kind === "PRODUCT" ? <p className="text-xs text-stone-500">Sin promoción: la pieza muestra el precio vigente</p> : null}
                {option && option.status !== "ACTIVE" ? <p className="text-xs font-bold text-amber-700">{option.status === "EXPIRED" ? "Vencida o desactivada: no se genera mientras no esté vigente" : "Todavía no empezó: no se genera hasta esa fecha"}</p> : null}
              </div>
              <div className="flex gap-1">
                <button aria-label={`Subir ${title}`} className={smallButton} disabled={index === 0} onClick={() => { setItems(moveItem(items, index, -1)); }} type="button">↑</button>
                <button aria-label={`Bajar ${title}`} className={smallButton} disabled={index === items.length - 1} onClick={() => { setItems(moveItem(items, index, 1)); }} type="button">↓</button>
                <button aria-label={`Quitar ${title}`} className={`${smallButton} text-red-700`} onClick={() => { setItems(items.filter((_, position) => position !== index)); }} type="button">Quitar</button>
              </div>
            </li>;
          })}
          {!items.length ? <li className="px-3 py-4 text-sm text-stone-500">Todavía no elegiste nada. Marcá promociones de la lista de abajo o buscá un producto.</li> : null}
        </ol>
      </div>

      <div>
        <p className="mb-2 text-sm font-bold">Agregar promociones</p>
        {catalogError ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{catalogError}</p> : null}
        {!catalog && !catalogError ? <p className="text-sm text-stone-500" role="status">Cargando promociones…</p> : null}
        {catalog ? <PromotionChooser onToggle={togglePromotion} options={catalog.promotions} selected={selectedPromotionIds} /> : null}
      </div>

      <div className="grid max-w-xl gap-1">
        <p className="text-sm font-bold">Agregar un producto sin promoción <span className="font-normal text-stone-500">(opcional)</span></p>
        <ProductPicker key={pickerKey} name="folder_product" onChange={addProduct} placeholder="Buscar producto: nombre, SKU o código de barras…" />
      </div>

      {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
      {notice ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{notice}</p> : null}
      <div className="flex flex-wrap items-center gap-4">
        <button className={primary} data-testid="folder-save" disabled={pending || !valid} onClick={save} type="button">{pending ? "Guardando…" : "Guardar carpeta"}</button>
        <button className={link} disabled={pending} onClick={onClose} type="button">Cancelar</button>
        {!valid ? <span className="text-xs text-stone-500">Falta {name.trim() === "" ? "el nombre" : items.length === 0 ? "elegir al menos un elemento" : "elegir un formato"}.</span> : null}
      </div>
    </div>
  </OverlayDialog>;
}
