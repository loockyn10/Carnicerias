"use client";

import { useRef, useState } from "react";

import { removeArtworkLogoAction, saveBranchContactAction, type BrandingLoadResult } from "../app/admin/products/artwork/actions";
import { formatBytes, MAX_PHOTO_BYTES } from "../lib/artwork-photo";
import { uploadArtworkLogo } from "../lib/artwork-photo-client";
import { ARTWORK_COLORS } from "../lib/artwork-tokens";

const input = "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-normal";
const secondaryButton = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold disabled:opacity-50";

type Loaded = Extract<BrandingLoadResult, { kind: "ok" }>;

/**
 * «Configurar identidad» (Cartelería → Piezas): el LOGO de la organización (subir / cambiar / quitar, en Supabase Storage) y el
 * contacto de la sucursal elegida (teléfono, dirección y ciudad). La dirección es la misma de «Sucursales»: no hay una segunda
 * fuente de verdad. No ocupa la pantalla: se abre desde un botón compacto.
 */
export function ArtworkIdentityModal({ branding, branchId, branchName, onChanged, onClose }: {
  branding: Loaded;
  branchId: string | null;
  branchName: string | null;
  onChanged: (result: Loaded) => void;
  onClose: () => void;
}) {
  const branch = branding.facts.branch;
  const [phone, setPhone] = useState(branch?.phone ?? "");
  const [address, setAddress] = useState(branch?.address ?? "");
  const [city, setCity] = useState(branch?.city ?? "");
  const [busy, setBusy] = useState<"logo" | "remove" | "contact" | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const logo = branding.facts.logo;

  function apply(result: BrandingLoadResult, okText: string) {
    if (result.kind === "error") { setMessage({ kind: "error", text: result.message }); return; }
    onChanged(result);
    setMessage({ kind: "ok", text: okText });
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setMessage(null);
    setBusy("logo");
    const result = await uploadArtworkLogo(file, branchId);
    setBusy(null);
    if (fileRef.current) fileRef.current.value = "";
    apply(result, "Logo guardado.");
  }

  async function removeLogo() {
    if (!window.confirm("¿Quitar el logo? Las piezas van a mostrar el nombre de la organización hasta que cargues otro.")) return;
    setMessage(null);
    setBusy("remove");
    const result = await removeArtworkLogoAction(branchId);
    setBusy(null);
    apply(result, "Logo quitado.");
  }

  async function saveContact() {
    if (!branchId) return;
    setMessage(null);
    setBusy("contact");
    const result = await saveBranchContactAction(branchId, { phone, address, city });
    setBusy(null);
    apply(result, "Contacto guardado.");
  }

  return <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4">
    <section aria-label="Configurar identidad" aria-modal="true" className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl" data-testid="identity-modal" role="dialog">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-black">Configurar identidad</h2>
        <button className="text-sm font-semibold text-stone-500 hover:text-stone-900" onClick={onClose} type="button">Cerrar</button>
      </div>

      <div className="mt-5 grid gap-2" data-testid="identity-logo">
        <p className="text-sm font-bold">Logo de cartelería</p>
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid h-32 w-24 place-items-center overflow-hidden rounded-lg border border-stone-200" style={{ background: ARTWORK_COLORS.BRAND_GREEN }}>
            {branding.logoUrl
              ? <img alt="Logo de cartelería" className="max-h-full max-w-full object-contain" src={branding.logoUrl} />
              : <span className="px-2 text-center text-xs text-white/80">Sin logo</span>}
          </div>
          <div className="grid gap-2">
            <input accept="image/png,image/jpeg,image/webp" className="hidden" data-testid="identity-logo-input" onChange={(event) => { void onFile(event.target.files?.[0]); }} ref={fileRef} type="file" />
            <button className={secondaryButton} disabled={busy !== null} onClick={() => { fileRef.current?.click(); }} type="button">
              {busy === "logo" ? "Subiendo…" : logo ? "Cambiar logo" : "Subir logo"}
            </button>
            {logo ? <button className={`${secondaryButton} text-red-700`} disabled={busy !== null} onClick={() => { void removeLogo(); }} type="button">{busy === "remove" ? "Quitando…" : "Eliminar"}</button> : null}
          </div>
        </div>
        <p className="text-xs text-stone-500">Preferentemente PNG con fondo transparente · hasta {formatBytes(MAX_PHOTO_BYTES)}. Va dentro de la franja verde de las piezas; si es apaisado se acuesta de abajo hacia arriba.</p>
      </div>

      <div className="mt-6 grid gap-3 border-t pt-5" data-testid="identity-contact">
        <p className="text-sm font-bold">Contacto{branchName ? <> de la sucursal <span className="text-rose-800">{branchName}</span></> : null}</p>
        {branchId ? <>
          <label className="grid gap-1 text-sm font-bold">Teléfono
            <input className={input} maxLength={40} name="phone" onChange={(event) => { setPhone(event.target.value); }} placeholder="p. ej. 3496-448808" value={phone} />
          </label>
          <label className="grid gap-1 text-sm font-bold">Dirección
            <input className={input} maxLength={200} name="address" onChange={(event) => { setAddress(event.target.value); }} placeholder="p. ej. Güemes 2180" value={address} />
          </label>
          <label className="grid gap-1 text-sm font-bold">Ciudad
            <input className={input} maxLength={80} name="city" onChange={(event) => { setCity(event.target.value); }} placeholder="p. ej. Esperanza, Santa Fe" value={city} />
          </label>
          <p className="text-xs text-stone-500">Es el contacto de esta sucursal: no se mezcla con el de otras. La dirección es la misma que figura en Sucursales. Lo que dejes vacío no se imprime.</p>
          <div><button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={busy !== null} onClick={() => { void saveContact(); }} type="button">{busy === "contact" ? "Guardando…" : "Guardar contacto"}</button></div>
        </> : <p className="rounded-lg bg-stone-50 p-3 text-sm text-stone-600">Elegí una sucursal para ver y editar su teléfono, dirección y ciudad. Con «Precio general» la pieza no lleva bloque de contacto.</p>}
      </div>

      {message ? <p className={`mt-4 text-sm ${message.kind === "error" ? "text-red-700" : "text-emerald-700"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
    </section>
  </div>;
}
