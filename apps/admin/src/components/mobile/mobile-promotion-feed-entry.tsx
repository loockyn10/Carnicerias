import { headers } from "next/headers";

import { parsePromotionFeedState, pendingPromotions } from "../../lib/promotion-feed";
import { createClient } from "../../lib/supabase/server";
import { MobilePromotionFeedButton } from "./mobile-promotion-feed-button";

/** ¿Lo abre un celular o una tablet? Sólo ahí se calcula N: en la computadora el Inicio del celular está oculto y no vale una consulta. */
export function isPhoneUserAgent(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

/**
 * «Descargar promociones Feed (N)» del Inicio del celular (D-103), del lado servidor: N (pendientes) y el tamaño de la última tanda salen de
 * UNA consulta (`get_promotion_feed_state`) mientras se arma la página, dentro de un `Suspense` (no demora el resto del Inicio). No genera
 * imágenes ni hace pedidos desde el celular; si la consulta falla el botón aparece sin el número y el toque vuelve a calcularlo.
 */
export async function MobilePromotionFeedEntry() {
  const userAgent = (await headers()).get("user-agent") ?? "";
  if (!isPhoneUserAgent(userAgent)) return <MobilePromotionFeedButton lastBatch={null} pending={null} />;
  const { data, error } = await (await createClient()).rpc("get_promotion_feed_state", {});
  const state = error ? null : parsePromotionFeedState(data);
  return <MobilePromotionFeedButton lastBatch={state?.lastBatch?.count ?? null} pending={state ? pendingPromotions(state).length : null} />;
}
