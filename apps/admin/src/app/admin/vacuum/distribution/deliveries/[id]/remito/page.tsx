import Link from "next/link";
import { notFound } from "next/navigation";

import { PrintButton } from "../../../../../../../components/distribution/print-button";
import { RemitoDocument } from "../../../../../../../components/distribution/remito-document";
import { requireAdminContext } from "../../../../../../../lib/admin";
import { buildRemito } from "../../../../../../../lib/distribution/logic";
import { parseDelivery } from "../../../../../../../lib/distribution/model";
import { createClient } from "../../../../../../../lib/supabase/server";
import { isUuid } from "../../../../../../../lib/uuid";

/**
 * Remito OPERATIVO imprimible de una entrega (no es un remito fiscal). Al imprimir sólo sale el documento: el resto de la pantalla (menú, botones) se oculta
 * con estilos de impresión, en hoja A4.
 */
export default async function RemitoPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await requireAdminContext();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  const result = await supabase.rpc("get_distribution_delivery", { p_delivery_id: id });
  const delivery = parseDelivery(result.data);
  if (!delivery) {
    if (result.error) return <main className="mx-auto max-w-3xl p-8"><p className="rounded-lg bg-red-50 p-4 text-red-800">{result.error.message}</p></main>;
    notFound();
  }
  return <main className="mx-auto max-w-5xl p-5 sm:p-8">
    <style>{`@page { size: A4; margin: 12mm; } @media print { body * { visibility: hidden; } #remito, #remito * { visibility: visible; } #remito { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
      <Link className="text-sm font-bold text-rose-800 underline" href={`/admin/vacuum/distribution/deliveries/${delivery.id}`}>← Volver a la entrega</Link>
      <PrintButton label="Imprimir el remito" />
    </div>
    <RemitoDocument remito={buildRemito(delivery)} timezone={context.timezone} />
  </main>;
}
