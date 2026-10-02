export default function RootLoading() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f4f1]" role="status" aria-label="Cargando">
      <div className="text-center">
        <img src="/icons/icon-192.png" alt="" width={96} height={96} className="mx-auto animate-pulse rounded-2xl" />
        <p className="mt-4 text-sm font-semibold uppercase tracking-wider text-rose-800">Administración Carnicerías</p>
      </div>
    </main>
  );
}
