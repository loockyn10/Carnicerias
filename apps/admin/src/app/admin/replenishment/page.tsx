import { ReplenishmentDashboard } from "../../../components/replenishment-dashboard";
import { requireAdminContext } from "../../../lib/admin";
import { createPerfLogger } from "../../../lib/perf";
import { calculateReplenishment } from "../../../lib/replenishment";
import { createClient } from "../../../lib/supabase/server";

export default async function ReplenishmentPage() {
  const perf = createPerfLogger("/admin/replenishment");
  const contextStartedAt = performance.now();
  const context = await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const supabase = await createClient();
  const [planResult, branchesResult, settingsResult] = await Promise.all([
    perf.measure("replenishmentPlan", supabase.rpc("get_replenishment_plan", { p_days: 7 })),
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("settings", supabase.from("organizations").select("replenishment_target_days").eq("id", context.organizationId).single())
  ]);
  const error = planResult.error ?? branchesResult.error ?? settingsResult.error;
  if (error) {
    perf.flush();
    return <main className="mx-auto max-w-7xl p-5 text-red-800 sm:p-10">No se pudo cargar la reposición: {error.message}</main>;
  }

  const transformStartedAt = performance.now();
  const rows = (planResult.data ?? []).map((row) => calculateReplenishment({
    branchId: row.branch_id,
    branchName: row.branch_name,
    productId: row.product_id,
    productName: row.product_name,
    unitType: row.unit_type,
    currentQuantity: row.current_quantity,
    minimumQuantity: row.minimum_quantity,
    manualTargetQuantity: row.target_quantity,
    soldRecentQuantity: row.sold_recent_quantity,
    salesDays: row.sales_days,
    targetCoverageDays: row.target_coverage_days
  }));
  const targetDays = settingsResult.data?.replenishment_target_days ?? rows[0]?.targetCoverageDays ?? 3;
  perf.mark("transform", transformStartedAt);
  perf.flush();

  return <main className="mx-auto max-w-7xl p-5 sm:p-10">
    <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Operación diaria</p>
    <h1 className="mt-1 text-3xl font-black">Qué llevar hoy</h1>
    <p className="mt-2 text-stone-600">Prioridad calculada con stock teórico, objetivos configurados y ventas completadas de los últimos 7 días.</p>
    <ReplenishmentDashboard branches={branchesResult.data ?? []} rows={rows} targetDays={targetDays} />
  </main>;
}
