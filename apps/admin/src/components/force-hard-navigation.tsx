"use client";

import { useEffect } from "react";

// Next.js's App Router client-side navigation intercepts a click on ANY link
// under /admin/branches/* against the (.)[id] modal route in
// app/admin/branches/@modal/(.)[id]/page.tsx, even when the target is a
// static sibling of [id] (e.g. /admin/branches/new, /admin/branches/compare)
// that should take priority — this is a Next.js route-interception
// limitation, not something fixable by reordering folders. The intercepted
// render then looks up a branch whose id equals that literal segment, finds
// none, and would otherwise call notFound(). A hard reload of the same URL
// bypasses interception entirely (only client-side/"soft" navigations are
// intercepted) and lets the real static or dynamic route resolve normally.
export function ForceHardNavigation() {
  useEffect(() => {
    window.location.replace(window.location.pathname + window.location.search);
  }, []);
  return null;
}
