import { NextResponse } from "next/server";

import { loadPublicSignage } from "../../../../lib/signage-server";

/** Consulta periódica del televisor: la presentación publicada de SU token (ya con los precios resueltos). Sólo lectura, sin login. */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await loadPublicSignage(token);
  if (result.kind === "ok") return NextResponse.json(result.view, { headers: NO_STORE });
  // 404 = ese enlace no corresponde a ninguna pantalla (mismo cuerpo para inexistente, mal formado o regenerado); 503 = reintentar.
  if (result.kind === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
}
