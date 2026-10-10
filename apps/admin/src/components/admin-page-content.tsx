"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function AdminPageContent({ children }: { children: ReactNode }) {
  // Debajo de `lg` (celular) la barra inferior fija ocupa `3.5rem` (+ el área segura): el contenido nunca queda tapado.
  return <div className="max-lg:pb-[calc(3.5rem+env(safe-area-inset-bottom))]" data-admin-page={usePathname()}>{children}</div>;
}
