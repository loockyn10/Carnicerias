"use client";

import type { ReactNode } from "react";
import { useState } from "react";

export function Modal({ trigger, title, children }: { trigger: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <><button className="rounded-lg bg-rose-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-900" onClick={() => setOpen(true)} type="button">{trigger}</button>{open ? <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4"><section aria-modal="true" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl" role="dialog"><div className="flex items-center justify-between gap-3"><h2 className="text-xl font-black">{title}</h2><button className="text-sm font-semibold text-stone-500 hover:text-stone-900" onClick={() => setOpen(false)} type="button">Cerrar</button></div><div className="mt-5">{children}</div></section></div> : null}</>;
}
