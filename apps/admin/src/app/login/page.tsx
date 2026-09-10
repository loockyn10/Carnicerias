import { redirect } from "next/navigation";

import { createClient } from "../../lib/supabase/server";
import { login } from "./actions";

interface LoginPageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (data.user) {
    redirect("/admin");
  }

  const { error } = await searchParams;

  return (
    <main className="grid min-h-screen place-items-center bg-stone-100 p-6">
      <section className="w-full max-w-md rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wider text-rose-800">Administración</p>
        <h1 className="mt-2 text-3xl font-semibold text-stone-900">Iniciar sesión</h1>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          Usá el usuario creado en Supabase Auth para validar identidad y políticas RLS.
        </p>

        {error ? (
          <p className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            {error}
          </p>
        ) : null}

        <form action={login} className="mt-6 grid gap-5">
          <label className="grid gap-2 text-sm font-medium text-stone-700">
            Email
            <input
              className="rounded-lg border border-stone-300 px-3 py-2.5 outline-none focus:border-rose-700 focus:ring-2 focus:ring-rose-100"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-stone-700">
            Contraseña
            <input
              className="rounded-lg border border-stone-300 px-3 py-2.5 outline-none focus:border-rose-700 focus:ring-2 focus:ring-rose-100"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button className="rounded-lg bg-rose-800 px-4 py-3 font-semibold text-white hover:bg-rose-900" type="submit">
            Ingresar
          </button>
        </form>
      </section>
    </main>
  );
}

