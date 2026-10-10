import Link from "next/link";

import { MOBILE_TASKS } from "../../lib/mobile-nav";
import { MobileMoreButton } from "./mobile-more-sheet";

/**
 * Inicio del celular: sólo las 4 tareas, grandes, con ícono, título y UNA frase. Quien abre la app sin conocer el sistema tiene que entender al instante qué
 * tocar. Todo lo demás está en «Más». (El escritorio conserva su panel: esta pantalla sólo se ve debajo de `lg`.)
 */
export function MobileHome({ organizationName }: { organizationName: string }) {
  return <div className="mobile-screen mx-auto w-full max-w-md px-4 pb-10 pt-[max(1.5rem,env(safe-area-inset-top))] lg:hidden" data-testid="mobile-home">
    <p className="text-center text-xs font-black uppercase tracking-[0.22em] text-stone-500">{organizationName}</p>
    <h1 className="mt-3 text-center text-3xl font-black tracking-tight">¿Qué querés hacer?</h1>
    <nav aria-label="Tareas" className="mt-6 grid gap-4">
      {MOBILE_TASKS.map((task) => <Link className="flex min-h-28 items-center gap-4 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm active:bg-stone-50" href={task.href} key={task.key} prefetch={false}>
        <span aria-hidden="true" className={`grid size-16 shrink-0 place-items-center rounded-2xl text-3xl ${task.tone}`}>{task.icon}</span>
        <span className="min-w-0"><span className="block text-xl font-black leading-tight">{task.title}</span><span className="mt-1 block text-base leading-snug text-stone-600">{task.description}</span></span>
      </Link>)}
    </nav>
    <div className="mt-8 flex justify-center"><MobileMoreButton className="min-h-12 rounded-xl px-5 text-base font-bold text-stone-600 active:bg-stone-200">Más opciones</MobileMoreButton></div>
  </div>;
}
