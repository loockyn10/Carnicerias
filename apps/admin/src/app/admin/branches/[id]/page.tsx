import { BranchPage } from "../../../../components/branch-detail";

export default function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <BranchPage params={params} searchParams={searchParams} />;
}
