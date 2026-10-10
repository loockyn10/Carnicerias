import Link from "next/link";

import { describeBranchPromotion } from "../lib/unit-promotions";
import { StatusBadge } from "./admin-ui";

export interface BranchPromotionRow {
  branchId: string;
  branchName: string;
  /** Escalones vigentes del descuento por cantidad de la sucursal, ordenados por cantidad (vacío = sin descuento por cantidad). */
  tiers: { minimumUnits: number; discountBps: number }[];
}

/**
 * Descuentos por cantidad vigentes en cada sucursal. SÓLO LECTURA (D-068, D-083): se configuran una sola vez para toda la organización en
 * Productos → Precios → Configuración de precios (sección «Descuentos por cantidad», con sus escalones) y el servidor los aplica a todas las
 * sucursales, así que no hay un editor por sucursal que pueda divergir. Desde N unidades del MISMO producto, X % sobre TODAS esas unidades
 * (productos distintos no se suman) con el MAYOR escalón alcanzado; no se acumulan entre sí, con un Pack, con una promoción propia del
 * producto ni con un precio manual.
 */
export function BranchPromotionsPanel({ rows }: { rows: BranchPromotionRow[] }) {
  return <section className="mt-6 rounded-xl bg-white p-5 shadow-sm" data-testid="branch-promotions">
    <h2 className="text-xl font-black">Descuentos por cantidad</h2>
    <p className="mt-1 text-sm text-stone-600">
      Se aplican a todos los productos por unidad: desde N unidades del <strong>mismo</strong> producto, X% de descuento sobre <strong>todas</strong> las unidades de esa línea (productos distintos no se suman). Con varios escalones manda el <strong>mayor</strong> alcanzado.
      No se acumula con un Pack, con una promoción propia del producto ni con un precio manual: manda un solo descuento por línea.
      Es una configuración de toda la organización: se cambia en <Link className="font-bold text-rose-800 hover:underline" href="/admin/products?tab=pricing">Productos → Precios → Configuración de precios</Link>.
    </p>
    <ul className="mt-4 divide-y">
      {rows.map((row) => (
        <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={row.branchId}>
          <div>
            <p className="font-bold">{row.branchName}</p>
            <p className="text-sm text-stone-600">{row.tiers.length ? row.tiers.map((tier) => describeBranchPromotion(tier.minimumUnits, tier.discountBps)).join(" · ") : "Sin descuentos por cantidad"}</p>
          </div>
          <StatusBadge tone={row.tiers.length ? "success" : "neutral"}>{row.tiers.length ? "Activos" : "Sin descuentos"}</StatusBadge>
        </li>
      ))}
      {!rows.length ? <li className="py-4 text-sm text-stone-500">No hay sucursales activas.</li> : null}
    </ul>
  </section>;
}
