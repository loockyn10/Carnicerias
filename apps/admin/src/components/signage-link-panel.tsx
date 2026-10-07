"use client";

import { useEffect, useRef, useState } from "react";

import { tvPath } from "../lib/signage";

/**
 * Enlace del televisor recién generado. La base sólo guarda el HASH del token, así que el enlace completo se muestra UNA vez (al crear
 * la pantalla o al regenerarla): hay que copiarlo ahora y pegarlo en el navegador del TV. Después sólo se puede regenerar.
 */
export function SignageLinkPanel({ token, onDismiss }: { token: string; onDismiss?: () => void }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<"ok" | "manual" | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const url = `${origin}${tvPath(token)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      // Sin permiso de portapapeles (http, navegador viejo): se selecciona el texto para copiarlo a mano.
      field.current?.focus();
      field.current?.select();
      setCopied("manual");
    }
  }

  return <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4" data-testid="signage-link-panel">
    <p className="text-sm font-bold text-amber-900">Enlace del televisor — copialo ahora</p>
    <p className="mt-1 text-sm text-amber-900">Por seguridad este enlace no se vuelve a mostrar. Si lo perdés, generá uno nuevo con «Regenerar enlace» (el anterior deja de funcionar).</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <input aria-label="Enlace del televisor" className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono text-xs" onFocus={(event) => { event.currentTarget.select(); }} readOnly ref={field} value={url} />
      <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white" onClick={() => { void copy(); }} type="button">Copiar enlace</button>
      <a className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-bold" href={tvPath(token)} rel="noopener noreferrer" target="_blank">Abrir enlace del TV</a>
      {onDismiss ? <button className="rounded-lg px-3 py-2 text-sm font-semibold text-stone-600 hover:bg-amber-100" onClick={onDismiss} type="button">Ocultar</button> : null}
    </div>
    {copied === "ok" ? <p className="mt-2 text-sm font-bold text-emerald-700">Enlace copiado.</p> : null}
    {copied === "manual" ? <p className="mt-2 text-sm text-amber-900">No se pudo copiar automáticamente: el texto quedó seleccionado, copialo con Ctrl+C.</p> : null}
  </div>;
}
