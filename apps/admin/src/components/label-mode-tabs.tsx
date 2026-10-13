import Link from "next/link";

export type LabelMode = "gondola" | "offers";

const MODES: { id: LabelMode; label: string; href: string }[] = [
  { id: "gondola", label: "Etiquetas de góndola", href: "/admin/products/labels" },
  { id: "offers", label: "Carteles de ofertas", href: "/admin/products/labels?mode=offers" }
];

/** Los dos modos de Productos → Etiquetas: la etiqueta 60 × 40 de góndola y el cartel A4 de ofertas. */
export function LabelModeTabs({ active }: { active: LabelMode }) {
  return <nav aria-label="Tipo de impresión" className="mt-5 inline-flex flex-wrap gap-1 rounded-xl bg-stone-100 p-1" data-testid="label-mode-tabs">
    {MODES.map((mode) => <Link
      aria-current={mode.id === active ? "page" : undefined}
      className={`rounded-lg px-4 py-2 text-sm font-bold ${mode.id === active ? "bg-white text-rose-800 shadow-sm" : "text-stone-600 hover:text-stone-950"}`}
      href={mode.href} key={mode.id}
    >{mode.label}</Link>)}
  </nav>;
}
