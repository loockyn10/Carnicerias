import Link from "next/link";

import { Notice } from "../../../../../components/distribution/ui";
import { fieldInput, fieldLabel, FormModal, optionalHint } from "../../../../../components/form-modal";
import { SectionTabs } from "../../../../../components/section-tabs";
import { requireAdminContext } from "../../../../../lib/admin";
import { COMMERCIAL_MODE_HINTS, COMMERCIAL_MODE_LABELS, COMMERCIAL_MODES, parseDistributionClients, WEEKDAY_LABELS, type DistributionClient, type DistributionSite } from "../../../../../lib/distribution/model";
import { DISTRIBUTION_TABS } from "../../../../../lib/distribution/tabs";
import { createClient } from "../../../../../lib/supabase/server";
import { formatIsoDate } from "../../../../../lib/vacuum";
import { VACUUM_TABS } from "../../../../../lib/vacuum-tabs";
import { saveDistributionClientAction, saveDistributionSiteAction } from "../actions";

function ClientFields({ client }: { client?: DistributionClient }) {
  return <>
    {client ? <input name="id" type="hidden" value={client.id} /> : null}
    <label className={fieldLabel}>Nombre comercial<input autoFocus className={fieldInput} defaultValue={client?.tradeName ?? ""} maxLength={160} name="trade_name" required /></label>
    <label className={fieldLabel}>Razón social <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={client?.legalName ?? ""} maxLength={200} name="legal_name" /></label>
    <label className={fieldLabel}>CUIT <span className={optionalHint}>opcional · se valida el dígito verificador</span><input className={fieldInput} defaultValue={client?.taxId ?? ""} inputMode="numeric" maxLength={13} name="tax_id" placeholder="20-12345678-6" /></label>
    <label className={fieldLabel}>Modalidad comercial
      <select className={fieldInput} defaultValue={client?.commercialMode ?? "CONSIGNMENT"} name="commercial_mode">{COMMERCIAL_MODES.map((mode) => <option key={mode} value={mode}>{COMMERCIAL_MODE_LABELS[mode]} — {COMMERCIAL_MODE_HINTS[mode]}</option>)}</select>
    </label>
    <label className={fieldLabel}>Observaciones <span className={optionalHint}>opcional</span><textarea className={fieldInput} defaultValue={client?.notes ?? ""} maxLength={1000} name="notes" rows={2} /></label>
    <label className={fieldLabel}>Estado<select className={fieldInput} defaultValue={client?.active === false ? "off" : "on"} name="active"><option value="on">Activo</option><option value="off">Inactivo (no recibe entregas)</option></select></label>
  </>;
}

function SiteFields({ clientId, site }: { clientId: string; site?: DistributionSite }) {
  return <>
    {site ? <input name="id" type="hidden" value={site.id} /> : <input name="client_id" type="hidden" value={clientId} />}
    <label className={fieldLabel}>Nombre del establecimiento<input autoFocus className={fieldInput} defaultValue={site?.name ?? ""} maxLength={160} name="name" placeholder="Sucursal Centro" required /></label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={fieldLabel}>Dirección <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={site?.address ?? ""} maxLength={240} name="address" /></label>
      <label className={fieldLabel}>Localidad <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={site?.city ?? ""} maxLength={120} name="city" /></label>
      <label className={fieldLabel}>Teléfono <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={site?.phone ?? ""} maxLength={60} name="phone" /></label>
      <label className={fieldLabel}>Contacto responsable <span className={optionalHint}>opcional</span><input className={fieldInput} defaultValue={site?.contactName ?? ""} maxLength={160} name="contact_name" /></label>
      <label className={fieldLabel}>Día habitual de reposición <span className={optionalHint}>opcional</span>
        <select className={fieldInput} defaultValue={site?.restockWeekday ?? ""} name="restock_weekday"><option value="">Sin día fijo</option>{WEEKDAY_LABELS.slice(1).map((label, index) => <option key={label} value={index + 1}>{label}</option>)}</select>
      </label>
      <label className={fieldLabel}>Modalidad <span className={optionalHint}>vacío = la del cliente</span>
        <select className={fieldInput} defaultValue={site?.commercialMode ?? ""} name="commercial_mode"><option value="">La del cliente</option>{COMMERCIAL_MODES.map((mode) => <option key={mode} value={mode}>{COMMERCIAL_MODE_LABELS[mode]}</option>)}</select>
      </label>
    </div>
    <label className={fieldLabel}>Observaciones <span className={optionalHint}>opcional</span><textarea className={fieldInput} defaultValue={site?.notes ?? ""} maxLength={1000} name="notes" rows={2} /></label>
    <label className={fieldLabel}>Estado<select className={fieldInput} defaultValue={site?.active === false ? "off" : "on"} name="active"><option value="on">Activo</option><option value="off">Inactivo (no recibe entregas)</option></select></label>
  </>;
}

/**
 * Envasados → Distribución → Supermercados. Clientes (la empresa: CUIT, razón social, modalidad) y sus establecimientos (cada uno con sus propias entregas,
 * dirección, contacto y día de reposición). Los establecimientos de un supermercado NO son las sucursales internas de Carnicerías Fran.
 */
