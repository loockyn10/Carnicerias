import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@carnicerias/database";

import { ARTWORK_BUCKET } from "./artwork-photo";
import { analyzePngAlpha } from "./png-alpha";

/**
 * Lee los bytes REALES de una foto PNG del bucket privado, decide si tiene fondo transparente y lo registra (D-086). Sólo servidor, con la
 * sesión del usuario (las políticas de Storage y la RPC validan organización y permiso). Devuelve el valor registrado o `null` si no se
 * pudo analizar o guardar: la pieza trata «sin dato» como foto opaca (el comportamiento de siempre).
 */
export async function recordPhotoAlpha(
  supabase: Pick<SupabaseClient<Database>, "storage" | "rpc">,
  productId: string,
  storagePath: string
): Promise<boolean | null> {
  if (!storagePath.endsWith(".png")) return null;
  const { data: file, error: downloadError } = await supabase.storage.from(ARTWORK_BUCKET).download(storagePath);
  if (downloadError) return null;
  const alpha = analyzePngAlpha(new Uint8Array(await file.arrayBuffer()));
  if (alpha === null) return null;
  const { error } = await supabase.rpc("set_product_artwork_photo_alpha", { p_product_id: productId, p_storage_path: storagePath, p_has_alpha: alpha });
  return error ? null : alpha;
}
