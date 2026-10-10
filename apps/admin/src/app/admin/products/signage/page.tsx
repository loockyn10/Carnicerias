import Link from "next/link";

import { SignageCreateForm, SignageEditor, type BranchOption } from "../../../../components/signage-editor";
import { SectionTabs } from "../../../../components/section-tabs";
import { SignageSubnav } from "../../../../components/signage-subnav";
import { requireAdminContext } from "../../../../lib/admin";
import { buildEditorDisplay } from "../../../../lib/signage";
import { parsePromotionCatalog } from "../../../../lib/signage-promotions";
import { createClient } from "../../../../lib/supabase/server";
import { PRODUCTOS_TABS } from "../../products-tabs";

export default async function SignagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const requestedId = typeof params.display === "string" ? params.display : "";
  const supabase = await createClient();

  const [displaysResult, branchesResult] = await Promise.all([
    // Columnas explícitas: el hash del token no es legible desde el cliente.
    supabase.from("digital_signage_displays").select("id, name, enabled, branch_id").eq("organization_id", context.organizationId).order("created_at"),
    supabase.from("branches").select("id, name, active").eq("organization_id", context.organizationId).order("name")
  ]);
  const displays = displaysResult.data ?? [];
  const selected = displays.find((display) => display.id === requestedId) ?? displays[0] ?? null;
  const [detailResult, catalogResult] = selected ? await Promise.all([
    supabase.rpc("get_signage_display_admin", { p_display_id: selected.id }),
    // Promociones ya cargadas (las que le aplican a ESTA pantalla: su sucursal y su vigencia) y los grupos reutilizables.
    supabase.rpc("get_signage_promotion_catalog", { p_branch_id: selected.branch_id, p_applicable_only: true })
  ]) : [null, null];
  const editorDisplay = detailResult?.data ? buildEditorDisplay(detailResult.data) : null;
  // El catálogo es un complemento: si falla, el editor sigue funcionando con productos (sin promociones ni grupos para elegir).
  const catalog = catalogResult?.data ? parsePromotionCatalog(catalogResult.data) : { promotions: [], groups: [] };
  const error = [displaysResult.error, branchesResult.error, detailResult?.error].find(Boolean);
  const branches: BranchOption[] = (branchesResult.data ?? []).map((branch) => ({ id: branch.id, name: branch.name, active: branch.active }));
  const branchName = (id: string | null) => branches.find((branch) => branch.id === id)?.name ?? "Sin sucursal";

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div><p className="text-sm text-stone-500">Inicio / Productos</p><h1 className="mt-1 text-3xl font-black tracking-tight">Productos</h1><p className="mt-2 text-stone-600">Catálogo y precios vigentes.</p></div>
    <SectionTabs active="/admin/products/artwork" tabs={PRODUCTOS_TABS} />
    <SignageSubnav active="screens" />
    <div className="mt-6">
      <h2 className="text-xl font-black">Cartelería digital</h2>
      <p className="mt-1 text-sm text-stone-600">Un televisor abre su enlace y muestra las ofertas en un carrusel, con los precios y promociones vigentes del sistema. Se actualiza solo.</p>
    </div>
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <div className="mt-5 grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside className="grid content-start gap-2" data-testid="signage-displays">
        {displays.map((display) => <Link
          className={`rounded-lg border px-3 py-2 text-sm ${display.id === selected?.id ? "border-rose-800 bg-rose-50 font-bold text-rose-800" : "border-stone-200 bg-white hover:bg-stone-50"}`}
          href={`/admin/products/signage?display=${display.id}`} key={display.id}
        >
          {display.name}
          <span className="block text-xs font-normal text-stone-500">{branchName(display.branch_id)}{display.enabled ? "" : " · desactivada"}</span>
        </Link>)}
      </aside>
      <div className="grid content-start gap-6">
        {selected && editorDisplay
          ? <SignageEditor branches={branches} catalog={catalog} display={editorDisplay} key={editorDisplay.id} />
          : null}
        <SignageCreateForm branches={branches} firstScreen={!displays.length} />
      </div>
    </div>
  </main>;
}
