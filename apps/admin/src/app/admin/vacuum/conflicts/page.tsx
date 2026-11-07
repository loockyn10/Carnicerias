import Link from "next/link";

import { SectionTabs } from "../../../../components/section-tabs";
import { VacuumConflictResolve } from "../../../../components/vacuum-conflict-resolve";
import { requireAdminContext } from "../../../../lib/admin";
import { formatLocalDateTime } from "../../../../lib/date-range";
import { createPerfLogger } from "../../../../lib/perf";
import { createClient } from "../../../../lib/supabase/server";
import { moneyText, parseVacuumConflicts, VACUUM_CONFLICT_REASON_LABELS, weightText } from "../../../../lib/vacuum";
import { VACUUM_TABS } from "../../../../lib/vacuum-tabs";

/**
 * Envasados → Conflictos de venta: ventas hechas offline en cajas distintas que reclamaron el MISMO paquete (ya vendido, anulado o en otra sucursal). La
 * venta nunca se pierde: queda registrada y descontó stock; acá se revisa qué pasó (por ejemplo, eran dos paquetes con el mismo código) y se deja nota.
 */
export default async function VacuumConflictsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/vacuum/conflicts");
  const context = await requireAdminContext();
  const params = await searchParams;
  const showResolved = params.status === "RESOLVED";
  const supabase = await createClient();
  const result = await perf.measure("conflicts", supabase.rpc("list_vacuum_package_conflicts", { p_status: showResolved ? "RESOLVED" : "OPEN", p_limit: 200 }));
  perf.flush();
  const rows = parseVacuumConflicts(result.data);
  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <p className="max-w-3xl text-stone-600">Dos cajas sin conexión pueden vender el mismo paquete. Cuando sincronizan, las dos ventas quedan registradas y la segunda aparece acá para revisarla.</p>
    <SectionTabs tabs={VACUUM_TABS} />
    {result.error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{result.error.message}</p> : null}
    <nav className="mt-6 flex gap-4 text-sm font-bold">
      <Link className={showResolved ? "text-stone-500" : "text-rose-800 underline"} href="/admin/vacuum/conflicts">Abiertos</Link>
      <Link className={showResolved ? "text-rose-800 underline" : "text-stone-500"} href="/admin/vacuum/conflicts?status=RESOLVED">Resueltos</Link>
    </nav>
    <section className="mt-3 overflow-hidden rounded-xl bg-white shadow-sm">
      <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm" data-testid="vacuum-conflicts">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-4">Paquete</th><th className="p-4">Qué pasó</th><th className="p-4">Venta</th><th className="p-4">{showResolved ? "Resolución" : "Resolver"}</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr className="border-b border-stone-100 align-top last:border-0" key={row.id}>
            <td className="p-4"><strong>{row.productName}</strong><span className="block text-xs text-stone-500">{weightText(row.weightGrams)} · {moneyText(row.totalCents)} · lote {row.lot}</span><span className="block font-mono text-xs text-stone-500">{row.ean13}</span></td>
            <td className="p-4">{VACUUM_CONFLICT_REASON_LABELS[row.reason] ?? row.reason}<span className="block text-xs text-stone-500">{row.branchName} · {formatLocalDateTime(row.createdAt, context.timezone)}</span></td>
            <td className="p-4 font-mono text-xs">{row.saleId.slice(0, 8)}{row.firstSaleId ? <span className="block text-stone-500">primera venta {row.firstSaleId.slice(0, 8)}</span> : null}</td>
            <td className="p-4">{row.status === "OPEN" ? <VacuumConflictResolve conflictId={row.id} /> : <span className="text-xs text-stone-600">{row.resolutionNote}</span>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {rows.length === 0 ? <p className="p-8 text-center text-stone-500">{showResolved ? "No hay conflictos resueltos." : "No hay conflictos abiertos."}</p> : null}
    </section>
  </main>;
}
