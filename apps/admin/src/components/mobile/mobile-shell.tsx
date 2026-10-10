"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { activeMobileTab, isMobileHome, mobileScreen, MOBILE_HOME, MOBILE_TABS } from "../../lib/mobile-nav";
import { MobileMoreButton } from "./mobile-more-sheet";
import { useChromeState } from "./mobile-chrome";

/**
 * Barra superior del celular: SIEMPRE tiene «‹ Volver», un título claro y «Inicio». En el Inicio no se muestra (el Inicio ya es el menú). Si la pantalla tiene
 * pasos internos, «‹» vuelve al paso anterior; si no, va a un destino fijo (no depende del historial, que en una app instalada puede estar vacío).
 */
export function MobileTopBar() {
  const pathname = usePathname();
  const view = useSearchParams().get("view");
  const chrome = useChromeState();
  if (isMobileHome(pathname)) return null;
  const screen = mobileScreen(pathname, view);
  const backClass = "grid size-11 shrink-0 place-items-center rounded-xl text-2xl font-bold text-stone-700 active:bg-stone-200";
  return <header className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b border-stone-200 bg-[#fbfaf8] px-2 pt-[env(safe-area-inset-top)] lg:hidden">
    {chrome.onBack
      ? <button aria-label="Volver" className={backClass} onClick={chrome.onBack} type="button">‹</button>
      : <Link aria-label="Volver" className={backClass} href={screen.backHref} prefetch={false}>‹</Link>}
    <h1 className="min-w-0 flex-1 truncate text-center text-lg font-black">{chrome.title ?? screen.title}</h1>
    <Link aria-label="Ir al Inicio" className="grid size-11 shrink-0 place-items-center rounded-xl text-xl active:bg-stone-200" href={MOBILE_HOME} prefetch={false}><span aria-hidden="true">🏠</span></Link>
  </header>;
}

/** Barra inferior fija: las mismas palabras que el Inicio. No se muestra en el Inicio (ahí las 4 tareas ya son el menú). */
export function MobileBottomNav() {
  const pathname = usePathname();
  const view = useSearchParams().get("view");
  if (isMobileHome(pathname)) return null;
  const active = activeMobileTab(pathname, view);
  const item = "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-bold";
  return <nav aria-label="Navegación" className="fixed inset-x-0 bottom-0 z-40 flex border-t border-stone-200 bg-[#fbfaf8] pb-[env(safe-area-inset-bottom)] lg:hidden">
    {MOBILE_TABS.map((tab) => <Link aria-current={active === tab.key ? "page" : undefined} className={`${item} ${active === tab.key ? "text-emerald-900" : "text-stone-500"}`} href={tab.href} key={tab.key} prefetch={false}>
      <span aria-hidden="true" className={`grid h-7 w-14 place-items-center rounded-full text-lg ${active === tab.key ? "bg-emerald-100" : ""}`}>{tab.icon}</span>{tab.label}
    </Link>)}
    <MobileMoreButton className={`${item} text-stone-500`}><span aria-hidden="true" className="grid h-7 w-14 place-items-center rounded-full text-lg">☰</span>Más</MobileMoreButton>
  </nav>;
}
