import Link from "next/link";

import { describeBranchPromotion } from "../lib/unit-promotions";
import { StatusBadge } from "./admin-ui";

export interface BranchPromotionRow {
  branchId: string;
  branchName: string;
  /** Promoción vigente de la sucursal, o null si no tiene ninguna. */
  promotion: { minimumUnits: number; discountBps: number } | null;
}

/**
 * Promoción "llevando 3u" vigente en cada sucursal. SÓLO LECTURA (D-068): se configura una sola vez para toda la organización en
 * Productos → Precios → Configuración de precios (campo «Dto llevando 3u») y el servidor la aplica a todas las sucursales, así que
 * no hay un editor por sucursal que pueda divergir. Desde 3 unidades del MISMO producto, X % sobre TODAS esas unidades (productos
 * distintos no se suman); no se acumula con un Pack, con una promoción propia del producto ni con un precio manual.
 */
export function BranchPromotionsPanel({ rows }: { rows: BranchPromotionRow[] }) {
  return <section className="mt-6 rounded-xl bg-white p-5 shadow-sm" data-testid="branch-promotions">
    <h2 className="text-xl font-black">Promoción llevando 3u</h2>
    <p className="mt-1 text-sm text-stone-600">
      Se aplica a todos los productos por unidad: desde 3 unidades del <strong>mismo</strong> producto, X% de descuento sobre <strong>todas</strong> las unidades de esa línea (productos distintos no se suman).
      No se acumula con un Pack, con una promoción propia del producto ni con un precio manual: manda un solo descuento por línea.
      Es una configuración de toda la organización: se cambia en <Link className="font-bold text-rose-800 hover:underline" href="/admin/products?tab=pricing">Productos → Precios → Configuración de precios</Link>.
    </p>
    <ul className="mt-4 divide-y">
      {rows.map((row) => (
        <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={row.branchId}>
          <div>
            <p className="font-bold">{row.branchName}</p>
            <p className="text-sm text-stone-600">{row.promotion ? describeBranchPromotion(row.promotion.minimumUnits, row.promotion.discountBps) : "Sin promoción llevando 3u"}</p>
          </div>
          <StatusBadge tone={row.promotion ? "success" : "neutral"}>{row.promotion ? "Activa" : "Sin promoción"}</StatusBadge>
        </li>
      ))}
      {!rows.length ? <li className="py-4 text-sm text-stone-500">No hay sucursales activas.</li> : null}
    </ul>
  </section>;
}
