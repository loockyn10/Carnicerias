import Link from "next/link";

import { SectionTabs } from "../../../../components/section-tabs";
import { VacuumLabelPreview } from "../../../../components/vacuum-label-preview";
import { VacuumPackageActions } from "../../../../components/vacuum-package-actions";
import { VacuumReprintButtons } from "../../../../components/vacuum-reprint-buttons";
import { requireAdminContext } from "../../../../lib/admin";
import { formatLocalDateTime, isIsoDate } from "../../../../lib/date-range";
import { createPerfLogger } from "../../../../lib/perf";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";
import { formatIsoDate, moneyText, parseVacuumPackage, parseVacuumPackagesPage, parseVacuumConfigPage, vacuumDims, VACUUM_PACKAGE_STATUS_LABELS, weightText } from "../../../../lib/vacuum";
import { buildInfoLabelLayout, buildPriceLabelLayout, packageToLabelData } from "../../../../lib/vacuum-label-layout";
import { VACUUM_TABS } from "../../../../lib/vacuum-tabs";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const PAGE_SIZE = 30;

/**
 * Envasados → Envasados recientes: historial auditable de paquetes con búsqueda (lote, corte o EAN-13), filtros por fecha y corte, vista del paquete tal
 * como salió y reimpresión de cada etiqueta. Paginado en el servidor; la vista y la reimpresión usan el snapshot guardado, nunca precios actuales.
 */
