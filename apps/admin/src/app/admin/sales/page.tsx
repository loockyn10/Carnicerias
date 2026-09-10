import Link from "next/link";
import { redirect } from "next/navigation";

import { formatCurrency, formatWeight } from "@carnicerias/business-logic";

import { createClient } from "../../../lib/supabase/server";

const PAYMENT_LABELS: Record<string, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  DEBIT: "Débito",
  CREDIT: "Crédito",
  OTHER: "Otro"
};

function formatDate(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone
  }).format(new Date(value));
}

export default async function SalesPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login");

  const { data: membership, error: membershipError } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("profile_id", authData.user.id)
    .eq("status", "ACTIVE")
    .limit(1)
    .maybeSingle();

  if (membershipError || !membership) {
    return <main className="p-8 text-red-800">No se pudo resolver una organización activa.</main>;
  }

  const [{ data: organization }, salesResult, branchesResult, profilesResult, productsResult, stockResult] =
    await Promise.all([
      supabase
        .from("organizations")
        .select("name, timezone")
        .eq("id", membership.organization_id)
        .maybeSingle(),
      supabase
        .from("sales")
        .select("id, branch_id, profile_id, status, total_cents, total_weight_grams, created_at, completed_at")
        .eq("organization_id", membership.organization_id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("branches")
        .select("id, name")
        .eq("organization_id", membership.organization_id),
      supabase.from("profiles").select("id, display_name"),
      supabase
        .from("products")
        .select("id, name")
        .eq("organization_id", membership.organization_id),
      supabase
        .from("stock_levels")
        .select("branch_id, product_id, quantity_grams, last_movement_at")
        .eq("organization_id", membership.organization_id)
    ]);

  const sales = salesResult.data ?? [];
  const saleIds = sales.map((sale) => sale.id);
  const [{ data: items, error: itemsError }, { data: payments, error: paymentsError }] = saleIds.length
    ? await Promise.all([
        supabase
          .from("sale_items")
          .select("id, sale_id, product_name_snapshot, weight_grams, price_per_kg_cents, subtotal_cents")
          .in("sale_id", saleIds)
          .order("created_at"),
        supabase
          .from("payments")
          .select("id, sale_id, method, amount_cents")
          .in("sale_id", saleIds)
          .order("created_at")
      ])
    : [{ data: [], error: null }, { data: [], error: null }];

  const error = [
    salesResult.error,
    branchesResult.error,
    profilesResult.error,
    productsResult.error,
    stockResult.error,
    itemsError,
    paymentsError
  ].find(Boolean);

  const branches = new Map((branchesResult.data ?? []).map((branch) => [branch.id, branch.name]));
  const profiles = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile.display_name]));
  const products = new Map((productsResult.data ?? []).map((product) => [product.id, product.name]));
  const timeZone = organization?.timezone ?? "America/Argentina/Buenos_Aires";

  return (
    <main className="min-h-screen bg-stone-100 p-5 sm:p-10">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-wider text-rose-800">{organization?.name ?? "Administración"}</p>
            <h1 className="mt-2 text-3xl font-black text-stone-950">Ventas y stock</h1>
            <p className="mt-2 text-stone-600">Últimas 100 ventas visibles según organización, sucursal y RLS.</p>
          </div>
          <Link className="rounded-lg border border-stone-300 bg-white px-4 py-2 font-semibold hover:bg-stone-50" href="/admin">Volver</Link>
        </div>

        {error ? <p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">Error de consulta: {error.message}</p> : null}

        <section className="mt-8 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
          <div className="border-b border-stone-200 p-5"><h2 className="text-xl font-black">Ventas</h2></div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] border-collapse text-left text-sm">
              <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                <tr><th className="p-4">Fecha</th><th className="p-4">Sucursal</th><th className="p-4">Empleado</th><th className="p-4">Peso</th><th className="p-4">Pago</th><th className="p-4 text-right">Total</th><th className="p-4">Detalle</th></tr>
              </thead>
              <tbody>
                {sales.map((sale) => {
                  const saleItems = (items ?? []).filter((item) => item.sale_id === sale.id);
                  const salePayments = (payments ?? []).filter((payment) => payment.sale_id === sale.id);
                  return (
                    <tr className="border-t border-stone-100 align-top" key={sale.id}>
                      <td className="p-4 whitespace-nowrap">{formatDate(sale.completed_at ?? sale.created_at, timeZone)}</td>
                      <td className="p-4 font-semibold">{branches.get(sale.branch_id) ?? sale.branch_id.slice(0, 8)}</td>
                      <td className="p-4">{profiles.get(sale.profile_id) ?? sale.profile_id.slice(0, 8)}</td>
                      <td className="p-4 whitespace-nowrap">{formatWeight(sale.total_weight_grams)}</td>
                      <td className="p-4">{salePayments.map((payment) => PAYMENT_LABELS[payment.method] ?? payment.method).join(" + ") || "—"}</td>
                      <td className="p-4 text-right text-lg font-black text-rose-800">{formatCurrency(BigInt(sale.total_cents))}</td>
                      <td className="p-4">
                        <details>
                          <summary className="cursor-pointer font-semibold text-rose-800">{saleItems.length} ítems</summary>
                          <ul className="mt-3 min-w-64 space-y-2">
                            {saleItems.map((item) => (
                              <li className="rounded-lg bg-stone-50 p-3" key={item.id}>
                                <strong>{item.product_name_snapshot}</strong>
                                <span className="block text-stone-600">{formatWeight(item.weight_grams)} · {formatCurrency(BigInt(item.price_per_kg_cents))}/kg</span>
                                <span className="block font-semibold">{formatCurrency(BigInt(item.subtotal_cents))}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </td>
                    </tr>
                  );
                })}
                {!sales.length ? <tr><td className="p-8 text-center text-stone-500" colSpan={7}>Todavía no hay ventas visibles.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-8 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-xl font-black">Stock actual derivado</h2>
          <p className="mt-1 text-sm text-stone-600">Suma del ledger por sucursal y producto; no existe una columna mutable paralela.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {(stockResult.data ?? []).map((level) => (
              <article className="rounded-xl border border-stone-200 bg-stone-50 p-4" key={`${level.branch_id ?? "unknown-branch"}-${level.product_id ?? "unknown-product"}`}>
                <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{level.branch_id ? branches.get(level.branch_id) : "Sucursal"}</p>
                <h3 className="mt-1 font-black">{level.product_id ? products.get(level.product_id) : "Producto"}</h3>
                <p className={`mt-3 text-2xl font-black ${(level.quantity_grams ?? 0) < 0 ? "text-red-700" : "text-emerald-700"}`}>{formatWeight(level.quantity_grams ?? 0)}</p>
              </article>
            ))}
            {!stockResult.data?.length ? <p className="text-stone-500">Sin movimientos de stock todavía.</p> : null}
          </div>
        </section>
      </div>
    </main>
  );
}
