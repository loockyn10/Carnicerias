"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  loadArtworkAction, loadBrandingAction, loadCollageAction, type ArtworkLoadResult, type BrandingLoadResult, type CollageLoadResult
} from "../app/admin/products/artwork/actions";
import type { ProductOption } from "../app/admin/actions";
import { buildCollageArtworkModel, buildOfferArtworkModel, countMissingPhotos, normalizeHeadline, type OfferArtworkModel } from "../lib/artwork";
import { buildArtworkBranding, type ArtworkBranding } from "../lib/artwork-branding";
import {
  ARTWORK_FORMATS, ARTWORK_TEMPLATES, ARTWORK_TEMPLATE_LABELS, COLLAGE_HEADLINE_PRESETS, COLLAGE_MAX_ITEMS, COLLAGE_MIN_ITEMS, HEADLINE_PRESETS,
  MAX_HEADLINE_LENGTH, defaultHeadline, formatsForTemplate, isExportableFormat, type ArtworkFormat, type ArtworkTemplate, type ExportableArtworkFormat
} from "../lib/artwork-tokens";
import { ArtworkIdentityModal } from "./artwork-identity-modal";
import { ArtworkPreview } from "./artwork/artwork-preview";
import { ProductPicker } from "./product-picker";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const chip = "rounded-full border px-3 py-1 text-xs font-bold";
const iconButton = "rounded border border-stone-300 bg-white px-2 py-1 text-xs font-bold text-stone-700 hover:bg-stone-50 disabled:opacity-30";

export interface ArtworkBranchOption { id: string; name: string; active: boolean }

type HeroLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: Extract<ArtworkLoadResult, { kind: "ok" }> }
  | { status: "error"; message: string };

type CollageLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: Extract<CollageLoadResult, { kind: "ok" }> }
  | { status: "error"; message: string };

type BrandingState =
  | { status: "loading" }
  | { status: "ready"; result: Extract<BrandingLoadResult, { kind: "ok" }> }
  | { status: "error"; message: string };

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? fallback;
}

/**
 * Cartelería → Piezas (D-074 / D-075). Una pieza = plantilla («Producto protagonista» con 1 producto o «Collage» con 2 a 5) +
 * sucursal + titular. Los botones TV / Feed / Story sólo cambian la composición. El precio, la promoción, el logo y el contacto los
 * trae el servidor; acá no se escribe ningún precio.
 */
