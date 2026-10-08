import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DigitalSignagePlayer } from "../../../components/digital-signage-player";
import { getAdminContext } from "../../../lib/admin";
import { buildSignageView } from "../../../lib/signage";
import { signageMediaUrls } from "../../../lib/signage-media";
import { createClient } from "../../../lib/supabase/server";
import { loadSignagePreviewAction } from "../../admin/products/signage/actions";

/**
 * «Abrir vista TV» del Admin: el MISMO reproductor que el televisor, a pantalla completa, pero identificado con la sesión del
 * administrador (no con el token, que sólo se conoce al generarlo). Sirve para probar viewport, nombres largos y rotación sin el TV.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Vista TV", robots: { index: false, follow: false } };

export default async function TvPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getAdminContext();
  if (!context) notFound();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_signage_display_admin", { p_display_id: id });
  if (error || data === null) notFound();
  return <DigitalSignagePlayer initialView={buildSignageView(data, signageMediaUrls(`/api/tv-preview/${id}`))} loadView={loadSignagePreviewAction.bind(null, id)} />;
}
