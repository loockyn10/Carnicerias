export default function AdminLoading() {
  return <main className="mx-auto max-w-7xl animate-pulse p-5 sm:p-8"><div className="h-4 w-32 rounded bg-stone-200" /><div className="mt-3 h-9 w-56 rounded bg-stone-200" /><div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[1, 2, 3, 4].map((item) => <div className="h-24 rounded-xl bg-white" key={item} />)}</div><div className="mt-8 h-56 rounded-xl bg-white" /></main>;
}