export function ArtworkWorkspace({ branches, defaultBranchId }: { branches: ArtworkBranchOption[]; defaultBranchId: string }) {
  const [template, setTemplate] = useState<ArtworkTemplate>("HERO");
  const [product, setProduct] = useState<ProductOption | null>(null);
  const [collageProducts, setCollageProducts] = useState<ProductOption[]>([]);
  const [pickerKey, setPickerKey] = useState(0);
  const [collageNotice, setCollageNotice] = useState<string | null>(null);
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [headline, setHeadline] = useState(defaultHeadline("HERO"));
  const [format, setFormat] = useState<ArtworkFormat>("feed");
  const [hero, setHero] = useState<HeroLoad>({ status: "idle" });
  const [collage, setCollage] = useState<CollageLoad>({ status: "idle" });
  const [brandingState, setBrandingState] = useState<BrandingState>({ status: "loading" });
  const [identityOpen, setIdentityOpen] = useState(false);
  const [download, setDownload] = useState<{ format: ExportableArtworkFormat | null; error: string | null }>({ format: null, error: null });
  const heroRequest = useRef(0);
  const collageRequest = useRef(0);
  const brandingRequest = useRef(0);

  const collageKey = collageProducts.map((item) => item.id).join(",");

  // Identidad (logo + contacto de la sucursal): se vuelve a leer al cambiar de sucursal.
  useEffect(() => {
    const requestId = ++brandingRequest.current;
    setBrandingState({ status: "loading" });
    loadBrandingAction(branchId || null)
      .then((result) => {
        if (brandingRequest.current !== requestId) return;
        setBrandingState(result.kind === "ok" ? { status: "ready", result } : { status: "error", message: result.message });
      })
      .catch(() => { if (brandingRequest.current === requestId) setBrandingState({ status: "error", message: "No se pudo leer la identidad" }); });
  }, [branchId]);

  useEffect(() => {
    if (template !== "HERO" || !product) { setHero({ status: "idle" }); return; }
    const requestId = ++heroRequest.current;
    setHero({ status: "loading" });
    loadArtworkAction(product.id, branchId || null)
      .then((result) => {
        if (heroRequest.current !== requestId) return;
        if (result.kind === "ok") setHero({ status: "ready", result });
        else setHero({ status: "error", message: result.kind === "error" ? result.message : "No se encontró el producto" });
      })
      .catch(() => { if (heroRequest.current === requestId) setHero({ status: "error", message: "No se pudo cargar la pieza" }); });
  }, [template, product, branchId]);

  useEffect(() => {
    if (template !== "COLLAGE" || collageProducts.length < COLLAGE_MIN_ITEMS) { setCollage({ status: "idle" }); return; }
    const requestId = ++collageRequest.current;
    setCollage({ status: "loading" });
    loadCollageAction(collageProducts.map((item) => item.id), branchId || null)
      .then((result) => {
        if (collageRequest.current !== requestId) return;
        setCollage(result.kind === "ok" ? { status: "ready", result } : { status: "error", message: result.message });
      })
      .catch(() => { if (collageRequest.current === requestId) setCollage({ status: "error", message: "No se pudo cargar el collage" }); });
    // `collageKey` identifica la lista (y su orden): no hace falta depender del arreglo.
  }, [template, collageKey, branchId]);

  const branding: ArtworkBranding | null = useMemo(
    () => (brandingState.status === "ready" ? buildArtworkBranding(brandingState.result.facts, brandingState.result.logoUrl) : null),
    [brandingState]
  );

  const heroReady = hero.status === "ready" ? hero.result : null;
  const collageReady = collage.status === "ready" ? collage.result : null;

  const built = useMemo((): { model: OfferArtworkModel | null; problem: string | null } => {
    if (!branding) return { model: null, problem: null };
    if (template === "HERO") {
      if (!heroReady) return { model: null, problem: null };
      const model = buildOfferArtworkModel(heroReady.facts, { headline, imageUrl: heroReady.photoUrl, branding });
      return { model, problem: model ? null : heroReady.unavailableMessage };
    }
    if (!collageReady) return { model: null, problem: null };
    const result = buildCollageArtworkModel(collageReady.entries.map((entry) => ({ facts: entry.facts, imageUrl: entry.photoUrl })), { headline, branding });
    return result.ok ? { model: result.model, problem: null } : { model: null, problem: result.message };
  }, [template, heroReady, collageReady, headline, branding]);
  const model = built.model;

  const loading = template === "HERO" ? hero.status === "loading" : collage.status === "loading";
  const loadError = template === "HERO" ? (hero.status === "error" ? hero.message : null) : (collage.status === "error" ? collage.message : null);
  const missingPhotos = model ? countMissingPhotos(model) : 0;
  const photoProblem = heroReady?.facts.photo && !heroReady.photoUrl;
  const activeBranch = branches.find((branch) => branch.id === branchId) ?? null;

  const availableFormats = formatsForTemplate(template);
  const shownFormat: ArtworkFormat = availableFormats.includes(format) ? format : "feed";

  function chooseTemplate(next: ArtworkTemplate) {
    if (next === template) return;
    // Si el titular era el de la otra plantilla (sin tocar), pasa al de la nueva.
    if (headline === defaultHeadline(template)) setHeadline(defaultHeadline(next));
    setTemplate(next);
    setDownload({ format: null, error: null });
  }

  function addCollageProduct(next: ProductOption | null) {
    if (!next) return;
    setPickerKey((key) => key + 1);
    if (collageProducts.some((item) => item.id === next.id)) { setCollageNotice(`«${next.name}» ya está en el collage.`); return; }
    if (collageProducts.length >= COLLAGE_MAX_ITEMS) { setCollageNotice(`El collage lleva hasta ${String(COLLAGE_MAX_ITEMS)} productos.`); return; }
    setCollageNotice(null);
    setCollageProducts((list) => [...list, next]);
  }

  function moveProduct(index: number, delta: -1 | 1) {
    setCollageProducts((list) => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      return next;
    });
  }

  function removeProduct(index: number) {
    setCollageNotice(null);
    setCollageProducts((list) => list.filter((_, position) => position !== index));
  }

  async function downloadPng(target: ExportableArtworkFormat) {
    const productIds = template === "HERO" ? (product ? [product.id] : []) : collageProducts.map((item) => item.id);
    if (!productIds.length) return;
    setDownload({ format: target, error: null });
    try {
      const response = await fetch("/api/artwork/png", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sólo ids, plantilla, titular y formato: el precio, la promoción, el logo y el contacto los resuelve el servidor.
        body: JSON.stringify({ template, productIds, branchId: branchId || null, headline: normalizeHeadline(headline, defaultHeadline(template)), format: target })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setDownload({ format: null, error: body?.error ?? "No se pudo generar la imagen" });
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(response.headers.get("Content-Disposition"), `super-ofertas-${target}.png`);
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
      setDownload({ format: null, error: null });
    } catch {
      setDownload({ format: null, error: "No se pudo generar la imagen. Revisá tu conexión y probá de nuevo." });
    }
  }

  const canDownload = Boolean(model) && download.format === null;
  const presets = template === "COLLAGE" ? COLLAGE_HEADLINE_PRESETS : HEADLINE_PRESETS;
  const normalizedHeadline = normalizeHeadline(headline, defaultHeadline(template));
  const noLogo = brandingState.status === "ready" && !brandingState.result.facts.logo;
  const noContact = brandingState.status === "ready" && Boolean(branchId) && !branding?.contact;

  return <div className="mt-5 grid gap-6 lg:grid-cols-[22rem_1fr]" data-testid="artwork-workspace">
    <section className="grid min-w-0 content-start gap-4 rounded-xl bg-white p-5 shadow-sm">
      <div aria-label="Tipo de pieza" className="grid min-w-0 gap-2 text-sm font-bold" role="group">
        <span>Tipo de pieza</span>
        <div className="grid grid-cols-2 gap-2">
          {ARTWORK_TEMPLATES.map((id) => <button
            aria-pressed={template === id}
            className={`rounded-lg border px-3 py-2 text-sm font-bold ${template === id ? "border-rose-800 bg-rose-800 text-white" : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"}`}
            data-testid={`template-${id.toLowerCase()}`} key={id} onClick={() => { chooseTemplate(id); }} type="button"
          >{ARTWORK_TEMPLATE_LABELS[id]}</button>)}
        </div>
      </div>

      {template === "HERO" ? <div className="grid min-w-0 gap-1 text-sm font-bold">
        <span>Producto</span>
        {/* Con sucursal elegida sólo se ofrecen los productos que esa sucursal vende. */}
        <ProductPicker branchId={branchId || null} name="artwork_product" onChange={setProduct} placeholder="Buscar producto…" />
      </div> : <div className="grid min-w-0 gap-2 text-sm font-bold" data-testid="collage-products">
        <span>Productos ({collageProducts.length}/{COLLAGE_MAX_ITEMS})</span>
        <ol className="grid gap-1">
          {collageProducts.map((item, index) => <li className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm font-normal" data-testid="collage-item" key={item.id}>
            <span className="w-5 shrink-0 text-center text-xs font-bold text-stone-500">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate"><strong className="font-bold">{item.name}</strong>{item.sku ? <span className="ml-2 text-xs text-stone-500">{item.sku}</span> : null}</span>
            <button aria-label={`Subir ${item.name}`} className={iconButton} disabled={index === 0} onClick={() => { moveProduct(index, -1); }} type="button">↑</button>
            <button aria-label={`Bajar ${item.name}`} className={iconButton} disabled={index === collageProducts.length - 1} onClick={() => { moveProduct(index, 1); }} type="button">↓</button>
            <button aria-label={`Quitar ${item.name}`} className={`${iconButton} text-red-700`} onClick={() => { removeProduct(index); }} type="button">✕</button>
          </li>)}
        </ol>
        {collageProducts.length < COLLAGE_MAX_ITEMS
          ? <div className="grid gap-1"><span className="text-xs font-normal text-stone-500">+ Agregar producto (nombre, SKU o código de barras)</span>
            <ProductPicker branchId={branchId || null} key={pickerKey} name="collage_product" onChange={addCollageProduct} placeholder="Buscar producto…" /></div>
          : <p className="text-xs font-normal text-stone-500">Llegaste al máximo de {COLLAGE_MAX_ITEMS} productos.</p>}
        {collageNotice ? <p className="text-xs font-normal text-amber-800" role="status">{collageNotice}</p> : null}
        <span className="text-xs font-normal text-stone-500">De {COLLAGE_MIN_ITEMS} a {COLLAGE_MAX_ITEMS} productos. El orden de la lista es el de la pieza.</span>
      </div>}

      <label className="grid min-w-0 gap-1 text-sm font-bold" htmlFor="artwork-branch">Sucursal
        <select className={`${input} w-full font-normal`} id="artwork-branch" onChange={(event) => { setBranchId(event.target.value); }} value={branchId}>
          <option value="">Precio general (sin sucursal)</option>
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.active ? "" : " (inactiva)"}</option>)}
        </select>
        <span className="text-xs font-normal text-stone-500">La pieza muestra el mismo precio y promoción que el POS de esa sucursal, y el contacto de esa sucursal.</span>
      </label>

      <div className="grid min-w-0 gap-2 text-sm font-bold">
        <label htmlFor="artwork-headline">Titular</label>
        <input className={`${input} w-full font-normal uppercase`} id="artwork-headline" maxLength={MAX_HEADLINE_LENGTH} onChange={(event) => { setHeadline(event.target.value); }} placeholder={defaultHeadline(template)} value={headline} />
        <div className="flex flex-wrap gap-2" data-testid="artwork-headline-presets">
          {presets.map((preset) => <button
            aria-pressed={normalizedHeadline === preset}
            className={`${chip} ${normalizedHeadline === preset ? "border-rose-800 bg-rose-50 text-rose-800" : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"}`}
            key={preset} onClick={() => { setHeadline(preset); }} type="button"
          >{preset}</button>)}
        </div>
        <span className="text-xs font-normal text-stone-500">Corto (hasta {MAX_HEADLINE_LENGTH} letras). El precio no se escribe a mano: sale del sistema.</span>
      </div>

      <div className="border-t pt-4">
        <button className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-700 hover:bg-stone-50 disabled:opacity-50" data-testid="open-identity" disabled={brandingState.status !== "ready"} onClick={() => { setIdentityOpen(true); }} type="button">
          Configurar identidad
        </button>
        <p className="mt-1 text-xs text-stone-500">Logo y contacto (teléfono, dirección, ciudad) de las piezas.</p>
      </div>

      <div className="grid gap-2 border-t pt-4">
        <p className="text-sm font-bold">Descargar</p>
        <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" data-testid="download-feed" disabled={!canDownload} onClick={() => { void downloadPng("feed"); }} type="button">
          {download.format === "feed" ? "Generando…" : "Descargar Feed PNG"}
        </button>
        <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" data-testid="download-story" disabled={!canDownload} onClick={() => { void downloadPng("story"); }} type="button">
          {download.format === "story" ? "Generando…" : "Descargar Story PNG"}
        </button>
        <p className="text-xs text-stone-500">Feed {ARTWORK_FORMATS.feed.width} × {ARTWORK_FORMATS.feed.height} · Story / WhatsApp Estado {ARTWORK_FORMATS.story.width} × {ARTWORK_FORMATS.story.height}.</p>
        {download.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{download.error}</p> : null}
      </div>
    </section>

    <section className="min-w-0">
      <div aria-label="Formato" className="flex flex-wrap gap-2" role="group">
        {availableFormats.map((id) => <button
          aria-pressed={shownFormat === id}
          className={`rounded-lg border px-4 py-2 text-sm font-bold ${shownFormat === id ? "border-rose-800 bg-rose-800 text-white" : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"}`}
          data-testid={`format-${id}`} key={id} onClick={() => { setFormat(id); }} type="button"
        >{ARTWORK_FORMATS[id].label.split(" ")[0]}<span className="ml-1 font-normal opacity-80">{ARTWORK_FORMATS[id].label.split(" ")[1]}</span>
          {isExportableFormat(id) ? null : <span className="ml-1 text-xs font-normal opacity-70">(vista previa)</span>}
        </button>)}
      </div>

      {(noLogo || noContact) && model ? <div className="mt-3 grid gap-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="identity-warnings">
        {noLogo ? <p>Todavía no cargaste el logo: la franja muestra el nombre de la organización. Usá <strong>Configurar identidad</strong>.</p> : null}
        {noContact ? <p>La sucursal {activeBranch ? <strong>{activeBranch.name}</strong> : null} no tiene teléfono, dirección ni ciudad cargados: la pieza no lleva bloque de contacto. Usá <strong>Configurar identidad</strong>.</p> : null}
      </div> : null}

      <div className="mt-4">
        {template === "HERO" && !product ? <p className="rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-stone-500" data-testid="artwork-empty">Elegí un producto para ver su pieza.</p> : null}
        {template === "COLLAGE" && collageProducts.length < COLLAGE_MIN_ITEMS ? <p className="rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-stone-500" data-testid="artwork-empty">Agregá al menos {COLLAGE_MIN_ITEMS} productos para armar el collage.</p> : null}
        {loading && !model ? <p className="rounded-xl bg-white p-10 text-center text-stone-500" role="status">Cargando la pieza…</p> : null}
        {brandingState.status === "error" ? <p className="rounded-lg bg-red-50 p-4 text-red-800" role="alert">{brandingState.message}</p> : null}
        {loadError ? <p className="rounded-lg bg-red-50 p-4 text-red-800" role="alert">{loadError}</p> : null}
        {built.problem && !model ? <p className="rounded-lg bg-amber-50 p-4 text-amber-900" data-testid="artwork-unavailable" role="alert">{built.problem}</p> : null}
        {model ? <div style={{ opacity: loading ? 0.5 : 1 }}>
          <ArtworkPreview format={shownFormat} model={model} />
          {missingPhotos > 0 ? <p className="mt-3 text-sm text-amber-800" data-testid="artwork-no-photo">
            {template === "HERO"
              ? <>Este producto no tiene foto comercial: la pieza usa un panel de reemplazo. Subila desde <strong>Administrar producto → Foto para cartelería</strong>.</>
              : <>{missingPhotos === 1 ? "1 producto sin foto comercial" : `${String(missingPhotos)} productos sin foto comercial`}: {model.items.filter((item) => !item.imageUrl).map((item) => item.productName).join(", ")}. La pieza usa un panel de reemplazo; subí la foto desde <strong>Administrar producto → Foto para cartelería</strong>.</>}
          </p> : null}
          {photoProblem ? <p className="mt-3 text-sm text-amber-800" role="alert">No se pudo cargar la foto del producto. Probá de nuevo en unos segundos.</p> : null}
        </div> : null}
      </div>
    </section>

    {identityOpen && brandingState.status === "ready" ? <ArtworkIdentityModal
      branchId={branchId || null}
      branchName={activeBranch?.name ?? null}
      branding={brandingState.result}
      key={branchId}
      onChanged={(result) => { setBrandingState({ status: "ready", result }); }}
      onClose={() => { setIdentityOpen(false); }}
    /> : null}
  </div>;
}
