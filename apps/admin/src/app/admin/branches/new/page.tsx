import Link from "next/link";

import { BranchForm } from "../../../../components/branch-form";
import { requireAdminContext } from "../../../../lib/admin";
import { createClient } from "../../../../lib/supabase/server";

export default async function NewBranchPage() {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const { data: existingBranches } = await supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name");

  return <main className="mx-auto max-w-xl p-5 sm:p-8">
    <Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/branches">← Volver a sucursales</Link>
    <p className="mt-4 text-sm font-bold uppercase tracking-wider text-rose-800">Sucursal</p>
    <h1 className="mt-1 text-3xl font-black">Nueva sucursal</h1>
    <p className="mt-2 text-stone-600">Los precios y promociones ya aplican a todas las sucursales. Cada sucursal vende sólo los productos que tiene habilitados: podés copiar el surtido de otra sucursal al crearla o habilitarlos después desde Productos.</p>
    <section className="mt-6 rounded-xl bg-white p-5 shadow-sm">
      <BranchForm copyFromOptions={existingBranches ?? []} />
    </section>
  </main>;
}
