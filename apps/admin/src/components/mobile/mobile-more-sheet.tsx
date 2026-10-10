"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { logout } from "../../app/admin/actions";
import { MOBILE_MORE_LINKS, MOBILE_NEW_PRODUCT } from "../../lib/mobile-nav";
import { OverlayDialog } from "../overlay-dialog";

/**
 * «Más»: lo que no es de las 4 tareas del celular. Son las pantallas completas del escritorio (pueden verse apretadas) y la salida de la cuenta. Lo
 * usan la barra inferior y el Inicio: el botón se dibuja con la clase y el contenido que le pasen.
 */
export function MobileMoreButton({ className, children }: { className: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className={className} onClick={() => { setOpen(true); }} type="button">{children}</button>
    {open ? <OverlayDialog onClose={() => { setOpen(false); }} tall title="Más opciones">
      <div className="mobile-screen mt-4 grid gap-2 pb-6">
        <Link className="flex min-h-14 items-center gap-3 rounded-xl bg-white px-4 py-3 shadow-sm" href={MOBILE_NEW_PRODUCT} onClick={() => { setOpen(false); }}>
          <span aria-hidden="true" className="text-2xl">➕</span><span className="font-black">Nuevo producto</span>
        </Link>
        <p className="mt-3 px-1 text-sm text-stone-500">Pantallas completas. Están pensadas para la computadora: en el celular pueden verse apretadas.</p>
        {MOBILE_MORE_LINKS.map((link) => <Link className="flex min-h-14 flex-col justify-center rounded-xl bg-white px-4 py-2 shadow-sm" href={link.href} key={link.href} onClick={() => { setOpen(false); }} prefetch={false}>
          <span className="font-bold">{link.label}</span><span className="text-sm text-stone-500">{link.description}</span>
        </Link>)}
        <form action={logout} className="mt-4"><button className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 py-3 font-bold text-stone-700" type="submit">Cerrar sesión</button></form>
      </div>
    </OverlayDialog> : null}
  </>;
}
