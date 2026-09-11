import { formatCurrency, formatWeight } from "@carnicerias/business-logic";

import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";
import { cancelSaleAction } from "../actions";

const PAYMENT_LABELS: Record<string, string> = { CASH: "Efectivo", TRANSFER: "Transferencia", DEBIT: "Débito", CREDIT: "Crédito", OTHER: "Otro" };
const MOVEMENT_LABELS: Record<string, string> = { SALE: "Venta", RETURN: "Reposición por anulación" };
const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

function localDate(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function ranges(preset: string, from: string, to: string, timeZone: string) {
  const today = localDate(timeZone);
  const current = new Date(`${today}T12:00:00Z`);
  if (preset === "yesterday") current.setUTCDate(current.getUTCDate() - 1);
  if (preset === "week") current.setUTCDate(current.getUTCDate() - ((current.getUTCDay() + 6) % 7));
  if (preset === "month") current.setUTCDate(1);
  const startDate = preset === "custom" && from ? from : current.toISOString().slice(0, 10);
  const endDate = preset === "custom" && to ? to : preset === "yesterday" ? current.toISOString().slice(0, 10) : today;
  return { start: `${startDate}T00:00:00-03:00`, end: `${endDate}T23:59:59.999-03:00` };
}

export default async function SalesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const preset = value("preset") || "today";
  const period = ranges(preset, value("from"), value("to"), context.timezone);
  const supabase = await createClient();

  const [branchesResult, profilesResult, productsResult] = await Promise.all([
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).order("name"),
    supabase.from("profiles").select("id, display_name"),
    supabase.from("products").select("id, name").eq("organization_id", context.organizationId)
  ]);

  let paymentSaleIds: string[] | null = null;
  if (value("payment")) {
    const paymentResult = await supabase.from("payments").select("sale_id").eq("organization_id", context.organizationId).eq("method", value("payment") as "CASH" | "TRANSFER" | "DEBIT" | "CREDIT" | "OTHER");
    paymentSaleIds = (paymentResult.data ?? []).map((row) => row.sale_id);
  }

  let query = supabase.from("sales").select("id, branch_id, profile_id, status, total_cents, total_weight_grams, created_at, completed_at, cancelled_at, cancelled_by, cancellation_reason").eq("organization_id", context.organizationId).gte("completed_at", period.start).lte("completed_at", period.end).order("completed_at", { ascending: false }).limit(200);
  if (value("branch")) query = query.eq("branch_id", value("branch"));
  if (value("employee")) query = query.eq("profile_id", value("employee"));
  if (value("status")) query = query.eq("status", value("status") as "DRAFT" | "COMPLETED" | "CANCELLED" | "REFUNDED");
  if (paymentSaleIds) query = query.in("id", paymentSaleIds.length ? paymentSaleIds : ["00000000-0000-0000-0000-000000000000"]);
  const salesResult = await query;
  const sales = salesResult.data ?? [];
  const saleIds = sales.map((sale) => sale.id);
  const [{ data: items, error: itemsError }, { data: payments, error: paymentsError }, { data: movements, error: movementsError }] = saleIds.length ? await Promise.all([
    supabase.from("sale_items").select("id, sale_id, product_name_snapshot, weight_grams, price_per_kg_cents, subtotal_cents").in("sale_id", saleIds).order("created_at"),
    supabase.from("payments").select("id, sale_id, method, amount_cents").in("sale_id", saleIds).order("created_at"),
    supabase.from("stock_movements").select("id, sale_id, type, quantity_grams, reason, occurred_at").in("sale_id", saleIds).order("occurred_at")
  ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];

  const error = [salesResult.error, branchesResult.error, profilesResult.error, productsResult.error, itemsError, paymentsError, movementsError].find(Boolean);
  const branches = new Map((branchesResult.data ?? []).map((item) => [item.id, item.name]));
  const profiles = new Map((profilesResult.data ?? []).map((item) => [item.id, item.display_name]));

  return <main className="mx-auto max-w-7xl p-5 sm:p-10"><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Historial</p><h1 className="mt-1 text-3xl font-black">Ventas</h1><p className="mt-2 text-stone-600">La consulta se filtra en PostgreSQL y devuelve hasta 200 ventas; los totales del dashboard no se agregan en el navegador.</p>
    <form className="mt-6 grid gap-3 rounded-2xl border bg-white p-4 shadow-sm md:grid-cols-3 xl:grid-cols-7"><select className={input} defaultValue={preset} name="preset"><option value="today">Hoy</option><option value="yesterday">Ayer</option><option value="week">Esta semana</option><option value="month">Este mes</option><option value="custom">Rango</option></select><input className={input} defaultValue={value("from")} name="from" type="date" /><input className={input} defaultValue={value("to")} name="to" type="date" /><select className={input} defaultValue={value("branch")} name="branch"><option value="">Todas las sucursales</option>{(branchesResult.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select className={input} defaultValue={value("employee")} name="employee"><option value="">Todos los empleados</option>{(profilesResult.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select><select className={input} defaultValue={value("payment")} name="payment"><option value="">Todos los pagos</option>{Object.entries(PAYMENT_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><div className="flex gap-2"><select className={`${input} min-w-0 flex-1`} defaultValue={value("status")} name="status"><option value="">Todos</option><option value="COMPLETED">Completadas</option><option value="CANCELLED">Anuladas</option></select><button className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white">Filtrar</button></div></form>
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <section className="mt-7 space-y-4">{sales.map((sale) => { const saleItems = (items ?? []).filter((item) => item.sale_id === sale.id); const salePayments = (payments ?? []).filter((payment) => payment.sale_id === sale.id); const saleMovements = (movements ?? []).filter((movement) => movement.sale_id === sale.id); return <article className="rounded-2xl border bg-white p-5 shadow-sm" key={sale.id}><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase text-stone-500">{new Date(sale.completed_at ?? sale.created_at).toLocaleString("es-AR", { timeZone: context.timezone })}</p><h2 className="mt-1 text-xl font-black">{branches.get(sale.branch_id)} · {profiles.get(sale.profile_id)}</h2><p className="text-sm text-stone-500">#{sale.id} · {salePayments.map((payment) => PAYMENT_LABELS[payment.method]).join(" + ")}</p></div><div className="text-right"><span className={`rounded-full px-3 py-1 text-xs font-black ${sale.status === "CANCELLED" ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}`}>{sale.status === "CANCELLED" ? "ANULADA" : sale.status}</span><p className="mt-2 text-2xl font-black text-rose-800">{formatCurrency(BigInt(sale.total_cents))}</p><p className="text-sm text-stone-500">{formatWeight(sale.total_weight_grams)}</p></div></div>
      <details className="mt-4"><summary className="cursor-pointer font-bold text-rose-800">Detalle ({saleItems.length} ítems)</summary><ul className="mt-3 grid gap-2 md:grid-cols-2">{saleItems.map((item) => <li className="rounded-lg bg-stone-50 p-3" key={item.id}><strong>{item.product_name_snapshot}</strong><p className="text-sm text-stone-600">{formatWeight(item.weight_grams)} · {formatCurrency(BigInt(item.price_per_kg_cents))}/kg</p><p className="font-bold">{formatCurrency(BigInt(item.subtotal_cents))}</p></li>)}</ul><h3 className="mt-4 font-bold">Movimientos relacionados</h3><ul className="mt-2 space-y-1 text-sm">{saleMovements.map((movement) => <li key={movement.id}>{MOVEMENT_LABELS[movement.type] ?? movement.type}: <strong>{movement.quantity_grams > 0 ? "+" : ""}{formatWeight(movement.quantity_grams)}</strong>{movement.reason ? ` · ${movement.reason}` : ""}</li>)}</ul></details>
      {sale.status === "CANCELLED" ? <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">Anulada {sale.cancelled_at ? new Date(sale.cancelled_at).toLocaleString("es-AR", { timeZone: context.timezone }) : ""} por {sale.cancelled_by ? profiles.get(sale.cancelled_by) : "—"}: {sale.cancellation_reason}</p> : null}
      {sale.status === "COMPLETED" ? <form action={cancelSaleAction} className="mt-4 flex flex-wrap gap-2 border-t pt-4"><input name="sale_id" type="hidden" value={sale.id} /><input name="idempotency_key" type="hidden" value={crypto.randomUUID()} /><input className={`${input} min-w-64 flex-1`} minLength={3} name="reason" placeholder="Motivo obligatorio de anulación" required /><button className="rounded-lg border border-red-300 px-4 py-2 font-bold text-red-800">Anular y reponer stock</button></form> : null}
    </article>; })}{!sales.length ? <p className="rounded-2xl border bg-white p-8 text-center text-stone-500">No hay ventas para los filtros elegidos.</p> : null}</section>
  </main>;
}
