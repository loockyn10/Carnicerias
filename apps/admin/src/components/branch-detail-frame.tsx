"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

interface BranchDetailFrameProps {
  children: ReactNode;
  modal?: boolean;
  title: string;
  subtitle: string;
  status: string;
}

export function BranchDetailFrame({ children, modal = false, title, subtitle, status }: BranchDetailFrameProps) {
  const router = useRouter();
  const closeButton = useRef<HTMLAnchorElement>(null);
  const close = () => router.replace("/admin/branches");

  useEffect(() => {
    if (!modal) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    window.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", onKeyDown); };
  }, [modal, router]);

  if (!modal) return children;
  return <div aria-labelledby="branch-detail-title" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/30 p-0 sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }} role="dialog">
    <section className="flex h-dvh w-full max-w-[96rem] flex-col overflow-hidden bg-[#f5f4f1] shadow-xl sm:h-[92vh] sm:rounded-2xl" onMouseDown={(event) => event.stopPropagation()}>
      <header className="flex shrink-0 items-center justify-between border-b border-stone-200 bg-[#fbfaf8] px-5 py-4 sm:px-7"><div className="min-w-0"><h1 className="truncate text-xl font-black" id="branch-detail-title">{title}</h1><p className="truncate text-sm text-stone-500">{subtitle}</p></div><div className="flex items-center gap-4"><span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700">{status}</span><Link aria-label="Cerrar detalle de sucursal" className="grid size-9 place-items-center rounded-lg text-xl text-stone-600 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-800" href="/admin/branches" ref={closeButton} replace>×</Link></div></header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  </div>;
}
