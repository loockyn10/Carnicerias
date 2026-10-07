import type { NextRequest } from "next/server";

import { updateSession } from "./lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

// /tv y /api/tv son la cartelería pública (sin login ni sesión): no pasan por el refresco de sesión de Supabase.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|tv/|api/tv/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"]
};

