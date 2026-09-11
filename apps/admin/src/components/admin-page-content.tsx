"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function AdminPageContent({ children }: { children: ReactNode }) {
  return <div data-admin-page={usePathname()}>{children}</div>;
}
