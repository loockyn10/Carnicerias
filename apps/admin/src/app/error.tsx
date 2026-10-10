"use client";

export default function RootError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f4f1] p-6">
      <section className="max-w-md rounded-2xl border border-stone-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-black text-stone-900">No se ha podido cargar</h1>
        <p className="mt-2 text-sm text-stone-600">{error.message}</p>
        <button className="mt-6 rounded-lg bg-rose-800 px-4 py-2 font-semibold text-white hover:bg-rose-900" onClick={reset}>Reintentar</button>
      </section>
    </main>
  );
}
