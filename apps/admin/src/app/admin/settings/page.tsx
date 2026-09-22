import Link from "next/link";

import { requireAdminContext } from "../../../lib/admin";

interface SettingsLink { label: string; description: string; href: string }

const SYSTEM_LINKS: SettingsLink[] = [
  { label: "Dispositivos POS", description: "Terminales autorizadas para operar.", href: "/admin/devices" },
  { label: "Avisos", description: "Comunicaciones visibles en las sucursales.", href: "/admin/announcements" }
];

const ADVANCED_LINKS: SettingsLink[] = [
  { label: "Auditoría", description: "Trazabilidad de los últimos eventos.", href: "/admin/audit" }
];

function LinkCard({ link }: { link: SettingsLink }) {
  return <Link className="block rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition-shadow hover:border-rose-200 hover:shadow-md" href={link.href}>
    <p className="font-bold text-stone-900">{link.label} →</p>
    <p className="mt-1 text-sm text-stone-600">{link.description}</p>
  </Link>;
}

export default async function SettingsPage() {
  await requireAdminContext();
  return <main className="mx-auto max-w-4xl p-5 sm:p-8">
    <p className="text-sm text-stone-500">Inicio / Configuración</p>
    <h1 className="mt-1 text-3xl font-black tracking-tight">Configuración</h1>
    <p className="mt-2 text-stone-600">Funciones técnicas y de uso poco frecuente.</p>

    <section className="mt-7">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-stone-400">Sistema</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">{SYSTEM_LINKS.map((link) => <LinkCard key={link.href} link={link} />)}</div>
    </section>

    <section className="mt-7">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-stone-400">Avanzado</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">{ADVANCED_LINKS.map((link) => <LinkCard key={link.href} link={link} />)}</div>
    </section>
  </main>;
}
