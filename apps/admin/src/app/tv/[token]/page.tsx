import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DigitalSignageTv } from "../../../components/digital-signage-player";
import { loadPublicSignage } from "../../../lib/signage-server";

/** Vista pública del televisor: /tv/<token>. Sin login, sólo lectura; el token es el único acceso. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Cartelería",
  robots: { index: false, follow: false },
  referrer: "no-referrer"
};

export default async function TvPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await loadPublicSignage(token);
  if (result.kind === "not_found") notFound();
  // Si la base no responde en este momento la página igual abre (pantalla de espera) y reintenta sola.
  return <DigitalSignageTv initialView={result.kind === "ok" ? result.view : null} token={token} />;
}
