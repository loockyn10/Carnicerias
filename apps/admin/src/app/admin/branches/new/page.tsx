import Link from "next/link";

import { BranchForm } from "../../../../components/branch-form";
import { requireAdminContext } from "../../../../lib/admin";

export default async function NewBranchPage() {
  await requireAdminContext();

  return <main className="mx-auto max-w-xl p-5 sm:p-8">
    <Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/branches">← Volver a sucursales</Link>
    <p className="mt-4 text-sm font-bold uppercase tracking-wider text-rose-800">Sucursal</p>
    <h1 className="mt-1 text-3xl font-black">Nueva sucursal</h1>
    <p className="mt-2 text-stone-600">Catálogo, precios y promociones existentes ya se aplican a esta sucursal apenas la crees; no hace falta duplicar nada.</p>
    <section className="mt-6 rounded-xl bg-white p-5 shadow-sm">
      <BranchForm />
    </section>
  </main>;
}
