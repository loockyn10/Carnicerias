import type { ReactNode } from "react";

import { AdminSidebar } from "../../components/admin-sidebar";
import { getAdminContext } from "../../lib/admin";
import { logout } from "./actions";

export default async function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  const context = await getAdminContext();

  if (!context) {
    return (
      <main className="grid min-h-screen place-items-center bg-stone-100 p-6">
        <section className="max-w-lg rounded-2xl border border-amber-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-bold uppercase tracking-wider text-amber-700">Acceso restringido</p>
          <h1 className="mt-2 text-2xl font-black">Este panel requiere el rol administrador</h1>
          <p className="mt-3 text-stone-600">La cuenta sigue habilitada para operar el POS en su sucursal asignada.</p>
          <form action={logout} className="mt-6"><button className="rounded-lg border px-4 py-2 font-bold">Cerrar sesión</button></form>
        </section>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f4f1] text-stone-800 lg:flex">
      <AdminSidebar />
      <div className="min-w-0 flex-1"><header className="flex min-h-16 items-center justify-between border-b border-stone-200 bg-[#fbfaf8] px-5 sm:px-8"><div><p className="text-sm font-semibold text-stone-700">{context.organizationName}</p><p className="text-xs text-stone-500">Administración</p></div><div className="flex items-center gap-3"><span className="hidden text-sm text-stone-500 sm:block">{context.email}</span><form action={logout}><button className="rounded-lg px-3 py-2 text-sm font-semibold text-stone-600 hover:bg-stone-100">Salir</button></form></div></header><div className="border-b border-stone-200 bg-[#fbfaf8] px-5 py-2 lg:hidden"><a className="mr-4 text-sm font-semibold text-rose-900" href="/admin">Inicio</a><a className="mr-4 text-sm font-semibold text-stone-600" href="/admin/sales">Ventas</a><a className="mr-4 text-sm font-semibold text-stone-600" href="/admin/stock">Stock</a><a className="text-sm font-semibold text-stone-600" href="/admin/catalog">Productos</a></div>{children}</div>
    </div>
  );
}
