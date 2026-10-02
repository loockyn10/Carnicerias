import Link from "next/link";

import { StatusBadge } from "../../../components/admin-ui";
import { SupplierActiveToggle, SupplierModal } from "../../../components/supplier-modal";
import { requireAdminContext } from "../../../lib/admin";
import { createPerfLogger } from "../../../lib/perf";
import { createClient } from "../../../lib/supabase/server";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const PAGE_SIZE = 50;

/**
 * Configuración → Proveedores. Base de proveedores y su vínculo con productos: listar, buscar, crear,
 * editar, activar/desactivar y ver cuántos productos tiene cada uno. Sin cuentas corrientes, pagos,
 * órdenes de compra, balances ni facturas de proveedor (no son parte de este sprint).
 */
export default async function SuppliersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/suppliers");
  await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const status = ["active", "inactive", "all"].includes(value("status")) ? value("status") : "all";
  const search = value("q").trim();
  const page = Math.max(1, Number.parseInt(value("page") || "1", 10) || 1);

  const supabase = await createClient();
  const { data, error } = await perf.measure("suppliersPage", supabase.rpc("list_suppliers_page", {
    p_status: status, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE, ...(search ? { p_search: search } : {})
  }));
  perf.flush();

  const rows = data ?? [];
  const total = rows[0]?.total_count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (target: number) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (status !== "all") query.set("status", status);
    if (target > 1) query.set("page", String(target));
    const text = query.toString();
    return text ? `/admin/suppliers?${text}` : "/admin/suppliers";
  };

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <nav aria-label="Ruta" className="text-sm text-stone-500">
      <Link className="hover:text-rose-800" href="/admin">Inicio</Link> / <Link className="hover:text-rose-800" href="/admin/settings">Configuración</Link> / <span className="text-stone-700">Proveedores</span>
    </nav>
    <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-black tracking-tight">Proveedores</h1>
        <p className="mt-2 text-stone-600">A quién le comprás cada producto. El proveedor principal se asigna al editar el producto o al importar desde SimplyGest.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link className="rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 hover:bg-stone-50" href="/admin/settings">← Volver a Configuración</Link>
        <SupplierModal />
      </div>
    </div>

    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}

    <form className="mt-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-[1fr_11rem_auto]">
      <input className={input} defaultValue={search} name="q" placeholder="Buscar por nombre, código o CUIT…" type="search" />
      <select className={input} defaultValue={status} name="status"><option value="all">Todos</option><option value="active">Activos</option><option value="inactive">Inactivos</option></select>
      <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold">Filtrar</button>
    </form>
    <p className="mt-3 text-sm text-stone-500">{total} proveedor{total === 1 ? "" : "es"}</p>

    <section className="mt-5 overflow-hidden rounded-xl bg-white shadow-sm">
      <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-4">Proveedor</th><th className="p-4">CUIT</th><th className="p-4">Contacto</th><th className="p-4">Productos</th><th className="p-4">Estado</th><th className="p-4 text-right">Acciones</th></tr></thead>
        <tbody>{rows.map((row) => <tr className="border-b border-stone-100 last:border-0" key={row.supplier_id}>
          <td className="p-4"><strong>{row.name}</strong>{row.code ? <p className="text-xs text-stone-500">Código {row.code}</p> : null}{row.notes ? <p className="mt-1 max-w-xs truncate text-xs text-stone-400" title={row.notes}>{row.notes}</p> : null}</td>
          <td className="p-4 text-stone-600">{row.tax_id ?? "—"}</td>
          <td className="p-4 text-xs text-stone-600">{row.phone ?? "—"}{row.email ? <span className="block">{row.email}</span> : null}</td>
          <td className="p-4"><strong>{row.product_count.toLocaleString("es-AR")}</strong><span className="block text-xs text-stone-500">como principal</span></td>
          <td className="p-4"><StatusBadge tone={row.active ? "success" : "neutral"}>{row.active ? "Activo" : "Inactivo"}</StatusBadge></td>
          <td className="p-4 text-right"><div className="flex flex-wrap justify-end gap-2">
            <SupplierModal supplier={{ id: row.supplier_id, name: row.name, code: row.code, taxId: row.tax_id, phone: row.phone, email: row.email, notes: row.notes, active: row.active }} />
            <SupplierActiveToggle supplier={{ id: row.supplier_id, name: row.name, active: row.active }} />
          </div></td>
        </tr>)}</tbody>
      </table></div>
      {rows.length === 0 ? <p className="p-8 text-center text-stone-500">{search || status !== "all" ? "No hay proveedores para estos filtros." : "Todavía no hay proveedores. Se crean acá o automáticamente al importar productos desde SimplyGest."}</p> : null}
    </section>

    {totalPages > 1 ? <nav aria-label="Paginación" className="mt-3 flex items-center justify-between text-sm">
      {page > 1 ? <Link className="font-bold text-rose-800 hover:underline" href={pageHref(page - 1)}>← Anterior</Link> : <span />}
      <span className="text-stone-500">Página {page} de {totalPages}</span>
      {page < totalPages ? <Link className="font-bold text-rose-800 hover:underline" href={pageHref(page + 1)}>Siguiente →</Link> : <span />}
    </nav> : null}
  </main>;
}
