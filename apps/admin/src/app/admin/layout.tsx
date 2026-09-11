import type { ReactNode } from "react";
import Link from "next/link";

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
    <div className="min-h-screen bg-stone-100">
      <header className="border-b border-stone-800 bg-stone-950 text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div><p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-400">Carnicerías · Admin</p><p className="font-black">{context.organizationName}</p></div>
          <nav className="flex flex-wrap items-center gap-1 text-sm font-bold">
            <Link className="rounded-lg px-3 py-2 hover:bg-stone-800" href="/admin">Dashboard</Link>
            <Link className="rounded-lg px-3 py-2 hover:bg-stone-800" href="/admin/catalog">Catálogo</Link>
            <Link className="rounded-lg px-3 py-2 hover:bg-stone-800" href="/admin/stock">Stock</Link>
            <Link className="rounded-lg px-3 py-2 hover:bg-stone-800" href="/admin/sales">Ventas</Link>
            <Link className="rounded-lg px-3 py-2 hover:bg-stone-800" href="/admin/employees">Empleados</Link>
            <Link className="rounded-lg px-3 py-2 hover:bg-stone-800" href="/admin/devices">POS</Link>
            <Link className="rounded-lg px-3 py-2 hover:bg-stone-800" href="/admin/audit">Auditoría</Link>
            <form action={logout}><button className="rounded-lg border border-stone-700 px-3 py-2 hover:bg-stone-800">Salir</button></form>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
