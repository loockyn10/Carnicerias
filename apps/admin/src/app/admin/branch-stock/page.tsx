import { BranchStockMatrix, type BranchStockMatrixBranch } from "../../../components/branch-stock-matrix";
import { requireAdminContext } from "../../../lib/admin";
import { buildBranchStockRows, type BranchStockProductMeta } from "../../../lib/branch-stock";
import { createPerfLogger } from "../../../lib/perf";
import { createClient } from "../../../lib/supabase/server";

export default async function BranchStockPage() {
  const perf = createPerfLogger("/admin/branch-stock");
  const contextStartedAt = performance.now();
  const context = await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const supabase = await createClient();

  // p_days is only used by get_replenishment_plan to compute a sales window
  // (sold_recent_quantity / target_coverage_days), which this screen does not
  // use — current/minimum/target quantities come straight from stock_levels
  // and are unaffected by p_days. 1 is the RPC's minimum accepted value.
  const [planResult, branchesResult, categoriesResult, productsResult, devicesResult] = await Promise.all([
    perf.measure("plan", supabase.rpc("get_replenishment_plan", { p_days: 1 })),
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("categories", supabase.from("categories").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("sort_order")),
    perf.measure("products", supabase.from("products").select("id, category_id, sku").eq("organization_id", context.organizationId).eq("active", true)),
    perf.measure("devices", supabase.from("pos_devices").select("branch_id, last_seen_at").eq("organization_id", context.organizationId))
  ]);

  const error = [planResult.error, branchesResult.error, categoriesResult.error, productsResult.error, devicesResult.error].find(Boolean);
  if (error) {
    perf.flush();
    return (
      <main className="mx-auto max-w-7xl p-5 sm:p-10">
        <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Multisucursal</p>
        <h1 className="mt-1 text-3xl font-black">Stock por sucursal</h1>
        <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">No se pudo cargar el stock: {error.message}</p>
      </main>
    );
  }

  const transformStartedAt = performance.now();

  const lastSeenByBranch = new Map<string, string>();
  for (const device of devicesResult.data ?? []) {
    const current = lastSeenByBranch.get(device.branch_id);
    if (!current || device.last_seen_at > current) lastSeenByBranch.set(device.branch_id, device.last_seen_at);
  }
  const branches: BranchStockMatrixBranch[] = (branchesResult.data ?? []).map((branch) => ({
    id: branch.id,
    name: branch.name,
    lastSeenAt: lastSeenByBranch.get(branch.id) ?? null
  }));

  const productMeta = new Map<string, BranchStockProductMeta>(
    (productsResult.data ?? []).map((product) => [product.id, { sku: product.sku, categoryId: product.category_id }])
  );
  const rows = buildBranchStockRows(
    (planResult.data ?? []).map((entry) => ({
      branchId: entry.branch_id,
      productId: entry.product_id,
      productName: entry.product_name,
      unitType: entry.unit_type,
      currentQuantity: entry.current_quantity,
      minimumQuantity: entry.minimum_quantity
    })),
    productMeta
  );

  perf.mark("transform", transformStartedAt);
  perf.flush();

  return (
    <main className="mx-auto max-w-7xl p-5 sm:p-10">
      <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Multisucursal</p>
      <h1 className="mt-1 text-3xl font-black">Stock por sucursal</h1>
      <p className="mt-2 text-stone-600">
        Buscá un producto y compará el stock conocido por el sistema en cada sucursal. Una sucursal con ventas
        offline todavía no sincronizadas puede mostrar stock desactualizado.
      </p>
      <BranchStockMatrix branches={branches} categories={categoriesResult.data ?? []} rows={rows} />
    </main>
  );
}
