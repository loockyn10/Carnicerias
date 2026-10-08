"use client";

import { useEffect, useRef, useState } from "react";

import { getArtworkPhotoAction, removeArtworkPhotoAction, type ArtworkPhotoState } from "../app/admin/products/artwork/actions";
import { uploadArtworkPhoto } from "../lib/artwork-photo-client";
import { formatBytes, MAX_PHOTO_BYTES } from "../lib/artwork-photo";

const secondaryButton = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold disabled:opacity-50";

/**
 * «Foto para cartelería» del editor de producto: UNA foto comercial por producto (distinta del código de barras/SKU), guardada en
 * Supabase Storage. Se carga recién al abrir el editor. No participa del formulario del producto: sube y quita por su cuenta.
 */
export function ProductArtworkPhotoField({ productId }: { productId: string }) {
  const [state, setState] = useState<ArtworkPhotoState | null>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void getArtworkPhotoAction(productId).then((result) => { if (!cancelled) setState(result); });
    return () => { cancelled = true; };
  }, [productId]);

  const loading = state === null;
  const url = state?.url ?? null;

  async function onFile(file: File | undefined) {
    if (!file) return;
    setMessage(null);
    setBusy("upload");
    const result = await uploadArtworkPhoto(productId, file);
    setBusy(null);
    if (inputRef.current) inputRef.current.value = "";
    if (result.error) { setMessage({ kind: "error", text: result.error }); return; }
    setState(result);
    setMessage({ kind: "ok", text: "Foto guardada." });
  }

  async function remove() {
    if (!window.confirm("¿Quitar la foto de cartelería de este producto?")) return;
    setMessage(null);
    setBusy("remove");
    const result = await removeArtworkPhotoAction(productId);
    setBusy(null);
    if (result.error) { setMessage({ kind: "error", text: result.error }); return; }
    setState(result);
    setMessage({ kind: "ok", text: "Foto quitada." });
  }

  return <div className="rounded-lg bg-stone-50 p-3" data-testid="artwork-photo-field">
    <p className="text-sm font-bold">Foto para cartelería</p>
    <p className="mt-1 text-xs text-stone-500">La foto protagonista de las piezas de Cartelería. Una por producto. Funciona mejor con fondo transparente (PNG) o blanco.</p>
    <div className="mt-3 flex flex-wrap items-center gap-4">
      <div className="grid h-28 w-40 place-items-center overflow-hidden rounded-lg border border-stone-200 bg-white" data-testid="artwork-photo-preview">
        {url
          ? <img alt="Foto de cartelería del producto" className="h-full w-full object-contain" src={url} />
          : <span className="px-2 text-center text-xs text-stone-400">{loading ? "Cargando…" : "Sin foto"}</span>}
      </div>
      <div className="grid gap-2">
        <input accept="image/jpeg,image/png,image/webp" className="hidden" data-testid="artwork-photo-input" onChange={(event) => { void onFile(event.target.files?.[0]); }} ref={inputRef} type="file" />
        <button className={secondaryButton} disabled={loading || busy !== null} onClick={() => { inputRef.current?.click(); }} type="button">
          {busy === "upload" ? "Subiendo…" : url ? "Cambiar foto" : "Subir foto"}
        </button>
        {url ? <button className={`${secondaryButton} text-red-700`} disabled={busy !== null} onClick={() => { void remove(); }} type="button">{busy === "remove" ? "Quitando…" : "Eliminar"}</button> : null}
        <p className="text-xs text-stone-500">JPG, PNG o WebP · hasta {formatBytes(MAX_PHOTO_BYTES)}{state?.sizeBytes ? ` · actual: ${formatBytes(state.sizeBytes)}` : ""}</p>
      </div>
    </div>
    {state?.error ? <p className="mt-2 text-sm text-red-700" role="alert">{state.error}</p> : null}
    {message ? <p className={`mt-2 text-sm ${message.kind === "error" ? "text-red-700" : "text-emerald-700"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
  </div>;
}
