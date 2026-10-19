import { LabelGroupsWorkspace, type BranchOption, type LabelRunDetail, type LabelRunRow } from "../../../../components/label-groups-workspace";
import { LabelModeTabs } from "../../../../components/label-mode-tabs";
import { SectionTabs } from "../../../../components/section-tabs";
import { requireAdminContext } from "../../../../lib/admin";
import { describeValues } from "../../../../lib/label-changes";
import { buildLabelGroupView, parseLabelBranchGroups, parseLabelGroupFacts, parseLabelGroupList } from "../../../../lib/label-group";
import { formatIsoStamp } from "../../../../lib/label-stamp";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";
import { PRODUCTOS_TABS } from "../../products-tabs";
import { OfferSignsView } from "./offers-view";

export default async function ProductLabelsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  if (value("mode") === "offers") {
    return <main className="mx-auto max-w-6xl p-5 sm:p-8">
      <div><p className="text-sm text-stone-500">Inicio / Productos</p><h1 className="mt-1 text-3xl font-black tracking-tight">Productos</h1><p className="mt-2 text-stone-600">Catálogo y precios vigentes.</p></div>
      <SectionTabs tabs={PRODUCTOS_TABS} />
      <LabelModeTabs active="offers" />
      <OfferSignsView organizationId={context.organizationId} requestedBranch={value("branch")} />
    </main>;
  }
  const requestedGroup = value("group");
  const requestedBranch = value("branch");
  const requestedRun = value("run");
  const supabase = await createClient();

  const [groupsResult, branchesResult, runsResult] = await Promise.all([
    supabase.rpc("list_label_groups", { p_include_inactive: true }),
    supabase.from("branches").select("id, name, active").eq("organization_id", context.organizationId).order("name"),
    supabase.from("product_label_print_runs").select("id, group_id, generated_at, label_count, product_count").eq("organization_id", context.organizationId).order("generated_at", { ascending: false }).limit(10)
  ]);
  const allGroups = parseLabelGroupList(groupsResult.data);
  const groups = allGroups.filter((entry) => entry.active);
  const explicitlySelected = requestedGroup && requestedGroup !== "all" ? groups.find((entry) => entry.groupId === requestedGroup) ?? null : null;
  const selectedBranchId = branchesResult.data?.some((branch) => branch.id === requestedBranch)
    ? requestedBranch
    : explicitlySelected?.branchId ?? groups.find((entry) => entry.branchId)?.branchId ?? branchesResult.data?.[0]?.id ?? null;
  const allMode = requestedGroup === "all" || !explicitlySelected;
  const selected = allMode ? null : explicitlySelected;

  const [factsResult, branchGroupsResult] = await Promise.all([
    selected && !selected.branchId ? supabase.rpc("get_label_group", { p_group_id: selected.groupId }) : Promise.resolve(null),
    selectedBranchId ? supabase.rpc("get_label_branch_groups", { p_branch_id: selectedBranchId }) : Promise.resolve(null)
  ]);
  const branchFacts = branchGroupsResult?.data ? parseLabelBranchGroups(branchGroupsResult.data) : [];
  const facts = selected?.branchId ? branchFacts.find((entry) => entry.groupId === selected.groupId) ?? null : factsResult?.data ? parseLabelGroupFacts(factsResult.data) : null;
  const group = facts ? buildLabelGroupView(facts, context.timezone) : null;
  const branchGroups = branchFacts.map((entry) => buildLabelGroupView(entry, context.timezone));
  const displayGroup = group ?? branchGroups[0] ?? null;

  const groupName = (id: string) => allGroups.find((entry) => entry.groupId === id)?.name ?? "Grupo archivado";
  const runs: LabelRunRow[] = (runsResult.data ?? []).map((run) => ({
    id: run.id, groupId: run.group_id, groupName: groupName(run.group_id), whenText: formatIsoStamp(run.generated_at, context.timezone),
    labelCount: run.label_count, productCount: run.product_count
  }));

  // Detalle de una generación (sólo si es de mi organización: la consulta ya filtra por ella y por RLS).
  let runDetail: LabelRunDetail | null = null;
  let detailError: string | null = null;
  if (isUuid(requestedRun)) {
    const [runResult, itemsResult] = await Promise.all([
      supabase.from("product_label_print_runs").select("id, group_id, generated_at, label_count, product_count").eq("organization_id", context.organizationId).eq("id", requestedRun).maybeSingle(),
      supabase.from("product_label_print_run_items").select("displayed_name, copies, unit_type, list_price_cents, promo_price_cents, promo_minimum_units, promo_discount_bps, condition_text, position")
        .eq("organization_id", context.organizationId).eq("run_id", requestedRun).order("position")
    ]);
    detailError = runResult.error?.message ?? itemsResult.error?.message ?? null;
    if (runResult.data) {
      runDetail = {
        run: {
          id: runResult.data.id, groupId: runResult.data.group_id, groupName: groupName(runResult.data.group_id),
          whenText: formatIsoStamp(runResult.data.generated_at, context.timezone), labelCount: runResult.data.label_count, productCount: runResult.data.product_count
        },
        items: (itemsResult.data ?? []).map((row) => ({
          productName: row.displayed_name, copies: row.copies, condition: row.condition_text,
          text: describeValues({
            displayedName: row.displayed_name, listPriceCents: String(row.list_price_cents),
            promoPriceCents: row.promo_price_cents === null ? null : String(row.promo_price_cents),
            promoMinimumUnits: row.promo_minimum_units, promoDiscountBps: row.promo_discount_bps
          }, row.unit_type)
        }))
      };
    }
  }

  const error = [groupsResult.error, branchesResult.error, runsResult.error, factsResult?.error, branchGroupsResult?.error].find(Boolean)?.message ?? detailError;
  const branches: BranchOption[] = (branchesResult.data ?? []).map((branch) => ({ id: branch.id, name: branch.name, active: branch.active }));

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div><p className="text-sm text-stone-500">Inicio / Productos</p><h1 className="mt-1 text-3xl font-black tracking-tight">Productos</h1><p className="mt-2 text-stone-600">Catálogo y precios vigentes.</p></div>
    <SectionTabs tabs={PRODUCTOS_TABS} />
    <LabelModeTabs active="gondola" />
    <div className="mt-6">
      <h2 className="text-xl font-black">Etiquetas de góndola</h2>
      <p className="mt-1 text-sm text-stone-600">Armá un grupo con los productos que llevan etiqueta física, elegí cuáles imprimir y descargá un PDF A4 (21 etiquetas de 60 × 40 mm por hoja) para imprimir al 100 % y cortar con tijera.</p>
    </div>
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error}</p> : null}
    <LabelGroupsWorkspace
      branches={branches}
      branchGroups={branchGroups}
      branchId={selectedBranchId}
      allMode={allMode}
      group={displayGroup}
      groups={groups.map((entry) => ({ groupId: entry.groupId, name: entry.name, branchId: entry.branchId, branchName: entry.branchName, itemCount: entry.itemCount }))}
      runDetail={runDetail}
      runs={runs}
    />
  </main>;
}
