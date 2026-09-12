import type { ReactNode } from "react";

export default function BranchesLayout({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  return <>{children}{modal}</>;
}
