import { BranchDetailFrame } from "../../../../../components/branch-detail-frame";

export default function Loading() {
  return <BranchDetailFrame modal status="" subtitle="" title="Cargando sucursal"><div className="mx-auto max-w-7xl p-5 sm:p-10"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div className="h-24 animate-pulse rounded-xl bg-stone-200" key={index} />)}</div><div className="mt-7 h-72 animate-pulse rounded-xl bg-stone-200" /></div></BranchDetailFrame>;
}
