import Link from "next/link";

import { StatusBadge } from "../../../../components/admin-ui";
import { SectionTabs } from "../../../../components/section-tabs";
import { VacuumCutToggle, VacuumDefaultShelfLifeForm, VacuumEanSchemeForm, VacuumEstablishmentForm, VacuumProductConfigModal } from "../../../../components/vacuum-settings-forms";
import { requireAdminContext } from "../../../../lib/admin";
import { createPerfLogger } from "../../../../lib/perf";
import { createClient } from "../../../../lib/supabase/server";
import { parseVacuumConfigPage, parseVacuumSettings, shelfLifeSummary } from "../../../../lib/vacuum";
import { VACUUM_TABS } from "../../../../lib/vacuum-tabs";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const PAGE_SIZE = 40;

/**
 * Envasados → Configuración: esquema del EAN-13, datos del establecimiento y medidas del papel (por organización) y qué cortes están disponibles para
 * envasar, con su vida útil, PLU y texto de conservación (por producto). Nada de esto trae valores por defecto de negocio: lo define la carnicería.
 */
export default async function VacuumSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/vacuum/settings");
  await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const filter = ["all", "enabled", "disabled"].includes(value("filter")) ? value("filter") : "all";
  const search = value("q").trim();
  const page = Math.max(1, Number.parseInt(value("page") || "1", 10) || 1);

  const supabase = await createClient();
  const [settingsResult, productsResult] = await Promise.all([
    perf.measure("settings", supabase.rpc("get_vacuum_settings")),
    perf.measure("products", supabase.rpc("list_vacuum_config_products_page", { p_filter: filter, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE, ...(search ? { p_search: search } : {}) }))
  ]);
  perf.flush();
  const settings = parseVacuumSettings(settingsResult.data);
  const products = parseVacuumConfigPage(productsResult.data);
  const error = settingsResult.error ?? productsResult.error;
  const totalPages = Math.max(1, Math.ceil(products.total / PAGE_SIZE));
  const href = (target: number) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (filter !== "all") query.set("filter", filter);
    if (target > 1) query.set("page", String(target));
    const text = query.toString();
    return text ? `/admin/vacuum/settings?${text}` : "/admin/vacuum/settings";
  };

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <p className="max-w-3xl text-stone-600">Configuración del envasado al vacío. Los cortes son los productos del catálogo: acá sólo se elige cuáles se pueden envasar.</p>
    <SectionTabs tabs={VACUUM_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}

    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <VacuumEanSchemeForm config={settings.ean} key={JSON.stringify(settings.ean)} />
      <VacuumDefaultShelfLifeForm days={settings.defaultShelfLifeDays} key={settings.defaultShelfLifeDays} />
      <VacuumEstablishmentForm key={[settings.businessName, settings.infoHeightMm, settings.priceHeightMm, settings.labelWidthMm].map(String).join("|")} settings={settings} />
    </div>

    <section className="mt-8">
      <h2 className="text-xl font-black">Cortes disponibles para envasar</h2>
      <p className="mt-1 text-sm text-stone-600">Sólo productos por peso. Habilitar es un clic: el sistema asigna el PLU solo y el corte usa el vencimiento general salvo que lo configures aparte. ¿Falta uno? Se crea en <Link className="font-bold text-rose-800 underline" href="/admin/products">Productos</Link>.</p>
      <form className="mt-3 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-[1fr_11rem_auto]">
        <input className={input} defaultValue={search} name="q" placeholder="Buscar por nombre o SKU…" type="search" />
        <select className={input} defaultValue={filter} name="filter"><option value="all">Todos</option><option value="enabled">Habilitados</option><option value="disabled">No habilitados</option></select>
        <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold">Filtrar</button>
      </form>
      <p className="mt-3 text-sm text-stone-500">{products.total} producto{products.total === 1 ? "" : "s"}</p>
      <div className="mt-3 overflow-hidden rounded-xl bg-white shadow-sm"><div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm" data-testid="vacuum-config-products">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-4">Corte</th><th className="p-4">Vencimiento</th><th className="p-4">Estado</th><th className="p-4 text-right">Acción</th></tr></thead>
        <tbody>{products.rows.map((row) => (
          <tr className="border-b border-stone-100 last:border-0" key={row.productId}>
            <td className="p-4"><strong>{row.name}</strong>{row.sku ? <span className="block text-xs text-stone-500">{row.sku}</span> : null}</td>
            <td className="p-4">{shelfLifeSummary(row).text} <span className="text-xs text-stone-500">· {shelfLifeSummary(row).custom ? "Personalizado" : "General"}</span></td>
            <td className="p-4"><StatusBadge tone={row.enabled ? "success" : "neutral"}>{row.enabled ? "Habilitado" : "No habilitado"}</StatusBadge></td>
            <td className="p-4"><div className="flex items-center justify-end gap-2"><VacuumProductConfigModal defaultShelfLifeDays={products.defaultShelfLifeDays} row={row} /><VacuumCutToggle enabled={row.enabled} productId={row.productId} /></div></td>
          </tr>
        ))}</tbody>
      </table></div>
      {products.rows.length === 0 ? <p className="p-8 text-center text-stone-500">No hay productos por peso para estos filtros.</p> : null}</div>
      {totalPages > 1 ? <nav aria-label="Paginación" className="mt-3 flex items-center justify-between text-sm">
        {page > 1 ? <Link className="font-bold text-rose-800 hover:underline" href={href(page - 1)}>← Anterior</Link> : <span />}
        <span className="text-stone-500">Página {page} de {totalPages}</span>
        {page < totalPages ? <Link className="font-bold text-rose-800 hover:underline" href={href(page + 1)}>Siguiente →</Link> : <span />}
      </nav> : null}
    </section>
  </main>;
}
