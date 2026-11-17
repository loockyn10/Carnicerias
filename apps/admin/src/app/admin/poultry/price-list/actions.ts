"use server";

import { revalidatePath } from "next/cache";

import { requireAdminContext } from "../../../../lib/admin";
import { ARTWORK_BUCKET, type StoredPhotoType } from "../../../../lib/artwork-photo";
import { readImageInfo } from "../../../../lib/image-size";
import { buildPriceListImagePath, isPriceListLogoSource, isValidPriceListImagePath, type PriceListImageKind } from "../../../../lib/poultry-price-list-images";
import { createClient } from "../../../../lib/supabase/server";

/**
 * Pollos → Imágenes de la lista (D-100). Mismo flujo que el logo de Cartelería: el servidor da la ruta (con la organización de la sesión), el
 * navegador sube el archivo al bucket privado con su sesión (las políticas de Storage aíslan por organización) y el servidor lo descarga,
 * comprueba que sea un PNG/JPG real, lee sus medidas y lo registra por RPC. Las imágenes reemplazadas de la lista se borran de Storage; los
 * logos de Cartelería nunca se tocan (sólo se eligen).
 */

export interface PriceListImageResult { error?: string }

type Supabase = Awaited<ReturnType<typeof createClient>>;

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function removeObject(supabase: Supabase, organizationId: string, path: string | null | undefined): Promise<void> {
  // Sólo imágenes propias de la lista; mejor esfuerzo (un objeto huérfano no afecta ninguna lista).
  if (!path || !isValidPriceListImagePath(path, organizationId)) return;
  await supabase.storage.from(ARTWORK_BUCKET).remove([path]).catch(() => undefined);
}

function done(): PriceListImageResult {
  revalidatePath("/admin/poultry/price-list");
  return {};
}

/** Ruta nueva donde el navegador sube el logo o el fondo de la lista. */
export async function createPriceListUploadPathAction(type: StoredPhotoType): Promise<{ path?: string; error?: string }> {
  try {
    const context = await requireAdminContext();
    const requested: string = type;
    if (requested !== "image/jpeg" && requested !== "image/png") return { error: "Pedido inválido" };
    return { path: buildPriceListImagePath(context.organizationId, crypto.randomUUID(), type) };
  } catch (error) {
    return { error: message(error, "No se pudo preparar la subida") };
  }
}

/** Registra el logo propio (queda elegido) o la foto de fondo que el navegador YA subió. */
export async function registerPriceListImageAction(kind: PriceListImageKind, storagePath: string): Promise<PriceListImageResult> {
  try {
    const context = await requireAdminContext();
    // Viene del navegador: el tipo no garantiza el valor en tiempo de ejecución.
    const requested: string = kind;
    if (requested !== "LOGO" && requested !== "BACKGROUND") return { error: "Pedido inválido" };
    if (!isValidPriceListImagePath(storagePath, context.organizationId)) return { error: "Imagen inválida" };
    const supabase = await createClient();
    const { data: file, error: downloadError } = await supabase.storage.from(ARTWORK_BUCKET).download(storagePath);
    if (downloadError) return { error: "No se pudo leer la imagen que se subió. Probá de nuevo." };
    const info = readImageInfo(new Uint8Array(await file.arrayBuffer()));
    if (!info) {
      await removeObject(supabase, context.organizationId, storagePath);
      return { error: "La imagen tiene que ser un PNG o JPG válido." };
    }
    const { data, error } = await supabase.rpc("set_poultry_price_list_image", { p_kind: kind, p_storage_path: storagePath, p_width_px: info.width, p_height_px: info.height });
    if (error) {
      await removeObject(supabase, context.organizationId, storagePath);
      return { error: error.message };
    }
    await removeObject(supabase, context.organizationId, (data as { previousPath?: string | null } | null)?.previousPath);
    return done();
  } catch (error) {
    return { error: message(error, "No se pudo guardar la imagen") };
  }
}

/** Elige uno de los logos ya guardados (identidad, carnicería o el propio de la lista). */
export async function setPriceListLogoSourceAction(source: string): Promise<PriceListImageResult> {
  try {
    await requireAdminContext();
    if (!isPriceListLogoSource(source)) return { error: "Logo inválido" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_poultry_price_list_logo_source", { p_source: source });
    if (error) return { error: error.message };
    return done();
  } catch (error) {
    return { error: message(error, "No se pudo elegir el logo") };
  }
}

/** Quita la foto de fondo (la lista vuelve al fondo neutro) y borra el archivo. */
export async function removePriceListBackgroundAction(): Promise<PriceListImageResult> {
  try {
    const context = await requireAdminContext();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("remove_poultry_price_list_background");
    if (error) return { error: error.message };
    await removeObject(supabase, context.organizationId, (data as { removedPath?: string | null } | null)?.removedPath);
    return done();
  } catch (error) {
    return { error: message(error, "No se pudo quitar la foto de fondo") };
  }
}