export default async function DistributionClientsPage() {
  await requireAdminContext();
  const supabase = await createClient();
  const result = await supabase.rpc("list_distribution_clients");
  const clients = parseDistributionClients(result.data);

  return <main className="mx-auto max-w-6xl p-5 sm:p-8" data-testid="distribution-clients">
    <p className="max-w-3xl text-stone-600">Los supermercados a los que se distribuye. Cada cliente puede tener varios establecimientos, y cada establecimiento recibe sus propias entregas.</p>
    <SectionTabs active="/admin/vacuum/distribution" tabs={VACUUM_TABS} />
    <SectionTabs tabs={DISTRIBUTION_TABS} />
    {result.error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{result.error.message}</p> : null}
    <div className="mt-6 flex justify-end">
      <FormModal action={saveDistributionClientAction} description="Después agregás sus establecimientos." submitLabel="Crear cliente" title="Nuevo supermercado" triggerClassName="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white hover:bg-rose-900" triggerLabel="+ Nuevo supermercado">
        <ClientFields />
      </FormModal>
    </div>
    {clients.length === 0 ? <div className="mt-4"><Notice tone="info">Todavía no cargaste ningún supermercado.</Notice></div> : null}
    <div className="mt-4 grid gap-5">
      {clients.map((client) => <section className={`rounded-xl bg-white p-5 shadow-sm ${client.active ? "" : "opacity-70"}`} data-testid="client-card" key={client.id}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">{client.tradeName}{client.active ? null : <span className="ml-2 rounded bg-stone-200 px-2 py-0.5 text-xs">Inactivo</span>}</h2>
            <p className="text-sm text-stone-600">{[client.legalName, client.taxId ? `CUIT ${client.taxId.replace(/^(\d{2})(\d{8})(\d)$/, "$1-$2-$3")}` : null].filter(Boolean).join(" · ") || "Sin razón social ni CUIT"}</p>
            <p className="mt-1 text-xs"><span className="rounded-full bg-rose-50 px-2.5 py-1 font-bold text-rose-900">{COMMERCIAL_MODE_LABELS[client.commercialMode]}</span> <span className="text-stone-500">{COMMERCIAL_MODE_HINTS[client.commercialMode]}</span></p>
            {client.notes ? <p className="mt-1 text-xs text-stone-500">{client.notes}</p> : null}
          </div>
          <div className="flex gap-2">
            <FormModal action={saveDistributionClientAction} submitLabel="Guardar" title={`Editar ${client.tradeName}`} triggerLabel="Editar"><ClientFields client={client} /></FormModal>
            <FormModal action={saveDistributionSiteAction} submitLabel="Crear establecimiento" title={`Nuevo establecimiento de ${client.tradeName}`} triggerClassName="rounded-lg bg-stone-900 px-3 py-2 text-sm font-bold text-white" triggerLabel="+ Establecimiento" wide><SiteFields clientId={client.id} /></FormModal>
          </div>
        </div>
        {client.sites.length === 0 ? <p className="mt-4 rounded-lg bg-stone-50 p-4 text-sm text-stone-500">Este cliente todavía no tiene establecimientos: agregá el primero para poder entregarle.</p> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-stone-200 text-stone-500"><tr><th className="py-2 pr-3">Establecimiento</th><th className="py-2 pr-3">Contacto</th><th className="py-2 pr-3">Reposición</th><th className="py-2 pr-3">Última entrega</th><th className="py-2" /></tr></thead>
          <tbody>{client.sites.map((site) => <tr className="border-b border-stone-100 align-top last:border-0" data-testid="site-row" key={site.id}>
            <td className="py-3 pr-3"><strong>{site.name}</strong>{site.active ? null : <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-xs">Inactivo</span>}<span className="block text-xs text-stone-500">{[site.address, site.city].filter(Boolean).join(", ") || "Sin dirección"}</span>
              <span className="block text-xs text-stone-500">{COMMERCIAL_MODE_LABELS[site.effectiveMode]}{site.commercialMode ? " (propia)" : ""}</span></td>
            <td className="py-3 pr-3 text-xs">{site.contactName ?? "—"}<span className="block text-stone-500">{site.phone ?? ""}</span></td>
            <td className="py-3 pr-3 text-xs">{site.restockWeekday ? `Los ${WEEKDAY_LABELS[site.restockWeekday]?.toLowerCase() ?? ""}` : "Sin día fijo"}</td>
            <td className="py-3 pr-3 text-xs">{site.lastDelivery ? <Link className="font-bold text-rose-800 underline" href={`/admin/vacuum/distribution/deliveries/${site.lastDelivery.id}`}>{site.lastDelivery.numberLabel}</Link> : "—"}{site.lastDelivery ? <span className="block text-stone-500">{formatIsoDate(site.lastDelivery.deliveryDate)} · {site.lastDelivery.packageCount} paquetes</span> : null}</td>
            <td className="py-3"><div className="flex flex-wrap justify-end gap-2">
              {site.active && client.active ? <Link className="rounded-lg bg-rose-800 px-3 py-2 text-xs font-bold text-white" href={site.draftId ? `/admin/vacuum/distribution/new?draft=${site.draftId}` : `/admin/vacuum/distribution/new?site=${site.id}`}>{site.draftId ? "Continuar borrador" : "Nueva entrega"}</Link> : null}
              <FormModal action={saveDistributionSiteAction} submitLabel="Guardar" title={`Editar ${site.name}`} triggerClassName="rounded-lg border px-3 py-2 text-xs font-bold" triggerLabel="Editar" wide><SiteFields clientId={client.id} site={site} /></FormModal>
            </div></td></tr>)}</tbody>
        </table></div>}
      </section>)}
    </div>
  </main>;
}
