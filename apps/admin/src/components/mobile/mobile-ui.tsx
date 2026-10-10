import type { ReactNode } from "react";

/** Botón principal: una sola acción clara por pantalla. Verde = guardar / confirmar; el rojo se reserva para errores y acciones destructivas. */
export const primaryButton = "grid min-h-14 w-full place-items-center rounded-2xl bg-emerald-700 px-4 text-lg font-black text-white active:bg-emerald-800 disabled:bg-stone-300 disabled:text-stone-500";
export const secondaryButton = "grid min-h-12 w-full place-items-center rounded-xl border border-stone-300 bg-white px-4 text-base font-bold text-stone-700 active:bg-stone-100 disabled:opacity-50";
export const bigInput = "min-h-14 w-full rounded-xl border border-stone-300 bg-white px-4 text-right text-2xl font-black text-stone-900 focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-200";
export const textInput = "min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-base text-stone-900 focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-200";

/** Barra fija sobre la barra inferior (la acción principal de la pantalla siempre a mano, con el pulgar). */
export function StickyFooter({ children }: { children: ReactNode }) {
  return <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 -mx-4 mt-4 border-t border-stone-200 bg-[#fbfaf8] px-4 py-3 shadow-[0_-6px_12px_-8px_rgba(0,0,0,0.15)]">{children}</div>;
}

export function Notice({ tone, children }: { tone: "ok" | "warn" | "error" | "info"; children: ReactNode }) {
  const styles = { ok: "bg-emerald-50 text-emerald-900", warn: "bg-amber-50 text-amber-900", error: "bg-red-50 text-red-800", info: "bg-stone-100 text-stone-700" };
  return <p className={`rounded-xl p-3 text-base ${styles[tone]}`} role={tone === "error" ? "alert" : "status"}>{children}</p>;
}
