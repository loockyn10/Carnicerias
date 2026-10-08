import Link from "next/link";

export const SIGNAGE_SECTIONS = [
  { id: "pieces", label: "Piezas", href: "/admin/products/artwork" },
  { id: "screens", label: "Pantallas TV", href: "/admin/products/signage" }
] as const;

export type SignageSection = (typeof SIGNAGE_SECTIONS)[number]["id"];

/** Dos vistas de la pestaña Cartelería: las piezas por producto (D-074) y las pantallas de TV con carrusel (D-072). */
export function SignageSubnav({ active }: { active: SignageSection }) {
  return <nav aria-label="Cartelería" className="mt-5 inline-flex rounded-lg bg-stone-100 p-1">
    {SIGNAGE_SECTIONS.map((section) => <Link
      aria-current={section.id === active ? "page" : undefined}
      className={`rounded-md px-4 py-1.5 text-sm font-bold ${section.id === active ? "bg-white text-rose-800 shadow-sm" : "text-stone-600 hover:text-stone-950"}`}
      href={section.href} key={section.id}
    >{section.label}</Link>)}
  </nav>;
}