export default async function VacuumRecentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/vacuum/recent");
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const search = value("q").trim();
  const from = isIsoDate(value("from")) ? value("from") : "";
  const to = isIsoDate(value("to")) ? value("to") : "";
  const productId = isUuid(value("product")) ? value("product") : "";
  const packageId = isUuid(value("package")) ? value("package") : "";
  const page = Math.max(1, Number.parseInt(value("page") || "1", 10) || 1);

  const supabase = await createClient();
  const [listResult, productsResult, detailResult, branchesResult] = await Promise.all([
    perf.measure("packages", supabase.rpc("list_vacuum_packages_page", {
      ...(from ? { p_from: from } : {}), ...(to ? { p_to: to } : {}), ...(productId ? { p_product_id: productId } : {}), ...(search ? { p_search: search } : {}),
      p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE
    })),
    perf.measure("products", supabase.rpc("list_vacuum_config_products_page", { p_filter: "enabled", p_limit: 200 })),
    packageId ? perf.measure("detail", supabase.rpc("get_vacuum_package", { p_package_id: packageId })) : Promise.resolve({ data: null, error: null }),
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"))
  ]);
  perf.flush();
  const list = parseVacuumPackagesPage(listResult.data);
  const products = parseVacuumConfigPage(productsResult.data).rows;
  const detail = parseVacuumPackage(detailResult.data);
  const branches = branchesResult.data ?? [];
  const error = listResult.error ?? productsResult.error ?? detailResult.error ?? branchesResult.error;
  const totalPages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const href = (extra: Record<string, string>) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (productId) query.set("product", productId);
    for (const [key, val] of Object.entries(extra)) if (val) query.set(key, val);
    const text = query.toString();
    return text ? `/admin/vacuum/recent?${text}` : "/admin/vacuum/recent";
  };

  const dims = detail ? vacuumDims({ labelWidthMm: detail.dims.widthMm, infoHeightMm: detail.dims.infoHeightMm, priceHeightMm: detail.dims.priceHeightMm }) : null;
  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <p className="max-w-3xl text-stone-600">Todo paquete envasado queda registrado con su precio, fechas, lote y código. Se puede consultar por lote y reimprimir tal como salió.</p>
    <SectionTabs tabs={VACUUM_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}

    {detail && dims ? <section className="mt-6 rounded-xl bg-white p-5 shadow-sm" data-testid="vacuum-package-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black">{detail.productName} — lote {detail.lot}</h2>
          <p className="mt-1 text-sm text-stone-600">{detail.branchName} · {weightText(detail.weightGrams)} × {moneyText(detail.pricePerKgCents)}/kg = <strong>{moneyText(detail.totalCents)}</strong></p>
          <p className="text-sm text-stone-600">Elaboración {formatIsoDate(detail.packedOn)} · vencimiento {formatIsoDate(detail.expiresOn)} · EAN-13 {detail.ean13}</p>
          <p className="text-xs text-stone-500">Registrado {formatLocalDateTime(detail.createdAt, context.timezone)}{detail.createdBy ? ` por ${detail.createdBy}` : ""} · {detail.printCount} impresión{detail.printCount === 1 ? "" : "es"}</p>
        </div>
        <Link className="rounded-lg border px-3 py-2 text-sm font-bold" href={href({})}>Cerrar</Link>
      </div>
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <VacuumLabelPreview layout={buildPriceLabelLayout(packageToLabelData(detail), dims)} title="Etiqueta de precio / caja" />
        <VacuumLabelPreview layout={buildInfoLabelLayout(packageToLabelData(detail), dims)} title="Etiqueta informativa / elaboración" />
      </div>
      <div className="mt-4"><VacuumReprintButtons packageId={detail.id} /></div>
      <p className="mt-3 text-xs text-stone-500">Estas etiquetas se arman con los datos guardados al envasar (precio, textos y esquema del código de ese momento), no con los valores de hoy.</p>
    </section> : packageId ? <p className="mt-5 rounded-lg bg-amber-50 p-4 text-amber-800">No se encontró el paquete.</p> : null}

    <form className="mt-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-[1fr_12rem_9rem_9rem_auto]">
      <input className={input} defaultValue={search} name="q" placeholder="Buscar por lote, corte o EAN-13…" type="search" />
      <select aria-label="Corte" className={input} defaultValue={productId} name="product"><option value="">Todos los cortes</option>{products.map((product) => <option key={product.productId} value={product.productId}>{product.name}</option>)}</select>
      <label className="grid gap-1 text-xs font-bold text-stone-500">Desde<input className={`${input} font-normal text-stone-900`} defaultValue={from} name="from" type="date" /></label>
      <label className="grid gap-1 text-xs font-bold text-stone-500">Hasta<input className={`${input} font-normal text-stone-900`} defaultValue={to} name="to" type="date" /></label>
      <button className="self-end rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold">Filtrar</button>
    </form>
    <p className="mt-3 text-sm text-stone-500">{list.total} paquete{list.total === 1 ? "" : "s"}</p>

    <section className="mt-3 overflow-hidden rounded-xl bg-white shadow-sm">
      <div className="overflow-x-auto"><table className="w-full min-w-[1100px] text-left text-sm" data-testid="vacuum-recent">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-4">Corte / lote</th><th className="p-4">Peso</th><th className="p-4">Precio</th><th className="p-4">Estado</th><th className="p-4">Fechas</th><th className="p-4">EAN-13</th><th className="p-4">Impresiones</th><th className="p-4 text-right">Acciones</th></tr></thead>
        <tbody>{list.rows.map((row) => (
          <tr className="border-b border-stone-100 last:border-0" key={row.id}>
            <td className="p-4"><strong>{row.productName}</strong><span className="block text-xs text-stone-500">{row.lot} · {row.branchName}</span></td>
            <td className="p-4">{weightText(row.weightGrams)}<span className="block text-xs text-stone-500">{moneyText(row.pricePerKgCents)}/kg</span></td>
            <td className="p-4 font-bold">{moneyText(row.totalCents)}</td>
            <td className="p-4 text-xs" data-testid="vacuum-package-status"><strong>{VACUUM_PACKAGE_STATUS_LABELS[row.status]}</strong>{row.currentBranchName ? <span className="block text-stone-500">en {row.currentBranchName}</span> : null}{row.status === "AVAILABLE" ? <VacuumPackageActions branches={branches} currentBranchId={row.currentBranchId} packageId={row.id} /> : null}</td>
            <td className="p-4 text-xs text-stone-600">Elab. {formatIsoDate(row.packedOn)}<br />Venc. {formatIsoDate(row.expiresOn)}</td>
            <td className="p-4 font-mono text-xs">{row.ean13}</td>
            <td className="p-4 text-xs text-stone-500">{row.printCount}{row.lastPrintedAt ? <span className="block">{formatLocalDateTime(row.lastPrintedAt, context.timezone)}</span> : null}</td>
            <td className="p-4"><div className="grid justify-items-end gap-2"><Link className="rounded-lg border px-2.5 py-1.5 text-xs font-bold" href={href({ package: row.id })}>Ver</Link><VacuumReprintButtons compact packageId={row.id} /></div></td>
          </tr>
        ))}</tbody>
      </table></div>
      {list.rows.length === 0 ? <p className="p-8 text-center text-stone-500">{search || from || to || productId ? "No hay paquetes para estos filtros." : "Todavía no se envasó ningún paquete."}</p> : null}
    </section>

    {totalPages > 1 ? <nav aria-label="Paginación" className="mt-3 flex items-center justify-between text-sm">
      {page > 1 ? <Link className="font-bold text-rose-800 hover:underline" href={href({ page: String(page - 1) })}>← Anterior</Link> : <span />}
      <span className="text-stone-500">Página {page} de {totalPages}</span>
      {page < totalPages ? <Link className="font-bold text-rose-800 hover:underline" href={href({ page: String(page + 1) })}>Siguiente →</Link> : <span />}
    </nav> : null}
  </main>;
}
