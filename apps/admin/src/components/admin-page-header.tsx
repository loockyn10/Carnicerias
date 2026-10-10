"use client";

import { usePathname } from "next/navigation";

import { adminPageHeader } from "../lib/admin-page-titles";

export function AdminPageHeader() {
  const header = adminPageHeader(usePathname());

  return <div className="min-w-0"><h1 className="truncate text-lg font-black tracking-tight sm:text-xl">{header.title}</h1>{header.description ? <p className="hidden truncate text-sm text-stone-500 sm:block">{header.description}</p> : null}</div>;
}
