import { BranchPage } from "../../../../../components/branch-detail";

export default function BranchModalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <BranchPage modal params={params} searchParams={searchParams} />;
}
