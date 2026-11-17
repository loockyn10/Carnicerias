import { createPriceListUploadPathAction, registerPriceListImageAction, type PriceListImageResult } from "../app/admin/poultry/price-list/actions";
import { ARTWORK_BUCKET } from "./artwork-photo";
import { preparePhoto, type PreparedPhoto } from "./artwork-photo-client";
import type { PriceListImageKind } from "./poultry-price-list-images";
import { createClient } from "./supabase/client";

/**
 * Subida (sólo navegador) del logo propio o de la foto de fondo de la lista de precios. Reutiliza la preparación de Cartelería
 * (`preparePhoto`: JPG/PNG/WebP, WebP → PNG, lado mayor ≤ 2.400 px, ≤ 5 MB) y el mismo bucket privado; el servidor da la ruta y registra.
 */
export async function uploadPriceListImage(kind: PriceListImageKind, file: File): Promise<PriceListImageResult> {
  let prepared: PreparedPhoto;
  try {
    prepared = await preparePhoto(file);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo preparar la imagen" };
  }
  const target = await createPriceListUploadPathAction(prepared.type);
  if (target.error || !target.path) return { error: target.error ?? "No se pudo preparar la subida" };
  const { error } = await createClient().storage.from(ARTWORK_BUCKET).upload(target.path, prepared.blob, { contentType: prepared.type, upsert: false });
  if (error) return { error: `No se pudo subir la imagen: ${error.message}` };
  return registerPriceListImageAction(kind, target.path);
}
