import Link from "next/link";
import { notFound } from "next/navigation";

import { ReconciliationPanel } from "../../../../../../components/distribution/reconciliation-panel";
import { DeliveryStatusBadge } from "../../../../../../components/distribution/ui";
import { SectionTabs } from "../../../../../../components/section-tabs";
import { requireAdminContext } from "../../../../../../lib/admin";
import { localDateString } from "../../../../../../lib/date-range";
import { COMMERCIAL_MODE_LABELS, parseReconciliation, parseReplenishmentHistory } from "../../../../../../lib/distribution/model";
import { DISTRIBUTION_TABS } from "../../../../../../lib/distribution/tabs";
import { createClient } from "../../../../../../lib/supabase/server";
import { isUuid } from "../../../../../../lib/uuid";
import { formatIsoDate, moneyText, weightText } from "../../../../../../lib/vacuum";
import { VACUUM_TABS } from "../../../../../../lib/vacuum-tabs";

/** Envasados → Distribución → una entrega: datos, remito, conciliación (vendidos informados, por cantidad), devoluciones y el historial de reposiciones del establecimiento. */
export default async function DeliveryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await requireAdminContext();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  const reconciliationResult = await supabase.rpc("get_delivery_reconciliation", { p_delivery_id: id });
  const reconciliation = parseReconciliation(reconciliationResult.data);
  if (!reconciliation) {
    if (reconciliationResult.error) return <main className="mx-auto max-w-5xl p-8"><p className="rounded-lg bg-red-50 p-4 text-red-800">{reconciliationResult.error.message}</p></main>;
    notFound();
  }
  const { delivery } = reconciliation;
  const historyResult = await supabase.rpc("get_site_replenishment_history", { p_site_id: delivery.site.id, p_limit: 12 });
  const history = parseReplenishmentHistory(historyResult.data);

  return <main className="mx-auto max-w-7xl p-5 sm:p-8" data-testid="delivery-detail">
    <SectionTabs active="/admin/vacuum/distribution" tabs={VACUUM_TABS} />
    <SectionTabs active="/admin/vacuum/distribution/deliveries" tabs={DISTRIBUTION_TABS} />
    <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-3xl font-black">{delivery.numberLabel} <span className="align-middle"><DeliveryStatusBadge status={delivery.status} /></span></h1>
        <p className="mt-1 text-stone-600">{delivery.client.tradeName} · {delivery.site.name}{delivery.site.city ? ` · ${delivery.site.city}` : ""}</p>
        <p className="text-sm text-stone-500">Entrega del {formatIsoDate(delivery.deliveryDate)} desde {delivery.originBranchName} · {COMMERCIAL_MODE_LABELS[delivery.commercialMode]} · {delivery.packageCount} paquetes · {weightText(delivery.totalGrams)} · {moneyText(delivery.totalCents)} (valor comercial)</p>
        <p className="text-xs text-stone-500">Preparada por {delivery.createdBy ?? "—"}{delivery.confirmedBy ? ` · despachada por ${delivery.confirmedBy}` : ""}{delivery.cancelReason ? ` · cancelada: ${delivery.cancelReason}` : ""}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white" href={`/admin/vacuum/distribution/deliveries/${delivery.id}/remito`}>Remito</Link>
        <Link className="rounded-lg border px-4 py-2 text-sm font-bold" href={`/admin/vacuum/distribution/returns?delivery=${delivery.id}`}>Devoluciones</Link>
        {delivery.status === "DRAFT" ? <Link className="rounded-lg border px-4 py-2 text-sm font-bold" href={`/admin/vacuum/distribution/new?draft=${delivery.id}`}>Continuar borrador</Link> : null}
      </div>
    </div>
    {delivery.status === "CONFIRMED" ? <div className="mt-6"><ReconciliationPanel history={history} reconciliation={reconciliation} today={localDateString(context.timezone)} /></div>
      : <p className="mt-6 rounded-lg bg-stone-50 p-6 text-sm text-stone-600">{delivery.status === "DRAFT" ? "Esta entrega es un borrador: todavía no se despachó, así que no hay nada que conciliar." : "Esta entrega fue cancelada."}</p>}
  </main>;
}
